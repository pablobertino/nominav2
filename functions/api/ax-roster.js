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

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  const cc = (body.company_code || '').trim();
  if (!cc) return json({ ok: false, error: 'Falta company_code.' }, 400);

  // Auth: solo admin/superadmin con alcance.
  const admin = await getAdmin(env, body.adminId);
  if (!admin) return json({ ok: false, error: 'La carga desde AX solo la hace un administrador.' }, 401);
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

  // Llamar a la API de empleados de AX (misma key que sync-companies).
  let apiData;
  try {
    const url = `${AX_EMPLEADOS_API}?alias=${encodeURIComponent(cc)}`;
    const apiRes = await fetch(url, {
      headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
    });
    if (!apiRes.ok) return json({ ok: false, error: `La API de AX respondio ${apiRes.status}.` }, 502);
    apiData = await apiRes.json();
  } catch (e) {
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
    return json({ ok: false, error: `La API no devolvio personal valido para ${cc}.` }, 200);
  }

  const activos = valid.filter(r => !r.end_date);
  const egresados = valid.filter(r => r.end_date);
  const cedsReporte = new Set(valid.map(r => r.id_number));

  try {
    if (isStore) {
      // --- TIENDA: store_workers ---
      // Conservar manuales cuya cedula no venga en el reporte de la API.
      const manualNow = await sb(env,
        `store_workers?company_code=eq.${encodeURIComponent(cc)}&source=eq.manual&select=id_number`);
      const manualKeep = (manualNow || []).filter(m => !cedsReporte.has(m.id_number)).map(m => m.id_number);
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
        source: 'ax_api',
      }));
      await sb(env, 'store_workers', { method: 'POST', body: JSON.stringify(payload) });
    } else {
      // --- EMPRESA NO-TIENDA: enterprise_workers ---
      // Conservar telefono/correo/direccion/department_id previos (la API no
      // los trae). El cargo SI lo trae la API, asi que aqui manda.
      const existing = await sb(env,
        `enterprise_workers?company_code=eq.${encodeURIComponent(cc)}&select=id_number,phone,email,address,department_id`);
      const prevByCed = {};
      (existing || []).forEach(e => { prevByCed[e.id_number] = e; });
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

    return json({
      ok: true,
      summary: {
        total: valid.length,
        active: activos.length,
        terminated: egresados.length,
        with_account: valid.filter(r => r.account_number).length,
        with_role: valid.filter(r => r.role).length,
        master_synced: masterSynced,
        target: table,
        source: 'ax_api',
        warnings,
      },
    });
  } catch (e) {
    return json({ ok: false, error: 'Error al guardar el roster: ' + e.message }, 500);
  }
}
