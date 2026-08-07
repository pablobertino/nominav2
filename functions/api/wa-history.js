/* =====================================================================
   functions/api/wa-history.js  →  POST /api/wa-history   (v6.62)
   HISTORIAL de envios de WhatsApp (solo LECTURA). Separa la DEFINICION
   del mensaje (plantilla en message_templates, que se edita en Mensajes)
   de su RESULTADO: cada envio efectivo queda registrado en wa_batches
   (la corrida) + wa_outbox (una fila por destino, con estado y error).

   Esta pantalla lee esos registros y los muestra. NO envia, NO edita, NO
   borra: el borrado/papelera es una iteracion posterior (decidido con
   Pablo). Cualquiera con view.whatsapp ve TODO el historial (sin alcance
   por usuario en esta primera version).

   ORIGENES de una corrida (se deduce de wa_batches.filters):
     - target='groups'  -> Difusion o un Mensaje/regla a grupos. Trae
                           filters.rule (el code del mensaje, si vino de
                           Mensajes) y filters.group_ids. El detalle sale de
                           wa_outbox.chat_id cruzado con wa_groups (nombre).
     - target='credenciales' -> envio de credenciales a una persona
                           (descontinuado en v6.55). filters.kind='portal'.
     - formato viejo (filters.group + filters.group_id) -> difusion antigua
                           a un solo grupo.
     - v6.158 source='naima' -> acuse automatico de Naima por un reporte.
                           Trae el tipo, la tienda y el reporte; el grupo sale
                           de wa_outbox.full_name (el aviso tiene un destino).

   Acciones (POST { action, user, ... }):
     list   { limit?, offset? }   gate: view.wa.history
     detail { batch_id }          gate: view.wa.history
   ===================================================================== */

import { resolveActor, can } from './_auth.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
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

/* Normaliza el estado crudo de wa_outbox a tres cubos para el resumen:
   ok (llego), error (fallo), pending (en cola / nunca disparo). El
   ejecutor marca 'sent' al enviar; 'pending' es el default. Cualquier otro
   valor no vacio se trata como error. */
function bucketOf(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'sent' || s === 'ok') return 'ok';
  if (s === 'pending' || s === '') return 'pending';
  return 'error';
}

/* Origen legible de una corrida a partir de filters (jsonb). Devuelve
   { kind, rule, label } donde kind es 'rule' | 'broadcast' | 'cred' | 'other'.
   rule = code del mensaje (si aplica), para que el frontend pueda mostrar la
   etiqueta del mensaje si la tiene a mano. */
/* v6.189 — URL firmada para ver el adjunto de una difusion en el Historial.
   Se pide SOLO al abrir el detalle de una corrida, nunca en la lista: firmar
   100 corridas para mostrar 100 miniaturas que casi nadie va a mirar es
   regalar tiempo de respuesta. */
const WA_MEDIA_BUCKET = 'wa-media';
async function mediaSignedUrl(env, path) {
  if (!path) return null;
  try {
    const res = await fetch(`${env.supabase_url}/storage/v1/object/sign/${WA_MEDIA_BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        apikey: env.supabase_service_role,
        Authorization: `Bearer ${env.supabase_service_role}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const rel = j && (j.signedURL || j.signedUrl);
    return rel ? `${env.supabase_url}/storage/v1${rel.startsWith('/') ? '' : '/'}${rel}` : null;
  } catch (_) { return null; }
}

function originOf(filters) {
  const f = filters || {};
  /* v6.158: los avisos de Naima (_naima.js) marcan filters.source='naima' y
     traen de que reporte salieron. Antes caian en 'other' ("Otro"), sin forma
     de filtrarlos ni de saber a que tienda correspondian. */
  if (f.source === 'naima') {
    return {
      kind: 'naima', rule: null, label: null,
      naima: {
        type: f.kind || null,          // ingreso | egreso | marcaje | ...
        company: f.company || null,    // codigo de la tienda que reporto
        zone: f.zone || null,
        report_id: f.report_id || null,
      },
    };
  }
  if (f.target === 'groups') {
    // Vino de Mensajes (regla con code) o de una Difusion suelta a grupos.
    if (f.rule) return { kind: 'rule', rule: String(f.rule), label: null };
    return { kind: 'broadcast', rule: null, label: null };
  }
  if (f.target === 'credenciales' || f.kind === 'portal' || f.kind === 'osticket') {
    return { kind: 'cred', rule: null, label: f.member ? String(f.member) : null };
  }
  // Formato viejo: difusion a un grupo (filters.group + group_id).
  if (f.group || f.group_id) return { kind: 'broadcast', rule: null, label: f.group ? String(f.group) : null };
  return { kind: 'other', rule: null, label: null };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Cuerpo inválido.' }, 400); }
  const action = body.action || 'list';

  try {
    const actor = await resolveActor(env, body.user);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);
    /* v6.155: Historial tiene permiso propio (antes compartia view.whatsapp).
       can() ya devuelve true para superadmin. */
    if (!can(actor, 'view.wa.history')) {
      return json({ ok: false, error: 'No tienes permiso para ver el historial (view.wa.history).' }, 403);
    }

    /* ---------------- list: corridas con su resumen ---------------- */
    if (action === 'list') {
      const limit = Math.min(Math.max(parseInt(body.limit, 10) || 100, 1), 300);
      const offset = Math.max(parseInt(body.offset, 10) || 0, 0);

      // Corridas (mas recientes primero). Traigo lo justo para la lista.
      const batches = await sb(env,
        `wa_batches?select=id,created_at,created_by,message,filters,total,with_phone,media_name,media_mime`
        + `&order=created_at.desc&limit=${limit}&offset=${offset}`);
      const rows = batches || [];
      if (!rows.length) return json({ ok: true, rows: [], templates: {} });

      // Resumen OK/error/pendiente por corrida en UNA sola consulta:
      // traigo (batch_id, status) de todo el outbox de estas corridas y
      // agrego en memoria (evita N consultas de conteo).
      const ids = rows.map(b => b.id);
      const inList = ids.map(id => `"${id}"`).join(',');
      // v6.158: se pide tambien full_name (el nombre del destino). En los
      // avisos de Naima el destino es UNO y es el grupo, asi que la lista puede
      // mostrar a que grupo se publico sin una consulta extra.
      const ob = await sb(env,
        `wa_outbox?select=batch_id,status,full_name&batch_id=in.(${inList})`);
      const agg = {};   // batch_id -> { ok, error, pending, total, name }
      (ob || []).forEach(o => {
        const a = agg[o.batch_id] || (agg[o.batch_id] = { ok: 0, error: 0, pending: 0, total: 0, name: null });
        a[bucketOf(o.status)]++; a.total++;
        if (!a.name && o.full_name) a.name = o.full_name;
      });

      // Etiquetas de los mensajes (message_templates) para las corridas que
      // vinieron de una regla: asi la lista muestra "Recordatorio de cierre"
      // en vez del code crudo. Una sola consulta con los codes presentes.
      const codes = [...new Set(rows.map(b => originOf(b.filters).rule).filter(Boolean))];
      const templates = {};
      if (codes.length) {
        const inCodes = codes.map(c => `"${String(c).replace(/"/g, '')}"`).join(',');
        const tpls = await sb(env,
          `message_templates?select=code,label&code=in.(${inCodes})`);
        (tpls || []).forEach(t => { templates[t.code] = t.label || t.code; });
      }

      /* v6.158: los avisos de Naima guardan el CODIGO de la tienda; para la
         lista hace falta el nombre. Una sola consulta con los codigos que
         aparezcan (en un dia son un punado de tiendas repetidas). */
      const naimaCodes = [...new Set(rows
        .map(b => originOf(b.filters).naima)
        .filter(Boolean).map(n => n.company).filter(Boolean))];
      const compNames = {};
      if (naimaCodes.length) {
        const inComp = naimaCodes.map(c => `"${String(c).replace(/"/g, '')}"`).join(',');
        const cs = await sb(env, `companies?select=company_code,business_name&company_code=in.(${inComp})`);
        (cs || []).forEach(c => { compNames[c.company_code] = c.business_name || c.company_code; });
      }

      const out = rows.map(b => {
        const o = originOf(b.filters);
        const a = agg[b.id] || { ok: 0, error: 0, pending: 0, total: 0 };
        return {
          id: b.id,
          created_at: b.created_at,
          created_by: b.created_by || null,
          message: b.message || '',
          origin_kind: o.kind,          // 'rule' | 'broadcast' | 'cred' | 'naima' | 'other'
          rule_code: o.rule,            // code del mensaje (si aplica)
          origin_label: o.label,        // etiqueta suelta (cred/difusion vieja)
          group_ids: (b.filters && b.filters.group_ids) || null,
          // v6.189: los NOMBRES de los grupos, para que la cabecera los liste
          // todos cuando la difusion fue a varios (antes solo se veia uno).
          group_names: (b.filters && b.filters.groups) || null,
          // Si llevo archivo, para poner el clip en la lista sin firmar nada.
          media: b.media_name
            ? { name: b.media_name, mime: b.media_mime, es_imagen: b.media_mime !== 'application/pdf' }
            : null,
          // v6.158: de que tienda fue el aviso y a que grupo se publico.
          naima: o.naima
            ? { ...o.naima, company_name: compNames[o.naima.company] || null, group: a.name || null }
            : null,
          total: b.total || 0,
          with_phone: b.with_phone || 0,
          // Resumen del resultado real (del outbox):
          sent_ok: a.ok,
          sent_error: a.error,
          sent_pending: a.pending,
          outbox_total: a.total,
        };
      });

      return json({ ok: true, rows: out, templates });
    }

    /* ---------------- detail: una corrida, destino por destino --------- */
    if (action === 'detail') {
      const batchId = String(body.batch_id || '').trim();
      if (!batchId) return json({ ok: false, error: 'Falta el identificador de la corrida.' }, 400);

      const bArr = await sb(env,
        `wa_batches?id=eq.${batchId}`
        + `&select=id,created_at,created_by,message,filters,total,with_phone,media_path,media_name,media_mime,media_mode&limit=1`);
      const batch = bArr && bArr[0];
      if (!batch) return json({ ok: false, error: 'No se encontró la corrida.' }, 404);

      const items = await sb(env,
        `wa_outbox?batch_id=eq.${batchId}`
        + `&select=id,id_number,full_name,company_code,phone_raw,chat_id,status,id_message,error_text,created_at,sent_at,message`
        + `&order=id.asc`);
      const list = items || [];

      // Cruce chat_id -> nombre de grupo legible (wa_groups). En los envios a
      // grupos, wa_outbox.chat_id es el @g.us del grupo; mostramos alias o
      // wa_name en vez del jid crudo.
      const groups = await sb(env, `wa_groups?select=chat_id,wa_name,alias`);
      const gmap = {};
      (groups || []).forEach(g => { gmap[g.chat_id] = g.alias || g.wa_name || g.chat_id; });

      const o = originOf(batch.filters);
      const detail = list.map(r => ({
        id: r.id,
        // Para envios a grupos, el "destino" es el grupo (chat_id). Para
        // credenciales, es la persona (full_name / phone).
        group_name: gmap[r.chat_id] || null,
        chat_id: r.chat_id,
        full_name: r.full_name || null,
        company_code: r.company_code || null,
        phone_raw: r.phone_raw || null,
        status: r.status,
        bucket: bucketOf(r.status),
        id_message: r.id_message || null,
        error_text: r.error_text || null,
        sent_at: r.sent_at || null,
        /* v6.189: el texto que recibio ESTE grupo. Con el encabezado de zona
           cada uno recibe algo distinto, asi que mostrar solo el mensaje base
           del lote seria mostrar algo que nadie leyo. Si la fila no tiene
           texto propio (difusiones viejas), queda en null y la pantalla usa
           el del lote. */
        message: r.message || null,
      }));

      return json({
        ok: true,
        batch: {
          id: batch.id,
          created_at: batch.created_at,
          created_by: batch.created_by || null,
          message: batch.message || '',
          origin_kind: o.kind,
          rule_code: o.rule,
          origin_label: o.label,
          total: batch.total || 0,
          with_phone: batch.with_phone || 0,
          /* v6.189: el adjunto, con URL firmada de una hora. Se firma aca y
             no en la lista porque el detalle se abre de a uno. */
          media: batch.media_path
            ? {
              name: batch.media_name || 'archivo',
              mime: batch.media_mime || null,
              mode: batch.media_mode || null,
              es_imagen: batch.media_mime !== 'application/pdf',
              url: await mediaSignedUrl(env, batch.media_path),
            }
            : null,
        },
        detail,
      });
    }

    return json({ ok: false, error: 'Acción no reconocida.' }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
}
