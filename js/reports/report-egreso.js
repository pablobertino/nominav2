/* =====================================================================
   js/reports/report-egreso.js
   Definicion del reporte de Egreso (Baja). Aporta el paso 4 y el envio.
   Se enchufa al wizard-core compartido.

   Particularidades del Egreso frente a Ausencia:
     - No hay "tipo" a elegir: siempre es Baja (B). No lleva documentos.
     - Por trabajador se captura UNA fecha: la FECHA REAL de egreso (cuando
       dejo de trabajar de verdad). De ahi el sistema DERIVA la fecha
       REPORTABLE (la que va a AX), que esta limitada por la ventana hacia
       atras (regla general de marcaje: hoy - corte_margen_dias con la hora
       tope, no futura, acotada por el hito de quincena).
         * Si la fecha real cae dentro de la ventana -> reportable = real.
         * Si la fecha real es mas antigua que el minimo reportable -> la
           reportable se fija en el minimo permitido y se avisa; la real
           queda registrada igual (en BD y en el ticket).
     - El Excel/AX recibe la REPORTABLE. El ticket muestra ambas cuando
       difieren, y una sola cuando coinciden.

   Identificacion del trabajador: minima y sin errores -> cedula + nombre,
   que vienen del roster (Reporte 10). No se piden los nombres separados.
   ===================================================================== */

import { $ } from '../core/dom.js';
import * as DW from './shared/date-window.js';

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
  ],
  summaryCell(w, key) {
    const e = w.egress || {};
    if (key === 'kind') return 'Baja (B)';
    if (key === 'report_date') return e.reportDate ? DW.fmtDate(e.reportDate) : '—';
    if (key === 'real_date') {
      if (!e.realDate) return '—';
      // Si coincide con la reportable, no es informacion nueva: guion.
      return e.realDate === e.reportDate
        ? '<span style="color:var(--muted)">igual</span>'
        : DW.fmtDate(e.realDate);
    }
    return '';
  },

  isComplete(w) { return !!(w.egress && w.egress.reportDate && w.egress.realDate); },

  renderStep4(ctx) {
    paintStep4(ctx);
  },

  async submit({ companyCode, responsible, position, workers, source_kind, source_admin_id }) {
    const lines = workers.map(w => ({
      id_number: w.ced,
      name: w.name,
      // Ambas fechas: la reportable (a AX) y la real (a BD + ticket).
      report_date: w.egress.reportDate,
      real_date: w.egress.realDate,
    }));
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
    <p class="hint">Indica la <b>fecha real de egreso</b> de cada trabajador (cuándo dejó de trabajar). La fecha que se envía a Nómina se ajusta sola al máximo permitido por el corte; la fecha real queda registrada de todas formas.</p>
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
        <th>Trabajador</th><th>Tipo</th><th>Fecha de egreso</th><th>Fecha real</th><th style="width:130px"></th>
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

/* Habilita "Revisar y enviar" solo si todos quedaron configurados. */
function updateNext(ctx) {
  const total = ctx.workers.length;
  const done = ctx.workers.filter(w => w.egress && w.egress.reportDate && w.egress.realDate).length;
  const btn = $('#egNext');
  if (btn) btn.disabled = done !== total || total === 0;
  const prog = $('#egProg');
  if (prog) prog.textContent = `${done} de ${total} configurados`;
  const bar = $('#egProgBar');
  if (bar) bar.style.width = total ? (done / total * 100) + '%' : '0%';
}

function renderRows(ctx) {
  const tb = $('#egTbody');
  if (!tb) return;

  tb.innerHTML = ctx.workers.map(w => {
    const e = w.egress || {};
    const ready = e.reportDate && e.realDate;
    const repCell = ready ? `<span class="date-badge">${DW.fmtDate(e.reportDate)}</span>` : '<span class="pill pill-pend">pendiente</span>';
    let realCell = '—';
    if (ready) {
      realCell = e.realDate === e.reportDate
        ? '<span style="color:var(--muted)">igual</span>'
        : `<span class="date-badge" style="background:#fff4e5;border-color:#f6c992">${DW.fmtDate(e.realDate)}</span>`;
    }
    return `<tr class="${ready ? 'done-row' : ''}">
      <td><input type="checkbox" class="chk egsel" value="${w.id}"></td>
      <td><b>${w.name}</b><br><span class="ced">${w.ced}</span>
        ${w.endDate ? `<br><span class="pill pill-out" style="margin-top:3px">ya tenía egreso ${DW.fmtDate(w.endDate)}</span>` : ''}</td>
      <td>Baja (B)</td>
      <td>${repCell}</td><td>${realCell}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm" data-cfg="${w.id}">${ready ? '✏️ Editar' : '＋ Configurar'}</button>
        <button class="x-btn" data-rm="${w.id}" title="Quitar">✕</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">No hay trabajadores. Vuelve al paso anterior para agregarlos.</td></tr>';

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

/* Dada la fecha REAL elegida, deriva la REPORTABLE segun la ventana de
   marcaje (win). Devuelve { reportDate, realDate, adjusted, msg }:
     - Si la real cae dentro de la ventana -> reportable = real (no ajuste).
     - Si la real es anterior al minimo reportable -> reportable = minimo,
       adjusted=true y un mensaje explicando que AX recibe el minimo.
   La real nunca puede ser futura ni posterior al egreso conocido; eso lo
   valida el caller antes de derivar. */
function deriveDates(realDate, win, endDate) {
  const { reportMin, reportMax } = win;
  // La reportable no puede exceder el tope superior (hoy/hito) ni el egreso.
  const maxRep = (endDate && endDate < reportMax) ? endDate : reportMax;
  let reportDate = realDate;
  let adjusted = false;
  let msg = '';
  if (realDate < reportMin) {
    // Mas antigua que lo reportable: AX recibe el minimo permitido.
    reportDate = reportMin;
    adjusted = true;
    msg = `La persona egresó el ${DW.fmtDate(realDate)}. El máximo reportable es el ${DW.fmtDate(reportMin)}, así que Nómina (AX) recibirá el ${DW.fmtDate(reportMin)}; la fecha real (${DW.fmtDate(realDate)}) queda registrada.`;
  } else if (realDate > maxRep) {
    // No deberia pasar (el input acota arriba), pero por seguridad.
    reportDate = maxRep;
    adjusted = true;
    msg = `La fecha se ajustó al ${DW.fmtDate(maxRep)} (tope permitido).`;
  }
  return { reportDate, realDate, adjusted, msg };
}

/* Valida la fecha REAL: no futura, no posterior al egreso ya conocido.
   Hacia atras es libre (justo sirve para egresos reportados tarde).
   Devuelve string de error o null. */
function realDateError(realDate, win, endDate) {
  if (!realDate) return 'Falta la fecha real de egreso.';
  if (realDate > win.reportMax) return `La fecha real no puede ser futura (máximo ${DW.fmtDate(win.reportMax)}).`;
  if (endDate && realDate > endDate) return `No puede ser posterior al egreso ya registrado (${DW.fmtDate(endDate)}).`;
  return null;
}

/* ---------- MODAL: configurar UN trabajador (fecha real) ---------- */
function openConfig(ctx, id) {
  const w = ctx.getWorker(id);
  if (!w) return;
  const { win } = ctx;
  const e = w.egress || {};
  // El input de fecha real se acota arriba (no futura, no posterior al
  // egreso conocido). Hacia atras queda libre (sin min).
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
      <div class="wiz-foot" style="margin-top:18px">
        <button class="btn" id="egCancel">Cancelar</button>
        <button class="btn btn-primary" id="egApply" disabled>Aplicar</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const dateEl = ov.querySelector('#egDate'), applyB = ov.querySelector('#egApply'),
        errEl = ov.querySelector('#egErr'), adjEl = ov.querySelector('#egAdjust');

  // touched: solo mostramos el error "Falta la fecha" despues de que el
  // usuario haya interactuado, para no "gritar" al abrir el modal vacio.
  let touched = !!e.realDate;

  function check() {
    const real = dateEl.value;
    const err = realDateError(real, win, w.endDate);
    // Si aun no toco el campo y esta vacio, no pintamos error (solo deshabilita).
    errEl.textContent = (touched || real) ? (err || '') : '';
    adjEl.style.display = 'none';
    if (err || !real) { applyB.disabled = true; return; }
    // Derivar reportable y, si hubo ajuste, mostrar el aviso.
    const d = deriveDates(real, win, w.endDate);
    if (d.adjusted) { adjEl.style.display = 'flex'; adjEl.innerHTML = `⚠ <div>${d.msg}</div>`; }
    applyB.disabled = false;
  }
  // El input date dispara 'input' al teclear y 'change' al elegir del
  // calendario nativo; escuchamos ambos para no perder ninguno.
  const onTouch = () => { touched = true; check(); };
  dateEl.addEventListener('input', onTouch);
  dateEl.addEventListener('change', onTouch);
  ov.querySelector('#egCancel').addEventListener('click', () => ov.remove());
  applyB.addEventListener('click', () => {
    const real = dateEl.value;
    const d = deriveDates(real, win, w.endDate);
    w.egress = { realDate: d.realDate, reportDate: d.reportDate };
    ov.remove();
    renderRows(ctx);
  });

  check();
  // Foco al campo para que el usuario pueda escribir/abrir el calendario.
  setTimeout(() => dateEl.focus(), 40);
}

/* ---------- MODAL: aplicar la misma fecha real en bloque ---------- */
function openBulk(ctx) {
  const ids = [...document.querySelectorAll('.egsel:checked')].map(c => +c.value);
  if (!ids.length) { alert('Selecciona al menos un trabajador.'); return; }
  const { win } = ctx;

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal">
      <h3>Aplicar fecha de egreso a seleccionados</h3>
      <p class="who">${ids.length} trabajador(es) · cada uno deriva su fecha reportable según el corte</p>
      <div><label class="flabel">Fecha real de egreso</label>
        <input type="date" id="bDate" max="${win.reportMax}"></div>
      <div class="date-err" id="bErr" style="color:var(--danger);font-size:12px;min-height:16px;margin-top:6px"></div>
      <div id="bAdjust" class="coord-note" style="display:none;margin-top:6px"></div>
      <div class="wiz-foot" style="margin-top:8px">
        <button class="btn" id="bCancel">Cancelar</button>
        <button class="btn btn-primary" id="bApply" disabled>Aplicar a ${ids.length}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const dateEl = ov.querySelector('#bDate'), applyB = ov.querySelector('#bApply'),
        errEl = ov.querySelector('#bErr'), adjEl = ov.querySelector('#bAdjust');

  let touched = false;
  function check() {
    const real = dateEl.value;
    // En bloque no validamos egreso por persona (se valida al aplicar); solo
    // no-futura. La derivacion por trabajador respeta su propio egreso.
    const err = !real ? 'Falta la fecha real de egreso.'
      : (real > win.reportMax ? `La fecha real no puede ser futura (máximo ${DW.fmtDate(win.reportMax)}).` : null);
    errEl.textContent = (touched && err) ? err : '';
    adjEl.style.display = 'none';
    if (err) { applyB.disabled = true; return; }
    // Aviso general si la fecha cae fuera de la ventana (se ajustara a AX).
    if (real < win.reportMin) {
      adjEl.style.display = 'flex';
      adjEl.innerHTML = `⚠ <div>La fecha real (${DW.fmtDate(real)}) es anterior al máximo reportable (${DW.fmtDate(win.reportMin)}). Nómina (AX) recibirá el ${DW.fmtDate(win.reportMin)}; la real queda registrada.</div>`;
    }
    applyB.disabled = false;
  }
  const onTouch = () => { touched = true; check(); };
  dateEl.addEventListener('input', onTouch);
  dateEl.addEventListener('change', onTouch);
  ov.querySelector('#bCancel').addEventListener('click', () => ov.remove());
  applyB.addEventListener('click', () => {
    const real = dateEl.value;
    let skipped = 0;
    ctx.workers.forEach(w => {
      if (!ids.includes(w.id)) return;
      // Si la real es posterior al egreso ya registrado de esa persona, se omite.
      if (w.endDate && real > w.endDate) { skipped++; return; }
      const d = deriveDates(real, win, w.endDate);
      w.egress = { realDate: d.realDate, reportDate: d.reportDate };
    });
    ov.remove();
    document.querySelectorAll('.egsel').forEach(c => c.checked = false);
    const all = $('#egAll'); if (all) all.checked = false;
    renderRows(ctx);
    if (skipped) alert(`${skipped} trabajador(es) no recibieron la fecha por ser posterior a su egreso ya registrado. Edítalos individualmente.`);
  });

  check();
}
