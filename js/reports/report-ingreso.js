/* =====================================================================
   js/reports/report-ingreso.js
   Definicion del reporte de Ingreso (Alta). Aporta el paso 4 y el envio.
   Se enchufa al wizard-core compartido.

   A diferencia de marcaje/ausencia/egreso, un Ingreso es una persona
   NUEVA: no sale del roster. El paso 4 captura el alta completa con un
   modal por persona (la grilla vive en ctx.workers, igual que los demas,
   para que el Resumen y el envio del core funcionen sin cambios).

   Cada worker agregado tiene la forma estandar { id, ced, name } MAS un
   objeto .ingreso con todos los datos del alta:
     { firstName, secondName, lastNames, cedKind, cargoCode,
       birthDate, gender, marital, account, bankCode, bankName,
       email, phone (nacional 04XX), phoneIntl (+58), address, startDate }

   Reglas (validadas tambien server-side en submit_ingreso):
     - cedula 6-8 digitos; letra V/E derivada (>=80.000.000 -> E).
     - edad >= 18 (desde fecha de nacimiento).
     - cuenta 20 digitos; prefijo (4) debe existir en el catalogo de bancos.
     - telefono opcional 04XX+7; prefijo en operadoras; se guarda +58.
     - cargo del catalogo (selectable_on_ingreso).
     - fecha de ingreso dentro de la ventana (margen atras + futuro config).
   TodoTicket NO se captura (siempre 'N' al exportar). El Data ID lo
   aporta la empresa en el servidor.
   ===================================================================== */

import { $ } from '../core/dom.js';
import * as DW from './shared/date-window.js';

// Catalogos del wizard (cargos + bancos + operadoras + ventana). Una vez.
let CAT = null;

async function loadCatalogs() {
  if (CAT) return CAT;
  const res = await fetch('/api/catalog', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'ingreso_catalogs' }),
  }).then(r => r.json()).catch(() => null);
  CAT = (res && res.ok) ? {
    cargos: res.cargos || [],
    bancos: res.bancos || [],
    operadoras: res.operadoras || [],
    win: res.window_config || { cutoff_time: '14:00', margin_days: 2, future_days: 7 },
    bankMap: Object.fromEntries((res.bancos || []).map(b => [b.code, b.name])),
    opMap: Object.fromEntries((res.operadoras || []).map(o => [o.code, o.name])),
  } : { cargos: [], bancos: [], operadoras: [], win: { cutoff_time: '14:00', margin_days: 2, future_days: 7 }, bankMap: {}, opMap: {} };
  return CAT;
}

function cargoLabel(code) {
  const c = (CAT && CAT.cargos || []).find(x => x.code === code);
  return c ? c.label : code;
}

/* Ventana propia de Ingreso: margen hacia atras (con hora tope) + futuro.
   No usa ctx.win (atada a la quincena, sin futuro). */
function ingresoWindow() {
  const wc = (CAT && CAT.win) || { cutoff_time: '14:00', margin_days: 2, future_days: 7 };
  return DW.typeWindow({
    pastWindowDays: wc.margin_days,
    pastUsesCutoff: true,
    futureWindowDays: wc.future_days,
    cutoffTime: wc.cutoff_time,
  });
}

/* Error de la fecha de ingreso contra la ventana de Ingreso. */
function startDateError(date, win) {
  if (!date) return 'Falta la fecha de ingreso.';
  if (date > win.maxDate) return `No puede ser posterior al ${DW.fmtDate(win.maxDate)} (máx. ${win.futureWindowDays} días a futuro).`;
  if (win.minDate && date < win.minDate) {
    if (win.pastCutoff && win.oldestDay && date < DW.addDays(win.oldestDay, 1)) {
      return `El ${DW.fmtDate(win.oldestDay)} ya no se puede reportar: pasó la hora tope (${win.cutoffTime} hora Venezuela).`;
    }
    return `No puede ser anterior al ${DW.fmtDate(win.minDate)} (fuera del margen reportable).`;
  }
  return null;
}

/* Valida la cuenta: 20 digitos, prefijo en catalogo de bancos. */
function validAccount(raw) {
  const c = String(raw || '').replace(/[^0-9]/g, '');
  if (!c) return { ok: false, empty: true };
  if (c.length !== 20) return { ok: false, msg: `La cuenta debe tener 20 dígitos (van ${c.length}).` };
  const pre = c.slice(0, 4);
  if (!CAT.bankMap[pre]) return { ok: false, msg: `El prefijo ${pre} no corresponde a un banco válido.` };
  return { ok: true, account: c, bankCode: pre, bankName: CAT.bankMap[pre] };
}

/* Valida el telefono opcional: 11 digitos 04XX+7, prefijo en operadoras. */
function validPhone(raw) {
  const c = String(raw || '').replace(/[^0-9]/g, '');
  if (!c) return { ok: true, empty: true, intl: null };
  if (c.length !== 11 || c[0] !== '0') return { ok: false, msg: 'El teléfono debe tener 11 dígitos (04XX-XXXXXXX).' };
  const pre = c.slice(0, 4);
  if (!CAT.opMap[pre]) return { ok: false, msg: `Prefijo ${pre} inválido. Use ${Object.keys(CAT.opMap).join(', ')}.` };
  return { ok: true, op: CAT.opMap[pre], national: c, intl: '+58' + c.slice(1) };
}

function ageFrom(ymd) {
  if (!ymd) return null;
  const { ymd: today } = DW.nowVE();
  const t = today.split('-').map(Number), b = ymd.split('-').map(Number);
  let a = t[0] - b[0];
  if (t[1] < b[1] || (t[1] === b[1] && t[2] < b[2])) a--;
  return a;
}

/* ¿el alta quedo completa? (todos los obligatorios validos) */
function ingresoComplete(w) {
  const g = w.ingreso;
  if (!g) return false;
  if (!g.firstName || !g.lastNames || !g.cargoCode || !g.gender || !g.marital) return false;
  if (!g.birthDate || ageFrom(g.birthDate) < 18) return false;
  if (!validAccount(g.account).ok) return false;
  if (g.phone && !validPhone(g.phone).ok) return false;
  if (!g.startDate || startDateError(g.startDate, ingresoWindow())) return false;
  return true;
}

export const ingresoReport = {
  code: 'ingreso',
  title: 'Reportar Ingreso',
  icon: '➕',
  tag: 'Ingreso · wizard',
  step4Label: 'Ingresos',

  summaryColumns: [
    { key: 'cargo', label: 'Cargo' },
    { key: 'edad', label: 'Edad' },
    { key: 'start', label: 'Fecha de ingreso' },
    { key: 'kind', label: 'Acción' },
  ],
  summaryCell(w, key) {
    const g = w.ingreso || {};
    if (key === 'cargo') return g.cargoCode ? `<span class="pill pill-role">${cargoLabel(g.cargoCode)}</span>` : '—';
    if (key === 'edad') {
      const a = ageFrom(g.birthDate);
      return a == null ? '—' : `${a} años`;
    }
    if (key === 'start') return g.startDate ? DW.fmtDate(g.startDate) : '—';
    if (key === 'kind') return '<span class="pill pill-set">A · Alta</span>';
    return '';
  },

  isComplete(w) { return ingresoComplete(w); },

  renderStep4(ctx) {
    $('#wzPanel').innerHTML = '<div class="pnl-loading">Cargando…</div>';
    loadCatalogs().then(() => paintStep4(ctx));
  },

  async submit({ companyCode, responsible, position, workers, source_kind, source_admin_id }) {
    const lines = workers.map(w => {
      const g = w.ingreso || {};
      return {
        id_number: w.ced,
        first_name: g.firstName,
        second_name: g.secondName || '',
        last_names: g.lastNames,
        cargo_code: g.cargoCode,
        birth_date: g.birthDate,
        gender: g.gender,
        marital_status: g.marital,
        account_number: g.account,
        email: g.email || '',
        phone: g.phoneIntl || '',   // se envia en +58 (server revalida)
        address: g.address || '',
        start_date: g.startDate,
      };
    });
    const res = await fetch('/api/reports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'submit_ingreso',
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
  const win = ingresoWindow();
  const panel = $('#wzPanel');
  panel.innerHTML = `
    <h2>Trabajadores que ingresan</h2>
    <p class="hint">Un ingreso es una persona <b>nueva</b>. Agrégala con el botón y completa sus datos. La acción es siempre <b>Alta (A)</b>, el <b>Data ID</b> lo toma la empresa y no se permiten menores de 18 años.</p>
    <div class="window-info"><span class="wi-ico">⏱</span><div>${windowTextIngreso(win)}</div></div>

    <div class="progress-line">
      <span id="igProg">0 de 0 listos para enviar</span>
      <div class="progress-bar"><div id="igProgBar" style="width:0%"></div></div>
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin:14px 0 4px;flex-wrap:wrap">
      <button class="btn btn-primary" id="igAdd">＋ Agregar ingreso</button>
      <span style="font-size:12px;color:var(--muted)" id="igCount">0 ingresos</span>
    </div>

    <table id="igTbl" style="display:none"><thead><tr>
      <th>Trabajador</th><th>Cédula</th><th>Cargo</th><th>Edad</th><th>Fecha ingreso</th><th>Acción</th><th style="width:120px"></th>
    </tr></thead><tbody id="igBody"></tbody></table>
    <div class="empty" id="igEmpty">Aún no has agregado ningún ingreso. Usa “＋ Agregar ingreso”.</div>

    <div class="wiz-foot">
      <button class="btn" id="igBack">← Atrás</button>
      <button class="btn btn-primary" id="igNext" disabled>Revisar y enviar →</button>
    </div>`;

  $('#igAdd').addEventListener('click', () => openIngresoModal(ctx, null));
  $('#igBack').addEventListener('click', () => ctx.setStep(3));
  $('#igNext').addEventListener('click', () => ctx.setStep(5));

  renderRows(ctx);
}

/* Texto de ventana propio (incluye futuro). */
function windowTextIngreso(win) {
  let t = `Hoy es <b>${DW.fmtDate(win.today)}</b>. La fecha de ingreso admite del <b>${DW.fmtDate(win.minDate)} al ${DW.fmtDate(win.maxDate)}</b>`;
  if (win.futureWindowDays > 0) t += ` (${win.futureWindowDays} días a futuro)`;
  t += '.';
  if (!win.pastCutoff && win.oldestDay) {
    t += ` El día más antiguo (<b>${DW.fmtDate(win.oldestDay)}</b>) solo se admite <b>hasta las ${DW.fmtClock(win.cutoffTime)} (hora Venezuela)</b>.`;
  } else if (win.pastCutoff && win.oldestDay) {
    t += ` (Ya pasó la hora tope de hoy, por eso el ${DW.fmtDate(win.oldestDay)} ya no está disponible.)`;
  }
  return t;
}

function updateNext(ctx) {
  const total = ctx.workers.length;
  const done = ctx.workers.filter(ingresoComplete).length;
  const btn = $('#igNext');
  if (btn) btn.disabled = !(total > 0 && done === total);
  const prog = $('#igProg');
  if (prog) prog.textContent = `${done} de ${total} listos para enviar`;
  const bar = $('#igProgBar');
  if (bar) bar.style.width = total ? (done / total * 100) + '%' : '0%';
  const cnt = $('#igCount');
  if (cnt) cnt.textContent = total + (total === 1 ? ' ingreso' : ' ingresos');
}

function renderRows(ctx) {
  const tb = $('#igBody');
  if (!tb) return;
  $('#igEmpty').style.display = ctx.workers.length ? 'none' : 'block';
  $('#igTbl').style.display = ctx.workers.length ? 'table' : 'none';

  tb.innerHTML = ctx.workers.map(w => {
    const g = w.ingreso || {};
    const ok = ingresoComplete(w);
    const age = ageFrom(g.birthDate);
    const cedTxt = w.ced ? `${g.cedKind || 'V'}-${w.ced}` : '—';
    const ageCell = age == null ? '<span class="pill pill-pend">falta</span>'
      : (age < 18 ? `<span class="pill pill-pend">${age} (menor)</span>` : `<span style="color:#15803d;font-weight:600">${age} años</span>`);
    const startCell = g.startDate
      ? (startDateError(g.startDate, ingresoWindow()) ? '<span class="pill pill-pend">revisar</span>' : `<span class="date-badge">${DW.fmtDate(g.startDate)}</span>`)
      : '<span class="pill pill-pend">pendiente</span>';
    return `<tr class="${ok ? 'done-row' : ''}">
      <td><b>${w.name || '—'}</b></td>
      <td class="ced">${cedTxt}</td>
      <td>${g.cargoCode ? `<span class="pill pill-role">${cargoLabel(g.cargoCode)}</span>` : '—'}</td>
      <td>${ageCell}</td>
      <td>${startCell}</td>
      <td><span class="pill pill-set">A · Alta</span></td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm" data-cfg="${w.id}">${ok ? '✏️ Editar' : '＋ Completar'}</button>
        <button class="x-btn" data-rm="${w.id}" title="Quitar">✕</button>
      </td>
    </tr>`;
  }).join('');

  tb.querySelectorAll('[data-cfg]').forEach(b => b.addEventListener('click', () => openIngresoModal(ctx, +b.dataset.cfg)));
  tb.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
    const w = ctx.getWorker(+b.dataset.rm);
    if (w && !confirm(`¿Quitar a ${w.name || 'este ingreso'} del reporte?`)) return;
    ctx.removeWorker(+b.dataset.rm);
    renderRows(ctx); updateNext(ctx);
  }));

  updateNext(ctx);
}

/* ---------- MODAL: alta / edicion de un ingreso ---------- */
function openIngresoModal(ctx, id) {
  const win = ingresoWindow();
  const existing = id ? ctx.getWorker(id) : null;
  // Si el worker llego del paso 3 (cedula + nombre) y aun no tiene datos de
  // ingreso, precargamos los nombres dividiendo el nombre escrito alli:
  // ultima palabra = apellidos, el resto = primer/segundo nombre.
  let g = (existing && existing.ingreso) ? existing.ingreso : {};
  if (existing && !existing.ingreso && existing.name) {
    const parts = String(existing.name).trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 3) g = { firstName: parts[0], secondName: parts[1], lastNames: parts.slice(2).join(' ') };
    else if (parts.length === 2) g = { firstName: parts[0], secondName: '', lastNames: parts[1] };
    else if (parts.length === 1) g = { firstName: parts[0], secondName: '', lastNames: '' };
  }
  const companyLabel = ctx.companyCode || '';

  const GEN = [['M', 'M – Masculino'], ['F', 'F – Femenino']];
  const CIV = [['S', 'S – Soltero/a'], ['C', 'C – Casado/a'], ['D', 'D – Divorciado/a'], ['V', 'V – Viudo/a']];
  const opt = (arr, cur) => `<option value="" ${!cur ? 'selected' : ''} disabled>— Seleccionar —</option>` +
    arr.map(o => `<option value="${o[0]}" ${cur === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('');
  const cargoOpts = `<option value="" ${!g.cargoCode ? 'selected' : ''} disabled>— Seleccionar —</option>` +
    (CAT.cargos || []).map(c => `<option value="${c.code}" ${g.cargoCode === c.code ? 'selected' : ''}>${c.label}</option>`).join('');
  const { ymd: today } = DW.nowVE();

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal modal-wide">
      <h3>${id ? 'Editar ingreso' : 'Nuevo ingreso (Alta)'}</h3>
      <p class="who">Acción <span class="pill pill-set">A · Alta</span> · Data ID <b>${companyLabel}</b> (automático, de la empresa)</p>

      <div class="ig-band">
        <div class="ig-band-t">📅 Fecha inicial de empleo <span style="color:var(--danger)">*</span></div>
        <input type="date" id="ig_start" min="${win.minDate || ''}" max="${win.maxDate}" value="${g.startDate || ''}">
        <div class="date-err" id="e_start" style="color:var(--danger);font-size:12px;min-height:15px;margin-top:5px"></div>
        <div class="hint" style="margin-top:4px">Dato principal del reporte. Admite del ${DW.fmtDate(win.minDate)} al ${DW.fmtDate(win.maxDate)}.</div>
      </div>

      <div class="ig-sec">Identidad</div>
      <div class="grid2">
        <div><label class="flabel">Primer nombre <span style="color:var(--danger)">*</span></label><input id="ig_first" value="${esc(g.firstName)}" placeholder="JUAN"><div class="ferr" id="e_first"></div></div>
        <div><label class="flabel">Segundo nombre <span class="opt">(opcional)</span></label><input id="ig_second" value="${esc(g.secondName)}" placeholder="CARLOS"><div class="ferr"></div></div>
      </div>
      <div style="margin-top:12px"><label class="flabel">Apellidos <span style="color:var(--danger)">*</span></label><input id="ig_last" value="${esc(g.lastNames)}" placeholder="PÉREZ GARCÍA"><div class="ferr" id="e_last"></div></div>
      <div class="grid2" style="margin-top:12px">
        <div><label class="flabel">Cédula (Nro Personal) <span style="color:var(--danger)">*</span></label><input id="ig_ced" value="${existing ? existing.ced : ''}" placeholder="12345678" inputmode="numeric"><div class="ig-line" id="e_ced"></div></div>
        <div><label class="flabel">Cargo <span style="color:var(--danger)">*</span></label><select id="ig_cargo">${cargoOpts}</select><div class="ferr" id="e_cargo"></div></div>
      </div>
      <div class="grid2" style="margin-top:12px">
        <div><label class="flabel">Fecha de nacimiento <span style="color:var(--danger)">*</span></label><input type="date" id="ig_birth" max="${today}" value="${g.birthDate || ''}"><div class="ferr" id="e_birth"></div></div>
        <div><label class="flabel">Edad <span class="opt">(calculada)</span></label><div class="ig-readonly" id="ig_age">—</div></div>
      </div>

      <div class="ig-sec">Datos personales y bancarios</div>
      <div class="grid2">
        <div><label class="flabel">Género <span style="color:var(--danger)">*</span></label><select id="ig_gender">${opt(GEN, g.gender)}</select><div class="ferr" id="e_gender"></div></div>
        <div><label class="flabel">Estado civil <span style="color:var(--danger)">*</span></label><select id="ig_marital">${opt(CIV, g.marital)}</select><div class="ferr" id="e_marital"></div></div>
      </div>
      <div style="margin-top:12px"><label class="flabel">Nro cuenta bancaria <span style="color:var(--danger)">*</span> <span class="opt">(20 dígitos)</span></label>
        <input id="ig_account" value="${esc(g.account)}" placeholder="0134 0123 45 0001234567" inputmode="numeric"><div class="ig-line" id="ig_bankline"></div><div class="ferr" id="e_account"></div></div>

      <div class="ig-sec">Contacto</div>
      <div class="grid2">
        <div><label class="flabel">Correo <span class="opt">(opcional)</span></label><input id="ig_email" value="${esc(g.email)}" placeholder="nombre@correo.com"><div class="ferr" id="e_email"></div></div>
        <div><label class="flabel">Teléfono móvil <span class="opt">(opcional)</span></label><input id="ig_phone" value="${esc(g.phone)}" placeholder="0414-1234567" inputmode="numeric"><div class="ig-line" id="ig_phoneline"></div><div class="ferr" id="e_phone"></div></div>
      </div>
      <div style="margin-top:12px"><label class="flabel">Dirección <span class="opt">(opcional)</span></label><input id="ig_address" value="${esc(g.address)}" placeholder="Calle, sector, ciudad"><div class="ferr"></div></div>

      <div class="wiz-foot" style="margin-top:18px">
        <button class="btn" id="ig_cancel">Cancelar</button>
        <button class="btn btn-primary" id="ig_save" disabled>${id ? 'Guardar cambios' : 'Agregar al reporte'}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const q = s => ov.querySelector(s);
  const saveB = q('#ig_save');

  q('#ig_ced').addEventListener('input', function () { this.value = this.value.replace(/[^0-9]/g, ''); showCed(); check(); });
  q('#ig_account').addEventListener('input', function () { this.value = this.value.replace(/[^0-9 \-]/g, ''); showBank(); check(); });
  q('#ig_phone').addEventListener('input', function () { this.value = this.value.replace(/[^0-9 \-]/g, ''); showPhone(); check(); });
  q('#ig_birth').addEventListener('change', () => { showAge(); check(); });
  q('#ig_birth').addEventListener('input', () => { showAge(); check(); });
  ['#ig_start', '#ig_first', '#ig_second', '#ig_last', '#ig_cargo', '#ig_gender', '#ig_marital', '#ig_email', '#ig_address']
    .forEach(sel => { const el = q(sel); el.addEventListener('input', check); el.addEventListener('change', check); });

  function showAge() {
    const v = q('#ig_birth').value, b = q('#ig_age');
    if (!v) { b.textContent = '—'; b.style.color = ''; return; }
    const a = ageFrom(v);
    if (a < 18) { b.textContent = `⚠ ${a} años (menor)`; b.style.color = 'var(--danger)'; }
    else { b.textContent = `✓ ${a} años`; b.style.color = '#15803d'; }
  }
  function showCed() {
    const el = q('#ig_ced'), line = q('#e_ced');
    const v = DW.validateCedula(el.value);
    if (!el.value) { line.textContent = ''; line.className = 'ig-line'; return; }
    if (v.ok) { line.className = 'ig-line ok'; line.textContent = `✓ ${v.kind === 'E' ? 'Extranjero' : 'Venezolano'} — ${v.kind}-${v.ced}`; }
    else { line.className = 'ig-line warn'; line.textContent = 'Cédula no válida (6 a 8 dígitos).'; }
  }
  function showBank() {
    const el = q('#ig_account'), line = q('#ig_bankline');
    const v = validAccount(el.value);
    if (v.empty) { line.textContent = ''; line.className = 'ig-line'; return; }
    if (v.ok) { line.className = 'ig-line ok'; line.textContent = `🏦 ${v.bankName} (${v.bankCode})`; }
    else { line.className = 'ig-line warn'; line.textContent = v.msg || ''; }
  }
  function showPhone() {
    const el = q('#ig_phone'), line = q('#ig_phoneline');
    const v = validPhone(el.value);
    if (v.empty) { line.textContent = ''; line.className = 'ig-line'; return; }
    if (v.ok) { line.className = 'ig-line ok'; line.textContent = `📱 ${v.op} → se guarda ${v.intl}`; }
    else { line.className = 'ig-line warn'; line.textContent = v.msg || ''; }
  }

  function check() {
    const e = {};
    const first = q('#ig_first').value.trim();
    const last = q('#ig_last').value.trim();
    const cedV = DW.validateCedula(q('#ig_ced').value);
    const cargo = q('#ig_cargo').value;
    const gender = q('#ig_gender').value;
    const marital = q('#ig_marital').value;
    const accV = validAccount(q('#ig_account').value);
    const birth = q('#ig_birth').value;
    const start = q('#ig_start').value;
    const email = q('#ig_email').value.trim();
    const phoneV = validPhone(q('#ig_phone').value);

    if (!first) e.first = 'Requerido.';
    if (!last) e.last = 'Requerido.';
    if (!cedV.ok) e.ced = q('#ig_ced').value ? 'Cédula no válida.' : 'Requerido.';
    else {
      // cedula repetida en el reporte (excluyendo el que edito)
      const dup = ctx.workers.some(w => w.ced === cedV.ced && w.id !== (existing ? existing.id : -1));
      if (dup) e.ced = 'Ya agregaste esa cédula.';
    }
    if (!cargo) e.cargo = 'Selecciona un cargo.';
    if (!gender) e.gender = 'Requerido.';
    if (!marital) e.marital = 'Requerido.';
    if (!accV.ok) e.account = accV.empty ? 'Requerido.' : (accV.msg || 'Cuenta no válida.');
    if (!birth) e.birth = 'Requerido.';
    else if (ageFrom(birth) < 18) e.birth = 'No se permiten menores de 18 años.';
    const se = startDateError(start, win);
    if (se) e.start = se;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = 'Formato inválido.';
    if (!phoneV.ok) e.phone = phoneV.msg || 'Teléfono no válido.';

    // pintar errores (los campos con linea propia -ced/account/phone- no duplican)
    const map = { first: 'e_first', last: 'e_last', cargo: 'e_cargo', gender: 'e_gender', marital: 'e_marital', birth: 'e_birth', start: 'e_start', email: 'e_email' };
    Object.keys(map).forEach(k => { const el = q('#' + map[k]); if (el) el.textContent = e[k] || ''; });
    // start usa color danger ya en su div
    const startErr = q('#e_start'); if (startErr) startErr.textContent = e.start || '';

    saveB.disabled = Object.keys(e).length > 0;
    return e;
  }

  q('#ig_cancel').addEventListener('click', () => ov.remove());
  saveB.addEventListener('click', () => {
    if (Object.keys(check()).length) return;
    const cedV = DW.validateCedula(q('#ig_ced').value);
    const accV = validAccount(q('#ig_account').value);
    const phoneV = validPhone(q('#ig_phone').value);
    const first = q('#ig_first').value.trim().toUpperCase();
    const second = q('#ig_second').value.trim().toUpperCase();
    const last = q('#ig_last').value.trim().toUpperCase();
    const fullName = [first, second, last].filter(Boolean).join(' ');

    const ingreso = {
      firstName: first, secondName: second || '', lastNames: last,
      cedKind: cedV.kind,
      cargoCode: q('#ig_cargo').value,
      birthDate: q('#ig_birth').value,
      gender: q('#ig_gender').value,
      marital: q('#ig_marital').value,
      account: accV.account, bankCode: accV.bankCode, bankName: accV.bankName,
      email: q('#ig_email').value.trim(),
      phone: q('#ig_phone').value.replace(/[^0-9]/g, ''),   // nacional, para mostrar/editar
      phoneIntl: phoneV.intl || '',                          // +58, para enviar
      address: q('#ig_address').value.trim(),
      startDate: q('#ig_start').value,
    };

    if (existing) {
      existing.ced = cedV.ced;
      existing.name = fullName;
      existing.ingreso = ingreso;
    } else {
      // crear un worker nuevo en ctx.workers (forma estandar + .ingreso)
      ctx.addWorker({ ced: cedV.ced, name: fullName, ingreso });
    }
    ov.remove();
    renderRows(ctx);
  });

  showAge(); showCed(); showBank(); showPhone(); check();
  setTimeout(() => q('#ig_start').focus(), 40);
}

function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
