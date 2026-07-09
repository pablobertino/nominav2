/* =====================================================================
   functions/api/sync-roster.js  →  POST /api/sync-roster
   SINCRONIZACION AUTOMATICA DE MEMBRESIA en tiendas (v4.55).

   Alcance DELIBERADAMENTE reducido (decision de Pablo 2026-07-09):
   - INGRESA a los trabajadores nuevos que el sistema trae y el portal no
     tiene (con departamento Retail, regla de tiendas).
   - RETIRA (egresa) a los que el sistema marca con fin de contrato.
   - NO TOCA ningun campo de los que ya estan (nombre, cargo, telefono,
     ficha completa: todo eso sigue siendo manual via Actualizar/ficha).

   Reglas de seguridad:
   - Egreso SOLO con dato EXPLICITO (finContrato pasada). JAMAS por
     ausencia en la respuesta (una respuesta parcial no egresa a nadie).
   - Umbral anti-vaciado: si la API devuelve menos del 70% de los activos
     de una tienda (y la tienda tiene 5+), esa tienda se SALTA con alerta.
   - Presupuesto de tiempo: lotes de 8 tiendas en paralelo; si se agota el
     presupuesto, corta limpio y lo dice en el resumen (proxima corrida
     continua de forma natural: es idempotente).
   - Todo queda en nomina_v2.roster_sync_log (solo tiendas con movimiento
     o alerta) + resumen en roster_sync_config.

   Invocacion:
   - Cron: tick_roster_sync() -> POST {source:'cron', adminId}
   - Manual (Configurar, superadmin): POST {source:'manual', adminId}

   Secrets: canaima_apikey, supabase_url, supabase_service_role
   ===================================================================== */

import { shadowCan } from './_auth.js';

const HCM_API = 'https://api2.grupocanaima.com/empleados/datos/v1';
const TIME_BUDGET_MS = 90000;   // presupuesto total de corrida
const BATCH = 8;                // tiendas en paralelo

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

const digits = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '');
const iso10 = (v) => {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/* Departamento Retail de la tienda (cada tienda tiene el suyo); lo crea si
   no existe. Misma regla que las cargas manuales (roster.js/ax-roster.js). */
async function retailDeptId(env, cc) {
  const rows = await sb(env,
    `departments?company_code=eq.${encodeURIComponent(cc)}&name=eq.Retail&select=id&limit=1`);
  if (rows && rows.length) return rows[0].id;
  const ins = await sb(env, 'departments', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ company_code: cc, name: 'Retail' }),
  });
  return ins && ins[0] ? ins[0].id : null;
}

/* Procesa UNA tienda. Devuelve { company_code, added, removed, skipped,
   alert, detail } sin lanzar (los errores quedan como alerta). */
async function processStore(env, cc) {
  const out = { company_code: cc, added: 0, removed: 0, skipped: false, alert: null, detail: {} };
  try {
    const today = new Date().toISOString().split('T')[0];
    const apiRes = await fetch(`${HCM_API}?alias=${encodeURIComponent(cc)}&fecha=${today}`, {
      headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
    });
    if (!apiRes.ok) {
      out.skipped = true; out.alert = `API ${apiRes.status}`;
      return out;
    }
    let data = await apiRes.json();
    let rows = Array.isArray(data) ? data : (data.empleados || data.data || data.items || []);
    if (!Array.isArray(rows)) rows = [];

    // Normalizar: vigentes (sin finContrato o futura) y egresados explicitos.
    const vig = new Map();      // ced -> row vigente
    const fin = new Map();      // ced -> fecha fin (pasada) explicita
    for (const r of rows) {
      const ced = digits(r.ficha || r.cedula || r.id_number);
      if (!ced) continue;
      const f = iso10(r.finContrato);
      if (f && f <= today) fin.set(ced, f);
      else vig.set(ced, r);
    }

    // Roster actual de la tienda.
    const cur = await sb(env,
      `store_workers?company_code=eq.${encodeURIComponent(cc)}&select=id_number,is_active,end_date`) || [];
    const curByCed = new Map(cur.map(w => [digits(w.id_number), w]));
    const activos = cur.filter(w => w.is_active !== false && !w.end_date);

    // UMBRAL ANTI-VACIADO: respuesta sospechosamente corta -> no tocar nada.
    if (activos.length >= 5 && vig.size < activos.length * 0.7) {
      out.skipped = true;
      out.alert = `Respuesta corta del sistema (${vig.size} vigentes vs ${activos.length} activos): tienda saltada por seguridad.`;
      return out;
    }

    // INGRESOS: vigentes del sistema que el roster no tiene (o tiene egresados
    // -> reingreso). NO se toca a los que ya estan activos.
    const toInsert = [];
    const toReenter = [];
    for (const [ced, r] of vig) {
      const w = curByCed.get(ced);
      if (!w) toInsert.push([ced, r]);
      else if (w.is_active === false || w.end_date) toReenter.push([ced, r]);
    }
    // EGRESOS: SOLO con finContrato explicita, sobre los que siguen activos.
    const toEgress = [];
    for (const [ced, f] of fin) {
      const w = curByCed.get(ced);
      if (w && w.is_active !== false && !w.end_date) toEgress.push([ced, f]);
    }

    if (!toInsert.length && !toReenter.length && !toEgress.length) return out;

    const deptId = (toInsert.length || toReenter.length) ? await retailDeptId(env, cc) : null;
    const fullNameOf = (r) => String(r.nombreCompleto
      || [r.primerNombre, r.segundoNombre, r.apellidos || [r.primerApellido, r.segundoApellido].filter(Boolean).join(' ')]
        .filter(Boolean).join(' ')).trim();

    if (toInsert.length) {
      const body = toInsert.map(([ced, r]) => ({
        company_code: cc,
        id_number: ced,
        full_name: fullNameOf(r) || ced,
        first_name: r.primerNombre || null,
        second_name: r.segundoNombre || null,
        last_names: r.apellidos || [r.primerApellido, r.segundoApellido].filter(Boolean).join(' ') || null,
        role: r.idCargo || null,
        start_date: iso10(r.inicioContrato),
        is_active: true,
        department_id: deptId,
        source: 'auto_sync',
      }));
      await sb(env, 'store_workers', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(body),
      });
      // Maestro global: crear SOLO si no existe (jamas pisar datos/foto).
      const masterRows = toInsert.map(([ced, r]) => ({
        id_number: ced,
        full_name: fullNameOf(r) || ced,
        first_name: r.primerNombre || null,
        second_name: r.segundoNombre || null,
        last_names: r.apellidos || null,
        birth_date: iso10(r.fechaNacimiento),
        last_source_company: cc,
      }));
      await sb(env, 'workers_master?on_conflict=id_number', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(masterRows),
      });
      out.added += toInsert.length;
      out.detail.added = toInsert.map(([c]) => c);
    }

    for (const [ced, r] of toReenter) {
      await sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}&id_number=eq.${encodeURIComponent(ced)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: true, end_date: null, start_date: iso10(r.inicioContrato), source: 'auto_sync' }),
      });
    }
    if (toReenter.length) {
      out.added += toReenter.length;
      out.detail.reentered = toReenter.map(([c]) => c);
    }

    for (const [ced, f] of toEgress) {
      await sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}&id_number=eq.${encodeURIComponent(ced)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: false, end_date: f }),
      });
    }
    if (toEgress.length) {
      out.removed = toEgress.length;
      out.detail.removed = toEgress.map(([c]) => c);
    }
    return out;
  } catch (e) {
    out.skipped = true;
    out.alert = String(e && e.message || e).slice(0, 300);
    return out;
  }
}

export async function onRequestPost({ request, env }) {
  const t0 = Date.now();
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const source = body.source === 'cron' ? 'cron' : 'manual';

  // Autorizacion (patron sync-companies): adminId debe ser superadmin activo.
  const adminId = parseInt(body.adminId, 10) || (body.user && parseInt(body.user.id, 10)) || null;
  if (!adminId) return json({ ok: false, error: 'Falta adminId.' }, 403);
  const adm = await sb(env, `admin_users?id=eq.${adminId}&is_active=eq.true&select=id,role`);
  if (!adm || !adm.length || adm[0].role !== 'superadmin') {
    return json({ ok: false, error: 'Solo el superadministrador puede ejecutar esta sincronizacion.' }, 403);
  }
  try { await shadowCan(env, { kind: 'admin', id: adminId }, 'sync-roster', source, 'hcm.sync', true); } catch (_) { /* no rompe */ }

  /* ---------- acciones de la tarjeta de Configurar (v4.56) ---------- */
  if (body.action === 'get_config') {
    const rows = await sb(env, 'roster_sync_config?id=eq.1&select=*');
    return json({ ok: true, config: rows && rows[0] ? rows[0] : null });
  }
  if (body.action === 'save_config') {
    const c = body.config || {};
    const patch = {
      enabled: !!c.enabled,
      frequency: ['hourly', '6h', '12h', 'daily', '2d'].includes(c.frequency) ? c.frequency : 'daily',
      daily_hour: Math.min(23, Math.max(0, parseInt(c.daily_hour, 10) || 6)),
      endpoint_url: (c.endpoint_url || '').trim() || null,
    };
    await sb(env, 'roster_sync_config?id=eq.1', {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
    });
    return json({ ok: true });
  }
  if (body.action === 'runs') {
    // Ultimas corridas: agrupadas por run_id (las filas del log son por tienda).
    const rows = await sb(env,
      'roster_sync_log?select=run_id,run_at,source,company_code,added,removed,skipped,alert&order=run_at.desc&limit=200') || [];
    const byRun = new Map();
    for (const r of rows) {
      const k = r.run_id || r.run_at;
      if (!byRun.has(k)) byRun.set(k, { run_id: k, run_at: r.run_at, source: r.source, added: 0, removed: 0, alerts: 0, stores: [] });
      const g = byRun.get(k);
      g.added += r.added || 0; g.removed += r.removed || 0; if (r.alert) g.alerts++;
      g.stores.push({ company_code: r.company_code, added: r.added, removed: r.removed, skipped: r.skipped, alert: r.alert });
    }
    return json({ ok: true, runs: [...byRun.values()].slice(0, 12) });
  }

  const cfgRows = await sb(env, 'roster_sync_config?id=eq.1&select=*');
  const cfg = cfgRows && cfgRows[0] ? cfgRows[0] : null;
  if (source === 'cron' && (!cfg || !cfg.enabled)) {
    return json({ ok: true, skipped: true, message: 'Sincronizacion de personal desactivada.' });
  }
  if (!env.canaima_apikey) return json({ ok: false, error: 'La clave del sistema no esta configurada.' }, 500);

  // Alcance: tiendas abiertas.
  const stores = await sb(env,
    `companies?company_type=eq.Tienda&is_active=eq.true&select=company_code&order=company_code.asc`) || [];
  const codes = stores.map(s => s.company_code);

  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const results = [];
  let incomplete = false;

  for (let i = 0; i < codes.length; i += BATCH) {
    if (Date.now() - t0 > TIME_BUDGET_MS) { incomplete = true; break; }
    const chunk = codes.slice(i, i + BATCH);
    const rs = await Promise.all(chunk.map(cc => processStore(env, cc)));
    results.push(...rs);
  }

  const added = results.reduce((a, r) => a + r.added, 0);
  const removed = results.reduce((a, r) => a + r.removed, 0);
  const alerts = results.filter(r => r.alert).length;

  // Log: SOLO tiendas con movimiento o alerta (corridas limpias no ensucian).
  const logRows = results
    .filter(r => r.added || r.removed || r.skipped)
    .map(r => ({
      run_id: runId, source, company_code: r.company_code,
      added: r.added, removed: r.removed, skipped: r.skipped,
      alert: r.alert, detail: r.detail && Object.keys(r.detail).length ? r.detail : null,
    }));
  if (logRows.length) {
    try { await sb(env, 'roster_sync_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(logRows) }); }
    catch (_) { /* el log nunca tumba la corrida */ }
  }

  const summary = {
    run_id: runId, stores: results.length, total_stores: codes.length,
    added, removed, alerts, incomplete,
  };
  try {
    await sb(env, 'roster_sync_config?id=eq.1', {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        last_run_at: new Date().toISOString(), last_source: source,
        last_status: 'ok', last_error: null,
        last_duration_ms: Date.now() - t0, last_summary: summary,
      }),
    });
  } catch (_) { /* resumen best-effort */ }

  return json({ ok: true, ...summary, duration_ms: Date.now() - t0 });
}
