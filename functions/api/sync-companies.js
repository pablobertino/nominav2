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

/** Llama a la API REST de Supabase con service_role (para GET con JSON) */
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
  const text = await res.text();
  return text ? JSON.parse(text) : null;   // tolera cuerpo vacío
}

/** Upsert en lote vía PostgREST. NO parsea respuesta (return=minimal). */
async function upsert(env, table, rows) {
  if (!rows.length) return;
  const res = await fetch(`${env.supabase_url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`upsert ${table} ${res.status}: ${detail}`);
  }
}

/** Registra el resultado de una corrida (manual o cron) en sync_config +
   sync_runs. NO debe romper la respuesta de la sincronizacion si el log falla. */
async function recordRun(env, { status, source, result, error, duration_ms, changes }) {
  const base = {
    apikey: env.supabase_service_role,
    Authorization: `Bearer ${env.supabase_service_role}`,
    'Content-Profile': 'nomina_v2',
    'Content-Type': 'application/json',
  };
  const finished = new Date();
  const started = new Date(finished.getTime() - (duration_ms || 0));
  try {
    await fetch(`${env.supabase_url}/rest/v1/sync_config?id=eq.1`, {
      method: 'PATCH', headers: { ...base, Prefer: 'return=minimal' },
      body: JSON.stringify({
        last_run_at: finished.toISOString(), last_status: status,
        last_result: result || null, last_source: source,
        last_duration_ms: duration_ms ?? null,
      }),
    });
    // Insertar la corrida y recuperar su id para enlazar los cambios.
    let runId = null;
    const runRes = await fetch(`${env.supabase_url}/rest/v1/sync_runs`, {
      method: 'POST', headers: { ...base, Prefer: 'return=representation' },
      body: JSON.stringify({
        started_at: started.toISOString(), finished_at: finished.toISOString(),
        status, source, result: result || null, error: error || null,
        duration_ms: duration_ms ?? null,
      }),
    });
    if (runRes.ok) { const rows = await runRes.json(); runId = rows && rows[0] && rows[0].id; }

    // Registrar los cambios detectados (empresa nueva / cambio de estatus).
    if (changes && changes.length) {
      await fetch(`${env.supabase_url}/rest/v1/company_change`, {
        method: 'POST', headers: { ...base, Prefer: 'return=minimal' },
        body: JSON.stringify(changes.map(c => ({ ...c, run_id: runId }))),
      });
    }
  } catch (_) { /* el log no debe afectar el resultado de la sync */ }
}

export async function onRequestPost({ request, env }) {
  // 1) Validar que el llamador es superadmin activo. Acepta { source } para
  //    distinguir corridas manuales (UI) de automaticas (cron via pg_net).
  let adminId, source = 'manual';
  try {
    const body = await request.json();
    adminId = body.adminId;
    source = body.source === 'cron' ? 'cron' : 'manual';
  } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }

  if (!adminId) return json({ ok: false, error: 'No autorizado.' }, 401);

  // Auth FUERA del registro de corridas (un fallo de auth no es una corrida).
  const admins = await sbFetch(env,
    `admin_users?id=eq.${encodeURIComponent(adminId)}&role=eq.superadmin&is_active=eq.true&select=id`)
    .catch(() => []);
  if (!admins.length) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

  // 2) Ejecutar la sincronizacion y registrar el resultado.
  const started = Date.now();
  try {
    // Traer empresas de la API de AX
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

    // Detectar cambios (empresa nueva / cambio de estatus) comparando contra
    // el estado actual ANTES del upsert. En la primera carga (sin empresas
    // previas) no se generan eventos: serian ruido (todas "nuevas").
    let changes = [];
    try {
      const existing = await sbFetch(env, 'companies?select=company_code,status,business_name');
      if (existing && existing.length) {
        const prev = new Map(existing.map(c => [c.company_code, c]));
        for (const row of companyRows) {
          const old = prev.get(row.company_code);
          if (!old) {
            changes.push({ company_code: row.company_code, business_name: row.business_name || null,
              change_type: 'new', old_value: null, new_value: row.status || null });
          } else {
            const a = (old.status || '').trim(), b = (row.status || '').trim();
            if (a !== b && (a || b)) {
              changes.push({ company_code: row.company_code,
                business_name: row.business_name || old.business_name || null,
                change_type: 'status', old_value: old.status || null, new_value: row.status || null });
            }
          }
        }
      }
    } catch (_) { changes = []; }   // si falla la deteccion, no rompe la sync

    // 4) Upsert en orden (catálogos antes que companies por las FK)
    await upsert(env, 'zones', [...zones.values()]);
    await upsert(env, 'subzones', [...subzones.values()]);
    await upsert(env, 'concepts', [...concepts.values()]);
    await upsert(env, 'companies', companyRows);

    const synced = {
      companies: companyRows.length,
      zones: zones.size,
      subzones: subzones.size,
      concepts: concepts.size,
    };
    await recordRun(env, { status: 'ok', source, result: synced, duration_ms: Date.now() - started, changes });
    return json({ ok: true, synced });
  } catch (err) {
    await recordRun(env, { status: 'error', source, result: { error: err.message },
      error: err.message, duration_ms: Date.now() - started });
    return json({ ok: false, error: 'Error: ' + err.message }, 500);
  }
}
