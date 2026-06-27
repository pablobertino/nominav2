/* =====================================================================
   functions/api/notifications.js  →  POST /api/notifications
   Novedades del catálogo de empresas (campanita). Para administradores
   activos (cualquier rol). Acciones (POST {action, adminId}):
     - get:  devuelve las últimas novedades + cuántas sin leer para ese admin.
     - seen: marca todas como leídas para ese admin (último id visto).

   Los eventos los genera /api/sync-companies en cada sincronización
   (empresa nueva / cambio de estatus) y viven en nomina_v2.company_change.
   El "leído" es por administrador (nomina_v2.notif_state).

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

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

async function isActiveAdmin(env, adminId) {
  if (!adminId) return false;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id`);
  return r && r.length > 0;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action, adminId } = body;

  try {
    if (!(await isActiveAdmin(env, adminId))) return json({ ok: false, error: 'No autorizado.' }, 403);

    if (action === 'get') {
      const stateRows = await sb(env, `notif_state?admin_id=eq.${encodeURIComponent(adminId)}&select=last_seen_change_id`);
      const lastSeen = (stateRows && stateRows[0] && stateRows[0].last_seen_change_id) || 0;
      const items = await sb(env,
        'company_change?select=id,company_code,business_name,change_type,old_value,new_value,detected_at&order=id.desc&limit=30') || [];
      const unreadRows = await sb(env, `company_change?id=gt.${lastSeen}&select=id&limit=500`) || [];
      return json({ ok: true, unread: unreadRows.length, items, last_seen: lastSeen });
    }

    if (action === 'seen') {
      const maxRows = await sb(env, 'company_change?select=id&order=id.desc&limit=1');
      const maxId = (maxRows && maxRows[0] && maxRows[0].id) || 0;
      await sb(env, 'notif_state', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ admin_id: adminId, last_seen_change_id: maxId, updated_at: new Date().toISOString() }),
      });
      return json({ ok: true, last_seen: maxId });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
