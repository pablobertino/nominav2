/* =====================================================================
   functions/api/company-reports.js  →  /api/company-reports
   "Reportes de empresas" (Fase 1). Tres vistas sobre el alcance del admin:
     - action 'list'     : empresas que pasan los filtros + contadores por
                           tipo de reporte y atencion (una fila por empresa,
                           incluidas las de 0 reportes -> cobertura/silencio).
     - action 'facets'   : combos de filtro (tipos/zonas/subzonas/conceptos)
                           presentes en el alcance.
     - action 'detail'   : dashboard de UNA empresa (ficha, kpis, por tipo,
                           tendencia por semana, ultimos reportes).
     - action 'rotation' : panel de rotacion de UNA empresa (egresos con su
                           snapshot de perfil + motivo reportado vs ratificado).

   Alcance por rol (igual que /api/report-stats y /api/dashboard):
   superadmin = todo (p_codes null); admin/editor = sus empresas (RPC
   get_admin_companies). Para 'detail'/'rotation' se VERIFICA que la empresa
   pedida este dentro del alcance antes de responder.

   Body: { action, user:{ kind:'admin', id }, from?, to?,
           type?, zone_id?, subzone_id?, concept_id?, search?, code? }
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

// Valida 'YYYY-MM-DD'. Devuelve la cadena o null.
function ymd(v) {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function clean(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s : null;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido' }, 400); }

  const user = body.user || null;
  const from = ymd(body.from);
  const to = ymd(body.to);

  try {
    if (!user || user.kind !== 'admin' || !user.id) {
      return json({ ok: false, error: 'Solo para administradores.' }, 403);
    }
    const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role`);
    if (!a || !a.length) return json({ ok: false, error: 'Sesion no valida.' }, 403);
    const role = a[0].role;

    // Alcance: superadmin = todo (null); admin/editor = sus empresas.
    let codes = null;
    if (role !== 'superadmin') {
      const rows = await sb(env, 'rpc/get_admin_companies', {
        method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
      });
      codes = (rows || []).map(r => r.company_code);
    }
    const scope = role === 'superadmin' ? 'all' : 'scoped';

    // ---- facets: combos de filtro presentes en el alcance ----
    if (body.action === 'facets') {
      const f = await sb(env, 'rpc/company_reports_facets', {
        method: 'POST', body: JSON.stringify({ p_codes: codes }),
      });
      return json({ ok: true, scope, facets: f || {} });
    }

    // ---- list: empresas filtradas + contadores ----
    if (body.action === 'list' || !body.action) {
      const rows = await sb(env, 'rpc/company_reports_list', {
        method: 'POST',
        body: JSON.stringify({
          p_codes: codes, p_from: from, p_to: to,
          p_type: clean(body.type),
          p_zone_id: clean(body.zone_id),
          p_subzone_id: clean(body.subzone_id),
          p_concept_id: clean(body.concept_id),
          p_search: clean(body.search),
        }),
      });
      return json({ ok: true, scope, rows: rows || [] });
    }

    // ---- detail / rotation: requieren empresa dentro del alcance ----
    if (body.action === 'detail' || body.action === 'rotation') {
      const code = clean(body.code);
      if (!code) return json({ ok: false, error: 'Falta la empresa.' }, 400);
      // Verificar alcance: si el admin tiene alcance limitado, la empresa
      // debe estar en su lista. superadmin (codes=null) puede ver cualquiera.
      if (codes !== null && !codes.includes(code)) {
        return json({ ok: false, error: 'Empresa fuera de tu alcance.' }, 403);
      }
      const fn = body.action === 'detail' ? 'company_reports_detail' : 'company_reports_rotation';
      const d = await sb(env, `rpc/${fn}`, {
        method: 'POST',
        body: JSON.stringify({ p_code: code, p_from: from, p_to: to }),
      });
      return json({ ok: true, scope, [body.action]: d || {} });
    }

    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
