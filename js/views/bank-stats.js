/* =====================================================================
   js/views/bank-stats.js  →  DATOS BANCARIOS · Estadísticas (v4.78)

   Distribución de las cuentas bancarias del personal VIGENTE del alcance:
     - Chips de los 5 bancos principales + chip de alerta "Sin cuenta"
     - Barras "General por banco" (+ fila fija Sin cuenta, aunque sea 0)
     - Pivote Banco (filas) × Tipo de empresa (columnas), n + % juntos
     - Heatmap Zona (filas) × top-5 bancos + Otros + Sin cuenta
     - Detalle nominal del personal sin cuenta / cuenta inválida (la
       herramienta para gestionar la solicitud de apertura)
   Cada tarjeta tiene su propio Exportar (xlsx/csv/txt, patrón global de
   Empresas: exporta lo visible respetando los filtros).

   Datos por /api/bank-stats (gate view.bankstats; alcance por
   get_admin_companies dentro de la función SQL bank_account_stats).
   Diseño aprobado en _PRUEBAS/bancos_stats_mockup.html (v0-mock4).
   Export: renderBankStats(user)
   ===================================================================== */

import { $ } from '../core/dom.js';
import { attachRefresh } from '../core/refresh.js';

let USER = null;
let RAW = { banks: {}, data: [], nocta: [] };   // respuesta del backend
let F = { tipo: 'ALL', zona: 'ALL' };            // filtros vivos

const TIPOS = ['Tienda', 'Importadora', 'Administrativa', 'Externa', 'Servicio'];
/* Colores del mockup aprobado: BDV rojo, Banesco verde, Mercantil azul,
   BNC morado, Provincial celeste; el resto neutro. */
const BK_COLORS = { '0102': '#c62828', '0134': '#0e9f6e', '0105': '#1e40af', '0191': '#7e22ce', '0108': '#0ea5e9' };
const BK_OTHER = '#94a3b8';
const WARN = '#b45309';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const nf = n => Number(n || 0).toLocaleString('es-VE');
const pf = (n, t) => t ? (100 * n / t).toLocaleString('es-VE', { maximumFractionDigits: 1 }) + '%' : '0%';
const bkName = p => RAW.banks[p] || ('Prefijo ' + p);
const bkColor = p => BK_COLORS[p] || BK_OTHER;

async function api(payload) {
  return fetch('/api/bank-stats', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: { kind: USER.kind, id: USER.id || null, companyCode: USER.companyCode || null }, ...payload }),
  }).then(x => x.json()).catch(() => null);
}

function ensureStyles() {
  if (document.getElementById('bkstStyles')) return;
  const st = document.createElement('style');
  st.id = 'bkstStyles';
  st.textContent = `
  .bkst-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .bkst-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .bkst-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:14px 0 12px}
  .bkst-bar select{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink)}
  .bkst-chips{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 16px}
  .bkst-chip{display:flex;align-items:center;gap:9px;background:var(--card,#fff);border:1px solid var(--border);border-radius:999px;padding:8px 16px 8px 10px}
  .bkst-chip .dot{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:10px;font-weight:800;font-family:ui-monospace,monospace;letter-spacing:-.5px;flex:none}
  .bkst-chip .nm{font-size:12.5px;font-weight:700;line-height:1.15;color:var(--ink)}
  .bkst-chip .nm small{display:block;font-weight:500;color:var(--muted);font-size:11px;font-family:ui-monospace,monospace}
  .bkst-chip .val{font-size:15px;font-weight:800;margin-left:4px}
  .bkst-chip .pc{font-size:11.5px;color:var(--muted)}
  .bkst-chip.nocta{border-style:dashed;border-color:#f3ddc0;background:var(--warn-bg,#fff7ed)}
  .bkst-card{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;padding:16px 18px;margin-bottom:16px}
  .bkst-cardhead{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:4px}
  .bkst-card h3{margin:0;font-size:15px;color:var(--ink)}
  .bkst-desc{font-size:12px;color:var(--muted);margin:0 0 14px}
  .bkst-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;font-weight:600;padding:7px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);cursor:pointer;white-space:nowrap}
  .bkst-btn:hover:not(:disabled){background:var(--bg-soft,#f1f5f9)}
  .bkst-btn:disabled{opacity:.5;cursor:default}
  .bkst-brow{display:grid;grid-template-columns:minmax(180px,250px) 1fr 120px;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border-soft,#f1f5f9);font-size:12.5px;color:var(--ink)}
  .bkst-brow .bname b{font-family:ui-monospace,monospace;color:var(--muted);font-weight:600;margin-right:6px}
  .bkst-track{height:16px;background:var(--bg-soft,#f1f5f9);border-radius:8px;overflow:hidden}
  .bkst-fill{height:100%;border-radius:8px}
  .bkst-num{text-align:right;font-variant-numeric:tabular-nums}
  .bkst-num b{font-size:13px}
  .bkst-num span{color:var(--muted);font-size:11px;margin-left:6px}
  .bkst-brow.nocta{background:var(--warn-bg,#fff7ed);border-radius:8px;padding:5px 8px;margin-top:6px;border-bottom:0}
  .bkst-brow.nocta .bname{color:${WARN};font-weight:700}
  .bkst-tblwrap{overflow:auto}
  .bkst-tbl{border-collapse:collapse;width:100%;font-size:12.5px}
  .bkst-tbl th{background:var(--bg-soft,#f8fafc);color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.03em;padding:8px 9px;text-align:right;border-bottom:2px solid var(--border);white-space:nowrap}
  .bkst-tbl th:first-child,.bkst-tbl td:first-child{text-align:left}
  .bkst-tbl th .pref{display:block;font-family:ui-monospace,monospace;color:var(--faint,#94a3b8);letter-spacing:0}
  .bkst-tbl td{padding:7px 9px;border-bottom:1px solid var(--border-soft,#eef1f5);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--ink)}
  .bkst-tbl td .pct{color:var(--muted);font-size:10.5px;margin-left:5px}
  .bkst-tbl td.bk b{font-family:ui-monospace,monospace;color:var(--muted);font-weight:600;margin-right:6px}
  .bkst-tbl tr.tot td{font-weight:800;border-top:2px solid var(--border);background:var(--bg-soft,#f8fafc)}
  .bkst-tbl tr.nocta td{background:var(--warn-bg,#fff7ed);color:${WARN};font-weight:700}
  .bkst-dim{color:var(--faint,#cbd5e1)}
  .bkst-ok{display:flex;align-items:center;gap:10px;background:var(--success-bg,#f0fdf4);border:1px solid #bbf7d0;color:var(--success,#15803d);border-radius:10px;padding:11px 14px;font-size:13px;font-weight:700;margin-bottom:12px}
  .bkst-empty{padding:26px 12px;text-align:center;color:var(--muted);font-size:13px}`;
  document.head.appendChild(st);
}

/* ---------- Exportar por tarjeta (patrón global de Empresas) ---------- */
function dl(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function tstamp() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
async function doExport(fmt, rows, fname) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  if (fmt === 'csv') {
    const escv = v => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [headers.join(';')].concat(rows.map(r => headers.map(h => escv(r[h])).join(';')));
    dl('\uFEFF' + lines.join('\r\n'), `${fname}.csv`, 'text/csv;charset=utf-8');
    return;
  }
  if (fmt === 'txt') {
    const widths = headers.map(h => Math.max(h.length, ...rows.map(r => String(r[h] ?? '').length)));
    const fmtRow = cells => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
    const lines = [fmtRow(headers), widths.map(w => '-'.repeat(w)).join('  ')]
      .concat(rows.map(r => fmtRow(headers.map(h => r[h]))));
    dl(lines.join('\r\n'), `${fname}.txt`, 'text/plain;charset=utf-8');
    return;
  }
  if (fmt === 'xlsx') {
    try {
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          s.onload = resolve; s.onerror = () => reject(new Error('Sin CDN'));
          document.head.appendChild(s);
        });
      }
      const ws = window.XLSX.utils.json_to_sheet(rows, { header: headers });
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Datos');
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (_) { /* sin conexión al CDN */ }
  }
}
function openExportMenu(btn, getRows, fnameBase) {
  const old = document.getElementById('bkstExpMenu');
  if (old) { old.remove(); return; }
  const r = btn.getBoundingClientRect();
  const m = document.createElement('div');
  m.id = 'bkstExpMenu';
  m.style.cssText = `position:fixed;top:${r.bottom + 6}px;left:${Math.max(8, r.right - 170)}px;z-index:1100;background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;box-shadow:0 10px 32px rgba(15,23,42,.18);padding:6px;min-width:170px;display:flex;flex-direction:column;gap:2px`;
  const item = (lbl, fmt) => {
    const b = document.createElement('button');
    b.textContent = lbl;
    b.style.cssText = 'font:inherit;font-size:13px;text-align:left;padding:8px 12px;border:0;border-radius:8px;background:transparent;color:var(--ink);cursor:pointer';
    b.addEventListener('mouseenter', () => { b.style.background = 'var(--bg-soft,#f1f5f9)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', () => { m.remove(); doExport(fmt, getRows(), `${fnameBase}_${tstamp()}`); });
    return b;
  };
  m.appendChild(item('Excel (.xlsx)', 'xlsx'));
  m.appendChild(item('CSV (.csv)', 'csv'));
  m.appendChild(item('Texto (.txt)', 'txt'));
  document.body.appendChild(m);
  setTimeout(() => {
    const away = ev => { if (!m.contains(ev.target) && ev.target !== btn) { m.remove(); document.removeEventListener('click', away); } };
    document.addEventListener('click', away);
  }, 0);
}

/* ---------- derivación de datos (respeta filtros) ---------- */
function filtered() {
  return RAW.data.filter(d => (F.tipo === 'ALL' || d[0] === F.tipo) && (F.zona === 'ALL' || d[1] === F.zona));
}
function noctaFiltered() {
  return RAW.nocta.filter(r => (F.tipo === 'ALL' || r.type === F.tipo) && (F.zona === 'ALL' || r.zone === F.zona));
}
function byBank(rows) {
  const m = {};
  rows.forEach(d => { m[d[2]] = (m[d[2]] || 0) + d[3]; });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}
function zonasAll() {
  return [...new Set(RAW.data.map(d => d[1]))]
    .sort((a, b) => a === 'Empresas (sin zona)' ? 1 : b === 'Empresas (sin zona)' ? -1 : a.localeCompare(b, 'es'));
}

/* filas de exportación por tarjeta (lo visible con los filtros vivos) */
function expGeneral() {
  const rows = filtered(); const banks = byBank(rows);
  const nocta = noctaFiltered().length;
  const total = rows.reduce((a, d) => a + d[3], 0) + nocta;
  const out = banks.map(([p, n]) => ({ 'Código': p, 'Banco': bkName(p), 'Personas': n, '%': pf(n, total) }));
  out.push({ 'Código': '', 'Banco': 'Sin cuenta o inválida', 'Personas': nocta, '%': pf(nocta, total) });
  return out;
}
function expTipo() {
  const rows = filtered(); const banks = byBank(rows);
  const tipos = F.tipo === 'ALL' ? TIPOS : [F.tipo];
  return banks.map(([p, bn]) => {
    const o = { 'Código': p, 'Banco': bkName(p), 'Total': bn };
    tipos.forEach(t => { o[t] = rows.filter(d => d[2] === p && d[0] === t).reduce((a, d) => a + d[3], 0); });
    return o;
  });
}
function expZona() {
  const rows = filtered(); const banks = byBank(rows).slice(0, 5).map(b => b[0]);
  return zonasAll().filter(z => rows.some(d => d[1] === z)).map(z => {
    const zr = rows.filter(d => d[1] === z);
    const o = { 'Zona': z, 'Total': zr.reduce((a, d) => a + d[3], 0) };
    banks.forEach(p => { o[bkName(p)] = zr.filter(d => d[2] === p).reduce((a, d) => a + d[3], 0); });
    o['Otros'] = zr.filter(d => !banks.includes(d[2])).reduce((a, d) => a + d[3], 0);
    return o;
  });
}
function expNocta() {
  return noctaFiltered().map(r => ({
    'Cédula': r.id_number, 'Nombre': r.full_name || '', 'Empresa': `${r.company_code} · ${r.company_name || ''}`,
    'Tipo': r.type, 'Zona': r.zone, 'Cargo': r.role || '', 'Teléfono': r.phone || '', 'Motivo': r.reason,
  }));
}

/* ---------- pintado ---------- */
function paint() {
  const rows = filtered();
  const noctaRows = noctaFiltered();
  const nocta = noctaRows.length;
  const conCta = rows.reduce((a, d) => a + d[3], 0);
  const total = conCta + nocta;
  const banks = byBank(rows);

  const sub = $('#bkstSub');
  if (sub) sub.innerHTML = `Cuentas del personal <b>vigente</b> de tu alcance · <b>${nf(total)}</b> colaboradores · ${banks.length} bancos · <b style="color:${nocta ? WARN : 'var(--success,#15803d)'}">${nf(nocta)} sin cuenta</b>`;

  /* chips top-5 + sin cuenta */
  $('#bkstChips').innerHTML = banks.slice(0, 5).map(([p, n]) => {
    const c = bkColor(p);
    return `<div class="bkst-chip" style="border-color:${c}44">
      <span class="dot" style="background:${c}">${esc(p)}</span>
      <span class="nm">${esc(bkName(p))}<small>${esc(p)}</small></span>
      <span class="val" style="color:${c}">${nf(n)}</span><span class="pc">${pf(n, total)}</span>
    </div>`;
  }).join('') + `<div class="bkst-chip nocta">
      <span class="dot" style="background:${WARN};font-size:13px">!</span>
      <span class="nm" style="color:${WARN}">Sin cuenta<small>o inválida</small></span>
      <span class="val" style="color:${WARN}">${nf(nocta)}</span><span class="pc">${pf(nocta, total)}</span>
    </div>`;

  /* barras general + fila fija sin cuenta */
  const max = banks.length ? banks[0][1] : 1;
  $('#bkstBars').innerHTML = (banks.map(([p, n]) => {
    const c = bkColor(p);
    return `<div class="bkst-brow">
      <span class="bname"><b>${esc(p)}</b>${esc(bkName(p))}</span>
      <div class="bkst-track"><div class="bkst-fill" style="width:${Math.max(1, 100 * n / max)}%;background:${c}"></div></div>
      <span class="bkst-num"><b>${nf(n)}</b><span>${pf(n, total)}</span></span>
    </div>`;
  }).join('') || '<div class="bkst-empty">Sin datos con estos filtros.</div>')
  + `<div class="bkst-brow nocta">
      <span class="bname">⚠ Sin cuenta o inválida</span>
      <div class="bkst-track" style="background:var(--card,#fff)"><div class="bkst-fill" style="width:${nocta ? Math.max(1, 100 * nocta / max) : 0}%;background:${WARN}"></div></div>
      <span class="bkst-num" style="color:${WARN}"><b>${nf(nocta)}</b><span style="color:${WARN};opacity:.75">${pf(nocta, total)}</span></span>
    </div>`;

  /* tabla banco x tipo */
  const tiposVis = F.tipo === 'ALL' ? TIPOS : [F.tipo];
  const cell = (n, rowTot) => n ? `${nf(n)}<span class="pct">${pf(n, rowTot)}</span>` : '<span class="bkst-dim">—</span>';
  const tot = {}; tiposVis.forEach(t => { tot[t] = 0; });
  let bodyT = banks.map(([p, bn]) => {
    const per = {}; tiposVis.forEach(t => { per[t] = 0; });
    rows.forEach(d => { if (d[2] === p && per[d[0]] != null) per[d[0]] += d[3]; });
    tiposVis.forEach(t => { tot[t] += per[t]; });
    return `<tr><td class="bk"><b>${esc(p)}</b>${esc(bkName(p))}</td><td><b>${nf(bn)}</b><span class="pct">${pf(bn, total)}</span></td>${tiposVis.map(t => `<td>${cell(per[t], bn)}</td>`).join('')}</tr>`;
  }).join('');
  bodyT += `<tr class="nocta"><td>⚠ Sin cuenta o inválida</td><td>${nf(nocta)}<span class="pct">${pf(nocta, total)}</span></td>${tiposVis.map(t => `<td>${nf(noctaRows.filter(r => r.type === t).length)}</td>`).join('')}</tr>`;
  bodyT += `<tr class="tot"><td>TOTAL</td><td>${nf(total)}</td>${tiposVis.map(t => `<td>${nf(tot[t] + noctaRows.filter(r => r.type === t).length)}<span class="pct">${pf(tot[t] + noctaRows.filter(r => r.type === t).length, total)}</span></td>`).join('')}</tr>`;
  $('#bkstTblTipo').innerHTML = `<div class="bkst-tblwrap"><table class="bkst-tbl"><thead><tr><th>Banco</th><th>Total</th>${tiposVis.map(t => `<th>${esc(t)}</th>`).join('')}</tr></thead><tbody>${bodyT}</tbody></table></div>`;

  /* tabla zona x top5+otros+sin cuenta (heatmap) */
  const top5 = banks.slice(0, 5).map(b => b[0]);
  const zVis = (F.zona === 'ALL' ? zonasAll() : [F.zona]).filter(z => rows.some(d => d[1] === z) || noctaRows.some(r => r.zone === z));
  let bodyZ = zVis.map(z => {
    const zr = rows.filter(d => d[1] === z);
    const zNo = noctaRows.filter(r => r.zone === z).length;
    const zt = zr.reduce((a, d) => a + d[3], 0) + zNo;
    const per = {}; let otros = 0;
    zr.forEach(d => { if (top5.includes(d[2])) per[d[2]] = (per[d[2]] || 0) + d[3]; else otros += d[3]; });
    const tds = top5.map(p => {
      const n = per[p] || 0, w = zt ? n / zt : 0, c = bkColor(p);
      const bg = n ? `background:${c}${Math.min(56, Math.round(w * 72) + 10).toString(16).padStart(2, '0')}` : '';
      return `<td style="${bg}">${n ? `${nf(n)}<span class="pct">${pf(n, zt)}</span>` : '<span class="bkst-dim">—</span>'}</td>`;
    }).join('');
    return `<tr><td>${esc(z)}</td><td><b>${nf(zt)}</b></td>${tds}<td>${otros ? `${nf(otros)}<span class="pct">${pf(otros, zt)}</span>` : '<span class="bkst-dim">—</span>'}</td><td style="${zNo ? 'color:' + WARN + ';font-weight:700' : ''}">${nf(zNo)}</td></tr>`;
  }).join('');
  const gTot = {}; let gOt = 0;
  rows.forEach(d => { if (top5.includes(d[2])) gTot[d[2]] = (gTot[d[2]] || 0) + d[3]; else gOt += d[3]; });
  bodyZ += `<tr class="tot"><td>TOTAL</td><td>${nf(total)}</td>${top5.map(p => `<td>${nf(gTot[p] || 0)}<span class="pct">${pf(gTot[p] || 0, total)}</span></td>`).join('')}<td>${nf(gOt)}<span class="pct">${pf(gOt, total)}</span></td><td style="${nocta ? 'color:' + WARN + ';font-weight:700' : ''}">${nf(nocta)}</td></tr>`;
  $('#bkstTblZona').innerHTML = `<div class="bkst-tblwrap"><table class="bkst-tbl"><thead><tr><th>Zona</th><th>Total</th>${top5.map(p => `<th>${esc(bkName(p))}<span class="pref">${esc(p)}</span></th>`).join('')}<th>Otros</th><th style="color:${WARN}">Sin cuenta</th></tr></thead><tbody>${bodyZ}</tbody></table></div>`;

  /* detalle nominal sin cuenta */
  const nc = $('#bkstNocta');
  if (nc) {
    if (!nocta) {
      nc.innerHTML = `<div class="bkst-ok">✔ ${F.tipo === 'ALL' && F.zona === 'ALL' ? 'Todo el personal vigente de tu alcance tiene una cuenta válida registrada.' : 'Con estos filtros no hay personal sin cuenta.'}</div>`;
    } else {
      nc.innerHTML = `<div class="bkst-tblwrap"><table class="bkst-tbl">
        <thead><tr><th style="text-align:left">Cédula</th><th style="text-align:left">Nombre</th><th style="text-align:left">Empresa</th><th style="text-align:left">Tipo</th><th style="text-align:left">Zona</th><th style="text-align:left">Cargo</th><th style="text-align:left">Teléfono</th><th style="text-align:left">Motivo</th></tr></thead>
        <tbody>${noctaRows.map(r => `<tr>
          <td style="text-align:left">${esc(r.id_number)}</td>
          <td style="text-align:left"><b>${esc(r.full_name || '(sin nombre)')}</b></td>
          <td style="text-align:left">${esc(r.company_code)}${r.company_name ? ' · ' + esc(r.company_name) : ''}</td>
          <td style="text-align:left">${esc(r.type)}</td>
          <td style="text-align:left">${esc(r.zone)}</td>
          <td style="text-align:left">${esc(r.role || '—')}</td>
          <td style="text-align:left">${esc(r.phone || '—')}</td>
          <td style="text-align:left;color:${WARN};font-weight:600">${esc(r.reason)}</td>
        </tr>`).join('')}</tbody></table></div>`;
    }
  }
  $('#bkstExpNocta').disabled = !nocta;
}

async function load() {
  $('#bkstChips').innerHTML = '<div class="bkst-empty">Cargando…</div>';
  const r = await api({});
  if (!r || !r.ok) {
    $('#bkstChips').innerHTML = `<div class="bkst-empty">No se pudo cargar${r && r.error ? ': ' + esc(r.error) : ''}.</div>`;
    return;
  }
  RAW.banks = {};
  (r.banks || []).forEach(b => { RAW.banks[b.code] = b.name; });
  RAW.data = r.data || [];
  RAW.nocta = r.nocta || [];
  buildFilters();
  paint();
}

function buildFilters() {
  const zSel = $('#bkstFZona');
  const cur = F.zona;
  zSel.innerHTML = '<option value="ALL">Zona: Todas</option>' + zonasAll().map(z => `<option value="${esc(z)}"${z === cur ? ' selected' : ''}>${esc(z)}</option>`).join('');
}

export async function renderBankStats(user) {
  USER = user;
  ensureStyles();
  F = { tipo: 'ALL', zona: 'ALL' };
  $('#pnlMain').innerHTML = `
    <div class="bkst-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px"><div>
      <h1>Datos bancarios · Estadísticas</h1>
      <p id="bkstSub">Cargando…</p>
    </div><span id="bkstRefresh"></span></div>
    <div class="bkst-bar">
      <select id="bkstFTipo"><option value="ALL">Tipo: Todos</option>${TIPOS.map(t => `<option value="${t}">${t}</option>`).join('')}</select>
      <select id="bkstFZona"><option value="ALL">Zona: Todas</option></select>
    </div>
    <div class="bkst-chips" id="bkstChips"></div>
    <div class="bkst-card">
      <div class="bkst-cardhead"><h3>General por banco</h3>
        <button class="bkst-btn" id="bkstExpGen">Exportar ▾</button></div>
      <p class="bkst-desc">Respeta los filtros de arriba. El prefijo de la cuenta (4 dígitos) se cruza con el catálogo de Bancos. La categoría <b>Sin cuenta</b> se muestra siempre, aunque esté en cero.</p>
      <div id="bkstBars"></div>
    </div>
    <div class="bkst-card">
      <div class="bkst-cardhead"><h3>Por tipo de empresa</h3>
        <button class="bkst-btn" id="bkstExpTipo">Exportar ▾</button></div>
      <p class="bkst-desc">Bancos como filas, tipos como columnas. Cada celda: cantidad y, en gris, qué parte del personal de ese banco está en ese tipo.</p>
      <div id="bkstTblTipo"></div>
    </div>
    <div class="bkst-card">
      <div class="bkst-cardhead"><h3>Por zona</h3>
        <button class="bkst-btn" id="bkstExpZona">Exportar ▾</button></div>
      <p class="bkst-desc">Zonas como filas × 5 bancos principales + Otros + Sin cuenta. El color marca el peso del banco dentro de la zona; las empresas no-tienda se agrupan como “Empresas (sin zona)”.</p>
      <div id="bkstTblZona"></div>
    </div>
    <div class="bkst-card">
      <div class="bkst-cardhead"><h3>⚠ Personal sin cuenta bancaria</h3>
        <button class="bkst-btn" id="bkstExpNocta">Exportar ▾</button></div>
      <p class="bkst-desc">El detalle nominal para gestionar la solicitud: a cada persona de esta lista hay que pedirle que abra su cuenta y la registre. Incluye cuentas <b>inválidas</b> (vacías, con texto, longitud errada o banco desconocido).</p>
      <div id="bkstNocta"></div>
    </div>`;

  $('#bkstFTipo').addEventListener('change', e => { F.tipo = e.target.value; paint(); });
  $('#bkstFZona').addEventListener('change', e => { F.zona = e.target.value; paint(); });
  $('#bkstExpGen').addEventListener('click', e => openExportMenu(e.currentTarget, expGeneral, 'bancos_general'));
  $('#bkstExpTipo').addEventListener('click', e => openExportMenu(e.currentTarget, expTipo, 'bancos_por_tipo'));
  $('#bkstExpZona').addEventListener('click', e => openExportMenu(e.currentTarget, expZona, 'bancos_por_zona'));
  $('#bkstExpNocta').addEventListener('click', e => openExportMenu(e.currentTarget, expNocta, 'personal_sin_cuenta'));

  await load();
  attachRefresh('#bkstRefresh', () => load(), 'bankstats');
}
