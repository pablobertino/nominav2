/* =====================================================================
   functions/api/api-status.js  →  POST /api/api-status
   ESTADO DE LAS APIS (grupo Sincronizacion → Herramientas).

   POR QUE EXISTE (v6.199):
   el 10/08/2026 la lectura del padron de LA01 fallo y Publicar rechazo la
   ficha con "No se pudo leer la ficha actual del sistema". Nos enteramos
   PORQUE UN USUARIO INTENTO PUBLICAR — o sea, tarde y por el peor canal.
   No habia forma de preguntarle al portal si las APIs estaban vivas.

   Esto NO reemplaza a Consultar API (esa trae datos, con parametros a mano).
   Aca solo importa una cosa: ¿contesta o no contesta, y si no, por que?

   Acciones (POST { action, user, ... }):
     list  {}          gate view.apistatus. Las APIs activas del catalogo.
     check {code}      gate view.apistatus. Pinguea UNA y devuelve
                       { ok, status, ms, reason, rows }.

   UNA POR LLAMADA, A PROPOSITO: pinguear las 8 en una sola invocacion se
   come el limite de subrequests de Cloudflare Pages y ademas deja al usuario
   mirando una pantalla quieta. El navegador hace el bucle y va pintando.

   Los parametros OBLIGATORIOS se rellenan solos segun el TIPO que declara el
   catalogo (date -> hoy, company -> un alias real). No se prueba el dato, se
   prueba que el servicio conteste; por eso alcanza con valores minimos.
   Si mañana se registra otra API en api_catalog, esto la toma sin deploy.

   Solo LEE. Ningun endpoint de aca modifica nada.
   Secrets: supabase_url, supabase_service_role, + el que diga secret_key.
   ===================================================================== */

import { resolveActor, can } from './_auth.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

/* v6.200: OJO CON Accept-Profile. Sin ese header PostgREST busca en `public`
   y devuelve un 404 "Could not find the table 'public.api_catalog'". Las
   tablas del portal viven en el esquema nomina_v2; todos los endpoints lo
   mandan y este se copio sin el. */
async function sb(env, path, init = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2', 'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const hoyIso = () => new Date().toISOString().slice(0, 10);

/* Un alias REAL para las APIs que exigen empresa. Se toma una tienda abierta
   cualquiera: da igual cual, lo que se prueba es que el servicio responda. */
async function aliasDeMuestra(env) {
  try {
    const r = await sb(env,
      'companies?is_active=eq.true&company_type=eq.Tienda&select=company_code&order=company_code.asc&limit=1');
    return (r && r[0] && r[0].company_code) || 'AA01';
  } catch (_) { return 'AA01'; }
}

/* Rellena los parametros REQUERIDOS por su tipo declarado en el catalogo.
   Los opcionales se dejan vacios: cuanto menos se pida, mas limpio el ping. */
function paramsDePrueba(defs, alias) {
  const out = {};
  for (const d of (Array.isArray(defs) ? defs : [])) {
    if (!d || !d.required) continue;
    if (d.type === 'date') out[d.key] = hoyIso();
    else if (d.type === 'company') out[d.key] = alias;
    else out[d.key] = '';
  }
  return out;
}

/* Cuenta filas sin asumir la forma: algunas APIs devuelven un array pelado y
   otras lo cuelgan de una clave (rows_key). null = no se pudo contar. */
function contarFilas(data, rowsKey) {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    if (rowsKey && Array.isArray(data[rowsKey])) return data[rowsKey].length;
    for (const k of ['empleados', 'data', 'items', 'empleos', 'asignaciones']) {
      if (Array.isArray(data[k])) return data[k].length;
    }
  }
  return null;
}

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const action = String(body.action || 'list').trim();

  try {
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
    if (!can(actor, 'view.apistatus')) {
      return json({ ok: false, error: 'No tienes permiso para ver el estado de las APIs (view.apistatus).' }, 403);
    }

    if (action === 'list') {
      const rows = await sb(env,
        'api_catalog?is_active=eq.true&select=code,label,endpoint_url,method,params,note'
        + '&order=sort_order.asc,label.asc') || [];
      /* El host va aparte para agrupar por servidor (api / api2 / api3).
         v6.202: ademas viaja la URL COMPLETA. Antes solo mandaba el host, y
         en una pantalla de diagnostico eso es esconder justo el dato que uno
         necesita para hablar con quien mantiene la API. Igual solo la ven los
         roles con view.apistatus, que son los mismos que ya pueden consultar
         esas APIs desde Consultar API. */
      return json({
        ok: true,
        apis: rows.map(r => {
          let host = '';
          try { host = new URL(r.endpoint_url).host; } catch (_) { host = ''; }
          return {
            code: r.code, label: r.label, host,
            url: r.endpoint_url, method: r.method || 'GET',
            note: r.note || null,
          };
        }),
      });
    }

    if (action === 'check') {
      const code = String(body.code || '').trim();
      if (!code) return json({ ok: false, error: 'Falta indicar que API revisar.' }, 400);
      const rows = await sb(env, `api_catalog?code=eq.${encodeURIComponent(code)}&is_active=eq.true&select=*`);
      const api = rows && rows[0];
      if (!api) return json({ ok: false, error: 'Esa API no existe o esta inactiva en el catalogo.' }, 404);

      const headers = { Accept: 'application/json' };
      if (api.secret_key) {
        const key = env[api.secret_key];
        // Esto NO es un fallo de la API: es una falta de configuracion nuestra,
        // y conviene que se lea distinto de "el servicio esta caido".
        if (!key) {
          return json({
            ok: true, code, ok_api: false, config: true, ms: 0,
            reason: `El secret "${api.secret_key}" no esta configurado en el servidor.`,
          });
        }
        headers['X-API-Key'] = key;
      }

      const alias = await aliasDeMuestra(env);
      const sent = paramsDePrueba(api.params, alias);
      const qs = Object.keys(sent).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(sent[k])}`).join('&');
      const url = qs ? `${api.endpoint_url}?${qs}` : api.endpoint_url;

      const t0 = Date.now();
      let res;
      try {
        res = await fetch(url, { method: api.method || 'GET', headers });
      } catch (e) {
        return json({
          ok: true, code, ok_api: false, ms: Date.now() - t0, params: sent,
          reason: `No se pudo conectar: ${(e && e.message) || e}`,
        });
      }
      const ms = Date.now() - t0;

      if (!res.ok) {
        let detalle = '';
        try { detalle = (await res.text()).slice(0, 200); } catch (_) { /* sin cuerpo */ }
        return json({
          ok: true, code, ok_api: false, status: res.status, ms, params: sent,
          reason: `Respondió HTTP ${res.status}${detalle ? ' — ' + detalle : ''}`,
        });
      }

      let data;
      try { data = await res.json(); } catch (_) {
        return json({
          ok: true, code, ok_api: false, status: res.status, ms, params: sent,
          reason: 'Respondió 200 pero el cuerpo no es JSON.',
        });
      }

      const filas = contarFilas(data, api.rows_key);
      /* 200 con cero filas NO se marca como fallo: puede ser legitimo (un dia
         sin egresos, por ejemplo). Se informa y que lo lea quien sabe. */
      return json({
        ok: true, code, ok_api: true, status: res.status, ms, params: sent,
        rows: filas,
        reason: filas === 0 ? 'Responde, pero devolvió 0 filas con los parámetros de prueba.' : null,
      });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
