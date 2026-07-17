/* =====================================================================
   functions/api/ax-sync.js  →  POST /api/ax-sync
   CONSUMO DE LAS APIs AX (middleware Flask de Sebastian) — v6.03.
   Doc autocontenida: C:\AX\Codigo\CLAUDE\GC_APIS_AX_EGRESOS_EMPRESAS_2026-07-16.md

   La key del middleware NUNCA viaja al navegador: vive en las env vars
   del proyecto Pages y solo esta Function la usa.

   Acciones (POST { action, user, ... }):
     egresos_pull  {desde, hasta, alias?}   gate hcm.sync.
         Llama a la API dedicada de egresos (max 365 dias por llamada,
         limite del middleware), upsertea en nomina_v2.ax_egresos +
         ax_asignaciones via RPC ax_egresos_upsert (idempotente:
         corridas repetidas no duplican) y devuelve conteos.
         Recordar la regla DANTHAL: "empleos" es el numero de egresos;
         "asignaciones" trae VARIAS filas por empleo (cargos).
     empresas_pull {}                       gate hcm.sync.
         Trae el catalogo completo de empresas-status (con nextEvent/
         nextStatus/nextFrom/nextTo/nextReason y modifiedDateTime como
         fecha-fallback del cambio) y lo upsertea en
         nomina_v2.company_status via company_status_upsert.

   Env vars (Cloudflare Pages): usa el secret canaima_apikey YA
   configurado (mismo middleware que las demas APIs del catalogo);
   ax_api_key / ax_egresos_url / ax_empresas_url son OVERRIDES opcionales.
   Ya existentes: supabase_url, supabase_service_role.
   ===================================================================== */

import { resolveActor, can, AuthError } from './_auth.js';

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

function isoDate(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/* GET al middleware con la key en header. Si el middleware devuelve un
   error estructurado ({error, detalle}), se propaga legible. */
async function axGet(url, key, params) {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  const res = await fetch(url + q, {
    headers: { 'X-API-Key': key, Accept: 'application/json' },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* respuesta no-JSON */ }
  if (!res.ok) {
    const msg = (data && (data.error || data.detalle)) || `HTTP ${res.status}`;
    throw new Error(`API AX: ${msg}`);
  }
  return data;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const action = body.action || '';

  try {
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
    if (!can(actor, 'hcm.sync')) {
      return json({ ok: false, error: 'No tienes permiso para sincronizar con AX (hcm.sync).' }, 403);
    }
    const axKey = env.ax_api_key || env.canaima_apikey;
    if (!axKey) {
      return json({ ok: false, error: 'Falta el secret canaima_apikey (o ax_api_key) en las variables del proyecto (Cloudflare Pages).' }, 500);
    }
    const egresosUrl = env.ax_egresos_url || 'https://api.grupocanaima.com/empleados/egresos/v1';
    const empresasUrl = env.ax_empresas_url || 'https://api.grupocanaima.com/empresas/status/v1';

    /* ---------- egresos_pull: rango de egresos con sus cargos ---------- */
    if (action === 'egresos_pull') {
      const desde = isoDate(body.desde);
      const hasta = isoDate(body.hasta);
      if (!desde || !hasta) return json({ ok: false, error: 'Indica desde y hasta (AAAA-MM-DD).' }, 400);
      if (desde > hasta) return json({ ok: false, error: 'El rango es invalido (hasta anterior a desde).' }, 400);
      const dias = Math.round((new Date(hasta) - new Date(desde)) / 86400000);
      if (dias > 365) return json({ ok: false, error: `Maximo 365 dias por llamada (limite de la API); el rango pide ${dias}. Trocealo.` }, 400);
      const alias = String(body.alias || '').trim();
      if (alias && !/^[A-Za-z0-9]{2,6}$/.test(alias)) return json({ ok: false, error: 'Alias invalido.' }, 400);

      const params = { desde, hasta };
      if (alias) params.alias = alias;
      const data = await axGet(egresosUrl, axKey, params);
      const empleos = Array.isArray(data && data.empleos) ? data.empleos : [];
      const asignaciones = Array.isArray(data && data.asignaciones) ? data.asignaciones : [];
      const up = await sb(env, 'rpc/ax_egresos_upsert', {
        method: 'POST',
        body: JSON.stringify({ p_empleos: empleos, p_asignaciones: asignaciones }),
      });
      return json({
        ok: true, desde, hasta, alias: alias || null,
        api: {
          totalEgresos: (data && data.totalEgresos) || empleos.length,
          totalAsignaciones: (data && data.totalAsignaciones) || asignaciones.length,
        },
        upsert: up || null,
      });
    }

    /* ---------- egresos_apply: cerrar en el portal lo confirmado ---------- */
    // v6.07: aplica ax_egresos a store_workers (end_date + is_active=false,
    // solo fines pasados, tolerancia 3 dias). Es SINCRONIZAR desde AX: dato
    // explicito de la API, jamas por ausencia (regla sync-roster v5.31).
    if (action === 'egresos_apply') {
      const up = await sb(env, 'rpc/ax_egresos_apply', { method: 'POST', body: '{}' });
      return json({ ok: true, apply: up || null });
    }

    /* ---------- empresas_pull: catalogo completo de empresas ---------- */
    if (action === 'empresas_pull') {
      const data = await axGet(empresasUrl, axKey, null);
      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) return json({ ok: false, error: 'El catalogo llego vacio; no se toca la tabla.' }, 502);
      const up = await sb(env, 'rpc/company_status_upsert', {
        method: 'POST', body: JSON.stringify({ p_rows: rows }),
      });
      return json({ ok: true, api: { empresas: rows.length }, upsert: up || null });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status);
    return json({ ok: false, error: 'Error: ' + String(e && e.message ? e.message : e) }, 500);
  }
}
