/* =====================================================================
   functions/api/_naima.js  →  AVISOS DE NAIMA EN LOS GRUPOS (v6.154)

   Cuando una TIENDA reporta (ingreso, egreso, marcaje, ausencia,
   modificacion, traslado) o pide una CONSTANCIA, Naima publica un acuse de
   recibo en el grupo de WhatsApp de la ZONA de esa tienda.

   Se importa desde reports.js y cert-requests.js. El prefijo _ lo excluye
   del enrutado de Pages Functions (mismo patron que _greenapi.js/_auth.js).

   TRES LLAVES, todas tienen que estar abiertas para que salga el aviso:
     1. Interruptor MAESTRO: app_settings.wa_naima_reports_enabled = 'true'.
        Arranca en 'false': apaga todo al instante, sin deploy.
     2. Interruptor POR TIPO: app_settings.wa_naima_reports_types, lista
        separada por comas (ej. 'ingreso,egreso,constancia'). Un tipo que no
        este en la lista no avisa, aunque el maestro este prendido.
     3. RUTEO de la zona: wa_zone_group tiene que mapear la zona de la tienda
        a un grupo habilitado. Zona sin grupo = sin aviso (rollout gradual:
        se arranca con Margarita y se van sumando zonas).

   POR QUE SE ENVIA EN EL MOMENTO Y NO SE ENCOLA:
   wa_outbox NO es una cola con un worker que la drene: las filas 'pending'
   solo salen cuando el FRONTEND llama a wa-send { action:'process' } en
   bucle. Un insert 'pending' desde aca se quedaria ahi para siempre. Por eso
   se sigue el patron de messages-run.js: enviar en el acto y grabar la fila
   ya como 'sent'/'error'. Mandar a UN grupo es 1 accion de bajo riesgo (la
   linea ya es miembro), y la separacion entre mensajes ya la impone la
   propia linea con delaySendMessagesMilliseconds = 15000 (el guardian de
   wa-send.js lo mantiene): no hace falta jitter en el camino del reporte.

   NUNCA LANZA. Todo va dentro de try/catch: si WhatsApp falla, el reporte
   ya quedo registrado y con su ticket. Un aviso perdido no puede tumbar un
   reporte.
   ===================================================================== */

import { gaClient } from './_greenapi.js';

const SETTING_ENABLED = 'wa_naima_reports_enabled';
const SETTING_TYPES   = 'wa_naima_reports_types';
/* Si la fila de tipos no existe todavia, estos son los que avisan. */
const DEFAULT_TYPES = 'ingreso,egreso,constancia';

/* Tipos de aviso: emoji + como se nombra en el mensaje. Las claves son los
   mismos 'topic' de reports_log, mas 'constancia' (cert_requests). */
export const NAIMA_TYPES = {
  ingreso:      { emoji: '🟢', label: 'Ingreso' },
  egreso:       { emoji: '🔴', label: 'Egreso' },
  marcaje:      { emoji: '🕐', label: 'Marcaje' },
  ausencia:     { emoji: '🟠', label: 'Ausencia' },
  modificacion: { emoji: '✏️', label: 'Modificación' },
  traslado:     { emoji: '🔁', label: 'Traslado' },
  constancia:   { emoji: '📜', label: 'Constancia de trabajo' },
};

/* El repertorio de Naima. {q} = ", Nombre (Rol)" o vacio (constancia pedida
   por la tienda, donde no hay persona: el solicitante es la tienda). */
const OPENERS = [
  '¡Épale{q}! 👋 Recibido.',
  '¡Fino{q}! 👌 Tomo nota.',
  '¡Gracias{q}! ✨ De una.',
  '¡Chévere{q}! 😎 Anotado.',
  '¡Vale{q}, gracias! 🙌',
  '¡De una{q}! Ya lo agarré 🤝',
  '¡Listo el pollo{q}! 🐔',
  '¡Manos a la obra{q}! 💪',
  '¡Al día{q}! Registrado ✅',
  '¡Naguará{q}, rapidito! 😄 Recibido.',
  '¡Recibido{q}! 📥',
  '¡Perfecto{q}! ✅ Ya quedó.',
  '¡Buenísimo{q}! 🙌 Anotado.',
  '¡Excelente{q}! ✨ Lo tengo.',
  '¡Listo{q}! 👍 Registrado.',
  '¡Anotado{q}! 📝',
  '¡Confirmado{q}! ✅',
  '¡Va que va{q}! 🚀 Recibido.',
  '¡Gracias por avisar{q}! 🙏',
  '¡Bien ahí{q}! 👏 Tomo nota.',
  '¡Súper{q}! 🌟 Ya lo tengo.',
  '¡Clarísimo{q}! 👌 Anotado.',
  '¡De lujo{q}! 😄 Registrado.',
  '¡Todo en orden{q}! ✅ Recibido.',
];

/* OJO: la firma es SIEMPRE "Capital Humano", nunca "Nómina" (regla del
   contexto aprobado). Los dos cierres del mockup que decian "en manos de
   Nómina" estan corregidos aca. */
const CLOSERS = [
  'Ya lo tiene Capital Humano. 💚',
  'Quedó registrado, nos ponemos las pilas. 💪',
  'Ya va en camino 🚀',
  'Quedó fino, cualquier cosa les aviso. 👀',
  'Tranquilos que quedó en manos de Capital Humano. 🤝',
  '¡Seguimos echándole pichón! 💪',
  '¡Pendiente que lo seguimos! 👍',
  'Listo pues, ¡gracias por reportar! 💚',
  '¡Dale que vamos bien! 🎯',
  'Eso quedó volando bajito. ✅',
  'Capital Humano ya lo está viendo. 👀',
  'Queda en nuestras manos. 🤝',
  'Lo tomamos desde acá. 💚',
  'Ya entró al sistema. ✅',
  'Gracias por reportar a tiempo. ⏱️',
  'Seguimos con eso. 👍',
  'Cualquier novedad les avisamos. 📣',
  'Quedó en la cola de Capital Humano. 📋',
  'Con esto seguimos adelante. 🚀',
  'Todo claro por acá. ✅',
  'Lo revisamos y les contamos. 🔎',
  'Gracias, así da gusto trabajar. 💚',
  'Quedamos atentos. 👀',
  'Capital Humano toma el relevo. 🤝',
  'Registrado y en marcha. ⚙️',
];

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

/* Solo grupos: jamas un chat individual (@c.us). Misma guarda que wa-send. */
const isGroupChat = id => /@g\.us$/i.test(String(id || ''));

/* =====================================================================
   v6.203 — CUMPLEAÑOS DE QUIEN REPORTA

   Cuando el responsable del reporte esta de cumpleaños, el acuse arranca con
   una felicitacion. Va en el MISMO mensaje y no en uno aparte: un envio extra
   a WhatsApp es justo lo que venimos cuidando, y llegaria descolgado del
   contexto. Va ARRIBA porque un "feliz cumpleaños" debajo de un numero de
   ticket parece un post-it pegado de apuro.

   UNA SOLA VEZ AL DIA, y el candado no es un `if (ya salude)`: dos reportes
   simultaneos leerian los dos que todavia no. Es la PK de naima_birthday_log
   (id_number, greeted_on) — saluda el insert que entra, el otro rebota.

   COMO SE LLEGA A LA FECHA: el reporte manda el NOMBRE del responsable, no su
   cedula. store_contacts ata nombre+tienda a cedula (255 de 255 la tienen) y
   de ahi workers_master da el birth_date (252 de 255). Se busca dentro de los
   contactos DE ESA TIENDA, que son 4 como maximo, asi que el match por nombre
   no es ambiguo. Si no calza, no se saluda: un cumpleaños perdido es molesto,
   saludar a la persona equivocada es peor.

   29 DE FEBRERO: se obvia en años normales (decision de Pablo). Solo saluda
   cuando el calendario realmente trae un 29/02.
   ===================================================================== */
const SETTING_BIRTHDAY = 'wa_naima_birthday_enabled';

const BIRTHDAY_LINES = [
  '🎂 ¡Feliz cumpleaños, *{n}*! 🎉',
  '🎂 ¡Hoy cumple años *{n}*! Felicidades de parte de todo el equipo 🎉',
  '🥳 ¡Feliz cumpleaños, *{n}*! Que tengas un día bien bonito.',
  '🎈 Antes de lo otro: ¡feliz cumpleaños, *{n}*! 🎂',
  '🎉 ¡*{n}* está de cumpleaños! Que la pases lindo hoy 🎂',
  '🎂 ¡Felicidades en tu día, *{n}*! 🎈',
  '🎊 ¡Feliz cumpleaños, *{n}*! Que se cumpla todo lo que pidas 🎂',
];

/* Hoy en Venezuela. UTC-4 fijo, sin horario de verano: restar 4 horas alcanza
   y evita depender de que el runtime traiga la base de zonas horarias. */
function hoyCaracas() {
  return new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
}

async function settingOn(env, key) {
  try {
    const r = await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}&select=value`);
    return String(r && r[0] ? r[0].value : '').trim().toLowerCase() === 'true';
  } catch (_) { return false; }
}

/* Devuelve la linea de felicitacion o ''. NUNCA lanza: si algo falla, el
   acuse sale igual sin saludo. */
async function birthdayLine(env, ctx) {
  try {
    if (!ctx.responsible || !ctx.companyCode) return '';
    if (!(await settingOn(env, SETTING_BIRTHDAY))) return '';

    const hoy = hoyCaracas();                 // 'YYYY-MM-DD'
    const mmdd = hoy.slice(5);
    /* El 29/02 no necesita codigo: comparar MM-DD con MM-DD ya hace que quien
       nacio ese dia solo calce cuando el calendario trae un 29/02. En años
       normales no se saluda, que es lo acordado. */

    const cc = encodeURIComponent(ctx.companyCode);
    const nom = String(ctx.responsible).trim();
    /* v6.206: is_active=true, como en todo el resto del codigo que lee
       store_contacts. Hoy es inofensivo —quien esta de baja no aparece en el
       wizard, asi que no puede ser el responsable de un reporte— pero desde
       la v6.205 el sync da de baja a los que ya no trabajan en la tienda, y
       leer sin filtrar deja abierta la puerta a felicitar a alguien que se
       fue. Una consulta que ignora el estado es una trampa esperando. */
    const contactos = await sb(env,
      `store_contacts?company_code=eq.${cc}&is_active=eq.true&select=id_number,full_name`) || [];
    const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const hit = contactos.find(c => norm(c.full_name) === norm(nom));
    if (!hit || !hit.id_number) return '';

    const ced = encodeURIComponent(hit.id_number);
    const w = await sb(env, `workers_master?id_number=eq.${ced}&select=birth_date,full_name`);
    const nace = w && w[0] && w[0].birth_date ? String(w[0].birth_date).slice(0, 10) : '';
    if (!nace || nace.slice(5) !== mmdd) return '';

    /* El candado. `Prefer: return=representation` + on conflict do nothing:
       si vuelve vacio es que ya se saludo hoy y este reporte se queda callado. */
    let entro = null;
    try {
      entro = await sb(env, 'naima_birthday_log?on_conflict=id_number,greeted_on', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({
          id_number: hit.id_number, greeted_on: hoy,
          company_code: ctx.companyCode, report_id: ctx.reportId || null,
          full_name: hit.full_name || nom,
        }),
      });
    } catch (_) { return ''; }
    if (!entro || !entro.length) return '';   // ya lo saludamos hoy

    /* La frase rota por persona y año, no por reporte: si rotara por reporte,
       dos personas que cumplen el mismo dia podrian sacar la misma. */
    const semilla = Math.abs([...String(hit.id_number)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7))
      + Number(hoy.slice(0, 4));
    const linea = BIRTHDAY_LINES[semilla % BIRTHDAY_LINES.length];
    return linea.replace('{n}', firstName(nom));
  } catch (_) {
    return '';
  }
}

/* Primer nombre, con la primera en mayuscula: 'JOSE LUIS PEREZ' -> 'José'
   no se puede (no hay acentos en el dato), pero si 'JOSE' -> 'Jose'. Se usa
   solo el primer nombre porque el saludo es cercano, no un encabezado. */
function firstName(full) {
  const w = String(full || '').trim().split(/\s+/)[0] || '';
  if (!w) return '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/* La rotacion NO usa Math.random(): se deriva del id del reporte, asi el
   mismo reporte siempre arma el mismo texto (reintentos idempotentes) y no
   hay estado que guardar.

   v6.157 — POR QUE CAMBIARON LOS NUMEROS. La version anterior tenia 10
   aperturas y 10 cierres, y elegia apertura = id % 10, cierre = (id*7) % 10.
   Parecian 100 combinaciones, pero eran 10: los DOS indices salian de
   `id mod 10`, asi que el par quedaba determinado por el ultimo digito del id
   y se repetia cada 10 reportes. Con ~54 avisos por dia, el mismo duo salia
   5 veces al dia. Multiplicar por 7 cambiaba el cierre, no el periodo.

   La correccion no es solo "mas frases": es que los dos tamanos sean
   COPRIMOS. Con 24 aperturas y 25 cierres, el par depende de
   (id mod 24, id mod 25), que por el teorema chino del resto equivale a
   id mod 600: hay 600 combinaciones reales y recien se repiten a los 600
   reportes (~11 dias al ritmo de hoy). Los pasos 11 y 7 son coprimos con su
   tamano, asi que cada lista se recorre entera saltando, sin quedar en orden. */
export function naimaText(ctx) {
  const t = NAIMA_TYPES[ctx.kind] || { emoji: '📌', label: ctx.kind || 'Reporte' };
  const seed = Math.abs(Number(ctx.reportId) || 0);

  const name = firstName(ctx.responsible);
  const role = String(ctx.roleLabel || '').trim();
  const q = name ? `, ${name}${role ? ` (${role})` : ''}` : '';

  const open  = OPENERS[(seed * 11) % OPENERS.length].replace('{q}', q);
  const close = CLOSERS[(seed * 7) % CLOSERS.length];

  const store = [ctx.companyName, ctx.companyCode ? `(${ctx.companyCode})` : '']
    .filter(Boolean).join(' ');
  const people = Number(ctx.workers) > 1 ? ` · ${Number(ctx.workers)} personas` : '';
  const line2 = `${t.emoji} *${t.label}* · *${store}*${people}`;

  // Constancia: no pasa por osTicket, asi que solo lleva su N° de solicitud.
  const numLabel = ctx.kind === 'constancia' ? 'Solicitud' : 'Reporte';
  const ticket = ctx.ticket ? `  ·  🎫 Ticket *#${ctx.ticket}*` : '';
  const line3 = `📄 ${numLabel} *N° ${ctx.reportCode}*${ticket}`;

  return `${open}\n${line2}\n${line3}\n${close}`;
}

/* Las tres llaves. Devuelve el grupo destino o null (con el motivo, que
   sirve para depurar desde el log de la Function). */
async function resolveTarget(env, kind, zoneId) {
  const rows = await sb(env,
    `app_settings?key=in.(${SETTING_ENABLED},${SETTING_TYPES})&select=key,value`) || [];
  const byKey = {};
  rows.forEach(r => { byKey[r.key] = r.value; });

  if (String(byKey[SETTING_ENABLED] || 'false').toLowerCase() !== 'true') {
    return { skip: 'apagado (interruptor maestro)' };
  }
  const types = String(byKey[SETTING_TYPES] == null ? DEFAULT_TYPES : byKey[SETTING_TYPES])
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!types.includes(String(kind).toLowerCase())) {
    return { skip: `tipo '${kind}' desactivado` };
  }
  if (!zoneId) return { skip: 'la tienda no tiene zona' };

  const route = await sb(env,
    `wa_zone_group?zone_id=eq.${encodeURIComponent(zoneId)}&enabled=eq.true&select=wa_group_id`);
  const gid = route && route[0] ? route[0].wa_group_id : null;
  if (!gid) return { skip: `la zona ${zoneId} no tiene grupo asignado` };

  const grp = await sb(env,
    `wa_groups?id=eq.${encodeURIComponent(gid)}&enabled=eq.true&select=id,chat_id,wa_name,alias`);
  const g = grp && grp[0];
  if (!g) return { skip: `el grupo ${gid} no existe o esta deshabilitado` };
  if (!isGroupChat(g.chat_id)) return { skip: 'el destino no es un grupo de WhatsApp' };
  return { group: g };
}

/* =====================================================================
   naimaNotify(env, ctx)  →  el unico punto de entrada.

   ctx = {
     kind,           'ingreso'|'egreso'|'marcaje'|'ausencia'|'modificacion'|
                     'traslado'|'constancia'
     zoneId,         zona de la tienda (reports_log.zone_id / companies.zone_id)
     companyCode, companyName,
     reportId,       id numerico (semilla de la rotacion de frases)
     reportCode,     el numero que se muestra (ya formateado)
     ticket,         numero de osTicket o null (constancia no tiene)
     responsible,    nombre del que reporto ('' si no aplica)
     roleLabel,      rol legible ('Gerente', 'Gestor de empresa'...)
     workers,        cuantas personas abarca el reporte
   }

   Devuelve { sent, skipped?, error? }. NUNCA lanza.
   ===================================================================== */
export async function naimaNotify(env, ctx) {
  try {
    if (!env || !env.supabase_url || !env.GREENAPI_TOKEN) {
      return { sent: false, skipped: 'WhatsApp no configurado' };
    }
    const target = await resolveTarget(env, ctx.kind, ctx.zoneId);
    if (!target.group) return { sent: false, skipped: target.skip };

    const g = target.group;
    /* v6.203: el saludo va PEGADO al acuse, no en un mensaje aparte. Si no
       hay cumpleaños (o ya se saludo hoy) esto devuelve '' y el texto queda
       exactamente igual que antes. */
    const cumple = await birthdayLine(env, ctx);
    const text = (cumple ? cumple + '\n\n' : '') + naimaText(ctx);

    /* Auditoria: la corrida (wa_batches) + el destino (wa_outbox), igual que
       Difusion y Mensajes, para que el aviso aparezca en el Historial de
       WhatsApp con su resultado real. */
    let batchId = null;
    try {
      const batch = await sb(env, 'wa_batches', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          created_by: 'naima',
          message: text,
          filters: {
            source: 'naima', kind: ctx.kind, zone: ctx.zoneId || null,
            company: ctx.companyCode || null, report_id: ctx.reportId || null,
            group_ids: [g.id],
          },
          total: 1, with_phone: 1,
        }),
      });
      batchId = batch && batch[0] && batch[0].id;
    } catch (_) { /* sin lote: el envio igual sigue */ }

    let status = 'sent', idMsg = null, errTxt = null;
    try {
      const res = await gaClient(env).sendMessage(g.chat_id, text);
      idMsg = (res && res.idMessage) || null;
    } catch (e) {
      status = 'error';
      errTxt = String(e && e.message ? e.message : e).slice(0, 500);
    }

    if (batchId) {
      // id_number es NOT NULL (resabio del diseno por-personas): se usa el
      // chat_id del grupo, que es un identificador real del destino.
      try {
        await sb(env, 'wa_outbox', {
          method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify([{
            batch_id: batchId,
            id_number: g.chat_id,
            full_name: g.alias || g.wa_name || g.chat_id,
            company_code: ctx.companyCode || '',
            phone_raw: g.chat_id,
            chat_id: g.chat_id,
            status,
            id_message: idMsg,
            error_text: errTxt,
            sent_at: status === 'sent' ? new Date().toISOString() : null,
          }]),
        });
      } catch (_) { /* la auditoria no puede tumbar nada */ }
    }

    return status === 'sent' ? { sent: true } : { sent: false, error: errTxt };
  } catch (e) {
    // Best-effort de verdad: el reporte ya esta guardado y con su ticket.
    return { sent: false, error: String(e && e.message ? e.message : e).slice(0, 300) };
  }
}
