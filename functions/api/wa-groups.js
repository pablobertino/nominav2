/* =====================================================================
   functions/api/wa-groups.js  →  POST /api/wa-groups   (v4.93)
   Catalogo de GRUPOS de WhatsApp de la linea corporativa.

   Flujo: 'discover' consulta al proveedor los chats de la cuenta
   (getChats), filtra los grupos (la linea debe SER MIEMBRO para verlos
   y para poder enviarles) y los upserta en nomina_v2.wa_groups
   refrescando el nombre real. 'save' fija alias interno del portal y el
   toggle enabled (solo los HABILITADOS aparecen como destino en la
   pantalla Difusion). 'list' devuelve el catalogo.

   Acciones (POST { action, user, ... }):
     list     {}                            gate: view.whatsapp
     discover {}                            gate: wa.send
     save     { id, alias?, enabled? }      gate: wa.send

   FUTURO: wa_group_admins (group_id, admin_id) para habilitar grupos
   por admin; este endpoint ganara acciones grant/revoke y 'list'
   filtrara por el actor cuando no sea superadmin.
   ===================================================================== */

import { resolveActor, can } from './_auth.js';
import { gaClient } from './_greenapi.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
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

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Cuerpo inválido.' }, 400); }
  const action = body.action || 'list';

  try {
    const actor = await resolveActor(env, body.user);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);
    if (!can(actor, 'view.whatsapp')) {
      return json({ ok: false, error: 'No tienes permiso para esta pantalla (view.whatsapp).' }, 403);
    }
    const actorName = String(actor.actor || '');

    if (action === 'list') {
      const rows = await sb(env, 'wa_groups?select=*&order=enabled.desc,wa_name.asc');
      return json({ ok: true, groups: rows || [], phone: env.GREENAPI_PHONE || null });
    }

    /* ------------- seteo: exige la llave de envio ------------- */
    if (!can(actor, 'wa.send')) {
      return json({ ok: false, error: 'No tienes permiso para administrar los grupos (wa.send).' }, 403);
    }

    /* discover: leer los grupos donde la linea es miembro y upsert */
    if (action === 'discover') {
      const chats = await gaClient(env).getChats();
      const groups = (Array.isArray(chats) ? chats : [])
        .filter(c => c && (c.type === 'group' || String(c.id || '').endsWith('@g.us')))
        .map(c => ({ chat_id: String(c.id), wa_name: c.name || null }));

      let upserted = 0;
      const now = new Date().toISOString();
      if (groups.length) {
        // Upsert por chat_id: refresca el nombre real, conserva alias/enabled.
        await sb(env, 'wa_groups?on_conflict=chat_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(groups.map(g => ({
            chat_id: g.chat_id, wa_name: g.wa_name,
            refreshed_at: now, updated_by: actorName,
          }))),
        });
        upserted = groups.length;
      }
      const rows = await sb(env, 'wa_groups?select=*&order=enabled.desc,wa_name.asc');
      return json({ ok: true, found: upserted, groups: rows || [], phone: env.GREENAPI_PHONE || null });
    }

    /* save: alias interno + habilitado */
    if (action === 'save') {
      const id = Number(body.id || 0);
      if (!id) return json({ ok: false, error: 'Falta el grupo.' }, 400);
      const patch = { updated_by: actorName };
      if (body.alias !== undefined) patch.alias = String(body.alias || '').trim() || null;
      if (body.enabled !== undefined) patch.enabled = !!body.enabled;
      const r = await sb(env, `wa_groups?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      if (!r || !r.length) return json({ ok: false, error: 'El grupo no existe.' }, 404);
      return json({ ok: true, group: r[0] });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (e) {
    if (e && e.name === 'AuthError') return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error interno: ' + (e && e.message ? e.message : e) }, 500);
  }
}
