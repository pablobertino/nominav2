/* =====================================================================
   functions/api/movements.js  →  POST /api/movements
   MOVIMIENTOS DE PERSONAL (v5.93, fase 1 del plan MOVIMIENTOS).
   Ingresos, egresos, traslados y cambios de cargo del periodo, derivados
   de nomina_v2.hcm_snapshot (13+ cortes quincenales) + role_history (en
   vivo). Toda la derivacion vive en la RPC nomina_v2.personnel_movements
   (reglas validadas: quincena 01-15/07/2026 = ing 84, egr 219, tras 55,
   cargo 42 — numeros de referencia del plan).

   Acciones (POST { action, user, ... }):
     facets  {}   gate view.movimientos. Combos de la vista: facetas
                  territoriales del alcance (zones/subzones/concepts/
                  types/companies, misma RPC que Buscar), las QUINCENAS
                  del calendario (payroll_periods, hasta la vigente) y
                  last_cut (ultimo corte cargado, para la nota de datos).
     list    {from, to, zone, subzone, concept, company}
                  gate view.movimientos. Devuelve TODOS los movimientos
                  del rango (todos los tipos: los chips filtran en el
                  cliente para que los conteos por tipo esten siempre a
                  la vista). El alcance del admin se aplica en la RPC via
                  p_codes (patron personnel_search); en traslados la fila
                  entra si ORIGEN o DESTINO estan en el alcance.

   Gate: view.movimientos (permiso NUEVO v5.93, patron view.norehirecheck:
   enforced, gobernable desde Roles; nace con superadmin + admin).

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { resolveActor, can, AuthError } from './_auth.js';

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

/* Alcance de EMPRESAS del actor (patron personnel_search):
   superadmin -> null (todas); resto -> get_admin_companies(p_admin_id).
   El id numerico viene en la sesion (user.id); el actor ya fue revalidado
   contra admin_users por resolveActor, asi que aqui solo se resuelve el
   listado de codes. */
async function scopeCodes(env, actor, user) {
  if (actor.role === 'superadmin') return null;
  const adminId = parseInt(user && user.id, 10) || null;
  if (!adminId) return [];
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: adminId }),
  });
  return (rows || []).map(r => r.company_code);
}

/* Fecha 'YYYY-MM-DD' valida o null. */
function isoDate(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const action = body.action || 'list';

  try {
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
    if (!can(actor, 'view.movimientos')) {
      return json({ ok: false, error: 'No tienes permiso para ver los movimientos de personal (view.movimientos).' }, 403);
    }
    const codes = await scopeCodes(env, actor, body.user);

    /* ---------- facets: combos de la vista ---------- */
    if (action === 'facets') {
      const EMPTY = { zones: [], subzones: [], concepts: [], statuses: [], types: [], companies: [] };
      const [facets, periods, cutRow, metaRow] = await Promise.all([
        (codes !== null && !codes.length)
          ? Promise.resolve(EMPTY)
          : sb(env, 'rpc/personnel_search_facets', {
              method: 'POST', body: JSON.stringify({ p_codes: codes }),
            }).then(f => f || EMPTY),
        // Quincenas del calendario, de la mas reciente a la mas vieja,
        // solo las que ya comenzaron (no tiene sentido consultar futuro)
        // y no antes del 2026 (los cortes cargados arrancan alli).
        sb(env, `payroll_periods?select=year,month,quincena,range_start,range_end`
          + `&year=gte.2026&range_start=lte.${new Date().toISOString().slice(0, 10)}`
          + `&order=range_start.desc&limit=48`),
        // Ultimo corte cargado (nota de hasta donde llegan traslados/cargos).
        sb(env, 'hcm_snapshot?select=cut_date&order=cut_date.desc&limit=1'),
        // v5.95: cuando se recalculo la cache de movimientos por ultima vez.
        sb(env, 'personnel_movements_cache_meta?id=eq.1&select=refreshed_at,row_count'),
      ]);
      return json({
        ok: true,
        facets,
        periods: periods || [],
        last_cut: (cutRow && cutRow[0] && cutRow[0].cut_date) || null,
        cache_at: (metaRow && metaRow[0] && metaRow[0].refreshed_at) || null,
      });
    }

    /* ---------- list: los movimientos del rango ---------- */
    if (action === 'list') {
      const from = isoDate(body.from);
      const to = isoDate(body.to);
      if (!from || !to) return json({ ok: false, error: 'Indica el rango de fechas (desde y hasta).' }, 400);
      if (from > to) return json({ ok: false, error: 'La fecha inicial no puede ser posterior a la final.' }, 400);

      // Alcance vacio (admin sin empresas): respuesta vacia, sin consultar.
      if (codes !== null && !codes.length) return json({ ok: true, rows: [] });

      const rows = await sb(env, 'rpc/personnel_movements', {
        method: 'POST',
        body: JSON.stringify({
          p_from: from,
          p_to: to,
          p_zone: body.zone ? String(body.zone) : null,
          p_subzone: body.subzone ? String(body.subzone) : null,
          p_concept: body.concept ? String(body.concept) : null,
          p_company: body.company ? String(body.company) : null,
          // Tipos: se piden TODOS; los chips del cliente aislan/combinan
          // sin refetch y los conteos por tipo quedan siempre visibles.
          p_types: null,
          p_admin_id: null,
          p_codes: codes,
          p_limit: 20000,
        }),
      });
      return json({ ok: true, rows: rows || [] });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status);
    return json({ ok: false, error: 'Error interno: ' + String(e && e.message ? e.message : e) }, 500);
  }
}
