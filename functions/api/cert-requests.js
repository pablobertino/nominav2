/* =====================================================================
   functions/api/cert-requests.js  →  /api/cert-requests
   CIRCUITO de Constancias de Trabajo, lado del SOLICITANTE.
   El solicitante puede ser:
     - company (tienda): su propia empresa.
     - admin/gestor/editor/superadmin: cualquier empresa de su alcance
       (get_admin_companies); superadmin = todas. Puede elegir empresa
       (tienda/empresa) y, dentro de ella, filtrar por departamento.

   Flujo: el solicitante elige 1+ empleados (como en los reportes) + un
   destinatario, y crea la solicitud. Nace en estado 'solicitada'. NO fija
   salario/bono/firmante: eso lo completa el admin en la revision
   (cert-admin.js). Se guarda un SNAPSHOT de la empresa (nombre, RIF,
   direccion, telefono, correo, ciudad) y del trabajador (nombre, cargo,
   fecha de ingreso) al momento de crear, para que la constancia no dependa
   de cambios posteriores.

   Acciones (POST {action}):
     - companies : empresas del alcance del actor (combo). Cada una indica si
                   es no-tienda (tiene departamentos). { actor }
     - departments : departamentos de una empresa (para el filtro del picker).
                   { actor, company_code }
     - roster    : empleados de una empresa (para elegir). Filtro opcional por
                   departamento y por texto. Devuelve id_number, nombre, cargo,
                   fecha de ingreso, foto. { actor, company_code, department?, q? }
     - create    : crea la solicitud + una linea por empleado (estado
                   'solicitada'). { actor, company_code, recipient?,
                   workers:[id_number...] | lines:[{id_number}], note? }
     - mine      : "mis solicitudes" del actor (con sus lineas). Para admin,
                   admite filtro por empresa. { actor, company_code? }
     - cancel    : anula una solicitud propia (estado 'anulada'), solo si
                   ninguna linea fue generada. { actor, request_id, reason? }

   'actor' = { kind:'company', companyCode } | { kind:'admin', id }

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);
const PUBLIC_THUMB_BUCKET = 'worker-thumbs';

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

function thumbUrl(env, photoKey) {
  if (!photoKey) return null;
  return `${env.supabase_url}/storage/v1/object/public/${PUBLIC_THUMB_BUCKET}/${photoKey}.jpg`;
}

/* ---------- resolucion del ACTOR (company | admin) ----------
   Devuelve una forma unificada:
     { kind, id?, companyCode?, role?, codes }
   codes = null  -> ve TODAS las empresas (company ve solo la suya via
                     companyCode; superadmin ve todas).
   codes = array -> company_codes permitidos (admin/gestor/editor con alcance).
   Para company, codes = [companyCode] (su unica empresa). */
async function resolveActor(env, actor) {
  if (!actor || !actor.kind) return null;
  if (actor.kind === 'company') {
    const cc = String(actor.companyCode || '').trim();
    if (!cc) return null;
    return { kind: 'company', companyCode: cc, role: 'company', codes: [cc] };
  }
  if (actor.kind === 'admin') {
    const id = actor.id;
    if (!id) return null;
    const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}&is_active=eq.true&select=id,role`);
    if (!a || !a.length) return null;
    if (a[0].role === 'superadmin') return { kind: 'admin', id: a[0].id, role: 'superadmin', codes: null };
    const rows = await sb(env, 'rpc/get_admin_companies', {
      method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
    });
    return { kind: 'admin', id: a[0].id, role: a[0].role, codes: (rows || []).map(r => r.company_code) };
  }
  return null;
}

/* ¿el actor puede operar sobre esta empresa? */
function actorCanCompany(act, cc) {
  if (!act || !cc) return false;
  if (act.codes === null) return true;            // superadmin
  return act.codes.includes(cc);
}

/* Identificador textual del solicitante para requester_id (auditoria). */
function requesterId(act) {
  return act.kind === 'company' ? act.companyCode : String(act.id);
}

/* Etiqueta legible del solicitante (para "mis solicitudes" del admin). */
function requesterKind(act) {
  return act.kind === 'company' ? 'company' : 'admin';
}

/* Empresas del alcance (para el combo). Devuelve
   [{ company_code, business_name, company_type, is_non_store }] ordenadas
   por company_code. company ve solo la suya. */
async function listCompanies(env, act) {
  let filter = '';
  if (act.codes !== null) {
    if (!act.codes.length) return [];
    const inList = act.codes.map(c => `"${c}"`).join(',');
    filter = `&company_code=in.(${inList})`;
  }
  const rows = await sb(env,
    `companies?select=company_code,business_name,company_type,status${filter}&order=company_code.asc`);
  return (rows || []).map(c => ({
    company_code: c.company_code,
    business_name: c.business_name || '',
    company_type: c.company_type || '',
    status: c.status || '',
    is_non_store: NON_STORE_TYPES.has(c.company_type),
  }));
}

/* Snapshot de la empresa para las lineas (nombre, RIF, direccion, tel, correo,
   ciudad). Lee companies. address/state/city/municipality pueden faltar. */
async function companySnapshot(env, cc) {
  const r = await sb(env,
    `companies?company_code=eq.${encodeURIComponent(cc)}`
    + `&select=business_name,tax_id,address,city,state,phone,phone2,email`);
  const c = (r && r[0]) || {};
  const phones = [c.phone, c.phone2].filter(Boolean).join(' / ');
  return {
    name: c.business_name || '',
    rif: c.tax_id || '',
    addr: c.address || '',
    city: c.city || '',
    phone: phones || '',
    email: c.email || '',
  };
}

/* Roster de una empresa: une store_workers + enterprise_workers por
   company_code. Solo ACTIVOS (sin end_date). Devuelve
   { id_number, full_name, role, start_date, photo_key, department_id, department_name }.
   Filtro opcional por department_id y por texto (nombre/cedula). */
async function companyRoster(env, cc, { department = null, q = '' } = {}) {
  // Traer de ambas fuentes; una empresa es tienda O no-tienda, pero
  // consultamos las dos por robustez (no se solapan por company_code+tipo).
  // OJO: store_workers / enterprise_workers NO tienen columna de foto; la
  // foto (photo_key) vive en workers_master (por cedula). Por eso el select
  // NO pide photo_key aqui (pedirlo devuelve 400 y vacia el roster).
  const sel = 'id_number,full_name,role,start_date,end_date,department_id';
  const [sw, ew] = await Promise.all([
    sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}&is_active=eq.true&select=${sel}&order=full_name.asc`),
    sb(env, `enterprise_workers?company_code=eq.${encodeURIComponent(cc)}&is_active=eq.true&select=${sel}&order=full_name.asc`),
  ]);
  let rows = [...(sw || []), ...(ew || [])];
  // Nombre de departamento (para mostrar). Mapa department_id -> name.
  const deptIds = [...new Set(rows.map(r => r.department_id).filter(x => x != null))];
  let deptName = {};
  if (deptIds.length) {
    const deps = await sb(env, `departments?id=in.(${deptIds.join(',')})&select=id,name`);
    (deps || []).forEach(d => { deptName[d.id] = d.name; });
  }
  if (department != null && department !== '' && department !== 'all') {
    rows = rows.filter(r => String(r.department_id) === String(department));
  }
  const needle = String(q || '').trim().toLowerCase();
  if (needle) {
    rows = rows.filter(r =>
      String(r.full_name || '').toLowerCase().includes(needle)
      || String(r.id_number || '').includes(needle));
  }
  // Fotos (miniatura publica) desde workers_master por cedula. Best-effort:
  // si falla, el roster igual carga (la foto es opcional en el picker).
  let photoByCed = {};
  const ceds = [...new Set(rows.map(r => r.id_number).filter(Boolean))];
  if (ceds.length) {
    try {
      const inList = ceds.map(c => `"${c}"`).join(',');
      const wm = await sb(env,
        `workers_master?id_number=in.(${inList})&select=id_number,photo_key`);
      (wm || []).forEach(w => { if (w.photo_key) photoByCed[w.id_number] = w.photo_key; });
    } catch { /* sin fotos: el roster carga igual */ }
  }
  return rows.map(r => ({
    id_number: r.id_number,
    full_name: r.full_name,
    role: r.role || null,
    start_date: r.start_date || null,
    department_id: r.department_id || null,
    department_name: r.department_id != null ? (deptName[r.department_id] || null) : null,
    thumb_url: thumbUrl(env, photoByCed[r.id_number] || null),
  }));
}

/* Mapa cedula -> { full_name, role, start_date } del roster de una empresa
   (para el snapshot del trabajador al crear la solicitud). */
async function rosterByCed(env, cc) {
  const sel = 'id_number,full_name,role,start_date';
  const [sw, ew] = await Promise.all([
    sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}&select=${sel}`),
    sb(env, `enterprise_workers?company_code=eq.${encodeURIComponent(cc)}&select=${sel}`),
  ]);
  const map = {};
  [...(sw || []), ...(ew || [])].forEach(w => {
    if (!map[w.id_number]) map[w.id_number] = { full_name: w.full_name, role: w.role || null, start_date: w.start_date || null };
  });
  return map;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const { action } = body;

  try {
    const act = await resolveActor(env, body.actor);
    if (!act) return json({ ok: false, error: 'Sesion no valida.' }, 403);

    /* ---------- combo de empresas ---------- */
    if (action === 'companies') {
      const companies = await listCompanies(env, act);
      return json({ ok: true, companies });
    }

    /* ---------- departamentos de una empresa (para el filtro) ---------- */
    if (action === 'departments') {
      const cc = String(body.company_code || '').trim();
      if (!cc) return json({ ok: false, error: 'Falta la empresa.' }, 400);
      if (!actorCanCompany(act, cc)) return json({ ok: false, error: 'Sin acceso a esa empresa.' }, 403);
      const deps = await sb(env,
        `departments?company_code=eq.${encodeURIComponent(cc)}&select=id,name&order=name.asc`);
      return json({ ok: true, departments: deps || [] });
    }

    /* ---------- roster (picker de empleados) ---------- */
    if (action === 'roster') {
      const cc = String(body.company_code || '').trim();
      if (!cc) return json({ ok: false, error: 'Falta la empresa.' }, 400);
      if (!actorCanCompany(act, cc)) return json({ ok: false, error: 'Sin acceso a esa empresa.' }, 403);
      const workers = await companyRoster(env, cc, {
        department: body.department != null ? body.department : null,
        q: body.q || '',
      });
      return json({ ok: true, workers });
    }

    /* ---------- crear solicitud ---------- */
    if (action === 'create') {
      const cc = String(body.company_code || '').trim();
      if (!cc) return json({ ok: false, error: 'Falta la empresa.' }, 400);
      if (!actorCanCompany(act, cc)) return json({ ok: false, error: 'Sin acceso a esa empresa.' }, 403);

      // Cedulas elegidas: admite workers:[ced...] o lines:[{id_number}].
      let ceds = [];
      if (Array.isArray(body.workers)) ceds = body.workers.map(x => String(x).replace(/[^0-9]/g, '')).filter(Boolean);
      else if (Array.isArray(body.lines)) ceds = body.lines.map(l => String(l.id_number || '').replace(/[^0-9]/g, '')).filter(Boolean);
      ceds = [...new Set(ceds)];
      if (!ceds.length) return json({ ok: false, error: 'Elige al menos un empleado.' }, 400);
      if (ceds.length > 50) return json({ ok: false, error: 'Demasiados empleados en una sola solicitud (max 50).' }, 400);

      const recipient = String(body.recipient || '').trim() || 'A quien pueda interesar';
      const note = String(body.note || '').trim() || null;

      // Snapshot de empresa + roster para nombre/cargo/fecha de ingreso.
      const [snap, roster] = await Promise.all([companySnapshot(env, cc), rosterByCed(env, cc)]);

      // Validar que cada cedula pertenezca al roster de la empresa.
      const missing = ceds.filter(c => !roster[c]);
      if (missing.length) {
        return json({ ok: false, error: `Estas cedulas no estan en el personal de ${cc}: ${missing.join(', ')}` }, 422);
      }

      // Cabecera de la solicitud.
      // REGLA: la solicitud SIEMPRE pertenece a la EMPRESA/tienda destino
      // (requester_kind='company', requester_id=company_code), aunque la haya
      // iniciado un admin. Asi la tienda la ve como propia en su lista.
      // 'created_via' distingue el origen: 'company' = la pidio la tienda;
      // 'admin' = la inicio un admin/superadmin (admin_id guarda quien).
      const viaAdmin = act.kind === 'admin';
      const reqRow = {
        company_code: cc,
        cert_type: 'constancia_trabajo',
        recipient,
        status: 'solicitada',
        requester_kind: 'company',
        requester_id: cc,
        created_via: viaAdmin ? 'admin' : 'company',
        admin_id: viaAdmin ? String(act.id) : null,
        note,
      };
      const ins = await sb(env, 'cert_requests', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(reqRow),
      });
      const reqId = ins && ins[0] ? ins[0].id : null;
      if (!reqId) return json({ ok: false, error: 'No se pudo crear la solicitud.' }, 500);

      // Lineas: una por empleado. Snapshot de trabajador + empresa. Salario/
      // bono/firmante quedan null (los completa el admin en la revision).
      const lines = ceds.map(ced => {
        const w = roster[ced];
        return {
          request_id: reqId,
          worker_id_number: ced,
          worker_full_name: w.full_name || ced,
          worker_role: w.role || null,
          start_date: w.start_date || null,
          recipient,                 // por defecto igual al de la cabecera; el admin puede afinar
          city: snap.city || null,
          company_name_snap: snap.name || null,
          company_rif_snap: snap.rif || null,
          company_addr_snap: snap.addr || null,
          company_phone_snap: snap.phone || null,
          company_email_snap: snap.email || null,
          status: 'solicitada',
        };
      });
      const insLines = await sb(env, 'cert_request_lines', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(lines),
      });

      // Auditoria por linea (solicitada).
      if (Array.isArray(insLines) && insLines.length) {
        const detalle = viaAdmin
          ? `Solicitud creada por admin #${act.id} a nombre de ${cc}`
          : 'Solicitud creada';
        const audit = insLines.map(l => ({
          line_id: l.id, from_status: null, to_status: 'solicitada',
          actor_kind: act.kind, actor_id: requesterId(act), detail: detalle,
        }));
        await sb(env, 'cert_line_audit', { method: 'POST', body: JSON.stringify(audit) }).catch(() => {});
      }

      return json({ ok: true, request_id: reqId, lines: (insLines || []).length });
    }

    /* ---------- mis solicitudes ---------- */
    if (action === 'mine') {
      // Cabeceras visibles para el actor: company ve las suyas por
      // requester_id; admin ve las que EL creo (requester_id = su id).
      // (La bandeja del admin para REVISAR pendientes de otros vive en
      // cert-admin.js; aca es "lo que YO pedi".)
      const rid = requesterId(act);
      const rk = requesterKind(act);
      let path = `cert_requests?requester_kind=eq.${rk}&requester_id=eq.${encodeURIComponent(rid)}`;
      // Filtro opcional por empresa (para el admin con varias).
      const cc = String(body.company_code || '').trim();
      if (cc) path += `&company_code=eq.${encodeURIComponent(cc)}`;
      path += '&select=*&order=requested_at.desc&limit=500';
      const reqs = await sb(env, path) || [];
      if (!reqs.length) return json({ ok: true, requests: [] });

      // Lineas de esas solicitudes.
      const ids = reqs.map(r => r.id);
      const linesRows = await sb(env,
        `cert_request_lines?request_id=in.(${ids.join(',')})&select=*&order=id.asc`) || [];
      const byReq = {};
      linesRows.forEach(l => { (byReq[l.request_id] = byReq[l.request_id] || []).push(l); });

      const out = reqs.map(r => ({ ...r, lines: byReq[r.id] || [] }));
      return json({ ok: true, requests: out });
    }

    /* ---------- anular solicitud propia ---------- */
    if (action === 'cancel') {
      const reqId = parseInt(body.request_id, 10);
      if (!reqId) return json({ ok: false, error: 'Falta la solicitud.' }, 400);
      const reason = String(body.reason || '').trim() || 'Anulada por el solicitante';

      // Debe ser del actor.
      const rid = requesterId(act);
      const rk = requesterKind(act);
      const r = await sb(env,
        `cert_requests?id=eq.${reqId}&requester_kind=eq.${rk}&requester_id=eq.${encodeURIComponent(rid)}&select=id,status`);
      if (!r || !r.length) return json({ ok: false, error: 'Solicitud no encontrada.' }, 404);

      // Solo se puede anular si NINGUNA linea fue generada/disponible.
      const lines = await sb(env, `cert_request_lines?request_id=eq.${reqId}&select=id,status`) || [];
      const anyGenerated = lines.some(l => l.status === 'generada' || l.status === 'disponible');
      if (anyGenerated) {
        return json({ ok: false, error: 'No se puede anular: ya hay constancias generadas en esta solicitud.' }, 409);
      }

      // Marcar cabecera + lineas como anuladas.
      await sb(env, `cert_requests?id=eq.${reqId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'anulada', updated_at: new Date().toISOString() }),
      });
      await sb(env, `cert_request_lines?request_id=eq.${reqId}&status=in.(solicitada,en_revision)`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'anulada', annul_reason: reason,
          annulled_by: requesterId(act), annulled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
      // Auditoria.
      const audit = lines
        .filter(l => l.status === 'solicitada' || l.status === 'en_revision')
        .map(l => ({
          line_id: l.id, from_status: l.status, to_status: 'anulada',
          actor_kind: act.kind, actor_id: requesterId(act), detail: reason,
        }));
      if (audit.length) await sb(env, 'cert_line_audit', { method: 'POST', body: JSON.stringify(audit) }).catch(() => {});

      return json({ ok: true, request_id: reqId, cancelled: true });
    }

    /* ---------- campanita: constancias listas (disponibles) sin ver ----------
       Solo para company (tienda/gestor de su empresa). Cuenta las lineas
       'disponible' de sus solicitudes con generated_at posterior al ultimo
       "visto" (cert_bell_seen). Devuelve { unread, items } (items = las mas
       recientes para el pop). */
    if (action === 'bell') {
      if (act.kind !== 'company') return json({ ok: true, unread: 0, items: [] });
      const cc = act.companyCode;
      // Ultimo visto.
      let seenAt = null;
      try {
        const s = await sb(env, `cert_bell_seen?company_code=eq.${encodeURIComponent(cc)}&select=seen_at`);
        seenAt = (s && s[0]) ? s[0].seen_at : null;
      } catch { /* sin registro: todo es nuevo */ }
      // Solicitudes de la empresa.
      const reqs = await sb(env,
        `cert_requests?company_code=eq.${encodeURIComponent(cc)}&requester_kind=eq.company&requester_id=eq.${encodeURIComponent(cc)}&select=id&limit=1000`) || [];
      if (!reqs.length) return json({ ok: true, unread: 0, items: [] });
      const ids = reqs.map(r => r.id);
      // Lineas disponibles de esas solicitudes.
      let lpath = `cert_request_lines?request_id=in.(${ids.join(',')})&status=eq.disponible&select=id,request_id,worker_full_name,generated_at&order=generated_at.desc&limit=50`;
      const lines = await sb(env, lpath) || [];
      const isNew = l => {
        if (!l.generated_at) return false;
        if (!seenAt) return true;
        return new Date(l.generated_at) > new Date(seenAt);
      };
      const nuevas = lines.filter(isNew);
      const items = nuevas.slice(0, 12).map(l => ({
        line_id: l.id, request_id: l.request_id,
        worker_full_name: l.worker_full_name || '', generated_at: l.generated_at,
      }));
      return json({ ok: true, unread: nuevas.length, items });
    }

    /* ---------- campanita: marcar visto (company) ---------- */
    if (action === 'bell_seen') {
      if (act.kind !== 'company') return json({ ok: true });
      const cc = act.companyCode;
      const now = new Date().toISOString();
      await sb(env, 'cert_bell_seen', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ company_code: cc, seen_at: now, updated_at: now }]),
      }).catch(() => {});
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}
