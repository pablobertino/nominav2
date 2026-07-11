/* =====================================================================
   functions/api/wa-send.js  →  POST /api/wa-send
   Difusion de mensajes WhatsApp (Green-API) - Fase 1: solo TEXTO.
   Estandar del grupo: GC_GREENAPI_INTEGRACION.md. El frontend NUNCA
   habla con Green-API: todo pasa por este proxy que valida permisos.

   Acciones (POST { action, user, ... }):
     facets   {}                          -> catalogos para los filtros
                gate: view.whatsapp
     preview  { target, filtros..., active, people[], group_id, direct_phone }
                -> { total, with_phone, without_phone, messages?, rows[<=1000] }
                gate: view.whatsapp
                v4.99 target: 'companies' (default) = telefonos de las
                EMPRESAS/TIENDAS segun filtros de estructura + solo
                activas (1 mensaje POR TELEFONO valido, muchas tienen 2);
                'people' = lista manual de cedulas armada con el buscador.
                Grupo y numero directo siguen mandando sobre todo.
                v5.05: limit 1000 (antes 100): el universo entra completo,
                asi excluir sobre la grilla es fiable.
     search_people { q }                  -> buscador de personas (roster
                activo, por nombre o cedula) para armar la lista manual
                gate: view.whatsapp (solo superadmin)
     send     { target, filtros..., message, exclude[] }  -> lote + cola
                -> { batch_id, queued }   gate: wa.send
                v5.05 exclude[]: codigos de empresa (o cedulas en modo
                Personas) QUITADOS a mano en la grilla del preview. El send
                re-consulta el RPC, por eso los excluidos deben viajar: se
                filtran aca y quedan registrados en wa_batches.filters.
     process  { batch_id }                -> envia una TANDA (<=8) con
                delay entre mensajes; el front repite hasta remaining=0
                -> { sent, errors, remaining }   gate: wa.send
     status   { batch_id }                -> conteos + errores del lote
                gate: view.whatsapp
     state    {}                          -> getStateInstance (diagnostico)
                gate: wa.send

   Regla 1 del estandar (sin rafagas): tandas cortas con pausa de ~450ms
   por mensaje; el "Message sending delay" de la consola Green-API es la
   segunda linea de defensa. Todo queda auditado en wa_batches/wa_outbox.
   ===================================================================== */

import { resolveActor, can, isSuperadmin } from './_auth.js';
import { gaClient, toChatId } from './_greenapi.js';

const BATCH_SIZE = 8;          // mensajes por invocacion (lotes chicos)
const DELAY_MS = 450;          // pausa entre mensajes (lotes chicos)
/* v4.92 ANTI-BLOQUEO: para difusiones GRANDES (>20 destinatarios) el ritmo
   baja a la regla 1 del estandar (1 msg cada 3-5s) con JITTER aleatorio
   (un ritmo metronomico tambien parece bot). Tanda de 4 con 2.5-4s entre
   mensajes = ~9-13s por invocacion (seguro para el limite de la Function)
   y ~1 mensaje cada 3.2s promedio. El "Message sending delay" de la
   consola del proveedor es la SEGUNDA linea de defensa (configurarlo en
   3000-5000ms). */
const BIG_THRESHOLD = 20;
const BIG_BATCH_SIZE = 4;
const bigDelay = () => 2500 + Math.floor(Math.random() * 1500);
const MAX_MESSAGE = 4000;      // limite practico del portal (API admite 20000)
/* v5.05: el preview trae hasta 1000 filas (antes 100). Con ~150 empresas
   activas el universo entra COMPLETO: lo que se ve es lo que se envia, y
   por eso excluir sobre la grilla es fiable (antes, con un filtro de mas
   de 100, se excluia sobre una muestra parcial y el resto viajaba igual). */
const PREVIEW_LIMIT = 1000;
/* v4.98 GUARDIAN DEL DELAY DE LINEA: el "Message sending delay" de la
   instancia (delaySendMessagesMilliseconds) es la SEGUNDA linea de
   defensa del estandar (pausa REAL entre salidas hacia WhatsApp). El
   action 'state' lo verifica en cada carga de Difusion y si esta por
   debajo del minimo lo corrige solo (auto-reparable: si alguien lo baja
   en la consola, el portal lo restaura). Idempotente: una vez en 3500ms
   nunca vuelve a setear (setSettings reinicia la instancia, doc: aplica
   en ~5 min). */
const LINE_DELAY_MIN_MS = 3000;
const LINE_DELAY_SET_MS = 3500;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sb(env, path, opts = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2', 'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
const rpc = (env, fn, args) =>
  sb(env, `rpc/${fn}`, { method: 'POST', body: JSON.stringify(args || {}) });

function pickFilters(body) {
  const nn = v => (v === undefined || v === null || v === '' ? null : String(v));
  return {
    p_zone: nn(body.zone), p_subzone: nn(body.subzone),
    p_type: nn(body.type), p_concept: nn(body.concept),
    p_company: nn(body.company), p_id_number: nn(body.id_number),
  };
}

/* v4.99: filtros para el destino EMPRESAS/TIENDAS (wa_company_recipients).
   p_active default true = solo empresas activas (checkbox de la vista). */
function pickCompanyFilters(body) {
  const nn = v => (v === undefined || v === null || v === '' ? null : String(v));
  return {
    p_zone: nn(body.zone), p_subzone: nn(body.subzone),
    p_type: nn(body.type), p_concept: nn(body.concept),
    p_company: nn(body.company),
    p_active: body.active === undefined ? true : !!body.active,
  };
}

/* v4.99: lista manual de cedulas (modo Personas). Sanea y dedup. */
function pickPeople(body) {
  const arr = Array.isArray(body.people) ? body.people : [];
  return [...new Set(arr.map(x => String(x || '').replace(/\D/g, '')).filter(Boolean))];
}

/* v5.05: EXCLUIDOS del preview. La grilla de destinatarios permite quitar
   empresas (una a una con la X, o varias con los checkboxes). El 'send' NO
   usa las filas del preview: RE-CONSULTA el RPC con los filtros, asi que la
   lista de excluidos tiene que VIAJAR y filtrarse aca; si no, se enviaria a
   quienes el usuario quito. Se guarda en wa_batches.filters (auditoria de a
   quien NO se le mando). Para empresas la clave es company_code; para
   personas, la cedula. */
function pickExclude(body) {
  const arr = Array.isArray(body.exclude) ? body.exclude : [];
  return new Set(arr.map(x => String(x || '').trim()).filter(Boolean));
}

/* v4.91: numero directo (pruebas / destinatario fuera de nomina).
   Valida >=10 digitos tras limpiar; manda solo (ignora filtros). */
function pickDirectPhone(body) {
  const raw = String(body.direct_phone || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return { raw, ok: digits.length >= 10 };
}

/* v4.93: grupo habilitado como destinatario. v4.97: si restrictAdminId
   viene (admin no-super), el grupo ademas debe estar ASIGNADO a ese
   admin en wa_group_admins. Un solo mensaje al chat_id @g.us (sin
   toChatId). Prioridad: grupo > numero directo > cedula. */
async function pickGroup(env, body, restrictAdminId) {
  const gid = Number(body.group_id || 0);
  if (!gid) return null;
  const r = await sb(env, `wa_groups?id=eq.${gid}&enabled=eq.true&select=id,chat_id,wa_name,alias`);
  const grp = (r && r[0]) || undefined;   // undefined = pedido pero no habilitado
  if (grp && restrictAdminId) {
    const link = await sb(env,
      `wa_group_admins?group_id=eq.${gid}&admin_id=eq.${restrictAdminId}&select=group_id&limit=1`);
    if (!link || !link.length) return undefined;   // no asignado a este admin
  }
  return grp;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Cuerpo inválido.' }, 400); }
  const action = body.action || 'facets';

  try {
    const actor = await resolveActor(env, body.user);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);
    if (!can(actor, 'view.whatsapp')) {
      return json({ ok: false, error: 'No tienes permiso para la difusión WhatsApp (view.whatsapp).' }, 403);
    }
    const actorName = String(actor.actor || '');
    // v4.97: superadmin difunde a todo; un admin no-super con permisos
    // concedidos SOLO publica a sus grupos asignados (wa_group_admins).
    const superOk = isSuperadmin(actor);
    const restrictId = superOk ? null : (Number(body.user && body.user.id) || -1);

    /* ---------------- facets: catalogos de filtros ---------------- */
    if (action === 'facets') {
      if (!superOk) {
        // Los filtros de estructura son exclusivos de superadmin.
        return json({ ok: true, zones: [], subzones: [], concepts: [], companies: [], types: [] });
      }
      const [zones, subzones, concepts, companies] = await Promise.all([
        sb(env, 'zones?select=id,name&order=name.asc'),
        sb(env, 'subzones?select=id,name,zone_id&order=name.asc'),
        sb(env, 'concepts?select=id,name&order=name.asc'),
        sb(env, 'companies?select=company_code,business_name,company_type&order=business_name.asc'),
      ]);
      const types = [...new Set((companies || []).map(c => c.company_type).filter(Boolean))].sort();
      return json({ ok: true, zones: zones || [], subzones: subzones || [], concepts: concepts || [], companies: companies || [], types });
    }

    /* ------- search_people: buscador para la lista manual (v4.99) ------- */
    if (action === 'search_people') {
      if (!superOk) {
        return json({ ok: false, error: 'El modo Personas es exclusivo del superadministrador.' }, 403);
      }
      const q = String(body.q || '').trim();
      if (q.length < 2) return json({ ok: true, rows: [] });
      const rows = await rpc(env, 'wa_people_search', { p_q: q, p_limit: 20 });
      return json({ ok: true, rows: rows || [] });
    }

    /* ---------------- preview: destinatarios ---------------- */
    if (action === 'preview') {
      if (!superOk && !Number(body.group_id || 0)) {
        return json({ ok: false, error: 'Tu difusión está limitada a los grupos que te asignaron: elige un grupo.' }, 400);
      }
      const grp = await pickGroup(env, body, restrictId);
      if (grp === undefined) return json({ ok: false, error: 'Ese grupo no está habilitado o no está asignado a tu usuario.' }, 400);
      if (grp) {
        return json({
          ok: true,
          total: 1, with_phone: 1, without_phone: 0,
          rows: [{
            id_number: '—', full_name: `Grupo: ${grp.alias || grp.wa_name || grp.chat_id}`,
            company_code: '', company_name: '(un solo mensaje al grupo)',
            phone: grp.chat_id, phone_ok: true,
          }],
        });
      }
      const direct = pickDirectPhone(body);
      if (direct) {
        // Destinatario sintetico: no consulta el roster.
        return json({
          ok: true,
          total: 1, with_phone: direct.ok ? 1 : 0, without_phone: direct.ok ? 0 : 1,
          rows: [{
            id_number: '—', full_name: 'Número directo',
            company_code: '', company_name: '(fuera de nómina)',
            phone: direct.raw, phone_ok: direct.ok,
          }],
        });
      }
      // v4.99: destino segun target. 'companies' (default) = telefonos de
      // las empresas; 'people' = lista manual de cedulas del buscador.
      // (id_number suelto se conserva por compatibilidad -> roster 1 persona)
      if (String(body.id_number || '').trim()) {
        const r = await rpc(env, 'wa_recipients', { ...pickFilters(body), p_limit: 100 });
        return json({ ok: true, target: 'people', ...(r || {}) });
      }
      if ((body.target || 'companies') === 'people') {
        const ids = pickPeople(body);
        if (!ids.length) return json({ ok: false, error: 'Agrega al menos una persona a la lista con el buscador.' }, 400);
        const r = await rpc(env, 'wa_people_by_ids', { p_ids: ids });
        return json({ ok: true, target: 'people', ...(r || {}) });
      }
      const r = await rpc(env, 'wa_company_recipients', { ...pickCompanyFilters(body), p_limit: PREVIEW_LIMIT });
      return json({ ok: true, target: 'companies', ...(r || {}) });
    }

    if (action === 'status') {
      const bid = String(body.batch_id || '');
      if (!bid) return json({ ok: false, error: 'Falta el lote.' }, 400);
      const rows = await sb(env, `wa_outbox?batch_id=eq.${encodeURIComponent(bid)}&select=status`);
      const errs = await sb(env, `wa_outbox?batch_id=eq.${encodeURIComponent(bid)}&status=eq.error&select=full_name,phone_raw,error_text&limit=50`);
      const n = { pending: 0, sent: 0, error: 0 };
      (rows || []).forEach(r => { n[r.status] = (n[r.status] || 0) + 1; });
      return json({ ok: true, ...n, errors: errs || [] });
    }

    /* ------------- lo que sigue exige la llave de envio ------------- */
    if (!can(actor, 'wa.send')) {
      return json({ ok: false, error: 'No tienes permiso para enviar mensajes WhatsApp (wa.send).' }, 403);
    }

    if (action === 'state') {
      const ga = gaClient(env);
      const st = await ga.state();
      // v4.98: guardian del delay de linea (ver constantes arriba).
      let delayMs = null, delayFixed = false, delayErr = null;
      try {
        const cfg = await ga.getSettings();
        delayMs = Number(cfg && cfg.delaySendMessagesMilliseconds) || 0;
        if (delayMs < LINE_DELAY_MIN_MS) {
          await ga.setSettings({ delaySendMessagesMilliseconds: LINE_DELAY_SET_MS });
          delayMs = LINE_DELAY_SET_MS;
          delayFixed = true;
        }
      } catch (e) {
        delayErr = String(e && e.message ? e.message : e).slice(0, 200);
      }
      return json({
        ok: true, state: st, phone: env.GREENAPI_PHONE || null,
        delay_ms: delayMs, delay_fixed: delayFixed, delay_error: delayErr,
      });
    }

    /* ---------------- send: crear lote + cola ---------------- */
    if (action === 'send') {
      const message = String(body.message || '').trim();
      if (!message) return json({ ok: false, error: 'El mensaje está vacío.' }, 400);
      if (message.length > MAX_MESSAGE) {
        return json({ ok: false, error: `El mensaje supera los ${MAX_MESSAGE} caracteres.` }, 400);
      }
      if (!superOk && !Number(body.group_id || 0)) {
        return json({ ok: false, error: 'Tu difusión está limitada a los grupos que te asignaron: elige un grupo.' }, 400);
      }
      const grp = await pickGroup(env, body, restrictId);
      if (grp === undefined) return json({ ok: false, error: 'Ese grupo no está habilitado o no está asignado a tu usuario.' }, 400);
      const direct = pickDirectPhone(body);
      if (direct && !direct.ok) {
        return json({ ok: false, error: 'El número directo no parece válido (mínimo 10 dígitos).' }, 400);
      }
      // Destinatarios: grupo (1 mensaje al chat) > numero directo >
      // v4.99: lista manual de personas > EMPRESAS/TIENDAS (default).
      // Nota: para empresas NO se exige filtro (el universo ya esta acotado
      // a las empresas del grupo, ~150 mensajes maximo con solo-activas);
      // para personas se exige lista no vacia.
      let r, rows, batchFilters;
      const target = String(body.target || 'companies');
      const EXC = pickExclude(body);   // v5.05: quitados a mano en la grilla
      if (grp) {
        r = { total: 1 };
        rows = [{ id_number: 'grupo', full_name: `Grupo: ${grp.alias || grp.wa_name || grp.chat_id}`, company_code: '', phone: grp.chat_id, phone_ok: true, chat_id_direct: grp.chat_id }];
        batchFilters = { group_id: grp.id, group: grp.alias || grp.wa_name || grp.chat_id };
      } else if (direct) {
        r = { total: 1 };
        rows = [{ id_number: 'directo', full_name: 'Número directo (prueba)', company_code: '', phone: direct.raw, phone_ok: true }];
        batchFilters = { direct_phone: direct.raw };
      } else if (String(body.id_number || '').trim()) {
        // Compatibilidad: cedula suelta -> roster (1 persona).
        const filters = pickFilters(body);
        r = await rpc(env, 'wa_recipients', { ...filters, p_limit: 100000 });
        rows = ((r && r.rows) || []).filter(x => x.phone_ok);
        batchFilters = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== null));
      } else if (target === 'people') {
        const ids = pickPeople(body).filter(id => !EXC.has(id));   // v5.05
        if (!ids.length) return json({ ok: false, error: 'Agrega al menos una persona a la lista con el buscador.' }, 400);
        r = await rpc(env, 'wa_people_by_ids', { p_ids: ids });
        rows = ((r && r.rows) || []).filter(x => x.phone_ok);
        batchFilters = { target: 'people', people: ids, ...(EXC.size ? { excluded: [...EXC] } : {}) };
      } else {
        const cf = pickCompanyFilters(body);
        r = await rpc(env, 'wa_company_recipients', { ...cf, p_limit: 100000 });
        // v5.05: fuera las empresas que el usuario quito en la grilla.
        const src = ((r && r.rows) || []).filter(c => !EXC.has(String(c.company_code)));
        // Expandir: 1 fila de cola POR TELEFONO valido de cada empresa.
        rows = [];
        for (const c of src) {
          for (const tel of (c.phones || [])) {
            rows.push({
              id_number: c.company_code,
              full_name: `${c.company_code} · ${c.business_name}`,
              company_code: c.company_code,
              phone: tel, phone_ok: true,
            });
          }
        }
        batchFilters = {
          target: 'companies', active: cf.p_active,
          ...Object.fromEntries(Object.entries(cf).filter(([k, v]) => k !== 'p_active' && v !== null)
            .map(([k, v]) => [k.replace(/^p_/, ''), v])),
          ...(EXC.size ? { excluded: [...EXC] } : {}),
        };
      }
      if (!rows.length) {
        return json({ ok: false, error: EXC.size
          ? 'No queda ningún destinatario: excluiste a todos los que tenían teléfono.'
          : 'Ningún destinatario del filtro tiene teléfono válido.' }, 400);
      }

      const batch = await sb(env, 'wa_batches', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          created_by: actorName,
          message,
          filters: batchFilters,
          // v5.05: 'total' = universo del filtro MENOS lo excluido (lo que
          // realmente se intento), no el universo bruto.
          total: (target === 'companies' && !grp && !direct)
            ? [...new Set(rows.map(x => x.company_code))].length
            : ((r && r.total) || rows.length),
          with_phone: rows.length,
        }),
      });
      const batchId = batch && batch[0] && batch[0].id;
      if (!batchId) throw new Error('No se pudo crear el lote.');

      // Cola: 1 fila por destinatario (insert masivo)
      await sb(env, 'wa_outbox', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(rows.map(x => ({
          batch_id: batchId,
          id_number: x.id_number,
          full_name: x.full_name || '',
          company_code: x.company_code || '',
          phone_raw: x.phone,
          // Grupos ya traen su chat_id @g.us; telefonos se normalizan.
          chat_id: x.chat_id_direct || toChatId(x.phone),
        }))),
      });
      return json({ ok: true, batch_id: batchId, queued: rows.length });
    }

    /* ---------------- process: enviar una tanda ---------------- */
    if (action === 'process') {
      const bid = String(body.batch_id || '');
      if (!bid) return json({ ok: false, error: 'Falta el lote.' }, 400);
      const batch = await sb(env, `wa_batches?id=eq.${encodeURIComponent(bid)}&select=id,message,with_phone`);
      if (!batch || !batch.length) return json({ ok: false, error: 'El lote no existe.' }, 404);
      const message = batch[0].message;
      const isBig = Number(batch[0].with_phone || 0) > BIG_THRESHOLD;
      const tanda = isBig ? BIG_BATCH_SIZE : BATCH_SIZE;

      const pend = await sb(env,
        `wa_outbox?batch_id=eq.${encodeURIComponent(bid)}&status=eq.pending&select=id,chat_id&order=id.asc&limit=${tanda}`);
      const ga = gaClient(env);
      let sent = 0, errors = 0;

      for (const row of (pend || [])) {
        try {
          const res = await ga.sendMessage(row.chat_id, message);
          await sb(env, `wa_outbox?id=eq.${row.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'sent', id_message: (res && res.idMessage) || null, sent_at: new Date().toISOString() }),
          });
          sent++;
        } catch (e) {
          await sb(env, `wa_outbox?id=eq.${row.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'error', error_text: String(e && e.message ? e.message : e).slice(0, 500) }),
          });
          errors++;
        }
        await sleep(isBig ? bigDelay() : DELAY_MS);
      }

      const left = await sb(env,
        `wa_outbox?batch_id=eq.${encodeURIComponent(bid)}&status=eq.pending&select=id&limit=1`);
      return json({ ok: true, sent, errors, remaining: (left && left.length) ? true : false });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (e) {
    if (e && e.name === 'AuthError') return json({ ok: false, error: e.message }, e.status || 403);
    // NUNCA exponer el token: los mensajes de gaClient no lo incluyen.
    return json({ ok: false, error: 'Error interno: ' + (e && e.message ? e.message : e) }, 500);
  }
}
