/* =====================================================================
   functions/api/ax-marcajes.js  ->  POST /api/ax-marcajes        (v6.167)
   MARCAJE MANUAL: HERRAMIENTA DE DIAGNOSTICO contra AX 2012.

   OJO, LEER ESTO PRIMERO: esta ruta YA NO es el camino de la publicacion.
   La publicacion de un reporte de Marcaje Manual vive en
   /api/reports-history (accion publish_ax): esa es la que respeta el
   alcance del usuario, deja rastro en ax_marcajes_log, cierra el reporte
   y su ticket, y no deja volver atras. Este archivo queda para lo otro:
   probar que el middleware responde y mandar UN marcaje suelto a mano
   cuando hay que depurar algo con Sistemas.

   Un marcaje mandado por aca NO pasa por ax_marcajes_log y NO toca ningun
   reporte: es una escritura suelta en AX, con nombre y apellido de quien
   la hizo solo en la respuesta que ve en pantalla.

   Toda la traduccion portal -> AX (alias, cedula, dayType, horas en
   segundos) vive en _axmarcajes.js, en un solo lugar, compartida con la
   publicacion de verdad.

   POR QUE UN PROXY Y NO LLAMAR DESDE EL NAVEGADOR:
   el HTML de prueba que circulo trae la X-API-Key escrita en el codigo
   (`const apiKey = '...'`). Servido al navegador, esa clave queda a la
   vista de cualquiera que abra el inspector, y con ella se puede escribir
   marcajes en AX sin pasar por el portal. Aca la clave vive en las env
   vars de Cloudflare y NUNCA viaja al cliente.

   Acciones (POST { action, user, ... }):
     health {}                              gate hcm.sync
        Ping de vida al middleware (GET .../health). No escribe nada.
     insert { alias, personnelNumber, transDate, dayType?,
              timeEntry?, timeExit? }       gate report.publish.marcaje
        Inserta UN marcaje. Devuelve la respuesta del middleware y -clave
        para depurar- el payload EXACTO que se envio.
        OJO: ESCRIBE EN AX DE VERDAD. No es un simulador. Por eso pide el
        mismo permiso que la publicacion (report.publish.marcaje) y no el
        de sincronizacion: escribir un marcaje es escribir un marcaje,
        venga de un reporte o de esta pantalla de pruebas.

   Env vars: canaima_apikey (o ax_api_key), ax_marcajes_url (opcional).
   ===================================================================== */

import { resolveActor, can, AuthError } from './_auth.js';
import { axHealth, axInsertMarcaje, AX_DAY_TYPES, dayTypeToAx } from './_axmarcajes.js';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Cuerpo inválido.' }, 400); }
  const action = body.action || 'health';

  try {
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);

    /* ---------------- health: ping sin efectos ---------------- */
    if (action === 'health') {
      if (!can(actor, 'hcm.sync')) {
        return json({ ok: false, error: 'No tienes permiso para sincronizar con AX (hcm.sync).' }, 403);
      }
      const r = await axHealth(env);
      return json(r, r.ok ? 200 : 502);
    }

    /* ---------------- insert: UN marcaje (ESCRIBE EN AX) ---------------- */
    if (action === 'insert') {
      if (!can(actor, 'report.publish.marcaje')) {
        return json({ ok: false, error: 'No tienes permiso para publicar marcajes en AX.' }, 403);
      }

      // El dayType de esta ruta se valida contra el vocabulario de AX: es
      // una herramienta de depuracion y quien la usa esta hablando en el
      // idioma de AX, no en el del portal.
      const dayTypeIn = String(body.dayType || 'Workday').trim();
      if (!AX_DAY_TYPES.has(dayTypeIn)) {
        return json({ ok: false, error: `Tipo de día inválido: ${dayTypeIn}. Debe ser Workday o RestDay.` }, 400);
      }

      const r = await axInsertMarcaje(env, {
        alias: body.alias,
        personnelNumber: body.personnelNumber,
        transDate: body.transDate,
        dayType: dayTypeToAx(dayTypeIn),
        timeEntry: body.timeEntry,
        timeExit: body.timeExit,
      });

      // El eco del payload es a proposito: en una integracion nueva, la
      // mitad de los problemas son "mande otra cosa de la que creia".
      const enviado = r.payload ? { ...r.payload, _horas_legibles: r.legible } : null;

      if (!r.ok) {
        return json({
          ok: false,
          http: r.http,
          error: r.error,
          detalles_ax: r.detalles_ax,
          xml: r.xml,
          enviado,
        }, r.http ? 502 : 400);
      }

      return json({ ok: true, http: r.http, mensaje: r.mensaje, enviado });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error del servidor: ' + (e && e.message ? e.message : e) }, 500);
  }
}
