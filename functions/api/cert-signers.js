/* =====================================================================
   functions/api/cert-signers.js  →  /api/cert-signers
   Catalogo de FIRMANTES de constancias de trabajo (nomina_v2.cert_signers).

   Los firmantes NO son los admin_users: es un catalogo propio y editable.
   Cada firmante tiene nombre, cargo (default para sus constancias) y una
   imagen de firma (PNG, idealmente fondo transparente) guardada en el bucket
   PRIVADO 'cert-signatures' como "<uuid>.png". La columna signature_key
   guarda ese uuid; la preview se firma on-demand (signed URL).

   Acciones (POST {action}):
     - list             : grilla de firmantes (+ preview firmada de la firma).
                          Lectura abierta a admin/superadmin (para el combo de
                          firmantes al emitir una constancia). Param opcional
                          only_active:true para el combo.
     - create           : (superadmin) alta: full_name + title [+ firma PNG].
     - update           : (superadmin) edita full_name / title / is_active y,
                          opcionalmente, reemplaza la firma.
     - set_active       : (superadmin) activa/desactiva por id.
     - upload_signature : (superadmin) sube/reemplaza solo la firma de un id.
     - sign             : (admin) devuelve la URL firmada de la firma de 1..N
                          ids (para preview lazy).

   Gate: lectura = admin/superadmin; escritura = superadmin (shadow:
   'cert.signers'). Consistente con holidays.js (shadow mode vigente).

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { shadowCan } from './_auth.js';

const BUCKET = 'cert-signatures';   // privado
const SIGNED_TTL = 60 * 60;         // 1h
const MAX_SIG_BYTES = 500 * 1024;   // 500KB tope de la firma

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

/* ---------- Storage (bucket privado cert-signatures) ---------- */
async function storageUpload(env, path, bytes, mime) {
  const res = await fetch(`${env.supabase_url}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Type': mime || 'image/png',
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

/* ---------- Helpers ---------- */
function b64ToBytes(b64) {
  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  const bin = atob(clean);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function newKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
function sigPath(key) { return `${key}.png`; }
// mime -> solo PNG/JPEG/WEBP; forzamos png por defecto (firma con transparencia).
function pickMime(m) {
  const s = String(m || '').toLowerCase();
  if (s.includes('png')) return 'image/png';
  if (s.includes('webp')) return 'image/webp';
  if (s.includes('jpeg') || s.includes('jpg')) return 'image/jpeg';
  return 'image/png';
}

async function isSuperadmin(env, adminId) {
  if (!adminId) return false;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&role=eq.superadmin&is_active=eq.true&select=id`);
  return r && r.length > 0;
}
async function isAdmin(env, adminId) {
  if (!adminId) return false;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id`);
  return r && r.length > 0;
}

// Valida/normaliza nombre y cargo. Devuelve {full_name, title} o {error}.
function buildFields(body, { requireName = true } = {}) {
  const full_name = String(body.full_name || '').trim();
  if (requireName && !full_name) return { error: 'El nombre del firmante es obligatorio.' };
  if (full_name.length > 160) return { error: 'El nombre es demasiado largo.' };
  let title = body.title == null ? null : String(body.title).trim();
  if (title === '') title = null;
  if (title && title.length > 120) return { error: 'El cargo es demasiado largo.' };
  return { full_name, title };
}

// Sube la firma (si viene) y devuelve {key, w, h} o null si no habia imagen.
// Lanza si el formato/tamano no sirve.
async function maybeUploadSignature(env, body) {
  const b64 = String(body.signature_b64 || '');
  if (!b64) return null;
  const mime = pickMime(body.signature_mime);
  const bytes = b64ToBytes(b64);
  if (!bytes.length) throw new Error('La firma esta vacia.');
  if (bytes.length > MAX_SIG_BYTES) throw new Error('La firma pesa demasiado (max 500KB).');
  const key = newKey();
  await storageUpload(env, sigPath(key), bytes, mime);
  return {
    key,
    w: parseInt(body.signature_w, 10) || null,
    h: parseInt(body.signature_h, 10) || null,
  };
}

/* ===================== Handler ===================== */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const { action } = body;
  const adminId = body.adminId != null ? body.adminId : (body.user && body.user.id);

  try {
    /* ---------- LECTURA (admin/superadmin) ---------- */
    if (action === 'list') {
      if (!(await isAdmin(env, adminId))) return json({ ok: false, error: 'Sesion no valida.' }, 403);
      // Shadow: gate legacy = admin activo (isAdmin). El combo de firmantes se
      // usa al revisar solicitudes -> code view.solicitudes.
      await shadowCan(env, adminId, 'cert-signers', 'list', 'view.solicitudes', true);
      const onlyActive = !!body.only_active;
      let path = 'cert_signers?select=*&order=is_active.desc,full_name.asc';
      if (onlyActive) path = 'cert_signers?is_active=eq.true&select=*&order=full_name.asc';
      const rows = await sb(env, path) || [];
      // Firmar la preview de cada firma (on-demand). Son pocos firmantes.
      const signers = [];
      for (const r of rows) {
        let url = null;
        if (r.signature_key) url = await storageSignedUrl(env, sigPath(r.signature_key));
        signers.push({
          id: r.id,
          full_name: r.full_name,
          title: r.title,
          is_active: r.is_active,
          has_signature: !!r.signature_key,
          signature_url: url,
          signature_w: r.signature_w,
          signature_h: r.signature_h,
          created_at: r.created_at,
          created_by: r.created_by,
        });
      }
      return json({ ok: true, signers });
    }

    if (action === 'sign') {
      if (!(await isAdmin(env, adminId))) return json({ ok: false, error: 'Sesion no valida.' }, 403);
      // Shadow: gate legacy = admin activo (isAdmin). Code view.solicitudes.
      await shadowCan(env, adminId, 'cert-signers', 'sign', 'view.solicitudes', true);
      const ids = Array.isArray(body.ids)
        ? [...new Set(body.ids.map(x => parseInt(x, 10)).filter(Boolean))].slice(0, 50)
        : [];
      if (!ids.length) return json({ ok: true, signatures: {} });
      const rows = await sb(env, `cert_signers?id=in.(${ids.join(',')})&select=id,signature_key`) || [];
      const out = {};
      for (const r of rows) {
        out[r.id] = r.signature_key ? await storageSignedUrl(env, sigPath(r.signature_key)) : null;
      }
      return json({ ok: true, signatures: out });
    }

    /* ---------- ESCRITURA (superadmin; shadow cert.signers) ---------- */
    const legacyOk = await isSuperadmin(env, adminId);
    await shadowCan(env, adminId, 'cert-signers', action || '?', 'cert.signers', legacyOk);
    if (!legacyOk) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    if (action === 'create') {
      const f = buildFields(body, { requireName: true });
      if (f.error) return json({ ok: false, error: f.error }, 400);
      let sig = null;
      try { sig = await maybeUploadSignature(env, body); }
      catch (e) { return json({ ok: false, error: String(e.message || e) }, 400); }
      const row = {
        full_name: f.full_name,
        title: f.title || 'ANALISTA DE CAPITAL HUMANO',
        signature_key: sig ? sig.key : null,
        signature_w: sig ? sig.w : null,
        signature_h: sig ? sig.h : null,
        is_active: body.is_active === false ? false : true,
        created_by: String(body.actor || body.username || '').trim() || ('admin#' + adminId),
      };
      const ins = await sb(env, 'cert_signers', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      return json({ ok: true, id: ins && ins[0] ? ins[0].id : null });
    }

    if (action === 'update') {
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta el firmante.' }, 400);
      const cur = await sb(env, `cert_signers?id=eq.${id}&select=*`);
      if (!cur || !cur.length) return json({ ok: false, error: 'Firmante no encontrado.' }, 404);

      const f = buildFields(body, { requireName: true });
      if (f.error) return json({ ok: false, error: f.error }, 400);
      const patch = {
        full_name: f.full_name,
        // title: si viene explicito lo usa; si viene vacio, cae al default.
        title: (f.title || 'ANALISTA DE CAPITAL HUMANO'),
      };
      if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;

      // Reemplazo opcional de firma. Si suben una nueva, borrar la anterior.
      let sig = null;
      try { sig = await maybeUploadSignature(env, body); }
      catch (e) { return json({ ok: false, error: String(e.message || e) }, 400); }
      if (sig) {
        patch.signature_key = sig.key;
        patch.signature_w = sig.w;
        patch.signature_h = sig.h;
      }

      await sb(env, `cert_signers?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      // Borrar la firma anterior recien ahora (ya persistio la nueva).
      if (sig && cur[0].signature_key && cur[0].signature_key !== sig.key) {
        await storageRemove(env, [sigPath(cur[0].signature_key)]);
      }
      return json({ ok: true, id });
    }

    if (action === 'set_active') {
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta el firmante.' }, 400);
      const active = body.is_active !== false;
      const cur = await sb(env, `cert_signers?id=eq.${id}&select=id`);
      if (!cur || !cur.length) return json({ ok: false, error: 'Firmante no encontrado.' }, 404);
      await sb(env, `cert_signers?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: active }),
      });
      return json({ ok: true, id, is_active: active });
    }

    if (action === 'upload_signature') {
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta el firmante.' }, 400);
      const cur = await sb(env, `cert_signers?id=eq.${id}&select=id,signature_key`);
      if (!cur || !cur.length) return json({ ok: false, error: 'Firmante no encontrado.' }, 404);
      let sig = null;
      try { sig = await maybeUploadSignature(env, body); }
      catch (e) { return json({ ok: false, error: String(e.message || e) }, 400); }
      if (!sig) return json({ ok: false, error: 'No se recibio ninguna firma.' }, 400);
      await sb(env, `cert_signers?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ signature_key: sig.key, signature_w: sig.w, signature_h: sig.h }),
      });
      if (cur[0].signature_key && cur[0].signature_key !== sig.key) {
        await storageRemove(env, [sigPath(cur[0].signature_key)]);
      }
      const url = await storageSignedUrl(env, sigPath(sig.key));
      return json({ ok: true, id, signature_url: url });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}
