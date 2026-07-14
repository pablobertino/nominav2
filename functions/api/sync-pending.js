/* =====================================================================
   functions/api/sync-pending.js  →  POST /api/sync-pending
   PENDIENTES DE SINCRONIZACION (v5.40).

   La bandeja de lo que la sincronizacion encontro y NECESITA UNA DECISION.
   Junta en un solo lugar tres cosas que hasta ahora estaban enterradas en el
   detalle expandible del Registro (donde nadie las veia):

     1. HAY QUE DECIDIR  (estado acumulado, vive en workers_master.ax_diff)
        Los dos lados tienen dato y no coinciden. Alguien tiene que elegir.
        Se resuelve con los botones que YA EXISTEN en /api/ax-review:
          - adopt          -> el valor del sistema entra al portal
          - detect_commit  -> el valor del portal se manda al sistema (Publicar)

     2. MAL ESCRITOS EN EL SISTEMA  (novedad, sale de la ULTIMA corrida)
        El sistema mando un correo sin arroba, un telefono con un prefijo que
        no existe. No se guardaron. No hay nada que decidir: estan rotos y se
        arreglan en el sistema. Aca solo se ven y se exportan.

     3. TIENDAS SALTADAS  (novedad, sale de la ULTIMA corrida)
        El sistema devolvio una lista sospechosamente corta y el portal
        prefirio no tocar nada antes que dar de baja a gente que trabaja.

   POR QUE 1 ES ESTADO Y 2/3 SON NOVEDADES:
   Un conflicto VIVE hasta que un humano lo resuelve: por eso se guarda en el
   maestro y se lee de ahi. Un dato roto en el sistema, en cambio, se arregla
   ALLA — y cuando se arregla, la proxima corrida deja de reportarlo solo. No
   necesita una tabla de estado que alguien tenga que mantener al dia; alcanza
   con leer la ultima corrida. Si el numero baja, es que lo arreglaron.

   POST { user|adminId }
   ->   { ok,
          conflicts: [{ id_number, full_name, company_code, fields:[
                        { campo, estado, portal, sistema } ] }],
          rejected:  [{ ced, nom, comp, campo, valor }],
          skipped:   [{ company_code, alert }],
          last_run:  { run_id, run_at, source } | null,
          counts:    { conflicts, rejected, skipped } }

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { resolveActor, can, shadowCan } from './_auth.js';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

async function sb(env, path) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2',
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

/* Miniatura publica de la foto (mismo bucket y criterio que Publicar: URL
   directa, cacheable, sin firmar). null si la ficha no tiene foto. */
const PUBLIC_THUMB_BUCKET = 'worker-thumbs';
function thumbUrlPub(env, photoKey) {
  if (!photoKey) return null;
  return `${env.supabase_url}/storage/v1/object/public/${PUBLIC_THUMB_BUCKET}/${photoKey}.jpg`;
}

/* ===================== v5.45: QUIEN TOCO EL DATO DEL OTRO LADO =====================

   El sistema SIEMPRE nos mando esto y lo estabamos tirando. Cada ficha viene
   con un bloque `auditoria`, CAMPO POR CAMPO:

     "auditoria": {
       "telefono":       { "modificadoPor": "PABLO",    "modificadoFecha": "2026-07-09T01:39:43Z" },
       "cuentaBancaria": { "modificadoPor": "LUZ.GORD", "modificadoFecha": "2026-07-06T17:54:17Z" },
       "estadoCivil":    { "modificadoPor": "th08.pmv", "modificadoFecha": "2021-11-03T14:34:35Z" }
     }

   Esto CAMBIA LA DECISION. No es lo mismo:
     - "el sistema dice 0412..."                                    <- un dato huerfano
     - "LUZ.GORD cambio la cuenta el 06/07, hace una semana"        <- alguien la valido
     - "th08.pmv toco esto en 2021"                                 <- nadie lo mira hace 5 anos

   Con la fecha de cada lado se ve CUAL ES MAS NUEVO, que suele ser el argumento
   mas fuerte para elegir.

   OJO con el eco: si el modificadoPor dice "PABLO" y la fecha coincide con una
   publicacion del portal, ese "cambio" en el sistema LO HIZO EL PORTAL. No es
   una novedad de un tercero. El front lo distingue.

   Las claves de `auditoria` usan los nombres de la API (telefono,
   cuentaBancaria), no los internos (phone, account_number). Este mapa traduce.
   `GeneroFechadeNacimiento` cubre DOS campos internos a la vez (asi lo manda el
   sistema; no es un error de tipeo nuestro). */
const AUD_KEY = {
  phone: 'telefono',
  email: 'correo',
  account_number: 'cuentaBancaria',
  first_name: 'nombres',
  second_name: 'nombres',
  last_names: 'apellidos',
  gender: 'GeneroFechadeNacimiento',
  birth_date: 'GeneroFechadeNacimiento',
  marital_status: 'estadoCivil',
  // Alias que ya usa el portal para las claves cortas del ax_diff_fields.
  telefono: 'telefono',
  correo: 'correo',
  cuenta: 'cuentaBancaria',
};

const HCM_API = 'https://api2.grupocanaima.com/empleados/datos/v1';

/* Lee el padron del sistema para una empresa y devuelve, por cedula, SOLO el
   bloque de auditoria. Null si la API no respondio: en ese caso la pagina se
   pinta igual, sin la columna de quien — un dato de contexto que falta no
   puede tumbar la bandeja. */
async function auditFor(env, cc) {
  try {
    const res = await fetch(`${HCM_API}?alias=${encodeURIComponent(cc)}`, {
      headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
    });
    if (!res.ok) return null;
    let data = await res.json();
    if (!Array.isArray(data)) data = data.empleados || data.data || data.items || [];
    const map = {};
    for (const e of data) {
      const ced = String(e.ficha ?? '').replace(/[^0-9]/g, '');
      if (ced && e.auditoria && typeof e.auditoria === 'object') map[ced] = e.auditoria;
    }
    return map;
  } catch (_) {
    return null;
  }
}

/* Empresas del alcance del actor. null = todas (superadmin). Mismo criterio
   que el resto del portal: un admin no-super solo ve lo suyo. */
async function allowedCompanies(env, actor) {
  if (actor.kind === 'admin' && actor.role === 'superadmin') return null;
  if (actor.kind !== 'admin' || !actor.id) return new Set();
  try {
    const res = await fetch(`${env.supabase_url}/rest/v1/rpc/get_admin_companies`, {
      method: 'POST',
      headers: {
        apikey: env.supabase_service_role,
        Authorization: `Bearer ${env.supabase_service_role}`,
        'Content-Profile': 'nomina_v2',
        'Accept-Profile': 'nomina_v2',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_admin_id: actor.id }),
    });
    if (!res.ok) return new Set();
    const rows = await res.json();
    return new Set((rows || []).map(r => r.company_code));
  } catch (_) {
    return new Set();
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  /* Mismo gate que el Registro (hcm.log): Pendientes y Registro son la misma
     informacion vista de dos formas — el Registro la cuenta por corrida, esto
     la junta por caso. Quien puede ver una, puede ver la otra. */
  const adminId = parseInt(body.adminId, 10) || (body.user && parseInt(body.user.id, 10)) || null;
  const actor = await resolveActor(env, body.user || (adminId ? { kind: 'admin', id: adminId } : null));
  if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
  if (!can(actor, 'hcm.log')) {
    return json({ ok: false, error: 'No tienes permiso para ver los pendientes de sincronizacion.' }, 403);
  }
  try { await shadowCan(env, body.user || { kind: 'admin', id: adminId }, 'sync-pending', body.action || 'list', 'hcm.log', true); } catch (_) { /* bitacora */ }

  /* ---------- ANULAR (v5.40) ----------
     Limpia la marca de diferencia SIN TOCAR NINGUN DATO. Ni el del portal ni el
     del sistema: los dos quedan como estan.

     Por que hace falta: hoy la unica salida de un conflicto era elegir un lado.
     Pero a veces LOS DOS estan mal, o el del portal esta bien y no se quiere
     escribir en el sistema ahora. Sin Anular, esas fichas se quedaban en la
     bandeja para siempre.

     ⚠ NO es lo mismo que el Anular de Publicar. Aquel descarta un cambio que
     estaba por enviarse al sistema (ax_change_set). Este solo apaga una
     ETIQUETA (ax_diff): el portal ya no te avisa de esa diferencia.

     La diferencia SIGUE EXISTIENDO. Si el dato cambia de alguno de los dos
     lados, la proxima sincronizacion la vuelve a marcar — y esta bien que asi
     sea: seria un conflicto distinto.

     Requiere hcm.publish: apagar un aviso de un dato que no coincide es una
     decision, no una consulta. Quien solo puede MIRAR el registro no deberia
     poder silenciarlo. */
  if (body.action === 'dismiss') {
    if (!can(actor, 'hcm.publish')) {
      return json({ ok: false, error: 'No tienes permiso para anular avisos de diferencias.' }, 403);
    }
    const ced = String(body.id_number || '').replace(/[^0-9]/g, '');
    if (!ced) return json({ ok: false, error: 'Falta la cedula.' }, 400);

    // Alcance: no se puede anular el aviso de alguien de otra empresa.
    const allowedD = await allowedCompanies(env, actor);
    if (allowedD !== null) {
      const w = await sb(env,
        `workers_master?id_number=eq.${encodeURIComponent(ced)}&select=last_source_company`);
      const cc = w && w[0] ? String(w[0].last_source_company || '') : '';
      if (!allowedD.has(cc)) {
        return json({ ok: false, error: 'No tienes alcance sobre esa ficha.' }, 403);
      }
    }

    const res = await fetch(
      `${env.supabase_url}/rest/v1/workers_master?id_number=eq.${encodeURIComponent(ced)}`, {
        method: 'PATCH',
        headers: {
          apikey: env.supabase_service_role,
          Authorization: `Bearer ${env.supabase_service_role}`,
          'Content-Profile': 'nomina_v2',
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        // Solo la etiqueta. Los datos (phone/email/account_number) NO se tocan.
        body: JSON.stringify({ ax_diff: false, ax_diff_fields: null, ax_diff_at: null }),
      });
    if (!res.ok) {
      return json({ ok: false, error: `No se pudo anular: ${res.status}` }, 500);
    }
    return json({ ok: true, dismissed: ced });
  }

  const allowed = await allowedCompanies(env, actor);
  if (allowed !== null && !allowed.size) {
    return json({ ok: true, conflicts: [], rejected: [], skipped: [], last_run: null,
                  counts: { conflicts: 0, rejected: 0, skipped: 0 } });
  }
  const inScope = (cc) => allowed === null || allowed.has(String(cc || ''));

  try {
    /* ---------- 1. HAY QUE DECIDIR (estado acumulado) ----------
       Sale del maestro, no de una corrida: la marca vive hasta que alguien la
       resuelve. */
    const marked = await sb(env,
      'workers_master?ax_diff=eq.true'
      + '&select=id_number,ced_kind,full_name,photo_key,last_source_company,'
      + 'ax_diff_fields,ax_diff_at,ax_pending,ax_pending_at'
      + '&order=ax_diff_at.desc&limit=500') || [];

    /* v5.44: la ficha tiene que decir DE DONDE es y QUE PASO, igual que en
       Publicar. Antes solo mostraba "BG04" — un codigo que no dice ni la razon
       social, ni la zona, ni el concepto. Con 195 empresas, eso no alcanza para
       decidir nada.

       Se resuelven en bloque (no una consulta por ficha): las empresas de las
       fichas marcadas, y los nombres de sus zonas/subzonas/conceptos. */
    const ccs = [...new Set(marked.map(m => m.last_source_company).filter(Boolean))];
    const compMeta = {};
    if (ccs.length) {
      const inList = ccs.map(c => `"${c}"`).join(',');
      const comps = await sb(env,
        `companies?company_code=in.(${inList})`
        + '&select=company_code,business_name,company_type,zone_id,subzone_id,concept_id') || [];

      const nameMap = async (tbl, ids) => {
        if (!ids.length) return {};
        const q = ids.map(i => `"${i}"`).join(',');
        const rows = await sb(env, `${tbl}?id=in.(${q})&select=id,name`) || [];
        const m = {};
        rows.forEach(r => { m[String(r.id)] = r.name; });
        return m;
      };
      const zoneIds = [...new Set(comps.map(c => c.zone_id).filter(x => x != null))];
      const subIds  = [...new Set(comps.map(c => c.subzone_id).filter(x => x != null))];
      const conIds  = [...new Set(comps.map(c => c.concept_id).filter(x => x != null))];
      const [zoneN, subN, conN] = await Promise.all([
        nameMap('zones', zoneIds), nameMap('subzones', subIds), nameMap('concepts', conIds),
      ]);

      comps.forEach(c => {
        compMeta[c.company_code] = {
          name: c.business_name || null,
          type: c.company_type || null,
          zona:     c.zone_id    != null ? (zoneN[String(c.zone_id)]    || null) : null,
          subzona:  c.subzone_id != null ? (subN[String(c.subzone_id)]  || null) : null,
          concepto: c.concept_id != null ? (conN[String(c.concept_id)] || null) : null,
        };
      });
    }

    /* ---------- QUIEN TOCO CADA LADO ----------

       PORTAL: el ax_change_set guarda quien edito la ficha y cuando. Es la
       bitacora de las ediciones del portal.

       SISTEMA: el bloque `auditoria` de la API, campo por campo. Una llamada
       por empresa (son pocas: las de las fichas marcadas). Si la API no
       responde, la pagina se pinta igual sin esa columna.

       ⚠ LIMITE DE CLOUDFLARE: 50 subrequests por invocacion. Aca ya van ~6
       consultas fijas + 1 por empresa. Con 5 conflictos en 3 empresas son 9.
       Si algun dia hay conflictos en 40 empresas distintas, esto hay que
       partirlo en tandas. Por eso el tope de empresas. */
    const AUD_MAX_COMPANIES = 20;
    const audByCed = {};
    const ccsForAudit = ccs.slice(0, AUD_MAX_COMPANIES);
    for (const cc of ccsForAudit) {
      const m = await auditFor(env, cc);
      if (m) Object.assign(audByCed, m);
    }

    // Quien edito en el PORTAL (del change_set pendiente de cada ficha).
    const ceds = [...new Set(marked.map(m => String(m.id_number)))];
    const portalEditBy = {};
    if (ceds.length) {
      const inCeds = ceds.map(c => `"${c}"`).join(',');
      const sets = await sb(env,
        `ax_change_set?id_number=in.(${inCeds})&status=eq.pending`
        + '&select=id_number,changed_by,changed_at,changes') || [];
      sets.forEach(s => {
        portalEditBy[String(s.id_number)] = {
          by: s.changed_by != null ? String(s.changed_by) : null,
          at: s.changed_at || null,
          fields: (s.changes && typeof s.changes === 'object') ? Object.keys(s.changes) : [],
        };
      });
    }

    const conflicts = [];
    for (const m of marked) {
      const cc = m.last_source_company || '';
      if (!inScope(cc)) continue;
      const ff = (m.ax_diff_fields && typeof m.ax_diff_fields === 'object') ? m.ax_diff_fields : {};
      const ced = String(m.id_number);
      const aud = audByCed[ced] || null;
      const pe = portalEditBy[ced] || null;

      const fields = [];
      for (const [campo, d] of Object.entries(ff)) {
        if (!d || typeof d !== 'object') continue;

        /* Quien toco ESTE campo en el SISTEMA. La clave del bloque auditoria
           usa el nombre de la API (telefono, cuentaBancaria), no el interno. */
        const ak = AUD_KEY[campo] || campo;
        const a = (aud && aud[ak] && typeof aud[ak] === 'object') ? aud[ak] : null;

        /* Quien lo toco en el PORTAL. Solo se atribuye si ESE campo esta en el
           change_set: si la tienda edito el correo, no se le puede endilgar
           tambien el telefono. */
        const editoEsteCampo = pe && Array.isArray(pe.fields)
          && (pe.fields.includes(campo) || pe.fields.includes(ak));

        fields.push({
          campo,
          estado: d.estado || 'conflicto',
          portal: d.portal != null ? String(d.portal) : null,
          sistema: d.sistema != null ? String(d.sistema) : null,
          // Procedencia del dato del portal (si alguien lo edito y no publico).
          portal_by: editoEsteCampo ? (pe.by || null) : null,
          portal_at: editoEsteCampo ? (pe.at || null) : null,
          // Procedencia del dato del sistema (del bloque auditoria).
          sistema_by: a ? (a.modificadoPor || null) : null,
          sistema_at: a ? (a.modificadoFecha || null) : null,
        });
      }
      if (!fields.length) continue;
      const cm = compMeta[cc] || {};
      conflicts.push({
        id_number: String(m.id_number),
        ced_kind: m.ced_kind || null,
        full_name: m.full_name || String(m.id_number),
        thumb_url: m.photo_key ? thumbUrlPub(env, m.photo_key) : null,
        company_code: cc,
        company_name: cm.name || null,
        company_type: cm.type || null,
        zona: cm.zona || null,
        subzona: cm.subzona || null,
        concepto: cm.concepto || null,
        fields,
        // Cuando el portal detecto la diferencia (no cuando el dato cambio: eso
        // no lo sabemos del lado del sistema).
        at: m.ax_diff_at || null,
        // Si la ficha ADEMAS tiene un cambio del portal esperando publicarse.
        // Es informacion importante: significa que alguien ya edito esto.
        pending: !!m.ax_pending,
        pending_at: m.ax_pending_at || null,
      });
    }

    /* ---------- 2 y 3. NOVEDADES DE LA ULTIMA CORRIDA ----------
       El resumen de la config dice cual fue la ultima corrida COMPLETA
       (last_summary.run_id). Se leen sus filas del log y se juntan los
       rechazados y las tiendas saltadas de TODAS sus tandas.

       Por que la ultima y no un acumulado: si el dato se corrige en el sistema,
       la proxima corrida deja de reportarlo. Acumular obligaria a mantener un
       estado que nadie va a actualizar a mano. */
    const cfgRows = await sb(env, 'roster_sync_config?id=eq.1&select=last_run_at,last_source,last_summary') || [];
    const cfg = cfgRows[0] || null;
    const runId = cfg && cfg.last_summary && cfg.last_summary.run_id;

    const rejected = [];
    const skipped = [];
    let lastRun = null;

    if (runId) {
      const logRows = await sb(env,
        `roster_sync_log?run_id=eq.${encodeURIComponent(runId)}`
        + '&select=company_code,run_at,source,skipped,alert,rej_detail') || [];

      lastRun = {
        run_id: runId,
        run_at: cfg.last_run_at || (logRows[0] && logRows[0].run_at) || null,
        source: cfg.last_source || (logRows[0] && logRows[0].source) || null,
      };

      for (const r of logRows) {
        if (!inScope(r.company_code)) continue;
        if (Array.isArray(r.rej_detail)) {
          for (const d of r.rej_detail) {
            if (!d) continue;
            rejected.push({
              ced: d.ced ? String(d.ced) : '',
              nom: d.nom || '',
              comp: d.comp || r.company_code || '',
              campo: d.campo || '',
              valor: d.valor != null ? String(d.valor) : '',
            });
          }
        }
        if (r.skipped || r.alert) {
          skipped.push({
            company_code: r.company_code || '',
            alert: r.alert || 'Sin detalle',
          });
        }
      }
    }

    return json({
      ok: true,
      conflicts,
      rejected,
      skipped,
      last_run: lastRun,
      counts: {
        conflicts: conflicts.length,
        rejected: rejected.length,
        skipped: skipped.length,
      },
    });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}
