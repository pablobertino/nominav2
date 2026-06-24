/* =====================================================================
   functions/api/worker-photo.js  →  /api/worker-photo
   Directorio de fichas de colaboradores y captura de su foto (tipo carnet).

   La foto vive en el Storage privado 'worker-photos' (dos versiones por
   persona: full/ y thumb/). La tabla workers_master (registro PERMANENTE
   por cedula, sin empresa) guarda solo las RUTAS + metadatos, nunca el
   binario. Asi la foto sobrevive al movimiento del trabajador entre
   tiendas y luego alimentara AX.

   El grid de una tienda se arma cruzando store_workers (su gente) con
   workers_master (la foto). Una tienda solo ve a SU roster; un admin/
   superadmin elige tienda primero (igual que el wizard) y su acceso se
   valida server-side contra su alcance.

   Acciones (POST {action}):
     - directory : lista del roster de una tienda + estado de foto + URL
                   firmada de la miniatura (para mostrar el grid).
         { action:'directory', company_code, user:{kind,id,companyCode} }
     - save      : sube las dos versiones (ya comprimidas en el navegador)
                   al bucket y guarda rutas/metadatos en workers_master.
         { action:'save', company_code, user, id_number,
           full_b64, thumb_b64, mime, width, height, bytes, uploaded_by }
     - remove    : quita la foto (borra del bucket + limpia workers_master).
         { action:'remove', company_code, user, id_number }

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const BUCKET = 'worker-photos';
const SIGNED_TTL = 60 * 60;   // 1h: vida de la URL firmada de la miniatura

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

// REST de PostgREST (datos). Mismo helper que el resto de endpoints.
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

/* ---------- Storage (API REST de Supabase Storage) ---------- */

// Sube (o reemplaza) un objeto al bucket. 'bytes' es un Uint8Array. Usa
// x-upsert para sobreescribir si ya existia (cambiar la foto de alguien).
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

// Borra una lista de objetos del bucket. No lanza si alguno no existe.
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

// Crea una URL firmada (temporal) para un objeto del bucket privado.
// Devuelve la URL absoluta o null si el objeto no existe / falla.
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
    // La API devuelve { signedURL: '/object/sign/...?token=...' } (relativa).
    const rel = js && (js.signedURL || js.signedUrl);
    return rel ? `${env.supabase_url}/storage/v1${rel}` : null;
  } catch { return null; }
}

/* ---------- Helpers ---------- */

// Decodifica base64 (sin el prefijo data:) a Uint8Array para subir el binario.
function b64ToBytes(b64) {
  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  const bin = atob(clean);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Deriva V/E de la cedula (misma regla del sistema).
function cedKind(ced) {
  return parseInt(ced, 10) >= 80000000 ? 'E' : 'V';
}

// Extension del archivo segun el MIME (para nombrar el objeto en Storage).
function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  return 'jpg';
}

// ¿el usuario tiene acceso a esta company_code? Tienda: solo la suya.
// Admin: superadmin = todas; admin normal = las de su alcance
// (get_admin_companies). Defensa server-side: el front nunca decide el
// acceso por si solo.
async function userCanAccess(env, user, cc) {
  if (!user || !cc) return false;
  if (user.kind === 'company') {
    return String(user.companyCode || '') === String(cc);
  }
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
    if (!cc) return json({ ok: false, error: 'Falta la tienda.' }, 400);
    if (!(await userCanAccess(env, user, cc))) {
      return json({ ok: false, error: 'No tienes acceso a esta tienda.' }, 403);
    }

    if (action === 'directory') return await directory(env, cc);
    if (action === 'save') return await savePhoto(env, cc, body);
    if (action === 'remove') return await removePhoto(env, cc, body);

    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}

/* Directorio: roster de la tienda (store_workers) cruzado con la foto de
   workers_master (por cedula). Devuelve por persona: cedula, nombre, cargo,
   estado de egreso, si tiene foto y la URL firmada de la MINIATURA (para el
   grid). La foto completa no se firma aqui (se usa al exportar a AX). */
async function directory(env, cc) {
  const workers = await sb(env,
    `store_workers?company_code=eq.${encodeURIComponent(cc)}`
    + `&select=id_number,full_name,role,end_date&order=full_name.asc`);
  const ceds = (workers || []).map(w => w.id_number).filter(Boolean);

  // Traer de la maestra solo los de este roster (filtro IN por cedula).
  let masterByCed = {};
  if (ceds.length) {
    // PostgREST: in.(a,b,c) con las cedulas escapadas.
    const inList = ceds.map(c => `"${c}"`).join(',');
    const master = await sb(env,
      `workers_master?id_number=in.(${inList})`
      + `&select=id_number,photo_thumb_path,photo_full_path,photo_uploaded_at`);
    (master || []).forEach(m => { masterByCed[m.id_number] = m; });
  }

  // Firmar la miniatura de quienes tengan foto (en paralelo).
  const items = await Promise.all((workers || []).map(async w => {
    const m = masterByCed[w.id_number] || {};
    const hasPhoto = !!m.photo_thumb_path;
    const thumbUrl = hasPhoto ? await storageSignedUrl(env, m.photo_thumb_path) : null;
    return {
      id_number: w.id_number,
      ced_kind: cedKind(w.id_number),
      full_name: w.full_name,
      role: w.role || null,
      end_date: w.end_date || null,
      has_photo: hasPhoto,
      thumb_url: thumbUrl,
      photo_uploaded_at: m.photo_uploaded_at || null,
    };
  }));

  const withPhoto = items.filter(i => i.has_photo).length;
  return json({
    ok: true,
    company_code: cc,
    total: items.length,
    with_photo: withPhoto,
    pending: items.length - withPhoto,
    workers: items,
  });
}

/* Guardar foto: sube las dos versiones (ya comprimidas en el navegador) al
   bucket y graba rutas + metadatos en workers_master por cedula. La persona
   debe existir en la maestra (se crea al cargar el Reporte 10); si por algun
   motivo no existe, se inserta minima con el nombre del roster. */
async function savePhoto(env, cc, body) {
  const ced = String(body.id_number || '').replace(/[^0-9]/g, '');
  if (!ced || ced.length < 6 || ced.length > 8) {
    return json({ ok: false, error: 'Cedula invalida.' }, 400);
  }
  // La persona debe pertenecer al roster de esta tienda (no subir foto a
  // alguien de otra tienda desde aqui).
  const inStore = await sb(env,
    `store_workers?company_code=eq.${encodeURIComponent(cc)}&id_number=eq.${encodeURIComponent(ced)}&select=id_number,full_name,first_name,second_name,last_names`);
  if (!inStore || !inStore.length) {
    return json({ ok: false, error: 'Ese trabajador no esta en la lista de la tienda.' }, 404);
  }

  const fullB64 = String(body.full_b64 || '');
  const thumbB64 = String(body.thumb_b64 || '');
  if (!fullB64 || !thumbB64) {
    return json({ ok: false, error: 'Faltan las imagenes (completa y miniatura).' }, 400);
  }
  const mime = String(body.mime || 'image/jpeg');
  const ext = extFromMime(mime);

  // Validar peso real de la version completa (defensa server-side: el front
  // ya comprime, pero no se confia). Limite del bucket: 1 MB.
  const fullBytes = b64ToBytes(fullB64);
  const thumbBytes = b64ToBytes(thumbB64);
  if (fullBytes.length > 1024 * 1024) {
    return json({ ok: false, error: 'La foto pesa mas de 1 MB. Reintenta (deberia comprimirse sola).' }, 413);
  }

  // Rutas estables por cedula (con tipo V/E para legibilidad). Mismo nombre
  // siempre -> al cambiar la foto se sobreescribe (x-upsert).
  const tag = `${cedKind(ced)}-${ced}`;
  const fullPath = `full/${tag}.${ext}`;
  const thumbPath = `thumb/${tag}.${ext}`;

  // Subir ambas versiones.
  await storageUpload(env, fullPath, fullBytes, mime);
  await storageUpload(env, thumbPath, thumbBytes, mime);

  // Metadatos de la foto.
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

  // Upsert por cedula: si ya existe en la maestra, solo actualiza la foto;
  // si no existe (caso raro), la crea con el nombre del roster.
  const exists = await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}&select=id_number`);
  if (exists && exists.length) {
    await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}`, {
      method: 'PATCH', body: JSON.stringify(photoPatch),
    });
  } else {
    const w = inStore[0];
    await sb(env, 'workers_master', {
      method: 'POST',
      body: JSON.stringify({
        id_number: ced,
        ced_kind: cedKind(ced),
        full_name: w.full_name,
        first_name: w.first_name || null,
        second_name: w.second_name || null,
        last_names: w.last_names || null,
        ...photoPatch,
      }),
    });
  }

  // Devolver la URL firmada de la miniatura recien subida (para refrescar el
  // grid sin recargar todo).
  const thumbUrl = await storageSignedUrl(env, thumbPath);
  return json({
    ok: true,
    id_number: ced,
    thumb_url: thumbUrl,
    bytes: fullBytes.length,
  });
}

/* Quitar foto: borra del bucket y limpia las columnas photo_* en la maestra.
   El registro de la persona (y sus demas datos) se conserva. */
async function removePhoto(env, cc, body) {
  const ced = String(body.id_number || '').replace(/[^0-9]/g, '');
  if (!ced) return json({ ok: false, error: 'Cedula invalida.' }, 400);

  const rows = await sb(env,
    `workers_master?id_number=eq.${encodeURIComponent(ced)}&select=photo_full_path,photo_thumb_path`);
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
