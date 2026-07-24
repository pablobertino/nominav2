/* =====================================================================
   js/views/cambio-cargo.js — vista "Cambio de Cargo" (F1)
   Consola de ESCRITURA: ascensos, descensos, traslados y egresos con
   circuito sugerir -> aprobar -> exportar la plantilla de Modificacion AX.
   Dos pantallas: "Cambio de Cargo" (wizard) e "Historial de cambio de cargo".

   Reutiliza: /api/personnel-search (buscar persona), /api/worker-photo
   accion group_history (trayectoria IGUAL que la ficha), /api/cambio-cargo
   (catalog/list/suggest/approve/reject/export).

   Mockup aprobado: _PRUEBAS/movimientos_wizard_v4.html
   Gate de menu: view.cambiocargo. Export: renderCambioCargo(user)
   ===================================================================== */

import { $ } from '../core/dom.js';
import { renderWorkerPhotos } from './worker-photos.js';

let USER = null;
let CAT = null;                 // catalogo (cargos, egress_reasons, my, assign_min_level)
let COMPS = null;               // tiendas del alcance (para el traslado)
let STEP = 0;
let TRAJ_OPEN = true;           // estado abierto/plegado de la trayectoria (persiste entre pasos)
let COLA_FILTER = 'todos', COLA_Q = '';
let MOVES = [];                 // historial cargado
const D = resetD();

function resetD() { return { person: null, tipo: null, cargoTo: null, empTo: '', empToLabel: '', motivo: '', fechaEf: '', fechaB: '', fechaA: '', comentario: '' }; }

/* Fecha de HOY en zona horaria de Venezuela (America/Caracas), no UTC. */
function todayVE() {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' }); }
  catch (_) { return new Date().toISOString().slice(0, 10); }
}
/* Defaults que deben existir ANTES de evaluar canNext (si no, el boton
   Continuar queda deshabilitado aunque el dato ya este puesto). */
function ensureDefaults() {
  if (!D.person || !D.tipo) return;
  if ((D.tipo === 'ascenso' || D.tipo === 'descenso') && !D.cargoTo) {
    const opts = targetsFor(D.person, D.tipo);
    if (opts.length) D.cargoTo = (D.tipo === 'ascenso' ? opts[opts.length - 1] : opts[0]).code;
  }
  if (D.tipo === 'traslado' && !D.cargoTo) {
    const opts = targetsFor(D.person, 'traslado');
    const cur = D.person.cargo_code;
    D.cargoTo = (cur && opts.some(o => o.code === cur)) ? cur : (opts[0] ? opts[0].code : null);
  }
  if (D.tipo === 'traslado') {
    if (!D.fechaB) D.fechaB = todayVE();
    if (!D.fechaA || D.fechaA <= D.fechaB) D.fechaA = addDaysIso(D.fechaB, 1);
  } else if (!D.fechaEf) {
    D.fechaEf = todayVE();
  }
}
/* Refresca solo el estado del boton Continuar sin re-render (no roba foco). */
function syncNext() { const b = document.getElementById('ccNext'); if (b) b.disabled = !canNext(); }
async function ensureCompanies() {
  if (COMPS) return COMPS;
  const r = await companiesApi();
  COMPS = (r && r.ok && r.companies) ? r.companies : [];
  return COMPS;
}

/* Colores por cargo (mismos del mockup; tienda alineado a la ficha). */
const CARGO_COLOR = {
  GERENTE_ZONA: '#4338ca', SUBGERENTE_ZONA: '#6d28d9', SUPERVISOR: '#0e7490',
  GERENTE: '#b45309', 'SUB-GERENTE': '#7e22ce', CAJERO: '#2b6cff',
  DEPOSITARIO: '#64748b', VENDEDOR: '#0e9f6e',
};
const colorOf = code => CARGO_COLOR[code] || '#64748b';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const norm = s => String(s == null ? '' : s).trim();
function fmt(iso) { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); }
function todayIso() { return new Date().toISOString().slice(0, 10); }

/* ---------- catalogo / cargos ---------- */
function cargoBy(code) { return (CAT && CAT.cargos || []).find(c => c.code === code) || null; }
function cargoLabel(code) { const c = cargoBy(code); return c ? c.label : (code || '—'); }
function cch(code, big) {
  const col = colorOf(code); const lbl = esc(cargoLabel(code));
  const st = big
    ? `font-size:15px;font-weight:800;border-radius:10px;padding:6px 13px`
    : `font-size:11.5px;font-weight:800;border-radius:999px;padding:2px 10px`;
  return `<span style="${st};background:${col}1a;color:${col}">${lbl}</span>`;
}
/* Cargos que el rol puede ASIGNAR: movibles con hier_level > assign_min_level. */
function assignable() {
  const min = CAT ? Number(CAT.assign_min_level) : 999;
  return (CAT.cargos || []).filter(c => c.movable && c.hier_level > min);
}
function targetsFor(person, tipo) {
  const cur = cargoBy(person.cargo_code);
  const curLvl = cur ? cur.hier_level : 999;
  let list = assignable();
  if (tipo === 'ascenso') list = list.filter(c => c.hier_level < curLvl);
  else if (tipo === 'descenso') list = list.filter(c => c.hier_level > curLvl);
  else if (tipo === 'traslado') {
    list = list.filter(c => c.ambito === 'tienda');
    // El traslado suele mantener el MISMO cargo: incluir el actual aunque no
    // sea "asignable" en el sentido de ascenso (ej. Vendedor).
    if (cur && cur.ambito === 'tienda' && !list.some(c => c.code === cur.code)) list = list.concat([cur]);
  }
  return list.sort((a, b) => a.hier_level - b.hier_level);
}

/* ---------- API ---------- */
async function api(payload) {
  return fetch('/api/cambio-cargo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, user: USER }),
  }).then(x => x.json()).catch(() => null);
}
async function searchApi(q) {
  return fetch('/api/personnel-search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // Solo empresas tipo Tienda. El alcance (zona del ejecutor) lo aplica el
    // endpoint por adminId (get_admin_companies_scoped, seccion 'buscar').
    body: JSON.stringify({ action: 'search', adminId: USER.id, q, type: 'Tienda' }),
  }).then(x => x.json()).catch(() => null);
}
async function historyApi(idNumber, companyCode) {
  return fetch('/api/worker-photo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // El endpoint EXIGE company_code (userCanAccess); sin el, devuelve error
    // y la trayectoria sale vacia.
    body: JSON.stringify({ action: 'group_history', id_number: idNumber, company_code: companyCode || '', user: USER }),
  }).then(x => x.json()).catch(() => null);
}
async function companiesApi() {
  return fetch('/api/cambio-cargo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'companies', user: USER }),
  }).then(x => x.json()).catch(() => null);
}

/* =====================================================================
   ENTRY
   ===================================================================== */
/* Pantalla 1: WIZARD (menu Cargos -> Cambio de Cargo). */
export async function renderCambioCargo(user) {
  USER = user;
  const host = $('#pnlMain');
  if (!host) return;
  host.innerHTML = styleBlock() + `<div class="cc-wrap"><div id="ccBody"><div class="cc-loading">Cargando…</div></div></div>`;
  if (!(await ensureCat())) return;
  paintWizard();
}

/* Pantalla 2: HISTORIAL (menu Cargos -> Historial). Pantalla aparte. */
export async function renderCambioCargoHist(user) {
  USER = user;
  const host = $('#pnlMain');
  if (!host) return;
  host.innerHTML = styleBlock() + `<div class="cc-wrap"><div id="ccBody"><div class="cc-loading">Cargando…</div></div></div>`;
  if (!(await ensureCat())) return;
  await paintCola();
}

async function ensureCat() {
  if (CAT) return true;
  const c = await api({ action: 'catalog' });
  if (!c || !c.ok) {
    const b = document.getElementById('ccBody');
    if (b) b.innerHTML = `<div class="cc-empty">${esc((c && c.error) || 'No se pudo cargar Cambio de Cargo.')}</div>`;
    return false;
  }
  CAT = c;
  return true;
}
/* Navega a la pantalla Historial pulsando su item del menu lateral. */
function gotoHistorial() {
  const b = document.querySelector('.pnl-side [data-view="cargohistorial"]');
  if (b) b.click();
}

/* =====================================================================
   WIZARD (Cambio de Cargo)
   ===================================================================== */
const STEP_LABELS = ['Persona', 'Tipo', 'Destino', 'Fecha', 'Revisión'];
const canNext = () => {
  if (STEP === 0) return !!D.person;
  if (STEP === 1) return !!D.tipo;
  if (STEP === 2) {
    if (D.tipo === 'egreso') return !!D.motivo;
    if (D.tipo === 'traslado') return !!(D.empTo && D.cargoTo);
    return !!D.cargoTo;
  }
  if (STEP === 3) {
    if (D.tipo === 'traslado') return !!(D.fechaB && D.fechaA);
    return !!D.fechaEf;
  }
  return true;
};

function paintWizard() {
  const body = document.getElementById('ccBody');
  const my = CAT.my || {};
  ensureDefaults();
  const stepper = STEP_LABELS.map((l, i) =>
    `<div class="cc-stp ${i < STEP ? 'done' : ''} ${i === STEP ? 'on' : ''}"><div class="bar"></div><div class="lb">${l}</div></div>`).join('');
  const foot = STEP === 4
    ? (my.aprobar
      ? `<button class="cc-btn apr" id="ccFin" data-k="a">✓ Aprobar y preparar</button>`
      : `<button class="cc-btn sug" id="ccFin" data-k="s">Enviar sugerencia</button>`)
    : `<button class="cc-btn next" id="ccNext" ${canNext() ? '' : 'disabled'}>Continuar →</button>`;

  body.innerHTML = `
    <div class="cc-wiz">
      <div class="cc-wh"><h1>Cambio de Cargo</h1><div class="sub">Paso ${STEP + 1} de 5 · ${esc(STEP_LABELS[STEP])}</div></div>
      <div class="cc-steps">${stepper}</div>
      <div class="cc-wbody" id="ccStep"></div>
      <div class="cc-wfoot">
        <button class="cc-btn back" id="ccBack" style="visibility:${STEP === 0 ? 'hidden' : 'visible'}">← Atrás</button>
        <span class="cc-fnote">${STEP === 4 ? (my.aprobar ? 'Con <b>aprobación</b> queda listo para exportar.' : 'Queda <b>sugerido</b> para el Gerente de Zona.') : ''}</span>
        <span class="cc-sp"></span>${foot}
      </div>
    </div>
    <div id="ccFicha"></div>`;

  document.getElementById('ccBack')?.addEventListener('click', () => { STEP = Math.max(0, STEP - 1); paintWizard(); });
  document.getElementById('ccNext')?.addEventListener('click', () => { if (canNext()) { STEP = Math.min(4, STEP + 1); paintWizard(); } });
  document.getElementById('ccFin')?.addEventListener('click', e => finish(e.currentTarget.dataset.k));

  paintStep();
  paintFicha();
}

function paintStep() {
  const el = document.getElementById('ccStep');
  if (STEP === 0) return stepPersona(el);
  if (STEP === 1) return stepTipo(el);
  if (STEP === 2) return stepDestino(el);
  if (STEP === 3) return stepFecha(el);
  return stepRevision(el);
}

/* --- paso Persona: buscar + elegir (una) --- */
function stepPersona(el) {
  el.innerHTML = `
    <div class="cc-sec">Buscar persona (dentro de tu alcance)</div>
    <input class="cc-inp" id="ccQ" placeholder="Nombre o cédula…" autocomplete="off">
    <div class="cc-plist" id="ccPlist"><div class="cc-hint">Escribe al menos 2 caracteres.</div></div>`;
  const q = document.getElementById('ccQ');
  q.value = window.__ccLastQ || '';
  let t = null;
  q.addEventListener('input', () => {
    window.__ccLastQ = q.value;
    clearTimeout(t);
    t = setTimeout(() => runSearch(q.value), 280);
  });
  if (q.value.trim().length >= 2) runSearch(q.value);
  setTimeout(() => q.focus(), 30);
}
async function runSearch(q) {
  const box = document.getElementById('ccPlist');
  if (!box) return;
  if (norm(q).length < 2) { box.innerHTML = `<div class="cc-hint">Escribe al menos 2 caracteres.</div>`; return; }
  box.innerHTML = `<div class="cc-hint">Buscando…</div>`;
  const r = await searchApi(norm(q));
  if (!r || !r.ok) { box.innerHTML = `<div class="cc-hint">No se pudo buscar. Intenta de nuevo.</div>`; return; }
  const rows = r.rows || [];
  if (!rows.length) { box.innerHTML = `<div class="cc-hint">Sin resultados.</div>`; return; }
  box.innerHTML = rows.slice(0, 40).map(p => {
    const cargoTxt = norm(p.role) || '';
    const ini = (norm(p.full_name) || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const on = D.person && D.person.id_number === p.id_number;
    const av = p.thumb_url ? `<img src="${esc(p.thumb_url)}" alt="">` : esc(ini);
    return `<div class="cc-prow ${on ? 'on' : ''}" data-ced="${esc(p.id_number)}">
      <div class="cc-pav">${av}</div>
      <div style="flex:1"><div class="cc-pnm">${esc(p.full_name || '')}</div>
        <div class="cc-pmeta">V-${esc(p.id_number)}${p.company_code ? ' · ' + esc(p.company_code) : ''}${p.company_name ? ' ' + esc(p.company_name) : ''}</div></div>
      <span class="cc-pcargo">${esc(cargoTxt)}</span>
      <button class="cc-openf" data-ced="${esc(p.id_number)}" title="Ver ficha completa">${IC_FICHA}</button></div>`;
  }).join('');
  box.querySelectorAll('.cc-prow').forEach(row => row.addEventListener('click', e => {
    if (e.target.closest('.cc-openf')) return;
    const p = rows.find(x => String(x.id_number) === row.dataset.ced);
    pickPerson(p);
  }));
  box.querySelectorAll('.cc-openf').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const p = rows.find(x => String(x.id_number) === btn.dataset.ced);
    if (p) openFichaFor(p);
  }));
}
const IC_FICHA = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
function openFichaFor(p) {
  const cc = p.company_code || (D.person && D.person.company_code);
  if (!cc) { toast('No pude abrir la ficha: falta la empresa.', true); return; }
  renderWorkerPhotos(USER, cc, () => renderCambioCargo(USER), { mode: 'store', openCed: p.id_number });
}
function pickPerson(p) {
  // Mapea el cargo de texto del roster a un code de cargos (mejor esfuerzo).
  D.person = {
    id_number: p.id_number, full_name: p.full_name || '', role_text: norm(p.role) || '',
    company_code: p.company_code || '', business_name: p.company_name || '',
    thumb_url: p.thumb_url || null, start_date: p.start_date || null,
    cargo_code: matchCargoCode(p.role),
  };
  D.tipo = null; D.cargoTo = null;
  paintWizard();
}
/* Empareja el cargo (texto del roster) con un code del catalogo, por ax_code
   o label normalizado. Si no matchea, queda null (el usuario igual elige). */
function matchCargoCode(roleText) {
  const t = String(roleText || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!t) return null;
  const cs = CAT.cargos || [];
  let hit = cs.find(c => String(c.ax_code).toUpperCase() === t) ||
    cs.find(c => String(c.label).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') === t);
  if (hit) return hit.code;
  // contiene
  hit = cs.find(c => t.includes(String(c.ax_code).toUpperCase())) ||
    cs.find(c => t.includes(String(c.label).toUpperCase()));
  return hit ? hit.code : null;
}

/* --- paso Tipo --- */
function stepTipo(el) {
  const T = [
    ['ascenso', 'Ascenso', 'subir de cargo', '#16a34a', '#f0fdf4'],
    ['descenso', 'Descenso', 'bajar de cargo', '#d97706', '#fffbeb'],
    ['traslado', 'Traslado', 'otra tienda/empresa', '#2563eb', '#eff6ff'],
    ['egreso', 'Egreso', 'baja', '#dc2626', '#fef2f2'],
  ];
  el.innerHTML = `<div class="cc-typegrid">${T.map(([k, t, s, c, bg]) =>
    `<div class="cc-typeb ${D.tipo === k ? 'on' : ''}" data-t="${k}" style="--c:${c};--bg:${bg}">
      <b>${t}</b><span>${s}</span></div>`).join('')}</div>`;
  el.querySelectorAll('.cc-typeb').forEach(b => b.addEventListener('click', () => {
    D.tipo = b.dataset.t; D.cargoTo = null;
    // default target
    const opts = targetsFor(D.person, D.tipo);
    if ((D.tipo === 'ascenso' || D.tipo === 'descenso') && opts.length) D.cargoTo = (D.tipo === 'ascenso' ? opts[opts.length - 1] : opts[0]).code;
    if (D.tipo === 'traslado' && D.person.cargo_code) D.cargoTo = D.person.cargo_code;
    paintWizard();
  }));
}

/* --- paso Destino --- */
function stepDestino(el) {
  const roleNote = `<div class="cc-hint" style="margin-top:8px">🔒 Como <b>${esc(roleLabel())}</b> solo puedes asignar cargos por debajo del tuyo (se configura por rol).</div>`;
  if (D.tipo === 'ascenso' || D.tipo === 'descenso') {
    const opts = targetsFor(D.person, D.tipo);
    if (!opts.length) { el.innerHTML = `<div class="cc-warn err">No hay cargos que tu rol pueda asignar para este ${D.tipo}. Debe hacerlo un rol superior.</div>`; return; }
    el.innerHTML = `<div class="cc-fld"><label>Nuevo cargo</label>
      <select id="ccCargo">${opts.map(c => `<option value="${c.code}" ${c.code === D.cargoTo ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>${roleNote}</div>`;
    document.getElementById('ccCargo').addEventListener('change', e => { D.cargoTo = e.target.value; paintFicha(); syncNext(); });
    return;
  }
  if (D.tipo === 'traslado') {
    const opts = targetsFor(D.person, 'traslado');
    const selChip = D.empTo
      ? `<div class="cc-selchip">Destino: <b>${esc(D.empTo)}</b>${D.empToLabel ? ' · ' + esc(D.empToLabel) : ''} <button id="ccEmpClear" title="Cambiar">✕</button></div>`
      : '';
    el.innerHTML = `<div class="cc-fld"><label>Empresa/tienda destino</label>
        ${selChip}
        <input class="cc-inp" id="ccEmpToQ" placeholder="Buscar por alias, razón social, zona, subzona o concepto…" autocomplete="off">
        <div class="cc-plist" id="ccEmpToList"><div class="cc-hint">Cargando tiendas…</div></div></div>
      <div class="cc-fld"><label>Cargo en destino</label>
        <select id="ccCargo">${opts.map(c => `<option value="${c.code}" ${c.code === (D.cargoTo || D.person.cargo_code) ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
      <div class="cc-warn">Sale del origen y entra al destino al día siguiente (nunca dos tiendas el mismo día). Las fechas van en el paso siguiente.</div>${roleNote}`;
    document.getElementById('ccCargo').addEventListener('change', e => { D.cargoTo = e.target.value; paintFicha(); syncNext(); });
    const q = document.getElementById('ccEmpToQ');
    q.addEventListener('input', () => renderEmpToList(q.value));
    document.getElementById('ccEmpClear')?.addEventListener('click', () => { D.empTo = ''; D.empToLabel = ''; paintStep(); paintFicha(); syncNext(); });
    ensureCompanies().then(() => renderEmpToList(''));
    return;
  }
  // egreso
  const reasons = CAT.egress_reasons || [];
  el.innerHTML = `<div class="cc-fld"><label>Motivo del egreso</label>
      <select id="ccMotivo"><option value="">Elige un motivo…</option>${reasons.map(r => `<option value="${esc(r.code)}" ${r.code === D.motivo ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></div>
    <div class="cc-fld"><label>Comentario (opcional)</label><textarea class="cc-inp" id="ccCom" rows="2">${esc(D.comentario)}</textarea></div>`;
  document.getElementById('ccMotivo').addEventListener('change', e => { D.motivo = e.target.value; paintFicha(); syncNext(); });
  document.getElementById('ccCom').addEventListener('input', e => { D.comentario = e.target.value; });
}
/* Lista filtrable de tiendas del alcance para el traslado. */
function renderEmpToList(q) {
  const box = document.getElementById('ccEmpToList');
  if (!box) return;
  const list = COMPS || [];
  const qq = norm(q).toLowerCase();
  const originCode = D.person && D.person.company_code;
  let f = (qq ? list.filter(c => [c.code, c.business_name, c.zona, c.subzona, c.concepto].some(v => String(v || '').toLowerCase().includes(qq))) : list)
    .filter(c => c.code !== originCode);
  if (!f.length) { box.innerHTML = `<div class="cc-hint">Sin tiendas que coincidan en tu alcance.</div>`; return; }
  box.innerHTML = f.slice(0, 50).map(c => `<div class="cc-prow ${D.empTo === c.code ? 'on' : ''}" data-code="${esc(c.code)}">
      <div style="flex:1"><div class="cc-pnm">${esc(c.code)} · ${esc(c.business_name || '')}</div>
        <div class="cc-pmeta">${[c.zona, c.subzona, c.concepto].filter(Boolean).map(esc).join(' · ') || '—'}</div></div>
      ${statusBadge(c.status)}</div>`).join('');
  box.querySelectorAll('.cc-prow').forEach(row => row.addEventListener('click', () => {
    const c = (COMPS || []).find(x => x.code === row.dataset.code);
    if (!c) return;
    D.empTo = c.code; D.empToLabel = c.business_name || '';
    paintStep(); paintFicha(); syncNext();
  }));
}
function statusBadge(st) {
  if (st === 'Cerrada temporal') return `<span class="cc-stat tmp">Cerrada temporal</span>`;
  if (st === 'Proyectada') return `<span class="cc-stat proj">Proyectada</span>`;
  return '';
}

/* --- paso Fecha --- */
function stepFecha(el) {
  const rule = `<div class="cc-hint">📅 Regla del sistema (corte de la quincena). Sugerido dentro de la quincena vigente.</div>`;
  if (D.tipo === 'traslado') {
    el.innerHTML = `<div class="cc-grid2">
        <div class="cc-fld"><label>Último día en origen</label><input class="cc-inp cc-date" type="date" id="ccFB" value="${esc(D.fechaB)}"></div>
        <div class="cc-fld"><label>Primer día en destino</label><input class="cc-inp cc-date" type="date" id="ccFA" value="${esc(D.fechaA)}"></div>
      </div>${rule}`;
    document.getElementById('ccFB').addEventListener('change', e => { D.fechaB = e.target.value; if (D.fechaA <= D.fechaB) D.fechaA = addDaysIso(D.fechaB, 1); paintStep(); paintFicha(); syncNext(); });
    document.getElementById('ccFA').addEventListener('change', e => { D.fechaA = e.target.value; paintFicha(); syncNext(); });
    return;
  }
  el.innerHTML = `<div class="cc-fld"><label>${D.tipo === 'egreso' ? 'Fecha de egreso' : 'Fecha efectiva'}</label>
      <input class="cc-inp cc-date" type="date" id="ccFE" value="${esc(D.fechaEf)}"></div>${rule}`;
  document.getElementById('ccFE').addEventListener('change', e => { D.fechaEf = e.target.value; paintFicha(); syncNext(); });
}
function addDaysIso(iso, d) { const t = Date.parse(iso + 'T00:00:00Z'); const nd = new Date(t + d * 86400000); return nd.toISOString().slice(0, 10); }

/* --- paso Revisión --- */
function stepRevision(el) {
  const p = D.person;
  const T = { ascenso: 'ASCENSO', descenso: 'DESCENSO', traslado: 'TRASLADO', egreso: 'EGRESO' }[D.tipo];
  const fEf = fmt(D.tipo === 'traslado' ? D.fechaA : D.fechaEf);
  el.innerHTML = `<div class="cc-after">
      <div class="cc-rev-h">${esc(p.full_name)} <span class="cc-pillA ${D.tipo}">${T}</span></div>
      <div class="cc-hint" style="font-size:13px;margin-top:6px">${fraseHtml(p)}. Efectivo el <b>${fEf}</b>.</div>
      <div class="cc-hint" style="margin-top:10px">Al confirmar queda <b>${CAT.my.aprobar ? 'aprobado' : 'sugerido para el Gerente de Zona'}</b>. La plantilla AX se descarga después, desde el Historial.</div>
    </div>`;
}
function fraseHtml(p) {
  const curLbl = esc(cargoLabel(p.cargo_code) || p.role_text || '—');
  if (D.tipo === 'ascenso' || D.tipo === 'descenso') return `${D.tipo === 'ascenso' ? 'Asciende' : 'Desciende'} de <b>${curLbl}</b> a <b>${esc(cargoLabel(D.cargoTo))}</b>`;
  if (D.tipo === 'traslado') { const chg = D.cargoTo && D.cargoTo !== p.cargo_code; const dest = `${esc(D.empTo)}${D.empToLabel ? ' ' + esc(D.empToLabel) : ''}`; return `Se traslada de <b>${esc(p.company_code)} ${esc(p.business_name)}</b> a <b>${dest}</b>` + (chg ? `, y de <b>${curLbl}</b> a <b>${esc(cargoLabel(D.cargoTo))}</b>` : ` (sigue como <b>${esc(cargoLabel(D.cargoTo) || curLbl)}</b>)`); }
  const rl = (CAT.egress_reasons || []).find(r => r.code === D.motivo);
  return `Egresa por <b>${esc(rl ? rl.label : '—')}</b>`;
}

/* --- ficha actual + trayectoria (get_group_history) --- */
async function paintFicha() {
  const host = document.getElementById('ccFicha');
  if (!host || !D.person) { if (host) host.innerHTML = ''; return; }
  const p = D.person;
  const ini = (norm(p.full_name) || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const av = p.thumb_url ? `<img src="${esc(p.thumb_url)}" alt="">` : esc(ini);
  const cargoTxt = esc(String(p.role_text || cargoLabel(p.cargo_code) || '—')).toUpperCase();
  const after = (STEP >= 1 && D.tipo) ? afterCardHtml(p) : '';
  host.innerHTML = `
    <div class="cc-cmp-h">Ficha actual (para decidir)</div>
    <div class="cc-fichaFull">
      <div class="cc-top"><div class="cc-pav big">${av}</div>
        <div class="cc-ffid">
          <h2>${esc(p.full_name)}</h2>
          <div class="cc-ced">V-${esc(p.id_number)}</div>
          <div class="cc-meta"><span class="cc-pill act" title="Vigente a la fecha">Activo</span><span class="cc-pill">${cargoTxt}</span></div>
          <div class="cc-fftrj" id="ccTenure"></div>
          <div class="cc-grp">${esc(p.company_code)} ${esc(p.business_name)} · <a class="cc-flink" id="ccOpenFicha">Ver ficha completa ↗</a></div>
        </div></div>
      <div id="ccTraj"><div class="cc-hint" style="margin-top:10px">Cargando trayectoria…</div></div>
    </div>${after}`;

  document.getElementById('ccOpenFicha')?.addEventListener('click', () => openFichaFor(p));
  const h = await historyApi(p.id_number, p.company_code);
  const items = (h && h.ok && h.items) ? h.items : [];
  const box = document.getElementById('ccTraj');
  if (box) {
    box.innerHTML = trajBlock(items);
    const det = box.querySelector('details.cc-trj');
    if (det) det.addEventListener('toggle', e => { TRAJ_OPEN = e.target.open; });
  }
  const ten = document.getElementById('ccTenure');
  if (ten) ten.innerHTML = tenureLine(items);
}
/* Linea resumen de antiguedad, estilo ficha ("En el Grupo: X · tramo continuo…"). */
function tenureLine(items) {
  if (!items || !items.length) return '';
  const toD = s => Date.parse(String(s).slice(0, 10) + 'T00:00:00Z');
  const first = toD(items[0].ini); const hoy = toD(todayVE());
  const totalDays = Math.round((hoy - first) / 86400000) + 1;
  let continuous = !!items[items.length - 1].vigente;
  for (let i = 0; i < items.length - 1 && continuous; i++) {
    const gap = Math.round((toD(items[i + 1].ini) - toD(items[i].fin)) / 86400000) - 1;
    if (gap > 0) continuous = false;
  }
  const dstr = dur(totalDays);
  return continuous
    ? `<b>En el Grupo: ${dstr}</b> · tramo continuo desde el ${fmt(items[0].ini)} · ✓ continuo`
    : `<b>En el Grupo: ${dstr}</b> · con pausas`;
}
function afterCardHtml(p) {
  const cur = p.cargo_code;
  let cargoLine, empVal, estado = 'Activo', estChg = false;
  if (D.tipo === 'egreso') {
    cargoLine = `<div class="cc-cargoline">${cur ? cch(cur, true) : ''} <span style="color:#991b1b;font-weight:800">→ EGRESO</span></div>`;
    empVal = `${esc(p.company_code)} ${esc(p.business_name)}`; estado = 'Egresado'; estChg = true;
  } else if (D.tipo === 'traslado') {
    cargoLine = `<div class="cc-cargoline">${cur ? cch(cur, true) : ''}<span class="cc-ar">→</span>${cch(D.cargoTo || cur, true)}</div>`;
    empVal = `${esc(p.company_code)} ${esc(p.business_name)} <span class="cc-ar">→</span> ${D.empTo ? esc(D.empTo) + (D.empToLabel ? ' ' + esc(D.empToLabel) : '') : '—'}`;
  } else {
    cargoLine = `<div class="cc-cargoline">${cur ? cch(cur, true) : ''}<span class="cc-ar">→</span>${cch(D.cargoTo || cur, true)}</div>`;
    empVal = `${esc(p.company_code)} ${esc(p.business_name)}`;
  }
  const pair = (k, val, chg, cls) => `<div class="cc-frow"><span class="k">${k}</span><span class="cc-vpair">${chg ? `<span class="cc-vchip old">${val.split('→')[0]}</span>` : ''}<span class="cc-vchip ${cls || ''}">${chg && val.includes('→') ? val.split('→')[1] : val}</span></span></div>`;
  return `<div class="cc-after"><div class="lab">Ficha nueva</div>${cargoLine}
    <div class="cc-frow"><span class="k">Empresa · Tienda</span><span class="cc-vpair">${empVal}</span></div>
    <div class="cc-frow"><span class="k">Estado</span><span class="cc-vpair"><span class="cc-vchip ${estChg ? 'egr' : ''}">${estado}</span></span></div>
    <div class="cc-frow"><span class="k">Efectivo</span><span class="cc-vpair"><span class="cc-vchip date">${fmt(D.tipo === 'traslado' ? D.fechaA : D.fechaEf)}</span></span></div></div>`;
}

/* trayectoria IGUAL que la ficha (get_group_history: alias, empresa, cargo,
   ini, fin, dias, vigente, zona, subzona). Colapsable. */
function trajBlock(items) {
  return `<details class="cc-trj" ${TRAJ_OPEN ? 'open' : ''}><summary>Ver trayectoria completa</summary><div>${trajHtml(items)}</div></details>`;
}
function trajHtml(items) {
  if (!items || !items.length) return `<div class="cc-hint">Sin historia registrada en el Grupo.</div>`;
  const toD = s => Date.parse(String(s).slice(0, 10) + 'T00:00:00Z');
  const hoy = toD(todayVE()); const first = toD(items[0].ini);
  const span = Math.max(1, (hoy - first) / 86400000 + 1);
  let segs = '', rows = '';
  for (let i = 0; i < items.length; i++) {
    const it = items[i]; const finD = it.fin ? toD(it.fin) : hoy;
    const days = (finD - toD(it.ini)) / 86400000 + 1;
    const w = Math.max(2, Math.round(days / span * 100)); const vig = !!it.vigente;
    segs += `<div style="width:${w}%;height:100%;background:${vig ? '#0f766e' : 'repeating-linear-gradient(45deg,#94a3b8 0 6px,#cbd5e1 6px 12px)'}" title="${esc(it.alias || '')} · ${fmt(it.ini)} → ${it.fin ? fmt(it.fin) : 'hoy'}"></div>`;
    const zsub = [it.zona, it.subzona].filter(Boolean).join(' · ');
    rows += `<div class="cc-hrow${vig ? ' now' : ''}">
      <span class="hd">${fmt(it.ini)} → ${it.fin ? fmt(it.fin) : 'hoy'}</span>
      <span class="ha">${esc(it.alias || '')}</span>
      <span class="hr">${esc(it.empresa || '')}</span>
      <span class="hz">${esc(zsub)}</span>
      <span class="hc">${esc(it.cargo || '')}</span>
      <span class="hdur">${vig ? `<b>${dur(it.dias)} · vigente</b>` : dur(it.dias)}</span></div>`;
    const nx = items[i + 1];
    if (nx) {
      const gap = Math.round((toD(nx.ini) - finD) / 86400000) - 1;
      if (gap > 0) {
        segs += `<div style="width:${Math.max(1, Math.round(gap / span * 100))}%;height:100%;background:#e2e8f0" title="Pausa · ${gap} días"></div>`;
        rows += `<div class="cc-hpause">⏸ pausa de ${gap} día${gap === 1 ? '' : 's'} (${fmt(addDaysIso(it.fin, 1))} → ${fmt(addDaysIso(nx.ini, -1))})</div>`;
      }
    }
  }
  return `<div style="display:flex;align-items:center;height:10px;border-radius:99px;overflow:hidden;background:#e2e8f0;margin-top:8px" title="Desde el ${fmt(items[0].ini)} hasta hoy">${segs}</div>`
    + `<div style="display:flex;justify-content:space-between;font-size:10.5px;color:#94a3b8;margin:3px 0 7px"><span>${fmt(items[0].ini)}</span><span>hoy</span></div>`
    + `<div class="cc-hist">${rows}</div>`
    + `<div style="font-size:11px;color:#94a3b8;margin-top:5px">Razón social del momento según el sistema · el empleo vigente muestra la razón social actual.</div>`;
}
function dur(d) { if (d == null) return ''; d = Number(d); if (d < 31) return `${d} d`; const m = Math.floor(d / 30.4); if (m < 12) return `${m} m`; const y = Math.floor(m / 12), mm = m % 12; return `${y} a${mm ? ` ${mm} m` : ''}`; }

/* --- guardar (sugerir / aprobar) --- */
async function finish(k) {
  const p = D.person;
  const item = {
    tipo: D.tipo,
    id_number: p.id_number,
    full_name: p.full_name,
    cargo_from: p.cargo_code || null,
    cargo_to: D.tipo === 'egreso' ? null : (D.cargoTo || null),
    empresa_origen: p.company_code || null,
    empresa_destino: D.tipo === 'traslado' ? D.empTo : null,
    motivo: D.tipo === 'egreso' ? D.motivo : null,
    fecha_efectiva: (D.tipo === 'ascenso' || D.tipo === 'descenso') ? D.fechaEf : null,
    fecha_baja: D.tipo === 'egreso' ? D.fechaEf : (D.tipo === 'traslado' ? D.fechaB : null),
    fecha_alta: D.tipo === 'traslado' ? D.fechaA : null,
    comentario: D.comentario || null,
  };
  const btn = document.getElementById('ccFin');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  const r = await api({ action: 'suggest', items: [item], approve: k === 'a' });
  if (!r || !r.ok) {
    if (btn) { btn.disabled = false; btn.textContent = k === 'a' ? '✓ Aprobar y preparar' : 'Enviar sugerencia'; }
    toast((r && r.error) || 'No se pudo guardar el movimiento.', true);
    return;
  }
  // reset y saltar a la pantalla Historial (aparte)
  Object.assign(D, resetD());
  STEP = 0;
  toast(k === 'a' ? 'Movimiento aprobado. Míralo en Historial.' : 'Sugerencia enviada. Míralo en Historial.');
  gotoHistorial();
}

/* =====================================================================
   HISTORIAL (cola)
   ===================================================================== */
const ST = { sugerido: ['sug', 'Sugerido'], aprobado: ['apr', 'Aprobado'], exportado: ['exp', 'Exportado'], rechazado: ['rec', 'Rechazado'], ejecutado: ['exp', 'Ejecutado'], anulado: ['rec', 'Anulado'] };
const TIPO_LB = { ascenso: 'Ascenso', descenso: 'Descenso', lateral: 'Lateral', traslado: 'Traslado', egreso: 'Egreso' };
const FILTERS = [['todos', 'Todos'], ['sugerido', 'Pendientes'], ['aprobado', 'Aprobados'], ['exportado', 'Exportados'], ['rechazado', 'Rechazados']];

async function loadCola() {
  const r = await api({ action: 'list', estado: 'todos' });
  MOVES = (r && r.ok && r.rows) ? r.rows : [];
}
async function paintCola() {
  const body = document.getElementById('ccBody');
  body.innerHTML = `<div class="cc-cola"><div class="cc-loading">Cargando historial…</div></div>`;
  await loadCola();
  renderCola();
}
function cntBy(est) { return MOVES.filter(m => est === 'todos' ? true : m.estado === est).length; }
function colaFiltered() {
  return MOVES.filter(m => (COLA_FILTER === 'todos' || m.estado === COLA_FILTER) &&
    (!COLA_Q || (m.full_name || '').toLowerCase().includes(COLA_Q) || (m.id_number || '').includes(COLA_Q)));
}
function renderCola() {
  const body = document.getElementById('ccBody');
  const my = CAT.my || {};
  const pend = cntBy('sugerido');
  const chips = FILTERS.map(([f, lb]) => `<button data-f="${f}" class="${COLA_FILTER === f ? 'on' : ''}">${lb}<span class="n">${cntBy(f)}</span></button>`).join('');
  const approveBar = (pend > 0 && my.aprobar)
    ? `<div class="cc-approvebar">⏳ <b>${pend}</b> sugerencia${pend === 1 ? '' : 's'} esperan tu aprobación. Revisa cada una y pulsa <b>✓ Aprobar</b> o <b>Rechazar</b>.</div>`
    : (pend > 0 ? `<div class="cc-approvebar">⏳ <b>${pend}</b> sugerencia${pend === 1 ? '' : 's'} pendiente${pend === 1 ? '' : 's'}. Las aprueba el <b>Gerente de Zona</b>.</div>` : '');
  const exportBtn = my.aprobar && cntBy('aprobado') > 0
    ? `<button class="cc-sbtn exp" id="ccExportAll">⬇ Exportar plantilla AX (${cntBy('aprobado')})</button>` : '';
  body.innerHTML = `<div class="cc-cola">
    <div class="cc-cola-h"><h2>Historial de cambio de cargo</h2><span class="sub">viendo como <b>${esc(roleLabel())}</b></span><span class="cc-sp"></span>${exportBtn}</div>
    <div class="cc-cola-filter"><div class="cc-fchips">${chips}</div><input class="cc-inp" id="ccColaQ" placeholder="Buscar por nombre o cédula…" value="${esc(COLA_Q)}"></div>
    ${approveBar}
    <div id="ccColaList"></div>
    <div class="cc-cola-foot">${my.aprobar ? 'Con <b>mov.aprobar</b>: apruebas/rechazas sugerencias aquí, y desde <b>Cambio de Cargo</b> puedes crear un movimiento ya aprobado directo.' : 'Con <b>mov.sugerir</b>: tus movimientos quedan <b>sugeridos</b> hasta que el Gerente de Zona los apruebe.'} La plantilla AX se descarga una vez aprobado.</div>
  </div>`;
  body.querySelectorAll('.cc-fchips button').forEach(b => b.addEventListener('click', () => { COLA_FILTER = b.dataset.f; renderCola(); }));
  document.getElementById('ccColaQ').addEventListener('input', e => { COLA_Q = e.target.value.toLowerCase(); renderColaList(); });
  document.getElementById('ccExportAll')?.addEventListener('click', () => exportPlantilla(null));
  renderColaList();
}
function renderColaList() {
  const el = document.getElementById('ccColaList');
  if (!el) return;
  const list = colaFiltered();
  if (!list.length) { el.innerHTML = `<div class="cc-mvrow"><span class="cc-hint">Sin resultados para este filtro.</span></div>`; return; }
  el.innerHTML = list.map(mv => {
    const st = ST[mv.estado] || ['sug', mv.estado];
    return `<div class="cc-mvrow"><div class="cc-mv-main">
        <div class="cc-mv-nm">${esc(mv.full_name || ('V-' + mv.id_number))} <span class="cc-pillA ${mv.tipo}">${esc((TIPO_LB[mv.tipo] || mv.tipo).toUpperCase())}</span></div>
        <div class="cc-mv-det">${mvDetail(mv)}</div>
        <div class="cc-mv-meta">Efectivo ${fmt(mv.fecha_efectiva || mv.fecha_alta || mv.fecha_baja)} · ${esc(mv.suggested_by || '')}${mv.approved_by ? ' · aprobado por ' + esc(mv.approved_by) : ''}</div>
      </div><div class="cc-mv-side"><span class="cc-stbadge ${st[0]}">${st[1]}</span>${mvActions(mv)}</div></div>`;
  }).join('');
  el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const id = parseInt(b.dataset.id, 10); const act = b.dataset.act;
    if (act === 'approve') approveMove(id);
    else if (act === 'reject') rejectMove(id);
    else if (act === 'export') exportPlantilla([id]);
  }));
}
function mvDetail(mv) {
  if (mv.tipo === 'egreso') return `${mv.cargo_from ? cch(mv.cargo_from) : ''} <span class="cc-ar">→</span> <span class="cc-cchN egr">Egreso</span>${mv.motivo ? ' · ' + esc(mv.motivo) : ''}`;
  if (mv.tipo === 'traslado') return `${mv.cargo_from ? cch(mv.cargo_from) : ''}${mv.cargo_to && mv.cargo_to !== mv.cargo_from ? ` <span class="cc-ar">→</span> ${cch(mv.cargo_to)}` : ''} · <b>${esc(mv.empresa_origen || '')}</b> <span class="cc-ar">→</span> <b>${esc(mv.empresa_destino || '—')}</b>`;
  return `${mv.cargo_from ? cch(mv.cargo_from) : ''} <span class="cc-ar">→</span> ${mv.cargo_to ? cch(mv.cargo_to) : ''}`;
}
function mvActions(mv) {
  const my = CAT.my || {};
  if (mv.estado === 'sugerido') {
    if (my.aprobar) return `<div class="cc-mv-acts"><button class="cc-sbtn apr" data-act="approve" data-id="${mv.id}">✓ Aprobar</button><button class="cc-sbtn rec" data-act="reject" data-id="${mv.id}">Rechazar</button></div>`;
    return `<div class="cc-mv-wait">⏳ Esperando al Gerente de Zona</div>`;
  }
  if (mv.estado === 'aprobado') return `<div class="cc-mv-acts"><button class="cc-sbtn exp" data-act="export" data-id="${mv.id}">⬇ Plantilla AX</button>${my.aprobar ? `<button class="cc-sbtn ghost" data-act="reject" data-id="${mv.id}">Anular</button>` : ''}</div>`;
  return '';
}
async function approveMove(id) {
  const r = await api({ action: 'approve', id });
  if (!r || !r.ok) return toast((r && r.error) || 'No se pudo aprobar.', true);
  await loadCola(); renderCola(); toast('Aprobado.');
}
async function rejectMove(id) {
  const r = await api({ action: 'reject', id });
  if (!r || !r.ok) return toast((r && r.error) || 'No se pudo rechazar.', true);
  await loadCola(); renderCola(); toast('Rechazado.');
}
async function exportPlantilla(ids) {
  const r = await api({ action: 'export', ids: ids || null });
  if (!r || !r.ok) return toast((r && r.error) || 'No se pudo exportar.', true);
  if (!r.rows || !r.rows.length) return toast('No hay movimientos aprobados para exportar.', true);
  await downloadXlsx(r.columns, r.rows, r.filename || 'MODIFICACIONES.xlsx');
  await loadCola(); renderCola();
  toast(`Plantilla generada (${r.exported} movimiento${r.exported === 1 ? '' : 's'}).`);
}
async function downloadXlsx(columns, rows, filename) {
  const aoa = [columns].concat(rows);
  try {
    if (!window.XLSX) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar la librería Excel.'));
        document.head.appendChild(s);
      });
    }
    const ws = window.XLSX.utils.aoa_to_sheet(aoa);
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, 'MODIFICACIONES');
    window.XLSX.writeFile(wb, filename.replace(/\.xlsx$/i, '') + '.xlsx');
  } catch (e) {
    // Fallback CSV
    const csv = aoa.map(r => r.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = filename.replace(/\.xlsx$/i, '') + '.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
}

/* ---------- utils ---------- */
function roleLabel() {
  const r = CAT ? CAT.role : '';
  if (r === 'gerente_zona') return 'Gerente de Zona';
  if (r === 'supervisor_tiendas') return 'Supervisor';
  if (r === 'superadmin') return 'Superadmin';
  if (r === 'admin') return 'Administrador';
  return r || '';
}
function toast(msg, isErr) {
  let t = document.getElementById('ccToast');
  if (!t) { t = document.createElement('div'); t.id = 'ccToast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'cc-toast' + (isErr ? ' err' : '');
  t.style.opacity = '1';
  clearTimeout(window.__ccToastT);
  window.__ccToastT = setTimeout(() => { t.style.opacity = '0'; }, 3200);
}

/* ---------- estilos (scope cc-) ---------- */
function styleBlock() {
  return `<style>
  .cc-wrap{--pri:#7c3aed;--pri-soft:#f5f3ff;--ink:#111827;--soft:#374151;--muted:#6b7280;--faint:#9ca3af;--border:#eceff3;--border-2:#e5e7eb;font-size:14px;color:var(--ink)}
  .cc-loading,.cc-empty{padding:28px;color:var(--muted);text-align:center}
  .cc-nav{display:flex;align-items:center;gap:2px;background:#fff;border-bottom:1px solid var(--border-2);padding:0 4px;margin-bottom:16px}
  .cc-brand{font-weight:800;font-size:12.5px;margin-right:16px;padding:12px 8px;display:flex;align-items:center;gap:8px}
  .cc-brand .cc-dot{width:8px;height:8px;border-radius:3px;background:var(--pri)}
  .cc-nav button{border:0;background:transparent;color:var(--muted);font-size:13px;font-weight:700;padding:14px 12px;cursor:pointer;border-bottom:2px solid transparent;display:flex;align-items:center;gap:8px}
  .cc-nav button.on{color:var(--pri);border-bottom-color:var(--pri)}
  .cc-cnt{font-size:10.5px;font-weight:800;background:#fde68a;color:#92400e;border-radius:999px;padding:1px 7px}
  .cc-wiz{background:#fff;border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px rgba(15,23,42,.06);overflow:hidden;max-width:900px}
  .cc-wh{padding:16px 20px 0}.cc-wh h1{font-size:16px;font-weight:800;margin:0}.cc-wh .sub{color:var(--muted);font-size:12px;margin-top:2px}
  .cc-steps{display:flex;gap:6px;padding:14px 20px 0}
  .cc-stp{flex:1;display:flex;flex-direction:column;gap:5px}.cc-stp .bar{height:5px;border-radius:999px;background:#e5e7eb}
  .cc-stp.done .bar,.cc-stp.on .bar{background:var(--pri)}
  .cc-stp .lb{font-size:10px;font-weight:700;color:var(--faint);text-transform:uppercase}.cc-stp.on .lb{color:var(--pri)}.cc-stp.done .lb{color:var(--soft)}
  .cc-wbody{padding:16px 20px;min-height:150px}
  .cc-wfoot{display:flex;gap:9px;align-items:center;padding:14px 20px;border-top:1px solid var(--border);background:#fbfcfe}
  .cc-sp{flex:1}.cc-fnote{font-size:12px;color:var(--muted)}
  .cc-btn{border-radius:9px;padding:9px 15px;font-size:13px;font-weight:700;cursor:pointer;border:1px solid}
  .cc-btn.back{background:#fff;border-color:var(--border-2);color:var(--soft)}
  .cc-btn.next{background:#8b5cf6;border-color:#8b5cf6;color:#fff}.cc-btn.next:hover{background:#7c3aed}.cc-btn.next:disabled{background:#e5e1f7;border-color:#e5e1f7;cursor:not-allowed}
  .cc-btn.sug{background:#f5f3ff;border-color:#ddd6fe;color:#6d28d9}.cc-btn.apr{background:#8b5cf6;border-color:#8b5cf6;color:#fff}
  .cc-sec{font-size:10.5px;font-weight:800;letter-spacing:.08em;color:var(--faint);text-transform:uppercase;margin-bottom:10px}
  .cc-inp{width:100%;border:1px solid var(--border-2);border-radius:9px;padding:9px 11px;font-size:13px;font-family:inherit}
  .cc-plist{display:flex;flex-direction:column;gap:7px;max-height:260px;overflow:auto;margin-top:10px}
  .cc-prow{display:flex;gap:10px;align-items:center;border:1px solid var(--border);border-radius:11px;padding:9px 11px;cursor:pointer}
  .cc-prow:hover{border-color:#ddd6fe;background:#fbfbff}.cc-prow.on{border-color:var(--pri);background:var(--pri-soft)}
  .cc-pav{width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,#e5e7eb,#cbd5e1);color:#475569;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;flex:none;overflow:hidden}
  .cc-pav.big{width:56px;height:56px;font-size:16px}
  .cc-pav img{width:100%;height:100%;object-fit:cover}
  .cc-pnm{font-size:13px;font-weight:700}.cc-pmeta{font-size:11px;color:var(--muted);margin-top:1px}
  .cc-pcargo{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase}
  .cc-typegrid{display:grid;grid-template-columns:1fr 1fr;gap:11px}
  .cc-typeb{border:1.5px solid var(--border-2);border-radius:13px;padding:15px 14px;cursor:pointer}
  .cc-typeb:hover{background:#f8fafc}.cc-typeb.on{border-color:var(--c);background:var(--bg)}
  .cc-typeb b{display:block;font-size:14px;color:var(--c)}.cc-typeb span{color:var(--muted);font-size:11.5px}
  .cc-fld{margin-bottom:13px}.cc-fld label{display:block;font-size:11.5px;font-weight:700;color:var(--soft);margin-bottom:5px}
  .cc-fld select,.cc-fld textarea{width:100%;border:1px solid var(--border-2);border-radius:9px;padding:9px 11px;font-size:13px;font-family:inherit}
  .cc-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .cc-hint{font-size:12px;color:var(--muted);line-height:1.5}
  .cc-warn{font-size:12.5px;color:#1e40af;background:#eff6ff;border:1px solid #bfdbfe;border-radius:11px;padding:11px 13px;line-height:1.5;margin-top:6px}
  .cc-warn.err{color:#991b1b;background:#fef2f2;border-color:#fecaca}
  .cc-cmp-h{font-size:11px;font-weight:800;letter-spacing:.06em;color:var(--faint);text-transform:uppercase;margin:16px 4px 8px}
  .cc-fichaFull{background:#fff;border:1px solid var(--border);border-radius:14px;padding:16px 18px;max-width:900px}
  .cc-top{display:flex;gap:16px;align-items:flex-start}
  .cc-ffid{flex:1}
  .cc-ffid h2{font-size:19px;font-weight:700;margin:0;line-height:1.25;color:#0f172a}
  .cc-ced{font-size:12.5px;color:var(--muted);margin-top:2px}
  .cc-meta{display:flex;gap:7px;margin-top:7px;align-items:center;flex-wrap:wrap}
  .cc-pill{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;border-radius:999px;padding:3px 11px;border:1px solid #e5e7eb;background:#f1f5f9;color:#475569}
  .cc-pill.act{color:#0e9f6e;background:#e9f7f1;border-color:#c4e8d9;font-weight:800}
  .cc-fftrj{font-size:12.5px;color:var(--soft);margin-top:8px}
  .cc-cchN{display:inline-block;font-size:11.5px;font-weight:800;border-radius:999px;padding:2px 10px;background:#eef2f7;color:#475569}
  .cc-cchN.egr{background:#fee2e2;color:#991b1b}
  .cc-grp{font-size:12.5px;color:var(--soft);margin-top:6px}
  .cc-trj{margin-top:12px}
  .cc-trj>summary{cursor:pointer;font-size:12px;font-weight:700;color:#4f46e5;padding:2px 0;list-style:none}
  .cc-trj>summary::-webkit-details-marker{display:none}
  .cc-trj>summary::before{content:'▸ ';color:#94a3b8}.cc-trj[open]>summary::before{content:'▾ '}
  .cc-hist{display:flex;flex-direction:column;margin-top:2px}
  .cc-hrow{display:grid;grid-template-columns:150px 50px minmax(150px,1.5fr) minmax(120px,1.1fr) 110px 78px;gap:10px;align-items:center;font-size:12px;padding:7px 8px;border-bottom:1px solid var(--border)}
  .cc-hrow.now{background:#f5f7ff;border-radius:8px}
  .cc-hrow .hd{font-weight:700}.cc-hrow .ha{font-weight:800;color:#4f46e5}.cc-hrow .hr{color:var(--soft)}
  .cc-hrow .hz{color:var(--muted);font-size:11px}.cc-hrow .hc{font-weight:800;font-size:11.5px;color:#334155}
  .cc-hrow .hdur{text-align:right;color:var(--soft);font-weight:600}
  .cc-hpause{font-size:11.5px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:7px;padding:4px 9px;margin:4px 0}
  .cc-after{margin-top:14px;border:1px solid #bbf7d0;background:#fbfffc;border-radius:14px;padding:14px 16px;max-width:900px}
  .cc-after .lab{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#16a34a}
  .cc-cargoline{display:flex;align-items:center;gap:12px;margin:10px 0}.cc-ar{color:var(--pri);font-weight:800}
  .cc-frow{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12.5px;padding:8px 0;border-top:1px solid var(--border)}
  .cc-frow .k{color:var(--muted)}
  .cc-vpair{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap;font-weight:600}
  .cc-vchip{display:inline-block;font-size:11.5px;font-weight:700;border-radius:999px;padding:3px 11px;background:#f1f5f9;color:#475569}
  .cc-vchip.old{background:#f1f5f9;color:#94a3b8}.cc-vchip.egr{background:#fee2e2;color:#991b1b}.cc-vchip.date{background:#eef2ff;color:#4338ca}
  .cc-rev-h{font-size:15px;line-height:1.6}
  .cc-pillA{display:inline-block;font-size:12px;font-weight:800;border-radius:8px;padding:2px 9px}
  .cc-pillA.ascenso{background:#dcfce7;color:#166534}.cc-pillA.descenso{background:#fef3c7;color:#92400e}.cc-pillA.traslado{background:#dbeafe;color:#1e40af}.cc-pillA.egreso{background:#fee2e2;color:#991b1b}.cc-pillA.lateral{background:#e2e8f0;color:#334155}
  .cc-cola{background:#fff;border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px rgba(15,23,42,.06);overflow:hidden;max-width:960px}
  .cc-cola-h{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px}
  .cc-cola-h h2{font-size:15px;font-weight:800;margin:0}.cc-cola-h .sub{font-size:12px;color:var(--muted)}
  .cc-cola-filter{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--border);flex-wrap:wrap;background:#fbfcfe}
  .cc-fchips{display:flex;gap:5px;flex-wrap:wrap}
  .cc-fchips button{border:1px solid var(--border-2);background:#fff;color:var(--soft);font-size:12px;font-weight:700;padding:6px 12px;border-radius:999px;cursor:pointer;display:flex;align-items:center;gap:6px}
  .cc-fchips button.on{background:var(--pri-soft);border-color:#ddd6fe;color:var(--pri)}
  .cc-fchips button .n{font-size:10px;font-weight:800;background:#f1f5f9;color:#64748b;border-radius:999px;padding:0 6px}
  .cc-fchips button.on .n{background:#ddd6fe;color:var(--pri)}
  .cc-cola-filter .cc-inp{flex:1;min-width:160px}
  .cc-approvebar{display:flex;align-items:center;gap:8px;font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:9px 12px;margin:12px 18px 0}
  .cc-cola-foot{padding:12px 18px;border-top:1px solid var(--border);background:#fbfcfe;font-size:11.5px;color:var(--muted)}
  .cc-mvrow{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
  .cc-mv-main{flex:1;min-width:260px}
  .cc-mv-nm{font-size:13.5px;font-weight:800}
  .cc-mv-det{font-size:12.5px;color:var(--soft);margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .cc-mv-meta{font-size:11px;color:var(--faint);margin-top:6px}
  .cc-mv-side{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
  .cc-stbadge{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;border-radius:999px;padding:3px 10px;border:1px solid}
  .cc-stbadge.sug{background:#fffbeb;color:#92400e;border-color:#fde68a}.cc-stbadge.apr{background:#ecfdf5;color:#166534;border-color:#bbf7d0}
  .cc-stbadge.exp{background:#eff6ff;color:#1e40af;border-color:#bfdbfe}.cc-stbadge.rec{background:#fef2f2;color:#991b1b;border-color:#fecaca}
  .cc-mv-acts{display:flex;gap:7px}
  .cc-sbtn{border-radius:8px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid}
  .cc-sbtn.apr{background:#f0fdf4;color:#166534;border-color:#bbf7d0}.cc-sbtn.rec{background:#fef2f2;color:#b91c1c;border-color:#fecaca}
  .cc-sbtn.exp{background:#eff6ff;color:#1e40af;border-color:#bfdbfe}.cc-sbtn.ghost{background:#fff;color:var(--muted);border-color:var(--border-2)}
  .cc-mv-wait{font-size:11.5px;color:#92400e;font-weight:600}
  .cc-date{max-width:190px}
  .cc-openf{border:1px solid var(--border-2);background:#fff;color:var(--muted);border-radius:8px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
  .cc-openf:hover{color:var(--pri);border-color:#ddd6fe;background:#fbfbff}
  .cc-flink{color:var(--pri);font-weight:700;cursor:pointer}
  .cc-selchip{display:inline-flex;align-items:center;gap:8px;font-size:12px;background:var(--pri-soft);border:1px solid #ddd6fe;color:#5b21b6;border-radius:999px;padding:4px 8px 4px 12px;margin-bottom:8px}
  .cc-selchip button{border:0;background:#ede9fe;color:#5b21b6;border-radius:999px;width:18px;height:18px;cursor:pointer;font-size:11px;line-height:1}
  .cc-stat{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;border-radius:999px;padding:2px 8px;border:1px solid;flex:none}
  .cc-stat.tmp{background:#fffbeb;color:#92400e;border-color:#fde68a}
  .cc-stat.proj{background:#eff6ff;color:#1e40af;border-color:#bfdbfe}
  .cc-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#0f172a;color:#fff;font-size:13px;font-weight:600;padding:10px 16px;border-radius:10px;box-shadow:0 6px 24px rgba(15,23,42,.25);z-index:9999;transition:opacity .3s;opacity:0}
  .cc-toast.err{background:#b91c1c}
  </style>`;
}
