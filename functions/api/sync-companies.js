/* =====================================================================
   functions/api/sync-companies.js  →  POST /api/sync-companies
   Sincroniza el catálogo (zones, subzones, concepts, companies) desde la
   API de AX hacia Supabase (schema nomina_v2). Upsert puro: actualiza lo
   que viene, no desactiva ausentes. Excluye SIEMPRE la company 'DAT'.

   Protección: requiere { adminId } de un superadmin activo (se re-valida
   contra la base). Cuando endurezcamos auth, pasará a token firmado.

   Secrets: canaima_apikey, supabase_url, supabase_service_role
   ===================================================================== */

const AX_API = 'https://api.grupocanaima.com/empresas/status/v1';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

/** Slug para id de concepto: "MR PRICE + OH WOW" -> "MR_PRICE_OH_WOW" */
function slug(text) {
  return (text || '')
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/[^A-Z0-9]+/g, '_')                       // no-alfanumérico -> _
    .replace(/^_+|_+$/g, '');                          // limpia extremos
}

/** Llama a la API REST de Supabase con service_role */
async function sbFetch(env, path, opts = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Profile': 'nomina_v2',
      'Accept-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** Upsert en lote vía PostgREST (Prefer: resolution=merge-duplicates) */
async function upsert(env, table, rows) {
  if (!rows.length) return;
  await sbFetch(env, table, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
}

export async function onRequestPost({ request, env }) {
  // 1) Validar que el llamador es superadmin activo
  let adminId;
  try { ({ adminId } = await request.json()); }
  catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }

  if (!adminId) return json({ ok: false, error: 'No autorizado.' }, 401);

  try {
    const admins = await sbFetch(env,
      `admin_users?id=eq.${encodeURIComponent(adminId)}&role=eq.superadmin&is_active=eq.true&select=id`);
    if (!admins.length) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    // 2) Traer empresas de la API de AX
    const apiRes = await fetch(AX_API, {
      headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
    });
    if (!apiRes.ok) return json({ ok: false, error: `API AX respondió ${apiRes.status}` }, 502);
    let data = await apiRes.json();
    if (!Array.isArray(data)) data = data.empresas || data.data || data.items || [];

    // 3) Excluir DAT y mapear
    const companies = data.filter(c => {
      const id = String(c.companyId || c.alias || '').toUpperCase();
      return id !== 'DAT' && (c.alias || '').trim() !== '';
    });

    // Acumular catálogos únicos
    const zones = new Map();      // id -> {id,name,letter}
    const subzones = new Map();   // id -> {id,name,letter,zone_id}
    const concepts = new Map();   // id -> {id,name}
    const companyRows = [];

    for (const c of companies) {
      const zoneId = (c.zona || '').trim() || null;
      const subId  = zoneId && (c.subzona || '').trim()
        ? `${zoneId}_${(c.subzona || '').trim()}` : null;
      const conceptId = (c.concepto || '').trim() ? slug(c.concepto) : null;

      if (zoneId && !zones.has(zoneId)) {
        zones.set(zoneId, { id: zoneId, name: c.zoneName || c.zona, letter: c.zoneLetter || null });
      }
      if (subId && !subzones.has(subId)) {
        subzones.set(subId, { id: subId, name: c.subZoneName || c.subzona,
                              letter: c.subZoneLetter || null, zone_id: zoneId });
      }
      if (conceptId && !concepts.has(conceptId)) {
        concepts.set(conceptId, { id: conceptId, name: c.concepto });
      }

      const status = c.status || '';
      companyRows.push({
        company_code: c.alias,
        data_area: c.companyId || null,
        tax_id: c.rif || null,
        business_name: c.companyName || null,
        zone_id: zoneId,
        subzone_id: subId,
        concept_id: conceptId,
        company_type: c.tipoEmpresa || null,
        comp_group: c.compGroup || null,
        status,
        is_active: status.toLowerCase().includes('abier'),
        synced_at: new Date().toISOString(),
      });
    }

    // 4) Upsert en orden (catálogos antes que companies por las FK)
    await upsert(env, 'zones', [...zones.values()]);
    await upsert(env, 'subzones', [...subzones.values()]);
    await upsert(env, 'concepts', [...concepts.values()]);
    await upsert(env, 'companies', companyRows);

    return json({
      ok: true,
      synced: {
        companies: companyRows.length,
        zones: zones.size,
        subzones: subzones.size,
        concepts: concepts.size,
      },
    });
  } catch (err) {
    return json({ ok: false, error: 'Error: ' + err.message }, 500);
  }
}
