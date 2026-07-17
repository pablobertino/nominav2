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
   - La pestaña ANALISIS (v5.96-v5.99, COMPLETA): fila de KPIs con delta vs
     la quincena anterior y NETO con plantilla al corte (F1); panel de 6
     indicadores con "?" hacia la guia (F2); dispersion entre tiendas
     comparables con ranking clicable y curva de supervivencia por cohorte
     con selector (F3); diagnostico y recomendaciones por motor de reglas
     en el front (F4). Los conteos salen de la MISMA RPC del Detalle
     (nunca discrepan de los chips).
   - v6.00: PERIODO desde→hasta (rango de quincenas; el delta compara
     contra el bloque anterior del MISMO largo, con nota de fechas y
     aviso de rango corto); ranking de dispersion con FICHA COMPLETA en
     modal del portal (razon social, zona/subzona/concepto, filtro en
     vivo, codigo clicable -> Personal); indicadores con severidad por
     color y textos contra referencia; supervivencia segmentable por
     CARGO del primer ingreso (RPC cohortes_cargo, celdas >=5).
   - v6.01: la ficha de tiendas comparables pasa de modal a PAGINA propia
     (Volver al tablero intacto; el Volver de Personal regresa aqui), con
     columnas Razon social/Zona/Subzona/Concepto, filtro en vivo, orden y
     Exportar xlsx/csv/txt (motor comun exportTable; exporta lo visible).
   - v6.02: Exportar PDF en la pestaña Analisis (SOLO el analisis, sin el
     detalle nominal): jsPDF desde cdnjs (patron SheetJS), reporte
     dibujado programaticamente (membrete con periodo/alcance/fecha
     Caracas, KPIs con delta, 6 indicadores con severidad, banda y
     ranking de dispersion, curva de supervivencia redibujada + tabla de
     cohortes, tarjetas de diagnostico, pie numerado). Los textos salen
     del MISMO html de pantalla (pdfText): PDF y tablero no discrepan.

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
let C = { p1: '', p2: '', from: '', to: '', zone: '', subzone: '', concept: '', company: '', q: '' };
let TYPES_ON = new Set(TIPOS.map(t => t.key));   // chips: todos encendidos
let SORT = 'fecha';      // fecha | nombre | antiguedad | alias
let ROWS = null;         // null = aun no consultado
let STATS = null;        // cabecera del tablero Analisis (F1 v5.96)
let COHORT_SEL = '';     // cohorte elegida en la curva de supervivencia (F3)
let COHORT_CARGO = '';   // cargo elegido en la curva ('' = todos, v6.00)
let PREV_N = 0;          // cuantas quincenas mide el periodo elegido (v6.00)
let PREV_RANGE = null;   // {from,to} del bloque anterior del delta (v6.00)
let PREV_REASON = '';    // '' | 'anio' | 'nohist' cuando no hay bloque anterior
let PAGE = 1;
let PER = 50;
let TAB = 'detalle';     // detalle | analisis
let SUBVIEW = 'main';    // main | tiendas (ficha de comparables como pagina, v6.01)
let TQ = '';             // filtro en vivo de la ficha de tiendas
let TSORT = 'rot';       // orden de la ficha de tiendas

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
  /* Paneles del tablero (mockup v3, F2 v5.97) */
  .mv-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
  @media (max-width:900px){.mv-grid2{grid-template-columns:1fr}}
  .mv-panel{background:var(--card,#fff);border:1px solid var(--border);border-radius:14px;padding:16px 18px}
  .mv-panel h3{font-size:13px;margin:0 0 12px;color:var(--ink-soft,#475569)}
  .mv-rot{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  @media (max-width:520px){.mv-rot{grid-template-columns:1fr}}
  .mv-rk{border:1px solid var(--border-soft,#eef1f5);border-radius:11px;padding:12px 14px;background:#fbfcfe;position:relative}
  .mv-rk .v{font-size:23px;font-weight:800;color:var(--ink);letter-spacing:-.02em}
  .mv-rk .v.bad{color:#b91c1c}.mv-rk .v.warn{color:#b45309}.mv-rk .v.ok{color:var(--ok,#0e9f6e)}
  .mv-rk .l{font-size:11.5px;font-weight:700;color:var(--ink-soft,#475569);margin-top:2px}
  .mv-rk .e{font-size:11px;color:var(--muted);margin-top:4px;line-height:1.5}
  .mv-rk .q{position:absolute;top:8px;right:9px;width:17px;height:17px;border-radius:50%;
    background:#eef4ff;color:var(--brand,#2563eb);font-size:11px;font-weight:800;
    display:flex;align-items:center;justify-content:center;text-decoration:none;line-height:1}
  .mv-rk .q:hover{background:var(--brand,#2563eb);color:#fff}
  /* Dispersion entre tiendas + supervivencia (F3 v5.98) */
  .mv-band-wrap{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--muted);padding:6px 4px 2px}
  .mv-band{flex:1;height:14px;border-radius:8px;background:linear-gradient(90deg,#bfe3d4,#f3e0c0,#ecc8c8);position:relative}
  .mv-band .med{position:absolute;top:-5px;width:3px;height:24px;background:var(--ink);border-radius:2px}
  .mv-band-cap{text-align:center;font-size:10.5px;color:var(--faint,#94a3b8);margin:4px 0 10px}
  .mv-displists{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  @media (max-width:520px){.mv-displists{grid-template-columns:1fr}}
  .mv-displists h4{font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;color:var(--faint,#94a3b8);margin:0 0 5px}
  .mv-dl{list-style:none;margin:0;padding:0}
  .mv-dl li{display:flex;align-items:baseline;gap:8px;font-size:12px;padding:3px 0;border-bottom:1px dashed var(--border-soft,#eef1f5)}
  .mv-dl li:last-child{border-bottom:0}
  .mv-dl .rt{margin-left:auto;font-weight:800;font-variant-numeric:tabular-nums}
  .mv-dl.hi .rt{color:#b91c1c}.mv-dl.lo .rt{color:var(--ok,#0e9f6e)}
  .mv-dl .pl{font-size:10px;color:var(--faint,#94a3b8);white-space:nowrap}
  .mv-coh-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
  .mv-coh-head h3{margin:0}
  .mv-coh-head select{font:inherit;font-size:12px;padding:6px 9px;border:1px solid var(--border);
    border-radius:9px;background:var(--card,#fff);color:var(--ink);font-weight:600;margin-left:auto}
  .mv-surv text{font-family:inherit}
  /* Diagnostico y recomendaciones (F4 v5.99, mockup v3) */
  .mv-diag{border-left:3px solid var(--brand,#2563eb);background:#f7faff;border-radius:0 12px 12px 0;
    padding:13px 16px;margin-bottom:10px}
  .mv-diag.w{border-left-color:#b45309;background:#fdfaf4}
  .mv-diag.g{border-left-color:var(--ok,#0e9f6e);background:#f5fbf8}
  .mv-diag .h{font-size:12.5px;font-weight:800;margin-bottom:3px;color:var(--ink)}
  .mv-diag .ev{font-size:11.5px;color:var(--ink-soft,#475569);line-height:1.5;margin-bottom:6px}
  .mv-diag .ac{font-size:11.5px;color:var(--muted);line-height:1.55}
  .mv-diag .ac b{color:var(--ink-soft,#475569)}
  /* Ficha de tiendas comparables como PAGINA (v6.01, antes modal v6.00) */
  .mv-tp-bar{display:flex;gap:8px;align-items:center;margin:0 0 12px;flex-wrap:wrap}
  .mv-tp-bar .mv-search{max-width:380px}
  .mv-tp-table{width:100%;border-collapse:collapse;font-size:12.5px;background:var(--card,#fff);
    border:1px solid var(--border);border-radius:13px;overflow:hidden}
  .mv-tp-table th{background:var(--bg-soft,#f1f5f9);font-size:10px;letter-spacing:.4px;text-transform:uppercase;
    color:var(--ink-soft,#475569);padding:8px 12px;text-align:left;white-space:nowrap}
  .mv-tp-table td{padding:9px 12px;border-top:1px solid var(--border-soft,#eef1f5);vertical-align:middle}
  .mv-tp-table tr:hover td{background:#fbfcfe}
  .mv-tp-table td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .mv-tp-table .rk-n{color:var(--faint,#94a3b8);font-size:11px}
  .mv-tp-table .rz{color:var(--ink,#0f172a);font-weight:600}
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

  // v6.01: sub-pagina Ficha de tiendas comparables (se entra desde el
  // tablero; el Volver de Personal regresa aqui porque SUBVIEW persiste).
  if (SUBVIEW === 'tiendas') {
    if (STATS && STATS.dispersion && Array.isArray(STATS.dispersion.list) && STATS.dispersion.list.length) {
      renderTiendasPage();
      return;
    }
    SUBVIEW = 'main';   // sin stats vivos: de vuelta al tablero
  }

  $('#pnlMain').innerHTML = `
    <div class="mv-head"><h1>Movimientos de personal</h1>
      <p>Ingresos, egresos, traslados y cambios de cargo del período, derivados de los cortes quincenales del sistema.</p></div>
    <div class="mv-filters">
      <label>PERÍODO</label>
      <select id="mvP1" class="mv-qsel"><option value="">Desde…</option></select>
      <span class="mv-or">→</span>
      <select id="mvP2" class="mv-qsel"><option value="">Hasta…</option></select>
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

  // Combos de PERÍODO (v6.00): DESDE -> HASTA de quincenas del calendario.
  // Elegir solo DESDE = una quincena (HASTA se iguala). "Año completo"
  // vive en DESDE y deshabilita HASTA. Valores: 'q|start|end' / 'y|start|end'.
  const p1 = $('#mvP1'), p2 = $('#mvP2');
  const qOpt = (p) => `<option value="q|${esc(p.range_start)}|${esc(p.range_end)}">${esc(quincenaLabel(p))}</option>`;
  if (p1) {
    const years = [...new Set((PERIODS || []).map(p => p.year))];
    p1.innerHTML = '<option value="">Desde…</option>'
      + (PERIODS || []).map(qOpt).join('')
      + years.map(y => `<option value="y|${y}-01-01|${y}-12-31">— ${y} completo —</option>`).join('');
    if (C.p1 && [...p1.options].some(o => o.value === C.p1)) p1.value = C.p1;
  }
  fillP2();
  function fillP2() {
    if (!p2) return;
    const [k, s] = (C.p1 || '').split('|');
    if (k !== 'q') {   // sin desde, o año completo: HASTA no aplica
      p2.innerHTML = `<option value="">${k === 'y' ? '(año completo)' : 'Hasta…'}</option>`;
      p2.disabled = true; C.p2 = '';
      return;
    }
    p2.disabled = false;
    // Solo quincenas IGUALES O POSTERIORES a la de DESDE.
    const opts = (PERIODS || []).filter(p => p.range_start >= s);
    p2.innerHTML = opts.map(qOpt).join('');
    if (C.p2 && [...p2.options].some(o => o.value === C.p2)) p2.value = C.p2;
    else { C.p2 = C.p1; p2.value = C.p1; }
  }
  function rangeFromSel() {
    const a = (C.p1 || '').split('|');
    if (a[0] === 'y') { C.from = a[1]; C.to = a[2]; return; }
    if (a[0] !== 'q') { C.from = ''; C.to = ''; return; }
    const b = (C.p2 || C.p1).split('|');
    C.from = a[1]; C.to = b[2];
  }
  rangeFromSel();
  fillSelect($('#mvZone'), FACETS.zones || [], C.zone, 'Todas');
  fillSelect($('#mvSubzone'), subzonesFor(C.zone), C.subzone, 'Todas');
  fillSelect($('#mvConcept'), FACETS.concepts || [], C.concept, 'Todos');
  fillCompanySelect($('#mvCompany'), C.company);

  p1?.addEventListener('change', () => { C.p1 = p1.value; C.p2 = ''; fillP2(); rangeFromSel(); });
  p2?.addEventListener('change', () => { C.p2 = p2.value; rangeFromSel(); });

  $('#mvZone')?.addEventListener('change', () => {
    C.zone = $('#mvZone').value; C.subzone = '';
    fillSelect($('#mvSubzone'), subzonesFor(C.zone), '', 'Todas');
  });
  $('#mvSubzone')?.addEventListener('change', () => { C.subzone = $('#mvSubzone').value; });
  $('#mvConcept')?.addEventListener('change', () => { C.concept = $('#mvConcept').value; });
  $('#mvCompany')?.addEventListener('change', () => { C.company = $('#mvCompany').value; });

  $('#mvGo')?.addEventListener('click', run);
  $('#mvClear')?.addEventListener('click', () => {
    C = { p1: '', p2: '', from: '', to: '', zone: '', subzone: '', concept: '', company: '', q: '' };
    TYPES_ON = new Set(TIPOS.map(t => t.key));
    SORT = 'fecha'; ROWS = null; STATS = null; PAGE = 1;
    SUBVIEW = 'main'; TQ = ''; TSORT = 'rot';
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
  if (!C.from || !C.to) { showMsg('Elige el período: una quincena (desde), un rango de quincenas (desde → hasta) o el año completo.'); return; }
  const body = $('#mvBody');
  if (body) body.innerHTML = '<div class="mv-hint">Generando…</div>';
  const filtros = {
    zone: C.zone || null, subzone: C.subzone || null,
    concept: C.concept || null, company: C.company || null,
  };
  const prev = prevRange();
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

/* El bloque ANTERIOR del mismo largo para el delta de los KPIs (v6.00):
   si el período son N quincenas, se compara contra las N quincenas
   inmediatamente anteriores del calendario. Año completo o historia
   insuficiente -> null (sin delta). Deja PREV_N para el rotulo. */
function prevRange() {
  PREV_N = 0; PREV_RANGE = null; PREV_REASON = '';
  const a = (C.p1 || '').split('|');
  if (a[0] === 'y') { PREV_REASON = 'anio'; return null; }
  if (a[0] !== 'q' || !Array.isArray(PERIODS)) return null;
  const b = (C.p2 || C.p1).split('|');
  const i1 = PERIODS.findIndex(p => p.range_start === a[1]);   // desde (mas viejo)
  const i2 = PERIODS.findIndex(p => p.range_start === b[1]);   // hasta (mas nuevo)
  if (i1 < 0 || i2 < 0 || i2 > i1) return null;                // PERIODS viene desc
  const n = i1 - i2 + 1;
  PREV_N = n;   // largo del periodo elegido (rotulo del delta + nota de rango corto)
  if (i1 + n >= PERIODS.length) { PREV_REASON = 'nohist'; return null; }
  PREV_RANGE = { from: PERIODS[i1 + n].range_start, to: PERIODS[i1 + 1].range_end };
  return PREV_RANGE;
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
    body.innerHTML = `<div class="mv-hint">Elige el <b>período</b>: una quincena, un rango de quincenas (desde → hasta) o el año completo; refina por alcance y pulsa <b>Generar</b>.</div>`;
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
  // color = favorable (verde) / desfavorable (rojo). v6.00: si el periodo
  // son N quincenas, el bloque anterior mide N quincenas tambien.
  if (prev == null) return 'sin período anterior para comparar';
  const lbl = PREV_N === 1 ? 'Q anterior' : `${PREV_N} Q anteriores`;
  if (cur === prev) return `= vs ${lbl} (${prev})`;
  const up = cur > prev;
  const arrow = up ? '▲' : '▼';
  const pct = prev > 0 ? ` ${Math.round(Math.abs(cur - prev) / prev * 100)}%` : '';
  const good = (favorableUp === null) ? null : (up === favorableUp);
  const cls = good === null ? '' : (good ? 'up' : 'dn');
  return `<span class="${cls}">${arrow}${pct}</span> vs ${lbl} (${prev})`;
}

/* Nota bajo la fila de KPIs (v6.00): contra QUE bloque compara el delta,
   con fechas reales; nunca se comparan ventanas de largos distintos. Y
   aviso de rango corto: con 1 quincena los indicadores anualizados
   proyectan a 365 dias y amplifican variaciones puntuales. */
function deltaNote() {
  const Q = `<a class="q" style="position:static;display:inline-flex;width:15px;height:15px;border-radius:50%;background:#eef4ff;color:var(--brand,#2563eb);font-size:10px;font-weight:800;align-items:center;justify-content:center;text-decoration:none;vertical-align:middle" href="/guias/indicadores-rotacion.html#rot" target="_blank" rel="noopener" title="Qué mide y cómo se calcula">?</a>`;
  const parts = [];
  if (STATS && STATS.prev && PREV_RANGE) {
    parts.push(`Δ comparado contra ${PREV_N === 1 ? 'la quincena anterior' : `el bloque anterior del <b>mismo largo</b> (${PREV_N} quincenas)`}: ${esc(ddmm(PREV_RANGE.from))}–${esc(ddmm(PREV_RANGE.to))}.`);
  } else if (PREV_REASON === 'nohist') {
    const oldest = (Array.isArray(PERIODS) && PERIODS.length) ? PERIODS[PERIODS.length - 1].range_start : null;
    parts.push(`Sin bloque anterior del <b>mismo largo</b> (${PREV_N} quincena${PREV_N === 1 ? '' : 's'}) para comparar${oldest ? ` — el histórico arranca el ${esc(ddmm(oldest))}/${esc(String(oldest).slice(2, 4))}` : ''}; nunca se comparan ventanas de largos distintos.`);
  }
  if (PREV_N === 1) {
    parts.push(`Rango corto: los indicadores <b>anualizados</b> proyectan la quincena a 365 días y amplifican variaciones puntuales — para tendencia, compara un rango de quincenas o el año. ${Q}`);
  }
  if (!parts.length) return '';
  return `<p class="mv-note" style="margin:-4px 2px 14px">${parts.join(' ')}</p>`;
}

function paintAnalisis(body) {
  if (ROWS === null) {
    body.innerHTML = `<div class="mv-hint">Elige el <b>período</b>: una quincena, un rango de quincenas (desde → hasta) o el año completo; refina por alcance y pulsa <b>Generar</b>.</div>`;
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
    <div style="display:flex;justify-content:flex-end;margin:0 0 8px">
      <button class="mv-export-btn" id="mvPdfBtn" type="button" title="Reporte PDF del análisis (sin el detalle nominal)">Exportar PDF</button>
    </div>
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
    ${deltaNote()}
    ${paintIndicadores()}
    ${paintSurvival()}
    ${paintDiagnostico()}
    <p class="mv-note"><b>Nota honesta sobre las causas:</b> estos indicadores miden el <i>qué</i> con precisión (cuánta gente se va,
    cuándo y dónde), pero el <i>porqué</i> (¿selección? ¿pago? ¿trato? ¿estacionalidad?) requiere la encuesta de salida o el cruce
    por tienda/gerente que esta página facilita. La dispersión entre tiendas sugiere que “no se recluta bien” es solo parte de la
    historia: el mismo reclutamiento produce retención muy distinta según la tienda. El <b>Detalle</b> del período está en su
    pestaña, con buscador y exportación.</p>`;

  // Cableado del tablero: selector de cohorte (repinta la curva sin
  // refetch: todas las cohortes ya vienen en STATS) y tiendas clicables
  // del ranking -> Personal (patron v5.89).
  const cs = $('#mvCohSel');
  cs?.addEventListener('change', () => { COHORT_SEL = cs.value; paintAnalisis(body); });
  const cc = $('#mvCohCargo');
  cc?.addEventListener('change', () => { COHORT_CARGO = cc.value; paintAnalisis(body); });
  $('#mvPdfBtn')?.addEventListener('click', doExportPDF);
  $('#mvDispAll')?.addEventListener('click', () => {
    SUBVIEW = 'tiendas'; TQ = ''; TSORT = 'rot';
    renderMovements(USER);
  });
  body.querySelectorAll('.mv-al[data-code]').forEach(a =>
    a.addEventListener('click', () => openCompany(a.dataset.code)));
}

/* ---------- curva de supervivencia por cohorte (F3 v5.98, mockup v3) ---------- */
const MES_FULL = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function mesLabel(ym) {
  const m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
  return m ? `${MES_FULL[+m[2] - 1]} ${m[1]}` : ym;
}
function paintSurvival() {
  const all = (STATS && Array.isArray(STATS.cohortes)) ? STATS.cohortes : [];
  if (!all.length) return '';
  const porCargo = (STATS && Array.isArray(STATS.cohortes_cargo)) ? STATS.cohortes_cargo : [];
  const cargos = [...new Set(porCargo.map(x => x.cargo))];   // ya vienen en orden de jerarquia

  // Fuente segun el cargo elegido ('' = todos). Si el segmento quedo vacio
  // (cargo sin celdas >=5 con estos filtros), se vuelve a Todos.
  let src = COHORT_CARGO ? porCargo.filter(x => x.cargo === COHORT_CARGO) : all;
  if (!src.length) { COHORT_CARGO = ''; src = all; }
  if (!src.some(c => c.mes === COHORT_SEL)) COHORT_SEL = src[0].mes;
  const c = src.find(x => x.mes === COHORT_SEL);

  // Puntos de la curva: solo los checkpoints que la cohorte ya maduro
  // (la RPC manda null en los que aun no llegan). 'Hoy' siempre, naranja.
  const pts = [
    { lbl: 'Ingreso', v: 100 },
    { lbl: '1 mes',   v: c.s30 },
    { lbl: '3 meses', v: c.s90 },
    { lbl: '6 meses', v: c.s180 },
    { lbl: 'Hoy',     v: c.vivos, hoy: true },
  ].filter(p => p.v != null);
  const n = pts.length;
  const X = (i) => Math.round(60 + i * (485 / Math.max(1, n - 1)));
  const Y = (v) => Math.round((115 - v * 0.9) * 10) / 10;
  const line = pts.map((p, i) => `${X(i)},${Y(p.v)}`).join(' ');
  const poly = `${line} ${X(n - 1)},115 ${X(0)},115`;
  const cargoLbl = COHORT_CARGO ? ` · ${esc(COHORT_CARGO)}` : '';

  return `
    <div class="mv-panel" style="margin-bottom:14px">
      <div class="mv-coh-head">
        <h3>Supervivencia · cohorte de ingreso ${esc(mesLabel(c.mes))}${cargoLbl} (${c.size.toLocaleString('es-VE')} personas)</h3>
        <select id="mvCohCargo" title="Segmentar la cohorte por el cargo del primer ingreso">
          <option value="">Todos los cargos</option>
          ${cargos.map(x => `<option value="${esc(x)}" ${x === COHORT_CARGO ? 'selected' : ''}>${esc(x)}</option>`).join('')}
        </select>
        <select id="mvCohSel" style="margin-left:0">
          ${src.map(x => `<option value="${esc(x.mes)}" ${x.mes === COHORT_SEL ? 'selected' : ''}>${esc(mesLabel(x.mes))} · ${x.size.toLocaleString('es-VE')} personas</option>`).join('')}
        </select>
      </div>
      <svg class="mv-surv" viewBox="0 0 600 140" style="width:100%;max-width:680px;display:block">
        <line x1="45" y1="115" x2="575" y2="115" stroke="#e2e8f0" stroke-width="1"/>
        <line x1="45" y1="70" x2="575" y2="70" stroke="#eef1f5" stroke-width="1"/>
        <line x1="45" y1="25" x2="575" y2="25" stroke="#eef1f5" stroke-width="1"/>
        <text x="38" y="28" text-anchor="end" font-size="9" fill="#94a3b8">100%</text>
        <text x="38" y="73" text-anchor="end" font-size="9" fill="#94a3b8">50%</text>
        <text x="38" y="118" text-anchor="end" font-size="9" fill="#94a3b8">0%</text>
        <polygon points="${poly}" fill="#eaf1fd"/>
        <polyline points="${line}" fill="none" stroke="#2563eb" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
        ${pts.map((p, i) => `
          <circle cx="${X(i)}" cy="${Y(p.v)}" r="${p.hoy ? 4.5 : 3.5}" fill="${p.hoy ? '#b45309' : '#2563eb'}"/>
          <text x="${X(i)}" y="${Math.max(11, Y(p.v) - 11)}" text-anchor="middle" font-size="10" font-weight="${p.hoy ? '800' : '700'}" fill="${p.hoy ? '#b45309' : '#0f172a'}">${p.v}%</text>
          <text x="${X(i)}" y="131" text-anchor="middle" font-size="9" fill="#94a3b8">${esc(p.lbl)}</text>`).join('')}
      </svg>
      <p class="mv-note" style="margin-top:6px">Supervivencia <b>en el grupo</b>: la recontratación (misma u otra empresa) cuenta como seguir.
      Los cortes de 1/3/6 meses aparecen cuando la cohorte completa madura hasta ese punto. El poder está en <b>comparar curvas</b>
      con los selectores — por mes o por <b>cargo del primer ingreso</b> (segmentos con al menos 5 personas); la curva que “cae menos” señala dónde algo se hizo mejor.
      <a class="q" style="position:static;display:inline-flex;width:16px;height:16px;border-radius:50%;background:#eef4ff;color:var(--brand,#2563eb);font-size:10px;font-weight:800;align-items:center;justify-content:center;text-decoration:none;vertical-align:middle" href="/guias/indicadores-rotacion.html#coho" target="_blank" rel="noopener" title="Qué mide y cómo se calcula">?</a></p>
    </div>`;
}

/* ---------- Diagnóstico y recomendaciones (F4 v5.99, mockup v3) ----------
   Motor de reglas EN EL FRONT sobre los stats ya certificados (F1-F3).
   Cada regla: umbral -> tarjeta hallazgo/evidencia/acción con los textos
   del mockup v3 y los números vivos del período/filtros elegidos.
   Umbrales: temprana > 50% · dispersión ≥ 3× (max/mediana, o max/min si
   min > 0) · reincidentes ≥ 50. Sin hallazgos -> se dice, no se inventa. */
function paintDiagnostico() {
  const i = (STATS && STATS.indicadores) || null;
  if (!i) return '';
  const d = (STATS && STATS.dispersion) || null;
  const cards = [];
  const fmt = (x) => (x == null ? '—' : Number(x).toLocaleString('es-VE'));

  // Regla 1 (⚠ warn): rotación temprana > 50%.
  if (i.temprana90 != null && i.temprana90 > 50) {
    const de10 = Math.round(i.temprana90 / 10);
    cards.push(`
      <div class="mv-diag w">
        <div class="h">⚠ ${de10} de cada 10 egresos ocurren antes de los 90 días${i.temprana_vendedor != null ? ` (${i.temprana_vendedor}% en vendedores)` : ''}</div>
        <div class="ev"><b>Evidencia:</b> ${i.temprana90}% de ${fmt(i.egr_total)} egresos con &lt;90 días${i.mediana_egreso != null ? `; mediana de permanencia ${i.mediana_egreso} días` : ''}${i.temprana30 != null ? `; ${i.temprana30}% no completa el primer mes` : ''}.</div>
        <div class="ac"><b>Qué se hace en la industria:</b> ① entrevista estructurada con expectativas realistas del puesto (horarios, carga, pago) — reduce la sorpresa de la primera quincena; ② onboarding con “padrino” las primeras 2 semanas; ③ check-in del gerente a los 7 y 30 días; ④ <b>encuesta de salida</b> de 3 preguntas para separar causas (pago vs trato vs expectativa). Sin exit interviews, los datos muestran el patrón pero no la causa.</div>
      </div>`);
  }

  // Regla 2 (◆ azul): dispersión entre tiendas ≥ 3x -> factor local.
  if (d && d.n >= 8) {
    const ratio = d.min > 0 ? d.max / d.min : (d.mediana > 0 ? d.max / d.mediana : 0);
    if (ratio >= 3) {
      const rTxt = d.min > 0 ? `${Math.round(d.max / d.min)}×` : `${Math.round(d.max / Math.max(1, d.mediana))}× sobre la mediana`;
      // v6.00: la RPC manda la LISTA COMPLETA ordenada rot desc (ya no
      // top/low): los extremos se rebanan de d.list.
      const L = Array.isArray(d.list) ? d.list : [];
      const tops = L.slice(0, 2).map(x => `${x.code} (${x.rot}%)`).join(' y ');
      const lows = L.slice(-2).reverse().map(x => `${x.code} (${x.rot}%)`).join(' y ');
      cards.push(`
        <div class="mv-diag">
          <div class="h">◆ La dispersión entre tiendas (${d.min}%–${d.max}%) apunta a factor local, no solo a reclutamiento</div>
          <div class="ev"><b>Evidencia:</b> con el mismo tabulador y mercado, unas tiendas retienen ${rTxt} mejor que otras (${d.n} tiendas comparables, mediana ${d.mediana}%). Si la causa fuera solo central (selección/salario), la brecha sería pequeña.</div>
          <div class="ac"><b>Acción sugerida:</b> estudiar los extremos de cada lado — ¿qué hacen ${tops} distinto de ${lows}? (los códigos del panel de dispersión son clicables hacia Personal). Cruzar con la rotación del GERENTE de cada tienda: ${i.gerentes_egresados != null ? `${fmt(i.gerentes_egresados)} gerentes egresaron en el período, y` : ''} la literatura muestra que el cambio de gerente dispara la rotación del equipo en los 90 días siguientes.</div>
        </div>`);
    }
  }

  // Regla 3 (✓ verde): reincidentes -> la puerta giratoria como activo.
  if (i.reincidentes != null && i.reincidentes >= 50) {
    cards.push(`
      <div class="mv-diag g">
        <div class="h">✓ ${fmt(i.reincidentes)} reincidentes: la puerta giratoria también es un activo</div>
        <div class="ev"><b>Evidencia:</b> ${fmt(i.reincidentes)} personas tuvieron 2+ contratos observados en el período — el grupo re-contrata gente conocida constantemente.</div>
        <div class="ac"><b>Oportunidad:</b> formalizar un “pool de reingreso” (ex-empleados con buen desempeño, ya verificados en No reempleables) reduce el costo de selección y el riesgo de rotación temprana: el reincidente ya conoce el trabajo. El portal ya tiene la mitad de la infraestructura (<b>Verificar candidato</b>).</div>
      </div>`);
  }

  const body = cards.length
    ? cards.join('')
    : `<p class="mv-note" style="margin:0">Ningún hallazgo supera los umbrales con el período y los filtros elegidos
       (temprana &gt; 50%, dispersión ≥ 3×, reincidentes ≥ 50). Eso también es información.</p>`;

  return `
    <div class="mv-panel" style="margin-bottom:14px">
      <h3>Diagnóstico y recomendaciones — generado de los datos del período</h3>
      ${body}
    </div>`;
}

/* ---------- panel Indicadores del periodo (F2 v5.97, mockup v3) ----------
   6 tarjetas, cada una con su "?" hacia la guia publicada. Formulas: las
   de la guia, calculadas por la RPC respetando filtros y alcance.
   v6.00: valor destacado con COLOR POR SEVERIDAD y textos que ubican
   contra la referencia donde la hay. Umbrales (documentados):
   rotacion >100 mala / 60-100 alerta (banda alta del retail, guia #rot);
   temprana >50 mala / >35 alerta; estabilidad <25 mala / <40 alerta. */
function paintIndicadores() {
  const i = (STATS && STATS.indicadores) || null;
  if (!i) return '';
  const G = '/guias/indicadores-rotacion.html';
  const v = (x, suf) => (x == null ? '—' : `${x}${suf || ''}`);
  const fmt = (x) => (x == null ? '—' : Number(x).toLocaleString('es-VE'));
  const rk = (val, sev, lbl, expl, anchor) => `
    <div class="mv-rk">
      <a class="q" href="${G}#${anchor}" target="_blank" rel="noopener" title="Qué mide y cómo se calcula">?</a>
      <div class="v ${sev || ''}">${val}</div><div class="l">${lbl}</div><div class="e">${expl}</div>
    </div>`;

  // Severidades y textos con referencia.
  const rotSev = i.rot_anualizada == null ? '' : (i.rot_anualizada > 100 ? 'bad' : i.rot_anualizada >= 60 ? 'warn' : 'ok');
  const rotMult = i.rot_anualizada != null ? (i.rot_anualizada / 100).toFixed(1).replace('.', ',') : null;
  const rotTxt = `${fmt(i.egr_total)} egresos ÷ plantilla promedio ${fmt(i.plantilla_prom)}, a ${v(i.dias_efectivos)} días.`
    + (rotMult && i.rot_anualizada > 100 ? ` <b>≈${rotMult}× el techo de la banda alta del retail global</b> (60–100% anual ya se considera alta).`
       : ' Referencia retail: 60–100% anual ya es alta.');

  const tSev = i.temprana90 == null ? '' : (i.temprana90 > 50 ? 'bad' : i.temprana90 > 35 ? 'warn' : 'ok');
  const tHead = i.temprana90 != null && i.temprana90 > 50 ? 'Más de la mitad de los egresos no llega a los 3 meses. ' : '';
  const tTxt = `${tHead}${v(i.temprana30, '%')} no completa ni el primer mes · mediana al egresar ${v(i.mediana_egreso)} días — el esfuerzo de retención rinde más en las primeras semanas que en el aniversario.`;

  const eSev = i.estabilidad == null ? '' : (i.estabilidad < 25 ? 'bad' : i.estabilidad < 40 ? 'warn' : 'ok');
  const de4 = i.estabilidad != null ? Math.max(1, Math.round(i.estabilidad / 25)) : null;
  const eTxt = `Solo ~${de4 != null ? de4 : '—'} de cada 4 activos supera el año de contrato (al corte ${i.estab_cut ? esc(ddmm(i.estab_cut)) : '—'}): la experiencia del puesto se está reaprendiendo constantemente — el costo oculto de la rotación.`;

  const rePct = (i.reincidentes != null && i.plantilla_prom) ? Math.round(i.reincidentes / i.plantilla_prom * 100) : null;
  const reTxt = `Personas con 2+ contratos observados${rePct != null ? ` (≈${rePct}% de la plantilla promedio)` : ''}: se fueron y volvieron, o rotaron de tienda — también es un pool de reingreso ya conocido.`;

  const brecha = (i.temprana_vendedor != null && i.temprana_gerente != null) ? i.temprana_vendedor - i.temprana_gerente : null;
  const vgSev = brecha == null ? '' : (brecha > 20 ? 'bad' : brecha > 10 ? 'warn' : 'ok');
  const vgTxt = `${brecha != null ? `Brecha de ${brecha} puntos: ` : ''}el problema se concentra en la base operativa; el gerente resiste más. La entrada del vendedor es donde más rinde intervenir.`;

  const d = (STATS && STATS.dispersion) || null;
  const gPorTienda = (i.gerentes_egresados != null && d && d.n) ? (i.gerentes_egresados / d.n).toFixed(1).replace('.', ',') : null;
  const gTxt = `Estabilidad gerencial: el mejor predictor de la rotación del resto del equipo${gPorTienda ? ` — ≈${gPorTienda} egresos de gerente por tienda comparable en el período` : ''}. El cambio de gerente suele disparar la rotación del equipo en los ~90 días siguientes.`;

  return `
    <div class="mv-grid2">
      <div class="mv-panel">
        <h3>Indicadores del período (metodología estándar)</h3>
        <div class="mv-rot">
          ${rk(v(i.rot_anualizada, '%'), rotSev, 'Rotación anualizada', rotTxt, 'rot')}
          ${rk(v(i.temprana90, '%'), tSev, 'Rotación temprana <90 días', tTxt, 'temp')}
          ${rk(v(i.estabilidad, '%'), eSev, 'Índice de estabilidad', eTxt, 'estab')}
          ${rk(v(i.reincidentes), '', 'Reincidentes', reTxt, 'boom')}
          ${rk(`${v(i.temprana_vendedor, '%')} / ${v(i.temprana_gerente, '%')}`, vgSev, 'Temprana: vendedor vs gerente', vgTxt, 'temp')}
          ${rk(v(i.gerentes_egresados), '', 'Gerentes egresados', gTxt, 'disp')}
        </div>
      </div>
      <div class="mv-panel">
        ${paintDispersion()}
      </div>
    </div>`;
}

/* ---------- panel Dispersión entre tiendas comparables (F3 v5.98) ----------
   v6.00: la RPC manda la LISTA COMPLETA (list, orden rot desc); top/low se
   rebanan aca y el boton abre la ficha completa en un modal del portal. */
function paintDispersion() {
  const d = (STATS && STATS.dispersion) || null;
  const G = '/guias/indicadores-rotacion.html';
  if (!d || !Array.isArray(d.list) || !d.list.length) return `<h3>La clave diagnóstica: dispersión entre tiendas comparables</h3>
    <p class="mv-note" style="margin:0">Sin tiendas comparables (plantilla ≥ 8) dentro de los filtros elegidos.</p>`;
  const top = d.list.slice(0, 6);
  const low = d.list.slice(-6).reverse();
  const span = Math.max(1, d.max - d.min);
  const medPos = Math.round((d.mediana - d.min) / span * 100);
  const li = (x) => `<li><span class="mv-al" data-code="${esc(x.code)}" title="${esc(x.name || '')} · ${esc(x.zona || '')} · ${esc(x.concepto || '')}">${esc(x.code)}</span>
      <span class="pl">${esc(x.concepto || x.zona || '')} · plantilla ${x.plantilla} · ${x.egresos} egr.</span><span class="rt">${x.rot}%</span></li>`;
  return `
    <h3>La clave diagnóstica: dispersión entre tiendas comparables
      <a class="q" style="position:static;display:inline-flex;margin-left:6px;vertical-align:middle;width:17px;height:17px;border-radius:50%;background:#eef4ff;color:var(--brand,#2563eb);font-size:11px;font-weight:800;align-items:center;justify-content:center;text-decoration:none" href="${G}#disp" target="_blank" rel="noopener" title="Qué mide y cómo se calcula">?</a></h3>
    <div class="mv-band-wrap">
      <span>${d.min}%</span>
      <div class="mv-band"><span class="med" style="left:${medPos}%" title="Mediana ${d.mediana}%"></span></div>
      <span>${d.max}%</span>
    </div>
    <div class="mv-band-cap">mediana ${d.mediana}% · ${d.n} tiendas comparables (plantilla ≥8) · tasa del período · misma marca, mismo tabulador, mismo mercado</div>
    <div class="mv-displists">
      <div><h4>Rotan más</h4><ul class="mv-dl hi">${top.map(li).join('')}</ul></div>
      <div><h4>Retienen mejor</h4><ul class="mv-dl lo">${low.map(li).join('')}</ul></div>
    </div>
    <button class="mv-clear" id="mvDispAll" type="button" style="margin-top:12px">Ver la ficha completa (${d.n} tiendas)</button>`;
}

/* ---------- v6.01: Ficha de tiendas comparables como PAGINA ----------
   Reemplaza al modal v6.00. Volver regresa al tablero intacto (estado de
   modulo) y el Volver de Personal regresa a ESTA pagina (SUBVIEW
   persiste). Filtro en vivo + orden + Exportar xlsx/csv/txt (patron del
   portal: exporta LO VISIBLE). Codigo clicable -> Personal. */
function tiendasVisibles() {
  const d = (STATS && STATS.dispersion) || null;
  if (!d || !Array.isArray(d.list)) return [];
  const q = normSearch(TQ);
  const out = d.list.filter(x => !q ||
    normSearch(`${x.code} ${x.name || ''} ${x.zona || ''} ${x.subzona || ''} ${x.concepto || ''}`).includes(q));
  const by = {
    rot:       (a, b) => b.rot - a.rot || b.plantilla - a.plantilla,
    rot_asc:   (a, b) => a.rot - b.rot || b.plantilla - a.plantilla,
    plantilla: (a, b) => b.plantilla - a.plantilla || b.rot - a.rot,
    egresos:   (a, b) => b.egresos - a.egresos || b.rot - a.rot,
    codigo:    (a, b) => String(a.code).localeCompare(String(b.code)),
    empresa:   (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es'),
  };
  return out.slice().sort(by[TSORT] || by.rot);
}
function renderTiendasPage() {
  const d = STATS.dispersion;
  $('#pnlMain').innerHTML = `
    <div class="mv-head"><h1>Tiendas comparables — rotación del período</h1>
      <p>${C.from && C.to ? `Período ${esc(ddmm(C.from))}–${esc(ddmm(C.to))} · ` : ''}mediana ${d.mediana}% · ${d.n} tiendas comparables (plantilla ≥8) · tasa del período: egresos ÷ plantilla promedio de la tienda · misma marca, mismo tabulador, mismo mercado.</p></div>
    <div class="mv-tp-bar">
      <button class="mv-clear" id="mvTpBack" type="button">← Volver al tablero</button>
      <div class="mv-search">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="mvTpQ" type="text" placeholder="Filtrar por código, razón social, zona, subzona o concepto…" autocomplete="off">
      </div>
      <select id="mvTpSort">
        <option value="rot">Orden: Rotación (mayor primero)</option>
        <option value="rot_asc">Orden: Rotación (menor primero)</option>
        <option value="plantilla">Orden: Plantilla</option>
        <option value="egresos">Orden: Egresos</option>
        <option value="codigo">Orden: Código</option>
        <option value="empresa">Orden: Razón social A→Z</option>
      </select>
      <div class="mv-export-wrap">
        <button class="mv-export-btn" id="mvTpExportBtn" type="button">Exportar ▾</button>
        <div class="mv-export-menu" id="mvTpExportMenu" hidden>
          <button data-fmt="xlsx">Excel (.xlsx)</button>
          <button data-fmt="csv">CSV (.csv)</button>
          <button data-fmt="txt">Texto (.txt)</button>
        </div>
      </div>
    </div>
    <div class="mv-msg" id="mvMsg" hidden></div>
    <div class="mv-wrap" id="mvTpWrap"></div>
    <p class="mv-note">La <b>rotación del período</b> de cada tienda es la fórmula de la guía (egresos del período ÷ plantilla promedio de esa tienda), sin anualizar — por eso es comparable entre tiendas del mismo rango de fechas. Rojo = por encima de la mediana del grupo; verde = en la mediana o por debajo. Código clicable → Personal (su Volver regresa aquí). El export respeta el filtro y el orden aplicados.
    <a class="q" style="position:static;display:inline-flex;width:15px;height:15px;border-radius:50%;background:#eef4ff;color:var(--brand,#2563eb);font-size:10px;font-weight:800;align-items:center;justify-content:center;text-decoration:none;vertical-align:middle" href="/guias/indicadores-rotacion.html#disp" target="_blank" rel="noopener" title="Qué mide y cómo se calcula">?</a></p>`;

  $('#mvTpBack')?.addEventListener('click', () => { SUBVIEW = 'main'; renderMovements(USER); });
  const qEl = $('#mvTpQ');
  if (qEl) {
    qEl.value = TQ || '';
    qEl.addEventListener('input', () => { TQ = qEl.value; paintTiendasTable(); });
  }
  const sEl = $('#mvTpSort');
  if (sEl) {
    sEl.value = TSORT;
    sEl.addEventListener('change', () => { TSORT = sEl.value; paintTiendasTable(); });
  }
  const exBtn = $('#mvTpExportBtn'), exMenu = $('#mvTpExportMenu');
  exBtn?.addEventListener('click', (e) => { e.stopPropagation(); exMenu.hidden = !exMenu.hidden; });
  exMenu?.addEventListener('click', (e) => e.stopPropagation());
  exMenu?.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { exMenu.hidden = true; doExportTiendas(b.dataset.fmt); }));
  paintTiendasTable();
}
function paintTiendasTable() {
  const wrap = $('#mvTpWrap');
  if (!wrap) return;
  const d = STATS.dispersion;
  const rows = tiendasVisibles();
  if (!rows.length) {
    wrap.innerHTML = `<div class="mv-empty">Ninguna tienda coincide con el filtro.</div>`;
    return;
  }
  wrap.innerHTML = `<table class="mv-tp-table">
    <tr><th>#</th><th>Código</th><th>Razón social</th><th>Zona</th><th>Subzona</th><th>Concepto</th>
    <th style="text-align:right">Plantilla</th><th style="text-align:right">Egresos</th><th style="text-align:right">Rotación</th></tr>
    ${rows.map((x, i) => `<tr>
      <td class="rk-n">${i + 1}</td>
      <td><span class="mv-al" data-code="${esc(x.code)}">${esc(x.code)}</span></td>
      <td class="rz">${esc(x.name || '—')}</td>
      <td>${esc(x.zona || '—')}</td>
      <td>${esc(x.subzona || '—')}</td>
      <td>${esc(x.concepto || '—')}</td>
      <td class="num">${x.plantilla}</td>
      <td class="num">${x.egresos}</td>
      <td class="num"><b style="color:${x.rot > d.mediana ? '#b91c1c' : 'var(--ok,#0e9f6e)'}">${x.rot}%</b></td>
    </tr>`).join('')}
  </table>`;
  wrap.querySelectorAll('.mv-al[data-code]').forEach(a =>
    a.addEventListener('click', () => openCompany(a.dataset.code)));
}

/* ---------- v6.02: Exportar el ANALISIS a PDF (patron CDN de SheetJS) --
   SOLO el analisis, sin el detalle largo (decision 16/07). El reporte se
   DIBUJA programaticamente con jsPDF; los textos de indicadores y
   diagnostico se extraen del MISMO html que pinta la pantalla (pdfText),
   asi el PDF y el tablero no pueden discrepar. Helvetica es WinAnsi:
   pdfSan traduce los simbolos fuera del encoding. */
const PDF_C = {
  ink: [15, 23, 42], soft: [71, 85, 105], muted: [100, 116, 139],
  faint: [148, 163, 184], brand: [37, 99, 235], red: [185, 28, 28],
  amber: [180, 83, 9], green: [14, 159, 110], border: [226, 232, 240],
};
function pdfSan(s) {
  return String(s == null ? '' : s)
    .replace(/▲/g, '+').replace(/▼/g, '-').replace(/Δ/g, 'Delta ')
    .replace(/≈/g, '~').replace(/≥/g, '>=').replace(/≤/g, '<=')
    .replace(/×/g, 'x').replace(/→/g, '->').replace(/←/g, '<-')
    .replace(/⚠/g, '(!)').replace(/✓/g, '(ok)').replace(/◆/g, '•')
    .replace(/①/g, '1)').replace(/②/g, '2)').replace(/③/g, '3)').replace(/④/g, '4)');
}
function pdfText(html) {
  const t = document.createElement('div');
  t.innerHTML = html;
  return pdfSan((t.textContent || '').replace(/\s+/g, ' ').trim());
}
function nowCaracas() {
  const d = new Date(Date.now() - 4 * 3600 * 1000);
  const z = (n) => String(n).padStart(2, '0');
  return `${z(d.getUTCDate())}/${z(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}`;
}
function scopeLabel() {
  const f = FACETS || {};
  const nm = (arr, id) => (((arr || []).find(x => String(x.id) === String(id))) || {}).name;
  const parts = [];
  if (C.zone) parts.push(`Zona ${nm(f.zones, C.zone) || C.zone}`);
  if (C.subzone) parts.push(`Subzona ${nm(f.subzones, C.subzone) || C.subzone}`);
  if (C.concept) parts.push(`Concepto ${nm(f.concepts, C.concept) || C.concept}`);
  if (C.company) parts.push(`Empresa ${C.company}`);
  return parts.length ? parts.join(' · ') : 'Todo el grupo';
}
async function ensureJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar la librería PDF.'));
    document.head.appendChild(s);
  });
  return window.jspdf.jsPDF;
}
async function doExportPDF() {
  if (!STATS || !STATS.kpis) { showMsg('Genera el análisis primero (elige período y pulsa Generar).'); return; }
  showMsg('');
  let JsPDF;
  try { JsPDF = await ensureJsPDF(); }
  catch (e) { showMsg(e.message + ' Revisa tu conexión e inténtalo de nuevo.'); return; }

  const doc = new JsPDF({ unit: 'mm', format: 'a4' });   // 210 x 297
  const M = 14, W = 210 - M * 2;
  let y = 16;
  const C3 = (c) => doc.setTextColor(c[0], c[1], c[2]);
  const F3 = (c) => doc.setFillColor(c[0], c[1], c[2]);
  const D3 = (c) => doc.setDrawColor(c[0], c[1], c[2]);
  const need = (h) => { if (y + h > 283) { doc.addPage(); y = 16; } };
  const txt = (s, size, color, opts) => {
    doc.setFontSize(size); C3(color || PDF_C.ink);
    doc.setFont('helvetica', (opts && opts.bold) ? 'bold' : 'normal');
    const lines = doc.splitTextToSize(pdfSan(s), W);
    need(lines.length * size * 0.42 + 2);
    doc.text(lines, M, y);
    y += lines.length * size * 0.42 + ((opts && opts.gap) != null ? opts.gap : 1.5);
  };

  // Membrete
  txt('Movimientos de personal — Análisis del período', 16, PDF_C.ink, { bold: true, gap: 1 });
  txt(`Período ${ddmm(C.from)}–${ddmm(C.to)} ${String(C.to).slice(0, 4)} · ${scopeLabel()}`, 10.5, PDF_C.soft, { gap: 0.5 });
  txt(`Portal de Nómina · Grupo Canaima · generado el ${nowCaracas()} (Caracas)`, 8.5, PDF_C.faint, { gap: 2 });
  D3(PDF_C.border); doc.setLineWidth(0.3); doc.line(M, y, M + W, y); y += 5;

  // Fila de KPIs (mismos deltas de pantalla; color por favorabilidad)
  const k = STATS.kpis, p = STATS.prev || null, pl = STATS.plantilla || null;
  const kpis = [
    ['INGRESOS', k.ing, deltaLine(k.ing, p && p.ing, true), PDF_C.green],
    ['EGRESOS', k.egr, deltaLine(k.egr, p && p.egr, false), PDF_C.red],
    ['TRASLADOS', k.tras, deltaLine(k.tras, p && p.tras, null), PDF_C.brand],
    ['CAMBIOS DE CARGO', k.cargo, deltaLine(k.cargo, p && p.cargo, null), [126, 34, 206]],
    ['NETO', (k.neto > 0 ? '+' : '') + k.neto, pl ? `plantilla ${pl.n} al corte (${ddmm(pl.cut)})` : 'sin corte en el período', PDF_C.amber],
  ];
  need(26);
  const bw = (W - 12) / 5;
  kpis.forEach((kp, i) => {
    const x = M + i * (bw + 3);
    D3(PDF_C.border); F3([251, 252, 254]); doc.setLineWidth(0.25);
    doc.roundedRect(x, y, bw, 21, 1.6, 1.6, 'FD');
    doc.setFontSize(6.4); C3(PDF_C.faint); doc.setFont('helvetica', 'bold');
    doc.text(pdfSan(kp[0]), x + 2.5, y + 4.5);
    doc.setFontSize(14); C3(kp[3]); doc.text(String(kp[1]), x + 2.5, y + 11.5);
    const dH = String(kp[2]);
    const dc = dH.includes('class="up"') ? PDF_C.green : dH.includes('class="dn"') ? PDF_C.red : PDF_C.muted;
    doc.setFontSize(6.2); C3(dc); doc.setFont('helvetica', 'normal');
    doc.text(doc.splitTextToSize(pdfText(dH), bw - 5), x + 2.5, y + 15.2);
  });
  y += 25;
  const dn = pdfText(deltaNote()).replace(/\s*\?\s*$/, '');
  if (dn) txt(dn, 8, PDF_C.muted, { gap: 2.5 });

  // Indicadores del periodo: tarjetas extraidas del html de pantalla
  txt('Indicadores del período (metodología estándar)', 11.5, PDF_C.ink, { bold: true, gap: 2 });
  const tmpI = document.createElement('div');
  tmpI.innerHTML = paintIndicadores();
  const cards = [...tmpI.querySelectorAll('.mv-rot .mv-rk')].map(el => {
    const v = el.querySelector('.v');
    return {
      val: v ? v.textContent : '',
      col: v && v.classList.contains('bad') ? PDF_C.red
         : v && v.classList.contains('warn') ? PDF_C.amber
         : v && v.classList.contains('ok') ? PDF_C.green : PDF_C.ink,
      l: (el.querySelector('.l') || { textContent: '' }).textContent,
      e: (el.querySelector('.e') || { textContent: '' }).textContent,
    };
  });
  const cw = (W - 4) / 2;
  for (let r = 0; r < cards.length; r += 2) {
    const pair = cards.slice(r, r + 2);
    doc.setFontSize(7);
    const hs = pair.map(cd => 15 + doc.splitTextToSize(pdfSan(cd.e), cw - 6).length * 2.9);
    const ch = Math.max(...hs);
    need(ch + 3);
    pair.forEach((cd, i) => {
      const x = M + i * (cw + 4);
      D3(PDF_C.border); F3([251, 252, 254]); doc.setLineWidth(0.25);
      doc.roundedRect(x, y, cw, ch, 1.6, 1.6, 'FD');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13); C3(cd.col);
      doc.text(pdfSan(cd.val), x + 3, y + 6.5);
      doc.setFontSize(8); C3(PDF_C.soft);
      doc.text(pdfSan(cd.l), x + 3, y + 11);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); C3(PDF_C.muted);
      doc.text(doc.splitTextToSize(pdfSan(cd.e), cw - 6), x + 3, y + 15);
    });
    y += ch + 3;
  }
  y += 2;

  // Dispersion entre tiendas comparables: banda + ranking 2 columnas
  const d = STATS.dispersion;
  if (d && Array.isArray(d.list) && d.list.length) {
    need(20);
    txt('La clave diagnóstica: dispersión entre tiendas comparables', 11.5, PDF_C.ink, { bold: true, gap: 2.5 });
    const bx = M + 14, bwd = W - 28, by = y;
    F3([191, 227, 212]); doc.rect(bx, by, bwd / 3, 4.5, 'F');
    F3([243, 224, 192]); doc.rect(bx + bwd / 3, by, bwd / 3, 4.5, 'F');
    F3([236, 200, 200]); doc.rect(bx + 2 * bwd / 3, by, bwd / 3, 4.5, 'F');
    const mp = bx + Math.max(0, Math.min(1, (d.mediana - d.min) / Math.max(1, d.max - d.min))) * bwd;
    F3(PDF_C.ink); doc.rect(mp - 0.5, by - 1.2, 1, 6.9, 'F');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); C3(PDF_C.muted);
    doc.text(`${d.min}%`, bx - 2, by + 3.4, { align: 'right' });
    doc.text(`${d.max}%`, bx + bwd + 2, by + 3.4);
    y += 9;
    txt(`mediana ${d.mediana}% · ${d.n} tiendas comparables (plantilla >=8) · tasa del período · misma marca, mismo tabulador, mismo mercado`, 7.5, PDF_C.faint, { gap: 2.5 });
    const topL = d.list.slice(0, 6), lowL = d.list.slice(-6).reverse();
    const colw = (W - 6) / 2;
    need(6 + Math.max(topL.length, lowL.length) * 4);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); C3(PDF_C.faint);
    doc.text('ROTAN MÁS', M, y); doc.text('RETIENEN MEJOR', M + colw + 6, y);
    y += 3.8;
    const rline = (x, t, rot, col) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.6); C3(PDF_C.soft);
      doc.text(doc.splitTextToSize(pdfSan(t), colw - 13)[0], x, y);
      doc.setFont('helvetica', 'bold'); C3(col);
      doc.text(`${rot}%`, x + colw - 1, y, { align: 'right' });
    };
    for (let i = 0; i < Math.max(topL.length, lowL.length); i++) {
      if (topL[i]) rline(M, `${topL[i].code} · ${topL[i].concepto || topL[i].zona || ''} · pl. ${topL[i].plantilla} · ${topL[i].egresos} egr.`, topL[i].rot, PDF_C.red);
      if (lowL[i]) rline(M + colw + 6, `${lowL[i].code} · ${lowL[i].concepto || lowL[i].zona || ''} · pl. ${lowL[i].plantilla} · ${lowL[i].egresos} egr.`, lowL[i].rot, PDF_C.green);
      y += 4;
    }
    y += 1;
    txt('La ficha completa (razón social, zona, subzona, concepto, las N tiendas) se exporta a Excel desde "Ver la ficha completa" en el portal.', 7, PDF_C.faint, { gap: 3 });
  }

  // Supervivencia: curva redibujada nativa + tabla compacta de cohortes
  const all = Array.isArray(STATS.cohortes) ? STATS.cohortes : [];
  if (all.length) {
    const porCargo = Array.isArray(STATS.cohortes_cargo) ? STATS.cohortes_cargo : [];
    let src = COHORT_CARGO ? porCargo.filter(x => x.cargo === COHORT_CARGO) : all;
    if (!src.length) src = all;
    const c = src.find(x => x.mes === COHORT_SEL) || src[0];
    need(56);
    txt(`Supervivencia · cohorte de ingreso ${mesLabel(c.mes)}${COHORT_CARGO ? ' · ' + COHORT_CARGO : ''} (${c.size} personas)`, 11.5, PDF_C.ink, { bold: true, gap: 3 });
    const pts = [
      { lbl: 'Ingreso', v: 100 }, { lbl: '1 mes', v: c.s30 }, { lbl: '3 meses', v: c.s90 },
      { lbl: '6 meses', v: c.s180 }, { lbl: 'Hoy', v: c.vivos, hoy: true },
    ].filter(q => q.v != null);
    const gx = M + 10, gw = W - 20, gy = y + 3, gh = 32;
    const GX = (i) => gx + (pts.length > 1 ? i * (gw / (pts.length - 1)) : 0);
    const GY = (v) => gy + gh - (v / 100) * gh;
    D3(PDF_C.border); doc.setLineWidth(0.25);
    [0, 50, 100].forEach(g => {
      doc.line(gx - 2, GY(g), gx + gw, GY(g));
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); C3(PDF_C.faint);
      doc.text(`${g}%`, gx - 3, GY(g) + 1, { align: 'right' });
    });
    D3(PDF_C.brand); doc.setLineWidth(0.7);
    for (let i = 1; i < pts.length; i++) doc.line(GX(i - 1), GY(pts[i - 1].v), GX(i), GY(pts[i].v));
    pts.forEach((q, i) => {
      F3(q.hoy ? PDF_C.amber : PDF_C.brand);
      doc.circle(GX(i), GY(q.v), q.hoy ? 1.3 : 1, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); C3(q.hoy ? PDF_C.amber : PDF_C.ink);
      doc.text(`${q.v}%`, GX(i), Math.max(gy - 1, GY(q.v) - 2.4), { align: 'center' });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8); C3(PDF_C.faint);
      doc.text(pdfSan(q.lbl), GX(i), gy + gh + 4, { align: 'center' });
    });
    y = gy + gh + 9;
    // tabla de cohortes (todas las del segmento elegido)
    need(6 + src.length * 3.8);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(6.8); C3(PDF_C.faint);
    const cxs = [M, M + 46, M + 76, M + 102, M + 130, M + 158];
    ['COHORTE', 'PERSONAS', '1 MES', '3 MESES', '6 MESES', 'HOY'].forEach((h, i) => doc.text(h, cxs[i], y));
    y += 3.8;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.2); C3(PDF_C.soft);
    src.forEach(r => {
      doc.text(pdfSan(mesLabel(r.mes)), cxs[0], y);
      doc.text(String(r.size), cxs[1], y);
      doc.text(r.s30 == null ? '—' : `${r.s30}%`, cxs[2], y);
      doc.text(r.s90 == null ? '—' : `${r.s90}%`, cxs[3], y);
      doc.text(r.s180 == null ? '—' : `${r.s180}%`, cxs[4], y);
      doc.text(`${r.vivos}%`, cxs[5], y);
      y += 3.8;
    });
    y += 2;
    txt('Supervivencia en el grupo: la recontratación (misma u otra empresa) cuenta como seguir; los cortes de 1/3/6 meses aparecen cuando la cohorte completa madura hasta ese punto.', 7, PDF_C.faint, { gap: 3 });
  }

  // Diagnostico y recomendaciones (mismas tarjetas de pantalla)
  need(12);
  txt('Diagnóstico y recomendaciones — generado de los datos del período', 11.5, PDF_C.ink, { bold: true, gap: 2.5 });
  const tmpD = document.createElement('div');
  tmpD.innerHTML = paintDiagnostico();
  const diags = [...tmpD.querySelectorAll('.mv-diag')];
  if (!diags.length) {
    txt('Ningún hallazgo supera los umbrales con el período y los filtros elegidos (temprana > 50%, dispersión >= 3x, reincidentes >= 50). Eso también es información.', 8, PDF_C.muted, { gap: 2 });
  }
  diags.forEach(el => {
    const col = el.classList.contains('w') ? PDF_C.amber : el.classList.contains('g') ? PDF_C.green : PDF_C.brand;
    doc.setFontSize(8.5);
    const lh = doc.splitTextToSize(pdfText((el.querySelector('.h') || { innerHTML: '' }).innerHTML), W - 8);
    doc.setFontSize(7.5);
    const lev = doc.splitTextToSize(pdfText((el.querySelector('.ev') || { innerHTML: '' }).innerHTML), W - 8);
    const lac = doc.splitTextToSize(pdfText((el.querySelector('.ac') || { innerHTML: '' }).innerHTML), W - 8);
    const bh = 4 + lh.length * 3.5 + 1 + lev.length * 3 + 1 + lac.length * 3 + 2;
    need(bh + 3);
    F3(col); doc.rect(M, y, 1.2, bh, 'F');
    let yy = y + 4;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); C3(PDF_C.ink);
    doc.text(lh, M + 4, yy); yy += lh.length * 3.5 + 1;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); C3(PDF_C.soft);
    doc.text(lev, M + 4, yy); yy += lev.length * 3 + 1;
    C3(PDF_C.muted); doc.text(lac, M + 4, yy);
    y += bh + 3;
  });
  txt('Nota: estos indicadores miden el QUÉ con precisión; el porqué (selección, pago, trato, estacionalidad) requiere la encuesta de salida. El detalle nominal del período se consulta y exporta desde la pestaña Detalle del portal.', 7, PDF_C.faint, { gap: 2 });

  // Pie de pagina con numeracion en todas las paginas
  const ver = (document.querySelector('.pnl-bver') || { textContent: '' }).textContent || '';
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); C3(PDF_C.faint);
    doc.text(pdfSan(`Portal de Nómina ${ver} · Movimientos — Análisis · pág. ${i} de ${pages}`), 105, 292, { align: 'center' });
  }
  doc.save(`analisis_movimientos_${tstamp()}.pdf`);
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
  await exportTable(fmt, data, `movimientos_${tstamp()}`, 'Movimientos');
}

/* v6.01: exportacion de la ficha de tiendas comparables (misma mecanica;
   exporta LO VISIBLE: filtro y orden aplicados). */
function tiendasExportRows() {
  const d = (STATS && STATS.dispersion) || { mediana: null };
  return tiendasVisibles().map((x, i) => ({
    '#': i + 1,
    'Código': x.code,
    'Razón social': x.name || '',
    'Zona': x.zona || '',
    'Subzona': x.subzona || '',
    'Concepto': x.concepto || '',
    'Plantilla': x.plantilla,
    'Egresos': x.egresos,
    'Rotación %': x.rot,
    'Vs mediana': d.mediana == null ? '' : (x.rot > d.mediana ? 'Por encima' : 'Por debajo'),
  }));
}
async function doExportTiendas(fmt) {
  const data = tiendasExportRows();
  if (!data.length) { showMsg('No hay tiendas para exportar con ese filtro.'); return; }
  showMsg('');
  await exportTable(fmt, data, `tiendas_comparables_${tstamp()}`, 'Tiendas');
}

/* Motor comun de exportacion (xlsx/csv/txt, patron del portal). */
async function exportTable(fmt, data, fname, sheet) {
  const headers = Object.keys(data[0]);

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
      window.XLSX.utils.book_append_sheet(wb, ws, sheet);
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (e) {
      showMsg(e.message + ' Revisa tu conexión e inténtalo de nuevo.');
    }
    return;
  }
}
