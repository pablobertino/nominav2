/* =====================================================================
   functions/api/personal-doc.js — Documentos personales (PDF) de la ficha.
   Modelo GENERAL y escalable: una tabla nomina_v2.personal_documents con
   doc_type ('rif' hoy; otros a futuro) + datos jsonb con los campos propios
   de cada tipo. El PDF se extrae en el NAVEGADOR (pdfjs); aqui solo se guarda:
   el archivo al bucket privado 'personal-docs' y una fila en la tabla.

   NO reemplaza ningun dato de la ficha (la cedula NO se toca). Las
   advertencias viven en validaciones (jsonb) y persisten hasta corregir o
   cambiar el PDF. La referencia bancaria sigue en su propio endpoint
   (bank-ref.js / bank_references); esto arranca con el RIF.

   Acciones:
     save  (rif.upload)  : sube el PDF + inserta el documento (pendiente)
     list  (view.fotos)  : lista los documentos de un trabajador (recientes 1o)
     sign  (view.fotos)  : firma la URL de un PDF de respaldo (1h)
     annul (rif.upload)  : marca un documento como anulado (al reemplazar)
   ===================================================================== */
import { resolveActor, can } from './_auth.js';

const BUCKET = 'personal-docs';
const SIGNED_TTL = 60 * 60;   // 1h
const MAX_BYTES = 10 * 1024 * 1024;

// Permiso de ESCRITURA por tipo de documento. Escalable: al sumar un tipo
// nuevo se agrega aqui su permiso (o se reutiliza uno existente). Lectura
// (list/sign) se permite desde la ficha con view.fotos.
const WRITE_CODE = {
  rif: ['rif.upload'],
  cedula: ['cedula.upload'],
};
const READ_CODE = ['view.fotos'];
const REMOVE_CODE = ['docs.remove'];   // quitar/anular un documento (correccion)

const DOC_TYPES = new Set(Object.keys(WRITE_CODE));

// Formatos permitidos y extension por tipo de documento. El RIF es PDF; la
// cedula es imagen (se recorta/comprime en el navegador y llega como JPG).
const TYPE_MIME = {
  rif:    { ext: { 'application/pdf': 'pdf' }, def: 'application/pdf' },
  cedula: { ext: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }, def: 'image/jpeg' },
};
function resolveMime(docType, wanted) {
  const t = TYPE_MIME[docType] || TYPE_MIME.rif;
  const m = String(wanted || '').toLowerCase();
  if (t.ext[m]) return { mime: m, ext: t.ext[m] };
  return { mime: t.def, ext: t.ext[t.def] };
}

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

async function storageUpload(env, path, bytes, mime) {
  const res = await fetch(`${env.supabase_url}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Type': mime || 'application/pdf',
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Storage upload ${res.status}: ${await res.text()}`);
  return true;
}

async function storageSignedUrl(env, path) {
  if (!path) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
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

function b64ToBytes(b64) {
  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  const bin = atob(clean);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const norm = s => String(s == null ? '' : s).trim();
function cleanDigits(s, max) { const d = String(s || '').replace(/\D/g, ''); return max ? d.slice(0, max) : d; }
function safeDocType(t) { const v = norm(t) || 'rif'; return DOC_TYPES.has(v) ? v : null; }

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido.' }, 400); }

  const action = norm(body.action);
  const known = (action === 'save' || action === 'annul' || action === 'list' || action === 'sign');
  if (!known) return json({ ok: false, error: 'Accion no valida.' }, 400);

  const actor = await resolveActor(env, body.user);
  if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);

  // save: permiso de carga segun el tipo. annul: permiso de QUITAR (docs.remove).
  // list/sign: lectura desde la ficha.
  let codes;
  if (action === 'save') {
    const dt = safeDocType(body.doc_type);
    if (!dt) return json({ ok: false, error: 'Tipo de documento no valido.' }, 400);
    codes = WRITE_CODE[dt];
  } else if (action === 'annul') {
    codes = REMOVE_CODE;
  } else {
    codes = READ_CODE;
  }
  if (!codes.some(c => can(actor, c))) return json({ ok: false, error: 'No tienes permiso para esta accion.' }, 403);

  try {
    if (action === 'save')  return await saveDoc(env, actor, body);
    if (action === 'list')  return await listDocs(env, body);
    if (action === 'sign')  return await signDoc(env, body);
    if (action === 'annul') return await annulDoc(env, body);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
  return json({ ok: false, error: 'Accion no valida.' }, 400);
}

/* ---------- save: guarda PDF + fila (estado pendiente) ---------- */
async function saveDoc(env, actor, body) {
  const idNumber = cleanDigits(body.id_number);
  const docType = safeDocType(body.doc_type);
  if (!idNumber) return json({ ok: false, error: 'Falta la cedula del trabajador.' }, 400);
  if (!docType)  return json({ ok: false, error: 'Tipo de documento no valido.' }, 400);
  if (!body.pdf_base64) return json({ ok: false, error: 'Falta el PDF.' }, 400);

  const bytes = b64ToBytes(body.pdf_base64);
  if (!bytes.length) return json({ ok: false, error: 'El PDF llego vacio.' }, 400);
  if (bytes.length > MAX_BYTES) return json({ ok: false, error: 'El PDF supera 10 MB.' }, 400);

  const { mime, ext } = resolveMime(docType, body.mime);
  const storagePath = `${docType}/${idNumber}/${Date.now()}.${ext}`;
  await storageUpload(env, storagePath, bytes, mime);

  const row = {
    id_number: idNumber,
    doc_type: docType,
    estado: 'pendiente',
    datos: (body.datos && typeof body.datos === 'object') ? body.datos : {},
    validaciones: (body.validaciones && typeof body.validaciones === 'object') ? body.validaciones : {},
    storage_path: storagePath,
    uploaded_by: String(actor.actor || ''),
  };

  const ins = await sb(env, 'personal_documents', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  const saved = Array.isArray(ins) ? ins[0] : ins;
  const signed = await storageSignedUrl(env, storagePath);
  return json({ ok: true, document: saved, signed_url: signed });
}

/* ---------- list: documentos de un trabajador (por tipo si se indica) ---------- */
async function listDocs(env, body) {
  const idNumber = cleanDigits(body.id_number);
  if (!idNumber) return json({ ok: false, error: 'Falta la cedula.' }, 400);
  const dt = norm(body.doc_type);
  const typeFilter = (dt && DOC_TYPES.has(dt)) ? `&doc_type=eq.${encodeURIComponent(dt)}` : '';
  const rows = await sb(env,
    `personal_documents?id_number=eq.${encodeURIComponent(idNumber)}${typeFilter}`
    + `&order=created_at.desc&select=*`);
  return json({ ok: true, documents: rows || [] });
}

/* ---------- sign: firma la URL del PDF ---------- */
async function signDoc(env, body) {
  const path = norm(body.storage_path);
  if (!path) return json({ ok: false, error: 'Falta la ruta del PDF.' }, 400);
  const url = await storageSignedUrl(env, path);
  if (!url) return json({ ok: false, error: 'No se pudo firmar la URL del PDF.' }, 502);
  return json({ ok: true, signed_url: url });
}

/* ---------- annul: marca un documento como anulado (al reemplazar) ---------- */
async function annulDoc(env, body) {
  const id = parseInt(body.id, 10);
  if (!id) return json({ ok: false, error: 'Falta el id del documento.' }, 400);
  await sb(env, `personal_documents?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ estado: 'anulada', updated_at: new Date().toISOString() }),
  });
  return json({ ok: true });
}
