/* =====================================================================
   functions/api/wa-routing.js  →  POST /api/wa-routing   (v6.155)
   RUTEO DE LOS AVISOS DE NAIMA: que grupo de WhatsApp le toca a cada zona,
   y que avisos estan prendidos.

   El envio en si vive en _naima.js (lo dispara reports.js / cert-requests.js).
   Aca solo se LEE y se GUARDA la configuracion:
     - app_settings.wa_naima_reports_enabled : interruptor MAESTRO ('true'/'false')
     - app_settings.wa_naima_reports_types   : tipos prendidos, separados por comas
     - wa_zone_group                          : zona -> grupo (NULL = sin grupo)

   Acciones (POST { action, user, ... }):
     load {}                                   gate: view.wa.routing
       -> { zones[], groups[], routes{}, enabled, types[], catalog[] }
     save { routes[], enabled, types[] }       gate: view.wa.routing
       -> { ok, saved }

   v6.155: la pantalla se gobierna con SU permiso (view.wa.routing), no con
   el rol. Antes era view.whatsapp + un 'superonly' clavado en el menu de
   panel.js, que le ganaba a cualquier permiso concedido desde Roles. Ahora
   quien tenga el permiso ve y guarda; el superadmin lo tiene siempre porque
   can() le devuelve true a todo.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { resolveActor, can } from './_auth.js';
import { NAIMA_TYPES } from './_naima.js';

const SETTING_ENABLED = 'wa_naima_reports_enabled';
const SETTING_TYPES   = 'wa_naima_reports_types';
const DEFAULT_TYPES   = 'ingreso,egreso,constancia';

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

/* Una fila de app_settings que quiza no existe todavia: PATCH si esta, POST
   si no. No se usa upsert para no pisar label/kind/grupo de la fila. */
async function setSetting(env, key, value, meta) {
  const cur = await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}&select=key`);
  if (cur && cur.length) {
    await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ value: String(value), updated_at: new Date().toISOString() }),
    });
  } else {
    await sb(env, 'app_settings', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ key, value: String(value), ...(meta || {}) }),
    });
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Cuerpo inválido.' }, 400); }
  const action = body.action || 'load';

  try {
    const actor = await resolveActor(env, body.user);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);
    /* v6.155: permiso propio (antes: view.whatsapp + superonly clavado en el
       menu). can() ya devuelve true para superadmin. */
    if (!can(actor, 'view.wa.routing')) {
      return json({ ok: false, error: 'No tienes permiso para el ruteo de avisos (view.wa.routing).' }, 403);
    }
    /* ---------------- load ---------------- */
    if (action === 'load') {
      const [zones, groups, routes, settings, comps] = await Promise.all([
        sb(env, 'zones?select=id,name&order=name.asc'),
        sb(env, 'wa_groups?enabled=eq.true&select=id,chat_id,wa_name,alias&order=wa_name.asc'),
        sb(env, 'wa_zone_group?select=zone_id,wa_group_id,enabled'),
        sb(env, `app_settings?key=in.(${SETTING_ENABLED},${SETTING_TYPES})&select=key,value`),
        // Solo para el conteo "N tiendas" de cada fila; son ~200 filas.
        sb(env, 'companies?select=zone_id&limit=5000'),
      ]);

      const count = {};
      (comps || []).forEach(c => {
        if (c.zone_id) count[c.zone_id] = (count[c.zone_id] || 0) + 1;
      });

      const byKey = {};
      (settings || []).forEach(r => { byKey[r.key] = r.value; });

      const routeMap = {};
      (routes || []).forEach(r => {
        // enabled=false en la fila = ruteo apagado para esa zona: se muestra
        // como "sin asignar" (que es lo que hace, no mandar nada).
        routeMap[r.zone_id] = r.enabled === false ? null : (r.wa_group_id || null);
      });

      return json({
        ok: true,
        can_edit: true,   // llegar hasta aca ya implica el permiso de gestion
        enabled: String(byKey[SETTING_ENABLED] || 'false').toLowerCase() === 'true',
        types: String(byKey[SETTING_TYPES] == null ? DEFAULT_TYPES : byKey[SETTING_TYPES])
          .split(',').map(s => s.trim()).filter(Boolean),
        // El catalogo de tipos sale del backend para que la pantalla no tenga
        // que repetir la lista (una sola fuente de verdad: _naima.js).
        catalog: Object.entries(NAIMA_TYPES).map(([k, v]) => ({ kind: k, emoji: v.emoji, label: v.label })),
        zones: (zones || []).map(z => ({ id: z.id, name: z.name, stores: count[z.id] || 0 })),
        groups: (groups || []).map(g => ({ id: g.id, label: g.alias || g.wa_name || g.chat_id })),
        routes: routeMap,
      });
    }

    /* ---------------- save ---------------- */
    if (action === 'save') {
      const who = String(actor.actor || '');
      const now = new Date().toISOString();

      const routes = Array.isArray(body.routes) ? body.routes : [];
      if (routes.length) {
        const rows = routes.map(r => ({
          zone_id: String(r.zone_id || '').trim(),
          wa_group_id: r.wa_group_id ? Number(r.wa_group_id) : null,
          enabled: true,
          updated_at: now,
          updated_by: who,
        })).filter(r => r.zone_id);
        if (rows.length) {
          // Upsert por zone_id (PK): las zonas que nunca se tocaron nacen aca.
          await sb(env, 'wa_zone_group', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(rows),
          });
        }
      }

      if (typeof body.enabled === 'boolean') {
        await setSetting(env, SETTING_ENABLED, body.enabled ? 'true' : 'false', {
          label: 'Avisos de Naima en grupos (reportes)', kind: 'bool', grupo: 'WhatsApp',
        });
      }
      if (Array.isArray(body.types)) {
        const valid = body.types
          .map(t => String(t).trim().toLowerCase())
          .filter(t => Object.prototype.hasOwnProperty.call(NAIMA_TYPES, t));
        await setSetting(env, SETTING_TYPES, [...new Set(valid)].join(','), {
          label: 'Avisos de Naima: tipos activos', kind: 'text', grupo: 'WhatsApp',
          description: 'Tipos de aviso que Naima publica en los grupos, separados por comas.',
        });
      }

      return json({ ok: true, saved: routes.length });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (e) {
    if (e && e.name === 'AuthError') return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error del servidor: ' + (e && e.message ? e.message : e) }, 500);
  }
}
