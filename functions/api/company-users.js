/* =====================================================================
   functions/api/company-users.js  →  /api/company-users
   Gestión de accesos de compañía. Acciones (POST con {action,...}):
     - list:   lista companies + si tienen usuario (filtrable por alcance)
     - create: crea acceso para una company
     - reset:  resetea contraseña
     - toggle: activa/desactiva el acceso

   Autorización: el llamador manda { adminId }. Se revalida contra la base.
   - superadmin: puede todo.
   - admin: solo companies dentro de su alcance (get_admin_companies).

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
      'Accept-Profile': 'nomina_v2',
      'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

/** Devuelve {role} del admin o null si no es admin activo */
async function getAdmin(env, adminId) {
  if (!adminId) return null;
  const rows = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id,role`);
  return rows && rows.length ? rows[0] : null;
}

/** Set de company_codes que el admin puede gestionar (null = todas, si superadmin) */
async function allowedCompanies(env, admin) {
  if (admin.role === 'superadmin') return null; // todas
  const rows = await sb(env, `rpc/get_admin_companies`, {
    method: 'POST',
    body: JSON.stringify({ p_admin_id: admin.id }),
  });
  return new Set((rows || []).map(r => r.company_code));
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action, adminId } = body;

  try {
    const admin = await getAdmin(env, adminId);
    if (!admin) return json({ ok: false, error: 'No autorizado.' }, 401);
    const allowed = await allowedCompanies(env, admin);
    const canTouch = (code) => allowed === null || allowed.has(code);

    if (action === 'list') {
      const companies = await sb(env, 'companies?select=company_code,business_name,company_type,status,email&order=company_code');
      const users = await sb(env, 'company_users?select=company_code,email,is_active');
      const byCode = Object.fromEntries((users || []).map(u => [u.company_code, u]));
      let rows = companies.map(c => ({
        code: c.company_code, name: c.business_name, type: c.company_type, status: c.status,
        companyEmail: c.email || null,
        user: byCode[c.company_code] || null,
      }));
      if (allowed !== null) rows = rows.filter(r => allowed.has(r.code));
      return json({ ok: true, rows });
    }

    if (action === 'create') {
      const { companyCode, email, password, useTemp } = body;
      if (!companyCode) return json({ ok: false, error: 'Falta la compañía.' }, 400);
      if (!canTouch(companyCode)) return json({ ok: false, error: 'Fuera de tu alcance.' }, 403);
      const pwd = useTemp ? genTempPassword() : password;
      if (!pwd || pwd.length < 6) return json({ ok: false, error: 'Contraseña inválida (mín. 6).' }, 400);
      const hash = await hashPassword(pwd);
      await sb(env, 'company_users', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          company_code: companyCode, email: email ? email.trim().toLowerCase() : null, password_hash: hash,
          must_change_password: !!useTemp, is_active: true,
        }),
      });
      return json({ ok: true, tempPassword: useTemp ? pwd : null });
    }

    if (action === 'reset') {
      const { companyCode, password, useTemp } = body;
      if (!canTouch(companyCode)) return json({ ok: false, error: 'Fuera de tu alcance.' }, 403);
      const pwd = useTemp ? genTempPassword() : password;
      if (!pwd || pwd.length < 6) return json({ ok: false, error: 'Contraseña inválida (mín. 6).' }, 400);
      const hash = await hashPassword(pwd);
      await sb(env, `company_users?company_code=eq.${encodeURIComponent(companyCode)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ password_hash: hash, must_change_password: !!useTemp }),
      });
      return json({ ok: true, tempPassword: useTemp ? pwd : null });
    }

    if (action === 'toggle') {
      const { companyCode, isActive } = body;
      if (!canTouch(companyCode)) return json({ ok: false, error: 'Fuera de tu alcance.' }, 403);
      await sb(env, `company_users?company_code=eq.${encodeURIComponent(companyCode)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: !!isActive }),
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
