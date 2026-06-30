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

// Departamento comun del reporte (empresas no-tienda). Devuelve el
// department_id si TODOS los trabajadores indicados comparten un mismo
// departamento no nulo en esa empresa; null en otro caso (mezcla, sin
// departamento, o tienda). Se guarda en reports_log.department_id para que
// el Historial pueda filtrar por alcance empresa-departamento. No critico:
// si falla, devuelve null (el reporte se guarda sin departamento).
async function commonDepartment(env, cc, ceds) {
  try {
    const arr = [...new Set((ceds || []).map(c => String(c).replace(/[^0-9]/g, '')).filter(Boolean))];
    if (!arr.length) return null;
    const r = await sb(env, 'rpc/report_common_department', {
      method: 'POST',
      body: JSON.stringify({ p_company_code: cc, p_ceds: arr }),
    });
    // La RPC devuelve un escalar (bigint) o null.
    return (r === null || r === undefined || r === '') ? null : Number(r);
  } catch { return null; }
}

// Construye un adjunto en el formato que ESPERA la API de osTicket:
//   { "nombre.ext": "data:MIME;base64,XXXX" }
// (objeto con la clave = nombre de archivo). NO {name,data,...}.
function osAttach(filename, base64, mime) {
  return { [filename]: `data:${mime || 'application/octet-stream'};base64,${base64}` };
}

// Tamano real (en bytes) que representa un string base64, sin decodificarlo.
// Un base64 de longitud L codifica floor(L/4)*3 bytes menos el padding '='
// (cada '=' final resta 1 byte). Sirve para validar el peso de un adjunto
// en el servidor sin materializar el binario.
function base64Bytes(b64) {
  const s = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (!s) return 0;
  const pad = s.endsWith('==') ? 2 : (s.endsWith('=') ? 1 : 0);
  return Math.floor(s.length / 4) * 3 - pad;
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
    if (body.action === 'submit_egreso') {
      return await submitEgreso(env, body);
    }
    if (body.action === 'submit_ingreso') {
      return await submitIngreso(env, body);
    }
    if (body.action === 'submit_modificacion') {
      return await submitModificacion(env, body);
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
  const causes = await sb(env, 'marcaje_causas?is_active=eq.true&select=code,label,is_other');
  const causeMap = {};
  (causes || []).forEach(c => { causeMap[c.code] = c; });

  // --- Validacion linea por linea ---
  const clean = [];
  const errors = [];
  lines.forEach((ln, i) => {
    const ced = String(ln.id_number || '').replace(/[^0-9]/g, '');
    const name = String(ln.name || '').trim();
    const date = String(ln.mark_date || '').slice(0, 10);
    const dayType = String(ln.day_type || 'L').trim().toUpperCase() === 'D' ? 'D' : 'L';
    const isRest = dayType === 'D';
    const tin = String(ln.time_in || '').slice(0, 5);
    const tout = String(ln.time_out || '').slice(0, 5);
    const cause = String(ln.cause_code || '').trim();
    const otherText = (ln.cause_other_text || '').trim();
    const tag = name || ced || `fila ${i + 1}`;

    if (!ced || ced.length < 6 || ced.length > 8) { errors.push(`${tag}: cedula invalida.`); return; }
    if (!name) { errors.push(`${tag}: falta el nombre.`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push(`${tag}: fecha invalida.`); return; }
    // Horas: en Laborable son obligatorias y entrada < salida; en Descanso
    // NO se piden (la jornada no aplica) y se guardan como NULL.
    if (!isRest) {
      if (!/^\d{2}:\d{2}$/.test(tin) || !/^\d{2}:\d{2}$/.test(tout)) { errors.push(`${tag}: horas invalidas.`); return; }
      if (toMin(tin) >= toMin(tout)) { errors.push(`${tag}: la entrada debe ser menor que la salida.`); return; }
    }
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
      day_type: dayType,
      time_in: isRest ? null : tin,
      time_out: isRest ? null : tout,
      cause_code: cause,
      cause_other_text: causeMap[cause].is_other ? otherText : null,
      _causeLabel: causeMap[cause].label || cause,   // interno: para el Excel y el cuerpo
    });
  });

  if (errors.length) {
    return json({ ok: false, error: 'Hay datos que no cumplen las reglas.', details: errors }, 422);
  }

  // --- Datos de la tienda (encabezado + From osTicket + plantilla AX) ---
  // data_area es el Data ID que la plantilla AX necesita; los nombres de
  // zona/subzona/marca alimentan el cuerpo de texto del ticket.
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
  const reportDeptId = await commonDepartment(env, cc, clean.map(l => l.worker_id_number));
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
      attention: 'open',
      email_sent: false,
      source_kind: sourceKind,
      source_admin_id: sourceAdminId,
      department_id: reportDeptId,
    }),
  });
  const reportId = header && header[0] && header[0].id;
  if (!reportId) return json({ ok: false, error: 'No se pudo registrar el reporte.' }, 500);

  // --- Detalle en mark_report_lines (sin los campos internos _*) ---
  const payload = clean.map(l => ({
    report_id: reportId,
    worker_id_number: l.worker_id_number,
    worker_name: l.worker_name,
    mark_date: l.mark_date,
    day_type: l.day_type,
    time_in: l.time_in,
    time_out: l.time_out,
    cause_code: l.cause_code,
    cause_other_text: l.cause_other_text,
  }));
  await sb(env, 'mark_report_lines', { method: 'POST', body: JSON.stringify(payload) });

  // ───────────────────────────────────────────────────────────────────
  // ENVIO A OSTICKET (sincrono). Marcaje NO lleva documentos: es un solo
  // ticket PLANTILLA (PLA) con la plantilla AX (Excel) adjunta. Pieza 1/1.
  // 1) Crear/actualizar el usuario-tienda (From). 2) Crear el PLA con el
  // cuerpo de texto (buildReportText) + Excel axMarcaje. 3) Registrar la
  // relacion (gc-report.json). 4) Actualizar reports_log (osticket_id,
  // email_sent). El Excel manda data_area como TEXTO, fecha como FECHA,
  // horas como HORA (vacias en Descanso), Tipo de dia L/D y Causa legible.
  // ───────────────────────────────────────────────────────────────────
  const code = reportCode(reportId);
  const base = await osticketBase(env);
  const topicId = parseInt(await getSetting(env, 'osticket_topic_marcaje', '19'), 10) || 19;
  const fromEmail = compEmail || 'portal-nomina@grupocanaima.com';
  const fromName = `${cc} - ${compBusinessName || cc}`;
  const totalPieces = 1;   // marcaje = solo PLA

  const result = { osticket_pla: null, tickets_ok: 0, tickets_fail: 0, ticket_errors: [] };

  if (!base || !env.osticket_api_key) {
    result.ticket_errors.push('osTicket no configurado (url o api key).');
  } else {
    // 1) Usuario-tienda (idempotente). Auto-sync por uso (igual que ausencia).
    const ostUserId = await gcUser(env, base, { email: fromEmail, name: fromName, phone: compPhone });
    if (ostUserId) {
      try {
        await sb(env, `companies?company_code=eq.${encodeURIComponent(cc)}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_user_id: ostUserId, osticket_synced_at: new Date().toISOString() }),
        });
      } catch { /* no critico */ }
    }

    // 2) Cuerpo del PLA. Cada registro: Trabajador, Cedula, Fecha, Tipo de
    //    dia (Laborable (L)/Descanso (D)), y Entrada/Salida solo si es
    //    laborable. La Causa se muestra con su label legible (no el code).
    const registros = clean.map(l => {
      const causaTxt = l.cause_code === 'other' ? (l.cause_other_text || 'Otros') : (l._causeLabel || l.cause_code);
      const campos = [
        ['Trabajador', l.worker_name],
        ['Cédula', l.worker_id_number],
        ['Fecha', dmy(l.mark_date)],
        ['Tipo de día', l.day_type === 'D' ? 'Descanso (D)' : 'Laborable (L)'],
      ];
      if (l.day_type !== 'D') {
        campos.push(['Entrada', l.time_in]);
        campos.push(['Salida', l.time_out]);
      }
      campos.push(['Causa', causaTxt]);
      return campos;
    });
    const plaBody = buildReportText({
      pieceLabel: 'PLANTILLA', reportCode: code, piece: 1, totalPieces,
      topicLabel: 'Marcaje Manual',
      fecha: dmy(today), hora: nowHHMM,
      alias: cc, razon: compBusinessName, zona: mallZona, marca: marcaName,
      correoTienda: compEmail,
      responsable: responsible, cargo: position, telefono: compPhone, correoResp: compEmail,
      registros,
    });

    // Plantilla AX (Excel) adjunta. axMarcaje espera por linea: id_number,
    // date, time_in/out (vacias si 'D'), tipo (L/D) y causa_label (texto).
    let plaAttachments;
    try {
      const axCtx = {
        companyDataArea: compDataArea,
        companyName: compBusinessName,
        companyAlias: cc,
        todayYmd: today,
        reportCode: code,
        lines: clean.map(l => ({
          id_number: l.worker_id_number,
          date: l.mark_date,
          time_in: l.time_in || '',
          time_out: l.time_out || '',
          tipo: l.day_type,
          causa_label: l.cause_code === 'other' ? (l.cause_other_text || 'Otros') : (l._causeLabel || l.cause_code),
        })),
      };
      const wb = buildAxWorkbookBase64('marcaje', axCtx);
      if (wb) {
        plaAttachments = [osAttach(
          wb.filename, wb.base64,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )];
      }
    } catch (e) {
      result.ticket_errors.push(`Plantilla AX: ${String(e.message || e)}`);
    }

    try {
      const plaNum = await osticketCreateTicket(env, base, {
        email: fromEmail,
        name: fromName,
        subject: `[${code}] [1/${totalPieces}] PLA`,
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
      await gcReportLink(env, base, {
        report_code: code, ticket_number: plaNum, kind: 'PLA',
        company: cc, report_type: 'marcaje', doc_total: 0,
      });
    } catch (e) {
      result.tickets_fail++;
      result.ticket_errors.push(`PLA: ${String(e.message || e)}`);
    }

    if (result.osticket_pla) {
      try {
        await sb(env, `reports_log?id=eq.${reportId}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_id: result.osticket_pla, email_sent: true }),
        });
      } catch { /* el reporte ya esta en BD */ }
    }
  }

  // Cuantos recaudos quedaron pendientes (sin archivo) en todo el reporte.
  const pendingDocs = clean.reduce((acc, l) =>
    acc + (l._docs || []).filter(d => !d._b64).length, 0);

  return json({
    ok: true,
    report_id: reportId,
    workers_count: clean.length,
    pending_docs: pendingDocs,
    window: { today, now: nowHHMM, report_min: reportMin, report_max: reportMax },
    osticket: {
      pla: result.osticket_pla,
      tickets_ok: result.tickets_ok,
      tickets_fail: result.tickets_fail,
      errors: result.ticket_errors,
    },
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
  const reportDeptId = await commonDepartment(env, cc, clean.map(l => l.worker_id_number));
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
      attention: 'open',
      email_sent: false,
      source_kind: sourceKind,
      source_admin_id: sourceAdminId,
      department_id: reportDeptId,
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
    //    marco de doble linea + bloque PLANTILLA + DATOS DE LA TIENDA +
    //    REPORTANTE + registros de todos los trabajadores. Fechas DD/MM/YYYY.
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
      pieceLabel: 'PLANTILLA', reportCode: code, piece: 1, totalPieces,
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
        reportCode: code,   // numero de reporte -> nombre de archivo unico
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
        subject: `[${code}] [1/${totalPieces}] PLA`,
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
    //    El cuerpo usa el MISMO formato que el PLA (buildReportText) pero con
    //    bloque DOCUMENTO y un solo trabajador.
    for (let i = 0; i < withDoc.length; i++) {
      const l = withDoc[i];
      const ced = l.worker_id_number;
      const fname = l._fileName || `documento_${ced}`;
      const piece = i + 2;   // el PLA ocupo la pieza 1
      const periodo = l.date_from === l.date_to ? dmy(l.date_from) : `${dmy(l.date_from)} a ${dmy(l.date_to)}`;
      const docBody = buildReportText({
        pieceLabel: 'DOCUMENTO', reportCode: code, piece, totalPieces,
        topicLabel: `Período de Ausencia — ${atype.label}`,
        fecha: dmy(today), hora: nowHHMM,
        alias: cc, razon: compBusinessName, zona: mallZona, marca: marcaName,
        correoTienda: compEmail,
        responsable: responsible, cargo: position, telefono: compPhone, correoResp: compEmail,
        registros: [[
          ['Trabajador', l.worker_name],
          ['Cédula', ced],
          ['Período', periodo],
          ['Justificación', l.ax_code],
        ]],
      });
      try {
        const docNum = await osticketCreateTicket(env, base, {
          email: fromEmail,
          name: fromName,
          subject: `[${code}] [${piece}/${totalPieces}] DOC ${ced}`,
          message: docBody,
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

/* =====================================================================
   EGRESO (Baja)
   Registra el encabezado en reports_log (topic 'egreso') + el detalle por
   trabajador en egress_report_lines. Lleva carta de renuncia OPCIONAL: si
   se adjunta, viaja como ticket DOC por persona (igual que ausencia); si no,
   la tienda elige una causa que puede eximir el documento o dejarlo
   pendiente.

   Dos fechas por trabajador (modelo: la tienda decide la de egreso):
     - report_date : la FECHA DE EGRESO que va a AX. La elige la tienda y el
                     servidor la VALIDA contra la ventana del corte (no la
                     deriva). Es la obligatoria.
     - real_date   : la fecha real en que egreso, OPCIONAL e informativa.
                     Solo se registra si fue distinta a la reportada (p.ej.
                     mas antigua, fuera del margen). No se ata a la ventana:
                     solo <= hoy y <= report_date. Si no se indica, real =
                     report_date.
   El Excel recibe report_date (Fecha Final de Empleo). El cuerpo del ticket
   muestra la real solo cuando difiere.

   Body:
     { action:'submit_egreso', company_code, responsible, position,
       lines:[{ id_number, name, report_date, real_date,
                doc_file_name?, doc_file_b64?, doc_file_type?,
                doc_cause?, doc_cause_other? }],
       source_kind?, source_admin_id? }
   ===================================================================== */
async function submitEgreso(env, body) {
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
    if (!sourceAdminId) sourceKind = 'company';
  }

  if (!cc) return json({ ok: false, error: 'Falta la tienda.' }, 400);
  if (!responsible) return json({ ok: false, error: 'Falta el responsable.' }, 400);
  if (!lines.length) return json({ ok: false, error: 'No hay trabajadores en el reporte.' }, 400);

  // --- Ventana reportable (regla general de marcaje, server-side) ---
  const { ymd: today, hhmm: nowHHMM } = nowCaracas();
  const margin = parseInt(await getSetting(env, 'corte_margen_dias', '2'), 10) || 2;
  const cutoffTime = await getSetting(env, 'corte_hora_limite', '14:00');
  const pastCutoff = toMin(nowHHMM) >= toMin(cutoffTime);
  const reportMin = addDays(today, pastCutoff ? -(margin - 1) : -margin);
  const oldestDay = addDays(today, -margin);
  const period = await currentPeriod(env, today);
  const hito = period && period.milestone_date ? period.milestone_date : today;
  const reportMax = today < hito ? today : hito;

  // Trabajadores de la tienda (para validar egreso ya conocido). cedula -> end_date.
  // Se trae tambien el PERFIL para el snapshot (Fase 2): el egreso puede venir
  // de una tienda (store_workers) o de una empresa no-tienda (enterprise_workers),
  // asi que se consultan AMBAS por company_code. Mapa cedula -> {perfil, source}.
  const [rosterSW, rosterEW] = await Promise.all([
    sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}`
      + `&select=id_number,end_date,gender,birth_date,role,department_id,start_date`),
    sb(env, `enterprise_workers?company_code=eq.${encodeURIComponent(cc)}`
      + `&select=id_number,end_date,gender,birth_date,role,department_id,start_date`),
  ]);
  const endDateByCed = {};
  const profByCed = {};
  (rosterSW || []).forEach(w => {
    endDateByCed[w.id_number] = w.end_date || null;
    profByCed[w.id_number] = { ...w, _src: 'store_workers' };
  });
  (rosterEW || []).forEach(w => {
    // Si la cedula no estaba en store_workers, tomar el perfil/end_date de la empresa.
    if (!(w.id_number in endDateByCed)) endDateByCed[w.id_number] = w.end_date || null;
    if (!(w.id_number in profByCed)) profByCed[w.id_number] = { ...w, _src: 'enterprise_workers' };
  });

  // Helper: edad cumplida a 'ref' (YYYY-MM-DD) desde birth_date. null si falta
  // o es centinela 1900-01-01 (regla de datos del portal).
  const snapAge = (birth, ref) => {
    if (!birth || String(birth).slice(0, 10) <= '1900-01-01') return null;
    const b = String(birth).slice(0, 10).split('-').map(Number);
    const t = String(ref).slice(0, 10).split('-').map(Number);
    let a = t[0] - b[0];
    if (t[1] < b[1] || (t[1] === b[1] && t[2] < b[2])) a--;
    return (a >= 0 && a <= 120) ? a : null;
  };
  // Helper: dias entre dos 'YYYY-MM-DD' (b - a). null si falta alguna o negativo.
  const daysBetween = (a, b) => {
    if (!a || !b) return null;
    const da = Date.UTC(...String(a).slice(0, 10).split('-').map((n, i) => i === 1 ? n - 1 : +n));
    const db = Date.UTC(...String(b).slice(0, 10).split('-').map((n, i) => i === 1 ? n - 1 : +n));
    const d = Math.round((db - da) / 86400000);
    return d >= 0 ? d : null;
  };

  // --- Causas de egreso sin carta (catalogo) ---
  // waives_document: si la causa exime el documento (no queda pendiente).
  const causes = await sb(env, 'egress_doc_causes?is_active=eq.true&select=code,label,waives_document');
  const causeMap = {};
  (causes || []).forEach(c => { causeMap[c.code] = c; });

  // --- Motivos de egreso (catalogo, por que se va el trabajador). Obligatorio. ---
  const reasons = await sb(env, 'egress_reasons?is_active=eq.true&select=code,label');
  const reasonMap = {};
  (reasons || []).forEach(r => { reasonMap[r.code] = r; });

  // --- Validacion linea por linea ---
  // Nuevo modelo: el front manda report_date = la FECHA DE EGRESO elegida por
  // la tienda (la que va a AX). El servidor la VALIDA contra la ventana (no la
  // deriva). real_date es informativa: <= hoy y <= report_date; si no se
  // indica distinta, llega igual a report_date.
  const clean = [];
  const errors = [];
  lines.forEach((ln, i) => {
    const ced = String(ln.id_number || '').replace(/[^0-9]/g, '');
    const name = String(ln.name || '').trim();
    const report = String(ln.report_date || '').slice(0, 10);
    let real = String(ln.real_date || '').slice(0, 10);
    const tag = name || ced || `fila ${i + 1}`;
    // Documento (carta de renuncia): opcional. Si no hay carta, debe venir
    // una causa; segun la causa, exime o queda pendiente.
    const fileName = (ln.doc_file_name || '').toString().trim();
    const fileB64 = (ln.doc_file_b64 || '').toString();
    const fileType = (ln.doc_file_type || '').toString().trim();
    const causeCode = (ln.doc_cause || '').toString().trim();
    const causeOther = (ln.doc_cause_other || '').toString().trim();
    const reasonCode = (ln.reason_code || '').toString().trim();
    const reasonComment = (ln.reason_comment || '').toString().trim();

    if (!ced || ced.length < 6 || ced.length > 8) { errors.push(`${tag}: cedula invalida.`); return; }
    if (!name) { errors.push(`${tag}: falta el nombre.`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(report)) { errors.push(`${tag}: fecha de egreso invalida.`); return; }

    // FECHA DE EGRESO (reportable): validada contra la ventana del corte.
    const end = endDateByCed[ced];
    const maxRep = (end && end < reportMax) ? end : reportMax;
    if (report > maxRep) {
      errors.push(end && end < reportMax
        ? `${tag}: la fecha de egreso (${report}) no puede ser posterior al egreso ya registrado (${end}).`
        : `${tag}: la fecha de egreso (${report}) no puede ser futura ni posterior al ${reportMax}.`);
      return;
    }
    if (report < reportMin) {
      if (report === oldestDay && pastCutoff) {
        errors.push(`${tag}: el ${oldestDay} ya no se puede reportar (paso la hora tope ${cutoffTime} de Venezuela).`);
      } else {
        errors.push(`${tag}: la fecha de egreso (${report}) esta fuera del margen reportable (desde ${reportMin}).`);
      }
      return;
    }

    // FECHA REAL (opcional, informativa): si no vino o es igual, usa report.
    // Si vino distinta: <= hoy y <= report. No se ata a la ventana del corte
    // (puede ser mas antigua libremente).
    if (!real || !/^\d{4}-\d{2}-\d{2}$/.test(real)) real = report;
    if (real > today) { errors.push(`${tag}: la fecha real (${real}) no puede ser futura.`); return; }
    if (real > report) { errors.push(`${tag}: la fecha real (${real}) no puede ser posterior a la fecha de egreso (${report}).`); return; }

    // Motivo del egreso (obligatorio) + comentario (opcional, breve).
    if (!reasonCode) { errors.push(`${tag}: falta el motivo del egreso.`); return; }
    if (!reasonMap[reasonCode]) { errors.push(`${tag}: motivo de egreso invalido.`); return; }

    // Documento: si NO adjunta carta, exige una causa valida.
    const hasDoc = !!fileB64;
    let docCause = null, docWaived = false, causeLabel = null;
    if (!hasDoc) {
      if (!causeCode) { errors.push(`${tag}: indica la causa por la que no adjunta la carta de renuncia.`); return; }
      const c = causeMap[causeCode];
      if (!c) { errors.push(`${tag}: causa de no-adjunto invalida.`); return; }
      if (causeCode === 'other' && !causeOther) { errors.push(`${tag}: especifica la causa (Otra).`); return; }
      docCause = causeCode;
      docWaived = !!c.waives_document;
      causeLabel = causeCode === 'other' ? (causeOther || 'Otra causa') : (c.label || causeCode);
    }

    clean.push({
      worker_id_number: ced,
      worker_name: name,
      report_date: report,
      real_date: real,
      _adjusted: real !== report,
      // motivo del egreso (catalogo egress_reasons) + comentario de la tienda
      reason_code: reasonCode,
      reason_comment: reasonComment ? reasonComment.slice(0, 200) : null,
      _reasonLabel: (reasonMap[reasonCode] && reasonMap[reasonCode].label) || reasonCode,
      // documento
      has_document: hasDoc,
      doc_cause: docCause,
      doc_waived: docWaived,
      _causeLabel: causeLabel,        // interno: para el cuerpo del ticket
      _causeOther: causeOther || null,
      _fileName: fileName || null,    // interno: para el ticket DOC
      _fileB64: fileB64 || null,
      _fileType: fileType || null,
    });
  });

  if (errors.length) {
    return json({ ok: false, error: 'Hay datos que no cumplen las reglas.', details: errors }, 422);
  }

  // --- Datos de la tienda (encabezado + From osTicket + plantilla AX) ---
  const comp = await sb(env,
    `companies?company_code=eq.${encodeURIComponent(cc)}&select=data_area,zone_id,subzone_id,business_name,email,phone,concept_id`);
  const zone_id = comp && comp[0] ? comp[0].zone_id : null;
  const subzone_id = comp && comp[0] ? comp[0].subzone_id : null;
  const compBusinessName = comp && comp[0] ? (comp[0].business_name || '') : '';
  const compEmail = comp && comp[0] ? (comp[0].email || '') : '';
  const compPhone = comp && comp[0] ? (comp[0].phone || '') : '';
  const compDataArea = comp && comp[0] ? (comp[0].data_area || '') : '';
  const compConceptId = comp && comp[0] ? comp[0].concept_id : null;

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
  const mallZona = subzonaName || zonaName || '';

  // --- Encabezado en reports_log ---
  const reportDeptId = await commonDepartment(env, cc, clean.map(l => l.worker_id_number));
  const header = await sb(env, 'reports_log', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      company_code: cc,
      zone_id, subzone_id,
      topic: 'egreso',
      responsible,
      position: position || null,
      workers_count: clean.length,
      attention: 'open',
      email_sent: false,
      source_kind: sourceKind,
      source_admin_id: sourceAdminId,
      department_id: reportDeptId,
    }),
  });
  const reportId = header && header[0] && header[0].id;
  if (!reportId) return json({ ok: false, error: 'No se pudo registrar el reporte.' }, 500);

  // --- Detalle en egress_report_lines (ambas fechas + estado del documento) ---
  // Fase 2: ademas se captura el SNAPSHOT del perfil del trabajador al momento
  // del egreso (edad, sexo, cargo, departamento, antiguedad), para poder
  // analizar rotacion aunque la persona salga del roster. La antiguedad se
  // calcula con la fecha REAL de egreso (real_date) vs la fecha de ingreso.
  const payload = clean.map(l => {
    const p = profByCed[l.worker_id_number] || null;
    const birth = p && p.birth_date ? p.birth_date : null;
    const startD = p && p.start_date ? p.start_date : null;
    const ageY = snapAge(birth, l.real_date);
    const tenure = daysBetween(startD, l.real_date);
    return {
      report_id: reportId,
      worker_id_number: l.worker_id_number,
      worker_name: l.worker_name,
      report_date: l.report_date,
      real_date: l.real_date,
      reason_code: l.reason_code,
      reason_comment: l.reason_comment,
      has_document: l.has_document,
      doc_cause: l.doc_cause,
      doc_waived: l.doc_waived,
      // snapshot del perfil (null donde no haya dato / centinela 1900)
      snap_source: p ? p._src : 'none',
      snap_gender: p && p.gender ? p.gender : null,
      snap_birth_date: (birth && String(birth).slice(0, 10) > '1900-01-01') ? birth : null,
      snap_role: p && p.role ? p.role : null,
      snap_department_id: p && p.department_id != null ? p.department_id : null,
      snap_start_date: startD,
      snap_age_years: ageY,
      snap_tenure_days: tenure,
    };
  });
  await sb(env, 'egress_report_lines', { method: 'POST', body: JSON.stringify(payload) });

  // ───────────────────────────────────────────────────────────────────
  // ENVIO A OSTICKET. Igual que ausencia: 1 PLA (resumen + Excel accion B)
  // + 1 DOC por persona que adjunte carta de renuncia. Topic 33. El Excel
  // lleva la fecha REPORTABLE en "Fecha Final de Empleo" y el nombre dividido
  // (ultima palabra = apellidos). El cuerpo del PLA muestra el estado del
  // documento por persona (adjunto / causa).
  // ───────────────────────────────────────────────────────────────────
  const code = reportCode(reportId);
  const base = await osticketBase(env);
  const topicId = parseInt(await getSetting(env, 'osticket_topic_egreso', '33'), 10) || 33;
  const fromEmail = compEmail || 'portal-nomina@grupocanaima.com';
  const fromName = `${cc} - ${compBusinessName || cc}`;

  // Personas con carta adjunta (las que generan ticket DOC).
  const withDoc = clean.filter(l => l._fileB64);
  const nDocs = withDoc.length;
  const totalPieces = 1 + nDocs;   // PLA (1) + un DOC por carta

  const result = { osticket_pla: null, tickets_ok: 0, tickets_fail: 0, ticket_errors: [] };

  if (!base || !env.osticket_api_key) {
    result.ticket_errors.push('osTicket no configurado (url o api key).');
  } else {
    // 1) Usuario-tienda (idempotente). Auto-sync por uso.
    const ostUserId = await gcUser(env, base, { email: fromEmail, name: fromName, phone: compPhone });
    if (ostUserId) {
      try {
        await sb(env, `companies?company_code=eq.${encodeURIComponent(cc)}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_user_id: ostUserId, osticket_synced_at: new Date().toISOString() }),
        });
      } catch { /* no critico */ }
    }

    // 2) Cuerpo del PLA. Cada registro: Trabajador, Cedula, Tipo (Baja (B)),
    //    Fecha de egreso (reportable), Fecha real (solo si difiere), y el
    //    estado de la Carta de renuncia (adjunta / la causa elegida).
    const registros = clean.map(l => {
      const campos = [
        ['Trabajador', l.worker_name],
        ['Cédula', l.worker_id_number],
        ['Tipo', 'Baja (B)'],
        ['Fecha de egreso', dmy(l.report_date)],
      ];
      if (l._adjusted) campos.push(['Fecha real de egreso', dmy(l.real_date)]);
      campos.push(['Motivo', l._reasonLabel || l.reason_code]);
      if (l.reason_comment) campos.push(['Comentario', l.reason_comment]);
      if (l.has_document) {
        campos.push(['Carta de renuncia', 'adjunta (ticket DOC aparte)']);
      } else {
        const suf = l.doc_waived ? '' : ' — pendiente';
        campos.push(['Carta de renuncia', `${l._causeLabel}${suf}`]);
      }
      return campos;
    });
    const plaBody = buildReportText({
      pieceLabel: 'PLANTILLA', reportCode: code, piece: 1, totalPieces,
      topicLabel: 'Egreso',
      fecha: dmy(today), hora: nowHHMM,
      alias: cc, razon: compBusinessName, zona: mallZona, marca: marcaName,
      correoTienda: compEmail,
      responsable: responsible, cargo: position, telefono: compPhone, correoResp: compEmail,
      registros,
    });

    // Plantilla AX (Excel) accion B. El nombre se DIVIDE: la ultima palabra
    // va a Apellidos y el resto a Nombre (heuristica simple). id_number y
    // fechaFin = reportable. data_area va como Data ID. Resto vacio.
    let plaAttachments;
    try {
      const axCtx = {
        companyDataArea: compDataArea,
        companyName: compBusinessName,
        companyAlias: cc,
        todayYmd: today,
        reportCode: code,
        lines: clean.map(l => {
          const parts = String(l.worker_name).trim().split(/\s+/);
          const apellidos = parts.length > 1 ? parts[parts.length - 1] : '';
          const nombre = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0];
          return {
            id_number: l.worker_id_number,
            nombre,           // todo menos la ultima palabra
            apellidos,        // ultima palabra
            fechaFin: l.report_date,
          };
        }),
      };
      const wb = buildAxWorkbookBase64('egreso', axCtx);
      if (wb) {
        plaAttachments = [osAttach(
          wb.filename, wb.base64,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )];
      }
    } catch (e) {
      result.ticket_errors.push(`Plantilla AX: ${String(e.message || e)}`);
    }

    try {
      const plaNum = await osticketCreateTicket(env, base, {
        email: fromEmail,
        name: fromName,
        subject: `[${code}] [1/${totalPieces}] PLA`,
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
      await gcReportLink(env, base, {
        report_code: code, ticket_number: plaNum, kind: 'PLA',
        company: cc, report_type: 'egreso', doc_total: nDocs,
      });
    } catch (e) {
      result.tickets_fail++;
      result.ticket_errors.push(`PLA: ${String(e.message || e)}`);
    }

    // 3) Un ticket DOC por persona con carta de renuncia. Pieza k = 2,3,...
    for (let i = 0; i < withDoc.length; i++) {
      const l = withDoc[i];
      const ced = l.worker_id_number;
      const fname = l._fileName || `carta_renuncia_${ced}`;
      const piece = i + 2;   // el PLA ocupo la pieza 1
      const docBody = buildReportText({
        pieceLabel: 'DOCUMENTO', reportCode: code, piece, totalPieces,
        topicLabel: 'Egreso',
        fecha: dmy(today), hora: nowHHMM,
        alias: cc, razon: compBusinessName, zona: mallZona, marca: marcaName,
        correoTienda: compEmail,
        responsable: responsible, cargo: position, telefono: compPhone, correoResp: compEmail,
        registros: [[
          ['Trabajador', l.worker_name],
          ['Cédula', ced],
          ['Tipo', 'Baja (B)'],
          ['Fecha de egreso', dmy(l.report_date)],
          ['Documento', 'Carta de renuncia'],
        ]],
      });
      try {
        const docNum = await osticketCreateTicket(env, base, {
          email: fromEmail,
          name: fromName,
          subject: `[${code}] [${piece}/${totalPieces}] DOC ${ced}`,
          message: docBody,
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
          company: cc, report_type: 'egreso',
          worker_id: ced, worker_name: l.worker_name,
          doc_pos: piece, doc_total: totalPieces,
        });
      } catch (e) {
        result.tickets_fail++;
        result.ticket_errors.push(`DOC ${ced}: ${String(e.message || e)}`);
      }
    }

    if (result.osticket_pla) {
      try {
        await sb(env, `reports_log?id=eq.${reportId}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_id: result.osticket_pla, email_sent: true }),
        });
      } catch { /* el reporte ya esta en BD */ }
    }
  }

  // Cuantos quedaron debiendo carta (sin adjunto y sin causa que exima).
  const pendingDocs = clean.filter(l => !l.has_document && !l.doc_waived).length;

  return json({
    ok: true,
    report_id: reportId,
    workers_count: clean.length,
    pending_docs: pendingDocs,
    osticket: {
      pla: result.osticket_pla,
      tickets_ok: result.tickets_ok,
      tickets_fail: result.tickets_fail,
      errors: result.ticket_errors,
    },
  });
}

/* =====================================================================
   INGRESO (Alta)
   Registra el encabezado en reports_log (topic 'ingreso') + el detalle
   por trabajador en ingreso_report_lines. NO lleva documentos: es un
   solo ticket PLANTILLA (PLA) con el Excel de AX (accion 'A') adjunto.
   Un ingreso es una persona NUEVA (no sale del roster); por eso el
   formulario captura toda su identidad. Validaciones server-side:
     - cedula: 6 a 8 digitos; letra V/E derivada (>=80.000.000 -> E).
     - edad: fecha de nacimiento obligatoria; bloquea menores de 18.
     - cuenta: 20 digitos; los 4 primeros deben existir en 'bancos'
       (activo). Se guarda el nombre resuelto por trazabilidad.
     - telefono (opcional): 11 digitos 04XX+7; prefijo debe existir en
       'operadoras' (activo); se normaliza a +58XXXXXXXXXX.
     - cargo: code debe existir en 'cargos' (activo, selectable_on_ingreso).
     - fecha de ingreso (start_date): validada contra la ventana del corte
       (igual que la fecha de egreso), nunca futura mas alla del tope.
   El Data ID lo aporta la empresa (data_area). TodoTicket no se captura:
   el Excel pone 'N' por defecto. topic = osticket_topic_ingreso (31).

   Body:
     { action:'submit_ingreso', company_code, responsible, position,
       lines:[{ id_number, first_name, second_name?, last_names, cargo_code,
                birth_date, gender, marital_status, account_number,
                email?, phone?, address?, start_date }],
       source_kind?, source_admin_id? }
   ===================================================================== */
async function submitIngreso(env, body) {
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
    if (!sourceAdminId) sourceKind = 'company';
  }

  if (!cc) return json({ ok: false, error: 'Falta la tienda.' }, 400);
  if (!responsible) return json({ ok: false, error: 'Falta el responsable.' }, 400);
  if (!lines.length) return json({ ok: false, error: 'No hay trabajadores en el reporte.' }, 400);

  // --- Ventana reportable (regla general del corte, server-side) ---
  const { ymd: today, hhmm: nowHHMM } = nowCaracas();
  const margin = parseInt(await getSetting(env, 'corte_margen_dias', '2'), 10) || 2;
  const cutoffTime = await getSetting(env, 'corte_hora_limite', '14:00');
  const futureDays = parseInt(await getSetting(env, 'futuro_ingreso_egreso_dias', '7'), 10) || 7;
  // Limite de tamano por recaudo (MB), configurable en app_settings. El
  // cliente ya valida, pero el servidor NO confia: revalida el tamano real
  // de cada archivo base64 antes de aceptarlo (un cliente podria saltarse
  // la validacion del navegador). Fallback 2 si el setting faltara.
  const docMaxFileMb = parseFloat(await getSetting(env, 'doc_max_file_mb', '2')) || 2;
  const docMaxFileBytes = docMaxFileMb * 1024 * 1024;
  const pastCutoff = toMin(nowHHMM) >= toMin(cutoffTime);
  const reportMin = addDays(today, pastCutoff ? -(margin - 1) : -margin);
  const oldestDay = addDays(today, -margin);
  const reportMax = addDays(today, futureDays);

  // --- Catalogos para validar (cargos / bancos / operadoras activos) ---
  const cargos = await sb(env, 'cargos?is_active=eq.true&selectable_on_ingreso=eq.true&select=code,ax_code,label');
  const cargoMap = {};
  (cargos || []).forEach(c => { cargoMap[c.code] = c; });
  const bancos = await sb(env, 'bancos?is_active=eq.true&select=code,name');
  const bancoMap = {};
  (bancos || []).forEach(b => { bancoMap[b.code] = b.name; });
  const operadoras = await sb(env, 'operadoras?is_active=eq.true&select=code,name');
  const opSet = new Set((operadoras || []).map(o => o.code));

  // --- Recaudos del ingreso (required_docs incidence_code='ingreso', activos) ---
  // Catalogo fijo de documentos que se piden a CADA persona que ingresa.
  // map por id -> {id,name,enforcement}. Si un doc es 'block' y la persona
  // no adjunta su archivo, el envio se rechaza (no se registra el reporte).
  const ingDocs = await sb(env, 'required_docs?incidence_code=eq.ingreso&is_active=eq.true&select=id,name,enforcement,is_required&order=sort_order');
  const ingDocMap = {};
  (ingDocs || []).forEach(d => { ingDocMap[d.id] = { id: d.id, name: d.name, enforcement: d.enforcement || 'warn' }; });

  // Helper edad cumplida a partir de 'YYYY-MM-DD' (referencia: hoy VE).
  const ageFrom = (ymd) => {
    const t = today.split('-').map(Number), b = ymd.split('-').map(Number);
    let a = t[0] - b[0];
    if (t[1] < b[1] || (t[1] === b[1] && t[2] < b[2])) a--;
    return a;
  };

  // --- Validacion linea por linea ---
  const clean = [];
  const errors = [];
  const seenCed = new Set();
  lines.forEach((ln, i) => {
    const ced = String(ln.id_number || '').replace(/[^0-9]/g, '');
    const first = String(ln.first_name || '').trim();
    const second = String(ln.second_name || '').trim();
    const last = String(ln.last_names || '').trim();
    const cargo = String(ln.cargo_code || '').trim().toUpperCase();
    const birth = String(ln.birth_date || '').slice(0, 10);
    const gender = String(ln.gender || '').trim().toUpperCase();
    const marital = String(ln.marital_status || '').trim().toUpperCase();
    const accountRaw = String(ln.account_number || '').replace(/[^0-9]/g, '');
    const email = String(ln.email || '').trim();
    const phoneRaw = String(ln.phone || '').replace(/[^0-9]/g, '');
    const address = String(ln.address || '').trim();
    const start = String(ln.start_date || '').slice(0, 10);
    const tag = [first, last].filter(Boolean).join(' ') || ced || `fila ${i + 1}`;
    // Recaudos adjuntos de esta persona (Cedula, RIF, etc). Cada uno:
    // { required_doc_id, doc_name, file_name?, file_b64?, file_type? }.
    // El archivo es opcional (enforcement warn por defecto): si no viene,
    // el recaudo queda 'pendiente'. Se valida y normaliza mas abajo contra
    // el catalogo de required_docs del ingreso.
    const rawDocs = Array.isArray(ln.docs) ? ln.docs : [];

    // Cedula 6-8 digitos; letra V/E (>=80.000.000 -> E).
    if (!ced || ced.length < 6 || ced.length > 8) { errors.push(`${tag}: cedula invalida (6 a 8 digitos).`); return; }
    if (seenCed.has(ced)) { errors.push(`${tag}: cedula repetida en el reporte.`); return; }
    seenCed.add(ced);
    const cedKind = parseInt(ced, 10) >= 80000000 ? 'E' : 'V';

    if (!first) { errors.push(`${tag}: falta el primer nombre.`); return; }
    if (!last) { errors.push(`${tag}: faltan los apellidos.`); return; }
    if (!cargoMap[cargo]) { errors.push(`${tag}: cargo invalido o no disponible para ingreso.`); return; }
    if (gender !== 'M' && gender !== 'F') { errors.push(`${tag}: genero invalido.`); return; }
    if (!['S', 'C', 'D', 'V'].includes(marital)) { errors.push(`${tag}: estado civil invalido.`); return; }

    // Fecha de nacimiento + edad >= 18.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) { errors.push(`${tag}: fecha de nacimiento invalida.`); return; }
    if (birth > today) { errors.push(`${tag}: la fecha de nacimiento no puede ser futura.`); return; }
    if (ageFrom(birth) < 18) { errors.push(`${tag}: no se permiten menores de 18 anios.`); return; }

    // Cuenta 20 digitos + prefijo en bancos.
    if (accountRaw.length !== 20) { errors.push(`${tag}: la cuenta bancaria debe tener 20 digitos.`); return; }
    const bankCode = accountRaw.slice(0, 4);
    if (!bancoMap[bankCode]) { errors.push(`${tag}: el prefijo ${bankCode} de la cuenta no corresponde a un banco valido.`); return; }

    // Telefono opcional: 11 digitos 04XX+7, prefijo en operadoras, normaliza +58.
    let phoneIntl = null;
    if (phoneRaw) {
      if (phoneRaw.length !== 11 || phoneRaw[0] !== '0') { errors.push(`${tag}: el telefono debe tener 11 digitos (04XX-XXXXXXX).`); return; }
      const opPre = phoneRaw.slice(0, 4);
      if (!opSet.has(opPre)) { errors.push(`${tag}: prefijo telefonico ${opPre} invalido.`); return; }
      phoneIntl = '+58' + phoneRaw.slice(1);
    }

    // Correo opcional: formato simple.
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errors.push(`${tag}: correo con formato invalido.`); return; }

    // Fecha de ingreso: ventana del corte.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) { errors.push(`${tag}: fecha de ingreso invalida.`); return; }
    if (start > reportMax) { errors.push(`${tag}: la fecha de ingreso (${start}) no puede ser posterior al ${reportMax} (max. ${futureDays} dias a futuro).`); return; }
    if (start < reportMin) {
      if (start === oldestDay && pastCutoff) {
        errors.push(`${tag}: el ${oldestDay} ya no se puede reportar (paso la hora tope ${cutoffTime} de Venezuela).`);
      } else {
        errors.push(`${tag}: la fecha de ingreso (${start}) esta fuera del margen reportable (desde ${reportMin}).`);
      }
      return;
    }

    const fullName = [first, second, last].filter(Boolean).join(' ').toUpperCase();

    // Recaudos de esta persona: emparejar contra el catalogo de ingreso.
    // Para cada doc del catalogo, ver si el cliente mando archivo.
    // - block sin archivo -> error (no se registra el reporte).
    // - warn/optional sin archivo -> se registra 'pendiente'.
    const docsByReq = {};
    rawDocs.forEach(d => {
      const rid = parseInt(d.required_doc_id, 10);
      if (rid && ingDocMap[rid]) docsByReq[rid] = d;
    });
    const lineDocs = [];
    let docErr = false;
    (ingDocs || []).forEach(cat => {
      const sent = docsByReq[cat.id];
      const b64 = sent ? String(sent.file_b64 || '') : '';
      const fname = sent ? String(sent.file_name || '').trim() : '';
      const ftype = sent ? String(sent.file_type || '').trim() : '';
      const enforcement = cat.enforcement || 'warn';
      if (!b64 && enforcement === 'block') {
        errors.push(`${tag}: debe adjuntar ${cat.name} (obligatorio).`); docErr = true; return;
      }
      // Revalidacion server-side del tamano (no se confia en el cliente).
      if (b64) {
        const bytes = base64Bytes(b64);
        if (bytes > docMaxFileBytes) {
          errors.push(`${tag}: ${cat.name} pesa ${(bytes / 1048576).toFixed(1)} MB y el maximo es ${docMaxFileMb} MB.`);
          docErr = true; return;
        }
      }
      lineDocs.push({
        required_doc_id: cat.id,
        doc_name: cat.name,
        enforcement,
        _b64: b64 || null,
        _fname: fname || `${cat.name}_${ced}`,
        _ftype: ftype || 'application/octet-stream',
      });
    });
    if (docErr) return;

    clean.push({
      worker_id_number: ced,
      ced_kind: cedKind,
      first_name: first.toUpperCase(),
      second_name: second ? second.toUpperCase() : null,
      last_names: last.toUpperCase(),
      worker_name: fullName,
      cargo_code: cargo,
      _cargoAx: cargoMap[cargo].ax_code || cargo,   // interno: lo que va al Excel
      _cargoLabel: cargoMap[cargo].label || cargo,  // interno: cuerpo del ticket
      birth_date: birth,
      gender, marital_status: marital,
      account_number: accountRaw,
      bank_code: bankCode,
      bank_name: bancoMap[bankCode],
      email: email || null,
      phone: phoneIntl,
      address: address || null,
      start_date: start,
      _docs: lineDocs,   // interno: recaudos de esta persona (no es columna)
    });
  });

  if (errors.length) {
    return json({ ok: false, error: 'Hay datos que no cumplen las reglas.', details: errors }, 422);
  }

  // --- Datos de la tienda (encabezado + From osTicket + plantilla AX) ---
  const comp = await sb(env,
    `companies?company_code=eq.${encodeURIComponent(cc)}&select=data_area,zone_id,subzone_id,business_name,email,phone,concept_id`);
  const zone_id = comp && comp[0] ? comp[0].zone_id : null;
  const subzone_id = comp && comp[0] ? comp[0].subzone_id : null;
  const compBusinessName = comp && comp[0] ? (comp[0].business_name || '') : '';
  const compEmail = comp && comp[0] ? (comp[0].email || '') : '';
  const compPhone = comp && comp[0] ? (comp[0].phone || '') : '';
  const compDataArea = comp && comp[0] ? (comp[0].data_area || '') : '';
  const compConceptId = comp && comp[0] ? comp[0].concept_id : null;

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
  const mallZona = subzonaName || zonaName || '';

  // --- Encabezado en reports_log ---
  // (Ingreso: personal nuevo aun sin departamento asignado -> normalmente null.)
  const reportDeptId = await commonDepartment(env, cc, clean.map(l => l.worker_id_number));
  const header = await sb(env, 'reports_log', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      company_code: cc,
      zone_id, subzone_id,
      topic: 'ingreso',
      responsible,
      position: position || null,
      workers_count: clean.length,
      attention: 'open',
      email_sent: false,
      source_kind: sourceKind,
      source_admin_id: sourceAdminId,
      department_id: reportDeptId,
    }),
  });
  const reportId = header && header[0] && header[0].id;
  if (!reportId) return json({ ok: false, error: 'No se pudo registrar el reporte.' }, 500);

  // --- Detalle en ingreso_report_lines (devolviendo ids para enlazar docs) ---
  const payload = clean.map(l => ({
    report_id: reportId,
    worker_id_number: l.worker_id_number,
    ced_kind: l.ced_kind,
    first_name: l.first_name,
    second_name: l.second_name,
    last_names: l.last_names,
    worker_name: l.worker_name,
    cargo_code: l.cargo_code,
    birth_date: l.birth_date,
    gender: l.gender,
    marital_status: l.marital_status,
    account_number: l.account_number,
    bank_code: l.bank_code,
    bank_name: l.bank_name,
    email: l.email,
    phone: l.phone,
    address: l.address,
    start_date: l.start_date,
  }));
  const insertedLines = await sb(env, 'ingreso_report_lines', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });

  // --- Recaudos esperados por linea (ingreso_report_docs) ---
  // Un registro por (persona x recaudo del catalogo). status 'adjunto' si la
  // persona subio el archivo; 'pendiente' si no (enforcement warn/optional).
  // El archivo NO se guarda aqui: viaja por osTicket como ticket DOC. Ademas
  // guardamos el line_id en cada _docs de clean[] para no recalcular abajo.
  if (Array.isArray(insertedLines) && insertedLines.length === clean.length) {
    const docsPayload = [];
    insertedLines.forEach((row, idx) => {
      clean[idx]._lineId = row.id;
      (clean[idx]._docs || []).forEach(d => {
        docsPayload.push({
          line_id: row.id,
          required_doc_id: d.required_doc_id,
          doc_name: d.doc_name,
          enforcement: d.enforcement,
          status: d._b64 ? 'adjunto' : 'pendiente',
        });
      });
    });
    if (docsPayload.length) {
      await sb(env, 'ingreso_report_docs', { method: 'POST', body: JSON.stringify(docsPayload) });
    }
  }

  // ─── ENVIO A OSTICKET ───
  // 1 ticket PLA (resumen de todas las personas + Excel accion A) +
  // 1 ticket DOC por cada RECAUDO ADJUNTO (Cedula, RIF, etc), aplanando
  // todas las personas. Es decir, si 2 personas suben 4 recaudos c/u, son
  // 8 tickets DOC + 1 PLA = 9 piezas. Los recaudos 'pendiente' (sin archivo)
  // no generan ticket; quedan registrados en ingreso_report_docs.
  // El telefono se muestra en nacional en el cuerpo; al Excel va el +58.
  const code = reportCode(reportId);
  const base = await osticketBase(env);
  const topicId = parseInt(await getSetting(env, 'osticket_topic_ingreso', '31'), 10) || 31;
  const fromEmail = compEmail || 'portal-nomina@grupocanaima.com';
  const fromName = `${cc} - ${compBusinessName || cc}`;

  // Aplanar los recaudos CON archivo de todas las personas -> lista de DOCs.
  // Cada DOC referencia a su persona (para el cuerpo y el gc-report).
  const docPieces = [];
  clean.forEach(l => {
    (l._docs || []).forEach(d => {
      if (d._b64) docPieces.push({ line: l, doc: d });
    });
  });
  const nDocs = docPieces.length;
  const totalPieces = 1 + nDocs;   // PLA (1) + un DOC por recaudo adjunto

  const result = { osticket_pla: null, tickets_ok: 0, tickets_fail: 0, ticket_errors: [] };

  if (!base || !env.osticket_api_key) {
    result.ticket_errors.push('osTicket no configurado (url o api key).');
  } else {
    const ostUserId = await gcUser(env, base, { email: fromEmail, name: fromName, phone: compPhone });
    if (ostUserId) {
      try {
        await sb(env, `companies?company_code=eq.${encodeURIComponent(cc)}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_user_id: ostUserId, osticket_synced_at: new Date().toISOString() }),
        });
      } catch { /* no critico */ }
    }

    // Telefono en nacional para el cuerpo (+58XXXXXXXXXX -> 0XXXXXXXXXX).
    const phoneNat = (intl) => intl ? '0' + String(intl).replace(/^\+58/, '') : '—';
    const registros = clean.map(l => ([
      ['Trabajador', l.worker_name],
      ['Cedula', `${l.ced_kind}-${l.worker_id_number}`],
      ['Tipo', 'Alta (A)'],
      ['Cargo', l._cargoLabel],
      ['Fecha de ingreso', dmy(l.start_date)],
      ['Fecha de nacimiento', dmy(l.birth_date)],
      ['Genero', l.gender === 'M' ? 'Masculino' : 'Femenino'],
      ['Estado civil', { S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a' }[l.marital_status] || l.marital_status],
      ['Cuenta', `${l.account_number} (${l.bank_name})`],
      ['Correo', l.email || '—'],
      ['Telefono', phoneNat(l.phone)],
      ['Direccion', l.address || '—'],
    ]));
    const plaBody = buildReportText({
      pieceLabel: 'PLANTILLA', reportCode: code, piece: 1, totalPieces,
      topicLabel: 'Ingreso',
      fecha: dmy(today), hora: nowHHMM,
      alias: cc, razon: compBusinessName, zona: mallZona, marca: marcaName,
      correoTienda: compEmail,
      responsable: responsible, cargo: position, telefono: compPhone, correoResp: compEmail,
      registros,
    });

    // Plantilla AX (Excel) accion A. 18 columnas; TodoTicket 'N' por defecto
    // (lo pone el template). El nombre ya viene dividido en nombre/nombre2/
    // apellidos. La cuenta y la cedula van como texto (preservan ceros).
    let plaAttachments;
    try {
      const axCtx = {
        companyDataArea: compDataArea,
        companyName: compBusinessName,
        companyAlias: cc,
        todayYmd: today,
        reportCode: code,
        lines: clean.map(l => ({
          id_number: l.worker_id_number,
          nombre: l.first_name,
          nombre2: l.second_name || '',
          apellidos: l.last_names,
          correo: l.email || '',
          fechaIni: l.start_date,
          cargo: l._cargoAx,
          direccion: l.address || '',
          fechaNac: l.birth_date,
          estCivil: l.marital_status,
          telefono: l.phone || '',
          genero: l.gender,
          cuenta: l.account_number,
        })),
      };
      const wb = buildAxWorkbookBase64('ingreso', axCtx);
      if (wb) {
        plaAttachments = [osAttach(
          wb.filename, wb.base64,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )];
      }
    } catch (e) {
      result.ticket_errors.push(`Plantilla AX: ${String(e.message || e)}`);
    }

    try {
      const plaNum = await osticketCreateTicket(env, base, {
        email: fromEmail,
        name: fromName,
        subject: `[${code}] [1/${totalPieces}] PLA`,
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
      await gcReportLink(env, base, {
        report_code: code, ticket_number: plaNum, kind: 'PLA',
        company: cc, report_type: 'ingreso', doc_total: nDocs,
      });
    } catch (e) {
      result.tickets_fail++;
      result.ticket_errors.push(`PLA: ${String(e.message || e)}`);
    }

    // Un ticket DOC por cada recaudo adjunto, aplanando todas las personas.
    // Pieza k = 2,3,... (el PLA es la 1). El cuerpo lleva los datos de la
    // persona + el nombre del recaudo. El asunto incluye ced y recaudo para
    // identificarlo de un vistazo en osTicket.
    for (let i = 0; i < docPieces.length; i++) {
      const { line: l, doc: d } = docPieces[i];
      const ced = l.worker_id_number;
      const piece = i + 2;   // el PLA ocupo la pieza 1
      const docBody = buildReportText({
        pieceLabel: 'DOCUMENTO', reportCode: code, piece, totalPieces,
        topicLabel: `Ingreso — ${d.doc_name}`,
        fecha: dmy(today), hora: nowHHMM,
        alias: cc, razon: compBusinessName, zona: mallZona, marca: marcaName,
        correoTienda: compEmail,
        responsable: responsible, cargo: position, telefono: compPhone, correoResp: compEmail,
        registros: [[
          ['Trabajador', l.worker_name],
          ['Cédula', `${l.ced_kind}-${ced}`],
          ['Tipo', 'Alta (A)'],
          ['Recaudo', d.doc_name],
        ]],
      });
      try {
        const docNum = await osticketCreateTicket(env, base, {
          email: fromEmail,
          name: fromName,
          subject: `[${code}] [${piece}/${totalPieces}] DOC ${ced} ${d.doc_name}`,
          message: docBody,
          topicId,
          source: 'API',
          alert: false,
          autorespond: false,
          report_code: code,
          report_kind: 'DOC',
          attachments: [osAttach(d._fname, d._b64, d._ftype || 'application/octet-stream')],
        });
        result.tickets_ok++;
        await gcReportLink(env, base, {
          report_code: code, ticket_number: docNum, kind: 'DOC',
          company: cc, report_type: 'ingreso',
          worker_id: ced, worker_name: l.worker_name,
          doc_pos: piece, doc_total: totalPieces,
        });
      } catch (e) {
        result.tickets_fail++;
        result.ticket_errors.push(`DOC ${ced} ${d.doc_name}: ${String(e.message || e)}`);
      }
    }

    if (result.osticket_pla) {
      try {
        await sb(env, `reports_log?id=eq.${reportId}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_id: result.osticket_pla, email_sent: true }),
        });
      } catch { /* el reporte ya esta en BD */ }
    }
  }

  return json({
    ok: true,
    report_id: reportId,
    workers_count: clean.length,
    window: { today, now: nowHHMM, report_min: reportMin, report_max: reportMax },
    osticket: {
      pla: result.osticket_pla,
      tickets_ok: result.tickets_ok,
      tickets_fail: result.tickets_fail,
      errors: result.ticket_errors,
    },
  });
}

/* =====================================================================
   MODIFICACION DE DATOS (accion AX 'M')
   Registra el encabezado en reports_log (topic 'modificacion') + el
   detalle por trabajador en modificacion_report_lines (changes JSONB).
   NO lleva documentos: es un solo ticket PLANTILLA (PLA) con el Excel de
   AX (accion 'M', 18 columnas) adjunto.

   MODELO: solo viaja lo que CAMBIA. La cedula identifica y va SIEMPRE (no
   es modificable). El nombre tambien va siempre al Excel (AX lo exige para
   ubicar el registro): si no se modifico, se usa el actual del roster
   dividido en first/second/last. Cada campo del catalogo modificacion_fields
   que venga en changes se valida segun su input_kind; los que no vienen, se
   dejan VACIOS en el Excel (no se tocan en AX).

   No hay ventana de fechas (date_rule = none): la modificacion no se ata
   al corte de nomina.

   Body:
     { action:'submit_modificacion', company_code, responsible, position,
       lines:[{ id_number, worker_name?, changes:{ code: valor, ... } }],
       source_kind?, source_admin_id? }
   donde changes usa los code del catalogo (cargo, cuenta, telefono, correo,
   direccion, estCivil, fechaNac, todoTicket) y, para el nombre, las claves
   first_name / second_name / last_names (el modal divide el nombre en 3).
   ===================================================================== */
async function submitModificacion(env, body) {
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
    if (!sourceAdminId) sourceKind = 'company';
  }

  if (!cc) return json({ ok: false, error: 'Falta la tienda.' }, 400);
  if (!responsible) return json({ ok: false, error: 'Falta el responsable.' }, 400);
  if (!lines.length) return json({ ok: false, error: 'No hay trabajadores en el reporte.' }, 400);

  const { ymd: today, hhmm: nowHHMM } = nowCaracas();

  // --- Catalogo de campos modificables (activos) + catalogos de validacion ---
  // El catalogo define que se puede cambiar y como se valida (input_kind).
  // El nombre (input_kind 'name') se captura dividido en 3 sub-campos en el
  // modal; aqui se valida cada parte. cargo/cuenta/telefono requieren sus
  // catalogos para validar (existencia de cargo, prefijo de banco/operadora).
  const fieldsRows = await sb(env,
    'modificacion_fields?is_active=eq.true&select=code,label,ax_column,input_kind');
  if (!fieldsRows || !fieldsRows.length) {
    return json({ ok: false, error: 'No hay campos modificables configurados.' }, 400);
  }
  const fieldByCode = {};
  (fieldsRows || []).forEach(f => { fieldByCode[f.code] = f; });
  const hasField = (code) => !!fieldByCode[code];

  const cargos = await sb(env, 'cargos?is_active=eq.true&selectable_on_ingreso=eq.true&select=code,ax_code,label');
  const cargoMap = {};
  (cargos || []).forEach(c => { cargoMap[c.code] = c; });
  const bancos = await sb(env, 'bancos?is_active=eq.true&select=code,name');
  const bancoMap = {};
  (bancos || []).forEach(b => { bancoMap[b.code] = b.name; });
  const operadoras = await sb(env, 'operadoras?is_active=eq.true&select=code,name');
  const opSet = new Set((operadoras || []).map(o => o.code));

  // Helper edad cumplida (referencia: hoy VE), para validar fecha de nacimiento.
  const ageFrom = (ymd) => {
    const t = today.split('-').map(Number), b = ymd.split('-').map(Number);
    let a = t[0] - b[0];
    if (t[1] < b[1] || (t[1] === b[1] && t[2] < b[2])) a--;
    return a;
  };

  // --- Roster de la tienda: para precargar el nombre actual cuando el
  //     reporte no lo modifique (AX necesita el nombre dividido siempre). ---
  const roster = await sb(env,
    `store_workers?company_code=eq.${encodeURIComponent(cc)}`
    + `&select=id_number,full_name,first_name,second_name,last_names`);
  const rosterByCed = {};
  (roster || []).forEach(w => { rosterByCed[w.id_number] = w; });

  // --- Validacion linea por linea ---
  // Cada linea: cedula obligatoria (identifica) + un objeto changes con SOLO
  // los campos que cambian. Validar cada cambio segun el input_kind del campo.
  const clean = [];
  const errors = [];
  const seenCed = new Set();
  lines.forEach((ln, i) => {
    const ced = String(ln.id_number || '').replace(/[^0-9]/g, '');
    const changes = (ln.changes && typeof ln.changes === 'object') ? ln.changes : {};
    const tag = (ln.worker_name || '').trim() || ced || `fila ${i + 1}`;

    // Cedula obligatoria (6-8 digitos). Identifica al trabajador y va SIEMPRE.
    if (!ced || ced.length < 6 || ced.length > 8) { errors.push(`${tag}: cedula invalida (6 a 8 digitos).`); return; }
    if (seenCed.has(ced)) { errors.push(`${tag}: cedula repetida en el reporte.`); return; }
    seenCed.add(ced);
    const cedKind = parseInt(ced, 10) >= 80000000 ? 'E' : 'V';

    // Acumular en outChanges los valores YA VALIDADOS Y NORMALIZADOS, con la
    // clave del code del catalogo (o first/second/last para el nombre).
    const outChanges = {};
    let lineErr = false;
    const push = (k, v) => { outChanges[k] = v; };

    // --- Nombre (input_kind 'name'): llega dividido en first/second/last ---
    // Se considera "cambia el nombre" si vino cualquiera de las 3 claves.
    const nameTouched = ('first_name' in changes) || ('second_name' in changes) || ('last_names' in changes);
    if (nameTouched) {
      if (!hasField('nombre')) { errors.push(`${tag}: el nombre no es modificable.`); lineErr = true; }
      else {
        const f1 = String(changes.first_name == null ? '' : changes.first_name).trim().toUpperCase();
        const f2 = String(changes.second_name == null ? '' : changes.second_name).trim().toUpperCase();
        const ln3 = String(changes.last_names == null ? '' : changes.last_names).trim().toUpperCase();
        if (f1 && f1.length < 2) { errors.push(`${tag}: el primer nombre es muy corto.`); lineErr = true; }
        if (ln3 && ln3.length < 2) { errors.push(`${tag}: los apellidos son muy cortos.`); lineErr = true; }
        // Si cambia el nombre, exigir al menos primer nombre y apellidos
        // (no se admite un nombre vacio).
        if (!f1) { errors.push(`${tag}: falta el primer nombre.`); lineErr = true; }
        if (!ln3) { errors.push(`${tag}: faltan los apellidos.`); lineErr = true; }
        if (!lineErr) { push('first_name', f1); push('second_name', f2 || ''); push('last_names', ln3); }
      }
    }

    // --- Cargo (input_kind 'cargo'): code debe existir en el catalogo ---
    if ('cargo' in changes) {
      if (!hasField('cargo')) { errors.push(`${tag}: el cargo no es modificable.`); lineErr = true; }
      else {
        const cargo = String(changes.cargo || '').trim().toUpperCase();
        if (!cargoMap[cargo]) { errors.push(`${tag}: cargo invalido o no disponible.`); lineErr = true; }
        else push('cargo', cargo);
      }
    }

    // --- Cuenta (input_kind 'account'): 20 digitos + prefijo de banco ---
    if ('cuenta' in changes) {
      if (!hasField('cuenta')) { errors.push(`${tag}: la cuenta no es modificable.`); lineErr = true; }
      else {
        const acc = String(changes.cuenta || '').replace(/[^0-9]/g, '');
        if (acc.length !== 20) { errors.push(`${tag}: la cuenta debe tener 20 digitos.`); lineErr = true; }
        else if (!bancoMap[acc.slice(0, 4)]) { errors.push(`${tag}: el prefijo ${acc.slice(0, 4)} no es un banco valido.`); lineErr = true; }
        else push('cuenta', acc);
      }
    }

    // --- Telefono (input_kind 'phone'): 11 digitos 04XX+7, normaliza +58 ---
    if ('telefono' in changes) {
      if (!hasField('telefono')) { errors.push(`${tag}: el telefono no es modificable.`); lineErr = true; }
      else {
        const ph = String(changes.telefono || '').replace(/[^0-9]/g, '');
        if (ph.length !== 11 || ph[0] !== '0') { errors.push(`${tag}: el telefono debe tener 11 digitos (04XX-XXXXXXX).`); lineErr = true; }
        else if (!opSet.has(ph.slice(0, 4))) { errors.push(`${tag}: prefijo telefonico ${ph.slice(0, 4)} invalido.`); lineErr = true; }
        else push('telefono', '+58' + ph.slice(1));
      }
    }

    // --- Correo (input_kind 'email') ---
    if ('correo' in changes) {
      if (!hasField('correo')) { errors.push(`${tag}: el correo no es modificable.`); lineErr = true; }
      else {
        const em = String(changes.correo || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { errors.push(`${tag}: correo con formato invalido.`); lineErr = true; }
        else push('correo', em);
      }
    }

    // --- Direccion (input_kind 'text') ---
    if ('direccion' in changes) {
      if (!hasField('direccion')) { errors.push(`${tag}: la direccion no es modificable.`); lineErr = true; }
      else {
        const dir = String(changes.direccion || '').trim();
        if (!dir) { errors.push(`${tag}: la direccion no puede quedar vacia si se modifica.`); lineErr = true; }
        else push('direccion', dir);
      }
    }

    // --- Estado civil (input_kind 'marital'): S/C/D/V ---
    if ('estCivil' in changes) {
      if (!hasField('estCivil')) { errors.push(`${tag}: el estado civil no es modificable.`); lineErr = true; }
      else {
        const ec = String(changes.estCivil || '').trim().toUpperCase();
        if (!['S', 'C', 'D', 'V'].includes(ec)) { errors.push(`${tag}: estado civil invalido.`); lineErr = true; }
        else push('estCivil', ec);
      }
    }

    // --- Sexo / Genero (input_kind 'gender'): M/F ---
    if ('sexo' in changes) {
      if (!hasField('sexo')) { errors.push(`${tag}: el sexo no es modificable.`); lineErr = true; }
      else {
        const sx = String(changes.sexo || '').trim().toUpperCase();
        if (!['M', 'F'].includes(sx)) { errors.push(`${tag}: sexo invalido (M/F).`); lineErr = true; }
        else push('sexo', sx);
      }
    }

    // --- Fecha de nacimiento (input_kind 'birthdate'): mayor de 18 ---
    if ('fechaNac' in changes) {
      if (!hasField('fechaNac')) { errors.push(`${tag}: la fecha de nacimiento no es modificable.`); lineErr = true; }
      else {
        const fn = String(changes.fechaNac || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fn)) { errors.push(`${tag}: fecha de nacimiento invalida.`); lineErr = true; }
        else if (fn > today) { errors.push(`${tag}: la fecha de nacimiento no puede ser futura.`); lineErr = true; }
        else if (ageFrom(fn) < 18) { errors.push(`${tag}: no se permiten menores de 18 anios.`); lineErr = true; }
        else push('fechaNac', fn);
      }
    }

    // --- TodoTicket (input_kind 'todoticket'): S/N ---
    if ('todoTicket' in changes) {
      if (!hasField('todoTicket')) { errors.push(`${tag}: TodoTicket no es modificable.`); lineErr = true; }
      else {
        const tt = String(changes.todoTicket || '').trim().toUpperCase();
        if (!['S', 'N'].includes(tt)) { errors.push(`${tag}: TodoTicket invalido (S/N).`); lineErr = true; }
        else push('todoTicket', tt);
      }
    }

    if (lineErr) return;

    // Debe cambiar AL MENOS un campo (la cedula sola no modifica nada).
    const changedKeys = Object.keys(outChanges);
    if (!changedKeys.length) {
      errors.push(`${tag}: no se indico ningun cambio.`); return;
    }

    // Nombre para el Excel (AX lo exige). Si cambio, usar el nuevo; si no,
    // tomar el actual del roster (ya dividido). Si el roster no lo tiene
    // dividido, dividir el full_name al vuelo (heuristica simple: ultima
    // palabra = apellidos) como respaldo.
    const r = rosterByCed[ced] || {};
    let exFirst, exSecond, exLast;
    if (nameTouched) {
      exFirst = outChanges.first_name;
      exSecond = outChanges.second_name || '';
      exLast = outChanges.last_names;
    } else if (r.first_name || r.last_names) {
      exFirst = (r.first_name || '').toUpperCase();
      exSecond = (r.second_name || '').toUpperCase();
      exLast = (r.last_names || '').toUpperCase();
    } else {
      const parts = String(r.full_name || ln.worker_name || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
      if (parts.length > 1) { exLast = parts[parts.length - 1]; exFirst = parts.slice(0, -1).join(' '); exSecond = ''; }
      else { exFirst = parts[0] || ''; exSecond = ''; exLast = ''; }
    }

    // worker_name legible para BD/cuerpo (nombre completo resultante).
    const wname = [exFirst, exSecond, exLast].filter(Boolean).join(' ').trim()
      || (ln.worker_name || '').trim() || ced;

    clean.push({
      worker_id_number: ced,
      ced_kind: cedKind,
      worker_name: wname,
      changes: outChanges,        // lo que se guarda en BD (JSONB) y se muestra
      _exFirst: exFirst, _exSecond: exSecond, _exLast: exLast,  // para el Excel
    });
  });

  if (errors.length) {
    return json({ ok: false, error: 'Hay datos que no cumplen las reglas.', details: errors }, 422);
  }

  // --- Datos de la tienda (encabezado + From osTicket + plantilla AX) ---
  const comp = await sb(env,
    `companies?company_code=eq.${encodeURIComponent(cc)}&select=data_area,zone_id,subzone_id,business_name,email,phone,concept_id`);
  const zone_id = comp && comp[0] ? comp[0].zone_id : null;
  const subzone_id = comp && comp[0] ? comp[0].subzone_id : null;
  const compBusinessName = comp && comp[0] ? (comp[0].business_name || '') : '';
  const compEmail = comp && comp[0] ? (comp[0].email || '') : '';
  const compPhone = comp && comp[0] ? (comp[0].phone || '') : '';
  const compDataArea = comp && comp[0] ? (comp[0].data_area || '') : '';
  const compConceptId = comp && comp[0] ? comp[0].concept_id : null;

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
  const mallZona = subzonaName || zonaName || '';

  // --- Encabezado en reports_log ---
  const reportDeptId = await commonDepartment(env, cc, clean.map(l => l.worker_id_number));
  const header = await sb(env, 'reports_log', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      company_code: cc,
      zone_id, subzone_id,
      topic: 'modificacion',
      responsible,
      position: position || null,
      workers_count: clean.length,
      attention: 'open',
      email_sent: false,
      source_kind: sourceKind,
      source_admin_id: sourceAdminId,
      department_id: reportDeptId,
    }),
  });
  const reportId = header && header[0] && header[0].id;
  if (!reportId) return json({ ok: false, error: 'No se pudo registrar el reporte.' }, 500);

  // --- Detalle en modificacion_report_lines (changes JSONB) ---
  const payload = clean.map(l => ({
    report_id: reportId,
    worker_id_number: l.worker_id_number,
    worker_name: l.worker_name,
    changes: l.changes,
  }));
  await sb(env, 'modificacion_report_lines', { method: 'POST', body: JSON.stringify(payload) });

  // ───────────────────────────────────────────────────────────────────
  // ENVIO A OSTICKET. Modificacion NO lleva documentos: 1 solo ticket PLA
  // con el Excel accion 'M' adjunto. Topic 32. El Excel lleva SIEMPRE la
  // cedula y el nombre dividido; los campos cambiados en su columna y los NO
  // cambiados VACIOS (AX solo actualiza lo que viene con valor). Las fechas
  // de ingreso/egreso van vacias (no se modifican aqui).
  // ───────────────────────────────────────────────────────────────────
  const code = reportCode(reportId);
  const base = await osticketBase(env);
  const topicId = parseInt(await getSetting(env, 'osticket_topic_modificacion', '32'), 10) || 32;
  const fromEmail = compEmail || 'portal-nomina@grupocanaima.com';
  const fromName = `${cc} - ${compBusinessName || cc}`;
  const totalPieces = 1;   // modificacion = solo PLA

  const result = { osticket_pla: null, tickets_ok: 0, tickets_fail: 0, ticket_errors: [] };

  // Etiquetas legibles para el cuerpo del ticket.
  const maritalLbl = { S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a' };
  const phoneNat = (intl) => intl ? '0' + String(intl).replace(/^\+58/, '') : intl;
  // Convierte una clave+valor de changes a texto legible para el cuerpo.
  const changeText = (l) => {
    const ch = l.changes;
    const parts = [];
    if ('first_name' in ch || 'last_names' in ch) {
      parts.push(['Nombre', [l._exFirst, l._exSecond, l._exLast].filter(Boolean).join(' ')]);
    }
    if ('cargo' in ch) parts.push(['Cargo', (cargoMap[ch.cargo] && cargoMap[ch.cargo].label) || ch.cargo]);
    if ('cuenta' in ch) parts.push(['Cuenta', `${ch.cuenta} (${bancoMap[ch.cuenta.slice(0, 4)] || ''})`]);
    if ('telefono' in ch) parts.push(['Telefono', phoneNat(ch.telefono)]);
    if ('correo' in ch) parts.push(['Correo', ch.correo]);
    if ('direccion' in ch) parts.push(['Direccion', ch.direccion]);
    if ('estCivil' in ch) parts.push(['Estado civil', maritalLbl[ch.estCivil] || ch.estCivil]);
    if ('sexo' in ch) parts.push(['Sexo', ch.sexo === 'M' ? 'Masculino' : (ch.sexo === 'F' ? 'Femenino' : ch.sexo)]);
    if ('fechaNac' in ch) parts.push(['Fecha de nacimiento', dmy(ch.fechaNac)]);
    if ('todoTicket' in ch) parts.push(['TodoTicket', ch.todoTicket === 'S' ? 'Si' : 'No']);
    return parts;
  };

  if (!base || !env.osticket_api_key) {
    result.ticket_errors.push('osTicket no configurado (url o api key).');
  } else {
    // 1) Usuario-tienda (idempotente). Auto-sync por uso.
    const ostUserId = await gcUser(env, base, { email: fromEmail, name: fromName, phone: compPhone });
    if (ostUserId) {
      try {
        await sb(env, `companies?company_code=eq.${encodeURIComponent(cc)}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_user_id: ostUserId, osticket_synced_at: new Date().toISOString() }),
        });
      } catch { /* no critico */ }
    }

    // 2) Cuerpo del PLA. Cada registro: Trabajador (resultante), Cedula, Tipo
    //    (Modificacion (M)) y SOLO los campos que cambian (con su valor nuevo).
    const registros = clean.map(l => {
      const campos = [
        ['Trabajador', l.worker_name],
        ['Cédula', `${l.ced_kind}-${l.worker_id_number}`],
        ['Tipo', 'Modificación (M)'],
      ];
      changeText(l).forEach(([k, v]) => campos.push([k, v]));
      return campos;
    });
    const plaBody = buildReportText({
      pieceLabel: 'PLANTILLA', reportCode: code, piece: 1, totalPieces,
      topicLabel: 'Modificación de Datos',
      fecha: dmy(today), hora: nowHHMM,
      alias: cc, razon: compBusinessName, zona: mallZona, marca: marcaName,
      correoTienda: compEmail,
      responsable: responsible, cargo: position, telefono: compPhone, correoResp: compEmail,
      registros,
    });

    // Plantilla AX (Excel) accion 'M'. SIEMPRE cedula + nombre dividido; los
    // campos cambiados en su columna AX, los NO cambiados VACIOS. Las fechas
    // de ingreso/egreso van vacias (no se modifican). TodoTicket: solo va si
    // se cambio (si no, vacio -> AX no lo toca).
    let plaAttachments;
    try {
      const axCtx = {
        companyDataArea: compDataArea,
        companyName: compBusinessName,
        companyAlias: cc,
        todayYmd: today,
        reportCode: code,
        lines: clean.map(l => {
          const ch = l.changes;
          return {
            id_number: l.worker_id_number,
            nombre: l._exFirst,
            nombre2: l._exSecond || '',
            apellidos: l._exLast,
            correo: ('correo' in ch) ? ch.correo : '',
            // fechaIni / fechaFin: vacias (no se modifican en M).
            fechaIni: '',
            fechaFin: '',
            cargo: ('cargo' in ch) ? ((cargoMap[ch.cargo] && cargoMap[ch.cargo].ax_code) || ch.cargo) : '',
            direccion: ('direccion' in ch) ? ch.direccion : '',
            fechaNac: ('fechaNac' in ch) ? ch.fechaNac : '',
            estCivil: ('estCivil' in ch) ? ch.estCivil : '',
            telefono: ('telefono' in ch) ? ch.telefono : '',
            genero: ('sexo' in ch) ? ch.sexo : '',   // solo va si se modifico
            cuenta: ('cuenta' in ch) ? ch.cuenta : '',
            todoTicket: ('todoTicket' in ch) ? ch.todoTicket : '',
          };
        }),
      };
      const wb = buildAxWorkbookBase64('modificacion', axCtx);
      if (wb) {
        plaAttachments = [osAttach(
          wb.filename, wb.base64,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )];
      }
    } catch (e) {
      result.ticket_errors.push(`Plantilla AX: ${String(e.message || e)}`);
    }

    try {
      const plaNum = await osticketCreateTicket(env, base, {
        email: fromEmail,
        name: fromName,
        subject: `[${code}] [1/${totalPieces}] PLA`,
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
      await gcReportLink(env, base, {
        report_code: code, ticket_number: plaNum, kind: 'PLA',
        company: cc, report_type: 'modificacion', doc_total: 0,
      });
    } catch (e) {
      result.tickets_fail++;
      result.ticket_errors.push(`PLA: ${String(e.message || e)}`);
    }

    if (result.osticket_pla) {
      try {
        await sb(env, `reports_log?id=eq.${reportId}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_id: result.osticket_pla, email_sent: true }),
        });
      } catch { /* el reporte ya esta en BD */ }
    }
  }

  return json({
    ok: true,
    report_id: reportId,
    workers_count: clean.length,
    osticket: {
      pla: result.osticket_pla,
      tickets_ok: result.tickets_ok,
      tickets_fail: result.tickets_fail,
      errors: result.ticket_errors,
    },
  });
}
