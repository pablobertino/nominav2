/* =====================================================================
   js/reports/report-detail.js
   Pantalla dedicada (a todo el ancho) con el detalle de un reporte.
   Se monta en #pnlMain reemplazando el historial; "Volver" regresa.

   Delegacion por tipo: cada reporte sabe pintar sus propias lineas.
   Por ahora marcaje tiene tabla propia; los demas muestran un detalle
   generico hasta que se construyan.
   ===================================================================== */

import { $ } from '../core/dom.js';

const TYPES = {
  marcaje:      { label: 'Marcaje Manual', icon: '🕐' },
  ausencia:     { label: 'Período de Ausencia', icon: '📅' },
  ingreso:      { label: 'Ingreso — Alta', icon: '✅' },
  egreso:       { label: 'Egreso — Baja', icon: '🔴' },
  modificacion: { label: 'Modificación de Datos', icon: '✏️' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/* timestamptz ISO -> 'DD/MM/AAAA HH:MM a.m./p.m.' en hora Caracas (GMT-4) */
function fmtSent(iso) {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (isNaN(dt)) return iso;
  const car = new Date(dt.getTime() - 4 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  let h = car.getUTCHours(); const ap = h < 12 ? 'a. m.' : 'p. m.';
  h = h % 12; if (h === 0) h = 12;
  return `${p(car.getUTCDate())}/${p(car.getUTCMonth() + 1)}/${car.getUTCFullYear()} ${h}:${p(car.getUTCMinutes())} ${ap}`;
}

function attPill(a) {
  return a === 'done'
    ? '<span class="pill pill-set">Atendido</span>'
    : '<span class="pill pill-pend">Pendiente</span>';
}
function otPill(r) {
  if (r.osticket_id) return `<span class="pill pill-set">Enviado · #${r.osticket_id}</span>`;
  return '<span class="pill pill-out">No enviado</span>';
}
function originPill(r) {
  return r.source_kind === 'admin'
    ? '<span class="pill pill-origin-admin">Administrador</span>'
    : '<span class="pill pill-origin-company">Empresa</span>';
}

/* Lineas especificas por tipo. */
function linesHtml(r) {
  if (r.type === 'marcaje') {
    if (!r.lines || !r.lines.length) return '<p class="hint">Sin líneas de detalle.</p>';
    return `<table class="dtl-table"><thead><tr>
      <th>Trabajador</th><th>Cédula</th><th>Fecha</th><th>Entrada</th><th>Salida</th><th>Causa</th>
    </tr></thead><tbody>
      ${r.lines.map(l => `<tr>
        <td><b>${l.name}</b></td>
        <td class="ced">${l.id_number}</td>
        <td>${fmtDate(l.mark_date)}</td>
        <td><span class="time-badge">${l.time_in}</span></td>
        <td><span class="time-badge">${l.time_out}</span></td>
        <td>${l.cause}</td>
      </tr>`).join('')}
    </tbody></table>`;
  }
  // otros tipos: aun no construidos
  return `<p class="hint">Este reporte incluye ${r.workers_count} trabajador(es). El detalle específico de “${(TYPES[r.type] || {}).label || r.type}” estará disponible cuando se implemente ese tipo de reporte.</p>`;
}

/**
 * Pinta la pantalla de detalle.
 * @param {object} opts { reportId, user, onBack, canResend }
 */
export async function showReportDetail({ reportId, user, onBack }) {
  const host = $('#pnlMain');
  host.innerHTML = `<div class="pnl-loading">Cargando reporte…</div>`;

  const res = await fetch('/api/reports-history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'detail', user, report_id: reportId }),
  }).then(r => r.json()).catch(() => null);

  if (!res || !res.ok) {
    host.innerHTML = `
      <button class="btn" id="rdBack" style="margin-bottom:18px">← Volver al historial</button>
      <div class="card"><p class="muted" style="margin:0">No se pudo cargar el reporte: ${res ? res.error : 'error de red'}.</p></div>`;
    $('#rdBack').addEventListener('click', onBack);
    return;
  }

  const r = res.report;
  const t = TYPES[r.type] || { label: r.type, icon: '📄' };
  const canResend = !r.osticket_id;

  host.innerHTML = `
    <button class="btn" id="rdBack" style="margin-bottom:18px">← Volver al historial</button>
    <div class="rd-head">
      <div class="rd-id">
        <span class="rd-ico">${t.icon}</span>
        <div><h1 class="rd-title">Reporte #${r.id}</h1><div class="rd-subtype">${t.label}</div></div>
      </div>
      <div class="rd-actions">
        ${canResend ? `<button class="btn btn-send" id="rdResend">Enviar a osTicket</button>` : ''}
      </div>
    </div>
    <p class="rd-sent">Enviado el ${fmtSent(r.sent_at)}</p>

    <div class="card">
      <div class="rd-meta">
        <div><span class="rd-lbl">Tienda</span><span class="rd-val">${r.company_code}${r.company_name ? ' · ' + r.company_name : ''}</span></div>
        <div><span class="rd-lbl">Responsable</span><span class="rd-val">${r.responsible || '—'}${r.position ? ' · ' + r.position : ''}</span></div>
        <div><span class="rd-lbl">Origen</span><span class="rd-val">${originPill(r)}</span></div>
        <div><span class="rd-lbl">Trabajadores</span><span class="rd-val">${r.workers_count}</span></div>
        <div><span class="rd-lbl">Atención</span><span class="rd-val">${attPill(r.attention)}</span></div>
        <div><span class="rd-lbl">osTicket</span><span class="rd-val">${otPill(r)}</span></div>
      </div>
      <h3 class="rd-section">Trabajadores del reporte</h3>
      ${linesHtml(r)}
    </div>`;

  $('#rdBack').addEventListener('click', onBack);
  if (canResend && $('#rdResend')) {
    $('#rdResend').addEventListener('click', () => {
      // El envio real a osTicket se conecta cuando se implemente ese bloque.
      alert('El envío a osTicket aún no está habilitado. Quedará disponible cuando se active la integración.');
    });
  }
}
