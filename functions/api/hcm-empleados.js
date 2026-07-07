/* =====================================================================
   functions/api/hcm-empleados.js  →  POST /api/hcm-empleados
   Integracion con la API de Empleados HCM de AX 2012 (middleware Flask/AIF).
   Permite CONSULTAR el personal de una sucursal y SINCRONIZAR (escribir)
   correcciones de datos hacia AX, desde el portal, sin exponer la clave.

   Acciones (POST {action, user, ...}):
     - config:   devuelve la config de campos (hcm_field_config) para armar
                 el formulario en el front. Requiere hcm.view.
     - consulta: { alias, fecha? } -> lista de trabajadores vigentes de esa
                 sucursal. Proxy GET a la API de AX. Requiere hcm.view.
     - sync:     { updates:[...] } -> escribe cambios en AX (POST). Aplica
                 la RED ANTI-BORRADO. Requiere hcm.sync.

   SEGURIDAD CLAVE (no tocar sin entender):
   - La clave de AX vive en el Secret env.canaima_apikey (mismo que usa
     sync-companies para la API de empresas). NUNCA viaja al navegador.
   - RED ANTI-BORRADO: los campos "destructivos" (los que borran el dato en
     AX si se envian vacios) se OMITEN del payload cuando llegan vacios. Asi
     jamas se borra un dato en AX por un campo en blanco. La lista de campos
     y su marca destructive/required sale de app_settings.hcm_field_config.
   - Validacion de OBLIGATORIOS del lado servidor (no se confia en el front):
     si un campo required llega vacio para un trabajador, ese registro se
     RECHAZA (no se envia) y se reporta el motivo. El resto si se procesa.

   Gate: shadowCan(env, adminId, 'hcm-empleados', action, code, legacyOk).
   legacyOk (fase actual) = el rol del actor esta en hcm_sync_roles. Cuando
   se endurezca, el gate real sera can(actor, 'hcm.view'/'hcm.sync').

   Secrets: canaima_apikey, supabase_url, supabase_service_role
   Settings: hcm_field_config, hcm_sync_roles
   ===================================================================== */

import { shadowCan } from './_auth.js';

// Base de la API de empleados HCM (AX 2012). Distinta de la de empresas:
// esta vive en api2. La ruta ya incluye la version del servicio.
const HCM_API = 'https://api2.grupocanaima.com/empleados/datos/v1';

// Codigo de permiso por accion (para el shadow y el futuro gate real).
const HCM_CODE_BY_ACTION = {
  config: 'hcm.view',
  consulta: 'hcm.view',
  sync: 'hcm.sync',
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

// Lee un setting y lo parsea como JSON (los settings 'json' guardan texto).
async function getJsonSetting(env, key, fallback) {
  try {
    const r = await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}&select=value`);
    if (r && r[0] && r[0].value != null) return JSON.parse(r[0].value);
  } catch (_) { /* cae al fallback */ }
  return fallback;
}

// Actor activo del portal: { id, role } o null. Revalida contra BD.
async function getActor(env, adminId) {
  if (!adminId) return null;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id,role`);
  return r && r.length ? r[0] : null;
}

// Set de campos editables + su config (de hcm_field_config). Siempre incluye
// la lista de destructivos y required, para la red anti-borrado.
async function getFieldConfig(env) {
  const cfg = await getJsonSetting(env, 'hcm_field_config', {});
  const fields = cfg && typeof cfg === 'object' ? cfg : {};
  const editable = [];       // codes editables
  const required = [];       // codes obligatorios
  const destructive = [];    // codes destructivos (borran en AX si van vacios)
  for (const [code, f] of Object.entries(fields)) {
    if (f && f.editable) editable.push(code);
    if (f && f.required) required.push(code);
    if (f && f.destructive) destructive.push(code);
  }
  return { fields, editable, required, destructive };
}

// ¿El rol del actor puede sincronizar? (hcm_sync_roles). superadmin siempre.
async function canSyncRole(env, role) {
  if (role === 'superadmin') return true;
  const roles = await getJsonSetting(env, 'hcm_sync_roles', []);
  return Array.isArray(roles) && roles.includes(role);
}

// Llama a la API de AX. method GET|POST. Devuelve { ok, status, data|text }.
async function callAx(url, { method = 'GET', apiKey, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'X-API-Key': apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* no-json */ }
  return { ok: res.ok, status: res.status, data, text };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const { action, adminId } = body;

  try {
    const actor = await getActor(env, adminId);
    // legacy gate: actor activo cuyo rol esta autorizado en hcm_sync_roles.
    // (Para 'config'/'consulta' basta ver; para 'sync' se re-chequea abajo.)
    const roleOk = actor ? await canSyncRole(env, actor.role) : false;
    await shadowCan(env, adminId, 'hcm-empleados', action || '?', HCM_CODE_BY_ACTION[action] || 'hcm.view', roleOk);
    if (!actor) return json({ ok: false, error: 'No autorizado.' }, 401);
    if (!roleOk) return json({ ok: false, error: 'Tu rol no tiene acceso a la gestion de personal AX.' }, 403);

    if (!env.canaima_apikey) {
      return json({ ok: false, error: 'La clave de AX no esta configurada en el servidor.' }, 500);
    }

    // ---- config: devuelve la config de campos para el formulario ----
    if (action === 'config') {
      const { fields } = await getFieldConfig(env);
      return json({ ok: true, fields });
    }

    // ---- consulta: proxy GET a la API de AX ----
    if (action === 'consulta') {
      const alias = String(body.alias || '').trim();
      if (!alias) return json({ ok: false, error: 'Indica el alias de la sucursal.' }, 400);
      // fecha opcional YYYY-MM-DD; si no viene, AX asume hoy (no la forzamos).
      const fecha = String(body.fecha || '').trim();
      const qs = new URLSearchParams({ alias });
      if (fecha) qs.set('fecha', fecha);
      const r = await callAx(`${HCM_API}?${qs.toString()}`, { method: 'GET', apiKey: env.canaima_apikey });
      if (!r.ok) {
        return json({ ok: false, error: `La API de AX respondio ${r.status}.`, detail: r.text || null }, 502);
      }
      const list = Array.isArray(r.data) ? r.data : (r.data && (r.data.data || r.data.items) || []);
      return json({ ok: true, empleados: list, count: list.length });
    }

    // ---- sync: escribir cambios en AX (con red anti-borrado) ----
    if (action === 'sync') {
      // Re-chequeo explicito de sync (mismo gate por ahora, pero separado
      // para cuando el permiso hcm.sync se separe de hcm.view).
      if (!(await canSyncRole(env, actor.role))) {
        return json({ ok: false, error: 'Tu rol no puede sincronizar cambios a AX.' }, 403);
      }
      const updates = Array.isArray(body.updates) ? body.updates : null;
      if (!updates || !updates.length) return json({ ok: false, error: 'No hay cambios para sincronizar.' }, 400);

      const { fields, editable, required, destructive } = await getFieldConfig(env);
      const editableSet = new Set(editable);
      const requiredSet = new Set(required);
      const destructiveSet = new Set(destructive);

      // Construir el payload saneado. Por cada trabajador:
      //  - 'ficha' es obligatoria (llave); sin ella se rechaza.
      //  - solo se toman los campos EDITABLES de la config.
      //  - REQUIRED vacio -> se RECHAZA ese registro (no se envia), se reporta.
      //  - DESTRUCTIVO vacio -> se OMITE del payload (nunca se manda "").
      //  - No-destructivo vacio -> se puede enviar (AX lo ignora si aplica),
      //    pero para minimizar ruido tambien se omite si viene vacio.
      const clean = [];
      const rejected = [];
      for (const u of updates) {
        const ficha = u && (u.ficha != null) ? String(u.ficha).trim() : '';
        if (!ficha) { rejected.push({ ficha: null, reason: 'Sin ficha (llave).' }); continue; }

        const out = { ficha };
        const missingReq = [];
        for (const code of editableSet) {
          let val = u[code];
          val = (val == null) ? '' : String(val).trim();
          const isReq = requiredSet.has(code);
          const isDes = destructiveSet.has(code);

          if (val === '') {
            if (isReq) { missingReq.push(fields[code]?.label || code); continue; }
            // vacio no-obligatorio: omitir (destructivo o no) para no arriesgar.
            continue;
          }
          out[code] = val;
        }

        if (missingReq.length) {
          rejected.push({ ficha, reason: `Faltan obligatorios: ${missingReq.join(', ')}.` });
          continue;
        }
        // Si tras el saneo solo quedo la ficha (ningun campo a actualizar), no
        // tiene sentido enviarlo.
        if (Object.keys(out).length <= 1) {
          rejected.push({ ficha, reason: 'Sin cambios validos para enviar.' });
          continue;
        }
        clean.push(out);
      }

      if (!clean.length) {
        return json({ ok: false, error: 'Ningun registro paso la validacion.', rejected }, 422);
      }

      // Enviar a AX solo los registros saneados.
      const r = await callAx(HCM_API, { method: 'POST', apiKey: env.canaima_apikey, body: clean });
      if (!r.ok) {
        return json({ ok: false, error: `La API de AX respondio ${r.status} al sincronizar.`, detail: r.text || null, rejected }, 502);
      }
      return json({
        ok: true,
        sent: clean.length,
        rejected_count: rejected.length,
        rejected,
        ax_response: r.data ?? r.text ?? null,
      });
    }

    return json({ ok: false, error: 'Accion no reconocida.' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
