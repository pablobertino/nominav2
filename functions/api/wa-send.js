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
   consola del proveedor es la SEGUNDA linea de defensa (v6.73: objetivo
   15000ms, lo fija el guardian de abajo). */
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
   en la consola, el portal lo restaura). Idempotente: una vez en 15000ms
   nunca vuelve a setear (setSettings reinicia la instancia, doc: aplica
   en ~5 min).
   v6.73: objetivo subido de 3500 a 15000ms por el blindaje anti-baneo
   (BLINDAJE_ANTIBANEO.md): intervalos cortos entre chats distintos son
   senal de automatizacion; 15s es la recomendacion de Green-API. */
const LINE_DELAY_MIN_MS = 15000;
const LINE_DELAY_SET_MS = 15000;

/* ===================== v5.15: ESTADO DE LA LINEA EN CRISTIANO =====================
   El proveedor devuelve el estado de la linea como un codigo en ingles
   (stateInstance). La vista Difusion lo pintaba CRUDO en la pildora del
   encabezado: cuando la linea se cayo, al usuario le aparecio literalmente
   "yellowCard" y no habia forma de saber que significaba ni que hacer.

   Aca se traduce a un objeto que el front pinta tal cual:
     { level, title, hint }
       level: 'ok' | 'warn' | 'bad'   -> color de la pildora
       title: texto corto (lo que se ve)
       hint : que hacer (tooltip)

   Reglas del portal que esto respeta:
   - Nunca se nombra al proveedor en la UI (se dice "la linea").
   - Nunca se muestra jerga tecnica cruda en ingles.

   OJO CON yellowCard: la documentacion lo marca como "deprecated, replaced
   with suspended", PERO la consola del proveedor lo SIGUE devolviendo hoy
   (visto en produccion 2026-07-11). Por eso se mapean LOS DOS al mismo
   texto: creerle a la doc y sacar yellowCard dejaria al usuario otra vez
   frente a un codigo crudo. Cualquier estado desconocido cae en un texto
   generico y seguro (nunca se filtra el codigo del proveedor). */
const LINE_STATES = {
  authorized: {
    level: 'ok', title: 'Línea conectada',
    hint: 'La línea está lista para enviar.',
  },
  notAuthorized: {
    level: 'bad', title: 'Línea desconectada',
    hint: 'Hay que volver a vincular el teléfono de la línea escaneando el código QR. Mientras tanto no sale ningún mensaje.',
  },
  // Restriccion temporal de WhatsApp sobre la linea. yellowCard es el
  // nombre viejo del mismo estado; ambos siguen llegando.
  suspended: {
    level: 'warn', title: 'Línea con restricciones',
    hint: 'WhatsApp le puso restricciones temporales a la línea. Los envíos pueden fallar o llegar con demora. Conviene no hacer difusiones grandes hasta que se normalice.',
  },
  yellowCard: {
    level: 'warn', title: 'Línea con restricciones',
    hint: 'WhatsApp le puso restricciones temporales a la línea. Los envíos pueden fallar o llegar con demora. Conviene no hacer difusiones grandes hasta que se normalice.',
  },
  blocked: {
    level: 'bad', title: 'Línea bloqueada',
    hint: 'WhatsApp bloqueó la línea. No se puede enviar. Hay que revisarlo con el proveedor del servicio.',
  },
  sleepMode: {
    level: 'warn', title: 'Línea en reposo',
    hint: 'El teléfono de la línea está apagado o sin internet. Al encenderlo puede tardar unos minutos en reconectar.',
  },
  starting: {
    level: 'warn', title: 'Línea iniciando',
    hint: 'La línea se está levantando. Puede tardar unos minutos.',
  },
};

/* Traduce el estado crudo. Nunca devuelve el codigo del proveedor: si es
   desconocido, texto generico (que el usuario no vea jerga jamas). */
function lineStatus(st) {
  const code = st && st.stateInstance ? String(st.stateInstance) : '';
  const known = LINE_STATES[code];
  if (known) return { ...known, code };
  return {
    level: 'bad',
    title: 'Línea no disponible',
    hint: 'No se pudo verificar el estado de la línea. Vuelve a intentarlo en unos minutos.',
    code,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* v6.50 SOLO GRUPOS: la linea (Naima) publica UNICAMENTE en grupos de
   WhatsApp; jamas a un chat individual. Un chat_id de grupo termina en
   '@g.us'. Este guardian es la red de seguridad definitiva: aunque algun
   flujo viejo cuele un destinatario individual (@c.us), aca NO se envia. */
function isGroupChat(chatId) {
  return /@g\.us$/i.test(String(chatId || ''));
}

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
      // v6.50 SOLO GRUPOS: el preview solo confirma el grupo destino.
      if (!Number(body.group_id || 0)) {
        return json({ ok: false, error: 'Elige el grupo donde se va a publicar.' }, 400);
      }
      const grp = await pickGroup(env, body, restrictId);
      if (grp === undefined) return json({ ok: false, error: 'Ese grupo no está habilitado o no está asignado a tu usuario.' }, 400);
      if (!grp || !isGroupChat(grp.chat_id)) {
        return json({ ok: false, error: 'El destino no es un grupo válido de WhatsApp.' }, 400);
      }
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
        // v5.15: estado ya traducido (el front no interpreta codigos).
        line: lineStatus(st),
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
      // v6.50 SOLO GRUPOS: la difusion publica UNICAMENTE en un grupo de
      // WhatsApp. Se elimino el envio a empresas/personas/numero directo.
      const grp = await pickGroup(env, body, restrictId);
      if (!Number(body.group_id || 0)) {
        return json({ ok: false, error: 'Elige el grupo donde se va a publicar.' }, 400);
      }
      if (grp === undefined) return json({ ok: false, error: 'Ese grupo no está habilitado o no está asignado a tu usuario.' }, 400);
      if (!grp || !isGroupChat(grp.chat_id)) {
        return json({ ok: false, error: 'El destino no es un grupo válido de WhatsApp.' }, 400);
      }
      const rows = [{
        id_number: 'grupo',
        full_name: `Grupo: ${grp.alias || grp.wa_name || grp.chat_id}`,
        company_code: '', phone: grp.chat_id, phone_ok: true, chat_id_direct: grp.chat_id,
      }];
      const batchFilters = { group_id: grp.id, group: grp.alias || grp.wa_name || grp.chat_id };
      const r = { total: 1 };

      const batch = await sb(env, 'wa_batches', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          created_by: actorName,
          message,
          filters: batchFilters,
          total: (r && r.total) || rows.length,
          with_phone: rows.length,
        }),
      });
      const batchId = batch && batch[0] && batch[0].id;
      if (!batchId) throw new Error('No se pudo crear el lote.');

      // Cola: 1 fila (el grupo ya trae su chat_id @g.us).
      await sb(env, 'wa_outbox', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(rows.map(x => ({
          batch_id: batchId,
          id_number: x.id_number,
          full_name: x.full_name || '',
          company_code: x.company_code || '',
          phone_raw: x.phone,
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
        // v6.50 SOLO GRUPOS: nunca enviar a un chat individual. Si por algun
        // flujo viejo quedo un @c.us en la cola, se marca error y se salta.
        if (!isGroupChat(row.chat_id)) {
          await sb(env, `wa_outbox?id=eq.${row.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'error', error_text: 'Bloqueado: solo se permite publicar en grupos de WhatsApp.' }),
          });
          errors++;
          continue;
        }
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
