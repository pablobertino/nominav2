/* =====================================================================
   functions/api/ax-egreso.js  ->  POST /api/ax-egreso            (v6.208)
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

   ---------------------------------------------------------------------
   CONTRATO REAL  (verificado en vivo el 13/08/2026, v6.208)
   ---------------------------------------------------------------------
   PRIMERO Y MAS IMPORTANTE: el api_workerExit.py que circulo NO es lo que
   esta desplegado. Ese archivo manda el lote entero en una llamada SOAP y
   devuelve un solo texto crudo de AX. El middleware que atiende hoy tiene
   logica POR TRABAJADOR y devuelve CONTADORES. No leer el .py como si
   fuera la verdad; pedirle a Sistemas el actualizado.

   Lo que contesta de verdad, siempre con HTTP 200 y status "success":

     "Proceso finalizado. Egresados: 0. Errores: 1. Ya egresados: 0.
      Trabajador 00000001 no encontrado. "

   Tres cosas quedaron probadas:

   1) MIENTE EN EL CODIGO HTTP, igual que la API de marcajes. Contesta 200
      y "success" aunque una linea no haya entrado. Guiarse por eso es
      cerrar un reporte para siempre con gente sin egresar.
      LA UNICA SEÑAL CONFIABLE ES LA ARITMETICA:
          Egresados + Errores + Ya egresados  ==  cuantos mande
      Cuadro en las tres pruebas (1 de 1, 1 de 1, 2 de 2).

   2) REENVIAR ES SEGURO. "Ya egresados" es una categoria propia, no un
      error: la API detecta que la persona ya estaba egresada y la saltea
      sin volver a escribir. Sigue el modelo de MARCAJES (omitir es exito),
      no el de ausencias (donde AX rechaza y el log tiene que ser fuente de
      verdad). Probado con la misma fecha; falta probar con una distinta.

   3) EL LOTE SE PUEDE DESCIFRAR. Cada detalle nombra a la persona con su
      cedula ("La persona LUIS ALEJANDRO QUERO LOPEZ (25457490) ya esta
      egresada"), asi que en un lote mixto se puede atribuir linea por
      linea. No hace falta la llamada-por-linea que se uso en ausencias.

   Y quedo confirmado que personnelNumber es la CEDULA: se mando 25457490 y
   la API resolvio el nombre completo. El "Ej. 000150" del HTML de ejemplo
   es una pista falsa.

   LO QUE TODAVIA NO SE SABE:
     a) Que cara tiene un EXITO. Nunca se vio un "Egresados: 1": no sabemos
        si el detalle nombra a quien entro. Si no lo nombra, en un lote con
        varios exitos no se puede atribuir cual fue cual.
     b) Si una fecha DISTINTA para alguien ya egresado pisa la fin_contrato.
        El mensaje no menciona fechas, lo que sugiere que ni las mira, pero
        eso es una lectura, no un dato. Importa porque esa fecha es con la
        que se pagan las prestaciones.
     c) Empleos MULTIPLES. Esta API no recibe alias, y hay gente con varias
        relaciones laborales. Se supone que cierra la activa, que es unica,
        pero no esta probado.

   Acciones (POST { action, user, ... }):
     health {}         Ping de vida (GET .../health). No escribe nada.
     probar { lote }   Manda el lote TAL CUAL a AX y devuelve la respuesta
                       cruda. OJO: ESCRIBE EN AX DE VERDAD si la cedula
                       existe. No es un simulador.

   GATE: solo superadmin. Es una herramienta temporal que egresa gente de
   verdad; cuanta menos mano la alcance, mejor. El permiso definitivo
   (report.publish.egreso) nace con el boton Publicar, no con esto.

   Env vars: canaima_apikey (o ax_api_key), ax_finalizar_url (opcional).

   OJO CON EL NOMBRE DE LA VARIABLE: el override se llama ax_finalizar_url y
   NO ax_egresos_url. Ese ultimo ya existe y apunta a la API de LECTURA de
   egresos (/empleados/egresos/v1, la que usa ax-sync.js para llenar
   nomina_v2.ax_egresos). Son endpoints opuestos -uno lee, este ESCRIBE- y
   compartir el nombre significaria que configurar la sincronizacion manda
   egresos al lugar equivocado.
   ===================================================================== */

import { resolveActor, isSuperadmin, AuthError } from './_auth.js';
import { axKey, axCall } from './_axmarcajes.js';

export const AX_EGRESOS_URL_DEFAULT = 'https://api.grupocanaima.com/empleados/finalizar/v1';

/* Tope del lote. No es un limite de la API: es un freno de mano. Esta
   herramienta escribe egresos reales y se maneja a mano desde una consola;
   un dedo pesado no tiene que poder mandar doscientos. */
const MAX_LOTE = 10;

function axEgrBase(env) {
  return String((env && env.ax_finalizar_url) || AX_EGRESOS_URL_DEFAULT).replace(/\/+$/, '');
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
