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

import { shadowCan } from './_auth.js';

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
    const legacyOk = await isSuperadmin(env, adminId);
    await shadowCan(env, adminId, 'sync-config', action || '?', 'config.sincronizacion', legacyOk);
    if (!legacyOk) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    if (action === 'get') {
      const cfgRows = await sb(env, 'sync_config?id=eq.1&select=*');
      const runs = await sb(env, 'sync_runs?select=*&order=started_at.desc&limit=8') || [];
      if (runs.length) {
        const ids = runs.map(r => r.id).join(',');
        // Cambios de cada corrida (para mostrar el detalle o "Sin cambios").
        const changes = await sb(env,
          `company_change?run_id=in.(${ids})&select=run_id,company_code,business_name,change_type,old_value,new_value&order=id.asc`) || [];
        const byRun = {};
        for (const c of changes) { (byRun[c.run_id] = byRun[c.run_id] || []).push(c); }
        // Nombre de quien disparo (corridas manuales).
        const adminIds = [...new Set(runs.map(r => r.triggered_by).filter(Boolean))];
        const names = {};
        if (adminIds.length) {
          const admins = await sb(env, `admin_users?id=in.(${adminIds.join(',')})&select=id,username`) || [];
          for (const a of admins) names[a.id] = a.username;
        }
        for (const r of runs) {
          r.changes = byRun[r.id] || [];
          r.triggered_by_name = r.triggered_by ? (names[r.triggered_by] || null) : null;
        }
      }
      return json({ ok: true, config: (cfgRows && cfgRows[0]) || null, runs });
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

      if (body.manual_cooldown_value !== undefined) {
        const v = parseInt(body.manual_cooldown_value, 10);
        if (isNaN(v) || v < 0 || v > 999) return json({ ok: false, error: 'Límite inválido (0 a 999).' }, 400);
        patch.manual_cooldown_value = v;
      }
      if (body.manual_cooldown_unit !== undefined) {
        if (!['minutes', 'hours', 'days'].includes(body.manual_cooldown_unit))
          return json({ ok: false, error: 'Unidad inválida.' }, 400);
        patch.manual_cooldown_unit = body.manual_cooldown_unit;
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
