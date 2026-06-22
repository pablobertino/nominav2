/* =====================================================================
   js/reports/report-ausencia.js
   Definicion del reporte de Ausencia. Aporta el paso 4 y el envio.
   Se enchufa al wizard-core compartido.

   Patron de UI (unico, reutilizable por los proximos reportes):
     - Una sola TABLA compacta, una fila por trabajador, que escala a
       muchos (20+). Cada fila muestra su estado (Desde/Hasta, documento,
       nota) y un boton "Configurar/Editar".
     - La configuracion de cada trabajador se hace en un MODAL: fechas +
       nota + (si el tipo lo requiere) el documento, todo junto.
     - Accion en bloque: marcar varias filas y aplicar el mismo rango.
     - El TIPO de ausencia es uno por reporte y NO viene preseleccionado;
       nada aparece hasta elegirlo. (Regla UX del proyecto: ningun campo
       de reporte arranca con valor por defecto.)

   Adjuntos: el archivo NO se sube a Storage. Se lee a base64 al elegirlo
   y viaja dentro del envio hacia osTicket (ticket DOC por persona). El
   archivo no se persiste en BD; si el envio falla, se re-adjunta (ver DOC).

   Fechas: ventana CONFIGURABLE POR TIPO (no es la ventana de quincena del
   marcaje). Cada tipo define cuanto hacia atras y hacia el futuro:
     - Hacia atras: si el tipo respeta el corte (past_uses_cutoff), el
       limite lo manda el corte global (corte_margen_dias + hora tope) en
       vivo, para no aceptar fechas fuera del corte de calculo de nomina.
     - Hacia el futuro: future_window_days (0 = sin futuro; ej. prenatal 42).
     - Hasta >= Desde y nunca posterior al egreso del trabajador.
   ===================================================================== */

import { $ } from '../core/dom.js';
import * as DW from './shared/date-window.js';

let TYPES = null; // [{code,label,ax_code,allows_future,note,past_window_days,past_uses_cutoff,future_window_days,docs:[...]}]
let CUTOFF_TIME = '14:00'; // hora tope global (para tipos con past_uses_cutoff)
let GLOBAL_MARGIN = 2;     // corte_margen_dias global (para tipos con past_uses_cutoff)

async function loadTypes() {
  if (TYPES) return TYPES;
  const res = await fetch('/api/catalog', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'absence_types' }),
  }).then(r => r.json()).catch(() => null);
  TYPES = (res && res.ok && res.types) ? res.types : [];
  if (res && res.cutoff_time) CUTOFF_TIME = res.cutoff_time;
  if (res && res.global_margin) GLOBAL_MARGIN = res.global_margin;
  return TYPES;
}

function typeByCode(code) {
  return (TYPES || []).find(t => t.code === code) || null;
}
// Documento principal de un tipo (0 o 1 en la practica). Devuelve null si no lleva.
function docOfType(t) {
  return t && t.docs && t.docs.length ? t.docs[0] : null;
}
function typeHasDoc(t) {
  return !!docOfType(t);
}
// Ventana de fechas (min/max) del tipo elegido, con la hora de corte global.
// Si el tipo respeta el corte (past_uses_cutoff), el margen hacia atras lo
// manda el setting global en vivo (GLOBAL_MARGIN), no el numero guardado:
// asi nunca se permite reportar fuera del corte de calculo de nomina.
function windowOf(t) {
  const usesCutoff = t ? !!t.past_uses_cutoff : false;
  const pastDays = usesCutoff
    ? GLOBAL_MARGIN
    : (t ? t.past_window_days : null);
  return DW.typeWindow({
    pastWindowDays: pastDays,
    pastUsesCutoff: usesCutoff,
    futureWindowDays: t ? t.future_window_days : 0,
    cutoffTime: CUTOFF_TIME,
  });
}

/* Estado local del paso 4 (vive mientras el wizard este montado).
   typeCode arranca null: nada preseleccionado. */
const S = {
  typeCode: null,
};

export const ausenciaReport = {
  code: 'ausencia',
  title: 'Reportar Ausencia',
  icon: '📅',
  tag: 'Ausencia · wizard',
  step4Label: 'Ausencias',

  summaryColumns: [
    { key: 'type', label: 'Tipo' },
    { key: 'from', label: 'Desde' },
    { key: 'to', label: 'Hasta' },
    { key: 'doc', label: 'Documento' },
  ],
  summaryCell(w, key) {
    const a = w.absence || {};
    const t = typeByCode(S.typeCode);
    if (key === 'type') return t ? `${t.label} <span class="pill pill-ax">${t.ax_code}</span>` : '—';
    if (key === 'from') return a.from ? DW.fmtDate(a.from) : '—';
    if (key === 'to') return a.to ? DW.fmtDate(a.to) : '—';
    if (key === 'doc') {
      const doc = docOfType(t);
      if (!doc) return '<span style="color:var(--muted)">No requiere</span>';
      if (a.fileName) return `<span class="pill pill-set">📎 adjunto</span>`;
      return `<span class="pill pill-pend">pendiente</span>`;
    }
    return '';
  },

  isComplete(w) { return !!(w.absence && w.absence.from && w.absence.to); },

  renderStep4(ctx) {
    $('#wzPanel').innerHTML = '<div class="pnl-loading">Cargando…</div>';
    loadTypes().then(() => paintStep4(ctx));
  },

  async submit({ companyCode, responsible, position, workers, source_kind, source_admin_id }) {
    const t = typeByCode(S.typeCode);
    const doc = docOfType(t);
    const lines = workers.map(w => ({
      id_number: w.ced,
      name: w.name,
      date_from: w.absence.from,
      date_to: w.absence.to,
      note: (w.absence.note || '').trim() || null,
      // Documento: nombre + contenido base64 + tipo MIME (si lo hay). El
      // archivo viaja dentro del envio hacia osTicket; NO se guarda en BD.
      doc_file_name: doc ? (w.absence.fileName || null) : null,
      doc_file_b64: doc ? (w.absence.fileB64 || null) : null,
      doc_file_type: doc ? (w.absence.fileType || null) : null,
    }));
    const res = await fetch('/api/reports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'submit_ausencia',
        company_code: companyCode,
        responsible, position,
        absence_code: S.typeCode,
        lines,
        source_kind, source_admin_id,
      }),
    });
    return res.json();
  },
};

/* ===================== PASO 4 ===================== */

function paintStep4(ctx) {
  const panel = $('#wzPanel');
  panel.innerHTML = `
    <h2>Configurar ausencias</h2>

    <div class="type-row">
      <div style="flex:1">
        <label class="flabel">Tipo de ausencia (aplica a este reporte)</label>
        <select id="azType">
          <option value="" selected disabled>Selecciona el tipo de ausencia…</option>
          ${(TYPES || []).map(x => `<option value="${x.code}">${x.label}</option>`).join('')}
        </select>
      </div>
      <div style="width:130px">
        <label class="flabel">Código AX</label>
        <input id="azAx" value="" readonly placeholder="—" style="font-family:monospace;text-align:center;background:#f7f9fc">
      </div>
    </div>
    <p class="hint" id="azHint">Elige primero el tipo de ausencia para configurar a los trabajadores.</p>
    <div id="azCoord" class="coord-note" style="display:none"></div>

    <div id="azAfter" style="display:none">
      <div class="window-info" id="azInfo"></div>
      <div class="progress-line">
        <span id="azProg">0 de ${ctx.workers.length} configurados</span>
        <div class="progress-bar"><div id="azProgBar" style="width:0%"></div></div>
      </div>
      <div class="selbar hidden" id="azSelbar"><b id="azSelCount">0</b> seleccionados
        <span class="spacer"></span>
        <button class="btn btn-sm btn-primary" id="azBulk">Aplicar fechas a seleccionados</button>
        <button class="btn btn-sm" id="azClear">Quitar selección</button>
      </div>
      <table>
        <thead><tr>
          <th style="width:30px"><input type="checkbox" class="chk" id="azAll"></th>
          <th>Trabajador</th><th>Desde</th><th>Hasta</th>
          <th class="az-coldoc">Documento</th><th>Nota</th><th style="width:130px"></th>
        </tr></thead><tbody id="azTbody"></tbody>
      </table>
      <div class="wiz-foot">
        <button class="btn" id="azBack">← Atrás</button>
        <button class="btn btn-primary" id="azNext" disabled>Revisar y enviar →</button>
      </div>
    </div>`;

  // Si ya habia un tipo elegido (volver atras desde el resumen), restaurarlo.
  if (S.typeCode) {
    const sel = $('#azType');
    if (sel) sel.value = S.typeCode;
  }

  $('#azType').addEventListener('change', e => {
    S.typeCode = e.target.value || null;
    // Cambiar de tipo limpia la configuracion previa (las reglas de fecha y
    // el documento dependen del tipo).
    ctx.workers.forEach(w => { w.absence = null; });
    refreshTypeHeader(ctx);
  });
  $('#azBack').addEventListener('click', () => ctx.setStep(3));
  $('#azNext').addEventListener('click', () => ctx.setStep(5));
  $('#azAll').addEventListener('change', e => {
    document.querySelectorAll('.azsel').forEach(c => c.checked = e.target.checked);
    onSel();
  });
  $('#azBulk').addEventListener('click', () => openBulk(ctx));
  $('#azClear').addEventListener('click', () => {
    document.querySelectorAll('.azsel').forEach(c => c.checked = false);
    $('#azAll').checked = false; onSel();
  });

  refreshTypeHeader(ctx);
}

function refreshTypeHeader(ctx) {
  const t = typeByCode(S.typeCode);
  const after = $('#azAfter');
  if (!t) {
    $('#azAx').value = '';
    $('#azHint').textContent = 'Elige primero el tipo de ausencia para configurar a los trabajadores.';
    $('#azCoord').style.display = 'none';
    after.style.display = 'none';
    return;
  }
  $('#azAx').value = t.ax_code;
  const doc = docOfType(t);
  let hint = doc ? `Requiere documento: <b>${doc.name}</b>.` : 'Este tipo no requiere documento.';
  // Describir la ventana de fechas configurada para este tipo.
  // Si respeta el corte global, el limite atras es el margen global en vivo.
  const effPastDays = t.past_uses_cutoff ? GLOBAL_MARGIN : t.past_window_days;
  const back = (effPastDays == null)
    ? 'sin límite hacia atrás'
    : `hasta ${effPastDays} día(s) atrás${t.past_uses_cutoff ? ` (el más antiguo solo hasta las ${CUTOFF_TIME})` : ''}`;
  const fwd = (t.future_window_days > 0)
    ? `hasta ${t.future_window_days} día(s) a futuro`
    : 'sin fechas futuras';
  hint += ` Fechas: ${back}, ${fwd}.`;
  $('#azHint').innerHTML = hint;

  const coord = $('#azCoord');
  if (t.note) { coord.style.display = 'flex'; coord.innerHTML = `⚠ <div>${t.note}</div>`; }
  else { coord.style.display = 'none'; coord.innerHTML = ''; }

  // Mostrar/ocultar la columna Documento segun el tipo.
  document.querySelectorAll('.az-coldoc').forEach(e => e.style.display = doc ? '' : 'none');

  $('#azInfo').innerHTML = doc
    ? `<span>📋</span><div>Configura cada trabajador con <b>Configurar</b> (fechas, nota y su <b>${doc.name}</b>). Si varios comparten el mismo rango, márcalos y usa <b>Aplicar a seleccionados</b>. Si no tienes el documento aún, puedes enviar y queda como <b>documento pendiente</b>.</div>`
    : `<span>📋</span><div>Configura el rango de fechas de cada trabajador con <b>Configurar</b>. Si varios comparten el mismo rango, márcalos y usa <b>Aplicar a seleccionados</b>.</div>`;

  after.style.display = 'block';
  renderRows(ctx);
}

/* Habilita "Revisar y enviar" solo si todos los trabajadores estan completos.
   Con documento 'block', exige tambien el archivo. */
function updateNext(ctx) {
  const t = typeByCode(S.typeCode);
  const doc = docOfType(t);
  const blocking = doc && doc.enforcement === 'block';
  const total = ctx.workers.length;
  const done = ctx.workers.filter(w => {
    const a = w.absence;
    if (!a || !a.from || !a.to) return false;
    if (a.to < a.from) return false;
    if (blocking && !a.fileName) return false;
    return true;
  }).length;
  const btn = $('#azNext');
  if (btn) btn.disabled = done !== total || total === 0;
  const prog = $('#azProg');
  if (prog) prog.textContent = `${done} de ${total} configurados`;
  const bar = $('#azProgBar');
  if (bar) bar.style.width = total ? (done / total * 100) + '%' : '0%';
}

function renderRows(ctx) {
  const t = typeByCode(S.typeCode);
  const doc = docOfType(t);
  const tb = $('#azTbody');
  if (!tb) return;

  tb.innerHTML = ctx.workers.map(w => {
    const a = w.absence || {};
    const ready = a.from && a.to;
    const fromCell = ready ? `<span class="date-badge">${DW.fmtDate(a.from)}</span>` : '<span class="pill pill-pend">pendiente</span>';
    const toCell = ready ? `<span class="date-badge">${DW.fmtDate(a.to)}</span>` : '—';
    const noteCell = (a.note || '').trim() ? a.note : '<span style="color:var(--muted)">—</span>';
    let docCell = '';
    if (doc) {
      docCell = a.fileName
        ? `<span class="pill pill-set">📎 adjunto</span>`
        : `<span class="pill pill-pend">pendiente</span>`;
    }
    return `<tr class="${ready ? 'done-row' : ''}">
      <td><input type="checkbox" class="chk azsel" value="${w.id}"></td>
      <td><b>${w.name}</b><br><span class="ced">${w.ced}</span>
        ${w.endDate ? `<br><span class="pill pill-out" style="margin-top:3px">egresó ${DW.fmtDate(w.endDate)}</span>` : ''}</td>
      <td>${fromCell}</td><td>${toCell}</td>
      ${doc ? `<td class="az-coldoc">${docCell}</td>` : '<td class="az-coldoc" style="display:none"></td>'}
      <td style="max-width:170px">${noteCell}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm" data-cfg="${w.id}">${ready ? '✏️ Editar' : '＋ Configurar'}</button>
        <button class="x-btn" data-rm="${w.id}" title="Quitar">✕</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">No hay trabajadores. Vuelve al paso anterior para agregarlos.</td></tr>';

  // listeners
  tb.querySelectorAll('.azsel').forEach(c => c.addEventListener('change', onSel));
  tb.querySelectorAll('[data-cfg]').forEach(b => b.addEventListener('click', () => openConfig(ctx, +b.dataset.cfg)));
  tb.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
    const w = ctx.getWorker(+b.dataset.rm);
    if (w && !confirm(`¿Quitar a ${w.name} del reporte?`)) return;
    ctx.removeWorker(+b.dataset.rm);
    renderRows(ctx); updateNext(ctx);
  }));

  $('#azAll').checked = false;
  onSel();
  updateNext(ctx);
}

function onSel() {
  const n = document.querySelectorAll('.azsel:checked').length;
  const bar = $('#azSelbar');
  if (bar) bar.classList.toggle('hidden', n === 0);
  const c = $('#azSelCount');
  if (c) c.textContent = n;
}

/* Mensaje de error de fechas, o null si esta bien. Usa la ventana
   configurable del tipo (dias atras/futuro + hora tope) y el egreso. */
function dateError(t, from, to, endDate) {
  if (!from || !to) return null;
  const win = windowOf(t);
  return DW.typeRangeError(from, to, win, endDate || null);
}

/* ---------- MODAL: configurar UN trabajador (fechas + nota + documento) ---------- */
function openConfig(ctx, id) {
  const w = ctx.getWorker(id);
  if (!w) return;
  const t = typeByCode(S.typeCode);
  const doc = docOfType(t);
  const a = w.absence || {};
  const win = windowOf(t);
  // Acotar los inputs date a la ventana del tipo y al egreso del trabajador.
  const minAttr = win.minDate ? `min="${win.minDate}"` : '';
  const maxBase = win.maxDate;
  const maxForWorker = (w.endDate && w.endDate < maxBase) ? w.endDate : maxBase;
  const maxAttr = `max="${maxForWorker}"`;
  const endMax = maxAttr;

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal">
      <h3>Configurar ausencia</h3>
      <p class="who">${w.name} · ${w.ced}${w.endDate ? ` · egresó ${DW.fmtDate(w.endDate)}` : ''}</p>
      <div class="grid2">
        <div><label class="flabel">Desde</label><input type="date" id="mFrom" ${minAttr} ${maxAttr} value="${a.from || ''}"></div>
        <div><label class="flabel">Hasta</label><input type="date" id="mTo" ${minAttr} ${endMax} value="${a.to || ''}"></div>
      </div>
      <div class="date-err" id="mErr" style="color:var(--danger);font-size:12px;min-height:16px;margin-top:6px"></div>
      <div><label class="flabel">Nota (opcional)</label>
        <input id="mNote" value="${(a.note || '').replace(/"/g, '&quot;')}" placeholder="Observación para Capital Humano"></div>
      ${doc ? docBoxHtml(doc, a) : ''}
      <div class="wiz-foot" style="margin-top:18px">
        <button class="btn" id="mCancel">Cancelar</button>
        <button class="btn btn-primary" id="mApply">Aplicar</button>
      </div>
      <input type="file" id="mFile" hidden accept="image/*,.pdf,.doc,.docx">
    </div>`;
  document.body.appendChild(ov);

  // estado temporal del archivo dentro del modal
  let fileName = a.fileName || null;

  const fromEl = ov.querySelector('#mFrom'), toEl = ov.querySelector('#mTo'),
        noteEl = ov.querySelector('#mNote'), applyB = ov.querySelector('#mApply'),
        errEl = ov.querySelector('#mErr');

  function repaintDoc() {
    const box = ov.querySelector('#mDocBox');
    if (box) box.outerHTML = docBoxHtml(doc, { ...a, fileName });
    bindDoc();
  }
  function bindDoc() {
    if (!doc) return;
    const pick = ov.querySelector('#mPick');
    const clear = ov.querySelector('#mClearFile');
    if (pick) pick.addEventListener('click', () => ov.querySelector('#mFile').click());
    if (clear) clear.addEventListener('click', () => {
      fileName = null;
      // Limpiar tambien el archivo leido (b64) del trabajador.
      if (w.absence) { w.absence.fileB64 = null; w.absence.fileType = null; }
      repaintDoc(); check();
    });
  }
  if (doc) {
    ov.querySelector('#mFile').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) {
        fileName = f.name;
        // Leer el File a base64 para adjuntarlo al ticket de osTicket al
        // enviar. Guardamos b64, nombre y tipo MIME en el trabajador. El
        // archivo NO se sube a Storage: viaja solo dentro del envio.
        const reader = new FileReader();
        reader.onload = () => {
          w.absence = w.absence || {};
          w.absence.fileB64 = String(reader.result).split(',')[1] || null;
          w.absence.fileName = f.name;
          w.absence.fileType = f.type || 'application/octet-stream';
        };
        reader.readAsDataURL(f);
      } else {
        fileName = null;
      }
      repaintDoc(); check();
    });
    bindDoc();
  }

  function check() {
    const msg = dateError(t, fromEl.value, toEl.value, w.endDate);
    errEl.textContent = msg || '';
    const datesOk = fromEl.value && toEl.value && !msg;
    const blocking = doc && doc.enforcement === 'block';
    applyB.disabled = !(datesOk && (!blocking || fileName));
  }
  fromEl.addEventListener('input', check);
  toEl.addEventListener('input', check);

  ov.querySelector('#mCancel').addEventListener('click', () => ov.remove());
  applyB.addEventListener('click', () => {
    // Preservar el archivo leido (b64/tipo) que el reader dejo en w.absence.
    const prev = w.absence || {};
    w.absence = {
      from: fromEl.value,
      to: toEl.value,
      note: noteEl.value.trim(),
      fileName: doc ? fileName : null,
      // El b64/tipo solo valen si sigue habiendo archivo (fileName).
      fileB64: (doc && fileName) ? (prev.fileB64 || null) : null,
      fileType: (doc && fileName) ? (prev.fileType || null) : null,
    };
    ov.remove();
    renderRows(ctx);
  });

  check();
}

function docBoxHtml(doc, a) {
  const blocking = doc.enforcement === 'block';
  const has = !!a.fileName;
  return `<div class="doc-box ${blocking ? 'block' : ''}" id="mDocBox">
    <div class="doc-title">📄 Documento requerido: ${doc.name}</div>
    ${doc.note ? `<div class="doc-note">${doc.note}</div>` : ''}
    <div class="doc-actions">
      ${has
        ? `<span class="file-pill">📎 ${a.fileName} <span class="x" id="mClearFile">✕</span></span>
           <button class="btn btn-sm" id="mPick">Cambiar archivo</button>`
        : `<button class="btn btn-sm btn-primary" id="mPick">📎 Adjuntar documento</button>
           <span style="font-size:12px;color:var(--muted)">${blocking ? 'obligatorio para enviar' : 'o envía y queda pendiente'}</span>`}
    </div>
    ${(!has && !blocking)
      ? `<div class="pendwarn">⏳ <div>Si envías sin el documento, quedará registrado: <b>Debe a Capital Humano — ${doc.name}</b>.</div></div>`
      : ''}
    ${(!has && blocking)
      ? `<div class="pendwarn" style="background:var(--danger-bg);border-color:#f3c2c2;color:#b91c1c">⛔ <div>Este tipo exige el documento para poder enviar.</div></div>`
      : ''}
  </div>`;
}

/* ---------- MODAL: aplicar fechas en bloque (varios) ---------- */
function openBulk(ctx) {
  const ids = [...document.querySelectorAll('.azsel:checked')].map(c => +c.value);
  if (!ids.length) { alert('Selecciona al menos un trabajador.'); return; }
  const t = typeByCode(S.typeCode);
  const doc = docOfType(t);
  const win = windowOf(t);
  const minAttr = win.minDate ? `min="${win.minDate}"` : '';
  const maxAttr = `max="${win.maxDate}"`;

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal">
      <h3>Aplicar fechas a seleccionados</h3>
      <p class="who">${ids.length} trabajador(es) · se valida el egreso de cada uno</p>
      <div class="grid2">
        <div><label class="flabel">Desde</label><input type="date" id="bFrom" ${minAttr} ${maxAttr}></div>
        <div><label class="flabel">Hasta</label><input type="date" id="bTo" ${minAttr} ${maxAttr}></div>
      </div>
      <div class="date-err" id="bErr" style="color:var(--danger);font-size:12px;min-height:16px;margin-top:6px"></div>
      <div><label class="flabel">Nota (opcional)</label>
        <input id="bNote" placeholder="Se aplica a todos los seleccionados"></div>
      ${doc ? `<p class="hint" style="margin-top:10px">El documento (<b>${doc.name}</b>) se adjunta luego, por persona, desde <b>Editar</b>.</p>` : ''}
      <div class="wiz-foot" style="margin-top:8px">
        <button class="btn" id="bCancel">Cancelar</button>
        <button class="btn btn-primary" id="bApply" disabled>Aplicar a ${ids.length}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const fromEl = ov.querySelector('#bFrom'), toEl = ov.querySelector('#bTo'),
        noteEl = ov.querySelector('#bNote'), applyB = ov.querySelector('#bApply'),
        errEl = ov.querySelector('#bErr');

  function check() {
    const msg = DW.typeRangeError(fromEl.value, toEl.value, win, null) || '';
    errEl.textContent = msg;
    applyB.disabled = !(fromEl.value && toEl.value && !msg);
  }
  fromEl.addEventListener('input', check);
  toEl.addEventListener('input', check);
  ov.querySelector('#bCancel').addEventListener('click', () => ov.remove());
  applyB.addEventListener('click', () => {
    const from = fromEl.value, to = toEl.value, note = noteEl.value.trim();
    let skipped = 0;
    ctx.workers.forEach(w => {
      if (!ids.includes(w.id)) return;
      if (w.endDate && to > w.endDate) { skipped++; return; }
      const prev = w.absence || {};
      w.absence = { from, to, note: note || prev.note || '', fileName: prev.fileName || null,
                    fileB64: prev.fileB64 || null, fileType: prev.fileType || null };
    });
    ov.remove();
    // limpiar seleccion
    document.querySelectorAll('.azsel').forEach(c => c.checked = false);
    const all = $('#azAll'); if (all) all.checked = false;
    renderRows(ctx);
    if (skipped) alert(`${skipped} trabajador(es) no recibieron la fecha por ser posterior a su egreso. Edítalos individualmente.`);
  });

  check();
}
