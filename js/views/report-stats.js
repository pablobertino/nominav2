/* =====================================================================
   js/views/report-stats.js  →  vista "Estadisticas"
   Estadisticas de reportes sobre nomina_v2.reports_log (Opcion B).
   Llama a /api/report-stats con el alcance del usuario y un periodo.
   Muestra: KPIs (total, vs periodo anterior, cobertura, promedio diario),
   reportes por tipo, tendencia por dia, y cobertura por tienda (top que
   mas reportan + tiendas sin reportes).

   Export: renderReportStats(user)  — user = { kind:'admin', id, role, name }
   ===================================================================== */

import { ensureXLSX } from '../reports/shared/roster.js';

const $ = (s, r = document) => r.querySelector(s);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return Number(n || 0).toLocaleString('es-VE'); }

// Hoy en Venezuela (GMT-4 fijo).
function caracasToday() {
  const c = new Date(Date.now() - 4 * 3600 * 1000);
  return { y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate() };
}
const isoOf = (dt) => dt.toISOString().slice(0, 10);

// Rango del mes actual + offset (0 = este mes, -1 = mes pasado).
function monthBounds(off) {
  const t = caracasToday();
  let y = t.y, m = (t.m - 1) + off;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(y, m + 1, 0));
  return { from: isoOf(first), to: isoOf(last) };
}
// Ultimos n dias (incluye hoy).
function lastNDays(n) {
  const t = caracasToday();
  const today = new Date(Date.UTC(t.y, t.m - 1, t.d));
  const from = new Date(Date.UTC(t.y, t.m - 1, t.d));
  from.setUTCDate(from.getUTCDate() - (n - 1));
  return { from: isoOf(from), to: isoOf(today) };
}

const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function dLabel(ymd) {
  const mm = +String(ymd).slice(5, 7), dd = +String(ymd).slice(8, 10);
  return `${dd} ${MES[mm - 1] || ''}`;
}
// Lista de dias 'YYYY-MM-DD' entre from y to (inclusive).
function dayRange(from, to) {
  const out = [];
  const a = new Date(from + 'T00:00:00Z'), b = new Date(to + 'T00:00:00Z');
  for (let t = a.getTime(); t <= b.getTime(); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// Orden y estetica fija de los 5 tipos de reporte.
const TOPIC = {
  marcaje:      { label: 'Marcaje Manual', color: '#2563eb', icon: '\u{1F550}' },
  ausencia:     { label: 'Ausencia',       color: '#d97706', icon: '\u{1F4C5}' },
  ingreso:      { label: 'Ingreso',        color: '#16a34a', icon: '\u2795' },
  egreso:       { label: 'Egreso',         color: '#dc2626', icon: '\u{1F534}' },
  modificacion: { label: 'Modificaci\u00f3n', color: '#7c3aed', icon: '\u270F\uFE0F' },
};
const TOPIC_ORDER = ['marcaje', 'ausencia', 'ingreso', 'egreso', 'modificacion'];

function avatarColor(seed) {
  const s = String(seed || ''); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 6;
}
const AVATAR_BG = ['#dbeafe', '#dcfce7', '#fae8ff', '#fef9c3', '#ffedd5', '#e0e7ff'];
const AVATAR_FG = ['#1e40af', '#166534', '#86198f', '#854d0e', '#9a3412', '#3730a3'];

/* ---------- estilos ---------- */
function ensureStyles() {
  if (document.getElementById('rsStyles')) return;
  const st = document.createElement('style');
  st.id = 'rsStyles';
  st.textContent = `
  .rs-head { display:flex; justify-content:space-between; align-items:flex-end; gap:14px; flex-wrap:wrap; }
  .rs-head h1 { margin:0; font-size:21px; font-weight:700; color:var(--ink); }
  .rs-head p { margin:3px 0 0; color:var(--muted); font-size:13px; }
  .rs-filters { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .rs-filters select, .rs-filters input[type=date], .rs-btn {
    font:inherit; font-size:13px; padding:8px 12px; border:1px solid var(--border);
    border-radius:9px; background:var(--surface); color:var(--ink); }
  .rs-btn { cursor:pointer; } .rs-btn-primary { background:var(--brand,#2563eb); color:#fff; border-color:var(--brand,#2563eb); }
  .rs-custom { display:none; gap:8px; align-items:center; flex-wrap:wrap; }
  .rs-custom.on { display:flex; }
  .rs-quincena { display:none; }
  .rs-quincena.on { display:inline-block; }

  .rs-kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:16px 0 6px; }
  .rs-kpi { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:15px 17px; box-shadow:0 1px 2px rgba(15,23,42,.06); }
  .rs-kpi .l { font-size:12px; color:var(--muted); margin-bottom:7px; }
  .rs-kpi .n { font-size:26px; font-weight:700; line-height:1; color:var(--ink); }
  .rs-kpi .sub { font-size:11px; color:var(--faint,#94a3b8); margin-top:6px; }
  .rs-up { color:#16a34a; font-weight:700; } .rs-down { color:#dc2626; font-weight:700; }
  @media (max-width:760px){ .rs-kpis { grid-template-columns:repeat(2,1fr); } }

  .rs-sec { margin:24px 0 10px; font-size:14px; font-weight:600; color:var(--ink); }
  .rs-sec small { font-weight:400; color:var(--muted); font-size:12px; margin-left:6px; }
  .rs-card { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:16px 18px; box-shadow:0 1px 2px rgba(15,23,42,.06); }

  .rs-bars { display:flex; flex-direction:column; gap:11px; }
  .rs-brow { display:grid; grid-template-columns:160px 1fr 92px; align-items:center; gap:10px; }
  .rs-bl { font-size:12.5px; color:var(--ink-soft,#334155); display:flex; align-items:center; gap:7px; white-space:nowrap; }
  .rs-bl .dot { width:9px; height:9px; border-radius:3px; flex:0 0 auto; }
  .rs-bt { height:14px; border-radius:7px; background:var(--border-soft,#eef0f3); overflow:hidden; }
  .rs-bt i { display:block; height:100%; border-radius:7px; opacity:.92; }
  .rs-bn { font-size:12.5px; text-align:right; color:var(--ink); } .rs-bn b { font-weight:700; } .rs-bn span { color:var(--muted); font-size:11.5px; margin-left:4px; }

  .rs-trend { display:flex; align-items:flex-end; gap:5px; height:160px; padding:6px 2px 0; }
  .rs-tcol { flex:1; display:flex; flex-direction:column; align-items:center; gap:6px; height:100%; justify-content:flex-end; min-width:0; }
  .rs-tcol .bar { width:100%; max-width:26px; background:var(--brand,#2563eb); border-radius:6px 6px 0 0; opacity:.85; min-height:2px; }
  .rs-tcol .d { font-size:9px; color:var(--faint,#94a3b8); white-space:nowrap; }
  .rs-tcol .v { font-size:9px; color:var(--muted); }

  .rs-two { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  @media (max-width:760px){ .rs-two { grid-template-columns:1fr; } .rs-brow { grid-template-columns:120px 1fr 80px; } }

  .rs-csub { font-size:12.5px; font-weight:600; color:var(--ink-soft,#334155); margin-bottom:8px; display:flex; align-items:center; gap:8px; }
  .rs-lst { display:flex; flex-direction:column; }
  .rs-lrow { display:flex; align-items:center; gap:10px; padding:9px 2px; border-top:1px solid var(--border-soft,#eef0f3); }
  .rs-lrow:first-child { border-top:none; }
  .rs-rank { width:20px; text-align:center; font-weight:700; color:var(--faint,#94a3b8); font-size:12px; }
  .rs-code { font-family:ui-monospace,Menlo,monospace; font-weight:600; font-size:12px; color:var(--brand,#2563eb); background:var(--brand-bg,#eff6ff); border-radius:6px; padding:1px 7px; }
  .rs-nm { flex:1; min-width:0; font-size:13px; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rs-nm small { display:block; color:var(--muted); font-size:11px; }
  .rs-val { font-size:13px; font-weight:700; color:var(--ink); }
  .rs-pill { display:inline-block; font-size:11px; font-weight:600; border-radius:999px; padding:2px 9px; }
  .rs-pill-warn { color:#b45309; background:#fef3c7; } .rs-pill-bad { color:#991b1b; background:#fee2e2; } .rs-pill-ok { color:#166534; background:#dcfce7; }
  .rs-empty { background:var(--surface); border:1px dashed var(--border); border-radius:14px; padding:18px; text-align:center; color:var(--muted); font-size:13px; }
  .rs-note { font-size:11.5px; color:var(--muted); margin:14px 2px 0; line-height:1.5; }
  .rs-kpis5 { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; margin:6px 0 12px; }
  @media (max-width:880px){ .rs-kpis5 { grid-template-columns:repeat(2,1fr); } }
  .rs-actfilters { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:0 0 10px; }
  .rs-actfilters select { font:inherit; font-size:13px; padding:8px 12px; border:1px solid var(--border); border-radius:9px; background:var(--surface); color:var(--ink); }
  .rs-actfilters .sp { flex:1; }
  .rs-actwrap { overflow:auto; border:1px solid var(--border); border-radius:14px; background:var(--surface); }
  table.rs-act { width:100%; border-collapse:collapse; font-size:12.5px; min-width:780px; }
  table.rs-act th, table.rs-act td { padding:9px 11px; text-align:left; border-bottom:1px solid var(--border-soft,#eef0f3); white-space:nowrap; }
  table.rs-act th { position:sticky; top:0; background:var(--surface2,#f8fafc); color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.03em; z-index:1; }
  table.rs-act th.num, table.rs-act td.num { text-align:right; }
  table.rs-act tr:last-child td { border-bottom:none; }
  table.rs-act tbody tr:hover { background:var(--brand-bg,#eff6ff); }
  table.rs-act td.code { font-family:ui-monospace,Menlo,monospace; font-weight:700; color:var(--brand,#2563eb); }
  table.rs-act td.strong { font-weight:700; color:var(--ink); }
  table.rs-act td.ok { color:#16a34a; font-weight:600; } table.rs-act td.bad { color:#dc2626; font-weight:600; } table.rs-act td.gray { color:#64748b; }
  table.rs-act .rs-dash { color:var(--faint,#cbd5e1); }
  `;
  document.head.appendChild(st);
}

/* ---------- estado del periodo ---------- */
let RS_USER = null;
let RS_FROM = null, RS_TO = null;
let RS_PERIODS = null;      // cache de quincenas (payroll_periods)
let RS_QUINCENA_ID = null;  // id de la quincena elegida en modo quincena
let RS_STORES_TOTAL = 0;    // tiendas activas del alcance (para "X / Y")
let RS_LAST_SCOPE = 'scoped';
let RS_ACT_ROWS = [];       // ultima tabla de actividad por tienda
let RS_ACT_TOPIC = 'ALL';   // filtro Topico de la tabla
let RS_ACT_STATUS = 'ALL';  // filtro Estado (atencion) de la tabla

/* ---------- entrada ---------- */
export async function renderReportStats(user) {
  RS_USER = user;
  ensureStyles();
  if (!RS_FROM || !RS_TO) { const b = monthBounds(0); RS_FROM = b.from; RS_TO = b.to; }

  $('#pnlMain').innerHTML = `
    <div class="rs-head">
      <div>
        <h1>Estad\u00edsticas de reportes</h1>
        <p id="rsPeriodLbl">Cargando\u2026</p>
      </div>
      <div class="rs-filters">
        <select id="rsPreset">
          <option value="m0">Este mes</option>
          <option value="quincena">Quincena (pago)</option>
          <option value="m1">Mes pasado</option>
          <option value="d30">\u00daltimos 30 d\u00edas</option>
          <option value="d90">\u00daltimos 90 d\u00edas</option>
          <option value="custom">Personalizado\u2026</option>
        </select>
        <select class="rs-quincena" id="rsQuincena"></select>
        <span class="rs-custom" id="rsCustom">
          <input type="date" id="rsFrom" value="${RS_FROM}">
          <span style="color:var(--muted);font-size:12px">a</span>
          <input type="date" id="rsTo" value="${RS_TO}">
          <button class="rs-btn rs-btn-primary" id="rsApply">Aplicar</button>
        </span>
      </div>
    </div>
    <div id="rsBody"><div class="rs-empty">Cargando estad\u00edsticas\u2026</div></div>`;

  // Eventos (sin onclick inline por CSP).
  $('#rsPreset').addEventListener('change', onPreset);
  $('#rsApply').addEventListener('click', onApplyCustom);
  $('#rsQuincena').addEventListener('change', onQuincena);

  await loadStats();
}

async function onPreset(e) {
  const v = e.target.value;
  const custom = $('#rsCustom');
  const quin = $('#rsQuincena');
  custom.classList.toggle('on', v === 'custom');
  quin.classList.toggle('on', v === 'quincena');
  if (v === 'custom') return;
  if (v === 'quincena') { await selectQuincenaMode(); return; }
  let b;
  if (v === 'm0') b = monthBounds(0);
  else if (v === 'm1') b = monthBounds(-1);
  else if (v === 'd30') b = lastNDays(30);
  else if (v === 'd90') b = lastNDays(90);
  RS_FROM = b.from; RS_TO = b.to;
  $('#rsFrom').value = RS_FROM; $('#rsTo').value = RS_TO;
  loadStats();
}

// Carga las quincenas (una sola vez) desde payroll_periods.
async function ensurePeriods() {
  if (RS_PERIODS) return RS_PERIODS;
  try {
    const res = await fetch('/api/report-stats', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'periods', user: { kind: RS_USER.kind, id: RS_USER.id } }),
    });
    const d = await res.json();
    RS_PERIODS = (d.ok && Array.isArray(d.periods)) ? d.periods : [];
  } catch { RS_PERIODS = []; }
  return RS_PERIODS;
}

function quincenaLabel(p) {
  const mm = +String(p.range_start).slice(5, 7);
  const q = p.quincena === 1 ? '1\u00aa' : '2\u00aa';
  return `${q} quincena ${MES[mm - 1] || ''} ${p.year}`;
}

// Modo quincena: pobla el select, elige la que contiene hoy (o la previa) y carga.
async function selectQuincenaMode() {
  const sel = $('#rsQuincena');
  const pers = await ensurePeriods();
  if (!pers.length) { sel.innerHTML = '<option value="">(sin quincenas)</option>'; return; }
  sel.innerHTML = pers.map(p => `<option value="${p.id}">${esc(quincenaLabel(p))}</option>`).join('');
  const t = caracasToday();
  const todayIso = `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
  let chosen = (RS_QUINCENA_ID && pers.find(p => String(p.id) === String(RS_QUINCENA_ID)))
    || pers.find(p => p.range_start <= todayIso && p.range_end >= todayIso)
    || pers[0];
  RS_QUINCENA_ID = chosen.id;
  sel.value = String(chosen.id);
  RS_FROM = chosen.range_start; RS_TO = chosen.range_end;
  $('#rsFrom').value = RS_FROM; $('#rsTo').value = RS_TO;
  loadStats();
}

function onQuincena(e) {
  const p = (RS_PERIODS || []).find(x => String(x.id) === String(e.target.value));
  if (!p) return;
  RS_QUINCENA_ID = p.id;
  RS_FROM = p.range_start; RS_TO = p.range_end;
  $('#rsFrom').value = RS_FROM; $('#rsTo').value = RS_TO;
  loadStats();
}

function onApplyCustom() {
  const f = $('#rsFrom').value, t = $('#rsTo').value;
  if (!f || !t) return;
  if (f > t) { RS_FROM = t; RS_TO = f; } else { RS_FROM = f; RS_TO = t; }
  $('#rsFrom').value = RS_FROM; $('#rsTo').value = RS_TO;
  loadStats();
}

async function loadStats() {
  const body = $('#rsBody');
  body.innerHTML = '<div class="rs-empty">Cargando estad\u00edsticas\u2026</div>';
  let data;
  try {
    const res = await fetch('/api/report-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { kind: RS_USER.kind, id: RS_USER.id }, from: RS_FROM, to: RS_TO }),
    });
    data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Error');
  } catch (e) {
    body.innerHTML = `<div class="rs-empty">No se pudieron cargar las estad\u00edsticas.<br><small>${esc(String(e.message || e))}</small></div>`;
    return;
  }
  renderBody(data);
}

function renderBody(data) {
  const s = data.stats || {};
  const scopeNote = data.scope === 'all' ? 'Todo el grupo' : 'Tu alcance';
  $('#rsPeriodLbl').textContent = `${scopeNote} \u00b7 ${dLabel(RS_FROM)} \u2013 ${dLabel(RS_TO)} ${String(RS_TO).slice(0,4)}`;

  const total = s.total || 0;
  const prev = s.prev_total || 0;
  const delta = total - prev;
  let vsHtml;
  if (prev === 0) vsHtml = `<div class="n">${total ? '\u2014' : '0'}</div><div class="sub">sin base de comparaci\u00f3n</div>`;
  else {
    const pct = Math.round(delta / prev * 100);
    const cls = delta >= 0 ? 'rs-up' : 'rs-down';
    const arr = delta >= 0 ? '\u25B2' : '\u25BC';
    vsHtml = `<div class="n ${cls}">${arr} ${Math.abs(pct)}%</div><div class="sub">antes: ${fmt(prev)}</div>`;
  }

  const stTotal = s.stores_total || 0, stRep = s.stores_reported || 0;
  RS_STORES_TOTAL = stTotal;
  const cov = stTotal ? Math.round(stRep / stTotal * 100) : 0;

  const kpis = `
    <div class="rs-kpi"><div class="l">Total de reportes</div><div class="n">${fmt(total)}</div><div class="sub">${fmt(s.workers || 0)} trabajadores</div></div>
    <div class="rs-kpi"><div class="l">vs. periodo anterior</div>${vsHtml}</div>
    <div class="rs-kpi"><div class="l">Tiendas que reportaron</div><div class="n">${fmt(stRep)} <span style="font-size:14px;color:var(--faint,#94a3b8)">/ ${fmt(stTotal)}</span></div><div class="sub">${cov}% de cobertura</div></div>
    <div class="rs-kpi"><div class="l">Promedio diario</div><div class="n">${s.avg_per_day != null ? s.avg_per_day : 0}</div><div class="sub">reportes por d\u00eda</div></div>`;

  // Por tipo (orden fijo de los 5).
  const byTypeMap = {};
  (s.by_type || []).forEach(t => { byTypeMap[t.topic] = t; });
  const maxType = Math.max(1, ...TOPIC_ORDER.map(k => (byTypeMap[k] ? byTypeMap[k].n : 0)));
  const typeBars = TOPIC_ORDER.map(k => {
    const meta = TOPIC[k]; const row = byTypeMap[k] || { n: 0, workers: 0 };
    const pct = total ? Math.round(row.n / total * 100) : 0;
    return `<div class="rs-brow">
      <span class="rs-bl"><span class="dot" style="background:${meta.color}"></span>${meta.icon} ${meta.label}</span>
      <div class="rs-bt"><i style="width:${Math.round(row.n / maxType * 100)}%;background:${meta.color}"></i></div>
      <span class="rs-bn"><b>${fmt(row.n)}</b><span>${pct}%</span></span></div>`;
  }).join('');

  // Tendencia por dia (rellena dias sin reportes con 0).
  const byDay = {}; (s.by_day || []).forEach(g => { byDay[g.d] = g.n; });
  const days = dayRange(RS_FROM, RS_TO);
  const maxDay = Math.max(1, ...days.map(d => byDay[d] || 0));
  const showLabels = days.length <= 31;
  const trend = days.map(d => {
    const n = byDay[d] || 0;
    return `<div class="rs-tcol" title="${dLabel(d)}: ${n}">
      <div class="v">${n || ''}</div>
      <div class="bar" style="height:${Math.round((n / maxDay) * 100)}%"></div>
      ${showLabels ? `<div class="d">${String(d).slice(8, 10)}</div>` : ''}</div>`;
  }).join('');
  const trendHtml = days.length
    ? `<div class="rs-trend">${trend}</div>`
    : '<div class="rs-empty">Sin d\u00edas en el rango.</div>';

  // Cobertura: top + silenciosas.
  const top = s.top_stores || [];
  const topHtml = top.length
    ? top.map((t, i) => `<div class="rs-lrow"><span class="rs-rank">${i + 1}</span><span class="rs-code">${esc(t.company_code)}</span><span class="rs-nm">${esc(t.business_name || t.company_code)}<small>${esc([t.zone, t.subzone].filter(Boolean).join(' \u00b7 ') || '\u2014')}</small></span><span class="rs-val">${fmt(t.n)}</span></div>`).join('')
    : '<div class="rs-empty">Sin reportes en el periodo.</div>';

  const silent = s.silent_stores || [];
  const silentCount = s.silent_count || 0;
  const shown = silent.slice(0, 12);
  const silentHtml = silentCount === 0
    ? '<div class="rs-empty">Todas las tiendas del alcance reportaron \u{1F389}</div>'
    : shown.map(t => `<div class="rs-lrow"><span class="rs-code">${esc(t.company_code)}</span><span class="rs-nm">${esc(t.business_name || t.company_code)}<small>${esc([t.zone, t.subzone].filter(Boolean).join(' \u00b7 ') || '\u2014')}</small></span><span class="rs-pill rs-pill-warn">0</span></div>`).join('')
      + (silentCount > shown.length ? `<div class="rs-lrow"><span class="rs-nm" style="color:var(--muted);font-style:italic">\u2026 y ${fmt(silentCount - shown.length)} m\u00e1s</span></div>` : '');

  $('#rsBody').innerHTML = `
    <div class="rs-kpis">${kpis}</div>

    <div class="rs-sec">Reportes por tipo</div>
    <div class="rs-card"><div class="rs-bars">${typeBars}</div></div>

    <div class="rs-sec">Tendencia en el tiempo <small>reportes por d\u00eda</small></div>
    <div class="rs-card">${trendHtml}</div>

    <div class="rs-sec">Cobertura por tienda <small>tiendas activas del alcance: ${fmt(stTotal)}</small></div>
    <div class="rs-two">
      <div class="rs-card">
        <div class="rs-csub">Top tiendas que m\u00e1s reportaron</div>
        <div class="rs-lst">${topHtml}</div>
      </div>
      <div class="rs-card">
        <div class="rs-csub">Tiendas SIN reportes ${silentCount ? `<span class="rs-pill rs-pill-bad">${fmt(silentCount)}</span>` : `<span class="rs-pill rs-pill-ok">0</span>`}</div>
        <div class="rs-lst">${silentHtml}</div>
      </div>
    </div>

    <p class="rs-note">Los datos salen de los reportes enviados desde el portal (tabla propia). La cobertura compara contra las tiendas activas de tu alcance.</p>

    <div class="rs-sec">Actividad por tienda <small>una fila por tienda · estilo del portal anterior</small></div>
    <div class="rs-kpis5" id="rsActKpis"></div>
    <div class="rs-actfilters">
      <select id="rsActTopic">
        <option value="ALL">Tópico: todos</option>
        <option value="marcaje">Marcaje</option>
        <option value="ausencia">Ausencia</option>
        <option value="ingreso">Ingreso (Alta)</option>
        <option value="egreso">Egreso (Baja)</option>
        <option value="modificacion">Modificación</option>
      </select>
      <select id="rsActStatus">
        <option value="ALL">Estado: todos</option>
        <option value="attended">Atendidos</option>
        <option value="pending">Sin atender</option>
        <option value="annulled">Anulados</option>
      </select>
      <span class="sp"></span>
      <button class="rs-btn rs-btn-primary" id="rsActExport">⬇ Exportar Excel</button>
    </div>
    <div class="rs-actwrap" id="rsActTableWrap"><div class="rs-empty" style="border:none">Cargando actividad…</div></div>`;

  const tSel = $('#rsActTopic'); if (tSel) { tSel.value = RS_ACT_TOPIC; tSel.addEventListener('change', () => { RS_ACT_TOPIC = tSel.value; loadActivity(); }); }
  const sSel = $('#rsActStatus'); if (sSel) { sSel.value = RS_ACT_STATUS; sSel.addEventListener('change', () => { RS_ACT_STATUS = sSel.value; loadActivity(); }); }
  const xBtn = $('#rsActExport'); if (xBtn) xBtn.addEventListener('click', exportActivity);

  loadActivity();
}

/* ===================== ACTIVIDAD POR TIENDA (estilo del portal anterior) =====================
   Una fila por tienda con total + atendidos/sin atender/anulados + conteo por
   topico. Filtros Topico/Estado re-consultan el backend. Exporta a .xlsx con
   SheetJS (ensureXLSX). KPIs de la cabecera se derivan de las filas visibles. */
async function loadActivity() {
  const wrap = $('#rsActTableWrap');
  if (wrap) wrap.innerHTML = '<div class="rs-empty" style="border:none">Cargando actividad…</div>';
  let d;
  try {
    const res = await fetch('/api/report-stats', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'activity', user: { kind: RS_USER.kind, id: RS_USER.id },
        from: RS_FROM, to: RS_TO,
        topic: RS_ACT_TOPIC === 'ALL' ? null : RS_ACT_TOPIC,
        status: RS_ACT_STATUS === 'ALL' ? null : RS_ACT_STATUS,
      }),
    });
    d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Error');
  } catch (e) {
    if (wrap) wrap.innerHTML = `<div class="rs-empty" style="border:none">No se pudo cargar la actividad por tienda.<br><small>${esc(String(e.message || e))}</small></div>`;
    const k = $('#rsActKpis'); if (k) k.innerHTML = '';
    return;
  }
  RS_LAST_SCOPE = d.scope || RS_LAST_SCOPE;
  RS_ACT_ROWS = d.rows || [];
  paintActivity(RS_ACT_ROWS);
}

function paintActivity(rows) {
  const sum = key => rows.reduce((a, r) => a + (r[key] || 0), 0);
  const tot = sum('total'), att = sum('attended'), un = sum('unattended'), an = sum('annulled');
  const k = $('#rsActKpis');
  if (k) k.innerHTML = `
    <div class="rs-kpi"><div class="l">Total reportes</div><div class="n">${fmt(tot)}</div></div>
    <div class="rs-kpi"><div class="l">✅ Atendidos</div><div class="n" style="color:#16a34a">${fmt(att)}</div></div>
    <div class="rs-kpi"><div class="l">🔴 Sin atender</div><div class="n" style="color:#dc2626">${fmt(un)}</div></div>
    <div class="rs-kpi"><div class="l">⚫ Anulados</div><div class="n" style="color:#475569">${fmt(an)}</div></div>
    <div class="rs-kpi"><div class="l">Tiendas con reportes</div><div class="n">${fmt(rows.length)} <span style="font-size:13px;color:var(--faint,#94a3b8)">/ ${fmt(RS_STORES_TOTAL)}</span></div></div>`;

  const wrap = $('#rsActTableWrap');
  if (!wrap) return;
  if (!rows.length) { wrap.innerHTML = '<div class="rs-empty" style="border:none">Sin actividad de tiendas en el periodo con esos filtros.</div>'; return; }
  const dash = v => v ? fmt(v) : '<span class="rs-dash">—</span>';
  const head = `<thead><tr>
    <th>Alias</th><th>Zona</th><th>Marca</th>
    <th class="num">Total</th><th class="num">✅</th><th class="num">🔴</th><th class="num">⚫</th>
    <th class="num">Marcaje</th><th class="num">Ausencia</th><th class="num">Alta</th><th class="num">Baja</th><th class="num">Modif.</th>
  </tr></thead>`;
  const tb = rows.map(r => `<tr>
    <td class="code">${esc(r.company_code)}</td>
    <td>${esc(r.zona || '—')}</td>
    <td>${esc(r.marca || '—')}</td>
    <td class="num strong">${fmt(r.total)}</td>
    <td class="num ok">${dash(r.attended)}</td>
    <td class="num bad">${dash(r.unattended)}</td>
    <td class="num gray">${dash(r.annulled)}</td>
    <td class="num">${dash(r.marcaje)}</td>
    <td class="num">${dash(r.ausencia)}</td>
    <td class="num">${dash(r.ingreso)}</td>
    <td class="num">${dash(r.egreso)}</td>
    <td class="num">${dash(r.modificacion)}</td>
  </tr>`).join('');
  wrap.innerHTML = `<table class="rs-act">${head}<tbody>${tb}</tbody></table>`;
}

async function exportActivity() {
  const rows = RS_ACT_ROWS || [];
  if (!rows.length) { alert('No hay actividad para exportar con los filtros actuales.'); return; }
  const btn = $('#rsActExport');
  const prev = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Generando…'; }
  let XLSX;
  try { XLSX = await ensureXLSX(); }
  catch { if (btn) { btn.disabled = false; btn.textContent = prev; } alert('No se pudo cargar el generador de Excel.'); return; }

  const scopeNote = (RS_LAST_SCOPE === 'all') ? 'Todo el grupo' : 'Alcance del usuario';
  const topicLbl = RS_ACT_TOPIC === 'ALL' ? 'Todos' : (TOPIC[RS_ACT_TOPIC] ? TOPIC[RS_ACT_TOPIC].label : RS_ACT_TOPIC);
  const statusLbl = { ALL: 'Todos', attended: 'Atendidos', pending: 'Sin atender', annulled: 'Anulados' }[RS_ACT_STATUS] || 'Todos';

  const aoa = [];
  aoa.push(['Actividad por tienda - Portal de Nomina Grupo Canaima']);
  aoa.push([`Periodo: ${RS_FROM} a ${RS_TO}`, '', `Alcance: ${scopeNote}`, '', `Topico: ${topicLbl}`, '', `Estado: ${statusLbl}`]);
  aoa.push([]);
  aoa.push(['Alias', 'Zona', 'Marca', 'Total', 'Atendidos', 'Sin atender', 'Anulados', 'Marcaje', 'Ausencia', 'Alta (Ingreso)', 'Baja (Egreso)', 'Modificacion']);
  rows.forEach(r => aoa.push([
    r.company_code, r.zona || '', r.marca || '', r.total, r.attended, r.unattended, r.annulled,
    r.marcaje, r.ausencia, r.ingreso, r.egreso, r.modificacion,
  ]));
  const sum = key => rows.reduce((a, r) => a + (r[key] || 0), 0);
  aoa.push([]);
  aoa.push(['TOTAL', '', '', sum('total'), sum('attended'), sum('unattended'), sum('annulled'),
    sum('marcaje'), sum('ausencia'), sum('ingreso'), sum('egreso'), sum('modificacion')]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 8 }, { wch: 22 }, { wch: 16 }, { wch: 8 }, { wch: 10 }, { wch: 11 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 13 }, { wch: 13 }, { wch: 13 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Actividad');
  XLSX.writeFile(wb, `Actividad_por_tienda_${RS_FROM}_a_${RS_TO}.xlsx`);
  if (btn) { btn.disabled = false; btn.textContent = prev; }
}
