/* =====================================================================
   functions/api/period-pay.js  →  POST /api/period-pay
   LECTURA del estado de pago del periodo desde la tabla cache
   nomina_v2.period_pay_status (la alimenta el cron sync-period-pay).
   NO llama al API de AX: lee de la tabla, que es lo eficiente y alimenta
   por igual a tienda, admin y superadmin.

   Dos acciones:
   - action 'card'  -> una empresa (alias). Para la tarjeta de la tienda.
                       Devuelve el registro de mayor index (0 si existe,
                       si no -1). usedFallback=true si solo hay anterior.
   - action 'grid'  -> todas las empresas del alcance del admin (una fila
                       por empresa, su index mas alto). superadmin = todas.

   El refresco de la tabla lo hace el cron (frecuencia variable por dia) o
   el boton manual de Sincronizacion -> /api/sync-period-pay.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

/* --- Supabase REST con service_role --- */
async function sb(env, path, opts = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Profile': 'nomina_v2',
      'Accept-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

/* --- Auth (mismo patron que ax-roster.js) --- */
async function getAdmin(env, adminId) {
  if (!adminId) return null;
  const rows = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id,role`);
  return rows && rows.length ? rows[0] : null;
}
async function allowedCompanies(env, admin) {
  if (admin.role === 'superadmin') return null; // todas
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: admin.id }),
  });
  return new Set((rows || []).map(r => r.company_code));
}

/* Fila de la tabla -> shape que espera el cliente (camelCase del API). */
function slim(r) {
  if (!r) return null;
  return {
    alias: r.alias,
    index: r.idx != null ? String(r.idx) : null,
    periodoNomina: r.periodo_nomina || null,
    periodoPago: r.periodo_pago || null,
    pagoDesde: r.pago_desde || null,
    pagoHasta: r.pago_hasta || null,
    status: r.status || null,
    tag: r.tag || null,
    fetchedAt: r.fetched_at || null,
  };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  const action = body.action || 'card';

  // ===== TARJETA TIENDA (una empresa) =====
  if (action === 'card') {
    const alias = (body.alias || body.companyCode || '').trim();
    if (!alias) return json({ ok: false, error: 'Falta el alias de la empresa.' }, 400);
    try {
      // Traer 0 y -1 de esa empresa; ordenar por idx desc y tomar el mayor.
      const rows = await sb(env,
        `period_pay_status?alias=eq.${encodeURIComponent(alias)}&order=idx.desc&select=*`) || [];
      const reg = rows[0] || null;
      // usedFallback: el mas reciente es el anterior (idx < 0) -> el actual
      // aun no tiene pago calculado.
      const usedFallback = !!(reg && reg.idx != null && Number(reg.idx) < 0);
      return json({ ok: true, period: slim(reg), usedFallback });
    } catch (e) {
      return json({ ok: false, error: 'No se pudo leer el estado de pago: ' + e.message }, 500);
    }
  }

  // ===== GRILLA ADMIN (todas las empresas del alcance) =====
  if (action === 'grid') {
    const admin = await getAdmin(env, body.adminId);
    if (!admin) return json({ ok: false, error: 'Solo un administrador puede ver la grilla.' }, 401);
    let allowed;
    try { allowed = await allowedCompanies(env, admin); }
    catch (e) { return json({ ok: false, error: 'Error resolviendo el alcance: ' + e.message }, 500); }

    try {
      const all = await sb(env, `period_pay_status?order=alias.asc,idx.desc&select=*`) || [];
      // Una fila por empresa: el index mas alto (ya viene ordenado idx desc).
      const byAlias = {};
      for (const r of all) {
        if (!byAlias[r.alias]) byAlias[r.alias] = r;
      }
      let rows = Object.values(byAlias);
      if (allowed !== null) rows = rows.filter(r => allowed.has(r.alias));
      // usedFallback global: si TODAS las visibles son anteriores (idx < 0).
      const usedFallback = rows.length > 0 && rows.every(r => Number(r.idx) < 0);
      rows = rows.map(slim).sort((a, b) => (a.alias || '').localeCompare(b.alias || ''));
      return json({ ok: true, rows, usedFallback });
    } catch (e) {
      return json({ ok: false, error: 'No se pudo leer el estado de pago: ' + e.message }, 500);
    }
  }

  return json({ ok: false, error: 'Accion no reconocida.' }, 400);
}
