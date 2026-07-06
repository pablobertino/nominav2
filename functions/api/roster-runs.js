/* =====================================================================
   functions/api/roster-runs.js  →  POST /api/roster-runs
   Bitácora de sincronizaciones de PERSONAL (roster) para la vista
   "Sinc. Personal". La ven admin, editor y superadmin.

   Alcance:
     - superadmin: ve todas las empresas.
     - admin / editor: ven solo las empresas de su alcance
       (get_admin_companies) — sus propias sincronizaciones y las que
       hizo cualquiera (incluido el superadmin) sobre esas empresas.

   Acciones (POST {action, adminId}):
     - get: últimas corridas (empresa, quién, cuándo, origen, resultado, #cambios)
     - changes {run_id}: detalle de cambios de una corrida (validando alcance)

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { shadowCan } from './_auth.js';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
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

/* null = todas (superadmin); si no, Set de company_code del alcance. */
async function allowedCompanies(env, admin) {
  if (admin.role === 'superadmin') return null;
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: admin.id }),
  });
  return new Set((rows || []).map(r => r.company_code));
}

function inList(arr) { return arr.map(c => `"${String(c).replace(/"/g, '')}"`).join(','); }

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action, adminId } = body;

  try {
    const admin = await getAdmin(env, adminId);
    if (!admin) return json({ ok: false, error: 'No autorizado.' }, 403);

    // SHADOW: gate legacy = admin/editor/super activo (getAdmin). Code de vista.
    await shadowCan(env, adminId, 'roster-runs', action || '?', 'view.rostersync', !!admin);

    const allowed = await allowedCompanies(env, admin);

    if (action === 'get') {
      let runs;
      if (allowed === null) {
        runs = await sb(env, 'roster_run?select=*&order=finished_at.desc&limit=80') || [];
      } else {
        const codes = [...allowed];
        if (!codes.length) return json({ ok: true, runs: [] });
        runs = await sb(env, `roster_run?company_code=in.(${inList(codes)})&select=*&order=finished_at.desc&limit=80`) || [];
      }

      // Nombres de empresa y de quién disparó.
      const ccs = [...new Set(runs.map(r => r.company_code))];
      const nameByCc = {};
      if (ccs.length) {
        const comps = await sb(env, `companies?company_code=in.(${inList(ccs)})&select=company_code,business_name`) || [];
        comps.forEach(c => { nameByCc[c.company_code] = c.business_name; });
      }
      const adminIds = [...new Set(runs.map(r => r.triggered_by).filter(Boolean))];
      const nameById = {};
      if (adminIds.length) {
        const admins = await sb(env, `admin_users?id=in.(${adminIds.join(',')})&select=id,username`) || [];
        admins.forEach(a => { nameById[a.id] = a.username; });
      }
      for (const r of runs) {
        r.business_name = nameByCc[r.company_code] || null;
        r.triggered_by_name = r.triggered_by ? (nameById[r.triggered_by] || null) : null;
      }
      return json({ ok: true, runs });
    }

    if (action === 'changes') {
      const runId = body.run_id;
      if (!runId) return json({ ok: false, error: 'Falta run_id.' }, 400);
      const runRows = await sb(env, `roster_run?id=eq.${encodeURIComponent(runId)}&select=company_code`);
      const run = runRows && runRows[0];
      if (!run) return json({ ok: false, error: 'Corrida no encontrada.' }, 404);
      if (allowed !== null && !allowed.has(run.company_code)) return json({ ok: false, error: 'Sin alcance sobre esa empresa.' }, 403);
      const changes = await sb(env,
        `roster_change?run_id=eq.${encodeURIComponent(runId)}&select=id_number,worker_name,change_type,old_value,new_value&order=id.asc`) || [];
      return json({ ok: true, changes });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
