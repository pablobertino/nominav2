/* =====================================================================
   functions/api/catalog.js  →  GET /api/catalog
   Devuelve el catálogo completo desde Supabase (nomina_v2) para el panel:
   companies (con zona/subzona/concepto resueltos + si tiene acceso),
   zones, subzones y concepts. Lectura; usa service_role.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

async function sb(env, path) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2',
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}

export async function onRequestGet({ env }) {
  try {
    const [companies, zones, subzones, concepts, users] = await Promise.all([
      sb(env, 'companies?select=company_code,business_name,tax_id,zone_id,subzone_id,concept_id,company_type,status,is_active,email,phone&order=company_code'),
      sb(env, 'zones?select=id,name,letter&order=name'),
      sb(env, 'subzones?select=id,name,letter,zone_id&order=name'),
      sb(env, 'concepts?select=id,name&order=name'),
      sb(env, 'company_users?select=company_code'),
    ]);

    // set de companies con acceso
    const withAccess = new Set(users.map(u => u.company_code));

    // mapas para resolver nombres
    const zoneName = Object.fromEntries(zones.map(z => [z.id, z.name]));
    const subName  = Object.fromEntries(subzones.map(s => [s.id, s.name]));
    const conName  = Object.fromEntries(concepts.map(c => [c.id, c.name]));

    const rows = companies.map(c => ({
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
      hasAccess: withAccess.has(c.company_code),
    }));

    return json({ ok: true, companies: rows, zones, subzones, concepts });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
