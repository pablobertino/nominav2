/* =====================================================================
   functions/api/dashboard.js  →  /api/dashboard
   Resumen del panel de inicio para admin/superadmin/editor:
     - KPIs (empresas, empleados, zonas, subzonas)
     - personal por tipo de empresa + empresas por tipo
     - cumpleanos del ALCANCE del que llama (hoy + proximos), con la foto
       firmada de los que cumplen HOY.

   El alcance lo da el rol: superadmin = todo (p_codes null); admin/editor =
   sus empresas (RPC get_admin_companies). El dashboard de las TIENDAS/
   empresas (rol company) NO usa este endpoint: se arma en el cliente con
   /api/worker-photo (directory), que ya trae su roster con fotos.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const BUCKET = 'worker-photos';
const SIGNED_TTL = 60 * 60;   // 1h

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

async function storageSignedUrl(env, path) {
  if (!path) return null;
  try {
    const res = await fetch(`${env.supabase_url}/storage/v1/object/sign/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        apikey: env.supabase_service_role,
        Authorization: `Bearer ${env.supabase_service_role}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: SIGNED_TTL }),
    });
    if (!res.ok) return null;
    const js = await res.json();
    const rel = js && (js.signedURL || js.signedUrl);
    return rel ? `${env.supabase_url}/storage/v1${rel}` : null;
  } catch { return null; }
}

function cedKind(ced) { return parseInt(ced, 10) >= 80000000 ? 'E' : 'V'; }

/* ===================== Handler ===================== */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido' }, 400); }

  const user = body.user || null;
  let days = parseInt(body.days, 10);
  if (!Number.isFinite(days)) days = 30;
  days = Math.max(1, Math.min(90, days));

  try {
    if (!user || user.kind !== 'admin' || !user.id) {
      return json({ ok: false, error: 'Solo para administradores.' }, 403);
    }
    const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role,name,username`);
    if (!a || !a.length) return json({ ok: false, error: 'Sesion no valida.' }, 403);
    const role = a[0].role;

    // Alcance: superadmin = todo (null); admin/editor = sus empresas.
    let codes = null;
    if (role !== 'superadmin') {
      const rows = await sb(env, 'rpc/get_admin_companies', {
        method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
      });
      codes = (rows || []).map(r => r.company_code);
    }

    // Resumen + cumpleanos + movimientos (ingresos/egresos recientes) + edad por cargo.
    const [summary, bdays, movements, ageByCargo] = await Promise.all([
      sb(env, 'rpc/dashboard_admin_summary', {
        method: 'POST', body: JSON.stringify({ p_codes: codes }),
      }),
      sb(env, 'rpc/dashboard_birthdays', {
        method: 'POST', body: JSON.stringify({ p_codes: codes, p_days: days }),
      }),
      sb(env, 'rpc/dashboard_movements', {
        method: 'POST', body: JSON.stringify({ p_codes: codes, p_limit: 6 }),
      }),
      sb(env, 'rpc/dashboard_age_by_cargo', {
        method: 'POST', body: JSON.stringify({ p_codes: codes }),
      }),
    ]);

    const all = Array.isArray(bdays) ? bdays : [];
    const today = all.filter(b => b.days_until === 0);
    const upcoming = all.filter(b => b.days_until > 0);

    // Foto firmada solo para los que cumplen HOY (set chico). Se busca el
    // thumb en workers_master por cedula.
    if (today.length) {
      const ceds = today.map(b => b.id_number).filter(Boolean);
      const inList = ceds.map(c => `"${c}"`).join(',');
      const master = await sb(env,
        `workers_master?id_number=in.(${inList})&select=id_number,photo_thumb_path`);
      const pathByCed = {};
      (master || []).forEach(m => { if (m.photo_thumb_path) pathByCed[m.id_number] = m.photo_thumb_path; });
      await Promise.all(today.map(async b => {
        b.ced_kind = cedKind(b.id_number);
        b.thumb_url = pathByCed[b.id_number] ? await storageSignedUrl(env, pathByCed[b.id_number]) : null;
      }));
    }
    upcoming.forEach(b => { b.ced_kind = cedKind(b.id_number); });

    // Enriquecer cada cumpleanero con datos de su empresa (nombre, zona,
    // subzona, concepto) para poder ubicar de donde es; con solo el alias se
    // hace dificil identificarlo, sobre todo en la vista de admin.
    const codeset = [...new Set([...today, ...upcoming].map(b => b.company_code).filter(Boolean))];
    if (codeset.length) {
      const inC = codeset.map(c => `"${c}"`).join(',');
      const [comps, zs, ss, cs] = await Promise.all([
        sb(env, `companies?company_code=in.(${inC})&select=company_code,business_name,zone_id,subzone_id,concept_id`),
        sb(env, 'zones?select=id,name'),
        sb(env, 'subzones?select=id,name'),
        sb(env, 'concepts?select=id,name'),
      ]);
      const zMap = {}, sMap = {}, cMap = {}, compMap = {};
      (zs || []).forEach(z => { zMap[z.id] = z.name; });
      (ss || []).forEach(s => { sMap[s.id] = s.name; });
      (cs || []).forEach(c => { cMap[c.id] = c.name; });
      (comps || []).forEach(c => {
        compMap[c.company_code] = {
          company_name: c.business_name || null,
          zone: c.zone_id ? (zMap[c.zone_id] || null) : null,
          subzone: c.subzone_id ? (sMap[c.subzone_id] || null) : null,
          concept: c.concept_id ? (cMap[c.concept_id] || null) : null,
        };
      });
      const attach = b => { const m = compMap[b.company_code]; if (m) Object.assign(b, m); };
      today.forEach(attach);
      upcoming.forEach(attach);
    }

    return json({
      ok: true,
      scope: role === 'superadmin' ? 'all' : 'scoped',
      days,
      summary: summary || {},
      ageByCargo: ageByCargo || { stores: [], enterprises: [] },
      today,
      upcoming,
      movimientos: movements || { ingresos: [], egresos: [] },
    });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
