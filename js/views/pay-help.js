/* =====================================================================
   js/views/pay-help.js
   Ayuda compartida de los ESTADOS DE PAGO del periodo. La usan la grilla
   "Estado de pago" (admin/superadmin) y la tarjeta del Inicio de la tienda.

   Analogo a showAttHelpModal (ticket-actions.js) pero para el flujo de
   pago: Calculado -> Enviado -> Cargado -> Pagado. Incluye la nota de
   responsabilidad (Capital Humano vs Tesoreria).

   Sin onclick inline (CSP): el modal se arma con addEventListener.
   ===================================================================== */

/* Estados de pago en orden del flujo. cls = misma clase de pill que usan
   pay-grid/pay-card (.pst-*); label = nombre visible; desc = explicacion. */
export const PAY_STATES = {
  calculado: {
    cls: 'pst-calculado', label: 'Pago calculado',
    desc: 'Capital Humano realizo el calculo correspondiente a la quincena, determinando los montos a pagar.',
  },
  enviado: {
    cls: 'pst-enviado', label: 'Pago enviado',
    desc: 'Capital Humano reviso y ratifico el calculo, y lo remitio formalmente a Tesoreria para su gestion de pago.',
  },
  cargado: {
    cls: 'pst-cargado', label: 'Pago cargado',
    desc: 'Tesoreria cargo el pago en el portal bancario correspondiente.',
  },
  pagado: {
    cls: 'pst-pagado', label: 'Pagado',
    desc: 'Se verifico que los pagos cargados en el banco fueron procesados. Este proceso puede tardar hasta 48 horas habiles.',
  },
};
export const PAY_ORDER = ['calculado', 'enviado', 'cargado', 'pagado'];

/* Agrupacion de estados por departamento responsable. Los estados de cada
   grupo se pintan dentro de un bloque enmarcado con su encabezado, para que
   la division Capital Humano / Tesoreria se entienda de un vistazo. */
const PAY_GROUPS = [
  { key: 'ch', label: 'Gestiona Capital Humano', icon: '\u{1F464}', states: ['calculado', 'enviado'] },
  { key: 'tes', label: 'Gestiona Tesoreria', icon: '\u{1F3E6}', states: ['cargado', 'pagado'] },
];

/* Nota de responsabilidad (Capital Humano vs Tesoreria). La tienda NO ve un
   preview del calculo: no hay nada que reclamar hasta que el pago se realiza.
   Por eso no se menciona un "antes del pago". Tesoreria atiende la carga y
   ejecucion del pago; Capital Humano responde por el calculo, con 5 dias
   habiles despues del Dia de Pago para reclamar un monto mal calculado. */
const PAY_NOTE =
  'La <b>carga y ejecucion del pago</b> las gestiona <b>Tesoreria</b> (desde Pago enviado). '
  + 'Si detectas un <b>calculo errado</b>, lo revisa <b>Capital Humano</b>: tienes '
  + '<b>5 dias habiles despues del Dia de Pago</b> para reclamarlo.';

/* Estilos propios del modal de pago (una vez). Reusa .modal-ov / .modal-box
   del panel; solo agrega la lista y la nota. Exportada porque la tarjeta de
   la tienda (pay-card.js) tambien necesita .pay-help-q antes de que se abra
   el modal, para que el "?" salga con su tamano correcto de una. */
export function ensurePayHelpStyles() {
  if (document.getElementById('payHelpStyles')) return;
  const st = document.createElement('style');
  st.id = 'payHelpStyles';
  st.textContent = `
  .pay-help-intro { font-size:13px; color:var(--muted,#64748b); margin:0 0 14px; line-height:1.5; }
  /* Bloques por departamento responsable (CH morado, Tesoreria ambar). */
  .pay-help-groups { display:flex; flex-direction:column; gap:8px; margin:0 0 14px; }
  .pay-help-arrow { display:flex; justify-content:center; color:var(--faint,#94a3b8); line-height:1; margin:-2px 0; }
  .pay-help-arrow svg { width:18px; height:18px; }
  .pay-help-grp { border-radius:12px; overflow:hidden; border:1px solid; }
  .pay-help-grp.grp-ch { border-color:#ddd6fe; }
  .pay-help-grp.grp-tes { border-color:#fed7aa; }
  .pay-help-ghead { display:flex; align-items:center; gap:8px; padding:8px 14px; border-bottom:1px solid;
    font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; }
  .pay-help-grp.grp-ch .pay-help-ghead { background:#f3e8ff; color:#6b21a8; border-bottom-color:#ddd6fe; }
  .pay-help-grp.grp-tes .pay-help-ghead { background:#fef3c7; color:#92400e; border-bottom-color:#fed7aa; }
  .pay-help-list { list-style:none; margin:0; padding:12px 14px; display:flex; flex-direction:column; gap:12px; }
  .pay-help-list li { display:grid; grid-template-columns:130px 1fr; gap:12px; align-items:start; }
  .pay-help-list .pst { display:inline-flex; align-items:center; gap:7px; padding:4px 11px;
    border-radius:999px; font-size:12px; font-weight:700; justify-self:start; white-space:nowrap; }
  .pay-help-list .pst::before { content:''; width:7px; height:7px; border-radius:50%; background:currentColor; }
  .pay-help-list .pst-pagado { background:#dcfce7; color:#15803d; }
  .pay-help-list .pst-enviado { background:#eff4ff; color:#1e40af; }
  .pay-help-list .pst-cargado { background:#fef3c7; color:#92400e; }
  .pay-help-list .pst-calculado { background:#f3e8ff; color:#7c3aed; }
  .pay-help-desc { font-size:13px; color:var(--ink,#0f172a); line-height:1.5; }
  .pay-help-note { font-size:12.5px; color:var(--ink,#0f172a); line-height:1.55;
    background:#fff7ed; border:1px solid #fed7aa; border-radius:10px; padding:12px 14px; }
  .pay-help-note b { color:var(--ink,#0f172a); }
  .pay-help-note .ph-tag { display:inline-flex; align-items:center; gap:6px; font-weight:700;
    color:#b45309; margin-bottom:5px; }
  /* El "?" de ayuda. Mas grande y con fondo azul-tenue para que se note de
     entrada, tanto en la grilla como en la tarjeta de la tienda. */
  .pay-help-q { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px;
    border-radius:50%; background:var(--brand-bg,#eff4ff); color:var(--brand,#2563eb);
    font-size:14px; font-weight:700; cursor:pointer; margin-left:6px; vertical-align:middle;
    user-select:none; line-height:1; }
  .pay-help-q:hover { background:#dbe6fe; color:var(--brand,#1d4ed8); }
  `;
  document.head.appendChild(st);
}

/* Muestra el modal de ayuda de estados de pago. Cierra con la X, el boton
   Entendido, click en el fondo o Escape. Evita duplicados. */
export function showPayHelpModal() {
  if (document.getElementById('payHelpOv')) return;
  ensurePayHelpStyles();

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.id = 'payHelpOv';
  ov.innerHTML = `
    <div class="modal-box pay-help-modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <span>\u00bfQu\u00e9 significa cada estado de pago?</span>
        <button class="modal-x" id="payHelpX" aria-label="Cerrar">\u2715</button>
      </div>
      <p class="pay-help-intro">El estado refleja en qu\u00e9 punto del proceso de pago est\u00e1 la quincena. Cada etapa la gestiona un departamento distinto.</p>
      <div class="pay-help-groups">
        ${PAY_GROUPS.map((g, gi) => `
          <div class="pay-help-grp grp-${g.key}">
            <div class="pay-help-ghead"><span>${g.icon}</span><span>${g.label}</span></div>
            <ul class="pay-help-list">
              ${g.states.map(k => `
                <li>
                  <span class="pst ${PAY_STATES[k].cls}">${PAY_STATES[k].label}</span>
                  <span class="pay-help-desc">${PAY_STATES[k].desc}</span>
                </li>`).join('')}
            </ul>
          </div>
          ${gi < PAY_GROUPS.length - 1 ? '<div class="pay-help-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg></div>' : ''}`).join('')}
      </div>
      <div class="pay-help-note">
        <div class="ph-tag">\u26A0 Importante</div>
        ${PAY_NOTE}
      </div>
      <div class="modal-actions">
        <button class="btn btn-primary" id="payHelpOk">Entendido</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const close = () => {
    document.removeEventListener('keydown', onKey);
    ov.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.getElementById('payHelpX').addEventListener('click', close);
  document.getElementById('payHelpOk').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
}

/* Devuelve el HTML de un "?" clickable para poner junto a una etiqueta. El
   llamador debe enganchar el listener sobre el id que pase (CSP: sin inline).
   Ej: `Estado de pago ${payHelpQ('pgHelp')}` y luego
       $('#pgHelp').addEventListener('click', showPayHelpModal). */
export function payHelpQ(id) {
  return `<span class="pay-help-q" id="${id}" title="Ver qu\u00e9 significa cada estado de pago" role="button" tabindex="0">?</span>`;
}
