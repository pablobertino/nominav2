/* =====================================================================
   functions/api/roster.js  →  /api/roster
   Lista de personal de cada tienda (snapshot del Reporte 10 del POS).
   El frontend lee el .xlsx con SheetJS y envia las filas ya extraidas
   como JSON; este Worker valida, detecta egresados y responsables
   (segun las reglas configurables de manager_role_rules), y REEMPLAZA
   por completo el snapshot.

   Acciones (POST {action}):
     - get     : devuelve el snapshot actual + metadatos de la tienda.
                 { action:'get', company_code }
     - replace : valida y reemplaza el snapshot con las filas del Reporte 10.
                 { action:'replace', company_code, uploaded_by?, source_file?,
                   rows:[{ id_number, full_name, role, has_biometric,
                           start_date, end_date }] }
                 Devuelve un resumen de validacion (cuantos, egresados,
                 responsables detectados) y precarga store_contacts con los
                 gerentes/subgerentes si la tienda no tiene responsables.
     - clear   : borra COMPLETAMENTE la lista de la tienda (store_workers +
                 store_roster_meta). Opcionalmente tambien los responsables.
                 { action:'clear', company_code, wipe_contacts? }

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

// --- Auth helpers (para la carga por Reporte AX en tienda, solo admin) ---
// El Reporte AX en tienda lo cargan SOLO admin/superadmin. Estos helpers
// validan el adminId y su alcance (igual patron que enterprise-roster.js).
async function getAdmin(env, adminId) {
  if (!adminId) return null;
  const rows = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id,role`);
  return rows && rows.length ? rows[0] : null;
}
async function allowedCompanies(env, admin) {
  if (admin.role === 'superadmin') return null; // todas
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: admin.id }),
  });
  return new Set((rows || []).map(r => r.company_code));
}

// Valida que el usuario (de la sesion del cliente) tenga acceso a la empresa.
// Sirve para tienda (su propia empresa) y para admin (superadmin = todas;
// resto = get_admin_companies). Mismo criterio que worker-photo.js. Cierra
// las acciones de gestion de lista (replace/clear/add_manual) para que un
// rol con alcance (ej. editor_personal) no toque empresas fuera del suyo.
async function userCanAccess(env, user, cc) {
  if (!user || !cc) return false;
  if (user.kind === 'company') return String(user.companyCode || '') === String(cc);
  if (user.kind === 'admin' && user.id) {
    const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role`);
    if (!a || !a.length) return false;
    if (a[0].role === 'superadmin') return true;
    const rows = await sb(env, 'rpc/get_admin_companies', {
      method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
    });
    return (rows || []).some(r => r.company_code === cc);
  }
  return false;
}

// Normaliza texto de cargo para comparar con patrones: mayusculas, sin
// acentos, espacios colapsados. Igual que guarda el ABM (cargo_save).
function normCargo(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

// Resuelve el cargo del Reporte 10 contra el catalogo configurable
// (cargo_patterns -> cargos). 'cat' es el indice precargado por
// loadCargoCatalog(): { patterns:[{pattern,cargo}], ... } ordenado por
// especificidad (sort_order asc, lo mas especifico primero). Gana el PRIMER
// patron contenido en el cargo. Devuelve el cargo resuelto o null.
//   cargo = { code, label, ax_code, can_be_responsible, responsible_role }
function resolveCargo(rawRole, cat) {
  const r = normCargo(rawRole);
  if (!r || !cat || !cat.patterns.length) return null;
  for (const p of cat.patterns) {
    if (p.pattern && r.includes(p.pattern)) return p.cargo;
  }
  return null;
}

// Detecta SOLO el rol de responsable. Prioridad:
//   1) catalogo de cargos (cargo_patterns) si esta poblado;
//   2) manager_role_rules (reglas viejas) como respaldo;
//   3) logica clasica GERENTE/SUB si todo lo anterior esta vacio.
// Asi el cambio es seguro aunque el catalogo nuevo aun no tenga patrones.
function detectManagerRole(rawRole, rules, cat) {
  // 1) catalogo de cargos
  if (cat && cat.patterns.length) {
    const c = resolveCargo(rawRole, cat);
    if (c) return c.can_be_responsible ? (c.responsible_role || null) : null;
    // si el catalogo existe pero el cargo no matchea ninguno, no es responsable
    return null;
  }
  // 2) reglas viejas
  const r = (rawRole || '').toUpperCase();
  if (!r) return null;
  if (Array.isArray(rules) && rules.length) {
    for (const rule of rules) {
      const pat = String(rule.pattern || '').toUpperCase().trim();
      if (pat && r.includes(pat)) return rule.result_role;
    }
    return null;
  }
  // 3) Fallback defensivo (todo vacio): logica original.
  if (!r.includes('GERENTE')) return null;
  if (r.includes('SUB')) return 'Sub-Gerente';
  return 'Gerente';
}

// Carga el catalogo de cargos + patrones una vez por request y lo deja
// listo para resolveCargo/detectManagerRole. Patrones ordenados por
// sort_order asc (lo mas especifico primero, ej. SUB GERENTE antes que
// GERENTE). Devuelve { patterns:[{pattern,cargo}], byCode:{code->cargo} }.
async function loadCargoCatalog(env) {
  const cargos = await sb(env,
    'cargos?is_active=eq.true&select=id,code,label,ax_code,can_be_responsible,responsible_role');
  const byId = {};
  const byCode = {};
  (cargos || []).forEach(c => {
    const cargo = {
      code: c.code, label: c.label, ax_code: c.ax_code || c.code,
      can_be_responsible: !!c.can_be_responsible, responsible_role: c.responsible_role || null,
    };
    byId[c.id] = cargo; byCode[c.code] = cargo;
  });
  const pats = await sb(env,
    'cargo_patterns?is_active=eq.true&select=pattern,cargo_id,sort_order&order=sort_order.asc');
  const patterns = (pats || [])
    .map(p => ({ pattern: normCargo(p.pattern), cargo: byId[p.cargo_id] }))
    .filter(p => p.pattern && p.cargo);
  return { patterns, byCode };
}

// Normaliza una fila cruda del Reporte 10 a la forma de store_workers.
// Acepta tolerancia en nombres: el frontend ya manda claves limpias.
function normalizeRow(row) {
  const id_number = String(row.id_number ?? '').replace(/[^0-9]/g, '');
  const full_name = String(row.full_name ?? '').trim();
  const role = (row.role ?? '').toString().trim() || null;
  // end_date: el Reporte 10 trae 'VIGENTE' o una fecha; el front ya
  // convierte VIGENTE -> null y las fechas a 'YYYY-MM-DD'.
  const end_date = row.end_date ? String(row.end_date).slice(0, 10) : null;
  const start_date = row.start_date ? String(row.start_date).slice(0, 10) : null;
  const has_biometric = row.has_biometric == null ? true : !!row.has_biometric;
  // Datos personales nuevos del Reporte 10 (el front ya los normalizo).
  // Pueden venir null si la columna no estaba o el valor no era valido.
  // Se revalidan defensivamente aqui (no confiar solo en el cliente).
  const accDigits = String(row.account_number ?? '').replace(/[^0-9]/g, '');
  const account_number = accDigits.length === 20 ? accDigits : null;
  const tt = String(row.todo_ticket ?? '').trim().toUpperCase();
  const todo_ticket = (tt === 'S' || tt === 'N') ? tt : null;
  const data_id = (row.data_id ?? '').toString().trim() || null;
  // Nombre dividido (el front ya lo separo con la heuristica 2-apellidos).
  const first_name = (row.first_name ?? '').toString().trim() || null;
  const second_name = (row.second_name ?? '').toString().trim() || null;
  const last_names = (row.last_names ?? '').toString().trim() || null;
  // Datos personales del Reporte 10 ampliado (el front ya los normalizo;
  // se revalidan aqui para no confiar solo en el cliente).
  //  - marital_status: 'S'|'C'|'D'|'V' o null.
  //  - gender: 'M'|'F' o null.
  //  - phone: 11 digitos 04XXXXXXXXX o null.
  //  - email: formato valido o null.
  //  - birth_date / address: tal cual (null si vacio).
  const ms = String(row.marital_status ?? '').trim().toUpperCase();
  const marital_status = ['S', 'C', 'D', 'V'].includes(ms) ? ms : null;
  const gd = String(row.gender ?? '').trim().toUpperCase();
  const gender = (gd === 'M' || gd === 'F') ? gd : null;
  const phDigits = String(row.phone ?? '').replace(/[^0-9]/g, '');
  const phone = (phDigits.length === 11 && phDigits[0] === '0' && phDigits[1] === '4') ? phDigits : null;
  const em = String(row.email ?? '').trim().toLowerCase();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) ? em : null;
  const birth_date = row.birth_date ? String(row.birth_date).slice(0, 10) : null;
  const address = (row.address ?? '').toString().trim() || null;
  return {
    id_number, full_name, role, end_date, start_date, has_biometric,
    account_number, todo_ticket, data_id, first_name, second_name, last_names,
    marital_status, gender, phone, email, birth_date, address,
  };
}

// Normaliza una fila del REPORTE AX para store_workers. A diferencia del
// Reporte 10, el AX NO trae cargo (role), telefono, correo ni direccion;
// SI trae identidad, nacimiento, genero, estado civil, cuenta, todoticket,
// fechas y data_id. Los campos que el AX no trae quedan undefined aqui y se
// resuelven en el handler (el cargo se conserva del registro previo).
function normalizeRowAX(row) {
  const id_number = String(row.id_number ?? '').replace(/[^0-9]/g, '');
  const full_name = String(row.full_name ?? '').trim();
  const first_name = (row.first_name ?? '').toString().trim() || null;
  const second_name = (row.second_name ?? '').toString().trim() || null;
  const last_names = (row.last_names ?? '').toString().trim() || null;
  const birth_date = row.birth_date ? String(row.birth_date).slice(0, 10) : null;
  const start_date = row.start_date ? String(row.start_date).slice(0, 10) : null;
  const end_date = row.end_date ? String(row.end_date).slice(0, 10) : null;
  const gd = String(row.gender ?? '').trim().toUpperCase();
  const gender = (gd === 'M' || gd === 'F') ? gd : null;
  const ms = String(row.marital_status ?? '').trim().toUpperCase();
  const marital_status = ['S', 'C', 'D', 'V'].includes(ms) ? ms : null;
  const accDigits = String(row.account_number ?? '').replace(/[^0-9]/g, '');
  const account_number = accDigits.length === 20 ? accDigits : null;
  const tt = String(row.todo_ticket ?? '').trim().toUpperCase();
  const todo_ticket = (tt === 'S' || tt === 'N') ? tt : null;
  const data_id = (row.data_id ?? '').toString().trim() || null;
  return {
    id_number, full_name, first_name, second_name, last_names,
    birth_date, start_date, end_date, gender, marital_status,
    account_number, todo_ticket, data_id,
  };
}

// Deriva V/E de la cedula: >= 80.000.000 -> E, si no V (misma regla que
// usa el resto del sistema, ej. submitIngreso).
function cedKind(ced) {
  return parseInt(ced, 10) >= 80000000 ? 'E' : 'V';
}

// Upsert por cedula en workers_master (el registro PERMANENTE de la persona,
// sin empresa). Se llama tras reemplazar store_workers: por cada trabajador
// del Reporte 10, si su cedula no existe en la maestra se inserta; si existe,
// se ACTUALIZAN sus datos con los del reporte (el mas reciente gana). Las
// columnas de foto (photo_*) NO van en el payload, asi el merge de PostgREST
// las deja intactas -> la foto nunca se pisa. Tampoco se manda created_at
// (default en insert; en update se conserva). updated_at lo refresca el
// trigger. last_source_company anota que tienda hizo la ultima carga.
//
// No es critico para la carga del roster: si fallara, el roster ya quedo
// guardado; el upsert se reintenta en la proxima carga. Por eso el llamador
// lo envuelve en try/catch y solo acumula un warning.
async function upsertWorkersMaster(env, cc, validRows) {
  if (!validRows.length) return 0;
  // IMPORTANTE: PostgREST (PGRST102) exige que TODAS las filas del lote
  // tengan EXACTAMENTE el mismo conjunto de claves. Por eso cada fila
  // incluye SIEMPRE las mismas columnas (null si no hay valor). Las columnas
  // photo_* NUNCA van en el payload: el merge las deja intactas y la foto
  // nunca se pisa. Con la politica "el ultimo reporte manda", enviar null
  // cuando el reporte no trae el dato es el comportamiento correcto.
  const payload = validRows.map(r => ({
    id_number: r.id_number,
    ced_kind: cedKind(r.id_number),
    first_name: r.first_name || null,
    second_name: r.second_name || null,
    last_names: r.last_names || null,
    full_name: r.full_name,
    role: r.role || null,
    account_number: r.account_number || null,
    bank_code: r.account_number ? r.account_number.slice(0, 4) : null,
    todo_ticket: r.todo_ticket || null,
    data_id: r.data_id || null,
    phone: r.phone || null,
    email: r.email || null,
    gender: r.gender || null,
    marital_status: r.marital_status || null,
    birth_date: r.birth_date || null,
    address: r.address || null,
    last_source_company: cc,
  }));
  // on_conflict=id_number + merge-duplicates: inserta o actualiza por cedula.
  await sb(env, 'workers_master?on_conflict=id_number', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(payload),
  });
  return payload.length;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido' }, 400); }

  const action = body.action;
  try {
    if (action === 'get') {
      const cc = (body.company_code || '').trim();
      if (!cc) return json({ ok: false, error: 'Falta company_code' }, 400);
      const workers = await sb(env,
        `store_workers?company_code=eq.${encodeURIComponent(cc)}`
        + `&select=id_number,full_name,role,has_biometric,start_date,end_date,is_active,account_number,phone,email,gender,marital_status,birth_date,address,todo_ticket,data_id,first_name,second_name,last_names&order=full_name.asc`);
      // Marcar cada trabajador con su rol de responsable detectado
      // (manager_role: 'Gerente'|'Sub-Gerente'|null) y, si el catalogo de
      // cargos lo resuelve, tambien el cargo canonico (cargo_code/label)
      // ademas del texto crudo del Reporte 10. Una sola fuente de verdad:
      // el catalogo configurable (cargo_patterns -> cargos), con respaldo
      // en manager_role_rules. El front ordena/destaca sin conocer patrones.
      const cargoCat = await loadCargoCatalog(env);
      const roleRules = await sb(env,
        'manager_role_rules?is_active=eq.true&select=pattern,result_role&order=sort_order.asc');
      const out = (workers || []).map(w => {
        const cargo = resolveCargo(w.role, cargoCat);
        return {
          ...w,
          manager_role: detectManagerRole(w.role, roleRules, cargoCat),
          cargo_code: cargo ? cargo.code : null,
          cargo_label: cargo ? cargo.label : null,
        };
      });
      const metaArr = await sb(env,
        `store_roster_meta?company_code=eq.${encodeURIComponent(cc)}`
        + `&select=uploaded_at,uploaded_by,total_count,active_count,source_file`);
      const meta = metaArr && metaArr[0] ? metaArr[0] : null;
      return json({ ok: true, workers: out, meta });
    }

    if (action === 'replace') {
      const cc = (body.company_code || '').trim();
      if (!cc) return json({ ok: false, error: 'Falta company_code' }, 400);
      if (!(await userCanAccess(env, body.user, cc))) return json({ ok: false, error: 'No tienes acceso a esta empresa.' }, 403);
      const rawRows = Array.isArray(body.rows) ? body.rows : [];
      if (!rawRows.length) return json({ ok: false, error: 'El Reporte 10 no trae filas.' }, 400);

      // Validacion + normalizacion
      const warnings = [];
      const seen = new Set();
      const valid = [];
      let noCargo = 0;
      for (const raw of rawRows) {
        const r = normalizeRow(raw);
        // columnas esenciales: cedula y nombre
        if (!r.id_number || r.id_number.length < 6 || r.id_number.length > 8) continue;
        if (!r.full_name) continue;
        if (seen.has(r.id_number)) continue; // dedup por cedula
        seen.add(r.id_number);
        if (!r.role) noCargo++;
        valid.push(r);
      }
      if (!valid.length) return json({ ok: false, error: 'Ninguna fila valida (revisa columnas Cedula y Nombre).' }, 400);
      if (noCargo) warnings.push(`Columna "Cargo" vacia en ${noCargo} fila(s) (se cargan igual).`);

      const activos = valid.filter(r => !r.end_date);
      const egresados = valid.filter(r => r.end_date);

      // Reglas configurables de clasificacion de cargo -> responsable.
      // Prioridad: catalogo de cargos (cargo_patterns) y, como respaldo,
      // manager_role_rules. Si ambos vacios, detectManagerRole cae a la
      // logica clasica GERENTE/SUB.
      const cargoCat = await loadCargoCatalog(env);
      const roleRules = await sb(env,
        'manager_role_rules?is_active=eq.true&select=pattern,result_role&order=sort_order.asc');

      // Responsables detectados (gerentes/subgerentes vigentes)
      const managers = activos
        .map(r => ({ ...r, mrole: detectManagerRole(r.role, roleRules, cargoCat) }))
        .filter(r => r.mrole);
      const nGer = managers.filter(m => m.mrole === 'Gerente').length;
      const nSub = managers.filter(m => m.mrole === 'Sub-Gerente').length;

      // --- Reemplazo del snapshot ---
      // Se reemplazan SOLO las filas de origen Reporte 10 (source 'report10'
      // o legado null). Las filas MANUALES (source 'manual') se CONSERVAN,
      // salvo que el propio Reporte 10 ya traiga esa cedula (entonces el
      // reporte manda y la manual se reemplaza para no duplicar).
      const cedsReporte = new Set(valid.map(r => r.id_number));
      // 1) Manuales actuales de la tienda.
      const manualNow = await sb(env,
        `store_workers?company_code=eq.${encodeURIComponent(cc)}&source=eq.manual&select=id_number`);
      const manualKeep = (manualNow || []).filter(m => !cedsReporte.has(m.id_number)).map(m => m.id_number);
      // 2) Borrar todo lo que NO sea manual-a-conservar:
      //    - las filas report10/legado (se reemplazan), y
      //    - las manuales cuya cedula ahora viene en el Reporte 10.
      if (manualKeep.length) {
        const inList = manualKeep.map(c => `"${c}"`).join(',');
        await sb(env,
          `store_workers?company_code=eq.${encodeURIComponent(cc)}&id_number=not.in.(${inList})`,
          { method: 'DELETE' });
      } else {
        await sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });
      }

      const payload = valid.map(r => ({
        company_code: cc,
        id_number: r.id_number,
        full_name: r.full_name,
        role: r.role,
        has_biometric: r.has_biometric,
        start_date: r.start_date,
        end_date: r.end_date,
        is_active: !r.end_date,
        // Datos personales del Reporte 10 ampliado. El SP nuevo ya trae
        // telefono, correo, sexo, estado civil, nacimiento y direccion; los
        // que no vengan (o no validen) quedan en null.
        account_number: r.account_number,
        todo_ticket: r.todo_ticket,
        data_id: r.data_id,
        first_name: r.first_name,
        second_name: r.second_name,
        last_names: r.last_names,
        phone: r.phone,
        email: r.email,
        gender: r.gender,
        marital_status: r.marital_status,
        birth_date: r.birth_date,
        address: r.address,
        source: 'report10',
      }));
      await sb(env, 'store_workers', { method: 'POST', body: JSON.stringify(payload) });

      // Sincronizar la tabla maestra de colaboradores (workers_master) por
      // cedula. Es el registro permanente de la persona (sin empresa) que
      // sobrevive entre tiendas y guarda la foto. No es critico: si falla,
      // el roster ya quedo guardado y se reintenta en la proxima carga.
      let masterSynced = 0;
      try {
        masterSynced = await upsertWorkersMaster(env, cc, valid);
      } catch (e) {
        // Incluir el mensaje real para diagnosticar (temporal). Si esto vuelve
        // a fallar, el texto del error aparece en el resumen de la carga.
        warnings.push('Directorio (workers_master) no sincronizado: ' + String(e.message || e));
      }

      // Metadatos del snapshot (upsert)
      await sb(env, 'store_roster_meta', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          company_code: cc,
          uploaded_at: new Date().toISOString(),
          uploaded_by: (body.uploaded_by || '').trim() || null,
          total_count: valid.length,
          active_count: activos.length,
          source_file: (body.source_file || '').trim() || null,
          source: 'report10',
        }),
      });

      // Precargar/RENOVAR responsables detectados del Reporte 10.
      // Regla: los responsables con source 'report10' se RENUEVAN con cada
      // carga (se borran los viejos y se siembran los gerentes/subgerentes
      // del nuevo Reporte 10). Los responsables 'manual' (agregados a mano
      // por la tienda/admin) NO se tocan: se conservan siempre.
      // Asi, al subir un Reporte 10 nuevo, los gerentes quedan actualizados
      // sin pisar lo que la tienda gestiono manualmente.
      let contactsSeeded = 0;
      // 1) Borrar (baja logica) los responsables 'report10' previos.
      await sb(env,
        `store_contacts?company_code=eq.${encodeURIComponent(cc)}&source=eq.report10`,
        { method: 'DELETE' });
      // 2) Cuantos 'manual' activos quedan (para respetar el tope de 4).
      const manualLeft = await sb(env,
        `store_contacts?company_code=eq.${encodeURIComponent(cc)}&is_active=eq.true&select=id`);
      const room = Math.max(0, 4 - ((manualLeft && manualLeft.length) || 0));
      // 3) Sembrar los gerentes/subgerentes del nuevo Reporte 10, evitando
      //    duplicar una cedula que ya este como responsable manual.
      if (room > 0 && managers.length) {
        const manualCeds = new Set();
        // Releer los manuales con su cedula para no duplicar.
        const manualRows = await sb(env,
          `store_contacts?company_code=eq.${encodeURIComponent(cc)}&is_active=eq.true&select=id_number`);
        (manualRows || []).forEach(m => { if (m.id_number) manualCeds.add(m.id_number); });
        const seed = managers
          .filter(m => !manualCeds.has(m.id_number))
          .slice(0, room)
          .map(m => ({
            company_code: cc,
            full_name: m.full_name,
            role: m.mrole,
            id_number: m.id_number,
            source: 'report10',
          }));
        if (seed.length) {
          try {
            await sb(env, 'store_contacts', { method: 'POST', body: JSON.stringify(seed) });
            contactsSeeded = seed.length;
          } catch (e) { /* el trigger de max 4 no deberia saltar con <=4 */ }
        }
      }

      return json({
        ok: true,
        summary: {
          total: valid.length,
          active: activos.length,
          terminated: egresados.length,
          managers: managers.length,
          gerentes: nGer,
          subgerentes: nSub,
          contacts_seeded: contactsSeeded,
          master_synced: masterSynced,
          warnings,
        },
      });
    }

    if (action === 'clear') {
      const cc = (body.company_code || '').trim();
      if (!cc) return json({ ok: false, error: 'Falta company_code' }, 400);
      if (!(await userCanAccess(env, body.user, cc))) return json({ ok: false, error: 'No tienes acceso a esta empresa.' }, 403);
      // Borra la lista y sus metadatos. mark_report_lines NO se toca:
      // los reportes ya enviados conservan su detalle historico.
      await sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });
      await sb(env, `store_roster_meta?company_code=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });
      let contactsWiped = false;
      if (body.wipe_contacts) {
        await sb(env, `store_contacts?company_code=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });
        contactsWiped = true;
      }
      return json({ ok: true, cleared: true, contacts_wiped: contactsWiped });
    }

    if (action === 'add_manual') {
      // Alta MANUAL de un colaborador: una cedula que aun no esta en el
      // Reporte 10 del POS. Entra a store_workers (lista de la tienda) y se
      // sincroniza a workers_master (directorio permanente por cedula).
      // Pide lo minimo (cedula + nombre dividido + cargo opcional + estado);
      // el resto de la ficha se completa luego desde Personal.
      const cc = (body.company_code || '').trim();
      if (!cc) return json({ ok: false, error: 'Falta company_code' }, 400);
      if (!(await userCanAccess(env, body.user, cc))) return json({ ok: false, error: 'No tienes acceso a esta empresa.' }, 403);

      const ced = String(body.id_number || '').replace(/[^0-9]/g, '');
      if (!ced || ced.length < 6 || ced.length > 8) {
        return json({ ok: false, error: 'Cedula invalida (6 a 8 digitos).' }, 400);
      }
      // No duplicar dentro de la misma tienda.
      const dup = await sb(env,
        `store_workers?company_code=eq.${encodeURIComponent(cc)}&id_number=eq.${encodeURIComponent(ced)}&select=id_number`);
      if (dup && dup.length) {
        return json({ ok: false, error: 'Esa cedula ya esta en la lista de esta tienda.' }, 409);
      }

      const first = String(body.first_name || '').trim().toUpperCase();
      const second = String(body.second_name || '').trim().toUpperCase();
      const last = String(body.last_names || '').trim().toUpperCase();
      if (!first) return json({ ok: false, error: 'Falta el primer nombre.' }, 400);
      if (!last) return json({ ok: false, error: 'Faltan los apellidos.' }, 400);
      const full_name = [first, second, last].filter(Boolean).join(' ');
      const role = String(body.role || '').trim().toUpperCase() || null;
      const isEgresado = !!body.egresado;
      const today = new Date().toISOString().slice(0, 10);

      // Insertar en store_workers. source='manual' marca que se cargo a mano
      // (lo usa la futura logica de conservar manuales al actualizar).
      const wRow = {
        company_code: cc,
        id_number: ced,
        full_name,
        first_name: first,
        second_name: second || null,
        last_names: last,
        role,
        has_biometric: false,
        start_date: today,
        end_date: isEgresado ? today : null,
        is_active: !isEgresado,
        source: 'manual',
      };
      try {
        await sb(env, 'store_workers', { method: 'POST', body: JSON.stringify([wRow]) });
      } catch (e) {
        // Si la columna 'source' aun no existe en store_workers, reintentar
        // sin ella (compatibilidad: la migracion de 'source' puede no estar).
        const msg = String(e.message || e);
        if (/source/i.test(msg)) {
          delete wRow.source;
          await sb(env, 'store_workers', { method: 'POST', body: JSON.stringify([wRow]) });
        } else {
          throw e;
        }
      }

      // Sincronizar a la maestra por cedula (sin pisar foto ni datos buenos).
      try {
        await upsertWorkersMaster(env, cc, [{
          id_number: ced, full_name, role,
          first_name: first, second_name: second || null, last_names: last,
          account_number: null, todo_ticket: null, data_id: null,
          phone: null, email: null, gender: null, marital_status: null,
          birth_date: null, address: null,
        }]);
      } catch { /* no critico: se reintenta al cargar Reporte 10 */ }

      return json({ ok: true, id_number: ced, full_name, added: true });
    }

    if (action === 'replace_ax') {
      // Carga del REPORTE AX en una TIENDA. Solo admin/superadmin. Escribe en
      // store_workers con la regla "el ultimo reporte manda": el AX redefine
      // el roster y pisa los campos que trae (identidad, nacimiento, genero,
      // estado civil, cuenta, todoticket, fechas, data_id). El CARGO (que el
      // AX no trae) se CONSERVA del registro previo por cedula. Los manuales
      // cuya cedula no venga en el AX se conservan (igual que en replace).
      const cc = (body.company_code || '').trim();
      if (!cc) return json({ ok: false, error: 'Falta company_code' }, 400);

      // Autorizacion: solo admin/superadmin con alcance sobre la tienda.
      const admin = await getAdmin(env, body.adminId);
      if (!admin) return json({ ok: false, error: 'El Reporte AX solo lo carga un administrador.' }, 401);
      const allowed = await allowedCompanies(env, admin);
      if (allowed !== null && !allowed.has(cc)) {
        return json({ ok: false, error: 'No tienes alcance sobre esa tienda.' }, 403);
      }

      const rawRows = Array.isArray(body.rows) ? body.rows : [];
      if (!rawRows.length) return json({ ok: false, error: 'El Reporte AX no trae filas.' }, 400);

      // Validacion + dedup.
      const warnings = [];
      const seen = new Set();
      const valid = [];
      for (const raw of rawRows) {
        const r = normalizeRowAX(raw);
        if (!r.id_number || r.id_number.length < 6 || r.id_number.length > 8) continue;
        if (!r.full_name) continue;
        if (seen.has(r.id_number)) continue;
        seen.add(r.id_number);
        valid.push(r);
      }
      if (!valid.length) return json({ ok: false, error: 'Ninguna fila valida (revisa Numero de personal y Nombre).' }, 400);

      const activos = valid.filter(r => !r.end_date);
      const egresados = valid.filter(r => r.end_date);

      // El AX NO trae cargo: leemos el cargo previo por cedula para conservarlo.
      const prev = await sb(env,
        `store_workers?company_code=eq.${encodeURIComponent(cc)}&select=id_number,role`);
      const roleByCed = {};
      (prev || []).forEach(p => { roleByCed[p.id_number] = p.role || null; });

      // --- Reemplazo del roster (igual politica que replace) ---
      // Se conservan los manuales cuya cedula NO venga en el AX; el resto se
      // reemplaza. Si el AX trae una cedula que estaba manual, el AX manda.
      const cedsReporte = new Set(valid.map(r => r.id_number));
      const manualNow = await sb(env,
        `store_workers?company_code=eq.${encodeURIComponent(cc)}&source=eq.manual&select=id_number`);
      const manualKeep = (manualNow || []).filter(m => !cedsReporte.has(m.id_number)).map(m => m.id_number);
      if (manualKeep.length) {
        const inList = manualKeep.map(c => `"${c}"`).join(',');
        await sb(env,
          `store_workers?company_code=eq.${encodeURIComponent(cc)}&id_number=not.in.(${inList})`,
          { method: 'DELETE' });
      } else {
        await sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });
      }

      const payload = valid.map(r => ({
        company_code: cc,
        id_number: r.id_number,
        full_name: r.full_name,
        first_name: r.first_name,
        second_name: r.second_name,
        last_names: r.last_names,
        // El AX MANDA (se toman del reporte):
        birth_date: r.birth_date,
        gender: r.gender,
        marital_status: r.marital_status,
        account_number: r.account_number,
        todo_ticket: r.todo_ticket,
        start_date: r.start_date,
        end_date: r.end_date,
        data_id: r.data_id,
        is_active: !r.end_date,
        has_biometric: true,
        // El AX NO trae cargo -> se conserva el previo por cedula:
        role: roleByCed[r.id_number] || null,
        // El AX no trae telefono/correo/direccion: no son columnas del
        // reporte, asi que quedan null en la fila nueva (no hay con que
        // pisarlos y la fila se reemplaza). Si se requiere conservarlos,
        // se haria como con el cargo; por ahora la regla acordada es que
        // esos campos viven en la ficha (workers_master) y alli se conservan.
        source: 'reporte_ax',
      }));
      await sb(env, 'store_workers', { method: 'POST', body: JSON.stringify(payload) });

      // Sincronizar workers_master por cedula. Reusa el upsert del Reporte 10
      // (no pisa foto; agrega datos personales solo si vienen con valor).
      let masterSynced = 0;
      try {
        masterSynced = await upsertWorkersMaster(env, cc, valid.map(r => ({
          id_number: r.id_number, full_name: r.full_name,
          first_name: r.first_name, second_name: r.second_name, last_names: r.last_names,
          role: roleByCed[r.id_number] || null,
          account_number: r.account_number, todo_ticket: r.todo_ticket, data_id: r.data_id,
          gender: r.gender, marital_status: r.marital_status, birth_date: r.birth_date,
          phone: null, email: null, address: null,
        })));
      } catch (e) {
        warnings.push('Directorio (workers_master) no sincronizado: ' + String(e.message || e));
      }

      // Metadatos del snapshot. source='reporte_ax' deja constancia de la
      // fuente de la ultima carga de esta tienda.
      await sb(env, 'store_roster_meta', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          company_code: cc,
          uploaded_at: new Date().toISOString(),
          uploaded_by: (body.uploaded_by || '').trim() || null,
          total_count: valid.length,
          active_count: activos.length,
          source_file: (body.source_file || '').trim() || null,
          source: 'reporte_ax',
        }),
      });

      return json({
        ok: true,
        summary: {
          total: valid.length,
          active: activos.length,
          terminated: egresados.length,
          master_synced: masterSynced,
          source: 'reporte_ax',
          warnings,
        },
      });
    }

    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
