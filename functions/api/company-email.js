/* =====================================================================
   functions/api/company-email.js  →  POST /api/company-email
   Actualiza el correo de una compañía (companies.email).
   Autorización: { adminId }. superadmin = cualquiera; admin = solo
   compañías dentro de su alcance (get_admin_companies).

   Body: { adminId, companyCode, email }
   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }); }

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

async function getAdmin(env, adminId) {
  if (!adminId) return null;
  const rows = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id,role`);
  return rows && rows.length ? rows[0] : null;
}

async function canTouch(env, admin, code) {
  if (admin.role === 'superadmin') return true;
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: admin.id }),
  });
  return (rows || []).some(r => r.company_code === code);
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { adminId, companyCode, email } = body;

  try {
    const admin = await getAdmin(env, adminId);
    if (!admin) return json({ ok: false, error: 'No autorizado.' }, 401);
    if (!companyCode) return json({ ok: false, error: 'Falta la compañía.' }, 400);
    if (!(await canTouch(env, admin, companyCode))) return json({ ok: false, error: 'Fuera de tu alcance.' }, 403);

    // email vacío => null (permite limpiar el correo)
    const clean = (email && email.trim()) ? email.trim() : null;
    // validación mínima si hay valor
    if (clean && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
      return json({ ok: false, error: 'Correo con formato inválido.' }, 400);
    }

    await sb(env, `companies?company_code=eq.${encodeURIComponent(companyCode)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ email: clean }),
    });
    return json({ ok: true, email: clean });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
