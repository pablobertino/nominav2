/* =====================================================================
   functions/api/company-reports.js  →  /api/company-reports
   "Reportes de empresas" (Fase 1) + "Mis estadisticas" del usuario company.

   Acciones (POST {action}):
     - facets   : combos de filtro (tipos/zonas/subzonas/conceptos) del
                  alcance. [solo admin/superadmin]
     - list     : empresas que pasan los filtros + contadores por tipo de
                  reporte y atencion. [solo admin/superadmin]
     - detail   : dashboard de UNA empresa (ficha, kpis, por tipo, tendencia,
                  ultimos reportes). [admin con alcance | company = SU codigo]
     - rotation : panel de rotacion de UNA empresa (egresos con snapshot de
                  perfil + motivo reportado vs ratificado). [igual que detail]

   Alcance (resolveScope, mismo patron que reports-history.js):
     company    -> solo su company_code (revalidado en company_users activo)
     admin      -> get_admin_companies ; superadmin -> todas
   Para detail/rotation se exige que el codigo pedido este en el alcance.
   list/facets quedan vetadas a company (devuelven 403).

   Body: { action, user, from?, to?, type?, zone_id?, subzone_id?,
           concept_id?, search?, code? }
     user admin   = { kind:'admin', id }
     user company = { kind:'company', companyCode }
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

function ymd(v) {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function clean(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s : null;
}

/* Resuelve el alcance del usuario (mismo criterio que reports-history.js):
     { all:true }            -> superadmin
     { codes:[...] }         -> admin (sus empresas) o company (la suya)
     { codes:[] }            -> sin acceso
   Ademas devuelve kind/role para decidir que acciones se permiten.        */
async function resolveScope(env, user) {
  if (!user) return { codes: [], kind: null };
  if (user.kind === 'company') {
    if (!user.companyCode) return { codes: [], kind: 'company' };
    const u = await sb(env, `company_users?company_code=eq.${encodeURIComponent(user.companyCode)}&is_active=eq.true&select=company_code`);
    return { codes: (u && u.length) ? [user.companyCode] : [], kind: 'company' };
  }
  if (user.kind === 'admin' && user.id) {
    const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role`);
    if (!a || !a.length) return { codes: [], kind: 'admin' };
    if (a[0].role === 'superadmin') return { all: true, kind: 'admin', role: 'superadmin' };
    const rows = await sb(env, 'rpc/get_admin_companies', {
      method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
    });
    return { codes: (rows || []).map(r => r.company_code), kind: 'admin', role: a[0].role };
  }
  return { codes: [], kind: null };
}

// Codigos del alcance para pasar a los RPC (null = todas, para superadmin).
function scopeCodes(scope) { return scope.all ? null : (scope.codes || []); }
// True si el codigo pedido esta dentro del alcance.
function inScope(scope, code) { return scope.all || (scope.codes || []).includes(code); }

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido' }, 400); }

  const from = ymd(body.from);
  const to = ymd(body.to);

  try {
    const scope = await resolveScope(env, body.user || null);
    if (!scope.kind) return json({ ok: false, error: 'Sesion no valida.' }, 403);

    const isCompany = scope.kind === 'company';

    // ---- facets / list : solo admin ----
    if (body.action === 'facets') {
      if (isCompany) return json({ ok: false, error: 'No disponible.' }, 403);
      const f = await sb(env, 'rpc/company_reports_facets', {
        method: 'POST', body: JSON.stringify({ p_codes: scopeCodes(scope) }),
      });
      return json({ ok: true, facets: f || {} });
    }

    if (body.action === 'list' || (!body.action && !isCompany)) {
      if (isCompany) return json({ ok: false, error: 'No disponible.' }, 403);
      const rows = await sb(env, 'rpc/company_reports_list', {
        method: 'POST',
        body: JSON.stringify({
          p_codes: scopeCodes(scope), p_from: from, p_to: to,
          p_type: clean(body.type),
          p_zone_id: clean(body.zone_id),
          p_subzone_id: clean(body.subzone_id),
          p_concept_id: clean(body.concept_id),
          p_search: clean(body.search),
        }),
      });
      return json({ ok: true, rows: rows || [] });
    }

    // ---- detail / rotation : admin (su alcance) o company (su codigo) ----
    if (body.action === 'detail' || body.action === 'rotation') {
      // company: ignora el code del body y usa el SUYO (no se fia del cliente).
      const code = isCompany ? (scope.codes[0] || null) : clean(body.code);
      if (!code) return json({ ok: false, error: isCompany ? 'Sesion sin empresa.' : 'Falta la empresa.' }, 400);
      if (!inScope(scope, code)) return json({ ok: false, error: 'Empresa fuera de tu alcance.' }, 403);
      const fn = body.action === 'detail' ? 'company_reports_detail' : 'company_reports_rotation';
      const d = await sb(env, `rpc/${fn}`, {
        method: 'POST', body: JSON.stringify({ p_code: code, p_from: from, p_to: to }),
      });
      return json({ ok: true, [body.action]: d || {} });
    }

    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
