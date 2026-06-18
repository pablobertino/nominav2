/* =====================================================================
   functions/api/login.js  →  POST /api/login
   Valida credenciales server-side contra Supabase (schema nomina_v2).
   El hash NUNCA toca el navegador: el cliente manda usuario + contraseña
   en claro por HTTPS y aquí se calcula SHA-256(pwd + salt) y se compara.

   Secrets (Cloudflare → Variables, todas Secret):
     - supabase_url            (https://<proj>.supabase.co)
     - supabase_service_role   (service_role key, bypassa RLS)
   ===================================================================== */

const SALT = 'nm_salt_2025';            // regla de negocio 1.1
const STORE_CODE_RE = /^[A-Za-z]{2}\d{2,}$/;

/** SHA-256(pwd + salt) en hex, usando Web Crypto (disponible en Workers) */
async function hashPassword(pwd) {
  const data = new TextEncoder().encode(pwd + SALT);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Helper para consultar la API REST de Supabase con service_role */
async function sb(env, path) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2',   // schema expuesto
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost({ request, env }) {
  let identifier, password;
  try {
    ({ identifier, password } = await request.json());
  } catch {
    return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  }

  identifier = (identifier || '').trim();
  if (!identifier || !password) {
    return json({ ok: false, error: 'Faltan credenciales.' }, 400);
  }

  try {
    const hash = await hashPassword(password);
    const isEmail = identifier.includes('@');

    // 1) Intentar como admin (username o email)
    const adminFilter = isEmail
      ? `email=eq.${encodeURIComponent(identifier)}`
      : `username=eq.${encodeURIComponent(identifier)}`;
    const admins = await sb(env, `admin_users?${adminFilter}&is_active=eq.true&select=id,username,name,email,role,password_hash,must_change_password`);

    if (admins.length) {
      const u = admins[0];
      if (u.password_hash !== hash) return json({ ok: false, error: 'Credenciales incorrectas.' }, 401);
      return json({
        ok: true,
        user: { kind: 'admin', id: u.id, username: u.username, name: u.name, role: u.role,
                email: u.email || null, mustChangePassword: u.must_change_password },
      });
    }

    // 2) Intentar como company (store_code o email)
    const compFilter = isEmail
      ? `email=eq.${encodeURIComponent(identifier)}`
      : `company_code=eq.${encodeURIComponent(identifier.toUpperCase())}`;
    const users = await sb(env, `company_users?${compFilter}&is_active=eq.true&select=id,company_code,email,password_hash,must_change_password`);

    if (users.length) {
      const u = users[0];
      if (u.password_hash !== hash) return json({ ok: false, error: 'Credenciales incorrectas.' }, 401);
      return json({
        ok: true,
        user: { kind: 'company', id: u.id, companyCode: u.company_code,
                email: u.email || null, mustChangePassword: u.must_change_password },
      });
    }

    return json({ ok: false, error: 'Credenciales incorrectas.' }, 401);
  } catch (err) {
    return json({ ok: false, error: 'Error del servidor: ' + err.message }, 500);
  }
}

/** Rechazar otros métodos */
export async function onRequest({ request }) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Método no permitido.' }, 405);
  }
}
