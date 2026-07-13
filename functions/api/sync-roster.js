/* =====================================================================
   functions/api/sync-roster.js  →  POST /api/sync-roster
   SINCRONIZACION AUTOMATICA DE MEMBRESIA en tiendas (v5.31).

   Alcance DELIBERADAMENTE reducido (decision de Pablo 2026-07-09):
   - INGRESA a los trabajadores nuevos que el sistema trae y el portal no
     tiene (con departamento Retail, regla de tiendas). El ingreso entra con
     la FICHA COMPLETA: nombre, cargo, y ademas cuenta bancaria, telefono y
     correo (v5.31 — antes entraban vacios: ver abajo).
   - RETIRA (egresa) a los que el sistema marca con fin de contrato.
   - NO TOCA ningun campo de los que YA ESTAN (nombre, cargo, telefono,
     ficha completa: todo eso sigue siendo manual via Actualizar/ficha).

   ⚠ LA DISTINCION QUE IMPORTA (v5.31):
     INSERT   = persona nueva  -> se trae TODO. No hay nada que pisar.
     REINGRESO/UPDATE = persona que ya existe -> NO se toca su ficha.
   No es lo mismo "no pisar el dato de alguien" que "crear a alguien con la
   ficha a medias". Lo primero es la regla; lo segundo era un bug.

   🔴 PENDIENTE — EL UPDATE NO EXISTE TODAVIA. Si un tercero cambia la cuenta
   en AX de alguien que ya esta en el portal, el portal NO se entera. Traerlo
   necesita resolver los conflictos: hay fichas con cambios del portal aun sin
   publicar (`ax_pending`) que un UPDATE ciego pisaria. La API ya da la
   municion (`auditoria.modificadoPor` dice si el cambio vino del portal o de
   un tercero). Diseno en _PLANES/PENDIENTE_SYNC_ROSTER_BUGS.md §BUG 3.

   🔴 PENDIENTE — EL CRON NO AVANZA DE TANDA. La cadena de auto-invocacion se
   corta en el primer eslabon: cada corrida del cron procesa SIEMPRE las mismas
   10 tiendas y nunca llega a `done`, asi que nunca escribe last_run_at y el
   tick la vuelve a disparar a los 15 min, para siempre. Las tiendas 10-131 no
   se sincronizan solas nunca. Ver _PLANES/PENDIENTE_SYNC_ROSTER_BUGS.md §BUG 1.

   Reglas de seguridad:
   - Egreso SOLO con dato EXPLICITO (finContrato pasada). JAMAS por
     ausencia en la respuesta (una respuesta parcial no egresa a nadie).
   - Umbral anti-vaciado: si la API devuelve menos del 70% de los activos
     de una tienda (y la tienda tiene 5+), esa tienda se SALTA con alerta.
   - Centinelas: la API devuelve '-' / 'None' / 'No' / '0' cuando no hay dato.
     Se limpian (clean/cleanAccount) o se guardaria un guion como cuenta.
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

/* ===== TANDAS (v5.14) =====
   Cloudflare corta en 50 SUBREQUESTS por invocacion. Esta sincronizacion
   recorre TODAS las tiendas abiertas (hoy 132) y cada tienda cuesta como
   minimo 2 subrequests (1 GET a la API del sistema + 1 SELECT del roster), sin
   contar los PATCH/POST de ingresos y egresos. O sea: 264+ subrequests en una
   sola invocacion, contra un techo de 50.

   Consecuencia: la corrida COMPLETA nunca pudo terminar; moria a mitad con
   "Too many subrequests" antes de escribir siquiera el log. Por eso la config
   mostraba last_run_at=null (nunca corrio) pese a estar el codigo entero.

   Arreglo: la corrida se hace por TANDAS de tiendas. Cada invocacion procesa
   como mucho STORES_PER_CALL y devuelve el offset siguiente; quien llama
   (el front con su barra de progreso, o el tick del cron) vuelve a invocar
   hasta terminar. La operacion ya era idempotente, asi que trocearla es
   seguro: reintentar una tanda no duplica ingresos ni re-egresa a nadie.

   Cuenta por tanda (peor caso realista):
     10 tiendas x 2 (API + roster)          = 20
     + movimientos (depto/insert/patch)     ~ 10-15
     + arranque (config, alcance) + log     ~  5
                                            = ~40  (cabe en 50, con aire)

   BATCH baja de 8 a 5: el paralelismo no ahorra subrequests (los gasta igual),
   y en tandas chicas no hace falta apretar tanto a la API del sistema. */
const STORES_PER_CALL = 10;     // tiendas por invocacion (limite de Cloudflare)
const BATCH = 5;                // tiendas en paralelo dentro de la tanda

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

/* ===== CENTINELAS DE LA API (v5.31) =====
   El microservicio Flask usa `campo or '-'` como default, asi que un dato
   vacio en AX NO llega como null: llega como '-' (o 'None', 'No', '0' segun
   el campo). Si se guardaran tal cual, la ficha tendria un guion como cuenta
   bancaria y el portal lo mostraria como si fuera un dato real.

   Doc: _PLANES/API_HCM_EMPLEADOS_INTERNALS_2026-07-10.md §2.
   La carga manual (ax-roster.js) ya los filtra; el auto_sync tiene que hacer
   lo mismo o ensucia el maestro. Verificado 2026-07-13: hoy hay 0 centinelas
   guardados en workers_master. */
const SENTINELS = new Set(['-', 'none', 'no', '0', 'n/a', 'na', '--']);
const clean = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (!s || SENTINELS.has(s.toLowerCase())) return null;
  return s;
};

/* La cuenta bancaria venezolana son 20 digitos. Si viene algo mas corto o mas
   largo, es basura (o un centinela raro): mejor null que un dato invalido que
   despues alguien use para pagar. La API ya manda SOLO la cuenta Principal de
   AX (verificado 2026-07-13 contra el ERP), asi que no hay que elegir entre
   varias: la que llega es la que vale. */
const cleanAccount = (v) => {
  const s = clean(v);
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  return d.length === 20 ? d : null;
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
      /* v5.31 — LA FICHA ENTRA COMPLETA.

         El bug: el INSERT no traia cuenta bancaria, telefono ni correo, aunque
         la API los devuelve (cuentaBancaria/telefono/correo). Resultado: toda
         persona ingresada por auto_sync quedaba con la ficha a medias.
         Verificado 2026-07-13 contra AX: de las 2.689 personas vigentes, 79 no
         tenian cuenta — y AX SI las tenia. El corte era perfecto por origen:
           source='ax_api'    2.602 personas,  0 sin cuenta
           source='auto_sync'    87 personas, 79 sin cuenta  <-- el agujero

         Esto es SOLO el INSERT (persona que el portal no tiene). NO se toca a
         los que ya estan: esa sigue siendo la regla del 2026-07-09, y ademas
         hay 8 fichas con cambios del portal aun sin publicar a AX (ax_pending)
         que un UPDATE ciego se llevaria puesto. El UPDATE necesita la logica de
         conflictos (auditoria.modificadoPor) y va aparte. */
      const body = toInsert.map(([ced, r]) => ({
        company_code: cc,
        id_number: ced,
        full_name: fullNameOf(r) || ced,
        first_name: r.primerNombre || null,
        second_name: r.segundoNombre || null,
        last_names: r.apellidos || [r.primerApellido, r.segundoApellido].filter(Boolean).join(' ') || null,
        role: r.idCargo || null,
        start_date: iso10(r.inicioContrato),
        account_number: cleanAccount(r.cuentaBancaria),
        phone: clean(r.telefono),
        email: clean(r.correo),
        is_active: true,
        department_id: deptId,
        source: 'auto_sync',
      }));
      await sb(env, 'store_workers', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(body),
      });
      // Maestro global: crear SOLO si no existe (jamas pisar datos/foto).
      // resolution=ignore-duplicates => si la persona ya existe (viene de otra
      // empresa), esta fila se descarta entera y NO le pisa nada. Por eso es
      // seguro mandar aca la ficha completa.
      const masterRows = toInsert.map(([ced, r]) => ({
        id_number: ced,
        full_name: fullNameOf(r) || ced,
        first_name: r.primerNombre || null,
        second_name: r.segundoNombre || null,
        last_names: r.apellidos || null,
        birth_date: iso10(r.fechaNacimiento),
        account_number: cleanAccount(r.cuentaBancaria),
        phone: clean(r.telefono),
        email: clean(r.correo),
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

    /* REINGRESO: la persona ya existe en el roster de esta tienda (egresada) y
       el sistema la trae vigente de nuevo. Se la reactiva y NADA MAS.
       Deliberadamente NO se tocan cuenta/telefono/correo aca: su ficha ya
       existe y puede tener datos cargados desde el portal. Reactivar no es
       excusa para pisar. (El INSERT si los trae, porque ahi no hay nada que
       pisar: la persona es nueva.) */
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

export async function onRequestPost({ request, env, ctx }) {
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
      retry_minutes: Math.min(720, Math.max(0, parseInt(c.retry_minutes, 10) || 0)),
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

  /* v5.14: TANDA. offset = desde que tienda seguir; run_id se recibe para que
     todas las tandas de una misma corrida compartan el mismo id en el log (y
     el Registro las muestre como UNA corrida, no como 14 sueltas). */
  const offset = Math.max(0, parseInt(body.offset, 10) || 0);
  const runId = (body.run_id && String(body.run_id).slice(0, 40))
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const slice = codes.slice(offset, offset + STORES_PER_CALL);
  const nextOffset = offset + slice.length;
  const done = nextOffset >= codes.length;

  const results = [];
  let incomplete = false;

  try {
  for (let i = 0; i < slice.length; i += BATCH) {
    if (Date.now() - t0 > TIME_BUDGET_MS) { incomplete = true; break; }
    const chunk = slice.slice(i, i + BATCH);
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

  /* v5.14: el resumen ACUMULA entre tandas. La corrida son N invocaciones; si
     cada una pisara el resumen con lo suyo, la config terminaria mostrando lo
     de la ULTIMA tanda ("2 ingresos") en vez del total de la corrida. Los
     totales llegan del llamador (que los viene sumando) y aca se les agrega lo
     de esta tanda. */
  const prevAdded = Math.max(0, parseInt(body.acc_added, 10) || 0);
  const prevRemoved = Math.max(0, parseInt(body.acc_removed, 10) || 0);
  const prevAlerts = Math.max(0, parseInt(body.acc_alerts, 10) || 0);
  const prevStores = Math.max(0, parseInt(body.acc_stores, 10) || 0);

  const totAdded = prevAdded + added;
  const totRemoved = prevRemoved + removed;
  const totAlerts = prevAlerts + alerts;
  const totStores = prevStores + results.length;

  const summary = {
    run_id: runId, stores: totStores, total_stores: codes.length,
    added: totAdded, removed: totRemoved, alerts: totAlerts,
    incomplete: incomplete || !done,
  };

  /* La config se marca como CORRIDA solo cuando la ultima tanda termina: si se
     escribiera last_run_at en cada tanda, el tick del cron creeria que la
     corrida ya se hizo y no dispararia las tandas que faltan. Mientras hay
     tandas pendientes se refresca last_attempt_at (senal de vida). */
  try {
    await sb(env, 'roster_sync_config?id=eq.1', {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(done
        ? {
          last_run_at: new Date().toISOString(), last_source: source,
          last_status: 'ok', last_error: null,
          last_duration_ms: Date.now() - t0, last_summary: summary,
        }
        : { last_attempt_at: new Date().toISOString(), last_source: source }),
    });
  } catch (_) { /* resumen best-effort */ }

  /* v5.14: CADENA DE TANDAS PARA EL CRON.
     El tick de la base hace UNA sola llamada. Si esa llamada procesa 10 tiendas
     y termina, las otras 122 se quedan sin sincronizar y nadie las retoma hasta
     el dia siguiente (que volveria a hacer las primeras 10: las mismas siempre).

     Por eso, cuando la corrida viene del cron y quedan tandas, el Worker se
     AUTO-INVOCA con el offset siguiente. Cada eslabon es una invocacion nueva,
     con su propio presupuesto limpio de 50 subrequests.

     waitUntil: la respuesta se devuelve YA; el encadenado sigue en segundo
     plano. Sin esto, Cloudflare mataria el fetch pendiente al cerrar la
     respuesta y la cadena se cortaria en el primer eslabon.

     El manual NO se auto-encadena: ahi el front hace el bucle y muestra la
     barra de progreso (el usuario esta mirando; conviene que vea el avance y
     pueda ver el resultado). */
  if (!done && source === 'cron') {
    const selfUrl = new URL(request.url).origin + '/api/sync-roster';
    const nextBody = {
      source: 'cron', adminId,
      offset: nextOffset, run_id: runId,
      acc_added: totAdded, acc_removed: totRemoved,
      acc_alerts: totAlerts, acc_stores: totStores,
    };
    const chain = fetch(selfUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextBody),
    }).catch(() => { /* si un eslabon falla, el reintento del tick lo retoma */ });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(chain);
  }

  return json({
    ok: true, ...summary,
    // v5.14: el llamador usa esto para seguir con la proxima tanda.
    done,
    next_offset: done ? null : nextOffset,
    processed: results.length,     // tiendas de ESTA tanda
    duration_ms: Date.now() - t0,
  });
  } catch (e) {
    // v4.58: una falla dura marca la corrida como error en la config para
    // que el tick REINTENTE a los retry_minutes configurados.
    try {
      await sb(env, 'roster_sync_config?id=eq.1', {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          last_run_at: new Date().toISOString(), last_source: source,
          last_status: 'error', last_error: String(e && e.message || e).slice(0, 400),
          last_duration_ms: Date.now() - t0,
        }),
      });
    } catch (_) { /* best-effort */ }
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}
