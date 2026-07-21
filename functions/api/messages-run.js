/* =====================================================================
   functions/api/messages-run.js  →  POST /api/messages-run
   FASE 2 — EJECUTOR de los mensajes programados. v6.56 SOLO GRUPOS.

   Lo llama el CRON, no una persona:
     pg_cron (cada 15 min)
       -> nomina_v2.tick_messages()   decide QUE regla toca hoy
            -> POST aqui { source:'cron', adminId, code, period }

   Este endpoint NO decide cuando: eso ya lo resolvio el tick. Aca se
   ARMA y se ENVIA:
     1. lee la regla (message_templates)
     2. v6.56: el destino son los GRUPOS de la regla (group_ids -> wa_groups
        -> chat_id @g.us). Ya NO son personas del roster.
     3. arma el texto UNA sola vez (un grupo recibe un mensaje unico para
        todos; sin #Nombre/#Empresa), con las fechas del ciclo vigente.
     4. canal 'portal'   -> crea/reemplaza el aviso en announcements
        canal 'wa'       -> envia el texto a cada grupo @g.us (gaClient)
        canal 'wa+portal'-> las dos

   POR QUE NO HACE FALTA LA MAQUINARIA ANTI-BANEO DE DIFUSION:
   los baneos se disparan por mandar a muchos NUMEROS que no te agendan
   (difusion fria a @c.us). Enviar a un GRUPO es 1 mensaje a 1 destino @g.us
   donde la linea YA es miembro: WhatsApp lo cuenta como 1 accion, no como N
   miembros. Para 5 grupos son 5 operaciones. La unica precaucion es un
   respiro corto entre grupo y grupo (cortesia a la API, no anti-baneo).

   EL REEMPLAZO DEL AVISO es seguro por construccion: la regla solo pisa
   avisos con rule_id = SU code. Un aviso creado a mano tiene rule_id NULL
   y es INTOCABLE. La regla de "cierre" tampoco ve el aviso de "pago".

   Tambien se puede llamar a mano desde la vista (source:'manual') para
   probar/enviar una regla sin esperar al cron ("A mano / Inmediato").

   Secrets: supabase_url, supabase_service_role, portal_base_url
   ===================================================================== */

import { resolveActor, can } from './_auth.js';
import { gaClient } from './_greenapi.js';
import { renderTemplate } from './wa-templates.js';

/* v6.56: entre grupo y grupo, un respiro corto. NO es anti-baneo (mandar a
   un grupo es 1 accion de bajo riesgo); es cortesia para no golpear la API
   de la linea con varias llamadas en el mismo instante. */
const bigDelay = () => 2500 + Math.floor(Math.random() * 1500);
const MAX_GROUPS_PER_RUN = 50;   // tope de seguridad por invocacion (limite de la Function)

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

/* ---------- fechas del ciclo (identico a wa-templates.js) ---------- */
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
                'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function fmtDate(d) {
  if (!d) return '';
  const s = String(d).slice(0, 10).split('-');
  if (s.length !== 3) return '';
  const day = Number(s[2]), mon = Number(s[1]);
  if (!day || !mon) return '';
  return `${day} de ${MONTHS[mon - 1]}`;
}
function fmtDateTime(ts) {
  if (!ts) return '';
  const base = fmtDate(String(ts).slice(0, 10));
  const hh = String(ts).slice(11, 16);
  return hh && hh !== '00:00' ? `${base} a las ${hh}` : base;
}

/* Periodo vigente en hora de CARACAS (no UTC: si no, entre las 20:00 y
   medianoche el portal ya estaria en el dia siguiente). */
async function cycleCtx(env) {
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Caracas' });
  const sel = 'period_no,name,range_start,range_end,cutoff_date,report_deadline,milestone_date,pay_date,claim_deadline';
  let p = await sb(env, `payroll_periods?range_start=lte.${hoy}&range_end=gte.${hoy}&select=${sel}&limit=1`);
  if (!p || !p.length) {
    p = await sb(env, `payroll_periods?range_start=gte.${hoy}&select=${sel}&order=range_start.asc&limit=1`);
  }
  const r = (p && p[0]) || {};
  return {
    period_no: r.period_no || null,
    periodo: r.name || '',
    fecha_cierre: fmtDate(r.cutoff_date),
    limite_reportes: fmtDateTime(r.report_deadline),
    fecha_calculo: fmtDate(r.milestone_date),
    fecha_pago: fmtDate(r.pay_date),
    fecha_reclamos: fmtDate(r.claim_deadline),
  };
}

/* ---------- canal PORTAL: crear el aviso, reemplazando el propio ----------
   La regla archiva SU aviso anterior (rule_id = su code) y publica el nuevo.
   Los avisos manuales (rule_id NULL) no se tocan JAMAS: es la respuesta a
   "esto no me va a pisar los avisos que ya tengo, no?". No. */
async function publishAnnouncement(env, tpl, text, periodNo, adminId) {
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Caracas' });

  // 1) Archivar el aviso anterior DE ESTA MISMA REGLA (si lo hay).
  await sb(env, `announcements?rule_id=eq.${encodeURIComponent(tpl.code)}&is_active=eq.true`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() }),
  });

  // 2) Publicar el nuevo, marcado con su dueno.
  // OJO: created_by es INTEGER (id de admin_users), no texto. El cron corre
  // como el superadmin que le paso tick_messages(); si no se manda, el aviso
  // queda huerfano y en la vista Avisos no se sabe quien lo publico.
  const row = await sb(env, 'announcements', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      title: tpl.label,
      body: text,
      audience: 'everyone',        // el valor que usa el portal (no 'all')
      starts_on: hoy,
      ends_on: null,
      is_active: true,
      created_by: Number(adminId) || null,
      rule_id: tpl.code,
      rule_period: periodNo || null,
    }),
  });
  return (row && row[0] && row[0].id) || null;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  const code = String(body.code || '').trim();
  const isCron = String(body.source || '') === 'cron';
  if (!code) return json({ ok: false, error: 'Falta el mensaje.' }, 400);

  try {
    /* GATE. El cron se identifica con el adminId que le pasa tick_messages()
       (el superadmin activo). Una llamada manual pasa por el permiso normal
       de envio: probar una regla es enviar de verdad. */
    const user = isCron
      ? { kind: 'admin', id: Number(body.adminId) || 0 }
      : body.user;
    const actor = await resolveActor(env, user);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
    if (!isCron && !can(actor, 'wa.send')) {
      return json({ ok: false, error: 'No tienes permiso para enviar mensajes.' }, 403);
    }

    const tRows = await sb(env, `message_templates?code=eq.${encodeURIComponent(code)}&select=*`);
    const tpl = tRows && tRows[0];
    if (!tpl) return json({ ok: false, error: 'Ese mensaje no existe.' }, 404);
    if (!tpl.is_active) return json({ ok: false, error: 'Ese mensaje esta inactivo.' }, 400);

    const cyc = await cycleCtx(env);
    const chan = tpl.channel || 'wa';
    const wantWa = chan === 'wa' || chan === 'wa+portal';
    const wantPortal = chan === 'portal' || chan === 'wa+portal';

    /* v6.56: el texto es UNO SOLO para todo el grupo (sin #Nombre/#Empresa).
       Se renderiza una sola vez con las fechas del ciclo vigente. */
    const text = renderTemplate(tpl.body, { ...cyc }, false);

    /* ---------- canal PORTAL ----------
       El aviso es un cartel unico: mismo texto renderizado. */
    let annId = null;
    if (wantPortal) {
      // El id del admin: el cron manda adminId; una corrida manual usa el
      // actor de la sesion. En los dos casos, el aviso queda con autor.
      const who = isCron ? Number(body.adminId) : Number(user && user.id);
      annId = await publishAnnouncement(env, tpl, text, cyc.period_no, who);
    }

    /* ---------- canal WHATSAPP (a los GRUPOS) ----------
       Se resuelven los chat_id @g.us de los grupos de la regla y se envia el
       MISMO texto a cada uno, con un respiro corto entre grupo y grupo. No
       hay maquinaria anti-baneo: mandar a un grupo es 1 accion de bajo
       riesgo (ver cabecera). Se guarda la corrida en wa_batches y cada grupo
       en wa_outbox para auditoria (quien recibio que), igual que Difusion. */
    let batchId = null, queued = 0, sent = 0, errors = 0, groupsTotal = 0;

    if (wantWa) {
      const gids = Array.isArray(tpl.group_ids) ? tpl.group_ids : [];
      let groups = [];
      if (gids.length) {
        // Solo grupos habilitados: si el super deshabilito un grupo, la regla
        // deja de mandarle sin tener que reeditarla.
        groups = await sb(env,
          `wa_groups?id=in.(${gids.join(',')})&enabled=eq.true&select=id,chat_id,wa_name,alias`) || [];
      }
      groupsTotal = groups.length;

      if (groups.length) {
        const batch = await sb(env, 'wa_batches', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            created_by: isCron ? 'cron' : String(actor.actor || ''),
            message: text,
            filters: {
              rule: tpl.code, nature: tpl.nature, trigger: tpl.trigger_kind,
              target: 'groups',
              group_ids: groups.map(g => g.id),
            },
            total: groups.length,
            with_phone: groups.length,   // en grupos: "destinos validos"
          }),
        });
        batchId = batch && batch[0] && batch[0].id;

        const targets = groups.slice(0, MAX_GROUPS_PER_RUN);
        queued = targets.length;

        const ga = gaClient(env);
        for (let i = 0; i < targets.length; i++) {
          const g = targets[i];
          let st = 'sent', idMsg = null, errTxt = null;
          try {
            const res = await ga.sendMessage(g.chat_id, text);
            idMsg = (res && res.idMessage) || null;
            sent++;
          } catch (e) {
            st = 'error';
            errTxt = String(e && e.message ? e.message : e).slice(0, 500);
            errors++;
          }
          // Auditoria por grupo. Se reusa wa_outbox: full_name = nombre del
          // grupo, chat_id = @g.us. id_number/company_code no aplican.
          await sb(env, 'wa_outbox', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify([{
              batch_id: batchId,
              id_number: null,
              full_name: g.alias || g.wa_name || g.chat_id,
              company_code: '',
              phone_raw: g.chat_id,
              chat_id: g.chat_id,
              status: st,
              id_message: idMsg,
              error_text: errTxt,
              sent_at: st === 'sent' ? new Date().toISOString() : null,
            }]),
          });
          // Respiro corto entre grupo y grupo (salvo tras el ultimo).
          if (i < targets.length - 1) await sleep(bigDelay());
        }
      }
    }

    /* ---------- cerrar la corrida en la regla ---------- */
    const okRun = errors === 0;
    await sb(env, `message_templates?code=eq.${encodeURIComponent(code)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        last_status: okRun ? 'ok' : 'error',
        last_error: okRun ? null : `${errors} grupo(s) fallaron`,
        last_sent: sent,
        portal_announcement_id: annId || null,
      }),
    });

    return json({
      ok: true,
      code, channel: chan,
      groups_total: groupsTotal,
      queued, sent, errors,
      announcement_id: annId,
      batch_id: batchId,
      // Util cuando la regla no tiene grupos habilitados (todos deshabilitados
      // o ninguno elegido) pero el canal incluye WhatsApp.
      note: (wantWa && !groupsTotal)
        ? 'La regla no tiene grupos habilitados: no se envio ningun WhatsApp.'
        : null,
    });
  } catch (e) {
    // Dejar el error EN LA REGLA: si no, una corrida del cron falla en
    // silencio y nadie se entera hasta que alguien pregunta por que no llego
    // el mensaje.
    try {
      await sb(env, `message_templates?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          last_status: 'error',
          last_error: String(e && e.message ? e.message : e).slice(0, 500),
        }),
      });
    } catch (_) { /* si ni eso se puede, que al menos responda */ }
    return json({ ok: false, error: 'Error del servidor: ' + (e && e.message ? e.message : e) }, 500);
  }
}
