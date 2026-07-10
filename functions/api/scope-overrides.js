/* =====================================================================
   functions/api/scope-overrides.js  →  Alcance por sección (v4.83)

   Overrides de alcance por miembro del Equipo y sección. El miembro
   conserva su alcance base (get_admin_companies) en todo el portal; en
   las secciones con override el servidor resuelve el alcance ampliado
   via get_admin_companies_scoped(admin_id, section). Secciones activas:
     'bank' → Datos bancarios (Cuentas + Estadísticas, consulta).
   Mockup aprobado: _PRUEBAS/equipo_alcance_overrides_mockup.html.

   Acciones (POST { action, user, ... }):
     list      { admin_ids:[..] }   → overrides de esos miembros
                 gate: view.equipo (ver la ficha ya exige eso)
     save      { admin_id, section, scope_kind, company_codes?, include_base }
                 scope_kind 'inherit' BORRA el override (vuelve al base)
                 gate: team.scope_override (nace solo-superadmin)
     preview   { admin_id, scope_kind, company_codes?, include_base }
                 → { base_n, extra_n, total_n }  gate: team.scope_override
     companies {} → catálogo liviano para el modo Personalizado
                 gate: team.scope_override
   ===================================================================== */

import { resolveActor, can } from './_auth.js';

const SECTIONS = new Set(['bank']);
const KINDS = new Set(['all', 'stores', 'non_stores', 'custom', 'types']);

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

async function rpc(env, fn, args) {
  return sb(env, `rpc/${fn}`, { method: 'POST', body: JSON.stringify(args || {}) });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Cuerpo inválido.' }, 400); }
  const action = body.action || 'list';

  try {
    const actor = await resolveActor(env, body.user);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);

    /* ---------- list: overrides de uno o varios miembros ---------- */
    if (action === 'list') {
      if (!can(actor, 'view.equipo')) {
        return json({ ok: false, error: 'No tienes permiso para ver el Equipo (view.equipo).' }, 403);
      }
      const ids = (Array.isArray(body.admin_ids) ? body.admin_ids : [])
        .map(n => parseInt(n, 10)).filter(n => Number.isFinite(n));
      if (!ids.length) return json({ ok: true, overrides: [], canEdit: can(actor, 'team.scope_override') });
      const rows = await sb(env,
        `admin_scope_overrides?admin_id=in.(${ids.join(',')})`
        + `&select=admin_id,section,scope_kind,company_codes,company_types,include_base,updated_at,updated_by`);
      return json({ ok: true, overrides: rows || [], canEdit: can(actor, 'team.scope_override') });
    }

    /* ---------- todo lo demás exige la llave del override ---------- */
    if (!can(actor, 'team.scope_override')) {
      return json({ ok: false, error: 'No tienes permiso para definir alcances por sección (team.scope_override).' }, 403);
    }

    if (action === 'preview') {
      const adminId = parseInt(body.admin_id, 10);
      const kind = String(body.scope_kind || '');
      if (!Number.isFinite(adminId)) return json({ ok: false, error: 'Miembro inválido.' }, 400);
      if (!KINDS.has(kind)) return json({ ok: false, error: 'Tipo de alcance inválido.' }, 400);
      const p = await rpc(env, 'scope_override_preview', {
        p_admin_id: adminId,
        p_scope_kind: kind,
        p_company_codes: Array.isArray(body.company_codes) ? body.company_codes : null,
        p_company_types: Array.isArray(body.company_types) ? body.company_types : null,
        p_include_base: body.include_base !== false,
      });
      return json({ ok: true, ...(p || {}) });
    }

    if (action === 'companies') {
      const rows = await sb(env,
        'companies?select=company_code,business_name,company_type&order=business_name.asc');
      return json({ ok: true, companies: rows || [] });
    }

    if (action === 'save') {
      const adminId = parseInt(body.admin_id, 10);
      const section = String(body.section || '');
      const kind = String(body.scope_kind || '');
      if (!Number.isFinite(adminId)) return json({ ok: false, error: 'Miembro inválido.' }, 400);
      if (!SECTIONS.has(section)) return json({ ok: false, error: 'Sección inválida.' }, 400);

      // Protección: nunca sobre un superadmin (ya lo ve todo) ni sobre uno mismo
      // sin ser superadmin (evita auto-ampliarse el alcance con la llave prestada).
      const target = await sb(env, `admin_users?id=eq.${adminId}&select=id,role,username`);
      if (!target || !target.length) return json({ ok: false, error: 'El miembro no existe.' }, 404);
      if (target[0].role === 'superadmin') {
        return json({ ok: false, error: 'Un superadmin ya ve todo: no aplica override.' }, 400);
      }
      if (actor.role !== 'superadmin' && String(target[0].username) === String(actor.actor)) {
        return json({ ok: false, error: 'No puedes definir tu propio alcance por sección.' }, 403);
      }

      if (kind === 'inherit') {
        await sb(env, `admin_scope_overrides?admin_id=eq.${adminId}&section=eq.${encodeURIComponent(section)}`,
          { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        return json({ ok: true, removed: true });
      }

      if (!KINDS.has(kind)) return json({ ok: false, error: 'Tipo de alcance inválido.' }, 400);
      let codes = null, types = null;
      if (kind === 'custom') {
        codes = (Array.isArray(body.company_codes) ? body.company_codes : [])
          .map(c => String(c || '').trim()).filter(Boolean);
        if (!codes.length) return json({ ok: false, error: 'El alcance personalizado necesita al menos una empresa.' }, 400);
      }
      if (kind === 'types') {
        types = (Array.isArray(body.company_types) ? body.company_types : [])
          .map(c => String(c || '').trim()).filter(Boolean);
        if (!types.length) return json({ ok: false, error: 'El alcance por tipos necesita al menos un tipo de empresa.' }, 400);
      }

      await sb(env, 'admin_scope_overrides?on_conflict=admin_id,section', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          admin_id: adminId, section,
          scope_kind: kind,
          company_codes: codes,
          company_types: types,
          include_base: body.include_base !== false,
          updated_at: new Date().toISOString(),
          updated_by: String(actor.actor || ''),
        }),
      });
      return json({ ok: true, saved: true });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (e) {
    if (e && e.name === 'AuthError') return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error interno: ' + (e && e.message ? e.message : e) }, 500);
  }
}
