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
import { openPublishAxModal, openPublishAxQueueModal, motivoNoPublicable, AX_ARROW } from './shared/publish-ax.js';
import {
  ATT_STATES, ATT_ORDER, attPill, axPublishedPill, syncDot, attAuditText,
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
  traslado:     { label: 'Traslado', icon: '🔁' },
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
  // Origen: para envios de la central se muestra el ROL REAL del emisor
  // (source_role, del catálogo de Roles: "Gestor de empresa", "Coordinador"…),
  // NO un genérico "Administrador". Para envios de la empresa, su TIPO
  // (Tienda, Administrativa, Importadora...) — "Empresa" a secas confunde
  // porque en el vocabulario del grupo significa lo-que-no-es-tienda.
  return r.source_kind === 'admin'
    ? `<span class="pill pill-origin-admin">${esc(r.source_role || r.position || 'Central')}</span>`
    : `<span class="pill pill-origin-company">${esc(r.company_type || 'Empresa')}</span>`;
}

/* =====================================================================
   axEstadoLine (v6.209) — el renglon "Ya en AX" debajo del estado.

   POR QUE EXISTE: medido el 13/08, 27 de los 36 reportes de egreso sin
   cerrar YA estaban cargados en AX y nadie cerro el reporte. Alguien los
   sube a mano y el portal se queda mirando el techo. Esto no cierra nada
   ni bloquea nada: solo lo dice, que es lo que faltaba.

   POR QUE UN RENGLON Y NO OTRA PILDORA: dos pildoras apiladas en la misma
   celda compiten y ninguna gana. El estado del reporte es el dato mayor;
   esto es una nota al pie suya. Por eso el color va en el texto y no en un
   fondo: se lee sin gritar mas fuerte que el estado.

   Tres formas, y ninguna opina sobre quien tiene razon:
     - todas las lineas en AX, misma fecha  -> "Ya en AX · 10/08"
     - todas en AX, otra fecha              -> ademas "el reporte dice ..."
     - algunas si y otras no                -> "1 de 2 en AX"
   El caso de fecha distinta se muestra ENTERO en el listado a proposito
   (medido: 8 casos, todos de 1 o 2 dias). Esconderlo en un tooltip seria
   ocultar justo lo unico que pide una decision humana.

   No se pinta si el reporte tiene ax_published_at: eso lo publicamos
   nosotros y la pildora con candado ya lo dice. El backend directamente no
   manda el dato en ese caso.
   ===================================================================== */
function ddmm(iso) {
  if (!iso) return '';
  const [, m, d] = String(iso).slice(0, 10).split('-');
  return (d && m) ? `${d}/${m}` : iso;
}

function axEstadoLine(r) {
  const e = r && r.ax_estado;
  if (!e || !e.en_ax) return '';
  if (e.en_ax < e.lineas) {
    return `<div class="att-ax att-ax-parc" title="Parte de las líneas de este reporte ya figuran egresadas en AX.">`
      + `${e.en_ax} de ${e.lineas} en AX</div>`;
  }
  const fecha = e.fecha_ax ? ` · ${ddmm(e.fecha_ax)}` : '';
  const cab = `<div class="att-ax att-ax-ok" title="Este egreso ya figura cargado en AX.">Ya en AX${fecha}</div>`;
  if (e.coincide) return cab;
  const dice = e.fecha_rep
    ? `<div class="att-ax-sub">el reporte dice ${ddmm(e.fecha_rep)}</div>`
    : '<div class="att-ax-sub">con otra fecha</div>';
  return cab + dice;
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

/* v6.168 — Permisos del Historial resueltos por la MATRIZ, no por el rol.
   Antes canManage estaba clavado a (role==='admin' || role==='superadmin'),
   asi que un coordinador con report.attention concedido en Roles igual no
   veia el selector de estado: la matriz decia que si y la pantalla que no.
   Mismo patron que ensureReportPerms en panel.js: una consulta a my-perms
   por sesion, cacheada en module scope.
   Ante fallo de red se es PERMISIVO en la pantalla — el endpoint valida el
   permiso igual, asi que nadie hace nada que no pueda por un error pasajero. */
const HIST_CODES = ['report.attention', 'report.publish.marcaje', 'report.publish.ausencia'];
let HIST_PERMS = null;

async function ensureHistoryPerms(user) {
  if (HIST_PERMS) return HIST_PERMS;
  const todos = (v) => { HIST_PERMS = {}; HIST_CODES.forEach(c => { HIST_PERMS[c] = v; }); return HIST_PERMS; };
  // La tienda nunca gestiona estados ni publica: no hace falta preguntar.
  if (user.kind !== 'admin') return todos(false);
  if (user.role === 'superadmin') return todos(true);
  try {
    const r = await fetch('/api/my-perms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { kind: user.kind, id: user.id || null }, codes: HIST_CODES }),
    }).then(x => x.json());
    if (!r || !r.ok) return todos(true);
    if (r.super) return todos(true);
    HIST_PERMS = {};
    HIST_CODES.forEach(c => { HIST_PERMS[c] = !!(r.perms && r.perms[c]); });
    return HIST_PERMS;
  } catch (_) { return todos(true); }
}

export async function renderHistory(user) {
  const isCompany = user.kind === 'company';
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  const showStore = !isCompany; // admin y superadmin ven columna/filtro tienda
  // Quien puede cambiar el estado de atencion (columna de seleccion + barra
  // de acciones) y quien puede publicar marcajes en AX. Los dos salen de la
  // matriz de Roles, no del nombre del rol.
  // Se pinta un "Cargando" antes de esperar los permisos para no dejar en
  // pantalla la vista anterior mientras responde my-perms (la primera vez;
  // despues sale del cache y es instantaneo).
  $('#pnlMain').innerHTML = '<div class="pnl-loading">Cargando…</div>';
  const perms = await ensureHistoryPerms(user);
  const canManage = !!perms['report.attention'];
  const canPublishAx = !!perms['report.publish.marcaje'];
  const canPublishAus = !!perms['report.publish.ausencia'];
  /* v6.181 — Un reporte se puede publicar si su tipo tiene endpoint Y el
     usuario tiene el permiso DE ESE TIPO. Publicar marcajes y publicar
     ausencias son decisiones distintas: una ausencia mal cargada mueve la
     nomina, un marcaje no. Por eso son dos permisos y no uno. */
  const puedePublicar = (r) => (r && r.type === 'ausencia') ? canPublishAus : canPublishAx;
  /* v6.176 — La columna de seleccion y la barra de acciones son de QUIEN
     TENGA ALGO QUE HACER CON VARIOS REPORTES A LA VEZ, no solo de quien
     cambia estados. Si dependieran de report.attention, un rol con permiso
     para publicar pero sin el de atencion se quedaria sin la cola y sin
     ninguna pista de por que. Dentro de la barra, cada control sigue
     pidiendo SU permiso. */
  const canSelect = canManage || canPublishAx || canPublishAus;

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

    ${canSelect ? `<div class="hsel-bar" id="hSelBar" style="display:none">
      <b><span id="hSelCount">0</span></b> reporte(s) seleccionado(s)
      <span style="flex:1"></span>
      ${canManage ? `<label style="font-size:12px;color:var(--muted)">Marcar como:</label>
      <select id="hSelStatus">
        ${ATT_ORDER.map(k => `<option value="${k}">${ATT_STATES[k].label}</option>`).join('')}
      </select>
      <input id="hSelComment" placeholder="Comentario (opcional)" style="flex:0 1 220px">
      <button class="btn btn-sm btn-primary" id="hSelApply">Aplicar</button>
      <button class="btn btn-sm" id="hSelSync" title="Reenviar a osTicket el estado actual de los reportes seleccionados">\u21BB Sincronizar</button>` : ''}
      ${(canPublishAx || canPublishAus) ? `<button class="btn btn-sm btn-ax" id="hSelPub" title="Publicar en AX los reportes seleccionados, uno detr\u00E1s de otro">${AX_ARROW} Publicar</button>` : ''}
      <button class="btn btn-sm" id="hSelClear">Limpiar</button>
    </div>` : ''}

    <div class="tablebox">
      <table><thead><tr>
        ${canSelect ? '<th style="width:30px"><input type="checkbox" class="chk" id="hAll"></th>' : ''}
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

  const ncols = (showStore ? 9 : 8) + (canSelect ? 1 : 0);

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
    // v6.209 — cuando se miro AX por ultima vez. Solo viene si en la pagina
    // hay egresos; si no, queda null y el pie no dice nada.
    // El replace es una red: si algun dia la marca llega con espacio en vez
    // de "T" (formato de Postgres, no ISO), new Date() la rechaza en Safari y
    // el pie mostraria el texto crudo.
    ST.axSyncAt = d.ax_sync_at ? String(d.ax_sync_at).replace(' ', 'T') : null;
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
    // Recalcula tambien el contador del boton Publicar: al cambiar de pagina
    // o de filtro cambian las filas visibles y con ellas cuantos son aptos.
    updateSelBar();
  }

  // ---- Fila de ESCRITORIO (<tr>) ----
  function desktopRow(r) {
    const t = TYPES[r.type] || { label: r.type, icon: '📄' };
      const storeTd = showStore
        ? `<td><div class="store-cell">${r.company_code}<div class="sub2">${r.company_name || ''}</div></div></td>` : '';
      const resend = !r.osticket_id
        ? `<button class="btn btn-sm btn-send" data-resend="${r.id}">Enviar a osTicket</button>` : '';
      // Los publicados en AX no se pueden seleccionar: no hay cambio de estado
      // posible para ellos, asi que meterlos en una accion masiva solo
      // produciria un error a medias.
      const checkTd = canSelect
        ? (r.ax_published_at
          ? `<td><span class="ax-lock" title="Publicado en AX: su estado ya no se puede cambiar.">\u{1F512}</span></td>`
          : `<td><input type="checkbox" class="chk hrow-chk" data-pick="${r.id}" ${ST.selected.has(r.id) ? 'checked' : ''}></td>`)
        : '';
      // Celda de atencion: el pill + (si canManage) un selector inline para
      // cambiar SOLO esa fila, + el indicador de sincronizacion con osTicket,
      // + la auditoria (quien/cuando) del ultimo cambio.
      const audit = attAuditText(r);
      const auditHtml = audit ? `<div class="att-audit">${audit}</div>` : '';
      // v6.209 — va DEBAJO del estado (no en columna propia): el listado ya
      // esta ancho y este dato califica al estado, no compite con el.
      const axHtml = axEstadoLine(r);
      let attTd;
      if (r.ax_published_at) {
        // v6.168 — Publicado en AX: NO va el selector. El estado ya no se
        // puede cambiar (lo impide el trigger de la base, no solo la
        // pantalla), y ofrecer un desplegable que siempre falla es peor que
        // no ofrecerlo.
        attTd = `<td>${axPublishedPill(r.ax_published_at)}${auditHtml}</td>`;
      } else if (canManage) {
        // Boton de re-sincronizar SIEMPRE disponible cuando el reporte tiene
        // ticket (el estado pudo cambiar en osTicket por otra via). Compacto:
        // selector de estado + punto de sync + boton refrescar en UNA linea.
        const syncBtn = r.osticket_id
          ? `<button class="icon-btn att-syncbtn" data-syncone="${r.id}" title="Reenviar a osTicket el estado actual de este reporte">\u21BB</button>`
          : '';
        attTd = `<td><div class="att-cell">
          <select class="att-row-sel att-${r.attention}" data-attsel="${r.id}" title="Cambiar estado de este reporte">
            ${ATT_ORDER.map(k => `<option value="${k}" ${k === r.attention ? 'selected' : ''}>${ATT_STATES[k].label}</option>`).join('')}
          </select>${syncDot(r.osticket_sync)}${syncBtn}</div>${auditHtml}${axHtml}</td>`;
      } else {
        attTd = `<td>${attPill(r.attention)}${auditHtml}${axHtml}</td>`;
      }
      return `<tr class="main" data-open="${r.id}">
        ${checkTd}
        <td><div class="col-type"><span class="ico">${t.icon}</span>
          <div><div class="fol">N° ${r.id}</div><div class="ttl">${t.label}</div></div></div></td>
        ${storeTd}
        <td>${fmtSent(r.sent_at)}</td>
        <td>${r.responsible || '—'}<div style="font-size:11.5px;color:var(--faint)">${esc(r.source_kind === 'admin' ? (r.source_role || r.position || 'Central') : (r.position || ''))}</div></td>
        <td>${originPill(r)}</td>
        <td style="text-align:center"><b>${r.workers_count}</b></td>
        ${attTd}
        <td>${otPill(r, ST.osticketUrl, ST.viewerIsAgent)}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm" data-open="${r.id}">Ver detalle</button>
          <button class="icon-btn" data-copytxt="${r.id}" title="Copiar el texto del ticket">\u29C9</button>
          <button class="icon-btn" data-dltxt="${r.id}" title="Descargar el texto del ticket (.txt)">\u2913</button>
          <button class="icon-btn" data-dlxls="${r.id}" title="Descargar la plantilla de Excel del ticket (.xlsx)">\u{1F4C4}</button>
          ${publishBtn(r)}
          ${resend}
        </td>
      </tr>`;
  }

  /* v6.168 — Boton "Publicar en AX". Solo para Marcaje Manual, solo si el rol
     tiene report.publish.marcaje, y solo si el reporte NO esta publicado.
     Los otros tipos de reporte no tienen a donde publicarse todavia: su carga
     en AX sigue siendo manual con la plantilla de Excel. */
  function publishBtn(r) {
    // Quien decide si se puede publicar es motivoNoPublicable, compartida con
    // la cola: si el boton y la cola opinaran distinto, el usuario veria un
    // reporte con boton que la cola saltea, o al reves.
    if (!puedePublicar(r) || motivoNoPublicable(r)) return '';
    // Misma flecha, mismos colores y MISMA PALABRA que el "Publicar" de
    // Sincronizacion. En el portal "Publicar" ya significa una sola cosa
    // -mandarlo a AX-, asi que aclararlo en la etiqueta sobra. El destino se
    // explica en el tooltip y en el aviso del modal, que es donde hace falta.
    const que = r.type === 'ausencia' ? 'estas ausencias' : 'estos marcajes';
    return `<button class="btn btn-sm btn-ax" data-pubax="${r.id}"
      title="Cargar ${que} en AX 2012. Si entran todas, el reporte queda cerrado para siempre."
      >${AX_ARROW} Publicar</button>`;
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
    rows.push(['Responsable', (r.responsible || '\u2014') + (() => { const sub = r.source_kind === 'admin' ? (r.source_role || r.position || 'Central') : (r.position || ''); return sub ? `<div class="hc-sub">${esc(sub)}</div>` : ''; })()]);
    rows.push(['Origen', originPill(r)]);
    rows.push(['Trabaj.', `<b>${r.workers_count}</b>`]);
    rows.push(['osTicket', otPill(r, ST.osticketUrl, ST.viewerIsAgent)]);
    const grid = rows.map(([k, v]) => `<span class="hc-k">${k}</span><span class="hc-v">${v}</span>`).join('');

    // Publicado en AX manda sobre todo lo demas: se muestra la pildora con
    // candado en la cabecera y no se pinta el selector de estado.
    const publicado = !!r.ax_published_at;
    const headPill = publicado ? axPublishedPill(r.ax_published_at) : (canManage ? '' : attPill(r.attention));
    const checkbox = canSelect && !publicado
      ? `<input type="checkbox" class="chk hrow-chk hc-check" data-pick="${r.id}" ${ST.selected.has(r.id) ? 'checked' : ''} title="Seleccionar">` : '';

    // v6.209 \u2014 el mismo renglon del escritorio. Cuelga del bloque de estado
    // cuando existe; si el que mira no gestiona no hay bloque, y entonces va
    // en una fila propia con su etiqueta, para no quedar huerfano en la
    // tarjeta.
    const axHtml = axEstadoLine(r);
    let manageBlock = '';
    if (canManage && !publicado) {
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
        </div>${auditHtml}${axHtml}</div>`;
    } else if (axHtml) {
      manageBlock = `<div class="hc-manage"><span class="hc-k">AX</span><div>${axHtml}</div></div>`;
    }

    const resend = !r.osticket_id
      ? `<div class="hc-acts hc-acts2"><button class="btn btn-sm btn-send" data-resend="${r.id}">Enviar a osTicket</button></div>` : '';
    const acts = `<div class="hc-acts">
      <button class="btn btn-sm hc-detail" data-open="${r.id}">Ver detalle</button>
      <button class="icon-btn hc-ib" data-copytxt="${r.id}" title="Copiar el texto del ticket">\u29C9</button>
      <button class="icon-btn hc-ib" data-dltxt="${r.id}" title="Descargar el texto del ticket (.txt)">\u2913</button>
      <button class="icon-btn hc-ib" data-dlxls="${r.id}" title="Descargar la plantilla de Excel (.xlsx)">\u{1F4C4}</button>
    </div>${publishBtn(r) ? `<div class="hc-acts hc-acts2">${publishBtn(r)}</div>` : ''}${resend}`;

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
      if (e.target.closest('[data-copytxt],[data-dltxt],[data-dlxls],[data-resend],[data-attsel],[data-syncone],[data-pick],[data-otlink],[data-pubax]')) return;
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
    // ---- Publicar en AX (v6.168) ----
    // El modal se encarga del aviso, de la espera y de mostrar el resultado
    // linea por linea. Aca solo se abre y, si publico algo, se recarga la
    // pagina para que el reporte aparezca ya con su candado.
    host.querySelectorAll('[data-pubax]').forEach(b => b.addEventListener('click', async e => {
      e.stopPropagation();
      const id = parseInt(b.dataset.pubax, 10);
      const row = ST.rows.find(x => x.id === id) || { id };
      await openPublishAxModal({
        user,
        report: {
          id, type: row.type,
          company_code: row.company_code, company_name: row.company_name,
          workers_count: row.workers_count,
        },
        onDone: () => load(),
      });
    }));

    // ---- Seleccion multiple: de quien pueda hacer algo en masa ----
    if (canSelect) {
      host.querySelectorAll('[data-pick]').forEach(c => c.addEventListener('click', e => {
        e.stopPropagation();
        const id = parseInt(c.dataset.pick, 10);
        if (c.checked) ST.selected.add(id); else ST.selected.delete(id);
        updateSelBar();
      }));
    }

    // ---- Gestion de estado de atencion (solo con report.attention) ----
    if (canManage) {
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
    if (!canSelect) return;
    const bar = $('#hSelBar'); if (!bar) return;
    const n = ST.selected.size;
    bar.style.display = n ? 'flex' : 'none';
    if ($('#hSelCount')) $('#hSelCount').textContent = n;
    /* v6.177 — El boton dice cuantos de los marcados se pueden publicar de
       verdad. Marcando 20 reportes de todo tipo, "Publicar (8)" evita la
       sorpresa de que el modal proponga muchos menos.
       Si no hay ninguno se deja igual habilitado a proposito: el modal
       explica el motivo de cada uno, y un boton muerto no explica nada. */
    const pb = $('#hSelPub');
    if (pb) {
      const pubN = ST.rows.filter(r => ST.selected.has(r.id) && puedePublicar(r) && !motivoNoPublicable(r)).length;
      pb.innerHTML = `${AX_ARROW} Publicar${pubN ? ` (${pubN})` : ''}`;
      pb.title = pubN
        ? `Publicar en AX ${pubN} reporte(s) de Marcaje Manual, uno detrás de otro`
        : 'Ninguno de los reportes marcados se puede publicar todavía';
    }
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
    // v6.168: algunos pueden haber quedado fuera por estar publicados en AX.
    // No es un error (los demas si cambiaron), pero hay que decirlo o el
    // usuario se queda pensando que se aplico a todos.
    if (d.locked) {
      noticeModal({
        title: 'Algunos reportes no cambiaron',
        message: `${d.locked} reporte(s) ya estan publicados en AX y su estado no se puede cambiar. `
          + `Los otros ${d.updated} si se actualizaron.`,
      });
    }
    // Actualizar en memoria las filas afectadas (estado + auditoria del
    // response) y limpiar seleccion, para reflejar quien/cuando sin recargar.
    const idset = new Set(ids);
    ST.rows.forEach(r => {
      if (idset.has(r.id) && !r.ax_published_at) {
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
    /* v6.209 — junto al conteo va CUANDO se miro AX por ultima vez. Sin eso
       el renglon "Ya en AX" aparenta ser tiempo real y no lo es: si alguien
       egresa a una persona ahora mismo, el portal se entera en la proxima
       corrida del cron de egresos. Solo aparece si la pagina trae egresos.
       innerHTML y no textContent porque lleva marca; los valores son numeros
       propios y una fecha ya formateada, nada que venga del usuario. */
    const sync = ST.axSyncAt
      ? ` <span class="hinfo-ax" title="El aviso «Ya en AX» sale de la última sincronización con el sistema, no de una consulta en vivo.">· AX al ${fmtSent(ST.axSyncAt)}</span>`
      : '';
    $('#hInfo').innerHTML = `Mostrando ${from}–${toN} de ${ST.total} reportes${sync}`;
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

  // ---- controles de la seleccion, comunes a cualquier accion en masa ----
  if (canSelect) {
    // Checkbox "todos" (de la pagina actual).
    if ($('#hAll')) $('#hAll').addEventListener('change', e => {
      if (e.target.checked) ST.rows.forEach(r => ST.selected.add(r.id));
      else ST.rows.forEach(r => ST.selected.delete(r.id));
      paintRows(); updateSelBar();
    });
    // Barra: limpiar seleccion.
    if ($('#hSelClear')) $('#hSelClear').addEventListener('click', () => {
      ST.selected.clear(); paintRows(); updateSelBar();
    });
    // Barra: publicar en AX la seleccion, encolada (v6.176).
    // La seleccion sobrevive al cambio de pagina, pero ST.rows solo tiene la
    // pagina actual: de los ids que no estan a la vista no se conoce ni el
    // tipo ni el estado, asi que no se puede decidir si son publicables. Se
    // cuentan aparte y se avisan como salteados, en vez de mandarlos a ciegas.
    if ($('#hSelPub')) $('#hSelPub').addEventListener('click', async () => {
      const ids = [...ST.selected];
      if (!ids.length) return;
      const visibles = ST.rows.filter(r => ST.selected.has(r.id));
      const faltantes = ids.length - visibles.length;
      await openPublishAxQueueModal({
        user, reports: visibles, faltantes,
        onDone: () => { ST.selected.clear(); load(); updateSelBar(); },
      });
    });
  }

  // ---- gestion de estado (solo con report.attention) ----
  if (canManage) {
    // Filtro de atencion.
    if ($('#hAtt')) $('#hAtt').addEventListener('change', () => {
      ST.filters.attention = $('#hAtt').value;
      ST.page = 1; load();
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
