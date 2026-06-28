/* =====================================================================
   functions/api/report-stats.js  →  /api/report-stats
   Estadisticas de reportes (Opcion B: tabla propia nomina_v2.reports_log,
   que el portal ya escribe en cada envio). Resumen por periodo y alcance:
     - KPIs: total, vs periodo anterior, cobertura (tiendas que reportaron
       / total tiendas del alcance), promedio diario, trabajadores.
     - por tipo (marcaje/ausencia/ingreso/egreso/modificacion).
     - tendencia por dia (hora Venezuela).
     - cobertura: top tiendas que mas reportan + tiendas SIN reportes.

   El alcance lo da el rol del que llama: superadmin = todo (p_codes null);
   admin/editor = sus empresas (RPC get_admin_companies). Mismo patron de
   auth que /api/dashboard.

   Body: { user:{ kind:'admin', id }, from?:'YYYY-MM-DD', to?:'YYYY-MM-DD' }
   Secrets: supabase_url, supabase_service_role
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

// Valida 'YYYY-MM-DD'. Devuelve la cadena o null.
function ymd(v) {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido' }, 400); }

  const user = body.user || null;
  const from = ymd(body.from);
  const to = ymd(body.to);

  try {
    if (!user || user.kind !== 'admin' || !user.id) {
      return json({ ok: false, error: 'Solo para administradores.' }, 403);
    }
    const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role`);
    if (!a || !a.length) return json({ ok: false, error: 'Sesion no valida.' }, 403);
    const role = a[0].role;

    // Lista de quincenas (periodos de pago) para el filtro. No depende del
    // alcance: son los mismos periodos para todos. Se piden aparte (lazy).
    if (body.action === 'periods') {
      const pers = await sb(env,
        'payroll_periods?select=id,name,year,month,quincena,range_start,range_end'
        + '&order=range_start.desc&limit=18');
      return json({ ok: true, periods: pers || [] });
    }

    // Alcance: superadmin = todo (null); admin/editor = sus empresas.
    let codes = null;
    if (role !== 'superadmin') {
      const rows = await sb(env, 'rpc/get_admin_companies', {
        method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
      });
      codes = (rows || []).map(r => r.company_code);
    }

    const stats = await sb(env, 'rpc/report_stats', {
      method: 'POST',
      body: JSON.stringify({ p_codes: codes, p_from: from, p_to: to }),
    });

    return json({
      ok: true,
      scope: role === 'superadmin' ? 'all' : 'scoped',
      stats: stats || {},
    });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
