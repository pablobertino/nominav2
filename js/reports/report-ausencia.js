/* =====================================================================
   js/reports/report-ausencia.js
   Definicion del reporte de Ausencia. Aporta el paso 4 (detalle por
   trabajador: tipo de ausencia, rango de fechas y documento adjunto) y
   el envio. Se enchufa al wizard-core compartido.

   Estructura hibrida:
     - Tipo SIN documento (EME/MUD/FUE): varios trabajadores en bloque,
       como marcaje (tabla con seleccion multiple + aplicar fechas).
     - Tipo CON documento (REP/PRE/POST/LAC/PAT/MAT): una tarjeta por
       trabajador, cada uno con su rango y su documento.

   El TIPO de ausencia es uno por reporte (se elige arriba del paso 4 y
   aplica a todos los trabajadores).

   Adjuntos: por ahora NO se suben a Storage. Se elige el archivo y solo
   se recuerda su nombre; el envio real a osTicket se conecta despues
   (ver los bloques marcados con  TODO osTicket ).

   Fechas: la ausencia NO usa la ventana reportable de la quincena (un
   reposo puede empezar antes; matrimonio/mudanza pueden ser futuros).
   Reglas: Hasta >= Desde, futuro solo si el tipo lo permite
   (allows_future), y nunca posterior al egreso del trabajador.
   ===================================================================== */

import { $ } from '../core/dom.js';
import * as DW from './shared/date-window.js';

let TYPES = null; // [{code,label,ax_code,allows_future,note,docs:[{id,name,note,enforcement,is_required}]}]

async function loadTypes() {
  if (TYPES) return TYPES;
  const res = await fetch('/api/catalog', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'absence_types' }),
  }).then(r => r.json()).catch(() => null);
  TYPES = (res && res.ok && res.types) ? res.types : [];
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

/* Estado local del paso 4 (vive mientras el wizard este montado). */
const S = {
  typeCode: null, // tipo elegido para este reporte
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
    loadTypes().then(() => {
      if (!S.typeCode && TYPES.length) S.typeCode = TYPES[0].code;
      paintStep4(ctx);
    });
    $('#wzPanel').innerHTML = '<div class="pnl-loading">Cargando…</div>';
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
      // Documento: por ahora solo el nombre del archivo elegido (si lo hay).
      // El archivo en si se enviara a osTicket cuando se conecte (ver Worker).
      doc_file_name: doc ? (w.absence.fileName || null) : null,
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
  const t = typeByCode(S.typeCode);

  panel.innerHTML = `
    <h2>Configurar ausencias</h2>

    <div class="type-row">
      <div style="flex:1">
        <label class="flabel">Tipo de ausencia (aplica a este reporte)</label>
        <select id="azType">
          ${(TYPES || []).map(x => `<option value="${x.code}" ${x.code === S.typeCode ? 'selected' : ''}>${x.label}</option>`).join('')}
        </select>
      </div>
      <div style="width:130px">
        <label class="flabel">Código AX</label>
        <input id="azAx" value="${t ? t.ax_code : ''}" readonly style="font-family:monospace;text-align:center;background:#f7f9fc">
      </div>
    </div>
    <p class="hint" id="azHint"></p>
    <div id="azCoord" class="coord-note" style="display:none"></div>

    <div id="azBody"></div>
  `;

  $('#azType').addEventListener('change', e => {
    S.typeCode = e.target.value;
    // Al cambiar de tipo, las marcas de documento dejan de aplicar si el nuevo no lleva doc.
    paintStep4(ctx);
  });

  refreshTypeHeader();
  paintBody(ctx);
}

function refreshTypeHeader() {
  const t = typeByCode(S.typeCode);
  if (!t) return;
  $('#azAx').value = t.ax_code;
  const doc = docOfType(t);
  let hint = doc ? `Requiere documento: <b>${doc.name}</b>.` : 'Este tipo no requiere documento.';
  hint += t.allows_future ? ' Admite fechas futuras.' : ' Solo fechas pasadas o actuales.';
  $('#azHint').innerHTML = hint;
  // Nota de coordinacion (EME/MUD/FUE traen note en BD).
  const coord = $('#azCoord');
  if (t.note) { coord.style.display = 'flex'; coord.innerHTML = `⚠ <div>${t.note}</div>`; }
  else { coord.style.display = 'none'; coord.innerHTML = ''; }
}

function paintBody(ctx) {
  const t = typeByCode(S.typeCode);
  if (typeHasDoc(t)) paintDocMode(ctx);
  else paintBlockMode(ctx);
}

/* Habilita "Revisar y enviar" solo si todos los trabajadores estan completos.
   En modo con doc 'block', exige tambien el archivo. */
function updateNext(ctx) {
  const t = typeByCode(S.typeCode);
  const doc = docOfType(t);
  const blocking = doc && doc.enforcement === 'block';
  const allOk = ctx.workers.length > 0 && ctx.workers.every(w => {
    const a = w.absence;
    if (!a || !a.from || !a.to) return false;
    if (a.to < a.from) return false;
    if (blocking && !a.fileName) return false;
    return true;
  });
  const btn = $('#azNext');
  if (btn) btn.disabled = !allOk;
}

/* ---------- MODO CON DOCUMENTO: una tarjeta por trabajador ---------- */
function paintDocMode(ctx) {
  const t = typeByCode(S.typeCode);
  const doc = docOfType(t);
  const body = $('#azBody');

  body.innerHTML = `
    <div class="window-info">
      <span>📎</span>
      <div>Cada trabajador lleva su propio rango de fechas y su documento (<b>${doc.name}</b>). El archivo se adjuntará al ticket de Capital Humano. Si aún no lo tienes, puedes enviar y quedará registrado como <b>documento pendiente</b>${doc.enforcement === 'block' ? ', salvo este tipo que exige el documento para poder enviar' : ''}.</div>
    </div>
    <div id="azCards"></div>
    <div class="wiz-foot">
      <button class="btn" id="azBack">← Atrás</button>
      <button class="btn btn-primary" id="azNext" disabled>Revisar y enviar →</button>
    </div>`;

  $('#azBack').addEventListener('click', () => ctx.setStep(3));
  $('#azNext').addEventListener('click', () => ctx.setStep(5));

  renderCards(ctx);
}

function renderCards(ctx) {
  const t = typeByCode(S.typeCode);
  const doc = docOfType(t);
  const wrap = $('#azCards');
  const today = DW.nowVE().ymd;
  const maxAttr = t.allows_future ? '' : `max="${today}"`;

  wrap.innerHTML = ctx.workers.map(w => {
    const a = w.absence || {};
    const endMax = w.endDate ? ` (egresó ${DW.fmtDate(w.endDate)})` : '';
    const hasFile = !!a.fileName;
    const blocking = doc.enforcement === 'block';
    return `
      <div class="wcard" data-id="${w.id}">
        <div class="wcard-head">
          <div><span class="wname">${w.name}</span><span class="wced">${w.ced}${endMax}</span></div>
          <button class="x-btn" data-rm="${w.id}" title="Quitar">✕</button>
        </div>
        <div class="grid2">
          <div><label class="flabel">Desde</label>
            <input type="date" class="az-from" data-id="${w.id}" value="${a.from || ''}" ${maxAttr} ${w.endDate ? `max="${w.endDate}"` : maxAttr}></div>
          <div><label class="flabel">Hasta</label>
            <input type="date" class="az-to" data-id="${w.id}" value="${a.to || ''}" ${w.endDate ? `max="${w.endDate}"` : maxAttr}></div>
        </div>
        <div class="az-dateerr" data-id="${w.id}" style="color:var(--danger);font-size:11.5px;margin-top:6px;min-height:14px"></div>
        <div style="margin-top:10px"><label class="flabel">Nota (opcional)</label>
          <input class="az-note" data-id="${w.id}" value="${(a.note || '').replace(/"/g, '&quot;')}" placeholder="Observación para Capital Humano"></div>

        <div class="doc-box ${blocking ? 'block' : ''}">
          <div class="doc-title">📄 Documento requerido: <span>${doc.name}</span></div>
          ${doc.note ? `<div class="doc-note">${doc.note}</div>` : ''}
          <div class="doc-actions">
            ${hasFile
              ? `<span class="file-pill">📎 ${a.fileName} <span class="x" data-clearfile="${w.id}">✕</span></span>
                 <button class="btn btn-sm" data-pick="${w.id}">Cambiar archivo</button>`
              : `<button class="btn btn-sm btn-primary" data-pick="${w.id}">📎 Adjuntar documento</button>
                 <span style="font-size:12px;color:var(--muted)">${blocking ? 'obligatorio para enviar' : 'o envía y queda pendiente'}</span>`}
            <input type="file" class="az-file" data-id="${w.id}" hidden accept="image/*,.pdf,.doc,.docx">
          </div>
          ${(!hasFile && !blocking)
            ? `<div class="pendwarn">⏳ <div>Si envías sin el documento, quedará registrado: <b>Debe a Capital Humano — ${doc.name}</b>.</div></div>`
            : ''}
          ${(!hasFile && blocking)
            ? `<div class="pendwarn" style="background:var(--danger-bg);border-color:#f3c2c2;color:#b91c1c">⛔ <div>Este tipo exige el documento para poder enviar.</div></div>`
            : ''}
        </div>
      </div>`;
  }).join('') || '<div class="empty">No hay trabajadores. Vuelve al paso anterior para agregarlos.</div>';

  // fechas
  wrap.querySelectorAll('.az-from').forEach(el => el.addEventListener('input', () => onDateChange(ctx, +el.dataset.id)));
  wrap.querySelectorAll('.az-to').forEach(el => el.addEventListener('input', () => onDateChange(ctx, +el.dataset.id)));
  wrap.querySelectorAll('.az-note').forEach(el => el.addEventListener('input', () => {
    const w = ctx.getWorker(+el.dataset.id); if (w) { w.absence = w.absence || {}; w.absence.note = el.value; }
  }));
  // quitar
  wrap.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
    const w = ctx.getWorker(+b.dataset.rm);
    if (w && !confirm(`¿Quitar a ${w.name} del reporte?`)) return;
    ctx.removeWorker(+b.dataset.rm);
    renderCards(ctx); updateNext(ctx);
  }));
  // adjuntar archivo (por ahora solo recordamos el nombre)
  wrap.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
    const fileInput = wrap.querySelector(`.az-file[data-id="${b.dataset.pick}"]`);
    if (fileInput) fileInput.click();
  }));
  wrap.querySelectorAll('.az-file').forEach(inp => inp.addEventListener('change', () => {
    const w = ctx.getWorker(+inp.dataset.id);
    const f = inp.files && inp.files[0];
    if (w && f) {
      w.absence = w.absence || {};
      w.absence.fileName = f.name;
      // ─────────────────────────────────────────────────────────────
      // TODO osTicket: aqui guardar el archivo (f) para adjuntarlo al
      // ticket al enviar. Por ahora SOLO recordamos el nombre. Cuando se
      // conecte osTicket, leer el File a base64 y mandarlo en submit().
      //   const reader = new FileReader();
      //   reader.onload = () => { w.absence.fileB64 = reader.result.split(',')[1]; };
      //   reader.readAsDataURL(f);
      // ─────────────────────────────────────────────────────────────
    }
    renderCards(ctx); updateNext(ctx);
  }));
  // quitar archivo
  wrap.querySelectorAll('[data-clearfile]').forEach(x => x.addEventListener('click', () => {
    const w = ctx.getWorker(+x.dataset.clearfile);
    if (w && w.absence) { w.absence.fileName = null; /* TODO osTicket: limpiar tambien fileB64 */ }
    renderCards(ctx); updateNext(ctx);
  }));

  updateNext(ctx);
}

function onDateChange(ctx, id) {
  const w = ctx.getWorker(id);
  if (!w) return;
  const fromEl = $(`.az-from[data-id="${id}"]`);
  const toEl = $(`.az-to[data-id="${id}"]`);
  w.absence = w.absence || {};
  w.absence.from = fromEl.value;
  w.absence.to = toEl.value;
  // validacion visible
  const err = $(`.az-dateerr[data-id="${id}"]`);
  err.textContent = dateRangeError(w) || '';
  updateNext(ctx);
}

/* Devuelve un mensaje de error de fechas, o null si esta bien. */
function dateRangeError(w) {
  const t = typeByCode(S.typeCode);
  const a = w.absence || {};
  if (!a.from || !a.to) return null; // aun incompleto, no marcar error
  if (a.to < a.from) return 'La fecha Hasta no puede ser anterior a Desde.';
  const today = DW.nowVE().ymd;
  if (!t.allows_future && a.from > today) return 'Este tipo no admite fechas futuras.';
  if (!t.allows_future && a.to > today) return 'Este tipo no admite fechas futuras.';
  if (w.endDate && a.to > w.endDate) return `No puede ser posterior al egreso (${DW.fmtDate(w.endDate)}).`;
  return null;
}

/* ---------- MODO SIN DOCUMENTO: tabla en bloque ---------- */
function paintBlockMode(ctx) {
  const body = $('#azBody');
  body.innerHTML = `
    <div class="window-info">
      <span>👥</span>
      <div>Este tipo no requiere documento, así que puedes reportar a varios trabajadores con la misma ausencia. Selecciona y aplica el rango de fechas en bloque, o edita a cada uno con ✏️.</div>
    </div>
    <div class="selbar hidden" id="azSelbar"><b id="azSelCount">0</b> seleccionados
      <span class="spacer"></span>
      <button class="btn btn-sm btn-primary" id="azBulk">Aplicar fechas a seleccionados</button>
      <button class="btn btn-sm" id="azClear">Quitar selección</button>
    </div>
    <table>
      <thead><tr>
        <th style="width:30px"><input type="checkbox" class="chk" id="azAll"></th>
        <th>Trabajador</th><th>Desde</th><th>Hasta</th><th>Nota</th><th style="width:70px"></th>
      </tr></thead><tbody id="azTbody"></tbody>
    </table>
    <div class="wiz-foot">
      <button class="btn" id="azBack">← Atrás</button>
      <button class="btn btn-primary" id="azNext" disabled>Revisar y enviar →</button>
    </div>`;

  $('#azAll').addEventListener('change', e => {
    document.querySelectorAll('.azsel').forEach(c => c.checked = e.target.checked); onSel();
  });
  $('#azBulk').addEventListener('click', () => openBulk(ctx));
  $('#azClear').addEventListener('click', () => {
    document.querySelectorAll('.azsel').forEach(c => c.checked = false); $('#azAll').checked = false; onSel();
  });
  $('#azBack').addEventListener('click', () => ctx.setStep(3));
  $('#azNext').addEventListener('click', () => ctx.setStep(5));

  renderRows(ctx);

  function onSel() {
    const n = document.querySelectorAll('.azsel:checked').length;
    $('#azSelbar').classList.toggle('hidden', n === 0);
    $('#azSelCount').textContent = n;
  }
  paintBlockMode._onSel = onSel;
}

function renderRows(ctx) {
  const tb = $('#azTbody');
  tb.innerHTML = ctx.workers.map(w => {
    const a = w.absence || {};
    const ready = a.from && a.to;
    const from = ready ? `<span class="date-badge">${DW.fmtDate(a.from)}</span>` : '<span class="pill pill-pend">pendiente</span>';
    const to = ready ? `<span class="date-badge">${DW.fmtDate(a.to)}</span>` : '—';
    const note = (a.note || '').trim() ? a.note : '<span style="color:var(--muted);font-size:12px">—</span>';
    return `<tr>
      <td><input type="checkbox" class="chk azsel" value="${w.id}"></td>
      <td><b>${w.name}</b><br><span class="ced">${w.ced}</span>
        ${w.endDate ? `<br><span class="pill pill-out" style="margin-top:3px">ausencia máx. ${DW.fmtDate(w.endDate)}</span>` : ''}</td>
      <td>${from}</td><td>${to}</td><td>${note}</td>
      <td style="white-space:nowrap"><button class="btn btn-sm" data-edit="${w.id}" title="Editar">✏️</button>
        <button class="x-btn" data-rm="${w.id}" title="Quitar">✕</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">No hay trabajadores. Vuelve al paso anterior.</td></tr>';

  $('#azAll').checked = false;
  tb.querySelectorAll('.azsel').forEach(c => c.addEventListener('change', paintBlockMode._onSel));
  tb.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEditOne(ctx, +b.dataset.edit)));
  tb.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
    const w = ctx.getWorker(+b.dataset.rm);
    if (w && !confirm(`¿Quitar a ${w.name} del reporte?`)) return;
    ctx.removeWorker(+b.dataset.rm);
    renderRows(ctx); updateNext(ctx);
  }));
  if (paintBlockMode._onSel) paintBlockMode._onSel();
  updateNext(ctx);
}

/* Modal de fechas para uno o varios (bloque). */
function openDatesModal({ title, who, initial, onApply }) {
  const t = typeByCode(S.typeCode);
  const today = DW.nowVE().ymd;
  const maxAttr = t.allows_future ? '' : `max="${today}"`;
  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal">
      <h3>${title}</h3>
      <p class="who">${who}</p>
      <div class="grid2" style="margin-bottom:8px">
        <div><label class="flabel">Desde</label><input type="date" id="mFrom" ${maxAttr} value="${initial.from || ''}"></div>
        <div><label class="flabel">Hasta</label><input type="date" id="mTo" ${maxAttr} value="${initial.to || ''}"></div>
      </div>
      <div class="date-err" id="mErr" style="color:var(--danger);font-size:12px;min-height:16px"></div>
      <div><label class="flabel">Nota (opcional)</label><input id="mNote" value="${(initial.note || '').replace(/"/g, '&quot;')}" placeholder="Observación para Capital Humano"></div>
      <div class="wiz-foot" style="margin-top:14px">
        <button class="btn" id="mCancel">Cancelar</button>
        <button class="btn btn-primary" id="mApply">Aplicar</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const fromEl = ov.querySelector('#mFrom'), toEl = ov.querySelector('#mTo'),
        noteEl = ov.querySelector('#mNote'), applyB = ov.querySelector('#mApply'), errEl = ov.querySelector('#mErr');

  function check() {
    let msg = '';
    if (fromEl.value && toEl.value) {
      if (toEl.value < fromEl.value) msg = 'La fecha Hasta no puede ser anterior a Desde.';
      else if (!t.allows_future && (fromEl.value > today || toEl.value > today)) msg = 'Este tipo no admite fechas futuras.';
    }
    errEl.textContent = msg;
    applyB.disabled = !(fromEl.value && toEl.value && !msg);
  }
  fromEl.addEventListener('input', check);
  toEl.addEventListener('input', check);
  ov.querySelector('#mCancel').addEventListener('click', () => ov.remove());
  applyB.addEventListener('click', () => {
    onApply({ from: fromEl.value, to: toEl.value, note: noteEl.value.trim() });
    ov.remove();
  });
  check();
}

function openEditOne(ctx, id) {
  const w = ctx.getWorker(id);
  if (!w) return;
  openDatesModal({
    title: 'Editar ausencia',
    who: `${w.name} · ${w.ced}${w.endDate ? ` · egresó ${DW.fmtDate(w.endDate)}` : ''}`,
    initial: w.absence || {},
    onApply: (vals) => {
      if (w.endDate && vals.to > w.endDate) {
        alert(`La fecha Hasta no puede ser posterior al egreso (${DW.fmtDate(w.endDate)}).`);
        return;
      }
      w.absence = { ...vals };
      renderRows(ctx);
    },
  });
}

function openBulk(ctx) {
  const ids = [...document.querySelectorAll('.azsel:checked')].map(c => +c.value);
  if (!ids.length) { alert('Selecciona al menos un trabajador.'); return; }
  openDatesModal({
    title: 'Aplicar fechas a seleccionados',
    who: `${ids.length} trabajador(es) · la fecha se valida contra el egreso de cada uno`,
    initial: {},
    onApply: (vals) => {
      let skipped = 0;
      ctx.workers.forEach(w => {
        if (ids.includes(w.id)) {
          if (w.endDate && vals.to > w.endDate) { skipped++; return; }
          w.absence = { ...vals };
        }
      });
      renderRows(ctx);
      if (skipped) alert(`${skipped} trabajador(es) no recibieron la fecha por ser posterior a su egreso. Edítalos individualmente.`);
    },
  });
}
