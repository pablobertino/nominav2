/* =====================================================================
   functions/api/change-password.js  →  POST /api/change-password
   Cambio de la PROPIA clave, ya con sesion iniciada.

   Por que existe (v5.08): el portal marcaba must_change_password al crear
   un usuario con clave temporal y al resetearla, el login lo devolvia como
   mustChangePassword... y NADIE lo leia. La "clave temporal" no caducaba
   nunca: seguia sirviendo para siempre hasta que el usuario decidiera
   cambiarla por su cuenta. Ahora el portal INTERCEPTA el ingreso y obliga
   a definir una clave nueva antes de dejar entrar.

   Esto es distinto de recover-confirm.js (que exige un token enviado por
   correo, para el "olvide mi contraseña" SIN sesion). Aca el usuario ya
   probo que sabe su clave actual: acaba de iniciar sesion con ella.

   Se protege de dos formas:
     - Se re-verifica la clave ACTUAL contra el hash guardado. No alcanza
       con decir "soy el usuario 13": hay que probar la clave vigente.
     - La clave nueva no puede ser igual a la actual (si no, el usuario
       "cumple" el cambio dejando la temporal puesta, que es justo lo que
       queremos evitar).

   Sirve para los 3 tipos de cuenta (admin, company, enterprise), para que
   el dia de manana la tienda tambien pueda ser forzada.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const SALT = 'nm_salt_2025';    // identico a login.js (regla de negocio 1.1)
const MIN_PWD_LEN = 6;

const TABLE_BY_KIND = {
  admin:      'admin_users',
  company:    'company_users',
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
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  const kind = String(body.kind || '');
  const id = body.id;
  const current = body.currentPassword || '';
  const next = body.newPassword || '';

  const table = TABLE_BY_KIND[kind];
  if (!table || !id) return json({ ok: false, error: 'Sesion no valida.' }, 403);
  if (!current) return json({ ok: false, error: 'Indica tu contrasena actual.' }, 400);
  if (next.length < MIN_PWD_LEN) {
    return json({ ok: false, error: `La contrasena debe tener al menos ${MIN_PWD_LEN} caracteres.` }, 400);
  }
  if (next === current) {
    return json({ ok: false, error: 'La contrasena nueva no puede ser igual a la actual.' }, 400);
  }

  try {
    // 1) La cuenta existe y esta activa.
    const rows = await sb(env,
      `${table}?id=eq.${encodeURIComponent(id)}&is_active=eq.true&select=id,password_hash`);
    if (!rows || !rows.length) return json({ ok: false, error: 'Sesion no valida.' }, 403);

    // 2) Re-verificar la clave ACTUAL. El id de la sesion no basta como
    //    prueba: hay que demostrar que se conoce la clave vigente.
    const curHash = await hashPassword(current);
    if (rows[0].password_hash !== curHash) {
      return json({ ok: false, error: 'La contrasena actual no es correcta.' }, 401);
    }

    // 3) Guardar la nueva y APAGAR el flag (aca deja de ser temporal).
    const newHash = await hashPassword(next);
    await sb(env, `${table}?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ password_hash: newHash, must_change_password: false }),
    });

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: 'Error del servidor: ' + err.message }, 500);
  }
}

export async function onRequest({ request }) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Metodo no permitido.' }, 405);
}
