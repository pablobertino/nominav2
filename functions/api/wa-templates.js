/* =====================================================================
   functions/api/wa-templates.js  →  POST /api/wa-templates
   Catalogo de MENSAJES predeterminados de WhatsApp (vista WhatsApp >
   Mensajes, mockup _PRUEBAS/wa_mensajes_mockup.html v0-mock3).

   Fuente de verdad: nomina_v2.message_templates.

   Acciones (POST { action, user, ... }):
     list    {}                     -> plantillas + catalogo de comodines +
               catalogos de alcance (zonas/subzonas/conceptos/tipos/empresas)
               + fechas del ciclo vigente.  gate: view.wa.templates
     save    { code, label, body, [channel, scope_filters] }
               gate: wa.templates
     create  { label, body, channel, scope_filters } -> mensaje PUNTUAL nuevo
               gate: wa.templates
     delete  { code }               -> borra un puntual (los de sistema no)
               gate: wa.templates
     toggle  { code, is_active }    -> activa/desactiva (no las de sistema)
               gate: wa.templates
     preview { code, body, sample, [nature] } -> render con datos de ejemplo.
               NUNCA usa claves reales: las de ejemplo son fijas.
               gate: view.wa.templates
     preview_scope { scope } -> cuantas personas caen en el alcance y cuantas
               tienen telefono (el numero que importa).  gate: view.wa.templates

   NATURALEZA (columna nature). Define la conducta del mensaje:
     credencial -> los 2 de siempre. Los dispara Equipo, llevan clave, no
                   tienen alcance (el destinatario es el miembro). is_system.
     puntual    -> [FASE 1] envio manual con alcance sobre el roster.
     ciclo      -> [FASE 2] automatico por hito de nomina.
     cumpleanos -> [FASE 2] automatico el dia del cumple.

   ALCANCE (scope_filters jsonb): las MISMAS 6 claves que toma wa_recipients
   (zone, subzone, type, concept, company, id_number). No se inventa un
   vocabulario nuevo: es el de Difusion, y el RPC ya resuelve el roster real
   (store_workers + enterprise_workers vigentes) con su telefono efectivo.

   COMODINES  (sintaxis #Nombre, la MISMA de las plantillas de Avisos):
     Credenciales: #Nombre #Usuario #Rol #Correo #LinkPortal #Clave
                   #LinkOsticket #UsuarioOsticket #ClaveOsticket
     Puntuales:    #Nombre #Empresa #Periodo #Fecha_Cierre #Limite_Reportes
                   #Fecha_Calculo #Fecha_Pago #Fecha_Reclamos
   Las fechas del ciclo salen de payroll_periods, que el sistema YA calcula:
   nadie las tipea, y el mensaje sigue siendo cierto la quincena siguiente.
   Bloque condicional:
     #SiOsticket ... #FinSiOsticket   -> solo si el rol del miembro tiene
     osTicket (osticket_kind != 'none'). Para los demas desaparece. Asi un
     solo mensaje sirve para TODOS los roles: sin esto haria falta una
     plantilla por combinacion, y habria que mantenerlas sincronizadas.

   LAS CLAVES NO SE GUARDAN. El render de envio (renderTemplate, que usa
   admin-users.js) recibe la clave recien generada, la mete en el texto y
   la olvida. En wa_queue/wa_batches el mensaje queda ENMASCARADO.

   Secrets: supabase_url, supabase_service_role, portal_base_url
   ===================================================================== */

import { resolveActor, can, isSuperadmin } from './_auth.js';

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

/* ---------- catalogo de comodines (lo consume el editor) ---------- */
export const VARS = {
  cred_portal: [
    { v: '#Nombre',     d: 'Nombre completo' },
    { v: '#Usuario',    d: 'Usuario del portal' },
    { v: '#Rol',        d: 'Nombre del rol' },
    { v: '#Correo',     d: 'Correo' },
    { v: '#LinkPortal', d: 'Direccion del portal' },
    { v: '#Clave',      d: 'Clave del portal', secret: true },
  ],
  cred_osticket: [
    { v: '#Nombre',           d: 'Nombre completo' },
    { v: '#Rol',              d: 'Nombre del rol' },
    { v: '#LinkOsticket',     d: 'Direccion de osTicket' },
    { v: '#UsuarioOsticket',  d: 'Usuario de osTicket' },
    { v: '#ClaveOsticket',    d: 'Clave de osTicket', secret: true },
  ],
  /* v6.56 SOLO GRUPOS: los mensajes a grupos son UN SOLO texto para todo el
     grupo (no se personaliza por persona), asi que NO hay #Nombre ni #Empresa.
     Solo quedan las fechas del ciclo de nomina vigente, que son globales y
     el sistema ya calcula (nadie las carga, y siguen siendo ciertas la
     quincena siguiente). */
  puntual: [
    { v: '#Periodo',         d: 'Periodo vigente (ej. 2026-07-Q1)' },
    { v: '#Fecha_Cierre',    d: 'Cierre de la quincena' },
    { v: '#Limite_Reportes', d: 'Limite para cargar reportes' },
    { v: '#Fecha_Calculo',   d: 'Dia del calculo' },
    { v: '#Fecha_Pago',      d: 'Dia del pago' },
    { v: '#Fecha_Reclamos',  d: 'Limite de reclamos' },
  ],
};
const SECRET_VARS = ['#Clave', '#ClaveOsticket'];

/* La URL del portal viene del secret portal_base_url de Cloudflare. Se
   normaliza porque puede estar cargada con o sin esquema y con o sin barra
   final ("nominav2.pages.dev", "https://nominav2.pages.dev/"): si el link
   sale mal, le llega roto a la persona. */
export function portalUrl(env) {
  const raw = String(env.portal_base_url || '').trim();
  if (!raw) return '';
  const noSlash = raw.replace(/\/+$/, '');
  return /^https?:\/\//i.test(noSlash) ? noSlash : `https://${noSlash}`;
}

async function getSetting(env, key, fallback) {
  const r = await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  return (r && r[0] && r[0].value != null) ? r[0].value : fallback;
}

/* ================== MOTOR DE PLANTILLAS ==================
   Se exporta para que admin-users.js arme el mensaje al enviar.

   ctx = { nombre, usuario, rol, correo, clave, osticket_usuario,
           osticket_clave, tiene_osticket, link_portal, link_osticket }

   Reglas duras:
   - Los comodines de CLAVE solo se resuelven si allowSecret. Si no, se
     borran del texto (no se deja "#Clave" crudo, que seria peor: parece un
     error y encima delata que ahi iba una clave).
   - Se reemplaza de MAS LARGO a MAS CORTO. Si no, "#Clave" se come el
     prefijo de "#ClaveOsticket" y queda "Tmp-a7k2Osticket". */
export function renderTemplate(body, ctx, allowSecret) {
  let out = String(body || '');

  // 1) Bloque condicional de osTicket.
  out = out.replace(/#SiOsticket\r?\n?([\s\S]*?)#FinSiOsticket\r?\n?/g,
    (_, inner) => (ctx.tiene_osticket ? inner : ''));

  // 2) Comodines.
  const map = {
    '#Nombre': ctx.nombre || '',
    '#Usuario': ctx.usuario || '',
    '#Rol': ctx.rol || '',
    '#Correo': ctx.correo || '',
    '#LinkPortal': ctx.link_portal || '',
    '#LinkOsticket': ctx.link_osticket || '',
    '#UsuarioOsticket': ctx.osticket_usuario || '',
    '#Clave': allowSecret ? (ctx.clave || '') : '',
    '#ClaveOsticket': allowSecret ? (ctx.osticket_clave || '') : '',
    // FASE 1: mensajes puntuales (persona del roster + fechas del ciclo).
    // Ausentes = cadena vacia, igual que el resto: un mensaje de credenciales
    // que no usa #Periodo no se entera de que existe.
    '#Empresa': ctx.empresa || '',
    '#Periodo': ctx.periodo || '',
    '#Fecha_Cierre': ctx.fecha_cierre || '',
    '#Limite_Reportes': ctx.limite_reportes || '',
    '#Fecha_Calculo': ctx.fecha_calculo || '',
    '#Fecha_Pago': ctx.fecha_pago || '',
    '#Fecha_Reclamos': ctx.fecha_reclamos || '',
  };
  Object.keys(map)
    .sort((a, b) => b.length - a.length)   // largos primero (#ClaveOsticket antes que #Clave)
    .forEach(k => { out = out.split(k).join(map[k]); });

  // 3) Limpieza: el condicional y los comodines vacios dejan lineas sueltas.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/* Version ENMASCARADA para el historial (wa_batches / wa_queue). Las claves
   no se persisten en ningun lado: si manana alguien lee la tabla de envios,
   no encuentra credenciales. */
export function maskSecrets(text, ctx) {
  let out = String(text || '');
  [ctx.clave, ctx.osticket_clave].filter(Boolean).forEach(v => {
    out = out.split(v).join('••••••••');
  });
  return out;
}

/* Contexto de envio para un miembro del equipo. Lo usa admin-users.js. */
export async function buildCtx(env, member, extra = {}) {
  const [ostUrl, roles] = await Promise.all([
    getSetting(env, 'osticket_url', ''),
    sb(env, 'roles?select=code,label,osticket_kind'),
  ]);
  const role = (roles || []).find(r => r.code === member.role) || {};
  const kind = role.osticket_kind || 'none';
  return {
    nombre: member.name || member.username || '',
    usuario: member.username || '',
    rol: role.label || member.role || '',
    correo: member.email || '',
    link_portal: portalUrl(env),
    link_osticket: String(ostUrl || '').replace(/\/+$/, ''),
    tiene_osticket: kind !== 'none',
    osticket_usuario: extra.osticket_usuario || member.username || '',
    clave: extra.clave || '',
    osticket_clave: extra.osticket_clave || '',
  };
}

/* ---------- datos de ejemplo del editor (nunca claves reales) ---------- */
const SAMPLES = {
  agent:  { nombre: 'Wendy Moreno', usuario: 'wendy.moreno', rol: 'Administrador',
            correo: 'wendy.moreno@grupocanaima.net', tiene_osticket: true,
            osticket_usuario: 'wendy.moreno' },
  client: { nombre: 'Yanmira Salazar', usuario: 'yanmira.salazar', rol: 'Gestor de empresa',
            correo: 'yanmira.salazar@grupocanaima.net', tiene_osticket: true,
            osticket_usuario: 'yanmira.salazar' },
  none:   { nombre: 'Agustin Hernandez', usuario: 'agustin.hernandez', rol: 'Supervisor Tiendas',
            correo: 'agustin.hernandez@grupocanaima.net', tiene_osticket: false,
            osticket_usuario: '' },
};

/* ============ FASE 1: fechas del CICLO DE NOMINA ============
   Las 5 fechas clave salen de payroll_periods y el sistema YA las calcula
   (estan cargadas hasta octubre y mas alla). Nadie las tipea: por eso un
   mensaje que dice "el cierre es el #Fecha_Cierre" sigue siendo cierto la
   quincena que viene sin tocar nada.

   Periodo VIGENTE = el que contiene hoy (range_start <= hoy <= range_end).
   Si no hay (hueco en el calendario), se toma el proximo que arranque: es
   preferible a mandar un mensaje con las fechas en blanco. */
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
                'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function fmtDate(d) {
  if (!d) return '';
  const s = String(d).slice(0, 10).split('-');   // 'YYYY-MM-DD'
  if (s.length !== 3) return '';
  const day = Number(s[2]), mon = Number(s[1]);
  if (!day || !mon) return '';
  return `${day} de ${MONTHS[mon - 1]}`;         // "15 de julio"
}
function fmtDateTime(ts) {
  if (!ts) return '';
  const base = fmtDate(String(ts).slice(0, 10));
  const hh = String(ts).slice(11, 16);           // 'HH:MM'
  return hh && hh !== '00:00' ? `${base} a las ${hh}` : base;
}

async function cycleCtx(env) {
  // Caracas: la fecha "de hoy" se toma en la zona del negocio, no en UTC. Si
  // no, entre las 20:00 y medianoche el portal ya estaria en el dia siguiente
  // y podria saltar de periodo antes de tiempo.
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Caracas' });
  const sel = 'period_no,name,range_start,range_end,cutoff_date,report_deadline,milestone_date,pay_date,claim_deadline';

  let p = await sb(env,
    `payroll_periods?range_start=lte.${hoy}&range_end=gte.${hoy}&select=${sel}&limit=1`);
  if (!p || !p.length) {
    p = await sb(env,
      `payroll_periods?range_start=gte.${hoy}&select=${sel}&order=range_start.asc&limit=1`);
  }
  const r = (p && p[0]) || {};
  return {
    periodo: r.name || '',
    fecha_cierre: fmtDate(r.cutoff_date),
    limite_reportes: fmtDateTime(r.report_deadline),
    fecha_calculo: fmtDate(r.milestone_date),
    fecha_pago: fmtDate(r.pay_date),
    fecha_reclamos: fmtDate(r.claim_deadline),
  };
}

/* v6.56 SOLO GRUPOS: grupos ELEGIBLES para el actor. Misma regla de alcance
   que Difusion (wa-groups list): el superadmin ve todos los grupos
   habilitados; un admin no-super ve SOLO los que tiene asignados en
   wa_group_admins (y habilitados). Devuelve [{id, chat_id, wa_name, alias}].
   No se inventa vocabulario: es el mismo modelo de la pantalla Grupos. */
async function groupsForActor(env, actor, user) {
  if (isSuperadmin(actor)) {
    return await sb(env,
      'wa_groups?enabled=eq.true&select=id,chat_id,wa_name,alias,participants&order=wa_name.asc') || [];
  }
  const adminId = Number(user && user.id) || 0;
  if (!adminId) return [];
  const links = await sb(env, `wa_group_admins?admin_id=eq.${adminId}&select=group_id`);
  const ids = (links || []).map(l => l.group_id);
  if (!ids.length) return [];
  return await sb(env,
    `wa_groups?id=in.(${ids.join(',')})&enabled=eq.true&select=id,chat_id,wa_name,alias,participants&order=wa_name.asc`) || [];
}

/* v6.56: sanea y ACOTA los group_ids que llegan del cliente a los que el
   actor tiene permitido (evita que alguien mande a un grupo que no es suyo
   inyectando ids). Devuelve un arreglo de enteros unicos, ya filtrado. */
function pickGroupIds(raw, allowedIds) {
  const set = new Set((allowedIds || []).map(Number));
  const out = [];
  for (const g of (Array.isArray(raw) ? raw : [])) {
    const n = Number(g);
    if (Number.isInteger(n) && set.has(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/* Los 6 filtros de alcance. MISMO vocabulario que wa_recipients y que
   Difusion: no se inventa uno nuevo. '' / undefined = sin acotar. */
function pickScope(o) {
  const nn = v => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
  return {
    zone: nn(o.zone), subzone: nn(o.subzone), type: nn(o.type),
    concept: nn(o.concept), company: nn(o.company), id_number: nn(o.id_number),
  };
}

/* FASE 2: el disparo. Se sanea aca y la BD ademas lo valida con CHECKs (una
   regla 'cycle' sin hito, o 'date' sin fecha, no se puede guardar).
   Devuelve null si el vocabulario es invalido -> el handler responde 400. */
const CYCLE_FIELDS = ['cutoff_date', 'report_deadline', 'milestone_date', 'pay_date', 'claim_deadline'];
// v6.56 SOLO GRUPOS: se quito 'birthday'. Un grupo no cumple anios; los
// mensajes van a grupos, no a personas. Los tipos vivos son: manual (a mano/
// inmediato), cycle (por hito de nomina), date (fecha fija), every (cada tanto).
const TRIGGERS = ['manual', 'cycle', 'date', 'every'];

function pickTrigger(o) {
  const kind = String(o.trigger_kind || 'manual');
  if (!TRIGGERS.includes(kind)) return null;

  const t = {
    trigger_kind: kind,
    cycle_field: null, cycle_offset: 0,
    trigger_date: null, trigger_every_days: null,
    trigger_hour: Math.max(0, Math.min(23, Number(o.trigger_hour) || 8)),
  };

  if (kind === 'cycle') {
    const f = String(o.cycle_field || '');
    if (!CYCLE_FIELDS.includes(f)) return null;
    t.cycle_field = f;
    // Rango sano: mas de una quincena de anticipacion no tiene sentido (la
    // fecha objetivo caeria en el periodo anterior).
    t.cycle_offset = Math.max(-10, Math.min(10, Number(o.cycle_offset) || 0));
  } else if (kind === 'date') {
    const d = String(o.trigger_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    t.trigger_date = d;
  } else if (kind === 'every') {
    const n = Number(o.trigger_every_days) || 0;
    if (n < 1 || n > 365) return null;
    t.trigger_every_days = n;
  }
  return t;
}

/* Resuelve el alcance -> destinatarios reales, via el RPC que ya usa Difusion. */
async function resolveScope(env, scope, limit = 100) {
  const s = pickScope(scope || {});
  const res = await fetch(`${env.supabase_url}/rest/v1/rpc/wa_recipients`, {
    method: 'POST',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2', 'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_zone: s.zone, p_subzone: s.subzone, p_type: s.type,
      p_concept: s.concept, p_company: s.company, p_id_number: s.id_number,
      p_limit: limit,
    }),
  });
  if (!res.ok) throw new Error(`wa_recipients ${res.status}: ${await res.text()}`);
  return await res.json();   // { total, with_phone, without_phone, rows[] }
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const action = body.action;

  try {
    const actor = await resolveActor(env, body.user);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);

    if (!can(actor, 'view.wa.templates')) {
      return json({ ok: false, error: 'No tienes permiso para ver los mensajes.' }, 403);
    }

    /* ---------- listar ---------- */
    if (action === 'list') {
      const rows = await sb(env,
        'message_templates?select=code,label,description,body,scope,allows_secret,is_system,is_active,sort_order,updated_at,updated_by,nature,channel,scope_filters,group_ids,trigger_kind,cycle_field,cycle_offset,trigger_date,trigger_every_days,trigger_hour,retry_minutes,last_fire_on,last_status,last_error,last_sent&order=sort_order.asc,code.asc');
      const links = {
        portal: portalUrl(env),
        osticket: String(await getSetting(env, 'osticket_url', '') || '').replace(/\/+$/, ''),
      };
      // FASE 1: catalogos para el selector de alcance (los mismos de Difusion)
      // y las fechas del ciclo vigente (para el preview del editor).
      // v6.56: ademas, los GRUPOS elegibles del actor (destino real de los
      // mensajes). Los catalogos de personas se conservan por si alguna
      // plantilla vieja los usara, pero el editor nuevo ya no los muestra.
      const [zones, subzones, concepts, companies, cycle, groups] = await Promise.all([
        sb(env, 'zones?select=id,name&order=name.asc'),
        sb(env, 'subzones?select=id,name,zone_id&order=name.asc'),
        sb(env, 'concepts?select=id,name&order=name.asc'),
        sb(env, 'companies?is_active=eq.true&select=company_code,business_name,company_type&order=company_code.asc'),
        cycleCtx(env),
        groupsForActor(env, actor, body.user),
      ]);
      return json({
        ok: true,
        rows: rows || [],
        vars: VARS,
        links,
        cycle,
        groups: groups || [],
        groups_mode: isSuperadmin(actor) ? 'super' : 'admin',
        catalogs: {
          zones: zones || [], subzones: subzones || [], concepts: concepts || [],
          companies: companies || [],
          types: [...new Set((companies || []).map(c => c.company_type).filter(Boolean))].sort(),
        },
        can_edit: can(actor, 'wa.templates'),
        can_send: can(actor, 'wa.send'),
        // Si el secret no esta cargado, el link del portal saldria vacio en el
        // mensaje. Mejor avisarlo en la vista que mandar un texto cojo.
        warn: links.portal ? null : 'Falta configurar la direccion del portal (secret portal_base_url en Cloudflare): el comodin #LinkPortal va a salir vacio.',
      });
    }

    /* ---------- FASE 1: preview del ALCANCE (contador en vivo) ----------
       Devuelve cuantos caen en el alcance y, sobre todo, CUANTOS TIENEN
       TELEFONO. Es el numero que importa: hoy solo 233 de 2.676 personas
       activas lo tienen cargado. Sin este dato a la vista, uno cree que le
       llego a todos y en realidad le llego al 9%. */
    if (action === 'preview_scope') {
      const r = await resolveScope(env, body.scope || {}, 12);
      return json({
        ok: true,
        total: r.total || 0,
        with_phone: r.with_phone || 0,
        without_phone: r.without_phone || 0,
        sample: (r.rows || []).slice(0, 12),
      });
    }

    /* ---------- FASE 2: previsión de disparos ----------
       Cuando se elige "2 dias antes del limite de reportes", esto responde
       CUANDO saldria de verdad, quincena por quincena. Sin esto, el usuario
       elige un hito y un offset a ciegas. */
    if (action === 'preview_schedule') {
      const field = String(body.cycle_field || '').trim();
      const off = Number(body.cycle_offset || 0);
      const OK = ['cutoff_date', 'report_deadline', 'milestone_date', 'pay_date', 'claim_deadline'];
      if (!OK.includes(field)) return json({ ok: false, error: 'Hito invalido.' }, 400);

      const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Caracas' });
      const rows = await sb(env,
        `payroll_periods?range_end=gte.${hoy}&select=period_no,name,${field}`
        + `&order=range_start.asc&limit=4`) || [];

      const out = rows.map(p => {
        const raw = p[field];
        if (!raw) return null;
        // report_deadline es timestamptz; el resto son date.
        const base = String(raw).slice(0, 10);
        const d = new Date(base + 'T12:00:00Z');   // mediodia: evita cruces de huso
        d.setUTCDate(d.getUTCDate() + off);
        const fireOn = d.toISOString().slice(0, 10);
        return {
          period: p.name,
          target: base,
          target_txt: fmtDate(base),
          fire_on: fireOn,
          fire_txt: fmtDate(fireOn),
          past: fireOn < hoy,
        };
      }).filter(Boolean);

      return json({ ok: true, today: hoy, rows: out });
    }

    /* ---------- FASE 2: correr una regla AHORA (probarla) ----------
       Delega en /api/messages-run, el mismo endpoint que golpea el cron. No
       se duplica la logica de envio: probar es correr de verdad. */
    if (action === 'run_now') {
      if (!can(actor, 'wa.send')) {
        return json({ ok: false, error: 'No tienes permiso para enviar mensajes.' }, 403);
      }
      const rc = String(body.code || '').trim();
      if (!rc) return json({ ok: false, error: 'Falta el mensaje.' }, 400);
      const base = portalUrl(env) || 'https://nominav2.pages.dev';
      const res = await fetch(`${base}/api/messages-run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'manual', user: body.user, code: rc }),
      });
      return json(await res.json(), res.status);
    }

    /* ---------- preview del editor ---------- */
    if (action === 'preview') {
      // v6.56 SOLO GRUPOS: los mensajes a grupos son un texto UNICO para todo
      // el grupo. El preview muestra ese texto con las fechas REALES del
      // periodo vigente (no inventadas). Sin #Nombre/#Empresa: no existen.
      if (body.nature === 'puntual' || body.nature === 'ciclo') {
        const cyc = await cycleCtx(env);
        return json({ ok: true, text: renderTemplate(body.body || '', { ...cyc }, false) });
      }
      const sample = SAMPLES[body.sample] || SAMPLES.agent;
      const ost = String(await getSetting(env, 'osticket_url', '') || '').replace(/\/+$/, '');
      const ctx = {
        ...sample,
        link_portal: portalUrl(env),
        link_osticket: ost,
        clave: 'Tmp-a7k2-9xz1',        // ejemplo fijo, no es de nadie
        osticket_clave: 'Gc-2026-Tk',
      };
      return json({ ok: true, text: renderTemplate(body.body || '', ctx, true) });
    }

    /* ---------- guardar / activar ---------- */
    if (!can(actor, 'wa.templates')) {
      return json({ ok: false, error: 'No tienes permiso para editar los mensajes.' }, 403);
    }

    if (action === 'save') {
      const code = String(body.code || '').trim();
      const label = String(body.label || '').trim();
      const text = String(body.body || '');
      if (!code) return json({ ok: false, error: 'Falta el mensaje.' }, 400);
      if (!label) return json({ ok: false, error: 'El mensaje necesita un nombre.' }, 400);
      if (!text.trim()) return json({ ok: false, error: 'El mensaje no puede quedar vacio.' }, 400);

      const cur = await sb(env, `message_templates?code=eq.${encodeURIComponent(code)}&select=code,allows_secret,nature,is_system`);
      if (!cur || !cur.length) return json({ ok: false, error: 'Ese mensaje no existe.' }, 404);

      // Guardia: no se puede meter un comodin de clave en una plantilla que no
      // esta habilitada para claves. Es el gate que decide si #Clave se resuelve.
      if (!cur[0].allows_secret) {
        const used = SECRET_VARS.filter(v => text.includes(v));
        if (used.length) {
          return json({ ok: false, error:
            `Este mensaje no puede llevar claves (${used.join(', ')}). Se enviaria con ese dato en blanco.` }, 400);
        }
      }

      const patch = {
        label, body: text,
        updated_at: new Date().toISOString(),
        updated_by: actor.username || actor.name || String(actor.id || ''),
      };
      /* FASE 1: alcance y canal solo se tocan en los mensajes NO de sistema.
         Los de credenciales no tienen alcance (su destinatario es el miembro
         al que se le crea el acceso) y su canal es fijo: dejarlos editables
         seria ofrecer una perilla que no hace nada. */
      if (!cur[0].is_system) {
        if (body.scope_filters !== undefined) patch.scope_filters = pickScope(body.scope_filters || {});
        // v6.56 SOLO GRUPOS: el destino real son los grupos. Se acotan a los
        // que el actor tiene permitidos (no se confia en el cliente).
        if (body.group_ids !== undefined) {
          const allowed = await groupsForActor(env, actor, body.user);
          const gids = pickGroupIds(body.group_ids, allowed.map(g => g.id));
          if (!gids.length) {
            return json({ ok: false, error: 'Elige al menos un grupo de destino.' }, 400);
          }
          patch.group_ids = gids;
        }
        if (body.channel !== undefined) {
          const ch = String(body.channel || 'wa');
          if (!['wa', 'portal', 'wa+portal'].includes(ch)) {
            return json({ ok: false, error: 'Canal invalido.' }, 400);
          }
          patch.channel = ch;
        }
        // FASE 2: el disparo. Cambiar la programacion RESETEA los antifuegos
        // (last_fire_on / last_period): si no, una regla que ya disparo hoy
        // con la config vieja no volveria a correr con la nueva, y el usuario
        // no entenderia por que su cambio "no hace nada".
        if (body.trigger_kind !== undefined) {
          const trg = pickTrigger(body);
          if (!trg) return json({ ok: false, error: 'La programacion esta incompleta o es invalida.' }, 400);
          Object.assign(patch, trg, { last_fire_on: null, last_period: null });
          // v6.56: la naturaleza se deduce del disparo. Ya no hay cumpleanos:
          // ciclo si es por hito de nomina, puntual en cualquier otro caso.
          patch.nature = trg.trigger_kind === 'cycle' ? 'ciclo' : 'puntual';
        }
      }

      await sb(env, `message_templates?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      return json({ ok: true });
    }

    /* ---------- FASE 1: crear un mensaje PUNTUAL (con alcance) ---------- */
    if (action === 'create') {
      const label = String(body.label || '').trim();
      const text = String(body.body || '');
      if (label.length < 2) return json({ ok: false, error: 'El mensaje necesita un nombre.' }, 400);
      if (!text.trim()) return json({ ok: false, error: 'El mensaje no puede quedar vacio.' }, 400);

      const ch = String(body.channel || 'wa');
      if (!['wa', 'portal', 'wa+portal'].includes(ch)) {
        return json({ ok: false, error: 'Canal invalido.' }, 400);
      }
      // v6.56 SOLO GRUPOS: hay que elegir al menos un grupo de destino, y se
      // acota a los que el actor tiene permitidos. Si el mensaje SOLO va al
      // portal (channel 'portal'), no exige grupos.
      const allowedG = await groupsForActor(env, actor, body.user);
      const gids = pickGroupIds(body.group_ids, allowedG.map(g => g.id));
      if (ch !== 'portal' && !gids.length) {
        return json({ ok: false, error: 'Elige al menos un grupo de destino.' }, 400);
      }
      // Un mensaje a grupos JAMAS lleva claves (el destino es un grupo, no un
      // miembro con usuario del portal). allows_secret queda en false y aca se
      // rechaza el comodin, para que no se guarde un texto que al enviarse
      // saldria con un hueco.
      const used = SECRET_VARS.filter(v => text.includes(v));
      if (used.length) {
        return json({ ok: false, error:
          `Un mensaje a grupos no puede llevar claves (${used.join(', ')}): se enviaria con ese dato en blanco.` }, 400);
      }

      // code autogenerado desde el nombre (unico, estable, legible en la BD).
      const slug = label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'mensaje';
      let code = slug;
      const dup = await sb(env, `message_templates?code=like.${encodeURIComponent(slug + '*')}&select=code`);
      if (dup && dup.length) code = `${slug}_${Date.now().toString(36).slice(-4)}`;

      const maxRows = await sb(env, 'message_templates?select=sort_order&order=sort_order.desc&limit=1');
      const nextSort = ((maxRows && maxRows[0] && maxRows[0].sort_order) || 0) + 10;

      // FASE 2: el disparo decide la naturaleza (y con eso, en que seccion de
      // la lista aparece). Una sola fuente de verdad. v6.56: sin cumpleanos.
      const trg = pickTrigger(body);
      if (!trg) return json({ ok: false, error: 'La programacion esta incompleta o es invalida.' }, 400);
      const nature = trg.trigger_kind === 'cycle' ? 'ciclo' : 'puntual';

      await sb(env, 'message_templates', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          code, label, body: text,
          nature, channel: ch,
          ...trg,
          group_ids: gids,
          scope_filters: {},
          scope: 'grupos', allows_secret: false,
          is_system: false, is_active: true, sort_order: nextSort,
          created_by: actor.username || actor.name || String(actor.id || ''),
          updated_at: new Date().toISOString(),
          updated_by: actor.username || actor.name || String(actor.id || ''),
        }),
      });
      return json({ ok: true, code });
    }

    if (action === 'toggle') {
      const code = String(body.code || '').trim();
      const cur = await sb(env, `message_templates?code=eq.${encodeURIComponent(code)}&select=code,is_system`);
      if (!cur || !cur.length) return json({ ok: false, error: 'Ese mensaje no existe.' }, 404);
      if (cur[0].is_system && !body.is_active) {
        return json({ ok: false, error: 'Este mensaje lo usa el portal (Equipo) y no se puede desactivar. Su texto si se puede editar.' }, 400);
      }
      await sb(env, `message_templates?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: !!body.is_active }),
      });
      return json({ ok: true });
    }

    /* ---------- FASE 1: borrar un mensaje puntual ----------
       Solo los NO de sistema. Los de credenciales los dispara Equipo desde el
       codigo: si se borraran, crear un usuario dejaria de avisarle su clave.
       Por eso no se pueden borrar ni desactivar (arriba), solo editar el texto. */
    if (action === 'delete') {
      const code = String(body.code || '').trim();
      const cur = await sb(env, `message_templates?code=eq.${encodeURIComponent(code)}&select=code,is_system,label`);
      if (!cur || !cur.length) return json({ ok: false, error: 'Ese mensaje no existe.' }, 404);
      if (cur[0].is_system) {
        return json({ ok: false, error: 'Este mensaje lo usa el portal y no se puede borrar. Su texto si se puede editar.' }, 400);
      }
      await sb(env, `message_templates?code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Accion no reconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: 'Error del servidor: ' + err.message }, 500);
  }
}

export async function onRequest({ request }) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Metodo no permitido.' }, 405);
}
