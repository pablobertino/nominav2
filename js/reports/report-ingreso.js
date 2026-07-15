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
import { getSession } from '../core/session.js';
import * as DW from './shared/date-window.js';

// Catalogos del wizard (cargos + bancos + operadoras + ventana). Una vez.
let CAT = null;

// Lista de ingresos del reporte en curso. La guardamos a nivel de modulo
// para que el boton "Ver detalle" del Resumen (que pinta wizard-core, sin
// hook a nuestras celdas) pueda localizar a la persona por su cedula y
// abrir su ficha en modo solo-lectura. Se refresca en cada render del paso 4.
let LAST_WORKERS = [];

/* ===== v5.77: AVISO TEMPRANO DE NO REEMPLEABLE (en el modal del alta) =====
   Hasta v5.76 el bloqueo solo saltaba al FINAL: la tienda llenaba la ficha
   entera, adjuntaba recaudos, llegaba al Resumen, tocaba Enviar... y recien
   ahi el servidor rechazaba. El control era correcto pero la experiencia no.

   Ahora, apenas la cedula es valida (6-8 digitos), se consulta
   /api/no-rehire (action 'check') y si la persona esta en la lista:
   - la linea de la cedula lo dice en rojo (sin motivo ni observaciones:
     decision de Pablo 14/07, ese detalle no es de nivel tienda), y
   - el boton "Agregar al reporte" queda deshabilitado.

   Esto es CORTESIA, no el control: si la red falla o alguien salta el
   front, el gate del servidor (submitIngreso, v5.74) rechaza igual.
   Por eso un error aca solo se anota en consola y no bloquea nada.
   Cache por cedula para no repetir consultas mientras escriben. */
const NR_CACHE = new Map();   // ced -> { blocked, full_name } (respuesta del check)
let NR_TIMER = null;
function nrLookup(ced, refresh) {
  if (!ced || NR_CACHE.has(ced)) return;   // ya se sabe: check() lo lee sincrono
  clearTimeout(NR_TIMER);
  NR_TIMER = setTimeout(async () => {
    try {
      const user = getSession();
      if (!user) return;
      const r = await fetch('/api/no-rehire', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'check', id_number: ced,
          user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null },
        }),
      }).then(x => x.json());
      if (r && r.ok) { NR_CACHE.set(ced, { blocked: !!r.blocked, full_name: r.full_name || null }); refresh(); }
    } catch (e) {
      // Cortesia fallida: el servidor bloquea igual en el envio.
      console.warn('Chequeo de no reempleable fallo (el servidor valida igual):', e);
    }
  }, 350);
}
const nrIsBlocked = ced => { const e = NR_CACHE.get(ced); return !!(e && e.blocked); };

/* ===== v5.78: ENCABEZADO FIJO + CARTEL DE NO REEMPLEABLE (mockup B) =====
   Mockup aprobado: _PRUEBAS\norehire_banner_mockup.html (variante B).
   El modal del alta pasa a tener el encabezado ("Nuevo ingreso (Alta)" +
   Accion/Data ID) SIEMPRE fijo arriba; el formulario scrollea por debajo.
   Cuando la cedula esta en la lista de no reempleables, el cartel rojo se
   inyecta DENTRO de ese bloque fijo (nombre oficial de la lista + cedula +
   mensaje) y el resto del formulario se atenua y bloquea, salvo la cedula,
   que sigue editable para corregirla. Si la corrigen, todo revive.
   OJO: sin escapes octales en este CSS (leccion de v5.13). */
let IG_STYLED = false;
function ensureIngresoCss() {
  if (IG_STYLED) return;
  IG_STYLED = true;
  const css = document.createElement('style');
  css.textContent = `
  .ig-modal{display:flex;flex-direction:column;padding:0 !important;overflow:hidden !important;max-height:88vh}
  .ig-mhead{flex:none;background:#fff;position:relative;z-index:5;box-shadow:0 4px 12px rgba(15,23,42,.07)}
  .ig-mhead h3{margin:0;padding:20px 26px 2px}
  .ig-mhead .who{margin:0;padding:0 26px 12px}
  .ig-mbody{flex:1;min-height:0;overflow:auto;padding:16px 26px 24px}
  .ig-nrbanner{background:#fef2f2;border-top:1px solid #fecaca;border-bottom:2px solid #fca5a5;
    padding:12px 26px;display:flex;gap:13px;align-items:center}
  .ig-nrbanner .ico{flex:none;width:42px;height:42px;border-radius:50%;background:#fee2e2;
    border:1.5px solid #fca5a5;display:flex;align-items:center;justify-content:center;font-size:20px}
  .ig-nrbanner .tt{font-size:13px;font-weight:800;color:#991b1b;letter-spacing:.01em}
  .ig-nrbanner .nm{font-size:15px;font-weight:800;color:#7f1d1d;margin-top:1px}
  .ig-nrbanner .nm .ced{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:13px;
    background:#fee2e2;border:1px solid #fecaca;border-radius:7px;padding:1px 8px;margin-left:8px;
    color:#991b1b;vertical-align:1px}
  .ig-nrbanner .ms{font-size:12px;color:#b91c1c;margin-top:3px;line-height:1.5}
  .ig-dimmed{opacity:.45;pointer-events:none;user-select:none}`;
  document.head.appendChild(css);
}

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
    docs: res.docs || [],
    docLimits: res.doc_limits || { max_file_mb: 2, max_total_mb: 20, allowed_ext: ['jpg','jpeg','png','pdf','doc','docx'] },
    win: res.window_config || { cutoff_time: '14:00', margin_days: 2, future_days: 7 },
    bankMap: Object.fromEntries((res.bancos || []).map(b => [b.code, b.name])),
    opMap: Object.fromEntries((res.operadoras || []).map(o => [o.code, o.name])),
  } : { cargos: [], bancos: [], operadoras: [], docs: [], docLimits: { max_file_mb: 2, max_total_mb: 20, allowed_ext: ['jpg','jpeg','png','pdf','doc','docx'] }, win: { cutoff_time: '14:00', margin_days: 2, future_days: 7 }, bankMap: {}, opMap: {} };
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
  // Ingreso captura TODO en el paso 4 (la persona es nueva, no sale del
  // roster), asi que el wizard omite el paso 3 (Trabajadores).
  skipWorkerStep: true,

  summaryColumns: [
    { key: 'cargo', label: 'Cargo' },
    { key: 'edad', label: 'Edad' },
    { key: 'start', label: 'Fecha de ingreso' },
    { key: 'docs', label: 'Recaudos' },
    { key: 'kind', label: 'Acción' },
    { key: 'detalle', label: '' },
  ],
  summaryCell(w, key) {
    const g = w.ingreso || {};
    if (key === 'cargo') return g.cargoCode ? `<span class="pill pill-role">${cargoLabel(g.cargoCode)}</span>` : '—';
    if (key === 'edad') {
      const a = ageFrom(g.birthDate);
      return a == null ? '—' : `${a} años`;
    }
    if (key === 'start') return g.startDate ? DW.fmtDate(g.startDate) : '—';
    if (key === 'docs') {
      const total = (CAT && CAT.docs) ? CAT.docs.length : 0;
      if (!total) return '<span style="color:var(--muted)">—</span>';
      const n = (g.docs || []).filter(d => d.file_b64).length;
      if (n === 0) return `<span class="pill pill-pend">0/${total}</span>`;
      if (n === total) return `<span class="pill pill-set">📎 ${n}/${total}</span>`;
      return `<span class="pill pill-warn2">${n}/${total}</span>`;
    }
    if (key === 'kind') return '<span class="pill pill-set">A · Alta</span>';
    if (key === 'detalle') {
      // Boton que abre la ficha completa en solo-lectura. wizard-core
      // engancha el listener por delegacion (data-detail-ced), sin onclick
      // inline (la CSP del sitio bloquea los handlers inline).
      return `<button type="button" class="btn btn-sm" data-detail-ced="${w.ced}">👁 Ver detalle</button>`;
    }
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
        // Se envia en NACIONAL (04XX-XXXXXXX). El server valida con su regla
        // nacional (11 digitos, empieza en 0) y normaliza a +58 al guardar.
        // Enviar phoneIntl (+58) rompia la cuenta de digitos del server.
        phone: g.phone || '',
        address: g.address || '',
        start_date: g.startDate,
        // Recaudos adjuntos de esta persona. Cada uno: required_doc_id +
        // archivo (nombre/base64/tipo). Los que el server no reciba con
        // archivo quedan 'pendiente'. El archivo NO se persiste: viaja a
        // osTicket como ticket DOC.
        docs: (g.docs || []).map(d => ({
          required_doc_id: d.required_doc_id,
          file_name: d.file_name || null,
          file_b64: d.file_b64 || null,
          file_type: d.file_type || null,
        })),
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
      <th>Trabajador</th><th>Cédula</th><th>Cargo</th><th>Edad</th><th>Fecha ingreso</th><th>Recaudos</th><th>Acción</th><th style="width:120px"></th>
    </tr></thead><tbody id="igBody"></tbody></table>
    <div class="empty" id="igEmpty">Aún no has agregado ningún ingreso. Usa “＋ Agregar ingreso”.</div>

    <div class="wiz-foot">
      <button class="btn" id="igBack">← Atrás</button>
      <button class="btn btn-primary" id="igNext" disabled>Revisar y enviar →</button>
    </div>`;

  $('#igAdd').addEventListener('click', () => openIngresoModal(ctx, null));
  $('#igBack').addEventListener('click', () => ctx.setStep(ctx.stepBefore4 || 2));
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
  // Mantener la lista del reporte accesible para el boton "Ver detalle" del
  // Resumen (que pinta wizard-core en otra fase).
  LAST_WORKERS = ctx.workers || [];
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
    const totalDocs = (CAT && CAT.docs) ? CAT.docs.length : 0;
    const nDocs = (g.docs || []).filter(d => d.file_b64).length;
    const docsCell = !totalDocs ? '<span style="color:var(--muted)">—</span>'
      : (nDocs === 0 ? `<span class="pill pill-pend">0/${totalDocs}</span>`
        : (nDocs === totalDocs ? `<span class="pill pill-set">📎 ${nDocs}/${totalDocs}</span>`
          : `<span class="pill pill-warn2">${nDocs}/${totalDocs}</span>`));
    return `<tr class="${ok ? 'done-row' : ''}">
      <td><b>${w.name || '—'}</b></td>
      <td class="ced">${cedTxt}</td>
      <td>${g.cargoCode ? `<span class="pill pill-role">${cargoLabel(g.cargoCode)}</span>` : '—'}</td>
      <td>${ageCell}</td>
      <td>${startCell}</td>
      <td>${docsCell}</td>
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
  ensureIngresoCss();   // v5.78: encabezado fijo + cartel de no reempleable
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
    <div class="modal modal-wide ig-modal">
      <div class="ig-mhead">
        <h3>${id ? 'Editar ingreso' : 'Nuevo ingreso (Alta)'}</h3>
        <p class="who">Acción <span class="pill pill-set">A · Alta</span> · Data ID <b>${companyLabel}</b> (automático, de la empresa)</p>
        <div id="ig_nrslot"></div>
      </div>
      <div class="ig-mbody">

      <div class="ig-band" data-nrdim>
        <div class="ig-band-t">📅 Fecha inicial de empleo <span style="color:var(--danger)">*</span></div>
        <input type="date" id="ig_start" min="${win.minDate || ''}" max="${win.maxDate}" value="${g.startDate || ''}">
        <div class="date-err" id="e_start" style="color:var(--danger);font-size:12px;min-height:15px;margin-top:5px"></div>
        <div class="hint" style="margin-top:4px">Dato principal del reporte. Admite del ${DW.fmtDate(win.minDate)} al ${DW.fmtDate(win.maxDate)}.</div>
      </div>

      <div class="ig-sec" data-nrdim>Identidad</div>
      <div class="grid2" data-nrdim>
        <div><label class="flabel">Primer nombre <span style="color:var(--danger)">*</span></label><input id="ig_first" value="${esc(g.firstName)}" placeholder="JUAN"><div class="ferr" id="e_first"></div></div>
        <div><label class="flabel">Segundo nombre <span class="opt">(opcional)</span></label><input id="ig_second" value="${esc(g.secondName)}" placeholder="CARLOS"><div class="ferr"></div></div>
      </div>
      <div data-nrdim style="margin-top:12px"><label class="flabel">Apellidos <span style="color:var(--danger)">*</span></label><input id="ig_last" value="${esc(g.lastNames)}" placeholder="PÉREZ GARCÍA"><div class="ferr" id="e_last"></div></div>
      <div class="grid2" style="margin-top:12px">
        <div><label class="flabel">Cédula (Nro Personal) <span style="color:var(--danger)">*</span></label><input id="ig_ced" value="${existing ? existing.ced : ''}" placeholder="12345678" inputmode="numeric"><div class="ig-line" id="e_ced"></div></div>
        <div data-nrdim><label class="flabel">Cargo <span style="color:var(--danger)">*</span></label><select id="ig_cargo">${cargoOpts}</select><div class="ferr" id="e_cargo"></div></div>
      </div>
      <div class="grid2" data-nrdim style="margin-top:12px">
        <div><label class="flabel">Fecha de nacimiento <span style="color:var(--danger)">*</span></label><input type="date" id="ig_birth" max="${today}" value="${g.birthDate || ''}"><div class="ferr" id="e_birth"></div></div>
        <div><label class="flabel">Edad <span class="opt">(calculada)</span></label><div class="ig-readonly" id="ig_age">—</div></div>
      </div>

      <div class="ig-sec" data-nrdim>Datos personales y bancarios</div>
      <div class="grid2" data-nrdim>
        <div><label class="flabel">Género <span style="color:var(--danger)">*</span></label><select id="ig_gender">${opt(GEN, g.gender)}</select><div class="ferr" id="e_gender"></div></div>
        <div><label class="flabel">Estado civil <span style="color:var(--danger)">*</span></label><select id="ig_marital">${opt(CIV, g.marital)}</select><div class="ferr" id="e_marital"></div></div>
      </div>
      <div data-nrdim style="margin-top:12px"><label class="flabel">Nro cuenta bancaria <span style="color:var(--danger)">*</span> <span class="opt">(20 dígitos)</span></label>
        <input id="ig_account" value="${esc(g.account)}" placeholder="0134 0123 45 0001234567" inputmode="numeric"><div class="ig-line" id="ig_bankline"></div><div class="ferr" id="e_account"></div></div>

      <div class="ig-sec" data-nrdim>Contacto</div>
      <div class="grid2" data-nrdim>
        <div><label class="flabel">Correo <span class="opt">(opcional)</span></label><input id="ig_email" value="${esc(g.email)}" placeholder="nombre@correo.com"><div class="ferr" id="e_email"></div></div>
        <div><label class="flabel">Teléfono móvil <span class="opt">(opcional)</span></label><input id="ig_phone" value="${esc(g.phone)}" placeholder="0414-1234567" inputmode="numeric"><div class="ig-line" id="ig_phoneline"></div><div class="ferr" id="e_phone"></div></div>
      </div>
      <div data-nrdim style="margin-top:12px"><label class="flabel">Dirección <span class="opt">(opcional)</span></label><input id="ig_address" value="${esc(g.address)}" placeholder="Calle, sector, ciudad"><div class="ferr"></div></div>

      ${(CAT.docs && CAT.docs.length) ? `
      <div class="ig-sec" data-nrdim>Recaudos del trabajador <span class="opt">(opcionales)</span></div>
      <p class="hint" data-nrdim style="margin:-4px 0 8px">Adjunta lo que tengas; los que falten quedan como <b>pendientes</b> en el ticket. Máx. ${CAT.docLimits.max_file_mb} MB por archivo (${CAT.docLimits.allowed_ext.join(', ')}).</p>
      <div id="ig_docs" data-nrdim></div>` : ''}

      <div class="wiz-foot" style="margin-top:18px">
        <button class="btn" id="ig_cancel">Cancelar</button>
        <button class="btn btn-primary" id="ig_save" disabled>${id ? 'Guardar cambios' : 'Agregar al reporte'}</button>
      </div>
      </div>
      <input type="file" id="ig_file" hidden accept=".jpg,.jpeg,.png,.pdf,.doc,.docx,image/*">
    </div>`;
  document.body.appendChild(ov);

  const q = s => ov.querySelector(s);
  const saveB = q('#ig_save');

  /* ---- Recaudos (adjuntos por trabajador) ----
     Estado local: docState[required_doc_id] = { file_name, file_b64, file_type }.
     Se precarga de g.docs al editar. El archivo se lee a base64 en el momento
     de elegirlo (no se sube a Storage): viaja en el submit hacia osTicket. */
  const CATDOCS = CAT.docs || [];
  const LIM = CAT.docLimits || { max_file_mb: 2, allowed_ext: ['jpg','jpeg','png','pdf','doc','docx'] };
  const docState = {};
  (g.docs || []).forEach(d => {
    if (d && d.required_doc_id) docState[d.required_doc_id] = {
      file_name: d.file_name || null, file_b64: d.file_b64 || null, file_type: d.file_type || null,
    };
  });

  function renderDocs() {
    const box = q('#ig_docs');
    if (!box) return;
    box.innerHTML = CATDOCS.map(d => {
      const st = docState[d.id];
      const has = st && st.file_b64;
      const right = has
        ? `<span class="file-pill">📎 ${esc(st.file_name)} <span class="x" data-clr="${d.id}" title="Quitar">✕</span></span>
           <button type="button" class="btn btn-sm" data-pick="${d.id}">Cambiar</button>`
        : `<button type="button" class="btn btn-sm btn-primary" data-pick="${d.id}">📎 Adjuntar</button>`;
      return `<div class="docrow">
        <span class="docrow-name">📄 ${esc(d.name)}</span>
        <span class="docrow-act">${right}</span>
      </div>`;
    }).join('') +
      `<div class="docrow-foot" id="ig_docs_foot"></div>`;
    updateDocsFoot();
    box.querySelectorAll('[data-pick]').forEach(b =>
      b.addEventListener('click', () => pickFor(+b.dataset.pick)));
    box.querySelectorAll('[data-clr]').forEach(b =>
      b.addEventListener('click', () => { delete docState[+b.dataset.clr]; renderDocs(); }));
  }
  function updateDocsFoot() {
    const foot = q('#ig_docs_foot');
    if (!foot) return;
    const n = CATDOCS.filter(d => docState[d.id] && docState[d.id].file_b64).length;
    foot.innerHTML = `<span style="font-size:12px;color:var(--muted)">ℹ ${n} de ${CATDOCS.length} recaudos adjuntos.</span>`;
  }
  function pickFor(docId) {
    const inp = q('#ig_file');
    inp.value = '';
    inp.dataset.docId = String(docId);
    inp.click();
  }

  if (CATDOCS.length) {
    q('#ig_file').addEventListener('change', function () {
      const f = this.files && this.files[0];
      const docId = parseInt(this.dataset.docId, 10);
      if (!f || !docId) return;
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (LIM.allowed_ext.length && !LIM.allowed_ext.includes(ext)) {
        alert(`Tipo no permitido (.${ext}). Use: ${LIM.allowed_ext.join(', ')}.`); return;
      }
      const maxBytes = (LIM.max_file_mb || 2) * 1024 * 1024;
      if (f.size > maxBytes) {
        alert(`El archivo pesa ${(f.size/1048576).toFixed(1)} MB y el máximo es ${LIM.max_file_mb} MB.`); return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        docState[docId] = {
          file_name: f.name,
          file_b64: String(reader.result).split(',')[1] || null,
          file_type: f.type || 'application/octet-stream',
        };
        renderDocs();
      };
      reader.readAsDataURL(f);
    });
    renderDocs();
  }

  q('#ig_ced').addEventListener('input', function () {
    this.value = this.value.replace(/[^0-9]/g, '');
    showCed(); check(); applyNrState();
    // v5.77: apenas la cedula es valida, se consulta si es no reempleable.
    const v = DW.validateCedula(this.value);
    if (v.ok) nrLookup(v.ced, () => { if (ov.isConnected) { showCed(); check(); applyNrState(); } });
  });
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
    if (!v.ok) { line.className = 'ig-line warn'; line.textContent = 'Cédula no válida (6 a 8 dígitos).'; return; }
    // v5.77: la persona esta en la lista de no reempleables -> se dice ACA,
    // antes de que llenen la ficha. Sin motivo: solo Capital Humano lo maneja.
    if (nrIsBlocked(v.ced)) {
      line.className = 'ig-line warn';
      // v5.78: el mensaje completo vive en el cartel del encabezado; aca
      // queda el recordatorio y la salida (corregir el numero).
      line.textContent = '🚫 En la lista de no reempleables. Corrígela si te equivocaste de número.';
      return;
    }
    line.className = 'ig-line ok'; line.textContent = `✓ ${v.kind === 'E' ? 'Extranjero' : 'Venezolano'} — ${v.kind}-${v.ced}`;
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
      // cedula que YA esta en la lista de la tienda: no es un ingreso
      // (esa persona ya trabaja ahi). Se bloquea para evitar altas duplicadas.
      else if ((ctx.roster || []).some(r => r.id_number === cedV.ced)) {
        e.ced = 'Esa cédula ya está en la lista de la tienda (no es un ingreso nuevo).';
      }
      // v5.77: no reempleable -> no se puede agregar al reporte. El texto
      // visible lo pinta showCed() en la linea de la cedula; aca solo se
      // deshabilita el boton.
      else if (nrIsBlocked(cedV.ced)) {
        e.ced = 'No reempleable: no se puede ingresar.';
      }
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

  /* v5.78: cartel + formulario atenuado (mockup B). Se inyecta o se quita
     del slot del encabezado fijo segun el resultado del check; todo lo
     marcado con data-nrdim se atenua y bloquea (la cedula NO lo lleva:
     sigue editable para corregirla, y Cancelar tampoco). El nombre sale de
     la LISTA del sistema, no de lo que tipeo la tienda: es la identidad
     real de esa cedula. */
  const escT = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function applyNrState() {
    const slot = q('#ig_nrslot');
    if (!slot) return;
    const v = DW.validateCedula(q('#ig_ced').value);
    const info = v.ok ? NR_CACHE.get(v.ced) : null;
    const blocked = !!(info && info.blocked);
    slot.innerHTML = !blocked ? '' : `
      <div class="ig-nrbanner">
        <div class="ico">🚫</div>
        <div>
          <div class="tt">NO REEMPLEABLE — NO SE PUEDE INGRESAR</div>
          <div class="nm">${escT(info.full_name || 'Persona en la lista del sistema')} <span class="ced">${v.kind}-${v.ced}</span></div>
          <div class="ms">Esta persona no es reempleable en el grupo. Para más información, contacta a Capital Humano.</div>
        </div>
      </div>`;
    ov.querySelectorAll('[data-nrdim]').forEach(el => el.classList.toggle('ig-dimmed', blocked));
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
      // Recaudos adjuntos: array {required_doc_id, file_name, file_b64, file_type}.
      // Solo los que tienen archivo cargado. Viajan en el submit a osTicket.
      docs: (CAT.docs || [])
        .filter(d => docState[d.id] && docState[d.id].file_b64)
        .map(d => ({
          required_doc_id: d.id,
          file_name: docState[d.id].file_name,
          file_b64: docState[d.id].file_b64,
          file_type: docState[d.id].file_type,
        })),
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

  showAge(); showCed(); showBank(); showPhone(); check(); applyNrState();
  // v5.77: si el modal abre con cedula precargada (editar / venia del paso 3),
  // consultarla de una vez.
  {
    const v0 = DW.validateCedula(q('#ig_ced').value);
    if (v0.ok) nrLookup(v0.ced, () => { if (ov.isConnected) { showCed(); check(); applyNrState(); } });
  }
  setTimeout(() => q('#ig_start').focus(), 40);
}

function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

/* =====================================================================
   FICHA SOLO-LECTURA (Resumen -> "Ver detalle")
   Muestra TODOS los datos capturados del ingreso sin permitir editarlos.
   Se invoca desde el boton del Resumen via la funcion global de abajo,
   porque wizard-core pinta el Resumen y no engancha listeners a nuestras
   celdas. Busca a la persona por cedula en LAST_WORKERS (la lista del
   reporte en curso, refrescada en cada render del paso 4).
   ===================================================================== */
window.__nv2VerIngreso = function (ced) {
  const w = (LAST_WORKERS || []).find(x => String(x.ced) === String(ced));
  if (!w || !w.ingreso) { alert('No se encontraron los datos de este ingreso.'); return; }
  openIngresoView(w);
};

function openIngresoView(w) {
  const g = w.ingreso || {};
  const GEN = { M: 'Masculino', F: 'Femenino' };
  const CIV = { S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a' };
  const age = ageFrom(g.birthDate);
  const phoneNat = g.phone ? g.phone : '—';
  const docsList = (CAT && CAT.docs) ? CAT.docs : [];
  const docState = {};
  (g.docs || []).forEach(d => { if (d && d.required_doc_id) docState[d.required_doc_id] = d; });

  // Fila de dato (etiqueta + valor). Para valores vacios muestra una raya.
  const row = (label, value) =>
    `<div class="vr-row"><span class="vr-lbl">${label}</span><span class="vr-val">${value == null || value === '' ? '—' : esc(value)}</span></div>`;

  const docsHtml = docsList.length
    ? docsList.map(d => {
        const st = docState[d.id];
        const has = st && st.file_b64;
        const pill = has
          ? `<span class="pill pill-set">📎 ${esc(st.file_name || 'adjunto')}</span>`
          : `<span class="pill pill-pend">pendiente</span>`;
        return `<div class="vr-row"><span class="vr-lbl">${esc(d.name)}</span><span class="vr-val">${pill}</span></div>`;
      }).join('')
    : `<div class="vr-row"><span class="vr-val" style="color:var(--muted)">Esta tienda no tiene recaudos configurados.</span></div>`;

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal modal-wide">
      <h3>Detalle del ingreso</h3>
      <p class="who">${esc(w.name || '')} · <span class="pill pill-set">A · Alta</span> · solo lectura</p>

      <div class="ig-sec" style="margin-top:6px">Identidad</div>
      ${row('Primer nombre', g.firstName)}
      ${row('Segundo nombre', g.secondName)}
      ${row('Apellidos', g.lastNames)}
      ${row('Cédula', `${g.cedKind || 'V'}-${w.ced}`)}
      ${row('Cargo', g.cargoCode ? cargoLabel(g.cargoCode) : '—')}
      ${row('Fecha de nacimiento', g.birthDate ? DW.fmtDate(g.birthDate) : '—')}
      ${row('Edad', age == null ? '—' : `${age} años`)}

      <div class="ig-sec">Datos personales y bancarios</div>
      ${row('Género', GEN[g.gender] || g.gender)}
      ${row('Estado civil', CIV[g.marital] || g.marital)}
      ${row('Cuenta bancaria', g.account ? `${g.account}${g.bankName ? ' · ' + g.bankName : ''}` : '—')}

      <div class="ig-sec">Contacto</div>
      ${row('Correo', g.email)}
      ${row('Teléfono', phoneNat)}
      ${row('Dirección', g.address)}

      <div class="ig-sec">Fecha de ingreso</div>
      ${row('Fecha inicial de empleo', g.startDate ? DW.fmtDate(g.startDate) : '—')}

      <div class="ig-sec">Recaudos</div>
      ${docsHtml}

      <div class="wiz-foot" style="margin-top:18px">
        <span></span>
        <button class="btn btn-primary" id="ivClose">Cerrar</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#ivClose').addEventListener('click', close);
  // Se cierra SOLO con su boton (Cerrar); no al hacer clic fuera.
}
