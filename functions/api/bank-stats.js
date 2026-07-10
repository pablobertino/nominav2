/* =====================================================================
   functions/api/bank-stats.js  →  DATOS BANCARIOS · Estadísticas (v4.78)

   Devuelve la distribución de cuentas bancarias del personal VIGENTE del
   alcance del usuario, más el detalle nominal de quien no tiene cuenta o
   la tiene inválida (la herramienta para gestionar la apertura).

   Toda la agregación vive en la función SQL nomina_v2.bank_account_stats
   (p_admin_id): NULL = superadmin (todo el grupo); id = solo las empresas
   de get_admin_companies. La cuenta efectiva es la editada en la ficha
   (workers_master) y, si no hay, la del roster — el mismo pick que usa el
   directory de fichas.

   Gate: view.bankstats (matriz de Roles). superadmin siempre puede.
   Respuesta: { ok, banks:[{code,name}], data:[[tipo,zona,prefijo,n]...],
                nocta:[{id_number, full_name, company_code, ...reason}] }
   ===================================================================== */

import { resolveActor, can } from './_auth.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

async function rpc(env, fn, args) {
  const res = await fetch(`${env.supabase_url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2', 'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args || {}),
  });
  if (!res.ok) throw new Error(`Supabase RPC ${fn} ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Cuerpo inválido.' }, 400); }

  try {
    const actor = await resolveActor(env, body.user);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);
    if (!can(actor, 'view.bankstats')) {
      return json({ ok: false, error: 'No tienes permiso para ver Datos bancarios (view.bankstats).' }, 403);
    }

    // Alcance: superadmin ve todo el grupo; el resto, sus empresas.
    const adminId = actor.role === 'superadmin' ? null : (actor.id || null);
    if (actor.role !== 'superadmin' && adminId == null) {
      return json({ ok: false, error: 'No se pudo determinar tu alcance.' }, 403);
    }

    const stats = await rpc(env, 'bank_account_stats', { p_admin_id: adminId });
    if (!stats) return json({ ok: false, error: 'No se pudo calcular la estadística.' }, 500);

    return json({ ok: true, banks: stats.banks || [], data: stats.data || [], nocta: stats.nocta || [] });
  } catch (e) {
    if (e && e.name === 'AuthError') return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error interno: ' + (e && e.message ? e.message : e) }, 500);
  }
}
