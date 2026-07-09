/* =====================================================================
   functions/api/my-perms.js  →  POST /api/my-perms
   Consulta LIVIANA de permisos de la PROPIA sesion (v4.64).

   El menu del portal la usa para decidir que items del grupo
   Sincronizacion pintar segun la matriz de Roles (permisos view.*
   enforced). Solo revela informacion del propio actor: recibe una lista
   de codes y responde true/false por cada uno via can().

   POST { user, codes: ['view.axcompare', ...] }   (max 40 codes)
   ->   { ok, super: bool, perms: { code: bool, ... } }

   Sin gate adicional: cualquier sesion valida puede preguntar POR SI
   MISMA (no expone la matriz de otros roles).
   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { resolveActor, can } from './_auth.js';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  const actor = await resolveActor(env, body.user || null);
  if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);

  const codes = Array.isArray(body.codes) ? body.codes.slice(0, 40) : [];
  const perms = {};
  for (const c of codes) {
    const code = String(c || '').trim();
    if (!code || code.length > 60) continue;
    try { perms[code] = !!can(actor, code); } catch (_) { perms[code] = false; }
  }
  const isSuper = !!(actor && (actor.role === 'superadmin' || actor.isSuper));
  return json({ ok: true, super: isSuper, perms });
}
