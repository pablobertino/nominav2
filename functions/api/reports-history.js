/* =====================================================================
   functions/api/reports-history.js  →  /api/reports-history
   Historial de reportes enviados. Filtrado por alcance segun rol:
     - tienda (company): solo sus propios reportes
     - admin: solo reportes de tiendas en su alcance (get_admin_companies)
     - superadmin: todos
   Con filtros (tipo, rango de fechas, tienda, busqueda, estado de
   atencion y de osTicket) y paginacion server-side.

   Acciones (POST {action}):
     - list   : pagina de encabezados + total.
                { action:'list', user, filters:{ type?, date_from?, date_to?,
                  company?, q?, attention?, osticket? }, page?, per_page? }
     - detail : un reporte + sus lineas de detalle.
                { action:'detail', user, report_id }
     - ticket_text : regenera el CUERPO DE TEXTO del ticket (PLA) de un
                reporte ya enviado, reusando buildReportText con los datos
                guardados. Util cuando osTicket esta caido (copiar/pegar).
                Devuelve { ok, text, filename }.
                { action:'ticket_text', user, report_id }
     - ticket_excel : regenera la PLANTILLA DE EXCEL (.xlsx) que se adjunta
                al ticket PLA, reusando buildAxWorkbookBase64 con los datos
                guardados. Devuelve { ok, base64, filename, mime }.
                { action:'ticket_excel', user, report_id }
     - set_attention : (solo admin/superadmin con alcance) cambia el estado
                de atencion de uno o varios reportes y opcionalmente
                sincroniza el estado en osTicket.
                { action:'set_attention', user, report_ids:[...], status,
                  comment?, sync_osticket? }

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { buildReportText, buildAxWorkbookBase64 } from './_ax-template.js';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

// 'YYYY-MM-DD' -> 'DD/MM/YYYY' (igual que reports.js, para el cuerpo del ticket)
function dmy(ymd) {
  if (!ymd) return '';
  const m = String(ymd).slice(0, 10).split('-');
  return m.length === 3 ? `${m[2]}/${m[1]}/${m[0]}` : ymd;
}

// Folio del reporte: id con ceros a la izquierda, minimo 4 digitos (igual
// que reportCode en reports.js). 29 -> '0029'; 12345 -> '12345'.
function reportCode(id) {
  return String(id).padStart(4, '0');
}

// Sanea un texto para usarlo en un nombre de archivo (alias/tipo): quita
// acentos, deja solo alfanumerico y guion bajo, mayusculas.
function safeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
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
  return res;
}

async function sbJson(env, path, opts = {}) {
  const res = await sb(env, path, opts);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

/* =====================================================================
   osTicket — helpers para empujar el estado (mismo patron que reports.js).
   La URL vive en app_settings.osticket_url; la API key es Secret de
   Cloudflare osticket_api_key. El cambio de estado va al endpoint propio
   /api/gc-status.json, que recorre TODOS los tickets del reporte
   (PLA + N DOC, via gc_report_link) y aplica Ticket::setStatus.
   ===================================================================== */

async function getSetting(env, key, fallback) {
  const r = await sbJson(env, `app_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  return (r && r[0] && r[0].value != null) ? r[0].value : fallback;
}

// Base URL del osTicket (sin barra final).
async function osticketBase(env) {
  const url = await getSetting(env, 'osticket_url', '');
  return String(url || '').replace(/\/+$/, '');
}

// POST JSON con la X-API-Key. Devuelve { status, ok, text, json }. No lanza.
async function osticketPost(env, base, path, payload) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'X-API-Key': env.osticket_api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let js = null;
  try { js = text ? JSON.parse(text) : null; } catch { /* puede venir texto plano */ }
  return { status: res.status, ok: res.ok, text, json: js };
}

// Cambia el estado de TODOS los tickets de un reporte (por report_code) en
// osTicket. Devuelve el objeto de respuesta del endpoint o lanza Error.
async function osticketSetReportStatus(env, base, reportCodeStr, statusId, comment) {
  const r = await osticketPost(env, base, '/api/gc-status.json', {
    report_code: reportCodeStr,
    status_id: statusId,
    comment: comment || '',
  });
  // 200 = todos ok; 207 = parcial; 4xx/5xx = error. El cuerpo es JSON.
  if (r.status === 200) return r.json || { ok: true };
  if (r.status === 207) return r.json || { ok: false };
  throw new Error((r.json && r.json.error) ? r.json.error : `osTicket ${r.status}: ${r.text || 'sin detalle'}`);
}

// Crea un ticket en osTicket (mismo patron que reports.js). Devuelve el
// NUMERO del ticket (texto, ej '002140') o lanza Error. La API responde 201
// con el numero como cuerpo (texto plano, a veces con comillas).
async function osticketCreateTicket(env, base, payload) {
  const r = await osticketPost(env, base, '/api/tickets.json', payload);
  if (r.status !== 201) {
    throw new Error(`osTicket ticket ${r.status}: ${r.text || 'sin detalle'}`);
  }
  return (r.text || '').trim().replace(/^"|"$/g, '');
}

// Registra la relacion ticket<->reporte (gc_report_link). No critico.
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

// Adjunto en el formato de la API de osTicket: { "nombre.ext": "data:MIME;base64,XXXX" }.
function osAttach(filename, base64, mime) {
  return { [filename]: `data:${mime || 'application/octet-stream'};base64,${base64}` };
}

/* Resuelve el alcance del usuario: devuelve
     { all:true }                         -> superadmin (todas)
     { codes:[...] }                      -> lista explicita (tienda/admin)
   o { codes:[] } si no tiene acceso.     */
async function resolveScope(env, user) {
  if (!user) return { codes: [] };
  if (user.kind === 'company') {
    if (!user.companyCode) return { codes: [] };
    // revalidar acceso activo
    const u = await sbJson(env, `company_users?company_code=eq.${encodeURIComponent(user.companyCode)}&is_active=eq.true&select=company_code`);
    return { codes: (u && u.length) ? [user.companyCode] : [] };
  }
  if (user.kind === 'admin' && user.id) {
    const a = await sbJson(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role`);
    if (!a || !a.length) return { codes: [] };
    if (a[0].role === 'superadmin') return { all: true };
    const rows = await sbJson(env, 'rpc/get_admin_companies', {
      method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
    });
    return { codes: (rows || []).map(r => r.company_code) };
  }
  return { codes: [] };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido' }, 400); }

  try {
    const scope = await resolveScope(env, body.user || null);
    // sin alcance: nada que mostrar
    if (!scope.all && (!scope.codes || scope.codes.length === 0)) {
      if (body.action === 'detail') return json({ ok: false, error: 'Sin acceso a este reporte.' }, 403);
      return json({ ok: true, rows: [], total: 0, page: 1, per_page: 20 });
    }

    if (body.action === 'list') return await listReports(env, body, scope);
    if (body.action === 'detail') return await detailReport(env, body, scope);
    if (body.action === 'ticket_text') return await ticketText(env, body, scope);
    if (body.action === 'ticket_excel') return await ticketExcel(env, body, scope);
    if (body.action === 'set_attention') return await setAttention(env, body, scope);
    if (body.action === 'sync_osticket') return await syncOsticket(env, body, scope);
    if (body.action === 'resend_info') return await resendInfo(env, body, scope);
    if (body.action === 'resend_osticket') return await resendOsticket(env, body, scope);
    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}

/* Construye el segmento de filtro de company_code segun alcance. */
function scopeFilter(scope) {
  if (scope.all) return '';
  // in.(a,b,c)
  const list = scope.codes.map(c => `"${c}"`).join(',');
  return `&company_code=in.(${list})`;
}

async function listReports(env, body, scope) {
  const f = body.filters || {};
  const page = Math.max(1, parseInt(body.page, 10) || 1);
  const perPage = Math.min(100, Math.max(10, parseInt(body.per_page, 10) || 20));
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  let q = 'reports_log?select=id,company_code,zone_id,subzone_id,topic,sent_at,'
    + 'responsible,position,workers_count,attention,osticket_id,email_sent,source_kind,'
    + 'osticket_sync,attention_at,attention_comment,attention_by';
  q += scopeFilter(scope);

  // Filtros
  if (f.type && f.type !== 'ALL') q += `&topic=eq.${encodeURIComponent(f.type)}`;
  if (f.company && f.company !== 'ALL') q += `&company_code=eq.${encodeURIComponent(f.company)}`;
  if (f.zone && f.zone !== 'ALL') q += `&zone_id=eq.${encodeURIComponent(f.zone)}`;
  if (f.subzone && f.subzone !== 'ALL') q += `&subzone_id=eq.${encodeURIComponent(f.subzone)}`;
  if (f.origin === 'admin' || f.origin === 'company') q += `&source_kind=eq.${f.origin}`;
  // Concepto: reports_log no lo guarda; se resuelve a los company_code de
  // ese concepto y se filtra por ellos. Si no hay ninguno, no habra filas.
  if (f.concept && f.concept !== 'ALL') {
    const con = await sbJson(env, `concepts?name=eq.${encodeURIComponent(f.concept)}&select=id`);
    if (con && con.length) {
      const cc = await sbJson(env, `companies?concept_id=eq.${encodeURIComponent(con[0].id)}&select=company_code`);
      const list = (cc || []).map(c => `"${c.company_code}"`).join(',');
      q += list ? `&company_code=in.(${list})` : `&company_code=in.("__none__")`;
    } else {
      q += `&company_code=in.("__none__")`;
    }
  }
  if (f.date_from) q += `&sent_at=gte.${encodeURIComponent(f.date_from + 'T00:00:00')}`;
  if (f.date_to) q += `&sent_at=lte.${encodeURIComponent(f.date_to + 'T23:59:59')}`;
  if (f.attention && f.attention !== 'ALL') q += `&attention=eq.${encodeURIComponent(f.attention)}`;
  if (f.osticket === 'sent') q += `&osticket_id=not.is.null`;
  if (f.osticket === 'unsent') q += `&osticket_id=is.null`;
  // Busqueda libre: responsable o folio (id). PostgREST 'or'.
  if (f.q && f.q.trim()) {
    const term = f.q.trim();
    const idNum = term.replace(/[^0-9]/g, '');
    const ors = [`responsible.ilike.*${term}*`];
    if (idNum) ors.push(`id.eq.${idNum}`);
    q += `&or=(${ors.join(',')})`;
  }

  q += '&order=id.desc';

  // Paginacion con conteo exacto via Content-Range
  const res = await sb(env, q, { headers: { Prefer: 'count=exact', Range: `${from}-${to}`, 'Range-Unit': 'items' } });
  const rows = JSON.parse((await res.text()) || '[]');
  const cr = res.headers.get('content-range') || '';
  const total = cr.includes('/') ? parseInt(cr.split('/')[1], 10) || rows.length : rows.length;

  // Nombres de tienda (para admin/superadmin) en un solo query
  const codes = [...new Set(rows.map(r => r.company_code))];
  let nameByCode = {};
  if (codes.length) {
    const list = codes.map(c => `"${c}"`).join(',');
    const comps = await sbJson(env, `companies?company_code=in.(${list})&select=company_code,business_name`);
    (comps || []).forEach(c => { nameByCode[c.company_code] = c.business_name; });
  }

  // Nombres de los admins que cambiaron estados (para mostrar "quien"), en lote.
  const adminIds = [...new Set(rows.map(r => r.attention_by).filter(Boolean))];
  let nameByAdmin = {};
  if (adminIds.length) {
    const list = adminIds.join(',');
    const admins = await sbJson(env, `admin_users?id=in.(${list})&select=id,name`);
    (admins || []).forEach(x => { nameByAdmin[x.id] = x.name; });
  }

  const out = rows.map(r => ({
    id: r.id,
    type: r.topic,
    company_code: r.company_code,
    company_name: nameByCode[r.company_code] || null,
    sent_at: r.sent_at,
    responsible: r.responsible,
    position: r.position,
    workers_count: r.workers_count,
    attention: r.attention,
    osticket_id: r.osticket_id,
    osticket_sync: r.osticket_sync || 'na',
    attention_at: r.attention_at || null,
    attention_comment: r.attention_comment || null,
    attention_by_name: r.attention_by ? (nameByAdmin[r.attention_by] || null) : null,
    email_sent: r.email_sent,
    source_kind: r.source_kind || 'company',
  }));

  // URL base de osTicket (sin barra final) para que el front arme el enlace
  // directo al ticket en el SCP: {base}/scp/tickets.php?number={osticket_id}.
  // Se lee una sola vez por pagina (no por fila).
  let osticketUrl = '';
  try { osticketUrl = await osticketBase(env); } catch { osticketUrl = ''; }

  return json({ ok: true, rows: out, total, page, per_page: perPage, osticket_url: osticketUrl });
}

async function detailReport(env, body, scope) {
  const id = parseInt(body.report_id, 10);
  if (!id) return json({ ok: false, error: 'Falta report_id' }, 400);

  let q = `reports_log?id=eq.${id}&select=id,company_code,zone_id,subzone_id,topic,sent_at,`
    + 'responsible,position,workers_count,attention,osticket_id,email_sent,notes,source_kind,'
    + 'osticket_sync,attention_at,attention_comment,attention_by';
  q += scopeFilter(scope);
  const head = await sbJson(env, q);
  if (!head || !head.length) return json({ ok: false, error: 'Reporte no encontrado o sin acceso.' }, 404);
  const r = head[0];

  // Nombre de tienda
  const comp = await sbJson(env, `companies?company_code=eq.${encodeURIComponent(r.company_code)}&select=business_name`);
  const companyName = comp && comp[0] ? comp[0].business_name : null;

  // Nombre del admin que cambio el estado de atencion (si lo hay).
  let attentionByName = null;
  if (r.attention_by) {
    const ab = await sbJson(env, `admin_users?id=eq.${encodeURIComponent(r.attention_by)}&select=name`);
    attentionByName = (ab && ab[0]) ? ab[0].name : null;
  }

  // Lineas segun tipo. Por ahora solo marcaje tiene tabla de detalle.
  let lines = [];
  if (r.topic === 'marcaje') {
    const raw = await sbJson(env,
      `mark_report_lines?report_id=eq.${id}`
      + `&select=worker_id_number,worker_name,mark_date,time_in,time_out,cause_code,cause_other_text,marcaje_causas(label)`
      + `&order=id.asc`);
    lines = (raw || []).map(l => ({
      id_number: l.worker_id_number,
      name: l.worker_name,
      mark_date: l.mark_date,
      time_in: (l.time_in || '').slice(0, 5),
      time_out: (l.time_out || '').slice(0, 5),
      cause: l.cause_code === 'other'
        ? (l.cause_other_text || 'Otros')
        : (l.marcaje_causas && l.marcaje_causas.label) || l.cause_code,
    }));
  } else if (r.topic === 'ausencia') {
    const raw = await sbJson(env,
      `absence_report_lines?report_id=eq.${id}`
      + `&select=id,worker_id_number,worker_name,absence_code,ax_code,date_from,date_to,note,`
      + `absence_types(label),absence_report_docs(doc_name,status,enforcement)`
      + `&order=id.asc`);
    lines = (raw || []).map(l => {
      const doc = (l.absence_report_docs && l.absence_report_docs.length) ? l.absence_report_docs[0] : null;
      return {
        id_number: l.worker_id_number,
        name: l.worker_name,
        absence_code: l.absence_code,
        absence_label: (l.absence_types && l.absence_types.label) || l.absence_code,
        ax_code: l.ax_code,
        date_from: l.date_from,
        date_to: l.date_to,
        note: l.note || '',
        doc_name: doc ? doc.doc_name : null,
        doc_status: doc ? doc.status : null,        // 'adjunto' | 'pendiente' | null (no requiere)
        doc_enforcement: doc ? doc.enforcement : null,
      };
    });
  }

  return json({
    ok: true,
    osticket_url: await (async () => { try { return await osticketBase(env); } catch { return ''; } })(),
    report: {
      id: r.id, type: r.topic, company_code: r.company_code, company_name: companyName,
      zone_id: r.zone_id, subzone_id: r.subzone_id, sent_at: r.sent_at,
      responsible: r.responsible, position: r.position, workers_count: r.workers_count,
      attention: r.attention, osticket_id: r.osticket_id, email_sent: r.email_sent, notes: r.notes,
      source_kind: r.source_kind || 'company',
      osticket_sync: r.osticket_sync || 'na',
      attention_at: r.attention_at || null,
      attention_comment: r.attention_comment || null,
      attention_by_name: attentionByName,
      lines,
    },
  });
}

/* =====================================================================
   ticket_text — Regenera el CUERPO DE TEXTO del ticket (PLA) de un reporte
   ya enviado, reusando buildReportText con los datos guardados. Es la MISMA
   regla de construccion que reports.js usa al enviar; aqui se reconstruye el
   ctx desde la BD (encabezado + datos de tienda + lineas de detalle por
   tipo). Util cuando osTicket esta caido: la tienda copia/baja el texto y lo
   pega manualmente.

   Nombre de archivo (igual patron que las plantillas AX, con .txt):
     {AAAAMMDD}_{NNNN}_{ALIAS}_{TIPO}.txt
   donde AAAAMMDD = fecha de envio del reporte, NNNN = folio (id con ceros,
   minimo 4 digitos), ALIAS = company_code, TIPO = topic en mayusculas.
   Ej: 20260628_0029_BB05_EGRESO.txt
   ===================================================================== */
async function ticketText(env, body, scope) {
  const id = parseInt(body.report_id, 10);
  if (!id) return json({ ok: false, error: 'Falta report_id' }, 400);

  // Encabezado (con control de alcance).
  let q = `reports_log?id=eq.${id}&select=id,company_code,zone_id,subzone_id,topic,sent_at,`
    + 'responsible,position,workers_count,source_kind';
  q += scopeFilter(scope);
  const head = await sbJson(env, q);
  if (!head || !head.length) return json({ ok: false, error: 'Reporte no encontrado o sin acceso.' }, 404);
  const r = head[0];
  const topic = r.topic;
  const cc = r.company_code;

  // Datos de la tienda (igual que reports.js: data_area no hace falta para el
  // texto, pero si business_name/email/phone/concepto/zona/subzona).
  const comp = await sbJson(env,
    `companies?company_code=eq.${encodeURIComponent(cc)}&select=business_name,email,phone,zone_id,subzone_id,concept_id`);
  const c0 = comp && comp[0] ? comp[0] : {};
  const compBusinessName = c0.business_name || '';
  const compEmail = c0.email || '';
  const compPhone = c0.phone || '';
  const zoneId = r.zone_id != null ? r.zone_id : c0.zone_id;
  const subzoneId = r.subzone_id != null ? r.subzone_id : c0.subzone_id;
  const conceptId = c0.concept_id;

  let zonaName = '', subzonaName = '', marcaName = '';
  if (subzoneId != null) {
    const sz = await sbJson(env, `subzones?id=eq.${encodeURIComponent(subzoneId)}&select=name`);
    subzonaName = sz && sz[0] ? (sz[0].name || '') : '';
  }
  if (zoneId != null) {
    const zn = await sbJson(env, `zones?id=eq.${encodeURIComponent(zoneId)}&select=name`);
    zonaName = zn && zn[0] ? (zn[0].name || '') : '';
  }
  if (conceptId != null) {
    const cn = await sbJson(env, `concepts?id=eq.${encodeURIComponent(conceptId)}&select=name`);
    marcaName = cn && cn[0] ? (cn[0].name || '') : '';
  }
  const mallZona = subzonaName || zonaName || '';

  // Fecha/hora del reporte: se reconstruyen desde sent_at en hora Venezuela
  // (GMT-4). Si por algo no hay sent_at, cae a la fecha de hoy VE.
  const sentMs = r.sent_at ? Date.parse(r.sent_at) : Date.now();
  const car = new Date((isNaN(sentMs) ? Date.now() : sentMs) - 4 * 3600 * 1000);
  const ymd = car.toISOString().slice(0, 10);
  const hh = String(car.getUTCHours()).padStart(2, '0');
  const mi = String(car.getUTCMinutes()).padStart(2, '0');
  const fechaTxt = dmy(ymd);
  const horaTxt = `${hh}:${mi}`;

  // Etiqueta del topic para el cuerpo (misma redaccion que reports.js).
  const topicLabelMap = {
    marcaje: 'Marcaje Manual',
    ausencia: 'Período de Ausencia',
    ingreso: 'Ingreso',
    egreso: 'Egreso',
    modificacion: 'Modificación de Datos',
  };

  // --- Reconstruir los registros por tipo (misma forma que en cada submit) ---
  let registros = [];
  let topicLabel = topicLabelMap[topic] || (topic || '').toUpperCase();

  if (topic === 'marcaje') {
    const raw = await sbJson(env,
      `mark_report_lines?report_id=eq.${id}`
      + `&select=worker_id_number,worker_name,mark_date,day_type,time_in,time_out,cause_code,cause_other_text,marcaje_causas(label)`
      + `&order=id.asc`);
    registros = (raw || []).map(l => {
      const causaTxt = l.cause_code === 'other'
        ? (l.cause_other_text || 'Otros')
        : ((l.marcaje_causas && l.marcaje_causas.label) || l.cause_code);
      const campos = [
        ['Trabajador', l.worker_name],
        ['Cédula', l.worker_id_number],
        ['Fecha', dmy(l.mark_date)],
        ['Tipo de día', l.day_type === 'D' ? 'Descanso (D)' : 'Laborable (L)'],
      ];
      if (l.day_type !== 'D') {
        campos.push(['Entrada', (l.time_in || '').slice(0, 5)]);
        campos.push(['Salida', (l.time_out || '').slice(0, 5)]);
      }
      campos.push(['Causa', causaTxt]);
      return campos;
    });

  } else if (topic === 'ausencia') {
    const raw = await sbJson(env,
      `absence_report_lines?report_id=eq.${id}`
      + `&select=worker_id_number,worker_name,absence_code,ax_code,date_from,date_to,note,`
      + `absence_types(label),absence_report_docs(doc_name,status)`
      + `&order=id.asc`);
    // El topicLabel de ausencia incluye el tipo (label) si todas las lineas
    // comparten el mismo, igual que el envio lo arma por tipo de ausencia.
    const firstType = (raw && raw[0] && raw[0].absence_types && raw[0].absence_types.label) || '';
    if (firstType) topicLabel = `Período de Ausencia — ${firstType}`;
    registros = (raw || []).map(l => {
      const doc = (l.absence_report_docs && l.absence_report_docs.length) ? l.absence_report_docs[0] : null;
      const campos = [
        ['Trabajador', l.worker_name],
        ['Cédula', l.worker_id_number],
        ['Desde', dmy(l.date_from)],
        ['Hasta', dmy(l.date_to)],
        ['Justificación', l.ax_code],
      ];
      if (l.note) campos.push(['Nota', l.note]);
      if (doc) campos.push(['Documento', doc.status === 'adjunto' ? 'adjunto (ticket DOC aparte)' : 'pendiente']);
      return campos;
    });

  } else if (topic === 'egreso') {
    const raw = await sbJson(env,
      `egress_report_lines?report_id=eq.${id}`
      + `&select=worker_id_number,worker_name,report_date,real_date,has_document,doc_cause,doc_waived,`
      + `reason_code,reason_comment`
      + `&order=id.asc`);
    // Sin FK declarada: resolver labels de motivo y causa con lookups.
    const [reasonsRows, causesRows] = await Promise.all([
      sbJson(env, 'egress_reasons?select=code,label'),
      sbJson(env, 'egress_doc_causes?select=code,label'),
    ]);
    const reasonMap = {}; (reasonsRows || []).forEach(x => { reasonMap[x.code] = x.label; });
    const causeMap = {}; (causesRows || []).forEach(x => { causeMap[x.code] = x.label; });
    registros = (raw || []).map(l => {
      const adjusted = l.real_date && l.report_date && l.real_date !== l.report_date;
      const reasonLabel = reasonMap[l.reason_code] || l.reason_code || '';
      const campos = [
        ['Trabajador', l.worker_name],
        ['Cédula', l.worker_id_number],
        ['Tipo', 'Baja (B)'],
        ['Fecha de egreso', dmy(l.report_date)],
      ];
      if (adjusted) campos.push(['Fecha real de egreso', dmy(l.real_date)]);
      campos.push(['Motivo', reasonLabel]);
      if (l.reason_comment) campos.push(['Comentario', l.reason_comment]);
      if (l.has_document) {
        campos.push(['Carta de renuncia', 'adjunta (ticket DOC aparte)']);
      } else {
        const causeLabel = causeMap[l.doc_cause] || l.doc_cause || '—';
        const suf = l.doc_waived ? '' : ' — pendiente';
        campos.push(['Carta de renuncia', `${causeLabel}${suf}`]);
      }
      return campos;
    });

  } else if (topic === 'ingreso') {
    const raw = await sbJson(env,
      `ingreso_report_lines?report_id=eq.${id}`
      + `&select=worker_id_number,ced_kind,worker_name,cargo_code,birth_date,gender,marital_status,`
      + `account_number,bank_name,email,phone,address,start_date`
      + `&order=id.asc`);
    // Sin FK declarada: resolver label del cargo con lookup.
    const cargosRows = await sbJson(env, 'cargos?select=code,label');
    const cargoMap = {}; (cargosRows || []).forEach(c => { cargoMap[c.code] = c.label; });
    const maritalLbl = { S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a' };
    const phoneNat = (intl) => intl ? '0' + String(intl).replace(/^\+58/, '') : '—';
    registros = (raw || []).map(l => ([
      ['Trabajador', l.worker_name],
      ['Cedula', `${l.ced_kind || 'V'}-${l.worker_id_number}`],
      ['Tipo', 'Alta (A)'],
      ['Cargo', cargoMap[l.cargo_code] || l.cargo_code || ''],
      ['Fecha de ingreso', dmy(l.start_date)],
      ['Fecha de nacimiento', dmy(l.birth_date)],
      ['Genero', l.gender === 'M' ? 'Masculino' : (l.gender === 'F' ? 'Femenino' : (l.gender || '—'))],
      ['Estado civil', maritalLbl[l.marital_status] || l.marital_status || '—'],
      ['Cuenta', l.account_number ? `${l.account_number}${l.bank_name ? ` (${l.bank_name})` : ''}` : '—'],
      ['Correo', l.email || '—'],
      ['Telefono', phoneNat(l.phone)],
      ['Direccion', l.address || '—'],
    ]));

  } else if (topic === 'modificacion') {
    const raw = await sbJson(env,
      `modificacion_report_lines?report_id=eq.${id}`
      + `&select=worker_id_number,worker_name,changes&order=id.asc`);
    // Catalogos para resolver labels legibles de los campos cambiados.
    const [cargosRows, bancosRows] = await Promise.all([
      sbJson(env, 'cargos?select=code,label'),
      sbJson(env, 'bancos?select=code,name'),
    ]);
    const cargoMap = {}; (cargosRows || []).forEach(c => { cargoMap[c.code] = c.label; });
    const bancoMap = {}; (bancosRows || []).forEach(b => { bancoMap[b.code] = b.name; });
    const maritalLbl = { S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a' };
    const phoneNat = (intl) => intl ? '0' + String(intl).replace(/^\+58/, '') : intl;
    const cedKind = (ced) => parseInt(ced, 10) >= 80000000 ? 'E' : 'V';
    registros = (raw || []).map(l => {
      const ch = (l.changes && typeof l.changes === 'object') ? l.changes : {};
      const campos = [
        ['Trabajador', l.worker_name],
        ['Cédula', `${cedKind(l.worker_id_number)}-${l.worker_id_number}`],
        ['Tipo', 'Modificación (M)'],
      ];
      if ('first_name' in ch || 'last_names' in ch) {
        const nm = [ch.first_name, ch.second_name, ch.last_names].filter(Boolean).join(' ');
        campos.push(['Nombre', nm]);
      }
      if ('cargo' in ch) campos.push(['Cargo', cargoMap[ch.cargo] || ch.cargo]);
      if ('cuenta' in ch) campos.push(['Cuenta', `${ch.cuenta} (${bancoMap[String(ch.cuenta).slice(0, 4)] || ''})`]);
      if ('telefono' in ch) campos.push(['Telefono', phoneNat(ch.telefono)]);
      if ('correo' in ch) campos.push(['Correo', ch.correo]);
      if ('direccion' in ch) campos.push(['Direccion', ch.direccion]);
      if ('estCivil' in ch) campos.push(['Estado civil', maritalLbl[ch.estCivil] || ch.estCivil]);
      if ('sexo' in ch) campos.push(['Sexo', ch.sexo === 'M' ? 'Masculino' : (ch.sexo === 'F' ? 'Femenino' : ch.sexo)]);
      if ('fechaNac' in ch) campos.push(['Fecha de nacimiento', dmy(ch.fechaNac)]);
      if ('todoTicket' in ch) campos.push(['TodoTicket', ch.todoTicket === 'S' ? 'Si' : 'No']);
      return campos;
    });

  } else {
    return json({ ok: false, error: `Tipo de reporte no soportado: ${topic}` }, 400);
  }

  const code = reportCode(r.id);
  const text = buildReportText({
    pieceLabel: 'PLANTILLA', reportCode: code, piece: 1, totalPieces: 1,
    topicLabel,
    fecha: fechaTxt, hora: horaTxt,
    alias: cc, razon: compBusinessName, zona: mallZona, marca: marcaName,
    correoTienda: compEmail,
    responsable: r.responsible || '', cargo: r.position || '',
    telefono: compPhone, correoResp: compEmail,
    registros,
  });

  // Nombre de archivo: AAAAMMDD_NNNN_ALIAS_TIPO.txt
  const filename = `${ymd.replace(/-/g, '')}_${code}_${safeName(cc)}_${safeName(topic)}.txt`;

  return json({ ok: true, text, filename });
}

/* =====================================================================
   ticket_excel — Regenera la PLANTILLA DE EXCEL (.xlsx) que se adjunta al
   ticket PLA de un reporte ya enviado, reusando buildAxWorkbookBase64 (la
   MISMA funcion del envio). Reconstruye ctx.lines con la forma EXACTA que
   cada builder del Excel espera (distinta a los registros del texto), desde
   las tablas de detalle. Devuelve { base64, filename, mime } para que el
   front dispare la descarga del .xlsx.
   ===================================================================== */
async function ticketExcel(env, body, scope) {
  const id = parseInt(body.report_id, 10);
  if (!id) return json({ ok: false, error: 'Falta report_id' }, 400);

  // Encabezado (con control de alcance).
  let q = `reports_log?id=eq.${id}&select=id,company_code,topic,sent_at`;
  q += scopeFilter(scope);
  const head = await sbJson(env, q);
  if (!head || !head.length) return json({ ok: false, error: 'Reporte no encontrado o sin acceso.' }, 404);
  const r = head[0];
  const topic = r.topic;
  const cc = r.company_code;

  // Datos de la tienda necesarios para el Excel: data_area (Data ID de AX) y
  // business_name. El resto de columnas salen de las lineas de detalle.
  const comp = await sbJson(env,
    `companies?company_code=eq.${encodeURIComponent(cc)}&select=data_area,business_name`);
  const c0 = comp && comp[0] ? comp[0] : {};
  const compDataArea = c0.data_area || '';
  const compBusinessName = c0.business_name || '';

  // Fecha del reporte (para el nombre de archivo), en hora Venezuela.
  const sentMs = r.sent_at ? Date.parse(r.sent_at) : Date.now();
  const car = new Date((isNaN(sentMs) ? Date.now() : sentMs) - 4 * 3600 * 1000);
  const ymd = car.toISOString().slice(0, 10);
  const code = reportCode(r.id);

  // Helper: divide un nombre completo en {nombre, apellidos} (ultima palabra
  // = apellidos), igual heuristica que el envio de egreso.
  const splitName = (full) => {
    const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length > 1) return { nombre: parts.slice(0, -1).join(' '), apellidos: parts[parts.length - 1] };
    return { nombre: parts[0] || '', apellidos: '' };
  };

  // Construir ctx.lines con la forma que cada builder del Excel espera.
  let lines = [];
  let kind = topic;   // 'marcaje'|'ausencia'|'ingreso'|'egreso'|'modificacion'

  if (topic === 'marcaje') {
    const raw = await sbJson(env,
      `mark_report_lines?report_id=eq.${id}`
      + `&select=worker_id_number,mark_date,day_type,time_in,time_out,cause_code,cause_other_text,marcaje_causas(label)`
      + `&order=id.asc`);
    lines = (raw || []).map(l => ({
      id_number: l.worker_id_number,
      date: l.mark_date,
      time_in: (l.time_in || '').slice(0, 5),
      time_out: (l.time_out || '').slice(0, 5),
      tipo: l.day_type === 'D' ? 'D' : 'L',
      causa_label: l.cause_code === 'other'
        ? (l.cause_other_text || 'Otros')
        : ((l.marcaje_causas && l.marcaje_causas.label) || l.cause_code),
    }));

  } else if (topic === 'ausencia') {
    const raw = await sbJson(env,
      `absence_report_lines?report_id=eq.${id}`
      + `&select=worker_id_number,ax_code,date_from,date_to&order=id.asc`);
    lines = (raw || []).map(l => ({
      id_number: l.worker_id_number,
      date_from: l.date_from,
      date_to: l.date_to,
      ax_code: l.ax_code,
    }));

  } else if (topic === 'ingreso') {
    const raw = await sbJson(env,
      `ingreso_report_lines?report_id=eq.${id}`
      + `&select=worker_id_number,first_name,second_name,last_names,cargo_code,birth_date,gender,`
      + `marital_status,account_number,email,phone,address,start_date&order=id.asc`);
    // El Excel de ingreso usa el ax_code del cargo; resolver con lookup.
    const cargosRows = await sbJson(env, 'cargos?select=code,ax_code');
    const axByCode = {}; (cargosRows || []).forEach(c => { axByCode[c.code] = c.ax_code || c.code; });
    lines = (raw || []).map(l => ({
      id_number: l.worker_id_number,
      nombre: l.first_name || '',
      nombre2: l.second_name || '',
      apellidos: l.last_names || '',
      correo: l.email || '',
      fechaIni: l.start_date || '',
      cargo: axByCode[l.cargo_code] || l.cargo_code || '',
      direccion: l.address || '',
      fechaNac: l.birth_date || '',
      estCivil: l.marital_status || '',
      telefono: l.phone || '',
      genero: l.gender || '',
      cuenta: l.account_number || '',
    }));

  } else if (topic === 'egreso') {
    const raw = await sbJson(env,
      `egress_report_lines?report_id=eq.${id}`
      + `&select=worker_id_number,worker_name,report_date&order=id.asc`);
    lines = (raw || []).map(l => {
      const { nombre, apellidos } = splitName(l.worker_name);
      return {
        id_number: l.worker_id_number,
        nombre, apellidos,
        fechaFin: l.report_date,
      };
    });

  } else if (topic === 'modificacion') {
    const raw = await sbJson(env,
      `modificacion_report_lines?report_id=eq.${id}`
      + `&select=worker_id_number,worker_name,changes&order=id.asc`);
    // El Excel de modificacion lleva SIEMPRE cedula + nombre dividido; los
    // campos cambiados en su columna AX, los no cambiados VACIOS. El cargo va
    // como ax_code; resolver con lookup. El nombre dividido sale de changes
    // (si se modifico) o del worker_name guardado (ultima palabra = apellidos).
    const cargosRows = await sbJson(env, 'cargos?select=code,ax_code');
    const axByCode = {}; (cargosRows || []).forEach(c => { axByCode[c.code] = c.ax_code || c.code; });
    lines = (raw || []).map(l => {
      const ch = (l.changes && typeof l.changes === 'object') ? l.changes : {};
      let nombre, nombre2, apellidos;
      if ('first_name' in ch || 'last_names' in ch) {
        nombre = (ch.first_name || '').toUpperCase();
        nombre2 = (ch.second_name || '').toUpperCase();
        apellidos = (ch.last_names || '').toUpperCase();
      } else {
        const s = splitName(l.worker_name);
        nombre = s.nombre.toUpperCase(); nombre2 = ''; apellidos = s.apellidos.toUpperCase();
      }
      return {
        id_number: l.worker_id_number,
        nombre, nombre2, apellidos,
        correo: ('correo' in ch) ? ch.correo : '',
        fechaIni: '',
        fechaFin: '',
        cargo: ('cargo' in ch) ? (axByCode[ch.cargo] || ch.cargo) : '',
        direccion: ('direccion' in ch) ? ch.direccion : '',
        fechaNac: ('fechaNac' in ch) ? ch.fechaNac : '',
        estCivil: ('estCivil' in ch) ? ch.estCivil : '',
        telefono: ('telefono' in ch) ? ch.telefono : '',
        genero: ('sexo' in ch) ? ch.sexo : '',
        cuenta: ('cuenta' in ch) ? ch.cuenta : '',
        todoTicket: ('todoTicket' in ch) ? ch.todoTicket : '',
      };
    });

  } else {
    return json({ ok: false, error: `Tipo de reporte no soportado: ${topic}` }, 400);
  }

  const axCtx = {
    companyDataArea: compDataArea,
    companyName: compBusinessName,
    companyAlias: cc,
    todayYmd: ymd,         // la fecha del reporte -> nombre de archivo
    reportCode: code,
    lines,
  };
  const wb = buildAxWorkbookBase64(kind, axCtx);
  if (!wb) return json({ ok: false, error: 'No se pudo generar la plantilla de Excel.' }, 500);

  return json({
    ok: true,
    base64: wb.base64,
    filename: wb.filename,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/* =====================================================================
   set_attention — Cambia el estado de atencion de uno o varios reportes.
   SOLO admin/superadmin (NO editor_personal, NO tienda). El admin solo
   puede tocar reportes dentro de su alcance (resolveScope ya lo limita;
   ademas se filtra el UPDATE por company_code del alcance).

   Estados (identicos a osTicket): open | attended | resolved | closed.
   Es reversible (se puede volver a cualquier estado). Registra quien y
   cuando, y un comentario opcional.

   INTEGRACION OSTICKET (pendiente): por ahora el cambio es solo INTERNO.
   Cuando osTicket este conectado, aqui se empujara el estado al ticket via
   API y se actualizara osticket_sync (synced/failed). Ver el bloque marcado
   con  >>> OSTICKET <<<  mas abajo. Mientras tanto, osticket_sync se deja en
   'pending' si el reporte tiene osticket_id (hay ticket que sincronizar mas
   tarde) o 'na' si no tiene ticket (no hay nada que sincronizar).

   Body: { action:'set_attention', user, report_ids:[...], status,
           comment?, sync_osticket? }
   ===================================================================== */

// Mapa de nuestro estado -> id de estado en osTicket (para la integracion
// futura). open=Abierto(1), attended=Atendido(6), resolved=Resuelto(2),
// closed=Cerrado(3).
const OSTICKET_STATE_ID = { open: 1, attended: 6, resolved: 2, closed: 3 };
const VALID_ATTENTION = ['open', 'attended', 'resolved', 'closed'];

async function setAttention(env, body, scope) {
  // 1) Autorizacion: SOLO admin/superadmin reales. El editor_personal tiene
  //    user.kind='admin' pero role='editor_personal' -> se rechaza. La tienda
  //    (kind='company') tampoco puede.
  const user = body.user || {};
  if (user.kind !== 'admin' || !user.id) {
    return json({ ok: false, error: 'Solo un administrador puede cambiar el estado de atencion.' }, 403);
  }
  const a = await sbJson(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role,name`);
  if (!a || !a.length) return json({ ok: false, error: 'Administrador no valido.' }, 403);
  const role = a[0].role;
  if (role !== 'admin' && role !== 'superadmin') {
    return json({ ok: false, error: 'Tu rol no permite cambiar el estado de atencion.' }, 403);
  }

  // 2) Validar entrada.
  const status = String(body.status || '').trim();
  if (!VALID_ATTENTION.includes(status)) {
    return json({ ok: false, error: 'Estado de atencion invalido.' }, 400);
  }
  const ids = Array.isArray(body.report_ids) ? body.report_ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
  if (!ids.length) return json({ ok: false, error: 'No se indicaron reportes.' }, 400);
  const comment = body.comment != null ? String(body.comment).trim().slice(0, 300) : null;

  // 3) Filtrar a los reportes que existen Y estan en el alcance del usuario
  //    (defensa extra ademas de scopeFilter). Solo se actualizan esos.
  const idList = ids.join(',');
  let q = `reports_log?id=in.(${idList})&select=id,company_code,osticket_id`;
  q += scopeFilter(scope);
  const allowed = await sbJson(env, q) || [];
  const allowedIds = allowed.map(r => r.id);
  if (!allowedIds.length) {
    return json({ ok: false, error: 'Ninguno de los reportes esta en tu alcance.' }, 403);
  }

  // 4) Estado de sincronizacion con osTicket. Si el reporte tiene tickets
  //    (osticket_id no nulo) se empuja el estado a osTicket; si no, queda
  //    'na'. El cambio INTERNO siempre persiste primero: si osTicket falla,
  //    se marca 'failed' con el error, pero el estado de atencion ya quedo
  //    guardado (no se revierte).
  const nowIso = new Date().toISOString();
  const withTicket = allowed.filter(r => r.osticket_id);
  const withoutTicket = allowed.filter(r => !r.osticket_id);

  // Patch comun de auditoria + estado.
  const basePatch = {
    attention: status,
    attention_comment: comment,
    attention_by: user.id,
    attention_at: nowIso,
  };

  // 4a) Reportes SIN ticket -> osticket_sync 'na' (no hay nada que empujar).
  if (withoutTicket.length) {
    const list = withoutTicket.map(r => r.id).join(',');
    await sb(env, `reports_log?id=in.(${list})`, {
      method: 'PATCH',
      body: JSON.stringify({ ...basePatch, osticket_sync: 'na', osticket_sync_error: null }),
    });
  }

  // 4b) Reportes CON ticket -> primero guardar el estado interno (pending),
  //     luego empujar a osTicket y marcar synced/failed segun resultado.
  let synced = 0, failedSync = 0;
  if (withTicket.length) {
    const list = withTicket.map(r => r.id).join(',');
    await sb(env, `reports_log?id=in.(${list})`, {
      method: 'PATCH',
      body: JSON.stringify({ ...basePatch, osticket_sync: 'pending', osticket_sync_error: null }),
    });

    let base = '';
    try { base = await osticketBase(env); } catch { base = ''; }
    const res = await pushStatusToOsticket(env, base, withTicket, status, comment, nowIso);
    synced = res.synced; failedSync = res.failed;
  }

  return json({
    ok: true,
    updated: allowedIds.length,
    skipped: ids.length - allowedIds.length,
    status,
    // auditoria del cambio (para que el front la muestre sin recargar)
    attention_at: nowIso,
    attention_by_name: a[0].name || null,
    attention_comment: comment,
    // resumen de sincronizacion con osTicket
    sync: {
      with_ticket: withTicket.length,
      without_ticket: withoutTicket.length,
      synced,
      failed: failedSync,
    },
  });
}

/* =====================================================================
   pushStatusToOsticket — empuja a osTicket el estado de un conjunto de
   reportes (cada uno con su osticket_id no nulo) y marca synced/failed en
   reports_log. Reutilizado por set_attention y por sync_osticket.
     - rows: filas con al menos { id, attention }. Si se pasa forcedStatus,
       se usa ese estado para todos; si no, se usa el attention de cada fila.
     - Devuelve { synced, failed }.
   ===================================================================== */
async function pushStatusToOsticket(env, base, rows, forcedStatus, comment, nowIso) {
  let synced = 0, failed = 0;
  for (const r of rows) {
    const status = forcedStatus || r.attention || 'open';
    const statusId = OSTICKET_STATE_ID[status];
    const code = reportCode(r.id);
    try {
      if (!base) throw new Error('osticket_url no configurado');
      if (!statusId) throw new Error('estado sin mapeo osTicket: ' + status);
      const res = await osticketSetReportStatus(env, base, code, statusId, comment);
      if (res && res.ok) {
        synced++;
        await sb(env, `reports_log?id=eq.${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_sync: 'synced', osticket_sync_at: nowIso, osticket_sync_error: null }),
        });
      } else {
        failed++;
        const detail = res && res.results
          ? res.results.filter(x => !x.ok).map(x => `${x.number || x.ticket_id}: ${x.error || 'error'}`).join(' | ')
          : 'sincronizacion parcial';
        await sb(env, `reports_log?id=eq.${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_sync: 'failed', osticket_sync_error: detail.slice(0, 300) }),
        });
      }
    } catch (e) {
      failed++;
      await sb(env, `reports_log?id=eq.${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ osticket_sync: 'failed', osticket_sync_error: String(e.message || e).slice(0, 300) }),
      });
    }
  }
  return { synced, failed };
}

/* =====================================================================
   sync_osticket — (Re)sincroniza con osTicket el ESTADO ACTUAL de atencion
   de uno o varios reportes, sin cambiar el estado interno. Sirve para:
     - reportes que fallaron la sincronizacion (osticket_sync='failed'),
     - reportes con ticket creados ANTES de existir la integracion
       (osticket_sync 'na'/'pending') cuyo ticket en osTicket no refleja el
       estado de atencion actual.
   SOLO admin/superadmin, y solo dentro de su alcance.

   Body:
     { action:'sync_osticket', user, report_ids:[...] }   -> esos reportes
     { action:'sync_osticket', user, mode:'pending' }      -> todos los del
         alcance con ticket y osticket_sync IN ('pending','failed').
   ===================================================================== */
async function syncOsticket(env, body, scope) {
  const user = body.user || {};
  if (user.kind !== 'admin' || !user.id) {
    return json({ ok: false, error: 'Solo un administrador puede sincronizar.' }, 403);
  }
  const a = await sbJson(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role`);
  if (!a || !a.length || (a[0].role !== 'admin' && a[0].role !== 'superadmin')) {
    return json({ ok: false, error: 'Tu rol no permite sincronizar.' }, 403);
  }

  const mode = String(body.mode || '').trim();
  let rows = [];

  if (mode === 'pending') {
    // Todos los del alcance con ticket y sync pendiente o fallido.
    let q = 'reports_log?select=id,attention,osticket_id,osticket_sync'
      + '&osticket_id=not.is.null&osticket_sync=in.(pending,failed)';
    q += scopeFilter(scope);
    q += '&order=id.desc&limit=500';
    rows = (await sbJson(env, q)) || [];
  } else {
    const ids = Array.isArray(body.report_ids) ? body.report_ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
    if (!ids.length) return json({ ok: false, error: 'No se indicaron reportes.' }, 400);
    let q = `reports_log?id=in.(${ids.join(',')})&select=id,attention,osticket_id,osticket_sync`;
    q += scopeFilter(scope);
    rows = (await sbJson(env, q)) || [];
  }

  // Solo los que tienen ticket (los demas no hay nada que empujar).
  const withTicket = rows.filter(r => r.osticket_id);
  if (!withTicket.length) {
    return json({ ok: true, synced: 0, failed: 0, total: 0, note: 'No hay reportes con ticket para sincronizar.' });
  }

  const nowIso = new Date().toISOString();
  let base = '';
  try { base = await osticketBase(env); } catch { base = ''; }
  // Empuja el estado ACTUAL de cada reporte (forcedStatus=null -> usa r.attention).
  const res = await pushStatusToOsticket(env, base, withTicket, null, 'Sincronizacion manual desde el Portal', nowIso);

  return json({
    ok: res.failed === 0,
    total: withTicket.length,
    synced: res.synced,
    failed: res.failed,
  });
}

/* =====================================================================
   REENVIO / GENERACION DE TICKETS (opcion D)
   Para reportes que NO tienen ticket (osticket_id nulo): permite generar
   los tickets en osTicket re-adjuntando los documentos (que no se guardan
   en BD). Dos pasos:
     - resend_info: dice que documentos pide cada tipo (slots por trabajador)
       y datos del reporte, para que el front arme el modal.
     - resend_osticket: recibe los archivos re-adjuntados y crea PLA + DOCs
       igual que el envio original, registra gc_report_link y actualiza
       reports_log (osticket_id + email_sent). SOLO admin/superadmin.
   ===================================================================== */

// Carga el contexto comun de un reporte para (re)generar sus tickets:
// encabezado + datos de tienda + nombres de zona/subzona/marca + fecha/hora
// de envio. Devuelve null si no existe o esta fuera de alcance.
async function loadReportContext(env, id, scope) {
  let q = `reports_log?id=eq.${id}&select=id,company_code,zone_id,subzone_id,topic,sent_at,`
    + 'responsible,position,osticket_id';
  q += scopeFilter(scope);
  const head = await sbJson(env, q);
  if (!head || !head.length) return null;
  const r = head[0];
  const cc = r.company_code;

  const comp = await sbJson(env,
    `companies?company_code=eq.${encodeURIComponent(cc)}&select=data_area,business_name,email,phone,zone_id,subzone_id,concept_id`);
  const c0 = comp && comp[0] ? comp[0] : {};
  const zoneId = r.zone_id != null ? r.zone_id : c0.zone_id;
  const subzoneId = r.subzone_id != null ? r.subzone_id : c0.subzone_id;

  let zonaName = '', subzonaName = '', marcaName = '';
  if (subzoneId != null) {
    const sz = await sbJson(env, `subzones?id=eq.${encodeURIComponent(subzoneId)}&select=name`);
    subzonaName = sz && sz[0] ? (sz[0].name || '') : '';
  }
  if (zoneId != null) {
    const zn = await sbJson(env, `zones?id=eq.${encodeURIComponent(zoneId)}&select=name`);
    zonaName = zn && zn[0] ? (zn[0].name || '') : '';
  }
  if (c0.concept_id != null) {
    const cn = await sbJson(env, `concepts?id=eq.${encodeURIComponent(c0.concept_id)}&select=name`);
    marcaName = cn && cn[0] ? (cn[0].name || '') : '';
  }

  const sentMs = r.sent_at ? Date.parse(r.sent_at) : Date.now();
  const car = new Date((isNaN(sentMs) ? Date.now() : sentMs) - 4 * 3600 * 1000);
  const ymd = car.toISOString().slice(0, 10);
  const hh = String(car.getUTCHours()).padStart(2, '0');
  const mi = String(car.getUTCMinutes()).padStart(2, '0');

  return {
    report: r,
    cc,
    dataArea: c0.data_area || '',
    businessName: c0.business_name || '',
    email: c0.email || '',
    phone: c0.phone || '',
    mallZona: subzonaName || zonaName || '',
    marca: marcaName,
    ymd,
    fecha: dmy(ymd),
    hora: `${hh}:${mi}`,
    code: reportCode(r.id),
  };
}

// Etiqueta del topic (igual redaccion que reports.js / ticket_text).
const TOPIC_LABEL = {
  marcaje: 'Marcaje Manual',
  ausencia: 'Período de Ausencia',
  ingreso: 'Ingreso',
  egreso: 'Egreso',
  modificacion: 'Modificación de Datos',
};

/* resend_info — Describe que necesita el reenvio de un reporte sin ticket.
   Devuelve, ademas de datos basicos, la lista de "slots" de documentos que
   la tienda debe re-adjuntar (vacia para marcaje/modificacion). Cada slot:
   { key, worker_id, worker_name, doc_name, required_doc_id?, required }.
   key identifica el slot para emparejar el archivo en resend_osticket. */
async function resendInfo(env, body, scope) {
  const id = parseInt(body.report_id, 10);
  if (!id) return json({ ok: false, error: 'Falta report_id' }, 400);
  const ctx = await loadReportContext(env, id, scope);
  if (!ctx) return json({ ok: false, error: 'Reporte no encontrado o sin acceso.' }, 404);
  if (ctx.report.osticket_id) {
    return json({ ok: false, error: 'Este reporte ya tiene ticket en osTicket.' }, 409);
  }
  const topic = ctx.report.topic;
  const slots = [];

  if (topic === 'ausencia') {
    // Un slot por linea que tenga documento esperado (status adjunto/pendiente).
    const lines = await sbJson(env,
      `absence_report_lines?report_id=eq.${id}`
      + `&select=id,worker_id_number,worker_name,absence_report_docs(doc_name,enforcement,status)&order=id.asc`);
    (lines || []).forEach(l => {
      const d = (l.absence_report_docs && l.absence_report_docs.length) ? l.absence_report_docs[0] : null;
      if (d) {
        slots.push({
          key: `L${l.id}`,
          worker_id: l.worker_id_number,
          worker_name: l.worker_name,
          doc_name: d.doc_name,
          required: (d.enforcement === 'block'),
        });
      }
    });
  } else if (topic === 'egreso') {
    // Un slot por linea con has_document (carta de renuncia adjunta originalmente).
    const lines = await sbJson(env,
      `egress_report_lines?report_id=eq.${id}`
      + `&select=id,worker_id_number,worker_name,has_document&order=id.asc`);
    (lines || []).forEach(l => {
      if (l.has_document) {
        slots.push({
          key: `L${l.id}`,
          worker_id: l.worker_id_number,
          worker_name: l.worker_name,
          doc_name: 'Carta de renuncia',
          required: false,
        });
      }
    });
  } else if (topic === 'ingreso') {
    // Un slot por cada recaudo (ingreso_report_docs) de cada linea.
    const lines = await sbJson(env,
      `ingreso_report_lines?report_id=eq.${id}`
      + `&select=id,worker_id_number,worker_name,ingreso_report_docs(id,required_doc_id,doc_name,enforcement,status)&order=id.asc`);
    (lines || []).forEach(l => {
      (l.ingreso_report_docs || []).forEach(d => {
        slots.push({
          key: `D${d.id}`,
          worker_id: l.worker_id_number,
          worker_name: l.worker_name,
          doc_name: d.doc_name,
          required_doc_id: d.required_doc_id,
          required: (d.enforcement === 'block'),
        });
      });
    });
  }
  // marcaje / modificacion -> sin slots (solo PLA).

  return json({
    ok: true,
    report_id: id,
    topic,
    topic_label: TOPIC_LABEL[topic] || topic,
    company_code: ctx.cc,
    company_name: ctx.businessName,
    needs_docs: slots.length > 0,
    slots,
  });
}

/* resend_osticket — Genera los tickets de un reporte sin ticket. Reconstruye
   el contexto desde la BD y crea PLA + DOCs (con los archivos re-adjuntados
   que vengan en body.files). SOLO admin/superadmin.

   body.files: array de { key, file_name, file_b64, file_type } (los slots
   que la tienda re-adjunto; pueden faltar los no obligatorios).
   ===================================================================== */
async function resendOsticket(env, body, scope) {
  const user = body.user || {};
  if (user.kind !== 'admin' || !user.id) {
    return json({ ok: false, error: 'Solo un administrador puede reenviar a osTicket.' }, 403);
  }
  const a = await sbJson(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role`);
  if (!a || !a.length || (a[0].role !== 'admin' && a[0].role !== 'superadmin')) {
    return json({ ok: false, error: 'Tu rol no permite reenviar a osTicket.' }, 403);
  }

  const id = parseInt(body.report_id, 10);
  if (!id) return json({ ok: false, error: 'Falta report_id' }, 400);
  const ctx = await loadReportContext(env, id, scope);
  if (!ctx) return json({ ok: false, error: 'Reporte no encontrado o sin acceso.' }, 404);
  if (ctx.report.osticket_id) {
    return json({ ok: false, error: 'Este reporte ya tiene ticket en osTicket.' }, 409);
  }

  const base = await osticketBase(env);
  if (!base || !env.osticket_api_key) {
    return json({ ok: false, error: 'osTicket no esta configurado (url o api key).' }, 500);
  }

  // Archivos re-adjuntados, indexados por key del slot.
  const filesByKey = {};
  (Array.isArray(body.files) ? body.files : []).forEach(f => {
    if (f && f.key && f.file_b64) {
      filesByKey[f.key] = {
        name: String(f.file_name || 'documento').trim(),
        b64: String(f.file_b64),
        type: String(f.file_type || 'application/octet-stream'),
      };
    }
  });

  const topic = ctx.report.topic;
  const code = ctx.code;
  const fromEmail = ctx.email || 'portal-nomina@grupocanaima.com';
  const fromName = `${ctx.cc} - ${ctx.businessName || ctx.cc}`;
  const topicSettingKey = {
    marcaje: 'osticket_topic_marcaje', ausencia: 'osticket_topic_ausencia',
    ingreso: 'osticket_topic_ingreso', egreso: 'osticket_topic_egreso',
    modificacion: 'osticket_topic_modificacion',
  }[topic];
  const topicDefault = { marcaje: 19, ausencia: 20, ingreso: 31, egreso: 33, modificacion: 32 }[topic];
  const topicId = parseInt(await getSetting(env, topicSettingKey, String(topicDefault)), 10) || topicDefault;

  // Construir registros del PLA + lista de DOCs a crear, segun el tipo.
  // Cada DOC: { ced, worker_name, doc_label, file:{name,b64,type}, slotKey }.
  let plaRegistros = [];
  let plaTopicLabel = TOPIC_LABEL[topic] || topic;
  const docTickets = [];
  let axKind = topic, axLines = [];

  if (topic === 'marcaje') {
    const raw = await sbJson(env,
      `mark_report_lines?report_id=eq.${id}`
      + `&select=worker_id_number,worker_name,mark_date,day_type,time_in,time_out,cause_code,cause_other_text,marcaje_causas(label)&order=id.asc`);
    plaRegistros = (raw || []).map(l => {
      const causa = l.cause_code === 'other' ? (l.cause_other_text || 'Otros')
        : ((l.marcaje_causas && l.marcaje_causas.label) || l.cause_code);
      const campos = [
        ['Trabajador', l.worker_name], ['Cédula', l.worker_id_number],
        ['Fecha', dmy(l.mark_date)],
        ['Tipo de día', l.day_type === 'D' ? 'Descanso (D)' : 'Laborable (L)'],
      ];
      if (l.day_type !== 'D') { campos.push(['Entrada', (l.time_in || '').slice(0, 5)]); campos.push(['Salida', (l.time_out || '').slice(0, 5)]); }
      campos.push(['Causa', causa]);
      return campos;
    });
    axLines = (raw || []).map(l => ({
      id_number: l.worker_id_number, date: l.mark_date,
      time_in: (l.time_in || '').slice(0, 5), time_out: (l.time_out || '').slice(0, 5),
      tipo: l.day_type === 'D' ? 'D' : 'L',
      causa_label: l.cause_code === 'other' ? (l.cause_other_text || 'Otros') : ((l.marcaje_causas && l.marcaje_causas.label) || l.cause_code),
    }));

  } else if (topic === 'ausencia') {
    const raw = await sbJson(env,
      `absence_report_lines?report_id=eq.${id}`
      + `&select=id,worker_id_number,worker_name,ax_code,date_from,date_to,note,absence_types(label),absence_report_docs(doc_name)&order=id.asc`);
    const firstType = (raw && raw[0] && raw[0].absence_types && raw[0].absence_types.label) || '';
    if (firstType) plaTopicLabel = `Período de Ausencia — ${firstType}`;
    plaRegistros = (raw || []).map(l => {
      const hasDoc = (l.absence_report_docs && l.absence_report_docs.length);
      const campos = [
        ['Trabajador', l.worker_name], ['Cédula', l.worker_id_number],
        ['Desde', dmy(l.date_from)], ['Hasta', dmy(l.date_to)],
        ['Justificación', l.ax_code],
      ];
      if (l.note) campos.push(['Nota', l.note]);
      if (hasDoc) {
        const f = filesByKey[`L${l.id}`];
        campos.push(['Documento', f ? 'adjunto (ticket DOC aparte)' : 'pendiente']);
      }
      return campos;
    });
    axLines = (raw || []).map(l => ({
      id_number: l.worker_id_number, date_from: l.date_from, date_to: l.date_to, ax_code: l.ax_code,
    }));
    // DOC por linea con documento y archivo re-adjuntado.
    (raw || []).forEach(l => {
      const hasDoc = (l.absence_report_docs && l.absence_report_docs.length);
      const f = filesByKey[`L${l.id}`];
      if (hasDoc && f) {
        const periodo = l.date_from === l.date_to ? dmy(l.date_from) : `${dmy(l.date_from)} a ${dmy(l.date_to)}`;
        docTickets.push({
          ced: l.worker_id_number, worker_name: l.worker_name,
          file: f, subjectExtra: l.worker_id_number,
          registros: [[['Trabajador', l.worker_name], ['Cédula', l.worker_id_number], ['Período', periodo], ['Justificación', l.ax_code]]],
        });
      }
    });

  } else if (topic === 'egreso') {
    const raw = await sbJson(env,
      `egress_report_lines?report_id=eq.${id}`
      + `&select=id,worker_id_number,worker_name,report_date,real_date,has_document,doc_cause,doc_waived,reason_code,reason_comment&order=id.asc`);
    const [reasonsRows, causesRows] = await Promise.all([
      sbJson(env, 'egress_reasons?select=code,label'),
      sbJson(env, 'egress_doc_causes?select=code,label'),
    ]);
    const reasonMap = {}; (reasonsRows || []).forEach(x => { reasonMap[x.code] = x.label; });
    const causeMap = {}; (causesRows || []).forEach(x => { causeMap[x.code] = x.label; });
    plaRegistros = (raw || []).map(l => {
      const adjusted = l.real_date && l.report_date && l.real_date !== l.report_date;
      const campos = [
        ['Trabajador', l.worker_name], ['Cédula', l.worker_id_number],
        ['Tipo', 'Baja (B)'], ['Fecha de egreso', dmy(l.report_date)],
      ];
      if (adjusted) campos.push(['Fecha real de egreso', dmy(l.real_date)]);
      campos.push(['Motivo', reasonMap[l.reason_code] || l.reason_code || '']);
      if (l.reason_comment) campos.push(['Comentario', l.reason_comment]);
      if (l.has_document) {
        const f = filesByKey[`L${l.id}`];
        campos.push(['Carta de renuncia', f ? 'adjunta (ticket DOC aparte)' : 'pendiente']);
      } else {
        const suf = l.doc_waived ? '' : ' — pendiente';
        campos.push(['Carta de renuncia', `${causeMap[l.doc_cause] || l.doc_cause || '—'}${suf}`]);
      }
      return campos;
    });
    axLines = (raw || []).map(l => {
      const parts = String(l.worker_name).trim().split(/\s+/);
      const apellidos = parts.length > 1 ? parts[parts.length - 1] : '';
      const nombre = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0];
      return { id_number: l.worker_id_number, nombre, apellidos, fechaFin: l.report_date };
    });
    (raw || []).forEach(l => {
      const f = filesByKey[`L${l.id}`];
      if (l.has_document && f) {
        docTickets.push({
          ced: l.worker_id_number, worker_name: l.worker_name, file: f, subjectExtra: l.worker_id_number,
          registros: [[['Trabajador', l.worker_name], ['Cédula', l.worker_id_number], ['Tipo', 'Baja (B)'], ['Fecha de egreso', dmy(l.report_date)], ['Documento', 'Carta de renuncia']]],
        });
      }
    });

  } else if (topic === 'ingreso') {
    const raw = await sbJson(env,
      `ingreso_report_lines?report_id=eq.${id}`
      + `&select=id,worker_id_number,ced_kind,worker_name,first_name,second_name,last_names,cargo_code,birth_date,gender,marital_status,account_number,bank_name,email,phone,address,start_date,ingreso_report_docs(id,doc_name)&order=id.asc`);
    const cargosRows = await sbJson(env, 'cargos?select=code,label,ax_code');
    const cargoLbl = {}; const cargoAx = {};
    (cargosRows || []).forEach(c => { cargoLbl[c.code] = c.label; cargoAx[c.code] = c.ax_code || c.code; });
    const maritalLbl = { S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a' };
    const phoneNat = (intl) => intl ? '0' + String(intl).replace(/^\+58/, '') : '—';
    plaRegistros = (raw || []).map(l => ([
      ['Trabajador', l.worker_name], ['Cedula', `${l.ced_kind || 'V'}-${l.worker_id_number}`],
      ['Tipo', 'Alta (A)'], ['Cargo', cargoLbl[l.cargo_code] || l.cargo_code || ''],
      ['Fecha de ingreso', dmy(l.start_date)], ['Fecha de nacimiento', dmy(l.birth_date)],
      ['Genero', l.gender === 'M' ? 'Masculino' : (l.gender === 'F' ? 'Femenino' : (l.gender || '—'))],
      ['Estado civil', maritalLbl[l.marital_status] || l.marital_status || '—'],
      ['Cuenta', l.account_number ? `${l.account_number}${l.bank_name ? ` (${l.bank_name})` : ''}` : '—'],
      ['Correo', l.email || '—'], ['Telefono', phoneNat(l.phone)], ['Direccion', l.address || '—'],
    ]));
    axLines = (raw || []).map(l => ({
      id_number: l.worker_id_number, nombre: l.first_name || '', nombre2: l.second_name || '',
      apellidos: l.last_names || '', correo: l.email || '', fechaIni: l.start_date || '',
      cargo: cargoAx[l.cargo_code] || l.cargo_code || '', direccion: l.address || '',
      fechaNac: l.birth_date || '', estCivil: l.marital_status || '', telefono: l.phone || '',
      genero: l.gender || '', cuenta: l.account_number || '',
    }));
    // DOC por cada recaudo con archivo re-adjuntado.
    (raw || []).forEach(l => {
      (l.ingreso_report_docs || []).forEach(d => {
        const f = filesByKey[`D${d.id}`];
        if (f) {
          docTickets.push({
            ced: l.worker_id_number, worker_name: l.worker_name, file: f,
            subjectExtra: `${l.worker_id_number} ${d.doc_name}`, topicLabelDoc: `Ingreso — ${d.doc_name}`,
            registros: [[['Trabajador', l.worker_name], ['Cédula', `${l.ced_kind || 'V'}-${l.worker_id_number}`], ['Tipo', 'Alta (A)'], ['Recaudo', d.doc_name]]],
          });
        }
      });
    });

  } else if (topic === 'modificacion') {
    const raw = await sbJson(env,
      `modificacion_report_lines?report_id=eq.${id}&select=worker_id_number,worker_name,changes&order=id.asc`);
    const [cargosRows, bancosRows] = await Promise.all([
      sbJson(env, 'cargos?select=code,label,ax_code'),
      sbJson(env, 'bancos?select=code,name'),
    ]);
    const cargoLbl = {}; const cargoAx = {};
    (cargosRows || []).forEach(c => { cargoLbl[c.code] = c.label; cargoAx[c.code] = c.ax_code || c.code; });
    const bancoMap = {}; (bancosRows || []).forEach(b => { bancoMap[b.code] = b.name; });
    const maritalLbl = { S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a' };
    const phoneNat = (intl) => intl ? '0' + String(intl).replace(/^\+58/, '') : intl;
    const cedKind = (ced) => parseInt(ced, 10) >= 80000000 ? 'E' : 'V';
    const splitName = (full) => {
      const parts = String(full || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
      if (parts.length > 1) return { f: parts.slice(0, -1).join(' '), s: '', l: parts[parts.length - 1] };
      return { f: parts[0] || '', s: '', l: '' };
    };
    plaTopicLabel = 'Modificación de Datos';
    plaRegistros = (raw || []).map(l => {
      const ch = (l.changes && typeof l.changes === 'object') ? l.changes : {};
      const campos = [
        ['Trabajador', l.worker_name], ['Cédula', `${cedKind(l.worker_id_number)}-${l.worker_id_number}`],
        ['Tipo', 'Modificación (M)'],
      ];
      if ('first_name' in ch || 'last_names' in ch) campos.push(['Nombre', [ch.first_name, ch.second_name, ch.last_names].filter(Boolean).join(' ')]);
      if ('cargo' in ch) campos.push(['Cargo', cargoLbl[ch.cargo] || ch.cargo]);
      if ('cuenta' in ch) campos.push(['Cuenta', `${ch.cuenta} (${bancoMap[String(ch.cuenta).slice(0, 4)] || ''})`]);
      if ('telefono' in ch) campos.push(['Telefono', phoneNat(ch.telefono)]);
      if ('correo' in ch) campos.push(['Correo', ch.correo]);
      if ('direccion' in ch) campos.push(['Direccion', ch.direccion]);
      if ('estCivil' in ch) campos.push(['Estado civil', maritalLbl[ch.estCivil] || ch.estCivil]);
      if ('sexo' in ch) campos.push(['Sexo', ch.sexo === 'M' ? 'Masculino' : (ch.sexo === 'F' ? 'Femenino' : ch.sexo)]);
      if ('fechaNac' in ch) campos.push(['Fecha de nacimiento', dmy(ch.fechaNac)]);
      if ('todoTicket' in ch) campos.push(['TodoTicket', ch.todoTicket === 'S' ? 'Si' : 'No']);
      return campos;
    });
    axLines = (raw || []).map(l => {
      const ch = (l.changes && typeof l.changes === 'object') ? l.changes : {};
      let nm;
      if ('first_name' in ch || 'last_names' in ch) nm = { f: (ch.first_name || '').toUpperCase(), s: (ch.second_name || '').toUpperCase(), l: (ch.last_names || '').toUpperCase() };
      else nm = splitName(l.worker_name);
      return {
        id_number: l.worker_id_number, nombre: nm.f, nombre2: nm.s, apellidos: nm.l,
        correo: ('correo' in ch) ? ch.correo : '', fechaIni: '', fechaFin: '',
        cargo: ('cargo' in ch) ? (cargoAx[ch.cargo] || ch.cargo) : '',
        direccion: ('direccion' in ch) ? ch.direccion : '', fechaNac: ('fechaNac' in ch) ? ch.fechaNac : '',
        estCivil: ('estCivil' in ch) ? ch.estCivil : '', telefono: ('telefono' in ch) ? ch.telefono : '',
        genero: ('sexo' in ch) ? ch.sexo : '', cuenta: ('cuenta' in ch) ? ch.cuenta : '',
        todoTicket: ('todoTicket' in ch) ? ch.todoTicket : '',
      };
    });
  } else {
    return json({ ok: false, error: `Tipo de reporte no soportado: ${topic}` }, 400);
  }

  const nDocs = docTickets.length;
  const totalPieces = 1 + nDocs;
  const result = { osticket_pla: null, tickets_ok: 0, tickets_fail: 0, ticket_errors: [] };

  // Usuario-tienda (idempotente).
  const ostUserId = await gcUser(env, base, { email: fromEmail, name: fromName, phone: ctx.phone });
  if (ostUserId) {
    try {
      await sb(env, `companies?company_code=eq.${encodeURIComponent(ctx.cc)}`, {
        method: 'PATCH',
        body: JSON.stringify({ osticket_user_id: ostUserId, osticket_synced_at: new Date().toISOString() }),
      });
    } catch { /* no critico */ }
  }

  // PLA con Excel adjunto.
  let plaAttachments;
  try {
    const wb = buildAxWorkbookBase64(axKind, {
      companyDataArea: ctx.dataArea, companyName: ctx.businessName, companyAlias: ctx.cc,
      todayYmd: ctx.ymd, reportCode: code, lines: axLines,
    });
    if (wb) plaAttachments = [osAttach(wb.filename, wb.base64, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')];
  } catch (e) {
    result.ticket_errors.push(`Plantilla AX: ${String(e.message || e)}`);
  }

  const plaBody = buildReportText({
    pieceLabel: 'PLANTILLA', reportCode: code, piece: 1, totalPieces,
    topicLabel: plaTopicLabel, fecha: ctx.fecha, hora: ctx.hora,
    alias: ctx.cc, razon: ctx.businessName, zona: ctx.mallZona, marca: ctx.marca,
    correoTienda: ctx.email, responsable: ctx.report.responsible || '', cargo: ctx.report.position || '',
    telefono: ctx.phone, correoResp: ctx.email, registros: plaRegistros,
  });

  try {
    const plaNum = await osticketCreateTicket(env, base, {
      email: fromEmail, name: fromName,
      subject: `[${code}] [1/${totalPieces}] PLA`,
      message: plaBody, topicId, source: 'API', alert: false, autorespond: false,
      report_code: code, report_kind: 'PLA',
      ...(plaAttachments ? { attachments: plaAttachments } : {}),
    });
    result.osticket_pla = plaNum;
    result.tickets_ok++;
    await gcReportLink(env, base, { report_code: code, ticket_number: plaNum, kind: 'PLA', company: ctx.cc, report_type: topic, doc_total: nDocs });
  } catch (e) {
    result.tickets_fail++;
    result.ticket_errors.push(`PLA: ${String(e.message || e)}`);
  }

  // DOCs (uno por archivo re-adjuntado).
  for (let i = 0; i < docTickets.length; i++) {
    const d = docTickets[i];
    const piece = i + 2;
    const docBody = buildReportText({
      pieceLabel: 'DOCUMENTO', reportCode: code, piece, totalPieces,
      topicLabel: d.topicLabelDoc || plaTopicLabel, fecha: ctx.fecha, hora: ctx.hora,
      alias: ctx.cc, razon: ctx.businessName, zona: ctx.mallZona, marca: ctx.marca,
      correoTienda: ctx.email, responsable: ctx.report.responsible || '', cargo: ctx.report.position || '',
      telefono: ctx.phone, correoResp: ctx.email, registros: d.registros,
    });
    try {
      const docNum = await osticketCreateTicket(env, base, {
        email: fromEmail, name: fromName,
        subject: `[${code}] [${piece}/${totalPieces}] DOC ${d.subjectExtra}`,
        message: docBody, topicId, source: 'API', alert: false, autorespond: false,
        report_code: code, report_kind: 'DOC',
        attachments: [osAttach(d.file.name, d.file.b64, d.file.type)],
      });
      result.tickets_ok++;
      await gcReportLink(env, base, {
        report_code: code, ticket_number: docNum, kind: 'DOC', company: ctx.cc, report_type: topic,
        worker_id: d.ced, worker_name: d.worker_name, doc_pos: piece, doc_total: totalPieces,
      });
    } catch (e) {
      result.tickets_fail++;
      result.ticket_errors.push(`DOC ${d.ced}: ${String(e.message || e)}`);
    }
  }

  // Actualizar reports_log si el PLA se creo (osticket_id + email_sent +
  // osticket_sync 'synced' porque acabamos de crear con el estado abierto).
  if (result.osticket_pla) {
    try {
      await sb(env, `reports_log?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          osticket_id: result.osticket_pla, email_sent: true,
          osticket_sync: 'synced', osticket_sync_at: new Date().toISOString(), osticket_sync_error: null,
        }),
      });
    } catch { /* el reporte ya esta en BD */ }
  }

  return json({
    ok: !!result.osticket_pla,
    report_id: id,
    osticket_id: result.osticket_pla,
    tickets_ok: result.tickets_ok,
    tickets_fail: result.tickets_fail,
    errors: result.ticket_errors,
  });
}
