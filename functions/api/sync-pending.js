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
  try { await shadowCan(env, body.user || { kind: 'admin', id: adminId }, 'sync-pending', 'list', 'hcm.log', true); } catch (_) { /* bitacora */ }

  const allowed = await allowedCompanies(env, actor);
  if (allowed !== null && !allowed.size) {
    return json({ ok: true, conflicts: [], rejected: [], skipped: [], last_run: null,
                  counts: { conflicts: 0, rejected: 0, skipped: 0 } });
  }
  const inScope = (cc) => allowed === null || allowed.has(String(cc || ''));

  try {
    /* ---------- 1. HAY QUE DECIDIR (estado acumulado) ----------
       Sale del maestro, no de una corrida: la marca vive hasta que alguien la
       resuelve. `last_source_company` dice de que empresa vino la persona (es
       lo que usa el alcance y lo que necesita `adopt` para re-detectar). */
    const marked = await sb(env,
      'workers_master?ax_diff=eq.true'
      + '&select=id_number,full_name,last_source_company,ax_diff_fields,ax_diff_at'
      + '&order=ax_diff_at.desc&limit=500') || [];

    const conflicts = [];
    for (const m of marked) {
      const cc = m.last_source_company || '';
      if (!inScope(cc)) continue;
      const ff = (m.ax_diff_fields && typeof m.ax_diff_fields === 'object') ? m.ax_diff_fields : {};
      const fields = [];
      for (const [campo, d] of Object.entries(ff)) {
        if (!d || typeof d !== 'object') continue;
        fields.push({
          campo,
          estado: d.estado || 'conflicto',
          portal: d.portal != null ? String(d.portal) : null,
          sistema: d.sistema != null ? String(d.sistema) : null,
        });
      }
      if (!fields.length) continue;
      conflicts.push({
        id_number: String(m.id_number),
        full_name: m.full_name || String(m.id_number),
        company_code: cc,
        fields,
        at: m.ax_diff_at || null,
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
