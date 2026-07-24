/* =====================================================================
   functions/api/cambio-cargo.js  →  POST /api/cambio-cargo
   CAMBIO DE CARGO (consola de escritura). Ascensos, descensos, traslados
   y egresos con circuito sugerir -> aprobar -> exportar la plantilla de
   Modificacion de AX (A/B/M). Distinto de /api/movements (tablero historico
   de solo lectura, derivado del sync). Aqui se PROPONEN y APRUEBAN cambios.

   Tabla: nomina_v2.personnel_movement_requests.
   Cargos de zona/tienda: nomina_v2.cargos (ambito, hier_level, movable).
   Alcance por rol de asignacion: nomina_v2.mov_role_scope (min_assign_level).

   Acciones (POST { action, user, ... }):
     catalog {}                gate view.cambiocargo | mov.sugerir | mov.aprobar
                               Cargos (con jerarquia continua), motivos de
                               egreso, permisos del actor (sugerir/aprobar) y
                               el nivel de asignacion del rol.
     list    {estado?, q?}     gate view.cambiocargo. Movimientos del alcance.
     suggest {items:[...], approve?}  gate mov.sugerir (approve=true exige
                               mov.aprobar): inserta uno o varios movimientos.
     approve {id}              gate mov.aprobar.
     reject  {id, reason?}     gate mov.aprobar.
     export  {ids?}            gate mov.aprobar. Arma la matriz de la plantilla
                               AX (18 columnas, traslado=2 filas) de los
                               aprobados y los marca exportados.

   Secrets: supabase_url, supabase_service_role
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

/* Alcance de EMPRESAS del actor (patron movements.js): superadmin -> null
   (todas); resto -> get_admin_companies(p_admin_id). */
async function scopeCodes(env, actor, user) {
  if (actor.role === 'superadmin') return null;
  const adminId = parseInt(user && user.id, 10) || null;
  if (!adminId) return [];
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: adminId }),
  });
  return (rows || []).map(r => r.company_code);
}

const norm = s => String(s == null ? '' : s).trim();
const cleanDigits = s => String(s || '').replace(/\D/g, '');
function isoDate(v) { const s = norm(v); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }

const TIPOS = new Set(['ascenso', 'descenso', 'lateral', 'traslado', 'egreso']);

/* Nivel de asignacion del rol (mov_role_scope). superadmin = -1 (todo).
   Sin fila = 999 (no asigna nada). */
async function assignLevel(env, actor) {
  if (actor.role === 'superadmin') return -1;
  const rows = await sb(env, `mov_role_scope?role_code=eq.${encodeURIComponent(actor.role)}&select=min_assign_level`);
  if (rows && rows.length) return Number(rows[0].min_assign_level);
  return 999;
}

async function loadCargos(env) {
  const rows = await sb(env, 'cargos?is_active=eq.true&select=code,label,ax_code,ambito,hier_level,movable,sort_order&order=hier_level');
  return (rows || []).map(c => ({
    code: c.code, label: c.label, ax_code: c.ax_code || c.code,
    ambito: c.ambito || 'tienda',
    hier_level: c.hier_level == null ? 999 : Number(c.hier_level),
    movable: !!c.movable, sort_order: c.sort_order,
  }));
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const action = norm(body.action) || 'catalog';

  try {
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);

    const mySugerir = can(actor, 'mov.sugerir');
    const myAprobar = can(actor, 'mov.aprobar');
    const myView = can(actor, 'view.cambiocargo') || mySugerir || myAprobar;

    if (action === 'catalog') {
      if (!myView) return json({ ok: false, error: 'No tienes permiso para Cambio de Cargo.' }, 403);
      const [cargos, reasons, minLevel] = await Promise.all([
        loadCargos(env),
        sb(env, 'egress_reasons?is_active=eq.true&select=code,label,sort_order&order=sort_order'),
        assignLevel(env, actor),
      ]);
      return json({
        ok: true,
        cargos,
        egress_reasons: (reasons || []).map(r => ({ code: r.code, label: r.label })),
        my: { sugerir: mySugerir, aprobar: myAprobar, view: myView },
        assign_min_level: minLevel,
        role: actor.role,
      });
    }

    if (action === 'list') {
      if (!myView) return json({ ok: false, error: 'No tienes permiso para ver Cambio de Cargo.' }, 403);
      const codes = await scopeCodes(env, actor, body.user);
      if (codes !== null && !codes.length) return json({ ok: true, rows: [] });

      let path = 'personnel_movement_requests?select=*&order=created_at.desc&limit=500';
      const estado = norm(body.estado);
      if (estado && estado !== 'todos') path += `&estado=eq.${encodeURIComponent(estado)}`;
      if (codes !== null) {
        const inList = codes.map(c => `"${c}"`).join(',');
        path += `&or=(empresa_origen.in.(${inList}),empresa_destino.in.(${inList}))`;
      }
      let rows = await sb(env, path) || [];
      const q = norm(body.q).toLowerCase();
      if (q) rows = rows.filter(r => (r.full_name || '').toLowerCase().includes(q) || (r.id_number || '').includes(q));
      return json({ ok: true, rows });
    }

    if (action === 'suggest') {
      if (!mySugerir) return json({ ok: false, error: 'No tienes permiso para sugerir cambios (mov.sugerir).' }, 403);
      const wantApprove = body.approve === true;
      if (wantApprove && !myAprobar) return json({ ok: false, error: 'No tienes permiso para aprobar (mov.aprobar).' }, 403);

      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json({ ok: false, error: 'No hay movimientos que registrar.' }, 400);

      const codes = await scopeCodes(env, actor, body.user);
      const cargos = await loadCargos(env);
      const byCode = c => cargos.find(x => x.code === c);
      const minLevel = await assignLevel(env, actor);

      const nowIso = new Date().toISOString();
      const estado = wantApprove ? 'aprobado' : 'sugerido';
      const rowsToInsert = [];

      for (const it of items) {
        const idNumber = cleanDigits(it.id_number);
        const tipo = norm(it.tipo);
        if (!idNumber || !TIPOS.has(tipo)) return json({ ok: false, error: 'Movimiento invalido (cedula o tipo).' }, 400);

        const empOrigen = norm(it.empresa_origen) || null;
        const empDestino = norm(it.empresa_destino) || null;
        // Alcance: el origen (o destino en traslado) debe estar en el alcance.
        if (codes !== null) {
          const ok = (empOrigen && codes.includes(empOrigen)) || (empDestino && codes.includes(empDestino));
          if (!ok) return json({ ok: false, error: 'Ese personal esta fuera de tu alcance.' }, 403);
        }

        const cargoTo = norm(it.cargo_to) || null;
        // Validar que el cargo destino sea asignable por el rol (excepto egreso).
        if (tipo !== 'egreso' && cargoTo) {
          const c = byCode(cargoTo);
          if (!c) return json({ ok: false, error: 'Cargo destino no valido.' }, 400);
          if (!(actor.role === 'superadmin') && c.hier_level <= minLevel) {
            return json({ ok: false, error: `Tu rol no puede asignar el cargo ${c.label}.` }, 403);
          }
        }

        rowsToInsert.push({
          tipo,
          id_number: idNumber,
          full_name: norm(it.full_name) || null,
          cargo_from: norm(it.cargo_from) || null,
          cargo_to: tipo === 'egreso' ? null : cargoTo,
          empresa_origen: empOrigen,
          empresa_destino: tipo === 'traslado' ? empDestino : null,
          motivo: norm(it.motivo) || null,
          fecha_efectiva: isoDate(it.fecha_efectiva),
          fecha_baja: isoDate(it.fecha_baja),
          fecha_alta: isoDate(it.fecha_alta),
          estado,
          comentario: norm(it.comentario) || null,
          suggested_by: String(actor.actor || ''),
          suggested_role: actor.role,
          approved_by: wantApprove ? String(actor.actor || '') : null,
          approved_at: wantApprove ? nowIso : null,
        });
      }

      const ins = await sb(env, 'personnel_movement_requests', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(rowsToInsert),
      });
      return json({ ok: true, inserted: ins || [], estado });
    }

    if (action === 'approve') {
      if (!myAprobar) return json({ ok: false, error: 'No tienes permiso para aprobar (mov.aprobar).' }, 403);
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta el id.' }, 400);
      await sb(env, `personnel_movement_requests?id=eq.${id}&estado=eq.sugerido`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ estado: 'aprobado', approved_by: String(actor.actor || ''), approved_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    if (action === 'reject') {
      if (!myAprobar) return json({ ok: false, error: 'No tienes permiso para rechazar (mov.aprobar).' }, 403);
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta el id.' }, 400);
      await sb(env, `personnel_movement_requests?id=eq.${id}&estado=in.(sugerido,aprobado)`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ estado: 'rechazado', rejected_by: String(actor.actor || ''), rejected_at: new Date().toISOString(), reject_reason: norm(body.reason) || null, updated_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    if (action === 'export') {
      if (!myAprobar) return json({ ok: false, error: 'No tienes permiso para exportar (mov.aprobar).' }, 403);
      return await exportPlantilla(env, actor, body);
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status);
    return json({ ok: false, error: 'Error interno: ' + String(e && e.message ? e.message : e) }, 500);
  }
}

/* ---------- export: matriz de la plantilla de Modificacion AX ----------
   18 columnas exactas del archivo MODIFICACIONES. Traslado = 2 filas (B origen
   / A destino). Ascenso/descenso/lateral = 1 fila M. Egreso = 1 fila B.
   Devuelve { columns, rows, filename } para que el front arme el .xlsx, y
   marca los movimientos como 'exportado'. */
const AX_COLUMNS = [
  'Nombre', 'Segundo Nombre', 'Apellidos', 'Numero de Personal', 'Correo Electrónico',
  'Data ID', 'Fecha inicial de Empleo', 'Fecha Final de Empleo', 'Cargo', 'Direccion',
  'Fecha de Nacimiento', 'Estado Civil', 'Telefono', 'Genero', 'Nro de Cuenta Bancaria',
  'TodoTicket', 'Accion', 'Clave',
];

function fmtAx(iso) { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; }

async function exportPlantilla(env, actor, body) {
  const ids = Array.isArray(body.ids) ? body.ids.map(n => parseInt(n, 10)).filter(Boolean) : null;
  const codes = await scopeCodes(env, actor, body.user);

  let path = 'personnel_movement_requests?estado=eq.aprobado&select=*&order=created_at.asc';
  if (ids && ids.length) path += `&id=in.(${ids.join(',')})`;
  if (codes !== null && codes.length) {
    const inList = codes.map(c => `"${c}"`).join(',');
    path += `&or=(empresa_origen.in.(${inList}),empresa_destino.in.(${inList}))`;
  } else if (codes !== null && !codes.length) {
    return json({ ok: true, columns: AX_COLUMNS, rows: [], filename: null, exported: 0 });
  }
  const moves = await sb(env, path) || [];
  if (!moves.length) return json({ ok: true, columns: AX_COLUMNS, rows: [], filename: null, exported: 0 });

  const cargos = await loadCargos(env);
  const axOf = code => { const c = cargos.find(x => x.code === code); return c ? c.ax_code : (code || ''); };

  // Datos maestros de cada persona (para llenar la plantilla).
  const ceds = [...new Set(moves.map(m => m.id_number).filter(Boolean))];
  const masters = {};
  if (ceds.length) {
    const inCed = ceds.map(c => `"${c}"`).join(',');
    const mrows = await sb(env,
      `workers_master?id_number=in.(${inCed})&select=id_number,first_name,second_name,last_names,email,data_id,address,birth_date,marital_status,phone,gender,account_number,todo_ticket`);
    (mrows || []).forEach(r => { masters[r.id_number] = r; });
  }
  // Fecha de ingreso original (primer tramo del Grupo) por persona, para M/B.
  const ingByCed = {};
  await Promise.all(ceds.map(async ced => {
    try {
      const h = await sb(env, 'rpc/get_group_history', { method: 'POST', body: JSON.stringify({ p_ced: ced }) });
      if (h && h.length) ingByCed[ced] = h[0].ini || null;
    } catch (_) { /* sin historia: queda vacio */ }
  }));

  const baseRow = (m, accion, cargoAx, fIni, fFin) => {
    const w = masters[m.id_number] || {};
    return [
      w.first_name || '', w.second_name || '', w.last_names || '', m.id_number, w.email || '',
      w.data_id || '', fmtAx(fIni), fmtAx(fFin), cargoAx, w.address || '',
      fmtAx(w.birth_date), w.marital_status || '', w.phone || '', w.gender || '', w.account_number || '',
      w.todo_ticket || '', accion, '',
    ];
  };

  const rows = [];
  for (const m of moves) {
    const ing = ingByCed[m.id_number] || null;
    if (m.tipo === 'egreso') {
      rows.push(baseRow(m, 'B', axOf(m.cargo_from), ing, m.fecha_baja));
    } else if (m.tipo === 'traslado') {
      // Fila 1: B en origen (ultimo dia). Fila 2: A en destino (primer dia).
      rows.push(baseRow(m, 'B', axOf(m.cargo_from), ing, m.fecha_baja));
      rows.push(baseRow(m, 'A', axOf(m.cargo_to || m.cargo_from), m.fecha_alta, null));
    } else {
      // ascenso / descenso / lateral -> M con el nuevo cargo, ingreso original.
      rows.push(baseRow(m, 'M', axOf(m.cargo_to || m.cargo_from), ing, null));
    }
  }

  // Marcar exportados.
  const doneIds = moves.map(m => m.id).filter(Boolean);
  if (doneIds.length) {
    await sb(env, `personnel_movement_requests?id=in.(${doneIds.join(',')})`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ estado: 'exportado', exported_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return json({ ok: true, columns: AX_COLUMNS, rows, filename: `MODIFICACIONES_CAMBIO_CARGO_${stamp}.xlsx`, exported: doneIds.length });
}
