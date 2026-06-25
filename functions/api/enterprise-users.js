/* =====================================================================
   functions/api/enterprise-users.js  →  /api/enterprise-users
   ABM de Usuarios de Empresa: la persona que se loguea y reporta
   incidencias por combinacion Empresa+Departamento. El cargo vive en la
   persona. El alcance son pares (Empresa, Departamento); una combinacion
   solo puede pertenecer a UNA persona (restriccion unica en BD).

   Acciones (POST con {action, adminId, ...}):
     - list        : lista de usuarios de empresa (+ su cargo y nº de combos).
     - get         : un usuario con su alcance detallado.
     - create      : crea { name, username, email, cargo_code, password|useTemp }.
     - update      : edita { id, name, username, email, cargo_code }.
     - reset       : nueva contraseña { id, password|useTemp }.
     - toggle      : activa/desactiva { id, is_active }.
     - scope_add   : agrega combo { id, company_code, department_id }.
     - scope_remove: quita combo { scope_id }.
     - companies   : lista de empresas NO-tienda (para el editor de alcance).
     - departments : departamentos activos de una empresa (para el alcance).

   Autorizacion: { adminId }. superadmin todo; admin limitado a su alcance
   de empresas para las acciones de scope. La gestion del usuario-persona
   (crear/editar/reset/toggle) la hace cualquier admin activo.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const SALT = 'nm_salt_2025';
const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);

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

async function getAdmin(env, adminId) {
  if (!adminId) return null;
  const rows = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id,role`);
  return rows && rows.length ? rows[0] : null;
}
async function allowedCompanies(env, admin) {
  if (admin.role === 'superadmin') return null;
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: admin.id }),
  });
  return new Set((rows || []).map(r => r.company_code));
}

const cleanEmail = e => (e ? String(e).trim().toLowerCase() : null);
const cleanUser = u => String(u || '').trim();

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action, adminId } = body;

  try {
    const admin = await getAdmin(env, adminId);
    if (!admin) return json({ ok: false, error: 'No autorizado.' }, 401);
    const allowed = await allowedCompanies(env, admin);
    const canTouchCompany = code => allowed === null || allowed.has(code);

    /* ---------- listados de apoyo para el editor de alcance ---------- */
    if (action === 'companies') {
      // Empresas NO-tienda, dentro del alcance del admin.
      let rows = await sb(env,
        'companies?select=company_code,business_name,tax_id,company_type,status&order=business_name.asc');
      rows = (rows || []).filter(c => NON_STORE_TYPES.has(c.company_type));
      if (allowed !== null) rows = rows.filter(c => allowed.has(c.company_code));
      return json({ ok: true, companies: rows });
    }

    if (action === 'departments') {
      const code = body.company_code;
      if (!code) return json({ ok: false, error: 'Falta la empresa.' }, 400);
      if (!canTouchCompany(code)) return json({ ok: false, error: 'Fuera de tu alcance.' }, 403);
      const rows = await sb(env,
        `departments?company_code=eq.${encodeURIComponent(code)}&is_active=eq.true&order=name.asc&select=id,name`);
      // marcar cuales ya estan tomados por otra persona (para el editor)
      const taken = await sb(env,
        `enterprise_user_scope?company_code=eq.${encodeURIComponent(code)}&select=department_id,enterprise_user_id`);
      const byDep = {};
      (taken || []).forEach(t => { byDep[t.department_id] = t.enterprise_user_id; });
      const departments = (rows || []).map(d => ({ id: d.id, name: d.name, taken_by: byDep[d.id] || null }));
      return json({ ok: true, departments });
    }

    /* ---------- ABM de la persona ---------- */
    if (action === 'list') {
      const users = await sb(env,
        'enterprise_users?order=name.asc&select=id,name,username,email,cargo_code,is_active,must_change_password,created_at');
      const cargos = await sb(env, 'department_cargos?select=code,label');
      const cargoMap = Object.fromEntries((cargos || []).map(c => [c.code, c.label]));
      // contar combos por usuario
      const scope = await sb(env, 'enterprise_user_scope?select=enterprise_user_id');
      const combos = {};
      (scope || []).forEach(s => { combos[s.enterprise_user_id] = (combos[s.enterprise_user_id] || 0) + 1; });
      const rows = (users || []).map(u => ({
        id: u.id, name: u.name, username: u.username, email: u.email || null,
        cargo_code: u.cargo_code || null, cargo: u.cargo_code ? (cargoMap[u.cargo_code] || u.cargo_code) : null,
        is_active: u.is_active, must_change_password: u.must_change_password,
        combos: combos[u.id] || 0,
      }));
      return json({ ok: true, rows });
    }

    if (action === 'get') {
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta id.' }, 400);
      const us = await sb(env, `enterprise_users?id=eq.${id}&select=id,name,username,email,cargo_code,is_active`);
      if (!us || !us.length) return json({ ok: false, error: 'Usuario no encontrado.' }, 404);
      const scope = await sb(env,
        `enterprise_user_scope?enterprise_user_id=eq.${id}`
        + `&select=id,company_code,department_id,companies(business_name),departments(name)`);
      const combos = (scope || []).map(s => ({
        scope_id: s.id, company_code: s.company_code, department_id: s.department_id,
        company_name: s.companies ? s.companies.business_name : null,
        department_name: s.departments ? s.departments.name : null,
      }));
      return json({ ok: true, user: us[0], combos });
    }

    if (action === 'create') {
      const name = String(body.name || '').trim();
      const username = cleanUser(body.username);
      const email = cleanEmail(body.email);
      const cargo_code = body.cargo_code || null;
      if (!name) return json({ ok: false, error: 'Falta el nombre.' }, 400);
      if (!username) return json({ ok: false, error: 'Falta el nombre de usuario.' }, 400);
      const pwd = body.useTemp ? genTempPassword() : body.password;
      if (!pwd || pwd.length < 6) return json({ ok: false, error: 'Contraseña inválida (mín. 6).' }, 400);
      // unicidad de username / email
      const dupU = await sb(env, `enterprise_users?username=eq.${encodeURIComponent(username)}&select=id`);
      if (dupU && dupU.length) return json({ ok: false, error: 'Ese nombre de usuario ya existe.' }, 409);
      if (email) {
        const dupE = await sb(env, `enterprise_users?email=eq.${encodeURIComponent(email)}&select=id`);
        if (dupE && dupE.length) return json({ ok: false, error: 'Ese correo ya está en uso.' }, 409);
      }
      const hash = await hashPassword(pwd);
      const row = await sb(env, 'enterprise_users', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          name, username, email, cargo_code, password_hash: hash,
          must_change_password: !!body.useTemp, is_active: true,
        }),
      });
      return json({ ok: true, id: row && row[0] && row[0].id, tempPassword: body.useTemp ? pwd : null });
    }

    if (action === 'update') {
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta id.' }, 400);
      const name = String(body.name || '').trim();
      const username = cleanUser(body.username);
      const email = cleanEmail(body.email);
      if (!name || !username) return json({ ok: false, error: 'Nombre y usuario son obligatorios.' }, 400);
      const dupU = await sb(env, `enterprise_users?username=eq.${encodeURIComponent(username)}&id=neq.${id}&select=id`);
      if (dupU && dupU.length) return json({ ok: false, error: 'Ese nombre de usuario ya existe.' }, 409);
      if (email) {
        const dupE = await sb(env, `enterprise_users?email=eq.${encodeURIComponent(email)}&id=neq.${id}&select=id`);
        if (dupE && dupE.length) return json({ ok: false, error: 'Ese correo ya está en uso.' }, 409);
      }
      await sb(env, `enterprise_users?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ name, username, email, cargo_code: body.cargo_code || null }),
      });
      return json({ ok: true });
    }

    if (action === 'reset') {
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta id.' }, 400);
      const pwd = body.useTemp ? genTempPassword() : body.password;
      if (!pwd || pwd.length < 6) return json({ ok: false, error: 'Contraseña inválida (mín. 6).' }, 400);
      const hash = await hashPassword(pwd);
      await sb(env, `enterprise_users?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ password_hash: hash, must_change_password: !!body.useTemp }),
      });
      return json({ ok: true, tempPassword: body.useTemp ? pwd : null });
    }

    if (action === 'toggle') {
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta id.' }, 400);
      await sb(env, `enterprise_users?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: !!body.is_active }),
      });
      return json({ ok: true });
    }

    /* ---------- alcance (combos Empresa+Departamento) ---------- */
    if (action === 'scope_add') {
      const id = parseInt(body.id, 10);
      const code = body.company_code;
      const depId = parseInt(body.department_id, 10);
      if (!id || !code || !depId) return json({ ok: false, error: 'Faltan datos.' }, 400);
      if (!canTouchCompany(code)) return json({ ok: false, error: 'Fuera de tu alcance.' }, 403);
      // validar que el depto pertenezca a esa empresa y este activo
      const dep = await sb(env, `departments?id=eq.${depId}&company_code=eq.${encodeURIComponent(code)}&select=id,is_active`);
      if (!dep || !dep.length) return json({ ok: false, error: 'El departamento no pertenece a esa empresa.' }, 400);
      try {
        await sb(env, 'enterprise_user_scope', {
          method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ enterprise_user_id: id, company_code: code, department_id: depId }),
        });
      } catch (e) {
        if (String(e.message).includes('enterprise_user_scope_company_code_department_id_key')
            || String(e.message).includes('duplicate key')) {
          return json({ ok: false, error: 'Esa combinación Empresa–Departamento ya está asignada a un usuario.' }, 409);
        }
        throw e;
      }
      return json({ ok: true });
    }

    if (action === 'scope_remove') {
      const scopeId = parseInt(body.scope_id, 10);
      if (!scopeId) return json({ ok: false, error: 'Falta scope_id.' }, 400);
      // validar alcance del admin sobre la empresa del combo
      const row = await sb(env, `enterprise_user_scope?id=eq.${scopeId}&select=company_code`);
      if (row && row.length && !canTouchCompany(row[0].company_code)) {
        return json({ ok: false, error: 'Fuera de tu alcance.' }, 403);
      }
      await sb(env, `enterprise_user_scope?id=eq.${scopeId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
