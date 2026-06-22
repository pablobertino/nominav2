/* =====================================================================
   js/reports/report-egreso.js
   Definicion del reporte de Egreso (Baja). Aporta el paso 4 y el envio.
   Se enchufa al wizard-core compartido.

   Particularidades del Egreso:
     - No hay "tipo" a elegir: siempre es Baja (B).
     - Por trabajador se captura UNA fecha real de egreso; de ahi se DERIVA
       la reportable (limitada por la ventana de marcaje hacia atras). Si la
       real es mas antigua que el minimo reportable, AX recibe el minimo y
       la real queda registrada igual.
     - CARTA DE RENUNCIA opcional (mismo mecanismo que el documento de
       ausencia): si se adjunta, viaja como ticket DOC por persona. Si NO
       se adjunta, la tienda debe elegir una CAUSA. Cada causa puede EXIMIR
       el documento (no queda pendiente) o no (queda pendiente, como el
       modo "advierte" de ausencias).

   Identificacion del trabajador: cedula + nombre (del roster). El nombre se
   divide al armar el Excel (ultima palabra = apellidos) en el servidor.
   ===================================================================== */

import { $ } from '../core/dom.js';
import * as DW from './shared/date-window.js';

// Catalogo de causas de no-adjunto (cargado una vez). Cada una: {code,label,waives_document}.
let CAUSES = null;

async function loadCauses() {
  if (CAUSES) return CAUSES;
  const res = await fetch('/api/catalog', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'egress_causes' }),
  }).then(r => r.json()).catch(() => null);
  CAUSES = (res && res.ok && res.causas) ? res.causas : [];
  return CAUSES;
}
function causeByCode(code) {
  return (CAUSES || []).find(c => c.code === code) || null;
}

export const egresoReport = {
  code: 'egreso',
  title: 'Reportar Egreso',
  icon: '🔴',
  tag: 'Egreso · wizard',
  step4Label: 'Egresos',

  summaryColumns: [
    { key: 'kind', label: 'Tipo' },
    { key: 'report_date', label: 'Fecha de egreso' },
    { key: 'real_date', label: 'Fecha real' },
    { key: 'doc', label: 'Carta de renuncia' },
  ],
  summaryCell(w, key) {
    const e = w.egress || {};
    if (key === 'kind') return 'Baja (B)';
    if (key === 'report_date') return e.reportDate ? DW.fmtDate(e.reportDate) : '—';
    if (key === 'real_date') {
      if (!e.realDate) return '—';
      return e.realDate === e.reportDate
        ? '<span style="color:var(--muted)">igual</span>'
        : DW.fmtDate(e.realDate);
    }
    if (key === 'doc') {
      if (e.fileName) return '<span class="pill pill-set">📎 adjunta</span>';
      const c = causeByCode(e.docCause);
      if (!c) return '<span class="pill pill-pend">pendiente</span>';
      const label = e.docCause === 'other' ? (e.docCauseOther || 'Otra') : c.label;
      return c.waives_document
        ? `<span class="pill pill-set" title="${label}">sin carta (eximida)</span>`
        : `<span class="pill pill-pend" title="${label}">pendiente</span>`;
    }
    return '';
  },

  isComplete(w) {
    const e = w.egress;
    if (!e || !e.reportDate || !e.realDate) return false;
    // El documento queda resuelto si: hay carta, o hay causa elegida.
    return !!(e.fileName || e.docCause);
  },

  renderStep4(ctx) {
    $('#wzPanel').innerHTML = '<div class="pnl-loading">Cargando…</div>';
    loadCauses().then(() => paintStep4(ctx));
  },

  async submit({ companyCode, responsible, position, workers, source_kind, source_admin_id }) {
    const lines = workers.map(w => {
      const e = w.egress || {};
      return {
        id_number: w.ced,
        name: w.name,
        report_date: e.reportDate,
        real_date: e.realDate,
        // Documento: si hay carta viaja el base64; si no, la causa.
        doc_file_name: e.fileName || null,
        doc_file_b64: e.fileB64 || null,
        doc_file_type: e.fileType || null,
        doc_cause: e.fileName ? null : (e.docCause || null),
        doc_cause_other: e.fileName ? null : (e.docCauseOther || null),
      };
    });
    const res = await fetch('/api/reports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'submit_egreso',
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

function paintStep4(ctx) {
  const { win } = ctx;
  const panel = $('#wzPanel');
  panel.innerHTML = `
    <h2>Configurar egresos</h2>
    <p class="hint">Indica la <b>fecha real de egreso</b> de cada trabajador (cuándo dejó de trabajar) y la <b>carta de renuncia</b>. La fecha que se envía a Nómina se ajusta sola al máximo permitido por el corte; la fecha real queda registrada de todas formas. Si no tienes la carta, elige una causa.</p>
    <div class="window-info"><span class="wi-ico">⏱</span><div>${DW.windowText(win)}</div></div>

    <div class="progress-line">
      <span id="egProg">0 de ${ctx.workers.length} configurados</span>
      <div class="progress-bar"><div id="egProgBar" style="width:0%"></div></div>
    </div>

    <div class="selbar hidden" id="egSelbar"><b id="egSelCount">0</b> seleccionados
      <span class="spacer"></span>
      <button class="btn btn-sm btn-primary" id="egBulk">Aplicar fecha a seleccionados</button>
      <button class="btn btn-sm" id="egClear">Quitar selección</button>
    </div>

    <table>
      <thead><tr>
        <th style="width:30px"><input type="checkbox" class="chk" id="egAll"></th>
        <th>Trabajador</th><th>Tipo</th><th>Fecha de egreso</th><th>Fecha real</th><th>Carta</th><th style="width:130px"></th>
      </tr></thead><tbody id="egTbody"></tbody>
    </table>

    <div class="wiz-foot">
      <button class="btn" id="egBack">← Atrás</button>
      <button class="btn btn-primary" id="egNext" disabled>Revisar y enviar →</button>
    </div>`;

  $('#egAll').addEventListener('change', e => {
    document.querySelectorAll('.egsel').forEach(c => c.checked = e.target.checked);
    onSel();
  });
  $('#egBulk').addEventListener('click', () => openBulk(ctx));
  $('#egClear').addEventListener('click', () => {
    document.querySelectorAll('.egsel').forEach(c => c.checked = false);
    $('#egAll').checked = false; onSel();
  });
  $('#egBack').addEventListener('click', () => ctx.setStep(3));
  $('#egNext').addEventListener('click', () => ctx.setStep(5));

  renderRows(ctx);
}

/* Habilita "Revisar y enviar" solo si todos quedaron completos
   (fecha + documento resuelto: carta o causa). */
function updateNext(ctx) {
  const total = ctx.workers.length;
  const done = ctx.workers.filter(w => {
    const e = w.egress;
    return e && e.reportDate && e.realDate && (e.fileName || e.docCause);
  }).length;
  const btn = $('#egNext');
  if (btn) btn.disabled = done !== total || total === 0;
  const prog = $('#egProg');
  if (prog) prog.textContent = `${done} de ${total} configurados`;
  const bar = $('#egProgBar');
  if (bar) bar.style.width = total ? (done / total * 100) + '%' : '0%';
}

function docCell(e) {
  if (e.fileName) return '<span class="pill pill-set">📎 adjunta</span>';
  const c = causeByCode(e.docCause);
  if (!c) return '<span class="pill pill-pend">pendiente</span>';
  const label = e.docCause === 'other' ? (e.docCauseOther || 'Otra') : c.label;
  return c.waives_document
    ? `<span class="pill pill-set" title="${label}">sin carta</span>`
    : `<span class="pill pill-pend" title="${label}">pendiente</span>`;
}

function renderRows(ctx) {
  const tb = $('#egTbody');
  if (!tb) return;

  tb.innerHTML = ctx.workers.map(w => {
    const e = w.egress || {};
    const ready = e.reportDate && e.realDate && (e.fileName || e.docCause);
    const repCell = (e.reportDate) ? `<span class="date-badge">${DW.fmtDate(e.reportDate)}</span>` : '<span class="pill pill-pend">pendiente</span>';
    let realCell = '—';
    if (e.realDate) {
      realCell = e.realDate === e.reportDate
        ? '<span style="color:var(--muted)">igual</span>'
        : `<span class="date-badge" style="background:#fff4e5;border-color:#f6c992">${DW.fmtDate(e.realDate)}</span>`;
    }
    const dCell = (e.reportDate) ? docCell(e) : '<span style="color:var(--muted)">—</span>';
    return `<tr class="${ready ? 'done-row' : ''}">
      <td><input type="checkbox" class="chk egsel" value="${w.id}"></td>
      <td><b>${w.name}</b><br><span class="ced">${w.ced}</span>
        ${w.endDate ? `<br><span class="pill pill-out" style="margin-top:3px">ya tenía egreso ${DW.fmtDate(w.endDate)}</span>` : ''}</td>
      <td>Baja (B)</td>
      <td>${repCell}</td><td>${realCell}</td><td>${dCell}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm" data-cfg="${w.id}">${ready ? '✏️ Editar' : '＋ Configurar'}</button>
        <button class="x-btn" data-rm="${w.id}" title="Quitar">✕</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">No hay trabajadores. Vuelve al paso anterior para agregarlos.</td></tr>';

  tb.querySelectorAll('.egsel').forEach(c => c.addEventListener('change', onSel));
  tb.querySelectorAll('[data-cfg]').forEach(b => b.addEventListener('click', () => openConfig(ctx, +b.dataset.cfg)));
  tb.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
    const w = ctx.getWorker(+b.dataset.rm);
    if (w && !confirm(`¿Quitar a ${w.name} del reporte?`)) return;
    ctx.removeWorker(+b.dataset.rm);
    renderRows(ctx); updateNext(ctx);
  }));

  $('#egAll').checked = false;
  onSel();
  updateNext(ctx);
}

function onSel() {
  const n = document.querySelectorAll('.egsel:checked').length;
  const bar = $('#egSelbar');
  if (bar) bar.classList.toggle('hidden', n === 0);
  const c = $('#egSelCount');
  if (c) c.textContent = n;
}

/* Dada la fecha REAL elegida, deriva la REPORTABLE segun la ventana (win). */
function deriveDates(realDate, win, endDate) {
  const { reportMin, reportMax } = win;
  const maxRep = (endDate && endDate < reportMax) ? endDate : reportMax;
  let reportDate = realDate;
  let adjusted = false;
  let msg = '';
  if (realDate < reportMin) {
    reportDate = reportMin;
    adjusted = true;
    msg = `La persona egresó el ${DW.fmtDate(realDate)}. El máximo reportable es el ${DW.fmtDate(reportMin)}, así que Nómina (AX) recibirá el ${DW.fmtDate(reportMin)}; la fecha real (${DW.fmtDate(realDate)}) queda registrada.`;
  } else if (realDate > maxRep) {
    reportDate = maxRep;
    adjusted = true;
    msg = `La fecha se ajustó al ${DW.fmtDate(maxRep)} (tope permitido).`;
  }
  return { reportDate, realDate, adjusted, msg };
}

/* Valida la fecha REAL: no futura, no posterior al egreso ya conocido. */
function realDateError(realDate, win, endDate) {
  if (!realDate) return 'Falta la fecha real de egreso.';
  if (realDate > win.reportMax) return `La fecha real no puede ser futura (máximo ${DW.fmtDate(win.reportMax)}).`;
  if (endDate && realDate > endDate) return `No puede ser posterior al egreso ya registrado (${DW.fmtDate(endDate)}).`;
  return null;
}

/* HTML del bloque de carta de renuncia (estado actual: archivo o causa). */
function docBoxHtml(e) {
  const hasFile = !!e.fileName;
  const causeOpts = (CAUSES || []).map(c =>
    `<option value="${c.code}" ${e.docCause === c.code ? 'selected' : ''}>${c.label}</option>`).join('');
  return `<div class="doc-box" id="egDocBox" style="margin-top:14px">
    <div class="doc-title">📄 Carta de renuncia <span style="color:var(--muted);font-weight:400">(opcional)</span></div>
    <div class="doc-actions">
      ${hasFile
        ? `<span class="file-pill">📎 ${e.fileName} <span class="x" id="egClearFile">✕</span></span>
           <button class="btn btn-sm" id="egPick">Cambiar archivo</button>`
        : `<button class="btn btn-sm btn-primary" id="egPick">📎 Adjuntar carta</button>`}
    </div>
    ${hasFile ? '' : `
      <div style="margin-top:12px">
        <label class="flabel">Si no la adjuntas, indica la causa</label>
        <select id="egCause">
          <option value="" ${!e.docCause ? 'selected' : ''} disabled>Selecciona una causa…</option>
          ${causeOpts}
        </select>
        <div id="egCauseOtherWrap" style="margin-top:8px;${e.docCause === 'other' ? '' : 'display:none'}">
          <input id="egCauseOther" placeholder="Especifica la causa" value="${(e.docCauseOther || '').replace(/"/g, '&quot;')}">
        </div>
        <div id="egCauseNote" class="hint" style="margin-top:6px"></div>
      </div>`}
  </div>`;
}

/* ---------- MODAL: configurar UN trabajador (fecha + carta/causa) ---------- */
function openConfig(ctx, id) {
  const w = ctx.getWorker(id);
  if (!w) return;
  const { win } = ctx;
  const e = w.egress || {};
  const maxForWorker = (w.endDate && w.endDate < win.reportMax) ? w.endDate : win.reportMax;

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal">
      <h3>Configurar egreso</h3>
      <p class="who">${w.name} · ${w.ced}${w.endDate ? ` · egreso ya registrado ${DW.fmtDate(w.endDate)}` : ''}</p>
      <div><label class="flabel">Fecha real de egreso</label>
        <input type="date" id="egDate" max="${maxForWorker}" value="${e.realDate || ''}"></div>
      <div class="date-err" id="egErr" style="color:var(--danger);font-size:12px;min-height:16px;margin-top:6px"></div>
      <div id="egAdjust" class="coord-note" style="display:none;margin-top:6px"></div>
      <div id="egDocSlot"></div>
      <input type="file" id="egFile" hidden accept="image/*,.pdf,.doc,.docx">
      <div class="wiz-foot" style="margin-top:18px">
        <button class="btn" id="egCancel">Cancelar</button>
        <button class="btn btn-primary" id="egApply" disabled>Aplicar</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  // Estado temporal dentro del modal.
  const tmp = {
    realDate: e.realDate || '',
    fileName: e.fileName || null, fileB64: e.fileB64 || null, fileType: e.fileType || null,
    docCause: e.docCause || '', docCauseOther: e.docCauseOther || '',
  };
  let touched = !!e.realDate;

  const dateEl = ov.querySelector('#egDate'), applyB = ov.querySelector('#egApply'),
        errEl = ov.querySelector('#egErr'), adjEl = ov.querySelector('#egAdjust'),
        docSlot = ov.querySelector('#egDocSlot');

  function renderDoc() {
    docSlot.innerHTML = docBoxHtml(tmp);
    const pick = ov.querySelector('#egPick');
    if (pick) pick.addEventListener('click', () => ov.querySelector('#egFile').click());
    const clr = ov.querySelector('#egClearFile');
    if (clr) clr.addEventListener('click', () => {
      tmp.fileName = null; tmp.fileB64 = null; tmp.fileType = null;
      renderDoc(); check();
    });
    const sel = ov.querySelector('#egCause');
    if (sel) sel.addEventListener('change', () => {
      tmp.docCause = sel.value;
      const ow = ov.querySelector('#egCauseOtherWrap');
      if (ow) ow.style.display = sel.value === 'other' ? '' : 'none';
      const c = causeByCode(sel.value);
      const note = ov.querySelector('#egCauseNote');
      if (note && c) note.textContent = c.waives_document
        ? 'Con esta causa el egreso NO queda pendiente de carta.'
        : 'El egreso quedará como “carta pendiente” hasta que se entregue.';
      check();
    });
    const other = ov.querySelector('#egCauseOther');
    if (other) other.addEventListener('input', () => { tmp.docCauseOther = other.value; check(); });
    // Nota inicial si ya hay causa elegida.
    const c0 = causeByCode(tmp.docCause);
    const note0 = ov.querySelector('#egCauseNote');
    if (note0 && c0) note0.textContent = c0.waives_document
      ? 'Con esta causa el egreso NO queda pendiente de carta.'
      : 'El egreso quedará como “carta pendiente” hasta que se entregue.';
  }

  ov.querySelector('#egFile').addEventListener('change', ev => {
    const f = ev.target.files && ev.target.files[0];
    if (f) {
      const reader = new FileReader();
      reader.onload = () => {
        tmp.fileName = f.name;
        tmp.fileB64 = String(reader.result).split(',')[1] || null;
        tmp.fileType = f.type || 'application/octet-stream';
        // Al adjuntar carta, la causa deja de ser necesaria.
        tmp.docCause = ''; tmp.docCauseOther = '';
        renderDoc(); check();
      };
      reader.readAsDataURL(f);
    }
  });

  function check() {
    const real = tmp.realDate;
    const err = realDateError(real, win, w.endDate);
    errEl.textContent = (touched || real) ? (err || '') : '';
    adjEl.style.display = 'none';
    if (err || !real) { applyB.disabled = true; return; }
    const d = deriveDates(real, win, w.endDate);
    if (d.adjusted) { adjEl.style.display = 'flex'; adjEl.innerHTML = `⚠ <div>${d.msg}</div>`; }
    // Documento resuelto: hay carta, o hay causa elegida (y si es 'other', con texto).
    const docOk = tmp.fileName
      || (tmp.docCause && (tmp.docCause !== 'other' || (tmp.docCauseOther || '').trim()));
    applyB.disabled = !docOk;
  }

  const onTouch = () => { touched = true; tmp.realDate = dateEl.value; check(); };
  dateEl.addEventListener('input', onTouch);
  dateEl.addEventListener('change', onTouch);
  ov.querySelector('#egCancel').addEventListener('click', () => ov.remove());
  applyB.addEventListener('click', () => {
    const d = deriveDates(tmp.realDate, win, w.endDate);
    w.egress = {
      realDate: d.realDate, reportDate: d.reportDate,
      fileName: tmp.fileName, fileB64: tmp.fileB64, fileType: tmp.fileType,
      docCause: tmp.fileName ? null : (tmp.docCause || null),
      docCauseOther: tmp.fileName ? null : (tmp.docCauseOther || null),
    };
    ov.remove();
    renderRows(ctx);
  });

  renderDoc();
  check();
  setTimeout(() => dateEl.focus(), 40);
}

/* ---------- MODAL: aplicar la misma fecha + causa en bloque ----------
   En bloque solo se aplica fecha real y (opcional) una causa comun; la
   carta se adjunta luego por persona desde Editar. */
function openBulk(ctx) {
  const ids = [...document.querySelectorAll('.egsel:checked')].map(c => +c.value);
  if (!ids.length) { alert('Selecciona al menos un trabajador.'); return; }
  const { win } = ctx;
  const causeOpts = (CAUSES || []).map(c => `<option value="${c.code}">${c.label}</option>`).join('');

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal">
      <h3>Aplicar a seleccionados</h3>
      <p class="who">${ids.length} trabajador(es) · cada uno deriva su fecha reportable según el corte</p>
      <div><label class="flabel">Fecha real de egreso</label>
        <input type="date" id="bDate" max="${win.reportMax}"></div>
      <div class="date-err" id="bErr" style="color:var(--danger);font-size:12px;min-height:16px;margin-top:6px"></div>
      <div id="bAdjust" class="coord-note" style="display:none;margin-top:6px"></div>
      <div style="margin-top:12px"><label class="flabel">Carta de renuncia (causa común, opcional)</label>
        <select id="bCause">
          <option value="" selected>— Sin causa (la configuro por persona) —</option>
          ${causeOpts}
        </select>
        <div id="bCauseOtherWrap" style="margin-top:8px;display:none">
          <input id="bCauseOther" placeholder="Especifica la causa">
        </div>
        <p class="hint" style="margin-top:6px">La carta se adjunta luego por persona desde <b>Editar</b>. Aquí solo aplicas fecha y, si quieres, una causa común.</p>
      </div>
      <div class="wiz-foot" style="margin-top:8px">
        <button class="btn" id="bCancel">Cancelar</button>
        <button class="btn btn-primary" id="bApply" disabled>Aplicar a ${ids.length}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const dateEl = ov.querySelector('#bDate'), applyB = ov.querySelector('#bApply'),
        errEl = ov.querySelector('#bErr'), adjEl = ov.querySelector('#bAdjust'),
        causeEl = ov.querySelector('#bCause');
  let touched = false;

  causeEl.addEventListener('change', () => {
    ov.querySelector('#bCauseOtherWrap').style.display = causeEl.value === 'other' ? '' : 'none';
    check();
  });

  function check() {
    const real = dateEl.value;
    const err = !real ? 'Falta la fecha real de egreso.'
      : (real > win.reportMax ? `La fecha real no puede ser futura (máximo ${DW.fmtDate(win.reportMax)}).` : null);
    errEl.textContent = (touched && err) ? err : '';
    adjEl.style.display = 'none';
    if (err) { applyB.disabled = true; return; }
    if (real < win.reportMin) {
      adjEl.style.display = 'flex';
      adjEl.innerHTML = `⚠ <div>La fecha real (${DW.fmtDate(real)}) es anterior al máximo reportable (${DW.fmtDate(win.reportMin)}). Nómina (AX) recibirá el ${DW.fmtDate(win.reportMin)}; la real queda registrada.</div>`;
    }
    // Si la causa es 'other', exige texto.
    if (causeEl.value === 'other' && !(ov.querySelector('#bCauseOther').value || '').trim()) {
      applyB.disabled = true; return;
    }
    applyB.disabled = false;
  }
  const onTouch = () => { touched = true; check(); };
  dateEl.addEventListener('input', onTouch);
  dateEl.addEventListener('change', onTouch);
  ov.querySelector('#bCancel').addEventListener('click', () => ov.remove());
  applyB.addEventListener('click', () => {
    const real = dateEl.value;
    const cause = causeEl.value || '';
    const causeOther = cause === 'other' ? (ov.querySelector('#bCauseOther').value || '').trim() : '';
    let skipped = 0;
    ctx.workers.forEach(w => {
      if (!ids.includes(w.id)) return;
      if (w.endDate && real > w.endDate) { skipped++; return; }
      const d = deriveDates(real, win, w.endDate);
      const prev = w.egress || {};
      w.egress = {
        realDate: d.realDate, reportDate: d.reportDate,
        // Conservar carta si ya la tenía; si no, aplicar la causa común (si se eligió).
        fileName: prev.fileName || null, fileB64: prev.fileB64 || null, fileType: prev.fileType || null,
        docCause: prev.fileName ? null : (cause || prev.docCause || null),
        docCauseOther: prev.fileName ? null : (cause === 'other' ? causeOther : (cause ? null : (prev.docCauseOther || null))),
      };
    });
    ov.remove();
    document.querySelectorAll('.egsel').forEach(c => c.checked = false);
    const all = $('#egAll'); if (all) all.checked = false;
    renderRows(ctx);
    if (skipped) alert(`${skipped} trabajador(es) no recibieron la fecha por ser posterior a su egreso ya registrado. Edítalos individualmente.`);
  });

  check();
}
