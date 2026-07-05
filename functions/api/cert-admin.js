/* =====================================================================
   functions/api/cert-admin.js  →  /api/cert-admin
   CIRCUITO de Constancias de Trabajo, lado del ADMIN (revision/generacion).

   El admin recibe las solicitudes de constancia de las empresas de su alcance
   (get_admin_companies; superadmin = todas), abre cada linea (una constancia
   por empleado) con un SNAPSHOT precargado y COMPLETA los datos que el
   solicitante NO llena: salario base, bono (USD/tasa/monto), firmante (nombre
   y cargo), ciudad, fecha de expedicion y destinatario. Los defaults de
   salario/bono salen de app_settings (grupo 'Constancias').

   Al "GENERAR" se persiste el snapshot completo (salario, bono, firmante,
   ciudad, etc.), se genera el PDF (modulo _cert-pdf.js, pdf-lib), se sube al
   bucket privado 'cert-docs' como '<line_id>.pdf' y la linea pasa a
   'disponible' con pdf_key. Si el PDF falla, la linea queda 'generada' sin
   pdf_key (reintentable), sin perder el snapshot. Rechazar marca 'rechazada'
   con motivo (permiso shadow 'cert.reject').

   Acciones (POST {action}):
     - inbox      : bandeja del admin = solicitudes de SU alcance (todas, no
                    solo las que el creo), con lineas. Filtros opcionales por
                    empresa y estado. { user, company_code?, status? }
     - detail     : una solicitud + sus lineas + defaults (app_settings) +
                    catalogo de firmantes activos (para el combo). { user, request_id }
     - save_line  : guarda/edita el snapshot de UNA linea (sin generar). Pone
                    la linea 'en_revision' si estaba 'solicitada'. { user, line_id, patch:{...} }
     - generate   : marca 'generada' 1..N lineas (guardando el patch final de
                    cada una si viene). Requiere firmante + salario. NO crea PDF.
                    { user, request_id, lines:[{line_id, patch?}] } | { user, line_id, patch? }
     - reject     : marca 'rechazada' 1..N lineas con motivo. { user, line_id|lines, reason }

   'user' = { kind:'admin', id } (o { kind:'company', companyCode } — pero la
   bandeja del admin es de rol admin; company no tiene acceso aca).

   Gate de escritura: shadow 'cert.generate' (generate/save_line) y
   'cert.reject' (reject). Legacy: cualquier admin del alcance.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { shadowCan } from './_auth.js';
import { buildConstanciaPdf } from './_cert-pdf.js';

const SETTINGS_GROUP = 'Constancias';
const SIG_BUCKET = 'cert-signatures';   // privado: firmas de los firmantes
const DOCS_BUCKET = 'cert-docs';        // privado: PDFs generados

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

function nowIso() { return new Date().toISOString(); }

/* ---------- Storage helpers (firma de entrada, PDF de salida) ---------- */

/* Baja los bytes de un objeto de un bucket privado (para la firma). Devuelve
   Uint8Array o null si no existe / falla. Best-effort. */
async function storageDownload(env, bucket, path) {
  try {
    const res = await fetch(`${env.supabase_url}/storage/v1/object/${bucket}/${path}`, {
      headers: {
        apikey: env.supabase_service_role,
        Authorization: `Bearer ${env.supabase_service_role}`,
      },
    });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch { return null; }
}

/* Sube un PDF (bytes) al bucket privado cert-docs (upsert). */
async function storageUploadPdf(env, path, bytes) {
  const res = await fetch(`${env.supabase_url}/storage/v1/object/${DOCS_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Storage upload ${res.status}: ${await res.text()}`);
  return true;
}

/* Resuelve la firma del firmante de una linea: si signer_id apunta a un
   cert_signers con signature_key, baja el PNG del bucket cert-signatures.
   Devuelve { bytes, mime } o null (sin firma -> el PDF va sin firma). */
async function resolveSignature(env, merged) {
  const signerId = merged.signer_id;
  if (!signerId) return null;
  const rows = await sb(env,
    `cert_signers?id=eq.${encodeURIComponent(signerId)}&select=signature_key`).catch(() => null);
  const key = rows && rows[0] && rows[0].signature_key;
  if (!key) return null;
  const bytes = await storageDownload(env, SIG_BUCKET, `${key}.png`);
  if (!bytes || !bytes.length) return null;
  return { bytes, mime: 'image/png' };
}

/* Genera el PDF de una linea (snapshot merged), lo sube a cert-docs y
   devuelve el pdf_key. Lanza si algo falla (el caller decide el fallback). */
async function generatePdfForLine(env, lineId, merged) {
  const sig = await resolveSignature(env, merged);
  const bytes = await buildConstanciaPdf(env, merged, sig
    ? { signatureBytes: sig.bytes, signatureMime: sig.mime }
    : {});
  const pdfKey = `${lineId}.pdf`;
  await storageUploadPdf(env, pdfKey, bytes);
  return pdfKey;
}

/* ---------- resolucion del ADMIN + alcance ----------
   Devuelve { id, role, actor, codes } donde:
     codes = null  -> ve TODAS las empresas (superadmin)
     codes = array -> company_codes permitidos (get_admin_companies) */
async function resolveAdmin(env, user) {
  if (!user || user.kind !== 'admin' || !user.id) return null;
  const a = await sb(env,
    `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,username,name,role`);
  if (!a || !a.length) return null;
  const actor = a[0].username || a[0].name || ('admin#' + a[0].id);
  if (a[0].role === 'superadmin') return { id: a[0].id, role: 'superadmin', actor, codes: null };
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
  });
  return { id: a[0].id, role: a[0].role, actor, codes: (rows || []).map(r => r.company_code) };
}

function adminCanCompany(adm, cc) {
  if (!adm || !cc) return false;
  if (adm.codes === null) return true;
  return adm.codes.includes(cc);
}

/* Defaults de salario/cestaticket desde app_settings (grupo 'Constancias').
   Claves: cert_salario_default_ves, cert_cestaticket_default_usd. */
async function loadDefaults(env) {
  const rows = await sb(env,
    `app_settings?grupo=eq.${encodeURIComponent(SETTINGS_GROUP)}&select=key,value`).catch(() => null);
  const map = {};
  (rows || []).forEach(r => { map[r.key] = r.value; });
  const num = (v, d) => {
    const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
    return isNaN(n) ? d : n;
  };
  return {
    salary_default_ves: num(map.cert_salario_default_ves, 300),
    cestaticket_default_usd: num(map.cert_cestaticket_default_usd, 40),
  };
}

/* Catalogo de firmantes activos (para el combo del admin al revisar). */
async function activeSigners(env) {
  const rows = await sb(env,
    'cert_signers?is_active=eq.true&select=id,full_name,title&order=full_name.asc').catch(() => []);
  return rows || [];
}

/* Whitelist de campos editables del snapshot de una linea (lo que el admin
   puede tocar en la revision). Evita que el cliente escriba columnas de
   control (status, generated_by, etc.). */
const LINE_EDITABLE = new Set([
  'worker_full_name', 'worker_id_number', 'worker_role', 'start_date',
  'salary_amount', 'bonus_usd', 'bonus_rate', 'bonus_amount',
  'recipient', 'city',
  'signer_id', 'signer_name_snap', 'signer_title_snap',
  'company_name_snap', 'company_rif_snap', 'company_addr_snap',
  'company_phone_snap', 'company_email_snap',
]);

function sanitizePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(patch)) {
    if (!LINE_EDITABLE.has(k)) continue;
    let v = patch[k];
    if (v === '') v = null;
    out[k] = v;
  }
  return out;
}

/* Trae una linea (con la empresa de su cabecera) verificando alcance. Devuelve
   { line, req } o null si no existe / fuera de alcance. */
async function lineInScope(env, adm, lineId) {
  const ls = await sb(env, `cert_request_lines?id=eq.${lineId}&select=*`);
  if (!ls || !ls.length) return null;
  const line = ls[0];
  const rs = await sb(env, `cert_requests?id=eq.${line.request_id}&select=*`);
  if (!rs || !rs.length) return null;
  const req = rs[0];
  if (!adminCanCompany(adm, req.company_code)) return null;
  return { line, req };
}

/* Inserta auditoria (best-effort). */
async function audit(env, lineId, from, to, adm, detail) {
  await sb(env, 'cert_line_audit', {
    method: 'POST',
    body: JSON.stringify([{
      line_id: lineId, from_status: from || null, to_status: to,
      actor_kind: 'admin', actor_id: String(adm.id), detail: detail || null,
    }]),
  }).catch(() => {});
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const { action } = body;

  try {
    const adm = await resolveAdmin(env, body.user);
    if (!adm) return json({ ok: false, error: 'Sesion de administrador no valida.' }, 403);

    /* ---------- bandeja del admin ---------- */
    if (action === 'inbox') {
      // Solicitudes de las empresas del alcance (todas, sin importar quien las
      // creo). superadmin ve todas.
      let path = 'cert_requests?select=*';
      if (adm.codes !== null) {
        if (!adm.codes.length) return json({ ok: true, requests: [] });
        const inList = adm.codes.map(c => `"${c}"`).join(',');
        path += `&company_code=in.(${inList})`;
      }
      const cc = String(body.company_code || '').trim();
      if (cc) {
        if (!adminCanCompany(adm, cc)) return json({ ok: false, error: 'Sin acceso a esa empresa.' }, 403);
        path += `&company_code=eq.${encodeURIComponent(cc)}`;
      }
      const st = String(body.status || '').trim();
      if (st) path += `&status=eq.${encodeURIComponent(st)}`;
      path += '&order=requested_at.desc&limit=500';
      const reqs = await sb(env, path) || [];
      if (!reqs.length) return json({ ok: true, requests: [] });

      const ids = reqs.map(r => r.id);
      const lines = await sb(env,
        `cert_request_lines?request_id=in.(${ids.join(',')})&select=*&order=id.asc`) || [];
      const byReq = {};
      lines.forEach(l => { (byReq[l.request_id] = byReq[l.request_id] || []).push(l); });
      const out = reqs.map(r => ({ ...r, lines: byReq[r.id] || [] }));
      return json({ ok: true, requests: out });
    }

    /* ---------- detalle de una solicitud (para revisar) ---------- */
    if (action === 'detail') {
      const reqId = parseInt(body.request_id, 10);
      if (!reqId) return json({ ok: false, error: 'Falta la solicitud.' }, 400);
      const rs = await sb(env, `cert_requests?id=eq.${reqId}&select=*`);
      if (!rs || !rs.length) return json({ ok: false, error: 'Solicitud no encontrada.' }, 404);
      const req = rs[0];
      if (!adminCanCompany(adm, req.company_code)) return json({ ok: false, error: 'Sin acceso a esa empresa.' }, 403);
      const lines = await sb(env,
        `cert_request_lines?request_id=eq.${reqId}&select=*&order=id.asc`) || [];
      const [defaults, signers] = await Promise.all([loadDefaults(env), activeSigners(env)]);
      return json({ ok: true, request: req, lines, defaults, signers });
    }

    /* ---------- guardar/editar snapshot de una linea (sin generar) ---------- */
    if (action === 'save_line') {
      const lineId = parseInt(body.line_id, 10);
      if (!lineId) return json({ ok: false, error: 'Falta la linea.' }, 400);
      const found = await lineInScope(env, adm, lineId);
      if (!found) return json({ ok: false, error: 'Linea no encontrada o fuera de alcance.' }, 404);
      const { line } = found;

      const legacyOk = true;   // cualquier admin del alcance
      await shadowCan(env, body.user, 'cert-admin', 'save_line', 'cert.generate', legacyOk);

      // Editar una constancia YA generada/disponible: permitido SOLO a
      // admin/superadmin (no gestor_empresa ni editor_personal). Tras editar,
      // hay que RE-GENERAR para rehacer el PDF (se avisa desde el front).
      const isPowerAdmin = adm.role === 'admin' || adm.role === 'superadmin';
      if ((line.status === 'generada' || line.status === 'disponible') && !isPowerAdmin) {
        return json({ ok: false, error: 'No se puede editar: la constancia ya fue generada.' }, 409);
      }
      if (line.status === 'rechazada' || line.status === 'anulada') {
        return json({ ok: false, error: 'No se puede editar una constancia rechazada o anulada.' }, 409);
      }

      const patch = sanitizePatch(body.patch);
      patch.updated_at = nowIso();
      // Al tocar por primera vez, pasa a 'en_revision'.
      const toRevision = line.status === 'solicitada';
      if (toRevision) patch.status = 'en_revision';

      await sb(env, `cert_request_lines?id=eq.${lineId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      // Marcar la cabecera 'en_revision' + admin_id la primera vez.
      await sb(env, `cert_requests?id=eq.${line.request_id}&status=eq.solicitada`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'en_revision', admin_id: String(adm.id), reviewed_at: nowIso(), updated_at: nowIso() }),
      }).catch(() => {});
      if (toRevision) await audit(env, lineId, 'solicitada', 'en_revision', adm, 'En revision');
      return json({ ok: true, line_id: lineId });
    }

    /* ---------- generar (snapshot final + PDF real -> disponible) ---------- */
    if (action === 'generate') {
      const legacyOk = true;
      await shadowCan(env, body.user, 'cert-admin', 'generate', 'cert.generate', legacyOk);

      // Admite un solo line_id o una lista de {line_id, patch?}.
      let items = [];
      if (Array.isArray(body.lines)) items = body.lines.map(x => ({ line_id: parseInt(x.line_id, 10), patch: x.patch }));
      else if (body.line_id) items = [{ line_id: parseInt(body.line_id, 10), patch: body.patch }];
      items = items.filter(x => x.line_id);
      if (!items.length) return json({ ok: false, error: 'No hay lineas para generar.' }, 400);

      const results = [];
      // Re-generar una constancia ya emitida (reemplazar el PDF) es potestad
      // de admin/superadmin. gestor/editor solo generan las pendientes.
      const isPowerAdmin = adm.role === 'admin' || adm.role === 'superadmin';
      for (const it of items) {
        const found = await lineInScope(env, adm, it.line_id);
        if (!found) { results.push({ line_id: it.line_id, ok: false, error: 'Fuera de alcance.' }); continue; }
        const { line } = found;
        const yaEmitida = line.status === 'generada' || line.status === 'disponible';
        if (yaEmitida && !isPowerAdmin) {
          results.push({ line_id: it.line_id, ok: false, error: 'Ya generada.' }); continue;
        }
        if (line.status === 'rechazada' || line.status === 'anulada') {
          results.push({ line_id: it.line_id, ok: false, error: 'Rechazada/anulada.' }); continue;
        }
        // Snapshot final = lo que ya tiene la linea + el patch de esta llamada.
        const patch = sanitizePatch(it.patch);
        const merged = { ...line, ...patch };
        // Validaciones minimas para una constancia valida.
        const salaryOk = merged.salary_amount != null && String(merged.salary_amount) !== '';
        const signerOk = merged.signer_id != null || (merged.signer_name_snap && String(merged.signer_name_snap).trim());
        if (!salaryOk) { results.push({ line_id: it.line_id, ok: false, error: 'Falta el salario base.' }); continue; }
        if (!signerOk) { results.push({ line_id: it.line_id, ok: false, error: 'Falta el firmante.' }); continue; }

        const finalPatch = {
          ...patch,
          generated_at: nowIso(),
          generated_by: String(adm.id),
          updated_at: nowIso(),
        };

        // 1) Persistir el snapshot final ANTES de generar (asi el PDF lee lo
        //    definitivo y, si el PDF falla, el snapshot ya quedo guardado).
        //    Estado 'generada' como intermedio; pasa a 'disponible' al subir
        //    el PDF con exito.
        await sb(env, `cert_request_lines?id=eq.${it.line_id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ ...finalPatch, status: 'generada' }),
        });

        // 2) Generar el PDF (leyendo el snapshot final) y subirlo a cert-docs.
        //    Si algo falla, la linea queda 'generada' SIN pdf_key: se puede
        //    reintentar; no perdemos el snapshot ni bloqueamos el resto.
        let pdfKey = null;
        try {
          pdfKey = await generatePdfForLine(env, it.line_id, merged);
        } catch (e) {
          await audit(env, it.line_id, line.status, 'generada', adm,
            'Snapshot generado; PDF fallo: ' + String(e && e.message || e));
          results.push({ line_id: it.line_id, ok: false, error: 'PDF: ' + String(e && e.message || e), partial: true });
          continue;
        }

        // 3) PDF listo: guardar pdf_key y pasar la linea a 'disponible'.
        await sb(env, `cert_request_lines?id=eq.${it.line_id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'disponible', pdf_key: pdfKey, updated_at: nowIso() }),
        });
        const regen = yaEmitida ? 'Constancia RE-generada (PDF ' + pdfKey + ')' : 'Constancia generada (PDF ' + pdfKey + ')';
        await audit(env, it.line_id, line.status, 'disponible', adm, regen);
        results.push({ line_id: it.line_id, ok: true, pdf_key: pdfKey });
      }

      // Actualizar estado de cabecera(s) afectada(s): si TODAS sus lineas
      // quedaron en un estado final (generada/disponible/rechazada/anulada),
      // la cabecera pasa a 'generada'.
      const reqIds = [...new Set((await Promise.all(
        items.map(async it => {
          const f = await lineInScope(env, adm, it.line_id);
          return f ? f.line.request_id : null;
        }))).filter(Boolean))];
      for (const rid of reqIds) {
        const ls = await sb(env, `cert_request_lines?request_id=eq.${rid}&select=status`) || [];
        const pending = ls.some(l => l.status === 'solicitada' || l.status === 'en_revision');
        const anyGen = ls.some(l => l.status === 'generada' || l.status === 'disponible');
        if (!pending && anyGen) {
          // Si TODAS las que no estan rechazadas/anuladas quedaron
          // 'disponible' (PDF listo), la cabecera pasa a 'disponible'; si
          // alguna quedo 'generada' sin PDF (fallo), queda 'generada'.
          const activas = ls.filter(l => l.status === 'generada' || l.status === 'disponible');
          const todasDisp = activas.length > 0 && activas.every(l => l.status === 'disponible');
          const headStatus = todasDisp ? 'disponible' : 'generada';
          await sb(env, `cert_requests?id=eq.${rid}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ status: headStatus, admin_id: String(adm.id), updated_at: nowIso() }),
          }).catch(() => {});
        }
      }

      const okCount = results.filter(r => r.ok).length;
      return json({ ok: okCount > 0, generated: okCount, results });
    }

    /* ---------- rechazar (con motivo) ---------- */
    if (action === 'reject') {
      const legacyOk = true;
      await shadowCan(env, body.user, 'cert-admin', 'reject', 'cert.reject', legacyOk);

      const reason = String(body.reason || '').trim();
      if (!reason) return json({ ok: false, error: 'Indica el motivo del rechazo.' }, 400);

      let ids = [];
      if (Array.isArray(body.lines)) ids = body.lines.map(x => parseInt(x, 10)).filter(Boolean);
      else if (body.line_id) ids = [parseInt(body.line_id, 10)].filter(Boolean);
      ids = [...new Set(ids)];
      if (!ids.length) return json({ ok: false, error: 'No hay lineas para rechazar.' }, 400);

      const results = [];
      const reqIds = new Set();
      for (const lid of ids) {
        const found = await lineInScope(env, adm, lid);
        if (!found) { results.push({ line_id: lid, ok: false, error: 'Fuera de alcance.' }); continue; }
        const { line } = found;
        if (line.status === 'generada' || line.status === 'disponible') {
          results.push({ line_id: lid, ok: false, error: 'Ya generada; no se puede rechazar.' }); continue;
        }
        if (line.status === 'rechazada' || line.status === 'anulada') {
          results.push({ line_id: lid, ok: false, error: 'Ya cerrada.' }); continue;
        }
        await sb(env, `cert_request_lines?id=eq.${lid}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'rechazada', reject_reason: reason,
            rejected_by: String(adm.id), rejected_at: nowIso(), updated_at: nowIso(),
          }),
        });
        await audit(env, lid, line.status, 'rechazada', adm, reason);
        reqIds.add(line.request_id);
        results.push({ line_id: lid, ok: true });
      }

      // Cabecera: si ya no quedan lineas pendientes ni generadas, no forzamos
      // un estado; pero si todas terminaron rechazadas/anuladas, reflejarlo.
      for (const rid of reqIds) {
        const ls = await sb(env, `cert_request_lines?request_id=eq.${rid}&select=status`) || [];
        const pending = ls.some(l => l.status === 'solicitada' || l.status === 'en_revision');
        const anyGen = ls.some(l => l.status === 'generada' || l.status === 'disponible');
        if (!pending && !anyGen) {
          await sb(env, `cert_requests?id=eq.${rid}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'rechazada', admin_id: String(adm.id), updated_at: nowIso() }),
          }).catch(() => {});
        }
      }

      const okCount = results.filter(r => r.ok).length;
      return json({ ok: okCount > 0, rejected: okCount, results });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}
