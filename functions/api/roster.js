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
  return { id_number, full_name, role, end_date, start_date, has_biometric, account_number, todo_ticket, data_id, first_name, second_name, last_names };
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
  const payload = validRows.map(r => ({
    id_number: r.id_number,
    ced_kind: cedKind(r.id_number),
    first_name: r.first_name,
    second_name: r.second_name,
    last_names: r.last_names,
    full_name: r.full_name,
    role: r.role,
    account_number: r.account_number,
    bank_code: r.account_number ? r.account_number.slice(0, 4) : null,
    todo_ticket: r.todo_ticket,
    data_id: r.data_id,
    last_source_company: cc,
    // OJO: no se incluyen birth_date, gender, marital_status, phone, email,
    // address (el Reporte 10 no los trae) NI las columnas photo_*. Para una
    // cedula nueva nacen en null; para una existente se conservan tal cual
    // (merge-duplicates no toca columnas ausentes del payload).
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

      // --- Reemplazo del snapshot (borra e inserta) ---
      await sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });

      const payload = valid.map(r => ({
        company_code: cc,
        id_number: r.id_number,
        full_name: r.full_name,
        role: r.role,
        has_biometric: r.has_biometric,
        start_date: r.start_date,
        end_date: r.end_date,
        is_active: !r.end_date,
        // Datos personales del Reporte 10 (los que vengan). Las columnas que
        // el archivo aun no trae (telefono, correo, sexo, estado civil,
        // nacimiento, direccion) quedan en null hasta que el POS las exporte.
        account_number: r.account_number,
        todo_ticket: r.todo_ticket,
        data_id: r.data_id,
        first_name: r.first_name,
        second_name: r.second_name,
        last_names: r.last_names,
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
        warnings.push('No se pudo sincronizar el directorio de colaboradores (se reintenta en la proxima carga).');
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

    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
