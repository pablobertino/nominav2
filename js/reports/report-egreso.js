/* =====================================================================
   js/reports/report-egreso.js
   Definicion del reporte de Egreso (Baja). Aporta el paso 4 y el envio.
   Se enchufa al wizard-core compartido.

   Modelo de fechas (decision de Pablo):
     - FECHA DE EGRESO (obligatoria): la que va a Nomina (AX). Es la fecha
       reportable; se valida contra la ventana del corte (no futura, dentro
       del margen, no posterior al egreso ya registrado).
     - FECHA REAL (opcional): solo si la persona realmente egreso en una
       fecha distinta a la reportada (normalmente mas antigua, fuera del
       margen). Es un dato informativo; NO se valida contra la ventana del
       corte (puede ser mas antigua libremente), solo <= hoy y <= la fecha
       de egreso reportada. Si no se indica, real = egreso.

   CARTA DE RENUNCIA opcional (mismo mecanismo que el documento de
   ausencia): si se adjunta, viaja como ticket DOC por persona. Si NO se
   adjunta, la tienda debe elegir una CAUSA. Cada causa puede EXIMIR el
   documento (no queda pendiente) o no (queda pendiente, como el modo
   "advierte" de ausencias).

   Identificacion del trabajador: cedula + nombre (del roster). El nombre se
   divide al armar el Excel (ultima palabra = apellidos) en el servidor.

   Nota: el backend (submit_egreso) recibe report_date (la de egreso, que va
   a AX) y real_date. Para mantener compatibilidad, SIEMPRE enviamos ambas;
   si la tienda no indica real distinta, real_date = report_date.
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
    { key: 'real_date', label: 'Fecha real (opcional)' },
    { key: 'doc', label: 'Carta de renuncia' },
  ],
  summaryCell(w, key) {
    const e = w.egress || {};
    if (key === 'kind') return 'Baja (B)';
    if (key === 'report_date') return e.reportDate ? DW.fmtDate(e.reportDate) : '—';
    if (key === 'real_date') {
      // Solo se muestra cuando la real difiere de la de egreso; si no, es
      // un dato que no aplica (la persona egreso en la fecha reportada).
      if (!e.realDate || e.realDate === e.reportDate) return '<span style="color:var(--muted)">—</span>';
      return `<span style="color:#9a6a00">${DW.fmtDate(e.realDate)}</span>`;
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
    if (!e || !e.reportDate) return false;
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
      // report_date = la de egreso (va a AX). real_date = la real si difiere,
      // si no, igual a la de egreso (compatibilidad con el backend).
      const reportDate = e.reportDate;
      const realDate = e.realDate || e.reportDate;
      return {
        id_number: w.ced,
        name: w.name,
        report_date: reportDate,
        real_date: realDate,
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
    <p class="hint">Indica la <b>fecha de egreso</b> de cada trabajador (la que se reporta a Nómina) y la <b>carta de renuncia</b>. Si la persona egresó en una fecha distinta a la que se puede reportar, puedes registrar además la <b>fecha real</b> (opcional). Si no tienes la carta, elige una causa.</p>
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
   (fecha de egreso + documento resuelto: carta o causa). */
function updateNext(ctx) {
  const total = ctx.workers.length;
  const done = ctx.workers.filter(w => {
    const e = w.egress;
    return e && e.reportDate && (e.fileName || e.docCause);
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
    const ready = e.reportDate && (e.fileName || e.docCause);
    const repCell = (e.reportDate) ? `<span class="date-badge">${DW.fmtDate(e.reportDate)}</span>` : '<span class="pill pill-pend">pendiente</span>';
    // Fecha real: solo cuando difiere de la de egreso. Si coincide o no se
    // indico, no aplica (guion suave).
    let realCell = '<span style="color:#ccc">—</span>';
    if (e.realDate && e.realDate !== e.reportDate) {
      realCell = `<span class="date-badge" style="background:#fff4e5;border-color:#f6c992">${DW.fmtDate(e.realDate)}</span>`;
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

/* Valida la FECHA DE EGRESO (la reportable) contra la ventana del corte.
   Es la que va a AX, asi que sigue las reglas normales. */
function egresoDateError(date, win, endDate) {
  if (!date) return 'Falta la fecha de egreso.';
  const v = DW.validateDate(date, win, endDate);
  return v.ok ? null : v.msg;
}

/* Valida la FECHA REAL (opcional). No se ata a la ventana del corte: puede
   ser mas antigua libremente. Solo: <= hoy y <= la fecha de egreso. */
function realDateError(realDate, win, reportDate) {
  if (!realDate) return null; // opcional
  if (realDate > win.today) return `La fecha real no puede ser futura (hoy es ${DW.fmtDate(win.today)}).`;
  if (reportDate && realDate > reportDate) return `La fecha real no puede ser posterior a la fecha de egreso (${DW.fmtDate(reportDate)}).`;
  return null;
}

/* HTML del bloque de carta de renuncia (estado actual: archivo o causa).
   Se inserta directo en el HTML inicial del modal (no en un slot vacio),
   para que SIEMPRE aparezca a la primera. */
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
  // Tope de la fecha de egreso reportable (acotado por el egreso ya registrado).
  const maxEgreso = (w.endDate && w.endDate < win.reportMax) ? w.endDate : win.reportMax;

  // Estado temporal dentro del modal.
  const tmp = {
    reportDate: e.reportDate || '',
    realDate: e.realDate && e.realDate !== e.reportDate ? e.realDate : '',
    realOn: !!(e.realDate && e.realDate !== e.reportDate),
    fileName: e.fileName || null, fileB64: e.fileB64 || null, fileType: e.fileType || null,
    docCause: e.docCause || '', docCauseOther: e.docCauseOther || '',
  };
  let touched = !!e.reportDate;

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  // El bloque de carta se inserta YA en el HTML inicial (no en un slot que
  // se llena despues), para que aparezca a la primera apertura.
  ov.innerHTML = `
    <div class="modal">
      <h3>Configurar egreso</h3>
      <p class="who">${w.name} · ${w.ced}${w.endDate ? ` · egreso ya registrado ${DW.fmtDate(w.endDate)}` : ''}</p>

      <div><label class="flabel">Fecha de egreso <span style="color:var(--danger)">*</span> <span style="color:var(--muted);font-weight:400">(la que se reporta a Nómina)</span></label>
        <input type="date" id="egDate" min="${win.reportMin}" max="${maxEgreso}" value="${tmp.reportDate}"></div>
      <div class="date-err" id="egErr" style="color:var(--danger);font-size:12px;min-height:16px;margin-top:6px"></div>

      <div style="margin-top:10px">
        <label class="radio-row" style="font-size:13px;display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="egRealOn" ${tmp.realOn ? 'checked' : ''}>
          La persona egresó en una fecha distinta a la reportada (registrar fecha real)
        </label>
        <div id="egRealWrap" style="margin-top:8px;${tmp.realOn ? '' : 'display:none'}">
          <label class="flabel">Fecha real de egreso <span style="color:var(--muted);font-weight:400">(opcional, informativa)</span></label>
          <input type="date" id="egReal" max="${win.today}" value="${tmp.realDate}">
          <div class="date-err" id="egRealErr" style="color:var(--danger);font-size:12px;min-height:16px;margin-top:6px"></div>
          <div id="egRealNote" class="hint" style="margin-top:4px"></div>
        </div>
      </div>

      ${docBoxHtml(tmp)}
      <input type="file" id="egFile" hidden accept="image/*,.pdf,.doc,.docx">

      <div class="wiz-foot" style="margin-top:18px">
        <button class="btn" id="egCancel">Cancelar</button>
        <button class="btn btn-primary" id="egApply" disabled>Aplicar</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const dateEl = ov.querySelector('#egDate'),
        realOnEl = ov.querySelector('#egRealOn'),
        realWrap = ov.querySelector('#egRealWrap'),
        realEl = ov.querySelector('#egReal'),
        realErrEl = ov.querySelector('#egRealErr'),
        realNoteEl = ov.querySelector('#egRealNote'),
        applyB = ov.querySelector('#egApply'),
        errEl = ov.querySelector('#egErr');

  // --- Bloque de carta: enlazar eventos (re-render tras adjuntar/limpiar) ---
  function bindDoc() {
    const pick = ov.querySelector('#egPick');
    if (pick) pick.addEventListener('click', () => ov.querySelector('#egFile').click());
    const clr = ov.querySelector('#egClearFile');
    if (clr) clr.addEventListener('click', () => {
      tmp.fileName = null; tmp.fileB64 = null; tmp.fileType = null;
      reRenderDoc(); check();
    });
    const sel = ov.querySelector('#egCause');
    if (sel) sel.addEventListener('change', () => {
      tmp.docCause = sel.value;
      const ow = ov.querySelector('#egCauseOtherWrap');
      if (ow) ow.style.display = sel.value === 'other' ? '' : 'none';
      updateCauseNote();
      check();
    });
    const other = ov.querySelector('#egCauseOther');
    if (other) other.addEventListener('input', () => { tmp.docCauseOther = other.value; check(); });
    updateCauseNote();
  }
  function updateCauseNote() {
    const note = ov.querySelector('#egCauseNote');
    const c = causeByCode(tmp.docCause);
    if (note && c) note.textContent = c.waives_document
      ? 'Con esta causa el egreso NO queda pendiente de carta.'
      : 'El egreso quedará como “carta pendiente” hasta que se entregue.';
    else if (note) note.textContent = '';
  }
  // Re-render SOLO del bloque de carta (reemplaza el #egDocBox existente).
  function reRenderDoc() {
    const cur = ov.querySelector('#egDocBox');
    if (!cur) return;
    const tmpWrap = document.createElement('div');
    tmpWrap.innerHTML = docBoxHtml(tmp);
    cur.replaceWith(tmpWrap.firstElementChild);
    bindDoc();
  }

  // Adjuntar archivo -> base64.
  ov.querySelector('#egFile').addEventListener('change', ev => {
    const f = ev.target.files && ev.target.files[0];
    if (f) {
      const reader = new FileReader();
      reader.onload = () => {
        tmp.fileName = f.name;
        tmp.fileB64 = String(reader.result).split(',')[1] || null;
        tmp.fileType = f.type || 'application/octet-stream';
        tmp.docCause = ''; tmp.docCauseOther = ''; // con carta, la causa no aplica
        reRenderDoc(); check();
      };
      reader.readAsDataURL(f);
    }
  });

  // Toggle de la fecha real opcional.
  realOnEl.addEventListener('change', () => {
    tmp.realOn = realOnEl.checked;
    realWrap.style.display = tmp.realOn ? '' : 'none';
    if (!tmp.realOn) { tmp.realDate = ''; realEl.value = ''; }
    check();
  });
  const onReal = () => { tmp.realDate = realEl.value; check(); };
  realEl.addEventListener('input', onReal);
  realEl.addEventListener('change', onReal);

  function check() {
    // 1) Fecha de egreso (obligatoria, contra la ventana).
    const errEgreso = egresoDateError(tmp.reportDate, win, w.endDate);
    errEl.textContent = (touched || tmp.reportDate) ? (errEgreso || '') : '';

    // 2) Fecha real (opcional): validar solo si el toggle esta activo.
    let errReal = null;
    realErrEl.textContent = '';
    realNoteEl.textContent = '';
    if (tmp.realOn) {
      errReal = realDateError(tmp.realDate, win, tmp.reportDate);
      realErrEl.textContent = errReal || '';
      if (!errReal && tmp.realDate && tmp.reportDate && tmp.realDate !== tmp.reportDate) {
        realNoteEl.textContent = `Nómina recibirá el ${DW.fmtDate(tmp.reportDate)}; la fecha real (${DW.fmtDate(tmp.realDate)}) queda registrada como referencia.`;
      }
    }

    // 3) Documento resuelto: carta, o causa (si 'other', con texto).
    const docOk = tmp.fileName
      || (tmp.docCause && (tmp.docCause !== 'other' || (tmp.docCauseOther || '').trim()));

    const allOk = !errEgreso && tmp.reportDate && !errReal && docOk;
    applyB.disabled = !allOk;
  }

  const onTouch = () => { touched = true; tmp.reportDate = dateEl.value; check(); };
  dateEl.addEventListener('input', onTouch);
  dateEl.addEventListener('change', onTouch);
  ov.querySelector('#egCancel').addEventListener('click', () => ov.remove());
  applyB.addEventListener('click', () => {
    // real efectiva: si el toggle esta on y hay fecha distinta, se guarda;
    // si no, real = report (la persona egreso en la fecha reportada).
    const realEff = (tmp.realOn && tmp.realDate && tmp.realDate !== tmp.reportDate)
      ? tmp.realDate : tmp.reportDate;
    w.egress = {
      reportDate: tmp.reportDate,
      realDate: realEff,
      fileName: tmp.fileName, fileB64: tmp.fileB64, fileType: tmp.fileType,
      docCause: tmp.fileName ? null : (tmp.docCause || null),
      docCauseOther: tmp.fileName ? null : (tmp.docCauseOther || null),
    };
    ov.remove();
    renderRows(ctx);
  });

  bindDoc();
  check();
  setTimeout(() => dateEl.focus(), 40);
}

/* ---------- MODAL: aplicar la misma fecha + causa en bloque ----------
   En bloque solo se aplica la FECHA DE EGRESO y (opcional) una causa comun;
   la carta y la fecha real se ajustan luego por persona desde Editar. */
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
      <p class="who">${ids.length} trabajador(es) · se aplica la misma fecha de egreso</p>
      <div><label class="flabel">Fecha de egreso <span style="color:var(--danger)">*</span></label>
        <input type="date" id="bDate" min="${win.reportMin}" max="${win.reportMax}"></div>
      <div class="date-err" id="bErr" style="color:var(--danger);font-size:12px;min-height:16px;margin-top:6px"></div>
      <div style="margin-top:12px"><label class="flabel">Carta de renuncia (causa común, opcional)</label>
        <select id="bCause">
          <option value="" selected>— Sin causa (la configuro por persona) —</option>
          ${causeOpts}
        </select>
        <div id="bCauseOtherWrap" style="margin-top:8px;display:none">
          <input id="bCauseOther" placeholder="Especifica la causa">
        </div>
        <p class="hint" style="margin-top:6px">La carta y la fecha real (si aplica) se ajustan luego por persona desde <b>Editar</b>. Aquí solo aplicas la fecha de egreso y, si quieres, una causa común.</p>
      </div>
      <div class="wiz-foot" style="margin-top:8px">
        <button class="btn" id="bCancel">Cancelar</button>
        <button class="btn btn-primary" id="bApply" disabled>Aplicar a ${ids.length}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const dateEl = ov.querySelector('#bDate'), applyB = ov.querySelector('#bApply'),
        errEl = ov.querySelector('#bErr'), causeEl = ov.querySelector('#bCause');
  let touched = false;

  causeEl.addEventListener('change', () => {
    ov.querySelector('#bCauseOtherWrap').style.display = causeEl.value === 'other' ? '' : 'none';
    check();
  });

  function check() {
    const date = dateEl.value;
    const err = egresoDateError(date, win, null);
    errEl.textContent = (touched && err) ? err : '';
    if (err) { applyB.disabled = true; return; }
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
    const date = dateEl.value;
    const cause = causeEl.value || '';
    const causeOther = cause === 'other' ? (ov.querySelector('#bCauseOther').value || '').trim() : '';
    let skipped = 0;
    ctx.workers.forEach(w => {
      if (!ids.includes(w.id)) return;
      // Si la fecha de egreso es posterior al egreso ya registrado, no aplica.
      if (w.endDate && date > w.endDate) { skipped++; return; }
      const prev = w.egress || {};
      // Conservar fecha real previa solo si sigue siendo coherente (<= nueva fecha de egreso).
      const keepReal = (prev.realDate && prev.realDate !== prev.reportDate && prev.realDate <= date)
        ? prev.realDate : date;
      w.egress = {
        reportDate: date,
        realDate: keepReal,
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
