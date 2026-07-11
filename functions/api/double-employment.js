/* =====================================================================
   functions/api/double-employment.js  →  POST /api/double-employment
   Doble empleo: personas ACTIVAS en dos o mas empresas al mismo tiempo.

   Una persona no puede estar activa en dos tiendas a la vez. Pasa cuando
   la ingresan en la tienda nueva pero nadie cierra su contrato en la
   anterior. Mientras siga asi, esa persona cuenta DOBLE en la nomina, en
   los reportes y en los envios.

   SOLO LECTURA. El portal NO corrige nada: la fuente de verdad es el
   sistema (AX). Si el portal "arreglara" el dato, la proxima
   sincronizacion lo reviviria igual. Se listan para que alguien vaya a
   cerrar el contrato donde corresponde; al hacerlo, el caso desaparece
   solo de esta lista.

   Acciones (POST { action, user }):
     count  {}   -> { n }            conteo para el badge del menu y el
                                     aviso de la pagina de inicio.
                                     gate: view.dobleempleo
     list   {}   -> { rows[] }       el detalle completo.
                                     gate: view.dobleempleo

   'count' es deliberadamente barato: lo llama el panel en cada carga para
   pintar el badge, asi que no trae filas, solo el numero.
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
const rpc = (env, fn, args) =>
  sb(env, `rpc/${fn}`, { method: 'POST', body: JSON.stringify(args || {}) });

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) {
    return json({ ok: false, error: 'Cuerpo inválido.' }, 400);
  }
  const action = body.action || 'count';

  try {
    const actor = await resolveActor(env, body.user);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);
    if (!can(actor, 'view.dobleempleo')) {
      return json({ ok: false, error: 'No tienes permiso para ver el doble empleo (view.dobleempleo).' }, 403);
    }

    if (action === 'count') {
      const r = await rpc(env, 'double_employment_count', {});
      return json({ ok: true, n: Number(r) || 0 });
    }

    if (action === 'list') {
      const rows = await rpc(env, 'double_employment_list', {});
      return json({ ok: true, rows: rows || [] });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (e) {
    if (e && e.name === 'AuthError') return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error interno: ' + (e && e.message ? e.message : e) }, 500);
  }
}
