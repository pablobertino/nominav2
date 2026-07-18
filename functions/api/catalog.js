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

    // --- Catalogo de MOTIVOS de egreso (por que se va el trabajador) ---
    // Distinto de egress_causes (que es por que no se adjunta la carta).
    // Lo elige la tienda; el motivo es OBLIGATORIO en el reporte de egreso.
    if (body.action === 'egress_reasons') {
      const reasons = await sb(env, 'egress_reasons?is_active=eq.true&select=code,label,is_other&order=sort_order');
      return json({ ok: true, reasons: reasons || [] });
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

    // --- Catalogo del wizard de MODIFICACION (campos modificables + cargos/bancos/operadoras) ---
    // Devuelve los campos activos del catalogo modificacion_fields (que se
    // pueden cambiar) + los catalogos necesarios para validar cargo/cuenta/
    // telefono cuando esos campos esten activos. No hay ventana de fechas
    // (date_rule = none): la modificacion no se ata al corte.
    if (body.action === 'modificacion_catalogs') {
      const fields = await sb(env, 'modificacion_fields?is_active=eq.true&select=code,label,ax_column,input_kind,note,sort_order&order=sort_order');
      const cargos = await sb(env, 'cargos?is_active=eq.true&selectable_on_ingreso=eq.true&select=code,label,ax_code,sort_order&order=sort_order');
      const bancos = await sb(env, 'bancos?is_active=eq.true&select=code,name,sort_order&order=sort_order');
      const operadoras = await sb(env, 'operadoras?is_active=eq.true&select=code,name,sort_order&order=sort_order');
      return json({
        ok: true,
        fields: (fields || []).map(f => ({
          code: f.code, label: f.label, ax_column: f.ax_column,
          input_kind: f.input_kind, note: f.note || null,
        })),
        cargos: (cargos || []).map(c => ({ code: c.code, label: c.label, ax_code: c.ax_code || c.code })),
        bancos: (bancos || []).map(b => ({ code: b.code, name: b.name })),
        operadoras: (operadoras || []).map(o => ({ code: o.code, name: o.name })),
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

    // v4.72: fin del shadow view.empresas aqui. Este listado es
    // INFRAESTRUCTURA del panel (lo usan el dashboard de la tienda, las
    // fichas y los wizards, no solo la vista Empresas), asi que gatearlo
    // con view.empresas era un falso positivo: generaba ~63 discrepancias
    // por mes de tiendas cargando SU propia empresa. El gate real es la
    // SESION VALIDA + el alcance de allowedSet (superadmin=todas; admin=su
    // alcance; tienda=solo su empresa). Sesion invalida -> 403.
    if (allowed !== null && allowed.size === 0) {
      return json({ ok: false, error: 'Sesion no valida.' }, 403);
    }

    const [companies, zones, subzones, concepts, users,
           storeMeta, entMeta, staffCounts, depts, photoCov, breakdown] = await Promise.all([
      sb(env, 'companies?select=company_code,business_name,tax_id,data_area,zone_id,subzone_id,concept_id,company_type,status,is_active,email,phone,phone2,address,city,state,municipality,ax_modified_at&order=company_code'),
      sb(env, 'zones?select=id,name,letter&order=name'),
      sb(env, 'subzones?select=id,name,letter,zone_id&order=name'),
      sb(env, 'concepts?select=id,name&order=name'),
      sb(env, 'company_users?select=company_code'),
      // Metadatos de la ultima carga de personal (tienda / empresa no-tienda).
      sb(env, 'store_roster_meta?select=company_code,uploaded_at,uploaded_by,total_count,source,auto_refreshed_at'),
      sb(env, 'enterprise_roster_meta?select=company_code,uploaded_at,uploaded_by,row_count,source'),
      // Conteo de personal por empresa, AGREGADO en la BD (vista). Antes se
      // traia todo store_workers para contar en el cliente, pero PostgREST
      // corta en 1000 filas y hay >1000, asi que muchas empresas quedaban
      // sub-contadas o en cero. La vista devuelve una fila por empresa.
      sb(env, 'v_company_staff_count?select=company_code,n'),
      // Departamentos por empresa (para el conteo que se muestra en el boton
      // "Departamentos" de la grilla de Empresas). Solo cuenta los ACTIVOS.
      sb(env, 'departments?is_active=eq.true&select=company_code'),
      // Cobertura de fotos por empresa (chip "% con foto" de la celda
      // Personal): total del roster vs cuantos tienen photo_key en
      // workers_master. Una sola llamada agregada (rpc get_photo_coverage).
      sb(env, 'rpc/get_photo_coverage', { method: 'POST', body: '{}' }),
      // v6.17: desglose de la QUINCENA EN CURSO por empresa (barrita de la
      // celda Personal): estables / nuevos / traslados / egresos. Una sola
      // llamada agregada (rpc get_roster_breakdown, quincena Caracas).
      sb(env, 'rpc/get_roster_breakdown', { method: 'POST', body: '{}' }),
    ]);

    const withAccess = new Set(users.map(u => u.company_code));
    const zoneName = Object.fromEntries(zones.map(z => [z.id, z.name]));
    const subName  = Object.fromEntries(subzones.map(s => [s.id, s.name]));
    const conName  = Object.fromEntries(concepts.map(c => [c.id, c.name]));

    // --- Indice de personal por empresa (cantidad + meta de carga) ---
    // Total de personal: una fila por empresa desde la vista agregada.
    const countByCompany = {};
    (staffCounts || []).forEach(r => { countByCompany[r.company_code] = (countByCompany[r.company_code] || 0) + (r.n || 0); });

    // Conteo de departamentos (activos) por empresa, para el boton
    // "Departamentos" de la grilla. Se muestra en empresas no-tienda.
    const deptCountByCompany = {};
    (depts || []).forEach(d => { deptCountByCompany[d.company_code] = (deptCountByCompany[d.company_code] || 0) + 1; });

    // Cobertura de fotos por empresa: { code: { total, with_photo } }.
    const photoByCompany = {};
    (photoCov || []).forEach(p => { photoByCompany[p.company_code] = { total: p.total || 0, withPhoto: p.with_photo || 0 }; });

    // v6.17: desglose de la quincena en curso por empresa (barrita).
    const bkByCompany = {};
    (breakdown || []).forEach(b => {
      bkByCompany[b.company_code] = {
        est: b.estables || 0, nue: b.nuevos || 0,
        tra: b.traslados_q || 0, egr: b.egresos_q || 0,
      };
    });

    // Meta (fecha, quien, metodo) por empresa. Cada empresa esta en UNA de las
    // dos tablas segun su tipo, asi que no hay colision.
    const metaByCompany = {};
    (storeMeta || []).forEach(m => {
      metaByCompany[m.company_code] = {
        count: m.total_count, uploaded_at: m.uploaded_at,
        uploaded_by: m.uploaded_by, source: m.source || null,
        auto_refreshed_at: m.auto_refreshed_at || null,   // v6.17: frescura 🔄
      };
    });
    (entMeta || []).forEach(m => {
      metaByCompany[m.company_code] = {
        count: m.row_count, uploaded_at: m.uploaded_at,
        uploaded_by: m.uploaded_by, source: m.source || null,
      };
    });

    let rows = companies
      // v6.18 (pedido de Pablo): las empresas de tipo "Ninguno" (nuevas de
      // AX sin configurar: sin lista, sin contacto) NO viajan al front. Con
      // este unico corte desaparecen de la vista Empresas, de las stat
      // cards, de los conteos y del modal Sincronizar personal (que opera
      // sobre las visibles). En BD siguen vivas: el pull las mantiene, y el
      // dia que en AX les asignen tipo aparecen solas.
      .filter(c => (c.company_type || '') !== 'Ninguno')
      .map(c => {
      const meta = metaByCompany[c.company_code] || null;
      return {
        code: c.company_code,
        name: c.business_name,
        taxId: c.tax_id,
        dataArea: c.data_area || null,
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
        // Direccion (para el modal de Empresas; NO se muestra en la grilla).
        address: c.address || null,
        city: c.city || null,
        state: c.state || null,
        municipality: c.municipality || null,
        hasAccess: withAccess.has(c.company_code),
        // Personal: cantidad (cuenta real de filas) + meta de la ultima carga.
        staffCount: countByCompany[c.company_code] || 0,
        // Cobertura de fotos (chip de la celda Personal): cuantos del roster
        // tienen foto. El total del RPC puede diferir minimamente del
        // staffCount de la vista; el % se calcula con photoTotal.
        photoCount: (photoByCompany[c.company_code] || {}).withPhoto || 0,
        photoTotal: (photoByCompany[c.company_code] || {}).total || 0,
        // Cantidad de departamentos activos (para el boton "Departamentos").
        deptCount: deptCountByCompany[c.company_code] || 0,
        rosterAt: meta ? meta.uploaded_at : null,
        rosterBy: meta ? meta.uploaded_by : null,
        rosterSource: meta ? meta.source : null,
        // v6.17: frescura de la corrida automatica + barrita de la quincena
        // en curso (estables / nuevos / traslados / egresos).
        autoRefreshedAt: meta ? (meta.auto_refreshed_at || null) : null,
        bkEst: (bkByCompany[c.company_code] || {}).est || 0,
        bkNew: (bkByCompany[c.company_code] || {}).nue || 0,
        bkTras: (bkByCompany[c.company_code] || {}).tra || 0,
        bkEgr: (bkByCompany[c.company_code] || {}).egr || 0,
        // v6.18: ultima modificacion de la empresa en AX (modifiedDateTime;
        // 1900-01-01 ya llega como NULL desde sync-companies).
        axModifiedAt: c.ax_modified_at || null,
      };
    });

    // Aplicar filtro de alcance (si no es superadmin)
    if (allowed !== null) {
      rows = rows.filter(r => allowed.has(r.code));
    }

    return json({ ok: true, companies: rows, zones, subzones, concepts });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
