/* =====================================================================
   functions/api/wa-send.js  →  POST /api/wa-send
   Difusion de mensajes WhatsApp (Green-API) - Fase 1: solo TEXTO.
   Estandar del grupo: GC_GREENAPI_INTEGRACION.md. El frontend NUNCA
   habla con Green-API: todo pasa por este proxy que valida permisos.

   Acciones (POST { action, user, ... }):
     facets   {}                          -> catalogos para los filtros
                gate: view.whatsapp
     preview  { target, filtros..., active, people[], group_id, direct_phone }
                -> { total, with_phone, without_phone, messages?, rows[<=1000] }
                gate: view.whatsapp
                v4.99 target: 'companies' (default) = telefonos de las
                EMPRESAS/TIENDAS segun filtros de estructura + solo
                activas (1 mensaje POR TELEFONO valido, muchas tienen 2);
                'people' = lista manual de cedulas armada con el buscador.
                Grupo y numero directo siguen mandando sobre todo.
                v5.05: limit 1000 (antes 100): el universo entra completo,
                asi excluir sobre la grilla es fiable.
     search_people { q }                  -> buscador de personas (roster
                activo, por nombre o cedula) para armar la lista manual
                gate: view.whatsapp (solo superadmin)
     send     { target, filtros..., message, exclude[] }  -> lote + cola
                -> { batch_id, queued }   gate: wa.send
                v5.05 exclude[]: codigos de empresa (o cedulas en modo
                Personas) QUITADOS a mano en la grilla del preview. El send
                re-consulta el RPC, por eso los excluidos deben viajar: se
                filtran aca y quedan registrados en wa_batches.filters.
     process  { batch_id }                -> envia una TANDA (<=8) con
                delay entre mensajes; el front repite hasta remaining=0
                -> { sent, errors, remaining }   gate: wa.send
     status   { batch_id }                -> conteos + errores del lote
                gate: view.whatsapp
     state    {}                          -> getStateInstance (diagnostico)
                gate: wa.send. Ademas hace de GUARDIAN de la linea: verifica
                el ritmo de envio y el acuse de lectura, y los corrige si
                alguien los cambio en la consola del proveedor.

   Regla 1 del estandar (sin rafagas): tandas cortas con pausa de ~450ms
   por mensaje; el "Message sending delay" de la consola Green-API es la
   segunda linea de defensa. Todo queda auditado en wa_batches/wa_outbox.
   ===================================================================== */

import { resolveActor, can, isSuperadmin } from './_auth.js';
import { gaClient, toChatId } from './_greenapi.js';

const BATCH_SIZE = 8;          // mensajes por invocacion (lotes chicos)
const DELAY_MS = 450;          // pausa entre mensajes (lotes chicos)
/* v4.92 ANTI-BLOQUEO: para difusiones GRANDES (>20 destinatarios) el ritmo
   baja a la regla 1 del estandar (1 msg cada 3-5s) con JITTER aleatorio
   (un ritmo metronomico tambien parece bot). Tanda de 4 con 2.5-4s entre
   mensajes = ~9-13s por invocacion (seguro para el limite de la Function)
   y ~1 mensaje cada 3.2s promedio. El "Message sending delay" de la
   consola del proveedor es la SEGUNDA linea de defensa (v6.73: objetivo
   15000ms, lo fija el guardian de abajo). */
const BIG_THRESHOLD = 20;
const BIG_BATCH_SIZE = 4;
const bigDelay = () => 2500 + Math.floor(Math.random() * 1500);
const MAX_MESSAGE = 4000;      // limite practico del portal (API admite 20000)
/* v5.05: el preview trae hasta 1000 filas (antes 100). Con ~150 empresas
   activas el universo entra COMPLETO: lo que se ve es lo que se envia, y
   por eso excluir sobre la grilla es fiable (antes, con un filtro de mas
   de 100, se excluia sobre una muestra parcial y el resto viajaba igual). */
const PREVIEW_LIMIT = 1000;
/* v4.98 GUARDIAN DEL DELAY DE LINEA: el "Message sending delay" de la
   instancia (delaySendMessagesMilliseconds) es la SEGUNDA linea de
   defensa del estandar (pausa REAL entre salidas hacia WhatsApp). El
   action 'state' lo verifica en cada carga de Difusion y si esta por
   debajo del minimo lo corrige solo (auto-reparable: si alguien lo baja
   en la consola, el portal lo restaura). Idempotente: una vez en 15000ms
   nunca vuelve a setear (setSettings reinicia la instancia, doc: aplica
   en ~5 min).
   v6.73: objetivo subido de 3500 a 15000ms por el blindaje anti-baneo
   (BLINDAJE_ANTIBANEO.md): intervalos cortos entre chats distintos son
   senal de automatizacion; 15s es la recomendacion de Green-API. */
const LINE_DELAY_MIN_MS = 15000;
const LINE_DELAY_SET_MS = 15000;
/* v6.159 ACUSE DE LECTURA ("las dos rayitas azules").

   v6.160 CORRECCION: la version anterior de este comentario afirmaba que la
   linea "nunca marcaba leido". Era falso. Se dedujo del codigo del portal (que
   efectivamente no marca nada) sin mirar la instancia, y en la consola del
   proveedor markIncomingMessagesReadedOnReply YA estaba en 'yes', puesto a
   mano. O sea que este guardian no lo ACTIVA: lo SOSTIENE, que igual es util
   (si alguien lo apaga desde la consola, el portal lo repone). Leccion: el
   estado de la linea vive en la instancia, no en el repositorio.

   De las dos opciones que da el proveedor se mantiene la MENOS delatora:
     markIncomingMessagesReaded         -> marca TODO lo entrante al instante.
                                           Barrido constante, cero criterio:
                                           es MAS robotico, no menos.
     markIncomingMessagesReadedOnReply  -> marca leido SOLO el chat donde la
                                           API efectivamente responde.  <-- esta
   Con la segunda, el leido queda pegado a una accion real: Naima lee el grupo
   donde acaba de publicar un acuse, ~2 s despues del reporte. Es exactamente
   lo que haria una persona que abre el grupo, ve el reporte y contesta. Y en
   los grupos donde no responde nada, no marca nada, que tambien es humano.

   OJO (doc del proveedor): si markIncomingMessagesReadedOnReply es 'yes', la
   otra se IGNORA; y los mensajes recibidos ANTES de aplicar el ajuste se
   quedan en "entregado" para siempre. Aplica de aca en adelante. */
const READ_ON_REPLY = 'yes';
/* v6.160 "ESCRIBIENDO…". autoTyping es un ajuste de instancia: el proveedor
   muestra el indicador ANTES de cada mensaje saliente, y calcula cuanto dura
   segun el LARGO del mensaje. Sale gratis la variacion: no hay que programar
   ninguna espera.

   El valor es la velocidad de tecleo, de 1 (5 caracteres por segundo) a 10
   (50 c/s); 0 lo apaga. Se elige 3 (15 c/s):

     Los avisos de Naima miden 145-179 caracteres (159 en promedio), asi que
     con 3 el "escribiendo..." dura ~11 s. Hoy, SIN esto, el mensaje sale a los
     ~2 s: son ~80 caracteres por segundo, el doble de lo que el propio
     proveedor admite como maximo y muy por encima de cualquier humano (una
     persona rapida en el telefono hace 3-6 c/s). O sea que esto no es
     maquillaje: corrige una senal que hoy se esta dando.

     Con 1 (5 c/s) el indicador duraria ~32 s: mas realista, pero el acuse
     dejaria de ser oportuno. 3 es el punto donde sigue leyendose como alguien
     que contesta al toque pero que igual tuvo que teclear.

   OJO: la doc del proveedor describe el chatId de forma generica y no aclara
   si el indicador se ve en GRUPOS. En chats individuales es seguro; en grupos
   hay que verificarlo en vivo (mirar el grupo cuando entre el proximo
   reporte). Si no aparece, se pone en 0 y no se pierde nada. */
const AUTO_TYPING = 3;

/* ===================== v5.15: ESTADO DE LA LINEA EN CRISTIANO =====================
   El proveedor devuelve el estado de la linea como un codigo en ingles
   (stateInstance). La vista Difusion lo pintaba CRUDO en la pildora del
   encabezado: cuando la linea se cayo, al usuario le aparecio literalmente
   "yellowCard" y no habia forma de saber que significaba ni que hacer.

   Aca se traduce a un objeto que el front pinta tal cual:
     { level, title, hint }
       level: 'ok' | 'warn' | 'bad'   -> color de la pildora
       title: texto corto (lo que se ve)
       hint : que hacer (tooltip)

   Reglas del portal que esto respeta:
   - Nunca se nombra al proveedor en la UI (se dice "la linea").
   - Nunca se muestra jerga tecnica cruda en ingles.

   OJO CON yellowCard: la documentacion lo marca como "deprecated, replaced
   with suspended", PERO la consola del proveedor lo SIGUE devolviendo hoy
   (visto en produccion 2026-07-11). Por eso se mapean LOS DOS al mismo
   texto: creerle a la doc y sacar yellowCard dejaria al usuario otra vez
   frente a un codigo crudo. Cualquier estado desconocido cae en un texto
   generico y seguro (nunca se filtra el codigo del proveedor). */
const LINE_STATES = {
  authorized: {
    level: 'ok', title: 'Línea conectada',
    hint: 'La línea está lista para enviar.',
  },
  notAuthorized: {
    level: 'bad', title: 'Línea desconectada',
    hint: 'Hay que volver a vincular el teléfono de la línea escaneando el código QR. Mientras tanto no sale ningún mensaje.',
  },
  // Restriccion temporal de WhatsApp sobre la linea. yellowCard es el
  // nombre viejo del mismo estado; ambos siguen llegando.
  suspended: {
    level: 'warn', title: 'Línea con restricciones',
    hint: 'WhatsApp le puso restricciones temporales a la línea. Los envíos pueden fallar o llegar con demora. Conviene no hacer difusiones grandes hasta que se normalice.',
  },
  yellowCard: {
    level: 'warn', title: 'Línea con restricciones',
    hint: 'WhatsApp le puso restricciones temporales a la línea. Los envíos pueden fallar o llegar con demora. Conviene no hacer difusiones grandes hasta que se normalice.',
  },
  blocked: {
    level: 'bad', title: 'Línea bloqueada',
    hint: 'WhatsApp bloqueó la línea. No se puede enviar. Hay que revisarlo con el proveedor del servicio.',
  },
  sleepMode: {
    level: 'warn', title: 'Línea en reposo',
    hint: 'El teléfono de la línea está apagado o sin internet. Al encenderlo puede tardar unos minutos en reconectar.',
  },
  starting: {
    level: 'warn', title: 'Línea iniciando',
    hint: 'La línea se está levantando. Puede tardar unos minutos.',
  },
};

/* Traduce el estado crudo. Nunca devuelve el codigo del proveedor: si es
   desconocido, texto generico (que el usuario no vea jerga jamas). */
function lineStatus(st) {
  const code = st && st.stateInstance ? String(st.stateInstance) : '';
  const known = LINE_STATES[code];
  if (known) return { ...known, code };
  return {
    level: 'bad',
    title: 'Línea no disponible',
    hint: 'No se pudo verificar el estado de la línea. Vuelve a intentarlo en unos minutos.',
    code,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* v6.50 SOLO GRUPOS: la linea (Naima) publica UNICAMENTE en grupos de
   WhatsApp; jamas a un chat individual. Un chat_id de grupo termina en
   '@g.us'. Este guardian es la red de seguridad definitiva: aunque algun
   flujo viejo cuele un destinatario individual (@c.us), aca NO se envia. */
function isGroupChat(chatId) {
  return /@g\.us$/i.test(String(chatId || ''));
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
const rpc = (env, fn, args) =>
  sb(env, `rpc/${fn}`, { method: 'POST', body: JSON.stringify(args || {}) });

function pickFilters(body) {
  const nn = v => (v === undefined || v === null || v === '' ? null : String(v));
  return {
    p_zone: nn(body.zone), p_subzone: nn(body.subzone),
    p_type: nn(body.type), p_concept: nn(body.concept),
    p_company: nn(body.company), p_id_number: nn(body.id_number),
  };
}

/* v4.99: filtros para el destino EMPRESAS/TIENDAS (wa_company_recipients).
   p_active default true = solo empresas activas (checkbox de la vista). */
function pickCompanyFilters(body) {
  const nn = v => (v === undefined || v === null || v === '' ? null : String(v));
  return {
    p_zone: nn(body.zone), p_subzone: nn(body.subzone),
    p_type: nn(body.type), p_concept: nn(body.concept),
    p_company: nn(body.company),
    p_active: body.active === undefined ? true : !!body.active,
  };
}

/* v4.99: lista manual de cedulas (modo Personas). Sanea y dedup. */
function pickPeople(body) {
  const arr = Array.isArray(body.people) ? body.people : [];
  return [...new Set(arr.map(x => String(x || '').replace(/\D/g, '')).filter(Boolean))];
}

/* v5.05: EXCLUIDOS del preview. La grilla de destinatarios permite quitar
   empresas (una a una con la X, o varias con los checkboxes). El 'send' NO
   usa las filas del preview: RE-CONSULTA el RPC con los filtros, asi que la
   lista de excluidos tiene que VIAJAR y filtrarse aca; si no, se enviaria a
   quienes el usuario quito. Se guarda en wa_batches.filters (auditoria de a
   quien NO se le mando). Para empresas la clave es company_code; para
   personas, la cedula. */
function pickExclude(body) {
  const arr = Array.isArray(body.exclude) ? body.exclude : [];
  return new Set(arr.map(x => String(x || '').trim()).filter(Boolean));
}

/* v4.91: numero directo (pruebas / destinatario fuera de nomina).
   Valida >=10 digitos tras limpiar; manda solo (ignora filtros). */
function pickDirectPhone(body) {
  const raw = String(body.direct_phone || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return { raw, ok: digits.length >= 10 };
}

/* v4.93: grupo habilitado como destinatario. v4.97: si restrictAdminId
   viene (admin no-super), el grupo ademas debe estar ASIGNADO a ese
   admin en wa_group_admins. Un solo mensaje al chat_id @g.us (sin
   toChatId). Prioridad: grupo > numero directo > cedula. */
async function pickGroup(env, body, restrictAdminId) {
  const gid = Number(body.group_id || 0);
  if (!gid) return null;
  const r = await sb(env, `wa_groups?id=eq.${gid}&enabled=eq.true&select=id,chat_id,wa_name,alias`);
  const grp = (r && r[0]) || undefined;   // undefined = pedido pero no habilitado
  if (grp && restrictAdminId) {
    const link = await sb(env,
      `wa_group_admins?group_id=eq.${gid}&admin_id=eq.${restrictAdminId}&select=group_id&limit=1`);
    if (!link || !link.length) return undefined;   // no asignado a este admin
  }
  return grp;
}

/* =====================================================================
   v6.180 — VARIOS grupos de una vez.

   Devuelve los grupos pedidos, habilitados, dentro del alcance del usuario,
   y CON SUS ZONAS. Si alguno no cumple, se devuelve el motivo en vez de
   sacarlo en silencio: publicar en menos grupos de los que uno marco, sin
   aviso, es peor que fallar.
   ===================================================================== */
async function pickGroups(env, ids, restrictAdminId) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(n => Number(n) || 0).filter(Boolean))];
  if (!list.length) return { grupos: [], rechazados: [] };

  const rows = await sb(env,
    `wa_groups?id=in.(${list.join(',')})&select=id,chat_id,wa_name,alias,enabled`) || [];
  const byId = new Map(rows.map(g => [g.id, g]));

  // Alcance: un admin no-super solo publica en los grupos que tiene asignados.
  let permitidos = null;
  if (restrictAdminId) {
    const links = await sb(env,
      `wa_group_admins?admin_id=eq.${restrictAdminId}&group_id=in.(${list.join(',')})&select=group_id`) || [];
    permitidos = new Set(links.map(l => l.group_id));
  }

  // Zonas de cada grupo, en UNA consulta (wa_zone_group ya lo sabe: es la
  // misma relacion que usa Ruteo de avisos).
  const zg = await sb(env,
    `wa_zone_group?wa_group_id=in.(${list.join(',')})&enabled=eq.true&select=wa_group_id,zone_id`) || [];
  const zoneIds = [...new Set(zg.map(z => z.zone_id).filter(v => v !== null && v !== undefined))];
  const nameByZone = new Map();
  if (zoneIds.length) {
    const zs = await sb(env,
      `zones?id=in.(${zoneIds.map(z => `"${z}"`).join(',')})&select=id,name`) || [];
    zs.forEach(z => nameByZone.set(String(z.id), z.name));
  }
  const zonasDe = new Map();
  zg.forEach(z => {
    const n = nameByZone.get(String(z.zone_id));
    if (!n) return;
    if (!zonasDe.has(z.wa_group_id)) zonasDe.set(z.wa_group_id, []);
    zonasDe.get(z.wa_group_id).push(n);
  });

  const grupos = [], rechazados = [];
  for (const id of list) {
    const g = byId.get(id);
    if (!g) { rechazados.push({ id, motivo: 'no existe' }); continue; }
    const nombre = g.alias || g.wa_name || g.chat_id;
    if (!g.enabled) { rechazados.push({ id, nombre, motivo: 'no está habilitado' }); continue; }
    if (!isGroupChat(g.chat_id)) { rechazados.push({ id, nombre, motivo: 'no es un grupo de WhatsApp' }); continue; }
    if (permitidos && !permitidos.has(id)) { rechazados.push({ id, nombre, motivo: 'no está asignado a tu usuario' }); continue; }
    grupos.push({
      id: g.id, chat_id: g.chat_id, nombre,
      zonas: (zonasDe.get(g.id) || []).sort((a, b) => a.localeCompare(b, 'es')),
    });
  }
  return { grupos, rechazados };
}

/* Saludo con las zonas del grupo. Idea de Pablo, y es mejor que variar el
   texto por variar: en el grupo de Margarita el aviso dice Margarita, o sea
   que la diferencia entre mensajes es INFORMACION UTIL para quien lee, y de
   paso deja de haber cuatro mensajes identicos seguidos.
   Un grupo sin zonas (Sistemas, Coordinacion, MEJORANDO) no lleva saludo:
   inventarle uno seria peor que no ponerlo. */
function saludoZonas(zonas) {
  if (!zonas || !zonas.length) return '';
  const b = zonas.map(z => `*${z}*`);
  const txt = b.length === 1 ? b[0]
    : b.slice(0, -1).join(', ') + ' y ' + b[b.length - 1];
  return `Equipo${zonas.length > 1 ? 's' : ''} de ${txt}:`;
}

function armarMensaje(base, zonas, conSaludo) {
  const s = conSaludo ? saludoZonas(zonas) : '';
  return s ? `${s}\n\n${base}` : base;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Cuerpo inválido.' }, 400); }
  const action = body.action || 'facets';

  try {
    const actor = await resolveActor(env, body.user);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);
    if (!can(actor, 'view.whatsapp')) {
      return json({ ok: false, error: 'No tienes permiso para la difusión WhatsApp (view.whatsapp).' }, 403);
    }
    const actorName = String(actor.actor || '');
    // v4.97: superadmin difunde a todo; un admin no-super con permisos
    // concedidos SOLO publica a sus grupos asignados (wa_group_admins).
    const superOk = isSuperadmin(actor);
    const restrictId = superOk ? null : (Number(body.user && body.user.id) || -1);

    /* ---------------- facets: catalogos de filtros ---------------- */
    if (action === 'facets') {
      if (!superOk) {
        // Los filtros de estructura son exclusivos de superadmin.
        return json({ ok: true, zones: [], subzones: [], concepts: [], companies: [], types: [] });
      }
      const [zones, subzones, concepts, companies] = await Promise.all([
        sb(env, 'zones?select=id,name&order=name.asc'),
        sb(env, 'subzones?select=id,name,zone_id&order=name.asc'),
        sb(env, 'concepts?select=id,name&order=name.asc'),
        sb(env, 'companies?select=company_code,business_name,company_type&order=business_name.asc'),
      ]);
      const types = [...new Set((companies || []).map(c => c.company_type).filter(Boolean))].sort();
      return json({ ok: true, zones: zones || [], subzones: subzones || [], concepts: concepts || [], companies: companies || [], types });
    }

    /* ------- search_people: buscador para la lista manual (v4.99) ------- */
    if (action === 'search_people') {
      if (!superOk) {
        return json({ ok: false, error: 'El modo Personas es exclusivo del superadministrador.' }, 403);
      }
      const q = String(body.q || '').trim();
      if (q.length < 2) return json({ ok: true, rows: [] });
      const rows = await rpc(env, 'wa_people_search', { p_q: q, p_limit: 20 });
      return json({ ok: true, rows: rows || [] });
    }

    /* ---------------- preview: destinatarios ---------------- */
    if (action === 'preview') {
      // v6.50 SOLO GRUPOS: el preview solo confirma el grupo destino.
      if (!Number(body.group_id || 0)) {
        return json({ ok: false, error: 'Elige el grupo donde se va a publicar.' }, 400);
      }
      const grp = await pickGroup(env, body, restrictId);
      if (grp === undefined) return json({ ok: false, error: 'Ese grupo no está habilitado o no está asignado a tu usuario.' }, 400);
      if (!grp || !isGroupChat(grp.chat_id)) {
        return json({ ok: false, error: 'El destino no es un grupo válido de WhatsApp.' }, 400);
      }
      return json({
        ok: true,
        total: 1, with_phone: 1, without_phone: 0,
        rows: [{
          id_number: '—', full_name: `Grupo: ${grp.alias || grp.wa_name || grp.chat_id}`,
          company_code: '', company_name: '(un solo mensaje al grupo)',
          phone: grp.chat_id, phone_ok: true,
        }],
      });
    }

    if (action === 'status') {
      const bid = String(body.batch_id || '');
      if (!bid) return json({ ok: false, error: 'Falta el lote.' }, 400);
      const rows = await sb(env, `wa_outbox?batch_id=eq.${encodeURIComponent(bid)}&select=status`);
      const errs = await sb(env, `wa_outbox?batch_id=eq.${encodeURIComponent(bid)}&status=eq.error&select=full_name,phone_raw,error_text&limit=50`);
      const n = { pending: 0, sent: 0, error: 0 };
      (rows || []).forEach(r => { n[r.status] = (n[r.status] || 0) + 1; });
      return json({ ok: true, ...n, errors: errs || [] });
    }

    /* ------------- lo que sigue exige la llave de envio ------------- */
    if (!can(actor, 'wa.send')) {
      return json({ ok: false, error: 'No tienes permiso para enviar mensajes WhatsApp (wa.send).' }, 403);
    }

    if (action === 'state') {
      const ga = gaClient(env);
      const st = await ga.state();
      // v4.98: guardian del delay de linea (ver constantes arriba).
      let delayMs = null, delayFixed = false, delayErr = null;
      let readMode = null, readFixed = false;
      let typingSpeed = null, typingFixed = false;
      try {
        const cfg = await ga.getSettings();
        delayMs = Number(cfg && cfg.delaySendMessagesMilliseconds) || 0;
        readMode = String((cfg && cfg.markIncomingMessagesReadedOnReply) || '').toLowerCase() || null;
        typingSpeed = Number((cfg && cfg.autoTyping) || 0);

        /* Los dos arreglos viajan en UNA sola llamada: setSettings REINICIA la
           instancia (doc: aplica en ~5 min), asi que dos llamadas serian dos
           reinicios. Idempotente: si ya estan bien, no se llama y no se
           reinicia nada. */
        const patch = {};
        if (delayMs < LINE_DELAY_MIN_MS) patch.delaySendMessagesMilliseconds = LINE_DELAY_SET_MS;
        if (readMode !== READ_ON_REPLY) patch.markIncomingMessagesReadedOnReply = READ_ON_REPLY;
        if (typingSpeed !== AUTO_TYPING) patch.autoTyping = AUTO_TYPING;

        if (Object.keys(patch).length) {
          await ga.setSettings(patch);
          if (patch.delaySendMessagesMilliseconds) { delayMs = LINE_DELAY_SET_MS; delayFixed = true; }
          if (patch.markIncomingMessagesReadedOnReply) { readMode = READ_ON_REPLY; readFixed = true; }
          if (patch.autoTyping !== undefined) { typingSpeed = AUTO_TYPING; typingFixed = true; }
        }
      } catch (e) {
        delayErr = String(e && e.message ? e.message : e).slice(0, 200);
      }
      return json({
        ok: true, state: st, phone: env.GREENAPI_PHONE || null,
        // v5.15: estado ya traducido (el front no interpreta codigos).
        line: lineStatus(st),
        delay_ms: delayMs, delay_fixed: delayFixed, delay_error: delayErr,
        // v6.159: estado del acuse de lectura ('yes' = la linea marca leido
        // los chats donde responde).
        read_mode: readMode, read_fixed: readFixed,
        // v6.160: velocidad del "escribiendo..." (0 = apagado).
        typing_speed: typingSpeed, typing_fixed: typingFixed,
      });
    }

    /* ---------------- send: crear lote + cola ---------------- */
    if (action === 'send') {
      const message = String(body.message || '').trim();
      if (!message) return json({ ok: false, error: 'El mensaje está vacío.' }, 400);
      if (message.length > MAX_MESSAGE) {
        return json({ ok: false, error: `El mensaje supera los ${MAX_MESSAGE} caracteres.` }, 400);
      }
      /* v6.50 SOLO GRUPOS: la difusion publica UNICAMENTE en grupos de
         WhatsApp. Se elimino el envio a empresas/personas/numero directo.
         v6.180: y ahora en VARIOS grupos de una vez. Se acepta group_ids[];
         group_id suelto se sigue admitiendo para no romper nada viejo. */
      const idsPedidos = Array.isArray(body.group_ids) && body.group_ids.length
        ? body.group_ids
        : (Number(body.group_id || 0) ? [Number(body.group_id)] : []);
      if (!idsPedidos.length) {
        return json({ ok: false, error: 'Elige al menos un grupo donde publicar.' }, 400);
      }

      const { grupos, rechazados } = await pickGroups(env, idsPedidos, restrictId);
      if (!grupos.length) {
        const det = rechazados.map(r => `${r.nombre || r.id} (${r.motivo})`).join('; ');
        return json({ ok: false, error: 'Ninguno de los grupos elegidos se puede usar: ' + det }, 400);
      }
      /* Si alguno quedo afuera se corta y se explica. Publicar en menos grupos
         de los que el usuario marco, sin decirle nada, es peor que fallar: se
         entera dias despues, cuando alguien pregunta por que no le llego. */
      if (rechazados.length) {
        const det = rechazados.map(r => `${r.nombre || r.id} (${r.motivo})`).join('; ');
        return json({ ok: false, error: 'No se envió nada. Estos grupos no se pueden usar: ' + det }, 400);
      }

      const conSaludo = body.zone_greeting !== false;   // por defecto SI
      const batchFilters = {
        group_ids: grupos.map(g => g.id),
        groups: grupos.map(g => g.nombre),
        zone_greeting: conSaludo,
      };

      const batch = await sb(env, 'wa_batches', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          created_by: actorName,
          message,                       // el texto BASE, sin saludo
          filters: batchFilters,
          total: grupos.length,
          with_phone: grupos.length,
        }),
      });
      const batchId = batch && batch[0] && batch[0].id;
      if (!batchId) throw new Error('No se pudo crear el lote.');

      /* Una fila por grupo, cada una con SU texto ya armado. Se guarda el
         mensaje final y no el saludo suelto para que la bitacora muestre
         exactamente lo que se publico en cada grupo. */
      await sb(env, 'wa_outbox', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(grupos.map(g => ({
          batch_id: batchId,
          id_number: 'grupo',
          full_name: `Grupo: ${g.nombre}`,
          company_code: '',
          phone_raw: g.chat_id,
          chat_id: g.chat_id,
          message: armarMensaje(message, g.zonas, conSaludo),
        }))),
      });
      return json({
        ok: true, batch_id: batchId, queued: grupos.length,
        grupos: grupos.map(g => ({ id: g.id, nombre: g.nombre, zonas: g.zonas })),
      });
    }

    /* ---------------- process: enviar una tanda ---------------- */
    if (action === 'process') {
      const bid = String(body.batch_id || '');
      if (!bid) return json({ ok: false, error: 'Falta el lote.' }, 400);
      const batch = await sb(env, `wa_batches?id=eq.${encodeURIComponent(bid)}&select=id,message,with_phone`);
      if (!batch || !batch.length) return json({ ok: false, error: 'El lote no existe.' }, 404);
      const message = batch[0].message;
      const isBig = Number(batch[0].with_phone || 0) > BIG_THRESHOLD;
      /* v6.180 RITMO DE LA DIFUSION MULTI-GRUPO.
         El modo lento (isBig) se dispara por CANTIDAD, a partir de 20. Pero
         la señal que mira WhatsApp no es el volumen: es mandar a CHATS
         DISTINTOS con poco intervalo, tal como dice la nota de la v6.73. Una
         difusion a 5 grupos no llega al umbral y saldria de una sola tanda,
         con 450ms entre grupo y grupo: cinco chats distintos en dos segundos,
         justo el patron que se quiere evitar.
         Por eso, en cuanto hay MAS DE UN grupo, se manda de a UNO y sin pausa
         del lado del servidor: la pausa la pone el navegador, entre 8 y 15
         segundos al azar. Asi cada invocacion de la Function dura lo que dura
         un mensaje (cero riesgo de timeout), el jitter sale gratis, se ve el
         avance grupo por grupo, y los 15s de delaySendMessagesMilliseconds
         del proveedor siguen siendo el piso duro por debajo. */
      const multiGrupo = Number(batch[0].with_phone || 0) > 1;
      const tanda = multiGrupo ? 1 : (isBig ? BIG_BATCH_SIZE : BATCH_SIZE);

      const pend = await sb(env,
        `wa_outbox?batch_id=eq.${encodeURIComponent(bid)}&status=eq.pending&select=id,chat_id,message,full_name&order=id.asc&limit=${tanda}`);
      const ga = gaClient(env);
      let sent = 0, errors = 0;
      const enviados = [];      // v6.180: para que el front diga cual acaba de salir

      for (const row of (pend || [])) {
        // v6.50 SOLO GRUPOS: nunca enviar a un chat individual. Si por algun
        // flujo viejo quedo un @c.us en la cola, se marca error y se salta.
        if (!isGroupChat(row.chat_id)) {
          await sb(env, `wa_outbox?id=eq.${row.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'error', error_text: 'Bloqueado: solo se permite publicar en grupos de WhatsApp.' }),
          });
          errors++;
          continue;
        }
        try {
          // v6.180: cada fila puede traer su propio texto (el encabezado con
          // la zona del grupo). Si no lo trae, se usa el del lote.
          const res = await ga.sendMessage(row.chat_id, row.message || message);
          await sb(env, `wa_outbox?id=eq.${row.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'sent', id_message: (res && res.idMessage) || null, sent_at: new Date().toISOString() }),
          });
          sent++;
          enviados.push(row.full_name || row.chat_id);
        } catch (e) {
          await sb(env, `wa_outbox?id=eq.${row.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'error', error_text: String(e && e.message ? e.message : e).slice(0, 500) }),
          });
          errors++;
        }
        // En multi-grupo NO se duerme aca: la pausa (8-15s con jitter) la pone
        // el navegador entre llamadas. Ver la nota de ritmo mas arriba.
        if (!multiGrupo) await sleep(isBig ? bigDelay() : DELAY_MS);
      }

      const left = await sb(env,
        `wa_outbox?batch_id=eq.${encodeURIComponent(bid)}&status=eq.pending&select=id&limit=1`);
      return json({
        ok: true, sent, errors,
        remaining: (left && left.length) ? true : false,
        enviados,
      });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (e) {
    if (e && e.name === 'AuthError') return json({ ok: false, error: e.message }, e.status || 403);
    // NUNCA exponer el token: los mensajes de gaClient no lo incluyen.
    return json({ ok: false, error: 'Error interno: ' + (e && e.message ? e.message : e) }, 500);
  }
}
