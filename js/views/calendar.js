/* =====================================================================
   js/views/calendar.js  →  vista "Calendario" (solo lectura, para TODOS)
   Muestra las quincenas de nomina (payroll_periods) en modo lectura: por
   cada quincena, el periodo, el dia de calculo (corte), el tope para
   reportar novedades y el dia de pago. Resalta la quincena actual.
   Datos por /api/periods (action 'list' / 'years'), que es lectura abierta
   a cualquier sesion (tienda, empresa, editor, admin, superadmin).

   Export: renderCalendar(user)
   ===================================================================== */

import { $ } from '../core/dom.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MES_LARGO = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Hoy en Venezuela (GMT-4 fijo) como 'YYYY-MM-DD'.
function caracasTodayYMD() {
  const c = new Date(Date.now() - 4 * 3600 * 1000);
  const z = n => String(n).padStart(2, '0');
  return `${c.getUTCFullYear()}-${z(c.getUTCMonth() + 1)}-${z(c.getUTCDate())}`;
}
function dm(ymd) {
  if (!ymd) return '—';
  const s = String(ymd).slice(0, 10).split('-');
  return s.length === 3 ? `${+s[2]} ${MES[(+s[1]) - 1] || ''}` : ymd;
}
// report_deadline es timestamptz: lo mostramos en hora de Caracas con fecha + hora.
function deadlineLabel(iso, limitTime) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const c = new Date(d.getTime() - 4 * 3600 * 1000); // a Caracas
  const day = `${c.getUTCDate()} ${MES[c.getUTCMonth()] || ''}`;
  let h = c.getUTCHours();
  const mi = String(c.getUTCMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'p.m.' : 'a.m.';
  h = h % 12; if (h === 0) h = 12;
  return `${day} · ${h}:${mi} ${ap}`;
}

let USER = null;
let CAL_YEAR = null;
let CAL_YEARS = [];

function ensureStyles() {
  if (document.getElementById('calStyles')) return;
  const st = document.createElement('style');
  st.id = 'calStyles';
  st.textContent = `
  .cal-head{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap}
  .cal-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .cal-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .cal-year select{font:inherit;font-size:14px;padding:8px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink)}
  .cal-legend{display:flex;gap:16px;flex-wrap:wrap;margin:14px 0 4px;font-size:12px;color:var(--muted)}
  .cal-legend b{color:var(--ink);font-weight:600}
  .cal-month{margin-top:18px}
  .cal-mtitle{font-size:13px;font-weight:700;color:var(--ink);text-transform:uppercase;letter-spacing:.04em;margin:0 2px 8px}
  .cal-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
  .cal-card{border:1px solid var(--border);border-radius:13px;background:var(--card,#fff);padding:13px 14px;position:relative}
  .cal-card.past{opacity:.62}
  .cal-card.now{border-color:var(--brand,#2563eb);box-shadow:0 0 0 2px rgba(37,99,235,.16)}
  .cal-card.next{border-color:#16a34a}
  .cal-ch{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px}
  .cal-q{font-size:14px;font-weight:700;color:var(--ink)}
  .cal-q small{display:block;font-size:11px;font-weight:500;color:var(--muted);margin-top:1px}
  .cal-tag{font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:999px;white-space:nowrap}
  .cal-tag.now{background:#dbeafe;color:#1e40af}
  .cal-tag.next{background:#dcfce7;color:#166534}
  .cal-tag.over{background:#fef3c7;color:#92400e}
  .cal-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:4px 0;font-size:12.5px;border-top:1px dashed var(--border)}
  .cal-row:first-of-type{border-top:0}
  .cal-rl{color:var(--muted)}
  .cal-rv{font-weight:600;color:var(--ink);text-align:right}
  .cal-rv.pay{color:#166534}
  .cal-rv.dead{color:#b45309}
  .cal-empty{padding:34px 14px;text-align:center;color:var(--muted)}
  `;
  document.head.appendChild(st);
}

async function periodsApi(payload) {
  return fetch('/api/periods', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(r => r.json()).catch(() => ({ ok: false }));
}

export async function renderCalendar(user) {
  USER = user;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="cal-head"><div><h1>Calendario de nómina</h1>
      <p>Fechas de cada quincena: hasta cuándo reportar novedades y cuándo es el pago.</p></div></div>
    <div class="pnl-loading" style="margin-top:18px">Cargando…</div>`;

  if (!CAL_YEAR) {
    const yr = await periodsApi({ action: 'years' });
    CAL_YEARS = (yr.ok && yr.years && yr.years.length) ? yr.years : [new Date().getFullYear()];
    const todayY = +caracasTodayYMD().slice(0, 4);
    CAL_YEAR = CAL_YEARS.includes(todayY) ? todayY : CAL_YEARS[CAL_YEARS.length - 1];
  }
  await loadYear();
}

async function loadYear() {
  const r = await periodsApi({ action: 'list', year: CAL_YEAR });
  const periods = (r.ok && r.periods) ? r.periods : [];
  paint(periods);
}

function paint(periods) {
  const today = caracasTodayYMD();
  // Indice de la quincena "proxima" (la primera cuyo periodo aun no termino),
  // para marcar Actual/Proxima.
  let nowId = null, nextId = null;
  for (const p of periods) {
    if (today >= p.range_start && today <= p.range_end) { nowId = p.id; break; }
  }
  if (nowId == null) {
    for (const p of periods) { if (p.range_start > today) { nextId = p.id; break; } }
  }

  const yearSel = CAL_YEARS.length > 1
    ? `<div class="cal-year"><select id="calYear">${CAL_YEARS.map(y => `<option value="${y}" ${y === CAL_YEAR ? 'selected' : ''}>${y}</option>`).join('')}</select></div>`
    : '';

  // Agrupar por mes.
  const byMonth = {};
  periods.forEach(p => { (byMonth[p.month] = byMonth[p.month] || []).push(p); });

  let body = '';
  if (!periods.length) {
    body = `<div class="cal-empty">No hay quincenas cargadas para ${CAL_YEAR}.</div>`;
  } else {
    for (let m = 1; m <= 12; m++) {
      const list = byMonth[m];
      if (!list || !list.length) continue;
      body += `<div class="cal-month"><div class="cal-mtitle">${MES_LARGO[m - 1]} ${CAL_YEAR}</div><div class="cal-cards">`;
      body += list.map(p => cardHtml(p, today, nowId, nextId)).join('');
      body += `</div></div>`;
    }
  }

  $('#pnlMain').innerHTML = `
    <div class="cal-head">
      <div><h1>Calendario de nómina</h1>
        <p>Fechas de cada quincena: hasta cuándo reportar novedades y cuándo es el pago.</p></div>
      ${yearSel}
    </div>
    <div class="cal-legend">
      <span><b>Día de cálculo</b>: último día que entra en la nómina.</span>
      <span><b>Tope de reporte</b>: hasta cuándo enviar novedades.</span>
      <span><b>Día de pago</b>: cuándo se paga.</span>
    </div>
    ${body}`;

  const ys = $('#calYear');
  if (ys) ys.addEventListener('change', async () => {
    CAL_YEAR = parseInt(ys.value, 10);
    $('#pnlMain').querySelectorAll('.cal-month').forEach(e => e.remove());
    await loadYear();
  });
}

function cardHtml(p, today, nowId, nextId) {
  const isNow = p.id === nowId;
  const isNext = p.id === nextId;
  const isPast = today > p.range_end;
  const cls = isNow ? 'now' : (isNext ? 'next' : (isPast ? 'past' : ''));
  let tag = '';
  if (isNow) tag = '<span class="cal-tag now">Actual</span>';
  else if (isNext) tag = '<span class="cal-tag next">Próxima</span>';
  // Aviso si el tope de reporte ya pasó pero la quincena sigue siendo la actual.
  if (isNow && p.report_deadline) {
    const dl = new Date(p.report_deadline);
    if (!isNaN(dl) && Date.now() > dl.getTime()) tag = '<span class="cal-tag over">Reporte cerrado</span>';
  }
  return `<div class="cal-card ${cls}">
    <div class="cal-ch">
      <div class="cal-q">Quincena ${p.quincena}<small>${dm(p.range_start)} – ${dm(p.range_end)}</small></div>
      ${tag}
    </div>
    <div class="cal-row"><span class="cal-rl">Día de cálculo</span><span class="cal-rv">${dm(p.cutoff_date)}</span></div>
    <div class="cal-row"><span class="cal-rl">Tope de reporte</span><span class="cal-rv dead">${deadlineLabel(p.report_deadline, p.report_limit_time)}</span></div>
    <div class="cal-row"><span class="cal-rl">Día de pago</span><span class="cal-rv pay">${dm(p.pay_date)}</span></div>
  </div>`;
}
