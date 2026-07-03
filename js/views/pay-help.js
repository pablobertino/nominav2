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

/* Nota de responsabilidad (Capital Humano vs Tesoreria). */
const PAY_NOTE =
  'Hasta el estado <b>Pago calculado</b>, las consultas o reclamos corresponden a '
  + '<b>Capital Humano</b>. A partir del estado <b>Pago enviado</b>, la responsabilidad '
  + 'pasa a <b>Tesoreria</b>; por lo tanto, cualquier consulta relacionada con la carga, '
  + 'procesamiento o ejecucion del pago debera dirigirse al departamento correspondiente, '
  + 'segun el estado en que se encuentre.';

/* Estilos propios del modal de pago (una vez). Reusa .modal-ov / .modal-box
   del panel; solo agrega la lista y la nota. */
function ensurePayHelpStyles() {
  if (document.getElementById('payHelpStyles')) return;
  const st = document.createElement('style');
  st.id = 'payHelpStyles';
  st.textContent = `
  .pay-help-intro { font-size:13px; color:var(--muted,#64748b); margin:0 0 14px; line-height:1.5; }
  .pay-help-list { list-style:none; margin:0 0 14px; padding:0; display:flex; flex-direction:column; gap:12px; }
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
  /* El "?" de ayuda, mismo look que .att-help pero reutilizable aqui. */
  .pay-help-q { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px;
    border-radius:50%; background:var(--border-soft,#eef2f7); color:var(--muted,#64748b);
    font-size:11px; font-weight:700; cursor:pointer; margin-left:6px; vertical-align:middle;
    user-select:none; line-height:1; }
  .pay-help-q:hover { background:var(--brand-bg,#eff4ff); color:var(--brand,#2563eb); }
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
      <p class="pay-help-intro">El estado refleja en qu\u00e9 punto del proceso de pago est\u00e1 la quincena.</p>
      <ul class="pay-help-list">
        ${PAY_ORDER.map(k => `
          <li>
            <span class="pst ${PAY_STATES[k].cls}">${PAY_STATES[k].label}</span>
            <span class="pay-help-desc">${PAY_STATES[k].desc}</span>
          </li>`).join('')}
      </ul>
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
