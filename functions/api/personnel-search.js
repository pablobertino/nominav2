/* =====================================================================
   functions/api/personnel-search.js  →  POST /api/personnel-search
   Busqueda GLOBAL de personal por cedula o nombre, en todas las empresas
   dentro del alcance del administrador. Une store_workers + enterprise_workers
   via la funcion nomina_v2.personnel_search.

   Acciones (POST {action, adminId, ...}):
     search {q}  -> lista de coincidencias (cedula/nombre), con su empresa.

   Scope: superadmin = todas; admin/editor = solo sus empresas
   (get_admin_companies). Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { shadowCan } from './_auth.js';

// Mapa accion -> code. search/facets pertenecen a la vista Buscar;
// incomplete a la vista Datos incompletos.
const PS_CODE_BY_ACTION = {
  search: 'view.buscar',
  facets: 'view.buscar',
  incomplete: 'view.datosincompletos',
};

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

/* Bucket publico de miniaturas (esquema nuevo por photo_key). La URL es
   directa y cacheable, sin firmar. Se agrega thumb_url a cada fila que tenga
   photo_key; el front pinta la miniatura o cae a iniciales si es null. */
const PUBLIC_THUMB_BUCKET = 'worker-thumbs';
function thumbUrl(env, photoKey) {
  if (!photoKey) return null;
  return `${env.supabase_url}/storage/v1/object/public/${PUBLIC_THUMB_BUCKET}/${photoKey}.jpg`;
}
function withThumbs(env, rows) {
  return (rows || []).map(r => ({ ...r, thumb_url: thumbUrl(env, r.photo_key) }));
}

/** admin -> { id, role, codes }  codes=null (todas) | array de company_code. */
async function resolveAdmin(env, adminId) {
  if (!adminId) return null;
  const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id,role`);
  if (!a || !a.length) return null;
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

    // SHADOW: gate legacy = admin valido (resolveAdmin). Code por vista.
    await shadowCan(env, adminId, 'personnel-search', action || '?', PS_CODE_BY_ACTION[action] || 'view.buscar', !!admin);

    if (action === 'facets') {
      const EMPTY = { zones: [], subzones: [], concepts: [], statuses: [], types: [], companies: [] };
      if (admin.codes !== null && !admin.codes.length) {
        return json({ ok: true, facets: EMPTY, totals: { total: 0, active: 0 } });
      }
      const f = await sb(env, 'rpc/personnel_search_facets', {
        method: 'POST', body: JSON.stringify({ p_codes: admin.codes }),
      });
      // Totales del ALCANCE (denominador fijo del contador en Buscar y Datos
      // incompletos): total = todo el personal del alcance; active = solo
      // activos. Respeta alcance por empresa y por departamento.
      let totals = { total: 0, active: 0 };
      try {
        const t = await sb(env, 'rpc/personnel_scope_totals', {
          method: 'POST',
          body: JSON.stringify({
            p_codes: admin.codes,
            p_admin_id: admin.role === 'superadmin' ? null : admin.id,
          }),
        });
        if (t && t[0]) totals = { total: Number(t[0].total) || 0, active: Number(t[0].active) || 0 };
      } catch (_) { /* si falla, el front no muestra denominador */ }
      return json({ ok: true, facets: f || EMPTY, totals });
    }

    if (action === 'search') {
      const q = (body.q || '').toString().trim();
      const gender = (body.gender === 'M' || body.gender === 'F') ? body.gender : null;
      const toAge = v => {
        if (v === '' || v === null || v === undefined) return null;
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n >= 0 && n <= 120 ? n : null;
      };
      const ageMin = toAge(body.age_min);
      const ageMax = toAge(body.age_max);
      const zone = body.zone ? String(body.zone) : null;
      const subzone = body.subzone ? String(body.subzone) : null;
      const concept = body.concept ? String(body.concept) : null;
      const cstatus = body.status ? String(body.status) : null;
      // Filtros nuevos: tipo de empresa y empresa puntual (igual que 'incomplete').
      const KNOWN_TYPES = ['Tienda', 'Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea'];
      const ctype = (body.type && KNOWN_TYPES.includes(String(body.type))) ? String(body.type) : null;
      const ccompany = body.company ? String(body.company) : null;
      // Filtro por presencia de foto: 'with' | 'without' | null (todos).
      const cphoto = (body.photo === 'with' || body.photo === 'without') ? body.photo : null;
      // cphoto cuenta como filtro: permite listar por foto SIN escribir texto.
      const hasFilter = !!(gender || ageMin != null || ageMax != null || zone || subzone || concept || cstatus || ctype || ccompany || cphoto);
      // Permite buscar por texto (>=2) o solo por filtros.
      if (q.length < 2 && !hasFilter) return json({ ok: true, rows: [], short: true });
      if (admin.codes !== null && !admin.codes.length) return json({ ok: true, rows: [] });
      const rows = await sb(env, 'rpc/personnel_search', {
        method: 'POST',
        body: JSON.stringify({
          p_codes: admin.codes, p_q: q,
          p_gender: gender, p_age_min: ageMin, p_age_max: ageMax,
          p_zone: zone, p_subzone: subzone, p_concept: concept, p_status: cstatus, p_limit: 5000,
          // Filtro por departamento: para admins con alcance por departamento
          // en una empresa, su personal se limita a esos departamentos.
          // superadmin pasa null (sin restriccion).
          p_admin_id: admin.role === 'superadmin' ? null : admin.id,
          p_type: ctype, p_company: ccompany, p_photo: cphoto,
        }),
      });
      return json({ ok: true, rows: withThumbs(env, rows) });
    }

    if (action === 'incomplete') {
      // Reporte de datos incompletos de personal ACTIVO en el alcance.
      // body.fields = lista de campos a evaluar (gender, birth_date, account,
      // phone, email, address). Si no viene, se usan los 5 por defecto.
      const ALLOWED = ['gender', 'birth_date', 'account', 'phone', 'email', 'address', 'marital', 'role', 'department', 'photo'];
      let fields = Array.isArray(body.fields) ? body.fields.filter(f => ALLOWED.includes(f)) : [];
      if (!fields.length) fields = ['gender', 'birth_date', 'account', 'phone', 'email'];
      const zone = body.zone ? String(body.zone) : null;
      const subzone = body.subzone ? String(body.subzone) : null;
      const concept = body.concept ? String(body.concept) : null;
      const cstatus = body.status ? String(body.status) : null;
      // Filtros nuevos: tipo de empresa y empresa puntual. El tipo se valida
      // contra la lista conocida; la empresa es un company_code libre (la RPC
      // igual respeta el alcance via p_codes/p_admin_id).
      const KNOWN_TYPES = ['Tienda', 'Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea'];
      const ctype = (body.type && KNOWN_TYPES.includes(String(body.type))) ? String(body.type) : null;
      const ccompany = body.company ? String(body.company) : null;
      // Filtro por presencia de foto: 'with' | 'without' | null (todos).
      const cphoto = (body.photo === 'with' || body.photo === 'without') ? body.photo : null;
      if (admin.codes !== null && !admin.codes.length) return json({ ok: true, rows: [] });
      const rows = await sb(env, 'rpc/personnel_incomplete', {
        method: 'POST',
        body: JSON.stringify({
          p_codes: admin.codes,
          p_fields: fields,
          p_zone: zone, p_subzone: subzone, p_concept: concept, p_status: cstatus,
          p_limit: 5000,
          p_admin_id: admin.role === 'superadmin' ? null : admin.id,
          p_type: ctype, p_company: ccompany, p_photo: cphoto,
        }),
      });
      return json({ ok: true, rows: withThumbs(env, rows), fields });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
