/* =====================================================================
   functions/api/egress-ratify.js  →  POST /api/egress-ratify
   Ratificacion / rectificacion del MOTIVO de egreso por el admin.

   La tienda reporta un motivo (egress_report_lines.reason_code +
   reason_comment). Como el gerente puede no decir la verdad, el admin
   revisa cada egreso y:
     - RATIFICA  -> acepta el motivo de la tienda tal cual.
     - RECTIFICA -> lo corrige con otro motivo (+ comentario propio).
   El doble estatus vive en las columnas admin_* de egress_report_lines.

   Acciones (POST {action, adminId, ...}):
     list  {status?}                 -> lista lineas de egreso (con scope)
     apply {line_id, mode,           -> ratifica / rectifica / reabre
            admin_code?, admin_comment?}

   mode: 'ratificar' | 'rectificar' | 'pendiente'
   Scope: superadmin = todas; admin = solo sus empresas (get_admin_companies).
   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

import { resolveActor, can } from './_auth.js';

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

/** Resuelve el admin y su alcance de empresas.
 *  Devuelve { id, role, codes }  donde codes = null (todas, superadmin)
 *  o un array de company_code permitidos. null si el admin no es valido. */
async function resolveAdmin(env, adminId) {
  if (!adminId) return null;
  const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id,role`);
  if (!a || !a.length) return null;
  // El gestor de empresa NO ratifica egresos (es atribucion de admin/superadmin).
  if (a[0].role === 'gestor_empresa') return null;
  if (a[0].role === 'superadmin') return { id: a[0].id, role: a[0].role, codes: null };
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
  });
  return { id: a[0].id, role: a[0].role, codes: (rows || []).map(r => r.company_code) };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const { action, adminId } = body;

  try {
    const admin = await resolveAdmin(env, adminId);
    if (!admin) return json({ ok: false, error: 'Requiere un administrador valido.' }, 403);
    // v4.74: CORTE del shadow (Lote 4). La pantalla exige view.egmotivos y
    // ratificar/rectificar exige egress.ratify en la matriz (can). La regla
    // legacy anti-gestor (resolveAdmin) y el alcance por empresa se conservan.
    const actor = await resolveActor(env, { kind: 'admin', id: adminId });

    /* ---------------- LISTAR ---------------- */
    if (action === 'list') {
      if (!can(actor, 'view.egmotivos')) return json({ ok: false, error: 'No tienes permiso para esta pantalla.' }, 403);
      const status = (body.status || '').trim() || null; // pendiente|ratificado|rectificado|null(todos)
      const rows = await sb(env, 'rpc/egress_ratify_list', {
        method: 'POST',
        body: JSON.stringify({ p_codes: admin.codes, p_status: status, p_limit: 400 }),
      });
      return json({ ok: true, rows: rows || [] });
    }

    /* ---------------- RATIFICAR / RECTIFICAR / REABRIR ---------------- */
    if (action === 'apply') {
      const lineId = parseInt(body.line_id, 10);
      const mode = (body.mode || '').trim();
      if (!lineId) return json({ ok: false, error: 'Falta la linea.' }, 400);
      if (!['ratificar', 'rectificar', 'pendiente'].includes(mode)) {
        return json({ ok: false, error: 'Accion invalida.' }, 400);
      }
      if (!can(actor, 'egress.ratify')) return json({ ok: false, error: 'No tienes permiso para ratificar motivos de egreso.' }, 403);

      // Traer la linea + la empresa del reporte (para validar alcance).
      const line = await sb(env, `egress_report_lines?id=eq.${lineId}&select=id,reason_code,report_id`);
      if (!line || !line.length) return json({ ok: false, error: 'Linea no encontrada.' }, 404);
      const rep = await sb(env, `reports_log?id=eq.${line[0].report_id}&select=company_code,topic`);
      const company = rep && rep[0] ? rep[0].company_code : null;
      if (!rep || !rep.length || rep[0].topic !== 'egreso') {
        return json({ ok: false, error: 'El reporte no es de egreso.' }, 400);
      }
      // Alcance: si no es superadmin, la empresa debe estar en su lista.
      if (admin.codes !== null && !admin.codes.includes(company)) {
        return json({ ok: false, error: 'Sin permiso sobre esa empresa.' }, 403);
      }

      const nowIso = new Date().toISOString();
      let patch;

      if (mode === 'pendiente') {
        // Reabrir: limpia la decision del admin.
        patch = {
          admin_reason_status: 'pendiente',
          admin_reason_code: null, admin_reason_comment: null,
          admin_ratified_by: null, admin_ratified_at: null,
        };
      } else if (mode === 'ratificar') {
        if (!line[0].reason_code) {
          return json({ ok: false, error: 'La tienda no indico un motivo: usa Rectificar para asignar uno.' }, 400);
        }
        patch = {
          admin_reason_status: 'ratificado',
          admin_reason_code: line[0].reason_code,
          admin_reason_comment: null,
          admin_ratified_by: admin.id, admin_ratified_at: nowIso,
        };
      } else { // rectificar
        const code = (body.admin_code || '').trim();
        if (!code) return json({ ok: false, error: 'Elige el motivo correcto.' }, 400);
        const valid = await sb(env, `egress_reasons?code=eq.${encodeURIComponent(code)}&is_active=eq.true&select=code`);
        if (!valid || !valid.length) return json({ ok: false, error: 'Motivo invalido o inactivo.' }, 400);
        const comment = (body.admin_comment || '').toString().trim();
        patch = {
          admin_reason_status: 'rectificado',
          admin_reason_code: code,
          admin_reason_comment: comment ? comment.slice(0, 300) : null,
          admin_ratified_by: admin.id, admin_ratified_at: nowIso,
        };
      }

      await sb(env, `egress_report_lines?id=eq.${lineId}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
