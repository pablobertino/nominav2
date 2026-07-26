/* =====================================================================
   views/mov-evolucion.js — Movimientos por quincena · Evolución (v6.137)

   Pantalla aparte (se llega con "Ver evolución" desde Movimientos, se vuelve
   con "← Volver a Movimientos"). Muestra cómo evolucionan quincena a
   quincena los EVENTOS (ingresados/egresados/trasladados/cambios de cargo) y,
   en su propio panel con escala aparte, la PLANTILLA ACTIVA (headcount del
   corte). La quincena en curso NO se suma hasta cerrar (la RPC solo trae
   range_end < hoy). Respeta el alcance y filtra por zona/subzona/concepto.

   Fuente: acción 'evolucion' de /api/mov-quincena (RPC movimientos_evolucion,
   eventos desde mv_mov_eventos + plantilla en vivo de hcm_snapshot).
   Gate: view.movquincena (el mismo de Movimientos). ===================== */
import { $ } from '../core/dom.js';

const SERIES = [
  { k: 'ing', name: 'Ingresados', col: '#1baf7a' },
  { k: 'egr', name: 'Egresados', col: '#e34948' },
  { k: 'tra', name: 'Traslados', col: '#2a78d6' },
  { k: 'cam', name: 'Cambios de cargo', col: '#4a3aa7' },
];
const PLANT_COL = '#256abf';
const MES = ['', 'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const nf = n => Number(n || 0).toLocaleString('es');
const qlabel = r => `${MES[r.month] || r.month} ${r.quincena}`;

async function api(payload) {
  const res = await fetch('/api/mov-quincena', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

let STYLED = false;
function ensureStyles() {
  if (STYLED) return;
  STYLED = true;
  const css = document.createElement('style');
  css.textContent = `
  .mev-back{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;color:var(--muted);
     border:1px solid var(--border);background:var(--surface,#fff);border-radius:9px;padding:6px 11px;margin:0 0 12px;cursor:pointer}
  .mev-back:hover{background:var(--bg-soft,#f8fafc)}
  .mev-head h2{margin:0;font-size:20px;font-weight:700}
  .mev-head p{margin:3px 0 0;color:var(--muted);font-size:12.5px;max-width:900px}
  .mev-filters{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 0;align-items:center}
  .mev-filters select{font:inherit;font-size:12.5px;padding:7px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--soft,#334155);min-width:140px}
  .mev-kpis{display:flex;gap:12px;flex-wrap:wrap;margin:14px 0 0}
  .mev-kpi{background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;padding:11px 15px;min-width:165px;flex:1 1 165px}
  .mev-kpi .l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
  .mev-kpi .v{font-size:23px;font-weight:800;margin-top:2px}.mev-kpi .s{font-size:11px;color:var(--muted);margin-top:2px}
  .mev-card{background:var(--card,#fff);border:1px solid var(--border);border-radius:14px;padding:15px 16px;margin:14px 0 0}
  .mev-card h3{font-size:13px;margin:0 0 2px;font-weight:800;display:flex;justify-content:space-between;align-items:center;gap:10px}
  .mev-card h3 .n{font-size:11.5px;color:var(--muted);font-weight:500}
  .mev-hl{font-size:12.5px;color:var(--soft,#334155);margin:2px 0 8px}.mev-hl b{color:var(--ink)}
  .mev-legend{display:flex;gap:14px;flex-wrap:wrap;margin:4px 0 8px;font-size:12px;color:var(--soft,#334155)}
  .mev-legend .lg{display:inline-flex;align-items:center;gap:6px}.mev-legend .dot{width:11px;height:11px;border-radius:50%}
  .mev-card svg{width:100%;height:auto;display:block;overflow:visible}
  .mev-note{font-size:11.5px;color:var(--soft,#334155);margin:8px 0 0;background:var(--bg-soft,#fafbff);border:1px dashed var(--border);border-radius:9px;padding:9px 12px;line-height:1.5}
  .mev-note b{color:var(--ink)}
  table.mev-tbl{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
  table.mev-tbl th{text-align:right;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:800;padding:8px 12px;border-bottom:1px solid var(--border)}
  table.mev-tbl th:first-child{text-align:left}
  table.mev-tbl td{text-align:right;padding:8px 12px;border-bottom:1px solid var(--border-soft,#eef1f5)}
  table.mev-tbl td.qn{text-align:left;font-weight:600;color:var(--soft,#334155)}
  table.mev-tbl td.tt{font-weight:800}table.mev-tbl td.pl{font-weight:700;color:${PLANT_COL}}
  table.mev-tbl tr.tot td{border-top:2px solid var(--border);border-bottom:none;font-weight:800;background:#fbfcfe}
  .mev-loading{padding:44px;text-align:center;color:var(--muted);font-size:13px}
  .mev-empty{padding:40px 20px;text-align:center;color:var(--muted);font-size:13px}`;
  document.head.appendChild(css);
}

const STATE = { user: null, onBack: null, year: null, zone: '', sub: '', con: '', facets: null, periods: [], rows: [] };

/* ---------- gráfico de líneas (eventos) ---------- */
function flowsSvg(rows) {
  const n = rows.length;
  const X0 = 54, X1 = 902, Yt = 22, Yb = 360;
  let rawMax = 1;
  rows.forEach(r => SERIES.forEach(s => { if (r[s.k] > rawMax) rawMax = r[s.k]; }));
  const niceMax = Math.max(50, Math.ceil(rawMax / 50) * 50);
  const x = i => X0 + (n <= 1 ? 0 : i * (X1 - X0) / (n - 1));
  const y = v => Yb - v / niceMax * (Yb - Yt);
  let grid = '';
  for (let g = 0; g <= 5; g++) {
    const v = Math.round(niceMax * g / 5);
    grid += `<line x1="${X0}" y1="${y(v)}" x2="${X1}" y2="${y(v)}" stroke="#e6eaf0" stroke-width="1"/>`
      + `<text x="${X0 - 8}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="#94a3b8">${v}</text>`;
  }
  let xl = '';
  rows.forEach((r, i) => { xl += `<text x="${x(i)}" y="${Yb + 18}" text-anchor="middle" font-size="9.5" fill="#94a3b8">${esc(qlabel(r))}</text>`; });
  let lines = '';
  SERIES.forEach(s => {
    const pts = rows.map((r, i) => `${x(i).toFixed(1)},${y(r[s.k]).toFixed(1)}`).join(' ');
    lines += `<polyline points="${pts}" fill="none" stroke="${s.col}" stroke-width="2" stroke-linejoin="round"/>`;
    rows.forEach((r, i) => {
      lines += `<circle cx="${x(i).toFixed(1)}" cy="${y(r[s.k]).toFixed(1)}" r="2.6" fill="#fff" stroke="${s.col}" stroke-width="1.6"><title>${esc(qlabel(r))} · ${s.name}: ${r[s.k]}</title></circle>`;
    });
  });
  // etiquetas directas a la derecha, apiladas
  const ends = SERIES.map(s => ({ s, vy: y(rows[n - 1][s.k]), v: rows[n - 1][s.k] })).sort((a, b) => a.vy - b.vy);
  let prev = -999, dl = '';
  ends.forEach(e => { let ly = e.vy; if (ly - prev < 15) ly = prev + 15; prev = ly; dl += `<text x="${X1 + 8}" y="${ly + 3.5}" font-size="11" font-weight="700" fill="${e.s.col}">${esc(e.s.name)} · ${e.v}</text>`; });
  return `<svg viewBox="0 0 1120 392" role="img" aria-label="Movimientos por quincena">${grid}<line x1="${X0}" y1="${Yb}" x2="${X1}" y2="${Yb}" stroke="#cbd5e1" stroke-width="1"/>${xl}${lines}${dl}</svg>`;
}

/* ---------- gráfico de plantilla (headcount, escala propia) ---------- */
function plantillaSvg(rows) {
  const n = rows.length;
  const X0 = 60, X1 = 900, Yt = 20, Yb = 250;
  const vals = rows.map(r => r.plantilla);
  const pmin = Math.min(...vals), pmax = Math.max(...vals);
  const lo = Math.floor((pmin - (pmax - pmin) * 0.15 - 1) / 100) * 100;
  const hi = Math.ceil((pmax + (pmax - pmin) * 0.15 + 1) / 100) * 100;
  const span = Math.max(1, hi - lo);
  const x = i => X0 + (n <= 1 ? 0 : i * (X1 - X0) / (n - 1));
  const y = v => Yb - (v - lo) / span * (Yb - Yt);
  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const v = Math.round(lo + span * g / 4);
    grid += `<line x1="${X0}" y1="${y(v)}" x2="${X1}" y2="${y(v)}" stroke="#e6eaf0" stroke-width="1"/>`
      + `<text x="${X0 - 8}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="#94a3b8">${nf(v)}</text>`;
  }
  let xl = '';
  rows.forEach((r, i) => { xl += `<text x="${x(i)}" y="${Yb + 18}" text-anchor="middle" font-size="9.5" fill="#94a3b8">${esc(qlabel(r))}</text>`; });
  const pts = rows.map((r, i) => `${x(i).toFixed(1)},${y(r.plantilla).toFixed(1)}`).join(' ');
  const area = `${X0},${Yb} ${pts} ${X1},${Yb}`;
  let dots = '';
  rows.forEach((r, i) => { dots += `<circle cx="${x(i).toFixed(1)}" cy="${y(r.plantilla).toFixed(1)}" r="2.8" fill="#fff" stroke="${PLANT_COL}" stroke-width="1.7"><title>${esc(qlabel(r))} · ${nf(r.plantilla)} activos</title></circle>`; });
  const lastV = rows[n - 1].plantilla;
  return `<svg viewBox="0 0 1040 285" role="img" aria-label="Plantilla activa por quincena">${grid}<line x1="${X0}" y1="${Yb}" x2="${X1}" y2="${Yb}" stroke="#cbd5e1" stroke-width="1"/>${xl}`
    + `<polygon points="${area}" fill="${PLANT_COL}" opacity="0.10"/>`
    + `<polyline points="${pts}" fill="none" stroke="${PLANT_COL}" stroke-width="2.4" stroke-linejoin="round"/>${dots}`
    + `<text x="${x(n - 1) + 8}" y="${y(lastV) + 3.5}" font-size="11" font-weight="700" fill="${PLANT_COL}">${nf(lastV)}</text></svg>`;
}

function paint() {
  const body = $('#mevBody');
  if (!body) return;
  const rows = STATE.rows;
  if (!rows.length) {
    body.innerHTML = '<div class="mev-card"><div class="mev-empty">No hay quincenas cerradas para los filtros elegidos.</div></div>';
    return;
  }
  const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const last = k => rows[rows.length - 1][k];
  const kpis = SERIES.map(s => `<div class="mev-kpi" style="border-top:3px solid ${s.col}">
    <div class="l">${s.name}</div><div class="v" style="color:${s.col}">${nf(sum(s.k))}</div>
    <div class="s">acumulado · última: ${nf(last(s.k))}</div></div>`).join('');
  const legend = SERIES.map(s => `<span class="lg"><span class="dot" style="background:${s.col}"></span>${s.name}</span>`).join('');

  const pFirst = rows[0].plantilla, pLast = last('plantilla'), pDelta = pLast - pFirst;
  const pPct = pFirst ? Math.round(pDelta / pFirst * 100) : 0;

  const trows = rows.map(r => `<tr><td class="qn">${esc(qlabel(r))}</td><td>${nf(r.ing)}</td><td>${nf(r.egr)}</td><td>${nf(r.tra)}</td><td>${nf(r.cam)}</td><td class="tt">${nf(r.ing + r.egr + r.tra + r.cam)}</td><td class="pl">${nf(r.plantilla)}</td></tr>`).join('');
  const totRow = `<tr class="tot"><td class="qn">Total</td><td>${nf(sum('ing'))}</td><td>${nf(sum('egr'))}</td><td>${nf(sum('tra'))}</td><td>${nf(sum('cam'))}</td><td class="tt">${nf(sum('ing') + sum('egr') + sum('tra') + sum('cam'))}</td><td class="pl">—</td></tr>`;

  body.innerHTML = `
    <div class="mev-kpis">${kpis}</div>
    <div class="mev-card">
      <h3>Movimientos por quincena <span class="n">eventos · ${rows.length} quincena${rows.length === 1 ? '' : 's'} cerrada${rows.length === 1 ? '' : 's'}</span></h3>
      <div class="mev-legend">${legend}</div>
      ${flowsSvg(rows)}
      <div class="mev-note"><b>Ojo:</b> “Egresados” cuenta fin de contrato (una persona puede egresar varias veces), no personas únicas. La quincena en curso no se incluye hasta cerrar.</div>
    </div>
    <div class="mev-card">
      <h3>Plantilla activa por quincena <span class="n">personas activas · escala propia</span></h3>
      <div class="mev-hl"><b style="font-size:16px;color:${PLANT_COL}">${nf(pLast)}</b> activos en la última quincena · <b style="color:${pDelta < 0 ? '#e34948' : '#1baf7a'}">${pDelta > 0 ? '+' : ''}${nf(pDelta)}</b> (${pPct > 0 ? '+' : ''}${pPct}%) desde la primera</div>
      ${plantillaSvg(rows)}
      <div class="mev-note"><b>Va en panel aparte</b> porque es headcount (miles de personas), no eventos: en el mismo eje aplastaría a los movimientos. Sale del corte quincenal de activos.</div>
    </div>
    <div class="mev-card">
      <h3>Histórico por quincena <span class="n">solo quincenas cerradas</span></h3>
      <table class="mev-tbl"><thead><tr><th>Quincena</th><th style="color:#1baf7a">Ingresados</th><th style="color:#e34948">Egresados</th><th style="color:#2a78d6">Traslados</th><th style="color:#4a3aa7">Cambios</th><th>Total mov.</th><th style="color:${PLANT_COL}">Plantilla</th></tr></thead><tbody>${trows}${totRow}</tbody></table>
    </div>`;
}

async function loadData() {
  const body = $('#mevBody');
  if (body) body.innerHTML = '<div class="mev-loading">Calculando la evolución…</div>';
  const r = await api({ action: 'evolucion', user: STATE.user, year: STATE.year, zone: STATE.zone || null, subzone: STATE.sub || null, concept: STATE.con || null });
  if (!$('#mevBody')) return;
  if (!r || !r.ok) { $('#mevBody').innerHTML = `<div class="mev-card"><div class="mev-empty">${esc((r && r.error) || 'No se pudo cargar.')}</div></div>`; return; }
  STATE.rows = r.rows || [];
  paint();
}

function fillSubzones() {
  const f = STATE.facets || {};
  const ss = $('#mevSub');
  if (!ss) return;
  let subs = f.subzones || [];
  if (STATE.zone) subs = subs.filter(s => !s.zone_name || s.zone_name === STATE.zone);
  ss.innerHTML = '<option value="">Subzona: todas</option>' + subs.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
  if (subs.some(s => s.name === STATE.sub)) ss.value = STATE.sub; else STATE.sub = '';
}

export async function renderMovEvolucion(user, onBack) {
  ensureStyles();
  STATE.user = user; STATE.onBack = onBack || null;
  STATE.rows = [];

  $('#pnlMain').innerHTML = `
    <button class="mev-back" id="mevBack">← Volver a Movimientos</button>
    <div class="mev-head">
      <h2>Movimientos por quincena · Evolución</h2>
      <p>Cómo evolucionan los movimientos (eventos) y la plantilla activa (lo estable) a lo largo del año. La quincena en curso no se suma hasta cerrar. Respeta tu alcance.</p>
    </div>
    <div class="mev-filters">
      <select id="mevYear"></select>
      <select id="mevZone"><option value="">Zona: todas</option></select>
      <select id="mevSub"><option value="">Subzona: todas</option></select>
      <select id="mevCon"><option value="">Concepto: todos</option></select>
    </div>
    <div id="mevBody"><div class="mev-loading">Cargando…</div></div>`;

  $('#mevBack')?.addEventListener('click', () => (typeof STATE.onBack === 'function' ? STATE.onBack() : null));

  // Facetas (zonas/subzonas/conceptos + años disponibles).
  const d = await api({ action: 'facets', user });
  if (!$('#mevBody')) return;
  STATE.facets = (d && d.facets) || { zones: [], subzones: [], concepts: [] };
  STATE.periods = (d && d.periods) || [];

  const years = [...new Set(STATE.periods.map(p => p.year))].sort((a, b) => b - a);
  if (!years.length) years.push(new Date().getFullYear());
  STATE.year = years[0];
  const ys = $('#mevYear');
  if (ys) ys.innerHTML = years.map(y => `<option value="${y}">Año ${y}</option>`).join('');

  const zs = $('#mevZone');
  if (zs) zs.innerHTML = '<option value="">Zona: todas</option>' + (STATE.facets.zones || []).map(z => `<option value="${esc(z.name)}">${esc(z.name)}</option>`).join('');
  const cs = $('#mevCon');
  if (cs) cs.innerHTML = '<option value="">Concepto: todos</option>' + (STATE.facets.concepts || []).map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  fillSubzones();

  ys?.addEventListener('change', () => { STATE.year = parseInt(ys.value, 10) || STATE.year; loadData(); });
  zs?.addEventListener('change', () => { STATE.zone = zs.value; fillSubzones(); loadData(); });
  $('#mevSub')?.addEventListener('change', e => { STATE.sub = e.target.value; loadData(); });
  cs?.addEventListener('change', () => { STATE.con = cs.value; loadData(); });

  await loadData();
}
