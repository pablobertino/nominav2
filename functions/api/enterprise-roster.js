/* =====================================================================
   functions/api/enterprise-roster.js  →  /api/enterprise-roster
   Lista de personal de EMPRESAS NO-TIENDA (snapshot del Reporte AX).
   El frontend lee el .xlsx con SheetJS y envia las filas ya extraidas;
   este Worker valida y aplica la carga sobre enterprise_workers, con
   MERGE NO DESTRUCTIVO de los campos que el Reporte AX no trae.

   Acciones (POST {action, adminId}):
     - get     : snapshot actual de la empresa + meta.
                 { action:'get', company_code, adminId }
     - replace : reemplaza el roster con las filas del Reporte AX.
                 { action:'replace', company_code, rows, uploaded_by?,
                   source_file?, adminId }
     - clear   : vacia el roster de la empresa (enterprise_workers +
                 enterprise_roster_meta). { action:'clear', company_code, adminId }

   REGLA DE CARGA (Reporte AX) — "EL AX MANDA":
     - El Reporte AX trae: cedula, nombre/desglose, nacimiento, genero,
       estado civil, CUENTA bancaria, TODOTICKET, fechas ingreso/egreso,
       data_id. NO trae: cargo, telefono, correo, direccion.
     - Reemplaza el ROSTER (quienes estan). Para los datos por persona:
       los que el AX TRAE mandan (se toman del reporte); los que NO trae
       (cargo/telefono/correo/direccion) se CONSERVAN del registro previo.
     - workers_master (global por cedula): se actualiza condicionalmente; la
       foto y los datos buenos NUNCA se pisan con null.

   Autorizacion: solo admin/superadmin (no usuarios de tienda). El admin
   debe tener la empresa dentro de su alcance.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { shadowCan } from './_auth.js';

const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);

// Mapa accion -> code. get = lectura (sin code fino); replace/clear son acciones.
const ER_CODE_BY_ACTION = {
  get: 'view.empresas',
  replace: 'roster.upload_ax',
  clear: 'roster.clear',
};

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }); }

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

/* Valida empresa: existe, es NO-tienda y esta dentro del alcance. */
async function checkCompany(env, code, allowed) {
  if (!code) return { ok: false, error: 'Falta la empresa.' };
  const rows = await sb(env, `companies?company_code=eq.${encodeURIComponent(code)}&select=company_code,company_type,business_name`);
  if (!rows || !rows.length) return { ok: false, error: 'Empresa no encontrada.' };
  if (!NON_STORE_TYPES.has(rows[0].company_type)) {
    return { ok: false, error: 'El Reporte AX para empresas solo aplica a empresas que no son tienda.' };
  }
  if (allowed !== null && !allowed.has(code)) {
    return { ok: false, error: 'No tienes alcance sobre esa empresa.' };
  }
  return { ok: true, company: rows[0] };
}

function cedKind(ced) { return parseInt(ced, 10) >= 80000000 ? 'E' : 'V'; }

/* Normaliza una fila del Reporte AX (el front ya la dejo casi lista). */
function normalizeRow(row) {
  const id_number = String(row.id_number ?? '').replace(/[^0-9]/g, '');
  const full_name = String(row.full_name ?? '').trim();
  const first_name = (row.first_name ?? '').toString().trim() || null;
  const second_name = (row.second_name ?? '').toString().trim() || null;
  const last_names = (row.last_names ?? '').toString().trim() || null;
  const birth_date = row.birth_date ? String(row.birth_date).slice(0, 10) : null;
  const gd = String(row.gender ?? '').trim().toUpperCase();
  const gender = (gd === 'M' || gd === 'F') ? gd : null;
  const ms = String(row.marital_status ?? '').trim().toUpperCase();
  const marital_status = ['S', 'C', 'D', 'V'].includes(ms) ? ms : null;
  const start_date = row.start_date ? String(row.start_date).slice(0, 10) : null;
  const end_date = row.end_date ? String(row.end_date).slice(0, 10) : null;
  const data_id = (row.data_id ?? '').toString().trim() || null;
  // Cuenta + todoticket (el AX nuevo SI los trae; se revalidan server-side).
  const accDigits = String(row.account_number ?? '').replace(/[^0-9]/g, '');
  const account_number = accDigits.length === 20 ? accDigits : null;
  const bank_code = account_number ? account_number.slice(0, 4) : null;
  const tt = String(row.todo_ticket ?? '').trim().toUpperCase();
  const todo_ticket = (tt === 'S' || tt === 'N') ? tt : null;
  return { id_number, full_name, first_name, second_name, last_names, birth_date, gender, marital_status, account_number, bank_code, todo_ticket, start_date, end_date, data_id };
}

/* Upsert por cedula en workers_master. IMPORTANTE: PostgREST (PGRST102)
   exige que TODAS las filas del lote tengan el MISMO conjunto de claves.
   Por eso cada fila incluye SIEMPRE las mismas columnas (null si no hay
   valor). El Reporte AX trae estos campos, asi que pisar con null respeta
   "el AX manda". Las columnas photo_* y role/phone/email/address NO van en
   el payload (la foto y lo que el AX no trae se conservan). */
async function upsertWorkersMaster(env, cc, validRows) {
  if (!validRows.length) return 0;
  const payload = validRows.map(r => ({
    id_number: r.id_number,
    ced_kind: cedKind(r.id_number),
    first_name: r.first_name || null,
    second_name: r.second_name || null,
    last_names: r.last_names || null,
    full_name: r.full_name,
    birth_date: r.birth_date || null,
    gender: r.gender || null,
    marital_status: r.marital_status || null,
    account_number: r.account_number || null,
    bank_code: r.bank_code || null,
    todo_ticket: r.todo_ticket || null,
    data_id: r.data_id || null,
    last_source_company: cc,
  }));
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
    const admin = await getAdmin(env, body.adminId);
    if (!admin) return json({ ok: false, error: 'Requiere un administrador.' }, 401);

    // SHADOW: gate legacy binario = admin activo (getAdmin). El alcance por
    // empresa (checkCompany) se evalua aparte. Code fino por accion.
    await shadowCan(env, body.adminId, 'enterprise-roster', action || '?', ER_CODE_BY_ACTION[action] || 'view.empresas', !!admin);

    const allowed = await allowedCompanies(env, admin);

    if (action === 'get') {
      const cc = (body.company_code || '').trim();
      const chk = await checkCompany(env, cc, allowed);
      if (!chk.ok) return json(chk, 403);
      const workers = await sb(env,
        `enterprise_workers?company_code=eq.${encodeURIComponent(cc)}`
        + `&select=id_number,full_name,role,department_id,has_biometric,start_date,end_date,is_active,account_number,bank_code,todo_ticket,phone,email,gender,marital_status,birth_date,address,data_id,first_name,second_name,last_names,source&order=full_name.asc`);
      // Red de seguridad: asegurar que workers_master (de donde la ficha lee
      // los datos personales) tenga a estas personas. Si una carga previa no
      // alcanzo a poblar la maestra, esto la repara al abrir la vista.
      try { await upsertWorkersMaster(env, cc, (workers || [])); } catch (e) { /* no critico */ }
      const metaArr = await sb(env,
        `enterprise_roster_meta?company_code=eq.${encodeURIComponent(cc)}&select=uploaded_at,uploaded_by,row_count,source,source_file`);
      const meta = metaArr && metaArr[0] ? metaArr[0] : null;
      return json({ ok: true, workers: workers || [], meta, company: chk.company });
    }

    if (action === 'replace') {
      const cc = (body.company_code || '').trim();
      const chk = await checkCompany(env, cc, allowed);
      if (!chk.ok) return json(chk, 403);

      const rawRows = Array.isArray(body.rows) ? body.rows : [];
      if (!rawRows.length) return json({ ok: false, error: 'El Reporte AX no trae filas.' }, 400);

      // Validacion + dedup.
      const warnings = [];
      const seen = new Set();
      const valid = [];
      for (const raw of rawRows) {
        const r = normalizeRow(raw);
        if (!r.id_number || r.id_number.length < 6 || r.id_number.length > 8) continue;
        if (!r.full_name) continue;
        if (seen.has(r.id_number)) continue;
        seen.add(r.id_number);
        valid.push(r);
      }
      if (!valid.length) return json({ ok: false, error: 'Ninguna fila valida (revisa Numero de personal y Nombre).' }, 400);

      const activos = valid.filter(r => !r.end_date);
      const egresados = valid.filter(r => r.end_date);

      // --- MERGE: "EL AX MANDA" para lo que trae; preserva lo que no trae ---
      // El Reporte AX NUEVO trae: identidad, nombres, nacimiento, genero,
      // estado civil, CUENTA, TODOTICKET, fechas, data_id => esos MANDAN
      // (se toman del reporte, incluso si vienen vacios).
      // El AX NO trae: cargo (role), telefono, correo, direccion,
      // department_id => esos se CONSERVAN del registro previo por cedula.
      const existing = await sb(env,
        `enterprise_workers?company_code=eq.${encodeURIComponent(cc)}`
        + `&select=id_number,role,phone,email,address,department_id`);
      const prevByCed = {};
      (existing || []).forEach(e => { prevByCed[e.id_number] = e; });

      // Reemplazo del roster: borramos todo el de la empresa y reinsertamos
      // (con los datos preservados ya mezclados). Tabla nueva, sin riesgo.
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
          // El AX MANDA (se toman del reporte):
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
          // El AX NO los trae -> conservar lo previo:
          role: prev.role || null,
          phone: prev.phone || null,
          email: prev.email || null,
          address: prev.address || null,
          department_id: prev.department_id || null,
          source: 'reporte_ax',
        };
      });
      await sb(env, 'enterprise_workers', { method: 'POST', body: JSON.stringify(payload) });

      // Sincronizar workers_master por cedula (foto/datos buenos intactos).
      let masterSynced = 0;
      try {
        masterSynced = await upsertWorkersMaster(env, cc, valid);
      } catch (e) {
        warnings.push('Directorio (workers_master) no sincronizado: ' + String(e.message || e));
      }

      // Meta de carga (upsert por company_code).
      await sb(env, 'enterprise_roster_meta', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          company_code: cc,
          source: 'reporte_ax',
          source_file: (body.source_file || '').trim() || null,
          uploaded_by: (body.uploaded_by || '').trim() || null,
          uploaded_at: new Date().toISOString(),
          row_count: valid.length,
        }),
      });

      return json({
        ok: true,
        summary: {
          total: valid.length,
          active: activos.length,
          terminated: egresados.length,
          master_synced: masterSynced,
          warnings,
        },
      });
    }

    if (action === 'clear') {
      const cc = (body.company_code || '').trim();
      const chk = await checkCompany(env, cc, allowed);
      if (!chk.ok) return json(chk, 403);
      // v4.51: limpiar la lista es mantenimiento reservado al SUPERADMIN
      // (decision de Pablo 2026-07-09; el permiso roster.clear existe en la
      // matriz pero por defecto NADIE lo tiene: superadmin pasa por diseno).
      // El shadow ya queda registrado por el mapa ER_CODE_BY_ACTION de arriba.
      if (!admin || admin.role !== 'superadmin') {
        return json({ ok: false, error: 'Limpiar la lista es una accion de mantenimiento reservada al superadministrador.' }, 403);
      }
      await sb(env, `enterprise_workers?company_code=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });
      await sb(env, `enterprise_roster_meta?company_code=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });
      return json({ ok: true, cleared: true });
    }

    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
