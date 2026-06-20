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
