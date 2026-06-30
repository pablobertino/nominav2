/* =====================================================================
   functions/api/period-pay.js  →  POST /api/period-pay
   Estado de pago del periodo de nomina, leido EN VIVO de la API de
   periodos de AX (api3.grupocanaima.com). La key vive en el servidor
   (env.canaima_apikey, header X-API-Key) y NUNCA viaja al navegador.

   Dos acciones:
   - action 'card'  -> una empresa (alias). Para la tarjeta de la tienda
                       en su Inicio. Estrategia: pedir por la fecha de hoy;
                       si viene vacio (periodo actual sin pago calculado),
                       reintentar con hoy-15d y marcar usedFallback=true.
   - action 'grid'  -> todas las empresas del alcance del admin. Una sola
                       llamada al API sin alias (filtrada por fecha), y se
                       intersecta con get_admin_companies. superadmin = todas.

   Estados de pago (status del API): "Pago calculado" -> "Pago cargado"
   -> "Pago enviado" -> "Pagado".

   Secrets: canaima_apikey, supabase_url, supabase_service_role
   ===================================================================== */

const PERIODOS_API = 'https://api3.grupocanaima.com/empresas/periodos/v1';

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

/* --- Fechas (UTC, formato YYYY-MM-DD) --- */
function ymd(d) { return d.toISOString().slice(0, 10); }
function todayYMD() { return ymd(new Date()); }
function minusDaysYMD(fecha, days) {
  const d = new Date(fecha + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return ymd(d);
}

/* --- Llama al API de periodos con una fecha; devuelve array (puede ser []) --- */
async function fetchPeriodos(env, alias, fecha) {
  let url = `${PERIODOS_API}?fecha=${encodeURIComponent(fecha)}`;
  if (alias) url += `&alias=${encodeURIComponent(alias)}`;
  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
  });
  if (!r.ok) throw new Error(`API periodos respondio ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : (j.data || j.items || []);
}

/* Estrategia: pedir por la fecha dada; si viene vacio, reintentar con -15d
   (periodo anterior). Devuelve { data, usedFallback }. */
async function fetchConFallback(env, alias, fecha) {
  let data = await fetchPeriodos(env, alias, fecha);
  if (data.length) return { data, usedFallback: false };
  data = await fetchPeriodos(env, alias, minusDaysYMD(fecha, 15));
  return { data, usedFallback: true };
}

/* De varios registros, el de mayor index (0 si existe, si no -1, etc.). */
function masReciente(rows) {
  if (!rows || !rows.length) return null;
  return rows.slice().sort((a, b) => parseInt(b.index, 10) - parseInt(a.index, 10))[0];
}

/* Solo los campos que el cliente necesita (no exponer de mas). */
function slim(p) {
  if (!p) return null;
  return {
    alias: p.alias || null,
    index: p.index != null ? String(p.index) : null,
    periodoNomina: p.periodoNomina || null,
    periodoPago: p.periodoPago || null,
    pagoDesde: p.pagoDesde || null,
    pagoHasta: p.pagoHasta || null,
    status: p.status || null,
    tag: p.tag || null,
  };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  const action = body.action || 'card';
  const fecha = (body.fecha && /^\d{4}-\d{2}-\d{2}$/.test(body.fecha)) ? body.fecha : todayYMD();

  // ===== TARJETA TIENDA (una empresa) =====
  if (action === 'card') {
    const alias = (body.alias || body.companyCode || '').trim();
    if (!alias) return json({ ok: false, error: 'Falta el alias de la empresa.' }, 400);
    try {
      const { data, usedFallback } = await fetchConFallback(env, alias, fecha);
      const reg = masReciente(data);
      return json({ ok: true, period: slim(reg), usedFallback });
    } catch (e) {
      return json({ ok: false, error: 'No se pudo consultar el estado de pago: ' + e.message }, 502);
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
      // Una sola llamada SIN alias (todas), con fallback a -15d si hoy viene vacio.
      const { data, usedFallback } = await fetchConFallback(env, '', fecha);
      // Quedarnos con el registro de mayor index por alias.
      const byAlias = {};
      for (const p of data) {
        const k = p.alias;
        if (!k) continue;
        if (!byAlias[k] || parseInt(p.index, 10) > parseInt(byAlias[k].index, 10)) byAlias[k] = p;
      }
      let rows = Object.values(byAlias);
      // Filtrar por alcance (superadmin = todas).
      if (allowed !== null) rows = rows.filter(p => allowed.has(p.alias));
      rows = rows.map(slim).sort((a, b) => (a.alias || '').localeCompare(b.alias || ''));
      return json({ ok: true, rows, usedFallback });
    } catch (e) {
      return json({ ok: false, error: 'No se pudo consultar el estado de pago: ' + e.message }, 502);
    }
  }

  return json({ ok: false, error: 'Accion no reconocida.' }, 400);
}
