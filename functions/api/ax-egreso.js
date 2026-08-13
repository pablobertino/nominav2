/* =====================================================================
   functions/api/ax-egreso.js  ->  POST /api/ax-egreso            (v6.207)
   EGRESOS: HERRAMIENTA DE DIAGNOSTICO contra AX 2012.

   QUE ES Y QUE NO ES. Esto NO publica reportes. No lee egress_report_lines,
   no escribe bitacora, no cierra nada, no aparece en ningun menu. Es un
   banco de pruebas para conocer el contrato de la API de egresos
   (POST /empleados/finalizar/v1) ANTES de implementar el boton Publicar.
   Cuando la publicacion de verdad exista, esto se borra o se deja como
   quedo ax-marcajes.js: para depurar un caso suelto con Sistemas.

   POR QUE VIVE EN EL SERVIDOR Y NO EN UN HTML:
   la API esta geobloqueada fuera de Venezuela y la excepcion es Cloudflare.
   Un HTML corriendo en el navegador sale con la IP de quien lo abre y el
   bloqueo lo frena. Desde aca la llamada sale del edge de Cloudflare, que
   si esta permitido. Y de yapa la X-API-Key nunca baja al cliente: el HTML
   de ejemplo la trae escrita en el codigo, y servida asi la lee cualquiera
   que abra el inspector -- con ella se pueden EGRESAR trabajadores sin
   pasar por el portal.

   POR QUE TODAVIA NO HAY UN _axegresos.js:
   los modulos compartidos (_axmarcajes.js, _axausencias.js) existen porque
   guardan una TRADUCCION ya verificada del portal a AX. Aca no hay nada
   verificado que guardar: justamente eso es lo que venimos a averiguar.
   Un modulo escrito hoy seria una suposicion con nombre de biblioteca.
   Nace cuando las pruebas digan como se comporta AX de verdad.

   LO QUE HAY QUE AVERIGUAR (y por eso la respuesta va CRUDA):
     1) Si la API dice la verdad. El middleware manda el lote entero en UNA
        llamada SOAP y devuelve UN solo texto (api_workerExit.py, lineas
        95-98). Solo contesta error si AX devuelve un HTTP distinto de 200,
        o sea si se cae el lote completo. Hay que ver que dice cuando la
        cedula no existe: si contesta un error honesto o si contesta
        "Exito" como hace la API de marcajes.
     2) Que pasa al REENVIAR un egreso ya cargado. En marcajes reenviar es
        gratis (AX omite lo identico); en ausencias es peligroso (AX
        rechaza el periodo superpuesto). En egresos no lo sabemos, y la
        respuesta cambia todo el diseño: si AX pisa la fecha en silencio,
        un reintento inocente corrompe una fin_contrato, que es el dato con
        el que se pagan las prestaciones.
     3) Si un lote mixto (una buena + una mala) se puede descifrar. Si no,
        hay que mandar de a UNA linea, como se hizo con ausencias.

   Acciones (POST { action, user, ... }):
     health {}         Ping de vida (GET .../health). No escribe nada.
     probar { lote }   Manda el lote TAL CUAL a AX y devuelve la respuesta
                       cruda. OJO: ESCRIBE EN AX DE VERDAD si la cedula
                       existe. No es un simulador.

   GATE: solo superadmin. Es una herramienta temporal que egresa gente de
   verdad; cuanta menos mano la alcance, mejor. El permiso definitivo
   (report.publish.egreso) nace con el boton Publicar, no con esto.

   Env vars: canaima_apikey (o ax_api_key), ax_egresos_url (opcional).
   ===================================================================== */

import { resolveActor, isSuperadmin, AuthError } from './_auth.js';
import { axKey, axCall } from './_axmarcajes.js';

export const AX_EGRESOS_URL_DEFAULT = 'https://api.grupocanaima.com/empleados/finalizar/v1';

/* Tope del lote. No es un limite de la API: es un freno de mano. Esta
   herramienta escribe egresos reales y se maneja a mano desde una consola;
   un dedo pesado no tiene que poder mandar doscientos. */
const MAX_LOTE = 10;

function axEgrBase(env) {
  return String((env && env.ax_egresos_url) || AX_EGRESOS_URL_DEFAULT).replace(/\/+$/, '');
}

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

/* Valida la FORMA del lote, no el contenido. Que la cedula exista o no en
   AX es justamente lo que se viene a probar: eso no se filtra aca. */
function revisarLote(lote) {
  if (!Array.isArray(lote) || !lote.length) {
    return { error: 'Mandá un lote: un array con al menos un { personnelNumber, fechaEgreso }.' };
  }
  if (lote.length > MAX_LOTE) {
    return { error: `El lote trae ${lote.length} líneas y el tope de esta herramienta es ${MAX_LOTE}.` };
  }
  const limpio = [];
  for (let i = 0; i < lote.length; i++) {
    const it = lote[i] || {};
    const personnelNumber = String(it.personnelNumber == null ? '' : it.personnelNumber).trim();
    const fechaEgreso = String(it.fechaEgreso == null ? '' : it.fechaEgreso).trim().slice(0, 10);
    if (!personnelNumber) return { error: `Línea ${i + 1}: falta personnelNumber.` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaEgreso)) {
      return { error: `Línea ${i + 1}: fechaEgreso debe venir como AAAA-MM-DD (llegó "${fechaEgreso}").` };
    }
    /* Se manda TAL CUAL vino, sin rellenar con ceros ni sacar puntos. Si el
       formato del numero de personal importa, queremos que la prueba lo
       destape, no que este codigo lo tape. */
    limpio.push({ personnelNumber, fechaEgreso });
  }
  return { lote: limpio };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Cuerpo inválido.' }, 400); }
  const action = String(body.action || 'health').trim();

  try {
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);
    if (!isSuperadmin(actor)) {
      return json({ ok: false, error: 'Solo un superadministrador puede usar esta herramienta.' }, 403);
    }

    const key = axKey(env);
    if (!key) {
      return json({ ok: false, error: 'Falta el secret canaima_apikey (o ax_api_key) en las variables del proyecto.' }, 500);
    }
    const base = axEgrBase(env);

    /* ---------------- health: ping sin efectos ---------------- */
    if (action === 'health') {
      const url = `${base}/health`;
      const t0 = Date.now();
      let r;
      try {
        r = await axCall(url, key, { method: 'GET' });
      } catch (e) {
        return json({
          ok: false, url, http: 0, ms: Date.now() - t0,
          error: 'No se pudo contactar al middleware: ' + String((e && e.message) || e),
        }, 502);
      }
      return json({
        ok: r.ok, url, http: r.status, ms: Date.now() - t0,
        respuesta: r.data,
        crudo: r.data ? null : String(r.raw || '').slice(0, 1000),
      }, r.ok ? 200 : 502);
    }

    /* ---------------- probar: ESCRIBE EN AX DE VERDAD ---------------- */
    if (action === 'probar') {
      const chk = revisarLote(body.lote);
      if (chk.error) return json({ ok: false, error: chk.error }, 400);

      const t0 = Date.now();
      let r;
      try {
        r = await axCall(base, key, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(chk.lote),
        });
      } catch (e) {
        return json({
          ok: false, url: base, http: 0, ms: Date.now() - t0, enviado: chk.lote,
          error: 'No se pudo contactar al middleware: ' + String((e && e.message) || e),
        }, 502);
      }

      /* Se devuelve TODO: el HTTP, el JSON si lo hubo y el texto crudo si no.
         Cuando AX devuelve un SOAP Fault, el middleware lo pasa entero en
         "details", y ese XML es la mejor pista que vamos a tener. */
      return json({
        ok: r.ok,
        url: base,
        http: r.status,
        ms: Date.now() - t0,
        enviado: chk.lote,
        respuesta: r.data,
        crudo: String(r.raw || '').slice(0, 4000),
      });
    }

    return json({ ok: false, error: 'Acción desconocida. Usá health o probar.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error del servidor: ' + (e && e.message ? e.message : e) }, 500);
  }
}
