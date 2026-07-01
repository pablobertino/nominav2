/* =====================================================================
   functions/api/admin-users.js  →  /api/admin-users
   Gestión del Equipo (admins). Solo superadmin. Acciones (POST {action}):
     - list:   lista admins con su rol
     - create: crea un admin
     - reset:  resetea contraseña
     - toggle: activa/desactiva

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const SALT = 'nm_salt_2025';

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

async function isSuperadmin(env, adminId) {
  if (!adminId) return false;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&role=eq.superadmin&is_active=eq.true&select=id`);
  return r && r.length > 0;
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
    if (!(await isSuperadmin(env, adminId))) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    if (action === 'list') {
      const rows = await sb(env, 'admin_users?select=id,username,name,email,role,is_active,osticket_user_id,osticket_user_synced_at&order=role.desc,username');
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
      const target = await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}&select=role,is_active`);
      if (!target || !target.length) return json({ ok: false, error: 'Usuario no encontrado.' }, 404);
      if (target[0].role === 'superadmin' && role !== 'superadmin') {
        const supers = await sb(env, 'admin_users?role=eq.superadmin&is_active=eq.true&select=id');
        if (supers && supers.length <= 1) return json({ ok: false, error: 'No puedes quitar el ultimo superadmin del sistema.' }, 400);
      }
      await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ role }),
      });
      return json({ ok: true });
    }

    // Crea/actualiza UN gestor_empresa como cliente de osTicket.
    // Opcional: si viene password, crea/actualiza la cuenta de acceso
    // (login local) con username (por defecto el username del portal) y esa
    // clave FIJA (osTicket no fuerza el cambio).
    if (action === 'sync_client') {
      const { id, username, password } = body;
      if (!id) return json({ ok: false, error: 'Falta el usuario.' }, 400);
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
