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

/* ===================== v5.46: QUIEN TOCO EL DATO, DESDE LA BASE =====================

   v5.45 salia a preguntarle al sistema el bloque `auditoria` CADA VEZ que
   alguien abria esta pagina. Estaba mal por dos razones:

   1. COSTABA UNA LLAMADA POR EMPRESA, EN CADA VISITA. Abrir Pendientes cinco
      veces eran quince llamadas al sistema para leer un dato que no cambia.

   2. LA FOTO NO CORRESPONDIA. El conflicto se detecto en la corrida de las
      16:50, contra el valor que el sistema tenia a las 16:50. Si a las 18:00
      alguien abre la pagina y le preguntamos al sistema "quien toco esto", la
      respuesta puede ser de OTRO cambio, posterior al conflicto que estamos
      mostrando. El "quien" no se corresponderia con el "que".

   Ahora la sincronizacion guarda el quien/cuando DENTRO de ax_diff_fields, en
   el mismo instante en que detecta el conflicto (v5.46 de sync-roster.js):

     "telefono": {
       "estado": "conflicto",
       "portal": "+584248494408",
       "sistema": "04123570189",
       "sistema_por": "ISMAEL.M",              <- quien lo toco en el sistema
       "sistema_el": "2025-11-17T20:16:16Z"    <- cuando
     }

   Esta pagina ya no llama a la API: lee de Postgres. Es la foto del momento en
   que se detecto el conflicto, que es exactamente lo que hay que mostrar.

   ⚠ Las fichas marcadas ANTES de v5.46 no tienen estos campos. Se muestran sin
   la linea de "quien", que es correcto: no lo sabemos. La proxima corrida las
   completa sola. */

/* El change_set guarda los campos con el nombre INTERNO (phone, email,
   account_number); ax_diff_fields usa el nombre CORTO (telefono, correo,
   cuenta). Sin este puente, la atribucion del portal no encontraria nunca su
   campo y la linea de "quien edito" no saldria jamas. */
const CAMPO_A_INTERNO = {
  telefono: 'phone',
  correo: 'email',
  cuenta: 'account_number',
};

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

  /* ===================== ADOPTAR (v5.47) =====================
     Escribe en el portal EL VALOR QUE MUESTRA LA PANTALLA. No vuelve a
     preguntarle al sistema.

     Antes esto llamaba a /api/ax-review action:adopt, que RE-DETECTA contra AX
     antes de escribir. Dos problemas:

     1. Tardaba varios segundos por cada clic (una llamada a la API por ficha).

     2. ⚠ EL PELIGROSO: podia escribir un valor QUE EL USUARIO NUNCA VIO. Si
        entre la sincronizacion y el clic alguien cambiaba el dato en AX, el
        boton adoptaba el valor NUEVO, no el que estaba en pantalla. En una
        cuenta bancaria eso es plata a una cuenta que nadie aprobo.

     Ahora: lo que ves es lo que se escribe. Si el dato cambio en AX despues, la
     proxima corrida lo vuelve a marcar como un conflicto nuevo — que es
     exactamente lo correcto: es una diferencia nueva, y merece una decision
     nueva.

     El valor sale de ax_diff_fields (lo que la ultima sincronizacion leyo del
     sistema), no del cuerpo del pedido: el front NO decide que se escribe. Si
     el front mandara el valor, cualquiera podria escribir lo que quisiera en
     workers_master con un pedido armado a mano. */
  if (body.action === 'adopt') {
    if (!can(actor, 'hcm.sync')) {
      return json({ ok: false, error: 'No tienes permiso para adoptar datos del sistema.' }, 403);
    }
    const ced = String(body.id_number || '').replace(/[^0-9]/g, '');
    if (!ced) return json({ ok: false, error: 'Falta la c\u00e9dula.' }, 400);

    const rows = await sb(env,
      `workers_master?id_number=eq.${encodeURIComponent(ced)}`
      + '&select=id_number,last_source_company,ax_diff,ax_diff_fields&limit=1');
    const w = rows && rows[0];
    if (!w) return json({ ok: false, error: 'No se encontr\u00f3 la ficha.' }, 404);
    if (!inScope(w.last_source_company || '')) {
      return json({ ok: false, error: 'Esa ficha no est\u00e1 en tu alcance.' }, 403);
    }
    if (!w.ax_diff) return json({ ok: true, count: 0, already: true });

    const ff = (w.ax_diff_fields && typeof w.ax_diff_fields === 'object') ? w.ax_diff_fields : {};

    /* Solo se adopta lo que se PUEDE adoptar:
         - conflicto  -> el sistema tiene un valor valido. Se toma.
         - dato_roto  -> el sistema lo tiene MAL. Adoptarlo seria romper el
                         portal a proposito. Se deja como esta.
       Si la ficha era toda dato_roto, no hay nada que hacer y se dice. */
    const patch = {};
    let rotos = 0;
    for (const [campo, d] of Object.entries(ff)) {
      if (!d || typeof d !== 'object') continue;
      if (d.estado === 'dato_roto') { rotos++; continue; }
      const col = CAMPO_A_INTERNO[campo];
      if (!col) continue;
      if (d.sistema == null || d.sistema === '') continue;
      patch[col] = String(d.sistema);
    }

    if (!Object.keys(patch).length) {
      return json({ ok: false, count: 0,
        error: rotos
          ? 'El sistema tiene estos datos mal escritos: no hay nada que adoptar. Hay que corregirlos all\u00e1.'
          : 'No hay ning\u00fan valor del sistema para adoptar.' }, 400);
    }

    /* La marca se limpia junto con la escritura: el conflicto quedo resuelto.
       Si mas adelante vuelven a diferir, la proxima corrida lo marca de nuevo. */
    patch.ax_diff = false;
    patch.ax_diff_fields = null;
    patch.ax_diff_at = null;

    await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });

    return json({ ok: true, count: Object.keys(patch).length - 3, skipped_broken: rotos });
  }

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

    /* ---------- QUIEN EDITO EN EL PORTAL ----------
       Sale del ax_change_set (la bitacora de ediciones del portal). El "quien"
       del lado del SISTEMA no se consulta: ya viene guardado dentro de
       ax_diff_fields, escrito por la sincronizacion en el momento de detectar
       el conflicto. Esta pagina NO llama a la API. */
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
      const pe = portalEditBy[ced] || null;

      const fields = [];
      for (const [campo, d] of Object.entries(ff)) {
        if (!d || typeof d !== 'object') continue;

        /* Quien lo toco en el PORTAL. Solo se atribuye si ESE campo esta en el
           change_set: si la tienda edito el correo, no se le puede endilgar
           tambien el telefono. Se prueban los dos nombres (corto e interno)
           porque las dos tablas los llaman distinto. */
        const interno = CAMPO_A_INTERNO[campo] || campo;
        const editoEsteCampo = pe && Array.isArray(pe.fields)
          && (pe.fields.includes(campo) || pe.fields.includes(interno));

        fields.push({
          campo,
          estado: d.estado || 'conflicto',
          portal: d.portal != null ? String(d.portal) : null,
          sistema: d.sistema != null ? String(d.sistema) : null,
          // Procedencia del dato del portal (si alguien lo edito y no publico).
          portal_by: editoEsteCampo ? (pe.by || null) : null,
          portal_at: editoEsteCampo ? (pe.at || null) : null,
          /* Procedencia del dato del sistema. Guardado por la sincronizacion en
             el momento de detectar el conflicto (v5.46). Las fichas marcadas
             antes de eso no lo tienen: van en null y la pagina no muestra la
             linea, que es lo correcto (no lo sabemos). */
          sistema_by: d.sistema_por || null,
          sistema_at: d.sistema_el || null,
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
        /* v5.48: cuantas tiendas recorrio. La pagina lo usa para encabezar con
           EL HECHO ("corrio el 13/07 a las 16:50 sobre 132 tiendas") en vez de
           soltar tres numeros sin contexto. Sale del resumen de la corrida, que
           ya lo tenia guardado. */
        stores: (cfg.last_summary && cfg.last_summary.stores != null)
          ? cfg.last_summary.stores : null,
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
