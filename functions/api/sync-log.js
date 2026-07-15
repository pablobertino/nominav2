/* =====================================================================
   functions/api/sync-log.js  →  POST /api/sync-log
   REGISTRO DE SINCRONIZACIONES unificado (v4.59). Solo superadmin.

   Devuelve, paginado y filtrable, el historial de corridas de los TRES
   procesos de sincronizacion programada:
     - companies : Catalogo de empresas   (tabla sync_runs)
     - pay       : Estado de pago         (tabla pay_sync_run)
     - roster    : Personal de tiendas    (roster_sync_log agrupado por
                   run_id; solo corridas CON movimiento o alerta, porque
                   las limpias no dejan filas por diseno)

   POST { user|adminId, process, page, page_size(25|50|100),
          status(''|'ok'|'error'), from(YYYY-MM-DD), to(YYYY-MM-DD) }
   ->   { ok, rows:[{run_at, source, status, duration_ms, summary,
          detail}], total, page, page_size }

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { resolveActor, can, shadowCan } from './_auth.js';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

async function sbRaw(env, path, extraHeaders = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2',
      ...extraHeaders,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res;
}
async function sb(env, path) { return (await sbRaw(env, path)).json(); }

const iso10 = (v) => {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  // v4.63: gate por MATRIZ (permiso enforced hcm.log). Antes era superadmin
  // hardcodeado; ahora se puede otorgar a otros roles desde la vista Roles.
  const adminId = parseInt(body.adminId, 10) || (body.user && parseInt(body.user.id, 10)) || null;
  const actor = await resolveActor(env, body.user || (adminId ? { kind: 'admin', id: adminId } : null));
  if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
  if (!can(actor, 'hcm.log')) {
    return json({ ok: false, error: 'No tienes permiso para ver el registro de sincronizaciones.' }, 403);
  }
  try { await shadowCan(env, body.user || { kind: 'admin', id: adminId }, 'sync-log', body.process || 'list', 'hcm.log', true); } catch (_) { /* bitacora */ }

  const process = ['companies', 'pay', 'roster', 'norehire'].includes(body.process) ? body.process : 'companies';
  const page = Math.max(1, parseInt(body.page, 10) || 1);
  const size = [25, 50, 100].includes(+body.page_size) ? +body.page_size : 25;
  const status = ['ok', 'error'].includes(body.status) ? body.status : '';
  const from = iso10(body.from);
  const to = iso10(body.to);
  const offset = (page - 1) * size;

  try {
    /* ---------- companies / pay: una fila por corrida ---------- */
    if (process === 'companies' || process === 'pay') {
      const table = process === 'companies' ? 'sync_runs' : 'pay_sync_run';
      const parts = [];
      if (status) parts.push(`status=eq.${status}`);
      if (from) parts.push(`started_at=gte.${from}T00:00:00`);
      if (to) parts.push(`started_at=lte.${to}T23:59:59`);
      const path = `${table}?select=*`
        + (parts.length ? '&' + parts.join('&') : '')
        + `&order=started_at.desc&limit=${size}&offset=${offset}`;
      const res = await sbRaw(env, path, { Prefer: 'count=exact' });
      const total = parseInt((res.headers.get('content-range') || '').split('/')[1], 10) || 0;
      const runs = await res.json() || [];

      /* ===== v5.63: QUE EMPRESAS CAMBIARON, NO SOLO CUANTAS =====
         `sync_runs` solo guarda el CONTEO (changes_count). El detalle vive en
         `company_change`, que el motor (sync-companies.js) ya viene llenando
         desde junio: una fila por empresa, con change_type ('new' | 'status'),
         old_value y new_value.

         Se traen los cambios de las corridas de ESTA pagina en UNA sola
         consulta (no una por corrida). Sin cambios, ni se pregunta. */
      let changesByRun = new Map();
      if (process === 'companies') {
        const runIds = runs.filter(r => (r.changes_count || 0) > 0).map(r => r.id);
        if (runIds.length) {
          const chg = await sb(env,
            `company_change?run_id=in.(${runIds.join(',')})`
            + `&select=run_id,company_code,business_name,change_type,old_value,new_value`
            + `&order=change_type.asc,company_code.asc`) || [];
          for (const c of chg) {
            if (!changesByRun.has(c.run_id)) changesByRun.set(c.run_id, []);
            changesByRun.get(c.run_id).push(c);
          }
        }
      }

      const rows = runs.map(r => {
        let summary;
        if (process === 'companies') {
          summary = (r.changes_count || 0) > 0 ? `${r.changes_count} cambio(s)` : 'Sin cambios';
        } else {
          const n = r.result && (r.result.updated ?? r.result.rows ?? r.result.count);
          summary = [r.mode || null, n != null ? `${n} registro(s)` : null].filter(Boolean).join(' \u00b7 ') || 'OK';
        }
        const changes = changesByRun.get(r.id) || [];
        return {
          run_at: r.started_at, source: r.source, status: r.status,
          duration_ms: r.duration_ms, summary,
          error: r.error || null,
          detail: r.result || null,
          /* Solo companies: el detalle fino de la corrida. `changes_count` puede
             ser > 0 con `changes` vacio en corridas viejas anteriores a que el
             motor empezara a registrar el detalle: la pagina lo dice, no finge. */
          changes_count: process === 'companies' ? (r.changes_count || 0) : undefined,
          changes: process === 'companies' ? changes : undefined,
        };
      });
      return json({ ok: true, process, rows, total, page, page_size: size });
    }

    /* ---------- norehire: agrupar no_rehire_log por run_id (v5.83) ----------
       La lista de no reempleables. Cada corrida deja eventos por persona
       (alta / baja / cambio) y una fila de CIERRE (event 'cierre') con el
       resumen, el origen, el estado y la duracion. Corridas anteriores al
       cierre (la carga inicial del 14/07) se reconstruyen desde sus eventos:
       aparecen igual, sin origen ni duracion. */
    if (process === 'norehire') {
      const nrParts = [];
      if (from) nrParts.push(`at=gte.${from}T00:00:00`);
      if (to) nrParts.push(`at=lte.${to}T23:59:59`);
      const logs = await sb(env,
        `no_rehire_log?select=run_id,event,id_number,full_name,detail,at`
        + (nrParts.length ? '&' + nrParts.join('&') : '')
        + `&order=at.desc&limit=3000`) || [];

      const byRun = new Map();
      for (const r of logs) {
        const k = r.run_id || r.at;
        if (!byRun.has(k)) byRun.set(k, {
          run_at: r.at, source: null, status: 'ok', duration_ms: null,
          error: null, cierre: null, eventos: [],
        });
        const g = byRun.get(k);
        if (r.event === 'cierre') {
          const d = (r.detail && typeof r.detail === 'object') ? r.detail : {};
          g.cierre = d;
          g.run_at = r.at;   // el cierre se escribe al final: es el run_at fiel
          g.source = d.source || null;
          g.status = d.status === 'error' ? 'error' : (d.status === 'warn' ? 'alerta' : 'ok');
          g.duration_ms = Number.isFinite(+d.duration_ms) ? +d.duration_ms : null;
          g.error = d.error || null;
        } else {
          g.eventos.push({ event: r.event, ced: r.id_number, nom: r.full_name, detail: r.detail || null });
        }
      }

      let groups = [...byRun.values()].map(g => {
        const c = g.cierre || {};
        const nA = g.eventos.filter(e => e.event === 'alta').length;
        const nB = g.eventos.filter(e => e.event === 'baja').length;
        const nC = g.eventos.filter(e => e.event === 'cambio').length;
        // El cierre manda; sin cierre (corridas viejas) se cuenta desde los eventos.
        const altas   = c.altas != null ? (c.altas + (c.reactivadas || 0)) : nA;
        const bajas   = c.bajas != null ? c.bajas : nB;
        const cambios = c.cambios != null ? c.cambios : nC;
        const sinMov = !altas && !bajas && !cambios;
        const summary = (sinMov && c.total_api != null)
          ? `${c.total_api} en la lista · sin novedades`
          : [`${altas} alta(s)`, `${bajas} baja(s)`, `${cambios} cambio(s)`].join(' · ');
        return {
          run_at: g.run_at, source: g.source, status: g.status,
          duration_ms: g.duration_ms, summary, error: g.error,
          detail: g.cierre, eventos: g.eventos,
        };
      });
      if (status === 'error') groups = groups.filter(g => g.status !== 'ok');
      if (status === 'ok') groups = groups.filter(g => g.status === 'ok');
      const nrTotal = groups.length;

      // Motivos traducidos (valor -> etiqueta), para que el detalle y el
      // export no muestren "motivo 3" pelado.
      const reasons = {};
      try {
        const rr = await sb(env, 'no_rehire_reason?select=value,label') || [];
        for (const x of rr) reasons[String(x.value)] = x.label;
      } catch (_) { /* sin catalogo: el front muestra el valor crudo */ }

      return json({
        ok: true, process, rows: groups.slice(offset, offset + size),
        total: nrTotal, page, page_size: size, reasons,
        note: 'Corridas de la lista de no reempleables: altas, bajas y cambios de motivo u observaciones.',
      });
    }

    /* ---------- roster: agrupar roster_sync_log por run_id ---------- */
    const parts = [];
    if (from) parts.push(`run_at=gte.${from}T00:00:00`);
    if (to) parts.push(`run_at=lte.${to}T23:59:59`);
    /* v5.37: se traen tambien los rellenos y las diferencias. Sin esto el
       Registro solo sabia de ingresos/egresos: una corrida que completo 755
       fichas y encontro 8 diferencias figuraba como "0 ingresos, 0 egresos",
       o sea, como si no hubiera hecho nada. */
    const logs = await sb(env,
      `roster_sync_log?select=run_id,run_at,source,company_code,added,removed,skipped,alert,detail,`
      + `filled,diff_review,diff_broken,diff_detail,fill_detail,rej_detail,duration_ms,stores_total`
      + (parts.length ? '&' + parts.join('&') : '')
      + `&order=run_at.desc&limit=3000`) || [];
    const byRun = new Map();
    for (const r of logs) {
      const k = r.run_id || r.run_at;
      if (!byRun.has(k)) byRun.set(k, {
        run_at: r.run_at, source: r.source,
        added: 0, removed: 0, filled: 0, alerts: 0,
        diff_review: 0, diff_broken: 0,
        stores: [],
        // El detalle fino, juntado de todas las tiendas de la corrida.
        diffs: [], fills: [], rejects: [],
        // v5.68: los trae la fila de cierre (la que tiene company_code null).
        duration_ms: null, stores_total: null, cerrada: false,
      });
      const g = byRun.get(k);

      /* ===== v5.68: LA FILA DE CIERRE =====
         `company_code = null` no es una tienda: es el cierre de la corrida.
         Trae la duracion REAL (de punta a punta) y cuantas tiendas se revisaron.
         Existe para que una corrida LIMPIA tambien deje registro: antes, una
         corrida sin movimiento y una corrida que nunca paso se veian igual.
         Sus contadores ya vienen sumados, asi que NO se acumulan (seria doble). */
      if (r.company_code == null) {
        g.duration_ms  = r.duration_ms;
        g.stores_total = r.stores_total;
        g.cerrada      = true;
        // El cierre se escribe al final: es el run_at mas fiel de la corrida.
        if (r.rej_detail && Array.isArray(r.rej_detail)) g.rejects.push(...r.rej_detail);
        continue;
      }

      g.added   += r.added   || 0;
      g.removed += r.removed || 0;
      g.filled  += r.filled  || 0;
      g.diff_review += r.diff_review || 0;
      g.diff_broken += r.diff_broken || 0;
      if (r.alert) g.alerts++;
      g.stores.push({ company_code: r.company_code, added: r.added, removed: r.removed, filled: r.filled, skipped: r.skipped, alert: r.alert, detail: r.detail });
      if (Array.isArray(r.diff_detail)) g.diffs.push(...r.diff_detail);
      if (Array.isArray(r.fill_detail)) g.fills.push(...r.fill_detail);
      if (Array.isArray(r.rej_detail))  g.rejects.push(...r.rej_detail);
    }
    let groups = [...byRun.values()].map(g => {
      /* El resumen cuenta TODO lo que hizo la corrida, no solo el alta y la
         baja. Los dos estatus de diferencia van separados porque no son lo
         mismo: "por revisar" lo decide un humano; "a corregir en el sistema"
         ya sabemos que el portal tiene razon. */
      const bits = [`${g.added} ingreso(s)`, `${g.removed} egreso(s)`];
      if (g.filled)      bits.push(`${g.filled} ficha(s) completada(s)`);
      if (g.diff_review) bits.push(`${g.diff_review} por revisar`);
      if (g.diff_broken) bits.push(`${g.diff_broken} a corregir en el sistema`);
      if (g.alerts)      bits.push(`${g.alerts} alerta(s)`);

      /* v5.68: la corrida que no encontro NADA tambien tiene algo que decir.
         "0 ingreso(s) · 0 egreso(s)" no comunica: parece que fallo. Lo que
         importa es que REVISO las 132 tiendas y no habia novedades. */
      const sinMovimiento = !g.added && !g.removed && !g.filled
                            && !g.diff_review && !g.diff_broken && !g.alerts;
      const summary = sinMovimiento && g.stores_total
        ? `${g.stores_total} tienda(s) revisada(s) \u00b7 sin novedades`
        : bits.join(' \u00b7 ');

      return {
        run_at: g.run_at, source: g.source,
        status: g.alerts ? 'alerta' : 'ok',
        duration_ms: g.duration_ms,
        summary,
        error: null,
        detail: g.stores,
        // Las pestanas del detalle (Completadas / Diferencias / Alertas).
        filled: g.filled,
        diff_review: g.diff_review,
        diff_broken: g.diff_broken,
        diffs: g.diffs,
        fills: g.fills,
        rejects: g.rejects,
        stores_total: g.stores_total,
      };
    });
    if (status === 'error') groups = groups.filter(g => g.status === 'alerta');
    if (status === 'ok') groups = groups.filter(g => g.status === 'ok');
    const total = groups.length;
    const rows = groups.slice(offset, offset + size);

    /* ===== v5.56: EL ESTADO DE HOY, NO SOLO EL DE LA CORRIDA =====

       El log esta CONGELADO: dice "3 por decidir" para siempre, aunque ya las
       hayas resuelto todas. Eso esta bien (el registro es historia y no se
       reescribe), pero el aviso que sale arriba HABLA EN PRESENTE y termina
       mandandote a una pantalla vacia.

       Solucion: el numero de la corrida no se toca, y ademas se le pregunta al
       maestro cuales de esas fichas SIGUEN VIVAS hoy (ax_diff = true). Con eso
       cada fila lleva su ✓ resuelta / ● sin resolver, y el aviso puede decir la
       verdad de HOY sin falsear la historia.

       Una sola consulta para toda la pagina (no una por corrida). */
    const cedsDiff = [...new Set(
      rows.flatMap(g => (g.diffs || []).map(d => String(d.ced || '')).filter(Boolean))
    )];
    let vivas = new Set();
    if (cedsDiff.length) {
      const inList = cedsDiff.map(c => `"${c}"`).join(',');
      const wm = await sb(env,
        `workers_master?id_number=in.(${inList})&ax_diff=is.true&select=id_number`) || [];
      vivas = new Set(wm.map(w => String(w.id_number)));
    }
    for (const g of rows) {
      g.diffs = (g.diffs || []).map(d => ({ ...d, vivo: vivas.has(String(d.ced || '')) }));
      // Cuantas de ESTA corrida siguen sin resolverse. Es lo que mira el aviso.
      g.diff_open = g.diffs.filter(d => d.vivo).length;
    }

    /* ===== v5.81: QUIEN entro y quien salio, con nombre =====
       El log guarda las CEDULAS (detail.added / detail.removed por tienda),
       pero no los nombres. Se resuelven contra el maestro en UNA consulta
       por pagina y viajan como mapa aparte (`people`), sin reescribir el log
       ni engordar cada fila. El maestro nunca borra, asi que tambien
       resuelve a los egresados. Corridas viejas sin cedulas en el detail
       simplemente no aparecen en el mapa (el front cae al numero). */
    const cedsMov = [...new Set(rows.flatMap(g => (g.detail || []).flatMap(s => {
      const d = (s && s.detail) || {};
      return [
        ...(Array.isArray(d.added) ? d.added : []),
        ...(Array.isArray(d.removed) ? d.removed : []),
      ];
    }).map(String).filter(Boolean)))];
    const people = {};
    if (cedsMov.length) {
      const inList = cedsMov.map(c => `"${c}"`).join(',');
      const wm = await sb(env,
        `workers_master?id_number=in.(${inList})&select=id_number,full_name,ced_kind`) || [];
      for (const w of wm) people[String(w.id_number)] = { full_name: w.full_name, ced_kind: w.ced_kind || 'V' };
    }

    return json({
      ok: true, process, rows, total, page, page_size: size, people,
      note: 'Historial completo: tambien las corridas que no encontraron novedades.',
    });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}
