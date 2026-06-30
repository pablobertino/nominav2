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

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action, adminId } = body;

  try {
    if (!(await isSuperadmin(env, adminId))) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    if (action === 'list') {
      const rows = await sb(env, 'admin_users?select=id,username,name,email,role,is_active&order=role.desc,username');
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
      await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: !!isActive }),
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
