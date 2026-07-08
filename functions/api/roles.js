/* =====================================================================
   functions/api/roles.js  →  POST /api/roles
   Matriz de Roles y Permisos (vista Roles, mockup v0-mock6).

   Fuente de verdad: nomina_v2.roles / permissions / role_permissions,
   las mismas tablas que consume can() de _auth.js. Al guardar se invalida
   el cache de permisos del isolate (los demas isolates refrescan por TTL
   de 15s).

   Acciones (POST {action, user}):
     - matrix : roles (con conteo de permisos y de usuarios) + catalogo de
                permisos activos (code, label, domain, kind, sort_order) +
                asignaciones por rol. Gate REAL: can('view.roles')
                (superadmin pasa por bypass; se puede conceder a otros).
     - save   : { role_code, grants:[codes...] } reemplaza la matriz del
                rol. Aplica en el SERVIDOR la regla "usar implica ver"
                (config.* enciende su view.cfg.*). SOLO superadmin.
                El rol 'superadmin' no se edita (tiene todo por codigo).
     - rename : { role_code, label } SOLO superadmin; roles no-sistema.
     - toggle : { role_code, is_active } SOLO superadmin; roles no-sistema;
                no se puede desactivar un rol con usuarios activos.
     - create : { code, label } SOLO superadmin; rol estandar nuevo, sin
                permisos (se asignan luego desde la matriz).

   'user' = { kind:'admin', id }
   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { resolveActor, can, isSuperadmin, invalidatePermCache } from './_auth.js';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
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

/* Regla "usar implica ver": encender un permiso de USO de Configuracion
   enciende (y sostiene) el VER de su pestana. Se aplica aqui ademas del
   front para que la invariante viva en el servidor. */
const IMPLIES = {
  'config.referencias': 'view.cfg.referencias',
  'config.cargos': 'view.cfg.cargos',
  'config.incidencias': 'view.cfg.incidencias',
  'config.calendario': 'view.cfg.calendario',
  'config.sincronizacion': 'view.cfg.sincronizacion',
  'config.osticket': 'view.cfg.osticket',
  'settings.save': 'view.cfg.ajustes',
};

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const action = body.action;

  try {
    const actor = await resolveActor(env, body.user);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
    // Gate REAL de lectura: view.roles (hoy solo superadmin por bypass).
    if (!can(actor, 'view.roles')) {
      return json({ ok: false, error: 'No tienes permiso para gestionar roles.' }, 403);
    }

    /* ---------- matriz completa ---------- */
    if (action === 'matrix') {
      const [roles, perms, rps, admins, tiendas] = await Promise.all([
        sb(env, 'roles?select=code,label,is_system,readonly_scope,is_active,sort_order&order=sort_order.asc,code.asc'),
        sb(env, 'permissions?is_active=eq.true&select=code,label,domain,kind,sort_order,help&order=sort_order.asc,code.asc'),
        sb(env, 'role_permissions?select=role_code,permission_code'),
        sb(env, 'admin_users?is_active=eq.true&select=role'),
        sb(env, 'company_users?is_active=eq.true&select=company_code'),
      ]);
      const grants = {};
      (rps || []).forEach(r => { (grants[r.role_code] = grants[r.role_code] || []).push(r.permission_code); });
      const userCount = {};
      (admins || []).forEach(a => { userCount[a.role] = (userCount[a.role] || 0) + 1; });
      userCount['tienda'] = (tiendas || []).length;
      const activeCodes = new Set((perms || []).map(p => p.code));
      const out = (roles || []).map(r => ({
        ...r,
        // conteo solo de permisos ACTIVOS (los retirados no cuentan)
        perm_count: r.code === 'superadmin' ? null : (grants[r.code] || []).filter(c => activeCodes.has(c)).length,
        user_count: userCount[r.code] || 0,
      }));
      return json({ ok: true, roles: out, permissions: perms || [], grants, me: { role: actor.role } });
    }

    /* ---------- escritura: SOLO superadmin ---------- */
    if (!isSuperadmin(actor)) {
      return json({ ok: false, error: 'La gestion de roles esta reservada al superadministrador.' }, 403);
    }

    if (action === 'save') {
      const roleCode = String(body.role_code || '').trim();
      if (!roleCode) return json({ ok: false, error: 'Falta el rol.' }, 400);
      if (roleCode === 'superadmin') return json({ ok: false, error: 'El superadmin tiene todos los permisos; no se edita.' }, 400);
      const role = await sb(env, `roles?code=eq.${encodeURIComponent(roleCode)}&select=code`);
      if (!role || !role.length) return json({ ok: false, error: 'Rol no encontrado.' }, 404);

      // Codes pedidos: solo permisos ACTIVOS existentes + regla usar->ver.
      const perms = await sb(env, 'permissions?is_active=eq.true&select=code');
      const valid = new Set((perms || []).map(p => p.code));
      const asked = Array.isArray(body.grants) ? body.grants.map(c => String(c).trim()).filter(Boolean) : [];
      const set = new Set(asked.filter(c => valid.has(c)));
      // usar implica ver (servidor):
      for (const [useCode, viewCode] of Object.entries(IMPLIES)) {
        if (set.has(useCode) && valid.has(viewCode)) set.add(viewCode);
      }
      const grants = [...set];

      // Reemplazo total de la matriz del rol.
      await sb(env, `role_permissions?role_code=eq.${encodeURIComponent(roleCode)}`, { method: 'DELETE' });
      if (grants.length) {
        await sb(env, 'role_permissions', {
          method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(grants.map(c => ({ role_code: roleCode, permission_code: c }))),
        });
      }
      invalidatePermCache(roleCode);
      return json({ ok: true, role_code: roleCode, granted: grants.length });
    }

    if (action === 'rename') {
      const roleCode = String(body.role_code || '').trim();
      const label = String(body.label || '').trim();
      if (!roleCode) return json({ ok: false, error: 'Falta el rol.' }, 400);
      if (label.length < 2 || label.length > 60) return json({ ok: false, error: 'El nombre debe tener entre 2 y 60 caracteres.' }, 400);
      const role = await sb(env, `roles?code=eq.${encodeURIComponent(roleCode)}&select=code,is_system`);
      if (!role || !role.length) return json({ ok: false, error: 'Rol no encontrado.' }, 404);
      if (role[0].is_system) return json({ ok: false, error: 'Los roles de sistema no se renombran.' }, 400);
      await sb(env, `roles?code=eq.${encodeURIComponent(roleCode)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ label }),
      });
      return json({ ok: true, role_code: roleCode, label });
    }

    if (action === 'toggle') {
      const roleCode = String(body.role_code || '').trim();
      if (!roleCode) return json({ ok: false, error: 'Falta el rol.' }, 400);
      const role = await sb(env, `roles?code=eq.${encodeURIComponent(roleCode)}&select=code,is_system,is_active`);
      if (!role || !role.length) return json({ ok: false, error: 'Rol no encontrado.' }, 404);
      if (role[0].is_system) return json({ ok: false, error: 'Los roles de sistema no se desactivan.' }, 400);
      const active = body.is_active !== false;
      if (!active) {
        // No dejar sin rol a usuarios activos.
        const inUse = await sb(env, `admin_users?role=eq.${encodeURIComponent(roleCode)}&is_active=eq.true&select=id&limit=1`);
        if (inUse && inUse.length) {
          return json({ ok: false, error: 'No se puede desactivar: hay usuarios activos con este rol. Cambiales el rol primero.' }, 409);
        }
      }
      await sb(env, `roles?code=eq.${encodeURIComponent(roleCode)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: active }),
      });
      invalidatePermCache(roleCode);
      return json({ ok: true, role_code: roleCode, is_active: active });
    }

    if (action === 'create') {
      const code = String(body.code || '').trim().toLowerCase();
      const label = String(body.label || '').trim();
      if (!/^[a-z][a-z0-9_]{2,30}$/.test(code)) {
        return json({ ok: false, error: 'Codigo invalido: minusculas, numeros y _, de 3 a 31 caracteres, empezando con letra.' }, 400);
      }
      if (label.length < 2 || label.length > 60) return json({ ok: false, error: 'El nombre debe tener entre 2 y 60 caracteres.' }, 400);
      const dup = await sb(env, `roles?code=eq.${encodeURIComponent(code)}&select=code`);
      if (dup && dup.length) return json({ ok: false, error: 'Ya existe un rol con ese codigo.' }, 409);
      const maxRows = await sb(env, 'roles?select=sort_order&order=sort_order.desc&limit=1');
      const nextSort = ((maxRows && maxRows[0] && maxRows[0].sort_order) || 0) + 10;
      await sb(env, 'roles', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ code, label, is_system: false, readonly_scope: false, is_active: true, sort_order: nextSort }),
      });
      return json({ ok: true, code, label });
    }

    return json({ ok: false, error: 'Accion no reconocida.' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
