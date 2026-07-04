/* =====================================================================
   functions/api/recover-confirm.js  →  POST /api/recover-confirm
   Paso 2 de la recuperación: recibe { token, newPassword }, valida el
   token (existe, no usado, vigente), calcula SHA-256(newPassword + salt)
   y actualiza el password_hash de la cuenta correspondiente. Marca el
   token como usado.

   El salt DEBE coincidir con login.js (regla de negocio 1.1).
   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const SALT = 'nm_salt_2025';               // idéntico a login.js
const MIN_PWD_LEN = 6;                      // largo mínimo de la nueva clave

const TABLE_BY_KIND = {
  company:    'company_users',
  admin:      'admin_users',
  enterprise: 'enterprise_users',
};

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

async function hashPassword(pwd) {
  const data = new TextEncoder().encode(pwd + SALT);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
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
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }

  const token = (body.token || '').trim();
  const newPassword = body.newPassword || '';
  if (!token) return json({ ok: false, error: 'Falta el token.' }, 400);
  if (newPassword.length < MIN_PWD_LEN) {
    return json({ ok: false, error: `La contraseña debe tener al menos ${MIN_PWD_LEN} caracteres.` }, 400);
  }

  try {
    // 1) Buscar token válido: no usado y no vencido.
    const nowIso = new Date().toISOString();
    const rows = await sb(env,
      `password_reset_tokens?token=eq.${encodeURIComponent(token)}`
      + `&used_at=is.null&expires_at=gt.${encodeURIComponent(nowIso)}`
      + `&select=id,user_kind,user_id`);

    if (!rows || !rows.length) {
      return json({ ok: false, error: 'El enlace no es válido o ya venció. Solicita uno nuevo.' }, 400);
    }
    const tok = rows[0];
    const table = TABLE_BY_KIND[tok.user_kind];
    if (!table) return json({ ok: false, error: 'Token corrupto.' }, 400);

    // 2) Nuevo hash y actualización de la cuenta.
    const hash = await hashPassword(newPassword);
    await sb(env, `${table}?id=eq.${tok.user_id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ password_hash: hash, must_change_password: false }),
    });

    // 3) Marcar token como usado (un solo uso).
    await sb(env, `password_reset_tokens?id=eq.${tok.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ used_at: new Date().toISOString() }),
    });

    return json({ ok: true, message: 'Tu contraseña se actualizó. Ya puedes iniciar sesión.' });
  } catch (err) {
    return json({ ok: false, error: 'Error del servidor: ' + err.message }, 500);
  }
}

export async function onRequest({ request }) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Método no permitido.' }, 405);
}
