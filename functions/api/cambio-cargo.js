/* =====================================================================
   functions/api/cambio-cargo.js  →  POST /api/cambio-cargo
   CAMBIO DE CARGO (consola de escritura). Ascensos, descensos, traslados
   y egresos con circuito sugerir -> aprobar -> exportar la plantilla de
   Modificacion de AX (A/B/M). Distinto de /api/movements (tablero historico
   de solo lectura, derivado del sync). Aqui se PROPONEN y APRUEBAN cambios.

   Tabla: nomina_v2.personnel_movement_requests.
   Cargos de zona/tienda: nomina_v2.cargos (ambito, hier_level, movable).
   Alcance por rol de asignacion: nomina_v2.mov_role_scope (min_assign_level).
   OJO: un rol AUSENTE de mov_role_scope queda en nivel 999 y no puede asignar
   NINGUN cargo (el mas alto, GERENTE_ZONA, es 10). Dar mov.sugerir sin darle
   su fila ahi = wizard que se llena entero y revienta en el ultimo paso.

   Acciones (POST { action, user, ... }):
     catalog {}                gate view.cambiocargo | mov.sugerir | mov.aprobar
                               Cargos (con jerarquia continua), motivos de
                               egreso, permisos del actor (sugerir/aprobar) y
                               el nivel de asignacion del rol.
     list    {estado?, q?}     gate view.cambiocargo. Movimientos del alcance.
     suggest {items:[...], approve?}  gate mov.sugerir (approve=true exige
                               mov.aprobar + mov.autoaprobar): inserta uno o
                               varios movimientos.
     approve {id}              gate mov.aprobar, y ademas mov.autoaprobar si
                               el movimiento lo sugirio uno mismo.
     reject  {id, reason?}     gate mov.aprobar. Rechazar lo propio SI se
                               permite: es cancelar, no auto-aprobarse.
     export  {ids?}            gate mov.aprobar. Arma la matriz de la plantilla
                               AX (18 columnas, traslado=2 filas) de los
                               aprobados y los marca exportados.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { resolveActor, can, AuthError } from './_auth.js';

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

/* Alcance de EMPRESAS del actor (patron movements.js): superadmin -> null
   (todas); resto -> get_admin_companies(p_admin_id). */
async function scopeCodes(env, actor, user) {
  if (actor.role === 'superadmin') return null;
  const adminId = parseInt(user && user.id, 10) || null;
  if (!adminId) return [];
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: adminId }),
  });
  return (rows || []).map(r => r.company_code);
}

const norm = s => String(s == null ? '' : s).trim();
const cleanDigits = s => String(s || '').replace(/\D/g, '');
function isoDate(v) { const s = norm(v); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }

/* v6.114: fecha efectiva con la regla del sistema. Hacia el PASADO, el mismo
   margen del corte de quincena que ingresos/egresos (corte_margen_dias +
   corte_hora_limite). Hacia el FUTURO, el tope propio de cambios de cargo
   (futuro_cambio_cargo_dias). Se calcula server-side; el wizard lo usa de guia. */
function addDaysIso(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}
function nowCaracas() {
  const car = new Date(Date.now() - 4 * 3600 * 1000);
  return { ymd: car.toISOString().slice(0, 10), hhmm: `${String(car.getUTCHours()).padStart(2, '0')}:${String(car.getUTCMinutes()).padStart(2, '0')}` };
}
function toMin(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; }
async function getSetting(env, key, fallback) {
  const r = await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  return (r && r[0] && r[0].value != null) ? r[0].value : fallback;
}
async function ccWindow(env) {
  const { ymd: today, hhmm } = nowCaracas();
  const margin = parseInt(await getSetting(env, 'corte_margen_dias', '2'), 10) || 2;
  const cutoff = await getSetting(env, 'corte_hora_limite', '14:00');
  const futuro = parseInt(await getSetting(env, 'futuro_cambio_cargo_dias', '7'), 10);
  const futuroDias = (isNaN(futuro) || futuro < 0) ? 7 : futuro;
  // Límite inferior móvil: hoy-margen, pero si ya pasó la hora tope sube 1 día.
  const pastCutoff = toMin(hhmm) >= toMin(cutoff);
  const minDate = addDaysIso(today, pastCutoff ? -(margin - 1) : -margin);
  const maxDate = addDaysIso(today, futuroDias);
  return { today, minDate, maxDate, marginDays: margin, futuroDias };
}

const TIPOS = new Set(['ascenso', 'descenso', 'lateral', 'traslado', 'egreso']);

/* v6.193 — VENCIMIENTO DE SUGERENCIAS.

   El agujero que tapa: la ventana de fechas (ccWindow) se validaba SOLO al
   sugerir. `approve` no la revisaba nunca. Y la ventana se MUEVE sola todos
   los dias (minDate = hoy - margen). O sea que una sugerencia cargada hoy
   con fecha efectiva del limite, aprobada tres dias despues, entraba a AX
   con una fecha que el propio portal habria rechazado ese dia. En silencio.

   Por que solo el limite INFERIOR: maxDate tambien avanza con el calendario,
   asi que una fecha futura nunca se sale por arriba con el paso del tiempo —
   se acerca. Lo unico que puede pasarse de rango esperando es el pasado. */
function movFechas(mv) {
  const t = String(mv.tipo || '');
  if (t === 'traslado') return [mv.fecha_baja, mv.fecha_alta].filter(Boolean);
  if (t === 'egreso') return [mv.fecha_baja].filter(Boolean);
  return [mv.fecha_efectiva].filter(Boolean);
}
function movVencido(mv, win) {
  const fs = movFechas(mv).map(d => String(d).slice(0, 10));
  if (!fs.length) return false;
  return fs.some(d => d < win.minDate);
}
const ESTADOS_PENDIENTES = ['sugerido', 'aprobado'];

/* Etiqueta del rol para el "responsable/origen" del reporte (rol real de quien
   aprueba/genera). Fallback: el code con guiones->espacios. */
function roleLabelES(role) {
  const M = {
    superadmin: 'Superadmin', admin: 'Administrador',
    gerente_zona: 'Gerente de Zona', subgerente_zona: 'Subgerente de Zona',
    supervisor_tiendas: 'Supervisor de Tiendas', coordinador: 'Coordinador',
    gestor_empresa: 'Gestor de Empresa', editor_personal: 'Editor de Personal',
  };
  return M[role] || (role ? String(role).replace(/_/g, ' ') : 'Administrador');
}

/* Nivel de asignacion del rol (mov_role_scope). superadmin = -1 (todo).
   Sin fila = 999 (no asigna nada). */
async function assignLevel(env, actor) {
  if (actor.role === 'superadmin') return -1;
  const rows = await sb(env, `mov_role_scope?role_code=eq.${encodeURIComponent(actor.role)}&select=min_assign_level`);
  if (rows && rows.length) return Number(rows[0].min_assign_level);
  return 999;
}

/* v6.115: ¿el que mira es AGENTE de osTicket? (tiene osticket_staff_id). Decide
   el tipo de link al ticket, igual que Reportes → Historial. Company = nunca. */
async function viewerIsAgent(env, user) {
  if (!user || user.kind === 'company' || !user.id) return false;
  try {
    const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&select=osticket_staff_id`);
    return !!(a && a[0] && a[0].osticket_staff_id != null);
  } catch { return false; }
}

async function loadCargos(env) {
  const rows = await sb(env, 'cargos?is_active=eq.true&select=code,label,ax_code,ambito,hier_level,movable,sort_order&order=hier_level');
  return (rows || []).map(c => ({
    code: c.code, label: c.label, ax_code: c.ax_code || c.code,
    ambito: c.ambito || 'tienda',
    hier_level: c.hier_level == null ? 999 : Number(c.hier_level),
    movable: !!c.movable, sort_order: c.sort_order,
  }));
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const action = norm(body.action) || 'catalog';

  try {
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);

    const mySugerir = can(actor, 'mov.sugerir');
    const myAprobar = can(actor, 'mov.aprobar');
    /* v6.191: SEGUNDO PAR DE OJOS. Hasta aca, tener mov.aprobar alcanzaba para
       cerrar el circuito solo: el gerente_zona sugeria y se aprobaba a si
       mismo. No era teorico — el unico traslado que habia en la tabla tenia
       suggested_by = approved_by. Ahora mov.aprobar sirve para aprobar lo de
       OTROS; aprobar lo PROPIO pide ademas mov.autoaprobar, que hoy solo
       tienen Capital Humano (coordinador) y el superadmin. */
    const myAuto = can(actor, 'mov.autoaprobar');
    const myView = can(actor, 'view.cambiocargo') || mySugerir || myAprobar;
    /* v6.155: la COLA de aprobaciones (action 'list') salio del paraguas de
       view.cambiocargo y tiene permiso propio. Se le suman aprobar/anular
       porque esas acciones refrescan la cola al terminar: quien puede
       aprobar tiene que poder leerla, aunque no tenga la vista concedida. */
    const myCola = can(actor, 'view.cargohistorial') || myAprobar || can(actor, 'mov.anular');

    // v6.104: NOVEDADES de una tienda — cambios (aprobados y con aviso
    // liberado) que la afectan aunque no los haya hecho ella. Accesible por el
    // usuario company (su propia tienda) o por un admin pasando company_code.
    if (action === 'novedades' || action === 'novedades_count') {
      const storeCode = actor.kind === 'company' ? actor.actor : norm(body.company_code);
      if (!storeCode) return json({ ok: false, error: 'Falta la tienda.' }, 400);
      const seenRows = await sb(env, `movement_store_seen?company_code=eq.${encodeURIComponent(storeCode)}&select=seen_at`);
      const seenAt = (seenRows && seenRows[0] && seenRows[0].seen_at) || null;
      const seenMs = seenAt ? Date.parse(seenAt) : 0;
      const cc = encodeURIComponent(storeCode);
      const rows = await sb(env, `personnel_movement_requests?estado=eq.reportado&store_notify=eq.true&or=(empresa_origen.eq.${cc},empresa_destino.eq.${cc})&order=store_notified_at.desc&limit=300`) || [];

      if (action === 'novedades_count') {
        const count = rows.filter(r => Date.parse(r.store_notified_at || 0) > seenMs).length;
        return json({ ok: true, count });
      }

      // Enriquecer: empresas (origen/destino), foto y estado del tramite.
      const comps = [...new Set(rows.flatMap(r => [r.empresa_origen, r.empresa_destino]).filter(Boolean))];
      const ceds = [...new Set(rows.map(r => r.id_number).filter(Boolean))];
      const repIds = [...new Set(rows.map(r => r.report_id).filter(Boolean))];
      const compMap = {}, photoMap = {}, attMap = {};
      if (comps.length) {
        const inC = comps.map(c => `"${c}"`).join(',');
        const [crows, zs, ss, csx] = await Promise.all([
          sb(env, `companies?company_code=in.(${inC})&select=company_code,business_name,zone_id,subzone_id,concept_id`),
          sb(env, 'zones?select=id,name'), sb(env, 'subzones?select=id,name'), sb(env, 'concepts?select=id,name'),
        ]);
        const zm = {}, sm = {}, cm = {};
        (zs || []).forEach(z => { zm[z.id] = z.name; });
        (ss || []).forEach(s => { sm[s.id] = s.name; });
        (csx || []).forEach(c => { cm[c.id] = c.name; });
        (crows || []).forEach(c => { compMap[c.company_code] = { rz: c.business_name || null, zona: zm[c.zone_id] || null, subzona: sm[c.subzone_id] || null, concepto: cm[c.concept_id] || null }; });
      }
      if (ceds.length) {
        const inCed = ceds.map(c => `"${c}"`).join(',');
        const wrows = await sb(env, `workers_master?id_number=in.(${inCed})&select=id_number,photo_key`);
        (wrows || []).forEach(w => { photoMap[w.id_number] = w; });
      }
      if (repIds.length) {
        const rl = await sb(env, `reports_log?id=in.(${repIds.join(',')})&select=id,attention`);
        (rl || []).forEach(r => { attMap[r.id] = r.attention; });
      }
      // Etiquetas de cargo (la tienda no carga el catalogo admin).
      const cargoLbl = {};
      (await loadCargos(env)).forEach(c => { cargoLbl[c.code] = c.label; });
      const lblOf = code => code ? (cargoLbl[code] || code) : '';
      const thumb = k => k ? `${env.supabase_url}/storage/v1/object/public/worker-thumbs/${k}.jpg` : null;
      const statusOf = att => att === 'closed' ? 'aplicado' : (att === 'attended' || att === 'resolved') ? 'proceso' : 'aprobado';
      const out = rows.map(r => {
        const oc = compMap[r.empresa_origen] || {};
        const dc = compMap[r.empresa_destino] || {};
        const w = photoMap[r.id_number] || {};
        let direction;
        if (r.tipo === 'egreso') direction = 'baja';
        else if (r.tipo === 'traslado') direction = (r.empresa_destino === storeCode) ? 'in' : 'out';
        else direction = 'stay';
        return {
          id: r.id, tipo: r.tipo, id_number: r.id_number, full_name: r.full_name,
          cargo_from: r.cargo_from, cargo_to: r.cargo_to,
          cargo_from_label: lblOf(r.cargo_from), cargo_to_label: lblOf(r.cargo_to),
          empresa_origen: r.empresa_origen, empresa_destino: r.empresa_destino,
          motivo: r.motivo, fecha_efectiva: r.fecha_efectiva, fecha_baja: r.fecha_baja, fecha_alta: r.fecha_alta,
          origen_rz: oc.rz, origen_concepto: oc.concepto, destino_rz: dc.rz, destino_concepto: dc.concepto,
          thumb_url: thumb(w.photo_key), status: statusOf(attMap[r.report_id]),
          store_notified_at: r.store_notified_at, direction,
          unseen: Date.parse(r.store_notified_at || 0) > seenMs,
        };
      });
      if (body.mark_seen) {
        const nowS = new Date().toISOString();
        await sb(env, 'movement_store_seen?on_conflict=company_code', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ company_code: storeCode, seen_at: nowS }),
        });
      }
      return json({ ok: true, rows: out });
    }

    if (action === 'catalog') {
      if (!myView) return json({ ok: false, error: 'No tienes permiso para Cambio de Cargo.' }, 403);
      /* v6.193: cedulas con un movimiento EN CURSO. El backend ya rechazaba el
         duplicado, pero recien al enviar — despues de llenar los cinco pasos.
         Con esto el wizard lo avisa en el paso 1, donde todavia no perdiste
         nada. La validacion de verdad sigue estando en `suggest`. */
      const [cargos, reasons, minLevel, ostRow, enCursoRows] = await Promise.all([
        loadCargos(env),
        sb(env, 'egress_reasons?is_active=eq.true&select=code,label,sort_order&order=sort_order'),
        assignLevel(env, actor),
        sb(env, 'app_settings?key=eq.osticket_url&select=value'),
        sb(env, `personnel_movement_requests?estado=in.(${ESTADOS_PENDIENTES.join(',')})&select=id_number,tipo`),
      ]);
      return json({
        ok: true,
        cargos,
        egress_reasons: (reasons || []).map(r => ({ code: r.code, label: r.label })),
        my: { sugerir: mySugerir, aprobar: myAprobar, autoaprobar: myAuto, view: myView, anular: can(actor, 'mov.anular') },
        assign_min_level: minLevel,
        role: actor.role,
        osticket_url: (ostRow && ostRow[0] && ostRow[0].value) || null,
        viewer_is_agent: await viewerIsAgent(env, body.user || null),
        me: String(actor.actor || ''),   // v6.117: para filtrar "Mis sugerencias"
        // v6.193: { cedula: tipo } de los movimientos en curso, para el paso 1.
        en_curso: Object.fromEntries((enCursoRows || []).map(r => [String(r.id_number), r.tipo])),
        window: await ccWindow(env),
      });
    }

    if (action === 'companies') {
      if (!myView) return json({ ok: false, error: 'No tienes permiso para Cambio de Cargo.' }, 403);
      const codes = await scopeCodes(env, actor, body.user);
      if (codes !== null && !codes.length) return json({ ok: true, companies: [] });
      // Tiendas del alcance, excluyendo Cerrado/Nulo (se permiten Abierto,
      // Cerrada temporal y Proyectada).
      let path = `companies?company_type=eq.Tienda&status=in.("Abierto","Cerrada temporal","Proyectada")`
        + `&select=company_code,business_name,status,zone_id,subzone_id,concept_id&order=company_code`;
      if (codes !== null) {
        const inList = codes.map(c => `"${c}"`).join(',');
        path += `&company_code=in.(${inList})`;
      }
      const [comps, zs, ss, cs] = await Promise.all([
        sb(env, path),
        sb(env, 'zones?select=id,name'),
        sb(env, 'subzones?select=id,name'),
        sb(env, 'concepts?select=id,name'),
      ]);
      const zm = {}, sm = {}, cm = {};
      (zs || []).forEach(z => { zm[z.id] = z.name; });
      (ss || []).forEach(s => { sm[s.id] = s.name; });
      (cs || []).forEach(c => { cm[c.id] = c.name; });
      const out = (comps || []).map(c => ({
        code: c.company_code, business_name: c.business_name || null, status: c.status || null,
        zona: zm[c.zone_id] || null, subzona: sm[c.subzone_id] || null, concepto: cm[c.concept_id] || null,
      }));
      return json({ ok: true, companies: out });
    }

    if (action === 'list') {
      if (!myCola) return json({ ok: false, error: 'No tienes permiso para ver las aprobaciones de cargo (view.cargohistorial).' }, 403);
      const codes = await scopeCodes(env, actor, body.user);
      if (codes !== null && !codes.length) return json({ ok: true, rows: [] });

      let path = 'personnel_movement_requests?select=*&order=created_at.desc&limit=500';
      const estado = norm(body.estado);
      if (estado && estado !== 'todos') path += `&estado=eq.${encodeURIComponent(estado)}`;
      if (codes !== null) {
        const inList = codes.map(c => `"${c}"`).join(',');
        path += `&or=(empresa_origen.in.(${inList}),empresa_destino.in.(${inList}))`;
      }
      /* v6.193: ventana de fechas de la BANDEJA (distinta de la ventana de
         fechas efectivas). El archivo — aprobados, rechazados, anulados,
         vencidos — crece para siempre y hay que poder acotarlo. Los
         PENDIENTES quedan SIEMPRE fuera del recorte: son la cola de trabajo,
         y esconder por fecha algo que nadie resolvio es exactamente como se
         pierden. La cola se vacia sola al resolverla; el archivo no. */
      const desde = isoDate(body.desde), hasta = isoDate(body.hasta);
      let rango = '';
      if (desde || hasta) {
        const cond = [];
        if (desde) cond.push(`created_at.gte.${desde}`);
        if (hasta) cond.push(`created_at.lt.${addDaysIso(hasta, 1)}`);
        rango = `&and=(or(estado.in.(${ESTADOS_PENDIENTES.join(',')}),and(${cond.join(',')})))`;
      }
      /* Si el arbol logico anidado no le cae bien a PostgREST, se cae a la
         consulta SIN rango antes que dejar la bandeja vacia: mejor mostrar de
         mas que hacerle creer a alguien que no hay nada que aprobar. */
      let rows;
      try {
        rows = await sb(env, path + rango) || [];
      } catch (e) {
        if (!rango) throw e;
        rows = await sb(env, path) || [];
      }

      /* v6.193: AUTO-VENCER al leer. No hay cron en Pages Functions, y este es
         el punto por el que pasan todos los que miran la bandeja, asi que es
         donde el vencimiento ocurre "solo". El approve igual revalida: esto
         es para que se VEA venir, no para que sea seguro. */
      const winL = await ccWindow(env);
      const vencidas = rows.filter(r => ESTADOS_PENDIENTES.includes(r.estado) && movVencido(r, winL));
      if (vencidas.length) {
        const nowL = new Date().toISOString();
        try {
          await sb(env, `personnel_movement_requests?id=in.(${vencidas.map(v => v.id).join(',')})`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ estado: 'vencido', updated_at: nowL }),
          });
          const ids = new Set(vencidas.map(v => v.id));
          rows = rows.map(r => ids.has(r.id) ? { ...r, estado: 'vencido', updated_at: nowL } : r);
        } catch (_) { /* si falla el marcado, approve igual las corta */ }
      }
      const q = norm(body.q).toLowerCase();
      if (q) rows = rows.filter(r => (r.full_name || '').toLowerCase().includes(q) || (r.id_number || '').includes(q));
      // Enriquecer con datos de la tienda origen (razon social, zona, subzona,
      // concepto) y la foto del trabajador (para la pantalla Aprobaciones).
      const comps = [...new Set(rows.flatMap(r => [r.empresa_origen, r.empresa_destino]).filter(Boolean))];
      const ceds = [...new Set(rows.map(r => r.id_number).filter(Boolean))];
      const compMap = {};
      if (comps.length) {
        const inC = comps.map(c => `"${c}"`).join(',');
        const [crows, zs, ss, cs] = await Promise.all([
          sb(env, `companies?company_code=in.(${inC})&select=company_code,business_name,zone_id,subzone_id,concept_id`),
          sb(env, 'zones?select=id,name'), sb(env, 'subzones?select=id,name'), sb(env, 'concepts?select=id,name'),
        ]);
        const zm = {}, sm = {}, cm = {};
        (zs || []).forEach(z => { zm[z.id] = z.name; });
        (ss || []).forEach(s => { sm[s.id] = s.name; });
        (cs || []).forEach(c => { cm[c.id] = c.name; });
        (crows || []).forEach(c => { compMap[c.company_code] = { rz: c.business_name || null, zona: zm[c.zone_id] || null, subzona: sm[c.subzone_id] || null, concepto: cm[c.concept_id] || null }; });
      }
      const photoMap = {};
      if (ceds.length) {
        const inCed = ceds.map(c => `"${c}"`).join(',');
        const wrows = await sb(env, `workers_master?id_number=in.(${inCed})&select=id_number,photo_key,gender,birth_date`);
        (wrows || []).forEach(w => { photoMap[w.id_number] = w; });
      }
      const thumb = k => k ? `${env.supabase_url}/storage/v1/object/public/worker-thumbs/${k}.jpg` : null;
      rows = rows.map(r => {
        const c = compMap[r.empresa_origen] || {};
        const dc = compMap[r.empresa_destino] || {};
        const w = photoMap[r.id_number] || {};
        return { ...r, rz: c.rz, zona: c.zona, subzona: c.subzona, concepto: c.concepto,
          dest_rz: dc.rz || null, dest_concepto: dc.concepto || null,
          thumb_url: thumb(w.photo_key), gender: w.gender || null, birth_date: w.birth_date || null };
      });
      return json({ ok: true, rows, window: winL });
    }

    // v6.114: ventana de fecha efectiva (min/max) para el wizard.
    if (action === 'window') {
      if (!myView) return json({ ok: false, error: 'Sin acceso.' }, 403);
      return json({ ok: true, window: await ccWindow(env) });
    }

    if (action === 'suggest') {
      if (!mySugerir) return json({ ok: false, error: 'No tienes permiso para sugerir cambios (mov.sugerir).' }, 403);
      const wantApprove = body.approve === true;
      if (wantApprove && !myAprobar) return json({ ok: false, error: 'No tienes permiso para aprobar (mov.aprobar).' }, 403);
      /* v6.191: "aprobar de una vez" es, por definicion, aprobarse a si mismo:
         el que sugiere y el que aprueba son la misma persona en la misma
         llamada. Por eso pide mov.autoaprobar ademas de mov.aprobar. */
      if (wantApprove && !myAuto) return json({ ok: false, error: 'No puedes aprobar tu propia sugerencia. Envíala y que la apruebe Capital Humano (falta mov.autoaprobar).' }, 403);

      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json({ ok: false, error: 'No hay movimientos que registrar.' }, 400);

      const codes = await scopeCodes(env, actor, body.user);
      const cargos = await loadCargos(env);
      const byCode = c => cargos.find(x => x.code === c);
      const minLevel = await assignLevel(env, actor);

      const nowIso = new Date().toISOString();
      const estado = wantApprove ? 'aprobado' : 'sugerido';
      const rowsToInsert = [];

      // v6.114: ventana de fecha efectiva (regla del sistema). Server manda.
      const win = await ccWindow(env);
      const inWin = d => !!d && d >= win.minDate && d <= win.maxDate;

      // v6.115: no duplicar cambios EN CURSO para la misma persona. "En curso"
      // = sugerido o aprobado (pendiente, aún no reportado). Bloquea tanto
      // contra lo ya guardado como contra duplicados dentro del mismo lote.
      const batchCeds = [...new Set(items.map(x => cleanDigits(x.id_number)).filter(Boolean))];
      const enCurso = new Set();
      if (batchCeds.length) {
        const prev = await sb(env, `personnel_movement_requests?id_number=in.(${batchCeds.join(',')})&estado=in.(%22sugerido%22,%22aprobado%22)&select=id_number`);
        (prev || []).forEach(p => enCurso.add(String(p.id_number)));
      }
      const seenCeds = new Set();

      for (const it of items) {
        const idNumber = cleanDigits(it.id_number);
        const tipo = norm(it.tipo);
        if (!idNumber || !TIPOS.has(tipo)) return json({ ok: false, error: 'Movimiento invalido (cedula o tipo).' }, 400);

        // v6.115: una sola persona por movimiento en curso.
        const quien = norm(it.full_name) || ('V-' + idNumber);
        if (enCurso.has(idNumber)) return json({ ok: false, error: `Ya hay un cambio de cargo en curso para ${quien}. Resolvé o anulá ese antes de crear otro.` }, 409);
        if (seenCeds.has(idNumber)) return json({ ok: false, error: `${quien} aparece dos veces en este envío. Dejá un solo movimiento por persona.` }, 409);
        seenCeds.add(idNumber);

        // v6.114: validar la(s) fecha(s) efectiva(s) contra la ventana.
        const fEf = isoDate(it.fecha_efectiva), fB = isoDate(it.fecha_baja), fA = isoDate(it.fecha_alta);
        const rango = `entre ${win.minDate} y ${win.maxDate}`;
        if (tipo === 'traslado') {
          if (!fB || !fA) return json({ ok: false, error: 'Faltan las fechas del traslado.' }, 400);
          if (!inWin(fB) || !inWin(fA)) return json({ ok: false, error: `La fecha del traslado debe estar ${rango}.` }, 400);
          if (fA <= fB) return json({ ok: false, error: 'El primer día en destino debe ser posterior al último día en origen (nunca dos tiendas el mismo día).' }, 400);
        } else if (tipo === 'egreso') {
          if (!inWin(fB)) return json({ ok: false, error: `La fecha de egreso debe estar ${rango}.` }, 400);
        } else {
          if (!inWin(fEf)) return json({ ok: false, error: `La fecha efectiva debe estar ${rango}.` }, 400);
        }

        const empOrigen = norm(it.empresa_origen) || null;
        const empDestino = norm(it.empresa_destino) || null;
        // Alcance: el origen (o destino en traslado) debe estar en el alcance.
        if (codes !== null) {
          const ok = (empOrigen && codes.includes(empOrigen)) || (empDestino && codes.includes(empDestino));
          if (!ok) return json({ ok: false, error: 'Ese personal esta fuera de tu alcance.' }, 403);
        }

        const cargoTo = norm(it.cargo_to) || null;
        // Validar que el cargo destino sea asignable por el rol (excepto egreso).
        if (tipo !== 'egreso' && cargoTo) {
          const c = byCode(cargoTo);
          if (!c) return json({ ok: false, error: 'Cargo destino no valido.' }, 400);
          // El traslado que MANTIENE el mismo cargo se permite aunque ese cargo
          // no sea "asignable" por rango (ej. Vendedor). Ascenso/descenso si exigen rango.
          const sameAsCurrent = (tipo === 'traslado' && cargoTo === (norm(it.cargo_from) || null));
          if (!sameAsCurrent && actor.role !== 'superadmin' && c.hier_level <= minLevel) {
            return json({ ok: false, error: `Tu rol no puede asignar el cargo ${c.label}.` }, 403);
          }
        }

        rowsToInsert.push({
          tipo,
          id_number: idNumber,
          full_name: norm(it.full_name) || null,
          cargo_from: norm(it.cargo_from) || null,
          cargo_to: tipo === 'egreso' ? null : cargoTo,
          empresa_origen: empOrigen,
          empresa_destino: tipo === 'traslado' ? empDestino : null,
          motivo: norm(it.motivo) || null,
          fecha_efectiva: isoDate(it.fecha_efectiva),
          fecha_baja: isoDate(it.fecha_baja),
          fecha_alta: isoDate(it.fecha_alta),
          estado,
          comentario: norm(it.comentario) || null,
          suggested_by: String(actor.actor || ''),
          suggested_role: actor.role,
          approved_by: wantApprove ? String(actor.actor || '') : null,
          approved_at: wantApprove ? nowIso : null,
        });
      }

      const ins = await sb(env, 'personnel_movement_requests', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(rowsToInsert),
      });
      // Aprobacion directa (Gerente de Zona): generar el reporte de cada uno.
      const reported = [];
      const notifyStore = body.notify_store !== false;   // v6.104: default SI
      if (wantApprove && Array.isArray(ins)) {
        for (const mv of ins) {
          const gen = await generateReport(env, request, actor, body.user, mv);
          if (gen.ok) {
            const nowR = new Date().toISOString();
            await sb(env, `personnel_movement_requests?id=eq.${mv.id}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ estado: 'reportado', osticket_id: gen.osticket_id, report_id: gen.report_id, report_topic: gen.topic, store_notify: notifyStore, store_notified_at: notifyStore ? nowR : null, updated_at: nowR }),
            });
            reported.push({ id: mv.id, ok: true, osticket_id: gen.osticket_id, topic: gen.topic });
          } else {
            reported.push({ id: mv.id, ok: false, error: gen.error, details: gen.details });
          }
        }
      }
      return json({ ok: true, inserted: ins || [], estado, reported });
    }

    if (action === 'approve') {
      if (!myAprobar) return json({ ok: false, error: 'No tienes permiso para aprobar (mov.aprobar).' }, 403);
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta el id.' }, 400);
      const rows = await sb(env, `personnel_movement_requests?id=eq.${id}&select=*`);
      const mv = rows && rows[0];
      if (!mv) return json({ ok: false, error: 'Movimiento no encontrado.' }, 404);
      if (!ESTADOS_PENDIENTES.includes(mv.estado)) return json({ ok: false, error: 'El movimiento ya no esta pendiente.' }, 409);
      /* v6.193: revalidar la ventana AL APROBAR. Faltaba: solo se validaba al
         sugerir, y como la ventana se corre sola cada dia, aprobar tarde
         metia en AX una fecha ya invalida. Se marca vencido y se corta. */
      const winA = await ccWindow(env);
      if (movVencido(mv, winA)) {
        const nowV = new Date().toISOString();
        await sb(env, `personnel_movement_requests?id=eq.${id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ estado: 'vencido', updated_at: nowV }),
        });
        return json({ ok: false, vencido: true, error: `Esta sugerencia se venció: su fecha (${movFechas(mv).map(d => String(d).slice(0, 10)).join(' y ')}) quedó fuera de la ventana permitida, que hoy va del ${winA.minDate} al ${winA.maxDate}. Cargala de nuevo con una fecha válida.` }, 409);
      }
      /* v6.191: el segundo par de ojos, tambien desde la COLA. Sin esto el
         bloqueo del wizard seria decorativo: bastaba sugerir, ir a
         Aprobaciones y aprobarse ahi. RECHAZAR la propia sigue permitido a
         proposito — rechazar lo tuyo es cancelarlo, no hay conflicto de
         interes, y bloquearlo dejaria sugerencias colgadas esperando a un
         tercero solo para borrarlas. */
      if (String(mv.suggested_by || '') === String(actor.actor || '') && !myAuto) {
        return json({ ok: false, error: 'No puedes aprobar tu propia sugerencia. La tiene que aprobar Capital Humano u otra persona con permiso.' }, 403);
      }
      // Aprobar = generar el reporte/ticket como los demas reportes del sistema.
      const gen = await generateReport(env, request, actor, body.user, mv);
      if (!gen.ok) return json({ ok: false, error: gen.error, details: gen.details }, 422);
      // v6.104: el que aprueba decide si la tienda se entera ya (toggle, por
      // defecto SI) o si el aviso se retiene para liberarlo despues.
      const notifyStore = body.notify_store !== false;
      const nowA = new Date().toISOString();
      await sb(env, `personnel_movement_requests?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          estado: 'reportado', approved_by: String(actor.actor || ''), approved_at: nowA,
          osticket_id: gen.osticket_id, report_id: gen.report_id, report_topic: gen.topic,
          store_notify: notifyStore, store_notified_at: notifyStore ? nowA : null,
          updated_at: nowA,
        }),
      });
      return json({ ok: true, osticket_id: gen.osticket_id, report_topic: gen.topic, store_notified: notifyStore });
    }

    if (action === 'reject') {
      if (!myAprobar) return json({ ok: false, error: 'No tienes permiso para rechazar (mov.aprobar).' }, 403);
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta el id.' }, 400);
      await sb(env, `personnel_movement_requests?id=eq.${id}&estado=in.(sugerido,aprobado)`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ estado: 'rechazado', rejected_by: String(actor.actor || ''), rejected_at: new Date().toISOString(), reject_reason: norm(body.reason) || null, updated_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    // v6.104: liberar el aviso a la tienda de un movimiento ya reportado que
    // quedo retenido (toggle apagado al aprobar). Mismo permiso que aprobar.
    if (action === 'publish_notice') {
      if (!myAprobar) return json({ ok: false, error: 'No tienes permiso para avisar a la tienda (mov.aprobar).' }, 403);
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta el id.' }, 400);
      const nowP = new Date().toISOString();
      await sb(env, `personnel_movement_requests?id=eq.${id}&estado=eq.reportado`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ store_notify: true, store_notified_at: nowP, updated_at: nowP }),
      });
      return json({ ok: true, store_notified_at: nowP });
    }

    // v6.117: MIS SUGERENCIAS — avisar al usuario que sugirió el resultado
    // (aprobada/rechazada/anulada). Cuenta no-vistas para la campanita y marca
    // visto (mark_seen) al abrir la sección. No cuenta las que él mismo resolvió.
    if (action === 'mis_sug') {
      if (!myView) return json({ ok: false, error: 'Sin acceso.' }, 403);
      const me = String(actor.actor || '');
      if (!me) return json({ ok: true, items: [], unread: 0 });
      const seenRows = await sb(env, `movement_suggester_seen?suggested_by=eq.${encodeURIComponent(me)}&select=seen_at`);
      const seenMs = (seenRows && seenRows[0]) ? Date.parse(seenRows[0].seen_at || 0) : 0;
      const rows = await sb(env, `personnel_movement_requests?suggested_by=eq.${encodeURIComponent(me)}`
        + `&order=updated_at.desc&limit=60&select=id,tipo,id_number,full_name,cargo_to,estado,updated_at,approved_by,rejected_by,anulado_by,reject_reason,osticket_id`);
      const cargos = await loadCargos(env);
      const lbl = c => (cargos.find(x => x.code === c) || {}).label || c || '';
      const resolved = st => st === 'reportado' || st === 'rechazado' || st === 'anulado';
      const selfDid = r => (r.estado === 'reportado' && r.approved_by === me) || (r.estado === 'rechazado' && r.rejected_by === me) || (r.estado === 'anulado' && r.anulado_by === me);
      const items = (rows || []).map(r => ({
        id: r.id, tipo: r.tipo, full_name: r.full_name, id_number: r.id_number,
        cargo_to_label: lbl(r.cargo_to), estado: r.estado, updated_at: r.updated_at,
        osticket_id: r.osticket_id, reject_reason: r.reject_reason,
        unseen: resolved(r.estado) && !selfDid(r) && Date.parse(r.updated_at || 0) > seenMs,
      }));
      const unread = items.filter(x => x.unseen).length;
      if (body.mark_seen) {
        await sb(env, 'movement_suggester_seen?on_conflict=suggested_by', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ suggested_by: me, seen_at: new Date().toISOString() }),
        });
      }
      return json({ ok: true, items, unread });
    }

    // v6.115: ANULAR un movimiento ya aprobado/reportado. No revierte el sistema
    // por sí solo (no sabemos en qué punto está Capital Humano): marca el
    // movimiento como anulado y la UI indica coordinar con Capital Humano para
    // que cierre el ticket sin ejecutar (o revierta si aún no lo hizo).
    // Gate propio: mov.anular (admin/coordinador/superadmin).
    if (action === 'anular') {
      if (!can(actor, 'mov.anular')) return json({ ok: false, error: 'No tienes permiso para anular (mov.anular).' }, 403);
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta el id.' }, 400);
      const reason = (norm(body.reason) || '').slice(0, 500) || null;
      const rows = await sb(env, `personnel_movement_requests?id=eq.${id}&select=id,estado,full_name,id_number`);
      const mv = rows && rows[0];
      if (!mv) return json({ ok: false, error: 'Movimiento no encontrado.' }, 404);
      if (mv.estado === 'anulado') return json({ ok: false, error: 'Ese movimiento ya está anulado.' }, 400);
      if (!['aprobado', 'reportado', 'exportado'].includes(mv.estado)) {
        return json({ ok: false, error: 'Solo se anula un movimiento ya aprobado o reportado.' }, 400);
      }
      const nowA = new Date().toISOString();
      await sb(env, `personnel_movement_requests?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ estado: 'anulado', anulado_by: String(actor.actor || ''), anulado_at: nowA, anulado_reason: reason, updated_at: nowA }),
      });
      return json({ ok: true, id, anulado_at: nowA });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status);
    return json({ ok: false, error: 'Error interno: ' + String(e && e.message ? e.message : e) }, 500);
  }
}

/* ---------- generateReport: crea el reporte/ticket como los demas ----------
   Ascenso/Descenso -> reporte de Modificacion (M, topic 32) con el nuevo cargo.
   Egreso           -> reporte de Egreso (B, topic 33) con motivo.
   Traslado         -> reporte de Traslado (B+A, topic 34) — en construccion.
   Reutiliza /api/reports (misma validacion, mismo osTicket, misma cabecera).
   Devuelve { ok, osticket_id, report_id, topic, error, details }. */
async function generateReport(env, request, actor, user, mv) {
  const origin = new URL(request.url).origin;
  const call = (payload) => fetch(`${origin}/api/reports`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, user }),
  }).then(r => r.json()).catch(e => ({ ok: false, error: 'No se pudo contactar el generador de reportes: ' + String((e && e.message) || e) }));

  // El responsable es QUIEN aprobó/generó el reporte, con su ROL REAL (no un
  // "Gerente de Zona" fijo): superadmin sale como Superadmin, etc. Se anota
  // "· Cambio de Cargo" para que el Origen deje claro de qué flujo proviene.
  const head = {
    responsible: String(actor.actor || ''),
    position: `${roleLabelES(actor.role)} · Cambio de Cargo`,
    source_kind: 'admin',
    source_admin_id: (user && user.id) || null,
  };

  if (mv.tipo === 'ascenso' || mv.tipo === 'descenso') {
    const r = await call({
      action: 'submit_modificacion', company_code: mv.empresa_origen, ...head,
      lines: [{ id_number: mv.id_number, worker_name: mv.full_name, changes: { cargo: mv.cargo_to } }],
    });
    return normReport(r, 'modificacion');
  }
  if (mv.tipo === 'egreso') {
    const r = await call({
      action: 'submit_egreso', company_code: mv.empresa_origen, ...head,
      lines: [{
        id_number: mv.id_number, name: mv.full_name,
        report_date: mv.fecha_baja || mv.fecha_efectiva,
        reason_code: mv.motivo, doc_cause: egresoDocCause(mv.motivo),
      }],
    });
    return normReport(r, 'egreso');
  }
  if (mv.tipo === 'traslado') {
    const r = await call({
      action: 'submit_traslado', company_code: mv.empresa_origen, ...head,
      lines: [{
        id_number: mv.id_number, name: mv.full_name,
        cargo_from: mv.cargo_from, cargo_to: mv.cargo_to,
        empresa_destino: mv.empresa_destino,
        fecha_baja: mv.fecha_baja, fecha_alta: mv.fecha_alta,
      }],
    });
    return normReport(r, 'traslado');
  }
  return { ok: false, error: 'Tipo de movimiento no soportado para reporte.' };
}
function normReport(r, topic) {
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'No se pudo generar el reporte.', details: r && r.details };
  const ost = (r.osticket && (r.osticket.pla || r.osticket.osticket_pla)) || r.osticket_id || null;
  return { ok: true, osticket_id: ost != null ? String(ost) : null, report_id: r.report_id || null, topic };
}
// Causa de no-adjunto (egress_doc_causes) segun el motivo; todas eximen la carta.
const EGRESO_DOC_CAUSE = { despido_just: 'dismissal', despido_injust: 'dismissal', abandono: 'abandonment', fin_contrato: 'contract_end' };
function egresoDocCause(motivo) { return EGRESO_DOC_CAUSE[String(motivo || '')] || 'verbal'; }

/* ---------- export (LEGACY, sin uso): matriz de la plantilla de Modificacion AX ----------
   Se reemplazo por generateReport (reporte + ticket). Se conserva por referencia. */
const AX_COLUMNS = [
  'Nombre', 'Segundo Nombre', 'Apellidos', 'Numero de Personal', 'Correo Electrónico',
  'Data ID', 'Fecha inicial de Empleo', 'Fecha Final de Empleo', 'Cargo', 'Direccion',
  'Fecha de Nacimiento', 'Estado Civil', 'Telefono', 'Genero', 'Nro de Cuenta Bancaria',
  'TodoTicket', 'Accion', 'Clave',
];

function fmtAx(iso) { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; }

async function exportPlantilla(env, actor, body) {
  const ids = Array.isArray(body.ids) ? body.ids.map(n => parseInt(n, 10)).filter(Boolean) : null;
  const codes = await scopeCodes(env, actor, body.user);

  let path = 'personnel_movement_requests?estado=eq.aprobado&select=*&order=created_at.asc';
  if (ids && ids.length) path += `&id=in.(${ids.join(',')})`;
  if (codes !== null && codes.length) {
    const inList = codes.map(c => `"${c}"`).join(',');
    path += `&or=(empresa_origen.in.(${inList}),empresa_destino.in.(${inList}))`;
  } else if (codes !== null && !codes.length) {
    return json({ ok: true, columns: AX_COLUMNS, rows: [], filename: null, exported: 0 });
  }
  const moves = await sb(env, path) || [];
  if (!moves.length) return json({ ok: true, columns: AX_COLUMNS, rows: [], filename: null, exported: 0 });

  const cargos = await loadCargos(env);
  const axOf = code => { const c = cargos.find(x => x.code === code); return c ? c.ax_code : (code || ''); };

  // Datos maestros de cada persona (para llenar la plantilla).
  const ceds = [...new Set(moves.map(m => m.id_number).filter(Boolean))];
  const masters = {};
  if (ceds.length) {
    const inCed = ceds.map(c => `"${c}"`).join(',');
    const mrows = await sb(env,
      `workers_master?id_number=in.(${inCed})&select=id_number,first_name,second_name,last_names,email,data_id,address,birth_date,marital_status,phone,gender,account_number,todo_ticket`);
    (mrows || []).forEach(r => { masters[r.id_number] = r; });
  }
  // Fecha de ingreso original (primer tramo del Grupo) por persona, para M/B.
  const ingByCed = {};
  await Promise.all(ceds.map(async ced => {
    try {
      const h = await sb(env, 'rpc/get_group_history', { method: 'POST', body: JSON.stringify({ p_ced: ced }) });
      if (h && h.length) ingByCed[ced] = h[0].ini || null;
    } catch (_) { /* sin historia: queda vacio */ }
  }));

  const baseRow = (m, accion, cargoAx, fIni, fFin) => {
    const w = masters[m.id_number] || {};
    return [
      w.first_name || '', w.second_name || '', w.last_names || '', m.id_number, w.email || '',
      w.data_id || '', fmtAx(fIni), fmtAx(fFin), cargoAx, w.address || '',
      fmtAx(w.birth_date), w.marital_status || '', w.phone || '', w.gender || '', w.account_number || '',
      w.todo_ticket || '', accion, '',
    ];
  };

  const rows = [];
  for (const m of moves) {
    const ing = ingByCed[m.id_number] || null;
    if (m.tipo === 'egreso') {
      rows.push(baseRow(m, 'B', axOf(m.cargo_from), ing, m.fecha_baja));
    } else if (m.tipo === 'traslado') {
      // Fila 1: B en origen (ultimo dia). Fila 2: A en destino (primer dia).
      rows.push(baseRow(m, 'B', axOf(m.cargo_from), ing, m.fecha_baja));
      rows.push(baseRow(m, 'A', axOf(m.cargo_to || m.cargo_from), m.fecha_alta, null));
    } else {
      // ascenso / descenso / lateral -> M con el nuevo cargo, ingreso original.
      rows.push(baseRow(m, 'M', axOf(m.cargo_to || m.cargo_from), ing, null));
    }
  }

  // Marcar exportados.
  const doneIds = moves.map(m => m.id).filter(Boolean);
  if (doneIds.length) {
    await sb(env, `personnel_movement_requests?id=in.(${doneIds.join(',')})`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ estado: 'exportado', exported_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return json({ ok: true, columns: AX_COLUMNS, rows, filename: `MODIFICACIONES_CAMBIO_CARGO_${stamp}.xlsx`, exported: doneIds.length });
}
