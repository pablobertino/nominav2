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
    if (body.action === 'submit_ausencia') {
      return await submitAusencia(env, body);
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

  // Origen del reporte: 'company' (tienda) | 'admin' (central).
  let sourceKind = body.source_kind === 'admin' ? 'admin' : 'company';
  let sourceAdminId = null;
  if (sourceKind === 'admin') {
    const aid = parseInt(body.source_admin_id, 10);
    if (aid) {
      const a = await sb(env, `admin_users?id=eq.${aid}&is_active=eq.true&select=id`);
      if (a && a.length) sourceAdminId = aid;
    }
    // Si no se pudo validar el admin, degradar a 'company' para no
    // guardar un origen 'admin' sin respaldo.
    if (!sourceAdminId) sourceKind = 'company';
  }

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
      source_kind: sourceKind,
      source_admin_id: sourceAdminId,
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

/* =====================================================================
   AUSENCIA
   Registra el encabezado en reports_log (topic 'ausencia') + el detalle
   por trabajador en absence_report_lines + los documentos esperados en
   absence_report_docs. Valida TODO server-side.

   El TIPO de ausencia es uno por reporte (body.absence_code).
   Reglas de fecha CONFIGURABLES POR TIPO (no usan la ventana de quincena):
     - Hasta >= Desde.
     - Hacia atras: past_window_days (null = sin limite) y, si
       past_uses_cutoff, el dia mas antiguo solo cuenta hasta la hora tope.
     - Hacia el futuro: future_window_days (0 = sin futuro).
     - Nunca posterior al egreso del trabajador.
   Documento (segun required_docs.enforcement del tipo):
     - block    -> si falta el archivo, ERROR 422 (no se registra).
     - warn     -> se registra; status 'adjunto' si vino doc_file_name,
                   'pendiente' si no.
     - optional -> igual que warn pero sin connotacion de "debe".

   Body:
     { action:'submit_ausencia', company_code, responsible, position,
       absence_code,
       lines:[{ id_number, name, date_from, date_to, note?, doc_file_name? }],
       source_kind?, source_admin_id? }
   ===================================================================== */
async function submitAusencia(env, body) {
  const cc = (body.company_code || '').trim();
  const responsible = (body.responsible || '').trim();
  const position = (body.position || '').trim();
  const absenceCode = (body.absence_code || '').trim();
  const lines = Array.isArray(body.lines) ? body.lines : [];

  // Origen del reporte: 'company' (tienda) | 'admin' (central).
  let sourceKind = body.source_kind === 'admin' ? 'admin' : 'company';
  let sourceAdminId = null;
  if (sourceKind === 'admin') {
    const aid = parseInt(body.source_admin_id, 10);
    if (aid) {
      const a = await sb(env, `admin_users?id=eq.${aid}&is_active=eq.true&select=id`);
      if (a && a.length) sourceAdminId = aid;
    }
    if (!sourceAdminId) sourceKind = 'company';
  }

  if (!cc) return json({ ok: false, error: 'Falta la tienda.' }, 400);
  if (!responsible) return json({ ok: false, error: 'Falta el responsable.' }, 400);
  if (!absenceCode) return json({ ok: false, error: 'Falta el tipo de ausencia.' }, 400);
  if (!lines.length) return json({ ok: false, error: 'No hay trabajadores en el reporte.' }, 400);

  // --- Tipo de ausencia: debe existir y estar activo ---
  const types = await sb(env,
    `absence_types?code=eq.${encodeURIComponent(absenceCode)}&is_active=eq.true&select=code,label,ax_code,past_window_days,past_uses_cutoff,future_window_days`);
  if (!types || !types.length) {
    return json({ ok: false, error: 'El tipo de ausencia no es valido o esta inactivo.' }, 400);
  }
  const atype = types[0];
  const axCode = atype.ax_code || atype.code;   // se copia a cada linea (lo que va a la plantilla AX)

  // --- Ventana de fechas configurable del tipo (calculada server-side) ---
  // past_window_days = null -> sin limite atras; numero -> tope de dias atras.
  // past_uses_cutoff = true -> el limite atras LO MANDA el corte global
  //   (corte_margen_dias + corte_hora_limite), no el numero guardado. Asi el
  //   reporte nunca entra fuera del corte de calculo de nomina, y cambiar el
  //   setting global ajusta todos los tipos sin reconfigurar cada uno.
  // future_window_days = 0 -> sin futuro; numero -> tope de dias adelante.
  const { ymd: today, hhmm: nowHHMM } = nowCaracas();
  const cutoffTime = await getSetting(env, 'corte_hora_limite', '14:00');
  const globalMargin = parseInt(await getSetting(env, 'corte_margen_dias', '2'), 10) || 2;
  const futureDays = Number(atype.future_window_days || 0);
  const pastUsesCutoff = !!atype.past_uses_cutoff;
  // Si el tipo respeta el corte global, el margen lo manda el setting (en vivo).
  // Si no, usa el numero propio del tipo (o null = sin limite atras).
  const pastDays = pastUsesCutoff
    ? globalMargin
    : ((atype.past_window_days === null || atype.past_window_days === undefined)
        ? null : Number(atype.past_window_days));

  // Limite inferior (minDate). null = sin limite hacia atras.
  let minDate = null;
  let oldestDay = null;
  let pastCutoffPassed = false;
  if (pastDays != null) {
    oldestDay = addDays(today, -pastDays);
    if (pastUsesCutoff) {
      pastCutoffPassed = toMin(nowHHMM) >= toMin(cutoffTime);
      minDate = pastCutoffPassed ? addDays(today, -(pastDays - 1)) : oldestDay;
    } else {
      minDate = oldestDay;
    }
  }
  // Limite superior (maxDate).
  const maxDate = futureDays > 0 ? addDays(today, futureDays) : today;

  // --- Documento del tipo (0 o 1) ---
  const docs = await sb(env,
    `required_docs?is_active=eq.true&absence_code=eq.${encodeURIComponent(absenceCode)}&select=id,name,enforcement,is_required&order=sort_order`);
  const doc = (docs && docs.length) ? docs[0] : null;
  const enforcement = doc ? (doc.enforcement || 'warn') : null;

  // Trabajadores de la tienda (para validar egreso). Mapa cedula -> end_date.
  const roster = await sb(env,
    `store_workers?company_code=eq.${encodeURIComponent(cc)}&select=id_number,end_date`);
  const endDateByCed = {};
  (roster || []).forEach(w => { endDateByCed[w.id_number] = w.end_date || null; });

  // --- Validacion linea por linea ---
  const clean = [];
  const errors = [];
  lines.forEach((ln, i) => {
    const ced = String(ln.id_number || '').replace(/[^0-9]/g, '');
    const name = String(ln.name || '').trim();
    const from = String(ln.date_from || '').slice(0, 10);
    const to = String(ln.date_to || '').slice(0, 10);
    const note = (ln.note || '').toString().trim();
    const fileName = (ln.doc_file_name || '').toString().trim();
    const tag = name || ced || `fila ${i + 1}`;

    if (!ced || ced.length < 6 || ced.length > 8) { errors.push(`${tag}: cedula invalida.`); return; }
    if (!name) { errors.push(`${tag}: falta el nombre.`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) { errors.push(`${tag}: fecha Desde invalida.`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) { errors.push(`${tag}: fecha Hasta invalida.`); return; }
    if (to < from) { errors.push(`${tag}: la fecha Hasta no puede ser anterior a Desde.`); return; }

    // Rango contra la ventana configurable del tipo.
    if (to > maxDate || from > maxDate) {
      errors.push(futureDays > 0
        ? `${tag}: la fecha no puede ser posterior al ${maxDate} (maximo ${futureDays} dias a futuro para ${atype.label}).`
        : `${tag}: este tipo (${atype.label}) no admite fechas futuras.`);
      return;
    }
    if (minDate && from < minDate) {
      if (pastUsesCutoff && pastCutoffPassed && oldestDay && from < addDays(oldestDay, 1)) {
        errors.push(`${tag}: el ${oldestDay} ya no se puede reportar (paso la hora tope ${cutoffTime} de Venezuela).`);
      } else {
        errors.push(`${tag}: la fecha Desde (${from}) excede el maximo hacia atras para ${atype.label} (desde ${minDate}).`);
      }
      return;
    }
    // Egreso del trabajador.
    const end = endDateByCed[ced];
    if (end && to > end) { errors.push(`${tag}: la fecha Hasta es posterior a su egreso (${end}).`); return; }

    // Documento bloqueante sin archivo -> error.
    if (doc && enforcement === 'block' && !fileName) {
      errors.push(`${tag}: este tipo exige adjuntar ${doc.name} para poder enviar.`); return;
    }

    clean.push({
      worker_id_number: ced,
      worker_name: name,
      absence_code: absenceCode,
      ax_code: axCode,
      date_from: from,
      date_to: to,
      note: note || null,
      _fileName: fileName || null,   // interno, no es columna de la tabla
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
      topic: 'ausencia',
      responsible,
      position: position || null,
      workers_count: clean.length,
      attention: 'pending',
      email_sent: false,
      source_kind: sourceKind,
      source_admin_id: sourceAdminId,
    }),
  });
  const reportId = header && header[0] && header[0].id;
  if (!reportId) return json({ ok: false, error: 'No se pudo registrar el reporte.' }, 500);

  // --- Detalle en absence_report_lines (devolviendo ids para enlazar docs) ---
  const linesPayload = clean.map(l => ({
    report_id: reportId,
    worker_id_number: l.worker_id_number,
    worker_name: l.worker_name,
    absence_code: l.absence_code,
    ax_code: l.ax_code,
    date_from: l.date_from,
    date_to: l.date_to,
    note: l.note,
  }));
  const insertedLines = await sb(env, 'absence_report_lines', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(linesPayload),
  });

  // --- Documentos esperados por linea (solo si el tipo lleva documento) ---
  // status 'adjunto' si la tienda eligio archivo; 'pendiente' si no.
  // El archivo en si NO se guarda: ira por osTicket cuando se conecte.
  if (doc && Array.isArray(insertedLines) && insertedLines.length === clean.length) {
    const docsPayload = insertedLines.map((row, idx) => ({
      line_id: row.id,
      required_doc_id: doc.id,
      doc_name: doc.name,
      enforcement: enforcement,
      status: clean[idx]._fileName ? 'adjunto' : 'pendiente',
    }));
    await sb(env, 'absence_report_docs', { method: 'POST', body: JSON.stringify(docsPayload) });
  }

  // ───────────────────────────────────────────────────────────────────
  // TODO osTicket: aqui se creara el ticket de Capital Humano (topic 20
  // = ausencia) y se adjuntaran los archivos que la tienda haya elegido.
  // El archivo NO viaja todavia: el frontend solo manda doc_file_name.
  // Cuando se conecte osTicket:
  //   1. El frontend (report-ausencia.js) leera cada File a base64 y lo
  //      enviara en lines[].doc_file_b64 + doc_file_name.
  //   2. Aqui se arma el ticket con esos adjuntos (lotes de 4 si aplica)
  //      y se actualiza reports_log.osticket_id / email_sent.
  //   3. Los absence_report_docs con archivo enviado pasan a 'adjunto'
  //      (ya quedan asi); los sin archivo siguen 'pendiente'.
  // ───────────────────────────────────────────────────────────────────

  // Cuantos quedaron debiendo documento (para feedback al usuario).
  const pendingDocs = doc ? clean.filter(l => !l._fileName).length : 0;

  return json({
    ok: true,
    report_id: reportId,
    workers_count: clean.length,
    absence_code: absenceCode,
    ax_code: axCode,
    pending_docs: pendingDocs,
  });
}
