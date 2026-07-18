/* =====================================================================
   functions/api/portal-params.js  →  /api/portal-params
   v6.25: Parámetros editables del portal (tabla nomina_v2.portal_params).
   Solo superadmin (gate real server-side, mismo patrón que config-catalogs).

   Acciones (POST {action, adminId, ...}):
     list               -> todos los parámetros (key, value, label, auditoría)
     save {key, value}  -> actualiza el valor con auditoría (updated_by/at)

   Reglas:
     - Los parámetros se CREAN por migración (INSERT), acá solo se editan:
       save rechaza claves inexistentes.
     - Claves *_dias: valor entero 0..365 (validación server-side).
     - Cualquier valor: máx 500 caracteres.
     - Primer parámetro: gap_continuidad_dias = 30 (antigüedad de Grupo,
       plan PLAN_ANTIGUEDAD_GRUPO_2026-07-18; lo lee get_group_tenure()).

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

import { shadowCan } from './_auth.js';

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

// Gate: devuelve el admin (id + username) solo si es superadmin activo.
async function superadminOf(env, adminId) {
  if (!adminId) return null;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&role=eq.superadmin&is_active=eq.true&select=id,username,full_name`);
  return (r && r[0]) || null;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const { action, adminId } = body;

  try {
    const admin = await superadminOf(env, adminId);
    await shadowCan(env, adminId, 'portal-params', action, 'config.parametros', !!admin);
    if (!admin) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    if (action === 'list') {
      const params = await sb(env, 'portal_params?select=key,value,label,updated_at,updated_by&order=key');
      return json({ ok: true, params: params || [] });
    }

    if (action === 'save') {
      const key = String(body.key || '').trim();
      const value = String(body.value ?? '').trim();
      if (!key) return json({ ok: false, error: 'Falta la clave.' }, 400);
      if (value.length > 500) return json({ ok: false, error: 'Valor demasiado largo (máx 500).' }, 400);
      // Claves de días: entero 0..365 (gap_continuidad_dias y futuras *_dias).
      if (/_dias$/.test(key)) {
        if (!/^\d{1,3}$/.test(value) || Number(value) > 365) {
          return json({ ok: false, error: 'Debe ser un número entero de días (0 a 365).' }, 400);
        }
      }
      const cur = await sb(env, `portal_params?key=eq.${encodeURIComponent(key)}&select=key`);
      if (!cur || !cur.length) return json({ ok: false, error: 'Parámetro inexistente (se crean por migración).' }, 404);
      const upd = await sb(env, `portal_params?key=eq.${encodeURIComponent(key)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          value,
          updated_at: new Date().toISOString(),
          updated_by: admin.full_name || admin.username || String(admin.id),
        }),
      });
      return json({ ok: true, param: (upd && upd[0]) || null });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
