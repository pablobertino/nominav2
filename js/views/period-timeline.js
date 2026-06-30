/* =====================================================================
   js/views/period-timeline.js  →  Linea de tiempo de la quincena
   Barra horizontal del inicio de la quincena al dia de pago, con los 3
   hitos (ultimo dia de calculo / dia de calculo / dia de pago) como
   circulos con los iconos de los avisos recurrentes, el avance hasta HOY
   y la cuenta regresiva al pago. Se usa arriba del dashboard y del
   calendario (todos los roles).

   Datos: /api/periods action 'current' (lectura abierta).
   Export: injectPeriodTimeline(hostEl) -> inserta la barra como primer hijo.
   ===================================================================== */

const TL_ICON = {
  calc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="8" y2="10"/><line x1="12" y1="10" x2="12" y2="10"/><line x1="16" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="8" y2="14"/><line x1="12" y1="14" x2="12" y2="14"/><line x1="8" y1="18" x2="12" y2="18"/></svg>',
  cut:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l3-3 3 3 4-5"/></svg>',
  pay:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg>',
};
const TL_MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const TL_DIA = ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa'];

function tlD(iso) { const [y, m, dd] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)); }
function tlDM(iso) { const x = tlD(iso); return x.getUTCDate() + ' ' + TL_MES[x.getUTCMonth()]; }
function tlDiaDM(iso) { const x = tlD(iso); return TL_DIA[x.getUTCDay()] + ' ' + x.getUTCDate() + ' ' + TL_MES[x.getUTCMonth()]; }
function tlBetween(a, b) { return Math.round((tlD(b) - tlD(a)) / 86400000); }
function tlPos(iso, startISO, endISO) {
  const tot = tlBetween(startISO, endISO) || 1;
  return Math.max(0, Math.min(1, tlBetween(startISO, iso) / tot));
}

function tlEnsureStyles() {
  if (document.getElementById('tlStyles')) return;
  const st = document.createElement('style');
  st.id = 'tlStyles';
  st.textContent = `
  .tl{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg,14px);padding:16px 30px 14px;box-shadow:var(--shadow-sm);margin-bottom:18px}
  .tl-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;gap:12px;flex-wrap:wrap}
  .tl-title{font-size:14px;font-weight:600;color:var(--ink)}
  .tl-title small{font-weight:400;color:var(--muted);margin-left:6px;font-size:12.5px}
  .tl-countdown{font-size:12.5px;color:var(--ink-soft,#334155);background:var(--brand-bg,#eff6ff);border:1px solid #bfdbfe;border-radius:999px;padding:4px 13px;white-space:nowrap}
  .tl-countdown b{color:var(--brand);font-weight:700}
  .tl-countdown.pay-today{background:#ecfdf5;border-color:#a7f3d0}
  .tl-countdown.pay-today b{color:#166534}
  .tl-track-wrap{position:relative;padding:0 8px}
  .tl-track{position:relative;height:8px;border-radius:6px;background:var(--border-soft,#eef0f3);margin:52px 0 46px}
  .tl-fill{position:absolute;top:0;left:0;height:100%;border-radius:6px;background:linear-gradient(90deg,#93c5fd,#2563eb)}
  .tl-mk{position:absolute;top:50%;transform:translate(-50%,-50%);z-index:2}
  .tl-ic{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--surface);border:2.5px solid var(--faint,#94a3b8);color:var(--faint,#94a3b8);box-shadow:0 0 0 4px var(--surface);transition:transform .15s}
  .tl-ic svg{width:18px;height:18px}
  .tl-mk.done.calc .tl-ic{border-color:#f59e0b;background:#fef3c7;color:#b45309}
  .tl-mk.done.cut  .tl-ic{border-color:#3b82f6;background:#dbeafe;color:#1e40af}
  .tl-mk.done.pay  .tl-ic{border-color:#22c55e;background:#dcfce7;color:#166534}
  .tl-mk.act .tl-ic{transform:scale(1.12)}
  .tl-mk.act.calc .tl-ic{border-color:#b45309;background:#f59e0b;color:#fff;box-shadow:0 0 0 4px var(--surface),0 0 0 7px #fde68a}
  .tl-mk.act.cut  .tl-ic{border-color:#1e40af;background:#3b82f6;color:#fff;box-shadow:0 0 0 4px var(--surface),0 0 0 7px #bfdbfe}
  .tl-mk.act.pay  .tl-ic{border-color:#166534;background:#22c55e;color:#fff;box-shadow:0 0 0 4px var(--surface),0 0 0 7px #a7f3d0}
  .tl-lbl{position:absolute;top:40px;left:50%;transform:translateX(-50%);text-align:center;white-space:nowrap}
  .tl-lbl .d{font-size:11px;color:var(--ink);font-weight:700;line-height:1.2}
  .tl-lbl .n{display:block;font-size:10.5px;color:var(--muted);font-weight:500;margin-top:2px}
  .tl-mk.act .tl-lbl .d{color:var(--brand)}
  .tl-today{position:absolute;top:-50px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;z-index:6;pointer-events:none}
  .tl-today .bub{background:var(--brand);color:#fff;font-size:10.5px;font-weight:700;padding:4px 11px;border-radius:999px;white-space:nowrap;box-shadow:0 2px 8px rgba(37,99,235,.35)}
  .tl-today .stem{width:2px;flex:1;min-height:28px;background:var(--brand)}
  .tl-today .pin{width:14px;height:14px;border-radius:50%;background:var(--brand);border:3px solid var(--surface);box-shadow:0 0 0 2px var(--brand);margin-bottom:-3px}
  .tl-today.on-hito .pin{display:none}
  .tl-today.on-hito .stem{min-height:14px}
  @media (max-width:560px){
    .tl{padding:16px 16px 18px}
    .tl-ic{width:32px;height:32px}
    .tl-lbl .d{font-size:10px}.tl-lbl .n{font-size:9.5px}
  }
  `;
  document.head.appendChild(st);
}

function tlCountdown(todayISO, payISO) {
  const toPay = tlBetween(todayISO, payISO);
  if (toPay > 1) return { txt: `Faltan <b>${toPay} días</b> para el pago`, cls: '' };
  if (toPay === 1) return { txt: `<b>Mañana</b> es el día de pago`, cls: '' };
  if (toPay === 0) return { txt: `<b>Hoy es el día de pago</b> 🎉`, cls: 'pay-today' };
  return { txt: `Pago realizado · período en cierre`, cls: '' };
}

function tlHtml(period, todayISO) {
  const startISO = period.range_start;
  const endISO = period.pay_date;       // el eje termina en el dia de pago
  const hitos = [
    { k: 'calc', name: 'Último',  iso: period.milestone_date },
    { k: 'cut',  name: 'Cálculo', iso: period.cutoff_date },
    { k: 'pay',  name: 'Pago',    iso: period.pay_date },
  ];
  const todayPos = tlPos(todayISO, startISO, endISO) * 100;
  const cd = tlCountdown(todayISO, period.pay_date);
  const onHito = hitos.some(h => h.iso === todayISO);
  const mks = hitos.map(h => {
    const p = tlPos(h.iso, startISO, endISO) * 100;
    const done = tlBetween(h.iso, todayISO) > 0;
    const act = h.iso === todayISO;
    return `<div class="tl-mk ${h.k} ${done ? 'done' : ''} ${act ? 'act' : ''}" style="left:${p}%">
      <div class="tl-ic">${TL_ICON[h.k]}</div>
      <div class="tl-lbl"><span class="d">${tlDiaDM(h.iso)}</span><span class="n">${h.name}</span></div>
    </div>`;
  }).join('');
  return `<div class="tl">
    <div class="tl-top">
      <div class="tl-title">Quincena en curso <small>${period.name} · ${tlDM(period.range_start)} al ${tlDM(period.range_end)}</small></div>
      <div class="tl-countdown ${cd.cls}">${cd.txt}</div>
    </div>
    <div class="tl-track-wrap">
      <div class="tl-track">
        <div class="tl-fill" style="width:${todayPos}%"></div>
        ${mks}
        <div class="tl-today ${onHito ? 'on-hito' : ''}" style="left:${todayPos}%">
          <div class="bub">HOY · ${tlDiaDM(todayISO)}</div>
          <div class="stem"></div>
          <div class="pin"></div>
        </div>
      </div>
    </div>
  </div>`;
}

/**
 * Inserta la linea de tiempo como PRIMER hijo del contenedor host.
 * Carga el periodo vigente de /api/periods (action current). Si no hay
 * periodo o falla, no inserta nada (silencioso).
 * @param {HTMLElement} host  contenedor (p.ej. #pnlMain)
 */
export async function injectPeriodTimeline(host) {
  if (!host) return;
  let data;
  try {
    data = await fetch('/api/periods', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'current' }),
    }).then(r => r.json());
  } catch { return; }
  if (!data || !data.ok || !data.period) return;
  const p = data.period;
  // Validacion minima de fechas.
  if (!p.range_start || !p.pay_date || !p.milestone_date || !p.cutoff_date) return;

  tlEnsureStyles();
  const el = document.createElement('div');
  el.id = 'periodTimeline';
  el.innerHTML = tlHtml(p, data.today);
  // Evitar duplicados si se re-renderiza.
  const prev = host.querySelector('#periodTimeline');
  if (prev) prev.remove();
  host.insertBefore(el.firstElementChild, host.firstChild);
}
