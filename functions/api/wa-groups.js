/* =====================================================================
   functions/api/wa-groups.js  →  POST /api/wa-groups   (v4.93, v4.97)
   Catalogo de GRUPOS de WhatsApp de la linea corporativa + alcance
   por administrador (tabla puente nomina_v2.wa_group_admins).

   Modelo de autorizacion (dos niveles, como el resto del portal):
     1) Permisos de rol (Roles): view.whatsapp (menu) y wa.send (enviar).
     2) Alcance por admin (wa_group_admins): a QUE grupos puede publicar.
   - Superadmin: gobierna el catalogo (discover/save/grant/revoke) y ve
     todos los grupos.
   - Admin no-super con permisos concedidos: 'list' le devuelve SOLO sus
     grupos HABILITADOS asignados (para el combo de Difusion) y
     mode:'admin' para que la vista se adapte.

   Acciones (POST { action, user, ... }):
     list     {}                        gate: view.whatsapp (scoped)
     discover {}                        gate: SOLO superadmin
     save     { id, alias?, enabled? }  gate: SOLO superadmin
     grant    { group_id, admin_id }    gate: SOLO superadmin
     revoke   { group_id, admin_id }    gate: SOLO superadmin
   ===================================================================== */

import { resolveActor, can, isSuperadmin } from './_auth.js';
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
    const superOk = isSuperadmin(actor);

    /* ---------------- list (scoped por actor) ---------------- */
    if (action === 'list') {
      if (superOk) {
        const [rows, assign, admins] = await Promise.all([
          sb(env, 'wa_groups?select=*&order=enabled.desc,wa_name.asc'),
          sb(env, 'wa_group_admins?select=group_id,admin_id'),
          sb(env, 'admin_users?is_active=eq.true&role=neq.superadmin&select=id,name,username&order=name.asc'),
        ]);
        return json({
          ok: true, mode: 'super',
          groups: rows || [], assign: assign || [], admins: admins || [],
          phone: env.GREENAPI_PHONE || null,
        });
      }
      // Admin no-super: SOLO sus grupos habilitados asignados.
      const adminId = Number(body.user && body.user.id) || 0;
      const links = await sb(env, `wa_group_admins?admin_id=eq.${adminId}&select=group_id`);
      const ids = (links || []).map(l => l.group_id);
      let rows = [];
      if (ids.length) {
        rows = await sb(env,
          `wa_groups?id=in.(${ids.join(',')})&enabled=eq.true&select=id,chat_id,wa_name,alias,enabled&order=wa_name.asc`);
      }
      return json({ ok: true, mode: 'admin', groups: rows || [], phone: env.GREENAPI_PHONE || null });
    }

    /* ---------- gobernanza del catalogo: SOLO superadmin ---------- */
    if (!superOk) {
      return json({ ok: false, error: 'La administración de grupos es exclusiva del superadministrador.' }, 403);
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
      const [rows, assign, admins] = await Promise.all([
        sb(env, 'wa_groups?select=*&order=enabled.desc,wa_name.asc'),
        sb(env, 'wa_group_admins?select=group_id,admin_id'),
        sb(env, 'admin_users?is_active=eq.true&role=neq.superadmin&select=id,name,username&order=name.asc'),
      ]);
      return json({
        ok: true, mode: 'super', found: upserted,
        groups: rows || [], assign: assign || [], admins: admins || [],
        phone: env.GREENAPI_PHONE || null,
      });
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

    /* grant / revoke: alcance por admin (v4.97) */
    if (action === 'grant' || action === 'revoke') {
      const groupId = Number(body.group_id || 0);
      const adminId = Number(body.admin_id || 0);
      if (!groupId || !adminId) return json({ ok: false, error: 'Faltan el grupo o el administrador.' }, 400);

      if (action === 'grant') {
        // Solo admins activos no-superadmin (el super no necesita filas).
        const adm = await sb(env, `admin_users?id=eq.${adminId}&is_active=eq.true&role=neq.superadmin&select=id`);
        if (!adm || !adm.length) return json({ ok: false, error: 'Ese administrador no existe, está inactivo o es superadministrador.' }, 400);
        await sb(env, 'wa_group_admins?on_conflict=group_id,admin_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify([{ group_id: groupId, admin_id: adminId, granted_by: actorName }]),
        });
      } else {
        await sb(env, `wa_group_admins?group_id=eq.${groupId}&admin_id=eq.${adminId}`, {
          method: 'DELETE', headers: { Prefer: 'return=minimal' },
        });
      }
      const assign = await sb(env, 'wa_group_admins?select=group_id,admin_id');
      return json({ ok: true, assign: assign || [] });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (e) {
    if (e && e.name === 'AuthError') return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error interno: ' + (e && e.message ? e.message : e) }, 500);
  }
}
