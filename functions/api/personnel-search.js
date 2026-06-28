/* =====================================================================
   functions/api/personnel-search.js  →  POST /api/personnel-search
   Busqueda GLOBAL de personal por cedula o nombre, en todas las empresas
   dentro del alcance del administrador. Une store_workers + enterprise_workers
   via la funcion nomina_v2.personnel_search.

   Acciones (POST {action, adminId, ...}):
     search {q}  -> lista de coincidencias (cedula/nombre), con su empresa.

   Scope: superadmin = todas; admin/editor = solo sus empresas
   (get_admin_companies). Secrets: supabase_url, supabase_service_role
   ===================================================================== */

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

/** admin -> { id, role, codes }  codes=null (todas) | array de company_code. */
async function resolveAdmin(env, adminId) {
  if (!adminId) return null;
  const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id,role`);
  if (!a || !a.length) return null;
  if (a[0].role === 'superadmin') return { id: a[0].id, role: a[0].role, codes: null };
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
  });
  return { id: a[0].id, role: a[0].role, codes: (rows || []).map(r => r.company_code) };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const { action, adminId } = body;

  try {
    const admin = await resolveAdmin(env, adminId);
    if (!admin) return json({ ok: false, error: 'Requiere un administrador valido.' }, 403);

    if (action === 'search') {
      const q = (body.q || '').toString().trim();
      if (q.length < 2) return json({ ok: true, rows: [], short: true });
      // Si el admin no tiene empresas en su alcance, no hay nada que buscar.
      if (admin.codes !== null && !admin.codes.length) return json({ ok: true, rows: [] });
      const rows = await sb(env, 'rpc/personnel_search', {
        method: 'POST',
        body: JSON.stringify({ p_codes: admin.codes, p_q: q, p_limit: 80 }),
      });
      return json({ ok: true, rows: rows || [] });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
