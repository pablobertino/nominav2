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
import { initialsOf, avatarColors } from '../core/avatar.js';
import { renderWorkerPhotos, openWorkerLightbox } from '../views/worker-photos.js';
import { openResendModal } from './shared/resend-modal.js';
import { openPublishAxModal, motivoNoPublicable, AX_ARROW } from './shared/publish-ax.js';
import {
  ATT_STATES, ATT_ORDER, attPill, axPublishedPill, syncDot, attAuditText, fmtStamp,
  fetchTicketText, fetchTicketExcel, postSetAttention, postSyncOsticket,
  copyText, downloadText, downloadBase64, showAttHelpModal, noticeModal,
} from './shared/ticket-actions.js';

/* v6.168 — Permisos del Detalle por la MATRIZ, no por el rol (mismo arreglo
   que en el Historial: un coordinador con report.attention concedido no veia
   el selector de estado). Cacheado en module scope; permisivo si falla la
   red, porque el endpoint valida el permiso igual. */
const RD_CODES = ['report.attention', 'report.publish.marcaje', 'report.publish.ausencia'];
let RD_PERMS = null;

async function ensureDetailPerms(user) {
  if (RD_PERMS) return RD_PERMS;
  const todos = (v) => { RD_PERMS = {}; RD_CODES.forEach(c => { RD_PERMS[c] = v; }); return RD_PERMS; };
  if (user.kind !== 'admin') return todos(false);
  if (user.role === 'superadmin') return todos(true);
  try {
    const r = await fetch('/api/my-perms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { kind: user.kind, id: user.id || null }, codes: RD_CODES }),
    }).then(x => x.json());
    if (!r || !r.ok) return todos(true);
    if (r.super) return todos(true);
    RD_PERMS = {};
    RD_CODES.forEach(c => { RD_PERMS[c] = !!(r.perms && r.perms[c]); });
    return RD_PERMS;
  } catch (_) { return todos(true); }
}

const TYPES = {
  marcaje:      { label: 'Marcaje Manual', icon: '🕐' },
  ausencia:     { label: 'Período de Ausencia', icon: '📅' },
  ingreso:      { label: 'Ingreso — Alta', icon: '✅' },
  egreso:       { label: 'Egreso — Baja', icon: '🔴' },
  modificacion: { label: 'Modificación de Datos', icon: '✏️' },
  traslado:     { label: 'Traslado', icon: '🔁' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/* v6.210 — Los tipos viejos (marcaje, ausencia) interpolaban los textos
   crudos. En egreso e ingreso hay campos que ESCRIBE una persona en la
   tienda -el comentario del motivo, el correo, la direccion- y esos no se
   pueden meter sin escapar en una plantilla HTML. */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

function otPill(r, osticketUrl, isAgent) {
  if (!r.osticket_id) return '<span class="pill pill-out">No enviado</span>';
  if (osticketUrl) {
    const num = encodeURIComponent(r.osticket_id);
    // agente -> panel de staff (/scp/); usuario -> puente propio gc_ticket.php
    // que traduce el numero al id interno y redirige a tickets.php?id=.
    const href = isAgent
      ? `${osticketUrl}/scp/tickets.php?number=${num}`
      : `${osticketUrl}/gc_ticket.php?number=${num}`;
    return `<a class="pill pill-set ot-link" href="${href}" target="_blank" rel="noopener" title="Abrir el ticket en osTicket">Enviado · #${r.osticket_id}</a>`;
  }
  return `<span class="pill pill-set">Enviado · #${r.osticket_id}</span>`;
}
function originPill(r) {
  // Igual que el Historial (history.js): para envios de la central se muestra
  // el ROL REAL del emisor (source_role, del catálogo de Roles), no un
  // genérico "Administrador".
  return r.source_kind === 'admin'
    ? `<span class="pill pill-origin-admin">${r.source_role || r.position || 'Central'}</span>`
    : `<span class="pill pill-origin-company">${r.company_type || 'Empresa'}</span>`;
}

/* =====================================================================
   CELDA DEL TRABAJADOR (v6.211) — avatar + nombre + cedula + ficha.

   Una sola para los CUATRO tipos de reporte. Antes cada rama pintaba el
   nombre a su manera; ahora la columna "Trabajador" se ve igual en marcaje,
   ausencia, egreso e ingreso, que es lo que uno espera de una misma tabla
   con distinto contenido.

   El boton de ficha es el MISMO icono de carnet que Buscar personal, a
   proposito: alla la ficha se abre con boton y la empresa con texto
   clicable, y el Detalle repite esa gramatica en vez de inventar otra.

   TRES ESTADOS, y la diferencia entre los dos ultimos importa:
     con foto        la miniatura publica (bucket worker-thumbs).
     sin foto        iniciales de color, y el boton igual: la ficha existe.
     sin ficha       ni boton ni enlace, y se dice "sin ficha aún". Pasa en
                     los ingresos, con gente que se esta dando de alta y
                     todavia no entro al maestro. Un boton que abre una
                     pantalla vacia es peor que no tener boton.
   ===================================================================== */
const ICO_FICHA = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="10" r="2"/><path d="M13 9h5M13 13h5M6.5 15.5c.4-1.2 1.4-2 2.5-2s2.1.8 2.5 2"/></svg>';

function avatarHtml(l) {
  if (l.thumb_url) {
    // haspic + data-avpic: mismo par que .ps-ava en Buscar personal. El clic
    // abre el visor grande (openWorkerLightbox), que es la misma ventana que
    // ya se usa alla, con su boton de descargar.
    return `<div class="rd-ava haspic" data-avpic="${esc(l.id_number)}" title="Ver foto"><img src="${esc(l.thumb_url)}" alt="" loading="lazy" onerror="this.remove()"></div>`;
  }
  const c = avatarColors(l.id_number);
  const cls = l.in_master === false ? 'rd-ava rd-ava-nof' : 'rd-ava';
  return `<div class="${cls}" style="background:${c.bg};color:${c.fg}">${esc(initialsOf(l.name))}</div>`;
}

function workerCell(l) {
  const sinFicha = l.in_master === false;
  const btn = sinFicha
    ? '<div class="rd-noficha">sin ficha aún</div>'
    : `<button type="button" class="icon-btn rd-fichabtn" data-ficha="${esc(l.id_number)}" title="Ver la ficha de ${esc(l.name)}">${ICO_FICHA}</button>`;
  return `<div class="rd-wcell">
      ${avatarHtml(l)}
      <div class="rd-wname"><b>${esc(l.name)}</b><div class="ced">${esc(l.ced_kind ? `${l.ced_kind}-${l.id_number}` : l.id_number)}</div>${sinFicha ? btn : ''}</div>
      ${sinFicha ? '' : btn}
    </div>`;
}

/* Lineas especificas por tipo. */
function linesHtml(r) {
  if (r.type === 'marcaje') {
    if (!r.lines || !r.lines.length) return '<p class="hint">Sin líneas de detalle.</p>';
    return `<table class="dtl-table"><thead><tr>
      <th>Trabajador</th><th>Fecha</th><th>Entrada</th><th>Salida</th><th>Causa</th>
    </tr></thead><tbody>
      ${r.lines.map(l => `<tr>
        <td>${workerCell(l)}</td>
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
      <th>Trabajador</th><th>Tipo</th><th>Cód. AX</th><th>Desde</th><th>Hasta</th><th>Documento</th><th>Nota</th>
    </tr></thead><tbody>
      ${r.lines.map(l => `<tr>
        <td>${workerCell(l)}</td>
        <td>${l.absence_label}</td>
        <td><span class="pill pill-ax">${l.ax_code}</span></td>
        <td>${fmtDate(l.date_from)}</td>
        <td>${fmtDate(l.date_to)}</td>
        <td>${docCell(l)}</td>
        <td>${l.note ? l.note : '<span style="color:var(--muted)">—</span>'}</td>
      </tr>`).join('')}
    </tbody></table>`;
  }
  if (r.type === 'egreso') {
    if (!r.lines || !r.lines.length) return '<p class="hint">Sin líneas de detalle.</p>';

    /* La fecha que manda es report_date, que es la que viaja a AX. real_date
       solo aparece cuando DIFIERE (el backend ya la manda en null si son
       iguales): repetir dos veces la misma fecha no informa y hace dudar. */
    const fechaCell = (l) => fmtDate(l.report_date)
      + (l.real_date ? `<div class="dtl-sub">real: ${fmtDate(l.real_date)}</div>` : '');

    /* Antiguedad en la unidad que se entiende de un vistazo. Que alguien haya
       durado 1 dia y otro 3 años no puede leerse igual, y "450 dias" obliga a
       hacer la cuenta mentalmente. */
    const antig = (l) => {
      const d = l.tenure_days;
      if (d == null) return '<span class="muted">—</span>';
      let txt;
      if (d < 31) txt = `${d} día${d === 1 ? '' : 's'}`;
      else if (d < 365) {
        // Math.max(1,...) y el plural a mano: 31 dias redondea a 1 y salia
        // "1 meses". Se ve en pantalla, y en una tabla de datos duros una
        // falta de concordancia hace dudar del resto de los numeros.
        const m = Math.max(1, Math.round(d / 30));
        txt = `${m} mes${m === 1 ? '' : 'es'}`;
      } else {
        const a = Math.floor(d / 365); const m = Math.round((d % 365) / 30);
        txt = `${a} a.${m ? ` ${m} m.` : ''}`;
      }
      return txt + (l.start_date ? `<div class="dtl-sub">desde ${fmtDate(l.start_date)}</div>` : '');
    };

    /* El motivo lo elige la tienda de una lista; el comentario lo ESCRIBE una
       persona y suele explicar lo que el codigo no. Por eso va visible y no
       en un tooltip. Debajo, solo si la central ratifico o RECTIFICO: el
       'pendiente' es el estado de la mayoria y decirlo en cada fila seria
       llenar la tabla de una palabra que no informa. */
    const motivo = (l) => {
      const base = l.reason ? esc(l.reason) : '<span class="muted">—</span>';
      const com = l.reason_comment ? `<div class="dtl-note">“${esc(l.reason_comment)}”</div>` : '';
      let rat = '';
      if (l.ratif_status === 'rectificado') {
        rat = `<div class="dtl-sub dtl-rect">rectificado${l.ratif_reason ? ` a: ${esc(l.ratif_reason)}` : ''}</div>`;
      } else if (l.ratif_status === 'ratificado') {
        rat = '<div class="dtl-sub">ratificado</div>';
      }
      return base + com + rat;
    };

    /* Cuando el documento no se exige, se dice POR QUE no se exige. "No
       requiere" a secas no deja auditar nada. */
    const docCell = (l) => {
      if (l.has_document) return '<span class="pill pill-set">📎 Adjunto</span>';
      if (l.doc_waived) {
        return `<span class="muted">No requiere</span>${l.doc_cause ? `<div class="dtl-sub">${esc(l.doc_cause)}</div>` : ''}`;
      }
      return `<span class="pill pill-pend">Pendiente</span>${l.doc_cause ? `<div class="dtl-sub">${esc(l.doc_cause)}</div>` : ''}`;
    };

    /* Misma regla que el Historial, porque es la misma funcion de la base
       (egresos_lineas_ax). Informativo: no cierra ni bloquea nada. */
    const axCell = (l) => {
      if (!l.ax_fin_contrato) return '<span class="muted">—</span>';
      const igual = l.ax_fin_contrato === l.report_date;
      return `<div class="att-ax att-ax-ok">${fmtDate(l.ax_fin_contrato).slice(0, 5)}</div>`
        + (igual ? '' : `<div class="att-ax-sub">el reporte dice ${fmtDate(l.report_date).slice(0, 5)}</div>`);
    };

    return `<table class="dtl-table"><thead><tr>
      <th>Trabajador</th><th>Cargo</th><th>Egreso</th><th>Antigüedad</th><th>Motivo</th><th>Documento</th>
      <th title="Si esta persona ya figura egresada en AX, según la última sincronización">En AX</th>
    </tr></thead><tbody>
      ${r.lines.map(l => `<tr>
        <td>${workerCell(l)}</td>
        <td>${l.role ? esc(l.role) : '<span class="muted">—</span>'}</td>
        <td>${fechaCell(l)}</td>
        <td>${antig(l)}</td>
        <td>${motivo(l)}</td>
        <td>${docCell(l)}</td>
        <td>${axCell(l)}</td>
      </tr>`).join('')}
    </tbody></table>`;
  }

  if (r.type === 'ingreso') {
    if (!r.lines || !r.lines.length) return '<p class="hint">Sin líneas de detalle.</p>';

    const edad = (l) => {
      if (l.age_years != null) return `${l.age_years} años`;
      if (!l.birth_date) return '<span class="muted">—</span>';
      const b = new Date(l.birth_date), h = new Date();
      let a = h.getFullYear() - b.getFullYear();
      const m = h.getMonth() - b.getMonth();
      if (m < 0 || (m === 0 && h.getDate() < b.getDate())) a--;
      return `${a} años`;
    };

    /* Solo los ultimos 4 digitos de la cuenta: el numero entero no hace falta
       para leer un reporte. Quien lo necesite lo tiene en Cuentas bancarias. */
    const banco = (l) => {
      if (!l.bank_name && !l.account_tail) return '<span class="muted">—</span>';
      return `${esc(l.bank_name || '—')}${l.account_tail ? `<div class="dtl-sub">···${esc(l.account_tail)}</div>` : ''}`;
    };

    const contacto = (l) => {
      const p = [];
      if (l.phone) p.push(esc(l.phone));
      if (l.email) p.push(`<div class="dtl-sub">${esc(l.email)}</div>`);
      return p.length ? p.join('') : '<span class="muted">—</span>';
    };

    /* Los pendientes se NOMBRAN. "2 de 4" obliga a abrir otra cosa para saber
       cuales faltan, y es justo el dato que uno viene a buscar. */
    const docs = (l) => {
      if (!l.docs_total) return '<span class="muted">No requiere</span>';
      if (!l.docs_pend.length) return `<span class="pill pill-set">📎 ${l.docs_ok} de ${l.docs_total}</span>`;
      return `<span class="pill pill-pend">${l.docs_ok} de ${l.docs_total}</span>`
        + `<div class="dtl-sub">falta: ${esc(l.docs_pend.join(', '))}</div>`;
    };

    return `<table class="dtl-table"><thead><tr>
      <th>Trabajador</th><th>Cargo</th><th>Ingreso</th><th>Edad</th><th>Banco</th><th>Contacto</th><th>Documentos</th>
    </tr></thead><tbody>
      ${r.lines.map(l => `<tr>
        <td>${workerCell(l)}</td>
        <td>${l.role ? esc(l.role) : '<span class="muted">—</span>'}</td>
        <td>${fmtDate(l.start_date)}</td>
        <td>${edad(l)}</td>
        <td>${banco(l)}</td>
        <td>${contacto(l)}</td>
        <td>${docs(l)}</td>
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

  // Quien puede cambiar el estado y quien puede publicar en AX: lo decide la
  // matriz de Roles, no el nombre del rol.
  const perms = await ensureDetailPerms(user);
  const canManage = !!perms['report.attention'];
  const canPublishAx = !!perms['report.publish.marcaje'];
  const canPublishAus = !!perms['report.publish.ausencia'];

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
  const osticketUrl = res.osticket_url || '';
  const viewerIsAgent = !!res.viewer_is_agent;
  const t = TYPES[r.type] || { label: r.type, icon: '📄' };
  const canResend = !r.osticket_id;

  // --- Banda de estado (Variante A): Atencion + osTicket en una franja
  //     propia, separada de los metadatos del reporte. ---
  const audit = attAuditText(r);
  const auditHtml = audit ? `<div class="sb-audit">${audit}</div>` : '';
  const commentHtml = r.attention_comment
    ? `<div class="sb-audit" style="font-style:italic">“${r.attention_comment}”</div>` : '';

  // v6.168 \u2014 Publicado en AX: el estado queda sellado. Va la pildora con
  // candado y NO el selector; el trigger de la base rechazaria el cambio de
  // todas formas, y un desplegable que siempre falla es peor que ninguno.
  const publicado = !!r.ax_published_at;
  const pubHtml = publicado
    ? `<div class="sb-audit">Publicado${r.ax_published_by_name ? ` por ${r.ax_published_by_name}` : ''}
        ${r.ax_published_at ? ` \u00B7 ${fmtStamp(r.ax_published_at)}` : ''}</div>`
    : '';

  let attControls;
  if (publicado) {
    attControls = `<div class="sb-row">${axPublishedPill(r.ax_published_at)}${syncDot(r.osticket_sync)}</div>${pubHtml}${auditHtml}${commentHtml}`;
  } else if (canManage) {
    const syncBtn = r.osticket_id
      ? `<button class="icon-btn att-syncbtn" id="rdSync" title="Reenviar a osTicket el estado actual de este reporte">\u21BB</button>`
      : '';
    attControls = `<div class="sb-row">
        <select class="att-row-sel att-${r.attention}" id="rdAttSel" title="Cambiar estado de este reporte">
          ${ATT_ORDER.map(k => `<option value="${k}" ${k === r.attention ? 'selected' : ''}>${ATT_STATES[k].label}</option>`).join('')}
        </select>${syncDot(r.osticket_sync)}${syncBtn}
      </div>${auditHtml}${commentHtml}`;
  } else {
    attControls = `<div class="sb-row">${attPill(r.attention)}</div>${auditHtml}${commentHtml}`;
  }

  /* Boton "Publicar". Quien decide si el reporte es publicable es
     motivoNoPublicable, la MISMA funcion que usan el Historial y la cola:
     si opinaran distinto, el usuario veria el boton en un sitio y no en el
     otro. v6.181: ya cubre Marcaje Manual y Periodo de Ausencia. */
  const permisoPub = r.type === 'ausencia' ? canPublishAus : canPublishAx;
  const showPubBtn = permisoPub && !motivoNoPublicable(r);

  const statusBand = `
    <div class="statusband">
      <div class="sb-block">
        <span class="sb-lbl">Atención <span class="att-help" id="rdAttHelp" title="Ver qué significa cada estado">?</span></span>
        ${attControls}
      </div>
      <div class="sb-sep"></div>
      <div class="sb-block">
        <span class="sb-lbl">osTicket</span>
        <div class="sb-row">${otPill(r, osticketUrl, viewerIsAgent)}</div>
      </div>
    </div>`;

  host.innerHTML = `
    <button class="btn" id="rdBack" style="margin-bottom:18px">← Volver al historial</button>
    <div class="rd-head">
      <div class="rd-id">
        <span class="rd-ico">${t.icon}</span>
        <div><h1 class="rd-title">Reporte #${r.id}</h1><div class="rd-subtype">${t.label}</div></div>
      </div>
      <div class="rd-actions">
        <button class="icon-btn" id="rdCopy" title="Copiar el texto del ticket">\u29C9</button>
        <button class="icon-btn" id="rdTxt" title="Descargar el texto del ticket (.txt)">\u2913</button>
        <button class="icon-btn" id="rdXls" title="Descargar la plantilla de Excel del ticket (.xlsx)">\u{1F4C4}</button>
        ${showPubBtn ? `<button class="btn btn-ax" id="rdPubAx" style="margin-left:8px" title="Cargar estos marcajes en AX 2012. Si entran todos, el reporte queda cerrado para siempre.">${AX_ARROW} Publicar</button>` : ''}
        ${canResend ? `<button class="btn btn-send" id="rdResend" style="margin-left:8px">Enviar a osTicket</button>` : ''}
      </div>
    </div>
    <p class="rd-sent">Enviado el ${fmtSent(r.sent_at)}</p>

    <div class="card">
      ${statusBand}
      <div class="rd-meta">
        <div><span class="rd-lbl">Tienda</span><span class="rd-val"><span class="rd-emplink" id="rdEmpLink" title="Ver el personal de ${esc(r.company_code)}">${esc(r.company_code)}${r.company_name ? ' · ' + esc(r.company_name) : ''}</span></span></div>
        <div><span class="rd-lbl">Responsable</span><span class="rd-val">${r.responsible || '—'}${(() => { const sub = r.source_kind === 'admin' ? (r.source_role || r.position) : r.position; return sub ? ' · ' + sub : ''; })()}</span></div>
        <div><span class="rd-lbl">Origen</span><span class="rd-val">${originPill(r)}</span></div>
        <div><span class="rd-lbl">Trabajadores</span><span class="rd-val">${r.workers_count}</span></div>
      </div>
      <h3 class="rd-section">Trabajadores del reporte</h3>
      ${linesHtml(r)}
    </div>`;

  $('#rdBack').addEventListener('click', onBack);

  /* =====================================================================
     v6.211 — SALIDAS HACIA PERSONAL: la ficha de un trabajador y el personal
     de la tienda. Las dos son la MISMA pantalla (renderWorkerPhotos); lo
     unico que cambia es si se le pide abrir una ficha puntual (openCed) o
     entrar a la grilla completa.

     El onExit vuelve a ESTE detalle, no al Historial. Es lo que uno espera
     al mirar una ficha desde un reporte: volver al reporte. Y como el
     Historial ahora conserva sus filtros, el camino completo -listado
     filtrado, detalle, ficha, y toda la vuelta- no pierde nada.

     NON_STORE_TYPES esta repetido en SEIS vistas del portal (ax-review,
     movements, mov-quincena, personnel-search, panel, wizard-core). No se
     unifica aca: migrar seis archivos es un cambio con su propio riesgo y
     merece su propia version. Se sigue el patron existente y queda anotado.
     ===================================================================== */
  const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);
  const modoEmpresa = NON_STORE_TYPES.has(r.company_type) ? 'enterprise' : 'store';
  const volverAlDetalle = () => showReportDetail({ reportId, user, onBack });
  const irAPersonal = (openCed) => renderWorkerPhotos(
    user, r.company_code, volverAlDetalle,
    openCed ? { mode: modoEmpresa, openCed } : { mode: modoEmpresa },
  );

  const empLink = $('#rdEmpLink');
  if (empLink) empLink.addEventListener('click', () => irAPersonal(null));

  host.querySelectorAll('[data-ficha]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      irAPersonal(b.dataset.ficha);
    });
  });

  /* La miniatura abre el visor grande, igual que en Buscar personal. Se usa
     openWorkerLightbox, la MISMA ventana de alla (con su boton de descargar):
     una foto de trabajador se mira siempre en el mismo visor, venga de donde
     venga. La URL sale de la linea y no de un data-attribute para no repetir
     una URL larga en el HTML de cada fila. */
  host.querySelectorAll('[data-avpic]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const ced = el.dataset.avpic;
      const l = (r.lines || []).find(x => String(x.id_number) === String(ced));
      if (l && l.thumb_url) openWorkerLightbox(l.thumb_url, `${l.name} · C.I. ${ced}`, `${ced}.jpg`);
    });
  });

  // Feedback breve en boton-icono sin tocar el glifo.
  const flashBtn = (b, ok) => {
    b.classList.remove('is-busy');
    b.classList.add(ok ? 'is-ok' : 'is-err');
    setTimeout(() => { b.classList.remove('is-ok', 'is-err'); b.disabled = false; }, 1200);
  };

  // --- Acciones de ticket (copiar / .txt / excel) ---
  let _txtCache = null;
  async function getTxt() {
    if (_txtCache) return _txtCache;
    const d = await fetchTicketText(user, r.id);
    if (d) _txtCache = { text: d.text, filename: d.filename };
    return _txtCache;
  }

  $('#rdCopy').addEventListener('click', async () => {
    const b = $('#rdCopy');
    b.disabled = true; b.classList.add('is-busy');
    const d = await getTxt();
    if (!d) { flashBtn(b, false); return; }
    const ok = await copyText(d.text);
    flashBtn(b, ok);
  });

  $('#rdTxt').addEventListener('click', async () => {
    const b = $('#rdTxt');
    b.disabled = true; b.classList.add('is-busy');
    const d = await getTxt();
    if (!d) { flashBtn(b, false); return; }
    downloadText(d.text, d.filename);
    flashBtn(b, true);
  });

  $('#rdXls').addEventListener('click', async () => {
    const b = $('#rdXls');
    b.disabled = true; b.classList.add('is-busy');
    const d = await fetchTicketExcel(user, r.id);
    if (!d) { flashBtn(b, false); return; }
    downloadBase64(d.base64, d.filename, d.mime);
    flashBtn(b, true);
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
      if (!d || !d.ok) {
        noticeModal({ title: 'No se pudo cambiar el estado', message: (d && d.error) || 'Error de red.', tone: 'error' });
        return;
      }
      // Recargar el detalle para reflejar estado + color + auditoria.
      showReportDetail({ reportId: r.id, user, onBack });
    });
  }

  // --- Re-sincronizar el estado con osTicket (solo admin, si hay ticket) ---
  if (canManage && $('#rdSync')) {
    $('#rdSync').addEventListener('click', async () => {
      const b = $('#rdSync');
      b.disabled = true; b.classList.add('is-busy');
      const d = await postSyncOsticket(user, { reportIds: [r.id] });
      if (!d || (!d.ok && d.failed == null)) {
        b.disabled = false; b.classList.remove('is-busy');
        noticeModal({ title: 'No se pudo sincronizar', message: (d && d.error) || 'Error de red.', tone: 'error' });
        return;
      }
      if (d.failed > 0) {
        await noticeModal({ title: 'Sincronizacion con error', message: `No se pudo sincronizar. ${(d.errors || []).join('; ')}`, tone: 'error' });
      }
      // Recargar el detalle para reflejar el nuevo osticket_sync.
      showReportDetail({ reportId: r.id, user, onBack });
    });
  }

  // --- Publicar en AX (v6.168) ---
  // Al terminar se recarga el detalle para que se vea ya con su candado.
  if (showPubBtn && $('#rdPubAx')) {
    $('#rdPubAx').addEventListener('click', async () => {
      const b = $('#rdPubAx');
      b.disabled = true;
      await openPublishAxModal({
        user,
        report: {
          id: r.id, type: r.type,
          company_code: r.company_code, company_name: r.company_name,
          workers_count: r.workers_count,
        },
        onDone: () => showReportDetail({ reportId: r.id, user, onBack }),
      });
      b.disabled = false;
    });
  }

  // --- Generar / reenviar el ticket cuando "No enviado" (opcion D) ---
  if (canResend && $('#rdResend')) {
    $('#rdResend').addEventListener('click', () => {
      openResendModal(user, {
        id: r.id, type: r.type, company_code: r.company_code, company_name: r.company_name,
      }, () => showReportDetail({ reportId: r.id, user, onBack }));
    });
  }
}
