/* =====================================================================
   functions/api/worker-photo.js  →  /api/worker-photo
   Personal de una empresa: directorio + foto + perfil (workers_master).

   Foto en Storage privado 'worker-photos' (dos versiones cuadradas):
     - thumb/  300x300  (grid)
     - full/   800x800  (visor / export a AX)
   workers_master guarda solo rutas + metadatos, nunca el binario.

   Acciones (POST {action}):
     - directory    : roster de la empresa + estado de foto + URL firmada
                      de la miniatura + datos de la empresa + catalogo de
                      bancos (para mostrar/validar la cuenta).
     - save         : sube las dos versiones (ya comprimidas) y graba
                      rutas/metadatos en workers_master. Devuelve URLs
                      firmadas (thumb + full).
     - save_profile : PATCH de los datos de la persona en workers_master
                      (nombre, nacimiento, genero, banco, contacto...).
     - remove       : quita la foto (bucket + columnas photo_*).

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const BUCKET = 'worker-photos';
const SIGNED_TTL = 60 * 60;          // 1h
const MAX_FULL_BYTES = 400 * 1024;   // tope server-side de la version grande

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
async function storageUpload(env, path, bytes, mime) {
  const res = await fetch(`${env.supabase_url}/storage/v1/object/${BUCKET}/${path}`, {
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
async function storageRemove(env, paths) {
  if (!paths || !paths.length) return;
  await fetch(`${env.supabase_url}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: paths }),
  }).catch(() => { /* no critico */ });
}
async function storageSignedUrl(env, path) {
  if (!path) return null;
  try {
    const res = await fetch(`${env.supabase_url}/storage/v1/object/sign/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        apikey: env.supabase_service_role,
        Authorization: `Bearer ${env.supabase_service_role}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: SIGNED_TTL }),
    });
    if (!res.ok) return null;
    const js = await res.json();
    const rel = js && (js.signedURL || js.signedUrl);
    return rel ? `${env.supabase_url}/storage/v1${rel}` : null;
  } catch { return null; }
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

/* ===================== Handler ===================== */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido' }, 400); }

  const action = body.action;
  const cc = (body.company_code || '').trim();
  const user = body.user || null;

  try {
    if (!cc) return json({ ok: false, error: 'Falta la empresa.' }, 400);
    if (!(await userCanAccess(env, user, cc))) return json({ ok: false, error: 'No tienes acceso a esta empresa.' }, 403);

    if (action === 'directory') return await directory(env, cc);
    if (action === 'save') return await savePhoto(env, cc, body);
    if (action === 'save_profile') return await saveProfile(env, cc, body);
    if (action === 'remove') return await removePhoto(env, cc, body);

    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}

/* ---------- DIRECTORY ---------- */
async function directory(env, cc) {
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

  // Roster de la empresa.
  const workers = await sb(env,
    `store_workers?company_code=eq.${encodeURIComponent(cc)}`
    + `&select=id_number,full_name,role,end_date,source&order=full_name.asc`);
  const ceds = (workers || []).map(w => w.id_number).filter(Boolean);

  // Metadatos del snapshot (cuando se cargo el Reporte 10, cuantos).
  const metaArr = await sb(env,
    `store_roster_meta?company_code=eq.${encodeURIComponent(cc)}`
    + `&select=uploaded_at,uploaded_by,total_count,source_file`);
  const meta = metaArr && metaArr[0] ? metaArr[0] : null;

  // Maestra de los de este roster.
  let masterByCed = {};
  if (ceds.length) {
    const inList = ceds.map(c => `"${c}"`).join(',');
    const master = await sb(env,
      `workers_master?id_number=in.(${inList})`
      + `&select=id_number,first_name,second_name,last_names,full_name,role,birth_date,gender,marital_status,`
      + `account_number,bank_code,phone,email,address,data_id,`
      + `photo_thumb_path,photo_full_path,photo_uploaded_by,photo_uploaded_at,updated_at`);
    (master || []).forEach(m => { masterByCed[m.id_number] = m; });
  }

  const items = await Promise.all((workers || []).map(async w => {
    const m = masterByCed[w.id_number] || {};
    const hasPhoto = !!m.photo_thumb_path;
    const thumbUrl = hasPhoto ? await storageSignedUrl(env, m.photo_thumb_path) : null;
    const fullUrl = m.photo_full_path ? await storageSignedUrl(env, m.photo_full_path) : null;
    return {
      id_number: w.id_number,
      ced_kind: cedKind(w.id_number),
      // Nombre: el de la maestra si existe; si no, el del roster.
      full_name: m.full_name || w.full_name,
      first_name: m.first_name || null,
      second_name: m.second_name || null,
      last_names: m.last_names || null,
      role: m.role || w.role || null,
      end_date: w.end_date || null,
      birth_date: m.birth_date || null,
      gender: m.gender || null,
      marital_status: m.marital_status || null,
      account_number: m.account_number || null,
      bank_code: m.bank_code || null,
      phone: m.phone || null,
      email: m.email || null,
      address: m.address || null,
      data_id: m.data_id || null,
      has_photo: hasPhoto,
      thumb_url: thumbUrl,
      full_url: fullUrl,
      photo_uploaded_by: m.photo_uploaded_by || null,
      updated_at: m.updated_at || null,
      source: w.source || 'report10',
    };
  }));

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
    meta,
    workers: items,
  });
}

/* ---------- SAVE (foto) ---------- */
async function savePhoto(env, cc, body) {
  const ced = String(body.id_number || '').replace(/[^0-9]/g, '');
  if (!ced || ced.length < 6 || ced.length > 8) return json({ ok: false, error: 'Cedula invalida.' }, 400);

  const inStore = await sb(env,
    `store_workers?company_code=eq.${encodeURIComponent(cc)}&id_number=eq.${encodeURIComponent(ced)}&select=id_number,full_name,first_name,second_name,last_names`);
  if (!inStore || !inStore.length) return json({ ok: false, error: 'Ese trabajador no esta en la lista de la empresa.' }, 404);

  const fullB64 = String(body.full_b64 || '');
  const thumbB64 = String(body.thumb_b64 || '');
  if (!fullB64 || !thumbB64) return json({ ok: false, error: 'Faltan las imagenes (grande y miniatura).' }, 400);

  const mime = String(body.mime || 'image/jpeg');
  const ext = extFromMime(mime);
  const fullBytes = b64ToBytes(fullB64);
  const thumbBytes = b64ToBytes(thumbB64);
  if (fullBytes.length > MAX_FULL_BYTES) {
    return json({ ok: false, error: 'La foto pesa demasiado. Reintenta (deberia comprimirse sola).' }, 413);
  }

  const tag = `${cedKind(ced)}-${ced}`;
  const fullPath = `full/${tag}.${ext}`;
  const thumbPath = `thumb/${tag}.${ext}`;
  await storageUpload(env, fullPath, fullBytes, mime);
  await storageUpload(env, thumbPath, thumbBytes, mime);

  const photoPatch = {
    photo_full_path: fullPath,
    photo_thumb_path: thumbPath,
    photo_w: parseInt(body.width, 10) || null,
    photo_h: parseInt(body.height, 10) || null,
    photo_bytes: fullBytes.length,
    photo_uploaded_at: new Date().toISOString(),
    photo_uploaded_by: (body.uploaded_by || '').trim() || cc,
    last_source_company: cc,
  };

  const exists = await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}&select=id_number`);
  if (exists && exists.length) {
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

  const [thumbUrl, fullUrl] = await Promise.all([storageSignedUrl(env, thumbPath), storageSignedUrl(env, fullPath)]);
  return json({ ok: true, id_number: ced, thumb_url: thumbUrl, full_url: fullUrl, bytes: fullBytes.length });
}

/* ---------- SAVE_PROFILE (datos de la persona) ---------- */
async function saveProfile(env, cc, body) {
  const ced = String(body.id_number || '').replace(/[^0-9]/g, '');
  if (!ced || ced.length < 6 || ced.length > 8) return json({ ok: false, error: 'Cedula invalida.' }, 400);
  const p = body.profile || {};

  // La persona debe pertenecer al roster de esta empresa.
  const inStore = await sb(env,
    `store_workers?company_code=eq.${encodeURIComponent(cc)}&id_number=eq.${encodeURIComponent(ced)}&select=id_number,full_name`);
  if (!inStore || !inStore.length) return json({ ok: false, error: 'Ese trabajador no esta en la lista de la empresa.' }, 404);

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
  if (p.marital_status && !['S', 'C', 'D', 'V'].includes(p.marital_status)) return json({ ok: false, error: 'Estado civil invalido.' }, 400);
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return json({ ok: false, error: 'Correo invalido.' }, 400);

  const patch = {
    first_name: p.first_name || null,
    second_name: p.second_name || null,
    last_names: p.last_names || null,
    full_name: p.full_name || null,
    role: p.role || null,
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

  const exists = await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}&select=id_number`);
  if (exists && exists.length) {
    await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  } else {
    await sb(env, 'workers_master', {
      method: 'POST',
      body: JSON.stringify({ id_number: ced, ced_kind: cedKind(ced), ...patch }),
    });
  }
  return json({ ok: true, id_number: ced });
}

/* ---------- REMOVE (foto) ---------- */
async function removePhoto(env, cc, body) {
  const ced = String(body.id_number || '').replace(/[^0-9]/g, '');
  if (!ced) return json({ ok: false, error: 'Cedula invalida.' }, 400);

  const rows = await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}&select=photo_full_path,photo_thumb_path`);
  const m = rows && rows[0];
  if (m) {
    await storageRemove(env, [m.photo_full_path, m.photo_thumb_path].filter(Boolean));
    await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        photo_full_path: null, photo_thumb_path: null,
        photo_w: null, photo_h: null, photo_bytes: null,
        photo_uploaded_at: null, photo_uploaded_by: null,
      }),
    });
  }
  return json({ ok: true, id_number: ced, removed: true });
}
