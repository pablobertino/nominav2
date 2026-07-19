/* =====================================================================
   functions/api/mov-quincena.js  →  POST /api/mov-quincena
   MOVIMIENTOS DE LA QUINCENA (v6.37). Vista operativa: TODOS los
   ingresados, trasladados, egresados y cambios de cargo de la quincena
   elegida, clasificados con la REGLA SIN REPETIR por la RPC
   nomina_v2.get_quincena_moves (roster vivo + espejos AX; ver migracion
   v637). NO usa hcm_snapshot: por eso sus totales no cuadran (ni deben)
   con la vista Rotacion, que cuenta desde los cortes.

   Acciones (POST { action, user, ... }):
     facets  {}         gate view.movquincena. Quincenas del calendario
                        (payroll_periods, solo las que ya comenzaron) +
                        facetas territoriales del alcance (zones/subzones/
                        concepts, misma RPC que Buscar).
     moves   {from,to}  gate view.movquincena. Todas las filas del rango
                        (los filtros territoriales y las pestañas filtran
                        en el cliente: ~500 filas por quincena). El alcance
                        del admin se aplica AQUI (la RPC no tiene p_codes):
                        una fila entra si su ORIGEN o su DESTINO esta en el
                        alcance. Cada fila sale con thumb_url (bucket
                        publico worker-thumbs por photo_key) y el tipo de
                        empresa de ambas puntas (para abrir la ficha en el
                        modo correcto: store/enterprise).

   Gate: view.movquincena (permiso NUEVO v6.37, hermano de
   view.movimientos; sembrado con superadmin + admin + auditor).
   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { resolveActor, can } from './_auth.js';

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

/* Alcance de EMPRESAS del actor (patron movements.js / personnel_search):
   superadmin -> null (todas); resto -> get_admin_companies(p_admin_id). */
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

/* Miniatura publica por photo_key (mismo bucket que Buscar). */
const PUBLIC_THUMB_BUCKET = 'worker-thumbs';
function thumbUrl(env, photoKey) {
  if (!photoKey) return null;
  return `${env.supabase_url}/storage/v1/object/public/${PUBLIC_THUMB_BUCKET}/${photoKey}.jpg`;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const action = body.action || 'moves';

  try {
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
    if (!can(actor, 'view.movquincena')) {
      return json({ ok: false, error: 'No tienes permiso para ver los movimientos de la quincena (view.movquincena).' }, 403);
    }
    const codes = await scopeCodes(env, actor, body.user);

    /* ---------- facets: quincenas + combos territoriales ---------- */
    if (action === 'facets') {
      const EMPTY = { zones: [], subzones: [], concepts: [], statuses: [], types: [], companies: [] };
      const [facets, periods] = await Promise.all([
        (codes !== null && !codes.length)
          ? Promise.resolve(EMPTY)
          : sb(env, 'rpc/personnel_search_facets', {
              method: 'POST', body: JSON.stringify({ p_codes: codes }),
            }).then(f => f || EMPTY),
        // Quincenas del calendario, mas reciente primero, solo las que ya
        // comenzaron y no antes de 2026 (los datos vivos arrancan alli).
        sb(env, `payroll_periods?select=year,month,quincena,range_start,range_end`
          + `&year=gte.2026&range_start=lte.${new Date().toISOString().slice(0, 10)}`
          + `&order=range_start.desc&limit=48`),
      ]);
      return json({ ok: true, facets, periods: periods || [] });
    }

    /* ---------- moves: las filas de la quincena ---------- */
    if (action === 'moves') {
      const from = isoDate(body.from);
      const to = isoDate(body.to);
      if (!from || !to) return json({ ok: false, error: 'Indica la quincena (desde y hasta).' }, 400);
      if (from > to) return json({ ok: false, error: 'La fecha inicial no puede ser posterior a la final.' }, 400);

      // Alcance vacio (admin sin empresas): respuesta vacia, sin consultar.
      if (codes !== null && !codes.length) return json({ ok: true, rows: [] });

      const [rows, comps] = await Promise.all([
        sb(env, 'rpc/get_quincena_moves', {
          method: 'POST', body: JSON.stringify({ p_from: from, p_to: to }),
        }),
        // Tipo de empresa por alias: decide el modo (store/enterprise) al
        // abrir la ficha en el cliente.
        sb(env, 'companies?select=company_code,company_type'),
      ]);
      const typeBy = {};
      (comps || []).forEach(c => { typeBy[c.company_code] = c.company_type || null; });

      let out = rows || [];
      if (codes !== null) {
        const set = new Set(codes);
        // La fila entra si su origen O su destino esta en el alcance.
        out = out.filter(r => set.has(r.a_alias) || set.has(r.b_alias));
      }
      out = out.map(r => ({
        ...r,
        a_tipo: typeBy[r.a_alias] || null,
        b_tipo: typeBy[r.b_alias] || null,
        thumb_url: thumbUrl(env, r.photo_key),
      }));
      return json({ ok: true, rows: out });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
