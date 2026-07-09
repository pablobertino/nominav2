/* =====================================================================
   functions/api/erp-query.js  →  POST /api/erp-query
   Vista "Consultar API" (grupo Sincronizacion, solo superadmin).
   Herramienta MANUAL de consulta y diagnostico de las APIs registradas en
   nomina_v2.api_catalog. Devuelve la respuesta TAL CUAL llega (sin
   normalizar). Este endpoint NO modifica datos, por diseño: solo consulta.

   Acciones (POST {action, user, ...}):
     - catalog : lista las APIs activas del catalogo (code, label, method,
                 params, note) para poblar el selector. NO expone la URL ni
                 el secret.
     - query   : { api_code, params:{k:v} } ejecuta la consulta.
                 Valida los params requeridos segun el catalogo, arma el
                 querystring, agrega la key (secret de CF referenciado por
                 nombre en secret_key) y devuelve:
                 { ok, api_code, api_label, url (sin credenciales),
                   params_sent, status, count, rows }
                 Retrocompatibilidad: si llega {alias, fecha} sin api_code,
                 se asume 'hcm_empleados' (front viejo durante el deploy).

   PRINCIPIOS:
   - La clave vive SOLO en secrets de Cloudflare; la BD guarda el NOMBRE del
     secret y el navegador jamas ve ni la clave ni el header.
   - Gate: hcm.publish (superadmin siempre pasa por can()), igual que la
     pagina Sincronizar.
   - NO se toca el payload: sin normalizadores, sin mapeos.
   - Agregar una API = INSERT en api_catalog (sin deploy).

   Secrets: supabase_url, supabase_service_role, + los referenciados por
   api_catalog.secret_key (ej. canaima_apikey)
   ===================================================================== */

import { resolveActor, can, shadowCan, AuthError } from './_auth.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
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

// 'YYYY-MM-DD' valido o null.
function isoDateOrNull(v) {
  const s = String(v || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/* Valida y normaliza UN parametro segun su tipo de catalogo. Devuelve
   { ok, value } o { ok:false, error }. Vacio con required=false -> se omite. */
function normalizeParam(def, raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) {
    return def.required
      ? { ok: false, error: `Falta el parametro "${def.label || def.key}".` }
      : { ok: true, value: null };
  }
  if (def.type === 'date') {
    const d = isoDateOrNull(v);
    return d ? { ok: true, value: d } : { ok: false, error: `"${def.label || def.key}" no es una fecha valida (YYYY-MM-DD).` };
  }
  if (def.type === 'company') {
    const a = v.toUpperCase();
    return /^[A-Z0-9]{2,10}$/.test(a)
      ? { ok: true, value: a }
      : { ok: false, error: `"${def.label || def.key}" no es un codigo de empresa valido.` };
  }
  // text: tal cual, con un tope prudente.
  return v.length <= 120 ? { ok: true, value: v } : { ok: false, error: `"${def.label || def.key}" es demasiado largo.` };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  try {
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
    // Mismo gate que Sincronizar: quien publica al sistema puede consultarlo.
    if (!can(actor, 'hcm.publish')) {
      return json({ ok: false, error: 'No tienes permiso para consultar las APIs.' }, 403);
    }
    // v4.54 SHADOW: la consulta manual es LECTURA -> code fino hcm.view
    // (gate real sigue hcm.publish; el log dira si conviene relajar).
    try { await shadowCan(env, body.user, 'erp-query', body.action || 'query', 'hcm.view', true); } catch (_) { /* no rompe */ }

    /* ---------- catalog: APIs activas para el selector ---------- */
    if (body.action === 'catalog') {
      const rows = await sb(env,
        'api_catalog?is_active=eq.true&select=code,label,method,params,note&order=sort_order.asc,label.asc') || [];
      return json({ ok: true, apis: rows });
    }

    /* ---------- query (default): ejecutar una consulta ---------- */
    // Retrocompatibilidad: front viejo manda {alias, fecha} sin api_code.
    let apiCode = String(body.api_code || '').trim();
    let paramsIn = (body.params && typeof body.params === 'object') ? body.params : {};
    if (!apiCode && body.alias) {
      apiCode = 'hcm_empleados';
      paramsIn = { alias: body.alias, fecha: body.fecha };
    }
    if (!apiCode) return json({ ok: false, error: 'Falta indicar que API consultar.' }, 400);

    const catRows = await sb(env,
      `api_catalog?code=eq.${encodeURIComponent(apiCode)}&is_active=eq.true&select=*`);
    const api = catRows && catRows[0] ? catRows[0] : null;
    if (!api) return json({ ok: false, error: 'Esa API no existe o esta inactiva en el catalogo.' }, 404);

    // Validar y armar los parametros segun el catalogo (solo los definidos:
    // cualquier extra del cliente se IGNORA, nunca se reenvia a ciegas).
    const defs = Array.isArray(api.params) ? api.params : [];
    const sent = {};
    for (const def of defs) {
      const r = normalizeParam(def, paramsIn[def.key]);
      if (!r.ok) return json({ ok: false, error: r.error }, 400);
      if (r.value != null) sent[def.key] = r.value;
    }
    // Regla especial heredada: la API de fichas usa HOY como fecha default.
    if (apiCode === 'hcm_empleados' && !sent.fecha) {
      sent.fecha = new Date().toISOString().split('T')[0];
    }

    const qs = Object.keys(sent)
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(sent[k])}`)
      .join('&');
    const url = qs ? `${api.endpoint_url}?${qs}` : api.endpoint_url;

    // Headers: la key se resuelve por NOMBRE de secret (si el catalogo lo indica).
    const headers = { Accept: 'application/json' };
    if (api.secret_key) {
      const key = env[api.secret_key];
      if (!key) return json({ ok: false, error: `El secret "${api.secret_key}" no esta configurado en el servidor.` }, 500);
      headers['X-API-Key'] = key;
    }

    let apiRes;
    try {
      apiRes = await fetch(url, { method: api.method || 'GET', headers });
    } catch (e) {
      return json({
        ok: false, api_code: apiCode, api_label: api.label, url, params_sent: sent,
        error: 'No se pudo conectar: ' + String(e.message || e),
      }, 502);
    }
    if (!apiRes.ok) {
      let detail = null;
      try { detail = (await apiRes.text()).slice(0, 400); } catch { /* sin cuerpo */ }
      return json({
        ok: false, api_code: apiCode, api_label: api.label, url, params_sent: sent,
        status: apiRes.status, error: `La API respondio ${apiRes.status}.`, detail,
      }, 502);
    }

    let data;
    try { data = await apiRes.json(); }
    catch {
      return json({
        ok: false, api_code: apiCode, api_label: api.label, url, params_sent: sent,
        status: apiRes.status, error: 'La API devolvio una respuesta que no es JSON.',
      }, 502);
    }

    // Tal cual llega: si no es array, intentar los envoltorios conocidos,
    // pero SIN transformar los objetos. Si es un objeto suelto, una fila.
    let rows = data;
    if (!Array.isArray(rows)) rows = data.empleados || data.data || data.items || null;
    if (!Array.isArray(rows)) rows = (data && typeof data === 'object') ? [data] : [];

    return json({
      ok: true, api_code: apiCode, api_label: api.label, url,
      params_sent: sent, status: apiRes.status, count: rows.length, rows,
    });
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status);
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
