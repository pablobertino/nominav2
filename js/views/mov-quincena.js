/* =====================================================================
   js/views/mov-quincena.js  →  vista "Movimientos" (de la quincena)
   Menu PERSONAL → Movimientos (v6.37; mockup aprobado
   _PRUEBAS/movimientos_quincena_mockup.html).

   Todos los INGRESADOS, TRASLADADOS, EGRESADOS y CAMBIOS DE CARGO de la
   quincena elegida, con sus fichas, filtrables por Zona / SubZona /
   Concepto y cuantificados en 4 stat-cards (que tambien filtran, igual
   que las pestañas). REGLA SIN REPETIR: las tres primeras categorias son
   excluyentes; Cambios de cargo es lente transversal.

   FILA UNICA formato Buscar personal en las 4 pestañas: foto real como
   avatar (iniciales si no hay), nombre + C.I./cargo/sexo/edad, iconos
   carnet (abrir ficha, tambien para egresados) y copiar, y bloque derecho
   variable: en Ingresados/Egresados el de Buscar (empresa, razon social,
   zona·subzona·concepto y pastillas con la fecha); en Trasladados/Cambios
   las dos cajitas ORIGEN → DESTINO. Sin textos redundantes con la pestaña
   activa: los chips solo aparecen cuando agregan informacion (reingreso,
   corta permanencia, ascenso/descenso, + traslado, misma empresa).

   Fuente: /api/mov-quincena (RPC get_quincena_moves: roster vivo +
   espejos AX). Sus totales NO cuadran con la vista Rotacion (cortes de
   hcm_snapshot) y esta bien: aqui se ve todo el movimiento, incluso quien
   entro y salio dentro de la misma quincena. La nota al pie lo dice.

   Ficha: reusa renderWorkerPhotos con opts.openCed (patron Buscar); al
   volver se regresa a ESTA vista con quincena, filtros y pestaña intactos
   (estado a nivel de modulo).
   Export: renderMovQuincena(user)
   ===================================================================== */

import { $ } from '../core/dom.js';
import { renderWorkerPhotos, openWorkerLightbox } from './worker-photos.js';

const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
const AVATAR_BG = ['#dbeafe', '#fae8ff', '#dcfce7', '#fef9c3', '#fee2e2', '#e0e7ff', '#ccfbf1', '#ffedd5'];
const AVATAR_FG = ['#1e40af', '#86198f', '#166534', '#854d0e', '#991b1b', '#3730a3', '#0f766e', '#9a3412'];
function avatarColor(seed) {
  const s = String(seed || ''); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % AVATAR_BG.length;
}
/* 'YYYY-MM-DD' -> 'dd/mm' y 'dd/mm/aa'. */
function fmtD(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return `${d}/${m}`;
}
function fmtDY(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return `${d}/${m}/${String(y).slice(2)}`;
}
function cedFmt(c) {
  const s = String(c || '').replace(/\D/g, '');
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function ageOf(birth) {
  if (!birth) return null;
  const b = new Date(birth + 'T00:00:00');
  if (isNaN(b)) return null;
  const now = new Date();
  let a = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) a--;
  return (a >= 0 && a <= 120) ? a : null;
}
function tstamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
function downloadBlob(content, filename, mime) {
  const blob = (content instanceof Blob) ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/* ---------- iconos ---------- */
const SVG = {
  // los mismos 4 tipos del Detalle de Rotacion
  ing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/></svg>',
  tra: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>',
  egr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="16" y1="11" x2="22" y2="11"/></svg>',
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>',
  card: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="8" cy="10" r="2"/><path d="M5.5 16.5c.5-1.7 1.5-2.5 2.5-2.5s2 .8 2.5 2.5"/><line x1="14" y1="9" x2="19" y2="9"/><line x1="14" y1="13" x2="19" y2="13"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
};

/* Definicion de las 4 categorias (orden de pestañas). */
const KINDS = [
  { k: 'ing', lbl: 'Ingresados',       one: 'ingresado',  color: '#16a34a', bg: '#f0fdf4' },
  { k: 'tra', lbl: 'Trasladados',      one: 'trasladado', color: '#2563eb', bg: '#eff6ff' },
  { k: 'egr', lbl: 'Egresados',        one: 'egresado',   color: '#dc2626', bg: '#fef2f2' },
  { k: 'cam', lbl: 'Cambios de cargo', one: 'cambio',     color: '#d97706', bg: '#fffbeb' },
];

/* ---------- estado del modulo (sobrevive al ir y volver de la ficha) ---------- */
let MQ = null;
function freshState(user) {
  return {
    user, periods: [], facets: null, rows: [],
    from: null, to: null, tab: 'ing',
    zone: '', sub: '', con: '', q: '',
    loading: false, error: null,
  };
}

/* ---------- estilos ---------- */
function ensureStyles() {
  if (document.getElementById('mqStyles')) return;
  const st = document.createElement('style');
  st.id = 'mqStyles';
  st.textContent = `
  .mq-note{font-size:12px;color:var(--muted,#64748b);margin:2px 2px 14px;line-height:1.5}
  .mq-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0 0 14px}
  @media(max-width:900px){.mq-cards{grid-template-columns:repeat(2,1fr)}}
  .mq-card{border:1px solid var(--border,#e6eaf0);border-radius:12px;padding:12px 14px;background:var(--card,#fff);cursor:pointer;display:flex;gap:11px;align-items:flex-start;transition:box-shadow .12s}
  .mq-card:hover{box-shadow:0 4px 14px rgba(15,23,42,.08)}
  .mq-card.on{border-color:var(--kc);box-shadow:0 0 0 1px var(--kc)}
  .mq-card .ic{flex:0 0 34px;width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:var(--kb);color:var(--kc)}
  .mq-card .ic svg{width:19px;height:19px}
  .mq-card .k{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--muted,#64748b)}
  .mq-card .v{font-size:22px;font-weight:800;color:var(--ink,#0f172a);line-height:1.15}
  .mq-card .h{font-size:10.5px;color:var(--faint,#94a3b8);margin-top:2px;line-height:1.35}
  .mq-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border,#e6eaf0);margin:0 0 4px;flex-wrap:wrap}
  .mq-tab{font-family:inherit;font-size:13.5px;font-weight:600;padding:9px 14px;border:0;background:none;color:var(--muted,#64748b);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;display:flex;align-items:center;gap:7px}
  .mq-tab:hover{color:var(--ink,#0f172a)}
  .mq-tab.on{color:var(--tc);border-bottom-color:var(--tc)}
  .mq-tab .cnt{font-size:11px;background:var(--border-soft,#f1f4f8);color:var(--muted,#64748b);border-radius:20px;padding:1px 7px;font-weight:700}
  .mq-tab.on .cnt{background:var(--tb);color:var(--tc)}
  .mq-list{border:1px solid var(--border,#e6eaf0);border-radius:12px;background:var(--card,#fff);overflow:hidden}
  .mq-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border-soft,#f1f4f8)}
  .mq-row:last-child{border-bottom:0}
  .mq-av{flex:0 0 40px;width:40px;height:40px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13.5px}
  .mq-av.pic{cursor:zoom-in}
  .mq-av img{width:100%;height:100%;object-fit:cover;display:block}
  .mq-mid{flex:0 1 auto;min-width:0}
  .mq-nm{font-weight:600;font-size:13.5px;color:var(--ink,#0f172a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mq-sub{font-size:11.5px;color:var(--muted,#64748b);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mq-acts{display:flex;gap:4px;flex:0 0 auto;margin-right:auto}
  .mq-ib{border:1px solid var(--border,#e6eaf0);background:var(--card,#fff);border-radius:8px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted,#64748b)}
  .mq-ib:hover{color:var(--brand,#2563eb);border-color:var(--brand,#2563eb)}
  .mq-right{flex:0 0 auto;min-width:300px;max-width:46%;margin-left:auto;text-align:left}
  .mq-right.duo{flex:0 0 52%;max-width:52%}
  .mq-emp1{font-size:12.5px;font-weight:700;color:var(--ink,#0f172a)}
  .mq-emp1 .da{font-weight:500;color:var(--faint,#94a3b8);font-size:11px}
  .mq-emp2{font-size:11.5px;color:var(--muted,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mq-pills{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px}
  .mq-pill{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap}
  .mq-pill.g{background:#dcfce7;color:#166534}
  .mq-pill.r{background:#fee2e2;color:#991b1b}
  .mq-pill.a{background:#fef3c7;color:#92400e}
  .mq-pill.b{background:#dbeafe;color:#1e40af}
  .mq-pill.x{background:#f1f5f9;color:#475569}
  .mq-duo{display:flex;align-items:stretch;gap:8px}
  .mq-box{flex:1 1 0;width:0;min-width:0;border:1px solid var(--border,#e6eaf0);border-radius:9px;padding:6px 9px;background:#fbfcfe}
  .mq-box .rz2{font-size:10.5px;color:var(--muted,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mq-box.dim{opacity:.72}
  .mq-box .b1{font-size:11.5px;font-weight:700;color:var(--ink,#0f172a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mq-box .b1 .rz{font-weight:500;color:var(--muted,#64748b)}
  .mq-box .b2{font-size:10.5px;color:var(--muted,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mq-box .b3{font-size:11px;font-weight:600;color:var(--ink-soft,#475569);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mq-box .b3 .fx{font-weight:500;color:var(--faint,#94a3b8)}
  .mq-arr{align-self:center;flex:0 0 auto;font-size:15px;color:var(--faint,#94a3b8)}
  .mq-dir-up{color:#16a34a}
  .mq-dir-dn{color:#dc2626}
  .mq-empty{padding:26px 16px;text-align:center;color:var(--muted,#64748b);font-size:13px}
  @media(max-width:820px){
    .mq-row{flex-wrap:wrap}
    .mq-right,.mq-right.duo{flex-basis:100%;max-width:100%;min-width:0;margin-top:6px;padding-left:52px}
  }`;
  document.head.appendChild(st);
}

/* ---------- API ---------- */
function userPayload(u) {
  return { kind: u.kind, id: u.id || null, companyCode: u.companyCode || null };
}
async function api(payload) {
  const res = await fetch('/api/mov-quincena', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, user: userPayload(MQ.user) }),
  });
  return res.json();
}

/* ---------- vista ---------- */
export async function renderMovQuincena(user) {
  ensureStyles();
  // Estado persistido: al volver de una ficha se repinta con lo que habia.
  const keep = MQ && MQ.user && String(MQ.user.id) === String(user.id) && MQ.periods.length;
  if (!keep) MQ = freshState(user);
  else MQ.user = user;

  $('#pnlMain').innerHTML = `
    <div class="pnl-head">
      <div><h1>Movimientos de la quincena</h1>
        <p id="mqSubt">Ingresados, trasladados, egresados y cambios de cargo, con sus fichas</p></div>
      <div class="head-actions">
        <div class="export-wrap">
          <button class="btn" id="mqExportBtn">Exportar ▾</button>
          <div class="export-menu" id="mqExportMenu" hidden>
            <button data-fmt="xlsx">Excel (.xlsx)</button>
            <button data-fmt="csv">CSV (.csv)</button>
            <button data-fmt="txt">Texto (.txt)</button>
          </div>
        </div>
      </div>
    </div>
    <div class="pnl-filters">
      <select id="mqQuin" style="font-weight:600"><option value="">Quincena: cargando…</option></select>
      <select id="mqZone"><option value="">Zona: todas</option></select>
      <select id="mqSub"><option value="">SubZona: todas</option></select>
      <select id="mqCon"><option value="">Concepto: todos</option></select>
      <div class="search" style="flex:1;min-width:180px">${SVG.search}<input id="mqQ" placeholder="Filtrar por nombre, cédula, cargo o empresa…" autocomplete="off"></div>
    </div>
    <div class="mq-cards" id="mqCards"></div>
    <div class="mq-tabs" id="mqTabs"></div>
    <div class="mq-list" id="mqList"><div class="pnl-loading">Cargando…</div></div>
    <p class="mq-note">Fuente: lista de personal en vivo + espejos del sistema, con la regla sin repetir (el trasladado no aparece como ingreso ni como egreso). Los totales <b>no coinciden con la vista Rotación</b> — Rotación cuenta desde los cortes quincenales de snapshot; aquí se ve todo el movimiento real, incluso quien entró y salió dentro de la misma quincena.</p>`;

  // Export
  const eb = $('#mqExportBtn'), em = $('#mqExportMenu');
  eb.addEventListener('click', (e) => { e.stopPropagation(); em.hidden = !em.hidden; });
  document.addEventListener('click', () => { em.hidden = true; });
  em.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { em.hidden = true; doExport(b.dataset.fmt); }));

  // Filtros
  $('#mqQuin').addEventListener('change', () => {
    const [f, t] = $('#mqQuin').value.split('|');
    MQ.from = f || null; MQ.to = t || null;
    loadMoves();
  });
  ['mqZone', 'mqSub', 'mqCon'].forEach(id =>
    $('#' + id).addEventListener('change', () => {
      MQ.zone = $('#mqZone').value; MQ.sub = $('#mqSub').value; MQ.con = $('#mqCon').value;
      fillSubzones();
      render();
    }));
  $('#mqQ').addEventListener('input', () => { MQ.q = $('#mqQ').value; render(); });

  if (keep) {
    fillCombos();
    render();
    return;
  }

  // Primera carga: facets (quincenas + territoriales), luego los movimientos.
  const d = await api({ action: 'facets' });
  if (!d || !d.ok) {
    $('#mqList').innerHTML = `<div class="mq-empty">Error: ${esc((d && d.error) || 'no se pudo cargar')}</div>`;
    return;
  }
  MQ.periods = d.periods || [];
  MQ.facets = d.facets || null;
  if (!MQ.periods.length) {
    $('#mqList').innerHTML = '<div class="mq-empty">No hay quincenas en el calendario de nómina.</div>';
    return;
  }
  // Por defecto: la quincena EN CURSO (hoy dentro del rango) o la mas reciente.
  const hoy = caracasToday();
  const cur = MQ.periods.find(p => p.range_start <= hoy && hoy <= p.range_end) || MQ.periods[0];
  MQ.from = cur.range_start; MQ.to = cur.range_end;
  fillCombos();
  loadMoves();
}

function caracasToday() {
  const c = new Date(Date.now() - 4 * 3600 * 1000);
  const z = n => String(n).padStart(2, '0');
  return `${c.getUTCFullYear()}-${z(c.getUTCMonth() + 1)}-${z(c.getUTCDate())}`;
}

function periodLabel(p, hoy) {
  const vig = (p.range_start <= hoy && hoy <= p.range_end) ? ' (en curso)' : '';
  const mes = MESES[(p.month || 1) - 1] || '';
  return `${fmtD(p.range_start)} – ${fmtD(p.range_end)} · ${mes} ${p.year}${vig}`;
}

function fillCombos() {
  const hoy = caracasToday();
  const qs = $('#mqQuin');
  qs.innerHTML = MQ.periods.map(p =>
    `<option value="${p.range_start}|${p.range_end}">${periodLabel(p, hoy)}</option>`).join('');
  qs.value = `${MQ.from}|${MQ.to}`;
  const f = MQ.facets || {};
  const zs = $('#mqZone');
  zs.innerHTML = '<option value="">Zona: todas</option>'
    + (f.zones || []).map(z => `<option value="${esc(z.name)}">${esc(z.name)}</option>`).join('');
  zs.value = MQ.zone || '';
  fillSubzones();
  const cs = $('#mqCon');
  cs.innerHTML = '<option value="">Concepto: todos</option>'
    + (f.concepts || []).map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  cs.value = MQ.con || '';
  $('#mqQ').value = MQ.q || '';
}

/* SubZonas acotadas a la zona elegida (facetas de Buscar traen zone_name). */
function fillSubzones() {
  const f = MQ.facets || {};
  const ss = $('#mqSub');
  let subs = f.subzones || [];
  if (MQ.zone) subs = subs.filter(s => !s.zone_name || s.zone_name === MQ.zone);
  const cur = MQ.sub;
  ss.innerHTML = '<option value="">SubZona: todas</option>'
    + subs.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
  ss.value = subs.some(s => s.name === cur) ? cur : '';
  MQ.sub = ss.value;
}

async function loadMoves() {
  if (!MQ.from || !MQ.to) return;
  MQ.loading = true;
  $('#mqList').innerHTML = '<div class="pnl-loading">Cargando movimientos…</div>';
  $('#mqCards').innerHTML = '';
  $('#mqTabs').innerHTML = '';
  const d = await api({ action: 'moves', from: MQ.from, to: MQ.to });
  MQ.loading = false;
  if (!d || !d.ok) {
    $('#mqList').innerHTML = `<div class="mq-empty">Error: ${esc((d && d.error) || 'no se pudo cargar')}</div>`;
    return;
  }
  MQ.rows = d.rows || [];
  render();
}

/* ---------- filtrado en cliente ---------- */
function passTerritory(r) {
  // La fila pasa si CUALQUIERA de sus dos puntas coincide con el filtro
  // (mismo criterio que el alcance: origen o destino).
  if (MQ.zone && r.a_zona !== MQ.zone && r.b_zona !== MQ.zone) return false;
  if (MQ.sub && r.a_subzona !== MQ.sub && r.b_subzona !== MQ.sub) return false;
  if (MQ.con && r.a_concepto !== MQ.con && r.b_concepto !== MQ.con) return false;
  return true;
}
function passText(r) {
  const q = (MQ.q || '').trim().toLowerCase();
  if (!q) return true;
  const hay = `${r.nombre || ''} ${r.ced || ''} ${r.a_cargo || ''} ${r.b_cargo || ''} ${r.a_alias || ''} ${r.b_alias || ''} ${r.a_empresa || ''} ${r.b_empresa || ''}`.toLowerCase();
  return q.split(/\s+/).every(w => hay.includes(w));
}
function filtered() {
  return MQ.rows.filter(r => passTerritory(r) && passText(r));
}

/* ---------- render ---------- */
function render() {
  const rows = filtered();
  const by = {};
  KINDS.forEach(K => { by[K.k] = rows.filter(r => r.kind === K.k); });

  // Subtitulo con el total de la quincena visible.
  const tot = by.ing.length + by.tra.length + by.egr.length;
  $('#mqSubt').textContent = `${tot} movimiento${tot === 1 ? '' : 's'} en la quincena (${by.cam.length} cambio${by.cam.length === 1 ? '' : 's'} de cargo)`;

  // Stat-cards con icono + desglose por zona (top 3 del lado relevante).
  $('#mqCards').innerHTML = KINDS.map(K => {
    const list = by[K.k];
    const zc = {};
    list.forEach(r => {
      const z = (K.k === 'egr' ? r.a_zona : (r.b_zona || r.a_zona)) || 'Sin zona';
      zc[z] = (zc[z] || 0) + 1;
    });
    const top = Object.entries(zc).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([z, n]) => `${esc(z)} ${n}`).join(' · ');
    return `<div class="mq-card${MQ.tab === K.k ? ' on' : ''}" data-k="${K.k}" style="--kc:${K.color};--kb:${K.bg}">
      <div class="ic">${SVG[K.k]}</div>
      <div><div class="k">${K.lbl}</div><div class="v">${list.length}</div>
        <div class="h">${top || '—'}</div></div>
    </div>`;
  }).join('');
  $('#mqCards').querySelectorAll('.mq-card').forEach(c =>
    c.addEventListener('click', () => { MQ.tab = c.dataset.k; render(); }));

  // Pestañas
  $('#mqTabs').innerHTML = KINDS.map(K =>
    `<button class="mq-tab${MQ.tab === K.k ? ' on' : ''}" data-k="${K.k}" style="--tc:${K.color};--tb:${K.bg}">${K.lbl} <span class="cnt">${by[K.k].length}</span></button>`).join('');
  $('#mqTabs').querySelectorAll('.mq-tab').forEach(b =>
    b.addEventListener('click', () => { MQ.tab = b.dataset.k; render(); }));

  // Lista de la pestaña activa
  const list = by[MQ.tab] || [];
  const host = $('#mqList');
  if (MQ.loading) { host.innerHTML = '<div class="pnl-loading">Cargando…</div>'; return; }
  if (!list.length) {
    const K = KINDS.find(x => x.k === MQ.tab);
    host.innerHTML = `<div class="mq-empty">Sin ${K ? K.lbl.toLowerCase() : 'filas'} en esta quincena con los filtros actuales.</div>`;
  } else {
    host.innerHTML = list.map(rowHtml).join('');
  }
  wireRows(host);
}

/* ---------- fila unica (formato Buscar) ---------- */
function avatarHtml(r) {
  const ix = avatarColor(r.ced);
  const ini = `<span style="width:100%;height:100%;display:${r.thumb_url ? 'none' : 'flex'};align-items:center;justify-content:center;background:${AVATAR_BG[ix]};color:${AVATAR_FG[ix]}">${esc(initialsOf(r.nombre))}</span>`;
  const img = r.thumb_url
    ? `<img src="${esc(r.thumb_url)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    : '';
  return `<div class="mq-av${r.thumb_url ? ' pic' : ''}"${r.thumb_url ? ` data-pic="1" title="Ampliar foto"` : ''}>${img}${ini}</div>`;
}
function subLine(r) {
  const parts = [`C.I. ${cedFmt(r.ced)}`];
  const cargo = (r.kind === 'egr' ? r.a_cargo : (r.b_cargo || r.a_cargo)) || '';
  if (cargo) parts.push(esc(cargo));
  if (r.genero === 'M' || r.genero === 'F') parts.push(r.genero);
  const a = ageOf(r.nacimiento);
  if (a != null) parts.push(`${a} años`);
  return parts.join(' · ');
}
function terrLine(alias, zona, sub, con) {
  return [zona, sub, con].filter(Boolean).map(esc).join(' · ') || '—';
}
/* Bloque derecho de Ingresados / Egresados: el de Buscar + pastillas. */
function rightSimple(r) {
  const isIng = r.kind === 'ing';
  const alias = isIng ? r.b_alias : r.a_alias;
  const da = isIng ? r.b_da : r.a_da;
  const emp = isIng ? r.b_empresa : r.a_empresa;
  const zona = isIng ? r.b_zona : r.a_zona;
  const sub = isIng ? r.b_subzona : r.a_subzona;
  const con = isIng ? r.b_concepto : r.a_concepto;
  const fecha = isIng ? r.b_fecha : r.a_fecha;
  const pills = [];
  if (isIng) {
    pills.push(`<span class="mq-pill g">ingresó el ${fmtD(fecha)}</span>`);
    if (r.reingreso_fin) pills.push(`<span class="mq-pill a">reingreso · egresó el ${fmtDY(r.reingreso_fin)}</span>`);
  } else {
    pills.push(`<span class="mq-pill r">egresó el ${fmtD(fecha)}</span>`);
    if (r.dias_cargo != null) {
      if (r.dias_cargo < 90) pills.push(`<span class="mq-pill a">⚠ ${r.dias_cargo} d en el cargo</span>`);
      else pills.push(`<span class="mq-pill x">${r.dias_cargo} d en el cargo</span>`);
    }
  }
  return `<div class="mq-right">
    <div class="mq-emp1">${esc(alias || '')}${da ? ` <span class="da">· ${esc(da)}</span>` : ''} <span style="font-weight:500;color:var(--muted,#64748b)">${esc(emp || '')}</span></div>
    <div class="mq-emp2">${terrLine(alias, zona, sub, con)}</div>
    <div class="mq-pills">${pills.join('')}</div>
  </div>`;
}
/* Bloque derecho de Trasladados / Cambios: dos cajitas ORIGEN → DESTINO. */
function boxHtml(alias, emp, con, zona, sub, cargo, fecha, dim) {
  return `<div class="mq-box${dim ? ' dim' : ''}">
    <div class="b1">${esc(alias || '')}</div>
    <div class="rz2">${esc(emp || '')}</div>
    <div class="b2">${[con, zona, sub].filter(Boolean).map(esc).join(' · ') || '—'}</div>
    <div class="b3">${esc(cargo || '—')}${fecha ? ` <span class="fx">· ${fmtD(fecha)}</span>` : ''}</div>
  </div>`;
}
function rightDuo(r) {
  const isCam = r.kind === 'cam';
  const arr = isCam && r.dir === 1 ? '<span class="mq-arr mq-dir-up">⬆</span>'
    : isCam && r.dir === -1 ? '<span class="mq-arr mq-dir-dn">⬇</span>'
    : '<span class="mq-arr">→</span>';
  const pills = [];
  if (r.kind === 'tra') {
    if (r.a_cargo && r.b_cargo && r.a_cargo !== r.b_cargo) {
      pills.push(`<span class="mq-pill a">+ cambio de cargo${r.dir === 1 ? ' ⬆' : r.dir === -1 ? ' ⬇' : ''}</span>`);
    }
  } else {
    if (r.con_traslado) pills.push('<span class="mq-pill b">+ traslado</span>');
    if (r.misma_empresa) pills.push('<span class="mq-pill x">misma empresa</span>');
    if (r.dir === 1) pills.push('<span class="mq-pill g">ascenso</span>');
    else if (r.dir === -1) pills.push('<span class="mq-pill r">descenso</span>');
  }
  return `<div class="mq-right duo">
    <div class="mq-duo">
      ${boxHtml(r.a_alias, r.a_empresa, r.a_concepto, r.a_zona, r.a_subzona, r.a_cargo, r.a_fecha, isCam)}
      ${arr}
      ${boxHtml(r.b_alias, r.b_empresa, r.b_concepto, r.b_zona, r.b_subzona, r.b_cargo, r.b_fecha, false)}
    </div>
    ${pills.length ? `<div class="mq-pills">${pills.join('')}</div>` : ''}
  </div>`;
}
function rowHtml(r, i) {
  const right = (r.kind === 'tra' || r.kind === 'cam') ? rightDuo(r) : rightSimple(r);
  return `<div class="mq-row" data-i="${i}">
    ${avatarHtml(r, i)}
    <div class="mq-mid">
      <div class="mq-nm">${esc(r.nombre || '—')}</div>
      <div class="mq-sub">${subLine(r)}</div>
    </div>
    <div class="mq-acts">
      <button class="mq-ib" data-open="${i}" title="Abrir ficha">${SVG.card}</button>
      <button class="mq-ib" data-copy="${i}" title="Copiar datos">${SVG.copy}</button>
    </div>
    ${right}
  </div>`;
}
function wireRows(host) {
  const rows = filtered().filter(r => r.kind === MQ.tab);
  // Clic en la foto -> lightbox (mismo patron que Buscar / Datos incompletos).
  host.querySelectorAll('.mq-av.pic').forEach(av =>
    av.addEventListener('click', () => {
      const row = av.closest('.mq-row');
      const r = row ? rows[parseInt(row.dataset.i, 10)] : null;
      if (!r || !r.thumb_url) return;
      openWorkerLightbox(r.thumb_url, `${r.nombre} · C.I. ${r.ced}`, `${r.ced}.jpg`);
    }));
  host.querySelectorAll('[data-open]').forEach(b =>
    b.addEventListener('click', () => {
      const r = rows[parseInt(b.dataset.open, 10)];
      if (r) openFicha(r);
    }));
  host.querySelectorAll('[data-copy]').forEach(b =>
    b.addEventListener('click', () => {
      const r = rows[parseInt(b.dataset.copy, 10)];
      if (!r) return;
      const alias = r.kind === 'egr' ? r.a_alias : (r.b_alias || r.a_alias);
      const emp = r.kind === 'egr' ? r.a_empresa : (r.b_empresa || r.a_empresa);
      const cargo = r.kind === 'egr' ? r.a_cargo : (r.b_cargo || r.a_cargo);
      const txt = `${r.nombre}\nC.I. ${cedFmt(r.ced)}\n${cargo || ''} · ${alias || ''} ${emp || ''}`.trim();
      navigator.clipboard.writeText(txt).then(() => {
        const o = b.innerHTML; b.innerHTML = '✓';
        setTimeout(() => { b.innerHTML = o; }, 1200);
      }).catch(() => {});
    }));
}

/* Ficha: reusa la vista Personal (patron Buscar). Para egresados se abre
   con la empresa de la que egreso (la ficha global muestra su trayectoria). */
function openFicha(r) {
  const alias = r.kind === 'egr' ? r.a_alias : (r.b_alias || r.a_alias);
  const tipo = r.kind === 'egr' ? r.a_tipo : (r.b_tipo || r.a_tipo);
  if (!alias) return;
  const mode = NON_STORE_TYPES.has(tipo) ? 'enterprise' : 'store';
  renderWorkerPhotos(MQ.user, alias, () => renderMovQuincena(MQ.user), { mode, openCed: r.ced });
}

/* ---------- export (lo visible de la pestaña activa) ---------- */
async function doExport(fmt) {
  const K = KINDS.find(x => x.k === MQ.tab);
  const rows = filtered().filter(r => r.kind === MQ.tab);
  if (!rows.length) { alert('No hay filas para exportar con los filtros actuales.'); return; }
  const data = rows.map(r => ({
    'Tipo': K ? K.lbl : r.kind,
    'Cédula': r.ced,
    'Nombre': r.nombre || '',
    'Sexo': r.genero || '',
    'Edad': ageOf(r.nacimiento) ?? '',
    'Empresa origen': r.a_alias ? `${r.a_alias} ${r.a_empresa || ''}`.trim() : '',
    'Cargo origen': r.a_cargo || '',
    'Fecha origen': r.a_fecha || '',
    'Empresa destino': r.b_alias ? `${r.b_alias} ${r.b_empresa || ''}`.trim() : '',
    'Cargo destino': r.b_cargo || '',
    'Fecha destino': r.b_fecha || '',
    'Zona': (r.kind === 'egr' ? r.a_zona : (r.b_zona || r.a_zona)) || '',
    'SubZona': (r.kind === 'egr' ? r.a_subzona : (r.b_subzona || r.a_subzona)) || '',
    'Concepto': (r.kind === 'egr' ? r.a_concepto : (r.b_concepto || r.a_concepto)) || '',
    'Detalle': [
      r.reingreso_fin ? `reingreso (egresó ${fmtDY(r.reingreso_fin)})` : '',
      r.dias_cargo != null ? `${r.dias_cargo} d en el cargo` : '',
      r.con_traslado ? 'con traslado' : '',
      r.misma_empresa ? 'misma empresa' : '',
      r.dir === 1 ? 'ascenso' : r.dir === -1 ? 'descenso' : '',
    ].filter(Boolean).join(' · '),
  }));
  const headers = Object.keys(data[0]);
  const fname = `movimientos_${MQ.tab}_${tstamp()}`;

  if (fmt === 'csv') {
    const escC = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [headers.join(';')].concat(data.map(r => headers.map(h => escC(r[h])).join(';')));
    downloadBlob('\uFEFF' + lines.join('\r\n'), `${fname}.csv`, 'text/csv;charset=utf-8');
    return;
  }
  if (fmt === 'txt') {
    const widths = headers.map(h => Math.max(h.length, ...data.map(r => String(r[h] ?? '').length)));
    const fmtRow = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
    const lines = [fmtRow(headers), widths.map(w => '-'.repeat(w)).join('  ')]
      .concat(data.map(r => fmtRow(headers.map(h => r[h]))));
    downloadBlob(lines.join('\r\n'), `${fname}.txt`, 'text/plain;charset=utf-8');
    return;
  }
  if (fmt === 'xlsx') {
    try {
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar la librería Excel.'));
          document.head.appendChild(s);
        });
      }
      const ws = window.XLSX.utils.json_to_sheet(data, { header: headers });
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, K ? K.lbl.slice(0, 30) : 'Movimientos');
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (e) { alert(e.message + ' Revisa tu conexión e inténtalo de nuevo.'); }
  }
}
