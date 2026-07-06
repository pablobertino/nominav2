/* =====================================================================
   functions/api/ax-roster.js  →  POST /api/ax-roster
   TERCERA VIA de carga de personal: trae el roster EN VIVO desde la API
   de empleados de AX (api2.grupocanaima.com), por alias de empresa/tienda.
   Independiente del Reporte 10 y del Reporte AX (Excel).

   Ventaja sobre el Excel AX: la API SI trae el cargo (idCargo) y el
   desglose de nombre/apellidos ya resuelto.

   Solo admin/superadmin. Escribe en store_workers (tiendas) o
   enterprise_workers (no-tienda) segun el tipo de la empresa, con la
   politica "EL ULTIMO REPORTE MANDA": el roster que devuelve la API
   redefine la lista y todos los campos que la API trae mandan. Los
   manuales cuya cedula no venga se conservan. Sincroniza workers_master
   sin pisar la foto.

   Secrets: canaima_apikey, supabase_url, supabase_service_role
   ===================================================================== */

import { shadowCan } from './_auth.js';

const AX_EMPLEADOS_API = 'https://api2.grupocanaima.com/empleados/datos/v1';

// Tipos de empresa que NO son tienda (van a enterprise_workers).
const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

/* --- Supabase REST con service_role --- */
async function sb(env, path, opts = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Profile': 'nomina_v2',
      'Accept-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

/* --- Auth: solo admin/superadmin con alcance sobre la empresa --- */
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

/* --- Helpers de normalizacion (mismos criterios que el parser AX) --- */
function genderCode(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (s.startsWith('MASC') || s === 'M') return 'M';
  if (s.startsWith('FEM') || s === 'F') return 'F';
  return null;
}
function maritalCode(raw) {
  const s = String(raw || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  if (s.startsWith('SOLTER')) return 'S';
  if (s.startsWith('CASAD')) return 'C';
  if (s.startsWith('DIVORCIAD')) return 'D';
  if (s.startsWith('VIUD')) return 'V';
  return null;
}
// API: todoTicket viene "Y" / "N".
function todoTicketCode(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (s === 'Y' || s === 'S' || s === 'SI') return 'S';
  if (s === 'N' || s === 'NO') return 'N';
  return null;
}
// Fecha: la API trae ISO con hora ("2001-06-23T12:00:00"); cortar a 10.
function dateOrNull(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
// finContrato 2154-12-31 (o anio >= 2100) => vigente => null.
function endDateOrNull(v) {
  const iso = dateOrNull(v);
  if (!iso) return null;
  return parseInt(iso.slice(0, 4), 10) >= 2100 ? null : iso;
}
function accountDigits(v) {
  const d = String(v || '').replace(/[^0-9]/g, '');
  return d.length === 20 ? d : null;
}

/* Mapea un objeto empleado de la API a nuestra fila normalizada.
   ficha = cedula (id_number); dataArea = data_id; idCargo = role;
   segundoApellido = apellidos completos (last_names); primerApellido se
   guarda en first_lastname para el nombre corto. */
function mapApiEmployee(e) {
  const id_number = String(e.ficha ?? '').replace(/[^0-9]/g, '');
  const first_name = (e.primerNombre || '').toString().trim().toUpperCase() || null;
  const second_name = (e.segundoNombre || '').toString().trim().toUpperCase() || null;
  // "Apellidos" completos vienen en segundoApellido; fallback a primerApellido.
  const last_names = ((e.segundoApellido || e.primerApellido || '').toString().trim().toUpperCase()) || null;
  const first_lastname = (e.primerApellido || '').toString().trim().toUpperCase() || null;
  const full_name = (e.nombreCompleto || [first_name, second_name, last_names].filter(Boolean).join(' ')).toString().trim().toUpperCase();
  const account_number = accountDigits(e.cuentaBancaria);
  return {
    id_number,
    full_name,
    first_name, second_name, last_names, first_lastname,
    role: (e.idCargo || '').toString().trim().toUpperCase() || null,
    birth_date: dateOrNull(e.fechaNacimiento),
    gender: genderCode(e.genero),
    marital_status: maritalCode(e.estadoCivil),
    account_number,
    bank_code: account_number ? account_number.slice(0, 4) : null,
    todo_ticket: todoTicketCode(e.todoTicket),
    start_date: dateOrNull(e.inicioContrato),
    end_date: endDateOrNull(e.finContrato),
    data_id: (e.dataArea || '').toString().trim() || null,
  };
}

/* Upsert condicional a workers_master por cedula (global, sin empresa).
   No pisa la foto; agrega datos personales solo si vienen con valor.
   "El ultimo reporte manda" en lo que la API trae con valor. */
async function upsertWorkersMaster(env, cc, rows) {
  if (!rows.length) return 0;
  // IMPORTANTE: PostgREST (PGRST102) exige que TODAS las filas del lote
  // tengan EXACTAMENTE el mismo conjunto de claves. Por eso aqui cada fila
  // incluye SIEMPRE las mismas columnas (con null cuando no hay valor), en
  // vez de agregarlas condicionalmente. Como la regla es "el ultimo reporte
  // manda" y la API trae todos estos campos, pisar con null es lo correcto.
  // phone/email/address y photo_* NO se incluyen nunca -> se preservan.
  const payload = rows.map(r => ({
    id_number: r.id_number,
    ced_kind: (/^\d+$/.test(r.id_number) && Number(r.id_number) >= 80000000) ? 'E' : 'V',
    full_name: r.full_name,
    first_name: r.first_name || null,
    second_name: r.second_name || null,
    last_names: r.last_names || null,
    first_lastname: r.first_lastname || null,
    role: r.role || null,
    birth_date: r.birth_date || null,
    gender: r.gender || null,
    marital_status: r.marital_status || null,
    account_number: r.account_number || null,
    bank_code: r.bank_code || null,
    todo_ticket: r.todo_ticket || null,
    data_id: r.data_id || null,
    last_source_company: cc,
  }));
  const res = await fetch(`${env.supabase_url}/rest/v1/workers_master?on_conflict=id_number`, {
    method: 'POST',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`workers_master ${res.status}: ${await res.text()}`);
  return payload.length;
}

// Devuelve el id del departamento "Retail" de una TIENDA (todo el personal de
// tienda pertenece a Retail por regla del negocio). Lo crea si no existe.
// Devuelve null solo si la creacion fallara (no bloquea la carga).
async function retailDeptId(env, cc) {
  const existing = await sb(env,
    `departments?company_code=eq.${encodeURIComponent(cc)}&name=eq.Retail&select=id&limit=1`);
  if (existing && existing.length) return existing[0].id;
  try {
    const created = await sb(env, 'departments', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ company_code: cc, name: 'Retail' }),
    });
    return created && created[0] ? created[0].id : null;
  } catch (e) {
    return null;
  }
}

/* Cambios a nivel trabajador entre el roster previo y el nuevo. En la primera
   sincronizacion (sin filas previas) NO genera eventos (seria ruido: todos
   "nuevos"). Detecta: nuevo, removido (ya no viene y no es manual) y cambio
   de estatus activo<->egresado. */
function computeRosterChanges(existingRows, valid) {
  const changes = [];
  if (!existingRows || !existingRows.length) return changes;
  const prev = new Map(existingRows.map(e => [e.id_number, e]));
  const nuevoByCed = new Map(valid.map(v => [v.id_number, v]));
  for (const v of valid) {
    const e = prev.get(v.id_number);
    if (!e) {
      changes.push({ id_number: v.id_number, worker_name: v.full_name || null,
        change_type: 'new', old_value: null, new_value: v.end_date ? 'Egresado' : 'Activo' });
    } else {
      const wasActive = !e.end_date, isActive = !v.end_date;
      if (wasActive !== isActive) {
        changes.push({ id_number: v.id_number, worker_name: v.full_name || e.full_name || null,
          change_type: 'status', old_value: wasActive ? 'Activo' : 'Egresado',
          new_value: isActive ? 'Activo' : 'Egresado' });
      }
    }
  }
  for (const e of existingRows) {
    if (!nuevoByCed.has(e.id_number) && e.source !== 'manual') {
      changes.push({ id_number: e.id_number, worker_name: e.full_name || null,
        change_type: 'removed', old_value: e.end_date ? 'Egresado' : 'Activo', new_value: null });
    }
  }
  return changes;
}

/* Registra una corrida de roster en roster_run + roster_change. No rompe la
   respuesta del sync si el log falla. */
async function recordRosterRun(env, { cc, status, source, triggered_by, result, error, changes, duration_ms }) {
  const base = {
    apikey: env.supabase_service_role,
    Authorization: `Bearer ${env.supabase_service_role}`,
    'Content-Profile': 'nomina_v2',
    'Content-Type': 'application/json',
  };
  const finished = new Date();
  const startedAt = new Date(finished.getTime() - (duration_ms || 0));
  const changesCount = (changes && changes.length) || 0;
  try {
    let runId = null;
    const res = await fetch(`${env.supabase_url}/rest/v1/roster_run`, {
      method: 'POST', headers: { ...base, Prefer: 'return=representation' },
      body: JSON.stringify({
        company_code: cc, started_at: startedAt.toISOString(), finished_at: finished.toISOString(),
        status, source, triggered_by: triggered_by ?? null,
        result: result || null, error: error || null,
        changes_count: changesCount, duration_ms: duration_ms ?? null,
      }),
    });
    if (res.ok) { const rows = await res.json(); runId = rows && rows[0] && rows[0].id; }
    if (changesCount && runId) {
      await fetch(`${env.supabase_url}/rest/v1/roster_change`, {
        method: 'POST', headers: { ...base, Prefer: 'return=minimal' },
        body: JSON.stringify(changes.map(c => ({ ...c, run_id: runId, company_code: cc }))),
      });
    }
  } catch (_) { /* el log no debe afectar el roster */ }
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  const cc = (body.company_code || '').trim();
  if (!cc) return json({ ok: false, error: 'Falta company_code.' }, 400);

  // Auth: solo admin/superadmin con alcance.
  const admin = await getAdmin(env, body.adminId);
  if (!admin) return json({ ok: false, error: 'La carga desde AX solo la hace un administrador.' }, 401);

  // SHADOW: gate legacy binario = admin activo (getAdmin). El alcance por
  // empresa (allowed) se evalua aparte, no en el shadow. Code roster.upload_api.
  await shadowCan(env, body.adminId, 'ax-roster', 'pull', 'roster.upload_api', !!admin);

  const allowed = await allowedCompanies(env, admin);
  if (allowed !== null && !allowed.has(cc)) {
    return json({ ok: false, error: 'No tienes alcance sobre esa empresa.' }, 403);
  }

  // La empresa debe existir; su tipo decide la tabla destino.
  let company;
  try {
    const rows = await sb(env, `companies?company_code=eq.${encodeURIComponent(cc)}&select=company_code,business_name,company_type`);
    company = rows && rows[0];
  } catch (e) {
    return json({ ok: false, error: 'Error consultando la empresa: ' + e.message }, 500);
  }
  if (!company) return json({ ok: false, error: `La empresa ${cc} no existe en el catalogo.` }, 404);
  const isStore = !NON_STORE_TYPES.has(company.company_type);
  const table = isStore ? 'store_workers' : 'enterprise_workers';

  const started = Date.now();
  const source = body.source === 'bulk' ? 'bulk' : 'manual';

  // Cooldown anti-abuso (misma regla que el sync de empresas), POR EMPRESA.
  // Solo cuentan las corridas OK; un fallo no bloquea el reintento.
  try {
    const cfgRows = await sb(env, 'sync_config?id=eq.1&select=manual_cooldown_value,manual_cooldown_unit');
    const cfg = cfgRows && cfgRows[0];
    if (cfg) {
      const unitMs = { minutes: 60000, hours: 3600000, days: 86400000 };
      const cdMs = (cfg.manual_cooldown_value || 0) * (unitMs[cfg.manual_cooldown_unit] || 60000);
      if (cdMs > 0) {
        const lastRows = await sb(env,
          `roster_run?company_code=eq.${encodeURIComponent(cc)}&status=eq.ok&order=finished_at.desc&limit=1&select=finished_at`);
        const last = lastRows && lastRows[0] && lastRows[0].finished_at;
        if (last) {
          const elapsed = Date.now() - new Date(last).getTime();
          if (elapsed < cdMs) {
            const retryAt = new Date(new Date(last).getTime() + cdMs).toISOString();
            return json({
              ok: false, error: 'cooldown', company_code: cc,
              last_at: last, retry_at: retryAt,
              message: 'Esta empresa se sincronizo hace poco. Espera antes de volver a intentar.',
            }, 429);
          }
        }
      }
    }
  } catch (_) { /* si falla la verificacion, no bloquea */ }

  // Llamar a la API de empleados de AX (misma key que sync-companies).
  let apiData;
  try {
    const url = `${AX_EMPLEADOS_API}?alias=${encodeURIComponent(cc)}`;
    const apiRes = await fetch(url, {
      headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
    });
    if (!apiRes.ok) {
      await recordRosterRun(env, { cc, status: 'error', source, triggered_by: admin.id, error: `API AX ${apiRes.status}`, duration_ms: Date.now() - started });
      return json({ ok: false, error: `La API de AX respondio ${apiRes.status}.` }, 502);
    }
    apiData = await apiRes.json();
  } catch (e) {
    await recordRosterRun(env, { cc, status: 'error', source, triggered_by: admin.id, error: 'API AX: ' + e.message, duration_ms: Date.now() - started });
    return json({ ok: false, error: 'No se pudo conectar con la API de AX: ' + e.message }, 502);
  }
  if (!Array.isArray(apiData)) apiData = apiData.empleados || apiData.data || apiData.items || [];

  // Normalizar + dedup por cedula.
  const warnings = [];
  const seen = new Set();
  const valid = [];
  for (const raw of apiData) {
    const r = mapApiEmployee(raw);
    if (!r.id_number || r.id_number.length < 6 || r.id_number.length > 8) continue;
    if (!r.full_name) continue;
    if (seen.has(r.id_number)) continue;
    seen.add(r.id_number);
    valid.push(r);
  }
  if (!valid.length) {
    await recordRosterRun(env, { cc, status: 'error', source, triggered_by: admin.id, error: 'Sin personal valido', duration_ms: Date.now() - started });
    return json({ ok: false, error: `La API no devolvio personal valido para ${cc}.` }, 200);
  }

  const activos = valid.filter(r => !r.end_date);
  const egresados = valid.filter(r => r.end_date);
  const cedsReporte = new Set(valid.map(r => r.id_number));

  let changes = [];   // cambios a nivel trabajador (se llena en cada rama)
  try {
    if (isStore) {
      // --- TIENDA: store_workers ---
      // Estado previo (para detectar cambios) y manuales a conservar.
      // Incluye department_id: la API no trae departamento, asi que se
      // CONSERVA el que cada persona ya tenia asignado.
      const existingAll = await sb(env,
        `store_workers?company_code=eq.${encodeURIComponent(cc)}&select=id_number,full_name,end_date,source,department_id`) || [];
      changes = computeRosterChanges(existingAll, valid);
      const deptByCed = {};
      existingAll.forEach(e => { if (e.department_id != null) deptByCed[e.id_number] = e.department_id; });
      // Regla del negocio: todo el personal de tienda pertenece a Retail;
      // quien no tenga departamento (nuevo) entra a Retail.
      const retailId = await retailDeptId(env, cc);
      const manualKeep = existingAll.filter(m => m.source === 'manual' && !cedsReporte.has(m.id_number)).map(m => m.id_number);
      if (manualKeep.length) {
        const inList = manualKeep.map(c => `"${c}"`).join(',');
        await sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}&id_number=not.in.(${inList})`, { method: 'DELETE' });
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
        first_lastname: r.first_lastname,
        role: r.role,                 // la API SI trae cargo -> manda
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
        // La API NO trae departamento -> conservar el previo; si no tenia,
        // entra a Retail (regla del negocio para tiendas):
        department_id: deptByCed[r.id_number] || retailId || null,
        source: 'ax_api',
      }));
      await sb(env, 'store_workers', { method: 'POST', body: JSON.stringify(payload) });

      // Sembrar/renovar responsables (gerentes/subgerentes detectados) para
      // que el paso "Responsable" del wizard los tenga. Solo TIENDAS; las
      // empresas no-tienda no usan responsables. No es critico: si falla, el
      // roster ya quedo guardado.
      try {
        await sb(env, 'rpc/seed_store_managers', {
          method: 'POST', body: JSON.stringify({ p_company_code: cc }),
        });
      } catch (e) {
        warnings.push('Responsables no sembrados: ' + String(e.message || e));
      }
    } else {
      // --- EMPRESA NO-TIENDA: enterprise_workers ---
      // Conservar telefono/correo/direccion/department_id previos (la API no
      // los trae). El cargo SI lo trae la API, asi que aqui manda.
      const existing = await sb(env,
        `enterprise_workers?company_code=eq.${encodeURIComponent(cc)}&select=id_number,phone,email,address,department_id,full_name,end_date,source`) || [];
      changes = computeRosterChanges(existing, valid);
      const prevByCed = {};
      existing.forEach(e => { prevByCed[e.id_number] = e; });
      await sb(env, `enterprise_workers?company_code=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });
      const payload = valid.map(r => {
        const prev = prevByCed[r.id_number] || {};
        return {
          company_code: cc,
          id_number: r.id_number,
          full_name: r.full_name,
          first_name: r.first_name,
          second_name: r.second_name,
          last_names: r.last_names,
          first_lastname: r.first_lastname,
          role: r.role,               // la API trae cargo -> manda
          birth_date: r.birth_date,
          gender: r.gender,
          marital_status: r.marital_status,
          account_number: r.account_number,
          bank_code: r.bank_code,
          todo_ticket: r.todo_ticket,
          start_date: r.start_date,
          end_date: r.end_date,
          data_id: r.data_id,
          is_active: !r.end_date,
          has_biometric: true,
          // La API no los trae -> conservar previos:
          phone: prev.phone || null,
          email: prev.email || null,
          address: prev.address || null,
          department_id: prev.department_id || null,
          source: 'ax_api',
        };
      });
      await sb(env, 'enterprise_workers', { method: 'POST', body: JSON.stringify(payload) });
    }

    // Sincronizar workers_master (no pisa foto).
    let masterSynced = 0;
    try { masterSynced = await upsertWorkersMaster(env, cc, valid); }
    catch (e) { warnings.push('Directorio (workers_master) no sincronizado: ' + String(e.message || e)); }

    // Metadatos del snapshot (tabla segun tipo).
    const metaTable = isStore ? 'store_roster_meta' : 'enterprise_roster_meta';
    const metaRow = isStore
      ? {
          company_code: cc,
          uploaded_at: new Date().toISOString(),
          uploaded_by: (body.uploaded_by || '').trim() || null,
          total_count: valid.length,
          active_count: activos.length,
          source_file: 'API AX (en vivo)',
          source: 'ax_api',
        }
      : {
          company_code: cc,
          source: 'ax_api',
          source_file: 'API AX (en vivo)',
          uploaded_by: (body.uploaded_by || '').trim() || null,
          uploaded_at: new Date().toISOString(),
          row_count: valid.length,
        };
    await sb(env, metaTable, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(metaRow),
    });

    const summary = {
      total: valid.length,
      active: activos.length,
      terminated: egresados.length,
      with_account: valid.filter(r => r.account_number).length,
      with_role: valid.filter(r => r.role).length,
      master_synced: masterSynced,
      target: table,
      source: 'ax_api',
      warnings,
      changes: changes.length,
    };
    await recordRosterRun(env, { cc, status: 'ok', source, triggered_by: admin.id, result: summary, changes, duration_ms: Date.now() - started });
    return json({ ok: true, summary });
  } catch (e) {
    await recordRosterRun(env, { cc, status: 'error', source, triggered_by: admin.id, error: e.message, duration_ms: Date.now() - started });
    return json({ ok: false, error: 'Error al guardar el roster: ' + e.message }, 500);
  }
}
