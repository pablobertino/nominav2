/* =====================================================================
   functions/api/wa-templates.js  →  POST /api/wa-templates
   Catalogo de MENSAJES predeterminados de WhatsApp (vista WhatsApp >
   Mensajes, mockup _PRUEBAS/wa_mensajes_mockup.html v0-mock3).

   Fuente de verdad: nomina_v2.message_templates.

   Acciones (POST { action, user, ... }):
     list    {}                     -> plantillas + catalogo de comodines
               gate: view.wa.templates
     save    { code, label, body }  -> guarda el texto de una plantilla
               gate: wa.templates
     toggle  { code, is_active }    -> activa/desactiva (no las de sistema)
               gate: wa.templates
     preview { code, body, sample } -> render con datos de ejemplo (para el
               editor). NUNCA usa claves reales: las de ejemplo son fijas.
               gate: view.wa.templates

   COMODINES  (sintaxis #Nombre, la MISMA de las plantillas de Avisos):
     #Nombre #Usuario #Rol #Correo #LinkPortal #Clave
     #LinkOsticket #UsuarioOsticket #ClaveOsticket
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

import { resolveActor, can } from './_auth.js';

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
        'message_templates?select=code,label,description,body,scope,allows_secret,is_system,is_active,sort_order,updated_at,updated_by&order=sort_order.asc,code.asc');
      const links = {
        portal: portalUrl(env),
        osticket: String(await getSetting(env, 'osticket_url', '') || '').replace(/\/+$/, ''),
      };
      return json({
        ok: true,
        rows: rows || [],
        vars: VARS,
        links,
        can_edit: can(actor, 'wa.templates'),
        // Si el secret no esta cargado, el link del portal saldria vacio en el
        // mensaje. Mejor avisarlo en la vista que mandar un texto cojo.
        warn: links.portal ? null : 'Falta configurar la direccion del portal (secret portal_base_url en Cloudflare): el comodin #LinkPortal va a salir vacio.',
      });
    }

    /* ---------- preview del editor ---------- */
    if (action === 'preview') {
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

      const cur = await sb(env, `message_templates?code=eq.${encodeURIComponent(code)}&select=code,allows_secret`);
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

      await sb(env, `message_templates?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          label, body: text,
          updated_at: new Date().toISOString(),
          updated_by: actor.username || actor.name || String(actor.id || ''),
        }),
      });
      return json({ ok: true });
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

    return json({ ok: false, error: 'Accion no reconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: 'Error del servidor: ' + err.message }, 500);
  }
}

export async function onRequest({ request }) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Metodo no permitido.' }, 405);
}
