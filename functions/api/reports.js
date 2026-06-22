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

   Secrets: supabase_url, supabase_service_role, osticket_api_key
   Settings (app_settings): osticket_url, osticket_topic_ausencia,
     corte_margen_dias, corte_hora_limite
   ===================================================================== */

import { buildReportText, buildAxWorkbookBase64 } from './_ax-template.js';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

// 'YYYY-MM-DD' -> 'DD/MM/YYYY' (para el cuerpo de texto del ticket)
function dmy(ymd) {
  if (!ymd) return '';
  const m = String(ymd).slice(0, 10).split('-');
  return m.length === 3 ? `${m[2]}/${m[1]}/${m[0]}` : ymd;
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

/* =====================================================================
   osTicket — helpers de envio
   El Worker habla con osTicket por HTTP (la URL vive en app_settings,
   la API key es Secret de Cloudflare osticket_api_key). Crea tickets
   via /api/tickets.json y registra la relacion via /api/gc-report.json,
   y crea/actualiza el usuario-tienda via /api/gc-user.json.
   ===================================================================== */

// Base URL del osTicket (sin barra final). Viene de app_settings.osticket_url.
async function osticketBase(env) {
  const url = await getSetting(env, 'osticket_url', '');
  return String(url || '').replace(/\/+$/, '');
}

// POST JSON a un endpoint del osTicket con la X-API-Key. Devuelve
// { status, ok, text, json }. No lanza: el llamador decide que hacer.
async function osticketPost(env, base, path, payload) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'X-API-Key': env.osticket_api_key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let js = null;
  try { js = text ? JSON.parse(text) : null; } catch { /* la creacion de ticket devuelve el numero como texto plano */ }
  return { status: res.status, ok: res.ok, text, json: js };
}

// Crea un ticket en osTicket. Devuelve el NUMERO del ticket (texto, ej
// '002140') o lanza Error con el detalle. La API responde 201 con el
// numero como cuerpo (texto plano), o JSON segun config.
async function osticketCreateTicket(env, base, payload) {
  const r = await osticketPost(env, base, '/api/tickets.json', payload);
  if (r.status !== 201) {
    throw new Error(`osTicket ticket ${r.status}: ${r.text || 'sin detalle'}`);
  }
  // El cuerpo suele ser el numero como texto plano (puede venir con comillas).
  let num = (r.text || '').trim().replace(/^"|"$/g, '');
  return num;
}

// Registra la relacion del ticket con su reporte (gc_report_link).
// No critico: si falla, se loguea pero no aborta el envio.
async function gcReportLink(env, base, data) {
  try {
    const r = await osticketPost(env, base, '/api/gc-report.json', data);
    return r.ok || r.status === 201;
  } catch { return false; }
}

// Crea/actualiza el usuario-tienda (From). Idempotente. Devuelve user_id|null.
async function gcUser(env, base, data) {
  try {
    const r = await osticketPost(env, base, '/api/gc-user.json', data);
    return (r.json && r.json.user_id) ? r.json.user_id : null;
  } catch { return null; }
}

// Codigo de reporte para el asunto: id con ceros, minimo 4 digitos.
function reportCode(id) {
  return String(id).padStart(4, '0');
}

// Construye un adjunto en el formato que ESPERA la API de osTicket:
//   { "nombre.ext": "data:MIME;base64,XXXX" }
// (objeto con la clave = nombre de archivo). NO {name,data,...}.
function osAttach(filename, base64, mime) {
  return { [filename]: `data:${mime || 'application/octet-stream'};base64,${base64}` };
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

  // --- Zona/subzona + datos de contacto de la tienda (encabezado + From osTicket) ---
  const comp = await sb(env,
    `companies?company_code=eq.${encodeURIComponent(cc)}&select=zone_id,subzone_id,business_name,email,phone`);
  const zone_id = comp && comp[0] ? comp[0].zone_id : null;
  const subzone_id = comp && comp[0] ? comp[0].subzone_id : null;
  const compBusinessName = comp && comp[0] ? (comp[0].business_name || '') : '';
  const compEmail = comp && comp[0] ? (comp[0].email || '') : '';
  const compPhone = comp && comp[0] ? (comp[0].phone || '') : '';

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
    const fileB64 = (ln.doc_file_b64 || '').toString();
    const fileType = (ln.doc_file_type || '').toString().trim();
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
      _fileB64: fileB64 || null,     // interno, viaja a osTicket
      _fileType: fileType || null,   // interno, mime del adjunto
    });
  });

  if (errors.length) {
    return json({ ok: false, error: 'Hay datos que no cumplen las reglas.', details: errors }, 422);
  }

  // --- Datos de la tienda (encabezado + From osTicket + plantilla AX) ---
  // Trae data_area (Data ID de AX) y los nombres de zona/subzona/marca para
  // el cuerpo de texto del ticket. data_area es CRITICO para la plantilla AX.
  const comp = await sb(env,
    `companies?company_code=eq.${encodeURIComponent(cc)}&select=data_area,zone_id,subzone_id,business_name,email,phone,concept_id`);
  const zone_id = comp && comp[0] ? comp[0].zone_id : null;
  const subzone_id = comp && comp[0] ? comp[0].subzone_id : null;
  const compBusinessName = comp && comp[0] ? (comp[0].business_name || '') : '';
  const compEmail = comp && comp[0] ? (comp[0].email || '') : '';
  const compPhone = comp && comp[0] ? (comp[0].phone || '') : '';
  const compDataArea = comp && comp[0] ? (comp[0].data_area || '') : '';
  const compConceptId = comp && comp[0] ? comp[0].concept_id : null;

  // Nombres legibles de zona/subzona/marca para el cuerpo del ticket.
  let zonaName = '', subzonaName = '', marcaName = '';
  if (subzone_id != null) {
    const sz = await sb(env, `subzones?id=eq.${encodeURIComponent(subzone_id)}&select=name`);
    subzonaName = sz && sz[0] ? (sz[0].name || '') : '';
  }
  if (zone_id != null) {
    const zn = await sb(env, `zones?id=eq.${encodeURIComponent(zone_id)}&select=name`);
    zonaName = zn && zn[0] ? (zn[0].name || '') : '';
  }
  if (compConceptId != null) {
    const cn = await sb(env, `concepts?id=eq.${encodeURIComponent(compConceptId)}&select=name`);
    marcaName = cn && cn[0] ? (cn[0].name || '') : '';
  }
  // Mall / Zona del cuerpo: preferimos subzona (el mall) y caemos a zona.
  const mallZona = subzonaName || zonaName || '';

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
  // ENVIO A OSTICKET (sincrono).
  // 1) Crear/actualizar el usuario-tienda (From = "AA01 - Razon Social").
  // 2) Crear 1 ticket PLANTILLA (PLA) con el resumen de TODOS los
  //    trabajadores + la plantilla AX (Excel) adjunta. Es la pieza 1.
  // 3) Crear 1 ticket DOCUMENTO (DOC) por cada persona con archivo. Las
  //    piezas DOC se numeran a partir de 2 (el PLA es la 1).
  //    Total de piezas T = 1 (PLA) + nDocs. Asunto PLA: [code] PLA [1/T].
  //    Asunto DOC: [code] DOC ced [k/T] con k = 2,3,...
  // 4) Tras cada ticket, registrar la relacion (gc-report.json).
  // 5) Actualizar reports_log (osticket_id = numero del PLA, email_sent).
  // Si un DOC falla, NO se aborta el resto: se acumula en ticketErrors.
  // ───────────────────────────────────────────────────────────────────
  const code = reportCode(reportId);
  const base = await osticketBase(env);
  const topicId = parseInt(await getSetting(env, 'osticket_topic_ausencia', '20'), 10) || 20;
  const fromEmail = compEmail || 'portal-nomina@grupocanaima.com';
  const fromName = `${cc} - ${compBusinessName || cc}`;

  // Personas con documento (las que generan ticket DOC).
  const withDoc = doc ? clean.filter(l => l._fileB64) : [];
  const nDocs = withDoc.length;
  // Total de piezas del reporte: el PLA (1) + un DOC por persona con doc.
  const totalPieces = 1 + nDocs;

  const result = { osticket_pla: null, tickets_ok: 0, tickets_fail: 0, ticket_errors: [] };

  if (!base || !env.osticket_api_key) {
    // Sin configuracion de osTicket no se envia, pero el reporte ya quedo en BD.
    result.ticket_errors.push('osTicket no configurado (url o api key).');
  } else {
    // 1) Usuario-tienda (idempotente). No critico. Si devuelve user_id,
    //    lo guardamos en companies (auto-sync por uso): asi la pantalla de
    //    sincronizacion sabe que esta tienda ya existe en osTicket.
    const ostUserId = await gcUser(env, base, { email: fromEmail, name: fromName, phone: compPhone });
    if (ostUserId) {
      try {
        await sb(env, `companies?company_code=eq.${encodeURIComponent(cc)}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_user_id: ostUserId, osticket_synced_at: new Date().toISOString() }),
        });
      } catch { /* no critico: el envio del ticket sigue igual */ }
    }

    // 2) Cuerpo del PLA: usa el formato oficial (buildReportText) con el
    //    marco de doble linea + DATOS DE LA TIENDA + REPORTANTE + INCIDENCIA,
    //    identico al del portal anterior. Cada registro lista los campos de
    //    la ausencia. Las fechas se muestran en DD/MM/YYYY.
    const registros = clean.map(l => {
      const campos = [
        ['Trabajador', l.worker_name],
        ['Cédula', l.worker_id_number],
        ['Desde', dmy(l.date_from)],
        ['Hasta', dmy(l.date_to)],
        ['Justificación', l.ax_code],
      ];
      if (l.note) campos.push(['Nota', l.note]);
      if (doc) campos.push(['Documento', l._fileB64 ? 'adjunto (ticket DOC aparte)' : 'pendiente']);
      return campos;
    });
    const plaBody = buildReportText({
      topicLabel: `Período de Ausencia — ${atype.label}`,
      fecha: dmy(today), hora: nowHHMM,
      alias: cc, razon: compBusinessName, zona: mallZona, marca: marcaName,
      correoTienda: compEmail,
      responsable: responsible, cargo: position, telefono: compPhone, correoResp: compEmail,
      registros,
    });

    // Plantilla AX (Excel) adjunta al PLA. Tipos de celda garantizados:
    // cedula/justificacion como TEXTO, fechas como FECHA real. El formato
    // del adjunto es el de la API de osTicket: { "nombre.xlsx": "data:..." }.
    let plaAttachments;
    try {
      const axCtx = {
        companyDataArea: compDataArea,
        companyName: compBusinessName,
        companyAlias: cc,
        todayYmd: today,
        lines: clean.map(l => ({
          id_number: l.worker_id_number,
          date_from: l.date_from,
          date_to: l.date_to,
          ax_code: l.ax_code,
        })),
      };
      const wb = buildAxWorkbookBase64('ausencia', axCtx);
      if (wb) {
        plaAttachments = [osAttach(
          wb.filename, wb.base64,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )];
      }
    } catch (e) {
      // Si fallara el armado del Excel, el PLA igual se envia (con su texto);
      // se registra el problema para revisarlo, sin abortar el reporte.
      result.ticket_errors.push(`Plantilla AX: ${String(e.message || e)}`);
    }

    try {
      const plaNum = await osticketCreateTicket(env, base, {
        email: fromEmail,
        name: fromName,
        subject: `[${code}] PLA [1/${totalPieces}]`,
        message: plaBody,
        topicId,
        source: 'API',
        alert: false,
        autorespond: false,
        report_code: code,
        report_kind: 'PLA',
        ...(plaAttachments ? { attachments: plaAttachments } : {}),
      });
      result.osticket_pla = plaNum;
      result.tickets_ok++;
      // Registrar relacion del PLA.
      await gcReportLink(env, base, {
        report_code: code, ticket_number: plaNum, kind: 'PLA',
        company: cc, report_type: 'ausencia', doc_total: nDocs,
      });
    } catch (e) {
      result.tickets_fail++;
      result.ticket_errors.push(`PLA: ${String(e.message || e)}`);
    }

    // 3) Un ticket DOC por persona con documento. Pieza k = 2,3,... (el PLA es 1).
    for (let i = 0; i < withDoc.length; i++) {
      const l = withDoc[i];
      const ced = l.worker_id_number;
      const fname = l._fileName || `documento_${ced}`;
      const piece = i + 2;   // el PLA ocupo la pieza 1
      try {
        const docNum = await osticketCreateTicket(env, base, {
          email: fromEmail,
          name: fromName,
          subject: `[${code}] DOC ${ced} [${piece}/${totalPieces}]`,
          message:
            `Documento(s) de ${l.worker_name} (${ced}) - reporte ${code}.\n` +
            `Tipo: ${atype.label} (AX: ${axCode}) - ${l.date_from === l.date_to ? l.date_from : l.date_from + ' a ' + l.date_to}.`,
          topicId,
          source: 'API',
          alert: false,
          autorespond: false,
          report_code: code,
          report_kind: 'DOC',
          attachments: [osAttach(fname, l._fileB64, l._fileType || 'application/octet-stream')],
        });
        result.tickets_ok++;
        await gcReportLink(env, base, {
          report_code: code, ticket_number: docNum, kind: 'DOC',
          company: cc, report_type: 'ausencia',
          worker_id: ced, worker_name: l.worker_name,
          doc_pos: piece, doc_total: totalPieces,
        });
      } catch (e) {
        result.tickets_fail++;
        result.ticket_errors.push(`DOC ${ced}: ${String(e.message || e)}`);
      }
    }

    // 5) Actualizar el encabezado con el resultado del envio.
    if (result.osticket_pla) {
      try {
        await sb(env, `reports_log?id=eq.${reportId}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_id: result.osticket_pla, email_sent: true }),
        });
      } catch { /* el reporte ya esta en BD; el envio se reintenta luego */ }
    }
  }

  // Cuantos quedaron debiendo documento (para feedback al usuario).
  const pendingDocs = doc ? clean.filter(l => !l._fileName).length : 0;

  return json({
    ok: true,
    report_id: reportId,
    workers_count: clean.length,
    absence_code: absenceCode,
    ax_code: axCode,
    pending_docs: pendingDocs,
    osticket: {
      pla: result.osticket_pla,
      tickets_ok: result.tickets_ok,
      tickets_fail: result.tickets_fail,
      errors: result.ticket_errors,
    },
  });
}
