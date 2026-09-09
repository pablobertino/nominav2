/* =====================================================================
   functions/api/snapshot-load.js  →  POST /api/snapshot-load
   CARGA DE CORTES QUINCENALES (v6.272) — la fuente de la vista Rotacion.

   EL BUG QUE ORIGINA ESTE ARCHIVO (08/09/2026). Rotacion deriva TODO de
   nomina_v2.hcm_snapshot. Los 13 cortes de 2026 se cargaron a mano la
   noche del 16/07 con un script de Python; el plan anotaba "futuras
   quincenas: re-correr el loader (o automatizar luego)" y nadie lo
   re-corrio. Resultado: el ultimo corte quedo en el 01/07 y durante dos
   meses la pantalla mostro CEROS que parecian datos — un gerente reporto
   "no me funciona la pestaña Rotacion" creyendo que era su usuario.
   La caja negra era peor que el hueco: el cron de la cache corria todos
   los dias sin fallar, recalculando sobre 13 cortes viejos.

   COMO FUNCIONA. La cola (nomina_v2.hcm_snapshot_runs) es una fila por
   (corte, alias) y es TAMBIEN el log: si un alias falla, ahi queda el
   motivo. Cada invocacion reclama un lote, lo procesa y lo cierra.

   ⚠ POR QUE EL AVANCE VIVE EN LA TABLA Y NO EN UNA CADENA DE LLAMADAS.
   sync-roster tiene documentado el BUG 1 (PENDIENTE_SYNC_ROSTER_BUGS.md):
   su cadena de auto-invocacion se corta en el primer eslabon, asi que
   cada corrida procesa SIEMPRE las mismas 10 tiendas y las demas no se
   sincronizan solas nunca. Aca no hay cadena: cada tick pide "las
   proximas N pendientes" a hcm_snapshot_claim() y se va. Si una corrida
   se muere a mitad, la siguiente sigue donde quedo — las filas que
   quedan 'running' huerfanas vuelven a la cola a los 10 minutos.

   211 aliases por corte, lotes de 40 -> 6 invocaciones por corte.

   Acciones (POST { action, user, ... }):
     status   {}          gate view.movimientos. Estado de la cola por
                          corte + ultimo corte cargado. Es la respuesta a
                          "¿por que Rotacion no muestra agosto?".
     enqueue  {cut}       SUPERADMIN. Encola un corte (idempotente: no
                          pisa lo ya cargado, asi que re-encolar reintenta
                          solo lo que falta). El cron lo drena solo.
     run      {limit}     SUPERADMIN. Procesa un lote a mano.
     run_cron {source,adminId,limit}
                          Invocado por nomina_v2.tick_hcm_snapshot().

   Secrets: canaima_apikey, supabase_url, supabase_service_role
   ===================================================================== */

import { resolveActor, can, AuthError } from './_auth.js';
import { snapRoster } from './_hcmsnap.js';
import { gaClient } from './_greenapi.js';

/* Cuanto tiempo se le permite a UNA invocacion antes de cortar limpio.
   Cortar a tiempo no pierde nada: lo no procesado sigue pendiente en la
   cola y la proxima corrida lo toma. */
const PRESUPUESTO_MS = 20000;
/* Aliases en paralelo. 8 es el mismo numero que usa sync-roster. */
const EN_PARALELO = 8;
/* Filas por llamada al upsert (el payload no puede crecer sin techo). */
const FILAS_POR_TANDA = 1500;

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

/* hcm_snapshot_upsert vive en public (lo dejo asi el loader original), no
   en nomina_v2: necesita su propio profile o PostgREST no lo encuentra. */
async function sbPublic(env, path, opts = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'public', 'Content-Profile': 'public',
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

const cfgPatch = (env, b) => sb(env, 'hcm_snapshot_config?id=eq.1', {
  method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(b),
}).catch(() => null);

/* =====================================================================
   procesarLote — el corazon. Reclama, lee la API, guarda, cierra.

   Un alias caido NO tumba la tanda: cada uno se resuelve por separado y
   su motivo se guarda en su fila. Un corte con 3 aliases en error es un
   corte al que le faltan 3 tiendas y lo dice; no un corte que "fallo".
   ===================================================================== */
async function procesarLote(env, limite) {
  const t0 = Date.now();
  const pedidos = await sb(env, 'rpc/hcm_snapshot_claim', {
    method: 'POST', body: JSON.stringify({ p_limit: limite }),
  });
  if (!pedidos || !pedidos.length) return { claimed: 0, ok: 0, empty: 0, error: 0, rows: 0, cortes: [] };

  /* El claim entrega ordenado por corte, pero un lote puede caer a caballo
     entre dos cortes: se agrupa para que cada upsert lleve un solo cut. */
  const porCorte = new Map();
  for (const p of pedidos) {
    const c = String(p.cut_date).slice(0, 10);
    if (!porCorte.has(c)) porCorte.set(c, []);
    porCorte.get(c).push(p.alias);
  }

  const resumen = { claimed: pedidos.length, ok: 0, empty: 0, error: 0, rows: 0, cortes: [] };

  for (const [cut, aliases] of porCorte) {
    const marcas = [];
    const filas = [];
    let cortadoPorTiempo = false;

    for (let i = 0; i < aliases.length; i += EN_PARALELO) {
      if (Date.now() - t0 > PRESUPUESTO_MS) {
        /* Lo que no se alcanzo vuelve a la cola tal cual: 'pending' otra
           vez, sin error, para que no consuma reintentos por culpa del
           reloj. El attempts ya lo subio el claim; eso es intencional
           (un alias que siempre queda ultimo igual termina agotando
           intentos y quedando visible, en vez de girar para siempre). */
        for (const a of aliases.slice(i)) marcas.push({ alias: a, status: 'pending', rows_in: null, error: null });
        cortadoPorTiempo = true;
        break;
      }
      const tanda = aliases.slice(i, i + EN_PARALELO);
      const res = await Promise.all(tanda.map(a => snapRoster(env, a, cut)));
      res.forEach((r, k) => {
        const alias = tanda[k];
        if (!r.ok) {
          marcas.push({ alias, status: 'error', rows_in: null, error: String(r.error || 'error').slice(0, 400) });
          resumen.error++;
          return;
        }
        if (!r.rows.length) {
          /* Sin gente a esa fecha es un dato, no una falla: empresa
             cerrada o todavia sin personal. No se reintenta. */
          marcas.push({ alias, status: 'empty', rows_in: 0, error: null });
          resumen.empty++;
          return;
        }
        filas.push(...r.rows);
        marcas.push({ alias, status: 'ok', rows_in: r.rows.length, error: null });
        resumen.ok++;
        resumen.rows += r.rows.length;
      });
    }

    /* Guardar ANTES de cerrar las marcas: si el upsert cae, los aliases
       quedan 'running' y vuelven a la cola a los 10 minutos. Al reves
       quedarian marcados 'ok' sin haber guardado nada. */
    try {
      for (let i = 0; i < filas.length; i += FILAS_POR_TANDA) {
        await sbPublic(env, 'rpc/hcm_snapshot_upsert', {
          method: 'POST', body: JSON.stringify({ p_rows: filas.slice(i, i + FILAS_POR_TANDA) }),
        });
      }
    } catch (e) {
      const msg = `upsert: ${(e && e.message) || e}`.slice(0, 400);
      for (const m of marcas) if (m.status === 'ok') { m.status = 'error'; m.error = msg; }
      resumen.error += resumen.ok; resumen.ok = 0; resumen.rows = 0;
    }

    await sb(env, 'rpc/hcm_snapshot_mark', {
      method: 'POST', body: JSON.stringify({ p_cut: cut, p_rows: marcas }),
    });
    resumen.cortes.push({ cut, aliases: aliases.length, cortado_por_tiempo: cortadoPorTiempo });
    if (cortadoPorTiempo) break;
  }

  return resumen;
}

/* Cuando un corte se termina de cargar, la cache de movimientos tiene que
   recalcularse o Rotacion sigue mostrando lo viejo con datos nuevos en la
   base — el peor de los dos mundos. Mejor esfuerzo: si falla, el cron de
   las 07:30 lo hace igual. */
async function refrescarSiTermino(env) {
  const quedan = await sb(env, 'hcm_snapshot_runs?status=in.(pending,running,error)&select=cut_date&limit=1');
  if (quedan && quedan.length) return false;
  await sb(env, 'rpc/personnel_movements_refresh', { method: 'POST', body: '{}' }).catch(() => null);
  return true;
}

function ddmm(f) {
  const s = String(f || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : s;
}

/* =====================================================================
   avisar — el vigilante habla.

   ⚠ EL AVISO MIRA EL DATO, NO EL JOB. Durante dos meses el cron de la
   cache de movimientos corrio todos los dias y todos los dias termino
   'ok': recalculaba impecablemente sobre cortes congelados el 01/07.
   Un monitoreo de "¿fallo algun job?" habria estado verde todo ese
   tiempo. La unica pregunta que sirve es "¿el ultimo corte es el que
   deberia ser?", y esa la contesta hcm_snapshot_salud().

   Una vez al dia por motivo, y el candado es la PK de
   hcm_snapshot_alerts, no un if: dos ticks que se pisen no mandan el
   aviso dos veces (mismo criterio que el saludo de cumpleaños).
   ===================================================================== */
async function avisar(env, salud) {
  if (!salud || salud.ok) return { enviado: false, motivo: 'sano' };

  const gano = await sb(env, 'rpc/hcm_snapshot_alert_claim', {
    method: 'POST',
    body: JSON.stringify({ p_motivo: salud.motivo, p_detalle: salud }),
  });
  if (gano !== true) return { enviado: false, motivo: 'ya se aviso hoy' };

  const cfg = await sb(env, 'hcm_snapshot_config?id=eq.1&select=alert_group_id');
  const gid = cfg && cfg[0] && cfg[0].alert_group_id;
  if (!gid) return { enviado: false, motivo: 'sin grupo de aviso configurado' };
  const grupo = await sb(env, `wa_groups?id=eq.${gid}&enabled=eq.true&select=chat_id,wa_name`);
  if (!grupo || !grupo.length) return { enviado: false, motivo: `grupo ${gid} inexistente o apagado` };

  const texto = salud.motivo === 'atrasado'
    ? `⚠️ *Rotación se está quedando sin datos*\n\n`
      + `El último corte quincenal completo es el *${ddmm(salud.cargado)}* y ya debería estar el del *${ddmm(salud.esperado)}*`
      + `${salud.dias_atraso ? ` (${salud.dias_atraso} días de atraso)` : ''}.\n\n`
      + `La vista Rotación va a mostrar CEROS para todo lo posterior a esa fecha, `
      + `y un cero sin explicación parece un dato real. Mientras tanto, el dato en vivo está en Movimientos.`
    : `⚠️ *Carga de cortes con empresas en error*\n\n`
      + `${salud.aliases_error} empresa(s) agotaron los reintentos y quedaron fuera del corte. `
      + `El motivo de cada una está en nomina_v2.hcm_snapshot_runs.`;

  try {
    await gaClient(env).sendMessage(grupo[0].chat_id, texto);
    return { enviado: true, grupo: grupo[0].wa_name };
  } catch (e) {
    /* Si el aviso no sale, se libera el candado del dia: al proximo tick
       se vuelve a intentar. Un vigilante mudo es peor que no tenerlo. */
    await sb(env, `hcm_snapshot_alerts?motivo=eq.${encodeURIComponent(salud.motivo)}`
      + `&alerted_on=eq.${salud.hoy}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => null);
    return { enviado: false, motivo: `WhatsApp: ${(e && e.message) || e}` };
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const action = body.action || 'status';

  try {
    /* ---------- alert: el vigilante, disparado por el mismo tick ---------- */
    if (action === 'alert' && body.source === 'cron') {
      const adminId = parseInt(body.adminId, 10) || 0;
      const adm = adminId
        ? await sb(env, `admin_users?id=eq.${adminId}&role=eq.superadmin&is_active=eq.true&select=id`)
        : null;
      if (!adm || !adm.length) return json({ ok: false, error: 'alert: adminId invalido.' }, 403);
      // La salud se recalcula aca: la que viaja en el body es de hace
      // segundos y esto decide si suena una alarma.
      const salud = await sb(env, 'rpc/hcm_snapshot_salud', { method: 'POST', body: '{}' });
      const r = await avisar(env, salud);
      return json({ ok: true, salud, aviso: r });
    }

    /* ---------- run_cron: lo dispara tick_hcm_snapshot() ---------- */
    // No hay sesion de navegador: se valida que adminId sea un superadmin
    // ACTIVO (mismo criterio que ax-sync/egresos_cron).
    if (action === 'run_cron' && body.source === 'cron') {
      const adminId = parseInt(body.adminId, 10) || 0;
      const adm = adminId
        ? await sb(env, `admin_users?id=eq.${adminId}&role=eq.superadmin&is_active=eq.true&select=id`)
        : null;
      if (!adm || !adm.length) return json({ ok: false, error: 'run_cron: adminId invalido.' }, 403);
      if (!env.canaima_apikey) {
        await cfgPatch(env, { last_run_at: new Date().toISOString(), last_status: 'error', last_error: 'Falta el secret canaima_apikey.' });
        return json({ ok: false, error: 'Falta el secret canaima_apikey.' }, 500);
      }
      try {
        const r = await procesarLote(env, parseInt(body.limit, 10) || null);
        const termino = await refrescarSiTermino(env);
        await cfgPatch(env, {
          last_run_at: new Date().toISOString(), last_status: 'ok', last_error: null,
          last_result: { ...r, termino },
        });
        return json({ ok: true, ...r, termino });
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 400);
        await cfgPatch(env, { last_run_at: new Date().toISOString(), last_status: 'error', last_error: msg });
        return json({ ok: false, error: msg }, 500);
      }
    }

    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);

    /* ---------- status: en que va la carga ---------- */
    if (action === 'status') {
      if (!can(actor, 'view.movimientos')) {
        return json({ ok: false, error: 'No tienes permiso para ver los movimientos de personal (view.movimientos).' }, 403);
      }
      const [cola, ultimo, cfg, salud] = await Promise.all([
        sb(env, 'hcm_snapshot_runs?select=cut_date,status'),
        sb(env, 'hcm_snapshot?select=cut_date&order=cut_date.desc&limit=1'),
        sb(env, 'hcm_snapshot_config?id=eq.1&select=enabled,batch_size,auto_from,alert_group_id,last_run_at,last_status,last_error,last_result'),
        sb(env, 'rpc/hcm_snapshot_salud', { method: 'POST', body: '{}' }),
      ]);
      const porCorte = {};
      for (const r of (cola || [])) {
        const c = String(r.cut_date).slice(0, 10);
        porCorte[c] = porCorte[c] || { cut: c, pending: 0, running: 0, ok: 0, empty: 0, error: 0 };
        porCorte[c][r.status] = (porCorte[c][r.status] || 0) + 1;
      }
      return json({
        ok: true,
        cortes: Object.values(porCorte).sort((a, b) => a.cut < b.cut ? 1 : -1),
        last_cut: (ultimo && ultimo[0] && ultimo[0].cut_date) || null,
        config: (cfg && cfg[0]) || null,
        salud: salud || null,
      });
    }

    /* De aca para abajo se escribe. Todavia no hay pantalla para esto: la
       carga rutinaria la hace el cron y el relleno historico se encola una
       vez. Por eso NO se inventa un permiso que nadie podria marcar en
       Roles (ya paso tres veces: view.apistatus, el aviso de cumpleaños de
       Naima y report.publish.*). Cuando haya pantalla, nace el permiso
       junto con su casilla. */
    if (actor.role !== 'superadmin') {
      return json({ ok: false, error: 'Solo un superadmin puede cargar cortes quincenales.' }, 403);
    }

    /* ---------- enqueue: poner un corte en la cola ---------- */
    if (action === 'enqueue') {
      const cut = isoDate(body.cut);
      if (!cut) return json({ ok: false, error: 'Indica el corte (AAAA-MM-DD).' }, 400);
      const hoy = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
      if (cut > hoy) return json({ ok: false, error: `El corte ${cut} es futuro: no hay roster que fotografiar todavia.` }, 400);
      const n = await sb(env, 'rpc/hcm_snapshot_enqueue', {
        method: 'POST', body: JSON.stringify({ p_cut: cut }),
      });
      return json({ ok: true, cut, encolados: n });
    }

    /* ---------- run: procesar un lote a mano ---------- */
    if (action === 'run') {
      if (!env.canaima_apikey) return json({ ok: false, error: 'Falta el secret canaima_apikey.' }, 500);
      const r = await procesarLote(env, parseInt(body.limit, 10) || null);
      const termino = await refrescarSiTermino(env);
      return json({ ok: true, ...r, termino });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status);
    return json({ ok: false, error: 'Error interno: ' + String(e && e.message ? e.message : e) }, 500);
  }
}
