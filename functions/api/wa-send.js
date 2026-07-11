/* =====================================================================
   functions/api/wa-send.js  →  POST /api/wa-send
   Difusion de mensajes WhatsApp (Green-API) - Fase 1: solo TEXTO.
   Estandar del grupo: GC_GREENAPI_INTEGRACION.md. El frontend NUNCA
   habla con Green-API: todo pasa por este proxy que valida permisos.

   Acciones (POST { action, user, ... }):
     facets   {}                          -> catalogos para los filtros
                gate: view.whatsapp
     preview  { zone, subzone, type, concept, company, id_number }
                -> { total, with_phone, without_phone, rows[<=100] }
                gate: view.whatsapp
     send     { filtros..., message }     -> crea lote + cola (pending)
                -> { batch_id, queued }   gate: wa.send
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

import { resolveActor, can } from './_auth.js';
import { gaClient, toChatId } from './_greenapi.js';

const BATCH_SIZE = 8;          // mensajes por invocacion de 'process'
const DELAY_MS = 450;          // pausa entre mensajes dentro de la tanda
const MAX_MESSAGE = 4000;      // limite practico del portal (API admite 20000)

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

/* v4.91: numero directo (pruebas / destinatario fuera de nomina).
   Valida >=10 digitos tras limpiar; manda solo (ignora filtros). */
function pickDirectPhone(body) {
  const raw = String(body.direct_phone || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return { raw, ok: digits.length >= 10 };
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

    /* ---------------- facets: catalogos de filtros ---------------- */
    if (action === 'facets') {
      const [zones, subzones, concepts, companies] = await Promise.all([
        sb(env, 'zones?select=id,name&order=name.asc'),
        sb(env, 'subzones?select=id,name,zone_id&order=name.asc'),
        sb(env, 'concepts?select=id,name&order=name.asc'),
        sb(env, 'companies?select=company_code,business_name,company_type&order=business_name.asc'),
      ]);
      const types = [...new Set((companies || []).map(c => c.company_type).filter(Boolean))].sort();
      return json({ ok: true, zones: zones || [], subzones: subzones || [], concepts: concepts || [], companies: companies || [], types });
    }

    /* ---------------- preview: destinatarios ---------------- */
    if (action === 'preview') {
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
      const r = await rpc(env, 'wa_recipients', { ...pickFilters(body), p_limit: 100 });
      return json({ ok: true, ...(r || {}) });
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
      const st = await gaClient(env).state();
      return json({ ok: true, state: st });
    }

    /* ---------------- send: crear lote + cola ---------------- */
    if (action === 'send') {
      const message = String(body.message || '').trim();
      if (!message) return json({ ok: false, error: 'El mensaje está vacío.' }, 400);
      if (message.length > MAX_MESSAGE) {
        return json({ ok: false, error: `El mensaje supera los ${MAX_MESSAGE} caracteres.` }, 400);
      }
      const direct = pickDirectPhone(body);
      if (direct && !direct.ok) {
        return json({ ok: false, error: 'El número directo no parece válido (mínimo 10 dígitos).' }, 400);
      }
      const filters = pickFilters(body);
      const hasFilter = !!direct || Object.values(filters).some(v => v !== null);
      if (!hasFilter) {
        return json({ ok: false, error: 'Elige al menos un filtro, un trabajador o un número directo: no se permite difusión a todo el grupo sin acotar.' }, 400);
      }
      // Destinatarios: numero directo (1 fila sintetica) o roster completo.
      let r, rows;
      if (direct) {
        r = { total: 1 };
        rows = [{ id_number: 'directo', full_name: 'Número directo (prueba)', company_code: '', phone: direct.raw, phone_ok: true }];
      } else {
        r = await rpc(env, 'wa_recipients', { ...filters, p_limit: 100000 });
        rows = ((r && r.rows) || []).filter(x => x.phone_ok);
      }
      if (!rows.length) return json({ ok: false, error: 'Ningún destinatario del filtro tiene teléfono válido.' }, 400);

      const batch = await sb(env, 'wa_batches', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          created_by: actorName,
          message,
          filters: direct
            ? { direct_phone: direct.raw }
            : Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== null)),
          total: (r && r.total) || rows.length,
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
          chat_id: toChatId(x.phone),
        }))),
      });
      return json({ ok: true, batch_id: batchId, queued: rows.length });
    }

    /* ---------------- process: enviar una tanda ---------------- */
    if (action === 'process') {
      const bid = String(body.batch_id || '');
      if (!bid) return json({ ok: false, error: 'Falta el lote.' }, 400);
      const batch = await sb(env, `wa_batches?id=eq.${encodeURIComponent(bid)}&select=id,message`);
      if (!batch || !batch.length) return json({ ok: false, error: 'El lote no existe.' }, 404);
      const message = batch[0].message;

      const pend = await sb(env,
        `wa_outbox?batch_id=eq.${encodeURIComponent(bid)}&status=eq.pending&select=id,chat_id&order=id.asc&limit=${BATCH_SIZE}`);
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
        await sleep(DELAY_MS);
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
