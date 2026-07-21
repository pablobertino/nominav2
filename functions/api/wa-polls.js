/* =====================================================================
   functions/api/wa-polls.js  →  POST /api/wa-polls
   Encuestas de WhatsApp (Green-API) - FASE A: crear, publicar y REGISTRAR.
   El frontend NUNCA habla con Green-API: todo pasa por este proxy que
   valida permisos (mismo patron que wa-send.js).

   SOLO GRUPOS (como Difusion desde v6.50): una encuesta se publica en un
   grupo habilitado; jamas a un chat individual.

   Acciones (POST { action, user, ... }):
     groups {}                                   -> grupos habilitados para
                el selector (mismos que ve el usuario segun su alcance)
                gate: view.whatsapp
     list   {}                                   -> historial de encuestas
                enviadas (wa_polls), mas recientes primero
                gate: view.whatsapp
     send   { question, options[], multiple, group_id }
                -> crea la encuesta en WhatsApp (sendPoll), guarda el
                   registro en wa_polls con el idMessage devuelto
                -> { ok, poll }               gate: wa.send

   FASE B (futura, NO implementada aca): leer los votos. Requerira activar
   en la instancia los settings incomingWebhook + pollMessageWebhook y un
   endpoint que reciba los PollUpdateMessage y los amarre por id_message.
   Por eso el id_message se guarda desde ya.

   Limites de Green-API (validados en _greenapi.sendPoll y aca):
     - pregunta (message) <= 255 caracteres
     - entre 2 y 12 opciones, unicas entre si
     - cada opcion (optionName) <= 100 caracteres
   ===================================================================== */

import { resolveActor, can, isSuperadmin } from './_auth.js';
import { gaClient } from './_greenapi.js';

const Q_MAX = 255;      // limite de la pregunta (Green-API)
const OPT_MAX = 100;    // limite por opcion (Green-API)
const OPT_MIN_N = 2;    // minimo de opciones
const OPT_MAX_N = 12;   // maximo de opciones

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

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

/* Grupo habilitado como destino. Igual que en wa-send: si restrictAdminId
   viene (admin no-super), el grupo ademas debe estar ASIGNADO a ese admin
   en wa_group_admins. */
async function pickGroup(env, gid, restrictAdminId) {
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

/* Sanea las opciones: recorta, quita vacias, valida largo y unicidad. */
function cleanOptions(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const s = String(x == null ? '' : x).trim();
    if (!s) continue;
    if (s.length > OPT_MAX) return { error: `Cada opción debe tener máximo ${OPT_MAX} caracteres.` };
    const key = s.toLowerCase();
    if (seen.has(key)) return { error: 'Las opciones no pueden repetirse.' };
    seen.add(key);
    out.push(s);
  }
  if (out.length < OPT_MIN_N) return { error: `La encuesta necesita al menos ${OPT_MIN_N} opciones.` };
  if (out.length > OPT_MAX_N) return { error: `La encuesta admite máximo ${OPT_MAX_N} opciones.` };
  return { options: out };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Cuerpo inválido.' }, 400); }
  const action = body.action || 'list';

  try {
    const actor = await resolveActor(env, body.user);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);
    if (!can(actor, 'view.whatsapp')) {
      return json({ ok: false, error: 'No tienes permiso para WhatsApp (view.whatsapp).' }, 403);
    }
    const actorName = String(actor.actor || '');
    const superOk = isSuperadmin(actor);
    const restrictId = superOk ? null : (Number(body.user && body.user.id) || -1);

    /* -------- groups: grupos habilitados para el selector -------- */
    if (action === 'groups') {
      // Superadmin ve todos los habilitados; admin no-super solo los suyos.
      let rows;
      if (superOk) {
        rows = await sb(env, 'wa_groups?enabled=eq.true&select=id,chat_id,wa_name,alias&order=wa_name.asc');
      } else {
        const links = await sb(env,
          `wa_group_admins?admin_id=eq.${restrictId}&select=group_id`);
        const ids = (links || []).map(l => l.group_id);
        if (!ids.length) rows = [];
        else rows = await sb(env,
          `wa_groups?enabled=eq.true&id=in.(${ids.join(',')})&select=id,chat_id,wa_name,alias&order=wa_name.asc`);
      }
      return json({ ok: true, groups: rows || [], phone: env.GREENAPI_PHONE || null });
    }

    /* -------- list: historial de encuestas enviadas -------- */
    if (action === 'list') {
      // Superadmin ve todo; admin no-super ve solo las que el creo.
      const flt = superOk ? '' : `&created_by=eq.${encodeURIComponent(actorName)}`;
      const rows = await sb(env,
        `wa_polls?select=*${flt}&order=created_at.desc&limit=100`);
      return json({ ok: true, polls: rows || [] });
    }

    /* ------------- lo que sigue exige la llave de envio ------------- */
    if (!can(actor, 'wa.send')) {
      return json({ ok: false, error: 'No tienes permiso para enviar por WhatsApp (wa.send).' }, 403);
    }

    /* -------- send: crear encuesta, publicar y registrar -------- */
    if (action === 'send') {
      const question = String(body.question || '').trim();
      if (!question) return json({ ok: false, error: 'Escribe la pregunta de la encuesta.' }, 400);
      if (question.length > Q_MAX) {
        return json({ ok: false, error: `La pregunta supera los ${Q_MAX} caracteres.` }, 400);
      }
      const cleaned = cleanOptions(body.options);
      if (cleaned.error) return json({ ok: false, error: cleaned.error }, 400);
      const multiple = !!body.multiple;

      if (!Number(body.group_id || 0)) {
        return json({ ok: false, error: 'Elige el grupo donde se publica la encuesta.' }, 400);
      }
      const grp = await pickGroup(env, Number(body.group_id), restrictId);
      if (grp === undefined) {
        return json({ ok: false, error: 'Ese grupo no está habilitado o no está asignado a tu usuario.' }, 400);
      }
      if (!grp || !isGroupChat(grp.chat_id)) {
        return json({ ok: false, error: 'El destino no es un grupo válido de WhatsApp.' }, 400);
      }

      // 1) Publicar en WhatsApp.
      const ga = gaClient(env);
      let idMessage = null, status = 'sent', errText = null;
      try {
        const res = await ga.sendPoll(grp.chat_id, question, cleaned.options, multiple);
        idMessage = (res && res.idMessage) || null;
      } catch (e) {
        status = 'error';
        errText = String(e && e.message ? e.message : e).slice(0, 300);
      }

      // 2) Registrar SIEMPRE (enviada o con error) para dejar rastro.
      const groupName = grp.alias || grp.wa_name || grp.chat_id;
      const saved = await sb(env, 'wa_polls', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          question,
          options: cleaned.options,
          multiple_answers: multiple,
          group_id: grp.id,
          group_name: groupName,
          chat_id: grp.chat_id,
          id_message: idMessage,
          created_by: actorName,
          status,
        }),
      });
      const poll = saved && saved[0];

      if (status === 'error') {
        return json({ ok: false, error: 'No se pudo publicar la encuesta: ' + (errText || 'error de la línea.'), poll }, 502);
      }
      return json({ ok: true, poll });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (e) {
    if (e && e.name === 'AuthError') return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error interno: ' + (e && e.message ? e.message : e) }, 500);
  }
}
