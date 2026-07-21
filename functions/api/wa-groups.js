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
     list       {}                        gate: view.whatsapp (scoped)
     discover   {}                        gate: SOLO superadmin (sincroniza: agrega y quita)
     save       { id, alias?, enabled? }  gate: SOLO superadmin
     remove     { id }                     gate: SOLO superadmin
     remove_all {}                          gate: SOLO superadmin
     grant      { group_id, admin_id }     gate: SOLO superadmin
     revoke     { group_id, admin_id }     gate: SOLO superadmin
   ===================================================================== */

import { resolveActor, can, isSuperadmin } from './_auth.js';
import { gaClient, groupMemberCount } from './_greenapi.js';

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

    /* discover: SINCRONIZA con WhatsApp. Refleja lo que hay en la linea AHORA:
       - upsert de los grupos presentes (refresca nombre, conserva alias/enabled)
       - QUITA los que ya no aparecen (la linea salio o los cambio de telefono),
         borrando primero sus asignaciones. Asi la lista siempre espeja WhatsApp.
       (v6.53: antes solo agregaba/refrescaba y dejaba colgados los viejos.) */
    if (action === 'discover') {
      const ga = gaClient(env);
      const chats = await ga.getChats();
      const groups = (Array.isArray(chats) ? chats : [])
        .filter(c => c && (c.type === 'group' || String(c.id || '').endsWith('@g.us')))
        .map(c => ({ chat_id: String(c.id), wa_name: c.name || null }));

      const now = new Date().toISOString();
      const seen = new Set(groups.map(g => g.chat_id));

      // Conteo de miembros por grupo (getGroupData). Es una llamada por
      // grupo, con un respiro corto entre una y otra por cortesia a la API
      // (la doc avisa que llamar muy seguido limita el invite link, no el
      // conteo). Si un grupo falla, se deja su conteo en null (no se pisa un
      // dato viejo con 0): mejor "sin dato" que un numero inventado.
      const counts = {};
      for (let i = 0; i < groups.length; i++) {
        try {
          const data = await ga.getGroupData(groups[i].chat_id);
          counts[groups[i].chat_id] = groupMemberCount(data);
        } catch (_) {
          counts[groups[i].chat_id] = null;
        }
        if (i < groups.length - 1) await sleep(600);
      }

      // 1) Upsert de los presentes (refresca nombre y conteo, conserva
      //    alias/enabled). El conteo solo se manda cuando se pudo obtener,
      //    para no borrar con null un valor previo si esta vez fallo.
      if (groups.length) {
        await sb(env, 'wa_groups?on_conflict=chat_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(groups.map(g => {
            const row = {
              chat_id: g.chat_id, wa_name: g.wa_name,
              refreshed_at: now, updated_by: actorName,
            };
            if (counts[g.chat_id] != null) row.participants = counts[g.chat_id];
            return row;
          })),
        });
      }

      // 2) Quitar los que ya NO estan en la linea. Compara contra lo que
      //    hay en la tabla; los ausentes se borran (con sus asignaciones).
      const existing = await sb(env, 'wa_groups?select=id,chat_id') || [];
      const stale = existing.filter(r => !seen.has(r.chat_id));
      let removed = 0;
      if (stale.length) {
        const ids = stale.map(r => r.id);
        await sb(env, `wa_group_admins?group_id=in.(${ids.join(',')})`, {
          method: 'DELETE', headers: { Prefer: 'return=minimal' },
        });
        await sb(env, `wa_groups?id=in.(${ids.join(',')})`, {
          method: 'DELETE', headers: { Prefer: 'return=minimal' },
        });
        removed = stale.length;
      }

      const [rows, assign, admins] = await Promise.all([
        sb(env, 'wa_groups?select=*&order=enabled.desc,wa_name.asc'),
        sb(env, 'wa_group_admins?select=group_id,admin_id'),
        sb(env, 'admin_users?is_active=eq.true&role=neq.superadmin&select=id,name,username&order=name.asc'),
      ]);
      return json({
        ok: true, mode: 'super', found: groups.length, removed,
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

    /* remove: quitar un grupo del catalogo (v6.52). Util para limpiar los
       grupos que quedaron de una linea anterior tras cambiar de telefono:
       el discover agrega/refresca pero no borra, asi que estos quedan
       colgados. Borra primero sus asignaciones (wa_group_admins) por si
       tuviera, y luego el grupo. Solo superadmin (gate de arriba). */
    if (action === 'remove') {
      const id = Number(body.id || 0);
      if (!id) return json({ ok: false, error: 'Falta el grupo.' }, 400);
      // Fuera primero las asignaciones (evita filas puente huerfanas).
      await sb(env, `wa_group_admins?group_id=eq.${id}`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' },
      });
      const r = await sb(env, `wa_groups?id=eq.${id}`, {
        method: 'DELETE', headers: { Prefer: 'return=representation' },
      });
      if (!r || !r.length) return json({ ok: false, error: 'El grupo no existe.' }, 404);
      return json({ ok: true, removed: id });
    }

    /* remove_all: vaciar el catalogo entero (v6.53). Borra todas las
       asignaciones y todos los grupos. Util para empezar de cero tras un
       cambio de linea. Solo superadmin (gate de arriba). */
    if (action === 'remove_all') {
      // neq.0 => borra todas las filas (el id es bigint > 0).
      await sb(env, 'wa_group_admins?id=neq.0', {
        method: 'DELETE', headers: { Prefer: 'return=minimal' },
      });
      await sb(env, 'wa_groups?id=neq.0', {
        method: 'DELETE', headers: { Prefer: 'return=minimal' },
      });
      return json({ ok: true, groups: [], assign: [] });
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
