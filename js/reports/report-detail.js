/* =====================================================================
   js/reports/report-detail.js
   Pantalla dedicada (a todo el ancho) con el detalle de un reporte.
   Se monta en #pnlMain reemplazando el historial; "Volver" regresa.

   Delegacion por tipo: cada reporte sabe pintar sus propias lineas.
   Por ahora marcaje y ausencia tienen tabla propia; los demas muestran
   un detalle generico hasta que se construyan.

   Acciones disponibles aqui (igual que en el Historial):
     - Copiar / descargar .txt / descargar Excel del ticket.
     - (admin/superadmin) cambiar el estado de atencion + ver quien/cuando.
     - Ayuda "?" con la explicacion de cada estado (modal legible).
   ===================================================================== */

import { $ } from '../core/dom.js';
import {
  ATT_STATES, ATT_ORDER, attPill, syncPill, attAuditText, fmtStamp,
  fetchTicketText, fetchTicketExcel, postSetAttention,
  copyText, downloadText, downloadBase64, showAttHelpModal,
} from './shared/ticket-actions.js';

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
  if (r.type === 'ausencia') {
    if (!r.lines || !r.lines.length) return '<p class="hint">Sin líneas de detalle.</p>';
    const docCell = (l) => {
      if (l.doc_status == null) return '<span style="color:var(--muted)">No requiere</span>';
      if (l.doc_status === 'adjunto') return `<span class="pill pill-set">📎 Adjunto</span>`;
      return `<span class="pill pill-pend">Pendiente${l.doc_name ? ' · ' + l.doc_name : ''}</span>`;
    };
    return `<table class="dtl-table"><thead><tr>
      <th>Trabajador</th><th>Cédula</th><th>Tipo</th><th>Cód. AX</th><th>Desde</th><th>Hasta</th><th>Documento</th><th>Nota</th>
    </tr></thead><tbody>
      ${r.lines.map(l => `<tr>
        <td><b>${l.name}</b></td>
        <td class="ced">${l.id_number}</td>
        <td>${l.absence_label}</td>
        <td><span class="pill pill-ax">${l.ax_code}</span></td>
        <td>${fmtDate(l.date_from)}</td>
        <td>${fmtDate(l.date_to)}</td>
        <td>${docCell(l)}</td>
        <td>${l.note ? l.note : '<span style="color:var(--muted)">—</span>'}</td>
      </tr>`).join('')}
    </tbody></table>`;
  }
  // otros tipos: aun no construidos
  return `<p class="hint">Este reporte incluye ${r.workers_count} trabajador(es). El detalle específico de “${(TYPES[r.type] || {}).label || r.type}” estará disponible cuando se implemente ese tipo de reporte.</p>`;
}

/**
 * Pinta la pantalla de detalle.
 * @param {object} opts { reportId, user, onBack }
 */
export async function showReportDetail({ reportId, user, onBack }) {
  const host = $('#pnlMain');
  host.innerHTML = `<div class="pnl-loading">Cargando reporte…</div>`;

  // Solo admin/superadmin pueden cambiar el estado de atencion.
  const canManage = user.kind === 'admin' && (user.role === 'admin' || user.role === 'superadmin');

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

  // Bloque de la celda Atencion: pill + (admin) selector + sync + auditoria.
  const audit = attAuditText(r);
  const auditHtml = audit ? `<div class="att-audit">${audit}</div>` : '';
  const commentHtml = r.attention_comment
    ? `<div class="att-comment">“${r.attention_comment}”</div>` : '';
  let attentionBlock;
  if (canManage) {
    attentionBlock = `<div class="att-cell">
      ${attPill(r.attention)}
      <select class="att-row-sel" id="rdAttSel" title="Cambiar estado de este reporte">
        ${ATT_ORDER.map(k => `<option value="${k}" ${k === r.attention ? 'selected' : ''}>${ATT_STATES[k].label}</option>`).join('')}
      </select>
      ${syncPill(r.osticket_sync)}${auditHtml}${commentHtml}</div>`;
  } else {
    attentionBlock = `${attPill(r.attention)}${auditHtml}${commentHtml}`;
  }

  host.innerHTML = `
    <button class="btn" id="rdBack" style="margin-bottom:18px">← Volver al historial</button>
    <div class="rd-head">
      <div class="rd-id">
        <span class="rd-ico">${t.icon}</span>
        <div><h1 class="rd-title">Reporte #${r.id}</h1><div class="rd-subtype">${t.label}</div></div>
      </div>
      <div class="rd-actions">
        <button class="btn" id="rdCopy" title="Copiar el texto del ticket">\u29C9 Copiar</button>
        <button class="btn" id="rdTxt" title="Descargar el texto del ticket (.txt)">\u2913 .txt</button>
        <button class="btn" id="rdXls" title="Descargar la plantilla de Excel del ticket (.xlsx)">\u2913 Excel</button>
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
        <div><span class="rd-lbl">Atención <span class="att-help" id="rdAttHelp" title="Ver qué significa cada estado">?</span></span><span class="rd-val">${attentionBlock}</span></div>
        <div><span class="rd-lbl">osTicket</span><span class="rd-val">${otPill(r)}</span></div>
      </div>
      <h3 class="rd-section">Trabajadores del reporte</h3>
      ${linesHtml(r)}
    </div>`;

  $('#rdBack').addEventListener('click', onBack);

  // --- Acciones de ticket (copiar / .txt / excel) ---
  let _txtCache = null;
  async function getTxt() {
    if (_txtCache) return _txtCache;
    const d = await fetchTicketText(user, r.id);
    if (d) _txtCache = { text: d.text, filename: d.filename };
    return _txtCache;
  }

  $('#rdCopy').addEventListener('click', async () => {
    const b = $('#rdCopy'); const orig = b.textContent;
    b.disabled = true; b.textContent = '…';
    const d = await getTxt();
    if (!d) { b.textContent = 'Error'; setTimeout(() => { b.textContent = orig; b.disabled = false; }, 1500); return; }
    const ok = await copyText(d.text);
    b.textContent = ok ? '\u2713 Copiado' : 'Error';
    setTimeout(() => { b.textContent = orig; b.disabled = false; }, 1500);
  });

  $('#rdTxt').addEventListener('click', async () => {
    const b = $('#rdTxt'); const orig = b.textContent;
    b.disabled = true; b.textContent = '…';
    const d = await getTxt();
    if (!d) { b.textContent = 'Error'; setTimeout(() => { b.textContent = orig; b.disabled = false; }, 1500); return; }
    downloadText(d.text, d.filename);
    b.textContent = '\u2713';
    setTimeout(() => { b.textContent = orig; b.disabled = false; }, 1200);
  });

  $('#rdXls').addEventListener('click', async () => {
    const b = $('#rdXls'); const orig = b.textContent;
    b.disabled = true; b.textContent = '…';
    const d = await fetchTicketExcel(user, r.id);
    if (!d) { b.textContent = 'Error'; setTimeout(() => { b.textContent = orig; b.disabled = false; }, 1500); return; }
    downloadBase64(d.base64, d.filename, d.mime);
    b.textContent = '\u2713';
    setTimeout(() => { b.textContent = orig; b.disabled = false; }, 1200);
  });

  // --- Ayuda de estados (modal legible) ---
  if ($('#rdAttHelp')) $('#rdAttHelp').addEventListener('click', showAttHelpModal);

  // --- Cambio de estado (solo admin/superadmin) ---
  if (canManage && $('#rdAttSel')) {
    $('#rdAttSel').addEventListener('change', async () => {
      const sel = $('#rdAttSel');
      const status = sel.value;
      sel.disabled = true;
      const d = await postSetAttention(user, [r.id], status, null);
      sel.disabled = false;
      if (!d || !d.ok) { alert(d ? d.error : 'No se pudo cambiar el estado.'); return; }
      // Refrescar en memoria y repintar el bloque de atencion sin recargar todo.
      r.attention = status;
      r.attention_at = d.attention_at || r.attention_at;
      r.attention_by_name = d.attention_by_name || r.attention_by_name;
      const newAudit = attAuditText(r);
      const cell = sel.closest('.att-cell');
      if (cell) {
        cell.querySelector('.pill').outerHTML = attPill(status);
        let auditEl = cell.querySelector('.att-audit');
        if (newAudit) {
          if (auditEl) auditEl.textContent = newAudit;
          else { const dv = document.createElement('div'); dv.className = 'att-audit'; dv.textContent = newAudit; cell.appendChild(dv); }
        }
      }
    });
  }

  if (canResend && $('#rdResend')) {
    $('#rdResend').addEventListener('click', () => {
      alert('El envío a osTicket aún no está habilitado. Quedará disponible cuando se active la integración.');
    });
  }
}
