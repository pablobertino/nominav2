/* =====================================================================
   functions/api/reports.js  →  /api/reports
   Recepcion de reportes de incidencia. Primer tipo: Marcaje Manual.
   Registra el encabezado en reports_log (topic) y el detalle por
   trabajador en mark_report_lines. Valida TODO server-side contra la
   hora real de Venezuela (no se fia del reloj del navegador).

   La regla de la ventana reportable (por el recalculo nocturno con
   margen de dias y hora tope):
     - Mas reciente reportable: HOY (hora Venezuela). Nunca futuro.
       Acotado ademas por el dia hito de la quincena en curso.
     - Mas antiguo reportable: HOY - corte_margen_dias. PERO ese dia mas
       antiguo solo se admite hasta corte_hora_limite (hora Venezuela);
       pasada esa hora, el minimo sube un dia.
     - Nunca posterior a la fecha de egreso del trabajador.
     - time_in < time_out (ademas lo refuerza un CHECK en BD).

   Acciones (POST {action}):
     - submit_marcaje : registra un reporte de marcaje.
       { action:'submit_marcaje', company_code, responsible, position,
         lines:[{ id_number, name, mark_date, time_in, time_out,
                  cause_code, cause_other_text? }] }

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

function addDays(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

// Fecha y hora ACTUALES en Venezuela (GMT-4 fijo, sin DST), calculadas
// en el servidor. Devuelve { ymd:'YYYY-MM-DD', hhmm:'HH:MM' }.
function nowCaracas() {
  const car = new Date(Date.now() - 4 * 3600 * 1000); // instante UTC - 4h
  const ymd = car.toISOString().slice(0, 10);
  const hh = String(car.getUTCHours()).padStart(2, '0');
  const mi = String(car.getUTCMinutes()).padStart(2, '0');
  return { ymd, hhmm: `${hh}:${mi}` };
}

// Lee un setting de app_settings por key (texto plano).
async function getSetting(env, key, fallback) {
  const r = await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  return (r && r[0] && r[0].value != null) ? r[0].value : fallback;
}

// Quincena en curso (la que contiene la fecha 'hoy' de Venezuela).
async function currentPeriod(env, todayYmd) {
  const r = await sb(env,
    `payroll_periods?range_start=lte.${todayYmd}&range_end=gte.${todayYmd}&select=*&limit=1`);
  return (r && r[0]) ? r[0] : null;
}

// HH:MM -> minutos
function toMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido' }, 400); }

  try {
    if (body.action === 'submit_marcaje') {
      return await submitMarcaje(env, body);
    }
    if (body.action === 'window') {
      return await getWindow(env, body);
    }
    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}

/* Devuelve la ventana reportable calculada server-side (hora VE real).
   La usa el frontend solo como guia visual; la validacion que bloquea
   sigue siendo submit_marcaje. No requiere permisos especiales: es la
   misma info que el portal mostraria en pantalla. */
async function getWindow(env, body) {
  const { ymd: today, hhmm: nowHHMM } = nowCaracas();
  const margin = parseInt(await getSetting(env, 'corte_margen_dias', '2'), 10) || 2;
  const cutoffTime = await getSetting(env, 'corte_hora_limite', '14:00');
  const pastCutoff = toMin(nowHHMM) >= toMin(cutoffTime);
  const reportMin = addDays(today, pastCutoff ? -(margin - 1) : -margin);
  const oldestDay = addDays(today, -margin);
  const period = await currentPeriod(env, today);
  const milestone = period && period.milestone_date ? period.milestone_date : null;
  const reportMax = (milestone && milestone < today) ? milestone : today;
  return json({
    ok: true,
    window: {
      today, nowHHMM, pastCutoff, reportMin, reportMax, oldestDay,
      marginDays: margin, cutoffTime, milestone,
    },
  });
}

async function submitMarcaje(env, body) {
  const cc = (body.company_code || '').trim();
  const responsible = (body.responsible || '').trim();
  const position = (body.position || '').trim();
  const lines = Array.isArray(body.lines) ? body.lines : [];

  if (!cc) return json({ ok: false, error: 'Falta la tienda.' }, 400);
  if (!responsible) return json({ ok: false, error: 'Falta el responsable.' }, 400);
  if (!lines.length) return json({ ok: false, error: 'No hay trabajadores en el reporte.' }, 400);

  // --- Parametros de la ventana, calculados server-side ---
  const { ymd: today, hhmm: nowHHMM } = nowCaracas();
  const margin = parseInt(await getSetting(env, 'corte_margen_dias', '2'), 10) || 2;
  const cutoffTime = await getSetting(env, 'corte_hora_limite', '14:00');

  // Limite inferior movil: hoy-margen, pero si ya paso la hora tope sube 1 dia.
  const pastCutoff = toMin(nowHHMM) >= toMin(cutoffTime);
  const reportMin = addDays(today, pastCutoff ? -(margin - 1) : -margin);
  const oldestDay = addDays(today, -margin);

  // Limite superior: hoy, acotado por el dia hito de la quincena en curso.
  const period = await currentPeriod(env, today);
  const hito = period && period.milestone_date ? period.milestone_date : today;
  const reportMax = today < hito ? today : hito;

  // Trabajadores de la tienda (para validar egreso). Mapa cedula -> end_date.
  const roster = await sb(env,
    `store_workers?company_code=eq.${encodeURIComponent(cc)}&select=id_number,end_date`);
  const endDateByCed = {};
  (roster || []).forEach(w => { endDateByCed[w.id_number] = w.end_date || null; });

  // Causas validas
  const causes = await sb(env, 'marcaje_causas?is_active=eq.true&select=code,is_other');
  const causeMap = {};
  (causes || []).forEach(c => { causeMap[c.code] = c; });

  // --- Validacion linea por linea ---
  const clean = [];
  const errors = [];
  lines.forEach((ln, i) => {
    const ced = String(ln.id_number || '').replace(/[^0-9]/g, '');
    const name = String(ln.name || '').trim();
    const date = String(ln.mark_date || '').slice(0, 10);
    const tin = String(ln.time_in || '').slice(0, 5);
    const tout = String(ln.time_out || '').slice(0, 5);
    const cause = String(ln.cause_code || '').trim();
    const otherText = (ln.cause_other_text || '').trim();
    const tag = name || ced || `fila ${i + 1}`;

    if (!ced || ced.length < 6 || ced.length > 8) { errors.push(`${tag}: cedula invalida.`); return; }
    if (!name) { errors.push(`${tag}: falta el nombre.`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push(`${tag}: fecha invalida.`); return; }
    if (!/^\d{2}:\d{2}$/.test(tin) || !/^\d{2}:\d{2}$/.test(tout)) { errors.push(`${tag}: horas invalidas.`); return; }
    if (toMin(tin) >= toMin(tout)) { errors.push(`${tag}: la entrada debe ser menor que la salida.`); return; }
    if (!causeMap[cause]) { errors.push(`${tag}: causa invalida.`); return; }
    if (causeMap[cause].is_other && !otherText) { errors.push(`${tag}: especifica la causa (Otros).`); return; }

    // Ventana de fechas
    if (date > reportMax) { errors.push(`${tag}: la fecha ${date} no puede ser futura ni posterior al ${reportMax}.`); return; }
    if (date < reportMin) {
      if (date === oldestDay && pastCutoff) {
        errors.push(`${tag}: el ${oldestDay} ya no se puede reportar (paso la hora tope ${cutoffTime} de Venezuela).`);
      } else {
        errors.push(`${tag}: la fecha ${date} esta fuera del margen reportable (desde ${reportMin}).`);
      }
      return;
    }
    // Egreso del trabajador
    const end = endDateByCed[ced];
    if (end && date > end) { errors.push(`${tag}: la fecha ${date} es posterior a su egreso (${end}).`); return; }

    clean.push({
      worker_id_number: ced,
      worker_name: name,
      mark_date: date,
      time_in: tin,
      time_out: tout,
      cause_code: cause,
      cause_other_text: causeMap[cause].is_other ? otherText : null,
    });
  });

  if (errors.length) {
    return json({ ok: false, error: 'Hay datos que no cumplen las reglas.', details: errors }, 422);
  }

  // --- Zona/subzona de la tienda (para el encabezado) ---
  const comp = await sb(env,
    `companies?company_code=eq.${encodeURIComponent(cc)}&select=zone_id,subzone_id`);
  const zone_id = comp && comp[0] ? comp[0].zone_id : null;
  const subzone_id = comp && comp[0] ? comp[0].subzone_id : null;

  // --- Encabezado en reports_log ---
  const header = await sb(env, 'reports_log', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      company_code: cc,
      zone_id, subzone_id,
      topic: 'marcaje',
      responsible,
      position: position || null,
      workers_count: clean.length,
      attention: 'pending',
      email_sent: false,
    }),
  });
  const reportId = header && header[0] && header[0].id;
  if (!reportId) return json({ ok: false, error: 'No se pudo registrar el reporte.' }, 500);

  // --- Detalle en mark_report_lines ---
  const payload = clean.map(l => ({ ...l, report_id: reportId }));
  await sb(env, 'mark_report_lines', { method: 'POST', body: JSON.stringify(payload) });

  // TODO (siguiente bloque): enviar a osTicket (topic 19) y marcar
  // osticket_id / email_sent. Por ahora queda registrado en BD.

  return json({
    ok: true,
    report_id: reportId,
    workers_count: clean.length,
    window: { today, now: nowHHMM, report_min: reportMin, report_max: reportMax },
  });
}
