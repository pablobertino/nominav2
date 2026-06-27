/* =====================================================================
   functions/api/sync-config.js  →  POST /api/sync-config
   Configuración de la sincronización automática del catálogo de empresas
   (cron en Supabase). Solo superadmin. Acciones (POST {action}):
     - get: devuelve la config (sync_config) + las últimas corridas (sync_runs).
     - set: guarda enabled / frequency / daily_hour / endpoint_url.

   El cron (pg_cron) revisa cada ~15 min y, según la frecuencia guardada aquí,
   dispara /api/sync-companies (que es quien hace el trabajo y registra el
   resultado). Esta ruta NO ejecuta la sincronización; solo administra su
   programación y muestra el estado.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const FREQS = ['hourly', '6h', '12h', 'daily', '2d'];

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

async function isSuperadmin(env, adminId) {
  if (!adminId) return false;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&role=eq.superadmin&is_active=eq.true&select=id`);
  return r && r.length > 0;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action, adminId } = body;

  try {
    if (!(await isSuperadmin(env, adminId))) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    if (action === 'get') {
      const cfgRows = await sb(env, 'sync_config?id=eq.1&select=*');
      const runs = await sb(env, 'sync_runs?select=*&order=started_at.desc&limit=8');
      return json({ ok: true, config: (cfgRows && cfgRows[0]) || null, runs: runs || [] });
    }

    if (action === 'set') {
      const patch = {};

      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;

      if (body.frequency !== undefined) {
        if (!FREQS.includes(body.frequency)) return json({ ok: false, error: 'Frecuencia inválida.' }, 400);
        patch.frequency = body.frequency;
      }

      if (body.daily_hour !== undefined) {
        const h = parseInt(body.daily_hour, 10);
        if (isNaN(h) || h < 0 || h > 23) return json({ ok: false, error: 'Hora inválida (00 a 23).' }, 400);
        patch.daily_hour = h;
      }

      if (body.endpoint_url !== undefined) {
        const u = String(body.endpoint_url || '').trim();
        if (u !== '') {
          try {
            const url = new URL(u);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('proto');
          } catch { return json({ ok: false, error: 'URL inválida (usa https://…).' }, 400); }
        }
        patch.endpoint_url = u === '' ? null : u.replace(/\/+$/, '');
      }

      if (!Object.keys(patch).length) return json({ ok: false, error: 'Nada que guardar.' }, 400);

      patch.updated_at = new Date().toISOString();
      patch.updated_by = adminId;

      await sb(env, 'sync_config?id=eq.1', {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
