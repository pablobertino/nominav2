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

/* Primer nombre, con la primera en mayuscula: 'JOSE LUIS PEREZ' -> 'José'
   no se puede (no hay acentos en el dato), pero si 'JOSE' -> 'Jose'. Se usa
   solo el primer nombre porque el saludo es cercano, no un encabezado. */
function firstName(full) {
  const w = String(full || '').trim().split(/\s+/)[0] || '';
  if (!w) return '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/* La rotacion NO usa Math.random(): se deriva del id del reporte. Como el id
   siempre sube, la apertura avanza de a 1 y el cierre de a 7 sobre 10
   opciones (7 y 10 son coprimos), asi que DOS reportes seguidos nunca
   comparten el mismo duo apertura+cierre. Sin estado que guardar y, de
   yapa, el mismo reporte siempre arma el mismo texto (reintentos idempotentes). */
export function naimaText(ctx) {
  const t = NAIMA_TYPES[ctx.kind] || { emoji: '📌', label: ctx.kind || 'Reporte' };
  const seed = Math.abs(Number(ctx.reportId) || 0);

  const name = firstName(ctx.responsible);
  const role = String(ctx.roleLabel || '').trim();
  const q = name ? `, ${name}${role ? ` (${role})` : ''}` : '';

  const open  = OPENERS[seed % OPENERS.length].replace('{q}', q);
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
    const text = naimaText(ctx);

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
