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

  const process = ['companies', 'pay', 'roster'].includes(body.process) ? body.process : 'companies';
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
      const rows = runs.map(r => {
        let summary;
        if (process === 'companies') {
          summary = (r.changes_count || 0) > 0 ? `${r.changes_count} cambio(s)` : 'Sin cambios';
        } else {
          const n = r.result && (r.result.updated ?? r.result.rows ?? r.result.count);
          summary = [r.mode || null, n != null ? `${n} registro(s)` : null].filter(Boolean).join(' \u00b7 ') || 'OK';
        }
        return {
          run_at: r.started_at, source: r.source, status: r.status,
          duration_ms: r.duration_ms, summary,
          error: r.error || null,
          detail: r.result || null,
        };
      });
      return json({ ok: true, process, rows, total, page, page_size: size });
    }

    /* ---------- roster: agrupar roster_sync_log por run_id ---------- */
    const parts = [];
    if (from) parts.push(`run_at=gte.${from}T00:00:00`);
    if (to) parts.push(`run_at=lte.${to}T23:59:59`);
    const logs = await sb(env,
      `roster_sync_log?select=run_id,run_at,source,company_code,added,removed,skipped,alert,detail`
      + (parts.length ? '&' + parts.join('&') : '')
      + `&order=run_at.desc&limit=3000`) || [];
    const byRun = new Map();
    for (const r of logs) {
      const k = r.run_id || r.run_at;
      if (!byRun.has(k)) byRun.set(k, { run_at: r.run_at, source: r.source, added: 0, removed: 0, alerts: 0, stores: [] });
      const g = byRun.get(k);
      g.added += r.added || 0; g.removed += r.removed || 0; if (r.alert) g.alerts++;
      g.stores.push({ company_code: r.company_code, added: r.added, removed: r.removed, skipped: r.skipped, alert: r.alert, detail: r.detail });
    }
    let groups = [...byRun.values()].map(g => ({
      run_at: g.run_at, source: g.source,
      status: g.alerts ? 'alerta' : 'ok',
      duration_ms: null,
      summary: `${g.added} ingreso(s) \u00b7 ${g.removed} egreso(s)${g.alerts ? ` \u00b7 ${g.alerts} alerta(s)` : ''}`,
      error: null,
      detail: g.stores,
    }));
    if (status === 'error') groups = groups.filter(g => g.status === 'alerta');
    if (status === 'ok') groups = groups.filter(g => g.status === 'ok');
    const total = groups.length;
    const rows = groups.slice(offset, offset + size);
    return json({
      ok: true, process, rows, total, page, page_size: size,
      note: 'Solo corridas con movimiento o alerta (las limpias no dejan registro por diseno).',
    });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}
