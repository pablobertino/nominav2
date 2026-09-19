/* =====================================================================
   functions/api/ax-cargo.js  ->  POST /api/ax-cargo
   CAMBIOS DE CARGO Y TRASLADOS: HERRAMIENTA DE DIAGNOSTICO contra AX 2012.

   QUE ES Y QUE NO ES. Esto NO es el boton Publicar. No escribe bitacora,
   no marca nada como publicado, no aparece en ningun menu. Es el banco de
   pruebas para conocer el contrato real de
   POST /empleados/cambioCargo/v1 ANTES de construir la publicacion.
   Cuando el boton exista, esto se deja como quedo ax-egreso.js: para
   depurar un caso suelto con Sistemas.

   POR QUE ESTE PASO EXISTE, Y NO ES DESCONFIANZA GRATUITA.
   En egresos ya nos paso, y quedo escrito en la cabecera de ax-egreso.js:
   el .py que circulaba NO era lo que estaba desplegado. El archivo mandaba
   el lote entero y devolvia un texto crudo; el middleware real tenia
   logica POR TRABAJADOR y devolvia CONTADORES. Y ademas se comprobo que
   estas APIs MIENTEN EN EL CODIGO HTTP: contestan 200 y "success" aunque
   la linea no haya entrado. La unica señal confiable resulto ser la
   aritmetica del mensaje.

   Asi que hay tres cosas que no se pueden leer de un .py y deciden la
   forma del publicador:

     1) ¿Contesta contadores o un texto suelto?  -> lote o de a uno
     2) ¿Miente en el HTTP?                      -> de que señal fiarse
     3) ¿Reenviar es seguro?                     -> si hace falta candado

   La (3) es la que mas pesa. En egresos reenviar resulto inofensivo ("Ya
   egresados" es una categoria propia). Si aca reenviar DUPLICA la
   asignacion de cargo, el publicador necesita un candado duro.

   POR QUE VIVE EN EL SERVIDOR Y NO EN UN HTML:
   la API esta geobloqueada fuera de Venezuela y la excepcion es
   Cloudflare. Y de yapa la X-API-Key nunca baja al cliente: el HTML de
   ejemplo la trae escrita en el codigo, y servida asi la lee cualquiera
   que abra el inspector — con ella se puede cambiarle el cargo o la
   empresa a cualquier trabajador sin pasar por el portal.

   Acciones (POST { action, user, ... }):
     health  {}          Ping de vida. No escribe nada.
     previa  { ids }     Traduce movimientos REALES de la cola al payload
                         que se mandaria, y NO manda nada. Lee la base,
                         resuelve el ax_code de cada cargo y muestra el
                         JSON exacto. Sirve para revisar la traduccion
                         contra datos de verdad sin tocar AX.
     probar  { lote }    Manda el lote TAL CUAL a AX y devuelve la
                         respuesta cruda. OJO: ESCRIBE EN AX DE VERDAD.
                         No es un simulador.

   GATE: solo superadmin. Cambia cargos y empresas de gente real.
   El permiso definitivo nace con el boton Publicar, no con esto.

   Env vars: canaima_apikey (o ax_api_key), ax_cambiocargo_url (opcional).
   ===================================================================== */

import { resolveActor, isSuperadmin, AuthError } from './_auth.js';
import { axKey, axCall } from './_axmarcajes.js';
import { axCargoBase, axCargoHealth, normalizeCargo } from './_axcargo.js';

/* Tope del lote. No es un limite de la API: es un freno de mano. Esta
   herramienta escribe cambios reales y se maneja desde una consola; un
   dedo pesado no tiene que poder mandar doscientos. */
const MAX_LOTE = 5;

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

/* Valida la FORMA del lote crudo, no el contenido. Que la cedula exista en
   AX es justamente lo que se viene a probar: eso no se filtra aca. */
function revisarLote(lote) {
  if (!Array.isArray(lote) || !lote.length) {
    return { error: 'Mandá un lote: un array con al menos un movimiento.' };
  }
  if (lote.length > MAX_LOTE) {
    return { error: `El lote trae ${lote.length} líneas y el tope de esta herramienta es ${MAX_LOTE}.` };
  }
  return { lote };
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

    /* ---------------- health: ping sin efectos ---------------- */
    if (action === 'health') {
      const t0 = Date.now();
      const h = await axCargoHealth(env);
      return json({ ...h, ms: Date.now() - t0 }, h.ok ? 200 : 502);
    }

    /* ---------------- previa: traduce y NO manda ----------------
       Lee movimientos de verdad y muestra el payload exacto. Es el paso
       que permite revisar la traduccion (sobre todo las fechas, que es lo
       unico realmente sutil) sin escribir una sola letra en AX. */
    if (action === 'previa') {
      const ids = (Array.isArray(body.ids) ? body.ids : [])
        .map(n => parseInt(n, 10)).filter(Number.isFinite);
      if (!ids.length) return json({ ok: false, error: 'Mandá ids: los N° de movimiento a traducir.' }, 400);
      if (ids.length > 50) return json({ ok: false, error: 'Máximo 50 movimientos por previa.' }, 400);

      const moves = await sb(env,
        `personnel_movement_requests?id=in.(${ids.join(',')})`
        + '&select=id,tipo,id_number,full_name,cargo_from,cargo_to,empresa_origen,'
        + 'empresa_destino,fecha_efectiva,fecha_baja,fecha_alta,estado') || [];
      if (!moves.length) return json({ ok: false, error: 'Ninguno de esos movimientos existe.' }, 404);

      /* El ax_code se resuelve ACA, que es donde esta la base. Y a
         diferencia del export a plantilla —que si falta el ax_code manda
         el code del portal— un faltante es un ERROR: 'CAJERO' donde AX
         espera 'CAJEROS' es pedirle a AX que adivine. */
      const cargos = await sb(env, 'cargos?select=code,ax_code') || [];
      const axOf = code => {
        const c = cargos.find(x => x.code === code);
        return c && c.ax_code ? c.ax_code : '';
      };

      const previa = moves.map(m => {
        const cargoPortal = m.cargo_to || m.cargo_from || '';
        const n = normalizeCargo({
          tipo: m.tipo,
          personnelNumber: m.id_number,
          position: axOf(cargoPortal),
          empresa_destino: m.tipo === 'traslado' ? m.empresa_destino : null,
          fecha_efectiva: m.fecha_efectiva,
          fecha_alta: m.fecha_alta,
          fecha_baja: m.fecha_baja,
          cargoCambia: !!(m.cargo_to && m.cargo_from && m.cargo_to !== m.cargo_from),
        });
        return {
          id: m.id, tipo: m.tipo, estado: m.estado,
          persona: `${m.full_name || ''} (${m.id_number})`.trim(),
          cargo_portal: cargoPortal, cargo_ax: axOf(cargoPortal) || null,
          ok: n.ok, payload: n.payload, legible: n.legible,
          error: n.error, avisos: n.avisos,
        };
      });

      return json({
        ok: true,
        url: axCargoBase(env),
        total: previa.length,
        traducibles: previa.filter(p => p.ok).length,
        con_error: previa.filter(p => !p.ok).length,
        previa,
        nota: 'Esto NO se mandó a AX. Es solo la traducción.',
      });
    }

    /* ---------------- probar: ESCRIBE EN AX DE VERDAD ---------------- */
    if (action === 'probar') {
      const key = axKey(env);
      if (!key) {
        return json({ ok: false, error: 'Falta el secret canaima_apikey (o ax_api_key) en las variables del proyecto.' }, 500);
      }
      const chk = revisarLote(body.lote);
      if (chk.error) return json({ ok: false, error: chk.error }, 400);

      const base = axCargoBase(env);
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

      /* Se devuelve TODO: el HTTP, el JSON si lo hubo y el texto crudo si
         no. Cuando AX devuelve un SOAP Fault, el middleware lo pasa entero
         en "details", y ese XML es la mejor pista que vamos a tener.
         Y se recuerda lo del 200 mentiroso, porque el que lea esto en
         pantalla va a ver "ok: true" y puede creerle. */
      return json({
        ok: r.ok,
        url: base,
        http: r.status,
        ms: Date.now() - t0,
        enviado: chk.lote,
        respuesta: r.data,
        ignorados: (r.data && Array.isArray(r.data.ignorados)) ? r.data.ignorados : [],
        crudo: String(r.raw || '').slice(0, 4000),
        ojo: 'HTTP 200 y "success" NO garantizan que la línea entró. Revisá el mensaje y los ignorados.',
      });
    }

    return json({ ok: false, error: 'Acción desconocida. Usá health, previa o probar.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error del servidor: ' + (e && e.message ? e.message : e) }, 500);
  }
}
