/* =====================================================================
   functions/api/roster.js  →  /api/roster
   Lista de personal de cada tienda (snapshot del Reporte 10 del POS).
   El frontend lee el .xlsx con SheetJS y envia las filas ya extraidas
   como JSON; este Worker valida, detecta egresados y responsables
   (segun las reglas configurables de manager_role_rules), y REEMPLAZA
   por completo el snapshot.

   Acciones (POST {action}):
     - get     : devuelve el snapshot actual + metadatos de la tienda.
                 { action:'get', company_code }
     - replace : valida y reemplaza el snapshot con las filas del Reporte 10.
                 { action:'replace', company_code, uploaded_by?, source_file?,
                   rows:[{ id_number, full_name, role, has_biometric,
                           start_date, end_date }] }
                 Devuelve un resumen de validacion (cuantos, egresados,
                 responsables detectados) y precarga store_contacts con los
                 gerentes/subgerentes si la tienda no tiene responsables.
     - clear   : borra COMPLETAMENTE la lista de la tienda (store_workers +
                 store_roster_meta). Opcionalmente tambien los responsables.
                 { action:'clear', company_code, wipe_contacts? }

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

// Detecta el rol de responsable a partir del cargo del Reporte 10, usando
// las reglas configurables de manager_role_rules (ya cargadas y ordenadas
// por sort_order asc). Gana la PRIMERA regla cuyo patron este contenido en
// el cargo. Devuelve la etiqueta (result_role) o null si ninguna coincide.
// Si no hay reglas configuradas, cae al comportamiento clasico (GERENTE /
// SUB) para no quedar sin deteccion ante una tabla vacia.
function detectManagerRole(rawRole, rules) {
  const r = (rawRole || '').toUpperCase();
  if (!r) return null;
  if (Array.isArray(rules) && rules.length) {
    for (const rule of rules) {
      const pat = String(rule.pattern || '').toUpperCase().trim();
      if (pat && r.includes(pat)) return rule.result_role;
    }
    return null;
  }
  // Fallback defensivo (tabla vacia): logica original.
  if (!r.includes('GERENTE')) return null;
  if (r.includes('SUB')) return 'Sub-Gerente';
  return 'Gerente';
}

// Normaliza una fila cruda del Reporte 10 a la forma de store_workers.
// Acepta tolerancia en nombres: el frontend ya manda claves limpias.
function normalizeRow(row) {
  const id_number = String(row.id_number ?? '').replace(/[^0-9]/g, '');
  const full_name = String(row.full_name ?? '').trim();
  const role = (row.role ?? '').toString().trim() || null;
  // end_date: el Reporte 10 trae 'VIGENTE' o una fecha; el front ya
  // convierte VIGENTE -> null y las fechas a 'YYYY-MM-DD'.
  const end_date = row.end_date ? String(row.end_date).slice(0, 10) : null;
  const start_date = row.start_date ? String(row.start_date).slice(0, 10) : null;
  const has_biometric = row.has_biometric == null ? true : !!row.has_biometric;
  return { id_number, full_name, role, end_date, start_date, has_biometric };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido' }, 400); }

  const action = body.action;
  try {
    if (action === 'get') {
      const cc = (body.company_code || '').trim();
      if (!cc) return json({ ok: false, error: 'Falta company_code' }, 400);
      const workers = await sb(env,
        `store_workers?company_code=eq.${encodeURIComponent(cc)}`
        + `&select=id_number,full_name,role,has_biometric,start_date,end_date,is_active&order=full_name.asc`);
      const metaArr = await sb(env,
        `store_roster_meta?company_code=eq.${encodeURIComponent(cc)}`
        + `&select=uploaded_at,uploaded_by,total_count,active_count,source_file`);
      const meta = metaArr && metaArr[0] ? metaArr[0] : null;
      return json({ ok: true, workers: workers || [], meta });
    }

    if (action === 'replace') {
      const cc = (body.company_code || '').trim();
      if (!cc) return json({ ok: false, error: 'Falta company_code' }, 400);
      const rawRows = Array.isArray(body.rows) ? body.rows : [];
      if (!rawRows.length) return json({ ok: false, error: 'El Reporte 10 no trae filas.' }, 400);

      // Validacion + normalizacion
      const warnings = [];
      const seen = new Set();
      const valid = [];
      let noCargo = 0;
      for (const raw of rawRows) {
        const r = normalizeRow(raw);
        // columnas esenciales: cedula y nombre
        if (!r.id_number || r.id_number.length < 6 || r.id_number.length > 8) continue;
        if (!r.full_name) continue;
        if (seen.has(r.id_number)) continue; // dedup por cedula
        seen.add(r.id_number);
        if (!r.role) noCargo++;
        valid.push(r);
      }
      if (!valid.length) return json({ ok: false, error: 'Ninguna fila valida (revisa columnas Cedula y Nombre).' }, 400);
      if (noCargo) warnings.push(`Columna "Cargo" vacia en ${noCargo} fila(s) (se cargan igual).`);

      const activos = valid.filter(r => !r.end_date);
      const egresados = valid.filter(r => r.end_date);

      // Reglas configurables de clasificacion de cargo -> responsable.
      // Se leen de manager_role_rules (activas, por orden). Si la tabla
      // esta vacia, detectManagerRole cae a la logica clasica.
      const roleRules = await sb(env,
        'manager_role_rules?is_active=eq.true&select=pattern,result_role&order=sort_order.asc');

      // Responsables detectados (gerentes/subgerentes vigentes)
      const managers = activos
        .map(r => ({ ...r, mrole: detectManagerRole(r.role, roleRules) }))
        .filter(r => r.mrole);
      const nGer = managers.filter(m => m.mrole === 'Gerente').length;
      const nSub = managers.filter(m => m.mrole === 'Sub-Gerente').length;

      // --- Reemplazo del snapshot (borra e inserta) ---
      await sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });

      const payload = valid.map(r => ({
        company_code: cc,
        id_number: r.id_number,
        full_name: r.full_name,
        role: r.role,
        has_biometric: r.has_biometric,
        start_date: r.start_date,
        end_date: r.end_date,
        is_active: !r.end_date,
      }));
      await sb(env, 'store_workers', { method: 'POST', body: JSON.stringify(payload) });

      // Metadatos del snapshot (upsert)
      await sb(env, 'store_roster_meta', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          company_code: cc,
          uploaded_at: new Date().toISOString(),
          uploaded_by: (body.uploaded_by || '').trim() || null,
          total_count: valid.length,
          active_count: activos.length,
          source_file: (body.source_file || '').trim() || null,
        }),
      });

      // Precargar/RENOVAR responsables detectados del Reporte 10.
      // Regla: los responsables con source 'report10' se RENUEVAN con cada
      // carga (se borran los viejos y se siembran los gerentes/subgerentes
      // del nuevo Reporte 10). Los responsables 'manual' (agregados a mano
      // por la tienda/admin) NO se tocan: se conservan siempre.
      // Asi, al subir un Reporte 10 nuevo, los gerentes quedan actualizados
      // sin pisar lo que la tienda gestiono manualmente.
      let contactsSeeded = 0;
      // 1) Borrar (baja logica) los responsables 'report10' previos.
      await sb(env,
        `store_contacts?company_code=eq.${encodeURIComponent(cc)}&source=eq.report10`,
        { method: 'DELETE' });
      // 2) Cuantos 'manual' activos quedan (para respetar el tope de 4).
      const manualLeft = await sb(env,
        `store_contacts?company_code=eq.${encodeURIComponent(cc)}&is_active=eq.true&select=id`);
      const room = Math.max(0, 4 - ((manualLeft && manualLeft.length) || 0));
      // 3) Sembrar los gerentes/subgerentes del nuevo Reporte 10, evitando
      //    duplicar una cedula que ya este como responsable manual.
      if (room > 0 && managers.length) {
        const manualCeds = new Set();
        // Releer los manuales con su cedula para no duplicar.
        const manualRows = await sb(env,
          `store_contacts?company_code=eq.${encodeURIComponent(cc)}&is_active=eq.true&select=id_number`);
        (manualRows || []).forEach(m => { if (m.id_number) manualCeds.add(m.id_number); });
        const seed = managers
          .filter(m => !manualCeds.has(m.id_number))
          .slice(0, room)
          .map(m => ({
            company_code: cc,
            full_name: m.full_name,
            role: m.mrole,
            id_number: m.id_number,
            source: 'report10',
          }));
        if (seed.length) {
          try {
            await sb(env, 'store_contacts', { method: 'POST', body: JSON.stringify(seed) });
            contactsSeeded = seed.length;
          } catch (e) { /* el trigger de max 4 no deberia saltar con <=4 */ }
        }
      }

      return json({
        ok: true,
        summary: {
          total: valid.length,
          active: activos.length,
          terminated: egresados.length,
          managers: managers.length,
          gerentes: nGer,
          subgerentes: nSub,
          contacts_seeded: contactsSeeded,
          warnings,
        },
      });
    }

    if (action === 'clear') {
      const cc = (body.company_code || '').trim();
      if (!cc) return json({ ok: false, error: 'Falta company_code' }, 400);
      // Borra la lista y sus metadatos. mark_report_lines NO se toca:
      // los reportes ya enviados conservan su detalle historico.
      await sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });
      await sb(env, `store_roster_meta?company_code=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });
      let contactsWiped = false;
      if (body.wipe_contacts) {
        await sb(env, `store_contacts?company_code=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });
        contactsWiped = true;
      }
      return json({ ok: true, cleared: true, contacts_wiped: contactsWiped });
    }

    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
