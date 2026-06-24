/* =====================================================================
   js/reports/report-modificacion.js
   Definicion del reporte de Modificacion de Datos (accion AX 'M').
   Aporta el paso 4 y el envio. Se enchufa al wizard-core compartido.

   Como Egreso, el trabajador SALE del roster (el paso 3 lo elige). En el
   paso 4, por cada trabajador se abre un modal que muestra los campos
   modificables (catalogo modificacion_fields) con su VALOR ACTUAL precargado
   cuando el roster lo conoce (nombre dividido, cargo, cuenta, todoticket).

   MODELO (decision de Pablo): solo viaja lo que CAMBIA.
     - Cada campo se compara contra su valor actual; si difiere, "cambia" y
       viaja. Lo no tocado no se modifica.
     - Los combos sin dato (Estado civil, y cualquier combo sin valor actual)
       arrancan en "— sin seleccionar —" para no cambiar falsamente.
     - La cedula identifica y NO es modificable: va siempre con cada linea.
     - El nombre se captura dividido en 3 sub-campos (primer/segundo nombre
       y apellidos), porque AX los necesita separados.
     - Validacion por tipo (cuenta 20+banco, telefono 04XX+operadora, correo,
       fecha nac. mayor de 18, etc).

   Cada worker del roster lleva su resultado en w.modif:
     { changes: { code|first_name|second_name|last_names: valorNuevo, ... },
       count }  // count = numero de campos que cambian
   ===================================================================== */

import { $ } from '../core/dom.js';

// Catalogo del wizard (campos modificables + cargos/bancos/operadoras). Una vez.
let CAT = null;

async function loadCatalogs() {
  if (CAT) return CAT;
  const res = await fetch('/api/catalog', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'modificacion_catalogs' }),
  }).then(r => r.json()).catch(() => null);
  CAT = (res && res.ok) ? {
    fields: res.fields || [],
    cargos: res.cargos || [],
    bancos: res.bancos || [],
    operadoras: res.operadoras || [],
    bankMap: Object.fromEntries((res.bancos || []).map(b => [b.code, b.name])),
    opMap: Object.fromEntries((res.operadoras || []).map(o => [o.code, o.name])),
    cargoMap: Object.fromEntries((res.cargos || []).map(c => [c.code, c.label])),
  } : { fields: [], cargos: [], bancos: [], operadoras: [], bankMap: {}, opMap: {}, cargoMap: {} };
  return CAT;
}

/* Etiqueta legible de un valor segun el tipo de campo. */
function maritalLabel(v) {
  return ({ S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a' })[v] || v;
}
function genderLabel(v) {
  return ({ M: 'Masculino', F: 'Femenino' })[v] || v;
}

/* ¿el trabajador ya tiene al menos un cambio configurado? */
function modifComplete(w) {
  return !!(w.modif && w.modif.count > 0);
}

/* Texto corto de "lo que cambia" para la grilla y el resumen. */
function changesSummary(w) {
  const ch = w.modif && w.modif.changes;
  if (!ch) return [];
  const out = [];
  if ('first_name' in ch || 'last_names' in ch) {
    out.push(['Nombre', [ch.first_name, ch.second_name, ch.last_names].filter(Boolean).join(' ')]);
  }
  if ('cargo' in ch) out.push(['Cargo', (CAT.cargoMap[ch.cargo]) || ch.cargo]);
  if ('cuenta' in ch) out.push(['Cuenta', `${ch.cuenta} (${CAT.bankMap[ch.cuenta.slice(0, 4)] || ''})`]);
  if ('telefono' in ch) out.push(['Teléfono', '0' + String(ch.telefono).replace(/^\+58/, '')]);
  if ('correo' in ch) out.push(['Correo', ch.correo]);
  if ('direccion' in ch) out.push(['Dirección', ch.direccion]);
  if ('estCivil' in ch) out.push(['Estado civil', maritalLabel(ch.estCivil)]);
  if ('sexo' in ch) out.push(['Sexo', genderLabel(ch.sexo)]);
  if ('fechaNac' in ch) out.push(['Fecha de nacimiento', ch.fechaNac]);
  if ('todoTicket' in ch) out.push(['TodoTicket', ch.todoTicket === 'S' ? 'Sí' : 'No']);
  return out;
}

export const modificacionReport = {
  code: 'modificacion',
  title: 'Reportar Modificación de Datos',
  icon: '✏️',
  tag: 'Modificación · wizard',
  step4Label: 'Modificaciones',

  summaryColumns: [
    { key: 'kind', label: 'Tipo' },
    { key: 'cambios', label: 'Campos que cambian' },
    { key: 'detalle', label: '' },
  ],
  summaryCell(w, key) {
    if (key === 'kind') return '<span class="pill pill-set">M · Modificación</span>';
    if (key === 'cambios') {
      const s = changesSummary(w);
      if (!s.length) return '<span class="pill pill-pend">sin cambios</span>';
      return s.map(([k]) => `<span class="pill pill-role">${k}</span>`).join(' ');
    }
    if (key === 'detalle') {
      return `<button type="button" class="btn btn-sm" data-detail-ced="${w.ced}">👁 Ver detalle</button>`;
    }
    return '';
  },

  isComplete(w) { return modifComplete(w); },

  renderStep4(ctx) {
    $('#wzPanel').innerHTML = '<div class="pnl-loading">Cargando…</div>';
    loadCatalogs().then(() => paintStep4(ctx));
  },

  async submit({ companyCode, responsible, position, workers, source_kind, source_admin_id }) {
    const lines = workers.map(w => ({
      id_number: w.ced,
      worker_name: w.name,
      changes: (w.modif && w.modif.changes) || {},
    }));
    const res = await fetch('/api/reports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'submit_modificacion',
        company_code: companyCode,
        responsible, position,
        lines,
        source_kind, source_admin_id,
      }),
    });
    return res.json();
  },
};

/* ===================== PASO 4 ===================== */

// Lista accesible para el boton "Ver detalle" del Resumen.
let LAST_WORKERS = [];

/* Resuelve y cuelga en cada worker su fila completa del roster (w._roster),
   buscando por cedula en ctx.roster. El worker que llega del paso 3 solo
   trae { id, ced, name, role, endDate }; la fila del roster (que SI tiene
   account_number, phone, email, gender, marital_status, birth_date, address,
   todo_ticket, first_name/second_name/last_names, cargo_code) vive en
   ctx.roster. Esta resolucion es lo que permite PRECARGAR los valores
   actuales en el modal. Si el trabajador se agrego a mano (no esta en el
   roster), w._roster queda como objeto vacio y el modal arranca en blanco. */
function attachRoster(ctx) {
  const byCed = {};
  (ctx.roster || []).forEach(r => { byCed[String(r.id_number)] = r; });
  (ctx.workers || []).forEach(w => {
    if (!w._roster) w._roster = byCed[String(w.ced)] || {};
  });
}

function paintStep4(ctx) {
  attachRoster(ctx);
  const panel = $('#wzPanel');
  panel.innerHTML = `
    <h2>Modificar datos de trabajadores</h2>
    <p class="hint">Por cada trabajador, indica <b>solo los campos que cambian</b>. Lo que no toques no se modifica. La <b>cédula</b> identifica al trabajador y siempre acompaña el reporte.</p>

    <div class="progress-line">
      <span id="moProg">0 de ${ctx.workers.length} configurados</span>
      <div class="progress-bar"><div id="moProgBar" style="width:0%"></div></div>
    </div>

    <table>
      <thead><tr>
        <th>Trabajador</th><th>Tipo</th><th>Campos que cambian</th><th style="width:130px"></th>
      </tr></thead><tbody id="moTbody"></tbody>
    </table>

    <div class="wiz-foot">
      <button class="btn" id="moBack">← Atrás</button>
      <button class="btn btn-primary" id="moNext" disabled>Revisar y enviar →</button>
    </div>`;

  $('#moBack').addEventListener('click', () => ctx.setStep(3));
  $('#moNext').addEventListener('click', () => ctx.setStep(5));
  renderRows(ctx);
}

function updateNext(ctx) {
  const total = ctx.workers.length;
  const done = ctx.workers.filter(modifComplete).length;
  const btn = $('#moNext');
  if (btn) btn.disabled = done !== total || total === 0;
  const prog = $('#moProg');
  if (prog) prog.textContent = `${done} de ${total} configurados`;
  const bar = $('#moProgBar');
  if (bar) bar.style.width = total ? (done / total * 100) + '%' : '0%';
}

function renderRows(ctx) {
  LAST_WORKERS = ctx.workers || [];
  const tb = $('#moTbody');
  if (!tb) return;

  tb.innerHTML = ctx.workers.map(w => {
    const ok = modifComplete(w);
    const chips = ok
      ? changesSummary(w).map(([k]) => `<span class="pill pill-role">${k}</span>`).join(' ')
      : '<span class="pill pill-pend">sin cambios</span>';
    return `<tr class="${ok ? 'done-row' : ''}">
      <td><b>${w.name}</b><br><span class="ced">${w.ced}</span></td>
      <td><span class="pill pill-set">M · Modificación</span></td>
      <td>${chips}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm" data-cfg="${w.id}">${ok ? '✏️ Editar' : '＋ Configurar'}</button>
        <button class="x-btn" data-rm="${w.id}" title="Quitar">✕</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="empty">No hay trabajadores. Vuelve al paso anterior para agregarlos.</td></tr>';

  tb.querySelectorAll('[data-cfg]').forEach(b => b.addEventListener('click', () => openModifModal(ctx, +b.dataset.cfg)));
  tb.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
    const w = ctx.getWorker(+b.dataset.rm);
    if (w && !confirm(`¿Quitar a ${w.name} del reporte?`)) return;
    ctx.removeWorker(+b.dataset.rm);
    renderRows(ctx); updateNext(ctx);
  }));

  updateNext(ctx);
}

/* ---------- Validacion por tipo (espejo del server) ---------- */
function validateField(kind, raw) {
  const v = (raw == null ? '' : String(raw)).trim();
  if (v === '') return { ok: true, empty: true, val: '' };
  switch (kind) {
    case 'account': {
      const d = v.replace(/[^0-9]/g, '');
      if (d.length !== 20) return { ok: false, msg: `La cuenta debe tener 20 dígitos (van ${d.length}).` };
      if (!CAT.bankMap[d.slice(0, 4)]) return { ok: false, msg: `El prefijo ${d.slice(0, 4)} no es un banco válido.` };
      return { ok: true, val: d };
    }
    case 'phone': {
      const d = v.replace(/[^0-9]/g, '');
      if (d.length !== 11 || d[0] !== '0') return { ok: false, msg: 'Teléfono de 11 dígitos (04XX-XXXXXXX).' };
      if (!CAT.opMap[d.slice(0, 4)]) return { ok: false, msg: `Prefijo ${d.slice(0, 4)} inválido.` };
      return { ok: true, val: '+58' + d.slice(1) };
    }
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, msg: 'Correo con formato inválido.' };
      return { ok: true, val: v };
    case 'name':
      if (v.length < 2) return { ok: false, msg: 'Demasiado corto.' };
      return { ok: true, val: v.toUpperCase() };
    case 'nameopt':
      return { ok: true, val: v.toUpperCase() };
    case 'gender':
      if (v !== 'M' && v !== 'F') return { ok: false, msg: 'Selecciona M o F.' };
      return { ok: true, val: v };
    case 'birthdate': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, msg: 'Fecha inválida.' };
      const age = (Date.now() - new Date(v)) / (365.25 * 864e5);
      if (age < 18) return { ok: false, msg: 'No se permiten menores de 18.' };
      if (age > 100) return { ok: false, msg: 'Fecha demasiado antigua.' };
      return { ok: true, val: v };
    }
    default:
      return { ok: true, val: v };
  }
}

/* Valor ACTUAL del trabajador para un code de campo (lo que conoce el
   roster). Devuelve string vacio si no se conoce. El nombre se maneja
   aparte (3 sub-campos). */
function currentValue(w, code) {
  const r = w._roster || {};
  switch (code) {
    case 'cargo': {
      // El roster trae cargo_code (resuelto) o role (texto). Solo precargamos
      // si coincide con un code del catalogo de cargos.
      const cc = r.cargo_code || '';
      return CAT.cargoMap[cc] ? cc : '';
    }
    case 'cuenta': return r.account_number || '';
    case 'telefono': {
      // El roster guarda +58...; el input se maneja en nacional.
      const p = r.phone || '';
      return p ? '0' + String(p).replace(/^\+58/, '') : '';
    }
    case 'correo': return r.email || '';
    case 'direccion': return r.address || '';
    case 'estCivil': return r.marital_status || '';
    case 'sexo': return r.gender || '';
    case 'fechaNac': return r.birth_date ? String(r.birth_date).slice(0, 10) : '';
    case 'todoTicket': return r.todo_ticket || '';
    default: return '';
  }
}

/* ---------- MODAL: configurar la modificacion de UN trabajador ---------- */
function openModifModal(ctx, id) {
  const w = ctx.getWorker(id);
  if (!w) return;
  const r = w._roster || {};

  // Valor actual del nombre dividido (del roster, ya dividido si existe; si
  // no, dividir el nombre completo con la heuristica simple: ultima palabra
  // = apellido, lo de antes = primer/segundo).
  let curFirst = (r.first_name || '').toUpperCase();
  let curSecond = (r.second_name || '').toUpperCase();
  let curLast = (r.last_names || '').toUpperCase();
  if (!curFirst && !curLast) {
    const parts = String(w.name || r.full_name || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
    if (parts.length >= 3) { curFirst = parts[0]; curSecond = parts[1]; curLast = parts.slice(2).join(' '); }
    else if (parts.length === 2) { curFirst = parts[0]; curLast = parts[1]; }
    else if (parts.length === 1) { curFirst = parts[0]; }
  }

  // Estado de edicion (DRAFT): arranca con los valores actuales precargados
  // (nombre dividido + los campos que el roster conoce). Los que no conoce
  // arrancan vacios (combos en "— sin seleccionar —").
  const draft = {
    first_name: curFirst, second_name: curSecond, last_names: curLast,
  };
  CAT.fields.forEach(f => {
    if (f.code === 'nombre') return; // el nombre va aparte (3 sub-campos)
    draft[f.code] = currentValue(w, f.code);
  });

  // Valores ORIGINALES (para detectar cambios). Inmutables.
  const orig = { ...draft };

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal modal-wide">
      <h3>Modificar datos</h3>
      <p class="who">${w.name} · <span class="ced">${w.ced}</span></p>
      <p class="hint" style="margin:-4px 0 10px">Cambia solo lo que haga falta. Lo que no toques no se modifica.</p>

      <div class="mo-anchor">
        <span class="mo-anchor-lbl">🪪 Cédula</span>
        <span class="mo-anchor-val">${w.ced}</span>
        <span class="pill pill-set" style="margin-left:auto">siempre va</span>
      </div>

      <div id="moFields"></div>

      <p class="hint" style="margin-top:6px">Los valores actuales se precargan de la lista de la tienda cuando existen. Los campos sin dato (teléfono, correo, estado civil…) se completan a mano.</p>

      <div class="mo-summary" id="moSummary"></div>

      <div class="wiz-foot" style="margin-top:14px">
        <span class="count" id="moCount"></span>
        <div style="display:flex;gap:8px">
          <button class="btn" id="moCancel">Cancelar</button>
          <button class="btn btn-primary" id="moSave" disabled>Aplicar al reporte</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const q = s => ov.querySelector(s);

  // ---- Render de los campos ----
  // El nombre se despliega en 3 sub-campos. El resto, un control por campo
  // segun su input_kind. Los combos sin valor actual arrancan vacios.
  function fieldControl(f) {
    const code = f.code;
    if (code === 'nombre') {
      return `
        <div class="mo-namegrid">
          ${nameInput('first_name', 'Primer nombre', draft.first_name)}
          ${nameInput('second_name', 'Segundo nombre', draft.second_name, true)}
          ${nameInput('last_names', 'Apellidos', draft.last_names)}
          <div class="mo-fullname">
            <span class="l">Nombre completo</span>
            <span class="v" data-fullname>${esc(joinName(draft))}</span>
          </div>
        </div>`;
    }
    const cur = draft[code];
    if (f.input_kind === 'cargo') {
      const has = !!cur;
      let o = `<option value="">${has ? '' : '— sin seleccionar —'}</option>`;
      CAT.cargos.forEach(c => { o += `<option value="${c.code}" ${cur === c.code ? 'selected' : ''}>${c.label}</option>`; });
      return `<select data-code="${code}">${o}</select>`;
    }
    if (f.input_kind === 'marital') {
      // Combo SIN preseleccion si no hay dato (evita cambio falso).
      const MAR = [['S', 'Soltero/a'], ['C', 'Casado/a'], ['D', 'Divorciado/a'], ['V', 'Viudo/a']];
      let o = `<option value="">— sin seleccionar —</option>`;
      MAR.forEach(([v, t]) => { o += `<option value="${v}" ${cur === v ? 'selected' : ''}>${t}</option>`; });
      return `<select data-code="${code}">${o}</select>`;
    }
    if (f.input_kind === 'gender') {
      // Sexo: combo M/F. SIN preseleccion si el roster no lo conoce (sale
      // vacio al modificar, no marca cambio falso). Si el dato existe, viene
      // ya seleccionado para que se vea el actual.
      const GEN = [['M', 'Masculino'], ['F', 'Femenino']];
      let o = `<option value="">— sin seleccionar —</option>`;
      GEN.forEach(([v, t]) => { o += `<option value="${v}" ${cur === v ? 'selected' : ''}>${t}</option>`; });
      return `<select data-code="${code}">${o}</select>`;
    }
    if (f.input_kind === 'todoticket') {
      const has = !!cur;
      let o = `<option value="">${has ? '' : '— sin seleccionar —'}</option>`;
      [['S', 'Sí'], ['N', 'No']].forEach(([v, t]) => { o += `<option value="${v}" ${cur === v ? 'selected' : ''}>${t}</option>`; });
      return `<select data-code="${code}">${o}</select>`;
    }
    if (f.input_kind === 'birthdate') {
      return `<input type="date" data-code="${code}" value="${esc(cur)}">`;
    }
    const ph = cur ? '' : '(sin dato — escribe el nuevo valor)';
    return `<input type="text" data-code="${code}" value="${esc(cur)}" placeholder="${ph}">`;
  }
  function nameInput(key, label, val, opt) {
    return `<div>
      <label class="flabel">${label}${opt ? ' <span class="opt">(opcional)</span>' : ''}</label>
      <input type="text" data-code="${key}" value="${esc(val)}">
    </div>`;
  }
  // Nombre completo armado a partir del draft (primer + segundo + apellidos).
  function joinName(d) {
    return [d.first_name, d.second_name, d.last_names].map(s => String(s || '').trim()).filter(Boolean).join(' ');
  }

  function renderFields() {
    const box = q('#moFields');
    box.innerHTML = CAT.fields.map(f => `
      <div class="mo-frow" data-row="${f.code}">
        <div class="mo-fname">${f.label}${f.note ? `<small>${esc(f.note)}</small>` : ''}</div>
        <div class="mo-fctrl">${fieldControl(f)}</div>
        <div class="mo-fstatus" data-status="${f.code}"></div>
        <div class="mo-ferr" data-err="${f.code}"></div>
      </div>`).join('');
    box.querySelectorAll('input,select').forEach(el => {
      el.addEventListener('input', onEdit);
      el.addEventListener('change', onEdit);
    });
    refresh();
  }

  function onEdit(e) {
    const code = e.target.dataset.code;
    draft[code] = e.target.value;
    // Refrescar el nombre completo armado en vivo cuando cambia una de sus partes.
    if (code === 'first_name' || code === 'second_name' || code === 'last_names') {
      const fn = q('[data-fullname]');
      if (fn) fn.textContent = joinName(draft);
    }
    refresh();
  }

  // ¿el code (o el nombre) difiere de su original?
  function isChanged(code) {
    if (code === 'nombre') {
      return draft.first_name !== orig.first_name
        || draft.second_name !== orig.second_name
        || draft.last_names !== orig.last_names;
    }
    return String(draft[code] ?? '') !== String(orig[code] ?? '');
  }

  function refresh() {
    let changes = [], hasError = false;
    CAT.fields.forEach(f => {
      const row = q(`[data-row="${f.code}"]`);
      const statusEl = q(`[data-status="${f.code}"]`);
      const errEl = q(`[data-err="${f.code}"]`);
      const changed = isChanged(f.code);

      // Validacion (solo de lo que cambia y no esta vacio).
      let err = '';
      if (changed) {
        if (f.code === 'nombre') {
          const v1 = validateField('name', draft.first_name);
          const v3 = validateField('name', draft.last_names);
          if (!draft.first_name.trim()) err = 'Falta el primer nombre.';
          else if (!draft.last_names.trim()) err = 'Faltan los apellidos.';
          else if (!v1.ok) err = v1.msg;
          else if (!v3.ok) err = v3.msg;
        } else {
          const r2 = validateField(f.input_kind, draft[f.code]);
          if (!r2.ok) err = r2.msg;
          // Campos de texto obligatorio si cambian (direccion no puede quedar vacia)
          if (r2.empty && f.input_kind === 'text') err = 'No puede quedar vacío si se modifica.';
        }
        if (err) hasError = true;
      }

      if (row) row.classList.toggle('changed', changed && !err);
      if (statusEl) {
        statusEl.innerHTML = changed
          ? (err ? '<span class="pill pill-pend">revisar</span>' : '<span class="pill pill-set">✎ cambia</span>')
          : (origHasValue(f.code) ? '<span class="mo-same">sin cambio</span>' : '<span class="mo-empty">sin dato</span>');
      }
      if (errEl) errEl.textContent = err;

      if (changed && !err) changes.push(f.code);
    });

    // Resumen
    const sum = q('#moSummary');
    if (changes.length) {
      const items = buildChanges(changes);
      sum.innerHTML = `<div class="mo-sum-title">➡ Lo que viajará a la plantilla</div>
        <ul><li><span class="k">Cédula</span><span class="arrow">→</span><span class="nv">${w.ced} (identifica)</span></li>`
        + items.map(([k, v]) => `<li><span class="k">${k}</span><span class="arrow">→</span><span class="nv">${esc(v)}</span></li>`).join('')
        + `</ul>`;
    } else {
      sum.innerHTML = `<div class="mo-sum-title">➡ Lo que viajará a la plantilla</div>
        <span class="mo-none">Aún no has cambiado ningún campo.</span>`;
    }

    const cnt = q('#moCount');
    if (cnt) cnt.innerHTML = changes.length ? `<b>${changes.length}</b> campo${changes.length > 1 ? 's' : ''} a modificar` : 'Ningún campo modificado';
    q('#moSave').disabled = changes.length === 0 || hasError;
  }

  function origHasValue(code) {
    if (code === 'nombre') return !!(orig.first_name || orig.last_names);
    return !!String(orig[code] ?? '');
  }

  // Construye la lista [label, valorNuevo] de lo que cambia (para el resumen).
  function buildChanges(codes) {
    const out = [];
    codes.forEach(code => {
      if (code === 'nombre') {
        out.push(['Nombre', [draft.first_name, draft.second_name, draft.last_names].filter(Boolean).join(' ')]);
      } else if (code === 'cargo') out.push(['Cargo', CAT.cargoMap[draft.cargo] || draft.cargo]);
      else if (code === 'cuenta') out.push(['Cuenta', `${draft.cuenta} (${CAT.bankMap[draft.cuenta.slice(0, 4)] || ''})`]);
      else if (code === 'telefono') out.push(['Teléfono', draft.telefono]);
      else if (code === 'correo') out.push(['Correo', draft.correo]);
      else if (code === 'direccion') out.push(['Dirección', draft.direccion]);
      else if (code === 'estCivil') out.push(['Estado civil', maritalLabel(draft.estCivil)]);
      else if (code === 'sexo') out.push(['Sexo', genderLabel(draft.sexo)]);
      else if (code === 'fechaNac') out.push(['Fecha de nacimiento', draft.fechaNac]);
      else if (code === 'todoTicket') out.push(['TodoTicket', draft.todoTicket === 'S' ? 'Sí' : 'No']);
    });
    return out;
  }

  q('#moCancel').addEventListener('click', () => ov.remove());
  q('#moSave').addEventListener('click', () => {
    // Construir el objeto changes final (solo lo que cambia, ya validado y
    // normalizado). Para el nombre, las 3 sub-claves.
    const changes = {};
    CAT.fields.forEach(f => {
      if (!isChangedFinal(f.code)) return;
      if (f.code === 'nombre') {
        changes.first_name = draft.first_name.trim().toUpperCase();
        changes.second_name = draft.second_name.trim().toUpperCase();
        changes.last_names = draft.last_names.trim().toUpperCase();
      } else {
        const r2 = validateField(f.input_kind, draft[f.code]);
        changes[f.code] = r2.ok ? r2.val : draft[f.code];
      }
    });
    w.modif = { changes, count: Object.keys(changes).filter(k => !['second_name'].includes(k) || true).length
      // contar "nombre" como 1 aunque sean 3 claves
    };
    // Recontar de forma legible: nº de campos del catalogo que cambian.
    w.modif.count = CAT.fields.filter(f => isChangedFinal(f.code)).length;
    ov.remove();
    renderRows(ctx);
  });

  function isChangedFinal(code) {
    if (code === 'nombre') {
      return draft.first_name !== orig.first_name
        || draft.second_name !== orig.second_name
        || draft.last_names !== orig.last_names;
    }
    return String(draft[code] ?? '') !== String(orig[code] ?? '');
  }

  renderFields();
  setTimeout(() => { const f = q('#moFields input,select'); if (f) f.focus(); }, 40);
}

function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

/* =====================================================================
   FICHA SOLO-LECTURA (Resumen -> "Ver detalle")
   ===================================================================== */
window.__nv2VerModif = function (ced) {
  const w = (LAST_WORKERS || []).find(x => String(x.ced) === String(ced));
  if (!w || !w.modif) { alert('No se encontraron los cambios de este trabajador.'); return; }
  openModifView(w);
};

function openModifView(w) {
  const items = changesSummary(w);
  const row = (label, value) =>
    `<div class="vr-row"><span class="vr-lbl">${label}</span><span class="vr-val">${value == null || value === '' ? '—' : esc(value)}</span></div>`;
  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal">
      <h3>Detalle de la modificación</h3>
      <p class="who">${esc(w.name)} · <span class="pill pill-set">M · Modificación</span> · solo lectura</p>
      <div class="mo-anchor" style="margin:8px 0 12px">
        <span class="mo-anchor-lbl">🪪 Cédula</span>
        <span class="mo-anchor-val">${w.ced}</span>
        <span class="pill pill-set" style="margin-left:auto">identifica</span>
      </div>
      <div class="ig-sec" style="margin-top:0">Campos que cambian</div>
      ${items.length ? items.map(([k, v]) => row(k, v)).join('') : '<div class="vr-row"><span class="vr-val" style="color:var(--muted)">Sin cambios.</span></div>'}
      <div class="wiz-foot" style="margin-top:18px">
        <span></span>
        <button class="btn btn-primary" id="mvClose">Cerrar</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#mvClose').addEventListener('click', close);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
}
