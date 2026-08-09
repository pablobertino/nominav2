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
let CC_WIN = null;              // v6.114: ventana de fecha efectiva {minDate,maxDate,...}
let COMPS = null;               // tiendas del alcance (para el traslado)
let STEP = 0;
let TRAJ_OPEN = true;           // estado abierto/plegado de la trayectoria (persiste entre pasos)
let COLA_FILTER = 'todos', COLA_Q = '';
/* v6.193: rango y orden de la bandeja. Arranca en el ultimo mes porque el
   archivo se acumula para siempre; "Ver todo" lo vacia. */
const isoHoy = () => new Date().toISOString().slice(0, 10);
const isoMenos = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
let COLA_DESDE = isoMenos(30), COLA_HASTA = isoHoy(), COLA_ORD = 'recientes';
let MOVES = [];                 // historial cargado
const D = resetD();

function resetD() { return { person: null, tipo: null, cargoTo: null, empTo: '', empToLabel: '', empToConcepto: '', motivo: '', fechaEf: '', fechaB: '', fechaA: '', comentario: '' }; }

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

/* v6.192: clave de sesion con la que se cargo CAT. EL PORQUE: cerrar sesion
   NO recarga la pagina — clearSession() borra sessionStorage y go('/login')
   solo cambia el hash, asi que el modulo ES sigue vivo y CAT (variable de
   modulo) sobrevive al cambio de usuario. Con el `if (CAT) return true` de
   antes, entrar con otra cuenta seguia usando el catalogo del anterior:
   `me` equivocado (por eso "Mis sugerencias" contaba 0 estando bien) y,
   mucho peor, `my` equivocado — a un rol SIN mov.autoaprobar se le podia
   pintar "Aprobar y preparar", un boton que el backend le rechaza. */
let CAT_FOR = null;
function userKey(u) { return u ? `${u.kind || 'admin'}:${u.id || u.companyCode || ''}` : ''; }

async function ensureCat() {
  const k = userKey(USER);
  if (CAT && CAT_FOR === k) return true;
  /* v6.195: al cambiar de usuario se limpia TODO el estado de la vista, no
     solo el catalogo. Faltaban COMPS (las tiendas del alcance del anterior:
     una cuenta acotada veia tiendas ajenas en el combo de traslado), el
     borrador del wizard y los filtros de la bandeja, que quedaban escritos
     de la sesion anterior. El reload al salir ya cubre el caso normal; esto
     cubre el cambio de cuenta sin recarga. */
  if (CAT_FOR !== k) {
    CAT = null; MOVES = []; MIS_UNSEEN = new Set(); CC_WIN = null; COMPS = null;
    Object.assign(D, resetD()); STEP = 0;
    COLA_FILTER = 'todos'; COLA_Q = '';
    COLA_DESDE = isoMenos(30); COLA_HASTA = isoHoy(); COLA_ORD = 'recientes';
    APRO_PAGE = 1; APRO_SEL = null; APRO_SUB = 'list';
  }
  const c = await api({ action: 'catalog' });
  if (!c || !c.ok) {
    const b = document.getElementById('ccBody');
    if (b) b.innerHTML = `<div class="cc-empty">${esc((c && c.error) || 'No se pudo cargar Cambio de Cargo.')}</div>`;
    return false;
  }
  CAT = c;
  CAT_FOR = k;
  // v6.114: ventana de fecha efectiva (regla del sistema). Guia del wizard;
  // el server revalida al sugerir/aprobar.
  if (!CC_WIN) {
    const w = await api({ action: 'window' });
    if (w && w.ok) CC_WIN = w.window;
  }
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
    // v6.114: además de estar cargadas, las fechas deben caer en la ventana
    // (regla del sistema). Sin ventana cargada no bloquea (el server revalida).
    const inW = d => !!d && (!CC_WIN || (d >= CC_WIN.minDate && d <= CC_WIN.maxDate));
    if (D.tipo === 'traslado') return inW(D.fechaB) && inW(D.fechaA) && D.fechaA > D.fechaB;
    return inW(D.fechaEf);
  }
  return true;
};

function paintWizard() {
  const body = document.getElementById('ccBody');
  const my = CAT.my || {};
  ensureDefaults();
  // Pasos con círculos numerados + conectores, como los wizards de Reportes.
  /* v6.193: los pasos YA COMPLETADOS son clickeables. Antes, para corregir el
     tipo estando en el paso 5 habia que apretar "Atrás" cuatro veces. */
  const stepper = STEP_LABELS.map((l, i) => {
    const st = i < STEP ? 'done' : (i === STEP ? 'on' : '');
    const ir = i < STEP ? ` data-go="${i}" title="Volver a ${esc(l)}"` : '';
    const step = `<div class="cc-stp ${st}"${ir}><span class="cc-stp-c">${i < STEP ? '✓' : (i + 1)}</span><span class="cc-stp-l">${l}</span></div>`;
    const line = i < STEP_LABELS.length - 1 ? `<div class="cc-stpline ${i < STEP ? 'done' : ''}"></div>` : '';
    return step + line;
  }).join('');
  /* v6.191: DOS botones cuando se puede autoaprobar. Antes habia UNO solo,
     elegido por my.aprobar: el que podia aprobar NUNCA podia dejar algo
     sugerido, porque la opcion sencillamente no se pintaba. Dos efectos
     malos: era imposible ensayar el circuito completo desde una cuenta, y
     el atajo se tomaba siempre, incluso cuando el caso pedia que otro lo
     mirara. Ahora aprobar de una es una DECISION, no el unico camino.
     Sin mov.autoaprobar solo queda sugerir — aunque tengas mov.aprobar —
     porque en el wizard lo que estas creando es tuyo. */
  const foot = STEP === 4
    ? (my.autoaprobar
      ? `<button class="cc-btn sug cc-fin" data-k="s" style="margin-right:8px">Enviar sugerencia</button>`
        + `<button class="cc-btn apr cc-fin" data-k="a">✓ Aprobar y preparar</button>`
      : `<button class="cc-btn sug cc-fin" data-k="s">Enviar sugerencia</button>`)
    : `<button class="cc-btn next" id="ccNext" ${canNext() ? '' : 'disabled'}>Continuar →</button>`;

  body.innerHTML = `
    <div class="cc-wiz">
      <div class="cc-wh"><div><h1>Cambio de Cargo</h1><div class="sub">Paso ${STEP + 1} de 5 · ${esc(STEP_LABELS[STEP])}</div></div><span class="cc-sp"></span>${STEP > 0 || D.person ? `<button class="cc-btn back mini" id="ccCancel" title="Descartar y volver al paso 1">✕ Cancelar</button>` : ''}<a class="cc-guia" href="/guias/cambio-cargo.html" target="_blank" rel="noopener">📘 ¿Cómo funciona?</a></div>
      <div class="cc-steps">${stepper}</div>
      <div class="cc-wbody" id="ccStep"></div>
      <div class="cc-wfoot">
        <button class="cc-btn back" id="ccBack" style="visibility:${STEP === 0 ? 'hidden' : 'visible'}">← Atrás</button>
        <span class="cc-fnote">${STEP === 4 ? (my.autoaprobar ? 'Elegí: <b>sugerir</b> y que otro lo revise, o <b>aprobar</b> de una vez.' : 'Queda <b>sugerido</b> hasta que otra persona lo apruebe.') : ''}</span>
        <span class="cc-sp"></span>${foot}
      </div>
    </div>
    <div id="ccFicha"></div>`;

  document.getElementById('ccBack')?.addEventListener('click', () => { STEP = Math.max(0, STEP - 1); paintWizard(); });
  // v6.193: salir sin tener que desandar paso por paso.
  document.getElementById('ccCancel')?.addEventListener('click', () => {
    Object.assign(D, resetD()); STEP = 0; paintWizard();
  });
  document.querySelectorAll('.cc-stp[data-go]').forEach(s => s.addEventListener('click', () => {
    STEP = parseInt(s.dataset.go, 10); paintWizard();
  }));
  document.getElementById('ccNext')?.addEventListener('click', () => { if (canNext()) { STEP = Math.min(4, STEP + 1); paintWizard(); } });
  // v6.191: ya no es un id unico — pueden ser dos botones (sugerir / aprobar).
  document.querySelectorAll('.cc-fin').forEach(b => b.addEventListener('click', e => finish(e.currentTarget.dataset.k)));

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
  /* v6.192: una MISMA cedula puede traer varias filas — son sus empleos, no
     personas repetidas (MEILER 31836004: FB04 hasta el 29/06 y FB02 desde el
     30/06). Dos arreglos:
     1) los empleos CERRADOS se marcan y van al final. Antes se veian igual
        que el vigente y elegir el equivocado creaba un traslado desde una
        tienda donde la persona ya no trabaja, sin ningun aviso.
     2) la seleccion va por INDICE y no por cedula. El `rows.find(x =>
        x.id_number === ced)` devolvia SIEMPRE la primera fila de esa cedula,
        asi que hacer clic en el empleo vigente podia elegir el cerrado
        segun como viniera ordenado. */
  const vivo = p => p.is_active !== false;
  /* v6.197: los empleos CERRADOS ya no se listan acá. En v6.192 los marqué en
     vez de esconderlos, y fue media medida: un empleo terminado no puede ser
     el punto de partida de NINGUN movimiento — no se asciende, traslada ni
     egresa a alguien de una tienda que ya dejó. Mostrarlo solo servia para
     ofrecer una opcion invalida y hacer parecer duplicada a una persona que
     no lo esta. Se avisa cuántos se ocultaron, para que no sea magia. */
  const cerrados = rows.filter(p => !vivo(p)).length;
  const orden = rows.filter(vivo);
  if (!orden.length) {
    box.innerHTML = `<div class="cc-hint">${cerrados
      ? `Se encontró a esta persona, pero <b>sin empleo vigente</b> (${cerrados} empleo${cerrados === 1 ? '' : 's'} ya cerrado${cerrados === 1 ? '' : 's'}). No se le puede cargar un movimiento.`
      : 'Sin resultados.'}</div>`;
    return;
  }
  box.innerHTML = orden.slice(0, 40).map((p, i) => {
    const cargoTxt = norm(p.role) || '';
    const ini = (norm(p.full_name) || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const on = D.person && D.person.id_number === p.id_number && D.person.company_code === p.company_code;
    const av = p.thumb_url ? `<img src="${esc(p.thumb_url)}" alt="">` : esc(ini);
    const zsc = [p.zona, p.subzona, p.concepto].filter(Boolean).map(esc).join(' · ');
    // v6.193: el "ya hay un cambio en curso" saltaba recien al enviar, con los
    // cinco pasos llenos. Ahora se ve acá, antes de empezar.
    const curso = enCursoDe(p.id_number);
    return `<div class="cc-prow ${on ? 'on' : ''}${curso ? ' encurso' : ''}" data-i="${i}">
      <div class="cc-pav">${av}</div>
      <div style="flex:1"><div class="cc-pnm">${esc(p.full_name || '')}${curso ? ` <span class="cc-encurso">YA TIENE UN ${esc(String(curso).toUpperCase())} EN CURSO</span>` : ''}</div>
        <div class="cc-pmeta">V-${esc(p.id_number)}${p.company_code ? ' · ' + esc(p.company_code) : ''}${p.company_name ? ' ' + esc(p.company_name) : ''}</div>
        ${zsc ? `<div class="cc-pmeta">${zsc}</div>` : ''}</div>
      <span class="cc-pcargo">${esc(cargoTxt)}</span>
      <button class="cc-openf" data-i="${i}" title="Ver ficha completa">${IC_FICHA}</button></div>`;
  }).join('')
    + (cerrados ? `<div class="cc-hint" style="margin-top:8px">No se muestra${cerrados === 1 ? '' : 'n'} <b>${cerrados} empleo${cerrados === 1 ? '' : 's'} ya cerrado${cerrados === 1 ? '' : 's'}</b>: un movimiento se carga siempre desde el empleo vigente. El historial completo está en la ficha.</div>` : '');
  box.querySelectorAll('.cc-prow').forEach(row => row.addEventListener('click', e => {
    if (e.target.closest('.cc-openf')) return;
    pickPerson(orden[parseInt(row.dataset.i, 10)]);
  }));
  box.querySelectorAll('.cc-openf').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const p = orden[parseInt(btn.dataset.i, 10)];
    if (p) openFichaFor(p);
  }));
}
// Mismo icono "Ver ficha" que Buscar / Datos incompletos (tarjeta de persona).
const IC_FICHA = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="10" r="2"/><path d="M13 9h5M13 13h5M6.5 15.5c.4-1.2 1.4-2 2.5-2s2.1.8 2.5 2"/></svg>';
function openFichaFor(p, back) {
  const cc = p.company_code || (D.person && D.person.company_code);
  if (!cc) { toast('No pude abrir la ficha: falta la empresa.', true); return; }
  renderWorkerPhotos(USER, cc, back || (() => renderCambioCargo(USER)), { mode: 'store', openCed: p.id_number });
}
/* v6.193: ¿esta persona ya tiene un movimiento sugerido/aprobado sin resolver?
   Lo manda `catalog` en en_curso. La validacion de verdad sigue en el backend
   al enviar: esto es para no hacerte llenar cinco pasos al pedo. */
function enCursoDe(ced) {
  const m = (CAT && CAT.en_curso) || {};
  return m[String(ced)] || null;
}
function pickPerson(p) {
  const curso = enCursoDe(p && p.id_number);
  if (curso) {
    toast(`${p.full_name || 'Esta persona'} ya tiene un ${curso} en curso. Resolvé o anulá ese antes de crear otro.`, true);
    return;
  }
  // Mapea el cargo de texto del roster a un code de cargos (mejor esfuerzo).
  D.person = {
    id_number: p.id_number, full_name: p.full_name || '', role_text: norm(p.role) || '',
    company_code: p.company_code || '', business_name: p.company_name || '',
    concepto: p.concepto || '', zona: p.zona || '', subzona: p.subzona || '',
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
  /* v6.194: el aviso del candado solo si el rol TIENE tope. Al coordinador
     (min_assign_level 0) y al superadmin (-1) les decia "solo puedes asignar
     cargos por debajo del tuyo" cuando pueden asignar todos: un permiso que
     no existe, anunciado como si existiera. */
  const tope = CAT && Number(CAT.assign_min_level);
  const roleNote = (tope > 0)
    ? `<div class="cc-hint" style="margin-top:8px">🔒 Como <b>${esc(roleLabel())}</b> solo puedes asignar cargos por debajo del tuyo (se configura por rol).</div>`
    : '';
  if (D.tipo === 'ascenso' || D.tipo === 'descenso') {
    const opts = targetsFor(D.person, D.tipo);
    if (!opts.length) { el.innerHTML = `<div class="cc-warn err">No hay cargos que tu rol pueda asignar para este ${D.tipo}. Debe hacerlo un rol superior.</div>`; return; }
    /* v6.192: el cargo nuevo es LA decision de este paso; hasta ahora era un
       combo igual a cualquier otro y se perdia en la pantalla. */
    el.innerHTML = `<div class="cc-fld cc-hero ${esc(D.tipo)}"><label>Nuevo cargo</label>
      <select id="ccCargo" class="cc-sel-hero">${opts.map(c => `<option value="${c.code}" ${c.code === D.cargoTo ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>${roleNote}</div>`;
    document.getElementById('ccCargo').addEventListener('change', e => { D.cargoTo = e.target.value; paintFicha(); syncNext(); });
    return;
  }
  if (D.tipo === 'traslado') {
    const opts = targetsFor(D.person, 'traslado');
    const selChip = D.empTo
      ? `<div class="cc-selchip">Destino: <b>${esc(D.empTo)}</b>${D.empToLabel ? ' · ' + esc(D.empToLabel) : ''} <button id="ccEmpClear" title="Cambiar">✕</button></div>`
      : '';
    /* v6.193: COMBO en vez de lista larga. Antes era un buscador con una lista
       de hasta 50 filas que empujaba todo el paso hacia abajo. El combo va
       agrupado por ZONA (<optgroup>): con ~180 tiendas, una lista plana
       alfabetica no ayuda a encontrar nada; la zona sí. El buscador queda
       como filtro opcional del combo, no como forma de elegir. */
    el.innerHTML = `<div class="cc-fld"><label>Empresa/tienda destino</label>
        ${selChip}
        <input class="cc-inp" id="ccEmpToQ" placeholder="Filtrar por alias, razón social, zona, subzona o concepto…" autocomplete="off">
        <select class="cc-inp cc-empsel" id="ccEmpToSel"><option value="">Cargando tiendas…</option></select>
        <div class="cc-hint" id="ccEmpToCnt" style="margin-top:6px"></div></div>
      <div class="cc-fld cc-hero traslado"><label>Cargo en destino</label>
        <select id="ccCargo" class="cc-sel-hero">${opts.map(c => `<option value="${c.code}" ${c.code === (D.cargoTo || D.person.cargo_code) ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
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
  const sel = document.getElementById('ccEmpToSel');
  const cnt = document.getElementById('ccEmpToCnt');
  if (!sel) return;
  const list = COMPS || [];
  const qq = norm(q).toLowerCase();
  const originCode = D.person && D.person.company_code;
  const f = (qq ? list.filter(c => [c.code, c.business_name, c.zona, c.subzona, c.concepto].some(v => String(v || '').toLowerCase().includes(qq))) : list)
    .filter(c => c.code !== originCode);
  if (!f.length) {
    sel.innerHTML = `<option value="">Sin tiendas que coincidan en tu alcance</option>`;
    if (cnt) cnt.textContent = '';
    return;
  }
  // Agrupadas por zona, y dentro por codigo. Es como la gente las busca.
  const porZona = new Map();
  f.forEach(c => {
    const z = c.zona || 'Sin zona';
    if (!porZona.has(z)) porZona.set(z, []);
    porZona.get(z).push(c);
  });
  const zonas = [...porZona.keys()].sort((a, b) => a.localeCompare(b, 'es'));
  sel.innerHTML = `<option value="">— Elegí la tienda destino —</option>`
    + zonas.map(z => `<optgroup label="${esc(z)}">`
      + porZona.get(z).sort((a, b) => String(a.code).localeCompare(String(b.code)))
        .map(c => `<option value="${esc(c.code)}" ${D.empTo === c.code ? 'selected' : ''}>${esc(c.code)} · ${esc(c.business_name || '')}${c.subzona ? ' · ' + esc(c.subzona) : ''}${c.concepto ? ' · ' + esc(c.concepto) : ''}${statusTxt(c.status)}</option>`).join('')
      + `</optgroup>`).join('');
  if (cnt) cnt.textContent = `${f.length} tienda${f.length === 1 ? '' : 's'} en tu alcance${qq ? ' con ese filtro' : ''}.`;
  sel.onchange = () => {
    const c = (COMPS || []).find(x => x.code === sel.value);
    if (!c) { D.empTo = ''; D.empToLabel = ''; D.empToConcepto = ''; syncNext(); return; }
    D.empTo = c.code; D.empToLabel = c.business_name || ''; D.empToConcepto = c.concepto || '';
    paintStep(); paintFicha(); syncNext();
  };
}
/* v6.193: al pasar la lista de tiendas a un <select>, el badge de estado ya no
   cabe como HTML — pero no se puede perder: una "Proyectada" (FA05, por caso)
   se veria igual que una abierta. Va como texto dentro de la opcion. */
function statusTxt(st) {
  if (st === 'Cerrada temporal') return '  ⚠ CERRADA TEMPORAL';
  if (st === 'Proyectada') return '  ⚠ PROYECTADA';
  return '';
}

/* --- paso Fecha --- */
function stepFecha(el) {
  // v6.114: min/max de la ventana (regla del sistema). Fallback sin límites si
  // aún no cargó; el server revalida igual.
  const mn = CC_WIN ? CC_WIN.minDate : '';
  const mx = CC_WIN ? CC_WIN.maxDate : '';
  const at = (a, b) => `${a ? ` min="${a}"` : ''}${b ? ` max="${b}"` : ''}`;
  const rule = CC_WIN
    ? `<div class="cc-hint">📅 Fecha permitida: del <b>${fmt(mn)}</b> al <b>${fmt(mx)}</b> (corte de quincena hacia atrás · hasta ${CC_WIN.futuroDias} días a futuro).</div>`
    : `<div class="cc-hint">📅 Regla del sistema (corte de la quincena).</div>`;
  if (D.tipo === 'traslado') {
    const bMax = mx ? addDaysIso(mx, -1) : '';               // deja lugar al +1 en destino
    const aMin = D.fechaB ? addDaysIso(D.fechaB, 1) : mn;     // destino: día siguiente al origen
    el.innerHTML = `<div class="cc-grid2">
        <div class="cc-fld"><label>Último día en origen</label><input class="cc-inp cc-date" type="date" id="ccFB" value="${esc(D.fechaB)}"${at(mn, bMax)}></div>
        <div class="cc-fld"><label>Primer día en destino</label><input class="cc-inp cc-date" type="date" id="ccFA" value="${esc(D.fechaA)}"${at(aMin, mx)}></div>
      </div>${rule}`;
    document.getElementById('ccFB').addEventListener('change', e => { D.fechaB = e.target.value; if (!D.fechaA || D.fechaA <= D.fechaB) D.fechaA = addDaysIso(D.fechaB, 1); paintStep(); paintFicha(); syncNext(); });
    document.getElementById('ccFA').addEventListener('change', e => { D.fechaA = e.target.value; paintFicha(); syncNext(); });
    return;
  }
  el.innerHTML = `<div class="cc-fld"><label>${D.tipo === 'egreso' ? 'Fecha de egreso' : 'Fecha efectiva'}</label>
      <input class="cc-inp cc-date" type="date" id="ccFE" value="${esc(D.fechaEf)}"${at(mn, mx)}></div>${rule}`;
  document.getElementById('ccFE').addEventListener('change', e => { D.fechaEf = e.target.value; paintFicha(); syncNext(); });
}
function addDaysIso(iso, d) { const t = Date.parse(iso + 'T00:00:00Z'); const nd = new Date(t + d * 86400000); return nd.toISOString().slice(0, 10); }

/* --- paso Revisión --- */
function stepRevision(el) {
  const p = D.person;
  const T = { ascenso: 'ASCENSO', descenso: 'DESCENSO', traslado: 'TRASLADO', egreso: 'EGRESO' }[D.tipo];
  const fEf = fmt(D.tipo === 'traslado' ? D.fechaA : D.fechaEf);
  // Un traslado que ademas cambia de cargo es tambien ascenso o descenso.
  let extra = '';
  if (D.tipo === 'traslado' && D.cargoTo && D.cargoTo !== p.cargo_code) {
    const a = cargoBy(p.cargo_code), b = cargoBy(D.cargoTo);
    if (a && b && b.hier_level < a.hier_level) extra = ` <span class="cc-pillA ascenso">ASCENSO</span>`;
    else if (a && b && b.hier_level > a.hier_level) extra = ` <span class="cc-pillA descenso">DESCENSO</span>`;
  }
  el.innerHTML = `<div class="cc-after">
      <div class="cc-rev-h">${esc(p.full_name)} <span class="cc-pillA ${D.tipo}">${T}</span>${extra}</div>
      <div class="cc-hint" style="font-size:13px;margin-top:6px">${fraseHtml(p)}. Efectivo el <b>${fEf}</b>.</div>
      <div class="cc-hint" style="margin-top:10px">${CAT.my.autoaprobar
        ? 'Abajo elegís: <b>Enviar sugerencia</b> (queda pendiente de que alguien más la revise) o <b>Aprobar y preparar</b> (se genera el ticket ya).'
        : 'Al confirmar queda <b>sugerido</b>, pendiente de aprobación. Nadie aprueba su propia sugerencia.'} La plantilla AX se descarga después, desde el Historial.</div>
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
          <div class="cc-grp">${esc(p.company_code)} ${esc(p.business_name)}</div>
        </div>
        <button class="cc-openf" id="ccOpenFicha" title="Ver ficha completa">${IC_FICHA}</button></div>
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
  // Concepto: en traslado, origen → destino (muchos cambian de concepto, p.ej.
  // MR PRICE → SHOE BOX). En el resto, el concepto de la tienda (informativo).
  const cptFrom = p.concepto || '';
  const cptTo = D.tipo === 'traslado' ? (D.empToConcepto || '') : cptFrom;
  const cptChg = D.tipo === 'traslado' && cptTo && cptFrom && cptTo !== cptFrom;
  const conceptVal = cptChg
    ? `<span class="cc-vchip old">${esc(cptFrom)}</span><span class="cc-ar">→</span><span class="cc-vchip">${esc(cptTo)}</span>`
    : `<span class="cc-vchip">${esc(cptTo || cptFrom || '—')}</span>`;
  return `<div class="cc-after"><div class="lab">Ficha nueva</div>${cargoLine}
    <div class="cc-frow"><span class="k">Empresa · Tienda</span><span class="cc-vpair">${empVal}</span></div>
    <div class="cc-frow"><span class="k">Concepto</span><span class="cc-vpair">${conceptVal}</span></div>
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
      <span class="hcon">${it.concepto ? `<em title="Concepto en ese momento">${esc(it.concepto)}</em>` : ''}</span>
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
    + `<div style="font-size:11px;color:#94a3b8;margin-top:5px">Razón social y <span style="color:#0e7490">concepto</span> del momento según el sistema · el empleo vigente muestra los datos actuales. En blanco cuando no hay histórico.</div>`;
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
  /* v6.191: hay que bloquear LOS DOS botones mientras guarda, no solo el
     que se apreto: si no, se puede sugerir y aprobar el mismo movimiento
     con dos clics seguidos. Se guarda el texto original para devolverlo
     tal cual si falla, en vez de reconstruirlo a mano. */
  const btns = Array.from(document.querySelectorAll('.cc-fin'));
  const btn = btns.find(b => b.dataset.k === k) || null;
  const label0 = btn ? btn.textContent : '';
  btns.forEach(b => { b.disabled = true; });
  if (btn) btn.textContent = 'Guardando…';
  const r = await api({ action: 'suggest', items: [item], approve: k === 'a' });
  if (!r || !r.ok) {
    btns.forEach(b => { b.disabled = false; });
    if (btn) btn.textContent = label0;
    toast((r && r.error) || 'No se pudo guardar el movimiento.', true);
    return;
  }
  Object.assign(D, resetD());
  STEP = 0;
  if (k === 'a') {
    const rep = (r.reported && r.reported[0]) || null;
    if (rep && rep.ok) {
      toast(rep.osticket_id ? `Aprobado. Ticket #${rep.osticket_id} generado — velo en Reportes → Historial.` : 'Aprobado y reportado. Velo en Reportes → Historial.');
    } else if (rep && !rep.ok) {
      toast('Guardado como aprobado, pero el reporte no se generó: ' + (rep.error || ''), true);
    } else {
      toast('Aprobado.');
    }
    paintWizard();
  } else {
    toast('Sugerencia enviada. Queda pendiente de aprobación.');
    gotoHistorial();
  }
}

/* =====================================================================
   APROBACIONES — bandeja donde se revisa la sugerencia y, al aprobar, se
   DISPARA el reporte + ticket (Reportes → Historial).
   ===================================================================== */
const TIPO_LB = { ascenso: 'Ascenso', descenso: 'Descenso', lateral: 'Lateral', traslado: 'Traslado', egreso: 'Egreso' };
// v6.192: "Sugeridos" y no "Pendientes" — nombra lo que la fila ES, no lo que le falta.
const APRO_FILTERS = [['sugerido', 'Sugeridos'], ['reportado', 'Aprobados'], ['rechazado', 'Rechazados'], ['vencido', 'Vencidos'], ['anulado', 'Anulados'], ['mias', 'Mis sugerencias']];
const APRO_PER = 8;
let APRO_PAGE = 1, APRO_SEL = null, APRO_SUB = 'list';   // 'list' | 'detail'

let MIS_UNSEEN = new Set();   // v6.117: ids de mis sugerencias resueltas sin ver
async function loadCola() {
  const r = await api({ action: 'list', estado: 'todos', desde: COLA_DESDE || undefined, hasta: COLA_HASTA || undefined });
  if (r && r.ok && r.window) CC_WIN = r.window;   // v6.193: para marcar vencidas
  MOVES = (r && r.ok && r.rows) ? r.rows : [];
  // v6.117: qué sugerencias mías se resolvieron y no vi (para el contador).
  if (CAT && CAT.my && CAT.my.sugerir) {
    const ms = await api({ action: 'mis_sug' });
    MIS_UNSEEN = new Set((ms && ms.ok ? (ms.items || []) : []).filter(x => x.unseen).map(x => x.id));
  } else MIS_UNSEEN = new Set();
}
function aproMiasUnseen() { return MIS_UNSEEN.size; }
async function paintCola() {
  const body = document.getElementById('ccBody');
  body.innerHTML = `<div class="cc-cola"><div class="cc-loading">Cargando…</div></div>`;
  // v6.117: si venimos desde la campanita (aviso violeta), abrir en Mis sugerencias.
  if (window.__ccOpenMias) { window.__ccOpenMias = false; COLA_FILTER = 'mias'; }
  if (!['sugerido', 'reportado', 'rechazado', 'vencido', 'anulado', 'mias'].includes(COLA_FILTER)) COLA_FILTER = 'sugerido';
  await loadCola();
  // v6.117: al entrar directo a "Mis sugerencias", marcarlas vistas.
  if (COLA_FILTER === 'mias' && MIS_UNSEEN.size) {
    MIS_UNSEEN = new Set();
    try { await api({ action: 'mis_sug', mark_seen: true }); } catch (_) {}
    try { window.__pnlBellRefresh && window.__pnlBellRefresh(); } catch (_) {}
  }
  if (APRO_SUB === 'detail' && MOVES.find(m => m.id === APRO_SEL)) renderDetail();
  else { APRO_SUB = 'list'; renderApro(); }
}
function aproCnt(est) {
  if (est === 'mias') { const me = CAT && CAT.me; return me ? MOVES.filter(m => m.suggested_by === me).length : 0; }
  return MOVES.filter(m => m.estado === est).length;
}
/* v6.193: criterios de orden. El default sigue siendo "recientes" para no
   cambiarle la bandeja a nadie de un dia para el otro. */
const ORDENES = [
  ['recientes', 'Más recientes primero'],
  ['antiguas', 'Más antiguas primero'],
  ['nombre', 'Nombre (A-Z)'],
  ['tipo', 'Tipo de movimiento'],
  ['tienda', 'Tienda'],
];
function aproSort(list) {
  const t = m => Date.parse(m.created_at || 0) || 0;
  const s = (a, b) => String(a || '').localeCompare(String(b || ''), 'es');
  const out = list.slice();
  if (COLA_ORD === 'antiguas') out.sort((a, b) => t(a) - t(b));
  else if (COLA_ORD === 'nombre') out.sort((a, b) => s(a.full_name, b.full_name));
  else if (COLA_ORD === 'tipo') out.sort((a, b) => s(a.tipo, b.tipo) || t(b) - t(a));
  else if (COLA_ORD === 'tienda') out.sort((a, b) => s(a.empresa_origen, b.empresa_origen) || t(b) - t(a));
  else out.sort((a, b) => t(b) - t(a));
  return out;
}
function aproFiltered() {
  const me = CAT && CAT.me;
  const base = COLA_FILTER === 'mias'
    ? MOVES.filter(m => me && m.suggested_by === me)
    : MOVES.filter(m => m.estado === COLA_FILTER);
  return aproSort(base.filter(m => !COLA_Q || (m.full_name || '').toLowerCase().includes(COLA_Q) || (m.id_number || '').includes(COLA_Q) || ((m.empresa_origen || '') + ' ' + (m.rz || '')).toLowerCase().includes(COLA_Q)));
}
/* v6.193: la fecha que se le paso a un movimiento vencido (la misma que el
   backend mira: baja+alta en traslado, baja en egreso, efectiva en el resto). */
function vencFecha(mv) {
  const f = mv.tipo === 'traslado' ? [mv.fecha_baja, mv.fecha_alta]
    : mv.tipo === 'egreso' ? [mv.fecha_baja] : [mv.fecha_efectiva];
  return f.filter(Boolean).map(d => fmt(String(d).slice(0, 10))).join(' y ');
}
function iniOf(n) { return (String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?').toUpperCase(); }
function avatarHtml(mv, big) {
  const cls = big ? 'cc-apav big' : 'cc-apav';
  if (mv.thumb_url) return `<div class="${cls}"><img src="${esc(mv.thumb_url)}" alt=""></div>`;
  return `<div class="${cls}" style="background:linear-gradient(135deg,#e5e7eb,#cbd5e1);color:#475569">${iniOf(mv.full_name)}</div>`;
}
/* ---------- LISTA (mini-fichas, estilo Buscar) ---------- */
function renderApro() {
  const body = document.getElementById('ccBody');
  // v6.117: "Mis sugerencias" solo para quien puede sugerir; su contador
  // resalta las no-vistas (violeta).
  const canSug = !!(CAT && CAT.my && CAT.my.sugerir);
  const chips = APRO_FILTERS.filter(([f]) => f !== 'mias' || canSug).map(([f, l]) => {
    const nUnseen = f === 'mias' ? aproMiasUnseen() : 0;
    const n = f === 'mias' ? aproCnt('mias') : aproCnt(f);
    return `<button data-f="${f}" class="${COLA_FILTER === f ? 'on' : ''}${f === 'mias' && nUnseen ? ' has-new' : ''}">${l}<span class="n">${n}</span></button>`;
  }).join('');
  const pend = aproCnt('sugerido');
  body.innerHTML = `<div class="cc-apro">
    <div class="cc-apro-head"><h2>Aprobaciones</h2>${pend ? `<span class="cc-cnt">${pend} pendiente${pend === 1 ? '' : 's'}</span>` : ''}<span class="cc-sp"></span><a class="cc-guia" href="/guias/cambio-cargo.html" target="_blank" rel="noopener">📘 ¿Cómo funciona?</a><span class="cc-hint">Al aprobar se genera el reporte y su <b>ticket</b> → Reportes · Historial</span></div>
    <div class="cc-apro-filters"><div class="cc-fchips">${chips}</div><input class="cc-inp" id="ccAQ" placeholder="Buscar por nombre, cédula o tienda…" value="${esc(COLA_Q)}"></div>
    <div class="cc-apro-rango">
      <span class="lb">Desde</span><input type="date" class="cc-inp d" id="ccADesde" value="${esc(COLA_DESDE)}">
      <span class="lb">Hasta</span><input type="date" class="cc-inp d" id="ccAHasta" value="${esc(COLA_HASTA)}">
      <button class="cc-btn back mini" id="ccARangoAll" title="Quitar el filtro de fechas">Ver todo</button>
      <span class="cc-sp"></span>
      <span class="lb">Ordenar</span>
      <select class="cc-inp o" id="ccAOrd">${ORDENES.map(([v, l]) => `<option value="${v}" ${COLA_ORD === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
    </div>
    <div class="cc-rangonote">El rango aplica al <b>archivo</b> (aprobados, rechazados, anulados y vencidos). Los <b>sugeridos</b> se muestran siempre completos: son la cola de trabajo y esconderlos por fecha es como se pierden.</div>
    <div id="ccAList"></div><div class="cc-pager" id="ccAPager"></div>
  </div>`;
  body.querySelectorAll('.cc-fchips button').forEach(b => b.addEventListener('click', async () => {
    COLA_FILTER = b.dataset.f; APRO_PAGE = 1;
    // v6.117: al abrir "Mis sugerencias" se marcan vistas (baja el aviso violeta).
    if (COLA_FILTER === 'mias' && MIS_UNSEEN.size) {
      MIS_UNSEEN = new Set();
      try { await api({ action: 'mis_sug', mark_seen: true }); } catch (_) {}
      try { window.__pnlBellRefresh && window.__pnlBellRefresh(); } catch (_) {}
    }
    renderApro();
  }));
  document.getElementById('ccAQ').addEventListener('input', e => { COLA_Q = e.target.value.toLowerCase(); APRO_PAGE = 1; renderAList(); });
  // v6.193: cambiar el rango recarga del server (el recorte es del lado del
  // server, si no el limite de 500 filas seguiria mordiendo igual).
  const recargar = async () => { APRO_PAGE = 1; await loadCola(); renderApro(); };
  document.getElementById('ccADesde')?.addEventListener('change', e => { COLA_DESDE = e.target.value; recargar(); });
  document.getElementById('ccAHasta')?.addEventListener('change', e => { COLA_HASTA = e.target.value; recargar(); });
  document.getElementById('ccARangoAll')?.addEventListener('click', () => { COLA_DESDE = ''; COLA_HASTA = ''; recargar(); });
  document.getElementById('ccAOrd')?.addEventListener('change', e => { COLA_ORD = e.target.value; APRO_PAGE = 1; renderAList(); });
  renderAList();
}
function renderAList() {
  const el = document.getElementById('ccAList'); if (!el) return;
  const list = aproFiltered();
  const pages = Math.max(1, Math.ceil(list.length / APRO_PER));
  if (APRO_PAGE > pages) APRO_PAGE = pages;
  const slice = list.slice((APRO_PAGE - 1) * APRO_PER, APRO_PAGE * APRO_PER);
  const my = CAT.my || {};
  const me = String((CAT && CAT.me) || '');
  el.innerHTML = slice.length ? slice.map(mv => {
    const loc = [mv.empresa_origen, mv.rz, mv.zona, mv.subzona, mv.concepto].filter(Boolean).map(esc).join(' · ');
    /* v6.192: aprobar sin entrar al detalle. Misma regla que adentro: si la
       sugerencia es tuya y no tenes mov.autoaprobar, el boton NO se pinta
       (mostrarlo deshabilitado seria una trampa, y el backend lo rechaza). */
    const puedo = mv.estado === 'sugerido' && my.aprobar
      && (my.autoaprobar || String(mv.suggested_by || '') !== me);
    return `<div class="cc-acard" data-id="${mv.id}">
      ${avatarHtml(mv)}
      <div style="flex:1;min-width:0">
        <div class="cc-anm">${esc(mv.full_name || ('V-' + mv.id_number))} <span class="cc-pillA ${mv.tipo}">${esc((TIPO_LB[mv.tipo] || mv.tipo).toUpperCase())}</span> <button class="cc-openf inline" data-fic="${mv.id}" title="Ver ficha completa">${IC_FICHA}</button></div>
        <div class="cc-adet">${mvDetail(mv)}</div>
        <div class="cc-aloc"><b class="ced">V-${esc(mv.id_number)}</b>${loc ? ' · ' + loc : ''}</div>
        <div class="cc-amt"><span class="cc-sugby">✎ Sugirió <b>${esc(mv.suggested_by || '—')}</b></span>${mv.estado === 'reportado' ? ` <span class="cc-mini apr">✓ Aprobó: ${esc(mv.approved_by || '—')}</span>${mv.osticket_id ? ` <span class="cc-mini tk">Ticket #${esc(mv.osticket_id)}</span>` : ''}` : mv.estado === 'rechazado' ? ` <span class="cc-mini rec">✕ Rechazó: ${esc(mv.rejected_by || '—')}</span>` : mv.estado === 'vencido' ? ` <span class="cc-mini venc">⌛ Vencida${vencFecha(mv) ? ' · fecha ' + esc(vencFecha(mv)) : ''}</span>` : ` <span class="cc-mini pend">⏳ Sin aprobar</span>`}</div>
      </div>
      <div class="cc-acta">
        ${puedo ? `<button class="cc-btn apr cc-quickapr" data-apr="${mv.id}">✓ Aprobar</button>` : ''}
        ${mv.estado === 'sugerido' && my.aprobar ? `<button class="cc-btn back cc-quickrej" data-rej="${mv.id}">✕ Rechazar</button>` : ''}
        ${my.anular && ['aprobado', 'reportado', 'exportado'].includes(mv.estado) ? `<button class="cc-btn danger cc-quickanu" data-anu="${mv.id}">⊘ Anular</button>` : ''}
      </div>
    </div>`;
  }).join('') : `<div class="cc-acard" style="cursor:default"><span class="cc-hint">${COLA_FILTER === 'sugerido' ? 'No hay sugerencias pendientes.' : 'Nada aquí.'}</span></div>`;
  el.querySelectorAll('.cc-quickapr').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const mv = MOVES.find(x => x.id === parseInt(b.dataset.apr, 10));
    if (mv) quickApprove(mv);
  }));
  // v6.193: rechazar tambien desde la lista. Una bandeja donde podes decir
  // que si pero no que no esta coja. Rechazar lo propio SI se permite.
  el.querySelectorAll('.cc-quickrej').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const id = parseInt(b.dataset.rej, 10);
    const reason = await ccPrompt('Motivo del rechazo (opcional):', 'Rechazar');
    if (reason === null) return;
    const r = await api({ action: 'reject', id, reason: reason || undefined });
    if (!r || !r.ok) return toast((r && r.error) || 'No se pudo rechazar.', true);
    await loadCola(); renderApro();
    toast('Sugerencia rechazada.');
  }));
  // v6.197: anular tambien desde la lista. Mismo criterio que aprobar y
  // rechazar: entrar al detalle para cada accion rutinaria es peaje.
  el.querySelectorAll('.cc-quickanu').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const mv = MOVES.find(x => x.id === parseInt(b.dataset.anu, 10));
    if (mv) anularMove(mv, true);
  }));
  el.querySelectorAll('.cc-acard[data-id]').forEach(c => c.addEventListener('click', e => {
    // v6.196: la ficha se mudo al lado del nombre, fuera de .cc-acta.
    if (e.target.closest('.cc-acta, .cc-openf')) return;
    showDetail(parseInt(c.dataset.id, 10));
  }));
  el.querySelectorAll('.cc-openf').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const mv = MOVES.find(x => x.id === parseInt(b.dataset.fic, 10));
    if (mv) openFichaFor({ id_number: mv.id_number, company_code: mv.empresa_origen }, () => renderCambioCargoHist(USER));
  }));
  const pg = document.getElementById('ccAPager');
  if (pg) pg.innerHTML = pages > 1
    ? `<button ${APRO_PAGE <= 1 ? 'disabled' : ''} id="aprPrev">‹ Anterior</button><span>Página ${APRO_PAGE} de ${pages} · ${list.length} en total</span><button ${APRO_PAGE >= pages ? 'disabled' : ''} id="aprNext">Siguiente ›</button>`
    : `<span>${list.length} ${list.length === 1 ? 'sugerencia' : 'sugerencias'}</span>`;
  document.getElementById('aprPrev')?.addEventListener('click', () => { APRO_PAGE--; renderAList(); });
  document.getElementById('aprNext')?.addEventListener('click', () => { APRO_PAGE++; renderAList(); });
}
function showDetail(id) { APRO_SEL = id; APRO_SUB = 'detail'; renderDetail(); }
function backToList() { APRO_SUB = 'list'; renderApro(); }

/* ---------- DETALLE (página aparte con Volver) ----------
   Reproduce el estilo de la ficha del empleado: cabecera con nombre en peso
   normal, cédula, chips, línea de empresa y trayectoria COLAPSABLE idéntica a
   la ficha. Debajo el cambio propuesto y un bloque que separa con claridad
   QUIÉN SUGIRIÓ de QUIÉN APROBÓ / RECHAZÓ (son cosas distintas). */
async function renderDetail() {
  const body = document.getElementById('ccBody');
  const mv = MOVES.find(x => x.id === APRO_SEL);
  if (!mv) { backToList(); return; }
  const my = CAT.my || {};
  /* v6.191: el segundo par de ojos, tambien acá. Sin esto el bloqueo del
     wizard seria decorativo: bastaba sugerir, entrar a Aprobaciones y
     aprobarse uno mismo. Rechazar la propia SI se permite: eso es cancelar
     lo que uno mismo propuso, no hay conflicto de interés. */
  const esMia = String(mv.suggested_by || '') === String(CAT.me || '');
  const puedoAprobarEsta = my.aprobar && (my.autoaprobar || !esMia);
  const ini = iniOf(mv.full_name);
  const av = mv.thumb_url ? `<img src="${esc(mv.thumb_url)}" alt="">` : esc(ini);
  const cargoTxt = mv.cargo_from ? esc(cargoLabel(mv.cargo_from)).toUpperCase() : '';
  const grp = [mv.empresa_origen, mv.rz].filter(Boolean).map(esc).join(' ');
  const zsc = [mv.zona, mv.subzona, mv.concepto].filter(Boolean).map(esc).join(' · ');
  // v6.115: botón Anular (gate mov.anular) para movimientos ya aprobados/reportados.
  const anularHtml = (my.anular && ['aprobado', 'reportado', 'exportado'].includes(mv.estado))
    ? `<div class="cc-anular-box"><button class="cc-btn danger" id="ccAAnular">⊘ Anular movimiento</button>`
      + `<div class="cc-anular-note">No revierte el sistema por sí solo: coordiná con <b>Capital Humano</b> para que cierren el ticket sin ejecutarlo (o lo reviertan si aún no lo hicieron). Acá queda marcado como <b>anulado</b>.</div></div>`
    : '';
  body.innerHTML = `
    <button class="cc-btn back cc-backbtn" id="ccBackList">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      Volver a Aprobaciones
    </button>
    <div class="cc-cmp-h">Revisión de la sugerencia</div>
    <div class="cc-fichaFull">
      <div class="cc-top">
        <div class="cc-pav big" id="ccDetPav" ${mv.thumb_url ? 'style="cursor:zoom-in"' : ''}>${av}</div>
        <div class="cc-ffid">
          <h2>${esc(mv.full_name || ('V-' + mv.id_number))}</h2>
          <div class="cc-ced">V-${esc(mv.id_number)}</div>
          <div class="cc-meta"><span class="cc-pill act" title="Vigente a la fecha">Activo</span>${cargoTxt ? `<span class="cc-pill">${cargoTxt}</span>` : ''}<span class="cc-pillA ${mv.tipo}">${esc((TIPO_LB[mv.tipo] || mv.tipo).toUpperCase())}</span></div>
          <div class="cc-grp">${grp}${zsc ? ` · <span style="color:var(--muted)">${zsc}</span>` : ''}</div>
        </div>
        <button class="cc-openf" id="ccAFicha" title="Ver ficha completa">${IC_FICHA}</button>
      </div>
      <div id="ccATraj"><div class="cc-hint" style="margin-top:12px">Cargando trayectoria…</div></div>
    </div>

    <div class="cc-after" style="margin-top:14px;border-color:#ddd6fe;background:var(--pri-soft)">
      <div class="lab" style="color:var(--pri)">Cambio propuesto</div>
      ${aproAfter(mv)}
    </div>

    <div class="cc-whoblock">
      <div class="cc-whorow"><span class="cc-whoic sug">✎</span><div><div class="cc-whok">Sugerido por</div><div class="cc-whov">${esc(mv.suggested_by || '—')}${mv.created_at ? ` · <span class="cc-whod">${fmt(mv.created_at)}</span>` : ''}</div>${mv.comentario ? `<div class="cc-whocom">“${esc(mv.comentario)}”</div>` : ''}</div></div>
      ${mv.estado === 'reportado' ? `<div class="cc-whorow"><span class="cc-whoic apr">✓</span><div><div class="cc-whok">Aprobado por</div><div class="cc-whov">${esc(mv.approved_by || '—')}${mv.approved_at ? ` · <span class="cc-whod">${fmt(mv.approved_at)}</span>` : ''}</div></div></div>` : ''}
      ${mv.estado === 'rechazado' ? `<div class="cc-whorow"><span class="cc-whoic rec">✕</span><div><div class="cc-whok">Rechazado por</div><div class="cc-whov">${esc(mv.rejected_by || '—')}${mv.rejected_at ? ` · <span class="cc-whod">${fmt(mv.rejected_at)}</span>` : ''}</div>${mv.reject_reason ? `<div class="cc-whocom">“${esc(mv.reject_reason)}”</div>` : ''}</div></div>` : ''}
      ${mv.estado === 'sugerido' ? `<div class="cc-whorow"><span class="cc-whoic pend">⏳</span><div><div class="cc-whok">Aprobación</div><div class="cc-whov" style="color:var(--muted);font-weight:500">Pendiente</div></div></div>` : ''}
      ${mv.estado === 'anulado' ? `<div class="cc-whorow"><span class="cc-whoic rec">⊘</span><div><div class="cc-whok">Anulado por</div><div class="cc-whov">${esc(mv.anulado_by || '—')}${mv.anulado_at ? ` · <span class="cc-whod">${fmt(mv.anulado_at)}</span>` : ''}</div>${mv.anulado_reason ? `<div class="cc-whocom">“${esc(mv.anulado_reason)}”</div>` : ''}</div></div>` : ''}
    </div>

    ${mv.estado === 'anulado'
      ? `<div class="cc-anulado-banner">⊘ Movimiento anulado. Coordiná con Capital Humano el cierre del ticket.</div>${mv.osticket_id ? aproDoneBox(mv.osticket_id, mv.report_id) : ''}`
      : (mv.estado === 'reportado' || mv.estado === 'exportado')
      ? aproDoneBox(mv.osticket_id, mv.report_id) + (mv.estado === 'reportado' ? aproNotifyBox(mv) : '') + anularHtml
      : mv.estado === 'aprobado'
      ? anularHtml
      : mv.estado === 'rechazado'
        ? ''
        /* v6.195: 'vencido' caia en el "else" junto con 'sugerido' y pintaba
           el boton de aprobar. El backend igual lo rechazaba, pero la pantalla
           ofrecia algo imposible — que es exactamente la trampa que veniamos
           sacando de esta vista. */
        : mv.estado === 'vencido'
        ? `<div class="cc-aact cc-aact-box" style="background:#f5f3ff;border-color:#ddd6fe">
            <div class="cc-awill">⌛ <b>Sugerencia vencida.</b> Su fecha (${esc(vencFecha(mv))}) quedó fuera de la ventana permitida, que hoy va del <b>${esc(fmt(CC_WIN && CC_WIN.minDate))}</b> al <b>${esc(fmt(CC_WIN && CC_WIN.maxDate))}</b>. Ya no se puede aprobar: cargá el movimiento de nuevo con una fecha válida.</div>
          </div>`
        /* v6.192: el aviso a la tienda va PRIMERO y destacado. Estaba
           enterrado entre el texto y los botones, y es la decision que no
           se puede deshacer: una vez publicada, la tienda ya la vio. */
        : (puedoAprobarEsta ? `<div class="cc-aact-box" style="margin-top:14px">
            <div class="cc-notify cc-notify-hero">
              <label class="cc-sw"><input type="checkbox" id="ccNotify" checked><span class="tr"></span><span class="kn"></span></label>
              <div class="txt"><div class="t1">🔔 Avisar a la tienda de este cambio</div>
                <div class="t2"><b>${esc(aproStoresTxt(mv))}</b> lo verá en sus <b>Novedades</b> apenas apruebes. Desactívalo para <b>retrasar el aviso</b> (podrás avisar después desde aquí).</div></div>
            </div>
            <div class="cc-aact" style="border:0;border-radius:0">
              <div class="cc-awill">Al aprobar se genera el reporte de <b>${aproTopicLabel(mv.tipo)}</b> con su ticket, y va a <b>Reportes → Historial</b>.</div>
            </div>
            <div class="cc-aact" style="border-top:1px solid var(--border)">
              <button class="cc-btn back" id="ccARej">Rechazar</button>
              <span class="cc-sp"></span>
              <button class="cc-btn apr" id="ccAApr">✓ Aprobar y generar ticket</button>
            </div>
          </div>`
          /* v6.191: sos vos quien la sugirió y no tenés mov.autoaprobar. No
             mostramos el botón de aprobar deshabilitado y mudo — se explica
             por qué no está, y se deja Rechazar, que acá significa
             "cancelo lo que yo mismo propuse". */
          : esMia && my.aprobar ? `<div class="cc-aact-box" style="margin-top:14px">
            <div class="cc-aact" style="border:0;border-radius:0">
              <div class="cc-awill">✋ Esta sugerencia es <b>tuya</b>, así que no podés aprobarla vos. La tiene que revisar <b>Capital Humano</b> u otra persona con permiso. Si te arrepentiste, rechazala acá.</div>
            </div>
            <div class="cc-aact" style="border-top:1px solid var(--border)">
              <button class="cc-btn back" id="ccARej">Rechazar mi sugerencia</button>
            </div>
          </div>`
          : `<div class="cc-aact cc-aact-box"><div class="cc-awill">⏳ Esperando aprobación.</div></div>`)}
  `;
  document.getElementById('ccBackList')?.addEventListener('click', backToList);
  document.getElementById('ccAFicha')?.addEventListener('click', () => openFichaFor({ id_number: mv.id_number, company_code: mv.empresa_origen }, () => renderCambioCargoHist(USER)));
  document.getElementById('ccAApr')?.addEventListener('click', () => approveMove(mv.id));
  document.getElementById('ccARej')?.addEventListener('click', () => rejectMove(mv.id));
  document.getElementById('ccAAnular')?.addEventListener('click', () => anularMove(mv));
  document.getElementById('ccPubNotice')?.addEventListener('click', () => publishNotice(mv.id));
  document.getElementById('ccDetPav')?.addEventListener('click', () => { if (mv.thumb_url) ccLightbox(mv); });
  document.querySelector('.cc-gorep')?.addEventListener('click', () => { const b = document.querySelector('.pnl-side [data-view="historial"]'); if (b) b.click(); });
  const h = await historyApi(mv.id_number, mv.empresa_origen);
  const items = (h && h.ok && h.items) ? h.items : [];
  const box = document.getElementById('ccATraj');
  if (box) {
    box.innerHTML = `<div class="cc-sec" style="margin:16px 0 6px">Trayectoria en el Grupo</div>${trajBlock(items)}`;
    const det = box.querySelector('details.cc-trj');
    if (det) det.addEventListener('toggle', e => { TRAJ_OPEN = e.target.open; });
  }
}
function aproTopicLabel(t) { if (t === 'egreso') return 'Egreso · tópico 33'; if (t === 'traslado') return 'Traslado · tópico 34'; return 'Modificación · tópico 32'; }
function aproAfter(mv) {
  // Fila Concepto: en traslado origen → destino (p.ej. MR PRICE → SHOE BOX);
  // en el resto, el concepto de la tienda (informativo).
  const cFrom = mv.concepto || '';
  const cTo = mv.tipo === 'traslado' ? (mv.dest_concepto || '') : cFrom;
  const cChg = mv.tipo === 'traslado' && cTo && cFrom && cTo !== cFrom;
  const conceptRow = `<div class="cc-frow"><span class="k">Concepto</span><span class="v">${cChg ? `${esc(cFrom)} <span class="cc-ar">→</span> ${esc(cTo)}` : esc(cTo || cFrom || '—')}</span></div>`;
  if (mv.tipo === 'egreso') return `<div class="cc-cargoline">${mv.cargo_from ? cch(mv.cargo_from, true) : ''} <span style="color:#991b1b;font-weight:800">→ EGRESO</span></div>
    <div class="cc-frow"><span class="k">Motivo</span><span class="v">${esc(mv.motivo || '—')}</span></div>
    ${conceptRow}
    <div class="cc-frow"><span class="k">Efectivo</span><span class="v">${fmt(mv.fecha_baja || mv.fecha_efectiva)}</span></div>`;
  if (mv.tipo === 'traslado') return `<div class="cc-cargoline">${mv.cargo_from ? cch(mv.cargo_from, true) : ''}<span class="cc-ar">→</span>${cch(mv.cargo_to || mv.cargo_from, true)}</div>
    <div class="cc-frow"><span class="k">Empresa · Tienda</span><span class="v">${esc(mv.empresa_origen || '')} ${esc(mv.rz || '')} <span class="cc-ar">→</span> ${esc(mv.empresa_destino || '—')}${mv.dest_rz ? ' ' + esc(mv.dest_rz) : ''}</span></div>
    ${conceptRow}
    <div class="cc-frow"><span class="k">Baja origen (B)</span><span class="v">${fmt(mv.fecha_baja)}</span></div>
    <div class="cc-frow"><span class="k">Alta destino (A)</span><span class="v">${fmt(mv.fecha_alta)}</span></div>`;
  return `<div class="cc-cargoline">${mv.cargo_from ? cch(mv.cargo_from, true) : ''}<span class="cc-ar">→</span>${cch(mv.cargo_to, true)}</div>
    <div class="cc-frow"><span class="k">Empresa · Tienda</span><span class="v">${esc(mv.empresa_origen || '')} ${esc(mv.rz || '')}</span></div>
    ${conceptRow}
    <div class="cc-frow"><span class="k">Efectivo</span><span class="v">${fmt(mv.fecha_efectiva)}</span></div>`;
}
function mvDetail(mv) {
  if (mv.tipo === 'egreso') return `${mv.cargo_from ? cch(mv.cargo_from) : ''} <span class="cc-ar">→</span> <span class="cc-cchN egr">Egreso</span>`;
  if (mv.tipo === 'traslado') return `${mv.cargo_from ? cch(mv.cargo_from) : ''}${mv.cargo_to && mv.cargo_to !== mv.cargo_from ? ` <span class="cc-ar">→</span> ${cch(mv.cargo_to)}` : ''} · ${esc(mv.empresa_origen || '')} <span class="cc-ar">→</span> ${esc(mv.empresa_destino || '—')}`;
  return `${mv.cargo_from ? cch(mv.cargo_from) : ''} <span class="cc-ar">→</span> ${mv.cargo_to ? cch(mv.cargo_to) : ''}`;
}
function ccLightbox(mv) {
  // Se cuelga DENTRO de #pnlMain (no de <body>): así, al navegar a cualquier
  // otra pantalla, el visor desaparece con el resto de la vista y no queda
  // flotando. Al hacer clic se elimina por completo.
  const host = document.getElementById('pnlMain') || document.body;
  const old = document.getElementById('ccLb');
  if (old) old.remove();
  const lb = document.createElement('div');
  lb.id = 'ccLb';
  lb.className = 'cc-lb on';
  const close = () => { lb.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  lb.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  lb.innerHTML = mv.thumb_url ? `<img src="${esc(mv.thumb_url)}" alt=""><div class="cap">${esc(mv.full_name || '')} · clic para cerrar</div>` : `<div class="big">${iniOf(mv.full_name)}</div><div class="cap">Sin foto · clic para cerrar</div>`;
  host.appendChild(lb);
}
/* Tienda(s) que se avisarán: origen y, en traslado, también destino. */
function aproStoresTxt(mv) {
  const s = [...new Set([mv.empresa_origen, mv.empresa_destino].filter(Boolean))];
  return s.length > 1 ? s.join(' y ') : (s[0] || 'la tienda');
}
/* Banda de estado del aviso a la tienda (en un movimiento ya reportado). */
function aproNotifyBox(mv) {
  if (mv.store_notify) {
    return `<div class="cc-avband sent"><span class="ic">🔔</span><div class="g"><b>Tienda avisada</b>${mv.store_notified_at ? ` · desde el ${fmt(mv.store_notified_at)}` : ''}. ${esc(aproStoresTxt(mv))} lo ve en sus Novedades.</div></div>`;
  }
  return `<div class="cc-avband held"><span class="ic">🔕</span><div class="g"><b>La tienda aún no fue avisada</b> de este cambio. El movimiento sigue su trámite; la novedad se publica cuando la liberes.</div><button class="cc-btn warn" id="ccPubNotice">🔔 Avisar a la tienda ahora</button></div>`;
}
async function approveMove(id) {
  const btn = document.getElementById('ccAApr');
  const notify = document.getElementById('ccNotify');
  const notifyStore = notify ? notify.checked : true;
  if (btn) { btn.disabled = true; btn.textContent = 'Generando…'; }
  const r = await api({ action: 'approve', id, notify_store: notifyStore });
  if (!r || !r.ok) {
    if (btn) { btn.disabled = false; btn.textContent = '✓ Aprobar y generar ticket'; }
    return toast((r && r.error) || 'No se pudo aprobar.', true);
  }
  await loadCola();
  APRO_SUB = 'detail'; APRO_SEL = id;
  renderDetail();
  toast(r.store_notified ? 'Aprobado. La tienda fue avisada.' : 'Aprobado. El aviso a la tienda quedó retenido.');
}
async function publishNotice(id) {
  const btn = document.getElementById('ccPubNotice');
  if (btn) { btn.disabled = true; btn.textContent = 'Avisando…'; }
  const r = await api({ action: 'publish_notice', id });
  if (!r || !r.ok) {
    if (btn) { btn.disabled = false; btn.textContent = '🔔 Avisar a la tienda ahora'; }
    return toast((r && r.error) || 'No se pudo avisar a la tienda.', true);
  }
  await loadCola();
  APRO_SUB = 'detail'; APRO_SEL = id;
  renderDetail();
  toast('Tienda avisada. Ya lo ve en sus Novedades.');
}
function aproDoneBox(ost, repId) {
  const rep = repId ? String(repId).padStart(4, '0') : null;
  const url = CAT && CAT.osticket_url;
  // v6.115: link al ticket PUNTUAL (mismo patrón que Reportes → Historial).
  // Agente osTicket -> panel de staff por número; usuario -> puente gc_ticket.php
  // (el PHP traduce número→id interno y redirige). Sin url, no hay link.
  const tHref = (url && ost)
    ? (CAT.viewer_is_agent
        ? `${url}/scp/tickets.php?number=${encodeURIComponent(ost)}`
        : `${url}/gc_ticket.php?number=${encodeURIComponent(ost)}`)
    : '';
  return `<div class="cc-adone"><div class="cc-adone-box">
     <div class="cc-adone-t">✅ Aprobado y reportado</div>
     <p>Ya está en <b>Reportes → Historial</b> para Capital Humano.</p>
     <div class="cc-adone-links">
       ${ost ? `<a ${tHref ? `href="${esc(tHref)}" target="_blank" rel="noopener"` : ''}><span>🎫 Ticket osTicket</span> <span class="tk">#${esc(ost)}</span>${tHref ? '<span class="ext">Ver ↗</span>' : ''}</a>` : ''}
       <a class="cc-gorep"><span>📄 Reporte${rep ? ' <span class="tk">#' + rep + '</span>' : ''}</span> <span class="ext">Ver en Reportes → Historial →</span></a>
     </div></div></div>`;
}
function ccPrompt(label, okLabel) {
  return new Promise(resolve => {
    let ov = document.getElementById('ccPromptOv');
    if (ov) ov.remove();
    ov = document.createElement('div');
    ov.id = 'ccPromptOv';
    ov.className = 'cc-prompt-ov';
    ov.innerHTML = `<div class="cc-prompt">
      <div class="cc-prompt-l">${esc(label)}</div>
      <textarea id="ccPromptTa" rows="3" placeholder="Escribe aquí…"></textarea>
      <div class="cc-prompt-btns">
        <button class="cc-btn back" id="ccPromptCancel">Cancelar</button>
        <button class="cc-btn apr" id="ccPromptOk">${esc(okLabel || 'Aceptar')}</button>
      </div></div>`;
    document.body.appendChild(ov);
    const ta = ov.querySelector('#ccPromptTa');
    setTimeout(() => ta && ta.focus(), 30);
    const done = val => { ov.remove(); resolve(val); };
    ov.querySelector('#ccPromptCancel').addEventListener('click', () => done(null));
    ov.querySelector('#ccPromptOk').addEventListener('click', () => done(ta.value.trim()));
    ov.addEventListener('click', e => { if (e.target === ov) done(null); });
  });
}
/* v6.192: aprobar desde la LISTA, sin entrar al detalle. No aprueba de una
   al primer clic a proposito: aprobar genera un ticket real y le publica la
   novedad a la tienda, asi que se confirma — y el toggle del aviso viene
   DENTRO de la confirmacion para no perderlo por atajar. */
function ccConfirmAprobar(mv) {
  return new Promise(resolve => {
    let ov = document.getElementById('ccPromptOv');
    if (ov) ov.remove();
    ov = document.createElement('div');
    ov.id = 'ccPromptOv';
    ov.className = 'cc-prompt-ov';
    ov.innerHTML = `<div class="cc-prompt">
      <div class="cc-prompt-l">Aprobar el <b>${esc(aproTopicLabel(mv.tipo))}</b> de <b>${esc(mv.full_name || '')}</b></div>
      <div class="cc-hint" style="margin:-4px 0 12px">Se genera el reporte con su ticket y va a <b>Reportes → Historial</b>.</div>
      <div class="cc-notify cc-notify-hero" style="border-radius:11px;border:1px solid var(--border)">
        <label class="cc-sw"><input type="checkbox" id="ccQNotify" checked><span class="tr"></span><span class="kn"></span></label>
        <div class="txt"><div class="t1">🔔 Avisar a la tienda de este cambio</div>
          <div class="t2"><b>${esc(aproStoresTxt(mv))}</b> lo verá en sus <b>Novedades</b> apenas apruebes. Desactívalo para <b>retrasar el aviso</b>.</div></div>
      </div>
      <div class="cc-prompt-btns">
        <button class="cc-btn back" id="ccPromptCancel">Cancelar</button>
        <button class="cc-btn apr" id="ccPromptOk">✓ Aprobar y generar ticket</button>
      </div></div>`;
    document.body.appendChild(ov);
    const done = val => { ov.remove(); resolve(val); };
    ov.querySelector('#ccPromptCancel').addEventListener('click', () => done(null));
    ov.querySelector('#ccPromptOk').addEventListener('click', () => done(!!ov.querySelector('#ccQNotify').checked));
    ov.addEventListener('click', e => { if (e.target === ov) done(null); });
  });
}
async function quickApprove(mv) {
  const notifyStore = await ccConfirmAprobar(mv);
  if (notifyStore === null) return;            // cancelado
  const r = await api({ action: 'approve', id: mv.id, notify_store: notifyStore });
  if (!r || !r.ok) return toast((r && r.error) || 'No se pudo aprobar.', true);
  await loadCola();
  renderApro();
  toast(r.store_notified
    ? (r.osticket_id ? `Aprobado. Ticket #${r.osticket_id}. La tienda fue avisada.` : 'Aprobado. La tienda fue avisada.')
    : 'Aprobado. El aviso a la tienda quedó retenido.');
}
async function rejectMove(id) {
  const reason = await ccPrompt('Motivo del rechazo (opcional):', 'Rechazar');
  if (reason === null) return;               // cancelado
  const r = await api({ action: 'reject', id, reason: reason || undefined });
  if (!r || !r.ok) return toast((r && r.error) || 'No se pudo rechazar.', true);
  await loadCola();
  APRO_SUB = 'detail'; APRO_SEL = id;
  renderDetail();
  toast('Sugerencia rechazada.');
}
/* v6.115: anular un movimiento ya aprobado/reportado (gate mov.anular). */
async function anularMove(mv, fromList) {
  const reason = await ccPrompt('Motivo de la anulación (opcional). Coordiná con Capital Humano para que cierren el ticket sin ejecutarlo.', 'Anular movimiento');
  if (reason === null) return;               // cancelado
  const r = await api({ action: 'anular', id: mv.id, reason: reason || undefined });
  if (!r || !r.ok) return toast((r && r.error) || 'No se pudo anular.', true);
  await loadCola();
  // v6.197: si vino de la lista, se vuelve a la lista. Mandarlo al detalle
  // seria sacarlo del lugar donde estaba trabajando.
  if (fromList) { renderApro(); toast('Movimiento anulado. Coordiná con Capital Humano el cierre del ticket.'); return; }
  APRO_SUB = 'detail'; APRO_SEL = mv.id;
  renderDetail();
  toast('Movimiento anulado. Coordiná con Capital Humano el cierre del ticket.');
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

/* =====================================================================
   NOVEDADES DE LA TIENDA — cambios de cargo/traslado/egreso que afectan a
   una tienda aunque no los haya hecho ella. Vista de solo lectura para el
   usuario company; el aviso llega al aprobarse (si el que aprueba lo libera)
   y el chip de estado evoluciona Aprobado → En proceso → Aplicado.
   ===================================================================== */
let NOV = [];
let NOV_FILTER = 'all';
const NOV_DIR = { in: 'Entra', out: 'Sale', stay: 'En tu tienda', baja: 'Baja' };
const NOV_ST = { aprobado: 'Aprobado', proceso: 'En proceso', aplicado: 'Aplicado' };

export async function renderNovedades(user) {
  USER = user;
  const host = $('#pnlMain');
  if (!host) return;
  host.innerHTML = styleBlock() + `<div class="cc-wrap"><div id="ccBody"><div class="cc-loading">Cargando…</div></div></div>`;
  const r = await api({ action: 'novedades', mark_seen: true });
  NOV = (r && r.ok && r.rows) ? r.rows : [];
  paintNovedades();
}
function novFiltered() {
  if (NOV_FILTER === 'all') return NOV;
  return NOV.filter(n => n.direction === NOV_FILTER);
}
function novCount(dir) { return NOV.filter(n => n.direction === dir).length; }
function paintNovedades() {
  const body = document.getElementById('ccBody');
  if (!body) return;
  const store = (USER && (USER.companyCode || USER.company_code)) || '';
  const chips = [['all', 'Todas', NOV.length], ['in', 'Entran', novCount('in')], ['out', 'Salen', novCount('out')], ['stay', 'En tu tienda', novCount('stay')], ['baja', 'Bajas', novCount('baja')]]
    .map(([f, l, n]) => `<button data-f="${f}" class="${NOV_FILTER === f ? 'on' : ''}">${l}<span class="n">${n}</span></button>`).join('');
  const list = novFiltered();
  body.innerHTML = `
    <div class="nv-head"><h1>Novedades de tu tienda</h1>
      <p class="nv-lead">Cambios de cargo, traslados y egresos que afectan a <b>${esc(store)}</b>, aunque no los hayas hecho tú. El estado del trámite se actualiza aquí hasta que Capital Humano lo aplica.</p></div>
    <div class="nv-filters">${chips}</div>
    <div class="nv-list">${list.length ? list.map(novCard).join('') : `<div class="nv-empty">No hay novedades para tu tienda por ahora.</div>`}</div>
    <div class="nv-legend">
      <span><span class="nv-st aprobado">Aprobado</span> el cambio se decidió, ticket abierto</span>
      <span><span class="nv-st proceso">En proceso</span> Capital Humano lo está tramitando</span>
      <span><span class="nv-st aplicado">Aplicado</span> ya cerrado en el sistema</span>
    </div>`;
  body.querySelectorAll('.nv-filters button').forEach(b => b.addEventListener('click', () => { NOV_FILTER = b.dataset.f; paintNovedades(); }));
  body.querySelectorAll('.nv-card [data-fic]').forEach(b => b.addEventListener('click', () => {
    const n = NOV.find(x => x.id === parseInt(b.dataset.fic, 10));
    if (n) openFichaFor({ id_number: n.id_number, company_code: (n.direction === 'in' ? n.empresa_destino : n.empresa_origen) }, () => renderNovedades(USER));
  }));
}
function novAvatar(n) {
  const grad = { in: 'linear-gradient(135deg,#34d399,#059669)', out: 'linear-gradient(135deg,#fbbf24,#d97706)', stay: 'linear-gradient(135deg,#818cf8,#4f46e5)', baja: 'linear-gradient(135deg,#f87171,#dc2626)' }[n.direction] || '#cbd5e1';
  if (n.thumb_url) return `<div class="nv-ava"><img src="${esc(n.thumb_url)}" alt="" loading="lazy" onerror="this.remove()"></div>`;
  return `<div class="nv-ava" style="background:${grad};color:#fff">${iniOf(n.full_name)}</div>`;
}
function novChangeLine(n) {
  const cg = (l, cls) => `<span class="nv-cg${cls ? ' ' + cls : ''}">${esc(l)}</span>`;
  const cpt = (a, b) => (a && b && a !== b) ? `${cg(a, 'old')}<span class="cc-ar">→</span>${cg(b)}` : cg(b || a || '—');
  if (n.direction === 'baja') return `${n.cargo_from_label ? cg(n.cargo_from_label, 'old') : ''}<span class="cc-ar">→</span>${cg('Egreso', 'egr')}${n.motivo ? ` · Motivo: ${esc(n.motivo)}` : ''}`;
  if (n.direction === 'in') return `Se incorpora como ${cg(n.cargo_to_label || n.cargo_from_label)} · ${cpt(n.origen_concepto, n.destino_concepto)}`;
  if (n.direction === 'out') return `Se traslada a <b>${esc(n.empresa_destino || '')}${n.destino_rz ? ' · ' + esc(n.destino_rz) : ''}</b> como ${cg(n.cargo_to_label || n.cargo_from_label)} · ${cpt(n.origen_concepto, n.destino_concepto)}`;
  // stay (ascenso/descenso en la misma tienda)
  return `${cpt(n.cargo_from_label, n.cargo_to_label)}${n.origen_concepto ? ` · ${cg(n.origen_concepto)}` : ''}`;
}
function novEff(n) {
  const d = n.direction === 'in' ? (n.fecha_alta || n.fecha_efectiva) : n.direction === 'baja' ? (n.fecha_baja || n.fecha_efectiva) : n.direction === 'out' ? (n.fecha_baja || n.fecha_efectiva) : (n.fecha_efectiva || n.fecha_alta);
  return fmt(d);
}
function novCard(n) {
  const tp = (TIPO_LB[n.tipo] || n.tipo);
  const meta = n.direction === 'in'
    ? `Viene de <b>${esc(n.empresa_origen || '')}${n.origen_rz ? ' · ' + esc(n.origen_rz) : ''}</b> · C.I. V-${esc(n.id_number)}`
    : `C.I. V-${esc(n.id_number)}`;
  return `<div class="nv-card">
    ${novAvatar(n)}
    <div class="nv-main">
      <div class="nv-nm">${esc(n.full_name || ('V-' + n.id_number))} <span class="nv-dir ${n.direction}">${esc(NOV_DIR[n.direction] || '')}</span> <span class="cc-pillA ${n.tipo}">${esc(tp)}</span></div>
      <div class="nv-change">${novChangeLine(n)}</div>
      <div class="nv-meta">${meta}</div>
    </div>
    <div class="nv-right">
      <span class="nv-st ${n.status}">${esc(NOV_ST[n.status] || n.status)}</span>
      <span class="nv-eff">Efectivo <b>${novEff(n)}</b></span>
    </div>
    <button class="cc-openf" data-fic="${n.id}" title="Ver ficha">${IC_FICHA}</button>
  </div>`;
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
  .cc-wh{padding:16px 20px 0;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.cc-wh h1{font-size:16px;font-weight:800;margin:0}.cc-wh .sub{color:var(--muted);font-size:12px;margin-top:2px}
  .cc-guia{font-size:12px;font-weight:700;color:var(--pri);text-decoration:none;background:var(--pri-soft);border:1px solid #ddd6fe;border-radius:999px;padding:5px 11px;white-space:nowrap;flex:none}
  .cc-guia:hover{background:#ede9fe}
  .cc-steps{display:flex;align-items:center;padding:16px 20px 4px}
  .cc-stp{display:flex;align-items:center;gap:8px;flex:none}
  .cc-stp-c{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12.5px;font-weight:700;border:1.5px solid #d1d5db;background:#fff;color:#9ca3af;flex:none;transition:all .15s}
  .cc-stp.on .cc-stp-c,.cc-stp.done .cc-stp-c{background:var(--pri);border-color:var(--pri);color:#fff}
  .cc-stp-l{font-size:12.5px;font-weight:600;color:#9ca3af;white-space:nowrap}
  .cc-stp.on .cc-stp-l{color:var(--pri);font-weight:700}.cc-stp.done .cc-stp-l{color:var(--soft)}
  .cc-stpline{flex:1;height:2px;background:#e5e7eb;margin:0 10px;border-radius:2px;min-width:14px}
  .cc-stpline.done{background:var(--pri)}
  @media(max-width:640px){.cc-stp:not(.on) .cc-stp-l{display:none}.cc-stpline{margin:0 6px}}
  .cc-wbody{padding:16px 20px;min-height:150px}
  .cc-wfoot{display:flex;gap:9px;align-items:center;padding:14px 20px;border-top:1px solid var(--border);background:#fbfcfe}
  .cc-sp{flex:1}.cc-fnote{font-size:12px;color:var(--muted)}
  .cc-btn{border-radius:9px;padding:9px 15px;font-size:13px;font-weight:700;cursor:pointer;border:1px solid}
  .cc-btn.back{background:#fff;border-color:var(--border-2);color:var(--soft)}
  .cc-btn.next{background:#8b5cf6;border-color:#8b5cf6;color:#fff}.cc-btn.next:hover{background:#7c3aed}.cc-btn.next:disabled{background:#e5e1f7;border-color:#e5e1f7;cursor:not-allowed}
  .cc-btn.sug{background:#f5f3ff;border-color:#ddd6fe;color:#6d28d9}.cc-btn.apr{background:#8b5cf6;border-color:#8b5cf6;color:#fff}
  .cc-btn.danger{background:#fff;border-color:#fecaca;color:#b91c1c}.cc-btn.danger:hover{background:#fef2f2}
  /* v6.115: anular movimiento */
  .cc-anular-box{margin-top:14px;border:1px dashed #fecaca;background:#fef7f7;border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
  .cc-anular-note{font-size:11.5px;color:#9f1239;line-height:1.5}
  .cc-anulado-banner{margin-top:14px;background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:11px 14px;font-size:13px;font-weight:700;color:#b91c1c}
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
  .cc-ffid h2{font-size:19px;font-weight:500;margin:0;line-height:1.25;color:#0f172a}
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
  .cc-hrow{display:grid;grid-template-columns:150px 50px minmax(140px,1.4fr) minmax(90px,0.9fr) minmax(110px,1.05fr) 100px 74px;gap:10px;align-items:center;font-size:12px;padding:7px 8px;border-bottom:1px solid var(--border)}
  .cc-hrow.now{background:#f5f7ff;border-radius:8px}
  .cc-hrow .hd{font-weight:700}.cc-hrow .ha{font-weight:800;color:#4f46e5}.cc-hrow .hr{color:var(--soft)}
  .cc-hrow .hcon em{font-style:normal;color:#0e7490;background:#ecfeff;border:1px solid #cffafe;border-radius:6px;padding:0 6px;font-size:11px;white-space:nowrap}
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
  .cc-fchips button.has-new{border-color:#c4b5fd;background:#f5f3ff;color:#6d28d9}
  .cc-fchips button.has-new .n{background:#8b5cf6;color:#fff}
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
  /* ===== Aprobaciones ===== */
  .cc-apro-head{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}
  .cc-apro-head h2{font-size:20px;font-weight:800;margin:0}
  .cc-apro-head .cc-cnt{background:#fde68a;color:#92400e}
  .cc-apro-filters{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:14px;flex-wrap:wrap}
  .cc-apro-filters .cc-inp{flex:1;min-width:160px}
  .cc-apro-grid{display:grid;grid-template-columns:360px 1fr;gap:16px;align-items:start}
  @media(max-width:880px){.cc-apro-grid{grid-template-columns:1fr}}
  .cc-acard{background:#fff;border:1px solid var(--border);border-radius:13px;padding:11px 12px;cursor:pointer;box-shadow:0 1px 2px rgba(15,23,42,.04);display:flex;gap:11px;align-items:flex-start;margin-bottom:8px}
  .cc-acard:hover{border-color:#ddd6fe}
  .cc-acard.on{border-color:var(--pri);box-shadow:0 0 0 3px #ede9fe}
  .cc-apav{width:42px;height:42px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex:none;overflow:hidden;cursor:zoom-in}
  .cc-apav img{width:100%;height:100%;object-fit:cover}
  .cc-apav.big{width:64px;height:64px;font-size:18px;border-radius:12px}
  .cc-anm{font-size:13.5px;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:7px;flex-wrap:wrap}
  .cc-adet{font-size:11.5px;color:var(--soft);margin-top:5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .cc-aloc{font-size:11px;color:var(--muted);margin-top:4px}
  .cc-amt{font-size:11px;color:var(--muted);margin-top:5px;display:flex;align-items:center;gap:5px;flex-wrap:wrap}
  .cc-mini{display:inline-flex;align-items:center;gap:4px;font-weight:600;border-radius:999px;padding:1px 8px;font-size:10.5px}
  .cc-mini.sug{background:#eff6ff;color:#1d4ed8}
  .cc-mini.apr{background:#ecfdf5;color:#15803d}
  .cc-mini.rec{background:#fef2f2;color:#b91c1c}
  .cc-mini.pend{background:#fffbeb;color:#92400e}
  .cc-mini.tk{background:#f1f5f9;color:#475569;font-family:ui-monospace,monospace}
  .cc-mini.venc{background:#f5f3ff;color:#6d28d9}
  /* v6.193 — rango y orden de la bandeja. */
  .cc-apro-rango{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 2px 4px}
  .cc-apro-rango .lb{font-size:11.5px;font-weight:700;color:var(--soft)}
  .cc-apro-rango .cc-inp.d{width:auto;padding:6px 9px;font-size:12.5px}
  .cc-apro-rango .cc-inp.o{width:auto;padding:6px 9px;font-size:12.5px;border:1px solid var(--border-2);border-radius:9px;font-family:inherit}
  .cc-btn.mini{padding:6px 11px !important;font-size:12px !important}
  .cc-rangonote{font-size:11.5px;color:var(--soft);padding:0 2px 10px;line-height:1.5}
  /* Detalle: bloque "quién sugirió / quién aprobó" (dos cosas distintas) */
  .cc-backbtn{display:inline-flex;align-items:center;gap:7px;margin-bottom:14px}
  .cc-whoblock{margin-top:14px;border:1px solid var(--border);border-radius:14px;overflow:hidden;max-width:900px;background:#fff}
  .cc-whorow{display:flex;gap:11px;align-items:flex-start;padding:12px 15px;border-top:1px solid var(--border)}
  .cc-whorow:first-child{border-top:0}
  .cc-whoic{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;flex:none}
  .cc-whoic.sug{background:#eff6ff;color:#1d4ed8}
  .cc-whoic.apr{background:#ecfdf5;color:#16a34a}
  .cc-whoic.rec{background:#fef2f2;color:#dc2626}
  .cc-whoic.pend{background:#fffbeb;color:#b45309}
  .cc-whok{font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.03em}
  .cc-whov{font-size:13.5px;color:var(--ink);font-weight:600;margin-top:1px}
  .cc-whod{color:var(--muted);font-weight:500;font-size:12px}
  .cc-whocom{font-size:12.5px;color:var(--soft);margin-top:3px;font-style:italic}
  .cc-aact-box{border:1px solid var(--border);border-radius:14px;margin-top:14px;max-width:900px;box-sizing:border-box}
  .cc-pager{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:10px;font-size:12px;color:var(--muted)}
  .cc-pager button{border:1px solid var(--border-2);background:#fff;border-radius:8px;padding:5px 10px;cursor:pointer;font-weight:700;color:var(--soft)}
  .cc-pager button:disabled{opacity:.4;cursor:default}
  .cc-apanel{background:#fff;border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px rgba(15,23,42,.06);overflow:hidden;min-height:420px}
  .cc-aempty{padding:66px 24px;text-align:center;color:var(--muted)}
  .cc-ahead{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;gap:14px;align-items:flex-start}
  .cc-ahead h2{font-size:18px;font-weight:700;margin:0}
  .cc-abody{padding:16px 20px}
  .cc-adatarow{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12.5px;color:var(--soft);background:#fbfcfe;border:1px solid var(--border);border-radius:11px;padding:10px 13px;margin-bottom:14px}
  .cc-adatarow b{color:var(--ink)}.cc-adatarow .k{color:var(--muted)}
  .cc-achange{border:1px solid #ddd6fe;background:var(--pri-soft);border-radius:13px;padding:14px 16px;margin-top:12px}
  .cc-awho{font-size:12px;color:var(--soft);background:#fbfcfe;border:1px solid var(--border);border-radius:10px;padding:9px 12px;margin-top:12px}.cc-awho b{color:var(--ink)}
  .cc-aact{border-top:1px solid var(--border);background:#fbfcfe;padding:14px 20px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .cc-awill{font-size:12px;color:#1e40af;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:8px 12px;flex:1;min-width:200px}
  .cc-btn.apr{background:#8b5cf6;border-color:#8b5cf6;color:#fff}.cc-btn.apr:hover{background:#7c3aed}
  .cc-adone{padding:18px 20px}
  .cc-adone-box{border:1px solid #bbf7d0;background:#f0fdf4;border-radius:14px;padding:18px}
  .cc-adone-t{font-size:15px;font-weight:800;color:#14532d}
  .cc-adone p{font-size:13px;color:#166534;margin:8px 0 0}
  .cc-adone-links{display:flex;flex-direction:column;gap:8px;margin-top:14px}
  .cc-adone-links a{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:700;text-decoration:none;border:1px solid #bbf7d0;background:#fff;border-radius:10px;padding:10px 13px;color:#166534;cursor:pointer}
  .cc-adone-links a:hover{background:#f0fdf4}
  .cc-adone-links .tk{font-family:ui-monospace,monospace;background:#dcfce7;border-radius:6px;padding:1px 7px}
  .cc-adone-links .ext{margin-left:auto;color:#16a34a}
  .cc-lb{position:fixed;inset:0;background:rgba(15,23,42,.78);display:none;align-items:center;justify-content:center;z-index:9998}
  .cc-lb.on{display:flex}
  .cc-lb img{max-width:80vw;max-height:80vh;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
  .cc-lb .big{width:280px;height:280px;border-radius:18px;background:#334155;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:64px}
  .cc-lb .cap{position:absolute;bottom:40px;color:#e2e8f0;font-size:13px}
  .cc-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#0f172a;color:#fff;font-size:13px;font-weight:600;padding:10px 16px;border-radius:10px;box-shadow:0 6px 24px rgba(15,23,42,.25);z-index:9999;transition:opacity .3s;opacity:0}
  .cc-toast.err{background:#b91c1c}
  .cc-prompt-ov{position:fixed;inset:0;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px}
  .cc-prompt{background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);padding:18px;width:min(420px,100%)}
  .cc-prompt-l{font-size:14px;font-weight:700;color:var(--ink);margin-bottom:10px}
  .cc-prompt textarea{width:100%;box-sizing:border-box;border:1px solid var(--border-2);border-radius:10px;padding:9px 11px;font-size:13px;font-family:inherit;resize:vertical}
  .cc-prompt-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
  .cc-prompt-btns .cc-btn.apr{background:#dc2626;border-color:#dc2626}.cc-prompt-btns .cc-btn.apr:hover{background:#b91c1c}
  /* ===== Novedades de la tienda ===== */
  .nv-head h1{font-size:22px;font-weight:800;margin:0 0 3px}
  .nv-lead{color:var(--muted);font-size:13px;margin:0 0 16px;line-height:1.5;max-width:820px}
  .nv-filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
  .nv-filters button{border:1px solid var(--border-2);background:#fff;color:var(--soft);font-size:12px;font-weight:600;padding:7px 13px;border-radius:999px;cursor:pointer;display:flex;align-items:center;gap:6px}
  .nv-filters button.on{background:var(--pri-soft);border-color:#ddd6fe;color:var(--pri)}
  .nv-filters button .n{font-size:10px;font-weight:800;background:#eef2f7;color:#64748b;border-radius:999px;padding:0 6px}
  .nv-filters button.on .n{background:#ddd6fe;color:var(--pri)}
  .nv-list{display:flex;flex-direction:column;gap:9px}
  .nv-empty{padding:34px 14px;text-align:center;color:var(--muted);border:1px solid var(--border);border-radius:13px;background:#fff}
  .nv-card{display:flex;align-items:center;gap:13px;padding:12px 14px;border:1px solid var(--border);border-radius:13px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.03)}
  .nv-card:hover{border-color:#dbe4f0}
  .nv-ava{width:44px;height:44px;border-radius:11px;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;overflow:hidden}
  .nv-ava img{width:100%;height:100%;object-fit:cover}
  .nv-main{flex:1;min-width:0}
  .nv-nm{font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .nv-change{font-size:12.5px;color:var(--soft);margin-top:4px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;line-height:1.5}
  .nv-meta{font-size:11.5px;color:var(--muted);margin-top:4px}
  .nv-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none;text-align:right}
  .nv-eff{font-size:11.5px;color:var(--muted)}.nv-eff b{color:var(--soft)}
  .nv-cg{display:inline-block;font-size:11.5px;font-weight:700;border-radius:999px;padding:2px 10px;background:#eef2f7;color:#475569}
  .nv-cg.old{background:#f1f5f9;color:#94a3b8}.nv-cg.egr{background:#fee2e2;color:#991b1b}
  .nv-dir{font-size:10.5px;font-weight:800;letter-spacing:.02em;border-radius:8px;padding:3px 9px;text-transform:uppercase}
  .nv-dir.in{background:#dcfce7;color:#166534}.nv-dir.out{background:#fef3c7;color:#92400e}
  .nv-dir.stay{background:#e0e7ff;color:#3730a3}.nv-dir.baja{background:#fee2e2;color:#991b1b}
  .nv-st{font-size:11px;font-weight:700;border-radius:999px;padding:3px 11px;white-space:nowrap}
  .nv-st.aprobado{background:#eff6ff;color:#1d4ed8}
  .nv-st.proceso{background:#fffbeb;color:#92400e}
  .nv-st.aplicado{background:#ecfdf5;color:#166534}
  .nv-legend{margin-top:16px;font-size:11.5px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap}
  .nv-legend span{display:inline-flex;align-items:center;gap:6px}
  /* ===== Toggle "avisar a la tienda" + banda de estado del aviso ===== */
  .cc-notify{display:flex;align-items:flex-start;gap:12px;padding:12px 18px;background:#fbfcfe;border-top:1px solid var(--border)}
  /* v6.192 — el aviso a la tienda no se puede deshacer: se ve o no sirve. */
  .cc-notify-hero{background:#fffbeb;border-top:0;border-bottom:1px solid #fde68a;padding:14px 18px}
  .cc-notify-hero .t1{font-size:14px;font-weight:800;color:#92400e}
  /* v6.192 — el cargo nuevo es LA decision del paso Destino. */
  .cc-hero{border:1px solid var(--border);border-left:4px solid var(--hc,#94a3b8);border-radius:12px;padding:13px 15px;background:var(--hbg,#f8fafc)}
  .cc-hero.ascenso{--hc:#16a34a;--hbg:#f0fdf4}
  .cc-hero.descenso{--hc:#d97706;--hbg:#fffbeb}
  .cc-hero.traslado{--hc:#2563eb;--hbg:#eff6ff}
  .cc-hero label{font-size:12px;color:#334155}
  /* v6.194: 17px + padding 12px cortaba el texto por abajo — el select nativo
     no crece solo con la fuente. Tamaño mas sobrio y line-height/height
     explicitos, que es lo que en realidad faltaba. */
  .cc-sel-hero{font-size:14.5px !important;font-weight:700;padding:9px 11px !important;line-height:1.5 !important;height:auto !important;min-height:0 !important;border-color:var(--hc) !important;background:#fff;color:#0f172a}
  /* v6.192 — quien sugirio deja de competir con el estado. */
  .cc-sugby{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#475569;background:#eff6ff;border:1px solid #bfdbfe;border-radius:999px;padding:2px 10px}
  .cc-sugby b{color:#1d4ed8;font-weight:800}
  /* v6.196: Aprobar y Rechazar EN LINEA. Estaban uno debajo del otro porque
     compartian la columna con el icono de ficha; la ficha se mudo al lado del
     nombre, que es donde uno la busca, y liberó el ancho. */
  .cc-acta{display:flex;flex-direction:row;align-items:center;gap:7px;flex:0 0 auto}
  /* display:inline-flex y no el flex del base: si no, el boton se comporta
     como bloque y se cae del renglon del nombre. */
  .cc-openf.inline{display:inline-flex;vertical-align:middle;width:24px;height:24px;padding:0;margin-left:3px;border-radius:7px}
  .cc-openf.inline svg{width:14px;height:14px}
  .cc-aloc .ced{color:#334155;font-weight:800;font-family:ui-monospace,monospace}
  /* v6.197: se fue .cc-prow.cerrado / .cc-exemp — los empleos cerrados ya no
     se listan en el wizard, asi que su estilo era codigo muerto. Dejarlo era
     invitar a la proxima confusion, como pasó con 'lateral'. */
  /* v6.193 — ya tiene un movimiento sin resolver: se ve antes de elegirla. */
  .cc-prow.encurso{opacity:.7;background:#fffbeb}
  .cc-encurso{display:inline-block;vertical-align:middle;font-size:9.5px;font-weight:800;letter-spacing:.3px;color:#92400e;background:#fef3c7;border:1px solid #fde68a;border-radius:999px;padding:1px 7px;margin-left:6px}
  /* v6.193 — combo de tienda destino, agrupado por zona. */
  .cc-empsel{margin-top:8px;padding:11px 12px;font-size:14px;font-weight:600;border:1px solid var(--border-2);border-radius:9px;font-family:inherit;background:#fff}
  /* v6.193 — volver a un paso ya hecho sin desandar de a uno. */
  .cc-stp[data-go]{cursor:pointer}
  .cc-stp[data-go]:hover .cc-stp-l{text-decoration:underline}
  .cc-quickapr,.cc-quickrej{padding:6px 12px !important;font-size:12px !important;white-space:nowrap}
  .cc-notify .txt{flex:1}
  .cc-notify .t1{font-size:13px;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:7px}
  .cc-notify .t2{font-size:11.5px;color:var(--muted);margin-top:3px;line-height:1.45}
  .cc-sw{position:relative;width:42px;height:24px;flex:none;cursor:pointer}
  .cc-sw input{display:none}
  .cc-sw .tr{position:absolute;inset:0;border-radius:999px;background:#cbd5e1;transition:.15s}
  .cc-sw .kn{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:.15s}
  .cc-sw input:checked + .tr{background:#16a34a}
  .cc-sw input:checked + .tr + .kn{left:20px}
  .cc-avband{display:flex;align-items:center;gap:11px;margin:12px 20px 18px;padding:12px 14px;border-radius:12px;font-size:12.5px}
  .cc-avband.held{background:#fffbeb;border:1px solid #fde68a;color:#92400e}
  .cc-avband.sent{background:#ecfdf5;border:1px solid #bbf7d0;color:#166534}
  .cc-avband .ic{font-size:16px;flex:none}
  .cc-avband .g{flex:1;line-height:1.4}
  .cc-btn.warn{background:#f59e0b;border-color:#f59e0b;color:#fff}.cc-btn.warn:hover{background:#d97706}
  </style>`;
}
