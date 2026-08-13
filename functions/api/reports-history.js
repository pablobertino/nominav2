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
     - publish_ax : (v6.167) publica en AX 2012 los marcajes de un reporte
                de Marcaje Manual, linea por linea. Si entran TODAS, el
                reporte queda Cerrado, su ticket tambien, y ya no vuelve a
                ningun estado anterior. Solo topic 'marcaje'.
                { action:'publish_ax', user, report_id, comment? }

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { buildReportText, buildAxWorkbookBase64 } from './_ax-template.js';
import { resolveActor, can } from './_auth.js';
import { axPublicarMarcajes, dayTypeToAx, axKey } from './_axmarcajes.js';
import { axPublicarAusencias } from './_axausencias.js';

// Mapa accion -> code. list/detail/ticket_* son lectura del Historial
// (view.historial). set_attention/sync_osticket/resend_* son gestion del
// estado de atencion del reporte (report.attention, solo admin/super).
const RH_CODE_BY_ACTION = {
  list: 'view.historial',
  detail: 'view.historial',
  ticket_text: 'view.historial',
  ticket_excel: 'view.historial',
  set_attention: 'report.attention',
  sync_osticket: 'report.attention',
  resend_info: 'report.attention',
  resend_osticket: 'report.attention',
  // Publicar en AX es una accion aparte: escribe en el ERP y cierra el
  // reporte para siempre. No se hereda de report.attention.
  publish_ax: 'report.publish.marcaje',
};

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

/* ¿El que mira es AGENTE de osTicket? Lo es si su registro tiene
   osticket_staff_id (staff/agente). Los usuarios de osTicket (tiendas y
   gestores) tienen osticket_user_id pero NO staff_id. Esto decide que tipo
   de enlace al ticket se arma en el Historial:
     agente  -> {base}/scp/tickets.php?number=XXXX   (panel de staff)
     usuario -> {base}/tickets.php?number=XXXX        (portal del cliente)
   Un admin puede tener AMBOS ids (es agente): prevalece el enlace de agente.
   Las tiendas (kind='company') nunca son agentes. */
async function viewerIsAgent(env, user) {
  if (!user) return false;
  if (user.kind === 'company') return false;
  if (user.kind === 'admin' && user.id) {
    const a = await sbJson(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&select=osticket_staff_id`);
    return !!(a && a[0] && a[0].osticket_staff_id != null);
  }
  return false;
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
   o { codes:[] } si no tiene acceso.

   Para ADMIN ademas se incluye:
     adminId        -> id del admin (para "ver siempre los suyos").
     deptByCompany  -> { [company_code]: [dept_id, ...] } para las empresas
                       donde el admin tiene alcance SOLO por departamento
                       (get_admin_dept_ids devuelve un array). En esas
                       empresas, en el Historial solo ve los reportes de
                       esos departamentos (o los suyos). Las empresas con
                       acceso completo (get_admin_dept_ids -> null) NO entran
                       aqui: se ven sin restriccion de departamento. */
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
    if (a[0].role === 'superadmin') return { all: true, adminId: a[0].id };
    const rows = await sbJson(env, 'rpc/get_admin_companies', {
      method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
    });
    const codes = (rows || []).map(r => r.company_code);
    // Mapa de restriccion por departamento en UNA sola llamada (antes se
    // llamaba get_admin_dept_ids una vez por empresa -> con un admin de
    // alcance amplio eso disparaba "Too many subrequests" en Cloudflare).
    // get_admin_dept_map devuelve solo las empresas restringidas por depto,
    // cada una con su array de dept_ids. Las de acceso completo no vienen.
    const deptByCompany = {};
    try {
      const mapRows = await sbJson(env, 'rpc/get_admin_dept_map', {
        method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
      });
      (mapRows || []).forEach(m => {
        if (Array.isArray(m.dept_ids) && m.dept_ids.length) {
          deptByCompany[m.company_code] = m.dept_ids.map(Number);
        }
      });
    } catch { /* si falla, se tratan todas como empresas completas */ }
    return { codes, adminId: a[0].id, deptByCompany };
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

    // v4.74: CORTE del shadow (Lote 4). Cada accion EXIGE su permiso de la
    // matriz (can): list/detail/ticket_* -> view.historial (tienda, gestor y
    // admin lo tienen); set_attention/sync_osticket/resend_* ->
    // report.attention (solo admin). El alcance por empresa/departamento
    // (resolveScope) se conserva intacto como segunda capa.
    const actor = await resolveActor(env, body.user || null);
    if (!can(actor, RH_CODE_BY_ACTION[body.action] || 'view.historial')) {
      return json({ ok: false, error: 'No tienes permiso para esta accion.' }, 403);
    }

    if (body.action === 'list') return await listReports(env, body, scope);
    if (body.action === 'detail') return await detailReport(env, body, scope);
    if (body.action === 'ticket_text') return await ticketText(env, body, scope);
    if (body.action === 'ticket_excel') return await ticketExcel(env, body, scope);
    if (body.action === 'set_attention') return await setAttention(env, body, scope);
    if (body.action === 'sync_osticket') return await syncOsticket(env, body, scope);
    if (body.action === 'resend_info') return await resendInfo(env, body, scope);
    if (body.action === 'resend_osticket') return await resendOsticket(env, body, scope);
    if (body.action === 'publish_ax') return await publishAx(env, body, scope);
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

/* Filtro FINO de visibilidad por departamento + autoria, para el Historial.
   Reglas (ademas del filtro por empresa de scopeFilter):
     - superadmin: sin restriccion.
     - admin con empresas de alcance COMPLETO (sin dept scope): ve todos los
       reportes de esas empresas.
     - admin con empresas restringidas por DEPARTAMENTO (deptByCompany): en
       esas empresas solo ve los reportes cuyo department_id este en su
       alcance, MAS los reportes hechos por el mismo (source_admin_id).
   Devuelve un segmento PostgREST que empieza con '&' (o '' si no aplica).

   Implementacion: un solo and=() con un or() interno:
     or(
       company_code.in.(<empresas completas>),         // ven todo
       and(company_code.in.(<emp con depto>), department_id.in.(<deptos>)),
       source_admin_id.eq.<adminId>                     // siempre los suyos
     )
   Si el admin no tiene ninguna empresa restringida por departamento, no se
   agrega nada (scopeFilter por empresa basta). */
function scopeDeptAuthorFilter(scope) {
  if (scope.all) return '';
  const deptBy = scope.deptByCompany || {};
  const deptCompanies = Object.keys(deptBy);
  // Sin restriccion por departamento en ninguna empresa: no hace falta filtro fino.
  if (!deptCompanies.length) return '';

  const fullCompanies = (scope.codes || []).filter(cc => !deptBy[cc]);
  const ors = [];
  // (a) Empresas de alcance completo: se ven enteras.
  if (fullCompanies.length) {
    ors.push(`company_code.in.(${fullCompanies.map(c => `"${c}"`).join(',')})`);
  }
  // (b) Cada empresa restringida por departamento: solo esos department_id.
  for (const cc of deptCompanies) {
    const ids = deptBy[cc];
    if (ids && ids.length) {
      ors.push(`and(company_code.eq."${cc}",department_id.in.(${ids.join(',')}))`);
    }
  }
  // (c) Siempre los reportes hechos por el propio admin.
  if (scope.adminId) ors.push(`source_admin_id.eq.${scope.adminId}`);

  if (!ors.length) return '';
  return `&or=(${ors.join(',')})`;
}

async function listReports(env, body, scope) {
  const f = body.filters || {};
  const page = Math.max(1, parseInt(body.page, 10) || 1);
  const perPage = Math.min(100, Math.max(10, parseInt(body.per_page, 10) || 20));
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  let q = 'reports_log?select=id,company_code,zone_id,subzone_id,topic,sent_at,'
    + 'responsible,position,workers_count,attention,osticket_id,email_sent,source_kind,source_admin_id,'
    + 'osticket_sync,attention_at,attention_comment,attention_by,ax_published_at';
  q += scopeFilter(scope);
  q += scopeDeptAuthorFilter(scope);   // restriccion fina por depto + autoria

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

  // Nombres y TIPO de empresa (para admin/superadmin) en un solo query. El
  // tipo alimenta la pastilla de origen del Historial: para reportes de la
  // empresa se muestra su company_type (Tienda, Administrativa, Importadora,
  // ...) en vez del generico "Empresa", que en el vocabulario del grupo
  // significa justamente lo-que-no-es-tienda.
  const codes = [...new Set(rows.map(r => r.company_code))];
  let nameByCode = {};
  let typeByCode = {};
  if (codes.length) {
    const list = codes.map(c => `"${c}"`).join(',');
    const comps = await sbJson(env, `companies?company_code=in.(${list})&select=company_code,business_name,company_type`);
    (comps || []).forEach(c => { nameByCode[c.company_code] = c.business_name; typeByCode[c.company_code] = c.company_type; });
  }

  // Nombres de los admins que cambiaron estados (para mostrar "quien"), en lote.
  const adminIds = [...new Set(rows.map(r => r.attention_by).filter(Boolean))];
  let nameByAdmin = {};
  if (adminIds.length) {
    const list = adminIds.join(',');
    const admins = await sbJson(env, `admin_users?id=in.(${list})&select=id,name`);
    (admins || []).forEach(x => { nameByAdmin[x.id] = x.name; });
  }

  // EMISOR CENTRAL: nombre + ROL REAL del admin/gestor que envió (origin
  // 'admin'). No se hardcodea "Administrador": se toma el rol del usuario y su
  // etiqueta del catálogo de Roles. En lote para toda la página.
  const srcIds = [...new Set(rows.map(r => r.source_admin_id).filter(Boolean))];
  let srcInfoById = {};
  if (srcIds.length) {
    const list = srcIds.join(',');
    const srcAdmins = await sbJson(env, `admin_users?id=in.(${list})&select=id,name,role`);
    const roleCodes = [...new Set((srcAdmins || []).map(a => a.role).filter(Boolean))];
    let labelByRole = {};
    if (roleCodes.length) {
      const rl = roleCodes.map(c => `"${c}"`).join(',');
      const roles = await sbJson(env, `roles?code=in.(${rl})&select=code,label`);
      (roles || []).forEach(r => { labelByRole[r.code] = r.label; });
    }
    (srcAdmins || []).forEach(a => {
      srcInfoById[a.id] = { name: a.name || null, role_label: labelByRole[a.role] || a.role || null };
    });
  }

  const out = rows.map(r => ({
    id: r.id,
    type: r.topic,
    company_code: r.company_code,
    company_name: nameByCode[r.company_code] || null,
    company_type: typeByCode[r.company_code] || null,
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
    source_admin_id: r.source_admin_id || null,
    source_admin_name: r.source_admin_id ? (srcInfoById[r.source_admin_id]?.name || null) : null,
    source_role: r.source_admin_id ? (srcInfoById[r.source_admin_id]?.role_label || null) : null,
    // v6.168: sello de publicacion en AX. Si viene, el reporte esta cerrado
    // para siempre: la UI muestra el candado y esconde el selector de estado.
    ax_published_at: r.ax_published_at || null,
  }));

  /* v6.209 — ¿ESTE EGRESO YA ESTA CARGADO EN AX?
     Medido el 13/08: 27 de los 36 reportes de egreso sin cerrar YA estaban
     hechos en AX y nadie cerro el reporte. Alguien los carga a mano y el
     portal no se entera. El dato para saberlo ya lo tenemos en casa
     (nomina_v2.ax_egresos, que llena sola el cron nv2_ax_egresos_tick), asi
     que esto NO llama a ninguna API: es una lectura de lo ya sincronizado.

     UNA sola llamada por PAGINA, no una por fila: se juntan los ids de los
     egresos visibles y la funcion los contesta todos juntos. La regla de
     emparejamiento vive en la base a proposito (ver el comentario de
     egresos_estado_ax); aca solo se pide el resultado. Es EXIGENTE: misma
     cedula, MISMA TIENDA y fecha a no mas de 7 dias. Las dos condiciones
     duras son las que evitan el falso positivo caro -dar por cargado un
     egreso que en realidad es otro empleo del mismo trabajador-, y hay casos
     reales de las dos clases: el reporte 718 tiene un egreso viejo en otra
     sucursal, y hay gente con dos egresos en la misma tienda.

     Se saltean los que tienen ax_published_at: esos los publicamos nosotros
     y la pildora con candado ya lo dice. Repetirlo seria ruido.

     Best-effort: si la funcion falla, el Historial se pinta igual sin el
     dato. Es informacion de ayuda, no puede tumbar el listado. */
  const egIds = rows.filter(r => r.topic === 'egreso' && !r.ax_published_at).map(r => r.id);
  if (egIds.length) {
    try {
      const est = await sbJson(env, 'rpc/egresos_estado_ax', {
        method: 'POST',
        body: JSON.stringify({ p_report_ids: egIds }),
      });
      const byId = {};
      (est || []).forEach(e => { byId[e.report_id] = e; });
      out.forEach(o => {
        const e = byId[o.id];
        if (!e || !e.en_ax) return;
        o.ax_estado = {
          lineas: e.lineas,
          en_ax: e.en_ax,
          fecha_ax: e.fecha_ax || null,
          fecha_rep: e.fecha_rep || null,
          coincide: e.coincide === true,
        };
      });
    } catch (_) { /* el listado no se cae por un dato informativo */ }
  }

  /* Cuando se miro AX por ultima vez. Va al pie del listado porque decir
     "ya esta en AX" sin decir desde cuando sabemos eso es medio mentir: si
     alguien egresa a una persona ahora mismo, el portal se entera en la
     proxima corrida del cron. */
  let axSyncAt = null;
  if (egIds.length) {
    try {
      const cfg = await sbJson(env, 'ax_sync_config?id=eq.1&select=last_run_at,last_status');
      if (cfg && cfg[0] && cfg[0].last_status === 'ok') axSyncAt = cfg[0].last_run_at || null;
    } catch (_) { /* sin fecha se muestra el renglon igual, sin el "según" */ }
  }

  // URL base de osTicket (sin barra final) para que el front arme el enlace
  // directo al ticket en el SCP: {base}/scp/tickets.php?number={osticket_id}.
  // Se lee una sola vez por pagina (no por fila).
  let osticketUrl = '';
  try { osticketUrl = await osticketBase(env); } catch { osticketUrl = ''; }
  const isAgent = await viewerIsAgent(env, body.user || null);

  return json({
    ok: true, rows: out, total, page, per_page: perPage,
    osticket_url: osticketUrl, viewer_is_agent: isAgent,
    ax_sync_at: axSyncAt,
  });
}

async function detailReport(env, body, scope) {
  const id = parseInt(body.report_id, 10);
  if (!id) return json({ ok: false, error: 'Falta report_id' }, 400);

  let q = `reports_log?id=eq.${id}&select=id,company_code,zone_id,subzone_id,topic,sent_at,`
    + 'responsible,position,workers_count,attention,osticket_id,email_sent,notes,source_kind,source_admin_id,'
    + 'osticket_sync,attention_at,attention_comment,attention_by,ax_published_at,ax_published_by';
  q += scopeFilter(scope);
  q += scopeDeptAuthorFilter(scope);   // no abrir reportes fuera de depto/autoria
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

  // v6.168: quien publico en AX. Suele ser el mismo que cerro el reporte,
  // pero se resuelve aparte porque el sello es lo que traba el estado y la
  // pantalla lo muestra con nombre y fecha.
  let axPublishedByName = null;
  if (r.ax_published_by) {
    if (r.ax_published_by === r.attention_by) {
      axPublishedByName = attentionByName;
    } else {
      const pb = await sbJson(env, `admin_users?id=eq.${encodeURIComponent(r.ax_published_by)}&select=name`);
      axPublishedByName = (pb && pb[0]) ? pb[0].name : null;
    }
  }

  // Emisor central: nombre + ROL REAL (no hardcode) del gestor/admin que envió.
  let sourceAdminName = null, sourceRole = null;
  if (r.source_admin_id) {
    const sa = await sbJson(env, `admin_users?id=eq.${encodeURIComponent(r.source_admin_id)}&select=name,role`);
    if (sa && sa[0]) {
      sourceAdminName = sa[0].name || null;
      sourceRole = sa[0].role || null;
      if (sa[0].role) {
        const rl = await sbJson(env, `roles?code=eq.${encodeURIComponent(sa[0].role)}&select=label`);
        if (rl && rl[0] && rl[0].label) sourceRole = rl[0].label;
      }
    }
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
    viewer_is_agent: await viewerIsAgent(env, body.user || null),
    report: {
      id: r.id, type: r.topic, company_code: r.company_code, company_name: companyName,
      zone_id: r.zone_id, subzone_id: r.subzone_id, sent_at: r.sent_at,
      responsible: r.responsible, position: r.position, workers_count: r.workers_count,
      attention: r.attention, osticket_id: r.osticket_id, email_sent: r.email_sent, notes: r.notes,
      source_kind: r.source_kind || 'company',
      source_admin_id: r.source_admin_id || null,
      source_admin_name: sourceAdminName,
      source_role: sourceRole,
      osticket_sync: r.osticket_sync || 'na',
      attention_at: r.attention_at || null,
      attention_comment: r.attention_comment || null,
      attention_by_name: attentionByName,
      ax_published_at: r.ax_published_at || null,
      ax_published_by_name: axPublishedByName,
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
  q += scopeDeptAuthorFilter(scope);
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
  q += scopeDeptAuthorFilter(scope);
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
  // 1) Autorizacion: SOLO usuarios administradores (no tiendas). La tienda
  //    (kind='company') no puede. Entre los admin, el permiso lo decide la
  //    MATRIZ (report.attention), no el rol: v6.63 dejo de exigir
  //    role==='admin'||'superadmin' hardcodeado, que rechazaba a un rol nuevo
  //    (ej. coordinador) aunque tuviera el permiso concedido en Roles.
  const user = body.user || {};
  if (user.kind !== 'admin' || !user.id) {
    return json({ ok: false, error: 'Solo un administrador puede cambiar el estado de atencion.' }, 403);
  }
  const a = await sbJson(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role,name`);
  if (!a || !a.length) return json({ ok: false, error: 'Administrador no valido.' }, 403);
  const actor = await resolveActor(env, user);
  if (!actor || !can(actor, 'report.attention')) {
    return json({ ok: false, error: 'No tienes permiso para cambiar el estado de atencion de los reportes.' }, 403);
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
  let q = `reports_log?id=in.(${idList})&select=id,company_code,osticket_id,ax_published_at`;
  q += scopeFilter(scope);
  q += scopeDeptAuthorFilter(scope);
  const allowedAll = await sbJson(env, q) || [];
  if (!allowedAll.length) {
    return json({ ok: false, error: 'Ninguno de los reportes esta en tu alcance.' }, 403);
  }

  // 3b) CANDADO DE PUBLICACION (v6.167). Un reporte con ax_published_at ya
  //     esta en AX: su estado no vuelve atras. El trigger de la base
  //     (reports_log_ax_lock) tambien lo impide, pero ahi el usuario veria
  //     un error crudo de Postgres. Aca se separan antes y se explica.
  const locked = allowedAll.filter(r => r.ax_published_at);
  const allowed = allowedAll.filter(r => !r.ax_published_at);
  if (!allowed.length) {
    return json({
      ok: false,
      locked: locked.length,
      locked_ids: locked.map(r => r.id),
      error: locked.length === 1
        ? `El reporte ${reportCode(locked[0].id)} ya fue publicado en AX: su estado no se puede cambiar.`
        : `Los ${locked.length} reportes ya fueron publicados en AX: su estado no se puede cambiar.`,
    }, 409);
  }
  const allowedIds = allowed.map(r => r.id);

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
    // Cuantos quedaron fuera por estar publicados en AX (no son un error:
    // el resto si se actualizo). El front los puede avisar aparte.
    locked: locked.length,
    locked_ids: locked.map(r => r.id),
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
  // v6.63: el permiso lo decide la matriz (report.attention), no el rol.
  const actor = await resolveActor(env, user);
  if (!actor || !can(actor, 'report.attention')) {
    return json({ ok: false, error: 'No tienes permiso para sincronizar el estado de los reportes.' }, 403);
  }

  const mode = String(body.mode || '').trim();
  let rows = [];

  if (mode === 'pending') {
    // Todos los del alcance con ticket y sync pendiente o fallido.
    let q = 'reports_log?select=id,attention,osticket_id,osticket_sync'
      + '&osticket_id=not.is.null&osticket_sync=in.(pending,failed)';
    q += scopeFilter(scope);
    q += scopeDeptAuthorFilter(scope);
    q += '&order=id.desc&limit=500';
    rows = (await sbJson(env, q)) || [];
  } else {
    const ids = Array.isArray(body.report_ids) ? body.report_ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
    if (!ids.length) return json({ ok: false, error: 'No se indicaron reportes.' }, 400);
    let q = `reports_log?id=in.(${ids.join(',')})&select=id,attention,osticket_id,osticket_sync`;
    q += scopeFilter(scope);
    q += scopeDeptAuthorFilter(scope);
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
  q += scopeDeptAuthorFilter(scope);
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
  // v6.63: el permiso lo decide la matriz (report.attention), no el rol.
  const actor = await resolveActor(env, user);
  if (!actor || !can(actor, 'report.attention')) {
    return json({ ok: false, error: 'No tienes permiso para reenviar reportes a osTicket.' }, 403);
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

/* =====================================================================
   publish_ax  (v6.168) — PUBLICAR EN AX un reporte de Marcaje Manual.

   Que hace, en criollo: agarra las lineas del reporte (mark_report_lines)
   y se las manda a AX 2012 EN UN SOLO LOTE. Deja constancia de cada linea
   en ax_marcajes_log. Si entraron TODAS, cierra el reporte y su ticket de
   osTicket y le pone el sello ax_published_at: de ahi no vuelve atras. Si
   alguna fallo, el reporte SIGUE ABIERTO y la respuesta dice cuales
   entraron y cuales no, con el payload exacto que se le mando a cada una.

   LAS CINCO REGLAS QUE HAY QUE TENER EN LA CABEZA:

   1) IDEMPOTENTE. Si el reporte ya tiene ax_published_at, responde ok con
      already:true. Un segundo clic (o un doble clic nervioso) no es un
      error: es alguien preguntando "¿ya se publico?".

   2) NO REENVIA LO QUE YA ENTRO. Antes de mandar, se leen las filas 'ok'
      de ax_marcajes_log DE ESTE MISMO reporte y esas lineas se saltan. Si
      la fila del log pertenece a OTRO reporte, NO se salta: eso es una
      CORRECCION (mismo trabajador, mismo dia, horario distinto) y hay que
      mandarla, porque AX actualiza el registro si ya existe.

   3) NO SE CONFIA DEL "Exito" DE AX. AX contesta HTTP 200 y status
      "Exito" aunque una linea no haya entrado (comprobado el 05/08/2026).
      Quien decide es la aritmetica de los contadores, y de eso se encarga
      _axmarcajes.js: si la cuenta no cuadra, reintenta linea por linea
      hasta saber exactamente cual fallo.

   4) TODO O NADA PARA CERRAR. El cierre es un solo PATCH que pone el
      estado, la auditoria y el sello juntos. El trigger de la base
      (reports_log_ax_lock) lo deja pasar porque compara contra
      OLD.ax_published_at, que en ese momento todavia es NULL.

   5) EL LOG MANDA. Si AX acepto las lineas pero no pudimos escribirlas en
      ax_marcajes_log, cuentan como FALLIDAS. Preferimos dejar el reporte
      abierto y que se reintente (AX omite lo que ya esta) antes que
      cerrarlo para siempre sin rastro de lo que se publico.

   Body: { action:'publish_ax', user, report_id, comment? }
   ===================================================================== */
async function publishAx(env, body, scope) {
  const t0 = Date.now();
  /* Un solo instante para todo el evento: el sello del reporte, las filas de
     la bitacora y el empujon a osTicket. Si cada pieza tomara su propia hora,
     un mismo hecho quedaria registrado con tres marcas distintas.
     v6.182: ademas estaba declarado dentro del bloque que la v6.181 extrajo a
     publicarLineasMarcaje, asi que el tronco se quedo sin el y el cierre
     reventaba con "nowIso is not defined" DESPUES de haber escrito en AX. */
  const nowIso = new Date().toISOString();
  // 1) Autorizacion. Igual que set_attention: solo usuarios administrativos
  //    (la tienda nunca), y entre ellos decide la MATRIZ, no el rol.
  const user = body.user || {};
  if (user.kind !== 'admin' || !user.id) {
    return json({ ok: false, error: 'Solo un administrador puede publicar marcajes en AX.' }, 403);
  }
  const a = await sbJson(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role,name`);
  if (!a || !a.length) return json({ ok: false, error: 'Administrador no valido.' }, 403);
  const actor = await resolveActor(env, user);
  // El permiso concreto depende del TIPO de reporte, y el tipo se sabe recien
  // al leerlo: la comprobacion fina va mas abajo, apenas se conoce el topic.
  // Sin la X-API-Key no tiene sentido empezar: cortamos antes de tocar nada.
  if (!axKey(env)) {
    return json({ ok: false, error: 'Falta el secret canaima_apikey (o ax_api_key) en las variables del proyecto.' }, 500);
  }

  // 2) El reporte, dentro del alcance del usuario (misma doble reja que el
  //    resto del Historial: empresa + departamento/autoria).
  const id = parseInt(body.report_id, 10);
  if (!id) return json({ ok: false, error: 'Falta report_id' }, 400);
  let q = `reports_log?id=eq.${id}&select=id,company_code,topic,attention,osticket_id,ax_published_at,ax_published_by`;
  q += scopeFilter(scope);
  q += scopeDeptAuthorFilter(scope);
  const head = await sbJson(env, q);
  if (!head || !head.length) return json({ ok: false, error: 'Reporte no encontrado o sin acceso.' }, 404);
  const rep = head[0];

  /* v6.181 — Cada tipo de reporte tiene su propio permiso: publicar marcajes
     y publicar ausencias son decisiones distintas, con consecuencias distintas
     (una ausencia mal cargada mueve la nomina). Por eso no se comparte gate. */
  const GATE_POR_TOPIC = {
    marcaje: 'report.publish.marcaje',
    ausencia: 'report.publish.ausencia',
  };
  const gate = GATE_POR_TOPIC[rep.topic];
  if (!gate) {
    return json({ ok: false, error: 'Este tipo de reporte todavía no se publica en AX.' }, 400);
  }
  if (!actor || !can(actor, gate)) {
    return json({
      ok: false,
      error: rep.topic === 'ausencia'
        ? 'No tienes permiso para publicar ausencias en AX.'
        : 'No tienes permiso para publicar marcajes en AX.',
    }, 403);
  }

  // 3) Ya publicado: no es error, es un "ya esta". Sin efectos.
  if (rep.ax_published_at) {
    let byName = null;
    if (rep.ax_published_by) {
      const p = await sbJson(env, `admin_users?id=eq.${encodeURIComponent(rep.ax_published_by)}&select=name`);
      byName = (p && p[0]) ? p[0].name : null;
    }
    return json({
      ok: true, already: true, report_id: id, company_code: rep.company_code,
      closed: rep.attention === 'closed', attention: rep.attention,
      published_at: rep.ax_published_at, published_by_name: byName,
      total: 0, publicadas: 0, fallidas: 0, omitidas: 0,
      osticket: { synced: 0, failed: 0 }, lineas: [],
    });
  }

  /* 3b) CERRADO A MANO NO SE PUBLICA (v6.175). "Cerrado" significa, por
     definicion del portal, "ya cargado en AX". Si llego a ese estado SIN el
     sello ax_published_at, es que alguien lo cargo a mano con la plantilla.
     Publicar encima puede PISAR una correccion: si al cargarlo se ajusto una
     hora, AX tiene el valor bueno y el reporte el viejo, y AX actualiza el
     registro existente sin avisar. Se exige devolver el estado primero, cosa
     que todavia se puede porque no hay sello que lo trabe. */
  if (rep.attention === 'closed') {
    return json({
      ok: false,
      needs_reopen: true,
      error: 'Este reporte figura como Cerrado, que en el portal significa que ya se cargo en AX a mano. '
        + 'Publicar ahora podria pisar una correccion hecha al cargarlo. Si igual hay que publicarlo, '
        + 'devolvele antes el estado a Abierto o Atendido.',
    }, 409);
  }

  /* 4) LA PARTE QUE DEPENDE DEL TIPO DE REPORTE.
     Marcajes y ausencias se leen de tablas distintas, se mandan a APIs
     distintas y -sobre todo- tienen reglas de reintento OPUESTAS: en
     marcajes reenviar es gratis porque AX omite lo identico; en ausencias
     AX rechaza el periodo superpuesto y reenviar es peligroso. Por eso cada
     uno tiene su funcion, y aca solo se elige.
     Todo lo que sigue -cerrar, sellar, avisar a osTicket, la bitacora- es
     comun a los dos y no se duplica. */
  const proc = rep.topic === 'ausencia'
    ? await publicarLineasAusencia(env, id, rep, user, body, actor, nowIso)
    : await publicarLineasMarcaje(env, id, rep, user, nowIso);
  if (proc.rechazo) return json(proc.rechazo.cuerpo, proc.rechazo.status);

  const { lineas, publicadas, fallidas, omitidas, total, axResumen } = proc;

  // 8) TODO O NADA. Solo si no fallo ninguna se cierra el reporte, con
  //    estado + auditoria + sello en un solo PATCH (regla 4).
  const comment = body.comment != null && String(body.comment).trim()
    ? String(body.comment).trim().slice(0, 300)
    : `Publicado en AX 2012 desde el Portal (${publicadas} marcaje${publicadas === 1 ? '' : 's'}`
      + `${omitidas ? `, ${omitidas} ya publicado${omitidas === 1 ? '' : 's'}` : ''}).`;

  let closed = false;
  let attention = rep.attention;
  let publishedAt = null;
  let osSynced = 0, osFailed = 0;

  if (!fallidas) {
    await sb(env, `reports_log?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        attention: 'closed',
        attention_comment: comment,
        attention_by: user.id,
        attention_at: nowIso,
        ax_published_at: nowIso,
        ax_published_by: user.id,
        osticket_sync: rep.osticket_id ? 'pending' : 'na',
        osticket_sync_error: null,
      }),
    });
    closed = true;
    attention = 'closed';
    publishedAt = nowIso;

    // 9) Y ahora el ticket. Va DESPUES del sello: el trigger no se queja
    //    porque estos PATCH no tocan attention.
    if (rep.osticket_id) {
      let osBase = '';
      try { osBase = await osticketBase(env); } catch { osBase = ''; }
      const resOs = await pushStatusToOsticket(env, osBase, [rep], 'closed', comment, nowIso);
      osSynced = resOs.synced; osFailed = resOs.failed;
    }
  }

  /* 10) BITACORA DEL EVENTO (v6.174). ax_marcajes_log guarda el resultado de
     cada MARCAJE; esta guarda el del CLIC completo, y existe para contestar
     una sola pregunta: ¿esto se podria publicar solo, sin que nadie mire?

     Por eso el dato que vale no es quien publico, sino si salio limpio al
     PRIMER intento. 'aislado' es la columna clave: true significa que la
     cuenta de AX no cuadro y hubo que reintentar linea por linea. Un evento
     con aislado=false y fallidas=0 es un evento que no necesito a nadie.

     Y 'errores' guarda los motivos concatenados: agrupando por ahi se ve QUE
     clase de problema impide automatizar (una cedula que no existe se
     resuelve distinto que la regla de antiguedad de AX).

     Best-effort a proposito: la bitacora JAMAS puede tumbar una publicacion
     que ya ocurrio. Si falla el insert, se pierde la fila y no el trabajo. */
  try {
    const motivos = lineas
      .filter(l => l.status === 'error')
      .map(l => `${l.worker_id_number}: ${l.error || 'sin detalle'}`)
      .join(' | ');
    const c = (axResumen && axResumen.contadores) || null;
    await sb(env, 'ax_publish_log', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        report_id: id,
        company_code: rep.company_code,
        published_by: user.id,
        source: 'portal',
        total,
        publicadas, fallidas, omitidas,
        ok: fallidas === 0,
        closed,
        aislado: !!(axResumen && axResumen.aislado),
        llamadas: (axResumen && axResumen.llamadas) || 0,
        ax_insertados: c ? c.insertados : null,
        ax_actualizados: c ? c.actualizados : null,
        ax_omitidos: c ? c.omitidos : null,
        ax_mensaje: (axResumen && axResumen.mensaje) ? String(axResumen.mensaje).slice(0, 1000) : null,
        errores: motivos ? motivos.slice(0, 2000) : null,
        osticket_synced: osSynced,
        osticket_failed: osFailed,
        duracion_ms: Date.now() - t0,
      }),
    });
  } catch (_) { /* la bitacora no rompe nada */ }

  return json({
    ok: fallidas === 0,
    report_id: id,
    company_code: rep.company_code,
    topic: rep.topic,
    total,
    publicadas,
    fallidas,
    omitidas,
    closed,
    attention,
    published_at: publishedAt,
    published_by_name: closed ? (a[0].name || null) : null,
    attention_by_name: closed ? (a[0].name || null) : null,
    attention_comment: closed ? comment : null,
    osticket: { synced: osSynced, failed: osFailed },
    ax: axResumen,
    lineas,
  }, fallidas === 0 ? 200 : 207);
}

/* =====================================================================
   publicarLineasMarcaje — la parte de publish_ax propia de MARCAJE MANUAL.
   Se extrajo tal cual en la v6.181, cuando entraron las ausencias: el
   cierre del reporte, el sello, osTicket y la bitacora son comunes y
   viven en publishAx; esto es lo unico que cambia entre un tipo y otro.
   Devuelve { lineas, publicadas, fallidas, omitidas, total, axResumen }
   o { rechazo: { cuerpo, status } } si hay que cortar antes de enviar.
   ===================================================================== */
async function publicarLineasMarcaje(env, id, rep, user, nowIso) {
    // 4) Las lineas del reporte.
    const lines = await sbJson(env,
      `mark_report_lines?report_id=eq.${id}`
      + `&select=id,worker_id_number,worker_name,mark_date,day_type,time_in,time_out`
      + `&order=id.asc`) || [];
    if (!lines.length) {
      return { rechazo: { cuerpo: { ok: false, error: 'El reporte no tiene lineas de marcaje.' }, status: 400 } };
    }

    // 4b) DOS LINEAS PARA LA MISMA PERSONA EL MISMO DIA no se pueden publicar:
    //     en AX son UN solo registro (la clave es tienda+cedula+fecha), asi que
    //     una pisaria a la otra y nadie sabria cual quedo. Mejor decirlo claro
    //     antes de escribir nada que dejar el resultado librado al orden.
    const porClave = new Map();
    for (const l of lines) {
      const k = `${l.worker_id_number}|${String(l.mark_date || '').slice(0, 10)}`;
      porClave.set(k, (porClave.get(k) || 0) + 1);
    }
    const repetidas = [...porClave.entries()].filter(([, n]) => n > 1).map(([k]) => k.replace('|', ' el '));
    if (repetidas.length) {
      return { rechazo: { status: 409, cuerpo: {
        ok: false,
        error: 'El reporte tiene mas de una linea para la misma persona el mismo dia, y en AX eso es un solo registro. '
          + 'Hay que corregirlo antes de publicar: ' + repetidas.join('; ') + '.',
      } } };
    }

    // 5) Lo que YA entro en un intento anterior DE ESTE reporte. Se compara
    //    por line_id: una fila del log de otro reporte es una correccion y
    //    debe volver a mandarse (regla 2 del encabezado).
    const prev = await sbJson(env,
      `ax_marcajes_log?report_id=eq.${id}&status=eq.ok&select=line_id`) || [];
    const yaEntraron = new Set(prev.map(x => x.line_id).filter(v => v != null));

    const pendientes = lines.filter(l => !yaEntraron.has(l.id));
    const omitidas = lines.length - pendientes.length;

      const lineaBase = (l, extra) => ({
      line_id: l.id,
      worker_id_number: l.worker_id_number,
      worker_name: l.worker_name || null,
      mark_date: String(l.mark_date || '').slice(0, 10),
      day_type: l.day_type || 'L',
      time_in: (l.time_in || '').slice(0, 5),
      time_out: (l.time_out || '').slice(0, 5),
      ...extra,
    });

    // Todo ya estaba publicado en un intento anterior: no hay nada que mandar,
    // pero SI hay que cerrar el reporte (quedo a medio camino la vez pasada).
    const lineas = lines
      .filter(l => yaEntraron.has(l.id))
      .map(l => lineaBase(l, {
        status: 'omitida', mensaje: 'Ya se habia publicado en un intento anterior.',
        error: null, payload: null,
      }));

    let publicadas = 0, fallidas = 0;
    let axResumen = null;

    if (pendientes.length) {
      // 6) EL LOTE. Una sola llamada; si la cuenta no cuadra, el modulo
      //    reintenta linea por linea y nos dice exactamente cual fallo.
      const res = await axPublicarMarcajes(env, pendientes.map(l => ({
        alias: rep.company_code,                 // alias, NO data_area
        personnelNumber: l.worker_id_number,
        transDate: String(l.mark_date || '').slice(0, 10),
        dayType: dayTypeToAx(l.day_type),        // 'L'|'D' -> Workday|RestDay
        timeEntry: l.time_in,                    // 'HH:MM:SS' -> segundos (lo hace el modulo)
        timeExit: l.time_out,
      })));

      axResumen = {
        llamadas: res.llamadas,
        aislado: res.aislado,
        mensaje: res.lote ? res.lote.mensaje : null,
        contadores: res.lote ? res.lote.counters : null,
      };

      // 7) Rastro en ax_marcajes_log, en UN SOLO upsert para todas las lineas.
      //    Antes era un INSERT por linea: con un reporte grande eso solo ya se
      //    comia el presupuesto de subrequests de Cloudflare.
      //    UPSERT por (tienda, cedula, fecha): si habia una fila de otro
      //    reporte, se pisa con este intento.
      //    created_at NO va en el payload a proposito: asi conserva la fecha
      //    del PRIMER intento mientras sent_at guarda la del ultimo.
      let logOk = true, logErr = null;
      try {
        await sb(env, 'ax_marcajes_log?on_conflict=company_code,worker_id_number,mark_date', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(pendientes.map((l, i) => {
            const r = res.resultados[i];
            return {
              report_id: id,
              line_id: l.id,
              company_code: rep.company_code,
              worker_id_number: l.worker_id_number,
              mark_date: String(l.mark_date || '').slice(0, 10),
              day_type: l.day_type || 'L',
              time_in: l.time_in || null,
              time_out: l.time_out || null,
              status: r.ok ? 'ok' : 'error',
              ax_message: r.mensaje ? String(r.mensaje).slice(0, 500) : null,
              ax_error: r.ok ? null : String(r.error || '').slice(0, 500),
              sent_at: nowIso,
              sent_by: user.id,
            };
          })),
        });
      } catch (e) {
        logOk = false;
        logErr = String((e && e.message) || e).slice(0, 300);
      }

      pendientes.forEach((l, i) => {
        const r = res.resultados[i];
        const ok = r.ok && logOk;
        if (ok) publicadas++; else fallidas++;
        lineas.push(lineaBase(l, {
          status: ok ? 'ok' : 'error',
          mensaje: r.ok ? r.mensaje : null,
          error: r.ok
            ? (logOk ? null : `AX aceptó el marcaje pero no se pudo dejar constancia en la bitácora: ${logErr}`)
            : r.error,
          detalles_ax: r.detalles_ax || null,
          xml: r.xml || null,
          payload: r.payload,
          via: r.via,
        }));
      });
    }

  return { lineas, publicadas, fallidas, omitidas, total: lines.length, axResumen };
}

/* =====================================================================
   publicarLineasAusencia — la parte de publish_ax propia de PERIODO DE
   AUSENCIA.                                                    (v6.181)

   ES DISTINTA A LA DE MARCAJES EN LO ESENCIAL, y conviene tenerlo claro
   antes de tocarla:

   1) SE MANDA DE A UNA LINEA. Lo hace el modulo _axausencias.js. AX
      identifica los fallos por CEDULA ("Fallo (28772674): ..."), asi que
      en un lote con dos periodos del mismo empleado no se sabria cual
      fallo. De a una, el 201 decide solo.

   2) NO SE REINTENTA LO QUE YA ENTRO, NUNCA. AX rechaza el periodo que se
      superpone con otro del mismo empleado, y devuelve el MISMO error
      tanto si la linea ya la mandamos nosotros como si choca con una
      ausencia cargada por otra via. Reenviar significaria marcar como
      fallida una linea que esta bien cargada. Por eso ax_ausencias_log
      es fuente de verdad y lo que figura 'ok' se saltea siempre.

   3) EL DOCUMENTO OBLIGATORIO MANDA. Una linea cuyo respaldo esta
      pendiente y es exigido (enforcement 'block') NO se publica: cargar
      un reposo en la nomina sin el certificado es justo lo que despues no
      se puede defender. Se permite forzarlo, pero solo de a un reporte,
      solo preguntando, y solo a quien tenga report.publish.forzar.
   ===================================================================== */
async function publicarLineasAusencia(env, id, rep, user, body, actor, nowIso) {

  // Las lineas, con su documento (si el tipo lo pide).
  const lines = await sbJson(env,
    `absence_report_lines?report_id=eq.${id}`
    + `&select=id,worker_id_number,worker_name,absence_code,ax_code,date_from,date_to,note,`
    + `absence_report_docs(doc_name,status,enforcement)`
    + `&order=id.asc`) || [];
  if (!lines.length) {
    return { rechazo: { status: 400, cuerpo: { ok: false, error: 'El reporte no tiene lineas de ausencia.' } } };
  }

  // Lo que YA entro. Se compara por line_id de ESTE reporte (regla 2).
  const prev = await sbJson(env,
    `ax_ausencias_log?report_id=eq.${id}&status=eq.ok&select=line_id`) || [];
  const yaEntraron = new Set(prev.map(x => x.line_id).filter(v => v != null));

  /* Documento exigido y todavia pendiente. enforcement 'block' es el campo
     que ya usa el portal para distinguir respaldo obligatorio de
     recomendado: se respeta ese, no se inventa otra regla. */
  const sinDoc = (l) => {
    const d = (l.absence_report_docs && l.absence_report_docs.length) ? l.absence_report_docs[0] : null;
    return !!(d && d.enforcement === 'block' && d.status !== 'adjunto');
  };
  const faltantes = lines.filter(l => !yaEntraron.has(l.id) && sinDoc(l));
  const forzar = body.force_missing_docs === true;

  if (faltantes.length && !forzar) {
    /* Se corta y se PREGUNTA, en vez de publicar a medias. La pantalla
       decide como mostrarlo: de a un reporte ofrece publicar igual (si el
       usuario tiene el permiso), y en la cola simplemente lo saltea. */
    const puedeForzar = !!(actor && can(actor, 'report.publish.forzar'));
    return { rechazo: { status: 409, cuerpo: {
      ok: false,
      needs_docs: true,
      can_force: puedeForzar,
      error: puedeForzar
        ? `Hay ${faltantes.length} ausencia(s) sin el documento obligatorio. Podés publicarlas igual, pero quedará registrado que se hizo sin respaldo.`
        : `Hay ${faltantes.length} ausencia(s) sin el documento obligatorio. No se puede publicar hasta que estén adjuntos.`,
      lineas_sin_doc: faltantes.map(l => ({
        line_id: l.id,
        worker_id_number: l.worker_id_number,
        worker_name: l.worker_name || null,
        date_from: l.date_from,
        date_to: l.date_to,
        absence_code: l.absence_code,
        doc_name: (l.absence_report_docs && l.absence_report_docs[0] && l.absence_report_docs[0].doc_name) || null,
      })),
    } } };
  }

  const pendientes = lines.filter(l => !yaEntraron.has(l.id));
  const omitidas = lines.length - pendientes.length;

  const base = (l, extra) => ({
    line_id: l.id,
    worker_id_number: l.worker_id_number,
    worker_name: l.worker_name || null,
    date_from: String(l.date_from || '').slice(0, 10),
    date_to: String(l.date_to || '').slice(0, 10),
    absence_code: l.absence_code,
    ax_code: l.ax_code,
    sin_doc: sinDoc(l),
    ...extra,
  });

  const lineas = lines
    .filter(l => yaEntraron.has(l.id))
    .map(l => base(l, {
      status: 'omitida',
      mensaje: 'Ya se había publicado en un intento anterior. No se reenvía: AX rechazaría el período repetido.',
      error: null, payload: null,
    }));

  let publicadas = 0, fallidas = 0;
  let axResumen = null;

  if (pendientes.length) {
    const res = await axPublicarAusencias(env, pendientes.map(l => ({
      personnelNumber: l.worker_id_number,
      dateFrom: String(l.date_from || '').slice(0, 10),
      dateTo: String(l.date_to || '').slice(0, 10),
      absenceCode: l.ax_code || l.absence_code,
      // approvedState 0 (Review): publicar desde el portal NO aprueba,
      // deja el registro para que alguien lo apruebe dentro de AX.
    })));
    axResumen = { llamadas: res.llamadas, aislado: true, mensaje: null, contadores: null };

    /* La bitacora se escribe SOLO con lo que entro y lo que fallo de este
       intento, en un upsert por (report_id, line_id). Va ANTES de contar
       resultados a proposito: si no se puede registrar, la linea cuenta
       como fallida — con ausencias, perder el rastro de lo que entro es
       peor que no publicar, porque despues no se puede reintentar. */
    let logOk = true, logErr = null;
    try {
      await sb(env, 'ax_ausencias_log?on_conflict=report_id,line_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(pendientes.map((l, i) => {
          const r = res.resultados[i];
          return {
            report_id: id,
            line_id: l.id,
            company_code: rep.company_code,
            worker_id_number: l.worker_id_number,
            worker_name: l.worker_name || null,
            date_from: String(l.date_from || '').slice(0, 10),
            date_to: String(l.date_to || '').slice(0, 10),
            absence_code: l.absence_code || null,
            ax_state: r.payload ? r.payload.state : null,
            approved_state: r.payload ? r.payload.approvedState : null,
            status: r.ok ? 'ok' : 'error',
            ax_message: r.mensaje ? String(r.mensaje).slice(0, 500) : null,
            ax_error: r.ok ? null : String(r.error || '').slice(0, 500),
            forzado: forzar && sinDoc(l),
            sent_at: nowIso,
            sent_by: user.id,
          };
        })),
      });
    } catch (e) {
      logOk = false;
      logErr = String((e && e.message) || e).slice(0, 300);
    }

    pendientes.forEach((l, i) => {
      const r = res.resultados[i];
      const ok = r.ok && logOk;
      if (ok) publicadas++; else fallidas++;
      lineas.push(base(l, {
        status: ok ? 'ok' : 'error',
        mensaje: r.ok ? r.mensaje : null,
        error: r.ok
          ? (logOk ? null : `AX registró la ausencia pero no se pudo dejar constancia en la bitácora: ${logErr}`)
          : r.error,
        http: r.http,
        payload: r.payload,
        forzada: forzar && sinDoc(l),
      }));
    });
  }

  return { lineas, publicadas, fallidas, omitidas, total: lines.length, axResumen };
}
