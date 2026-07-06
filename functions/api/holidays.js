/* =====================================================================
   functions/api/holidays.js  →  /api/holidays
   Feriados nacionales y bancarios (tabla nomina_v2.feriado).
   Acciones (POST {action}):
     - list   : lista feriados de un anio, opcional filtro tipo (nac/ban).
                Lectura abierta (superadmin, admin, tienda) para que la
                linea de tiempo pueda marcar los nacionales.
     - years  : anios que ya tienen feriados cargados.
     - create : (superadmin) alta de un feriado.
     - update : (superadmin) edicion de un feriado por id.
     - delete : (superadmin) baja de un feriado por id.

   Al crear/editar/eliminar un feriado NACIONAL, se recalculan los
   claim_deadline (Plazo Reclamo) de las quincenas cuyo pago sea anterior o
   igual al cierre afectado, porque add_business_days salta feriados
   nacionales y el cambio puede correr la fecha.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { shadowCan } from './_auth.js';

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

async function rpc(env, fn, args = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2', 'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Supabase RPC ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function isSuperadmin(env, adminId) {
  if (!adminId) return false;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&role=eq.superadmin&is_active=eq.true&select=id`);
  return r && r.length > 0;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

// Valida y normaliza el cuerpo de un feriado. Devuelve {row} o {error}.
function buildRow(body) {
  const fecha = String(body.fecha || '').trim();
  if (!ISO_RE.test(fecha)) return { error: 'Fecha inválida (formato AAAA-MM-DD).' };
  const nombre = String(body.nombre || '').trim();
  if (!nombre) return { error: 'El nombre es obligatorio.' };
  if (nombre.length > 120) return { error: 'El nombre es demasiado largo.' };
  let ejec = body.fecha_ejecucion == null || body.fecha_ejecucion === '' ? null : String(body.fecha_ejecucion).trim();
  if (ejec && !ISO_RE.test(ejec)) return { error: 'Fecha de ejecucion invalida.' };
  // Icono del feriado: codigo corto (ej. 'flag', 'cross'). El catalogo de
  // codigos validos lo define el frontend; aqui solo se valida que sea un
  // slug corto (letras/numeros/guion) o null. No es obligatorio.
  let icono = body.icono == null || body.icono === '' ? null : String(body.icono).trim().toLowerCase();
  if (icono && !/^[a-z0-9-]{1,24}$/.test(icono)) return { error: 'Icono invalido.' };
  // 'anio' es una columna GENERATED ALWAYS (EXTRACT(year FROM fecha)); NO se
  // envia en el insert/update (Postgres la calcula sola). Se devuelve aparte
  // solo para saber que anio recalcular en el Plazo Reclamo.
  const anio = parseInt(fecha.slice(0, 4), 10);
  return {
    anio,
    row: {
      fecha,
      fecha_ejecucion: ejec,
      nombre,
      es_nacional: !!body.es_nacional,
      es_bancario: !!body.es_bancario,
      movil: !!body.movil,
      icono,
    },
  };
}

// Recalcula claim_deadline de todas las quincenas cuyo pago cae en el anio
// dado (o el siguiente, por si el plazo cruza de diciembre a enero). Usa
// add_business_days, la misma fuente de verdad que el resto del sistema.
async function recalcClaimDeadlines(env, anio) {
  // Traemos las quincenas de ese anio y del siguiente (un plazo de fin de
  // diciembre puede cerrar en enero y depender de feriados de enero).
  const rows = await sb(env,
    `payroll_periods?year=in.(${anio},${anio + 1})&select=id,pay_date,claim_days`);
  if (!rows || !rows.length) return 0;
  let n = 0;
  for (const p of rows) {
    if (!p.pay_date) continue;
    const days = (p.claim_days != null) ? p.claim_days : 5;
    let deadline;
    try {
      deadline = await rpc(env, 'add_business_days', { p_start: p.pay_date, p_n: days });
    } catch { continue; }
    if (!deadline) continue;
    const dl = String(deadline).slice(0, 10);
    await sb(env, `payroll_periods?id=eq.${encodeURIComponent(p.id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ claim_deadline: dl }),
    });
    n++;
  }
  return n;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action } = body;

  try {
    // ---- Lectura: abierta a cualquier sesión ----
    if (action === 'list') {
      const year = parseInt(body.year, 10) || new Date().getFullYear();
      let path = `feriado?anio=eq.${year}&order=fecha&select=*`;
      // Filtro opcional por tipo: 'nac' (nacionales) | 'ban' (bancarios).
      if (body.filter === 'nac') path += '&es_nacional=eq.true';
      else if (body.filter === 'ban') path += '&es_bancario=eq.true';
      const rows = await sb(env, path);
      return json({ ok: true, year, holidays: rows || [] });
    }

    if (action === 'years') {
      const rows = await sb(env, 'feriado?select=anio&order=anio');
      const years = [...new Set((rows || []).map(r => r.anio))];
      return json({ ok: true, years });
    }

    // ---- Escritura: solo superadmin ----
    const { adminId } = body;
    const legacyOk = await isSuperadmin(env, adminId);
    await shadowCan(env, adminId, 'holidays', action || '?', 'config.calendario', legacyOk);
    if (!legacyOk) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    if (action === 'create') {
      const { row, anio, error } = buildRow(body);
      if (error) return json({ ok: false, error }, 400);
      // Evitar duplicado (fecha, nombre) - la tabla tiene unique en ese par.
      // Se codifica el nombre y se envuelve en comillas para PostgREST (puede
      // tener espacios/acentos).
      const dup = await sb(env,
        `feriado?fecha=eq.${row.fecha}&nombre=eq.${encodeURIComponent('"' + row.nombre + '"')}&select=id`);
      if (dup && dup.length) return json({ ok: false, error: 'Ya existe un feriado con esa fecha y nombre.' }, 409);
      await sb(env, 'feriado', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      });
      let recalced = 0;
      if (row.es_nacional) recalced = await recalcClaimDeadlines(env, anio);
      return json({ ok: true, recalced });
    }

    if (action === 'update') {
      const { id } = body;
      if (!id) return json({ ok: false, error: 'Falta el feriado.' }, 400);
      const cur = await sb(env, `feriado?id=eq.${encodeURIComponent(id)}&select=*`);
      if (!cur || !cur.length) return json({ ok: false, error: 'Feriado no encontrado.' }, 404);
      const { row, anio, error } = buildRow(body);
      if (error) return json({ ok: false, error }, 400);
      await sb(env, `feriado?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      });
      // Recalcular si el feriado ES o ERA nacional (cualquier cambio que
      // afecte el conteo de dias habiles), y en ambos anios si la fecha cambio.
      let recalced = 0;
      const wasNac = cur[0].es_nacional;
      if (row.es_nacional || wasNac) {
        recalced += await recalcClaimDeadlines(env, anio);
        if (cur[0].anio && cur[0].anio !== anio) {
          recalced += await recalcClaimDeadlines(env, cur[0].anio);
        }
      }
      return json({ ok: true, recalced });
    }

    if (action === 'delete') {
      const { id } = body;
      if (!id) return json({ ok: false, error: 'Falta el feriado.' }, 400);
      const cur = await sb(env, `feriado?id=eq.${encodeURIComponent(id)}&select=*`);
      if (!cur || !cur.length) return json({ ok: false, error: 'Feriado no encontrado.' }, 404);
      await sb(env, `feriado?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' },
      });
      let recalced = 0;
      if (cur[0].es_nacional) recalced = await recalcClaimDeadlines(env, cur[0].anio);
      return json({ ok: true, recalced });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
