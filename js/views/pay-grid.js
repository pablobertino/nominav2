/* =====================================================================
   js/views/pay-grid.js  →  vista "Estado de pago" (admin / superadmin)

   Grilla con el estado de pago del periodo de TODAS las empresas del
   alcance del admin (superadmin = todas). Lee de la tabla cache via
   /api/period-pay (action 'grid'), que ademas enriquece cada fila con
   datos de la empresa (razon social, RIF, tipo, estatus, ubicacion).

   4 tarjetas resumen (Pagado / Enviado / Cargado / Total) + buscador +
   filtro por estado + tabla.

   Exporta renderPayGrid(user). Pinta dentro de #pnlMain.
   ===================================================================== */

import { $ } from '../core/dom.js';

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

function ensureStyles() {
  if (document.getElementById('payGridStyles')) return;
  const st = document.createElement('style');
  st.id = 'payGridStyles';
  st.textContent = `
  .pg-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:6px 0 18px; }
  .pg-sc { border:1px solid var(--border,#e6eaf0); border-radius:var(--radius-md,10px); padding:14px 16px;
    background:var(--surface,#fff); border-left:3px solid var(--bd,var(--border,#e6eaf0)); }
  .pg-sc .n { font-size:24px; font-weight:750; letter-spacing:-.02em; line-height:1; }
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
  `;
  document.head.appendChild(st);
}

let PG_ROWS = [];
let PG_USER = null;

export async function renderPayGrid(user) {
  PG_USER = user;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Estado de pago</h1><p>Estado de pago del periodo por empresa</p></div></div>
    <div id="pgAclara"></div>
    <div class="pg-cards" id="pgCards"></div>
    <div class="pnl-filters">
      <div class="search">${'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>'}<input id="pgSearch" type="text" placeholder="Buscar empresa, c\u00f3digo o RIF\u2026"></div>
      <select id="pgFilter">
        <option value="all">Todos los estados</option>
        <option value="Pagado">Pagado</option>
        <option value="Pago enviado">Pago enviado</option>
        <option value="Pago cargado">Pago cargado</option>
        <option value="Pago calculado">Pago calculado</option>
      </select>
    </div>
    <div class="tablebox">
      <table><thead><tr>
        <th>Empresa</th><th>Tipo / Estatus</th><th>Periodo n\u00f3mina</th><th>Periodo de pago</th><th>Estado de pago</th>
      </tr></thead><tbody id="pgBody"><tr><td colspan="5" class="pnl-loading">Cargando estado de pago\u2026</td></tr></tbody></table>
    </div>`;

  $('#pgSearch').addEventListener('input', renderRows);
  $('#pgFilter').addEventListener('change', renderRows);

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
  PG_ROWS = d.rows || [];
  if (d.usedFallback) {
    $('#pgAclara').innerHTML = `<div class="pg-aclara">Mostrando el periodo anterior \u2014 el actual aun no tiene pago calculado.</div>`;
  }
  paintCards();
  renderRows();
}

function paintCards() {
  const cont = { 'Pagado': 0, 'Pago enviado': 0, 'Pago cargado': 0, 'Pago calculado': 0 };
  PG_ROWS.forEach(r => { const k = payState(r.status).key; if (cont[k] != null) cont[k]++; });
  const def = [
    ['Pagado', cont['Pagado'], '#16a34a'],
    ['Pago enviado', cont['Pago enviado'], '#2563eb'],
    ['Pago cargado', cont['Pago cargado'], '#b45309'],
    ['Total empresas', PG_ROWS.length, '#64748b'],
  ];
  $('#pgCards').innerHTML = def.map(([l, n, c]) =>
    `<div class="pg-sc" style="--bd:${c}"><div class="n" style="color:${c}">${n}</div><div class="l">${esc(l)}</div></div>`).join('');
}

function renderRows() {
  const q = ($('#pgSearch') && $('#pgSearch').value || '').toLowerCase();
  const f = ($('#pgFilter') && $('#pgFilter').value) || 'all';
  const rows = PG_ROWS.filter(r => {
    const hay = `${r.alias || ''} ${r.businessName || ''} ${r.taxId || ''}`.toLowerCase();
    const matchQ = hay.includes(q);
    const matchF = (f === 'all') || (payState(r.status).key === f);
    return matchQ && matchF;
  });
  $('#pgBody').innerHTML = rows.map(r => {
    const st = payState(r.status);                 // estado de PAGO (del periodo)
    const ubic = [r.zone, r.subzone, r.concept].filter(Boolean).join(' \u00b7 ');
    const emp = `<div class="pg-emp">
      <div class="code">${esc(r.alias || '\u2014')}</div>
      ${r.businessName ? `<div class="nm">${esc(r.businessName)}</div>` : ''}
      <div class="meta">${r.taxId ? `RIF ${esc(r.taxId)}` : ''}${r.taxId && ubic ? '<br>' : ''}${ubic ? esc(ubic) : ''}</div>
    </div>`;
    return `<tr>
      <td>${emp}</td>
      <td>${compStatusPill(r.companyStatus)}${r.type ? `<div class="pg-type">${esc(r.type)}</div>` : ''}</td>
      <td><div class="pg-per"><div class="top">${esc(r.periodoNomina || '\u2014')}</div></div></td>
      <td><div class="pg-per"><div class="top">${esc(r.periodoPago || '\u2014')}</div><div class="sub">${esc(fmtRango(r.pagoDesde, r.pagoHasta))}</div></div></td>
      <td><span class="pst ${st.cls}">${esc(st.txt)}</span></td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" class="empty">Sin resultados.</td></tr>`;
}
