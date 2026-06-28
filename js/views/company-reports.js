/* =====================================================================
   js/views/company-reports.js  →  vista "Reportes de empresas"
   Fase 1. Lista de empresas con filtros (tipo/zona/subzona/concepto +
   busqueda por alias/RIF/razon social) y, al entrar a una, su dashboard
   de reportes + panel de rotacion (egresos con perfil capturado al salir,
   motivo reportado vs ratificado por el admin).

   Datos: /api/company-reports (actions list/facets/detail/rotation).
   Alcance por rol lo resuelve el endpoint. Export (xlsx/csv/txt) de la
   lista filtrada con el mismo patron que la vista Empresas (menu Exportar).

   Export: renderCompanyReports(user)  — user={ kind:'admin', id, role, name }
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
function monthBounds(off) {
  const t = caracasToday();
  let y = t.y, m = (t.m - 1) + off;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return { from: isoOf(new Date(Date.UTC(y, m, 1))), to: isoOf(new Date(Date.UTC(y, m + 1, 0))) };
}
function lastNDays(n) {
  const t = caracasToday();
  const today = new Date(Date.UTC(t.y, t.m - 1, t.d));
  const from = new Date(Date.UTC(t.y, t.m - 1, t.d));
  from.setUTCDate(from.getUTCDate() - (n - 1));
  return { from: isoOf(from), to: isoOf(today) };
}
const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function dLabel(ymd) {
  if (!ymd) return '';
  const mm = +String(ymd).slice(5, 7), dd = +String(ymd).slice(8, 10);
  return `${dd} ${MES[mm - 1] || ''}`;
}
function agoLabel(iso) {
  if (!iso) return '';
  const t = caracasToday();
  const today = Date.UTC(t.y, t.m - 1, t.d);
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const that = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const n = Math.round((today - that) / 86400000);
  if (n <= 0) return 'hoy';
  if (n === 1) return 'ayer';
  if (n < 30) return `hace ${n} días`;
  const m = Math.round(n / 30);
  return m <= 1 ? 'hace 1 mes' : `hace ${m} meses`;
}

const TOPIC = {
  marcaje: { label: 'Marcaje Manual', color: '#2563eb', icon: '\u{1F550}' },
  ausencia: { label: 'Ausencia', color: '#d97706', icon: '\u{1F4C5}' },
  ingreso: { label: 'Ingreso', color: '#16a34a', icon: '\u2795' },
  egreso: { label: 'Egreso', color: '#dc2626', icon: '\u{1F534}' },
  modificacion: { label: 'Modificaci\u00f3n', color: '#7c3aed', icon: '\u270F\uFE0F' },
};
const TOPIC_ORDER = ['marcaje', 'ausencia', 'ingreso', 'egreso', 'modificacion'];
const NON_STORE = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en l\u00ednea']);

/* ---------- estilos ---------- */
function ensureStyles() {
  if (document.getElementById('crStyles')) return;
  const st = document.createElement('style');
  st.id = 'crStyles';
  st.textContent = `
  .cr-head { display:flex; justify-content:space-between; align-items:flex-end; gap:14px; flex-wrap:wrap; }
  .cr-head h1 { margin:0; font-size:21px; font-weight:700; color:var(--ink); }
  .cr-head p { margin:3px 0 0; color:var(--muted); font-size:13px; }
  .cr-head-r { display:flex; gap:8px; align-items:flex-end; }

  .cr-field label { display:block; font-size:11px; color:var(--muted); margin:0 0 4px 2px; }
  .cr-field select, .cr-field input { width:100%; font:inherit; font-size:13px; padding:8px 11px;
    border:1px solid var(--border); border-radius:9px; background:var(--surface); color:var(--ink); }
  .cr-filters { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin:16px 0 0; }
  .cr-searchrow { display:grid; grid-template-columns:1fr auto auto; gap:10px; align-items:end; margin-top:10px; }
  .cr-btn { font:inherit; font-size:13px; padding:9px 16px; border:1px solid var(--border); border-radius:9px;
    background:var(--surface); color:var(--ink); cursor:pointer; }
  .cr-btn-primary { background:var(--brand); color:#fff; border-color:var(--brand); }
  @media(max-width:820px){ .cr-filters{grid-template-columns:repeat(2,1fr);} .cr-searchrow{grid-template-columns:1fr;} }

  .cr-kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:18px 0 6px; }
  .cr-kpi { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:15px 17px; box-shadow:0 1px 2px rgba(15,23,42,.06); }
  .cr-kpi .l { font-size:12px; color:var(--muted); margin-bottom:7px; }
  .cr-kpi .n { font-size:26px; font-weight:700; line-height:1; color:var(--ink); }
  .cr-kpi .sub { font-size:11px; color:var(--faint,#94a3b8); margin-top:6px; }
  @media(max-width:760px){ .cr-kpis{grid-template-columns:repeat(2,1fr);} }

  .cr-sec { margin:24px 0 10px; font-size:14px; font-weight:600; color:var(--ink); }
  .cr-sec small { font-weight:400; color:var(--muted); font-size:12px; margin-left:6px; }

  .cr-tablewrap { overflow:auto; border:1px solid var(--border); border-radius:14px; background:var(--surface); }
  table.cr-tbl { width:100%; border-collapse:collapse; font-size:12.5px; min-width:860px; }
  table.cr-tbl th, table.cr-tbl td { padding:10px 12px; text-align:left; border-bottom:1px solid var(--border-soft,#eef0f3); white-space:nowrap; }
  table.cr-tbl th { position:sticky; top:0; background:var(--surface2,#f8fafc); color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.03em; z-index:1; }
  table.cr-tbl th.num, table.cr-tbl td.num { text-align:right; }
  table.cr-tbl tr:last-child td { border-bottom:none; }
  table.cr-tbl tbody tr { cursor:pointer; }
  table.cr-tbl tbody tr:hover { background:var(--brand-bg,#eff6ff); }
  table.cr-tbl td.code { font-family:ui-monospace,Menlo,monospace; font-weight:700; color:var(--brand,#2563eb); }
  table.cr-tbl td.strong { font-weight:700; color:var(--ink); }
  .cr-dash { color:var(--faint,#cbd5e1); }
  .cr-typetag { display:inline-block; font-size:10.5px; font-weight:600; border-radius:999px; padding:1px 8px; }
  .t-tienda { color:#1e40af; background:#dbeafe; } .t-otra { color:#9a3412; background:#ffedd5; }
  .cr-cov { display:inline-flex; align-items:center; gap:6px; }
  .cr-cov .bar { width:46px; height:7px; border-radius:4px; background:var(--border-soft,#eef0f3); overflow:hidden; }
  .cr-cov .bar i { display:block; height:100%; border-radius:4px; background:var(--brand,#2563eb); }
  .cr-note { font-size:11.5px; color:var(--muted); margin:14px 2px 0; line-height:1.5; }
  .cr-empty { background:var(--surface); border:1px dashed var(--border); border-radius:14px; padding:18px; text-align:center; color:var(--muted); font-size:13px; }

  /* menu exportar (calcado de panel.css) */
  .export-wrap { position:relative; }
  .export-menu { position:absolute; right:0; top:calc(100% + 4px); background:var(--surface);
    border:1px solid var(--border); border-radius:var(--radius-md,10px); box-shadow:0 6px 20px rgba(0,0,0,0.12);
    z-index:50; min-width:150px; overflow:hidden; }
  .export-menu[hidden] { display:none; }
  .export-menu button { display:block; width:100%; text-align:left; border:0; background:none;
    padding:9px 14px; font-size:13px; cursor:pointer; font-family:inherit; color:var(--ink-soft); }
  .export-menu button:hover { background:var(--border-soft); }

  /* detalle empresa */
  .cr-back { background:none; border:0; color:var(--brand); cursor:pointer; font:inherit; font-size:13px;
    padding:4px 0; margin-bottom:6px; display:inline-flex; align-items:center; gap:6px; }
  .cr-idcard { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:18px 20px; box-shadow:0 1px 2px rgba(15,23,42,.06); margin-bottom:6px; }
  .cr-idcode { display:inline-block; font-family:ui-monospace,Menlo,monospace; font-weight:600; font-size:13px; color:var(--brand); background:var(--brand-bg); border-radius:6px; padding:2px 9px; }
  .cr-idname { margin:9px 0 14px; font-size:19px; font-weight:700; color:var(--ink); }
  .cr-idgrid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px 18px; }
  .cr-idgrid > div { display:flex; flex-direction:column; gap:3px; }
  .cr-idlbl { font-size:10.5px; text-transform:uppercase; letter-spacing:.03em; color:var(--muted); }
  .cr-idval { font-size:13.5px; color:var(--ink); }
  @media(max-width:680px){ .cr-idgrid{grid-template-columns:repeat(2,1fr);} }

  .cr-card { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:16px 18px; box-shadow:0 1px 2px rgba(15,23,42,.06); }
  .cr-two { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  @media(max-width:820px){ .cr-two{grid-template-columns:1fr;} }

  .cr-bars { display:flex; flex-direction:column; gap:11px; }
  .cr-brow { display:grid; grid-template-columns:150px 1fr 92px; align-items:center; gap:10px; }
  .cr-bl { font-size:12.5px; color:var(--ink-soft,#334155); display:flex; align-items:center; gap:7px; white-space:nowrap; }
  .cr-bl .dot { width:9px; height:9px; border-radius:3px; flex:0 0 auto; }
  .cr-bt { height:14px; border-radius:7px; background:var(--border-soft,#eef0f3); overflow:hidden; }
  .cr-bt i { display:block; height:100%; border-radius:7px; opacity:.92; }
  .cr-bn { font-size:12.5px; text-align:right; color:var(--ink); } .cr-bn b { font-weight:700; } .cr-bn span { color:var(--muted); font-size:11.5px; margin-left:4px; }

  .cr-trend { display:flex; align-items:flex-end; gap:6px; height:150px; padding:6px 2px 0; }
  .cr-tcol { flex:1; display:flex; flex-direction:column; align-items:center; gap:6px; height:100%; justify-content:flex-end; min-width:0; }
  .cr-tcol .bar { width:100%; max-width:24px; background:var(--brand,#2563eb); border-radius:6px 6px 0 0; opacity:.85; min-height:2px; }
  .cr-tcol .d { font-size:9px; color:var(--faint,#94a3b8); white-space:nowrap; }
  .cr-tcol .v { font-size:9px; color:var(--muted); }

  .cr-rrow { display:flex; align-items:center; gap:10px; padding:9px 4px; border-top:1px solid var(--border-soft,#eef0f3); }
  .cr-rrow:first-child { border-top:none; }
  .cr-pill { display:inline-block; font-size:11px; font-weight:600; border-radius:999px; padding:2px 9px; }
  .p-ratif { color:#166534; background:#dcfce7; } .p-rectif { color:#9a3412; background:#ffedd5; } .p-pend { color:#b45309; background:#fef3c7; }

  table.cr-rot { width:100%; border-collapse:collapse; font-size:12.5px; }
  table.cr-rot th, table.cr-rot td { padding:9px 11px; text-align:left; border-bottom:1px solid var(--border-soft,#eef0f3); vertical-align:top; }
  table.cr-rot th { color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.03em; }
  table.cr-rot tr:last-child td { border-bottom:none; }
  .cr-soon { display:inline-block; font-size:10px; font-weight:700; color:#7c3aed; background:#f3e8ff; border-radius:999px; padding:1px 8px; margin-left:6px; vertical-align:middle; }
  `;
  document.head.appendChild(st);
}

/* ---------- estado ---------- */
let CR_USER = null;
let CR_FROM = null, CR_TO = null;
let CR_FACETS = null;
let CR_ROWS = [];               // ultima lista (para exportar)
let CR_FILTERS = { type: '', zone_id: '', subzone_id: '', concept_id: '', search: '' };

/* ---------- entrada ---------- */
export async function renderCompanyReports(user) {
  CR_USER = user;
  ensureStyles();
  if (!CR_FROM || !CR_TO) { const b = lastNDays(90); CR_FROM = b.from; CR_TO = b.to; }
  await ensureFacets();
  renderListShell();
  loadList();
}

async function ensureFacets() {
  if (CR_FACETS) return CR_FACETS;
  try {
    const d = await api({ action: 'facets' });
    CR_FACETS = (d.ok && d.facets) ? d.facets : { types: [], zones: [], subzones: [], concepts: [] };
  } catch { CR_FACETS = { types: [], zones: [], subzones: [], concepts: [] }; }
  return CR_FACETS;
}

function api(extra) {
  return fetch('/api/company-reports', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: { kind: CR_USER.kind, id: CR_USER.id }, from: CR_FROM, to: CR_TO, ...extra }),
  }).then(r => r.json());
}

/* ===================== LISTA ===================== */
function renderListShell() {
  const f = CR_FACETS || {};
  const opt = (arr, idKey, nameKey, sel) =>
    (arr || []).map(o => `<option value="${esc(o[idKey])}"${String(o[idKey]) === String(sel) ? ' selected' : ''}>${esc(o[nameKey])}</option>`).join('');
  const typeOpts = (f.types || []).map(t => `<option value="${esc(t)}"${t === CR_FILTERS.type ? ' selected' : ''}>${esc(t)}</option>`).join('');

  $('#pnlMain').innerHTML = `
    <div class="cr-head">
      <div>
        <h1>Reportes de empresas</h1>
        <p>Filtra y entra a una empresa para ver sus reportes en detalle.</p>
      </div>
      <div class="cr-head-r">
        <div class="cr-field" style="min-width:170px">
          <label>Per\u00edodo</label>
          <select id="crPeriod">
            <option value="m0">Este mes</option>
            <option value="m1">Mes pasado</option>
            <option value="d30">\u00daltimos 30 d\u00edas</option>
            <option value="d90" selected>\u00daltimos 90 d\u00edas</option>
          </select>
        </div>
        <div class="export-wrap">
          <button class="cr-btn" id="crExportBtn">Exportar \u25be</button>
          <div class="export-menu" id="crExportMenu" hidden>
            <button data-fmt="xlsx">Excel (.xlsx)</button>
            <button data-fmt="csv">CSV (.csv)</button>
            <button data-fmt="txt">Texto (.txt)</button>
          </div>
        </div>
      </div>
    </div>

    <div class="cr-filters">
      <div class="cr-field"><label>Tipo de empresa</label>
        <select id="crType"><option value="">Todas</option>${typeOpts}</select></div>
      <div class="cr-field"><label>Zona</label>
        <select id="crZone"><option value="">Todas</option>${opt(f.zones, 'id', 'name', CR_FILTERS.zone_id)}</select></div>
      <div class="cr-field"><label>Subzona</label>
        <select id="crSub"><option value="">Todas</option>${opt(f.subzones, 'id', 'name', CR_FILTERS.subzone_id)}</select></div>
      <div class="cr-field"><label>Concepto / Marca</label>
        <select id="crConcept"><option value="">Todos</option>${opt(f.concepts, 'id', 'name', CR_FILTERS.concept_id)}</select></div>
    </div>
    <div class="cr-searchrow">
      <div class="cr-field"><label>Buscar por alias, RIF o raz\u00f3n social</label>
        <input id="crSearch" type="text" placeholder="Ej: AA01, J-12345678-9, Shoe Box\u2026" value="${esc(CR_FILTERS.search)}"></div>
      <button class="cr-btn cr-btn-primary" id="crBtnSearch">Buscar</button>
      <button class="cr-btn" id="crBtnClear">Limpiar</button>
    </div>

    <div id="crKpis"></div>
    <div class="cr-sec">Empresas <small>clic en una fila para ver su detalle \u00b7 ordenadas por total de reportes</small></div>
    <div id="crListBody"><div class="cr-empty">Cargando\u2026</div></div>
    <p class="cr-note">La cobertura compara contra las empresas que pasan el filtro. Un admin con alcance limitado solo ve sus empresas.</p>`;

  // eventos
  $('#crPeriod').addEventListener('change', onPeriod);
  $('#crBtnSearch').addEventListener('click', applyFilters);
  $('#crSearch').addEventListener('keydown', e => { if (e.key === 'Enter') applyFilters(); });
  $('#crBtnClear').addEventListener('click', clearFilters);
  // subzona depende de zona (filtra el combo en el cliente)
  $('#crZone').addEventListener('change', onZoneChange);

  // menu exportar
  const eb = $('#crExportBtn'), em = $('#crExportMenu');
  eb.addEventListener('click', e => { e.stopPropagation(); em.hidden = !em.hidden; });
  document.addEventListener('click', () => { if (em) em.hidden = true; });
  em.addEventListener('click', e => e.stopPropagation());
  em.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { em.hidden = true; exportList(b.dataset.fmt); }));
}

function onZoneChange() {
  const zid = $('#crZone').value;
  const subs = (CR_FACETS.subzones || []).filter(s => !zid || String(s.zone_id) === String(zid));
  $('#crSub').innerHTML = `<option value="">Todas</option>` +
    subs.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
}

function onPeriod(e) {
  const v = e.target.value;
  let b;
  if (v === 'm0') b = monthBounds(0);
  else if (v === 'm1') b = monthBounds(-1);
  else if (v === 'd30') b = lastNDays(30);
  else b = lastNDays(90);
  CR_FROM = b.from; CR_TO = b.to;
  loadList();
}

function applyFilters() {
  CR_FILTERS = {
    type: $('#crType').value,
    zone_id: $('#crZone').value,
    subzone_id: $('#crSub').value,
    concept_id: $('#crConcept').value,
    search: $('#crSearch').value.trim(),
  };
  loadList();
}
function clearFilters() {
  CR_FILTERS = { type: '', zone_id: '', subzone_id: '', concept_id: '', search: '' };
  ['crType', 'crZone', 'crSub', 'crConcept', 'crSearch'].forEach(id => { const el = $('#' + id); if (el) el.value = ''; });
  onZoneChange();
  loadList();
}

async function loadList() {
  const body = $('#crListBody');
  if (body) body.innerHTML = '<div class="cr-empty">Cargando\u2026</div>';
  let d;
  try {
    d = await api({ action: 'list', ...CR_FILTERS });
    if (!d.ok) throw new Error(d.error || 'Error');
  } catch (e) {
    if (body) body.innerHTML = `<div class="cr-empty">No se pudo cargar la lista.<br><small>${esc(String(e.message || e))}</small></div>`;
    return;
  }
  CR_ROWS = d.rows || [];
  paintKpis(CR_ROWS);
  paintList(CR_ROWS);
}

function paintKpis(rows) {
  const n = rows.length;
  const totalRep = rows.reduce((a, r) => a + (r.total || 0), 0);
  const withRep = rows.filter(r => (r.total || 0) > 0).length;
  const silent = n - withRep;
  const cov = n ? Math.round(withRep / n * 100) : 0;
  const k = $('#crKpis');
  if (k) k.innerHTML = `<div class="cr-kpis">
    <div class="cr-kpi"><div class="l">Empresas en el filtro</div><div class="n">${fmt(n)}</div><div class="sub">${dLabel(CR_FROM)} \u2013 ${dLabel(CR_TO)}</div></div>
    <div class="cr-kpi"><div class="l">Total de reportes</div><div class="n">${fmt(totalRep)}</div><div class="sub">en el per\u00edodo</div></div>
    <div class="cr-kpi"><div class="l">Cobertura</div><div class="n">${fmt(withRep)} <span style="font-size:14px;color:var(--faint,#94a3b8)">/ ${fmt(n)}</span></div><div class="sub">${cov}% report\u00f3 al menos 1 vez</div></div>
    <div class="cr-kpi"><div class="l">Sin reportes</div><div class="n" style="color:#dc2626">${fmt(silent)}</div><div class="sub">empresas en silencio</div></div>
  </div>`;
}

function paintList(rows) {
  const body = $('#crListBody');
  if (!body) return;
  if (!rows.length) { body.innerHTML = '<div class="cr-empty">Ninguna empresa pasa el filtro.</div>'; return; }
  const dash = v => v ? fmt(v) : '<span class="cr-dash">\u2014</span>';
  const head = `<thead><tr>
    <th>Alias</th><th>Raz\u00f3n social</th><th>Tipo</th><th>Zona \u00b7 Subzona</th>
    <th class="num">Total</th><th class="num">\u{1F550} Marc.</th><th class="num">\u{1F4C5} Aus.</th>
    <th class="num">\u2795 Ing.</th><th class="num">\u{1F534} Egr.</th><th class="num">\u270F\uFE0F Mod.</th><th class="num">% Atend.</th>
  </tr></thead>`;
  const tb = rows.map(r => {
    const tot = r.total || 0;
    const tcls = r.company_type === 'Tienda' ? 't-tienda' : 't-otra';
    const loc = [r.zona, r.subzona].filter(Boolean).join(' \u00b7 ') || '\u2014';
    const att = tot ? Math.round((r.attended || 0) / tot * 100) : 0;
    return `<tr data-code="${esc(r.company_code)}">
      <td class="code">${esc(r.company_code)}</td>
      <td>${esc(r.business_name || '')}</td>
      <td><span class="cr-typetag ${tcls}">${esc(r.company_type || '\u2014')}</span></td>
      <td>${esc(loc)}</td>
      <td class="num strong">${fmt(tot)}</td>
      <td class="num">${dash(r.marcaje)}</td><td class="num">${dash(r.ausencia)}</td>
      <td class="num">${dash(r.ingreso)}</td><td class="num">${dash(r.egreso)}</td><td class="num">${dash(r.modificacion)}</td>
      <td class="num">${tot ? `<span class="cr-cov"><span class="bar"><i style="width:${att}%"></i></span>${att}%</span>` : '<span class="cr-dash">\u2014</span>'}</td>
    </tr>`;
  }).join('');
  body.innerHTML = `<div class="cr-tablewrap"><table class="cr-tbl">${head}<tbody>${tb}</tbody></table></div>`;
  body.querySelectorAll('#crListBody tr, .cr-tbl tbody tr').forEach(tr =>
    tr.addEventListener('click', () => openDetail(tr.dataset.code)));
}

/* ===================== DETALLE ===================== */
async function openDetail(code) {
  if (!code) return;
  $('#pnlMain').innerHTML = `<div class="pnl-loading">Cargando\u2026</div>`;
  let det, rot;
  try {
    [det, rot] = await Promise.all([
      api({ action: 'detail', code }),
      api({ action: 'rotation', code }),
    ]);
    if (!det.ok) throw new Error(det.error || 'Error');
  } catch (e) {
    $('#pnlMain').innerHTML = `<div class="cr-empty">No se pudo cargar el detalle.<br><small>${esc(String(e.message || e))}</small></div>`;
    return;
  }
  paintDetail(det.detail || {}, (rot && rot.ok) ? (rot.rotation || {}) : {});
}

function paintDetail(det, rot) {
  const c = det.company || {};
  const k = det.kpis || {};
  const byType = det.by_type || {};
  const total = k.total || 0;
  const att = total ? Math.round((k.attended || 0) / total * 100) : 0;
  const avgDay = k.days ? (total / k.days).toFixed(1) : '0';

  // barras por tipo
  const maxType = Math.max(1, ...TOPIC_ORDER.map(t => byType[t] || 0));
  const bars = TOPIC_ORDER.map(t => {
    const m = TOPIC[t], n = byType[t] || 0, pct = total ? Math.round(n / total * 100) : 0;
    return `<div class="cr-brow">
      <span class="cr-bl"><span class="dot" style="background:${m.color}"></span>${m.icon} ${m.label}</span>
      <div class="cr-bt"><i style="width:${Math.round(n / maxType * 100)}%;background:${m.color}"></i></div>
      <span class="cr-bn"><b>${fmt(n)}</b><span>${pct}%</span></span></div>`;
  }).join('');

  // tendencia por semana
  const wk = det.by_week || [];
  const maxWk = Math.max(1, ...wk.map(w => w.n || 0));
  const trend = wk.length
    ? wk.map(w => `<div class="cr-tcol" title="${esc(w.wk)}: ${w.n}"><div class="v">${w.n || ''}</div>
        <div class="bar" style="height:${Math.round((w.n || 0) / maxWk * 100)}%"></div>
        <div class="d">${dLabel(w.wk)}</div></div>`).join('')
    : '<div class="cr-empty" style="border:none">Sin reportes en el periodo.</div>';

  // recientes
  const rec = det.recent || [];
  const recHtml = rec.length
    ? rec.map(r => {
      const m = TOPIC[r.topic] || { label: r.topic, icon: '\u2022' };
      const okPill = r.attention === 'attended';
      const pill = okPill ? '<span class="cr-pill p-ratif">Atendido</span>'
        : r.attention === 'annulled' ? '<span class="cr-pill p-rectif">Anulado</span>'
          : '<span class="cr-pill p-pend">Pendiente</span>';
      return `<div class="cr-rrow"><span style="font-size:15px">${m.icon}</span>
        <span style="flex:1;font-size:13px">${esc(m.label)}</span>${pill}
        <span style="font-size:11.5px;color:var(--muted);min-width:70px;text-align:right">${agoLabel(r.sent_at)}</span></div>`;
    }).join('')
    : '<div class="cr-empty" style="border:none">Sin reportes en el periodo.</div>';

  const idgrid = [
    ['Tipo', c.company_type], ['Zona', c.zona], ['Subzona', c.subzona], ['Concepto', c.marca],
    ['RIF', c.tax_id], ['Estado', c.status], ['Per\u00edodo', `${dLabel(CR_FROM)} \u2013 ${dLabel(CR_TO)}`],
  ].map(([l, v]) => `<div><span class="cr-idlbl">${l}</span><span class="cr-idval">${esc(v || '\u2014')}</span></div>`).join('');

  $('#pnlMain').innerHTML = `
    <button class="cr-back" id="crBack">\u2190 Volver a la lista</button>
    <div class="cr-idcard">
      <span class="cr-idcode">${esc(c.company_code || '')}</span>
      <div class="cr-idname">${esc(c.business_name || '')}</div>
      <div class="cr-idgrid">${idgrid}</div>
    </div>

    <div class="cr-kpis">
      <div class="cr-kpi"><div class="l">Total de reportes</div><div class="n">${fmt(total)}</div><div class="sub">en el per\u00edodo</div></div>
      <div class="cr-kpi"><div class="l">Atendidos</div><div class="n" style="color:#16a34a">${fmt(k.attended || 0)}</div><div class="sub">${att}% \u00b7 ${fmt(k.pending || 0)} pendientes</div></div>
      <div class="cr-kpi"><div class="l">Egresos</div><div class="n" style="color:#dc2626">${fmt(k.egresos || 0)}</div><div class="sub">en el per\u00edodo</div></div>
      <div class="cr-kpi"><div class="l">Promedio diario</div><div class="n">${avgDay}</div><div class="sub">reportes por d\u00eda</div></div>
    </div>

    <div class="cr-sec">Reportes por tipo</div>
    <div class="cr-card"><div class="cr-bars">${bars}</div></div>

    <div class="cr-two" style="margin-top:12px">
      <div><div class="cr-sec" style="margin-top:6px">Tendencia <small>por semana</small></div>
        <div class="cr-card"><div class="cr-trend">${trend}</div></div></div>
      <div><div class="cr-sec" style="margin-top:6px">\u00daltimos reportes</div>
        <div class="cr-card" style="padding:6px 12px">${recHtml}</div></div>
    </div>

    ${rotationHtml(rot)}`;

  $('#crBack').addEventListener('click', () => { renderListShell(); paintKpis(CR_ROWS); paintList(CR_ROWS); window.scrollTo(0, 0); });
  window.scrollTo(0, 0);
}

function rotationHtml(rot) {
  const k = (rot && rot.kpis) || {};
  const rows = (rot && rot.rows) || [];
  const eg = k.egresos || 0;
  if (!eg) {
    return `<div class="cr-sec">Rotaci\u00f3n de personal</div>
      <div class="cr-empty">Sin egresos en el periodo para esta empresa.</div>`;
  }
  const earlyPct = eg ? Math.round((k.early_exits || 0) / eg * 100) : 0;
  const tenureLbl = k.avg_tenure_days != null ? `${fmt(k.avg_tenure_days)} <span style="font-size:13px;color:var(--faint,#94a3b8)">d\u00edas</span>` : '\u2014';
  const ageLbl = k.avg_age != null ? `${k.avg_age} <span style="font-size:13px;color:var(--faint,#94a3b8)">a\u00f1os</span>` : '\u2014';

  const statusPill = (st, lbl) => {
    const m = { ratificado: 'p-ratif', rectificado: 'p-rectif', pendiente: 'p-pend' };
    return `<span class="cr-pill ${m[st] || 'p-pend'}">${esc(lbl || (st === 'pendiente' ? 'Sin revisar' : st))}</span>`;
  };
  const tb = rows.map(r => {
    const gap = r.admin_status === 'rectificado'
      ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">\u21b3 difiere de lo reportado</div>` : '';
    const adminLbl = r.admin_status === 'pendiente' ? 'Sin revisar'
      : (r.admin_reason_label || r.reason_label || '\u2014');
    return `<tr>
      <td><b>${esc(r.worker_name || '')}</b></td>
      <td>${esc(r.role || '\u2014')}</td>
      <td>${r.tenure_days != null ? fmt(r.tenure_days) + ' d' : '<span class="cr-dash">\u2014</span>'}</td>
      <td>${r.age != null ? r.age : '<span class="cr-dash">\u2014</span>'}</td>
      <td>${esc(r.reason_label || '\u2014')}</td>
      <td>${statusPill(r.admin_status, adminLbl)}${gap}</td>
    </tr>`;
  }).join('');

  return `
    <div class="cr-sec">Rotaci\u00f3n de personal <small>egresos del periodo \u00b7 usa el perfil capturado al egresar</small></div>
    <div class="cr-kpis">
      <div class="cr-kpi"><div class="l">Egresos</div><div class="n">${fmt(eg)}</div><div class="sub">en el per\u00edodo</div></div>
      <div class="cr-kpi"><div class="l">Antig\u00fcedad prom. al salir</div><div class="n">${tenureLbl}</div><div class="sub">de ${fmt(eg)} egresos</div></div>
      <div class="cr-kpi"><div class="l">Salidas tempranas</div><div class="n" style="color:#dc2626">${fmt(k.early_exits || 0)}</div><div class="sub">menos de 90 d\u00edas (${earlyPct}%)</div></div>
      <div class="cr-kpi"><div class="l">Edad promedio</div><div class="n">${ageLbl}</div><div class="sub">${fmt(k.with_age || 0)} de ${fmt(eg)} con fecha</div></div>
    </div>
    <div class="cr-sec" style="margin-top:18px">Motivos: lo que reporta la tienda vs. lo que ratifica el admin</div>
    <div class="cr-card" style="padding:0">
      <table class="cr-rot"><thead><tr>
        <th>Trabajador</th><th>Cargo</th><th>Antig.</th><th>Edad</th><th>Motivo reportado</th><th>Ratificaci\u00f3n del admin</th>
      </tr></thead><tbody>${tb}</tbody></table>
    </div>
    <p class="cr-note">El an\u00e1lisis inteligente autom\u00e1tico (deteccion de patrones y perfilado) se activar\u00e1 cuando haya suficiente volumen de egresos.<span class="cr-soon">An\u00e1lisis inteligente \u00b7 pr\u00f3ximamente</span></p>`;
}

/* ===================== EXPORTACION (xlsx / csv / txt) ===================== */
const EXPORT_HEADERS = ['Alias', 'Razon social', 'Tipo', 'Zona', 'Subzona', 'Total', 'Marcaje', 'Ausencia', 'Ingreso', 'Egreso', 'Modificacion', 'Atendidos', 'Pendientes', 'Anulados'];
function exportData() {
  return (CR_ROWS || []).map(r => [
    r.company_code, r.business_name || '', r.company_type || '', r.zona || '', r.subzona || '',
    r.total || 0, r.marcaje || 0, r.ausencia || 0, r.ingreso || 0, r.egreso || 0, r.modificacion || 0,
    r.attended || 0, r.pending || 0, r.annulled || 0,
  ]);
}
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}
const stamp = () => `${CR_FROM}_a_${CR_TO}`;
async function exportList(fmt) {
  const data = exportData();
  if (!data.length) { alert('No hay empresas para exportar con los filtros actuales.'); return; }
  const fname = `Reportes_empresas_${stamp()}`;

  if (fmt === 'csv') {
    const escc = v => { const s = String(v == null ? '' : v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [EXPORT_HEADERS, ...data].map(r => r.map(escc).join(';'));
    downloadBlob('\uFEFF' + lines.join('\r\n'), `${fname}.csv`, 'text/csv;charset=utf-8');
    return;
  }
  if (fmt === 'txt') {
    const rows = [EXPORT_HEADERS, ...data].map(r => r.map(String));
    const widths = EXPORT_HEADERS.map((_, i) => Math.max(...rows.map(r => r[i].length)));
    const fmtRow = r => r.map((c, i) => c.padEnd(widths[i])).join('  ');
    const sep = widths.map(w => '-'.repeat(w)).join('  ');
    const out = [`Reportes de empresas  -  ${CR_FROM} a ${CR_TO}`, '', fmtRow(rows[0]), sep, ...rows.slice(1).map(fmtRow)].join('\r\n');
    downloadBlob(out, `${fname}.txt`, 'text/plain;charset=utf-8');
    return;
  }
  if (fmt === 'xlsx') {
    let XLSX;
    try { XLSX = await ensureXLSX(); }
    catch { alert('No se pudo cargar el generador de Excel.'); return; }
    const aoa = [
      ['Reportes de empresas - Portal de Nomina Grupo Canaima'],
      [`Periodo: ${CR_FROM} a ${CR_TO}`],
      [],
      EXPORT_HEADERS,
      ...data,
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 8 }, { wch: 34 }, { wch: 14 }, { wch: 16 }, { wch: 18 }, { wch: 7 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 13 }, { wch: 11 }, { wch: 11 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Reportes');
    XLSX.writeFile(wb, `${fname}.xlsx`);
  }
}
