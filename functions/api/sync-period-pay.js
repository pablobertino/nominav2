/* =====================================================================
   functions/api/sync-period-pay.js  →  POST /api/sync-period-pay
   Refresca la tabla cache nomina_v2.period_pay_status con el estado de
   pago de TODAS las empresas, guardando SOLO los index 0 (actual) y -1
   (anterior) de cada una.

   Lo dispara el cron nomina_v2.tick_sync_period_pay() (pg_net), con
   frecuencia variable segun el dia (Dia de Calculo / Dia de Pago / resto).
   Tambien puede dispararse manualmente desde la pantalla de Sincronizacion.

   Estrategia: DOS llamadas al API de periodos (sin alias, por fecha):
     1) fecha = HOY      -> trae el registro vigente de cada empresa
     2) fecha = HOY-15d  -> trae el periodo anterior de cada empresa
   De todo lo devuelto, por empresa nos quedamos con los dos index mas
   altos (normalmente 0 y -1; si el actual aun no tiene pago calculado, el
   API solo trae negativos y guardamos los dos mas recientes).

   La key del API vive en el servidor (env.canaima_apikey). NUNCA al cliente.

   Secrets: canaima_apikey, supabase_url, supabase_service_role
   ===================================================================== */

const PERIODOS_API = 'https://api3.grupocanaima.com/empresas/periodos/v1';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

/* --- Supabase REST con service_role --- */
async function sb(env, path, opts = {}) {
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
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

/* --- Fechas (UTC, YYYY-MM-DD) --- */
function ymd(d) { return d.toISOString().slice(0, 10); }
function todayYMD() { return ymd(new Date()); }
function minusDaysYMD(fecha, days) {
  const d = new Date(fecha + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return ymd(d);
}

/* --- Llama al API de periodos por fecha (sin alias = todas) --- */
async function fetchPeriodos(env, fecha) {
  const url = `${PERIODOS_API}?fecha=${encodeURIComponent(fecha)}`;
  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
  });
  if (!r.ok) throw new Error(`API periodos respondio ${r.status} (fecha ${fecha})`);
  const j = await r.json();
  return Array.isArray(j) ? j : (j.data || j.items || []);
}

function dateOnly(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/* Mapea un registro del API a una fila de period_pay_status. */
function mapRow(p) {
  return {
    alias: p.alias,
    idx: parseInt(p.index, 10),
    periodo_nomina: p.periodoNomina || null,
    periodo_pago: p.periodoPago || null,
    nomina_desde: dateOnly(p.nominaDesde),
    nomina_hasta: dateOnly(p.nominaHasta),
    pago_desde: dateOnly(p.pagoDesde),
    pago_hasta: dateOnly(p.pagoHasta),
    status: p.status || null,
    tag: p.tag || null,
    fetched_at: new Date().toISOString(),
  };
}

async function recordRun(env, { status, source, triggered_by, mode, result, error, started }) {
  try {
    await sb(env, 'pay_sync_run', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        started_at: new Date(started).toISOString(),
        finished_at: new Date().toISOString(),
        status, source: source || null, triggered_by: triggered_by ?? null,
        mode: mode || null, result: result || null, error: error || null,
        duration_ms: Date.now() - started,
      }),
    });
  } catch (_) { /* la bitacora no debe romper el sync */ }
}

async function updateConfig(env, patch) {
  try {
    await sb(env, 'pay_sync_config?id=eq.1', {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
  } catch (_) { /* no critico */ }
}

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch { /* cron puede no mandar body valido */ }

  const source = body.source === 'cron' ? 'cron' : 'manual';
  const mode = body.mode || null;
  const triggered_by = body.adminId ?? null;
  const started = Date.now();
  const fecha = (body.fecha && /^\d{4}-\d{2}-\d{2}$/.test(body.fecha)) ? body.fecha : todayYMD();

  let registros;
  try {
    // Dos llamadas: hoy (vigente) + hoy-15d (anterior).
    const [hoy, ant] = await Promise.all([
      fetchPeriodos(env, fecha),
      fetchPeriodos(env, minusDaysYMD(fecha, 15)),
    ]);
    registros = [...hoy, ...ant];
  } catch (e) {
    await updateConfig(env, { last_attempt_at: new Date().toISOString(), last_status: 'error', last_source: source, last_result: { error: e.message } });
    await recordRun(env, { status: 'error', source, triggered_by, mode, error: e.message, started });
    return json({ ok: false, error: 'No se pudo consultar el API de periodos: ' + e.message }, 502);
  }

  // Agrupar por alias y quedarnos con los DOS index mas altos (0 y -1, o los
  // dos mas recientes si el actual aun no aparece).
  const byAlias = {};
  for (const p of registros) {
    if (!p || !p.alias || p.index == null) continue;
    const k = p.alias;
    (byAlias[k] = byAlias[k] || []).push(p);
  }
  const rows = [];
  for (const k of Object.keys(byAlias)) {
    // dedup por index y orden desc
    const seen = new Set();
    const ordered = byAlias[k]
      .filter(p => { const i = String(p.index); if (seen.has(i)) return false; seen.add(i); return true; })
      .sort((a, b) => parseInt(b.index, 10) - parseInt(a.index, 10))
      .slice(0, 2);            // los dos mas recientes
    ordered.forEach(p => rows.push(mapRow(p)));
  }

  if (!rows.length) {
    await updateConfig(env, {
      last_attempt_at: new Date().toISOString(), last_run_at: new Date().toISOString(),
      last_status: 'ok', last_source: source, last_duration_ms: Date.now() - started,
      last_result: { companies: 0, rows: 0, note: 'API sin registros' },
    });
    await recordRun(env, { status: 'ok', source, triggered_by, mode, result: { companies: 0, rows: 0 }, started });
    return json({ ok: true, companies: 0, rows: 0 });
  }

  // Upsert masivo (PK alias+idx). merge-duplicates pisa con el dato fresco.
  try {
    await sb(env, 'period_pay_status?on_conflict=alias,idx', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
  } catch (e) {
    await updateConfig(env, { last_attempt_at: new Date().toISOString(), last_status: 'error', last_source: source, last_result: { error: e.message } });
    await recordRun(env, { status: 'error', source, triggered_by, mode, error: e.message, started });
    return json({ ok: false, error: 'No se pudo guardar el estado de pago: ' + e.message }, 500);
  }

  const companies = Object.keys(byAlias).length;
  const result = { companies, rows: rows.length, mode };
  await updateConfig(env, {
    last_attempt_at: new Date().toISOString(), last_run_at: new Date().toISOString(),
    last_status: 'ok', last_source: source, last_duration_ms: Date.now() - started, last_result: result,
  });
  await recordRun(env, { status: 'ok', source, triggered_by, mode, result, started });
  return json({ ok: true, ...result });
}
