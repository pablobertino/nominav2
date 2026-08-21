/* =====================================================================
   /api/ver-como — bitácora de "Ver como"                       (v6.256)

   Solo registra. La apertura de sesión ocurre en el navegador; acá queda el
   rastro de quién miró con los ojos de quién y cuándo.

   No es un control de acceso: el API acepta el objeto `user` sin token, así
   que esto no impide nada que no se pudiera hacer igual. Es lo que permite
   que la función no sea invisible, que es lo mínimo exigible para algo que
   deja ver la pantalla de otro.
   ===================================================================== */

import { resolveActor, can } from './_auth.js';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

async function sb(env, path, init = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Type': 'application/json',
      'Accept-Profile': 'nomina_v2',
      'Content-Profile': 'nomina_v2',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(await res.text());
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido.' }, 400); }

  const actor = await resolveActor(env, body.user);
  if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
  if (!can(actor, 'admin.vercomo')) {
    return json({ ok: false, error: 'No tienes permiso para ver el portal como otro usuario.' }, 403);
  }

  const action = String(body.action || '').trim();

  if (action === 'log') {
    try {
      await sb(env, 'ver_como_log', {
        method: 'POST',
        body: JSON.stringify({
          admin_id: (body.user && body.user.id) || null,
          admin_name: (body.user && (body.user.name || body.user.username)) || null,
          target_kind: String(body.target_kind || '').slice(0, 20),
          target_id: String(body.target_id || '').slice(0, 40),
          target_label: String(body.target_label || '').slice(0, 120),
        }),
      });
    } catch (_) {
      /* Que falle la bitacora no puede impedir el soporte. Se registra el
         fallo del lado del Worker y se sigue. */
      console.warn('[VER-COMO] no se pudo registrar la apertura');
    }
    return json({ ok: true });
  }

  if (action === 'list') {
    const rows = await sb(env,
      'ver_como_log?select=*&order=started_at.desc&limit=200');
    return json({ ok: true, rows: rows || [] });
  }

  return json({ ok: false, error: 'Accion no valida.' }, 400);
}
