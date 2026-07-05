/* =====================================================================
   js/reports/shared/resend-modal.js
   Modal para (re)generar los tickets de un reporte que quedo "No enviado"
   a osTicket. Pide al backend que documentos hacen falta (resend_info),
   deja re-adjuntarlos (opcion D) y dispara resend_osticket.

   - Tipos sin documentos (marcaje/modificacion): el modal solo confirma y
     envia (no pide archivos).
   - Tipos con documentos (ausencia/egreso/ingreso): muestra un slot por
     documento (trabajador + nombre del recaudo) con su boton de adjuntar.
     Los obligatorios (required) deben adjuntarse para poder enviar; los
     demas pueden quedar sin archivo (el ticket DOC no se crea para esos).

   Sin onclick inline (CSP): se enganchan listeners. Reusa .modal-ov/.modal.
   ===================================================================== */

import { fetchResendInfo, postResendOsticket, readFileB64 } from './ticket-actions.js';

/* Abre el modal. onDone() se llama tras un reenvio exitoso (para recargar). */
export async function openResendModal(user, report, onDone) {
  // report: { id, type, company_code, company_name }
  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal resend-modal">
      <h3>Enviar a osTicket</h3>
      <p class="who">Reporte N.° ${report.id} · ${report.company_code}${report.company_name ? ` · ${report.company_name}` : ''}</p>
      <div id="rsBody"><div class="pnl-loading">Cargando…</div></div>
    </div>`;
  document.body.appendChild(ov);

  const close = () => { document.removeEventListener('keydown', onKey); ov.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  // Se cierra SOLO con sus botones (Cancelar / Cerrar) o Escape; no al hacer clic fuera.
  document.addEventListener('keydown', onKey);

  const info = await fetchResendInfo(user, report.id);
  if (!info || !info.ok) {
    $body(ov).innerHTML = `
      <p class="rs-error">${info ? (info.error || 'No se pudo preparar el reenvío.') : 'Error de red.'}</p>
      <div class="wiz-foot" style="margin-top:14px"><button class="btn" id="rsCancel">Cerrar</button></div>`;
    ov.querySelector('#rsCancel').addEventListener('click', close);
    return;
  }

  // Estado local: archivos elegidos por key de slot. { [key]: {name,b64,type} }
  const picked = {};
  const slots = info.slots || [];

  renderForm();

  function renderForm() {
    const body = $body(ov);
    if (!slots.length) {
      // Sin documentos: confirmar y enviar.
      body.innerHTML = `
        <p class="rs-intro">Este reporte (<b>${info.topic_label}</b>) no lleva documentos adjuntos.
          Se generará el ticket con su plantilla. ¿Enviar a osTicket?</p>
        <div class="wiz-foot" style="margin-top:16px">
          <button class="btn" id="rsCancel">Cancelar</button>
          <button class="btn btn-primary" id="rsSend">Enviar a osTicket</button>
        </div>
        <div class="rs-status" id="rsStatus"></div>`;
    } else {
      body.innerHTML = `
        <p class="rs-intro">Este reporte (<b>${info.topic_label}</b>) tenía documentos adjuntos.
          Los archivos no se conservan, así que vuelve a adjuntarlos para incluirlos en sus tickets.
          Los marcados como <b>obligatorio</b> deben adjuntarse; el resto puede quedar sin archivo.</p>
        <div class="rs-slots">
          ${slots.map(s => slotRow(s)).join('')}
        </div>
        <div class="wiz-foot" style="margin-top:16px">
          <button class="btn" id="rsCancel">Cancelar</button>
          <button class="btn btn-primary" id="rsSend">Enviar a osTicket</button>
        </div>
        <div class="rs-status" id="rsStatus"></div>`;
    }

    body.querySelector('#rsCancel').addEventListener('click', close);
    body.querySelector('#rsSend').addEventListener('click', doSend);

    // Listeners de cada slot (adjuntar / quitar).
    slots.forEach(s => {
      const fileInput = body.querySelector(`[data-file="${s.key}"]`);
      const pickBtn = body.querySelector(`[data-pick="${s.key}"]`);
      const clearBtn = body.querySelector(`[data-clear="${s.key}"]`);
      if (pickBtn && fileInput) pickBtn.addEventListener('click', () => fileInput.click());
      if (fileInput) fileInput.addEventListener('change', async e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const r = await readFileB64(f);
        if (r) { picked[s.key] = r; renderForm(); updateSend(); }
      });
      if (clearBtn) clearBtn.addEventListener('click', () => { delete picked[s.key]; renderForm(); updateSend(); });
    });

    updateSend();
  }

  function slotRow(s) {
    const f = picked[s.key];
    const reqBadge = s.required ? '<span class="pill pill-out">obligatorio</span>' : '<span class="pill pill-pend">opcional</span>';
    const fileCell = f
      ? `<span class="file-pill">\u{1F4CE} ${f.name} <span class="x" data-clear="${s.key}">\u2715</span></span>`
      : `<button class="btn btn-sm btn-primary" data-pick="${s.key}">\u{1F4CE} Adjuntar</button>`;
    return `<div class="rs-slot">
      <div class="rs-slot-info">
        <b>${s.worker_name || s.worker_id}</b> <span class="ced">${s.worker_id}</span>
        <div class="rs-slot-doc">${s.doc_name} ${reqBadge}</div>
      </div>
      <div class="rs-slot-file">${fileCell}</div>
      <input type="file" data-file="${s.key}" hidden accept="image/*,.pdf,.doc,.docx">
    </div>`;
  }

  // Habilita Enviar solo si todos los obligatorios tienen archivo.
  function updateSend() {
    const btn = ov.querySelector('#rsSend');
    if (!btn) return;
    const missing = slots.some(s => s.required && !picked[s.key]);
    btn.disabled = missing;
  }

  async function doSend() {
    const btn = ov.querySelector('#rsSend');
    const status = ov.querySelector('#rsStatus');
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
    if (status) status.textContent = '';

    const files = Object.keys(picked).map(key => ({
      key,
      file_name: picked[key].name,
      file_b64: picked[key].b64,
      file_type: picked[key].type,
    }));

    const res = await postResendOsticket(user, report.id, files);
    if (!res || !res.ok) {
      if (status) {
        const errs = (res && res.errors && res.errors.length) ? ` (${res.errors.join('; ')})` : '';
        status.innerHTML = `<span class="rs-error">${res ? (res.error || 'No se pudo enviar.') : 'Error de red.'}${errs}</span>`;
      }
      if (btn) { btn.disabled = false; btn.textContent = 'Enviar a osTicket'; }
      return;
    }
    // Exito: avisar y cerrar.
    const extra = res.tickets_fail ? ` (${res.tickets_fail} pieza(s) con error: ${(res.errors || []).join('; ')})` : '';
    if (status) status.innerHTML = `<span class="rs-ok">\u2713 Ticket #${res.osticket_id} generado.${extra}</span>`;
    setTimeout(() => { close(); if (typeof onDone === 'function') onDone(); }, 900);
  }
}

function $body(ov) { return ov.querySelector('#rsBody'); }
