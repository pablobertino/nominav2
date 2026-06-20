/* =====================================================================
   js/reports/history.js
   Historial de reportes (seccion del menu). Lista paginada con filtros,
   alcance por rol (tienda / admin / superadmin) y acceso a la pantalla
   de detalle. Reutilizable para los 5 tipos de reporte.
   ===================================================================== */

import { $ } from '../core/dom.js';
import { showReportDetail } from './report-detail.js';

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

function attPill(a) {
  return a === 'done'
    ? '<span class="pill pill-set">Atendido</span>'
    : '<span class="pill pill-pend">Pendiente</span>';
}
function otPill(r) {
  return r.osticket_id
    ? `<span class="pill pill-set">#${r.osticket_id}</span>`
    : '<span class="pill pill-out">No enviado</span>';
}

export function renderHistory(user) {
  const isCompany = user.kind === 'company';
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  const showStore = !isCompany; // admin y superadmin ven columna/filtro tienda

  // estado de la vista
  const ST = {
    filters: { type: 'ALL', date_from: daysAgoYMD(30), date_to: todayYMD(),
               company: 'ALL', zone: 'ALL', subzone: 'ALL', concept: 'ALL',
               q: '', attention: 'ALL', osticket: 'ALL' },
    page: 1, perPage: 20, total: 0, rows: [],
    companies: [], zones: [], subzones: [], concepts: [], // catalogo para filtros
  };

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Historial de reportes</h1>
      <p>${isCompany ? 'Tus reportes enviados a Capital Humano.' : isSuper ? 'Todos los reportes del grupo.' : 'Reportes de las tiendas dentro de tu alcance.'}</p></div></div>

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
    </div>

    <div class="chip-row" id="hChips">
      <span style="font-size:12px;color:var(--faint);align-self:center">Atajos:</span>
      <button class="chip on" data-chip="30d">Últimos 30 días</button>
      <button class="chip" data-chip="quincena">Quincena en curso</button>
      <button class="chip" data-chip="pending">Pendientes</button>
      <button class="chip" data-chip="unsent">Sin osTicket</button>
    </div>

    <div class="tablebox">
      <table><thead><tr>
        <th>Tipo / N°</th>
        ${showStore ? '<th>Tienda</th>' : ''}
        <th>Fecha de envío</th>
        <th>Responsable</th>
        <th style="text-align:center">Trab.</th>
        <th>Atención</th>
        <th>osTicket</th>
        <th style="text-align:right">Acciones</th>
      </tr></thead><tbody id="hBody"></tbody></table>
    </div>

    <div class="hist-pager">
      <div class="hp-left">
        <span id="hInfo">—</span>
        <label class="hp-per">Por página:
          <select id="hPer"><option>20</option><option>50</option><option>100</option></select>
        </label>
      </div>
      <div class="pages" id="hPages"></div>
    </div>`;

  const ncols = showStore ? 8 : 7;

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
    paintRows(); paintPager();
  }

  function paintRows() {
    if (!ST.rows.length) {
      $('#hBody').innerHTML = `<tr><td colspan="${ncols}" class="empty">No hay reportes con los filtros actuales.</td></tr>`;
      return;
    }
    $('#hBody').innerHTML = ST.rows.map(r => {
      const t = TYPES[r.type] || { label: r.type, icon: '📄' };
      const storeTd = showStore
        ? `<td><div class="store-cell">${r.company_code}<div class="sub2">${r.company_name || ''}</div></div></td>` : '';
      const resend = !r.osticket_id
        ? `<button class="btn btn-sm btn-send" data-resend="${r.id}">Enviar a osTicket</button>` : '';
      return `<tr class="main" data-open="${r.id}">
        <td><div class="col-type"><span class="ico">${t.icon}</span>
          <div><div class="fol">N° ${r.id}</div><div class="ttl">${t.label}</div></div></div></td>
        ${storeTd}
        <td>${fmtSent(r.sent_at)}</td>
        <td>${r.responsible || '—'}<div style="font-size:11.5px;color:var(--faint)">${r.position || ''}</div></td>
        <td style="text-align:center"><b>${r.workers_count}</b></td>
        <td>${attPill(r.attention)}</td>
        <td>${otPill(r)}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm" data-open="${r.id}">Ver detalle</button> ${resend}
        </td>
      </tr>`;
    }).join('');

    $('#hBody').querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', e => {
      e.stopPropagation();
      openDetail(parseInt(el.dataset.open, 10));
    }));
    $('#hBody').querySelectorAll('[data-resend]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      alert('El envío a osTicket aún no está habilitado. Quedará disponible cuando se active la integración.');
    }));
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

  // ---- atajos (chips) ----
  $('#hChips').querySelectorAll('[data-chip]').forEach(c => c.addEventListener('click', () => {
    $('#hChips').querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
    c.classList.add('on');
    // reset de filtros de estado; los de fecha los ajusta el atajo
    ST.filters.attention = 'ALL'; ST.filters.osticket = 'ALL';
    const k = c.dataset.chip;
    if (k === '30d') { ST.filters.date_from = daysAgoYMD(30); ST.filters.date_to = todayYMD(); }
    else if (k === 'quincena') { ST.filters.date_from = daysAgoYMD(15); ST.filters.date_to = todayYMD(); }
    else if (k === 'pending') { ST.filters.attention = 'pending'; }
    else if (k === 'unsent') { ST.filters.osticket = 'unsent'; }
    // reflejar fechas en los inputs
    $('#hFrom').value = ST.filters.date_from; $('#hTo').value = ST.filters.date_to;
    ST.page = 1; load();
  }));

  // arranque
  loadCompanies();
  load();
}
