/* =====================================================================
   functions/api/bank-ref.js — Referencias bancarias (PDF) de la ficha. F1.
   El PDF se extrae en el NAVEGADOR (pdfjs); aqui solo se guarda: el archivo
   al bucket privado 'bank-refs' y una fila en nomina_v2.bank_references.

   NO toca la cuenta manual del trabajador: la adopcion del numero se decide
   al Publicar (Sincronizar, hcm.publish.bank). Las advertencias viven en
   validaciones (jsonb) y persisten hasta corregir la cedula o cambiar el PDF.

   Acciones:
     save  (bankref.upload) : sube el PDF + inserta la referencia (pendiente)
     list  (view.fotos)     : lista las referencias de un trabajador (recientes 1o)
     sign  (view.fotos)     : firma la URL de un PDF de respaldo (1h)
     annul (bankref.upload) : marca una referencia como anulada (al reemplazar)
   ===================================================================== */
import { resolveActor, can } from './_auth.js';

const BUCKET = 'bank-refs';
const SIGNED_TTL = 60 * 60;   // 1h
const MAX_BYTES = 10 * 1024 * 1024;

// Lectura (list/sign) permitida desde la ficha (view.fotos) Y desde la
// pantalla Datos Bancarios · Cuentas (view.bankaccounts).
const ACTION_CODE = {
  save: ['bankref.upload'],
  annul: ['docs.remove'],   // quitar es correccion (coordinador/admin/superadmin)
  list: ['view.fotos', 'view.bankaccounts'],
  sign: ['view.fotos', 'view.bankaccounts'],
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

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido.' }, 400); }

  const action = norm(body.action);
  const codes = ACTION_CODE[action];
  if (!codes) return json({ ok: false, error: 'Accion no valida.' }, 400);

  const actor = await resolveActor(env, body.user);
  if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
  if (!codes.some(c => can(actor, c))) return json({ ok: false, error: 'No tienes permiso para esta accion.' }, 403);

  try {
    if (action === 'save')  return await saveRef(env, actor, body);
    if (action === 'list')  return await listRefs(env, body);
    if (action === 'sign')  return await signRef(env, body);
    if (action === 'annul') return await annulRef(env, body);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
  return json({ ok: false, error: 'Accion no valida.' }, 400);
}

/* ---------- save: guarda PDF + fila (estado pendiente) ---------- */
async function saveRef(env, actor, body) {
  const idNumber = cleanDigits(body.id_number);
  if (!idNumber) return json({ ok: false, error: 'Falta la cedula del trabajador.' }, 400);
  if (!body.pdf_base64) return json({ ok: false, error: 'Falta el PDF.' }, 400);

  const bytes = b64ToBytes(body.pdf_base64);
  if (!bytes.length) return json({ ok: false, error: 'El PDF llego vacio.' }, 400);
  if (bytes.length > MAX_BYTES) return json({ ok: false, error: 'El PDF supera 10 MB.' }, 400);

  const storagePath = `${idNumber}/${Date.now()}.pdf`;
  await storageUpload(env, storagePath, bytes, 'application/pdf');

  const plantilla = ['bdv', 'banesco', 'mercantil', 'bancamiga', 'otro'].includes(body.plantilla) ? body.plantilla : 'otro';
  const row = {
    id_number: idNumber,
    plantilla,
    banco_code: norm(body.banco_code) || null,
    banco_nombre: norm(body.banco_nombre) || null,
    cuenta: body.cuenta ? (cleanDigits(body.cuenta, 20) || null) : null,
    cuenta_last4: body.cuenta_last4 ? cleanDigits(body.cuenta_last4, 4) : null,
    tipo_cuenta: norm(body.tipo_cuenta) || null,
    cedula_pdf: body.cedula_pdf ? cleanDigits(body.cedula_pdf) : null,
    nombre_pdf: norm(body.nombre_pdf) || null,
    nro_operacion: norm(body.nro_operacion) || null,
    fecha_emision: norm(body.fecha_emision) || null,     // 'YYYY-MM-DD' o null
    fecha_apertura: norm(body.fecha_apertura) || null,
    validaciones: (body.validaciones && typeof body.validaciones === 'object') ? body.validaciones : {},
    estado: 'pendiente',
    storage_path: storagePath,
    uploaded_by: String(actor.actor || ''),
  };

  const ins = await sb(env, 'bank_references', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  const saved = Array.isArray(ins) ? ins[0] : ins;
  const signed = await storageSignedUrl(env, storagePath);
  return json({ ok: true, reference: saved, signed_url: signed });
}

/* ---------- list: referencias de un trabajador ---------- */
async function listRefs(env, body) {
  const idNumber = cleanDigits(body.id_number);
  if (!idNumber) return json({ ok: false, error: 'Falta la cedula.' }, 400);
  const rows = await sb(env,
    `bank_references?id_number=eq.${encodeURIComponent(idNumber)}`
    + `&order=created_at.desc&select=*`);
  return json({ ok: true, references: rows || [] });
}

/* ---------- sign: firma la URL del PDF ---------- */
async function signRef(env, body) {
  const path = norm(body.storage_path);
  if (!path) return json({ ok: false, error: 'Falta la ruta del PDF.' }, 400);
  const url = await storageSignedUrl(env, path);
  if (!url) return json({ ok: false, error: 'No se pudo firmar la URL del PDF.' }, 502);
  return json({ ok: true, signed_url: url });
}

/* ---------- annul: marca una referencia como anulada (al reemplazar) ---------- */
async function annulRef(env, body) {
  const id = parseInt(body.id, 10);
  if (!id) return json({ ok: false, error: 'Falta el id de la referencia.' }, 400);
  await sb(env, `bank_references?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ estado: 'anulada', updated_at: new Date().toISOString() }),
  });
  return json({ ok: true });
}
