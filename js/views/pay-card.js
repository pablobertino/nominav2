/* =====================================================================
   js/views/pay-card.js  →  Tarjeta de "Estado de pago del periodo"

   Se inyecta en el Inicio de la TIENDA, justo debajo de la linea de
   tiempo de la quincena. Lee de la TABLA CACHE nomina_v2.period_pay_status
   via /api/period-pay (action 'card'). NO llama al API de AX: ese refresco
   lo hace el cron (frecuencia variable por dia). El boton de refrescar de
   esta tarjeta solo RELEE LA TABLA (barato), para que la tienda vea el
   ultimo dato cargado sin recargar toda la pagina.

   La tabla guarda el periodo actual (idx 0) cuando ya tiene pago calculado;
   si no, el anterior (idx -1) y se aclara que corresponde al periodo
   anterior (usedFallback).

   Estados de pago: "Pago calculado" -> "Pago enviado" -> "Pago cargado"
   -> "Pagado".

   Exporta injectPayCard(host, companyCode). Silencioso si falla (no
   rompe el dashboard).
   ===================================================================== */

import { $ } from '../core/dom.js';
import { showPayHelpModal, ensurePayHelpStyles } from './pay-help.js';

const IC_WALLET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg>';
const IC_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* status del API -> { cls, txt } amigable. */
function payState(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('pagado')) return { cls: 'pst-pagado', txt: 'Pagado' };
  if (s.includes('enviado')) return { cls: 'pst-enviado', txt: 'Pago enviado' };
  if (s.includes('cargado')) return { cls: 'pst-cargado', txt: 'Pago cargado' };
  if (s.includes('calculado')) return { cls: 'pst-calculado', txt: 'Pago calculado' };
  return { cls: 'pst-pendiente', txt: status || 'Pendiente' };
}

/* 'YYYY-MM-DDT...' -> 'DD/MM'. */
function dm(s) { return s ? `${String(s).slice(8, 10)}/${String(s).slice(5, 7)}` : '\u2014'; }
function fmtRango(desde, hasta) { return `${dm(desde)} al ${dm(hasta)}`; }

/* timestamptz ISO (fetched_at) -> "hace N min/horas/dias", relativo a ahora.
   Devuelve texto corto y amistoso para que la tienda sepa que tan fresco es
   el dato. Si es muy reciente, "hace un momento". */
function fmtHace(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return 'hace un momento';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  const dias = Math.floor(hrs / 24);
  return `hace ${dias} ${dias === 1 ? 'dia' : 'dias'}`;
}

/* estilos (una vez) */
function ensureStyles() {
  if (document.getElementById('payCardStyles')) return;
  const st = document.createElement('style');
  st.id = 'payCardStyles';
  st.textContent = `
  .pay-card { background:var(--surface,#fff); border:1px solid var(--border,#e6eaf0);
    border-radius:var(--radius-lg,14px); box-shadow:var(--shadow-sm,0 1px 3px rgba(15,23,42,.05));
    padding:16px 20px; display:flex; align-items:center; gap:18px; flex-wrap:wrap; margin-bottom:14px; }
  .pay-card .pc-ic { width:42px; height:42px; border-radius:11px; flex:0 0 auto; display:flex;
    align-items:center; justify-content:center; background:var(--brand-bg,#eff4ff); color:var(--brand,#2563eb); }
  .pay-card .pc-ic svg { width:22px; height:22px; }
  .pay-card .pc-main { flex:1; min-width:180px; }
  .pay-card .pc-lbl { font-size:11px; text-transform:uppercase; letter-spacing:.04em;
    color:var(--muted,#64748b); font-weight:600; }
  .pay-card .pc-period { font-size:16px; font-weight:700; color:var(--ink,#0f172a); margin-top:3px; line-height:1.2; }
  .pay-card .pc-sub { font-size:12px; color:var(--faint,#94a3b8); margin-top:2px; }
  .pay-card .pc-state { flex:0 0 auto; display:flex; flex-direction:column; align-items:flex-end; gap:7px; }
  .pay-card .pst { display:inline-flex; align-items:center; gap:7px; padding:7px 14px; border-radius:999px;
    font-size:13px; font-weight:700; }
  .pay-card .pst::before { content:''; width:8px; height:8px; border-radius:50%; background:currentColor; }
  .pay-card .pst-pagado { background:#dcfce7; color:#15803d; }
  .pay-card .pst-enviado { background:#eff4ff; color:#1e40af; }
  .pay-card .pst-cargado { background:#fef3c7; color:#92400e; }
  .pay-card .pst-calculado { background:#f3e8ff; color:#7c3aed; }
  .pay-card .pst-pendiente { background:var(--border-soft,#f1f4f8); color:var(--muted,#64748b); }
  .pay-card .pst-pendiente::before { opacity:.5; }
  .pay-card .pc-aclara { font-size:11px; color:#b45309; background:#fef3c7; border-radius:6px;
    padding:3px 9px; margin-top:7px; display:inline-block; }
  .pay-card .pc-err { color:var(--danger,#dc2626); font-size:13px; }
  /* Pie: "actualizado hace X" + boton refrescar */
  .pay-card .pc-fresh { display:inline-flex; align-items:center; gap:6px; font-size:11px;
    color:var(--faint,#94a3b8); white-space:nowrap; }
  .pay-card .pc-refresh { display:inline-flex; align-items:center; justify-content:center;
    width:26px; height:26px; border-radius:8px; border:1px solid var(--border,#e6eaf0);
    background:var(--surface,#fff); color:var(--muted,#64748b); cursor:pointer; padding:0; }
  .pay-card .pc-refresh:hover { background:var(--brand-bg,#eff4ff); color:var(--brand,#2563eb);
    border-color:var(--brand,#2563eb); }
  .pay-card .pc-refresh svg { width:15px; height:15px; }
  .pay-card .pc-refresh.spin svg { animation:pcSpin .8s linear infinite; }
  .pay-card .pc-refresh:disabled { opacity:.6; cursor:default; }
  /* El "?" junto al chip de estado necesita mas separacion aqui (el chip de
     la tarjeta es mas grande que el de la grilla). */
  .pay-card .pay-help-q { margin-left:9px; }
  @keyframes pcSpin { to { transform:rotate(360deg); } }
  `;
  document.head.appendChild(st);
}

/* Pinta el contenido de la tarjeta a partir de un registro (reusable: la
   usa la carga inicial y el refresco). card = el div .pay-card. */
function paintCard(card, reg, usedFallback) {
  if (!reg) {
    card.innerHTML = `<div class="pc-ic">${IC_WALLET}</div>
      <div class="pc-main"><div class="pc-lbl">Estado de pago del periodo</div>
        <div class="pc-period">Sin informacion</div>
        <div class="pc-sub">Aun no hay un periodo con pago para tu empresa.</div></div>`;
    return;
  }
  const esAnterior = usedFallback || (reg.tag && reg.tag !== 'Actual');
  const st = payState(reg.status);
  const hace = fmtHace(reg.fetchedAt);
  card.innerHTML = `
    <div class="pc-ic">${IC_WALLET}</div>
    <div class="pc-main">
      <div class="pc-lbl">Estado de pago del periodo</div>
      <div class="pc-period">${esc(reg.periodoNomina || '\u2014')} <span style="font-weight:400;color:var(--faint,#94a3b8);font-size:13px">\u00b7 pago ${esc(reg.periodoPago || '\u2014')}</span></div>
      <div class="pc-sub">Rango de pago: ${esc(fmtRango(reg.pagoDesde, reg.pagoHasta))}</div>
      ${esAnterior ? `<span class="pc-aclara">Corresponde al periodo anterior \u2014 el actual aun no tiene pago calculado</span>` : ''}
    </div>
    <div class="pc-state">
      <span style="display:inline-flex;align-items:center"><span class="pst ${st.cls}">${esc(st.txt)}</span><span class="pay-help-q" id="pcPayHelp" title="Ver que significa cada estado de pago" role="button" tabindex="0">?</span></span>
      <span class="pc-fresh">${hace ? `Actualizado ${esc(hace)}` : ''}<button class="pc-refresh" type="button" title="Actualizar" aria-label="Actualizar">${IC_REFRESH}</button></span>
    </div>`;
}

/* Inserta la tarjeta como SEGUNDO bloque del host (debajo de la linea de
   tiempo, que se inserta como primer hijo). Si no hay timeline, queda
   igualmente arriba del contenido. Silencioso ante errores. */
export async function injectPayCard(host, companyCode) {
  if (!host || !companyCode) return;
  ensureStyles();
  // Estilos del "?" (.pay-help-q): los define pay-help.js. Se inyectan aqui
  // para que el signo salga con su tamano correcto desde el primer render,
  // sin depender de que el usuario abra el modal antes.
  ensurePayHelpStyles();

  const card = document.createElement('div');
  card.className = 'pay-card';
  card.innerHTML = `<div class="pc-ic">${IC_WALLET}</div>
    <div class="pc-main"><div class="pc-lbl">Estado de pago del periodo</div>
      <div class="pc-period" style="color:var(--faint,#94a3b8);font-weight:500;font-size:13px">Consultando\u2026</div></div>`;

  // Colocar debajo de la linea de tiempo. La timeline se inyecta async y
  // puede no estar aun en el DOM; reintentamos brevemente para ubicarla.
  // period-timeline.js inserta un <div class="tl"> como primer hijo del host.
  function place(attempt) {
    if (!host.isConnected && attempt > 0) return; // host ya no esta
    const timeline = host.querySelector('.tl');
    if (timeline && timeline.parentNode === host) {
      host.insertBefore(card, timeline.nextSibling);
    } else if (attempt < 8) {
      setTimeout(() => place(attempt + 1), 120);
      return;
    } else {
      host.insertBefore(card, host.firstChild); // sin timeline: al inicio
    }
  }
  place(0);

  // Lee la tabla cache (action 'card'). NO llama al API de AX.
  async function load() {
    try {
      return await fetch('/api/period-pay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'card', alias: companyCode }),
      }).then(r => r.json());
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }

  // Re-leer la tabla y re-pintar. La cablea paintCard tras cada render.
  async function refresh(btn) {
    if (btn) { btn.disabled = true; btn.classList.add('spin'); }
    const r = await load();
    if (r && r.ok) {
      paintCard(card, r.period, r.usedFallback);
      wireRefresh();
    } else if (btn) {
      btn.disabled = false; btn.classList.remove('spin');
    }
  }

  // Engancha el boton de refrescar del render actual.
  function wireRefresh() {
    const btn = card.querySelector('.pc-refresh');
    if (btn) btn.addEventListener('click', () => refresh(btn));
    // Ayuda "?" de estados de pago (se repinta con la tarjeta, re-enganchar).
    const help = card.querySelector('#pcPayHelp');
    if (help) help.addEventListener('click', showPayHelpModal);
  }

  const d = await load();
  if (!d || !d.ok) {
    // Si falla, retiramos la tarjeta para no dejar un "Consultando..." colgado.
    card.remove();
    return;
  }
  paintCard(card, d.period, d.usedFallback);
  wireRefresh();
}
