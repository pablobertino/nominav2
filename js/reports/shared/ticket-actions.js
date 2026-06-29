/* =====================================================================
   js/reports/shared/ticket-actions.js
   Utilidades compartidas por el Historial y la pantalla de Detalle:
     - Estados de atencion (identicos a osTicket) + pills.
     - Regenerar/copiar/descargar el texto del ticket (.txt).
     - Regenerar/descargar la plantilla de Excel del ticket (.xlsx).
     - Cambiar el estado de atencion (solo admin/superadmin).
     - Modal de ayuda con la explicacion de cada estado.
     - Formato de la auditoria "quien / cuando".
   Sin onclick inline (la CSP del sitio los bloquea): el llamador engancha
   los listeners. Aqui solo se exponen funciones puras + helpers de red.
   ===================================================================== */

/* Estados de atencion (identicos a osTicket). label = nombre visible,
   cls = clase del pill (color), desc = explicacion para el modal de ayuda. */
export const ATT_STATES = {
  open:     { label: 'Abierto',  cls: 'att-open',     desc: 'Sin atender todavia. El reporte llego pero nadie lo ha tomado.' },
  attended: { label: 'Atendido', cls: 'att-attended', desc: 'En proceso. Capital Humano ya lo esta revisando.' },
  resolved: { label: 'Resuelto', cls: 'att-resolved', desc: 'Resuelto, pero aun NO cargado en el sistema (AX).' },
  closed:   { label: 'Cerrado',  cls: 'att-closed',   desc: 'Ya cargado en el sistema (AX). Proceso terminado.' },
};
export const ATT_ORDER = ['open', 'attended', 'resolved', 'closed'];

export function attPill(a) {
  const s = ATT_STATES[a] || ATT_STATES.open;
  return `<span class="pill ${s.cls}">${s.label}</span>`;
}

/* Indicador de sincronizacion con osTicket. na -> nada; synced -> ok;
   failed -> no se pudo (hover muestra el detalle); pending -> en curso. */
export function syncPill(s) {
  if (!s || s === 'na') return '';
  if (s === 'synced') return '<span class="pill att-resolved" title="Estado sincronizado con osTicket">\u2713 sinc.</span>';
  if (s === 'failed') return '<span class="pill pill-out" title="No se pudo sincronizar con osTicket">\u26A0 sinc.</span>';
  return '<span class="pill pill-pend" title="Sincronizando con osTicket">\u21BB sinc.</span>';
}

/* timestamptz ISO -> 'DD/MM/AAAA HH:MM a.m./p.m.' en hora Caracas (GMT-4). */
export function fmtStamp(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt)) return iso;
  const car = new Date(dt.getTime() - 4 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  let h = car.getUTCHours(); const ap = h < 12 ? 'a. m.' : 'p. m.';
  h = h % 12; if (h === 0) h = 12;
  return `${p(car.getUTCDate())}/${p(car.getUTCMonth() + 1)}/${car.getUTCFullYear()} ${h}:${p(car.getUTCMinutes())} ${ap}`;
}

/* Texto corto de auditoria del cambio de estado: "por X · DD/MM HH:MM".
   Devuelve '' si no hay datos. */
export function attAuditText(row) {
  const at = row.attention_at ? fmtStamp(row.attention_at) : '';
  const by = row.attention_by_name || '';
  if (!at && !by) return '';
  if (at && by) return `por ${by} \u00b7 ${at}`;
  return by ? `por ${by}` : at;
}

/* ---------------------------------------------------------------------
   Red: regenerar texto / excel / cambiar estado. Todas devuelven el JSON
   crudo del backend (o null si falla la red); el llamador decide el feedback.
   --------------------------------------------------------------------- */
export async function fetchTicketText(user, reportId) {
  const d = await fetch('/api/reports-history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'ticket_text', user, report_id: reportId }),
  }).then(r => r.json()).catch(() => null);
  return (d && d.ok && d.text) ? d : null;
}

export async function fetchTicketExcel(user, reportId) {
  const d = await fetch('/api/reports-history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'ticket_excel', user, report_id: reportId }),
  }).then(r => r.json()).catch(() => null);
  return (d && d.ok && d.base64) ? d : null;
}

export async function postSetAttention(user, reportIds, status, comment) {
  return fetch('/api/reports-history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set_attention', user, report_ids: reportIds, status, comment: comment || null }),
  }).then(r => r.json()).catch(() => null);
}

/* (Re)sincroniza con osTicket el estado actual de uno o varios reportes,
   sin cambiar el estado interno. Pasa report_ids para puntuales, o
   mode:'pending' para todos los pendientes/fallidos del alcance. */
export async function postSyncOsticket(user, { reportIds, mode } = {}) {
  const payload = { action: 'sync_osticket', user };
  if (mode) payload.mode = mode;
  if (reportIds) payload.report_ids = reportIds;
  return fetch('/api/reports-history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(r => r.json()).catch(() => null);
}

/* Pide al backend que documentos hay que re-adjuntar para (re)generar los
   tickets de un reporte sin osTicket. Devuelve { ok, needs_docs, slots, ... }. */
export async function fetchResendInfo(user, reportId) {
  return fetch('/api/reports-history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'resend_info', user, report_id: reportId }),
  }).then(r => r.json()).catch(() => null);
}

/* Genera los tickets del reporte en osTicket con los archivos re-adjuntados.
   files: [{ key, file_name, file_b64, file_type }]. */
export async function postResendOsticket(user, reportId, files) {
  return fetch('/api/reports-history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'resend_osticket', user, report_id: reportId, files: files || [] }),
  }).then(r => r.json()).catch(() => null);
}

/* Lee un File a base64 (sin el prefijo data:). Devuelve
   { name, b64, type } o null. Mismo mecanismo que los formularios. */
export function readFileB64(file) {
  return new Promise(resolve => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name,
      b64: String(reader.result).split(',')[1] || '',
      type: file.type || 'application/octet-stream',
    });
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/* ---------------------------------------------------------------------
   Portapapeles + descargas.
   --------------------------------------------------------------------- */
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

export function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename || 'reporte.txt';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function downloadBase64(base64, filename, mime) {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename || 'plantilla.xlsx';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ---------------------------------------------------------------------
   Modal de ayuda: explica cada estado de forma legible (no un alert).
   Se monta sobre <body>, se cierra con la X, el boton Entendido, click en
   el fondo o Escape. Sin dependencias.
   --------------------------------------------------------------------- */
export function showAttHelpModal() {
  // Evitar duplicados.
  if (document.getElementById('attHelpOv')) return;

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.id = 'attHelpOv';
  ov.innerHTML = `
    <div class="modal-box att-help-modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <span>\u00bfQu\u00e9 significa cada estado?</span>
        <button class="modal-x" id="attHelpX" aria-label="Cerrar">\u2715</button>
      </div>
      <p class="att-help-intro">El estado refleja en qu\u00e9 punto de la atenci\u00f3n est\u00e1 cada reporte.</p>
      <ul class="att-help-list">
        ${ATT_ORDER.map(k => `
          <li>
            <span class="pill ${ATT_STATES[k].cls}">${ATT_STATES[k].label}</span>
            <span class="att-help-desc">${ATT_STATES[k].desc}</span>
          </li>`).join('')}
      </ul>
      <div class="modal-actions">
        <button class="btn btn-primary" id="attHelpOk">Entendido</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const close = () => {
    document.removeEventListener('keydown', onKey);
    ov.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.getElementById('attHelpX').addEventListener('click', close);
  document.getElementById('attHelpOk').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
}
