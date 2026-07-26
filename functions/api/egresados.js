/* =====================================================================
   functions/api/egresados.js  →  POST /api/egresados
   EGRESADOS (v6.135). Pantalla de CONSULTA de personas que ya no están
   activas, pensada para detectar reempleo. Solo lectura.

   Fuente: ax_egresos (la historia laboral). Se agrupa por cédula y se toma
   el ÚLTIMO egreso de cada persona (misma lógica que las estadísticas de
   No reempleables). Se EXCLUYE a quien hoy sigue activo (store_workers /
   enterprise_workers). Se marca a los NO REEMPLEABLES (cruce con no_rehire).

   Alcance: el listado respeta el alcance del usuario (las empresas de su
   scope). Superadmin ve todo. La zona/subzona sale de la empresa del último
   egreso; el alcance se aplica por el company_code (alias) de ese egreso.

   Gate: view.egresados. El MOTIVO de no reempleable solo se revela a quien
   además tiene view.norehire; para el resto la persona sale marcada como
   "No reempleable" pero sin el motivo (misma línea de privacidad que
   Verificar candidato).

   Acciones (POST { action, user, ... }):
     list {q, zone, subzone, limit, offset}  -> { ok, total, rows }

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

const PUBLIC_THUMB_BUCKET = 'worker-thumbs';
function thumbUrl(env, photoKey) {
  if (!photoKey) return null;
  return `${env.supabase_url}/storage/v1/object/public/${PUBLIC_THUMB_BUCKET}/${photoKey}.jpg`;
}

/* Empresas del alcance del admin. Superadmin -> null (todas). El resto ->
   sus company_code base (get_admin_companies), igual que Buscar cuando no
   hay override por sección. */
async function scopedCodes(env, adminId, role) {
  if (role === 'superadmin') return null;
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: adminId }),
  }).catch(() => null);
  return (rows || []).map(r => r.company_code);
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const action = body.action || 'list';

  try {
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
    if (!can(actor, 'view.egresados')) {
      return json({ ok: false, error: 'No tienes permiso para ver los egresados (view.egresados).' }, 403);
    }

    if (action === 'list') {
      const adminId = (body.user && (body.user.id || body.user.adminId)) || actor.id || null;
      const codes = await scopedCodes(env, adminId, actor.role);
      // Con alcance vacío no hay nada que mostrar (no es un error).
      if (codes !== null && !codes.length) return json({ ok: true, total: 0, rows: [] });

      const q = typeof body.q === 'string' ? body.q.trim() : null;
      const zone = body.zone ? String(body.zone) : null;
      const subzone = body.subzone ? String(body.subzone) : null;
      // Tiempo de egresado: días desde el último egreso [min, max).
      const minDays = Number.isFinite(parseInt(body.min_days, 10)) ? parseInt(body.min_days, 10) : null;
      const maxDays = Number.isFinite(parseInt(body.max_days, 10)) ? parseInt(body.max_days, 10) : null;
      const limit = Math.min(Math.max(parseInt(body.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(body.offset, 10) || 0, 0);

      const res = await sb(env, 'rpc/egresados_list', {
        method: 'POST',
        body: JSON.stringify({
          p_codes: codes, p_q: q || null, p_zone: zone, p_subzone: subzone,
          p_min_days: minDays, p_max_days: maxDays,
          p_limit: limit, p_offset: offset,
        }),
      });

      const total = (res && res.total) || 0;
      const rows = (res && res.rows) || [];
      const seesReason = can(actor, 'view.norehire');
      const out = rows.map(r => ({
        id_number: r.ced,
        full_name: r.full_name || null,
        role: r.role || null,
        last_company_code: r.alias || null,
        last_company: r.empresa_nombre || null,
        zona: r.zona || null,
        subzona: r.subzona || null,
        last_egreso: r.fin_contrato || null,
        contratos: r.n_contratos || 0,
        primer_inicio: r.primer_inicio || null,
        dias_total: r.dias_total || 0,
        is_no_rehire: !!r.is_no_rehire,
        // El motivo solo para quien tiene view.norehire (privacidad).
        reason_value: (r.is_no_rehire && seesReason) ? r.reason_value : null,
        thumb_url: thumbUrl(env, r.photo_key),
      }));

      return json({ ok: true, total, rows: out, limit, offset });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status);
    return json({ ok: false, error: 'Error interno: ' + String(e && e.message ? e.message : e) }, 500);
  }
}
