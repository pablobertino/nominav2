/* =====================================================================
   functions/api/bank-accounts.js  →  DATOS BANCARIOS · Cuentas (v4.82)

   Grilla nominal exportable de la cuenta bancaria del personal VIGENTE.
   Toda la logica vive en nomina_v2.bank_accounts_list:
     - usuario de TIENDA/EMPRESA (kind=company): alcance forzado a SU
       empresa via p_company_code; los filtros de tipo/empresa/zona se
       ignoran server-side.
     - admin: p_admin_id = su id (get_admin_companies); superadmin: null.
   Cuenta efectiva = ficha maestra (workers_master) y si no, roster —
   el mismo criterio de bank_account_stats.

   Gate: view.bankaccounts (sembrado a TODOS los roles en v4.82; se
   gobierna desde la pantalla Roles). superadmin siempre puede.

   Body: { user, q, bank, has ('si'|'no'), type, company, zone, subzone,
           limit, offset }
   Respuesta: { ok, cards:{tot,con,sin,banks}, total, banks:[{code,name}],
                rows:[{id_number, full_name, role, company_code,
                       company_name, type, zone, subzone, acct, bank,
                       pref, reason}] }
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

const nn = v => { const s = String(v == null ? '' : v).trim(); return s === '' ? null : s; };

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Cuerpo inválido.' }, 400); }

  try {
    const actor = await resolveActor(env, body.user);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);
    if (!can(actor, 'view.bankaccounts')) {
      return json({ ok: false, error: 'No tienes permiso para ver las cuentas (view.bankaccounts).' }, 403);
    }

    // Alcance: tienda/empresa -> SU empresa; admin -> su id; super -> todo.
    // resolveActor no devuelve id: usar body.user.id ya validado por el.
    let companyCode = null, adminId = null;
    if (actor.kind === 'company') {
      companyCode = String(body.user.companyCode || '').trim() || null;
      if (!companyCode) return json({ ok: false, error: 'No se pudo determinar tu empresa.' }, 403);
    } else if (actor.role !== 'superadmin') {
      adminId = Number(body.user && body.user.id) || null;
      if (adminId == null) return json({ ok: false, error: 'No se pudo determinar tu alcance.' }, 403);
    }

    const lim = Math.min(Math.max(parseInt(body.limit, 10) || 50, 1), 10000);
    const off = Math.max(parseInt(body.offset, 10) || 0, 0);
    const isCompany = actor.kind === 'company';

    const data = await rpc(env, 'bank_accounts_list', {
      p_admin_id: adminId,
      p_company_code: companyCode,
      p_q: nn(body.q),
      p_bank: nn(body.bank),
      p_has: (body.has === 'si' || body.has === 'no') ? body.has : null,
      // Los filtros estructurales no aplican al usuario de empresa.
      p_type: isCompany ? null : nn(body.type),
      p_filter_company: isCompany ? null : nn(body.company),
      p_zone: isCompany ? null : nn(body.zone),
      p_subzone: isCompany ? null : nn(body.subzone),
      p_department: Number.isFinite(parseInt(body.department, 10)) ? parseInt(body.department, 10) : null,
      p_ref: (body.ref === 'si' || body.ref === 'no') ? body.ref : null,
      p_limit: lim,
      p_offset: off,
    });
    if (!data) return json({ ok: false, error: 'No se pudo consultar las cuentas.' }, 500);

    return json({
      ok: true,
      cards: data.cards || { tot: 0, con: 0, sin: 0, banks: 0 },
      total: data.total || 0,
      banks: data.banks || [],
      companies: data.companies || [],
      zones: data.zones || [],
      departments: data.departments || [],
      rows: data.rows || [],
    });
  } catch (e) {
    if (e && e.name === 'AuthError') return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error interno: ' + (e && e.message ? e.message : e) }, 500);
  }
}
