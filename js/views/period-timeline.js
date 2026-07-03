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
  claim: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="15" x2="12" y2="15"/></svg>',
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
  .tl-right{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .tl-prevpay{font-size:12.5px;color:#166534;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:999px;padding:4px 13px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
  .tl-prevpay svg{width:14px;height:14px}
  .tl-prevpay b{font-weight:700}
  .tl-track-wrap{position:relative;padding:0 8px}
  .tl-track{position:relative;height:8px;border-radius:6px;background:var(--border-soft,#eef0f3);margin:52px 0 46px}
  .tl-fill{position:absolute;top:0;left:0;height:100%;border-radius:6px;background:linear-gradient(90deg,#93c5fd,#2563eb)}
  /* Tramo de la VENTANA DE RECLAMO (pago anterior -> cierre de plazo). Color
     distinto al azul del avance: ambar, porque es un rango vivo, no un punto. */
  .tl-claim{position:absolute;top:0;height:100%;border-radius:6px;
    background:repeating-linear-gradient(45deg,#fcd34d,#fcd34d 6px,#fde68a 6px,#fde68a 12px);
    opacity:.9;z-index:1}
  .tl-claim.closed{background:repeating-linear-gradient(45deg,#e2e8f0,#e2e8f0 6px,#eef2f7 6px,#eef2f7 12px)}
  .tl-mk{position:absolute;top:50%;transform:translate(-50%,-50%);z-index:2}
  .tl-ic{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--surface);border:2.5px solid var(--faint,#94a3b8);color:var(--faint,#94a3b8);box-shadow:0 0 0 4px var(--surface);transition:transform .15s}
  .tl-ic svg{width:18px;height:18px}
  .tl-mk.done.calc .tl-ic{border-color:#f59e0b;background:#fef3c7;color:#b45309}
  .tl-mk.done.cut  .tl-ic{border-color:#3b82f6;background:#dbeafe;color:#1e40af}
  .tl-mk.done.pay  .tl-ic{border-color:#22c55e;background:#dcfce7;color:#166534}
  .tl-mk.prevpay .tl-ic{border-color:#16a34a;background:#dcfce7;color:#15803d}
  .tl-mk.prevpay.today .tl-ic{border-color:#166534;background:#22c55e;color:#fff;box-shadow:0 0 0 4px var(--surface),0 0 0 7px #a7f3d0}
  .tl-mk.prevpay .tl-lbl .d{color:#15803d}
  .tl-mk.prevpay .tl-lbl .n{color:#16a34a;font-weight:700}
  .tl-mk.prevpay.today .tl-lbl{top:44px}
  /* Nodo del cierre del plazo de reclamo (ambar). Si el plazo ya cerro
     (hoy > cierre) se muestra en gris apagado. */
  .tl-mk.claim .tl-ic{border-color:#d97706;background:#fef3c7;color:#b45309}
  .tl-mk.claim.closed .tl-ic{border-color:#cbd5e1;background:#f1f5f9;color:#94a3b8}
  .tl-mk.claim.act .tl-ic{border-color:#b45309;background:#f59e0b;color:#fff;box-shadow:0 0 0 4px var(--surface),0 0 0 7px #fde68a}
  .tl-mk.claim .tl-lbl .d{color:#b45309}
  .tl-mk.claim .tl-lbl .n{color:#d97706;font-weight:700}
  .tl-mk.claim.closed .tl-lbl .d{color:var(--muted,#64748b)}
  .tl-mk.claim.closed .tl-lbl .n{color:var(--faint,#94a3b8)}
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

function tlHtml(period, todayISO, prev) {
  const startISO = period.range_start;
  const endISO = period.pay_date;       // el eje termina en el dia de pago
  const hitos = [
    { k: 'calc', name: 'Último',  iso: period.milestone_date },
    { k: 'cut',  name: 'Cálculo', iso: period.cutoff_date },
    { k: 'pay',  name: 'Pago',    iso: period.pay_date },
  ];
  const todayPos = tlPos(todayISO, startISO, endISO) * 100;
  const cd = tlCountdown(todayISO, period.pay_date);

  // Hito de pago de la quincena ANTERIOR: su pago cae el mismo dia que arranca
  // la actual (inicio de la barra, pos 0). Se muestra durante toda la quincena.
  // Etiqueta dinamica: "Pago hoy" si hoy es ese dia, "Pago anterior" despues.
  // El chip de la derecha solo aparece el dia exacto del pago.
  let prevMk = '';
  let prevChip = '';
  let claimSeg = '';
  let claimMk = '';
  const prevIsValid = prev && prev.pay_date && prev.pay_date === startISO;
  if (prevIsValid) {
    const payToday = (todayISO === prev.pay_date);
    const prevLbl = payToday ? 'Pago hoy' : 'Pago anterior';
    prevMk = `<div class="tl-mk prevpay${payToday ? ' today' : ''}" style="left:0%">
      <div class="tl-ic">${TL_ICON.pay}</div>
      <div class="tl-lbl"><span class="d">${tlDiaDM(prev.pay_date)}</span><span class="n">${prevLbl}</span></div>
    </div>`;
    if (payToday) {
      prevChip = `<div class="tl-prevpay">${TL_ICON.pay} Hoy se paga la quincena anterior <b>${prev.name}</b></div>`;
    }

    // Ventana de RECLAMO de la quincena anterior: desde el pago anterior (pos 0)
    // hasta su cierre de plazo (prev.claim_deadline). Es un RANGO, por eso se
    // pinta como un tramo ambar (no un punto) con un nodo al final. Solo se
    // dibuja si el cierre cae dentro del eje visible [startISO .. endISO];
    // si el plazo se extiende mas alla del pago actual, se ancla al final del eje.
    if (prev.claim_deadline) {
      const claimISO = prev.claim_deadline;
      const claimInAxis = tlBetween(claimISO, endISO) >= 0; // claim <= fin del eje
      const claimPos = tlPos(claimISO, startISO, endISO) * 100;
      const closed = tlBetween(claimISO, todayISO) > 0; // hoy ya paso el cierre
      const act = claimISO === todayISO;
      // El tramo va de 0% a la posicion del cierre (clamp a 100 si se sale).
      const segEnd = Math.min(100, claimPos);
      claimSeg = `<div class="tl-claim${closed ? ' closed' : ''}" style="left:0%;width:${segEnd}%"></div>`;
      // El nodo del cierre solo se dibuja si cae dentro del eje; si no, se omite
      // (la quincena en curso ya no lo alcanza a mostrar).
      if (claimInAxis) {
        claimMk = `<div class="tl-mk claim${closed ? ' closed' : ''}${act ? ' act' : ''}" style="left:${claimPos}%">
          <div class="tl-ic">${TL_ICON.claim}</div>
          <div class="tl-lbl"><span class="d">${tlDiaDM(claimISO)}</span><span class="n">Plazo Reclamo</span></div>
        </div>`;
      }
    }
  }

  const onHito = hitos.some(h => h.iso === todayISO) || (prevIsValid && prev.pay_date === todayISO);
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
      <div class="tl-right">${prevChip}<div class="tl-countdown ${cd.cls}">${cd.txt}</div></div>
    </div>
    <div class="tl-track-wrap">
      <div class="tl-track">
        <div class="tl-fill" style="width:${todayPos}%"></div>
        ${claimSeg}
        ${prevMk}${claimMk}${mks}
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
  el.innerHTML = tlHtml(p, data.today, data.prev || null);
  // Evitar duplicados si se re-renderiza.
  const prev = host.querySelector('#periodTimeline');
  if (prev) prev.remove();
  host.insertBefore(el.firstElementChild, host.firstChild);
}
