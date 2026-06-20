/* =====================================================================
   functions/api/catalog.js  →  POST /api/catalog
   Devuelve el catálogo para el panel, FILTRADO según quién pregunta:
     - superadmin: todas las companies
     - admin: solo las companies dentro de su alcance (get_admin_companies)
     - tienda: solo su propia company

   Body: { user: {kind, id, role, companyCode} }  (la sesión del cliente)
   Zonas/subzonas/conceptos se devuelven completos (catálogo de referencia).

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
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
  return t ? JSON.parse(t) : [];
}

/** Revalida el usuario contra la BD y devuelve el set de companies permitidas.
 *  null = todas (superadmin). Set = lista explícita. Set vacío = ninguna. */
async function allowedSet(env, user) {
  if (!user) return new Set();
  // Usuario de tienda: solo su propia company
  if (user.kind === 'company') {
    if (!user.companyCode) return new Set();
    // revalidar que el acceso existe y está activo
    const u = await sb(env, `company_users?company_code=eq.${encodeURIComponent(user.companyCode)}&is_active=eq.true&select=company_code`);
    return new Set((u || []).map(r => r.company_code));
  }
  // Admin / superadmin: revalidar contra admin_users
  if (user.kind === 'admin' && user.id) {
    const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role`);
    if (!a || !a.length) return new Set();
    if (a[0].role === 'superadmin') return null; // todas
    const rows = await sb(env, 'rpc/get_admin_companies', {
      method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
    });
    return new Set((rows || []).map(r => r.company_code));
  }
  return new Set();
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const user = body.user || null;

  try {
    // --- Catalogo de causas de marcaje (para el wizard de marcaje) ---
    if (body.action === 'marcaje_causas') {
      const causas = await sb(env, 'marcaje_causas?is_active=eq.true&select=code,label,is_other&order=sort_order');
      return json({ ok: true, causas: causas || [] });
    }

    const allowed = await allowedSet(env, user); // null=todas | Set

    const [companies, zones, subzones, concepts, users] = await Promise.all([
      sb(env, 'companies?select=company_code,business_name,tax_id,zone_id,subzone_id,concept_id,company_type,status,is_active,email,phone,phone2&order=company_code'),
      sb(env, 'zones?select=id,name,letter&order=name'),
      sb(env, 'subzones?select=id,name,letter,zone_id&order=name'),
      sb(env, 'concepts?select=id,name&order=name'),
      sb(env, 'company_users?select=company_code'),
    ]);

    const withAccess = new Set(users.map(u => u.company_code));
    const zoneName = Object.fromEntries(zones.map(z => [z.id, z.name]));
    const subName  = Object.fromEntries(subzones.map(s => [s.id, s.name]));
    const conName  = Object.fromEntries(concepts.map(c => [c.id, c.name]));

    let rows = companies.map(c => ({
      code: c.company_code,
      name: c.business_name,
      taxId: c.tax_id,
      zone: zoneName[c.zone_id] || null,
      zoneId: c.zone_id,
      subzone: subName[c.subzone_id] || null,
      subzoneId: c.subzone_id,
      concept: conName[c.concept_id] || null,
      type: c.company_type,
      status: c.status,
      isActive: c.is_active,
      email: c.email || null,
      phone: c.phone || null,
      phone2: c.phone2 || null,
      hasAccess: withAccess.has(c.company_code),
    }));

    // Aplicar filtro de alcance (si no es superadmin)
    if (allowed !== null) {
      rows = rows.filter(r => allowed.has(r.code));
    }

    return json({ ok: true, companies: rows, zones, subzones, concepts });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
