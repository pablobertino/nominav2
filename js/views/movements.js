/* =====================================================================
   js/views/movements.js — vista "Movimientos" (v5.93, fase 1)
   Ingresos, egresos, traslados y cambios de cargo del periodo, derivados
   de los cortes quincenales del sistema (hcm_snapshot) + role_history.

   Mockups aprobados:
     _PRUEBAS\movimientos_mockup_v3.html          (tablero Analisis, v5.94)
     _PRUEBAS\movimientos_mockup_v3_detalle.html  (pestaña Detalle, ESTA)

   ESTA v5.93 construye la pestaña DETALLE completa (v5.96 la ajusta):
   - Filtros (v5.96): SOLO por PERIODO del calendario (payroll_periods:
     quincenas + año completo) + zona/subzona/concepto/empresa. Las fechas
     libres se retiraron: el analisis es quincena contra quincena y el
     Detalle tambien se consulta por periodo. NADA preseleccionado.
   - Chips-filtro por tipo con icono y CONTEO (clicables: aislar/combinar;
     todo se trae de una vez y los chips filtran en cliente).
   - Buscador por coma (nombre, cedula, cargo o alias), orden, tabla con
     icono circular + pill por tipo, ⚠ egresos tempranos (<90 dias),
     ⏳ traslados en curso, fecha exacta/quincenal, alias clicable ->
     Personal (patron v5.89: Volver regresa aqui con todo intacto),
     paginacion 25/50/100 y Exportar xlsx/csv/txt (patron SheetJS).
   - La pestaña ANALISIS (v5.96, F1): fila de KPIs del mockup v3 — ing/egr/
     tras/cargo con delta vs la quincena anterior del calendario y NETO con
     plantilla al corte. Los conteos salen de la MISMA RPC del Detalle
     (nunca discrepan de los chips). Indicadores, dispersion y curva de
     supervivencia: F2-F3 (v5.97-v5.98).

   Datos por /api/movements (facets + list). Gate: view.movimientos.
   Export: renderMovements(user)
   ===================================================================== */

import { $ } from '../core/dom.js';
import { renderWorkerPhotos } from './worker-photos.js';

const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- iconos por tipo (los del mockup v3) ---------- */
const MI = {
  // persona con + (ingreso)
  ingreso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
  // persona con − (egreso)
  egreso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
  // flechas ida/vuelta (traslado)
  traslado: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>',
  // tendencia (cambio de cargo)
  cargo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>',
};
const TIPOS = [
  { key: 'ingreso',  cls: 'i', lbl: 'Ingresos',          pill: 'INGRESO' },
  { key: 'egreso',   cls: 'e', lbl: 'Egresos',           pill: 'EGRESO' },
  { key: 'traslado', cls: 't', lbl: 'Traslados',         pill: 'TRASLADO' },
  { key: 'cargo',    cls: 'c', lbl: 'Cambios de cargo',  pill: 'CARGO' },
];
const TIPO_BY_KEY = Object.fromEntries(TIPOS.map(t => [t.key, t]));

/* ---------- busqueda por coma (mismo criterio que Datos incompletos) ---------- */
function normSearch(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00f1/g, 'n');
}
function parseSearchGroups(q) {
  return normSearch(q)
    .split(',')
    .map(g => g.split(/\s+/).filter(Boolean))
    .filter(g => g.length);
}
function matchesSearch(m, groups) {
  if (!groups.length) return true;
  const blob = normSearch(`${m.id_number || ''} ${m.full_name || ''} ${m.job_from || ''} ${m.job_to || ''} ${m.alias_from || ''} ${m.alias_to || ''} ${m.company_name || ''}`);
  return groups.some(tokens => tokens.every(t => blob.includes(t)));
}

/* Letra de la cedula (regla de siempre: >= 80.000.000 -> E). */
function cedKind(ced) {
  return Number(String(ced || '').replace(/[^0-9]/g, '')) >= 80000000 ? 'E' : 'V';
}
/* 'YYYY-MM-DD' -> 'dd/mm' */
function ddmm(iso) {
  const s = String(iso || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}` : s;
}
function quincenaLabel(p) {
  return `${p.year}-${String(p.month).padStart(2, '0')}-Q${p.quincena} · ${ddmm(p.range_start)}–${ddmm(p.range_end)} ${MESES[p.month - 1] || ''}`;
}
/* ISO timestamptz -> 'dd/mm hh:mm' hora Caracas (nota de la cache). */
function fmtCache(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const c = new Date(d.getTime() - 4 * 3600 * 1000);
  const z = n => String(n).padStart(2, '0');
  return `${z(c.getUTCDate())}/${z(c.getUTCMonth() + 1)} ${z(c.getUTCHours())}:${z(c.getUTCMinutes())}`;
}

/* ---------- estado del modulo (sobrevive al ir a Personal y Volver) ---------- */
let USER = null;
let FACETS = null;       // { zones, subzones, concepts, types, companies }
let PERIODS = null;      // quincenas del calendario (desc)
let LAST_CUT = null;     // ultimo corte cargado
let CACHE_AT = null;     // ultimo recalculo de la cache de movimientos (v5.95)
let COMPANY_TYPE = null; // Map alias -> company_type (para store/enterprise)
let C = { period: '', from: '', to: '', zone: '', subzone: '', concept: '', company: '', q: '' };
let TYPES_ON = new Set(TIPOS.map(t => t.key));   // chips: todos encendidos
let SORT = 'fecha';      // fecha | nombre | antiguedad | alias
let ROWS = null;         // null = aun no consultado
let STATS = null;        // cabecera del tablero Analisis (F1 v5.96)
let PAGE = 1;
let PER = 50;
let TAB = 'detalle';     // detalle | analisis

function ensureStyles() {
  if (document.getElementById('mvStyles')) return;
  const st = document.createElement('style');
  st.id = 'mvStyles';
  /* Estilos atenuados del mockup v3. OJO: sin escapes octales (leccion v5.13). */
  st.textContent = `
  .mv-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .mv-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .mv-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--card,#fff);
    border:1px solid var(--border);border-radius:14px;padding:12px 14px;margin:14px 0 12px}
  .mv-filters label{font-size:11px;font-weight:700;color:var(--faint,#94a3b8)}
  .mv-filters select,.mv-filters input[type=date]{font:inherit;font-size:12.5px;padding:8px 10px;
    border:1px solid var(--border);border-radius:10px;background:var(--card,#fff);color:var(--ink);max-width:100%}
  .mv-qsel{font-weight:700;color:var(--brand,#2563eb);border-color:#c7d8f8 !important}
  .mv-or{font-size:11px;color:var(--faint,#94a3b8);font-weight:700;padding:0 2px}
  .mv-go{font:inherit;font-size:13.5px;font-weight:600;padding:9px 18px;border:1px solid var(--brand,#2563eb);
    border-radius:10px;background:var(--brand,#2563eb);color:#fff;cursor:pointer;white-space:nowrap}
  .mv-go:hover{filter:brightness(.96)}
  .mv-clear{font:inherit;font-size:12.5px;padding:8px 12px;border:1px solid var(--border);border-radius:10px;
    background:var(--card,#fff);color:var(--ink-soft,#475569);cursor:pointer}
  .mv-clear:hover{background:var(--bg-soft,#f1f5f9)}
  /* Pestañas */
  .mv-tabs{display:flex;gap:2px;border-bottom:2px solid var(--border);margin-bottom:14px}
  .mv-tab{font-size:13px;font-weight:700;padding:9px 18px;color:var(--muted);cursor:pointer;
    border-bottom:2px solid transparent;margin-bottom:-2px;user-select:none}
  .mv-tab.on{color:var(--brand,#2563eb);border-bottom-color:var(--brand,#2563eb)}
  /* Analisis proximamente */
  .mv-soon{background:var(--card,#fff);border:1px dashed var(--border);border-radius:14px;
    padding:34px 22px;text-align:center;color:var(--muted);font-size:13px;line-height:1.6}
  /* KPIs del tablero (mockup v3, F1 v5.96) */
  .mv-kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:14px}
  .mv-kpi{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;padding:12px 14px}
  .mv-kpi .t{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;letter-spacing:.4px;color:var(--faint,#94a3b8)}
  .mv-kpi .dot{width:7px;height:7px;border-radius:50%;flex:none}
  .mv-kpi .n{font-size:23px;font-weight:800;margin-top:3px;color:var(--ink)}
  .mv-kpi .d{font-size:11px;color:var(--muted);margin-top:2px}
  .mv-kpi .d .up{color:var(--ok,#0e9f6e);font-weight:700}
  .mv-kpi .d .dn{color:#b91c1c;font-weight:700}
  @media (max-width:900px){.mv-kpis{grid-template-columns:repeat(2,1fr)}}
  /* Chips-filtro por tipo */
  .mv-typechips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
  .mv-tc{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;padding:6px 12px;
    border:1px solid var(--border);border-radius:999px;background:var(--card,#fff);color:var(--ink-soft,#475569);
    cursor:pointer;user-select:none}
  .mv-tc svg{width:13px;height:13px}
  .mv-tc .n{font-weight:800}
  .mv-tc.on{border-width:1.5px}
  .mv-tc.i.on{border-color:var(--ok,#0e9f6e);color:var(--ok,#0e9f6e);background:#f5fbf8}
  .mv-tc.e.on{border-color:#d9a0a0;color:#b91c1c;background:#fdf7f7}
  .mv-tc.t.on{border-color:#9db9ea;color:var(--brand,#2563eb);background:#f7faff}
  .mv-tc.c.on{border-color:#c9a8e6;color:#7e22ce;background:#fbf7fe}
  .mv-cnt{font-size:12px;color:var(--muted)}
  /* Barra del detalle */
  .mv-detbar{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
  .mv-search{flex:1;min-width:260px;max-width:420px;display:flex;align-items:center;gap:8px;padding:0 12px;
    border:1px solid var(--border);border-radius:10px;background:var(--card,#fff)}
  .mv-search svg{flex:none;color:var(--muted)}
  .mv-search input{border:0;flex:1;padding:9px 0;font:inherit;font-size:12.5px;background:transparent;
    color:var(--ink);outline:none;min-width:0}
  .mv-detbar select{font:inherit;font-size:12.5px;padding:8px 10px;border:1px solid var(--border);
    border-radius:10px;background:var(--card,#fff);color:var(--ink)}
  .mv-export-wrap{position:relative;margin-left:auto}
  .mv-export-btn{font:inherit;font-size:12.5px;font-weight:600;padding:8px 13px;border:1px solid var(--border);
    border-radius:10px;background:var(--card,#fff);cursor:pointer;color:var(--ink-soft,#475569)}
  .mv-export-btn:hover{background:var(--bg-soft,#f1f5f9)}
  .mv-export-menu{position:absolute;z-index:30;top:calc(100% + 6px);right:0;min-width:150px;background:var(--card,#fff);
    border:1px solid var(--border);border-radius:11px;box-shadow:0 8px 28px rgba(15,23,42,.14);padding:6px;
    display:flex;flex-direction:column;gap:2px}
  .mv-export-menu[hidden]{display:none}
  .mv-export-menu button{font:inherit;font-size:13px;text-align:left;padding:9px 11px;border:0;border-radius:8px;
    background:transparent;color:var(--ink);cursor:pointer}
  .mv-export-menu button:hover{background:var(--bg-soft,#f1f5f9)}
  /* Tabla */
  .mv-wrap{overflow-x:auto}
  .mv-det{width:100%;border-collapse:collapse;font-size:12.5px;background:var(--card,#fff);
    border:1px solid var(--border);border-radius:13px;overflow:hidden}
  .mv-det th{background:var(--bg-soft,#f1f5f9);font-size:10px;letter-spacing:.4px;text-transform:uppercase;
    color:var(--ink-soft,#475569);padding:8px 12px;text-align:left;white-space:nowrap}
  .mv-det td{padding:9px 12px;border-top:1px solid var(--border-soft,#eef1f5);vertical-align:middle}
  .mv-det tr:hover td{background:#fbfcfe}
  .mv-type{display:flex;align-items:center;gap:8px}
  .mv-ic{width:28px;height:28px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex:none}
  .mv-ic svg{width:15px;height:15px}
  .mv-ic.i{background:#e9f7f1;color:var(--ok,#0e9f6e)} .mv-ic.e{background:#fdecec;color:#b91c1c}
  .mv-ic.t{background:#e8f0ff;color:var(--brand,#2563eb)} .mv-ic.c{background:#f3e8ff;color:#7e22ce}
  .mv-pill{font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;border:1px solid var(--border);
    color:var(--ink-soft,#475569);white-space:nowrap}
  .mv-pill.i{border-color:#bfe3d4;color:var(--ok,#0e9f6e)}.mv-pill.e{border-color:#ecc8c8;color:#b91c1c}
  .mv-pill.t{border-color:#c7d8f8;color:var(--brand,#2563eb)}.mv-pill.c{border-color:#dcc8f0;color:#7e22ce}
  .mv-who .nm{font-weight:700;color:var(--ink)}
  .mv-who .ced{font-size:11px;color:var(--muted);font-family:ui-monospace,Menlo,monospace}
  .mv-al{font-family:ui-monospace,Menlo,monospace;font-weight:700;color:var(--brand,#2563eb);cursor:pointer;
    border-bottom:1px dashed transparent}
  .mv-al:hover{border-bottom-color:var(--brand,#2563eb)}
  .mv-arr{color:var(--faint,#94a3b8);font-weight:400}
  .mv-updn{font-size:10.5px;font-weight:800;padding:2px 7px;border-radius:999px;white-space:nowrap}
  .mv-updn.up{background:#e9f7f1;color:var(--ok,#0e9f6e)}
  .mv-updn.dn{background:#fdf3e7;color:#b45309}
  .mv-updn.lat{background:var(--bg-soft,#f1f5f9);color:var(--muted)}
  .mv-early{font-size:10.5px;font-weight:700;color:#b45309;white-space:nowrap}
  .mv-ant{color:var(--ink-soft,#475569);white-space:nowrap}
  .mv-pend{font-size:10px;font-weight:700;color:#b45309;background:#fdf3e7;border-radius:999px;
    padding:2px 8px;white-space:nowrap}
  .mv-fecha{color:var(--ink-soft,#475569);font-variant-numeric:tabular-nums;white-space:nowrap}
  .mv-fecha small{display:block;color:var(--faint,#94a3b8);font-size:9.5px}
  .mv-empty,.mv-hint{padding:34px 14px;text-align:center;color:var(--muted);background:var(--card,#fff);
    border:1px solid var(--border);border-radius:13px}
  .mv-msg{color:#b45309;font-size:12.5px;margin:6px 2px}
  /* Paginador (patron del portal) */
  .mv-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:14px 2px 4px}
  .mv-pager .pg-per{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted)}
  .mv-pager .pg-per select{font:inherit;font-size:12.5px;padding:5px 8px;border:1px solid var(--border);
    border-radius:8px;background:var(--card,#fff);color:var(--ink)}
  .mv-pager .pg-nav{display:flex;align-items:center;gap:5px}
  .mv-pager .pg-nav button{min-width:32px;height:32px;padding:0 9px;border:1px solid var(--border);
    border-radius:8px;background:var(--card,#fff);color:var(--ink);cursor:pointer;font:inherit;font-size:12.5px}
  .mv-pager .pg-nav button:hover:not(:disabled){background:var(--bg-soft,#f1f5f9)}
  .mv-pager .pg-nav button:disabled{opacity:.45;cursor:default}
  .mv-pager .pg-nav button.on{background:var(--brand,#2563eb);color:#fff;border-color:var(--brand,#2563eb)}
  .mv-pager .pg-info{font-size:12px;color:var(--muted)}
  .mv-note{color:var(--muted);font-size:11.5px;line-height:1.55;max-width:920px;margin-top:14px}
  @media (max-width:768px){
    .mv-filters{gap:9px}
    .mv-filters .fg{flex:1 1 100%;display:flex;align-items:center;justify-content:space-between;gap:8px}
    .mv-filters .fg select,.mv-filters .fg input{flex:1 1 auto;min-width:0}
    .mv-go,.mv-clear{flex:1 1 auto}
    .mv-search{max-width:none}
    .mv-export-wrap{margin-left:0;flex:1 1 auto}
    .mv-export-btn{width:100%}
  }`;
  document.head.appendChild(st);
}

async function api(payload) {
  return fetch('/api/movements', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, user: USER }),
  }).then(x => x.json()).catch(() => null);
}

function subzonesFor(zoneId) {
  const all = (FACETS && FACETS.subzones) || [];
  if (!zoneId) return all;
  return all.filter(s => String(s.id).startsWith(zoneId + '_'));
}
function fillSelect(sel, items, current, placeholder) {
  if (!sel) return;
  sel.innerHTML = `<option value="">${placeholder}</option>`
    + items.map(it => `<option value="${esc(it.id)}">${esc(it.name)}</option>`).join('');
  sel.value = items.some(it => String(it.id) === String(current)) ? current : '';
}
function fillCompanySelect(sel, current) {
  if (!sel) return;
  const items = (FACETS && FACETS.companies) || [];
  sel.innerHTML = '<option value="">Todas</option>'
    + items.map(c => `<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.name)}</option>`).join('');
  sel.value = items.some(c => String(c.code) === String(current)) ? current : '';
}

export async function renderMovements(user) {
  USER = user;
  ensureStyles();

  $('#pnlMain').innerHTML = `
    <div class="mv-head"><h1>Movimientos de personal</h1>
      <p>Ingresos, egresos, traslados y cambios de cargo del período, derivados de los cortes quincenales del sistema.</p></div>
    <div class="mv-filters">
      <label>QUINCENA</label>
      <select id="mvPeriod" class="mv-qsel"><option value="">Elige…</option></select>
      <span class="fg"><label>ZONA</label> <select id="mvZone"><option value="">Todas</option></select></span>
      <span class="fg"><label>SUBZONA</label> <select id="mvSubzone"><option value="">Todas</option></select></span>
      <span class="fg"><label>CONCEPTO</label> <select id="mvConcept"><option value="">Todos</option></select></span>
      <span class="fg"><label>EMPRESA</label> <select id="mvCompany"><option value="">Todas</option></select></span>
      <button class="mv-go" id="mvGo">Generar</button>
      <button class="mv-clear" id="mvClear">Limpiar</button>
    </div>
    <div class="mv-msg" id="mvMsg" hidden></div>
    <div class="mv-tabs">
      <span class="mv-tab ${TAB === 'analisis' ? 'on' : ''}" data-tab="analisis">📊 Análisis</span>
      <span class="mv-tab ${TAB === 'detalle' ? 'on' : ''}" data-tab="detalle">📋 Detalle</span>
    </div>
    <div id="mvBody"></div>`;

  // Facetas + quincenas (cache de modulo: sobreviven a ir a Personal y Volver).
  if (!FACETS || !PERIODS) {
    const r = await api({ action: 'facets' });
    if (r && r.ok) {
      FACETS = r.facets || { zones: [], subzones: [], concepts: [], types: [], companies: [] };
      PERIODS = r.periods || [];
      LAST_CUT = r.last_cut || null;
      CACHE_AT = r.cache_at || null;
      COMPANY_TYPE = new Map((FACETS.companies || []).map(c => [String(c.code), c.type || '']));
    } else {
      FACETS = FACETS || { zones: [], subzones: [], concepts: [], types: [], companies: [] };
      PERIODS = PERIODS || [];
      showMsg((r && r.error) || 'No se pudieron cargar los filtros. Recarga la página.');
    }
  }

  // Combo QUINCENA: quincenas del calendario (desc) + año completo.
  const pSel = $('#mvPeriod');
  if (pSel) {
    const years = [...new Set((PERIODS || []).map(p => p.year))];
    pSel.innerHTML = '<option value="">Elige…</option>'
      + (PERIODS || []).map(p =>
          `<option value="${esc(p.range_start)}|${esc(p.range_end)}">${esc(quincenaLabel(p))}</option>`).join('')
      + years.map(y => `<option value="${y}-01-01|${y}-12-31">— ${y} completo —</option>`).join('');
    // Restaurar la seleccion previa (si el rango sigue existiendo en el combo).
    if (C.period && [...pSel.options].some(o => o.value === C.period)) pSel.value = C.period;
  }
  fillSelect($('#mvZone'), FACETS.zones || [], C.zone, 'Todas');
  fillSelect($('#mvSubzone'), subzonesFor(C.zone), C.subzone, 'Todas');
  fillSelect($('#mvConcept'), FACETS.concepts || [], C.concept, 'Todos');
  fillCompanySelect($('#mvCompany'), C.company);

  // Periodo elegido -> rango de fechas del calendario (v5.96: el periodo
  // es la UNICA forma de definir el rango; las fechas libres se retiraron).
  pSel?.addEventListener('change', () => {
    C.period = pSel.value;
    if (!C.period) { C.from = ''; C.to = ''; return; }
    const [a, b] = C.period.split('|');
    C.from = a; C.to = b;
  });

  $('#mvZone')?.addEventListener('change', () => {
    C.zone = $('#mvZone').value; C.subzone = '';
    fillSelect($('#mvSubzone'), subzonesFor(C.zone), '', 'Todas');
  });
  $('#mvSubzone')?.addEventListener('change', () => { C.subzone = $('#mvSubzone').value; });
  $('#mvConcept')?.addEventListener('change', () => { C.concept = $('#mvConcept').value; });
  $('#mvCompany')?.addEventListener('change', () => { C.company = $('#mvCompany').value; });

  $('#mvGo')?.addEventListener('click', run);
  $('#mvClear')?.addEventListener('click', () => {
    C = { period: '', from: '', to: '', zone: '', subzone: '', concept: '', company: '', q: '' };
    TYPES_ON = new Set(TIPOS.map(t => t.key));
    SORT = 'fecha'; ROWS = null; PAGE = 1;
    renderMovements(USER);
  });

  document.querySelectorAll('.mv-tab').forEach(t =>
    t.addEventListener('click', () => { TAB = t.dataset.tab; renderMovements(USER); }));

  document.addEventListener('click', closeMenus);
  paintBody();
}

function showMsg(text) {
  const el = $('#mvMsg');
  if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false; el.textContent = text;
}
function closeMenus() {
  const em = $('#mvExportMenu');
  if (em) em.hidden = true;
}

async function run() {
  showMsg('');
  if (!C.from || !C.to) { showMsg('Elige un período del calendario (una quincena o el año completo).'); return; }
  const body = $('#mvBody');
  if (body) body.innerHTML = '<div class="mv-hint">Generando…</div>';
  const filtros = {
    zone: C.zone || null, subzone: C.subzone || null,
    concept: C.concept || null, company: C.company || null,
  };
  const prev = prevRangeFor(C.period);
  const [r, rs] = await Promise.all([
    api({ action: 'list', from: C.from, to: C.to, ...filtros }),
    api({ action: 'stats', from: C.from, to: C.to,
          prev_from: prev ? prev.from : null, prev_to: prev ? prev.to : null,
          ...filtros }),
  ]);
  if (!r || !r.ok) {
    ROWS = null; STATS = null;
    if (body) body.innerHTML = `<div class="mv-empty">${esc((r && r.error) || 'No se pudo consultar. Intenta de nuevo.')}</div>`;
    return;
  }
  ROWS = r.rows || [];
  STATS = (rs && rs.ok) ? rs.stats : null;
  PAGE = 1;
  paintBody();
}

/* La quincena ANTERIOR del calendario a la elegida (para el delta de los
   KPIs). PERIODS viene desc; "año completo" o sin match -> null (sin delta). */
function prevRangeFor(periodValue) {
  if (!periodValue || !Array.isArray(PERIODS)) return null;
  const idx = PERIODS.findIndex(p => `${p.range_start}|${p.range_end}` === periodValue);
  if (idx < 0 || idx + 1 >= PERIODS.length) return null;
  const p = PERIODS[idx + 1];
  return { from: p.range_start, to: p.range_end };
}

/* ---------- cuerpo: pestaña activa ---------- */
function paintBody() {
  const body = $('#mvBody');
  if (!body) return;

  if (TAB === 'analisis') {
    paintAnalisis(body);
    return;
  }

  if (ROWS === null) {
    body.innerHTML = `<div class="mv-hint">Elige un <b>período</b> del calendario (una quincena o el año completo), refina por alcance y pulsa <b>Generar</b>.</div>`;
    return;
  }

  // Conteos por tipo (sobre el resultado del server, antes de chips/busqueda).
  const counts = { ingreso: 0, egreso: 0, traslado: 0, cargo: 0 };
  ROWS.forEach(m => { if (counts[m.tipo] != null) counts[m.tipo]++; });

  // Chips + barra + tabla (contenedores; la tabla la pinta paintTable()).
  body.innerHTML = `
    <div class="mv-typechips" id="mvChips">
      ${TIPOS.map(t => `
        <span class="mv-tc ${t.cls} ${TYPES_ON.has(t.key) ? 'on' : ''}" data-type="${t.key}">
          ${MI[t.key]}${t.lbl} <span class="n">${counts[t.key]}</span>
        </span>`).join('')}
      <span class="mv-cnt" id="mvChipNote"></span>
    </div>
    <div class="mv-detbar">
      <div class="mv-search">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="mvQ" type="text" placeholder="Filtrar por nombre, cédula, cargo o alias… (separa con coma)" autocomplete="off">
      </div>
      <select id="mvSort">
        <option value="fecha">Orden: Fecha (recientes primero)</option>
        <option value="nombre">Orden: Nombre A→Z</option>
        <option value="antiguedad">Orden: Antigüedad al egresar</option>
        <option value="alias">Orden: Empresa (alias)</option>
      </select>
      <div class="mv-export-wrap">
        <button class="mv-export-btn" id="mvExportBtn" type="button">Exportar ▾</button>
        <div class="mv-export-menu" id="mvExportMenu" hidden>
          <button data-fmt="xlsx">Excel (.xlsx)</button>
          <button data-fmt="csv">CSV (.csv)</button>
          <button data-fmt="txt">Texto (.txt)</button>
        </div>
      </div>
    </div>
    <div class="mv-wrap" id="mvTableWrap"></div>
    <div class="mv-pager" id="mvPager" hidden></div>
    <p class="mv-note"><b>Iconografía:</b> persona con <b>+</b> = ingreso (verde) · persona con <b>−</b> = egreso (rojo) ·
    <b>flechas ida/vuelta</b> = traslado (azul) · <b>tendencia</b> = cambio de cargo (morado), con ↑↓↔ según la jerarquía de cargos.
    Los mismos iconos viven en los <b>chips-filtro</b> de arriba, con el conteo por tipo (clic para aislar o combinar tipos).
    ⚠ marca los egresos tempranos (&lt;90 días). La columna Fecha indica si es <b>exacta</b> (ingresos/egresos, viene del contrato)
    o <b>quincenal</b> (traslados y cargos históricos${LAST_CUT ? `; último corte cargado: ${esc(ddmm(LAST_CUT))}` : ''};
    desde el 15/07 el trigger registra los cambios de cargo al día). Alias clicable → Personal.${CACHE_AT ? ` Movimientos calculados al ${esc(fmtCache(CACHE_AT))} (se recalculan cada madrugada y al cargar cortes nuevos).` : ''}</p>`;

  // Chips: aislar/combinar. Nunca quedan todos apagados: apagar el ultimo
  // vuelve a encenderlos todos (equivale a "todos").
  document.querySelectorAll('.mv-tc').forEach(ch =>
    ch.addEventListener('click', () => {
      const k = ch.dataset.type;
      if (TYPES_ON.has(k)) TYPES_ON.delete(k); else TYPES_ON.add(k);
      if (!TYPES_ON.size) TYPES_ON = new Set(TIPOS.map(t => t.key));
      PAGE = 1;
      document.querySelectorAll('.mv-tc').forEach(c2 =>
        c2.classList.toggle('on', TYPES_ON.has(c2.dataset.type)));
      paintTable();
    }));

  const qEl = $('#mvQ');
  if (qEl) {
    qEl.value = C.q || '';
    qEl.addEventListener('input', () => { C.q = qEl.value; PAGE = 1; paintTable(); });
  }
  const sSel = $('#mvSort');
  if (sSel) {
    sSel.value = SORT;
    sSel.addEventListener('change', () => { SORT = sSel.value; PAGE = 1; paintTable(); });
  }

  const exBtn = $('#mvExportBtn'), exMenu = $('#mvExportMenu');
  exBtn?.addEventListener('click', (e) => { e.stopPropagation(); exMenu.hidden = !exMenu.hidden; });
  exMenu?.addEventListener('click', (e) => e.stopPropagation());
  exMenu?.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { exMenu.hidden = true; doExport(b.dataset.fmt); }));

  paintTable();
}

/* ---------- pestaña ANALISIS (F1 v5.96): fila de KPIs del mockup ---------- */
function deltaLine(cur, prev, favorableUp) {
  // "▲ 12% vs Q anterior (207)" — flecha = direccion real del cambio;
  // color = favorable (verde) / desfavorable (rojo). Sin delta -> guion.
  if (prev == null) return 'sin quincena anterior para comparar';
  if (cur === prev) return `= vs Q anterior (${prev})`;
  const up = cur > prev;
  const arrow = up ? '▲' : '▼';
  const pct = prev > 0 ? ` ${Math.round(Math.abs(cur - prev) / prev * 100)}%` : '';
  const good = (favorableUp === null) ? null : (up === favorableUp);
  const cls = good === null ? '' : (good ? 'up' : 'dn');
  return `<span class="${cls}">${arrow}${pct}</span> vs Q anterior (${prev})`;
}

function paintAnalisis(body) {
  if (ROWS === null) {
    body.innerHTML = `<div class="mv-hint">Elige un <b>período</b> del calendario (una quincena o el año completo), refina por alcance y pulsa <b>Generar</b>.</div>`;
    return;
  }
  if (!STATS || !STATS.kpis) {
    body.innerHTML = `<div class="mv-empty">No se pudieron calcular los indicadores del período. Vuelve a pulsar <b>Generar</b>.</div>`;
    return;
  }
  const k = STATS.kpis;
  const p = STATS.prev || null;
  const pl = STATS.plantilla || null;
  const neto = (k.neto > 0 ? '+' : k.neto < 0 ? '−' : '') + Math.abs(k.neto);

  body.innerHTML = `
    <div class="mv-kpis">
      <div class="mv-kpi"><div class="t"><span class="dot" style="background:var(--ok,#0e9f6e)"></span>INGRESOS</div>
        <div class="n">${k.ing}</div><div class="d">${deltaLine(k.ing, p && p.ing, true)}</div></div>
      <div class="mv-kpi"><div class="t"><span class="dot" style="background:#b91c1c"></span>EGRESOS</div>
        <div class="n">${k.egr}</div><div class="d">${deltaLine(k.egr, p && p.egr, false)}</div></div>
      <div class="mv-kpi"><div class="t"><span class="dot" style="background:var(--brand,#2563eb)"></span>TRASLADOS</div>
        <div class="n">${k.tras}</div><div class="d">${deltaLine(k.tras, p && p.tras, null)}</div></div>
      <div class="mv-kpi"><div class="t"><span class="dot" style="background:#7e22ce"></span>CAMBIOS DE CARGO</div>
        <div class="n">${k.cargo}</div><div class="d">${deltaLine(k.cargo, p && p.cargo, null)}</div></div>
      <div class="mv-kpi"><div class="t"><span class="dot" style="background:#b45309"></span>NETO</div>
        <div class="n">${neto}</div><div class="d">${pl ? `plantilla ${pl.n.toLocaleString('es-VE')} al corte (${esc(ddmm(pl.cut))})` : 'sin corte en el período'}</div></div>
    </div>
    <div class="mv-soon">
      Indicadores del período, dispersión entre tiendas y curva de supervivencia por cohorte — próximas fases (v5.97–v5.98),
      cada indicador con su “?” hacia la <a href="/guias/indicadores-rotacion.html" target="_blank" rel="noopener">guía de indicadores</a>.
      El <b>Detalle</b> del período está en su pestaña, con buscador y exportación.
    </div>`;
}

/* Filas visibles: chips de tipo + busqueda por coma + orden. */
function visibleRows() {
  const groups = parseSearchGroups(C.q || '');
  let out = (ROWS || []).filter(m => TYPES_ON.has(m.tipo) && matchesSearch(m, groups));
  if (SORT === 'nombre') {
    out = out.slice().sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || ''), 'es'));
  } else if (SORT === 'antiguedad') {
    // Antiguedad al egresar: egresos primero, del mas temprano al mas viejo;
    // el resto despues, en su orden de fecha.
    out = out.slice().sort((a, b) => {
      const av = (a.tipo === 'egreso' && a.dias_antiguedad != null) ? a.dias_antiguedad : Infinity;
      const bv = (b.tipo === 'egreso' && b.dias_antiguedad != null) ? b.dias_antiguedad : Infinity;
      return av - bv || String(b.fecha || '').localeCompare(String(a.fecha || ''));
    });
  } else if (SORT === 'alias') {
    out = out.slice().sort((a, b) =>
      String(a.alias_to || a.alias_from || '').localeCompare(String(b.alias_to || b.alias_from || '')));
  }
  // 'fecha': el server ya viene fecha desc.
  return out;
}

function aliasLink(code, idx, side) {
  if (!code) return '';
  return `<span class="mv-al" data-al="${idx}" data-side="${side}" title="Ver Personal de ${esc(code)}">${esc(code)}</span>`;
}
function updnChip(u) {
  if (u === 'up') return ' <span class="mv-updn up">↑</span>';
  if (u === 'down') return ' <span class="mv-updn dn">↓</span>';
  if (u === 'lat') return ' <span class="mv-updn lat">↔</span>';
  return '';
}
function antCell(m) {
  if (m.tipo === 'egreso') {
    if (m.dias_antiguedad == null) return '—';
    return m.dias_antiguedad < 90
      ? `<span class="mv-early">⚠ ${m.dias_antiguedad} días</span>`
      : `<span class="mv-ant">${m.dias_antiguedad} d</span>`;
  }
  if (m.tipo === 'ingreso') {
    if (m.dias_antiguedad == null) return '—';
    return `<span class="mv-ant">${m.dias_antiguedad} d${m.en_curso ? ' y sigue' : ''}</span>`;
  }
  if (m.tipo === 'traslado' && m.en_curso) return `<span class="mv-pend">⏳ en curso</span>`;
  return '—';
}
function fechaCell(m) {
  if (m.fecha_kind === 'quincenal') return `<td class="mv-fecha">Q ${ddmm(m.fecha)}<small>quincenal</small></td>`;
  return `<td class="mv-fecha">${ddmm(m.fecha)}<small>exacta</small></td>`;
}

function paintTable() {
  const wrap = $('#mvTableWrap');
  const pager = $('#mvPager');
  const note = $('#mvChipNote');
  if (!wrap) return;

  const shown = visibleRows();
  if (note) {
    const total = (ROWS || []).length;
    note.textContent = shown.length === total
      ? `${total} movimiento${total === 1 ? '' : 's'} · clic en un chip para aislar el tipo`
      : `${shown.length} de ${total} movimientos (chips/búsqueda aplicados)`;
  }

  if (!(ROWS || []).length) {
    wrap.innerHTML = `<div class="mv-empty">Ningún movimiento en el período con esos filtros.</div>`;
    if (pager) pager.hidden = true;
    return;
  }
  if (!shown.length) {
    wrap.innerHTML = `<div class="mv-empty">Ninguno coincide con los chips o la búsqueda.</div>`;
    if (pager) pager.hidden = true;
    return;
  }

  const total = shown.length;
  const pages = Math.max(1, Math.ceil(total / PER));
  if (PAGE > pages) PAGE = pages;
  const start = (PAGE - 1) * PER;
  const pageRows = shown.slice(start, start + PER);

  wrap.innerHTML = `<table class="mv-det">
    <tr><th style="width:170px">Tipo</th><th>Persona</th><th>Ruta</th><th>Cargo</th><th>Antigüedad</th><th style="width:92px">Fecha</th></tr>
    ${pageRows.map((m, i) => {
      const idx = start + i;
      const t = TIPO_BY_KEY[m.tipo] || TIPOS[0];
      const tipo = `<div class="mv-type"><span class="mv-ic ${t.cls}">${MI[m.tipo] || ''}</span><span class="mv-pill ${t.cls}">${t.pill}</span></div>`;
      const who = `<div class="mv-who"><div class="nm">${esc(m.full_name || 'Sin nombre en el corte')}</div><div class="ced">${cedKind(m.id_number)}-${esc(m.id_number)}</div></div>`;
      let ruta = '';
      if (m.tipo === 'traslado') {
        ruta = `${aliasLink(m.alias_from, idx, 'from')} <span class="mv-arr">→</span> ${aliasLink(m.alias_to, idx, 'to')}`;
      } else {
        ruta = aliasLink(m.alias_to || m.alias_from, idx, m.alias_to ? 'to' : 'from');
      }
      let cargo = '—';
      if (m.tipo === 'ingreso') cargo = esc(m.job_to || '—');
      else if (m.tipo === 'egreso') cargo = esc(m.job_from || '—');
      else if (m.job_from || m.job_to) {
        cargo = (m.job_from && m.job_to && m.job_from !== m.job_to)
          ? `${esc(m.job_from)} → ${esc(m.job_to)}${updnChip(m.updown)}`
          : esc(m.job_to || m.job_from || '—');
      }
      return `<tr>
        <td>${tipo}</td>
        <td>${who}</td>
        <td>${ruta}</td>
        <td>${cargo}</td>
        <td>${antCell(m)}</td>
        ${fechaCell(m)}
      </tr>`;
    }).join('')}
  </table>`;

  // Alias clicable -> Personal de esa empresa (patron v5.89): Volver
  // re-renderiza esta vista y el estado (filtros/resultado/pagina) esta
  // a nivel de modulo, asi que regresa todo intacto.
  wrap.querySelectorAll('.mv-al').forEach(a =>
    a.addEventListener('click', () => {
      const m = shown[+a.dataset.al];
      if (!m) return;
      const code = a.dataset.side === 'from' ? m.alias_from : (m.alias_to || m.alias_from);
      openCompany(code);
    }));

  paintPager(pager, total, pages, start, pageRows.length);
}

function paintPager(pager, total, pages, start, shownCount) {
  if (!pager) return;
  pager.hidden = false;
  const from = total === 0 ? 0 : start + 1;
  const to = start + shownCount;
  const nums = [];
  const push = (n) => { if (n >= 1 && n <= pages && !nums.includes(n)) nums.push(n); };
  push(1); push(2);
  for (let n = PAGE - 1; n <= PAGE + 1; n++) push(n);
  push(pages - 1); push(pages);
  nums.sort((a, b) => a - b);
  let btns = '';
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) btns += `<span style="color:var(--faint,#94a3b8);padding:0 2px">…</span>`;
    btns += `<button data-pg="${n}" class="${n === PAGE ? 'on' : ''}">${n}</button>`;
    prev = n;
  }
  pager.innerHTML = `
    <div class="pg-per">Mostrar
      <select id="mvPer">
        <option value="25" ${PER === 25 ? 'selected' : ''}>25</option>
        <option value="50" ${PER === 50 ? 'selected' : ''}>50</option>
        <option value="100" ${PER === 100 ? 'selected' : ''}>100</option>
      </select> por página
    </div>
    <div class="pg-nav">
      <button data-pg="prev" ${PAGE <= 1 ? 'disabled' : ''}>‹</button>
      ${btns}
      <button data-pg="next" ${PAGE >= pages ? 'disabled' : ''}>›</button>
    </div>
    <div class="pg-info">${from}–${to} de ${total}</div>`;

  const perSel = pager.querySelector('#mvPer');
  if (perSel) perSel.addEventListener('change', () => { PER = parseInt(perSel.value, 10) || 50; PAGE = 1; paintTable(); });
  pager.querySelectorAll('.pg-nav button[data-pg]').forEach(b =>
    b.addEventListener('click', () => {
      const v = b.dataset.pg;
      if (v === 'prev') PAGE = Math.max(1, PAGE - 1);
      else if (v === 'next') PAGE = Math.min(pages, PAGE + 1);
      else PAGE = parseInt(v, 10) || 1;
      paintTable();
    }));
}

/* Abre el Personal completo de una empresa (patron v5.89, openCompany de
   Buscar): modo store/enterprise por el tipo de la empresa (facetas). */
function openCompany(code) {
  if (!code) return;
  const type = COMPANY_TYPE ? (COMPANY_TYPE.get(String(code)) || '') : '';
  const mode = NON_STORE_TYPES.has(type) ? 'enterprise' : 'store';
  renderWorkerPhotos(USER, code, () => renderMovements(USER), { mode });
}

/* -------- Exportacion (xlsx / csv / txt), patron del portal --------
   Exporta lo que se ve: chips de tipo + busqueda + ORDEN aplicados. */
const TIPO_EXPORT = { ingreso: 'Ingreso', egreso: 'Egreso', traslado: 'Traslado', cargo: 'Cambio de cargo' };
const UPDN_EXPORT = { up: '↑ Asciende', down: '↓ Baja', lat: '↔ Lateral' };
function exportRows() {
  return visibleRows().map(m => ({
    'Tipo': TIPO_EXPORT[m.tipo] || m.tipo,
    'Cédula': `${cedKind(m.id_number)}-${m.id_number || ''}`,
    'Nombre': m.full_name || '',
    'Alias origen': m.alias_from || '',
    'Alias destino': m.alias_to || '',
    'Empresa': m.company_name || '',
    'Zona': m.zona || '',
    'Subzona': m.subzona || '',
    'Concepto': m.concepto || '',
    'Cargo anterior': m.job_from || '',
    'Cargo nuevo': m.job_to || '',
    'Movimiento de cargo': m.updown ? (UPDN_EXPORT[m.updown] || m.updown) : '',
    'Fecha': String(m.fecha || '').slice(0, 10),
    'Precisión': m.fecha_kind || '',
    'Antigüedad (días)': m.dias_antiguedad != null ? m.dias_antiguedad : '',
    'Egreso temprano (<90d)': (m.tipo === 'egreso' && m.dias_antiguedad != null && m.dias_antiguedad < 90) ? 'Sí' : '',
    'En curso': m.en_curso ? 'Sí' : '',
  }));
}
function downloadBlob(content, filename, mime) {
  const blob = (content instanceof Blob) ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function tstamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
async function doExport(fmt) {
  const data = exportRows();
  if (!data.length) { showMsg('No hay filas para exportar. Genera el reporte primero.'); return; }
  showMsg('');
  const headers = Object.keys(data[0]);
  const fname = `movimientos_${tstamp()}`;

  if (fmt === 'csv') {
    const escv = (v) => {
      const s = String(v ?? '');
      return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.join(';')].concat(data.map(r => headers.map(h => escv(r[h])).join(';')));
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
      window.XLSX.utils.book_append_sheet(wb, ws, 'Movimientos');
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (e) {
      showMsg(e.message + ' Revisa tu conexión e inténtalo de nuevo.');
    }
    return;
  }
}
