/* =====================================================================
   functions/api/personnel-docs.js  →  /api/personnel-docs
   Biblioteca GLOBAL de documentos del personal (modelos de cartas,
   planillas, formatos). Admin/superadmin suben, editan y archivan;
   las empresas (tiendas) solo ven y descargan. Versionado + auditoria.

   Archivos en Storage privado 'personnel-docs' (Word/PDF/Excel).
   En BD solo van rutas + metadatos:
     personnel_documents          -> documento logico (titulo, desc, cat, vers)
     personnel_document_versions  -> cada archivo subido (v1, v2...)
     personnel_document_audit     -> rastro de acciones
     personnel_doc_categories     -> categorias (configurable)

   Acciones (POST {action, user}):
     - list           : lista de documentos (+ categorias). Filtros opcionales.
     - versions       : historial de versiones de un documento (con URLs firmadas).
     - audit          : rastro de un documento.
     - download       : URL firmada de descarga (version vigente o una dada).
     - create         : crea documento + sube su primera version (v1).  [admin]
     - upload_version : sube una version nueva a un documento existente.  [admin]
     - update         : edita titulo/categoria/descripcion.              [admin]
     - archive        : archiva (no borra) un documento.                 [admin]
     - restore        : restaura un documento archivado.                 [admin]
     - cat_list/cat_save/cat_toggle : ABM de categorias.        [superadmin]

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const BUCKET = 'personnel-docs';
const SIGNED_TTL = 60 * 60;            // 1h
const MAX_BYTES = 10 * 1024 * 1024;    // 10 MB tope server-side

// Tipos permitidos (espejo del bucket). ext canonico por mime.
const MIME_EXT = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
};

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
async function storageSignedUrl(env, path, downloadName) {
  if (!path) return null;
  try {
    const body = { expiresIn: SIGNED_TTL };
    const res = await fetch(`${env.supabase_url}/storage/v1/object/sign/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        apikey: env.supabase_service_role,
        Authorization: `Bearer ${env.supabase_service_role}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const js = await res.json();
    const rel = js && (js.signedURL || js.signedUrl);
    if (!rel) return null;
    // Forzar descarga con el nombre original si se pide.
    const dl = downloadName ? `&download=${encodeURIComponent(downloadName)}` : '';
    return `${env.supabase_url}/storage/v1${rel}${dl}`;
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
function extFor(mime, name) {
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : 'bin';
}
function slug(s) {
  return String(s || 'documento').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'documento';
}

/* Resuelve el usuario de sesion: valida que exista y devuelve
   { kind, actor, role }. actor = nombre legible para autoria/auditoria.
   - admin/superadmin: por id en admin_users (actor = username; role real).
   - company: por companyCode (actor = companyCode; role = 'company').
   Esto NO confia en lo que diga el cliente sobre su rol: se revalida. */
async function resolveUser(env, user) {
  if (!user) return null;
  if (user.kind === 'company') {
    const cc = String(user.companyCode || '').trim();
    if (!cc) return null;
    const c = await sb(env, `companies?company_code=eq.${encodeURIComponent(cc)}&select=company_code`);
    if (!c || !c.length) return null;
    return { kind: 'company', actor: cc, role: 'company' };
  }
  if (user.kind === 'admin' && user.id) {
    const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,username,name,role`);
    if (!a || !a.length) return null;
    return { kind: 'admin', actor: a[0].username || a[0].name || ('admin#' + a[0].id), role: a[0].role };
  }
  return null;
}
function isManager(u) { return u && u.kind === 'admin' && (u.role === 'admin' || u.role === 'superadmin'); }

/* Registra una entrada de auditoria (no critica: si falla, no aborta). */
async function audit(env, documentId, action, detail, actorObj, versionNo) {
  try {
    await sb(env, 'personnel_document_audit', {
      method: 'POST',
      body: JSON.stringify({
        document_id: documentId, action, detail: detail || null,
        version_no: versionNo || null, actor: actorObj.actor, actor_kind: actorObj.role,
      }),
    });
  } catch { /* el rastro es deseable pero no debe romper la operacion */ }
}

/* ===================== Handler ===================== */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido' }, 400); }

  const action = body.action;
  try {
    const u = await resolveUser(env, body.user);
    if (!u) return json({ ok: false, error: 'Sesion no valida.' }, 403);

    // Lectura: cualquiera autenticado (admin/superadmin/company).
    if (action === 'list') return await listDocs(env, body, u);
    if (action === 'versions') return await listVersions(env, body, u);
    if (action === 'audit') return await listAudit(env, body, u);
    if (action === 'download') return await downloadDoc(env, body, u);
    if (action === 'cat_list') return await catList(env);

    // Gestion: solo admin/superadmin.
    if (!isManager(u)) return json({ ok: false, error: 'No tienes permiso para esta accion.' }, 403);

    if (action === 'create') return await createDoc(env, body, u);
    if (action === 'upload_version') return await uploadVersion(env, body, u);
    if (action === 'update') return await updateDoc(env, body, u);
    if (action === 'archive') return await archiveDoc(env, body, u);
    if (action === 'restore') return await restoreDoc(env, body, u);

    // ABM de categorias: solo superadmin.
    if (['cat_save', 'cat_toggle'].includes(action)) {
      if (u.role !== 'superadmin') return json({ ok: false, error: 'Solo el superadmin gestiona categorias.' }, 403);
      if (action === 'cat_save') return await catSave(env, body);
      if (action === 'cat_toggle') return await catToggle(env, body);
    }

    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}

/* ---------- Categorias ---------- */
async function catList(env) {
  const cats = await sb(env, 'personnel_doc_categories?order=sort_order.asc&select=id,code,label,sort_order,is_active');
  return json({ ok: true, categories: cats || [] });
}
async function catSave(env, body) {
  const c = body.category || {};
  const label = String(c.label || '').trim();
  if (!label) return json({ ok: false, error: 'Falta el nombre de la categoria.' }, 400);
  if (c.id) {
    await sb(env, `personnel_doc_categories?id=eq.${encodeURIComponent(c.id)}`, {
      method: 'PATCH', body: JSON.stringify({ label, sort_order: parseInt(c.sort_order, 10) || 100 }),
    });
    return json({ ok: true, id: c.id });
  }
  const code = slug(c.code || label).toLowerCase();
  const row = await sb(env, 'personnel_doc_categories', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ code, label, sort_order: parseInt(c.sort_order, 10) || 100 }),
  });
  return json({ ok: true, id: row && row[0] && row[0].id });
}
async function catToggle(env, body) {
  const id = parseInt(body.id, 10);
  if (!id) return json({ ok: false, error: 'Falta id.' }, 400);
  await sb(env, `personnel_doc_categories?id=eq.${id}`, {
    method: 'PATCH', body: JSON.stringify({ is_active: !!body.active }),
  });
  return json({ ok: true, id });
}

/* ---------- LIST ---------- */
async function listDocs(env, body, u) {
  // La tienda solo ve activos. El admin puede pedir incluir archivados.
  const scope = body.scope || 'active';   // active | all | archived
  let filter = '';
  if (u.kind === 'company' || scope === 'active') filter = '&is_archived=eq.false';
  else if (scope === 'archived') filter = '&is_archived=eq.true';
  // scope 'all' (solo admin): sin filtro de archivado.

  const docs = await sb(env,
    `personnel_documents?select=id,title,description,category_id,current_version,is_archived,`
    + `archived_at,archived_by,archive_reason,created_by,created_at,updated_by,updated_at`
    + `${filter}&order=is_archived.asc,title.asc`);

  const cats = await sb(env, 'personnel_doc_categories?select=id,code,label');
  const catById = {};
  (cats || []).forEach(c => { catById[c.id] = c; });

  // Para cada documento, traer metadatos de su version vigente (nombre/tipo/tam).
  const ids = (docs || []).map(d => d.id);
  let curByDoc = {};
  if (ids.length) {
    const inList = ids.join(',');
    // Trae todas las versiones de estos docs; nos quedamos con la vigente.
    const vers = await sb(env,
      `personnel_document_versions?document_id=in.(${inList})`
      + `&select=document_id,version_no,original_name,mime_type,size_bytes,ext,uploaded_by,uploaded_at`
      + `&order=document_id.asc,version_no.desc`);
    (vers || []).forEach(v => {
      // la primera que veo de cada doc es la de mayor version_no (orden desc)
      if (!curByDoc[v.document_id]) curByDoc[v.document_id] = v;
    });
  }

  const items = (docs || []).map(d => {
    const cv = curByDoc[d.id] || null;
    const cat = d.category_id ? catById[d.category_id] : null;
    return {
      id: d.id,
      title: d.title,
      description: d.description || null,
      category_id: d.category_id || null,
      category: cat ? cat.label : null,
      category_code: cat ? cat.code : null,
      current_version: d.current_version || 0,
      is_archived: !!d.is_archived,
      archived_at: d.archived_at || null,
      archived_by: d.archived_by || null,
      archive_reason: d.archive_reason || null,
      created_by: d.created_by,
      created_at: d.created_at,
      updated_by: d.updated_by || d.created_by,
      updated_at: d.updated_at,
      // de la version vigente
      file_name: cv ? cv.original_name : null,
      file_ext: cv ? cv.ext : null,
      file_mime: cv ? cv.mime_type : null,
      file_size: cv ? cv.size_bytes : null,
      file_uploaded_by: cv ? cv.uploaded_by : null,
      file_uploaded_at: cv ? cv.uploaded_at : null,
    };
  });

  return json({ ok: true, documents: items, categories: cats || [], can_manage: isManager(u) });
}

/* ---------- VERSIONS ---------- */
async function listVersions(env, body, u) {
  const id = parseInt(body.document_id, 10);
  if (!id) return json({ ok: false, error: 'Falta el documento.' }, 400);
  const doc = await sb(env, `personnel_documents?id=eq.${id}&select=id,title,current_version,is_archived`);
  if (!doc || !doc.length) return json({ ok: false, error: 'Documento no encontrado.' }, 404);
  // La tienda no ve versiones de archivados.
  if (u.kind === 'company' && doc[0].is_archived) return json({ ok: false, error: 'No disponible.' }, 404);

  const vers = await sb(env,
    `personnel_document_versions?document_id=eq.${id}`
    + `&select=id,version_no,original_name,mime_type,size_bytes,ext,comment,uploaded_by,uploaded_at,storage_path`
    + `&order=version_no.desc`);

  const items = await Promise.all((vers || []).map(async v => ({
    id: v.id,
    version_no: v.version_no,
    original_name: v.original_name,
    mime_type: v.mime_type,
    size_bytes: v.size_bytes,
    ext: v.ext,
    comment: v.comment || null,
    uploaded_by: v.uploaded_by,
    uploaded_at: v.uploaded_at,
    is_current: v.version_no === doc[0].current_version,
    url: await storageSignedUrl(env, v.storage_path, v.original_name),
  })));

  return json({ ok: true, title: doc[0].title, versions: items });
}

/* ---------- AUDIT ---------- */
async function listAudit(env, body, u) {
  // El rastro es informacion de gestion: solo admin/superadmin.
  if (!isManager(u)) return json({ ok: false, error: 'No tienes permiso.' }, 403);
  const id = parseInt(body.document_id, 10);
  if (!id) return json({ ok: false, error: 'Falta el documento.' }, 400);
  const rows = await sb(env,
    `personnel_document_audit?document_id=eq.${id}`
    + `&select=action,detail,version_no,actor,actor_kind,created_at&order=created_at.desc`);
  return json({ ok: true, audit: rows || [] });
}

/* ---------- DOWNLOAD ---------- */
async function downloadDoc(env, body, u) {
  const id = parseInt(body.document_id, 10);
  if (!id) return json({ ok: false, error: 'Falta el documento.' }, 400);
  const doc = await sb(env, `personnel_documents?id=eq.${id}&select=id,current_version,is_archived`);
  if (!doc || !doc.length) return json({ ok: false, error: 'Documento no encontrado.' }, 404);
  if (u.kind === 'company' && doc[0].is_archived) return json({ ok: false, error: 'No disponible.' }, 404);

  const verNo = parseInt(body.version_no, 10) || doc[0].current_version;
  const v = await sb(env,
    `personnel_document_versions?document_id=eq.${id}&version_no=eq.${verNo}`
    + `&select=storage_path,original_name`);
  if (!v || !v.length) return json({ ok: false, error: 'Version no encontrada.' }, 404);

  const url = await storageSignedUrl(env, v[0].storage_path, v[0].original_name);
  if (!url) return json({ ok: false, error: 'No se pudo generar el enlace.' }, 500);
  // Rastro de descarga (opcional; util para saber uso). No bloquea.
  await audit(env, id, 'download', `Descargo v${verNo} (${v[0].original_name})`, u, verNo);
  return json({ ok: true, url, file_name: v[0].original_name, version_no: verNo });
}

/* ---------- CREATE (documento + v1) ---------- */
async function createDoc(env, body, u) {
  const title = String(body.title || '').trim();
  if (!title) return json({ ok: false, error: 'Falta el titulo.' }, 400);
  const fileB64 = String(body.file_b64 || '');
  if (!fileB64) return json({ ok: false, error: 'Falta el archivo.' }, 400);

  const mime = String(body.mime || '').trim();
  const origName = String(body.file_name || 'documento').trim();
  const ext = extFor(mime, origName);
  if (!MIME_EXT[mime]) return json({ ok: false, error: 'Tipo de archivo no permitido. Usa Word, PDF o Excel.' }, 400);

  const bytes = b64ToBytes(fileB64);
  if (!bytes.length) return json({ ok: false, error: 'El archivo esta vacio.' }, 400);
  if (bytes.length > MAX_BYTES) return json({ ok: false, error: 'El archivo supera 10 MB.' }, 413);

  const categoryId = body.category_id ? parseInt(body.category_id, 10) : null;
  const description = (body.description || '').trim() || null;
  const comment = (body.comment || '').trim() || 'Version inicial';

  // 1) crear el documento (current_version 0 hasta subir el archivo)
  const docRow = await sb(env, 'personnel_documents', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      title, description, category_id: categoryId,
      current_version: 0, created_by: u.actor, updated_by: u.actor,
    }),
  });
  const docId = docRow && docRow[0] && docRow[0].id;
  if (!docId) return json({ ok: false, error: 'No se pudo crear el documento.' }, 500);

  // 2) subir el archivo (v1) al Storage
  const path = `${docId}/v1_${slug(title)}.${ext}`;
  await storageUpload(env, path, bytes, mime);

  // 3) registrar la version + actualizar current_version
  await sb(env, 'personnel_document_versions', {
    method: 'POST',
    body: JSON.stringify({
      document_id: docId, version_no: 1, storage_path: path,
      original_name: origName, mime_type: mime, size_bytes: bytes.length, ext,
      comment, uploaded_by: u.actor,
    }),
  });
  await sb(env, `personnel_documents?id=eq.${docId}`, {
    method: 'PATCH', body: JSON.stringify({ current_version: 1, updated_by: u.actor, updated_at: new Date().toISOString() }),
  });

  await audit(env, docId, 'create', `Creo el documento "${title}" (v1)`, u, 1);
  return json({ ok: true, id: docId, version_no: 1 });
}

/* ---------- UPLOAD VERSION ---------- */
async function uploadVersion(env, body, u) {
  const id = parseInt(body.document_id, 10);
  if (!id) return json({ ok: false, error: 'Falta el documento.' }, 400);
  const doc = await sb(env, `personnel_documents?id=eq.${id}&select=id,title,current_version`);
  if (!doc || !doc.length) return json({ ok: false, error: 'Documento no encontrado.' }, 404);

  const fileB64 = String(body.file_b64 || '');
  if (!fileB64) return json({ ok: false, error: 'Falta el archivo.' }, 400);
  const mime = String(body.mime || '').trim();
  const origName = String(body.file_name || 'documento').trim();
  const ext = extFor(mime, origName);
  if (!MIME_EXT[mime]) return json({ ok: false, error: 'Tipo de archivo no permitido. Usa Word, PDF o Excel.' }, 400);

  const bytes = b64ToBytes(fileB64);
  if (!bytes.length) return json({ ok: false, error: 'El archivo esta vacio.' }, 400);
  if (bytes.length > MAX_BYTES) return json({ ok: false, error: 'El archivo supera 10 MB.' }, 413);

  const nextNo = (doc[0].current_version || 0) + 1;
  const comment = (body.comment || '').trim() || null;
  const path = `${id}/v${nextNo}_${slug(doc[0].title)}.${ext}`;
  await storageUpload(env, path, bytes, mime);

  await sb(env, 'personnel_document_versions', {
    method: 'POST',
    body: JSON.stringify({
      document_id: id, version_no: nextNo, storage_path: path,
      original_name: origName, mime_type: mime, size_bytes: bytes.length, ext,
      comment, uploaded_by: u.actor,
    }),
  });
  await sb(env, `personnel_documents?id=eq.${id}`, {
    method: 'PATCH', body: JSON.stringify({ current_version: nextNo, updated_by: u.actor, updated_at: new Date().toISOString() }),
  });

  await audit(env, id, 'upload_version', `Subio la version v${nextNo}${comment ? ' — ' + comment : ''}`, u, nextNo);
  return json({ ok: true, id, version_no: nextNo });
}

/* ---------- UPDATE (titulo/categoria/descripcion) ---------- */
async function updateDoc(env, body, u) {
  const id = parseInt(body.document_id, 10);
  if (!id) return json({ ok: false, error: 'Falta el documento.' }, 400);
  const title = String(body.title || '').trim();
  if (!title) return json({ ok: false, error: 'Falta el titulo.' }, 400);
  const patch = {
    title,
    description: (body.description || '').trim() || null,
    category_id: body.category_id ? parseInt(body.category_id, 10) : null,
    updated_by: u.actor, updated_at: new Date().toISOString(),
  };
  await sb(env, `personnel_documents?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  await audit(env, id, 'edit', `Edito datos del documento (titulo/categoria/descripcion)`, u);
  return json({ ok: true, id });
}

/* ---------- ARCHIVE / RESTORE ---------- */
async function archiveDoc(env, body, u) {
  const id = parseInt(body.document_id, 10);
  if (!id) return json({ ok: false, error: 'Falta el documento.' }, 400);
  const reason = (body.reason || '').trim() || null;
  await sb(env, `personnel_documents?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      is_archived: true, archived_at: new Date().toISOString(),
      archived_by: u.actor, archive_reason: reason,
      updated_by: u.actor, updated_at: new Date().toISOString(),
    }),
  });
  await audit(env, id, 'archive', `Archivo el documento${reason ? ' — ' + reason : ''}`, u);
  return json({ ok: true, id, archived: true });
}
async function restoreDoc(env, body, u) {
  const id = parseInt(body.document_id, 10);
  if (!id) return json({ ok: false, error: 'Falta el documento.' }, 400);
  await sb(env, `personnel_documents?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      is_archived: false, archived_at: null, archived_by: null, archive_reason: null,
      updated_by: u.actor, updated_at: new Date().toISOString(),
    }),
  });
  await audit(env, id, 'restore', `Restauro el documento`, u);
  return json({ ok: true, id, archived: false });
}
