/* =====================================================================
   functions/api/ax-probe.js  →  POST /api/ax-probe
   HERRAMIENTA DE DIAGNOSTICO (solo superadmin): consulta la API de empleados
   del sistema (ERP) y devuelve la respuesta CRUDA tal cual llega, mas datos
   de apoyo (status HTTP, conteo, URL sin la clave). Sirve para verificar que
   trae el sistema para un alias/fecha, e inspeccionar el JSON exacto.

   La clave del sistema (canaima_apikey) NUNCA sale al navegador: la llamada
   la hace el servidor. El front solo manda alias/fecha/ficha.

   Accion unica (POST { user, alias, fecha?, ficha? }):
     - Llama GET {HCM_API}?alias=..&fecha=.. con X-API-Key del servidor.
     - Devuelve { ok, status, url, count, raw, filtered? }.
       raw     = JSON crudo tal cual (o texto si no fuese JSON).
       filtered= si se paso ficha, solo esa (comodidad; raw sigue completo).

   Secrets: canaima_apikey
   ===================================================================== */

import { resolveActor, isSuperadmin, AuthError } from './_auth.js';

const HCM_API = 'https://api2.grupocanaima.com/empleados/datos/v1';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  const user = body.user || null;

  try {
    const actor = await resolveActor(env, user);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
    // Herramienta de diagnostico: solo superadmin.
    if (!isSuperadmin(actor)) {
      return json({ ok: false, error: 'Solo un superadministrador puede usar esta herramienta.' }, 403);
    }
    if (!env.canaima_apikey) {
      return json({ ok: false, error: 'La clave del sistema no esta configurada en el servidor.' }, 500);
    }

    const alias = String(body.alias || '').trim();
    if (!alias) return json({ ok: false, error: 'Falta el alias de la empresa.' }, 400);
    const fecha = String(body.fecha || '').trim();   // YYYY-MM-DD (opcional)
    const ficha = String(body.ficha || '').replace(/[^0-9]/g, '');   // opcional

    // Construir URL. La clave va en el header, NUNCA en el query string.
    let url = `${HCM_API}?alias=${encodeURIComponent(alias)}`;
    if (fecha) url += `&fecha=${encodeURIComponent(fecha)}`;

    let res, text, data = null, parseError = null;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
      });
      text = await res.text();
      try { data = text ? JSON.parse(text) : null; }
      catch (e) { parseError = String(e.message || e); }
    } catch (e) {
      return json({ ok: false, error: 'No se pudo conectar con el sistema: ' + String(e.message || e), url }, 502);
    }

    // Normalizar el arreglo de empleados (por si viniera envuelto).
    let arr = data;
    if (data && !Array.isArray(data)) arr = data.empleados || data.data || data.items || null;
    const count = Array.isArray(arr) ? arr.length : null;

    // Filtro por ficha (comodidad para inspeccionar una sola). raw queda completo.
    let filtered = null;
    if (ficha && Array.isArray(arr)) {
      filtered = arr.filter(e => String(e.ficha ?? '').replace(/[^0-9]/g, '') === ficha);
    }

    return json({
      ok: res.ok,
      status: res.status,
      url,                       // sin la clave (esta en el header)
      count,                     // cantidad de empleados (o null si no es arreglo)
      parse_error: parseError,   // si el cuerpo no era JSON
      raw: data != null ? data : (text ?? null),   // JSON crudo tal cual, o texto
      filtered,                  // solo la ficha pedida (si se paso)
      alias, fecha: fecha || null, ficha: ficha || null,
    });
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status);
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
