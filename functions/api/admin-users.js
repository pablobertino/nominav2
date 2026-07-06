/* =====================================================================
   functions/api/admin-users.js  →  /api/admin-users
   Gestion del Equipo. superadmin: todo (crear, cambiar rol, ver todos los
   roles, sync masivo). admin no-super: VE y gestiona (reset/toggle/osTicket)
   SOLO los gestor_empresa entrelazados con su alcance (gestores_in_admin_scope).
   Acciones (POST {action}): list, create, reset, toggle, update_role,
   sync_client, sync_clients_all.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { shadowCan } from './_auth.js';

const SALT = 'nm_salt_2025';

// Mapa accion -> code de permiso (para el shadow). Todas las acciones de este
// endpoint estan bajo el gate superadmin legacy; el code fino permite que en
// la pasada final un rol no-super pueda tener solo parte (ej. team.role).
const TEAM_CODE_BY_ACTION = {
  list: 'view.equipo',
  create: 'team.create',
  reset: 'team.reset',
  toggle: 'team.toggle',
  update_role: 'team.role',
  sync_client: 'team.osticket',
  sync_clients_all: 'team.osticket',
};

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }); }

async function hashPassword(pwd) {
  const data = new TextEncoder().encode(pwd + SALT);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function genTempPassword() {
  const part = () => Math.random().toString(36).slice(2, 6);
  return `Tmp-${part()}-${part()}`;
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

async function getActiveAdmin(env, adminId) {
  if (!adminId) return null;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id,role`);
  return r && r.length ? r[0] : null;
}

// Set de ids de gestor_empresa entrelazados con el alcance de un admin (via
// RPC gestores_in_admin_scope). Para superadmin devuelve null (sin limite).
async function gestorScopeSet(env, admin) {
  if (admin.role === 'superadmin') return null;
  const r = await sb(env, 'rpc/gestores_in_admin_scope', {
    method: 'POST', body: JSON.stringify({ p_admin_id: admin.id }),
  });
  return new Set((r || []).map(x => Number(x)));
}

/* ---- osTicket (lado CLIENTE/user) ----
   El gestor_empresa se crea como usuario CLIENTE de osTicket (abre/consulta
   tickets), identificado por email via la API gc-user.json (la misma que usan
   las tiendas en osticket-users.js). NO es agente: no toca osticket_staff_id.
   Secret: osticket_api_key. Setting: osticket_url. */
async function getSetting(env, key, fallback) {
  const r = await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  return (r && r[0] && r[0].value != null) ? r[0].value : fallback;
}
async function osticketBase(env) {
  const url = await getSetting(env, 'osticket_url', '');
  return String(url || '').replace(/\/+$/, '');
}
// Crea/actualiza un usuario cliente en osTicket por email. Idempotente.
// Devuelve { ok, user_id, created } o lanza error.
async function gcUser(env, base, data) {
  const res = await fetch(`${base}/api/gc-user.json`, {
    method: 'POST',
    headers: { 'X-API-Key': env.osticket_api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const text = await res.text();
  let js = null;
  try { js = text ? JSON.parse(text) : null; } catch { /* no-json */ }
  if (!res.ok || !js || !js.user_id) {
    throw new Error(`gc-user ${res.status}: ${text || 'sin detalle'}`);
  }
  return js;
}

// Llama gc-agent.json (agentes). Devuelve el JSON o lanza con detalle.
async function gcAgent(env, base, data) {
  const res = await fetch(`${base}/api/gc-agent.json`, {
    method: 'POST',
    headers: { 'X-API-Key': env.osticket_api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const text = await res.text();
  let js = null;
  try { js = text ? JSON.parse(text) : null; } catch { /* no-json */ }
  if (!res.ok || !js || !js.ok) {
    const detail = (js && (js.error || (js.details && js.details.join('; ')))) || text || 'sin detalle';
    throw new Error(`gc-agent ${res.status}: ${detail}`);
  }
  return js;
}

// Sincroniza UN admin (debe ser gestor_empresa con correo) como cliente
// osTicket. Guarda osticket_user_id + fecha. Devuelve el resultado por fila.
// Si se pasa username/password, crea/actualiza tambien la cuenta de acceso
// del cliente (login local con clave fija) via gc-user.json.
async function syncClientOne(env, base, u, opts = {}) {
  const email = (u.email || '').trim();
  if (!email) return { id: u.id, username: u.username, ok: false, error: 'Sin correo.' };
  const name = (u.name || u.username || email).trim();
  const payload = { email, name };
  if (opts.username) payload.username = String(opts.username).trim();
  if (opts.password) payload.password = String(opts.password);
  const r = await gcUser(env, base, payload);
  await sb(env, `admin_users?id=eq.${encodeURIComponent(u.id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ osticket_user_id: r.user_id, osticket_user_synced_at: new Date().toISOString() }),
  });
  return { id: u.id, username: u.username, ok: true, user_id: r.user_id, created: r.created,
    account_created: r.account_created, account_updated: r.account_updated };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action, adminId } = body;

  try {
    const me = await getActiveAdmin(env, adminId);
    if (!me) return json({ ok: false, error: 'No autorizado.' }, 401);
    const isSuper = me.role === 'superadmin';

    // Acciones SOLO superadmin: crear usuarios, cambiar roles y sincronizacion
    // masiva de clientes osTicket. Las demas (list/reset/toggle/sync_client)
    // las puede hacer un admin, pero limitadas a los gestores de su alcance.
    const SUPER_ONLY = new Set(['create', 'update_role', 'sync_clients_all']);
    const legacyOk = isSuper || !SUPER_ONLY.has(action);
    // SHADOW: gate legacy = superadmin para SUPER_ONLY; admin activo para el resto.
    await shadowCan(env, adminId, 'admin-users', action || '?', TEAM_CODE_BY_ACTION[action] || 'team.role', legacyOk);
    if (SUPER_ONLY.has(action) && !isSuper) {
      return json({ ok: false, error: 'Requiere superadmin.' }, 403);
    }

    // Para un admin no-super, set de gestores que puede ver/gestionar (los
    // entrelazados con su alcance). superadmin -> null (todos).
    const gestorSet = await gestorScopeSet(env, me);
    // Valida que un target (por id) sea un gestor dentro del alcance del admin.
    // superadmin siempre pasa.
    const canTouchTarget = async (targetId) => {
      if (isSuper) return true;
      if (!gestorSet || !gestorSet.has(Number(targetId))) return false;
      return true;
    };

    if (action === 'list') {
      let rows = await sb(env, 'admin_users?select=id,username,name,email,role,is_active,osticket_staff_id,osticket_user_id,osticket_user_synced_at,last_login_at&order=role.desc,username');
      // admin no-super: solo los gestores entrelazados con su alcance.
      if (!isSuper) {
        rows = (rows || []).filter(a => a.role === 'gestor_empresa' && gestorSet.has(Number(a.id)));
      }
      // Resumen de alcance por admin: conteo de reglas include/exclude por
      // tipo (zone/subzone/company/department). Barato (2 lecturas), suficiente
      // para el resumen de la grilla; el detalle se edita en el editor de scope.
      const inc = await sb(env, 'admin_scope_include?select=admin_id,scope_type') || [];
      const exc = await sb(env, 'admin_scope_exclude?select=admin_id,scope_type') || [];
      const scopeMap = {};   // admin_id -> { inc:{type:n}, exc:{type:n} }
      const bump = (bucket, r) => {
        const k = r.admin_id;
        if (!scopeMap[k]) scopeMap[k] = { inc: {}, exc: {} };
        scopeMap[k][bucket][r.scope_type] = (scopeMap[k][bucket][r.scope_type] || 0) + 1;
      };
      inc.forEach(r => bump('inc', r));
      exc.forEach(r => bump('exc', r));
      (rows || []).forEach(a => { a.scope = scopeMap[a.id] || { inc: {}, exc: {} }; });
      return json({ ok: true, rows });
    }

    if (action === 'create') {
      const { username, name, email, role, password, useTemp } = body;
      if (!username) return json({ ok: false, error: 'Falta el usuario.' }, 400);
      const ALLOWED_ROLES = ['admin', 'superadmin', 'editor_personal', 'gestor_empresa'];
      const r = ALLOWED_ROLES.includes(role) ? role : 'admin';
      const pwd = useTemp ? genTempPassword() : password;
      if (!pwd || pwd.length < 6) return json({ ok: false, error: 'Contraseña inválida (mín. 6).' }, 400);
      const hash = await hashPassword(pwd);
      await sb(env, 'admin_users', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          username, name: name || null, email: email ? email.trim().toLowerCase() : null, password_hash: hash,
          role: r, must_change_password: !!useTemp, is_active: true,
        }),
      });
      return json({ ok: true, tempPassword: useTemp ? pwd : null });
    }

    if (action === 'reset') {
      const { id, password, useTemp } = body;
      if (!id) return json({ ok: false, error: 'Falta el usuario.' }, 400);
      // admin no-super: solo puede resetear gestores de su alcance.
      if (!(await canTouchTarget(id))) return json({ ok: false, error: 'Ese usuario esta fuera de tu alcance.' }, 403);
      const pwd = useTemp ? genTempPassword() : password;
      if (!pwd || pwd.length < 6) return json({ ok: false, error: 'Contraseña inválida (mín. 6).' }, 400);
      const hash = await hashPassword(pwd);
      await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ password_hash: hash, must_change_password: !!useTemp }),
      });
      return json({ ok: true, tempPassword: useTemp ? pwd : null });
    }

    if (action === 'toggle') {
      const { id, isActive } = body;
      if (!id) return json({ ok: false, error: 'Falta el usuario.' }, 400);
      // admin no-super: solo puede activar/desactivar gestores de su alcance.
      if (!(await canTouchTarget(id))) return json({ ok: false, error: 'Ese usuario esta fuera de tu alcance.' }, 403);
      // No permitir auto-desactivarse.
      if (!isActive && String(id) === String(adminId)) {
        return json({ ok: false, error: 'No puedes desactivar tu propio usuario.' }, 400);
      }
      // No dejar el sistema sin ningun superadmin activo.
      if (!isActive) {
        const target = await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}&select=role`);
        if (target && target.length && target[0].role === 'superadmin') {
          const supers = await sb(env, 'admin_users?role=eq.superadmin&is_active=eq.true&select=id');
          if ((supers || []).length <= 1) {
            return json({ ok: false, error: 'No puedes desactivar el ultimo superadmin del sistema.' }, 400);
          }
        }
      }
      await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: !!isActive }),
      });
      return json({ ok: true });
    }

    if (action === 'update_role') {
      const { id, role } = body;
      if (!id) return json({ ok: false, error: 'Falta el usuario.' }, 400);
      const ALLOWED_ROLES = ['admin', 'superadmin', 'editor_personal', 'gestor_empresa'];
      if (!ALLOWED_ROLES.includes(role)) return json({ ok: false, error: 'Rol no valido.' }, 400);
      if (String(id) === String(adminId)) return json({ ok: false, error: 'No puedes cambiar tu propio rol.' }, 400);
      const target = await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}&select=id,username,name,email,role,is_active,osticket_staff_id,osticket_user_id`);
      if (!target || !target.length) return json({ ok: false, error: 'Usuario no encontrado.' }, 404);
      const u = target[0];
      const prevRole = u.role;
      if (prevRole === 'superadmin' && role !== 'superadmin') {
        const supers = await sb(env, 'admin_users?role=eq.superadmin&is_active=eq.true&select=id');
        if (supers && supers.length <= 1) return json({ ok: false, error: 'No puedes quitar el ultimo superadmin del sistema.' }, 400);
      }
      if (role === prevRole) return json({ ok: true, note: 'Sin cambios de rol.' });

      // 1) Cambiar el rol en el portal (la verdad).
      await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ role }),
      });

      // 2) Reflejar en osTicket segun la transicion. No debe romper el cambio
      //    de rol (ya hecho): si osTicket falla, se informa como aviso.
      const wasAgent = (prevRole === 'admin' || prevRole === 'superadmin');
      const isAgent = (role === 'admin' || role === 'superadmin');
      const osticket = { steps: [], warnings: [] };
      const base = await osticketBase(env);
      const canOst = base && env.osticket_api_key;

      try {
        // 2a) Deja de ser agente (admin -> gestor/editor): desactivar agente.
        if (wasAgent && !isAgent && u.osticket_staff_id) {
          if (canOst) {
            try {
              const r = await gcAgent(env, base, { action: 'set_agent_active', staff_id: u.osticket_staff_id, active: 0 });
              osticket.steps.push(`Agente #${u.osticket_staff_id} desactivado en osTicket${r.scope_cleared ? ` (bandeja limpiada: ${r.scope_cleared})` : ''}.`);
            } catch (e) { osticket.warnings.push('No se pudo desactivar el agente en osTicket: ' + (e.message || e)); }
          } else {
            osticket.warnings.push('osTicket no esta configurado: desactiva el agente manualmente.');
          }
          // El puente de agente deja de aplicar (ya no es agente). Lo
          // conservamos NO: lo limpiamos para reflejar que no es agente.
          await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ osticket_staff_id: null }),
          });
        }

        // 2b) Pasa a gestor: crear/activar su cliente osTicket (si tiene correo).
        if (role === 'gestor_empresa') {
          if (canOst && u.email) {
            try {
              const r = await syncClientOne(env, base, u);
              if (r.ok) osticket.steps.push(`Cliente osTicket ${r.created ? 'creado' : 'actualizado'} (#${r.user_id}).`);
              else osticket.warnings.push('No se pudo crear el cliente osTicket: ' + r.error);
            } catch (e) { osticket.warnings.push('No se pudo crear el cliente osTicket: ' + (e.message || e)); }
          } else if (!u.email) {
            osticket.warnings.push('El gestor no tiene correo: no se creo su cliente osTicket. Agrega el correo y sincroniza desde su fila.');
          }
        }

        // 2c) Vuelve a ser agente (gestor/editor -> admin): no se crea agente
        //     aqui (requiere clave). Se avisa: crear al guardar su alcance o
        //     desde el boton osTicket de su fila.
        if (!wasAgent && isAgent) {
          osticket.steps.push('Ahora es administrador: crea su agente osTicket al guardar su alcance de tiendas, o con el boton osTicket de su fila.');
        }
      } catch (e) {
        osticket.warnings.push('osTicket: ' + (e.message || e));
      }

      return json({ ok: true, prev_role: prevRole, role, osticket });
    }

    // Crea/actualiza UN gestor_empresa como cliente de osTicket.
    // Opcional: si viene password, crea/actualiza la cuenta de acceso
    // (login local) con username (por defecto el username del portal) y esa
    // clave FIJA (osTicket no fuerza el cambio).
    if (action === 'sync_client') {
      const { id, username, password } = body;
      if (!id) return json({ ok: false, error: 'Falta el usuario.' }, 400);
      // admin no-super: solo gestores de su alcance.
      if (!(await canTouchTarget(id))) return json({ ok: false, error: 'Ese usuario esta fuera de tu alcance.' }, 403);
      const base = await osticketBase(env);
      if (!base || !env.osticket_api_key) return json({ ok: false, error: 'osTicket no esta configurado (URL o clave API).' }, 400);
      const rows = await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}&select=id,username,name,email,role`);
      if (!rows || !rows.length) return json({ ok: false, error: 'Usuario no encontrado.' }, 404);
      const u = rows[0];
      if (u.role !== 'gestor_empresa') return json({ ok: false, error: 'Solo el gestor de empresa se crea como cliente de osTicket.' }, 400);
      if (password != null && String(password).length && String(password).length < 6) {
        return json({ ok: false, error: 'La clave debe tener al menos 6 caracteres.' }, 400);
      }
      const opts = {};
      if (password != null && String(password).length) {
        opts.password = String(password);
        opts.username = (username && String(username).trim()) || u.username;
      }
      try {
        const r = await syncClientOne(env, base, u, opts);
        if (!r.ok) return json({ ok: false, error: r.error }, 400);
        return json({ ok: true, user_id: r.user_id, created: r.created,
          account_created: r.account_created, account_updated: r.account_updated,
          username: opts.username || null });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    // Crea/actualiza TODOS los gestor_empresa activos con correo como clientes.
    if (action === 'sync_clients_all') {
      const base = await osticketBase(env);
      if (!base || !env.osticket_api_key) return json({ ok: false, error: 'osTicket no esta configurado (URL o clave API).' }, 400);
      const gestores = await sb(env, 'admin_users?role=eq.gestor_empresa&is_active=eq.true&select=id,username,name,email&order=username');
      const results = [];
      let okCount = 0, failCount = 0;
      for (const u of (gestores || [])) {
        try {
          const r = await syncClientOne(env, base, u);
          results.push(r);
          if (r.ok) okCount++; else failCount++;
        } catch (e) {
          results.push({ id: u.id, username: u.username, ok: false, error: String(e.message || e) });
          failCount++;
        }
      }
      return json({ ok: true, processed: (gestores || []).length, ok_count: okCount, fail_count: failCount, results });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
