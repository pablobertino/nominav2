/* =====================================================================
   js/views/pay-grid.js  →  vista "Estado de pago" (admin / superadmin)

   Grilla con el estado de pago por empresa, leida de la tabla cache via
   /api/period-pay (action 'grid'), enriquecida con datos de la empresa
   (razon social, RIF, tipo, estatus, ubicacion).

   v5.94 (pedido de Pablo):
   - Filtro por PERIODO DE PAGO: combo con los periodos presentes en la
     cache (hoy el vigente y el anterior; el cron va sumando). Default
     "Más reciente por empresa" = el comportamiento de siempre (una fila
     por empresa, su indice mas alto). Elegir un periodo muestra la fila
     de CADA empresa en ESE periodo (la tenga como actual o anterior).
   - Filtro de ESTADOS multi-seleccion (checkboxes): por defecto vienen
     tildados Pago calculado, Pago enviado, Pago cargado y Pagado
     (Pendiente/otros destildado).
   - Las TARJETAS se recalculan CON LOS FILTROS aplicados (periodo +
     estados + busqueda) y cada una muestra su % contra la TOTALIDAD de
     las empresas del alcance; la ultima tarjeta es "Empresas N de TOTAL".

   Exporta renderPayGrid(user). Pinta dentro de #pnlMain.
   ===================================================================== */

import { $ } from '../core/dom.js';
import { showPayHelpModal } from './pay-help.js';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function payState(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('pagado')) return { cls: 'pst-pagado', txt: 'Pagado', key: 'Pagado' };
  if (s.includes('enviado')) return { cls: 'pst-enviado', txt: 'Pago enviado', key: 'Pago enviado' };
  if (s.includes('cargado')) return { cls: 'pst-cargado', txt: 'Pago cargado', key: 'Pago cargado' };
  if (s.includes('calculado')) return { cls: 'pst-calculado', txt: 'Pago calculado', key: 'Pago calculado' };
  return { cls: 'pst-pendiente', txt: status || 'Pendiente', key: 'Pendiente' };
}
function dm(s) { return s ? `${String(s).slice(8, 10)}/${String(s).slice(5, 7)}` : '\u2014'; }
function fmtRango(desde, hasta) { return `${dm(desde)} al ${dm(hasta)}`; }

/* Pildora del estatus de la empresa (Abierta / Cerrada / etc.). */
function compStatusPill(s) {
  const x = (s || '').toLowerCase();
  if (x.includes('abier')) return '<span class="pg-st pg-st-open">Abierta</span>';
  if (x.includes('cerrad') && x.includes('temp')) return '<span class="pg-st pg-st-temp">Cerrada temp.</span>';
  if (x.includes('cerrad')) return '<span class="pg-st pg-st-closed">Cerrada</span>';
  if (x.includes('proyect')) return '<span class="pg-st pg-st-proj">Proyectada</span>';
  if (!s || x.includes('nulo') || x.includes('vac')) return '<span class="muted">\u2014</span>';
  return `<span class="pg-st pg-st-gray">${esc(s)}</span>`;
}

/* Estados del filtro multi-seleccion (mismos keys que payState). Por
   defecto tildados los 4 estados "reales" del circuito; Pendiente no. */
const PG_STATUSES = ['Pago calculado', 'Pago enviado', 'Pago cargado', 'Pagado', 'Pendiente'];
const PG_DEFAULT_ON = ['Pago calculado', 'Pago enviado', 'Pago cargado', 'Pagado'];

function ensureStyles() {
  if (document.getElementById('payGridStyles')) return;
  const st = document.createElement('style');
  st.id = 'payGridStyles';
  st.textContent = `
  .pg-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:6px 0 18px; }
  .pg-sc { border:1px solid var(--border,#e6eaf0); border-radius:var(--radius-md,10px); padding:14px 16px;
    background:var(--surface,#fff); border-left:3px solid var(--bd,var(--border,#e6eaf0)); }
  .pg-sc .n { font-size:24px; font-weight:750; letter-spacing:-.02em; line-height:1; }
  .pg-sc .n small { font-size:12px; font-weight:700; color:var(--muted,#64748b); margin-left:5px; }
  .pg-sc .l { font-size:11.5px; color:var(--muted,#64748b); margin-top:4px; }
  .pst { display:inline-flex; align-items:center; gap:7px; padding:4px 11px; border-radius:999px;
    font-size:12px; font-weight:700; }
  .pst::before { content:''; width:7px; height:7px; border-radius:50%; background:currentColor; }
  .pst-pagado { background:#dcfce7; color:#15803d; }
  .pst-enviado { background:#eff4ff; color:#1e40af; }
  .pst-cargado { background:#fef3c7; color:#92400e; }
  .pst-calculado { background:#f3e8ff; color:#7c3aed; }
  .pst-pendiente { background:var(--border-soft,#f1f4f8); color:var(--muted,#64748b); }
  .pst-pendiente::before { opacity:.5; }
  .pg-aclara { font-size:11.5px; color:#b45309; background:#fef3c7; border:1px solid #f5e3b3;
    border-radius:8px; padding:7px 12px; margin:0 0 14px; }
  /* Celda empresa: codigo + razon social + RIF + ubicacion */
  .pg-emp .code { font-family:ui-monospace,Menlo,monospace; font-weight:700; font-size:13px; }
  .pg-emp .nm { font-size:13px; color:var(--ink,#0f172a); line-height:1.3; margin-top:1px; }
  .pg-emp .meta { font-size:11px; color:var(--faint,#94a3b8); margin-top:2px; line-height:1.35; }
  /* Celda periodo: nombre arriba + fechas debajo */
  .pg-per .top { font-size:13px; color:var(--ink,#0f172a); font-weight:600; }
  .pg-per .sub { font-size:11px; color:var(--faint,#94a3b8); margin-top:2px; }
  /* Pildora de estatus de empresa */
  .pg-st { display:inline-block; padding:2px 9px; border-radius:999px; font-size:11px; font-weight:600; }
  .pg-st-open { background:#dcfce7; color:#15803d; }
  .pg-st-temp { background:#fef3c7; color:#92400e; }
  .pg-st-closed { background:#fee2e2; color:#b91c1c; }
  .pg-st-proj { background:#f3e8ff; color:#7c3aed; }
  .pg-st-gray { background:var(--border-soft,#f1f4f8); color:var(--muted,#64748b); }
  .pg-type { font-size:11px; color:var(--muted,#64748b); margin-top:3px; }
  /* v5.94: combo de periodo de pago + dropdown de estados (checkboxes) */
  .pg-period { font:inherit; font-size:13px; padding:8px 10px; border:1px solid var(--border,#e6eaf0);
    border-radius:9px; background:var(--surface,#fff); color:var(--ink,#0f172a); font-weight:600; }
  .pg-stwrap { position:relative; }
  .pg-stbtn { display:inline-flex; align-items:center; gap:8px; font:inherit; font-size:13px; padding:8px 12px;
    border:1px solid var(--border,#e6eaf0); border-radius:9px; background:var(--surface,#fff);
    color:var(--ink,#0f172a); cursor:pointer; white-space:nowrap; }
  .pg-stbtn:hover { background:var(--bg-soft,#f1f5f9); }
  .pg-stmenu { position:absolute; z-index:30; top:calc(100% + 6px); right:0; min-width:210px;
    background:var(--card,#fff); border:1px solid var(--border,#e6eaf0); border-radius:12px;
    box-shadow:0 8px 28px rgba(15,23,42,.14); padding:8px; }
  .pg-stmenu[hidden] { display:none; }
  .pg-stopt { display:flex; align-items:center; gap:9px; padding:8px 10px; border-radius:8px;
    font-size:13px; color:var(--ink,#0f172a); cursor:pointer; }
  .pg-stopt:hover { background:var(--bg-soft,#f1f5f9); }
  .pg-stopt input { width:16px; height:16px; accent-color:var(--brand,#2563eb); }
  @media (max-width:768px){
    .pg-period, .pg-stwrap, .pg-stbtn { flex:1 1 auto; width:100%; }
  }
  `;
  document.head.appendChild(st);
}

/* ---------- estado del modulo ---------- */
let PG_ALL = [];        // TODAS las filas del alcance (idx 0 y -1)
let PG_PERIODS = [];    // [{code, desde, hasta}] desc
let PG_TOTAL = 0;       // totalidad de empresas del alcance (aliases unicos)
let PG_USER = null;
let PG_F = { q: '', period: 'latest', on: new Set(PG_DEFAULT_ON) };

export async function renderPayGrid(user) {
  PG_USER = user;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Estado de pago</h1><p>Estado de pago del periodo por empresa</p></div></div>
    <div id="pgAclara"></div>
    <div class="pg-cards" id="pgCards"></div>
    <div class="pnl-filters">
      <div class="search">${'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>'}<input id="pgSearch" type="text" placeholder="Buscar empresa, c\u00f3digo o RIF\u2026"></div>
      <select id="pgPeriod" class="pg-period" title="Periodo de pago">
        <option value="latest">Periodo de pago: m\u00e1s reciente por empresa</option>
      </select>
      <div class="pg-stwrap">
        <button class="pg-stbtn" id="pgStBtn" type="button">
          <span id="pgStLabel">Estados: 4</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <div class="pg-stmenu" id="pgStMenu" hidden>
          ${PG_STATUSES.map(s => `<label class="pg-stopt"><input type="checkbox" value="${esc(s)}" ${PG_F.on.has(s) ? 'checked' : ''}><span>${esc(s)}</span></label>`).join('')}
        </div>
      </div>
    </div>
    <div class="tablebox tbl-cards">
      <table><thead><tr>
        <th>Empresa</th><th>Tipo / Estatus</th><th>Periodo n\u00f3mina</th><th>Periodo de pago</th><th>Estado de pago <span class="pay-help-q" id="pgPayHelp" title="Ver que significa cada estado de pago" role="button" tabindex="0">?</span></th>
      </tr></thead><tbody id="pgBody"><tr><td colspan="5" class="pnl-loading">Cargando estado de pago\u2026</td></tr></tbody></table>
    </div>`;

  $('#pgSearch').addEventListener('input', () => { PG_F.q = $('#pgSearch').value; repaint(); });
  $('#pgPeriod').addEventListener('change', () => { PG_F.period = $('#pgPeriod').value; repaint(); });
  // Dropdown de estados (checkboxes): abrir/cerrar + cambio.
  const stBtn = $('#pgStBtn'), stMenu = $('#pgStMenu');
  stBtn.addEventListener('click', (e) => { e.stopPropagation(); stMenu.hidden = !stMenu.hidden; });
  stMenu.addEventListener('click', (e) => e.stopPropagation());
  stMenu.querySelectorAll('input[type=checkbox]').forEach(cb =>
    cb.addEventListener('change', () => {
      PG_F.on = new Set([...stMenu.querySelectorAll('input:checked')].map(x => x.value));
      repaint();
    }));
  document.addEventListener('click', () => { const m = $('#pgStMenu'); if (m) m.hidden = true; });
  // Ayuda "?" de la columna Estado de pago (mismo patron que Atencion).
  if ($('#pgPayHelp')) $('#pgPayHelp').addEventListener('click', showPayHelpModal);

  let d;
  try {
    d = await fetch('/api/period-pay', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'grid', adminId: user.id }),
    }).then(r => r.json());
  } catch (e) { d = { ok: false, error: String(e.message || e) }; }

  if (!d || !d.ok) {
    $('#pgBody').innerHTML = `<tr><td colspan="5" class="empty">No se pudo consultar: ${esc((d && d.error) || 'error')}</td></tr>`;
    return;
  }
  PG_ALL = d.rows || [];
  PG_PERIODS = d.periods || [];
  PG_TOTAL = new Set(PG_ALL.map(r => r.alias)).size;
  if (d.usedFallback) {
    $('#pgAclara').innerHTML = `<div class="pg-aclara">Mostrando el periodo anterior \u2014 el actual aun no tiene pago calculado.</div>`;
  }

  // Combo de periodo de pago: "mas reciente" + los periodos de la cache.
  const pSel = $('#pgPeriod');
  pSel.innerHTML = `<option value="latest">Periodo de pago: m\u00e1s reciente por empresa</option>`
    + PG_PERIODS.map(p =>
        `<option value="${esc(p.code)}">${esc(p.code)}${p.desde ? ` \u00b7 ${fmtRango(p.desde, p.hasta)}` : ''}</option>`).join('');
  pSel.value = PG_PERIODS.some(p => p.code === PG_F.period) ? PG_F.period : 'latest';
  PG_F.period = pSel.value;

  // Restaurar la busqueda previa (el estado vive en el modulo).
  if (PG_F.q) $('#pgSearch').value = PG_F.q;

  repaint();
}

/* Universo segun el filtro de periodo:
   - 'latest': una fila por empresa, su indice mas alto (comportamiento
     historico de la grilla).
   - un periodo puntual: la fila de cada empresa EN ESE periodo (venga del
     indice actual o del anterior). Empresas sin ese periodo no aparecen. */
function periodUniverse() {
  if (PG_F.period !== 'latest') {
    return PG_ALL.filter(r => r.periodoPago === PG_F.period);
  }
  const byAlias = {};
  for (const r of PG_ALL) {
    const prev = byAlias[r.alias];
    if (!prev || Number(r.index) > Number(prev.index)) byAlias[r.alias] = r;
  }
  return Object.values(byAlias).sort((a, b) => (a.alias || '').localeCompare(b.alias || ''));
}

/* Filas visibles: periodo + estados tildados + busqueda. Las tarjetas se
   calculan sobre ESTE mismo conjunto (stats respetan los filtros). */
function filteredRows() {
  const q = (PG_F.q || '').toLowerCase();
  return periodUniverse().filter(r => {
    const hay = `${r.alias || ''} ${r.businessName || ''} ${r.taxId || ''}`.toLowerCase();
    if (q && !hay.includes(q)) return false;
    return PG_F.on.has(payState(r.status).key);
  });
}

function repaint() {
  updateStLabel();
  const rows = filteredRows();
  paintCards(rows);
  paintRows(rows);
}

function updateStLabel() {
  const el = $('#pgStLabel');
  if (!el) return;
  const n = PG_F.on.size;
  el.textContent = n === 0 ? 'Estados: ninguno'
    : n === PG_STATUSES.length ? 'Estados: todos'
    : `Estados: ${n}`;
}

/* Tarjetas CON los filtros aplicados; % contra la TOTALIDAD de empresas
   del alcance (PG_TOTAL), que es el denominador fijo pedido por Pablo. */
function paintCards(rows) {
  const cont = { 'Pagado': 0, 'Pago enviado': 0, 'Pago cargado': 0, 'Pago calculado': 0 };
  rows.forEach(r => { const k = payState(r.status).key; if (cont[k] != null) cont[k]++; });
  const pct = n => PG_TOTAL > 0 ? `${Math.round((n / PG_TOTAL) * 100)}%` : '';
  const def = [
    ['Pagado', cont['Pagado'], '#16a34a'],
    ['Pago enviado', cont['Pago enviado'], '#2563eb'],
    ['Pago cargado', cont['Pago cargado'], '#b45309'],
    ['Pago calculado', cont['Pago calculado'], '#7c3aed'],
  ];
  $('#pgCards').innerHTML = def.map(([l, n, c]) =>
    `<div class="pg-sc" style="--bd:${c}"><div class="n" style="color:${c}">${n}<small>${pct(n)}</small></div><div class="l">${esc(l)}</div></div>`).join('')
    + `<div class="pg-sc" style="--bd:#64748b"><div class="n" style="color:#64748b">${rows.length}<small>de ${PG_TOTAL} \u00b7 ${pct(rows.length)}</small></div><div class="l">Empresas (con filtros)</div></div>`;
}

function paintRows(rows) {
  $('#pgBody').innerHTML = rows.map(r => {
    const st = payState(r.status);                 // estado de PAGO (del periodo)
    const ubic = [r.zone, r.subzone, r.concept].filter(Boolean).join(' \u00b7 ');
    const emp = `<div class="pg-emp">
      <div class="code">${esc(r.alias || '\u2014')}</div>
      ${r.businessName ? `<div class="nm">${esc(r.businessName)}</div>` : ''}
      <div class="meta">${r.taxId ? `RIF ${esc(r.taxId)}` : ''}${r.taxId && ubic ? '<br>' : ''}${ubic ? esc(ubic) : ''}</div>
    </div>`;
    return `<tr>
      <td data-label="Empresa">${emp}</td>
      <td data-label="Tipo / Estatus">${compStatusPill(r.companyStatus)}${r.type ? `<div class="pg-type">${esc(r.type)}</div>` : ''}</td>
      <td data-label="Periodo n\u00f3mina"><div class="pg-per"><div class="top">${esc(r.periodoNomina || '\u2014')}</div><div class="sub">${esc(fmtRango(r.nominaDesde, r.nominaHasta))}</div></div></td>
      <td data-label="Periodo de pago"><div class="pg-per"><div class="top">${esc(r.periodoPago || '\u2014')}</div><div class="sub">${esc(fmtRango(r.pagoDesde, r.pagoHasta))}</div></div></td>
      <td data-label="Estado de pago"><span class="pst ${st.cls}">${esc(st.txt)}</span></td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" class="empty">Sin resultados con esos filtros.</td></tr>`;
}
