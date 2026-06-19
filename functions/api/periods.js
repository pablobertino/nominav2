/* =====================================================================
   functions/api/periods.js  →  /api/periods
   Quincenas de nómina (tabla payroll_periods). Snapshot por año.
   Acciones (POST {action}):
     - list     : lista las quincenas de un año. Lectura para cualquier
                  sesión (superadmin, admin, tienda).
     - years    : devuelve los años que ya tienen quincenas generadas.
     - generate : (superadmin) genera las 24 quincenas de un año vía la
                  función generate_payroll_periods. No pisa overrides.
     - override : (superadmin) sobrescribe fechas y/o margen/hora de una
                  quincena puntual. Recalcula el deadline y marca
                  is_overridden=true.
     - reset    : (superadmin) revierte una quincena al valor calculado
                  por la regla (quita el override).

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

// RPC (funciones SQL) vía PostgREST
async function rpc(env, fn, args = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2', 'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Supabase RPC ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function isSuperadmin(env, adminId) {
  if (!adminId) return false;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&role=eq.superadmin&is_active=eq.true&select=id`);
  return r && r.length > 0;
}

// Recalcula el deadline (corte - margen) a la hora tope, en America/Caracas.
// Devuelve un ISO timestamptz. Se hace en JS para no depender de otra RPC.
function computeDeadline(cutoffDate, marginDays, limitTime) {
  // cutoffDate: 'YYYY-MM-DD'. limitTime: 'HH:MM'.
  const [y, m, d] = cutoffDate.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() - (marginDays || 0));
  const yy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(base.getUTCDate()).padStart(2, '0');
  const [hh, mi] = (limitTime || '14:00').split(':');
  // Caracas es GMT-4 fijo (sin DST). El instante UTC = local + 4h.
  const hUtc = String(Number(hh) + 4).padStart(2, '0');
  return `${yy}-${mm}-${dd}T${hUtc}:${mi}:00.000Z`;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action } = body;

  try {
    // ---- Lectura: abierta a cualquier sesión ----
    if (action === 'list') {
      const year = parseInt(body.year, 10) || new Date().getFullYear();
      const rows = await sb(env,
        `payroll_periods?year=eq.${year}&order=period_no&select=*`);
      return json({ ok: true, year, periods: rows || [] });
    }

    if (action === 'years') {
      const rows = await sb(env, 'payroll_periods?select=year&order=year');
      const years = [...new Set((rows || []).map(r => r.year))];
      return json({ ok: true, years });
    }

    // ---- Escritura: solo superadmin ----
    const { adminId } = body;
    if (!(await isSuperadmin(env, adminId))) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    if (action === 'generate') {
      const year = parseInt(body.year, 10);
      if (!year || year < 2024 || year > 2100) return json({ ok: false, error: 'Año inválido.' }, 400);
      const created = await rpc(env, 'generate_payroll_periods', { p_year: year, p_actor: String(adminId) });
      return json({ ok: true, year, created });
    }

    if (action === 'override') {
      const { id } = body;
      if (!id) return json({ ok: false, error: 'Falta la quincena.' }, 400);
      const cur = await sb(env, `payroll_periods?id=eq.${encodeURIComponent(id)}&select=*`);
      if (!cur || !cur.length) return json({ ok: false, error: 'Quincena no encontrada.' }, 404);
      const p = cur[0];

      const patch = {};
      const dateFields = ['range_start', 'range_end', 'cutoff_date', 'pay_date'];
      for (const f of dateFields) {
        if (body[f]) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(body[f])) return json({ ok: false, error: `Fecha inválida en ${f}.` }, 400);
          patch[f] = body[f];
        }
      }
      if (body.report_margin_days != null) {
        const md = parseInt(body.report_margin_days, 10);
        if (isNaN(md) || md < 0 || md > 31) return json({ ok: false, error: 'Margen inválido.' }, 400);
        patch.report_margin_days = md;
      }
      if (body.report_limit_time) {
        if (!/^\d{1,2}:\d{2}$/.test(body.report_limit_time)) return json({ ok: false, error: 'Hora inválida.' }, 400);
        const [h, mi] = body.report_limit_time.split(':');
        patch.report_limit_time = `${String(Number(h)).padStart(2, '0')}:${mi}`;
      }

      const cutoff = patch.cutoff_date || p.cutoff_date;
      const margin = patch.report_margin_days != null ? patch.report_margin_days : p.report_margin_days;
      const ltime  = patch.report_limit_time || p.report_limit_time;
      patch.report_deadline = computeDeadline(cutoff, margin, ltime);

      patch.is_overridden = true;
      patch.override_note = (body.override_note || '').trim() || null;
      patch.updated_at = new Date().toISOString();
      patch.updated_by = String(adminId);

      await sb(env, `payroll_periods?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      return json({ ok: true });
    }

    if (action === 'reset') {
      // Revierte una quincena: borra la fila y regenera solo ese año (no pisa
      // las demás por el ON CONFLICT DO NOTHING).
      const { id } = body;
      if (!id) return json({ ok: false, error: 'Falta la quincena.' }, 400);
      const cur = await sb(env, `payroll_periods?id=eq.${encodeURIComponent(id)}&select=year`);
      if (!cur || !cur.length) return json({ ok: false, error: 'Quincena no encontrada.' }, 404);
      const year = cur[0].year;
      await sb(env, `payroll_periods?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      await rpc(env, 'generate_payroll_periods', { p_year: year, p_actor: String(adminId) });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
