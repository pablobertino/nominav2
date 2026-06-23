/* =====================================================================
   functions/api/catalog.js  →  POST /api/catalog
   Devuelve el catálogo para el panel, FILTRADO según quién pregunta:
     - superadmin: todas las companies
     - admin: solo las companies dentro de su alcance (get_admin_companies)
     - tienda: solo su propia company

   Body: { user: {kind, id, role, companyCode} }  (la sesión del cliente)
   Zonas/subzonas/conceptos se devuelven completos (catálogo de referencia).

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

async function sb(env, path, opts = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2',
      'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}

/** Revalida el usuario contra la BD y devuelve el set de companies permitidas.
 *  null = todas (superadmin). Set = lista explícita. Set vacío = ninguna. */
async function allowedSet(env, user) {
  if (!user) return new Set();
  // Usuario de tienda: solo su propia company
  if (user.kind === 'company') {
    if (!user.companyCode) return new Set();
    // revalidar que el acceso existe y está activo
    const u = await sb(env, `company_users?company_code=eq.${encodeURIComponent(user.companyCode)}&is_active=eq.true&select=company_code`);
    return new Set((u || []).map(r => r.company_code));
  }
  // Admin / superadmin: revalidar contra admin_users
  if (user.kind === 'admin' && user.id) {
    const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role`);
    if (!a || !a.length) return new Set();
    if (a[0].role === 'superadmin') return null; // todas
    const rows = await sb(env, 'rpc/get_admin_companies', {
      method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
    });
    return new Set((rows || []).map(r => r.company_code));
  }
  return new Set();
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const user = body.user || null;

  try {
    // --- Catalogo de causas de marcaje (para el wizard de marcaje) ---
    if (body.action === 'marcaje_causas') {
      const causas = await sb(env, 'marcaje_causas?is_active=eq.true&select=code,label,is_other&order=sort_order');
      return json({ ok: true, causas: causas || [] });
    }

    // --- Catalogo de causas de egreso sin carta (para el wizard de egreso) ---
    // waives_document: si la causa exime el documento (no queda pendiente).
    if (body.action === 'egress_causes') {
      const causas = await sb(env, 'egress_doc_causes?is_active=eq.true&select=code,label,waives_document&order=sort_order');
      return json({ ok: true, causas: causas || [] });
    }

    // --- Catalogos del wizard de INGRESO (cargos + bancos + operadoras + ventana) ---
    // Una sola llamada para llenar el formulario de Alta. Todo configurable
    // por ABM. Cargos: solo los activos y marcados para ingreso, con label
    // (lo ve la tienda) y ax_code (lo que se exporta). Bancos/operadoras:
    // prefijo de 4 digitos -> nombre. La ventana de fecha se calcula con el
    // corte global + el tope futuro de ingreso/egreso (hora Venezuela).
    if (body.action === 'ingreso_catalogs') {
      const cargos = await sb(env, 'cargos?is_active=eq.true&selectable_on_ingreso=eq.true&select=code,label,ax_code,sort_order&order=sort_order');
      const bancos = await sb(env, 'bancos?is_active=eq.true&select=code,name,sort_order&order=sort_order');
      const operadoras = await sb(env, 'operadoras?is_active=eq.true&select=code,name,sort_order&order=sort_order');
      // Recaudos del ingreso (required_docs con incidence_code='ingreso', activos).
      // El modal de Alta los pide por trabajador; el envio los manda como
      // tickets DOC (uno por recaudo y por persona). enforcement: block/warn/optional.
      const docs = await sb(env, 'required_docs?incidence_code=eq.ingreso&is_active=eq.true&select=id,name,note,enforcement,is_required,sort_order&order=sort_order');
      const settings = await sb(env, 'app_settings?key=in.(corte_hora_limite,corte_margen_dias,futuro_ingreso_egreso_dias,doc_max_file_mb,doc_max_total_mb,doc_allowed_ext)&select=key,value');
      const sm = {};
      (settings || []).forEach(s => { sm[s.key] = s.value; });
      return json({
        ok: true,
        cargos: (cargos || []).map(c => ({ code: c.code, label: c.label, ax_code: c.ax_code || c.code })),
        bancos: (bancos || []).map(b => ({ code: b.code, name: b.name })),
        operadoras: (operadoras || []).map(o => ({ code: o.code, name: o.name })),
        docs: (docs || []).map(d => ({
          id: d.id, name: d.name, note: d.note || null,
          enforcement: d.enforcement || 'warn', is_required: d.is_required !== false,
        })),
        doc_limits: {
          max_file_mb: parseFloat(sm.doc_max_file_mb) || 2,
          max_total_mb: parseFloat(sm.doc_max_total_mb) || 20,
          allowed_ext: (sm.doc_allowed_ext || 'jpg,jpeg,png,pdf,doc,docx')
            .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
        },
        window_config: {
          cutoff_time: sm.corte_hora_limite || '14:00',
          margin_days: parseInt(sm.corte_margen_dias, 10) || 2,
          future_days: parseInt(sm.futuro_ingreso_egreso_dias, 10) || 7,
        },
      });
    }

    // --- Catalogo de tipos de ausencia + documentos requeridos (wizard de ausencia) ---
    if (body.action === 'absence_types') {
      const types = await sb(env, 'absence_types?is_active=eq.true&select=code,label,ax_code,allows_future,note,past_window_days,past_uses_cutoff,future_window_days&order=sort_order');
      // Documentos requeridos por tipo (uno por absence_code, normalmente 0 o 1).
      const docs = await sb(env, 'required_docs?is_active=eq.true&absence_code=not.is.null&select=id,absence_code,name,note,enforcement,is_required&order=sort_order');
      // Hora limite y margen global del corte (para los tipos con past_uses_cutoff).
      const settings = await sb(env, 'app_settings?key=in.(corte_hora_limite,corte_margen_dias)&select=key,value');
      const settingsMap = {};
      (settings || []).forEach(s => { settingsMap[s.key] = s.value; });
      const cutoffTime = settingsMap.corte_hora_limite || '14:00';
      const globalMargin = parseInt(settingsMap.corte_margen_dias, 10) || 2;
      // Adjuntar a cada tipo su(s) documento(s).
      const docsByCode = {};
      (docs || []).forEach(d => {
        (docsByCode[d.absence_code] = docsByCode[d.absence_code] || []).push({
          id: d.id, name: d.name, note: d.note || null,
          enforcement: d.enforcement || 'warn', is_required: d.is_required !== false,
        });
      });
      const out = (types || []).map(t => ({
        code: t.code, label: t.label, ax_code: t.ax_code || t.code,
        allows_future: !!t.allows_future, note: t.note || null,
        // Ventanas de fecha configurables por tipo.
        past_window_days: (t.past_window_days === null || t.past_window_days === undefined) ? null : t.past_window_days,
        past_uses_cutoff: !!t.past_uses_cutoff,
        future_window_days: t.future_window_days || 0,
        docs: docsByCode[t.code] || [],
      }));
      return json({ ok: true, types: out, cutoff_time: cutoffTime, global_margin: globalMargin });
    }

    const allowed = await allowedSet(env, user); // null=todas | Set

    const [companies, zones, subzones, concepts, users] = await Promise.all([
      sb(env, 'companies?select=company_code,business_name,tax_id,zone_id,subzone_id,concept_id,company_type,status,is_active,email,phone,phone2&order=company_code'),
      sb(env, 'zones?select=id,name,letter&order=name'),
      sb(env, 'subzones?select=id,name,letter,zone_id&order=name'),
      sb(env, 'concepts?select=id,name&order=name'),
      sb(env, 'company_users?select=company_code'),
    ]);

    const withAccess = new Set(users.map(u => u.company_code));
    const zoneName = Object.fromEntries(zones.map(z => [z.id, z.name]));
    const subName  = Object.fromEntries(subzones.map(s => [s.id, s.name]));
    const conName  = Object.fromEntries(concepts.map(c => [c.id, c.name]));

    let rows = companies.map(c => ({
      code: c.company_code,
      name: c.business_name,
      taxId: c.tax_id,
      zone: zoneName[c.zone_id] || null,
      zoneId: c.zone_id,
      subzone: subName[c.subzone_id] || null,
      subzoneId: c.subzone_id,
      concept: conName[c.concept_id] || null,
      type: c.company_type,
      status: c.status,
      isActive: c.is_active,
      email: c.email || null,
      phone: c.phone || null,
      phone2: c.phone2 || null,
      hasAccess: withAccess.has(c.company_code),
    }));

    // Aplicar filtro de alcance (si no es superadmin)
    if (allowed !== null) {
      rows = rows.filter(r => allowed.has(r.code));
    }

    return json({ ok: true, companies: rows, zones, subzones, concepts });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
