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

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { buildReportText } from './_ax-template.js';

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
    + 'responsible,position,workers_count,attention,osticket_id,email_sent,source_kind';
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
    email_sent: r.email_sent,
    source_kind: r.source_kind || 'company',
  }));

  return json({ ok: true, rows: out, total, page, per_page: perPage });
}

async function detailReport(env, body, scope) {
  const id = parseInt(body.report_id, 10);
  if (!id) return json({ ok: false, error: 'Falta report_id' }, 400);

  let q = `reports_log?id=eq.${id}&select=id,company_code,zone_id,subzone_id,topic,sent_at,`
    + 'responsible,position,workers_count,attention,osticket_id,email_sent,notes,source_kind';
  q += scopeFilter(scope);
  const head = await sbJson(env, q);
  if (!head || !head.length) return json({ ok: false, error: 'Reporte no encontrado o sin acceso.' }, 404);
  const r = head[0];

  // Nombre de tienda
  const comp = await sbJson(env, `companies?company_code=eq.${encodeURIComponent(r.company_code)}&select=business_name`);
  const companyName = comp && comp[0] ? comp[0].business_name : null;

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
    report: {
      id: r.id, type: r.topic, company_code: r.company_code, company_name: companyName,
      zone_id: r.zone_id, subzone_id: r.subzone_id, sent_at: r.sent_at,
      responsible: r.responsible, position: r.position, workers_count: r.workers_count,
      attention: r.attention, osticket_id: r.osticket_id, email_sent: r.email_sent, notes: r.notes,
      source_kind: r.source_kind || 'company',
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
