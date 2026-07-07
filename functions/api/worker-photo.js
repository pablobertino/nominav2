/* =====================================================================
   functions/api/worker-photo.js  →  /api/worker-photo
   Personal de una empresa: directorio + foto + perfil (workers_master).

   ESQUEMA DE FOTO (a partir de v2.80 - por photo_key uuid):
     - miniatura (300x300) -> bucket PUBLICO 'worker-thumbs', archivo
       "<photo_key>.jpg". URL fija y cacheable, sin firmar. El uuid no
       revela la cedula y, al cambiar la foto, cambia el uuid -> cambia la
       URL -> se invalida el cache. Esta es la que pinta la grilla.
     - version grande (800x800) -> bucket PRIVADO 'worker-photos', archivo
       "full/<photo_key>.jpg". Se firma on-demand solo al abrir el visor o
       exportar a AX (una a la vez, nunca en masa).
   workers_master guarda photo_key + rutas + metadatos, nunca el binario.

   ESQUEMA VIEJO (fallback, sigue vigente): fotos sin photo_key, ambas en el
   bucket privado 'worker-photos' como 'thumb/V-cedula.jpg' y
   'full/V-cedula.jpg'. Se leen firmando on-demand. Se migran con la accion
   'migrate_thumbs' (copia, no borra los originales).

   Acciones (POST {action}):
     - directory      : roster + datos empresa + bancos. Para fotos del
                        esquema nuevo devuelve la URL publica directa de la
                        thumb (sin firmar). Para fotos viejas (sin
                        photo_key) marca needs_sign para que el front las
                        pida con 'sign' (fallback lazy).
     - sign           : firma on-demand (fallback viejo + la full del visor).
     - save           : sube thumb->publico y full->privado con photo_key
                        nuevo, borra la foto nueva anterior.
     - save_profile   : PATCH de los datos de la persona.
     - migrate_thumbs : un solo uso. Copia las fotos viejas al esquema nuevo.
     - remove         : quita la foto (ambos buckets + columnas photo_*).

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { shadowCan } from './_auth.js';
import { hcmRosterRaw, fullHcmPayload } from './_hcm.js';

const BUCKET = 'worker-photos';          // privado: full (y thumb viejas)
const PUBLIC_BUCKET = 'worker-thumbs';   // publico: miniaturas nuevas
const SIGNED_TTL = 60 * 60;          // 1h
const MAX_FULL_BYTES = 400 * 1024;   // tope server-side de la version grande

// ---- Integracion AX (write-back de la ficha hacia AX 2012) ----
// API de empleados HCM (middleware Flask/AIF). Distinta de la de empresas:
// esta vive en api2. Clave en el Secret env.canaima_apikey (nunca al navegador).
const HCM_API = 'https://api2.grupocanaima.com/empleados/datos/v1';

// Textos en ESPANOL solo para MOSTRAR (si algun render los usa). Para ENVIAR
// al sistema se usan los textos en ingles de _hcm.js: la API cambio de idioma
// el 2026-07-07 (Single/Married/Divorced/... y Male/Female) y la escritura la
// arma fullHcmPayload (payload completo con eco).
const AX_GENDER = { M: 'Masculino', F: 'Femenino' };
const AX_MARITAL = {
  S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a',
  O: 'Conviviente', R: 'Uni\u00f3n Registrada',
};

// Mapa campo interno (workers_master) -> campo del payload de la API de AX.
// 'apellidos' es el campo de ESCRITURA (primer/segundoApellido son solo
// lectura en AX). 'address' NO viaja (la API no lo maneja).
const AX_FIELD_MAP = {
  first_name: 'primerNombre',
  second_name: 'segundoNombre',
  last_names: 'apellidos',
  birth_date: 'fechaNacimiento',
  gender: 'genero',
  marital_status: 'estadoCivil',
  account_number: 'cuentaBancaria',
  phone: 'telefono',
  email: 'correo',
};

// Campos que, si se envian VACIOS a AX, BORRAN el dato (sobreescritura
// destructiva). Nunca se mandan en blanco. (Segun la doc de la API HCM.)
const AX_DESTRUCTIVE = new Set(['first_name', 'second_name', 'last_names', 'account_number']);

// Mapa accion -> code. directory/sign son lectura (view.fotos); save/remove/
// set_department son gestion de foto (photo.manage); save_profile edita la
// ficha (ficha.edit). migrate_thumbs se valida como superadmin dentro de su
// handler (no lleva code fino aqui).
const WP_CODE_BY_ACTION = {
  directory: 'view.fotos',
  sign: 'view.fotos',
  save: 'photo.manage',
  remove: 'photo.manage',
  set_department: 'photo.manage',
  save_profile: 'ficha.edit',
  push_to_ax: 'hcm.sync',
};

// URL publica fija de un objeto del bucket publico (sin firmar, cacheable).
function publicUrl(env, bucket, path) {
  if (!path) return null;
  return `${env.supabase_url}/storage/v1/object/public/${bucket}/${path}`;
}

const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);

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

/* ---------- Storage ---------- */
// Sube a un bucket arbitrario (por defecto el privado). El bucket publico
// 'worker-thumbs' se usa para miniaturas; el privado 'worker-photos' para
// las full (y las thumb del esquema viejo).
async function storageUpload(env, path, bytes, mime, bucket) {
  bucket = bucket || BUCKET;
  const res = await fetch(`${env.supabase_url}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Type': mime || 'application/octet-stream',
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Storage upload ${res.status}: ${await res.text()}`);
  return true;
}
async function storageRemove(env, paths, bucket) {
  bucket = bucket || BUCKET;
  if (!paths || !paths.length) return;
  await fetch(`${env.supabase_url}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: paths }),
  }).catch(() => { /* no critico */ });
}
// Descarga los bytes de un objeto (para copiar entre buckets en la migracion).
async function storageDownload(env, bucket, path) {
  const res = await fetch(`${env.supabase_url}/storage/v1/object/${bucket}/${path}`, {
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
    },
  });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}
async function storageSignedUrl(env, path, bucket) {
  bucket = bucket || BUCKET;
  if (!path) return null;
  // Hasta 3 intentos: bajo carga, la primera firma puede fallar por saturacion
  // momentanea; un reintento corto recupera la gran mayoria sin que la foto se
  // pierda. Devuelve null solo si los 3 intentos fallan.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${env.supabase_url}/storage/v1/object/sign/${bucket}/${path}`, {
        method: 'POST',
        headers: {
          apikey: env.supabase_service_role,
          Authorization: `Bearer ${env.supabase_service_role}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: SIGNED_TTL }),
      });
      if (res.ok) {
        const js = await res.json();
        const rel = js && (js.signedURL || js.signedUrl);
        if (rel) return `${env.supabase_url}/storage/v1${rel}`;
      }
    } catch { /* reintenta */ }
    if (attempt < 2) await new Promise(r => setTimeout(r, 120 * (attempt + 1)));
  }
  return null;
}

/* ---------- Helpers ---------- */
function b64ToBytes(b64) {
  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  const bin = atob(clean);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function cedKind(ced) { return parseInt(ced, 10) >= 80000000 ? 'E' : 'V'; }
function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  return 'jpg';
}
// uuid v4 (Cloudflare Workers expone crypto.randomUUID). Identificador por
// foto: nombre del archivo en Storage = "<uuid>.jpg".
function newPhotoKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback improbable.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

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

/* Alcance por DEPARTAMENTO del que llama, dentro de una empresa.
   Devuelve null = sin restriccion (usuario de compania, superadmin, o admin
   con acceso a la empresa completa). Array = solo esos department_id
   (los trabajadores sin departamento quedan fuera). Fuente: RPC
   get_admin_dept_ids. */
async function allowedDeptIds(env, user, cc) {
  if (!user) return null;
  if (user.kind === 'company') return null;
  if (user.kind === 'admin' && user.id) {
    const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role`);
    if (!a || !a.length) return null;
    if (a[0].role === 'superadmin') return null;
    const res = await sb(env, 'rpc/get_admin_dept_ids', {
      method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id, p_company_code: cc }),
    });
    return Array.isArray(res) ? res.map(Number) : null;  // null = empresa completa
  }
  return null;
}

/* true si el departamento depId esta permitido por el alcance (null = sin
   restriccion). Un alcance por departamento NO incluye a los sin asignar. */
function deptOk(deptScope, depId) {
  if (!Array.isArray(deptScope)) return true;
  return depId != null && deptScope.includes(Number(depId));
}

/* Resuelve la TABLA de roster segun el tipo de empresa: las no-tienda usan
   enterprise_workers; las tiendas (o cualquier otra) usan store_workers.
   Asi el mismo endpoint (foto/ficha sobre workers_master por cedula) sirve
   para ambos mundos. La foto y el perfil viven en workers_master (global);
   solo cambia donde se valida la pertenencia al roster. */
async function rosterTable(env, cc) {
  const rows = await sb(env, `companies?company_code=eq.${encodeURIComponent(cc)}&select=company_type`);
  const type = rows && rows[0] ? rows[0].company_type : null;
  return NON_STORE_TYPES.has(type) ? 'enterprise_workers' : 'store_workers';
}

/* ===================== Handler ===================== */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido' }, 400); }

  const action = body.action;
  const cc = (body.company_code || '').trim();
  const user = body.user || null;

  try {
    // migrate_thumbs es global (no por empresa): solo superadmin. Se valida
    // aparte porque no requiere company_code.
    if (action === 'migrate_thumbs') return await migrateThumbs(env, user, body);

    if (!cc) return json({ ok: false, error: 'Falta la empresa.' }, 400);
    if (!(await userCanAccess(env, user, cc))) return json({ ok: false, error: 'No tienes acceso a esta empresa.' }, 403);

    // SHADOW: gate legacy binario = acceso a la empresa (userCanAccess). El
    // alcance por departamento (deptScope) se evalua aparte. Code por accion.
    await shadowCan(env, user, 'worker-photo', action || '?', WP_CODE_BY_ACTION[action] || 'view.fotos', true);

    const table = await rosterTable(env, cc);
    // Alcance por departamento del que llama (null = sin restriccion).
    const deptScope = await allowedDeptIds(env, user, cc);

    if (action === 'directory') return await directory(env, cc, table, deptScope);
    if (action === 'sign') return await signPhotos(env, cc, body, table, deptScope);
    if (action === 'save') return await savePhoto(env, cc, body, table, deptScope);
    if (action === 'save_profile') return await saveProfile(env, cc, body, table, deptScope);
    if (action === 'set_department') return await setDepartment(env, cc, body, table, deptScope);
    if (action === 'remove') return await removePhoto(env, cc, body, table, deptScope);
    if (action === 'push_to_ax') return await pushToAx(env, cc, body, table, deptScope, user);

    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}

/* ---------- DIRECTORY ---------- */
async function directory(env, cc, table, deptScope) {
  table = table || 'store_workers';
  const isEnterprise = table === 'enterprise_workers';
  // Datos de la empresa (cabecera de la ficha). Zona/subzona/concepto por id.
  const compRows = await sb(env,
    `companies?company_code=eq.${encodeURIComponent(cc)}`
    + `&select=company_code,business_name,tax_id,status,zone_id,subzone_id,concept_id`);
  const comp = (compRows && compRows[0]) || { company_code: cc };
  const [zoneR, subR, conR] = await Promise.all([
    comp.zone_id ? sb(env, `zones?id=eq.${encodeURIComponent(comp.zone_id)}&select=name`) : Promise.resolve(null),
    comp.subzone_id ? sb(env, `subzones?id=eq.${encodeURIComponent(comp.subzone_id)}&select=name`) : Promise.resolve(null),
    comp.concept_id ? sb(env, `concepts?id=eq.${encodeURIComponent(comp.concept_id)}&select=name`) : Promise.resolve(null),
  ]);
  const company = {
    code: comp.company_code,
    business_name: comp.business_name || null,
    tax_id: comp.tax_id || null,
    status: comp.status || null,
    zone: zoneR && zoneR[0] ? zoneR[0].name : null,
    subzone: subR && subR[0] ? subR[0].name : null,
    concept: conR && conR[0] ? conR[0].name : null,
  };

  // Catalogo de bancos activos -> mapa prefijo:nombre (mostrar/validar cuenta).
  const banks = await sb(env, 'bancos?is_active=eq.true&select=code,name&order=code');
  const bankMap = {};
  (banks || []).forEach(b => { bankMap[b.code] = b.name; });

  // Catalogo de departamentos de la empresa (para la ficha y la asignacion
  // masiva). En tiendas existe "Tiendas" sembrado; en no-tiendas los crea el
  // admin. Se devuelve la lista y se mapea id->nombre para cada trabajador.
  const depts = await sb(env, `departments?company_code=eq.${encodeURIComponent(cc)}&is_active=eq.true&select=id,name&order=sort_order.asc,name.asc`);
  const deptMap = {};
  (depts || []).forEach(d => { deptMap[d.id] = d.name; });
  // El catalogo que se ofrece para asignar respeta el alcance: un admin
  // restringido por departamento solo ve/asigna los suyos.
  const deptList = (depts || [])
    .filter(d => !Array.isArray(deptScope) || deptScope.includes(Number(d.id)))
    .map(d => ({ id: d.id, name: d.name }));

  // Roster de la empresa (tabla segun tipo). En modo empresa traemos TODOS
  // los datos personales desde enterprise_workers (el Reporte AX los tiene),
  // para no depender de que workers_master este poblado: la ficha usa el
  // dato del roster como respaldo del master. En tiendas el roster solo
  // aporta lo basico (los datos personales viven en el master/Reporte 10).
  const rosterSelect = isEnterprise
    ? `id_number,full_name,role,end_date,source,department_id,first_name,second_name,last_names,`
      + `birth_date,gender,marital_status,start_date,account_number,bank_code,todo_ticket,phone,email,address,data_id`
    : `id_number,full_name,role,end_date,source,department_id,birth_date,gender,marital_status,start_date`;
  const workersAll = await sb(env,
    `${table}?company_code=eq.${encodeURIComponent(cc)}&select=${rosterSelect}&order=full_name.asc`);
  // Alcance por departamento: si el admin esta restringido, solo su(s)
  // departamento(s) (los no asignados quedan fuera).
  const workers = Array.isArray(deptScope)
    ? (workersAll || []).filter(w => w.department_id != null && deptScope.includes(Number(w.department_id)))
    : (workersAll || []);
  const ceds = workers.map(w => w.id_number).filter(Boolean);

  // Metadatos del snapshot. store_roster_meta (tiendas) o
  // enterprise_roster_meta (empresas). Se normaliza a {uploaded_at,
  // uploaded_by, total_count, source_file} para el front.
  let meta = null;
  if (isEnterprise) {
    const metaArr = await sb(env,
      `enterprise_roster_meta?company_code=eq.${encodeURIComponent(cc)}`
      + `&select=uploaded_at,uploaded_by,row_count,source_file,source`);
    if (metaArr && metaArr[0]) {
      meta = {
        uploaded_at: metaArr[0].uploaded_at,
        uploaded_by: metaArr[0].uploaded_by,
        total_count: metaArr[0].row_count,
        source_file: metaArr[0].source_file,
        source: metaArr[0].source,
      };
    }
  } else {
    const metaArr = await sb(env,
      `store_roster_meta?company_code=eq.${encodeURIComponent(cc)}`
      + `&select=uploaded_at,uploaded_by,total_count,source_file`);
    meta = metaArr && metaArr[0] ? metaArr[0] : null;
  }

  // Maestra de los de este roster.
  let masterByCed = {};
  if (ceds.length) {
    const inList = ceds.map(c => `"${c}"`).join(',');
    const master = await sb(env,
      `workers_master?id_number=in.(${inList})`
      + `&select=id_number,first_name,second_name,last_names,full_name,role,birth_date,gender,marital_status,`
      + `account_number,bank_code,phone,email,address,data_id,`
      + `ax_pending,ax_pending_fields,ax_synced_at,`
      + `photo_key,photo_thumb_path,photo_full_path,photo_uploaded_by,photo_uploaded_at,updated_at`);
    (master || []).forEach(m => { masterByCed[m.id_number] = m; });
  }

  // Resolucion de la foto en el directory:
  //  - Esquema NUEVO (tiene photo_key): la miniatura esta en el bucket
  //    publico como "<photo_key>.jpg" -> URL publica directa, sin firmar,
  //    cacheable. Se devuelve en thumb_url y la grilla la pinta de una.
  //  - Esquema VIEJO (sin photo_key pero con photo_thumb_path): la miniatura
  //    esta en el bucket privado por cedula -> hay que firmarla. Se marca
  //    needs_sign:true y thumb_url:null; el front la pide con 'sign' (lazy).
  //  - Sin foto: has_photo:false.
  // La full NUNCA se firma aqui (solo on-demand al abrir el visor).
  const items = (workers || []).map(w => {
    const m = masterByCed[w.id_number] || {};
    const hasPhoto = !!(m.photo_key || m.photo_thumb_path);
    const isNew = !!m.photo_key;
    const thumbUrl = isNew ? publicUrl(env, PUBLIC_BUCKET, `${m.photo_key}.jpg`) : null;
    const needsSign = hasPhoto && !isNew;   // foto vieja: requiere firma lazy
    // Para cada dato personal: gana el master si lo tiene; si no, el del
    // roster (en empresa el Reporte AX lo trae). Asi la ficha muestra los
    // datos aunque workers_master aun no este sincronizado.
    const pick = (key) => (m[key] != null && m[key] !== '') ? m[key] : (w[key] != null && w[key] !== '' ? w[key] : null);
    return {
      id_number: w.id_number,
      ced_kind: cedKind(w.id_number),
      full_name: m.full_name || w.full_name,
      first_name: pick('first_name'),
      second_name: pick('second_name'),
      last_names: pick('last_names'),
      role: pick('role'),
      end_date: w.end_date || null,
      birth_date: pick('birth_date'),
      gender: pick('gender'),
      marital_status: pick('marital_status'),
      start_date: w.start_date || null,
      account_number: pick('account_number'),
      bank_code: pick('bank_code'),
      phone: pick('phone'),
      email: pick('email'),
      address: pick('address'),
      data_id: pick('data_id'),
      department_id: w.department_id || null,
      department_name: w.department_id ? (deptMap[w.department_id] || null) : null,
      has_photo: hasPhoto,
      needs_sign: needsSign,   // true = foto vieja, pedir con 'sign'
      thumb_url: thumbUrl,     // URL publica directa (esquema nuevo) o null
      full_url: null,          // la full se firma on-demand al abrir el visor
      photo_uploaded_by: m.photo_uploaded_by || null,
      updated_at: m.updated_at || null,
      // Estado de envio a AX: si tiene cambios locales sin enviar y cuales.
      ax_pending: !!m.ax_pending,
      ax_pending_fields: (m.ax_pending_fields && typeof m.ax_pending_fields === 'object') ? m.ax_pending_fields : {},
      ax_synced_at: m.ax_synced_at || null,
      source: w.source || 'report10',
    };
  });

  const withPhoto = items.filter(i => i.has_photo).length;
  const manualCount = items.filter(i => i.source === 'manual').length;
  return json({
    ok: true,
    company,
    bank_map: bankMap,
    total: items.length,
    with_photo: withPhoto,
    pending: items.length - withPhoto,
    manual_count: manualCount,
    report_count: items.length - manualCount,
    departments: deptList,
    meta,
    workers: items,
  });
}

/* ---------- SIGN (firma de fotos a demanda) ----------
   Devuelve, para cada cedula pedida, las URLs de su miniatura y su version
   grande. Sirve para dos casos:
     - Foto NUEVA (photo_key): la thumb es publica (URL directa, no se firma);
       solo se firma la full del bucket privado (para el visor).
     - Foto VIEJA (sin photo_key): ambas estan en el bucket privado por
       cedula y se firman (fallback del esquema anterior).
   La grilla solo llama esto para fotos viejas (needs_sign); la ficha/visor lo
   llama para obtener la full firmada de cualquier foto. Valida roster +
   alcance. */
async function signPhotos(env, cc, body, table, deptScope) {
  table = table || 'store_workers';
  const ids = Array.isArray(body.id_numbers)
    ? [...new Set(body.id_numbers.map(x => String(x).replace(/[^0-9]/g, '')).filter(Boolean))].slice(0, 30)
    : [];
  if (!ids.length) return json({ ok: true, photos: {} });

  // Solo cedulas que esten en el roster de esta empresa (y en el alcance).
  const inList = ids.map(c => `"${c}"`).join(',');
  const inRoster = await sb(env,
    `${table}?company_code=eq.${encodeURIComponent(cc)}&id_number=in.(${inList})&select=id_number,department_id`);
  const allowed = (inRoster || [])
    .filter(r => deptOk(deptScope, r.department_id))
    .map(r => r.id_number);
  if (!allowed.length) return json({ ok: true, photos: {} });

  // Datos de foto de esas cedulas (incluye photo_key para distinguir esquema).
  const allowList = allowed.map(c => `"${c}"`).join(',');
  const master = await sb(env,
    `workers_master?id_number=in.(${allowList})&select=id_number,photo_key,photo_thumb_path,photo_full_path`);

  const photos = {};
  for (const m of (master || [])) {
    let thumbUrl = null, fullUrl = null;
    if (m.photo_key) {
      // Esquema nuevo: thumb publica directa; full firmada del privado.
      thumbUrl = publicUrl(env, PUBLIC_BUCKET, `${m.photo_key}.jpg`);
      fullUrl = await storageSignedUrl(env, `full/${m.photo_key}.jpg`, BUCKET);
    } else {
      // Esquema viejo: ambas firmadas del bucket privado, por su path.
      thumbUrl = m.photo_thumb_path ? await storageSignedUrl(env, m.photo_thumb_path, BUCKET) : null;
      fullUrl = m.photo_full_path ? await storageSignedUrl(env, m.photo_full_path, BUCKET) : null;
    }
    photos[m.id_number] = { thumb_url: thumbUrl, full_url: fullUrl, has_photo: !!thumbUrl };
  }
  return json({ ok: true, photos });
}

/* ---------- SAVE (foto) ---------- */
async function savePhoto(env, cc, body, table, deptScope) {
  table = table || 'store_workers';
  const ced = String(body.id_number || '').replace(/[^0-9]/g, '');
  if (!ced || ced.length < 6 || ced.length > 8) return json({ ok: false, error: 'Cedula invalida.' }, 400);

  const inStore = await sb(env,
    `${table}?company_code=eq.${encodeURIComponent(cc)}&id_number=eq.${encodeURIComponent(ced)}&select=id_number,full_name,first_name,second_name,last_names,department_id`);
  if (!inStore || !inStore.length) return json({ ok: false, error: 'Ese trabajador no esta en la lista de la empresa.' }, 404);
  if (!deptOk(deptScope, inStore[0].department_id)) return json({ ok: false, error: 'Ese trabajador esta fuera de tu alcance (departamento).' }, 403);

  const fullB64 = String(body.full_b64 || '');
  const thumbB64 = String(body.thumb_b64 || '');
  if (!fullB64 || !thumbB64) return json({ ok: false, error: 'Faltan las imagenes (grande y miniatura).' }, 400);

  const mime = String(body.mime || 'image/jpeg');
  const fullBytes = b64ToBytes(fullB64);
  const thumbBytes = b64ToBytes(thumbB64);
  if (fullBytes.length > MAX_FULL_BYTES) {
    return json({ ok: false, error: 'La foto pesa demasiado. Reintenta (deberia comprimirse sola).' }, 413);
  }

  // photo_key anterior (si existia) para borrar la foto vieja despues de subir
  // la nueva. Tambien rescatamos los paths viejos (esquema por cedula) para
  // limpiarlos si esta persona aun estaba en el esquema anterior.
  const prevRows = await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}&select=id_number,photo_key,photo_thumb_path,photo_full_path`);
  const prev = prevRows && prevRows[0] ? prevRows[0] : null;

  // Esquema NUEVO: un uuid por subida. La miniatura va al bucket PUBLICO como
  // "<key>.jpg" (URL fija, cacheable, sin firmar). La full va al bucket
  // PRIVADO como "full/<key>.jpg" (se firma on-demand). Al cambiar la foto,
  // cambia el uuid -> cambia la URL publica -> se invalida el cache solo.
  const key = newPhotoKey();
  const thumbPath = `${key}.jpg`;          // en PUBLIC_BUCKET
  const fullPath = `full/${key}.jpg`;      // en BUCKET (privado)
  await storageUpload(env, thumbPath, thumbBytes, mime, PUBLIC_BUCKET);
  await storageUpload(env, fullPath, fullBytes, mime, BUCKET);

  const photoPatch = {
    photo_key: key,
    photo_full_path: fullPath,
    photo_thumb_path: thumbPath,   // path dentro del bucket publico
    photo_w: parseInt(body.width, 10) || null,
    photo_h: parseInt(body.height, 10) || null,
    photo_bytes: fullBytes.length,
    photo_uploaded_at: new Date().toISOString(),
    photo_uploaded_by: (body.uploaded_by || '').trim() || cc,
    last_source_company: cc,
  };

  if (prev) {
    await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}`, { method: 'PATCH', body: JSON.stringify(photoPatch) });
  } else {
    const w = inStore[0];
    await sb(env, 'workers_master', {
      method: 'POST',
      body: JSON.stringify({
        id_number: ced, ced_kind: cedKind(ced), full_name: w.full_name,
        first_name: w.first_name || null, second_name: w.second_name || null, last_names: w.last_names || null,
        ...photoPatch,
      }),
    });
  }

  // Borrar la foto ANTERIOR de esta persona (no las historicas migradas de
  // otros). Si tenia photo_key previo, borrar su thumb publica y su full
  // privada. Si venia del esquema viejo (sin key), borrar sus paths por cedula
  // del bucket privado. No es critico si falla (no rompe la subida nueva).
  if (prev) {
    if (prev.photo_key && prev.photo_key !== key) {
      await storageRemove(env, [`${prev.photo_key}.jpg`], PUBLIC_BUCKET);
      await storageRemove(env, [`full/${prev.photo_key}.jpg`], BUCKET);
    } else if (!prev.photo_key) {
      // Esquema viejo: thumb y full por cedula en el bucket privado.
      await storageRemove(env, [prev.photo_thumb_path, prev.photo_full_path].filter(Boolean), BUCKET);
    }
  }

  // Devolver la thumb publica directa y la full firmada (para refrescar la UI).
  const thumbUrl = publicUrl(env, PUBLIC_BUCKET, thumbPath);
  const fullUrl = await storageSignedUrl(env, fullPath, BUCKET);
  return json({ ok: true, id_number: ced, photo_key: key, thumb_url: thumbUrl, full_url: fullUrl, bytes: fullBytes.length });
}

/* ---------- CHANGE_SET (auditoria de cambios pendientes de publicar) ----------
   Registra/acumula en nomina_v2.ax_change_set los campos que el usuario cambio
   en una edicion de ficha, para la pagina de revision "Sincronizar". Un
   registro por (ficha, empresa) mientras status='pending': si ya existe uno
   pendiente, se ACUMULA el nuevo cambio sobre su JSON (el 'old' de cada campo
   se conserva del primer cambio; el 'new' se actualiza al ultimo valor). Si no
   existe, se crea. Los published/discarded no se tocan (historial permanente).

   deltas: { campo: { old, new } } SOLO de los campos que cambiaron en esta
   edicion (ya calculados en saveProfile). changedBy = admin_users.id (o null).

   No es critico para el guardado: si algo falla aqui, se registra y sigue (el
   dato ya quedo en workers_master; la auditoria es adicional). */
async function upsertChangeSet(env, cc, ced, deltas, changedBy) {
  const keys = Object.keys(deltas || {});
  if (!keys.length) return;   // nada que registrar
  const nowIso = new Date().toISOString();
  // Buscar un change_set PENDIENTE existente para esta ficha+empresa.
  const existing = await sb(env,
    `ax_change_set?id_number=eq.${encodeURIComponent(ced)}`
    + `&company_code=eq.${encodeURIComponent(cc)}&status=eq.pending`
    + `&select=id,changes&limit=1`);
  if (existing && existing.length) {
    // Acumular: conservar el 'old' original de cada campo ya presente; agregar
    // los campos nuevos; actualizar el 'new' al ultimo valor.
    const prev = (existing[0].changes && typeof existing[0].changes === 'object') ? existing[0].changes : {};
    const merged = { ...prev };
    for (const k of keys) {
      if (merged[k] && Object.prototype.hasOwnProperty.call(merged[k], 'old')) {
        // Ya habia un cambio en este campo: mantener el 'old' original, refrescar 'new'.
        merged[k] = { old: merged[k].old, new: deltas[k].new };
      } else {
        merged[k] = { old: deltas[k].old, new: deltas[k].new };
      }
    }
    await sb(env, `ax_change_set?id=eq.${encodeURIComponent(existing[0].id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ changes: merged, changed_by: changedBy ?? null, changed_at: nowIso }),
    });
  } else {
    // Nuevo change_set pendiente para esta ficha.
    await sb(env, 'ax_change_set', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        id_number: ced, company_code: cc,
        changes: deltas, status: 'pending',
        changed_by: changedBy ?? null, changed_at: nowIso,
      }),
    });
  }
}

/* ---------- SAVE_PROFILE (datos de la persona) ---------- */
async function saveProfile(env, cc, body, table, deptScope) {
  table = table || 'store_workers';
  const ced = String(body.id_number || '').replace(/[^0-9]/g, '');
  if (!ced || ced.length < 6 || ced.length > 8) return json({ ok: false, error: 'Cedula invalida.' }, 400);
  const p = body.profile || {};

  // La persona debe pertenecer al roster de esta empresa.
  const inStore = await sb(env,
    `${table}?company_code=eq.${encodeURIComponent(cc)}&id_number=eq.${encodeURIComponent(ced)}&select=id_number,full_name,department_id`);
  if (!inStore || !inStore.length) return json({ ok: false, error: 'Ese trabajador no esta en la lista de la empresa.' }, 404);
  if (!deptOk(deptScope, inStore[0].department_id)) return json({ ok: false, error: 'Ese trabajador esta fuera de tu alcance (departamento).' }, 403);

  // Validaciones server-side (defensa).
  const acc = p.account_number ? String(p.account_number).replace(/\D/g, '') : null;
  if (acc) {
    if (acc.length !== 20) return json({ ok: false, error: 'La cuenta debe tener 20 digitos.' }, 400);
    const bk = await sb(env, `bancos?code=eq.${encodeURIComponent(acc.slice(0, 4))}&is_active=eq.true&select=code`);
    if (!bk || !bk.length) return json({ ok: false, error: `Prefijo de banco ${acc.slice(0, 4)} no valido.` }, 400);
  }
  let phone = p.phone ? String(p.phone).replace(/[^\d+]/g, '') : null;
  if (phone) {
    let nat = phone.startsWith('+58') ? '0' + phone.slice(3) : phone;
    if (!/^0\d{10}$/.test(nat)) return json({ ok: false, error: 'Telefono no valido (04XX-XXXXXXX).' }, 400);
    phone = '+58' + nat.slice(1);
  }
  if (p.gender && !['M', 'F'].includes(p.gender)) return json({ ok: false, error: 'Genero invalido.' }, 400);
  // Estado civil: 6 codigos (mapean al enum HcmPersonMaritalStatus de AX):
  //   S=Soltero/a C=Casado/a D=Divorciado/a V=Viudo/a O=Cohabitando R=Asociacion registrada
  if (p.marital_status && !['S', 'C', 'D', 'V', 'O', 'R'].includes(p.marital_status)) return json({ ok: false, error: 'Estado civil invalido.' }, 400);
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return json({ ok: false, error: 'Correo invalido.' }, 400);

  const patch = {
    first_name: p.first_name || null,
    second_name: p.second_name || null,
    last_names: p.last_names || null,
    full_name: p.full_name || null,
    birth_date: p.birth_date || null,
    gender: p.gender || null,
    marital_status: p.marital_status || null,
    account_number: acc,
    bank_code: acc ? acc.slice(0, 4) : null,
    phone: phone,
    email: p.email || null,
    address: p.address || null,
    last_source_company: cc,
  };
  // El CARGO (role) NUNCA se edita desde la ficha: es dato maestro que llega
  // solo por la sincronizacion de personal desde AX (la API). El cargo afecta
  // el salario, por lo que se evita cualquier via de cambio manual en el
  // portal. Por eso NO se incluye 'role' en el patch bajo ninguna condicion
  // (asi ademas se evita borrarlo con null si el front lo mandara).

  // ----- Deteccion de cambios para el envio a AX (ax_pending) -----
  // Leemos los valores ACTUALES del master (los que viajan a AX) para saber
  // QUE campos cambio el usuario en esta edicion. Solo esos se marcaran como
  // pendientes de enviar a AX, y solo esos se enviaran luego (asi no se
  // arrastra un valor de lectura potencialmente erroneo -p.ej. estadoCivil-
  // que el usuario no toco). 'address' NO viaja a AX (la API no lo maneja).
  const AX_FIELDS = ['first_name', 'second_name', 'last_names', 'birth_date',
    'gender', 'marital_status', 'account_number', 'phone', 'email'];
  const prevRows = await sb(env,
    `workers_master?id_number=eq.${encodeURIComponent(ced)}`
    + `&select=id_number,${AX_FIELDS.join(',')},ax_pending,ax_pending_fields`);
  const prevM = prevRows && prevRows[0] ? prevRows[0] : null;
  const norm = v => (v == null || v === '') ? '' : String(v).trim();
  const changed = {};   // campo -> true si cambio en esta edicion
  for (const f of AX_FIELDS) {
    if (norm(patch[f]) !== norm(prevM ? prevM[f] : '')) changed[f] = true;
  }
  // Acumular con lo que ya estuviera pendiente (varias ediciones antes de
  // enviar): la union de campos cambiados sigue pendiente hasta el envio.
  const prevPending = (prevM && prevM.ax_pending_fields && typeof prevM.ax_pending_fields === 'object')
    ? prevM.ax_pending_fields : {};
  const mergedPending = { ...prevPending, ...changed };
  const anyPending = Object.keys(mergedPending).length > 0;
  // Si hubo algun cambio en campos de AX, marcar pendiente. Si esta edicion no
  // toco ningun campo de AX (p.ej. solo cambio la direccion), se conserva el
  // estado de pendiente previo tal cual (no lo limpia ni lo activa de mas).
  if (anyPending) {
    patch.ax_pending = true;
    patch.ax_pending_fields = mergedPending;
    patch.ax_pending_at = new Date().toISOString();
  }

  const exists = await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}&select=id_number`);
  if (exists && exists.length) {
    await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  } else {
    // Registro nuevo: si trae datos de campos AX, nace pendiente de enviar.
    const initPending = {};
    for (const f of AX_FIELDS) { if (norm(patch[f])) initPending[f] = true; }
    const born = { id_number: ced, ced_kind: cedKind(ced), ...patch };
    if (Object.keys(initPending).length) {
      born.ax_pending = true;
      born.ax_pending_fields = initPending;
      born.ax_pending_at = new Date().toISOString();
    }
    await sb(env, 'workers_master', {
      method: 'POST',
      body: JSON.stringify(born),
    });
  }

  // ----- Auditoria de cambios para la pagina de revision ("Sincronizar") -----
  // Registrar/acumular en ax_change_set los campos que cambiaron en esta
  // edicion, con su valor viejo->nuevo y quien lo hizo. Se usan los valores
  // internos (codigos S/C/D/V/O/R, M/F, +58..., YYYY-MM-DD) tal como estan en
  // el master; la pagina los traduce a texto legible. Solo campos de AX que
  // realmente cambiaron (el mismo 'changed' que marca ax_pending). No es
  // critico: si falla, el guardado ya quedo hecho.
  try {
    const changedByRaw = body.user && body.user.kind === 'admin' ? body.user.id : null;
    const changedBy = (changedByRaw != null && Number.isFinite(Number(changedByRaw))) ? Number(changedByRaw) : null;
    const deltas = {};
    for (const f of AX_FIELDS) {
      if (changed[f]) {
        deltas[f] = {
          old: (prevM && prevM[f] != null && prevM[f] !== '') ? prevM[f] : null,
          new: (patch[f] != null && patch[f] !== '') ? patch[f] : null,
        };
      }
    }
    await upsertChangeSet(env, cc, ced, deltas, changedBy);
  } catch (e) {
    // La auditoria no debe tumbar el guardado; el dato ya esta en el master.
  }

  // Departamento: vive en el ROSTER de la empresa (store_workers /
  // enterprise_workers), no en workers_master. Solo se toca si el cliente lo
  // envia explicitamente (department_id presente; null = quitarlo).
  if (Object.prototype.hasOwnProperty.call(body, 'department_id')) {
    const depId = (body.department_id === null || body.department_id === '') ? null : parseInt(body.department_id, 10);
    if (depId != null) {
      const d = await sb(env, `departments?id=eq.${depId}&company_code=eq.${encodeURIComponent(cc)}&select=id`);
      if (!d || !d.length) return json({ ok: false, error: 'Ese departamento no pertenece a esta empresa.' }, 400);
    }
    if (Array.isArray(deptScope) && !deptOk(deptScope, depId)) {
      return json({ ok: false, error: 'No puedes asignar a un departamento fuera de tu alcance.' }, 403);
    }
    await sb(env, `${table}?company_code=eq.${encodeURIComponent(cc)}&id_number=eq.${encodeURIComponent(ced)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ department_id: depId }),
    });
  }
  return json({ ok: true, id_number: ced, ax_pending: !!patch.ax_pending, ax_pending_fields: patch.ax_pending_fields || null });
}

/* ---------- SET_DEPARTMENT (asignacion masiva de departamento) ----------
   Asigna (o quita, con department_id null) un departamento a varios
   trabajadores del roster de ESTA empresa. El departamento debe pertenecer a
   la empresa. userCanAccess ya valido el alcance del que llama. */
async function setDepartment(env, cc, body, table, deptScope) {
  table = table || 'store_workers';
  let ids = Array.isArray(body.id_numbers)
    ? [...new Set(body.id_numbers.map(x => String(x).replace(/[^0-9]/g, '')).filter(Boolean))]
    : [];
  if (!ids.length) return json({ ok: false, error: 'No hay trabajadores seleccionados.' }, 400);
  const depId = (body.department_id === null || body.department_id === '' || body.department_id === undefined)
    ? null : parseInt(body.department_id, 10);
  if (depId != null) {
    const d = await sb(env, `departments?id=eq.${depId}&company_code=eq.${encodeURIComponent(cc)}&select=id`);
    if (!d || !d.length) return json({ ok: false, error: 'Ese departamento no pertenece a esta empresa.' }, 400);
  }
  // Alcance por departamento: solo se asigna a un departamento propio y solo
  // sobre trabajadores que ya esten en el alcance del admin.
  if (Array.isArray(deptScope)) {
    if (depId == null || !deptScope.includes(Number(depId))) {
      return json({ ok: false, error: 'Solo puedes asignar a departamentos de tu alcance.' }, 403);
    }
    const curList = ids.map(c => `"${c}"`).join(',');
    const cur = await sb(env,
      `${table}?company_code=eq.${encodeURIComponent(cc)}&id_number=in.(${curList})&select=id_number,department_id`);
    const allow = new Set(deptScope.map(Number));
    ids = (cur || []).filter(w => w.department_id != null && allow.has(Number(w.department_id))).map(w => w.id_number);
    if (!ids.length) return json({ ok: false, error: 'Ninguno de los seleccionados esta en tu alcance.' }, 403);
  }
  const inList = ids.map(c => `"${c}"`).join(',');
  await sb(env, `${table}?company_code=eq.${encodeURIComponent(cc)}&id_number=in.(${inList})`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ department_id: depId }),
  });
  return json({ ok: true, count: ids.length, department_id: depId });
}

/* ---------- REMOVE (foto) ---------- */
async function removePhoto(env, cc, body, table, deptScope) {
  table = table || 'store_workers';
  const ced = String(body.id_number || '').replace(/[^0-9]/g, '');
  if (!ced) return json({ ok: false, error: 'Cedula invalida.' }, 400);

  // La persona debe pertenecer al roster de esta empresa y a tu alcance.
  const inStore = await sb(env,
    `${table}?company_code=eq.${encodeURIComponent(cc)}&id_number=eq.${encodeURIComponent(ced)}&select=id_number,department_id`);
  if (!inStore || !inStore.length) return json({ ok: false, error: 'Ese trabajador no esta en la lista de la empresa.' }, 404);
  if (!deptOk(deptScope, inStore[0].department_id)) return json({ ok: false, error: 'Ese trabajador esta fuera de tu alcance (departamento).' }, 403);

  const rows = await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}&select=photo_key,photo_full_path,photo_thumb_path`);
  const m = rows && rows[0];
  if (m) {
    if (m.photo_key) {
      // Esquema nuevo: thumb en bucket publico, full en privado.
      await storageRemove(env, [`${m.photo_key}.jpg`], PUBLIC_BUCKET);
      await storageRemove(env, [`full/${m.photo_key}.jpg`], BUCKET);
    } else {
      // Esquema viejo: ambas por cedula en el bucket privado.
      await storageRemove(env, [m.photo_full_path, m.photo_thumb_path].filter(Boolean), BUCKET);
    }
    await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        photo_key: null,
        photo_full_path: null, photo_thumb_path: null,
        photo_w: null, photo_h: null, photo_bytes: null,
        photo_uploaded_at: null, photo_uploaded_by: null,
      }),
    });
  }
  return json({ ok: true, id_number: ced, removed: true });
}

/* ---------- PUSH_TO_AX (enviar cambios de la ficha hacia AX) ----------
   Toma los trabajadores con cambios PENDIENTES (ax_pending) de esta empresa y
   los escribe en AX via POST a la API HCM (api2). Dos modos:
     - individual/seleccion: body.id_numbers = [ced, ...] -> solo esos.
     - masivo: sin id_numbers -> todos los pendientes de la empresa (y del
       alcance por departamento del que llama).

   Principios (todos por diseno, no por confianza en el front):
     - Solo superadmin por ahora (cableado a permisos para ampliar luego).
     - Se envia SOLO lo que el usuario cambio: ax_pending_fields marca que
       campos van; asi no se arrastra un valor de lectura erroneo (estadoCivil).
     - Traduccion codigo->texto AX (genero, estado civil) y mapeo de nombres
       de campo (ver AX_FIELD_MAP). 'apellidos' es el campo de escritura.
     - RED ANTI-BORRADO: los campos destructivos (AX_DESTRUCTIVE) jamas se
       envian vacios. Si un pendiente quedara con un destructivo vacio, se
       omite ese campo (no se borra el dato en AX).
     - La 'ficha' de AX = la cedula (id_number).
     - Al EXITO se limpia ax_pending/ax_pending_fields y se marca ax_synced_at
       de los enviados. Los rechazados conservan su pendiente.
   Devuelve el detalle: enviados, rechazados y respuesta de AX. */
async function pushToAx(env, cc, body, table, deptScope, user) {
  table = table || 'store_workers';

  // --- Gate: solo superadmin por ahora ---
  if (!user || user.kind !== 'admin' || !user.id) {
    return json({ ok: false, error: 'Solo un administrador puede enviar datos a AX.' }, 403);
  }
  const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role`);
  if (!a || !a.length || a[0].role !== 'superadmin') {
    return json({ ok: false, error: 'Esta accion esta reservada al superadministrador.' }, 403);
  }
  if (!env.canaima_apikey) {
    return json({ ok: false, error: 'La clave de AX no esta configurada en el servidor.' }, 500);
  }

  // --- A que cedulas apunta este envio ---
  // Con id_numbers: solo esas (envio individual o de una seleccion). Sin
  // id_numbers: todos los pendientes de la empresa.
  const askedIds = Array.isArray(body.id_numbers)
    ? [...new Set(body.id_numbers.map(x => String(x).replace(/[^0-9]/g, '')).filter(Boolean))]
    : null;

  // Roster de la empresa (para validar pertenencia + alcance por departamento).
  const roster = await sb(env,
    `${table}?company_code=eq.${encodeURIComponent(cc)}&select=id_number,department_id`);
  const inScope = new Set(
    (roster || [])
      .filter(r => deptOk(deptScope, r.department_id))
      .map(r => String(r.id_number))
  );
  if (!inScope.size) return json({ ok: false, error: 'No hay personal en tu alcance para esta empresa.' }, 404);

  // Traer del master los PENDIENTES (solo los de esta empresa/alcance). Si se
  // pidieron cedulas concretas, se filtran ademas por esas.
  const scopeList = [...inScope].map(c => `"${c}"`).join(',');
  const AX_SEL = ['id_number', 'first_name', 'second_name', 'last_names',
    'birth_date', 'gender', 'marital_status', 'account_number', 'phone', 'email',
    'ax_pending', 'ax_pending_fields'].join(',');
  const pend = await sb(env,
    `workers_master?id_number=in.(${scopeList})&ax_pending=eq.true&select=${AX_SEL}`);
  let rows = (pend || []).filter(m => inScope.has(String(m.id_number)));
  if (askedIds) {
    const askedSet = new Set(askedIds);
    rows = rows.filter(m => askedSet.has(String(m.id_number)));
  }

  if (!rows.length) {
    return json({ ok: true, sent: 0, synced: [], rejected: [], message: 'No hay cambios pendientes de enviar a AX.' });
  }

  // --- ECO: leer la ficha ACTUAL del sistema para esta empresa ---
  // El payload SIEMPRE viaja completo (los 9 campos): los pendientes con el
  // valor del portal (traducido; enums en ingles) y el resto devolviendo lo
  // que el sistema ya tiene. Sin eco NO se envia (mejor rechazar que ir a
  // medias y arriesgar borrados/reseteos por campos omitidos).
  const erpByCed = await hcmRosterRaw(env, cc);
  if (erpByCed === null) {
    return json({ ok: false, error: 'No se pudo leer el estado actual del sistema para esta empresa; intenta de nuevo.' }, 502);
  }

  const clean = [];         // payloads listos para AX (completos, con eco)
  const cleanCeds = [];     // cedulas que se enviaran (para limpiar pendiente)
  const rejected = [];      // { id_number, reason }
  for (const m of rows) {
    const ced = String(m.id_number);
    const erpRaw = erpByCed[ced];
    if (!erpRaw) {
      rejected.push({ id_number: ced, reason: 'El sistema no devolvio esta ficha (respuesta parcial); no se envia sin el eco.' });
      continue;
    }
    const fields = (m.ax_pending_fields && typeof m.ax_pending_fields === 'object') ? m.ax_pending_fields : {};
    const { payload, changed } = fullHcmPayload(m, fields, erpRaw);
    if (!changed) {
      rejected.push({ id_number: ced, reason: 'Sin campos validos para enviar (todo quedo vacio).' });
      continue;
    }
    clean.push(payload);
    cleanCeds.push(ced);
  }

  if (!clean.length) {
    return json({ ok: false, error: 'Ningun cambio paso la validacion para enviar a AX.', rejected }, 422);
  }

  // --- Enviar a AX (POST) ---
  let axRes;
  try {
    const r = await fetch(HCM_API, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-Key': env.canaima_apikey },
      body: JSON.stringify(clean),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* no-json */ }
    axRes = { ok: r.ok, status: r.status, data, text };
  } catch (e) {
    return json({ ok: false, error: `No se pudo conectar con AX: ${String(e.message || e)}`, rejected }, 502);
  }
  if (!axRes.ok) {
    return json({ ok: false, error: `La API de AX respondio ${axRes.status} al enviar.`, detail: axRes.text || null, rejected }, 502);
  }

  // --- Exito: limpiar el pendiente de los enviados y marcar ax_synced_at ---
  const nowIso = new Date().toISOString();
  if (cleanCeds.length) {
    const okList = cleanCeds.map(c => `"${c}"`).join(',');
    await sb(env, `workers_master?id_number=in.(${okList})`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        ax_pending: false,
        ax_pending_fields: {},
        ax_pending_at: null,
        ax_synced_at: nowIso,
      }),
    });
  }

  return json({
    ok: true,
    sent: clean.length,
    synced: cleanCeds,
    rejected,
    rejected_count: rejected.length,
    ax_response: axRes.data ?? axRes.text ?? null,
  });
}

/* ---------- MIGRATE_THUMBS (un solo uso) ----------
   Migra las fotos del esquema viejo (sin photo_key, ambas en el bucket privado
   por cedula) al esquema nuevo: genera un photo_key, COPIA la thumb al bucket
   publico como "<key>.jpg" y la full al privado como "full/<key>.jpg", y
   actualiza workers_master (photo_key + paths nuevos). NO borra los archivos
   viejos (quedan como respaldo; se limpian aparte cuando se confirme todo).
   Solo superadmin. Procesa en serie (son pocas). Idempotente: las que ya
   tienen photo_key se saltan. Devuelve el detalle por cedula. */
async function migrateThumbs(env, user, body) {
  // Solo superadmin.
  if (!user || user.kind !== 'admin' || !user.id) return json({ ok: false, error: 'Solo superadmin.' }, 403);
  const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role`);
  if (!a || !a.length || a[0].role !== 'superadmin') return json({ ok: false, error: 'Solo superadmin.' }, 403);

  // Cloudflare limita ~50 subrequests por invocacion del Worker. Cada foto
  // hace ~5 subrequests (descargar thumb + subir thumb + descargar full +
  // subir full + PATCH). Por eso se migra en TANDAS pequenas: se llama esta
  // accion varias veces con un limit bajo (8 por defecto = ~40 subrequests).
  // Es idempotente (las ya migradas tienen photo_key y no se vuelven a tomar),
  // asi que basta repetir hasta que remaining llegue a 0.
  const lim = Math.min(Math.max(parseInt(body && body.limit, 10) || 8, 1), 9);

  // Cuantas quedan pendientes en total (con thumb path pero sin photo_key).
  const allPend = await sb(env,
    `workers_master?photo_key=is.null&photo_thumb_path=not.is.null&select=id_number`);
  const totalPending = (allPend || []).length;

  // Tanda de esta llamada.
  const pend = await sb(env,
    `workers_master?photo_key=is.null&photo_thumb_path=not.is.null`
    + `&select=id_number,photo_thumb_path,photo_full_path&limit=${lim}`);
  const list = pend || [];
  let migrated = 0, failed = 0;
  const errors = [];

  for (const m of list) {
    try {
      const key = newPhotoKey();
      // Copiar thumb vieja -> bucket publico como <key>.jpg.
      const thumbBytes = await storageDownload(env, BUCKET, m.photo_thumb_path);
      if (!thumbBytes) { failed++; errors.push(`${m.id_number}: thumb no encontrada`); continue; }
      await storageUpload(env, `${key}.jpg`, thumbBytes, 'image/jpeg', PUBLIC_BUCKET);
      // Copiar full vieja -> privado como full/<key>.jpg (si existe).
      let newFullPath = null;
      if (m.photo_full_path) {
        const fullBytes = await storageDownload(env, BUCKET, m.photo_full_path);
        if (fullBytes) {
          newFullPath = `full/${key}.jpg`;
          await storageUpload(env, newFullPath, fullBytes, 'image/jpeg', BUCKET);
        }
      }
      // Actualizar BD: photo_key + paths nuevos. La full vieja se conserva
      // fisicamente; si no se pudo copiar, dejamos el path viejo como respaldo.
      await sb(env, `workers_master?id_number=eq.${encodeURIComponent(m.id_number)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          photo_key: key,
          photo_thumb_path: `${key}.jpg`,
          photo_full_path: newFullPath || m.photo_full_path,
        }),
      });
      migrated++;
    } catch (e) {
      failed++;
      errors.push(`${m.id_number}: ${String(e.message || e)}`);
    }
  }

  // remaining = cuantas siguen pendientes despues de esta tanda (aprox: las
  // que fallaron siguen sin photo_key, asi que se reintentan en la proxima).
  const remaining = totalPending - migrated;
  return json({
    ok: true,
    batch: list.length,
    migrated, failed,
    remaining: remaining < 0 ? 0 : remaining,
    done: remaining <= 0,
    errors: errors.slice(0, 20),
  });
}
