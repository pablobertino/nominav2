/* =====================================================================
   functions/api/messages-run.js  →  POST /api/messages-run
   FASE 2 — EJECUTOR de los mensajes programados.

   Lo llama el CRON, no una persona:
     pg_cron (cada 15 min)
       -> nomina_v2.tick_messages()   decide QUE regla toca hoy
            -> POST aqui { source:'cron', adminId, code, period }

   Este endpoint NO decide cuando: eso ya lo resolvio el tick. Aca se
   ARMA y se ENVIA:
     1. lee la regla (message_templates)
     2. resuelve el alcance -> destinatarios (wa_recipients, o
        wa_birthday_recipients si es cumpleanos)
     3. arma el texto por persona (renderTemplate, el MISMO motor del preview)
     4. canal 'portal'   -> crea/reemplaza el aviso en announcements
        canal 'wa'       -> encola en wa_batches/wa_outbox y despacha
        canal 'wa+portal'-> las dos

   POR QUE REUSAR wa_batches/wa_outbox Y NO UNA COLA NUEVA:
   ahi vive TODA la maquinaria anti-bloqueo que ya funciona (tandas cortas,
   jitter, delay de linea, reintentos, auditoria de quien recibio que). Una
   cola paralela tendria que reimplementar eso y se desincronizaria.

   EL REEMPLAZO DEL AVISO es seguro por construccion: la regla solo pisa
   avisos con rule_id = SU code. Un aviso creado a mano tiene rule_id NULL
   y es INTOCABLE. La regla de "cierre" tampoco ve el aviso de "pago".

   Tambien se puede llamar a mano desde la vista (source:'manual') para
   probar una regla sin esperar al cron.

   Secrets: supabase_url, supabase_service_role, portal_base_url
   ===================================================================== */

import { resolveActor, can } from './_auth.js';
import { gaClient, toChatId } from './_greenapi.js';
import { renderTemplate } from './wa-templates.js';

/* Mismo ritmo que Difusion (wa-send.js): sin rafagas. Un envio programado
   no tiene apuro, asi que va directo al ritmo lento y seguro. */
const BATCH_SIZE = 4;
const bigDelay = () => 2500 + Math.floor(Math.random() * 1500);
const MAX_PER_RUN = 40;   // tope por invocacion (limite de la Function)

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
const rpc = (env, fn, args) =>
  sb(env, `rpc/${fn}`, { method: 'POST', body: JSON.stringify(args || {}) });

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

function scopeArgs(sf) {
  const s = sf || {};
  const nn = v => (v === undefined || v === null || String(v).trim() === '' ? null : String(v));
  return {
    p_zone: nn(s.zone), p_subzone: nn(s.subzone), p_type: nn(s.type),
    p_concept: nn(s.concept), p_company: nn(s.company), p_id_number: nn(s.id_number),
  };
}

/* ---------- canal PORTAL: crear el aviso, reemplazando el propio ----------
   La regla archiva SU aviso anterior (rule_id = su code) y publica el nuevo.
   Los avisos manuales (rule_id NULL) no se tocan JAMAS: es la respuesta a
   "esto no me va a pisar los avisos que ya tengo, no?". No. */
async function publishAnnouncement(env, tpl, text, periodNo) {
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Caracas' });

  // 1) Archivar el aviso anterior DE ESTA MISMA REGLA (si lo hay).
  await sb(env, `announcements?rule_id=eq.${encodeURIComponent(tpl.code)}&is_active=eq.true`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() }),
  });

  // 2) Publicar el nuevo, marcado con su dueno.
  const row = await sb(env, 'announcements', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      title: tpl.label,
      body: text,
      audience: 'everyone',
      starts_on: hoy,
      ends_on: null,
      is_active: true,
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
    const isBirthday = tpl.trigger_kind === 'birthday';
    const chan = tpl.channel || 'wa';
    const wantWa = chan === 'wa' || chan === 'wa+portal';
    const wantPortal = chan === 'portal' || chan === 'wa+portal';

    /* ---------- destinatarios ---------- */
    const args = scopeArgs(tpl.scope_filters);
    const r = isBirthday
      ? await rpc(env, 'wa_birthday_recipients', { ...args, p_on: null, p_limit: 100000 })
      : await rpc(env, 'wa_recipients', { ...args, p_limit: 100000 });

    const all = (r && r.rows) || [];
    const withPhone = all.filter(x => x.phone_ok);

    /* ---------- canal PORTAL ----------
       El aviso NO se personaliza por persona (es un cartel unico): se
       renderiza con el nombre en blanco y las fechas del ciclo. */
    let annId = null;
    if (wantPortal) {
      const text = renderTemplate(tpl.body, { nombre: '', empresa: '', ...cyc }, false);
      annId = await publishAnnouncement(env, tpl, text, cyc.period_no);
    }

    /* ---------- canal WHATSAPP ---------- */
    let batchId = null, queued = 0, sent = 0, errors = 0;

    if (wantWa && withPhone.length) {
      /* El texto se arma POR PERSONA: #Nombre y #Empresa cambian en cada
         mensaje, por eso no se puede mandar un texto unico al lote. El
         mensaje viaja en wa_outbox... pero wa_outbox NO tiene columna de
         mensaje por fila (el lote guarda uno solo). Se resuelve mandando
         aca mismo, sin diferir: son envios chicos (cumpleanos ~1/dia) y el
         cron ya nos dio la ventana. */
      const batch = await sb(env, 'wa_batches', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          created_by: isCron ? 'cron' : String(actor.actor || ''),
          message: renderTemplate(tpl.body, { nombre: '(cada persona)', empresa: '(su empresa)', ...cyc }, false),
          filters: {
            rule: tpl.code, nature: tpl.nature, trigger: tpl.trigger_kind,
            ...Object.fromEntries(Object.entries(tpl.scope_filters || {}).filter(([, v]) => v)),
            ...(isBirthday ? { birthday_on: (r && r.date) || null } : {}),
          },
          total: (r && r.total) || all.length,
          with_phone: withPhone.length,
        }),
      });
      batchId = batch && batch[0] && batch[0].id;

      const targets = withPhone.slice(0, MAX_PER_RUN);
      queued = targets.length;

      const ga = gaClient(env);
      for (let i = 0; i < targets.length; i += BATCH_SIZE) {
        const tanda = targets.slice(i, i + BATCH_SIZE);
        for (const p of tanda) {
          const text = renderTemplate(tpl.body, {
            nombre: p.full_name || '',
            empresa: p.company_name || '',
            ...cyc,
          }, false);
          let st = 'sent', idMsg = null, errTxt = null;
          try {
            const res = await ga.sendMessage(toChatId(p.phone), text);
            idMsg = (res && res.idMessage) || null;
            sent++;
          } catch (e) {
            st = 'error';
            errTxt = String(e && e.message ? e.message : e).slice(0, 500);
            errors++;
          }
          // Auditoria: quien recibio que, igual que Difusion.
          await sb(env, 'wa_outbox', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify([{
              batch_id: batchId,
              id_number: p.id_number,
              full_name: p.full_name || '',
              company_code: p.company_code || '',
              phone_raw: p.phone,
              chat_id: toChatId(p.phone),
              status: st,
              id_message: idMsg,
              error_text: errTxt,
              sent_at: st === 'sent' ? new Date().toISOString() : null,
            }]),
          });
          await sleep(bigDelay());
        }
      }
    }

    /* ---------- cerrar la corrida en la regla ---------- */
    const okRun = errors === 0;
    await sb(env, `message_templates?code=eq.${encodeURIComponent(code)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        last_status: okRun ? 'ok' : 'error',
        last_error: okRun ? null : `${errors} envio(s) fallaron`,
        last_sent: sent,
        portal_announcement_id: annId || null,
      }),
    });

    return json({
      ok: true,
      code, channel: chan,
      total: (r && r.total) || all.length,
      with_phone: withPhone.length,
      without_phone: (r && r.without_phone) || 0,
      queued, sent, errors,
      announcement_id: annId,
      batch_id: batchId,
      // Util cuando no hay a quien mandarle: el cumpleanos corre todos los
      // dias y la mayoria no cumple nadie (o nadie tiene telefono).
      note: (wantWa && !withPhone.length)
        ? 'Nadie del alcance tiene telefono cargado: no se envio ningun WhatsApp.'
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
