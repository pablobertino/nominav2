/* =====================================================================
   functions/api/no-rehire.js  →  POST /api/no-rehire
   NO REEMPLEABLES (v5.72). La lista de personas que el sistema marca como
   no aptas para recontratar, SINCRONIZADA al portal.

   ¿Por que se guarda en el portal y no se consulta en vivo? Porque el
   destino final es el BLOQUEO DE INGRESOS (Fase 2), y un control de
   seguridad que depende de que el sistema responda FALLA ABIERTO: si el
   sistema esta caido, dejariamos entrar a alguien que no debe. La copia
   local convierte el control en fallo-cerrado.

   Acciones (POST { action, user, ... }):
     list        {}            gate view.norehire. Devuelve TODAS las filas
                               (vigentes y bajas; el front filtra), cada una
                               con su etiqueta en español (no_rehire_reason),
                               el cruce OPCIONAL con workers_master (foto,
                               cargo — la mayoria NO esta: son gente que ya
                               se fue) y `activo_en` si la persona sigue
                               activa en alguna tienda (caso a gritar).
                               Incluye el estado de la corrida (config).
     sync        {source}      cron: {source:'cron', adminId superadmin} /
                               manual: superadmin. Trae la lista del sistema,
                               COMPARA contra lo local y registra altas,
                               bajas y cambios en no_rehire_log.
     check       {id_number}   cualquier sesion valida (lo usa el alta de
                               personal; las tiendas NO tienen view.norehire
                               pero SI necesitan saber si pueden ingresar).
                               Respuesta minima: { blocked, reason_label,
                               notes, full_name }.
     verify      {q}           gate view.norehirecheck (v5.79, pantalla
                               "Verificar candidato"). Cedula (6-8 digitos)
                               = respuesta definitiva; texto = coincidencias
                               por nombre. NUNCA devuelve motivo ni
                               observaciones: solo identidad (nombre, cedula,
                               foto) y si esta bloqueada.
     get_config  {}            superadmin. La fila de no_rehire_config.
     save_config {enabled, daily_hour, daily_minute}  superadmin.

   REGLAS DE LA COMPARACION (decisiones de Pablo, 14/07):
   - Las bajas NO SE BORRAN: se marcan con removed_at. Un hecho no se borra
     (mismo principio que el egreso).
   - GUARDA ANTI-VACIADO: si el sistema devuelve lista VACIA y el portal
     tiene gente vigente, NO se da de baja a nadie: se aborta con error.
     Una respuesta vacia puede ser una falla, y desbloquear a todos de
     golpe seria catastrofico.
   - Motivo desconocido: si llega un motivoValor sin fila en el catalogo,
     se muestra el nombre crudo del sistema CON reason_unknown:true (la
     pantalla lo marca). Se arregla con un INSERT en no_rehire_reason,
     sin deploy.
   - La cedula se normaliza a digitos sin ceros a la izquierda en LOS DOS
     lados de toda comparacion.

   La URL del sistema NO vive aca: se lee de nomina_v2.api_catalog
   (code 'empleados_no_contratar'), igual que Consultar API. La clave es
   el secret de Cloudflare que el catalogo nombra (canaima_apikey).

   ⚠ NUNCA un catch vacio en la bitacora: si el log no se pudo escribir,
   el motivo queda anexado en no_rehire_config.last_error (leccion de la
   saga del cron del personal, v5.38).

   Secrets: supabase_url, supabase_service_role, canaima_apikey (via catalogo)
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

/* Cedula normalizada: solo digitos, sin ceros a la izquierda. Se aplica a
   LO QUE VIENE DEL SISTEMA y a LO QUE ESTA EN EL PORTAL antes de comparar,
   para que "030947404" y "30947404" sean la misma persona. */
function cedNorm(v) {
  const d = String(v == null ? '' : v).replace(/[^0-9]/g, '').replace(/^0+/, '');
  return d || null;
}

/* Miniatura publica por photo_key (mismo esquema que Buscar). null si no
   hay foto; el front cae a iniciales. */
const PUBLIC_THUMB_BUCKET = 'worker-thumbs';
function thumbUrl(env, photoKey) {
  if (!photoKey) return null;
  return `${env.supabase_url}/storage/v1/object/public/${PUBLIC_THUMB_BUCKET}/${photoKey}.jpg`;
}

/* Catalogo de motivos: mapa value -> label. */
async function loadReasons(env) {
  const rows = await sb(env, 'no_rehire_reason?select=value,ax_name,label&is_active=eq.true') || [];
  const map = {};
  rows.forEach(r => { map[Number(r.value)] = r.label; });
  return map;
}

/* Resuelve la etiqueta de un motivo. Si el valor no esta en el catalogo,
   devuelve el nombre crudo del sistema y lo MARCA (reason_unknown). */
function reasonOf(reasons, value, rawName) {
  const label = reasons[Number(value)];
  if (label) return { reason_label: label, reason_unknown: false };
  return { reason_label: String(rawName || value || '').trim() || 'Motivo sin especificar', reason_unknown: true };
}

/* ¿adminId es un superadmin activo? (autorizacion del cron, patron
   sync-roster/sync-companies: el tick manda el id de un superadmin). */
async function isActiveSuper(env, adminId) {
  if (!adminId) return false;
  const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id,role`);
  return !!(a && a[0] && a[0].role === 'superadmin');
}

/* ================= SYNC: traer, comparar, registrar ================= */
async function runSync(env, sourceLabel) {
  const t0 = Date.now();
  const now = new Date().toISOString();
  const runId = 'nr-' + now.replace(/[-:TZ.]/g, '').slice(0, 14);

  /* El resultado SIEMPRE termina escrito en la config, pase lo que pase:
     esta funcion arma el resumen y un unico finally-like lo persiste. */
  const summary = { total_api: 0, altas: 0, bajas: 0, cambios: 0, reactivadas: 0, sin_cambio: 0 };
  const logRows = [];
  let status = 'ok';
  let errorMsg = null;

  try {
    // 1) La API, desde el catalogo (sin URL hardcodeada).
    const cat = await sb(env, "api_catalog?code=eq.empleados_no_contratar&is_active=eq.true&select=endpoint_url,secret_key");
    const api = cat && cat[0];
    if (!api) throw new Error("La API 'empleados_no_contratar' no esta en el catalogo o esta inactiva.");
    const headers = { Accept: 'application/json' };
    if (api.secret_key) {
      const key = env[api.secret_key];
      if (!key) throw new Error(`El secret "${api.secret_key}" no esta configurado en Cloudflare.`);
      headers['X-API-Key'] = key;
    }

    let apiRes;
    try { apiRes = await fetch(api.endpoint_url, { headers }); }
    catch (e) { throw new Error('No se pudo conectar con el sistema: ' + String(e.message || e)); }
    if (!apiRes.ok) throw new Error(`El sistema respondio ${apiRes.status}.`);
    let data;
    try { data = await apiRes.json(); }
    catch { throw new Error('El sistema devolvio una respuesta que no es JSON.'); }
    let apiRows = Array.isArray(data) ? data : (data && (data.empleados || data.data || data.items));
    if (!Array.isArray(apiRows)) throw new Error('El sistema devolvio un formato inesperado (no es una lista).');

    // Normalizar y deduplicar por cedula (si el sistema repitiera una ficha,
    // gana la ultima: es la vigente).
    const remote = new Map();
    for (const r of apiRows) {
      const ced = cedNorm(r.ficha);
      if (!ced) continue;
      remote.set(ced, {
        id_number: ced,
        full_name: String(r.nombreCompleto || '').trim() || null,
        reason_value: Number.isFinite(Number(r.motivoValor)) ? Number(r.motivoValor) : null,
        reason_name: String(r.motivoNombre || '').trim() || null,
        notes: String(r.observaciones || '').trim() || null,
      });
    }
    summary.total_api = remote.size;

    // 2) Lo local, completo (vigentes y bajas: una baja puede reactivarse).
    const local = await sb(env, 'no_rehire?select=id,id_number,full_name,reason_value,reason_name,notes,removed_at') || [];
    const localByCed = new Map();
    let activeCount = 0;
    for (const l of local) {
      const ced = cedNorm(l.id_number);
      if (!ced) continue;
      localByCed.set(ced, l);
      if (!l.removed_at) activeCount++;
    }

    // 3) GUARDA ANTI-VACIADO: lista vacia + portal con vigentes = abortar.
    if (remote.size === 0 && activeCount > 0) {
      throw new Error(`El sistema devolvio la lista VACIA y el portal tiene ${activeCount} vigente${activeCount === 1 ? '' : 's'}. No se dio de baja a nadie: una respuesta vacia puede ser una falla del sistema.`);
    }

    // 4) Comparar. Todo cambio deja fila en no_rehire_log.
    const inserts = [];
    const seenActive = [];   // cedulas vigentes sin cambios: solo last_seen_at

    for (const [ced, r] of remote) {
      const l = localByCed.get(ced);

      if (!l) {
        // ALTA: no existia.
        inserts.push({ ...r, source: sourceLabel, detected_at: now, last_seen_at: now });
        summary.altas++;
        logRows.push({ run_id: runId, event: 'alta', id_number: ced, full_name: r.full_name, detail: { motivo: r.reason_name, motivo_valor: r.reason_value, observaciones: r.notes } });
        continue;
      }

      if (l.removed_at) {
        // REACTIVACION: habia salido de la lista y volvio a entrar.
        await sb(env, `no_rehire?id=eq.${l.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ ...r, removed_at: null, last_seen_at: now, source: sourceLabel }),
        });
        summary.reactivadas++;
        logRows.push({ run_id: runId, event: 'alta', id_number: ced, full_name: r.full_name, detail: { reactivada: true, motivo: r.reason_name, motivo_valor: r.reason_value, observaciones: r.notes } });
        continue;
      }

      // ¿Cambio algo? (mismo motivo pero observaciones distintas cuenta:
      // pedido explicito de Pablo.)
      const changed = {};
      if ((l.reason_value ?? null) !== (r.reason_value ?? null)) changed.motivo_valor = { antes: l.reason_value, ahora: r.reason_value };
      if ((l.notes || '') !== (r.notes || '')) changed.observaciones = { antes: l.notes, ahora: r.notes };
      if ((l.full_name || '') !== (r.full_name || '')) changed.nombre = { antes: l.full_name, ahora: r.full_name };

      if (Object.keys(changed).length) {
        await sb(env, `no_rehire?id=eq.${l.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ ...r, last_seen_at: now }),
        });
        summary.cambios++;
        logRows.push({ run_id: runId, event: 'cambio', id_number: ced, full_name: r.full_name, detail: changed });
      } else {
        summary.sin_cambio++;
        seenActive.push(ced);
      }
    }

    // BAJAS: vigente en el portal pero ya no viene del sistema.
    for (const [ced, l] of localByCed) {
      if (l.removed_at || remote.has(ced)) continue;
      await sb(env, `no_rehire?id=eq.${l.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ removed_at: now }),
      });
      summary.bajas++;
      logRows.push({ run_id: runId, event: 'baja', id_number: ced, full_name: l.full_name, detail: { motivo: l.reason_name, motivo_valor: l.reason_value, observaciones: l.notes } });
    }

    // Altas en un solo POST; last_seen de los sin-cambio en un solo PATCH.
    if (inserts.length) {
      await sb(env, 'no_rehire', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(inserts) });
    }
    if (seenActive.length) {
      await sb(env, `no_rehire?id_number=in.(${seenActive.map(encodeURIComponent).join(',')})&removed_at=is.null`, {
        method: 'PATCH', body: JSON.stringify({ last_seen_at: now }),
      });
    }
  } catch (e) {
    status = 'error';
    errorMsg = String(e && e.message ? e.message : e);
  }

  /* v5.83: TODA corrida deja su FILA DE CIERRE (event 'cierre', sin persona):
     el resumen completo + origen + estado + duracion. Mismo aprendizaje que
     sync-roster (v5.68/v5.82): sin cierre, una corrida limpia y una que nunca
     paso se ven iguales, y el Registro de sincronizaciones no tendria de
     donde leer origen, estado ni duracion. Se escribe SIEMPRE, incluso si la
     corrida fallo (el error viaja adentro del detail). */
  logRows.push({
    run_id: runId, event: 'cierre', id_number: null, full_name: null,
    detail: { ...summary, source: sourceLabel, status, error: errorMsg, duration_ms: Date.now() - t0 },
  });

  // 5) Bitacora. Si falla, el motivo NO se pierde: va a last_error.
  if (logRows.length) {
    try {
      await sb(env, 'no_rehire_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(logRows) });
    } catch (e) {
      const msg = 'La bitacora no se pudo escribir: ' + String(e && e.message ? e.message : e);
      errorMsg = errorMsg ? (errorMsg + ' | ' + msg) : msg;
      if (status === 'ok') status = 'warn';
    }
  }

  // 6) El resultado SIEMPRE queda en la config (aunque haya fallado).
  const cfgPatch = {
    last_run_at: now,
    last_attempt_at: now,
    last_status: status,
    last_error: errorMsg,
    last_duration_ms: Date.now() - t0,
    last_summary: { ...summary, source: sourceLabel, run_id: runId },
  };
  try {
    await sb(env, 'no_rehire_config?id=eq.1', { method: 'PATCH', body: JSON.stringify(cfgPatch) });
  } catch (e) {
    // Ultimo recurso: que al menos el llamador se entere.
    return { ok: false, error: 'La corrida termino (' + status + ') pero no se pudo guardar el resultado: ' + String(e && e.message ? e.message : e), summary };
  }

  if (status === 'error') return { ok: false, error: errorMsg, summary };
  return { ok: true, status, warn: status === 'warn' ? errorMsg : null, summary, duration_ms: cfgPatch.last_duration_ms };
}

/* ============================ HANDLER ============================ */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const action = body.action || 'list';

  try {
    /* ---------- sync ---------- */
    if (action === 'sync') {
      if (body.source === 'cron') {
        // El tick manda el id de un superadmin activo (patron sync-roster).
        const adminId = parseInt(body.adminId, 10) || null;
        if (!(await isActiveSuper(env, adminId))) {
          return json({ ok: false, error: 'Cron no autorizado.' }, 403);
        }
        return json(await runSync(env, 'cron'));
      }
      const actor = await resolveActor(env, body.user || null);
      if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
      if (actor.role !== 'superadmin') {
        return json({ ok: false, error: 'Solo el superadmin puede sincronizar la lista.' }, 403);
      }
      return json(await runSync(env, 'manual'));
    }

    /* ---------- check (gate minimo: sesion valida) ----------
       Lo consume el alta de personal. La tienda NO tiene view.norehire,
       pero necesita saber si la cedula esta bloqueada Y POR QUE (asi lo
       pidio Pablo: "no se permite y se muestra la causa"). No devuelve
       nada mas que ese caso puntual. */
    if (action === 'check') {
      const actor = await resolveActor(env, body.user || null);
      if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
      const ced = cedNorm(body.id_number);
      if (!ced) return json({ ok: false, error: 'Falta la cedula.' }, 400);
      const rows = await sb(env, `no_rehire?id_number=eq.${encodeURIComponent(ced)}&removed_at=is.null&select=full_name,reason_value,reason_name,notes`);
      const hit = rows && rows[0];
      if (!hit) return json({ ok: true, blocked: false });
      const reasons = await loadReasons(env);
      const r = reasonOf(reasons, hit.reason_value, hit.reason_name);
      return json({ ok: true, blocked: true, full_name: hit.full_name, reason_label: r.reason_label, reason_unknown: r.reason_unknown, notes: hit.notes });
    }

    /* ---------- el resto exige actor ---------- */
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);

    /* ---------- verify (v5.79): la pantalla "Verificar candidato" ----------
       Gate propio (view.norehirecheck), pensado para tiendas y roles
       operativos. Contrato de privacidad: la respuesta JAMAS incluye
       reason_* ni notes — ni inspeccionando el JSON se ve el motivo. */
    if (action === 'verify') {
      if (!can(actor, 'view.norehirecheck')) {
        return json({ ok: false, error: 'No tienes permiso para verificar candidatos (view.norehirecheck).' }, 403);
      }
      const qRaw = String(body.q || '').trim();
      if (!qRaw) return json({ ok: false, error: 'Escribe una cedula o un nombre.' }, 400);

      // Enriquecer con foto y letra de cedula. La letra: la del maestro si
      // existe; si no, la regla de siempre (>= 80.000.000 -> E).
      const enrich = async (rows) => {
        const ceds = rows.map(x => cedNorm(x.id_number)).filter(Boolean);
        let master = [];
        if (ceds.length) {
          master = await sb(env, `workers_master?id_number=in.(${ceds.map(encodeURIComponent).join(',')})&select=id_number,ced_kind,photo_key`) || [];
        }
        const by = new Map(master.map(m => [cedNorm(m.id_number), m]));
        return rows.map(x => {
          const ced = cedNorm(x.id_number);
          const m = by.get(ced) || null;
          const kind = (m && m.ced_kind) || (Number(ced) >= 80000000 ? 'E' : 'V');
          return { id_number: ced, ced_kind: kind, full_name: x.full_name || null, thumb_url: m ? thumbUrl(env, m.photo_key) : null };
        });
      };

      // ¿Cedula? Solo digitos (se admiten separadores . - espacio), 6-8.
      const compact = qRaw.replace(/[\s.\-]/g, '').replace(/^[VvEe]/, '');
      if (/^[0-9]{6,8}$/.test(compact)) {
        const ced = cedNorm(compact);
        const rows = await sb(env, `no_rehire?id_number=eq.${encodeURIComponent(ced)}&removed_at=is.null&select=id_number,full_name`);
        if (!rows || !rows.length) return json({ ok: true, mode: 'ced', blocked: false, id_number: ced });
        const people = await enrich(rows);
        return json({ ok: true, mode: 'ced', blocked: true, person: people[0] });
      }

      // Nombre: minimo 3 letras. Se sanea lo que rompe la sintaxis de
      // PostgREST (comas, parentesis, comodines) y se arma un patron que
      // respeta el orden de las palabras: *WILTON*GARCIA*.
      const term = qRaw.replace(/[%_,()*]/g, ' ').replace(/\s+/g, ' ').trim();
      if (term.length < 3) return json({ ok: false, error: 'Escribe al menos 3 letras para buscar por nombre.' }, 400);
      const pattern = '*' + term.split(' ').join('*') + '*';
      const rows = await sb(env, `no_rehire?removed_at=is.null&full_name=ilike.${encodeURIComponent(pattern)}&select=id_number,full_name&order=full_name.asc&limit=20`) || [];
      return json({ ok: true, mode: 'name', q: term, matches: await enrich(rows) });
    }

    if (action === 'list') {
      if (!can(actor, 'view.norehire')) {
        return json({ ok: false, error: 'No tienes permiso para ver los no reempleables (view.norehire).' }, 403);
      }
      const [rows, reasons, cfgRows] = await Promise.all([
        sb(env, 'no_rehire?select=id,id_number,full_name,reason_value,reason_name,notes,detected_at,last_seen_at,removed_at&order=removed_at.nullsfirst,detected_at.desc'),
        loadReasons(env),
        sb(env, 'no_rehire_config?id=eq.1&select=enabled,daily_hour,daily_minute,last_run_at,last_status,last_error,last_summary'),
      ]);
      const list = rows || [];

      // Cruce OPCIONAL con el maestro (foto/cargo) y con las tiendas
      // (¿sigue activo en alguna? -> caso a gritar). La mayoria NO esta
      // en el maestro: son personas que ya se fueron.
      const ceds = list.map(x => cedNorm(x.id_number)).filter(Boolean);
      let master = [], active = [];
      if (ceds.length) {
        const inList = ceds.map(encodeURIComponent).join(',');
        [master, active] = await Promise.all([
          sb(env, `workers_master?id_number=in.(${inList})&select=id_number,ced_kind,full_name,role,photo_key,gender,birth_date,phone,email`),
          sb(env, `store_workers?id_number=in.(${inList})&is_active=eq.true&select=id_number,company_code`),
        ]);
      }
      const masterBy = new Map((master || []).map(m => [cedNorm(m.id_number), m]));
      const activeBy = new Map();
      (active || []).forEach(a => {
        const c = cedNorm(a.id_number);
        if (!activeBy.has(c)) activeBy.set(c, []);
        activeBy.get(c).push(a.company_code);
      });

      const out = list.map(x => {
        const ced = cedNorm(x.id_number);
        const m = masterBy.get(ced) || null;
        const r = reasonOf(reasons, x.reason_value, x.reason_name);
        return {
          id: x.id,
          id_number: ced,
          full_name: x.full_name || (m && m.full_name) || null,
          reason_value: x.reason_value,
          reason_label: r.reason_label,
          reason_unknown: r.reason_unknown,
          notes: x.notes,
          detected_at: x.detected_at,
          last_seen_at: x.last_seen_at,
          removed_at: x.removed_at,
          // Ficha del maestro (si existe): foto, cargo y demas.
          in_master: !!m,
          ced_kind: m ? m.ced_kind : null,
          role: m ? m.role : null,
          gender: m ? m.gender : null,
          birth_date: m ? m.birth_date : null,
          phone: m ? m.phone : null,
          email: m ? m.email : null,
          thumb_url: m ? thumbUrl(env, m.photo_key) : null,
          // 🔴 El caso a gritar: en la lista Y activo en una tienda.
          activo_en: activeBy.get(ced) || [],
        };
      });

      return json({ ok: true, rows: out, config: (cfgRows && cfgRows[0]) || null });
    }

    if (action === 'get_config') {
      if (actor.role !== 'superadmin') return json({ ok: false, error: 'Solo superadmin.' }, 403);
      const cfg = await sb(env, 'no_rehire_config?id=eq.1&select=*');
      return json({ ok: true, config: (cfg && cfg[0]) || null });
    }

    if (action === 'save_config') {
      if (actor.role !== 'superadmin') return json({ ok: false, error: 'Solo superadmin.' }, 403);
      const patch = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      const h = parseInt(body.daily_hour, 10);
      if (Number.isFinite(h) && h >= 0 && h <= 23) patch.daily_hour = h;
      const m = parseInt(body.daily_minute, 10);
      if (Number.isFinite(m) && m >= 0 && m <= 59) patch.daily_minute = m;
      if (!Object.keys(patch).length) return json({ ok: false, error: 'Nada que guardar.' }, 400);
      await sb(env, 'no_rehire_config?id=eq.1', { method: 'PATCH', body: JSON.stringify(patch) });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status);
    return json({ ok: false, error: 'Error interno: ' + String(e && e.message ? e.message : e) }, 500);
  }
}
