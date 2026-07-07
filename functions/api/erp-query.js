/* =====================================================================
   functions/api/erp-query.js  →  POST /api/erp-query
   Vista "Consultar sistema" (grupo Sincronizacion, solo superadmin).
   Consulta CRUDA a la API de empleados del sistema (HCM) por alias de
   empresa y fecha, y devuelve el JSON tal cual llega (sin normalizar).
   Es una herramienta de diagnostico: lo que el sistema responde, se ve.

   Peticion (POST):
     { user: {kind,id,companyCode}, alias: 'AA01', fecha: 'YYYY-MM-DD' }
     - alias: obligatorio (codigo de empresa).
     - fecha: opcional; si no viene se usa la fecha de HOY.

   Respuesta:
     { ok:true, alias, fecha, count, rows:[ ...objetos tal cual del sistema ] }

   PRINCIPIOS:
   - La key (env.canaima_apikey) vive SOLO en el servidor: el navegador
     jamas la ve. Por eso este endpoint existe (no se llama al sistema
     directo desde el front).
   - Gate: hcm.publish (superadmin siempre pasa por can()), igual que la
     pagina Sincronizar.
   - NO se toca el payload: sin normalizadores, sin mapeos. El filtro por
     cedula (si el usuario lo usa) es LOCAL en el front.

   Secrets: canaima_apikey
   ===================================================================== */

import { resolveActor, can, AuthError } from './_auth.js';

const HCM_API = 'https://api2.grupocanaima.com/empleados/datos/v1';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

// 'YYYY-MM-DD' valido o null.
function isoDateOrNull(v) {
  const s = String(v || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
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
      return json({ ok: false, error: 'No tienes permiso para consultar el sistema.' }, 403);
    }

    const alias = String(body.alias || '').trim().toUpperCase();
    if (!alias) return json({ ok: false, error: 'Falta el alias de la empresa.' }, 400);
    if (!/^[A-Z0-9]{2,10}$/.test(alias)) {
      return json({ ok: false, error: 'Alias no valido.' }, 400);
    }
    // Fecha: la que venga (valida) o HOY (UTC; el sistema la interpreta como
    // fecha de corte del roster).
    const fecha = isoDateOrNull(body.fecha) || new Date().toISOString().split('T')[0];

    // Llamada CRUDA al sistema (key server-side; nunca viaja al navegador).
    let apiRes;
    try {
      const url = `${HCM_API}?alias=${encodeURIComponent(alias)}&fecha=${encodeURIComponent(fecha)}`;
      apiRes = await fetch(url, {
        headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
      });
    } catch (e) {
      return json({ ok: false, error: 'No se pudo conectar con el sistema: ' + String(e.message || e) }, 502);
    }
    if (!apiRes.ok) {
      return json({ ok: false, error: `El sistema respondio ${apiRes.status}.`, status: apiRes.status }, 502);
    }

    let data;
    try { data = await apiRes.json(); }
    catch { return json({ ok: false, error: 'El sistema devolvio una respuesta que no es JSON.' }, 502); }

    // Tal cual llega: si no es array, intentar los envoltorios conocidos,
    // pero SIN transformar los objetos.
    let rows = data;
    if (!Array.isArray(rows)) rows = data.empleados || data.data || data.items || [];
    if (!Array.isArray(rows)) rows = [];

    return json({ ok: true, alias, fecha, count: rows.length, rows });
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status);
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
