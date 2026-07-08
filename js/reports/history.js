/* =====================================================================
   js/reports/history.js
   Historial de reportes (seccion del menu). Lista paginada con filtros,
   alcance por rol (tienda / admin / superadmin) y acceso a la pantalla
   de detalle. Reutilizable para los 5 tipos de reporte.
   ===================================================================== */

import { $ } from '../core/dom.js';
import { attachRefresh } from '../core/refresh.js';
import { showReportDetail } from './report-detail.js';
import { openResendModal } from './shared/resend-modal.js';
import {
  ATT_STATES, ATT_ORDER, attPill, syncDot, attAuditText,
  fetchTicketText, fetchTicketExcel, postSetAttention, postSyncOsticket,
  copyText, downloadText, downloadBase64, showAttHelpModal,
  confirmModal, noticeModal,
} from './shared/ticket-actions.js';

// Cache de textos de ticket ya regenerados, por report_id, para no pedir dos
// veces al backend si el usuario copia y luego descarga el mismo reporte.
const _ticketCache = {};

// URL base del Sistema de Tickets (osTicket). Se usa para el acceso directo
// desde la cabecera del Historial. Es la raiz del portal de clientes; el
// enlace por-fila al ticket puntual sigue usando ST.osticketUrl del backend.
const OSTICKET_BASE = 'https://ticketgrupocanaima.com/ostnoccsdemo/index.php';

// Envuelve fetchTicketText con cache local (copiar + descargar reusan).
async function getTicketText(user, reportId) {
  if (_ticketCache[reportId]) return _ticketCache[reportId];
  const d = await fetchTicketText(user, reportId);
  if (d) _ticketCache[reportId] = { text: d.text, filename: d.filename };
  return _ticketCache[reportId] || null;
}

const TYPES = {
  marcaje:      { label: 'Marcaje Manual', icon: '🕐' },
  ausencia:     { label: 'Período de Ausencia', icon: '📅' },
  ingreso:      { label: 'Ingreso — Alta', icon: '✅' },
  egreso:       { label: 'Egreso — Baja', icon: '🔴' },
  modificacion: { label: 'Modificación de Datos', icon: '✏️' },
};

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
function ymd(d) { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Caracas' }).format(d); }
function todayYMD() { return ymd(new Date()); }
function daysAgoYMD(n) { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); }

function otPill(r, osticketUrl, isAgent) {
  if (!r.osticket_id) return '<span class="pill pill-out">No enviado</span>';
  // El enlace directo al ticket depende de si quien mira es agente o usuario
  // de osTicket:
  //   agente  -> /scp/tickets.php?number=XXXX  (panel de staff; por numero)
  //   usuario -> /gc_ticket.php?number=XXXX     (puente propio: traduce el
  //              numero al id interno y redirige a tickets.php?id=, dejando
  //              que osTicket valide el acceso del cliente)
  // target=_blank y stopPropagation en el listener para no disparar "Ver
  // detalle".
  if (osticketUrl) {
    const num = encodeURIComponent(r.osticket_id);
    const href = isAgent
      ? `${osticketUrl}/scp/tickets.php?number=${num}`
      : `${osticketUrl}/gc_ticket.php?number=${num}`;
    return `<a class="pill pill-set ot-link" href="${href}" target="_blank" rel="noopener" data-otlink title="Abrir el ticket en osTicket">#${r.osticket_id}</a>`;
  }
  return `<span class="pill pill-set">#${r.osticket_id}</span>`;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function originPill(r) {
  // Origen: para envios de la central se muestra el ROL guardado con el
  // reporte (position). Para envios de la empresa, su TIPO (Tienda,
  // Administrativa, Importadora...) — "Empresa" a secas confunde porque en
  // el vocabulario del grupo significa lo-que-no-es-tienda.
  return r.source_kind === 'admin'
    ? `<span class="pill pill-origin-admin">${esc(r.position || 'Administrador')}</span>`
    : `<span class="pill pill-origin-company">${esc(r.company_type || 'Empresa')}</span>`;
}

// ¿viewport movil? (mismo umbral que el resto del portal: <=768px). Se
// consulta en cada pintado para decidir tabla (escritorio) vs tarjetas
// apiladas (movil).
function isMobile() {
  return window.matchMedia('(max-width:768px)').matches;
}

/* Feedback breve en un boton-icono SIN tocar su glifo: marca .is-ok o
   .is-err por ~1.2s y lo rehabilita. */
function flashBtn(b, ok) {
  b.classList.add(ok ? 'is-ok' : 'is-err');
  setTimeout(() => { b.classList.remove('is-ok', 'is-err'); b.disabled = false; }, 1200);
}

export function renderHistory(user) {
  const isCompany = user.kind === 'company';
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  const showStore = !isCompany; // admin y superadmin ven columna/filtro tienda
  // Solo admin/superadmin (NO editor_personal, NO tienda) pueden cambiar el
  // estado de atencion. Habilita la columna de seleccion + barra de acciones.
  const canManage = user.kind === 'admin' && (user.role === 'admin' || user.role === 'superadmin');

  // estado de la vista
  const ST = {
    filters: { type: 'ALL', date_from: daysAgoYMD(30), date_to: todayYMD(),
               company: 'ALL', zone: 'ALL', subzone: 'ALL', concept: 'ALL',
               q: '', attention: 'ALL', osticket: 'ALL' },
    page: 1, perPage: 20, total: 0, rows: [],
    companies: [], zones: [], subzones: [], concepts: [], // catalogo para filtros
    selected: new Set(),   // ids marcados (seleccion multiple)
    osticketUrl: '',       // base URL de osTicket (para el enlace al ticket)
    viewerIsAgent: false,  // el que mira es agente de osTicket (link /scp/) o usuario (link /)
  };

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Historial de reportes</h1>
      <p>${isCompany ? 'Tus reportes enviados a Capital Humano.' : isSuper ? 'Todos los reportes del grupo.' : 'Reportes de las tiendas dentro de tu alcance.'}</p></div>
      <div class="head-actions">
        <span id="hRefresh"></span>
        <a class="btn" id="hOsticket" href="${OSTICKET_BASE}" target="_blank" rel="noopener" title="Abrir el Sistema de Tickets (osTicket) en una pestaña nueva"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1a2 2 0 0 0 0 4v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1a2 2 0 0 0 0-4V9z"/><path d="M13 5v2M13 11v2M13 17v2"/></svg> Sistema de Tickets</a>
        ${canManage ? `<button class="btn" id="hSyncPending" title="Reenviar a osTicket el estado de los reportes pendientes o con error de sincronizacion">\u21BB Sincronizar pendientes</button>` : ''}
      </div>
    </div>

    <div class="hist-filters">
      <div class="fl"><label>Tipo</label>
        <select id="hType">
          <option value="ALL">Todos los tipos</option>
          ${Object.entries(TYPES).map(([k, t]) => `<option value="${k}">${t.icon} ${t.label}</option>`).join('')}
        </select></div>
      <div class="fl"><label>Desde</label><input type="date" id="hFrom" value="${ST.filters.date_from}"></div>
      <div class="fl"><label>Hasta</label><input type="date" id="hTo" value="${ST.filters.date_to}"></div>
      ${showStore ? `<div class="fl"><label>Zona</label><select id="hZone"><option value="ALL">Todas</option></select></div>
      <div class="fl"><label>Subzona</label><select id="hSub"><option value="ALL">Todas</option></select></div>
      <div class="fl"><label>Concepto</label><select id="hConcept"><option value="ALL">Todos</option></select></div>
      <div class="fl"><label>Tienda</label><select id="hCompany"><option value="ALL">Todas</option></select></div>` : ''}
      <div class="fl fl-search"><label>Buscar</label>
        <div class="hsearch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="hQ" placeholder="N° de reporte o responsable…"></div></div>
      ${canManage ? `<div class="fl"><label>Atención</label>
        <select id="hAtt">
          <option value="ALL">Todas</option>
          ${ATT_ORDER.map(k => `<option value="${k}">${ATT_STATES[k].label}</option>`).join('')}
        </select></div>` : ''}
    </div>

    <div class="chip-row" id="hChips">
      <span style="font-size:12px;color:var(--faint);align-self:center">Atajos:</span>
      <button class="chip on" data-chip="30d">Últimos 30 días</button>
      <button class="chip" data-chip="quincena">Quincena en curso</button>
      <button class="chip" data-chip="pending">Abiertos</button>
      <button class="chip" data-chip="unsent">Sin osTicket</button>
    </div>

    ${canManage ? `<div class="hsel-bar" id="hSelBar" style="display:none">
      <b><span id="hSelCount">0</span></b> reporte(s) seleccionado(s)
      <span style="flex:1"></span>
      <label style="font-size:12px;color:var(--muted)">Marcar como:</label>
      <select id="hSelStatus">
        ${ATT_ORDER.map(k => `<option value="${k}">${ATT_STATES[k].label}</option>`).join('')}
      </select>
      <input id="hSelComment" placeholder="Comentario (opcional)" style="flex:0 1 220px">
      <button class="btn btn-sm btn-primary" id="hSelApply">Aplicar</button>
      <button class="btn btn-sm" id="hSelSync" title="Reenviar a osTicket el estado actual de los reportes seleccionados">\u21BB Sincronizar</button>
      <button class="btn btn-sm" id="hSelClear">Limpiar</button>
    </div>` : ''}

    <div class="tablebox">
      <table><thead><tr>
        ${canManage ? '<th style="width:30px"><input type="checkbox" class="chk" id="hAll"></th>' : ''}
        <th>Tipo / N°</th>
        ${showStore ? '<th>Tienda</th>' : ''}
        <th>Fecha de envío</th>
        <th>Responsable</th>
        <th>Origen</th>
        <th style="text-align:center">Trab.</th>
        <th>Atención <span class="att-help" id="hAttHelp" title="Ver qué significa cada estado">?</span></th>
        <th>osTicket</th>
        <th style="text-align:right">Acciones</th>
      </tr></thead><tbody id="hBody"></tbody></table>
    </div>
    <div class="hist-cards" id="hCards"></div>

    <div class="hist-pager">
      <div class="hp-left">
        <span id="hInfo">—</span>
        <label class="hp-per">Por página:
          <select id="hPer"><option>20</option><option>50</option><option>100</option></select>
        </label>
      </div>
      <div class="pages" id="hPages"></div>
    </div>`;

  const ncols = (showStore ? 9 : 8) + (canManage ? 1 : 0);

  // ---- catalogo (admin/super): tiendas + zonas + subzonas + conceptos ----
  async function loadCompanies() {
    if (!showStore) return;
    const d = await fetch('/api/catalog', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user }),
    }).then(r => r.json()).catch(() => null);
    if (d && d.ok) {
      ST.companies = d.companies || [];
      ST.zones = d.zones || [];
      ST.subzones = d.subzones || [];
      ST.concepts = d.concepts || [];
      const zSel = $('#hZone');
      if (zSel) zSel.innerHTML = '<option value="ALL">Todas</option>'
        + ST.zones.map(z => `<option value="${z.id}">${z.name}</option>`).join('');
      const cSel = $('#hConcept');
      if (cSel) cSel.innerHTML = '<option value="ALL">Todos</option>'
        + ST.concepts.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
      fillSubzones();
      fillCompanies();
    }
  }

  // Subzonas dependientes de la zona elegida.
  function fillSubzones() {
    const sel = $('#hSub'); if (!sel) return;
    const zone = ST.filters.zone;
    const subs = zone === 'ALL' ? ST.subzones : ST.subzones.filter(s => s.zone_id === zone);
    sel.innerHTML = '<option value="ALL">Todas</option>'
      + subs.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  }

  // Tiendas dependientes de zona/subzona/concepto elegidos.
  function fillCompanies() {
    const sel = $('#hCompany'); if (!sel) return;
    let list = ST.companies.slice();
    if (ST.filters.zone !== 'ALL') list = list.filter(c => c.zoneId === ST.filters.zone);
    if (ST.filters.subzone !== 'ALL') list = list.filter(c => c.subzoneId === ST.filters.subzone);
    if (ST.filters.concept !== 'ALL') list = list.filter(c => c.concept === ST.filters.concept);
    sel.innerHTML = '<option value="ALL">Todas</option>'
      + list.map(c => `<option value="${c.code}">${c.code} · ${c.name || ''}</option>`).join('');
  }

  async function load() {
    $('#hBody').innerHTML = `<tr><td colspan="${ncols}" class="pnl-loading">Cargando…</td></tr>`;
    const d = await fetch('/api/reports-history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', user, filters: ST.filters, page: ST.page, per_page: ST.perPage }),
    }).then(r => r.json()).catch(() => null);

    if (!d || !d.ok) {
      $('#hBody').innerHTML = `<tr><td colspan="${ncols}" class="empty">Error: ${d ? d.error : 'de red'}.</td></tr>`;
      return;
    }
    ST.rows = d.rows; ST.total = d.total; ST.page = d.page; ST.perPage = d.per_page;
    ST.osticketUrl = d.osticket_url || '';
    ST.viewerIsAgent = !!d.viewer_is_agent;
    paintRows(); paintPager();
  }

  function paintRows() {
    // Host activo: en movil pintamos TARJETAS en #hCards; en escritorio, filas
    // en #hBody. Los listeners se enganchan sobre el host activo (wireRows).
    const mobile = isMobile();
    const tableBox = document.querySelector('.tablebox');
    const cardsBox = $('#hCards');
    if (tableBox) tableBox.style.display = mobile ? 'none' : '';
    if (cardsBox) cardsBox.style.display = mobile ? '' : 'none';
    const host = mobile ? cardsBox : $('#hBody');
    if (!host) return;
    if (!ST.rows.length) {
      host.innerHTML = mobile
        ? '<div class="hc-empty">No hay reportes con los filtros actuales.</div>'
        : `<tr><td colspan="${ncols}" class="empty">No hay reportes con los filtros actuales.</td></tr>`;
      return;
    }
    host.innerHTML = ST.rows.map(r => mobile ? mobileCard(r) : desktopRow(r)).join('');
    wireRows(host);
    syncHeaderCheckbox();
  }

  // ---- Fila de ESCRITORIO (<tr>) ----
  function desktopRow(r) {
    const t = TYPES[r.type] || { label: r.type, icon: '📄' };
      const storeTd = showStore
        ? `<td><div class="store-cell">${r.company_code}<div class="sub2">${r.company_name || ''}</div></div></td>` : '';
      const resend = !r.osticket_id
        ? `<button class="btn btn-sm btn-send" data-resend="${r.id}">Enviar a osTicket</button>` : '';
      const checkTd = canManage
        ? `<td><input type="checkbox" class="chk hrow-chk" data-pick="${r.id}" ${ST.selected.has(r.id) ? 'checked' : ''}></td>` : '';
      // Celda de atencion: el pill + (si canManage) un selector inline para
      // cambiar SOLO esa fila, + el indicador de sincronizacion con osTicket,
      // + la auditoria (quien/cuando) del ultimo cambio.
      const audit = attAuditText(r);
      const auditHtml = audit ? `<div class="att-audit">${audit}</div>` : '';
      let attTd;
      if (canManage) {
        // Boton de re-sincronizar SIEMPRE disponible cuando el reporte tiene
        // ticket (el estado pudo cambiar en osTicket por otra via). Compacto:
        // selector de estado + punto de sync + boton refrescar en UNA linea.
        const syncBtn = r.osticket_id
          ? `<button class="icon-btn att-syncbtn" data-syncone="${r.id}" title="Reenviar a osTicket el estado actual de este reporte">\u21BB</button>`
          : '';
        attTd = `<td><div class="att-cell">
          <select class="att-row-sel att-${r.attention}" data-attsel="${r.id}" title="Cambiar estado de este reporte">
            ${ATT_ORDER.map(k => `<option value="${k}" ${k === r.attention ? 'selected' : ''}>${ATT_STATES[k].label}</option>`).join('')}
          </select>${syncDot(r.osticket_sync)}${syncBtn}</div>${auditHtml}</td>`;
      } else {
        attTd = `<td>${attPill(r.attention)}${auditHtml}</td>`;
      }
      return `<tr class="main" data-open="${r.id}">
        ${checkTd}
        <td><div class="col-type"><span class="ico">${t.icon}</span>
          <div><div class="fol">N° ${r.id}</div><div class="ttl">${t.label}</div></div></div></td>
        ${storeTd}
        <td>${fmtSent(r.sent_at)}</td>
        <td>${r.responsible || '—'}<div style="font-size:11.5px;color:var(--faint)">${r.position || ''}</div></td>
        <td>${originPill(r)}</td>
        <td style="text-align:center"><b>${r.workers_count}</b></td>
        ${attTd}
        <td>${otPill(r, ST.osticketUrl, ST.viewerIsAgent)}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm" data-open="${r.id}">Ver detalle</button>
          <button class="icon-btn" data-copytxt="${r.id}" title="Copiar el texto del ticket">\u29C9</button>
          <button class="icon-btn" data-dltxt="${r.id}" title="Descargar el texto del ticket (.txt)">\u2913</button>
          <button class="icon-btn" data-dlxls="${r.id}" title="Descargar la plantilla de Excel del ticket (.xlsx)">\u{1F4C4}</button>
          ${resend}
        </td>
      </tr>`;
  }

  // ---- Tarjeta MOVIL (<div>) ----
  // Mismo contenido y MISMOS data-* que la fila (para que wireRows los
  // enganche igual). Cabecera (checkbox si gestiona + icono + N/tipo + pill
  // de atencion si NO gestiona) / datos en pares / (si gestiona) selector de
  // atencion / acciones (Ver detalle + iconos + reenviar).
  function mobileCard(r) {
    const t = TYPES[r.type] || { label: r.type, icon: '\uD83D\uDCC4' };
    const rows = [];
    if (showStore) {
      rows.push(['Tienda', `<b>${r.company_code}</b>${r.company_name ? `<div class="hc-sub">${r.company_name}</div>` : ''}`]);
    }
    rows.push(['Enviado', fmtSent(r.sent_at)]);
    rows.push(['Responsable', (r.responsible || '\u2014') + (r.position ? `<div class="hc-sub">${r.position}</div>` : '')]);
    rows.push(['Origen', originPill(r)]);
    rows.push(['Trabaj.', `<b>${r.workers_count}</b>`]);
    rows.push(['osTicket', otPill(r, ST.osticketUrl, ST.viewerIsAgent)]);
    const grid = rows.map(([k, v]) => `<span class="hc-k">${k}</span><span class="hc-v">${v}</span>`).join('');

    const headPill = canManage ? '' : attPill(r.attention);
    const checkbox = canManage
      ? `<input type="checkbox" class="chk hrow-chk hc-check" data-pick="${r.id}" ${ST.selected.has(r.id) ? 'checked' : ''} title="Seleccionar">` : '';

    let manageBlock = '';
    if (canManage) {
      const audit = attAuditText(r);
      const auditHtml = audit ? `<div class="att-audit">${audit}</div>` : '';
      const syncBtn = r.osticket_id
        ? `<button class="icon-btn att-syncbtn" data-syncone="${r.id}" title="Reenviar a osTicket el estado actual de este reporte">\u21BB</button>`
        : '';
      manageBlock = `<div class="hc-manage">
        <span class="hc-k">Atencion</span>
        <div class="hc-att">
          <select class="att-row-sel att-${r.attention}" data-attsel="${r.id}" title="Cambiar estado de este reporte">
            ${ATT_ORDER.map(k => `<option value="${k}" ${k === r.attention ? 'selected' : ''}>${ATT_STATES[k].label}</option>`).join('')}
          </select>${syncDot(r.osticket_sync)}${syncBtn}
        </div>${auditHtml}</div>`;
    }

    const resend = !r.osticket_id
      ? `<div class="hc-acts hc-acts2"><button class="btn btn-sm btn-send" data-resend="${r.id}">Enviar a osTicket</button></div>` : '';
    const acts = `<div class="hc-acts">
      <button class="btn btn-sm hc-detail" data-open="${r.id}">Ver detalle</button>
      <button class="icon-btn hc-ib" data-copytxt="${r.id}" title="Copiar el texto del ticket">\u29C9</button>
      <button class="icon-btn hc-ib" data-dltxt="${r.id}" title="Descargar el texto del ticket (.txt)">\u2913</button>
      <button class="icon-btn hc-ib" data-dlxls="${r.id}" title="Descargar la plantilla de Excel (.xlsx)">\u{1F4C4}</button>
    </div>${resend}`;

    return `<div class="hist-card" data-open="${r.id}">
      <div class="hc-top">
        ${checkbox}
        <div class="hc-ic">${t.icon}</div>
        <div class="hc-tt"><div class="hc-t1">N\u00b0 ${r.id}</div><div class="hc-t2">${t.label}</div></div>
        ${headPill}
      </div>
      <div class="hc-grid">${grid}</div>
      ${manageBlock}
      ${acts}
    </div>`;
  }

  // ---- Cableado de listeners sobre el host activo (tabla o tarjetas) ----
  // Ambos formatos usan los MISMOS data-* attributes; un solo conjunto de
  // listeners sirve para los dos. `host` es #hBody (tabla) o #hCards (movil).
  function wireRows(host) {
    host.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', e => {
      // No abrir el detalle si el clic viene de un control interno.
      if (e.target.closest('[data-copytxt],[data-dltxt],[data-dlxls],[data-resend],[data-attsel],[data-syncone],[data-pick],[data-otlink]')) return;
      // Si es el contenedor (fila/tarjeta) y el clic cayo en el boton interno
      // "Ver detalle", dejar que lo maneje el boton (evita doble apertura).
      if (el.matches('.hist-card, tr') && e.target.closest('[data-open]') !== el) return;
      e.stopPropagation();
      openDetail(parseInt(el.dataset.open, 10));
    }));
    host.querySelectorAll('[data-resend]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(b.dataset.resend, 10);
      const row = ST.rows.find(x => x.id === id) || { id };
      openResendModal(user, {
        id, type: row.type, company_code: row.company_code, company_name: row.company_name,
      }, () => load());
    }));
    // Enlace al ticket en osTicket: no debe disparar "Ver detalle".
    host.querySelectorAll('[data-otlink]').forEach(a => a.addEventListener('click', e => {
      e.stopPropagation();
    }));
    // Copiar el texto del ticket.
    host.querySelectorAll('[data-copytxt]').forEach(b => b.addEventListener('click', async e => {
      e.stopPropagation();
      const id = parseInt(b.dataset.copytxt, 10);
      b.disabled = true; b.classList.add('is-busy');
      const r = await getTicketText(user, id);
      b.classList.remove('is-busy');
      if (!r) { flashBtn(b, false); return; }
      const ok = await copyText(r.text);
      flashBtn(b, ok);
    }));
    // Descargar el texto del ticket como .txt.
    host.querySelectorAll('[data-dltxt]').forEach(b => b.addEventListener('click', async e => {
      e.stopPropagation();
      const id = parseInt(b.dataset.dltxt, 10);
      b.disabled = true; b.classList.add('is-busy');
      const r = await getTicketText(user, id);
      b.classList.remove('is-busy');
      if (!r) { flashBtn(b, false); return; }
      downloadText(r.text, r.filename);
      flashBtn(b, true);
    }));
    // Descargar la plantilla de Excel del ticket (.xlsx).
    host.querySelectorAll('[data-dlxls]').forEach(b => b.addEventListener('click', async e => {
      e.stopPropagation();
      const id = parseInt(b.dataset.dlxls, 10);
      b.disabled = true; b.classList.add('is-busy');
      const r = await fetchTicketExcel(user, id);
      b.classList.remove('is-busy');
      if (!r) { flashBtn(b, false); return; }
      downloadBase64(r.base64, r.filename, r.mime);
      flashBtn(b, true);
    }));
    // ---- Gestion de estado de atencion (solo admin/superadmin) ----
    if (canManage) {
      host.querySelectorAll('[data-pick]').forEach(c => c.addEventListener('click', e => {
        e.stopPropagation();
        const id = parseInt(c.dataset.pick, 10);
        if (c.checked) ST.selected.add(id); else ST.selected.delete(id);
        updateSelBar();
      }));
      host.querySelectorAll('[data-attsel]').forEach(s => {
        s.addEventListener('click', e => e.stopPropagation());
        s.addEventListener('change', async e => {
          e.stopPropagation();
          const id = parseInt(s.dataset.attsel, 10);
          await applyAttention([id], s.value, null, s);
        });
      });
      host.querySelectorAll('[data-syncone]').forEach(b => {
        b.addEventListener('click', async e => {
          e.stopPropagation();
          const id = parseInt(b.dataset.syncone, 10);
          await applySync({ reportIds: [id] }, b);
        });
      });
    }
  }

  // Actualiza la barra de seleccion multiple (contador + visibilidad).
  function updateSelBar() {
    if (!canManage) return;
    const bar = $('#hSelBar'); if (!bar) return;
    const n = ST.selected.size;
    bar.style.display = n ? 'flex' : 'none';
    if ($('#hSelCount')) $('#hSelCount').textContent = n;
    syncHeaderCheckbox();
  }

  // Pone el checkbox "todos" en el estado correcto segun la pagina actual.
  function syncHeaderCheckbox() {
    const all = $('#hAll'); if (!all) return;
    const idsPage = ST.rows.map(r => r.id);
    const pickedInPage = idsPage.filter(id => ST.selected.has(id)).length;
    all.checked = idsPage.length > 0 && pickedInPage === idsPage.length;
    all.indeterminate = pickedInPage > 0 && pickedInPage < idsPage.length;
  }

  // Aplica un cambio de estado a uno o varios reportes (llamada al backend).
  // anchorEl: elemento (boton/select) para feedback visual opcional.
  async function applyAttention(ids, status, comment, anchorEl) {
    if (!ids.length) return;
    if (anchorEl) anchorEl.disabled = true;
    const d = await postSetAttention(user, ids, status, comment);
    if (anchorEl) anchorEl.disabled = false;
    if (!d || !d.ok) {
      noticeModal({ title: 'No se pudo cambiar el estado', message: (d && d.error) || 'Error de red.', tone: 'error' });
      return;
    }
    // Actualizar en memoria las filas afectadas (estado + auditoria del
    // response) y limpiar seleccion, para reflejar quien/cuando sin recargar.
    const idset = new Set(ids);
    ST.rows.forEach(r => {
      if (idset.has(r.id)) {
        r.attention = status;
        r.attention_at = d.attention_at || r.attention_at;
        r.attention_by_name = d.attention_by_name || r.attention_by_name;
        r.attention_comment = (comment != null ? comment : r.attention_comment);
      }
    });
    ST.selected.clear();
    paintRows();
    updateSelBar();
  }

  // (Re)sincroniza con osTicket. opts = { reportIds:[...] } o { mode:'pending' }.
  // Tras sincronizar, recarga la pagina para reflejar el nuevo osticket_sync.
  async function applySync(opts, anchorEl) {
    if (anchorEl) { anchorEl.disabled = true; anchorEl.dataset._t = anchorEl.textContent; anchorEl.textContent = '\u2026'; }
    const d = await postSyncOsticket(user, opts);
    if (anchorEl) { anchorEl.disabled = false; if (anchorEl.dataset._t) anchorEl.textContent = anchorEl.dataset._t; }
    if (!d || !d.ok && d.failed == null) {
      noticeModal({ title: 'No se pudo sincronizar', message: (d && d.error) || 'Error de red.', tone: 'error' });
      return;
    }
    const total = d.total || 0;
    if (total === 0) {
      noticeModal({ title: 'Sincronizar con osTicket', message: d.note || 'No hay reportes con ticket para sincronizar.' });
    } else if (d.failed > 0) {
      noticeModal({ title: 'Sincronizacion parcial', message: `Sincronizados ${d.synced} de ${total}. ${d.failed} con error (revisa el indicador de cada reporte).`, tone: 'error' });
    }
    // Si se sincronizo una seleccion, limpiarla.
    if (opts && opts.reportIds) ST.selected.clear();
    // Recargar para traer el osticket_sync actualizado desde el backend.
    await load();
    updateSelBar();
  }

  function paintPager() {
    const from = ST.total === 0 ? 0 : (ST.page - 1) * ST.perPage + 1;
    const toN = Math.min(ST.page * ST.perPage, ST.total);
    $('#hInfo').textContent = `Mostrando ${from}–${toN} de ${ST.total} reportes`;
    const npages = Math.max(1, Math.ceil(ST.total / ST.perPage));
    const maxShow = 7;
    let start = Math.max(1, ST.page - 3);
    let end = Math.min(npages, start + maxShow - 1);
    start = Math.max(1, end - maxShow + 1);
    let html = `<button ${ST.page <= 1 ? 'disabled' : ''} data-pg="${ST.page - 1}">‹</button>`;
    for (let i = start; i <= end; i++) html += `<button class="${i === ST.page ? 'on' : ''}" data-pg="${i}">${i}</button>`;
    html += `<button ${ST.page >= npages ? 'disabled' : ''} data-pg="${ST.page + 1}">›</button>`;
    $('#hPages').innerHTML = html;
    $('#hPages').querySelectorAll('[data-pg]').forEach(b => b.addEventListener('click', () => {
      const p = parseInt(b.dataset.pg, 10);
      if (p < 1 || p > npages || p === ST.page) return;
      ST.page = p; load();
    }));
  }

  function openDetail(id) {
    showReportDetail({ reportId: id, user, onBack: () => renderHistory(user) });
  }

  // ---- listeners de filtros ----
  function applyFilters() {
    ST.filters.type = $('#hType').value;
    ST.filters.date_from = $('#hFrom').value;
    ST.filters.date_to = $('#hTo').value;
    if (showStore) {
      if ($('#hZone')) ST.filters.zone = $('#hZone').value;
      if ($('#hSub')) ST.filters.subzone = $('#hSub').value;
      if ($('#hConcept')) ST.filters.concept = $('#hConcept').value;
      if ($('#hCompany')) ST.filters.company = $('#hCompany').value;
    }
    ST.filters.q = $('#hQ').value;
    ST.page = 1; load();
  }
  $('#hType').addEventListener('change', applyFilters);
  $('#hFrom').addEventListener('change', applyFilters);
  $('#hTo').addEventListener('change', applyFilters);
  if (showStore) {
    // Zona cambia -> recalcula subzonas y tiendas, resetea los dependientes.
    if ($('#hZone')) $('#hZone').addEventListener('change', () => {
      ST.filters.zone = $('#hZone').value;
      ST.filters.subzone = 'ALL'; ST.filters.company = 'ALL';
      fillSubzones(); fillCompanies();
      applyFilters();
    });
    if ($('#hSub')) $('#hSub').addEventListener('change', () => {
      ST.filters.subzone = $('#hSub').value; ST.filters.company = 'ALL';
      fillCompanies(); applyFilters();
    });
    if ($('#hConcept')) $('#hConcept').addEventListener('change', () => {
      ST.filters.concept = $('#hConcept').value; ST.filters.company = 'ALL';
      fillCompanies(); applyFilters();
    });
    if ($('#hCompany')) $('#hCompany').addEventListener('change', applyFilters);
  }
  let qTimer = null;
  $('#hQ').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(applyFilters, 350); });
  $('#hPer').addEventListener('change', () => { ST.perPage = parseInt($('#hPer').value, 10) || 20; ST.page = 1; load(); });

  // Ayuda "?" de la columna Atencion: disponible para TODOS los roles (el ?
  // se muestra siempre en la cabecera, no solo a quienes pueden gestionar).
  if ($('#hAttHelp')) $('#hAttHelp').addEventListener('click', showAttHelpModal);

  // ---- gestion de estado (solo admin/superadmin) ----
  if (canManage) {
    // Filtro de atencion.
    if ($('#hAtt')) $('#hAtt').addEventListener('change', () => {
      ST.filters.attention = $('#hAtt').value;
      ST.page = 1; load();
    });
    // Checkbox "todos" (de la pagina actual).
    if ($('#hAll')) $('#hAll').addEventListener('change', e => {
      if (e.target.checked) ST.rows.forEach(r => ST.selected.add(r.id));
      else ST.rows.forEach(r => ST.selected.delete(r.id));
      paintRows(); updateSelBar();
    });
    // Barra: aplicar el estado elegido a la seleccion.
    if ($('#hSelApply')) $('#hSelApply').addEventListener('click', async () => {
      const ids = [...ST.selected];
      if (!ids.length) return;
      const status = $('#hSelStatus').value;
      const comment = $('#hSelComment') ? $('#hSelComment').value.trim() : '';
      await applyAttention(ids, status, comment, $('#hSelApply'));
      if ($('#hSelComment')) $('#hSelComment').value = '';
    });
    // Barra: limpiar seleccion.
    if ($('#hSelClear')) $('#hSelClear').addEventListener('click', () => {
      ST.selected.clear(); paintRows(); updateSelBar();
    });
    // Barra: sincronizar la seleccion con osTicket (reenvia su estado actual).
    if ($('#hSelSync')) $('#hSelSync').addEventListener('click', async () => {
      const ids = [...ST.selected];
      if (!ids.length) return;
      await applySync({ reportIds: ids }, $('#hSelSync'));
    });
    // Boton global: sincronizar con osTicket todos los pendientes/fallidos
    // del alcance (reenvia su estado actual).
    if ($('#hSyncPending')) $('#hSyncPending').addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Sincronizar pendientes con osTicket',
        message: 'Se reenviar\u00e1 a osTicket el estado de todos los reportes con sincronizaci\u00f3n pendiente o con error dentro de tu alcance. \u00bfContinuar?',
        confirmText: 'Sincronizar',
      });
      if (!ok) return;
      await applySync({ mode: 'pending' }, $('#hSyncPending'));
    });
  }

  // ---- atajos (chips) ----
  $('#hChips').querySelectorAll('[data-chip]').forEach(c => c.addEventListener('click', () => {
    $('#hChips').querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
    c.classList.add('on');
    // reset de filtros de estado; los de fecha los ajusta el atajo
    ST.filters.attention = 'ALL'; ST.filters.osticket = 'ALL';
    const k = c.dataset.chip;
    if (k === '30d') { ST.filters.date_from = daysAgoYMD(30); ST.filters.date_to = todayYMD(); }
    else if (k === 'quincena') { ST.filters.date_from = daysAgoYMD(15); ST.filters.date_to = todayYMD(); }
    else if (k === 'pending') { ST.filters.attention = 'open'; }
    else if (k === 'unsent') { ST.filters.osticket = 'unsent'; }
    // reflejar fechas en los inputs
    $('#hFrom').value = ST.filters.date_from; $('#hTo').value = ST.filters.date_to;
    ST.page = 1; load();
  }));

  // arranque
  loadCompanies();
  load();
  attachRefresh('#hRefresh', load, 'historial');
}
