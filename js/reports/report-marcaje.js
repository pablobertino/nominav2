/* =====================================================================
   js/reports/report-marcaje.js
   Definicion del reporte de Marcaje Manual. Aporta el paso 4 (config por
   trabajador: fecha, hora entrada, hora salida, causa) y el envio.
   Se enchufa al wizard-core compartido.
   ===================================================================== */

import { $ } from '../core/dom.js';
import * as DW from './shared/date-window.js';

let CAUSES = null; // [{code,label,is_other}]

async function loadCauses() {
  if (CAUSES) return CAUSES;
  const res = await fetch('/api/catalog', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'marcaje_causas' }),
  }).then(r => r.json()).catch(() => null);
  CAUSES = (res && res.ok && res.causas) ? res.causas : [
    { code: 'forgot', label: 'Olvido de marcaje', is_other: false },
    { code: 'other', label: 'Otros…', is_other: true },
  ];
  return CAUSES;
}

function causeLabel(code) {
  const c = (CAUSES || []).find(x => x.code === code);
  return c ? c.label : code;
}

export const marcajeReport = {
  code: 'marcaje',
  title: 'Reportar Marcaje Manual',
  icon: '🕐',
  tag: 'Marcaje Manual · wizard',
  step4Label: 'Marcajes',

  summaryColumns: [
    { key: 'date', label: 'Fecha' },
    { key: 'time_in', label: 'Entrada' },
    { key: 'time_out', label: 'Salida' },
    { key: 'cause', label: 'Causa' },
  ],
  summaryCell(w, key) {
    const m = w.mark || {};
    if (key === 'date') return m.date ? DW.fmtDate(m.date) : '—';
    if (key === 'time_in') return `<span class="time-badge">${m.timeIn || '—'}</span>`;
    if (key === 'time_out') return `<span class="time-badge">${m.timeOut || '—'}</span>`;
    if (key === 'cause') return m.cause === 'other' ? (m.other || 'Otros…') : causeLabel(m.cause);
    return '';
  },

  isComplete(w) { return !!w.mark; },

  renderStep4(ctx) {
    loadCauses().then(() => paintStep4(ctx));
    $('#wzPanel').innerHTML = '<div class="pnl-loading">Cargando…</div>';
  },

  async submit({ companyCode, responsible, position, workers }) {
    const lines = workers.map(w => ({
      id_number: w.ced, name: w.name,
      mark_date: w.mark.date, time_in: w.mark.timeIn, time_out: w.mark.timeOut,
      cause_code: w.mark.cause, cause_other_text: w.mark.cause === 'other' ? w.mark.other : null,
    }));
    const res = await fetch('/api/reports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'submit_marcaje', company_code: companyCode, responsible, position, lines }),
    });
    return res.json();
  },
};

/* ---- el paso 4 propiamente ---- */
let cfgMode = 'bulk';

function paintStep4(ctx) {
  const { workers, win, fmt } = ctx;
  const panel = $('#wzPanel');
  panel.innerHTML = `
    <h2>Configurar marcajes</h2>
    <p class="hint">Cada trabajador necesita fecha, hora de entrada, hora de salida y causa. Selecciona varios para aplicar lo mismo en bloque, o edita con ✏️.</p>
    <div class="window-info"><span class="wi-ico">⏱</span><div>${DW.windowText(win)}</div></div>
    <div class="selbar hidden" id="m4Selbar"><b id="m4SelCount">0</b> seleccionados
      <span class="spacer"></span>
      <button class="btn btn-sm btn-primary" id="m4Bulk">Aplicar a seleccionados</button>
      <button class="btn btn-sm" id="m4Clear">Quitar selección</button>
    </div>
    <table id="m4Tbl"><thead><tr>
      <th style="width:30px"><input type="checkbox" class="chk" id="m4All"></th>
      <th>Trabajador</th><th>Fecha</th><th>Entrada</th><th>Salida</th><th>Causa</th><th style="width:70px"></th>
    </tr></thead><tbody id="m4Body"></tbody></table>
    <div class="wiz-foot">
      <button class="btn" id="m4Back">← Atrás</button>
      <button class="btn btn-primary" id="m4Next" disabled>Revisar y enviar →</button>
    </div>`;

  $('#m4All').addEventListener('change', e => {
    document.querySelectorAll('.m4sel').forEach(c => c.checked = e.target.checked); onSel();
  });
  $('#m4Bulk').addEventListener('click', () => openCfg('bulk', ctx));
  $('#m4Clear').addEventListener('click', () => {
    document.querySelectorAll('.m4sel').forEach(c => c.checked = false); $('#m4All').checked = false; onSel();
  });
  $('#m4Back').addEventListener('click', () => ctx.setStep(3));
  $('#m4Next').addEventListener('click', () => ctx.setStep(5));

  paintBody(ctx);

  function onSel() {
    const n = document.querySelectorAll('.m4sel:checked').length;
    $('#m4Selbar').classList.toggle('hidden', n === 0);
    $('#m4SelCount').textContent = n;
  }
  // exponer para paintBody
  paintStep4._onSel = onSel;
}

function paintBody(ctx) {
  const { workers, fmt } = ctx;
  $('#m4Body').innerHTML = workers.map(w => {
    const m = w.mark;
    const fecha = m ? fmt.fmtDate(m.date) : '<span class="pill pill-pend">pendiente</span>';
    const tin = m ? `<span class="time-badge">${m.timeIn}</span>` : '—';
    const tout = m ? `<span class="time-badge">${m.timeOut}</span>` : '—';
    const causa = m ? (m.cause === 'other' ? (m.other || 'Otros…') : causeLabel(m.cause)) : '—';
    return `<tr>
      <td><input type="checkbox" class="chk m4sel" value="${w.id}"></td>
      <td><b>${w.name}</b><br><span style="font-size:12px;color:var(--muted)" class="ced">${w.ced}</span>
        ${w.endDate ? `<br><span class="pill pill-out" style="margin-top:3px">marcaje máx. ${fmt.fmtDate(w.endDate)}</span>` : ''}</td>
      <td>${fecha}</td><td>${tin}</td><td>${tout}</td><td>${causa}</td>
      <td style="white-space:nowrap"><button class="btn btn-sm" data-edit="${w.id}" title="Configurar">✏️</button>
        <button class="x-btn" data-rm="${w.id}" title="Quitar">✕</button></td>
    </tr>`;
  }).join('');
  $('#m4All').checked = false;
  $('#m4Body').querySelectorAll('.m4sel').forEach(c => c.addEventListener('change', paintStep4._onSel));
  $('#m4Body').querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openCfg(parseInt(b.dataset.edit, 10), ctx)));
  $('#m4Body').querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
    const w = ctx.getWorker(parseInt(b.dataset.rm, 10));
    if (w && !confirm(`¿Quitar a ${w.name} del reporte?`)) return;
    ctx.removeWorker(parseInt(b.dataset.rm, 10));
    paintBody(ctx); updateNext(ctx);
  }));
  if (paintStep4._onSel) paintStep4._onSel();
  updateNext(ctx);
}

function updateNext(ctx) {
  const allSet = ctx.workers.length > 0 && ctx.workers.every(w => w.mark);
  if ($('#m4Next')) $('#m4Next').disabled = !allSet;
}

function openCfg(mode, ctx) {
  const { win, fmt } = ctx;
  const isBulk = mode === 'bulk';
  let selIds = [];
  if (isBulk) {
    selIds = [...document.querySelectorAll('.m4sel:checked')].map(c => +c.value);
    if (!selIds.length) { alert('Selecciona al menos un trabajador.'); return; }
  }
  const w = isBulk ? null : ctx.getWorker(mode);
  // max de fecha: para individual, acotado por su egreso
  const maxForWorker = (!isBulk && w.endDate && w.endDate < win.reportMax) ? w.endDate : win.reportMax;

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal">
      <h3>${isBulk ? 'Aplicar a seleccionados' : 'Configurar marcaje'}</h3>
      <p class="who">${isBulk ? `${selIds.length} trabajador(es) · la fecha se valida contra el egreso de cada uno`
                              : `${w.name} · ${w.ced}${w.endDate ? ` · egresó ${fmt.fmtDate(w.endDate)}` : ''}`}</p>
      <div class="grid2" style="margin-bottom:8px">
        <div><label class="flabel">Fecha</label>
          <input type="date" id="cfgDate" min="${win.reportMin}" max="${maxForWorker}">
          <div class="date-err" id="dateErr"></div></div>
        <div><label class="flabel">Causa</label>
          <select id="cfgCause">${(CAUSES || []).map(c => `<option value="${c.code}">${c.label}</option>`).join('')}</select></div>
      </div>
      <div class="grid2" style="margin-bottom:8px">
        <div><label class="flabel">Hora de entrada</label><input type="time" id="cfgIn" value="08:00"></div>
        <div><label class="flabel">Hora de salida</label><input type="time" id="cfgOut" value="17:00"></div>
      </div>
      <div class="time-err" id="timeErr"></div>
      <div id="otherWrap" style="display:none;margin-bottom:8px">
        <label class="flabel">Especifica la causa</label><input id="cfgOther" placeholder="Describe brevemente"></div>
      <div class="wiz-foot" style="margin-top:14px">
        <button class="btn" id="cfgCancel">Cancelar</button>
        <button class="btn btn-primary" id="cfgApply">Aplicar</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const dEl = ov.querySelector('#cfgDate'), inEl = ov.querySelector('#cfgIn'),
        outEl = ov.querySelector('#cfgOut'), causeEl = ov.querySelector('#cfgCause'),
        otherEl = ov.querySelector('#cfgOther'), applyB = ov.querySelector('#cfgApply');

  // valores iniciales
  if (!isBulk && w.mark) {
    dEl.value = w.mark.date; causeEl.value = w.mark.cause; otherEl.value = w.mark.other || '';
    inEl.value = w.mark.timeIn; outEl.value = w.mark.timeOut;
  } else {
    dEl.value = (maxForWorker < win.reportMin) ? win.reportMin : maxForWorker;
  }
  toggleOther();

  function toggleOther() {
    const c = (CAUSES || []).find(x => x.code === causeEl.value);
    ov.querySelector('#otherWrap').style.display = (c && c.is_other) ? 'block' : 'none';
  }
  function validateDate() {
    const endForVal = isBulk ? null : (w.endDate || null);
    const v = DW.validateDate(dEl.value, win, endForVal);
    const err = ov.querySelector('#dateErr');
    err.style.color = v.level === 'warn' ? 'var(--warn)' : '';
    err.textContent = v.ok && v.level === 'ok' ? '' : v.msg;
    return v.ok;
  }
  function validateTimes() {
    const bad = inEl.value && outEl.value && inEl.value >= outEl.value;
    ov.querySelector('#timeErr').textContent = bad ? 'La hora de entrada debe ser menor que la de salida.' : '';
    return !bad;
  }
  function recheck() { applyB.disabled = !(validateDate() & validateTimes()); }

  dEl.addEventListener('input', recheck);
  inEl.addEventListener('input', recheck);
  outEl.addEventListener('input', recheck);
  causeEl.addEventListener('change', toggleOther);
  ov.querySelector('#cfgCancel').addEventListener('click', () => ov.remove());
  recheck();

  applyB.addEventListener('click', () => {
    const mark = {
      date: dEl.value, cause: causeEl.value, other: otherEl.value.trim(),
      timeIn: inEl.value, timeOut: outEl.value,
    };
    if (isBulk) {
      let skipped = 0;
      ctx.workers.forEach(ww => {
        if (selIds.includes(ww.id)) {
          if (ww.endDate && mark.date > ww.endDate) { skipped++; return; }
          ww.mark = { ...mark };
        }
      });
      ov.remove();
      paintBody(ctx);
      if (skipped) alert(`${skipped} trabajador(es) no recibieron la fecha por ser posterior a su egreso. Configúralos individualmente.`);
    } else {
      w.mark = { ...mark };
      ov.remove();
      paintBody(ctx);
    }
  });
}
