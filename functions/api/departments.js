/* =====================================================================
   functions/api/departments.js  →  /api/departments
   ABM de departamentos por empresa (solo empresas NO-tienda). Manual,
   no viene de AX. Una empresa puede tener 0..N departamentos.

   Acciones (POST con {action, adminId, ...}):
     - list   : departamentos de una empresa (company_code).
     - create : crea un departamento { company_code, name }.
     - rename : renombra { id, name }.
     - toggle : activa/desactiva { id, is_active }.
     - delete : elimina { id } (solo si no tiene alcance asignado).

   Autorizacion: el llamador manda { adminId }. Se revalida.
   - superadmin: todo.
   - admin: solo empresas dentro de su alcance (get_admin_companies).

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

// Tipos de empresa que PUEDEN tener departamentos (todo lo que no sea tienda).
const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);

import { resolveActor, can } from './_auth.js';

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
async function allowedCompanies(env, admin) {
  if (admin.role === 'superadmin') return null; // todas
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: admin.id }),
  });
  return new Set((rows || []).map(r => r.company_code));
}

/* Valida que la empresa exista, sea NO-tienda y este dentro del alcance. */
async function checkCompany(env, code, allowed) {
  if (!code) return { ok: false, error: 'Falta la empresa.' };
  const rows = await sb(env, `companies?company_code=eq.${encodeURIComponent(code)}&select=company_code,company_type`);
  if (!rows || !rows.length) return { ok: false, error: 'Empresa no encontrada.' };
  if (!NON_STORE_TYPES.has(rows[0].company_type)) {
    return { ok: false, error: 'Solo las empresas que no son tienda pueden tener departamentos.' };
  }
  if (allowed !== null && !allowed.has(code)) return { ok: false, error: 'Fuera de tu alcance.' };
  return { ok: true };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action, adminId } = body;

  try {
    const admin = await getAdmin(env, adminId);
    if (!admin) return json({ ok: false, error: 'No autorizado.' }, 401);
    const allowed = await allowedCompanies(env, admin);
    // v4.72: CORTE del shadow (Lote 2). Las acciones dept.* EXIGEN la matriz
    // (can). El alcance por empresa (allowed) se conserva como segunda capa.
    const actor = await resolveActor(env, { kind: 'admin', id: adminId });

    if (action === 'list') {
      const code = body.company_code;
      const chk = await checkCompany(env, code, allowed);
      if (!chk.ok) return json(chk, chk.error === 'Fuera de tu alcance.' ? 403 : 400);
      const rows = await sb(env,
        `departments?company_code=eq.${encodeURIComponent(code)}&order=name.asc&select=id,name,is_active,sort_order`);
      // contar usuarios (alcance) por departamento, para mostrar y para proteger borrado
      const scope = await sb(env,
        `enterprise_user_scope?company_code=eq.${encodeURIComponent(code)}&select=department_id`);
      const useCount = {};
      (scope || []).forEach(s => { useCount[s.department_id] = (useCount[s.department_id] || 0) + 1; });
      const departments = (rows || []).map(d => ({ ...d, users_count: useCount[d.id] || 0 }));
      return json({ ok: true, departments });
    }

    if (action === 'create') {
      const code = body.company_code;
      const name = String(body.name || '').trim();
      if (!name) return json({ ok: false, error: 'Falta el nombre del departamento.' }, 400);
      const chk = await checkCompany(env, code, allowed);
      if (!chk.ok) return json(chk, chk.error === 'Fuera de tu alcance.' ? 403 : 400);
      if (!can(actor, 'dept.create')) return json({ ok: false, error: 'No tienes permiso para crear departamentos.' }, 403);
      try {
        const row = await sb(env, 'departments', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ company_code: code, name, sort_order: parseInt(body.sort_order, 10) || 100 }),
        });
        return json({ ok: true, id: row && row[0] && row[0].id });
      } catch (e) {
        if (String(e.message).includes('uq_departments_company_name')) {
          return json({ ok: false, error: 'Ya existe un departamento con ese nombre en esta empresa.' }, 409);
        }
        throw e;
      }
    }

    if (action === 'rename') {
      const id = parseInt(body.id, 10);
      const name = String(body.name || '').trim();
      if (!id || !name) return json({ ok: false, error: 'Faltan datos.' }, 400);
      const dep = await sb(env, `departments?id=eq.${id}&select=company_code`);
      if (!dep || !dep.length) return json({ ok: false, error: 'Departamento no encontrado.' }, 404);
      const chk = await checkCompany(env, dep[0].company_code, allowed);
      if (!chk.ok) return json(chk, 403);
      if (!can(actor, 'dept.rename')) return json({ ok: false, error: 'No tienes permiso para renombrar departamentos.' }, 403);
      try {
        await sb(env, `departments?id=eq.${id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ name }),
        });
      } catch (e) {
        if (String(e.message).includes('uq_departments_company_name')) {
          return json({ ok: false, error: 'Ya existe un departamento con ese nombre en esta empresa.' }, 409);
        }
        throw e;
      }
      return json({ ok: true });
    }

    if (action === 'toggle') {
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta id.' }, 400);
      const dep = await sb(env, `departments?id=eq.${id}&select=company_code`);
      if (!dep || !dep.length) return json({ ok: false, error: 'Departamento no encontrado.' }, 404);
      const chk = await checkCompany(env, dep[0].company_code, allowed);
      if (!chk.ok) return json(chk, 403);
      if (!can(actor, 'dept.toggle')) return json({ ok: false, error: 'No tienes permiso para activar o desactivar departamentos.' }, 403);
      await sb(env, `departments?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: !!body.is_active }),
      });
      return json({ ok: true });
    }

    if (action === 'delete') {
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta id.' }, 400);
      const dep = await sb(env, `departments?id=eq.${id}&select=company_code`);
      if (!dep || !dep.length) return json({ ok: false, error: 'Departamento no encontrado.' }, 404);
      const chk = await checkCompany(env, dep[0].company_code, allowed);
      if (!chk.ok) return json(chk, 403);
      if (!can(actor, 'dept.delete')) return json({ ok: false, error: 'No tienes permiso para eliminar departamentos.' }, 403);
      // no borrar si tiene usuarios (alcance) asignados
      const used = await sb(env, `enterprise_user_scope?department_id=eq.${id}&select=id`);
      if (used && used.length) {
        return json({ ok: false, error: 'No se puede eliminar: tiene usuarios asignados. Quítalos primero o desactívalo.' }, 409);
      }
      await sb(env, `departments?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
