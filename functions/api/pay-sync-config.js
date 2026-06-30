/* =====================================================================
   functions/api/pay-sync-config.js  →  POST /api/pay-sync-config
   Configuracion del cron de ESTADO DE PAGO del periodo (tabla aparte
   pay_sync_config). Solo superadmin. Acciones:
     - get: devuelve la config + ultimas corridas (pay_sync_run).
     - set: guarda enabled / calc_minutes / pay_minutes / daily_hour / endpoint_url.
     - run: dispara una sincronizacion manual (llama /api/sync-period-pay).

   Frecuencia variable por dia (la decide tick_sync_period_pay segun el
   calendario de quincenas): Dia de Calculo -> calc_minutes; Dia de Pago
   -> pay_minutes; resto -> 1 vez al dia a daily_hour.

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

async function isSuperadmin(env, adminId) {
  if (!adminId) return false;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&role=eq.superadmin&is_active=eq.true&select=id`);
  return r && r.length > 0;
}

function clampMin(v, def) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return null;
  return Math.max(1, Math.min(1440, n));   // 1 min .. 24 h
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const { action, adminId } = body;

  try {
    if (!(await isSuperadmin(env, adminId))) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    if (action === 'get') {
      const cfgRows = await sb(env, 'pay_sync_config?id=eq.1&select=*');
      const runs = await sb(env, 'pay_sync_run?select=*&order=started_at.desc&limit=8') || [];
      return json({ ok: true, config: (cfgRows && cfgRows[0]) || null, runs });
    }

    if (action === 'set') {
      const patch = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;

      if (body.calc_minutes !== undefined) {
        const v = clampMin(body.calc_minutes);
        if (v === null) return json({ ok: false, error: 'Minutos (Dia de Calculo) invalidos.' }, 400);
        patch.calc_minutes = v;
      }
      if (body.pay_minutes !== undefined) {
        const v = clampMin(body.pay_minutes);
        if (v === null) return json({ ok: false, error: 'Minutos (Dia de Pago) invalidos.' }, 400);
        patch.pay_minutes = v;
      }
      if (body.daily_hour !== undefined) {
        const h = parseInt(body.daily_hour, 10);
        if (isNaN(h) || h < 0 || h > 23) return json({ ok: false, error: 'Hora invalida (00 a 23).' }, 400);
        patch.daily_hour = h;
      }
      if (body.endpoint_url !== undefined) {
        const u = String(body.endpoint_url || '').trim();
        if (u !== '') {
          try {
            const url = new URL(u);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('proto');
          } catch { return json({ ok: false, error: 'URL invalida (usa https://...).' }, 400); }
        }
        patch.endpoint_url = u === '' ? null : u.replace(/\/+$/, '');
      }

      if (!Object.keys(patch).length) return json({ ok: false, error: 'Nada que guardar.' }, 400);
      patch.updated_at = new Date().toISOString();
      patch.updated_by = adminId;

      await sb(env, 'pay_sync_config?id=eq.1', {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return json({ ok: true });
    }

    if (action === 'run') {
      // Disparo manual: llamar al endpoint de trabajo en el mismo origen.
      const origin = new URL(request.url).origin;
      let r;
      try {
        r = await fetch(`${origin}/api/sync-period-pay`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'manual', adminId }),
        }).then(x => x.json());
      } catch (e) {
        return json({ ok: false, error: 'No se pudo ejecutar: ' + e.message }, 502);
      }
      return json(r);
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
