/* =====================================================================
   views/panel.js — Panel principal con sidebar y secciones.
   Hito actual: Tiendas (6 filtros, default tipo=Tienda) y Catálogos
   (árbol zonas→subzonas + conceptos). Usuarios/Permisos/Sync se montan
   como secciones; por ahora Sync reusa el flujo existente.
   ===================================================================== */
import { $, mount } from '../core/dom.js';
import { getSession, clearSession } from '../core/session.js';
import { go } from '../core/router.js';
import { launchWizard } from '../reports/wizard-core.js';
import { marcajeReport } from '../reports/report-marcaje.js';
import { ausenciaReport } from '../reports/report-ausencia.js';
import { renderHistory } from '../reports/history.js';

let CATALOG = null;       // { companies, zones, subzones, concepts }
let currentView = 'tiendas';

/* ---------- iconos ---------- */
const I = {
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4"/></svg>',
  catalog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  key: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
  circle: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
  cog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>',
};

const NAV = [
  ['tiendas', I.store, 'Empresas'],
  ['catalogos', I.catalog, 'Catálogos'],
  ['usuarios', I.users, 'Usuarios'],
  ['quincenas', I.calendar, 'Quincenas'],
  ['historial', I.history, 'Historial'],
  ['equipo', I.team, 'Equipo', 'superonly'],
  ['permisos', I.shield, 'Permisos', 'superonly'],
  ['sync', I.sync, 'Sincronización', 'superonly'],
  ['config', I.cog, 'Configuración', 'superonly'],
];

/* ---------- shell ---------- */
function shell(user) {
  const isCompany = user.kind === 'company';
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  const nameLabel = isCompany ? user.companyCode : (user.name || user.username);
  const roleLabel = isCompany ? 'tienda' : user.role;
  const initials = (nameLabel || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const email = (user.email || '').trim().toLowerCase();

  // Navegación según rol: la tienda ve "Mi empresa" y su "Historial".
  const navItems = isCompany
    ? [['miempresa', I.store, 'Mi empresa'], ['historial', I.history, 'Historial']]
    : NAV.filter(n => n[3] !== 'superonly' || isSuper);

  return `
  <div class="pnl-layout">
    <aside class="pnl-side">
      <div class="pnl-brand">
        <div class="pnl-logo">${I.logo}</div>
        <div><div class="pnl-bname">Portal de Nómina</div><div class="pnl-bver">v1.47</div></div>
      </div>
      <nav class="pnl-nav" id="pnlNav">
        ${navItems.map(([id, ic, label]) =>
          `<button data-view="${id}" class="${id === currentView ? 'active' : ''}">${ic}<span>${label}</span></button>`
        ).join('')}
      </nav>
    </aside>
    <div class="pnl-content">
      <header class="pnl-topbar">
        <div class="pnl-user">
          <div class="pnl-avatar" id="pnlAvatar">${initials}</div>
          <div class="pnl-uinfo"><div class="pnl-uname">${nameLabel}</div><div class="pnl-urole">${roleLabel}</div></div>
        </div>
        <button id="logoutBtn" class="pnl-logout" title="Cerrar sesión">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
          Salir
        </button>
      </header>
      <main class="pnl-main" id="pnlMain"></main>
    </div>
  </div>`;
}

/* Carga el avatar vía Gravatar (SHA-256 del correo). Si no hay foto,
   Gravatar responde 404 (d=404) y conservamos las iniciales. */
async function loadAvatar(email) {
  if (!email) return;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
    const hash = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    const url = `https://www.gravatar.com/avatar/${hash}?s=72&d=404`;
    const img = new Image();
    img.onload = () => {
      const el = document.getElementById('pnlAvatar');
      if (el) { el.textContent = ''; el.appendChild(img); }
    };
    img.onerror = () => {}; // sin Gravatar: quedan las iniciales
    img.src = url;
    img.alt = '';
  } catch { /* navegador sin crypto.subtle: iniciales */ }
}

/* ---------- helpers de render ---------- */
/* Teléfono: en BD se guarda E.164 (+58...). Mostrar en nacional 0412-XXXXXXX */
function phoneDisplay(e164) {
  if (!e164) return null;
  let s = e164.replace(/[^\d+]/g, '');
  if (s.startsWith('+58')) s = '0' + s.slice(3);
  else if (s.startsWith('58') && s.length === 12) s = '0' + s.slice(2);
  if (/^\d{11}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4); // 0412-1234567
  return e164;
}
/* Para capturar: de E.164 a nacional sin guion (para el input) */
function phoneNational(e164) {
  if (!e164) return '';
  let s = e164.replace(/[^\d+]/g, '');
  if (s.startsWith('+58')) s = '0' + s.slice(3);
  else if (s.startsWith('58') && s.length === 12) s = '0' + s.slice(2);
  return s;
}

function statusPill(s) {
  const x = (s || '').toLowerCase();
  if (x.includes('abier')) return '<span class="pill pill-open">Abierta</span>';
  if (x.includes('cerrad') && x.includes('temp')) return '<span class="pill pill-temp">Cerrada temp.</span>';
  if (x.includes('cerrad')) return '<span class="pill pill-closed">Cerrada</span>';
  if (x.includes('proyect')) return '<span class="pill pill-proj">Proyectada</span>';
  if (x.includes('nulo')) return '<span class="pill pill-gray">Nulo</span>';
  return `<span class="pill pill-gray">${s || '—'}</span>`;
}

/* ---------- VISTA: TIENDAS ---------- */
function viewTiendas(user) {
  const types = [...new Set(CATALOG.companies.map(c => c.type).filter(Boolean))].sort();
  const statuses = [...new Set(CATALOG.companies.map(c => c.status).filter(Boolean))].sort();
  const concepts = CATALOG.concepts.map(c => c.name);

  // Estados "activos" por defecto: una tienda activa está Abierta o Cerrada temporal.
  const ACTIVE_STATES = statuses.filter(s => /abier/i.test(s) || (/cerrad/i.test(s) && /temp/i.test(s)));
  // Conjunto seleccionado (arranca en los activos; si no hubiera, todos)
  const selStatus = new Set(ACTIVE_STATES.length ? ACTIVE_STATES : statuses);

  $('#pnlMain').innerHTML = `
    <div class="pnl-head">
      <div><h1>Empresas</h1><p id="tCount"></p></div>
      <div class="export-wrap">
        <button class="btn" id="exportBtn">Exportar ▾</button>
        <div class="export-menu" id="exportMenu" hidden>
          <button data-fmt="xlsx">Excel (.xlsx)</button>
          <button data-fmt="csv">CSV (.csv)</button>
          <button data-fmt="txt">Texto (.txt)</button>
        </div>
      </div>
    </div>
    <div class="pnl-filters">
      <div class="search">${I.search}<input id="fName" type="text" placeholder="Buscar nombre o código…"></div>
      <select id="fType">${types.map(t => `<option ${t === 'Tienda' ? 'selected' : ''}>${t}</option>`).join('')}<option value="ALL">Todos los tipos</option></select>
      <div class="ms-wrap" id="fStatusWrap">
        <button type="button" class="ms-toggle" id="fStatusBtn">
          <span class="ms-label" id="fStatusLabel">Estados</span>
          ${I.chevron.replace('<svg', '<svg class="ms-caret"')}
        </button>
        <div class="ms-menu" id="fStatusMenu" hidden>
          <div class="ms-quick">
            <button type="button" data-q="active">Activas</button>
            <button type="button" data-q="all">Todos</button>
            <button type="button" data-q="none">Ninguno</button>
          </div>
          <div class="ms-sep"></div>
          ${statuses.map(s => `<label class="ms-opt"><input type="checkbox" value="${s}" ${selStatus.has(s) ? 'checked' : ''}><span>${s}</span><span class="ms-count">${CATALOG.companies.filter(c => c.status === s).length}</span></label>`).join('')}
        </div>
      </div>
      <select id="fZone"><option value="ALL">Todas las zonas</option>${CATALOG.zones.map(z => `<option value="${z.id}">${z.name}</option>`).join('')}</select>
      <select id="fSub"><option value="ALL">Todas las subzonas</option></select>
      <select id="fConcept"><option value="ALL">Todos los conceptos</option>${concepts.map(c => `<option>${c}</option>`).join('')}</select>
    </div>
    <div class="tablebox">
      <table><thead><tr>
        <th>Código</th><th>Razón social</th><th>Zona / Subzona</th><th>Concepto</th><th>Contacto</th><th>Estado</th><th>Acceso</th><th style="text-align:right">Reportar</th>
      </tr></thead><tbody id="tBody"></tbody></table>
    </div>
    <div class="legend">
      <span class="ico-ok">${I.check} con acceso</span>
      <span class="ico-no">${I.circle} sin usuario</span>
    </div>`;

  const fName = $('#fName'), fType = $('#fType'),
        fZone = $('#fZone'), fSub = $('#fSub'), fConcept = $('#fConcept');

  let visibleRows = []; // filas actualmente filtradas (para exportar)

  // ----- Multi-select de estados -----
  const msWrap = $('#fStatusWrap'), msBtn = $('#fStatusBtn'), msMenu = $('#fStatusMenu'), msLabel = $('#fStatusLabel');
  function updateStatusLabel() {
    const n = selStatus.size;
    if (n === 0) msLabel.textContent = 'Sin estados';
    else if (n === statuses.length) msLabel.textContent = 'Todos los estados';
    else if (ACTIVE_STATES.length && n === ACTIVE_STATES.length && ACTIVE_STATES.every(s => selStatus.has(s)))
      msLabel.textContent = 'Activas';
    else if (n === 1) msLabel.textContent = [...selStatus][0];
    else msLabel.textContent = `${n} estados`;
  }
  msBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = msMenu.hidden;
    msMenu.hidden = !open;
    msWrap.classList.toggle('open', open);
  });
  msMenu.addEventListener('click', (e) => e.stopPropagation());
  msMenu.querySelectorAll('input[type=checkbox]').forEach(cb =>
    cb.addEventListener('change', () => {
      if (cb.checked) selStatus.add(cb.value); else selStatus.delete(cb.value);
      updateStatusLabel(); render();
    }));
  msMenu.querySelectorAll('.ms-quick button').forEach(b =>
    b.addEventListener('click', () => {
      selStatus.clear();
      if (b.dataset.q === 'all') statuses.forEach(s => selStatus.add(s));
      else if (b.dataset.q === 'active') ACTIVE_STATES.forEach(s => selStatus.add(s));
      // 'none' deja el set vacío
      msMenu.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = selStatus.has(cb.value); });
      updateStatusLabel(); render();
    }));

  function fillSubs() {
    fSub.innerHTML = '<option value="ALL">Todas las subzonas</option>';
    if (fZone.value !== 'ALL') {
      CATALOG.subzones.filter(s => s.zone_id === fZone.value)
        .forEach(s => fSub.innerHTML += `<option value="${s.id}">${s.name}</option>`);
    }
  }

  function render() {
    const n = fName.value.toLowerCase();
    const rows = CATALOG.companies.filter(c => {
      return (`${c.code} ${c.name || ''}`.toLowerCase().includes(n))
        && (fType.value === 'ALL' || c.type === fType.value)
        && (selStatus.size === 0 || selStatus.has(c.status))
        && (fZone.value === 'ALL' || c.zoneId === fZone.value)
        && (fSub.value === 'ALL' || c.subzoneId === fSub.value)
        && (fConcept.value === 'ALL' || c.concept === fConcept.value);
    });
    $('#tCount').textContent = `${rows.length} de ${CATALOG.companies.length} entidades`;
    visibleRows = rows;
    $('#tBody').innerHTML = rows.map(c => {
      const tel = phoneDisplay(c.phone);
      const tel2 = phoneDisplay(c.phone2);
      const telLine = [tel, tel2].filter(Boolean).join(' / ') || 'sin teléfono';
      const contacto = `
        <div class="contact-cell">
          <div class="contact-lines">
            <span class="${c.email ? '' : 'muted'}">${c.email || 'sin correo'}</span>
            <span class="muted" style="font-size:12px">${telLine}</span>
          </div>
          <button class="email-edit" data-code="${c.code}" data-name="${(c.name||'').replace(/"/g,'')}" data-email="${c.email||''}" data-phone="${c.phone||''}" data-phone2="${c.phone2||''}" title="Editar contacto">${I.pencil}</button>
        </div>`;
      return `
      <tr>
        <td class="code">${c.code}</td>
        <td>${c.name || '—'}</td>
        <td>${c.zone || '—'}${c.subzone ? ' · ' + c.subzone : ''}</td>
        <td>${c.concept || '—'}</td>
        <td>${contacto}</td>
        <td>${statusPill(c.status)}</td>
        <td class="${c.hasAccess ? 'ico-ok' : 'ico-no'}">${c.hasAccess ? I.check : I.circle}</td>
        <td style="text-align:right"><button class="btn btn-mini" data-report-code="${c.code}" data-report-name="${(c.name||'').replace(/"/g,'')}">Reportar</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="8" class="empty">Sin resultados.</td></tr>';

    $('#tBody').querySelectorAll('.email-edit').forEach(b =>
      b.addEventListener('click', () => contactEditModal(user, b.dataset)));
    $('#tBody').querySelectorAll('[data-report-code]').forEach(b =>
      b.addEventListener('click', () => {
        const u = { ...user, pickedCompany: b.dataset.reportCode, pickedCompanyName: b.dataset.reportName };
        openReportPicker(u, () => viewTiendas(user));
      }));
  }

  fZone.addEventListener('change', () => { fillSubs(); render(); });
  [fName, fSub, fConcept].forEach(e => e.addEventListener('input', render));
  fType.addEventListener('change', render);
  // Cerrar el menú de estados al hacer clic fuera
  document.addEventListener('click', () => {
    if (!msMenu.hidden) { msMenu.hidden = true; msWrap.classList.remove('open'); }
  });
  updateStatusLabel();
  render();

  // Exportación (menú desplegable)
  const exportBtn = $('#exportBtn'), exportMenu = $('#exportMenu');
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
  });
  document.addEventListener('click', () => { exportMenu.hidden = true; }, { once: false });
  exportMenu.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { exportMenu.hidden = true; exportTiendas(b.dataset.fmt, visibleRows); }));
}

/* ---------- Exportación de Tiendas (xlsx / csv / txt) ---------- */
function exportRows(rows) {
  // Estructura tabular común a los tres formatos
  return rows.map(c => ({
    'Código': c.code,
    'Razón social': c.name || '',
    'Zona': c.zone || '',
    'Subzona': c.subzone || '',
    'Concepto': c.concept || '',
    'Correo': c.email || '',
    'Teléfono 1 nacional': phoneDisplay(c.phone) || '',
    'Teléfono 1 internacional': c.phone || '',
    'Teléfono 2 nacional': phoneDisplay(c.phone2) || '',
    'Teléfono 2 internacional': c.phone2 || '',
    'Estado': c.status || '',
    'Tiene acceso': c.hasAccess ? 'Sí' : 'No',
  }));
}
function downloadBlob(content, filename, mime) {
  const blob = (content instanceof Blob) ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function tstamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
async function exportTiendas(fmt, rows) {
  const data = exportRows(rows);
  if (!data.length) { alert('No hay filas para exportar con los filtros actuales.'); return; }
  const headers = Object.keys(data[0]);
  const fname = `tiendas_${tstamp()}`;

  if (fmt === 'csv') {
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.join(';')].concat(data.map(r => headers.map(h => esc(r[h])).join(';')));
    // BOM para que Excel abra UTF-8 correctamente
    downloadBlob('\uFEFF' + lines.join('\r\n'), `${fname}.csv`, 'text/csv;charset=utf-8');
    return;
  }

  if (fmt === 'txt') {
    // Texto tabular alineado por columnas
    const widths = headers.map(h => Math.max(h.length, ...data.map(r => String(r[h] ?? '').length)));
    const fmtRow = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
    const lines = [fmtRow(headers), widths.map(w => '-'.repeat(w)).join('  ')]
      .concat(data.map(r => fmtRow(headers.map(h => r[h]))));
    downloadBlob(lines.join('\r\n'), `${fname}.txt`, 'text/plain;charset=utf-8');
    return;
  }

  if (fmt === 'xlsx') {
    // Cargar SheetJS dinámicamente desde CDN solo cuando se necesita
    try {
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar la librería Excel.'));
          document.head.appendChild(s);
        });
      }
      const ws = window.XLSX.utils.json_to_sheet(data, { header: headers });
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Tiendas');
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (e) {
      alert(e.message + ' Revisa tu conexión e inténtalo de nuevo.');
    }
    return;
  }
}

/* Modal para editar datos de contacto (correo + teléfono) de una compañía */
function contactEditModal(user, ds) {
  openModal(`
    <div class="modal-head"><span>Datos de contacto</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${ds.code}${ds.name ? ' · ' + ds.name : ''}</p>
    <label class="flabel">Correo</label>
    <input type="text" id="emInput" value="${ds.email || ''}" placeholder="compania@grupocanaima.com" style="margin-bottom:14px">
    <label class="flabel">Teléfono móvil 1 <span class="muted">(04XX-XXXXXXX)</span></label>
    <input type="text" id="phInput" value="${phoneNational(ds.phone)}" placeholder="04121234567" style="margin-bottom:12px">
    <label class="flabel">Teléfono móvil 2 <span class="muted">(opcional)</span></label>
    <input type="text" id="phInput2" value="${phoneNational(ds.phone2)}" placeholder="04241234567" style="margin-bottom:6px">
    <p class="muted" style="font-size:11.5px;margin:0">Deja los campos vacíos para quitarlos. Se guarda en formato internacional (+58).</p>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Guardar</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const d = await fetch('/api/company-contact', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: user.id, companyCode: ds.code,
        email: $('#emInput').value, phone: $('#phInput').value, phone2: $('#phInput2').value }),
    }).then(r => r.json());
    if (!d.ok) { alert(d.error); return; }
    closeModal();
    const c = CATALOG.companies.find(x => x.code === ds.code);
    if (c) { c.email = d.email; c.phone = d.phone; c.phone2 = d.phone2; }
    viewTiendas(user);
  });
}

/* ---------- VISTA: CATÁLOGOS ---------- */
function viewCatalogos() {
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Catálogos</h1>
      <p>${CATALOG.zones.length} zonas · ${CATALOG.subzones.length} subzonas · ${CATALOG.concepts.length} conceptos</p></div></div>
    <div class="card">
      <h3>Zonas y subzonas</h3>
      <div id="treeBox"></div>
    </div>
    <div class="card">
      <h3>Conceptos <span class="muted">(${CATALOG.concepts.length})</span></h3>
      <div class="concepts">${CATALOG.concepts.map(c => `<span class="concept-tag">${c.name}</span>`).join('')}</div>
    </div>`;

  const tree = $('#treeBox');
  CATALOG.zones.forEach(z => {
    const subs = CATALOG.subzones.filter(s => s.zone_id === z.id);
    const total = CATALOG.companies.filter(c => c.zoneId === z.id).length;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="tree-zone">
        <span class="zname">${I.chevron} ${z.name} <span class="muted">(${z.letter || ''})</span></span>
        <span class="muted">${subs.length} sub · ${total}</span>
      </div>
      <div class="tree-subs">${subs.map(s => {
        const n = CATALOG.companies.filter(c => c.subzoneId === s.id).length;
        return `<div class="tree-sub"><span>${s.name}</span><span class="muted">${n}</span></div>`;
      }).join('')}</div>`;
    const head = wrap.querySelector('.tree-zone'), body = wrap.querySelector('.tree-subs');
    head.addEventListener('click', () => { head.classList.toggle('open'); body.classList.toggle('open'); });
    tree.appendChild(wrap);
  });
}

/* ---------- helper: modal ---------- */
function openModal(html) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.id = 'modalOv';
  ov.innerHTML = `<div class="modal-box">${html}</div>`;
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
  document.body.appendChild(ov);
}
function closeModal() {
  const ex = document.getElementById('modalOv');
  if (ex) ex.remove();
}

/* ---------- bloque de contraseña reutilizable (modal) ---------- */
function pwdBlockHtml() {
  return `
    <p class="flabel" style="margin-bottom:9px">Contraseña inicial</p>
    <label class="radio-row"><input type="radio" name="pwmode" value="temp" checked>
      <span>Generar temporal<br><span class="muted" style="font-size:12px">La cambia al entrar por primera vez</span></span></label>
    <label class="radio-row"><input type="radio" name="pwmode" value="manual">
      <span>Escribir yo la clave<br><span class="muted" style="font-size:12px">Tú defines la contraseña ahora</span></span></label>
    <div id="pwManual" style="display:none;margin-top:4px">
      <input type="text" id="pwInput" placeholder="Mínimo 6 caracteres">
    </div>`;
}
function readPwd() {
  const mode = document.querySelector('input[name=pwmode]:checked').value;
  if (mode === 'temp') return { useTemp: true };
  return { useTemp: false, password: document.getElementById('pwInput').value };
}
function wirePwdBlock() {
  document.querySelectorAll('input[name=pwmode]').forEach(r =>
    r.addEventListener('change', () => {
      document.getElementById('pwManual').style.display =
        document.querySelector('input[name=pwmode]:checked').value === 'manual' ? 'block' : 'none';
    }));
}

/* ---------- VISTA: USUARIOS (con pestanas: portal + osTicket) ---------- */
let USERS_TAB = 'portal';   // 'portal' | 'osticket'
let CU_ROWS = null;

async function viewUsuarios(user) {
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Usuarios</h1><p>Accesos al portal y usuarios en osTicket</p></div></div>
    <div class="cfg-tabs">
      <button class="cfg-tab" data-utab="portal">👤 Acceso al portal</button>
      <button class="cfg-tab" data-utab="osticket">🎫 Usuarios osTicket</button>
    </div>
    <div id="usersBody"></div>`;
  $('#pnlMain').querySelectorAll('.cfg-tab').forEach(b =>
    b.addEventListener('click', () => { USERS_TAB = b.dataset.utab; usersRenderTab(user); }));
  usersRenderTab(user);
}

function usersRenderTab(user) {
  $('#pnlMain').querySelectorAll('.cfg-tab').forEach(b =>
    b.classList.toggle('on', b.dataset.utab === USERS_TAB));
  const body = $('#usersBody');
  if (USERS_TAB === 'portal') usuariosPortalTab(user, body);
  else usuariosOsticketTab(user, body);
}

/* ===== Pestana ACCESO AL PORTAL (lo que era la vista Usuarios) ===== */
async function usuariosPortalTab(user, body) {
  body.innerHTML = `<div class="pnl-loading">Cargando…</div>`;
  const res = await fetch('/api/company-users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'list', adminId: user.id }),
  });
  const d = await res.json();
  if (!d.ok) { body.innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }
  CU_ROWS = d.rows;
  const types = [...new Set(CU_ROWS.map(r => r.type).filter(Boolean))].sort();

  body.innerHTML = `
    <p id="cuCount" class="muted" style="font-size:13px;margin:0 0 14px"></p>
    <div class="pnl-filters">
      <div class="search">${I.search}<input id="cuName" placeholder="Buscar compañía o código…"></div>
      <select id="cuType"><option value="Tienda">Tipo: Tienda</option>${types.filter(t=>t!=='Tienda').map(t=>`<option>${t}</option>`).join('')}<option value="ALL">Todos los tipos</option></select>
      <select id="cuAccess"><option value="ALL">Todas</option><option value="yes">Con acceso</option><option value="no">Sin acceso</option></select>
    </div>
    <div class="tablebox"><table><thead><tr>
      <th>Código</th><th>Compañía</th><th>Tipo</th><th>Usuario / Correo</th><th>Estado</th><th style="text-align:right">Acciones</th>
    </tr></thead><tbody id="cuBody"></tbody></table></div>`;

  const fName = $('#cuName'), fType = $('#cuType'), fAccess = $('#cuAccess');
  function render() {
    const n = fName.value.toLowerCase();
    const rows = CU_ROWS.filter(r =>
      (`${r.code} ${r.name || ''}`.toLowerCase().includes(n))
      && (fType.value === 'ALL' || r.type === fType.value)
      && (fAccess.value === 'ALL' || (fAccess.value === 'yes' ? !!r.user : !r.user)));
    $('#cuCount').textContent = `${rows.length} de ${CU_ROWS.length} compañías`;
    $('#cuBody').innerHTML = rows.map(r => {
      const u = r.user;
      const userCell = u
        ? `${r.code}<br><span class="muted" style="font-size:12px">${u.email || 'sin correo'}</span>`
        : `<span class="muted" style="font-size:12px">— sin usuario —</span>`;
      const stateCell = u
        ? (u.is_active ? '<span class="pill pill-open">Activo</span>' : '<span class="pill pill-closed">Inactivo</span>')
        : '<span class="pill pill-gray">Sin acceso</span>';
      const actions = u
        ? `<button class="btn btn-mini" data-act="reset" data-code="${r.code}">${I.key} Resetear</button>
           <button class="btn btn-mini" data-act="toggle" data-code="${r.code}" data-active="${u.is_active}">${u.is_active ? 'Desactivar' : 'Activar'}</button>`
        : `<button class="btn btn-mini btn-primary" data-act="create" data-code="${r.code}" data-name="${(r.name||'').replace(/"/g,'')}" data-type="${r.type||''}" data-email="${r.companyEmail||''}">${I.plus} Crear acceso</button>`;
      return `<tr><td class="code">${r.code}</td><td>${r.name || '—'}</td>
        <td><span class="pill pill-gray">${r.type || '—'}</span></td>
        <td style="font-size:13px">${userCell}</td><td>${stateCell}</td>
        <td style="text-align:right;white-space:nowrap">${actions}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">Sin resultados.</td></tr>';

    $('#cuBody').querySelectorAll('button[data-act]').forEach(b =>
      b.addEventListener('click', () => cuAction(b.dataset, user)));
  }
  [fName].forEach(e => e.addEventListener('input', render));
  [fType, fAccess].forEach(e => e.addEventListener('change', render));
  render();
}

/* ===== Pestana USUARIOS OSTICKET (sincronizacion) =====
   Lista las tiendas con su estado en osTicket (sincronizada / pendiente /
   sin correo) y permite crear/re-sincronizar el usuario-tienda (el "From"
   de los tickets), individual o masivamente. Reusa /api/osticket-users. */
let OU_ROWS = null;
let OU_SUMMARY = null;
let OU_FILTER = 'all';   // all | synced | pending | no_email

async function usuariosOsticketTab(user, body) {
  body.innerHTML = `<div class="pnl-loading">Cargando estado de osTicket…</div>`;
  const d = await ouApi({ action: 'list', adminId: user.id });
  if (!d.ok) { body.innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }
  OU_ROWS = d.tiendas || [];
  OU_SUMMARY = d.summary || { total: 0, synced: 0, pending: 0, no_email: 0 };

  body.innerHTML = `
    <div class="sum-cards">
      <div class="sum-card ok"><div class="n">${OU_SUMMARY.synced}</div><div class="l">Sincronizadas en osTicket</div></div>
      <div class="sum-card pend"><div class="n">${OU_SUMMARY.pending}</div><div class="l">Pendientes (con correo)</div></div>
      <div class="sum-card none"><div class="n">${OU_SUMMARY.no_email}</div><div class="l">Sin correo</div></div>
      <div class="sum-card"><div class="n">${OU_SUMMARY.total}</div><div class="l">Total tiendas</div></div>
    </div>
    <div class="pnl-filters">
      <div class="search">${I.search}<input id="ouSearch" placeholder="Buscar tienda o código…"></div>
      <select id="ouFilter">
        <option value="all">Todas</option>
        <option value="synced">Sincronizadas</option>
        <option value="pending">Pendientes</option>
        <option value="no_email">Sin correo</option>
      </select>
      <button class="btn btn-primary" id="ouSyncAll">${I.sync} Sincronizar todas${OU_SUMMARY.pending ? ` (${OU_SUMMARY.pending} pendientes)` : ''}</button>
    </div>
    <div class="tablebox"><table><thead><tr>
      <th>Código</th><th>Razón social</th><th>Correo (From)</th><th>Estado osTicket</th><th>Última sinc.</th><th style="text-align:right">Acción</th>
    </tr></thead><tbody id="ouBody"></tbody></table></div>
    <p class="muted" style="font-size:12px;margin:14px 2px 0;line-height:1.6">El usuario-tienda es el <b>remitente (From)</b> de los tickets en osTicket. “Sincronizada” ya existe; “pendiente” tiene correo pero falta crearla; “sin correo” no se puede crear hasta cargarle un correo (en la pestaña Empresas). Cada envío de reporte de ausencia también sincroniza la tienda automáticamente. El número <b>#N</b> es el id del usuario en osTicket.</p>`;

  $('#ouSearch').addEventListener('input', ouRender);
  $('#ouFilter').addEventListener('change', (e) => { OU_FILTER = e.target.value; ouRender(); });
  $('#ouSyncAll').addEventListener('click', () => ouSyncAll(user));
  ouRender(user);
}

function ouStatePill(state) {
  if (state === 'synced') return '<span class="pill pill-open">Sincronizada</span>';
  if (state === 'pending') return '<span class="pill pill-temp">Pendiente</span>';
  return '<span class="pill pill-gray">Sin correo</span>';
}

/* Fecha ISO -> 'DD/MM HH:MM' hora Caracas (reusa el patron del resto). */
function ouWhen(iso) {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (isNaN(dt)) return '—';
  const car = new Date(dt.getTime() - 4 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(car.getUTCDate())}/${p(car.getUTCMonth() + 1)} ${p(car.getUTCHours())}:${p(car.getUTCMinutes())}`;
}

function ouRender(user) {
  const q = ($('#ouSearch') && $('#ouSearch').value || '').toLowerCase();
  const rows = (OU_ROWS || []).filter(t =>
    (`${t.code} ${t.name || ''}`.toLowerCase().includes(q))
    && (OU_FILTER === 'all' || t.state === OU_FILTER));
  $('#ouBody').innerHTML = rows.map(t => {
    const idTag = t.osticket_user_id ? ` <span class="muted" style="font-size:11px">#${t.osticket_user_id}</span>` : '';
    const correo = t.email
      ? t.email
      : '<span class="muted">sin correo</span>';
    let actionBtn;
    if (t.state === 'no_email') {
      actionBtn = `<button class="btn btn-mini" disabled style="opacity:.5" title="Carga un correo en Empresas">Falta correo</button>`;
    } else if (t.state === 'synced') {
      actionBtn = `<button class="btn btn-mini" data-ousync="${t.code}">Re-sincronizar</button>`;
    } else {
      actionBtn = `<button class="btn btn-mini btn-primary" data-ousync="${t.code}">Crear en osTicket</button>`;
    }
    return `<tr>
      <td class="code">${t.code}</td>
      <td>${t.name || '—'}</td>
      <td style="font-size:13px">${correo}</td>
      <td>${ouStatePill(t.state)}${idTag}</td>
      <td class="muted" style="font-size:12px">${ouWhen(t.synced_at)}</td>
      <td style="text-align:right">${actionBtn}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">Sin resultados.</td></tr>';

  $('#ouBody').querySelectorAll('[data-ousync]').forEach(b =>
    b.addEventListener('click', () => ouSyncOne(user, b.dataset.ousync, b)));
}

/* Sincroniza UNA tienda (boton de fila). */
async function ouSyncOne(user, code, btn) {
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Sincronizando…';
  const d = await ouApi({ action: 'sync', adminId: user.id, codes: [code] });
  if (!d.ok) { alert(d.error || 'No se pudo sincronizar.'); btn.disabled = false; btn.textContent = orig; return; }
  const r = (d.results && d.results[0]) || null;
  if (r && !r.ok) { alert(`${code}: ${r.error || 'error'}`); btn.disabled = false; btn.textContent = orig; return; }
  // refrescar la pestana para reflejar el nuevo estado + tarjetas
  usuariosOsticketTab(user, $('#usersBody'));
}

/* Sincroniza TODAS las pendientes con correo (boton masivo). */
async function ouSyncAll(user) {
  const pend = OU_SUMMARY ? OU_SUMMARY.pending : 0;
  if (!pend) { alert('No hay tiendas pendientes con correo para sincronizar.'); return; }
  if (!confirm(`Se crearan/actualizaran ${pend} usuario(s)-tienda en osTicket. Continuar?`)) return;
  const btn = $('#ouSyncAll'); const orig = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Sincronizando todas…';
  const d = await ouApi({ action: 'sync', adminId: user.id, all: true });
  btn.disabled = false; btn.innerHTML = orig;
  if (!d.ok) { alert(d.error || 'No se pudo sincronizar.'); return; }
  alert(`Listo: ${d.ok_count} sincronizada(s), ${d.fail_count} con error (de ${d.processed}).`);
  usuariosOsticketTab(user, $('#usersBody'));
}

async function ouApi(payload) {
  const res = await fetch('/api/osticket-users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return res.json();
}

function cuAction(ds, user) {
  if (ds.act === 'toggle') {
    cuApi({ action: 'toggle', adminId: user.id, companyCode: ds.code, isActive: !(ds.active === 'true') })
      .then(() => viewUsuarios(user));
    return;
  }
  const isCreate = ds.act === 'create';
  openModal(`
    <div class="modal-head"><span>${isCreate ? 'Crear acceso' : 'Resetear contraseña'}</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${ds.code}${ds.name ? ' · ' + ds.name : ''}${ds.type ? ' · ' + ds.type : ''}</p>
    ${isCreate ? `
      <label class="flabel">Usuario</label>
      <input type="text" id="cuUser" value="${ds.code}" style="margin-bottom:12px">
      <label class="flabel">Correo <span class="muted">(heredado de la compañía, editable)</span></label>
      <input type="text" id="cuEmail" value="${ds.email || ''}" placeholder="compañia@grupocanaima.com" style="margin-bottom:14px">` : ''}
    ${pwdBlockHtml()}
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">${isCreate ? 'Crear acceso' : 'Resetear'}</button>
    </div>`);
  wirePwdBlock();
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const pw = readPwd();
    const payload = { adminId: user.id, companyCode: ds.code, ...pw,
      action: isCreate ? 'create' : 'reset',
      email: isCreate ? ($('#cuEmail').value || null) : undefined };
    const d = await cuApi(payload);
    if (!d.ok) { alert(d.error); return; }
    closeModal();
    if (d.tempPassword) alert('Contraseña temporal: ' + d.tempPassword + '\n(Cópiala y entrégala a la tienda.)');
    viewUsuarios(user);
  });
}
async function cuApi(payload) {
  const res = await fetch('/api/company-users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return res.json();
}

/* ---------- VISTA: EQUIPO (admins) ---------- */
async function viewEquipo(user) {
  $('#pnlMain').innerHTML = `<div class="pnl-head"><div><h1>Equipo</h1><p>Administradores del portal</p></div></div><div class="pnl-loading">Cargando…</div>`;
  const d = await auApi({ action: 'list', adminId: user.id });
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }
  const rows = d.rows;
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Equipo</h1><p>${rows.length} miembros</p></div>
      <button class="btn btn-primary" id="auNew">${I.plus} Nuevo miembro</button></div>
    <div class="tablebox"><table><thead><tr>
      <th>Usuario</th><th>Nombre</th><th>Correo</th><th>Rol</th><th>Estado</th><th style="text-align:right">Acciones</th>
    </tr></thead><tbody>
      ${rows.map(a => `<tr>
        <td class="code">${a.username}</td><td>${a.name || '—'}</td><td style="font-size:12px" class="muted">${a.email || '—'}</td>
        <td><span class="pill ${a.role === 'superadmin' ? 'pill-proj' : 'pill-gray'}">${a.role}</span></td>
        <td>${a.is_active ? '<span class="pill pill-open">Activo</span>' : '<span class="pill pill-closed">Inactivo</span>'}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-mini" data-act="reset" data-id="${a.id}" data-u="${a.username}">${I.key} Resetear</button>
          <button class="btn btn-mini" data-act="toggle" data-id="${a.id}" data-active="${a.is_active}">${a.is_active ? 'Desactivar' : 'Activar'}</button>
        </td></tr>`).join('')}
    </tbody></table></div>`;
  $('#auNew').addEventListener('click', () => auCreateModal(user));
  $('#pnlMain').querySelectorAll('button[data-act]').forEach(b =>
    b.addEventListener('click', () => auAction(b.dataset, user)));
}
function auCreateModal(user) {
  openModal(`
    <div class="modal-head"><span>Nuevo miembro</span><button class="modal-x" id="mX">✕</button></div>
    <label class="flabel">Usuario</label><input id="auU" placeholder="ej. yanmira.salazar" style="margin-bottom:12px">
    <label class="flabel">Nombre</label><input id="auN" placeholder="Nombre completo" style="margin-bottom:12px">
    <label class="flabel">Correo <span class="muted">(opcional)</span></label><input id="auE" placeholder="correo@grupocanaima.com" style="margin-bottom:12px">
    <label class="flabel">Rol</label>
    <select id="auR" style="margin-bottom:14px;width:100%"><option value="admin">admin</option><option value="superadmin">superadmin</option></select>
    ${pwdBlockHtml()}
    <div class="modal-actions"><button class="btn" id="mCancel">Cancelar</button><button class="btn btn-primary" id="mOk">Crear</button></div>`);
  wirePwdBlock();
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const pw = readPwd();
    const d = await auApi({ action: 'create', adminId: user.id,
      username: $('#auU').value, name: $('#auN').value, email: $('#auE').value || null,
      role: $('#auR').value, ...pw });
    if (!d.ok) { alert(d.error); return; }
    closeModal();
    if (d.tempPassword) alert('Contraseña temporal: ' + d.tempPassword);
    viewEquipo(user);
  });
}
function auAction(ds, user) {
  if (ds.act === 'toggle') {
    auApi({ action: 'toggle', adminId: user.id, id: ds.id, isActive: !(ds.active === 'true') }).then(() => viewEquipo(user));
    return;
  }
  openModal(`
    <div class="modal-head"><span>Resetear contraseña</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${ds.u}</p>
    ${pwdBlockHtml()}
    <div class="modal-actions"><button class="btn" id="mCancel">Cancelar</button><button class="btn btn-primary" id="mOk">Resetear</button></div>`);
  wirePwdBlock();
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const pw = readPwd();
    const d = await auApi({ action: 'reset', adminId: user.id, id: ds.id, ...pw });
    if (!d.ok) { alert(d.error); return; }
    closeModal();
    if (d.tempPassword) alert('Contraseña temporal: ' + d.tempPassword);
    viewEquipo(user);
  });
}
async function auApi(payload) {
  const res = await fetch('/api/admin-users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return res.json();
}

/* ---------- VISTA: PERMISOS (editor de alcance) ---------- */
let SCOPE = null; // estado de edición: {include:[], exclude:[], zones, subzones, companies, target}

async function viewPermisos(user) {
  $('#pnlMain').innerHTML = `<div class="pnl-head"><div><h1>Permisos</h1><p>Alcance de cada admin</p></div></div><div class="pnl-loading">Cargando…</div>`;
  const d = await auApi({ action: 'list', adminId: user.id });
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }
  const admins = d.rows.filter(a => a.role !== 'superadmin'); // superadmin ve todo
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Permisos</h1><p>Alcance de cada admin · el superadmin ve todo</p></div></div>
    ${admins.length === 0 ? '<div class="card"><p class="muted" style="margin:0">No hay admins (no superadmin) aún. Crea uno en la sección Equipo.</p></div>' : `
    <div class="tablebox"><table><thead><tr>
      <th>Usuario</th><th>Nombre</th><th>Estado</th><th style="text-align:right">Alcance</th>
    </tr></thead><tbody>
      ${admins.map(a => `<tr>
        <td class="code">${a.username}</td><td>${a.name || '—'}</td>
        <td>${a.is_active ? '<span class="pill pill-open">Activo</span>' : '<span class="pill pill-closed">Inactivo</span>'}</td>
        <td style="text-align:right"><button class="btn btn-mini btn-primary" data-id="${a.id}" data-u="${a.username}">${I.sliders} Editar alcance</button></td>
      </tr>`).join('')}
    </tbody></table></div>`}`;
  $('#pnlMain').querySelectorAll('button[data-id]').forEach(b =>
    b.addEventListener('click', () => openScopeEditor(user, b.dataset.id, b.dataset.u)));
}

async function openScopeEditor(user, targetId, targetUser) {
  $('#pnlMain').innerHTML = `<div class="pnl-loading">Cargando alcance…</div>`;
  const d = await fetch('/api/admin-scope', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get', adminId: user.id, targetId }),
  }).then(r => r.json());
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }

  SCOPE = {
    target: targetId, targetUser,
    include: d.include.map(x => ({ ...x })),
    exclude: d.exclude.map(x => ({ ...x })),
    zones: d.zones, subzones: d.subzones, companies: d.companies,
  };

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Alcance de ${targetUser}</h1>
      <p>Define qué tiendas puede gestionar. Alcance final = incluidos − excluidos.</p></div>
      <button class="btn" id="scBack">← Volver</button></div>
    <div class="card">
      <div class="sc-add">
        <select id="scLevel">
          <option value="zone">Zona</option>
          <option value="subzone">Subzona</option>
          <option value="company">Tienda</option>
        </select>
        <div class="search" style="flex:1">${I.search}<input id="scSearch" placeholder="Buscar…" autocomplete="off"></div>
      </div>
      <div id="scResults" class="sc-results"></div>
    </div>
    <div class="cards-row">
      <div class="card" style="flex:1">
        <h3 style="color:var(--success)">Incluidos (<span id="scIncN">0</span>)</h3>
        <div id="scIncList" class="sc-list"></div>
      </div>
      <div class="card" style="flex:1">
        <h3 style="color:var(--danger)">Excluidos (<span id="scExcN">0</span>)</h3>
        <div id="scExcList" class="sc-list"></div>
      </div>
    </div>
    <div class="card" id="scSummary" style="font-size:13px;color:var(--ink-soft)"></div>
    <div class="modal-actions">
      <button class="btn" id="scCancel">Cancelar</button>
      <button class="btn btn-primary" id="scSave">Guardar alcance</button>
    </div>`;

  $('#scBack').addEventListener('click', () => viewPermisos(user));
  $('#scCancel').addEventListener('click', () => viewPermisos(user));
  $('#scSave').addEventListener('click', () => saveScope(user));

  const lvl = $('#scLevel'), search = $('#scSearch');
  lvl.addEventListener('change', () => { search.value = ''; renderScResults(); });
  search.addEventListener('input', renderScResults);
  renderScopeLists();
  renderScResults();
}

// Etiqueta legible de un item de alcance
function scopeLabel(type, value) {
  if (type === 'zone') {
    const z = SCOPE.zones.find(z => String(z.id) === String(value));
    return `Zona: ${z ? z.name : value}`;
  }
  if (type === 'subzone') {
    const s = SCOPE.subzones.find(s => String(s.id) === String(value));
    return `Subzona: ${s ? s.name : value}`;
  }
  const c = SCOPE.companies.find(c => c.company_code === value);
  return `Tienda: ${value}${c ? ' · ' + c.business_name : ''}`;
}

function renderScResults() {
  const level = $('#scLevel').value;
  const q = $('#scSearch').value.toLowerCase();
  let opts = [];
  if (level === 'zone') opts = SCOPE.zones.map(z => ({ value: String(z.id), label: z.name }));
  else if (level === 'subzone') opts = SCOPE.subzones.map(s => ({ value: String(s.id), label: s.name }));
  else opts = SCOPE.companies.map(c => ({ value: c.company_code, label: `${c.company_code} · ${c.business_name}` }));
  if (q) opts = opts.filter(o => o.label.toLowerCase().includes(q));
  opts = opts.slice(0, 30);

  $('#scResults').innerHTML = opts.map(o =>
    `<div class="sc-res-row">
       <span>${o.label}</span>
       <span class="sc-res-btns">
         <button class="sc-inc" data-v="${o.value}" title="Incluir">+ incluir</button>
         <button class="sc-exc" data-v="${o.value}" title="Excluir">− excluir</button>
       </span>
     </div>`).join('') || '<div class="muted" style="padding:8px">Sin coincidencias.</div>';

  $('#scResults').querySelectorAll('.sc-inc').forEach(b =>
    b.addEventListener('click', () => addScope('include', level, b.dataset.v)));
  $('#scResults').querySelectorAll('.sc-exc').forEach(b =>
    b.addEventListener('click', () => addScope('exclude', level, b.dataset.v)));
}

function addScope(bucket, type, value) {
  const list = SCOPE[bucket];
  if (list.some(x => x.scope_type === type && String(x.scope_value) === String(value))) return; // ya está
  list.push({ scope_type: type, scope_value: String(value) });
  renderScopeLists();
}
function removeScope(bucket, type, value) {
  SCOPE[bucket] = SCOPE[bucket].filter(x => !(x.scope_type === type && String(x.scope_value) === String(value)));
  renderScopeLists();
}

function renderScopeLists() {
  const mk = (bucket) => SCOPE[bucket].map(x =>
    `<div class="sc-item"><span>${scopeLabel(x.scope_type, x.scope_value)}</span>
      <button data-b="${bucket}" data-t="${x.scope_type}" data-v="${x.scope_value}" title="Quitar">✕</button></div>`
  ).join('') || '<div class="muted" style="padding:8px">Vacío.</div>';
  $('#scIncList').innerHTML = mk('include');
  $('#scExcList').innerHTML = mk('exclude');
  $('#scIncN').textContent = SCOPE.include.length;
  $('#scExcN').textContent = SCOPE.exclude.length;
  document.querySelectorAll('.sc-item button').forEach(b =>
    b.addEventListener('click', () => removeScope(b.dataset.b, b.dataset.t, b.dataset.v)));

  // Resumen estimado de tiendas
  const est = estimateScope();
  $('#scSummary').innerHTML = `<span class="muted">Resultado estimado:</span> <strong>${est}</strong> tiendas gestionables.`;
}

// Estima cuántas tiendas quedan en el alcance (include − exclude)
function estimateScope() {
  const tiendas = SCOPE.companies; // solo tipo Tienda
  const inSet = new Set();
  SCOPE.include.forEach(x => {
    if (x.scope_type === 'zone') tiendas.filter(c => String(c.zone_id) === String(x.scope_value)).forEach(c => inSet.add(c.company_code));
    else if (x.scope_type === 'subzone') tiendas.filter(c => String(c.subzone_id) === String(x.scope_value)).forEach(c => inSet.add(c.company_code));
    else inSet.add(x.scope_value);
  });
  SCOPE.exclude.forEach(x => {
    if (x.scope_type === 'zone') tiendas.filter(c => String(c.zone_id) === String(x.scope_value)).forEach(c => inSet.delete(c.company_code));
    else if (x.scope_type === 'subzone') tiendas.filter(c => String(c.subzone_id) === String(x.scope_value)).forEach(c => inSet.delete(c.company_code));
    else inSet.delete(x.scope_value);
  });
  return inSet.size;
}

async function saveScope(user) {
  const btn = $('#scSave'); btn.disabled = true; btn.textContent = 'Guardando…';
  const d = await fetch('/api/admin-scope', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save', adminId: user.id, targetId: SCOPE.target,
      include: SCOPE.include, exclude: SCOPE.exclude }),
  }).then(r => r.json());
  if (!d.ok) { alert(d.error); btn.disabled = false; btn.textContent = 'Guardar alcance'; return; }
  viewPermisos(user);
}

/* ---------- VISTA: placeholders ---------- */
function viewSoon(title, msg) {
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>${title}</h1></div></div>
    <div class="card"><p class="muted" style="margin:0">${msg}</p></div>`;
}

/* ---------- VISTA: SYNC ---------- */
function viewSync(user) {
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Sincronización</h1><p>Catálogo AX → Supabase</p></div></div>
    <div class="card">
      ${isSuper ? `
      <div class="sync-row">
        <div class="muted" id="syncStatus">Vuelca empresas, zonas, subzonas y conceptos desde la API.</div>
        <button class="btn btn-primary" id="syncBtn">${I.sync} Sincronizar ahora</button>
      </div>` : `<p class="muted" style="margin:0">Solo el superadmin puede sincronizar.</p>`}
    </div>`;
  if (!isSuper) return;
  $('#syncBtn').addEventListener('click', async () => {
    const st = $('#syncStatus'), btn = $('#syncBtn');
    st.textContent = 'Sincronizando…'; btn.disabled = true;
    try {
      const res = await fetch('/api/sync-companies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminId: user.id }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      st.textContent = `✅ ${d.synced.companies} empresas, ${d.synced.zones} zonas, ${d.synced.subzones} subzonas, ${d.synced.concepts} conceptos.`;
      CATALOG = null; // forzar recarga al volver a Tiendas
    } catch (e) { st.textContent = '❌ ' + e.message; }
    finally { btn.disabled = false; }
  });
}

/* ---------- VISTA: QUINCENAS (payroll_periods) ---------- */
/* Superadmin: ve, genera por año y sobrescribe quincenas puntuales.
   Admin y tienda: solo lectura. */
let PERIODS_YEAR = null;
let PERIODS_HIDE_FUTURE = true; // por defecto oculta las quincenas futuras
let PERIODS_VISIBLE = [];       // filas actualmente visibles (para exportar)

async function periodsApi(payload) {
  const res = await fetch('/api/periods', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return res.json();
}

const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

/* fecha 'YYYY-MM-DD' -> Date en UTC (sin corrimiento de zona) */
function parseYMD(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
/* fecha 'YYYY-MM-DD' -> 'DD/MM' o 'DD/MM/AAAA' */
function fmtDate(iso, withYear) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return withYear ? `${d}/${m}/${y}` : `${d}/${m}`;
}
/* timestamptz ISO -> 'DD/MM HH:MM' en hora Caracas (GMT-4 fijo) */
function fmtDeadline(iso) {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (isNaN(dt)) return '—';
  const car = new Date(dt.getTime() - 4 * 3600 * 1000); // a hora local Caracas
  const p = (n) => String(n).padStart(2, '0');
  return `${p(car.getUTCDate())}/${p(car.getUTCMonth() + 1)}/${car.getUTCFullYear()} ${p(car.getUTCHours())}:${p(car.getUTCMinutes())}`;
}
/* Hoy en formato YYYY-MM-DD, hora de Caracas */
function todayCaracasYMD() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Caracas' }).format(new Date());
}
/* ¿la quincena p contiene la fecha de hoy? (en curso) */
function isCurrentPeriod(p, today) {
  return p.range_start <= today && today <= p.range_end;
}
/* relación temporal de la quincena con hoy: 'past' | 'curr' | 'fut' */
function periodRel(p, today) {
  if (p.range_end < today) return 'past';
  if (p.range_start > today) return 'fut';
  return 'curr';
}
/* días que abarca un rango, inclusivo (16/06–30/06 = 15 días) */
function rangeDays(a, b) {
  if (!a || !b) return 0;
  return Math.round((parseYMD(b) - parseYMD(a)) / 86400000) + 1;
}
/* renglón gris bajo Período/Rango: nombre del mes + cantidad de días */
function subMonth(a, b) {
  if (!a || !b) return '';
  const ma = parseYMD(a).getUTCMonth(), mb = parseYMD(b).getUTCMonth();
  const label = ma === mb ? MES[ma] : `${MES[ma].slice(0, 3)} – ${MES[mb].slice(0, 3)}`;
  return `<div class="submonth">${label} · <span class="days">${rangeDays(a, b)} días</span></div>`;
}
/* chip de cuenta regresiva (solo en la quincena en curso) */
function countdown(iso, today) {
  if (!iso) return '';
  const n = Math.round((parseYMD(iso) - parseYMD(today)) / 86400000);
  if (n < 0) return '';
  if (n === 0) return '<div class="countdown today">¡es hoy!</div>';
  const cls = n <= 2 ? 'soon' : '';
  return `<div class="countdown ${cls}">faltan ${n} ${n === 1 ? 'día' : 'días'}</div>`;
}
/* celda de fecha: número + día de la semana (ámbar si es finde) + chip opcional */
function dateCell(iso, opts = {}) {
  if (!iso) return '—';
  const i = parseYMD(iso).getUTCDay();
  const weekend = (i === 0 || i === 6);
  const chip = opts.countdown || '';
  return `<div class="date-cell ${weekend ? 'weekend' : ''}">`
    + `<div class="date-num">${fmtDate(iso, true)}</div>`
    + `<div class="date-dow">${DOW[i]}</div>${chip}</div>`;
}
/* celda de rango (Período / Rango de Pago): rango + mes·días */
function rangeCell(a, b) {
  return `<div class="date-cell"><div class="date-num">${fmtDate(a, true)} – ${fmtDate(b, true)}</div>${subMonth(a, b)}</div>`;
}
/* etiqueta de estado temporal (+ distintivo Modificada) */
function periodEstado(p, rel) {
  const base = rel === 'curr' ? '<span class="pill pill-curr">En curso</span>'
             : rel === 'fut'  ? '<span class="pill pill-fut">Futuro</span>'
             :                  '<span class="pill pill-past">Pasado</span>';
  const mod = p.is_overridden
    ? ` <span class="pill pill-mod" title="${(p.override_note || '').replace(/"/g, '&quot;')}">Modificada</span>` : '';
  return `<div class="estado-wrap">${base}${mod}</div>`;
}

async function viewPeriods(user) {
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  $('#pnlMain').innerHTML = `<div class="pnl-head"><div><h1>Quincenas</h1><p>Calendario de nómina</p></div></div><div class="pnl-loading">Cargando…</div>`;

  // años disponibles: los que ya existen; el botón genera SOLO el próximo año
  const yd = await periodsApi({ action: 'years' });
  const existing = (yd.ok && yd.years.length) ? yd.years.slice() : [];
  const thisYear = new Date().getFullYear();
  const nextYear = thisYear + 1;
  const years = [...new Set([...existing, thisYear])].sort();
  if (!PERIODS_YEAR || !years.includes(PERIODS_YEAR)) {
    PERIODS_YEAR = existing.includes(thisYear) ? thisYear : (existing.length ? existing[existing.length - 1] : thisYear);
  }
  // ¿ya existe el próximo año? entonces no hace falta el botón de generar
  const nextExists = existing.includes(nextYear);

  const genBtn = isSuper && !nextExists
    ? `<button class="btn btn-primary" id="pGen">${I.plus} Generar ${nextYear}</button>` : '';

  $('#pnlMain').innerHTML = `
    <div class="pnl-head">
      <div><h1>Quincenas</h1><p id="pInfo">Calendario de nómina</p></div>
      <div class="pnl-filters" style="margin:0">
        <label class="pchk"><input type="checkbox" id="pHideFut" ${PERIODS_HIDE_FUTURE ? 'checked' : ''}> Ocultar futuras</label>
        <select id="pYear">${years.map(y => `<option ${y === PERIODS_YEAR ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <div class="export-wrap">
          <button class="btn" id="pExportBtn">Exportar ▾</button>
          <div class="export-menu" id="pExportMenu" hidden>
            <button data-fmt="xlsx">Excel (.xlsx)</button>
            <button data-fmt="csv">CSV (.csv)</button>
            <button data-fmt="txt">Texto (.txt)</button>
          </div>
        </div>
        ${genBtn}
      </div>
    </div>
    <div class="tablebox scroll-x"><table><thead><tr>
      <th>Quincena</th><th>Período</th>
      <th class="grp grp-first">Código Pago</th><th class="grp grp-last">Rango de Pago</th>
      <th>Último día de cálculo</th><th>Día de Cálculo</th><th>Día de Pago</th>
      <th>Tope de reporte</th><th>Estado</th>${isSuper ? '<th style="text-align:right">Acciones</th>' : ''}
    </tr></thead><tbody id="pBody"></tbody></table></div>
    <p class="muted" style="font-size:12px;margin:14px 2px 0;line-height:1.6">El “último día de cálculo” es la última fecha que entra en el cálculo de la quincena (un día antes del día de cálculo): última oportunidad para cargar novedades, ese día hasta la hora tope. Las dos columnas con fondo azul son el <strong>período de pago</strong>; su rango termina justo en el último día de cálculo. Sábados y domingos se resaltan en ámbar. El estado es temporal (Pasado / En curso / Futuro) y, si la quincena fue ajustada a mano, lleva además el distintivo <span class="pill pill-mod" style="font-size:10px">Modificada</span>. ${isSuper ? 'Como superadmin puedes ajustar una quincena puntual; el resto solo la consulta.' : 'Esta vista es de solo lectura.'}</p>`;

  const NCOLS = isSuper ? 10 : 9;

  async function load() {
    $('#pBody').innerHTML = `<tr><td colspan="${NCOLS}" class="pnl-loading">Cargando…</td></tr>`;
    const d = await periodsApi({ action: 'list', year: PERIODS_YEAR });
    if (!d.ok) { $('#pBody').innerHTML = `<tr><td colspan="${NCOLS}" class="empty">Error: ${d.error}</td></tr>`; return; }
    if (!d.periods.length) {
      $('#pBody').innerHTML = `<tr><td colspan="${NCOLS}" class="empty">Este año aún no tiene quincenas generadas.</td></tr>`;
      $('#pInfo').textContent = `${PERIODS_YEAR} · sin generar`;
      PERIODS_VISIBLE = [];
      return;
    }

    const today = todayCaracasYMD();
    // Orden: más reciente primero (period_no descendente)
    let rows = d.periods.slice().sort((a, b) => b.period_no - a.period_no);
    const totalFuturas = rows.filter(p => p.range_start > today).length;
    if (PERIODS_HIDE_FUTURE) rows = rows.filter(p => p.range_start <= today);
    PERIODS_VISIBLE = rows; // para exportar exactamente lo que se ve

    $('#pInfo').textContent = `${PERIODS_YEAR} · ${rows.length} de ${d.periods.length} quincenas`
      + (PERIODS_HIDE_FUTURE && totalFuturas ? ` · ${totalFuturas} futuras ocultas` : '');

    if (!rows.length) {
      $('#pBody').innerHTML = `<tr><td colspan="${NCOLS}" class="empty">No hay quincenas para mostrar con el filtro actual.</td></tr>`;
      return;
    }

    $('#pBody').innerHTML = rows.map(p => {
      const rel = periodRel(p, today);
      const isCurr = rel === 'curr';
      const acc = isSuper
        ? `<td style="text-align:right;white-space:nowrap">
             <button class="btn btn-mini" data-act="edit" data-id="${p.id}">${I.sliders} Ajustar</button>
             ${p.is_overridden ? `<button class="btn btn-mini" data-act="reset" data-id="${p.id}" data-name="${p.name}">Restablecer</button>` : ''}
           </td>` : '';
      return `<tr class="${isCurr ? 'row-current' : ''}">
        <td class="code">${p.name}</td>
        <td>${rangeCell(p.range_start, p.range_end)}</td>
        <td class="grp grp-first"><span class="pp-code">${p.pay_code || '—'}</span></td>
        <td class="grp grp-last">${rangeCell(p.pay_from, p.pay_to)}</td>
        <td class="hito-cell">${dateCell(p.milestone_date)}</td>
        <td>${dateCell(p.cutoff_date, { countdown: isCurr ? countdown(p.cutoff_date, today) : '' })}</td>
        <td>${dateCell(p.pay_date, { countdown: isCurr ? countdown(p.pay_date, today) : '' })}</td>
        <td>${fmtDeadline(p.report_deadline)}</td>
        <td>${periodEstado(p, rel)}</td>
        ${acc}
      </tr>`;
    }).join('');
    if (isSuper) {
      $('#pBody').querySelectorAll('button[data-act]').forEach(b =>
        b.addEventListener('click', () => {
          if (b.dataset.act === 'edit') {
            const p = d.periods.find(x => String(x.id) === b.dataset.id);
            periodEditModal(user, p, load);
          } else {
            if (!confirm(`¿Restablecer ${b.dataset.name} al valor calculado por la regla? Se perderá el ajuste manual.`)) return;
            periodsApi({ action: 'reset', adminId: user.id, id: b.dataset.id }).then(r => {
              if (!r.ok) { alert(r.error); return; } load();
            });
          }
        }));
    }
  }

  $('#pYear').addEventListener('change', (e) => {
    PERIODS_YEAR = parseInt(e.target.value, 10);
    load();
  });
  $('#pHideFut').addEventListener('change', (e) => { PERIODS_HIDE_FUTURE = e.target.checked; load(); });
  // Exportación de la grilla de quincenas
  const pExpBtn = $('#pExportBtn'), pExpMenu = $('#pExportMenu');
  pExpBtn.addEventListener('click', (e) => { e.stopPropagation(); pExpMenu.hidden = !pExpMenu.hidden; });
  document.addEventListener('click', () => { pExpMenu.hidden = true; });
  pExpMenu.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { pExpMenu.hidden = true; exportPeriods(b.dataset.fmt); }));
  if (isSuper && !nextExists) {
    $('#pGen').addEventListener('click', async () => {
      const b = $('#pGen'); const orig = b.innerHTML;
      if (!confirm(`¿Generar las 24 quincenas de ${nextYear}? Esto no modifica años ya existentes.`)) return;
      b.disabled = true; b.textContent = 'Generando…';
      const r = await periodsApi({ action: 'generate', adminId: user.id, year: nextYear });
      b.disabled = false; b.innerHTML = orig;
      if (!r.ok) { alert(r.error); return; }
      PERIODS_YEAR = nextYear;
      viewPeriods(user); // recarga la vista (selector incluye el nuevo año)
    });
  }
  load();
}

/* Exportación de la grilla de Quincenas (xlsx / csv / txt) */
async function exportPeriods(fmt) {
  const today = todayCaracasYMD();
  const relLabel = { past: 'Pasado', curr: 'En curso', fut: 'Futuro' };
  const data = (PERIODS_VISIBLE || []).map(p => {
    const rel = periodRel(p, today);
    return {
      'Quincena': p.name,
      'Periodo desde': fmtDate(p.range_start, true),
      'Periodo hasta': fmtDate(p.range_end, true),
      'Dias del periodo': rangeDays(p.range_start, p.range_end),
      'Codigo Pago': p.pay_code || '',
      'Rango de Pago desde': fmtDate(p.pay_from, true),
      'Rango de Pago hasta': fmtDate(p.pay_to, true),
      'Dias del rango de pago': rangeDays(p.pay_from, p.pay_to),
      'Ultimo dia de calculo': fmtDate(p.milestone_date, true),
      'Dia de Calculo': fmtDate(p.cutoff_date, true),
      'Dia de Pago': fmtDate(p.pay_date, true),
      'Tope de reporte': fmtDeadline(p.report_deadline),
      'Estado': relLabel[rel] + (p.is_overridden ? ' (Modificada)' : ''),
      'Motivo del ajuste': p.override_note || '',
    };
  });
  if (!data.length) { alert('No hay quincenas para exportar con el filtro actual.'); return; }
  const headers = Object.keys(data[0]);
  const fname = `quincenas_${PERIODS_YEAR}_${tstamp()}`;

  if (fmt === 'csv') {
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.join(';')].concat(data.map(r => headers.map(h => esc(r[h])).join(';')));
    downloadBlob('\uFEFF' + lines.join('\r\n'), `${fname}.csv`, 'text/csv;charset=utf-8');
    return;
  }

  if (fmt === 'txt') {
    const widths = headers.map(h => Math.max(h.length, ...data.map(r => String(r[h] ?? '').length)));
    const fmtRow = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
    const lines = [fmtRow(headers), widths.map(w => '-'.repeat(w)).join('  ')]
      .concat(data.map(r => fmtRow(headers.map(h => r[h]))));
    downloadBlob(lines.join('\r\n'), `${fname}.txt`, 'text/plain;charset=utf-8');
    return;
  }

  if (fmt === 'xlsx') {
    try {
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar la librería Excel.'));
          document.head.appendChild(s);
        });
      }
      const ws = window.XLSX.utils.json_to_sheet(data, { header: headers });
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Quincenas');
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (e) {
      alert(e.message + ' Revisa tu conexión e inténtalo de nuevo.');
    }
    return;
  }
}

/* Modal de override de una quincena (solo superadmin) */
function periodEditModal(user, p, onSaved) {
  openModal(`
    <div class="modal-head"><span>Ajustar quincena</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${p.name}</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="flabel">Desde</label><input type="date" id="pe_rs" value="${p.range_start}"></div>
      <div><label class="flabel">Hasta</label><input type="date" id="pe_re" value="${p.range_end}"></div>
      <div><label class="flabel">Día de Cálculo</label><input type="date" id="pe_co" value="${p.cutoff_date}"></div>
      <div><label class="flabel">Día de Pago</label><input type="date" id="pe_pay" value="${p.pay_date}"></div>
      <div><label class="flabel">Margen (días)</label><input type="text" id="pe_mg" value="${p.report_margin_days}" placeholder="2"></div>
      <div><label class="flabel">Hora tope</label><input type="text" id="pe_ht" value="${(p.report_limit_time||'').slice(0,5)}" placeholder="14:00"></div>
    </div>
    <label class="flabel" style="margin-top:12px">Motivo del ajuste <span class="muted">(opcional)</span></label>
    <input type="text" id="pe_note" value="${(p.override_note||'').replace(/"/g,'&quot;')}" placeholder="ej. corrida por feriado" style="margin-bottom:6px">
    <p class="muted" style="font-size:11.5px;margin:0">El último día de cálculo y el tope de reporte se recalculan solos a partir del día de cálculo, el margen y la hora.</p>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Guardar ajuste</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const d = await periodsApi({
      action: 'override', adminId: user.id, id: p.id,
      range_start: $('#pe_rs').value, range_end: $('#pe_re').value,
      cutoff_date: $('#pe_co').value, pay_date: $('#pe_pay').value,
      report_margin_days: $('#pe_mg').value, report_limit_time: $('#pe_ht').value,
      override_note: $('#pe_note').value,
    });
    if (!d.ok) { alert(d.error); return; }
    closeModal();
    onSaved();
  });
}

/* ---------- VISTA: CONFIGURACIÓN (solo superadmin) ----------
   4 pestanas (mockup 09): Tipos de ausencia | Causas de marcaje |
   Corte y periodos | Integraciones. Guardado POR SECCION.
   Settings (corte + integraciones) -> /api/settings.
   Catalogos (ausencia + causas)    -> /api/config-catalogs. */
let CFG_DATA = null; // { settings:[], types:[], causas:[] }
let CFG_TAB = 'aus';

async function cfgSettings(payload) {
  return fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload) }).then(r => r.json());
}
async function cfgCatalogs(payload) {
  return fetch('/api/config-catalogs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload) }).then(r => r.json());
}

async function viewConfig(user) {
  $('#pnlMain').innerHTML = `<div class="pnl-head"><div><h1>Configuración</h1><p>Parámetros, catálogos e integraciones</p></div></div><div class="pnl-loading">Cargando…</div>`;
  const [st, ty, ca] = await Promise.all([
    cfgSettings({ action: 'list', adminId: user.id }),
    cfgCatalogs({ action: 'absence_list', adminId: user.id }),
    cfgCatalogs({ action: 'causa_list', adminId: user.id }),
  ]);
  if (!st.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${st.error}</div>`; return; }
  CFG_DATA = { settings: st.settings || [], types: (ty.ok && ty.types) || [], causas: (ca.ok && ca.causas) || [] };

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Configuración</h1><p>Parámetros, catálogos e integraciones del portal</p></div></div>
    <div class="cfg-tabs">
      <button class="cfg-tab" data-tab="aus">📅 Tipos de ausencia</button>
      <button class="cfg-tab" data-tab="mar">🕐 Causas de marcaje</button>
      <button class="cfg-tab" data-tab="cor">📆 Corte y períodos</button>
      <button class="cfg-tab" data-tab="int">🔌 Integraciones</button>
    </div>
    <div id="cfgBody"></div>`;

  $('#pnlMain').querySelectorAll('.cfg-tab').forEach(b =>
    b.addEventListener('click', () => { CFG_TAB = b.dataset.tab; cfgRenderTab(user); }));
  cfgRenderTab(user);
}

function cfgRenderTab(user) {
  $('#pnlMain').querySelectorAll('.cfg-tab').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === CFG_TAB));
  const body = $('#cfgBody');
  if (CFG_TAB === 'aus') cfgRenderAusencia(user, body);
  else if (CFG_TAB === 'mar') cfgRenderCausas(user, body);
  else if (CFG_TAB === 'cor') cfgRenderCorte(user, body);
  else if (CFG_TAB === 'int') cfgRenderIntegraciones(user, body);
}

/* ---- helpers de settings (corte / integraciones) ---- */
function cfgFieldRow(s) {
  if (s.is_secret) {
    const estado = s.configured
      ? '<span class="pill pill-open">Configurado</span>'
      : '<span class="pill pill-closed">No configurado</span>';
    return `<div class="cfg-row">
      <div class="cfg-meta"><div class="cfg-label">${s.label}</div>
        <div class="cfg-desc">${s.description || ''}</div></div>
      <div class="cfg-secret">${estado}<span class="cfg-secret-note">Se gestiona como secreto del servidor</span></div>
    </div>`;
  }
  const ph = s.kind === 'url' ? 'https://…'
    : s.kind === 'time' ? 'HH:MM (ej. 14:00)'
    : s.kind === 'email' ? 'correo@grupocanaima.com'
    : s.kind === 'number' ? 'solo números' : '';
  const narrow = (s.kind === 'number' || s.kind === 'time') ? 'narrow' : '';
  return `<div class="cfg-row">
    <div class="cfg-meta"><div class="cfg-label">${s.label}</div>
      <div class="cfg-desc">${s.description || ''}</div></div>
    <div class="cfg-input">
      <input type="text" class="${narrow}" data-cfgkey="${s.key}" value="${(s.value || '').replace(/"/g, '&quot;')}" placeholder="${ph}">
    </div>
  </div>`;
}

/* Guarda en bloque todos los inputs (no secretos) de un contenedor */
async function cfgSaveSection(user, container, savedEl, btn) {
  const inputs = [...container.querySelectorAll('input[data-cfgkey]')];
  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Guardando…';
  let firstError = null;
  for (const inp of inputs) {
    const key = inp.dataset.cfgkey;
    const r = await cfgSettings({ action: 'save', adminId: user.id, key, value: inp.value });
    if (!r.ok) { firstError = firstError || `${key}: ${r.error}`; inp.style.borderColor = 'var(--danger)'; }
    else { inp.value = r.value; inp.style.borderColor = ''; const s = CFG_DATA.settings.find(x => x.key === key); if (s) s.value = r.value; }
  }
  btn.disabled = false; btn.textContent = orig;
  if (firstError) { alert('Algunos campos no se guardaron:\n' + firstError); return; }
  if (savedEl) { savedEl.style.display = 'inline'; setTimeout(() => savedEl.style.display = 'none', 1800); }
}

/* ===== Pestana CORTE Y PERIODOS ===== */
function cfgRenderCorte(user, body) {
  const grupo = CFG_DATA.settings.filter(s => s.grupo === 'Quincenas y fechas límite');
  body.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3>Corte de cálculo</h3><span class="cfg-saved" id="savedCorte">✓ Guardado</span></div>
      <p class="cfg-desc" style="margin:0 0 8px">Define hasta cuándo hacia atrás se aceptan reportes. <b>Afecta todos los tipos</b> que respetan el corte (marcaje y ausencias). Cambiarlo aquí ajusta todo el portal.</p>
      <div id="corteFields">${grupo.map(cfgFieldRow).join('')}</div>
      <div class="cfg-foot"><button class="btn btn-primary" id="saveCorte">Guardar cambios</button></div>
    </div>`;
  $('#saveCorte').addEventListener('click', () =>
    cfgSaveSection(user, $('#corteFields'), $('#savedCorte'), $('#saveCorte')));
}

/* ===== Pestana INTEGRACIONES (osTicket + correo) ===== */
function cfgRenderIntegraciones(user, body) {
  const ost = CFG_DATA.settings.filter(s => s.grupo === 'osTicket');
  const cor = CFG_DATA.settings.filter(s => s.grupo === 'Notificaciones por correo');
  body.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3>osTicket</h3><span class="cfg-saved" id="savedOst">✓ Guardado</span></div>
      <div class="cfg-lock">🔒 <div>La <b>clave API</b> no se edita aquí: vive como <b>Secret de Cloudflare</b> (<span style="font-family:monospace">osticket_api_key</span>) y nunca viaja al navegador. Para cambiarla, se actualiza en el panel de Cloudflare.</div></div>
      <div id="ostFields">${ost.map(cfgFieldRow).join('')}</div>
      <div class="cfg-foot">
        <button class="btn btn-primary" id="saveOst">Guardar cambios</button>
        <button class="btn" id="ostPing">🔬 Probar conexión</button>
        <button class="btn" id="ostCreate" title="Crea un ticket real de prueba en el demo">🎫 Crear ticket de prueba</button>
      </div>
      <div id="ostTestResult" class="cfg-test-result" style="display:none"></div>
    </div>
    <div class="card">
      <div class="cfg-card-head"><h3>Notificaciones por correo</h3><span class="cfg-saved" id="savedMail">✓ Guardado</span></div>
      <div id="mailFields">${cor.map(cfgFieldRow).join('')}</div>
      <div class="cfg-foot"><button class="btn btn-primary" id="saveMail">Guardar cambios</button></div>
    </div>
    <p class="muted" style="font-size:12px;margin:14px 2px 0">Los secretos (claves de API) no se almacenan en el portal por seguridad; se configuran como variables protegidas del servidor (Cloudflare Pages → Settings → Variables and Secrets).</p>`;
  $('#saveOst').addEventListener('click', () =>
    cfgSaveSection(user, $('#ostFields'), $('#savedOst'), $('#saveOst')));
  $('#saveMail').addEventListener('click', () =>
    cfgSaveSection(user, $('#mailFields'), $('#savedMail'), $('#saveMail')));
  $('#ostPing').addEventListener('click', () => osticketTest(user, 'ping'));
  $('#ostCreate').addEventListener('click', () => {
    if (!confirm('Esto crea un ticket REAL en el osTicket demo (topic Ausencia). Usalo solo contra el demo. Continuar?')) return;
    osticketTest(user, 'create');
  });
}

/* Llama al Worker de prueba de osTicket y pinta el resultado. */
async function osticketTest(user, mode) {
  const box = $('#ostTestResult');
  const pingBtn = $('#ostPing'), createBtn = $('#ostCreate');
  pingBtn.disabled = true; createBtn.disabled = true;
  box.style.display = 'block';
  box.className = 'cfg-test-result testing';
  box.textContent = mode === 'create' ? 'Creando ticket de prueba en el demo…' : 'Probando conexion con osTicket…';
  let r;
  try {
    r = await fetch('/api/osticket-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: user.id, mode }),
    }).then(x => x.json());
  } catch (e) {
    r = { ok: false, error: 'No se pudo contactar el servidor: ' + e.message };
  }
  pingBtn.disabled = false; createBtn.disabled = false;
  const ok = r.ok;
  box.className = 'cfg-test-result ' + (ok ? 'good' : 'bad');
  const icon = ok ? '✅' : '⚠️';
  const msg = r.message || r.error || (ok ? 'Conexion correcta.' : 'No se pudo verificar la conexion.');
  const detail = r.detail ? `<div class="cfg-test-detail">Respuesta del servidor: <code>${String(r.detail).replace(/</g,'&lt;')}</code></div>` : '';
  const statusLine = (r.status != null) ? `<div class="cfg-test-detail">Codigo HTTP: ${r.status}</div>` : '';
  box.innerHTML = `<div class="cfg-test-msg">${icon} ${msg}</div>${statusLine}${detail}`;
}

/* ===== Pestana TIPOS DE AUSENCIA ===== */
function cfgRenderAusencia(user, body) {
  const enfPill = (e) => e === 'block' ? '<span class="pill pill-block">bloquea</span>'
    : e === 'optional' ? '<span class="pill pill-opt">opcional</span>'
    : '<span class="pill pill-warn2">advierte</span>';
  const rows = CFG_DATA.types.map(t => {
    const atras = t.past_uses_cutoff ? 'corte global' : (t.past_window_days == null ? 'sin límite' : `${t.past_window_days} días`);
    const fut = (t.future_window_days > 0) ? `${t.future_window_days} días` : '—';
    const doc = t.doc ? t.doc.name : '<span style="color:var(--muted)">—</span>';
    const enf = t.doc ? enfPill(t.doc.enforcement) : '<span class="pill pill-opt">—</span>';
    const estado = t.is_active ? '<span class="pill pill-open">activo</span>' : '<span class="pill pill-closed">inactivo</span>';
    return `<tr>
      <td><b>${t.label}</b></td>
      <td><span class="pill pill-ax">${t.ax_code}</span></td>
      <td>${atras}</td><td>${fut}</td>
      <td>${doc}</td><td>${enf}</td><td>${estado}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-mini" data-edit-aus="${t.code}">${I.pencil}</button>
        <button class="btn btn-mini" data-toggle-aus="${t.code}" data-active="${t.is_active}">${t.is_active ? 'Desactivar' : 'Activar'}</button>
      </td></tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">Sin tipos.</td></tr>';

  body.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3>Tipos de ausencia</h3>
        <button class="btn btn-primary btn-mini" id="ausNew">${I.plus} Nuevo tipo</button></div>
      <p class="cfg-desc" style="margin:0 0 14px">Código AX, ventanas de fecha y documento requerido por tipo. El límite hacia atrás "corte global" lo manda la pestaña Corte; cambiarlo allí ajusta todos estos tipos.</p>
      <table class="cfg-cat-table"><thead><tr>
        <th>Tipo</th><th>Cód. AX</th><th>Atrás</th><th>Futuro</th><th>Documento</th><th>Exigencia</th><th>Estado</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>`;

  $('#ausNew').addEventListener('click', () => cfgAusModal(user, null));
  body.querySelectorAll('[data-edit-aus]').forEach(b =>
    b.addEventListener('click', () => cfgAusModal(user, CFG_DATA.types.find(t => t.code === b.dataset.editAus))));
  body.querySelectorAll('[data-toggle-aus]').forEach(b =>
    b.addEventListener('click', async () => {
      const r = await cfgCatalogs({ action: 'absence_toggle', adminId: user.id, code: b.dataset.toggleAus, active: !(b.dataset.active === 'true') });
      if (!r.ok) { alert(r.error); return; }
      await cfgReloadCatalogs(user); cfgRenderTab(user);
    }));
}

function cfgAusModal(user, t) {
  const isNew = !t;
  const d = (t && t.doc) || null;
  openModal(`
    <div class="modal-head"><span>${isNew ? 'Nuevo tipo de ausencia' : 'Editar tipo de ausencia'}</span><button class="modal-x" id="mX">✕</button></div>
    <div class="cfg-grid2">
      <div><label class="flabel">Nombre (lo ve la tienda)</label><input id="au_label" value="${t ? t.label.replace(/"/g,'&quot;') : ''}" placeholder="Reposo"></div>
      <div><label class="flabel">Código AX</label><input id="au_ax" value="${t ? (t.ax_code||'') : ''}" placeholder="REP" style="font-family:monospace;text-transform:uppercase"></div>
    </div>
    <div class="cfg-grid3" style="margin-top:12px">
      <div><label class="flabel">Respeta corte global</label>
        <select id="au_cut"><option value="1" ${!t || t.past_uses_cutoff ? 'selected' : ''}>Sí</option><option value="0" ${t && !t.past_uses_cutoff ? 'selected' : ''}>No</option></select></div>
      <div><label class="flabel">Días atrás (si no respeta)</label><input id="au_past" type="number" min="0" value="${t && !t.past_uses_cutoff && t.past_window_days != null ? t.past_window_days : ''}" placeholder="vacío = sin límite"></div>
      <div><label class="flabel">Días a futuro</label><input id="au_fut" type="number" min="0" value="${t ? (t.future_window_days||0) : 0}"></div>
    </div>
    <p class="muted" style="font-size:11.5px;margin:8px 0 0">Con "respeta corte global = Sí", el límite hacia atrás lo manda el Corte (no el número). 0 días a futuro = no permite fechas futuras.</p>
    <div class="cfg-grid2" style="margin-top:14px">
      <div><label class="flabel">Código (interno)</label><input id="au_code" value="${t ? t.code : ''}" ${t ? 'readonly' : ''} placeholder="REP" style="font-family:monospace;text-transform:uppercase"></div>
      <div><label class="flabel">Estado</label>
        <select id="au_active"><option value="1" ${!t || t.is_active ? 'selected' : ''}>Activo</option><option value="0" ${t && !t.is_active ? 'selected' : ''}>Inactivo</option></select></div>
    </div>
    <hr style="border:0;border-top:1px solid var(--border);margin:16px 0">
    <p class="flabel" style="margin-bottom:8px">Documento requerido <span class="muted">(opcional)</span></p>
    <div class="cfg-grid2">
      <div><label class="flabel">Nombre del documento</label><input id="au_doc" value="${d ? d.name.replace(/"/g,'&quot;') : ''}" placeholder="Informe médico (vacío = sin documento)"></div>
      <div><label class="flabel">Exigencia</label>
        <select id="au_enf">
          <option value="block" ${d && d.enforcement==='block'?'selected':''}>Bloquea (no deja enviar sin él)</option>
          <option value="warn" ${!d || d.enforcement==='warn'?'selected':''}>Advierte (deja enviar, queda pendiente)</option>
          <option value="optional" ${d && d.enforcement==='optional'?'selected':''}>Opcional</option>
        </select></div>
    </div>
    <div style="margin-top:12px"><label class="flabel">Nota / coordinación (opcional)</label>
      <input id="au_note" value="${t && t.note ? t.note.replace(/"/g,'&quot;') : ''}" placeholder="ej. coordinar con el jefe inmediato"></div>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Guardar</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const usesCutoff = $('#au_cut').value === '1';
    const docName = $('#au_doc').value.trim();
    const payload = {
      action: 'absence_save', adminId: user.id,
      type: {
        code: $('#au_code').value, label: $('#au_label').value, ax_code: $('#au_ax').value,
        note: $('#au_note').value, is_active: $('#au_active').value === '1',
        past_uses_cutoff: usesCutoff,
        past_window_days: usesCutoff ? null : ($('#au_past').value === '' ? null : $('#au_past').value),
        future_window_days: $('#au_fut').value,
        doc: docName ? { name: docName, enforcement: $('#au_enf').value, is_required: true } : null,
      },
    };
    const r = await cfgCatalogs(payload);
    if (!r.ok) { alert(r.error); return; }
    closeModal();
    await cfgReloadCatalogs(user); cfgRenderTab(user);
  });
}

/* ===== Pestana CAUSAS DE MARCAJE ===== */
function cfgRenderCausas(user, body) {
  const rows = CFG_DATA.causas.map((c, i) => {
    const tipo = c.is_other ? '<span class="pill pill-warn2">texto libre</span>' : '';
    const estado = c.is_active ? '<span class="pill pill-open">activa</span>' : '<span class="pill pill-closed">inactiva</span>';
    return `<tr>
      <td style="font-family:monospace;color:var(--muted)">${i + 1}</td>
      <td><b>${c.label}</b><br><span class="muted" style="font-size:11px;font-family:monospace">${c.code}</span></td>
      <td>${tipo}</td><td>${estado}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-mini" data-edit-causa="${c.code}">${I.pencil}</button>
        <button class="btn btn-mini" data-toggle-causa="${c.code}" data-active="${c.is_active}">${c.is_active ? 'Desactivar' : 'Activar'}</button>
      </td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">Sin causas.</td></tr>';

  body.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3>Causas de marcaje</h3>
        <button class="btn btn-primary btn-mini" id="causaNew">${I.plus} Nueva causa</button></div>
      <p class="cfg-desc" style="margin:0 0 14px">Motivos que la tienda elige al reportar un marcaje manual. "Texto libre" pide una descripción adicional (tipo Otros).</p>
      <table class="cfg-cat-table"><thead><tr>
        <th>#</th><th>Causa</th><th>Tipo</th><th>Estado</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>`;

  $('#causaNew').addEventListener('click', () => cfgCausaModal(user, null));
  body.querySelectorAll('[data-edit-causa]').forEach(b =>
    b.addEventListener('click', () => cfgCausaModal(user, CFG_DATA.causas.find(c => c.code === b.dataset.editCausa))));
  body.querySelectorAll('[data-toggle-causa]').forEach(b =>
    b.addEventListener('click', async () => {
      const r = await cfgCatalogs({ action: 'causa_toggle', adminId: user.id, code: b.dataset.toggleCausa, active: !(b.dataset.active === 'true') });
      if (!r.ok) { alert(r.error); return; }
      await cfgReloadCatalogs(user); cfgRenderTab(user);
    }));
}

function cfgCausaModal(user, c) {
  const isNew = !c;
  openModal(`
    <div class="modal-head"><span>${isNew ? 'Nueva causa' : 'Editar causa'}</span><button class="modal-x" id="mX">✕</button></div>
    <label class="flabel">Nombre (lo ve la tienda)</label>
    <input id="ca_label" value="${c ? c.label.replace(/"/g,'&quot;') : ''}" placeholder="Olvido de marcaje" style="margin-bottom:12px">
    <label class="flabel">Código (interno)</label>
    <input id="ca_code" value="${c ? c.code : ''}" ${c ? 'readonly' : ''} placeholder="olvido" style="font-family:monospace;margin-bottom:12px">
    <label class="radio-row" style="margin-bottom:8px"><input type="checkbox" id="ca_other" ${c && c.is_other ? 'checked' : ''}>
      <span>Pide texto libre <span class="muted" style="font-size:12px">(como "Otros": la tienda escribe el detalle)</span></span></label>
    <label class="radio-row"><input type="checkbox" id="ca_active" ${!c || c.is_active ? 'checked' : ''}> <span>Activa</span></label>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Guardar</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const r = await cfgCatalogs({ action: 'causa_save', adminId: user.id,
      causa: { code: $('#ca_code').value, label: $('#ca_label').value,
        is_other: $('#ca_other').checked, is_active: $('#ca_active').checked } });
    if (!r.ok) { alert(r.error); return; }
    closeModal();
    await cfgReloadCatalogs(user); cfgRenderTab(user);
  });
}

/* Recarga catalogos (tras un cambio) sin recargar toda la vista */
async function cfgReloadCatalogs(user) {
  const [ty, ca] = await Promise.all([
    cfgCatalogs({ action: 'absence_list', adminId: user.id }),
    cfgCatalogs({ action: 'causa_list', adminId: user.id }),
  ]);
  if (ty.ok) CFG_DATA.types = ty.types || [];
  if (ca.ok) CFG_DATA.causas = ca.causas || [];
}

/* ---------- navegación ---------- */
async function ensureCatalog(user) {
  if (CATALOG) return;
  $('#pnlMain').innerHTML = '<div class="pnl-loading">Cargando catálogo…</div>';
  // POST con la sesión: el servidor filtra las empresas según rol/alcance
  const res = await fetch('/api/catalog', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user }),
  });
  const d = await res.json();
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }
  CATALOG = d;
}

async function navigate(view, user) {
  currentView = view;
  document.querySelectorAll('#pnlNav button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  if (view === 'tiendas' || view === 'catalogos') {
    await ensureCatalog(user);
    if (!CATALOG) return;
  }
  if (view === 'tiendas') viewTiendas(user);
  else if (view === 'catalogos') viewCatalogos();
  else if (view === 'usuarios') viewUsuarios(user);
  else if (view === 'quincenas') viewPeriods(user);
  else if (view === 'equipo') viewEquipo(user);
  else if (view === 'permisos') viewPermisos(user);
  else if (view === 'sync') viewSync(user);
  else if (view === 'config') viewConfig(user);
  else if (view === 'historial') renderHistory(user);
  else if (view === 'miempresa') viewMiEmpresa(user);
}

/* ---------- Selector de tipo de reporte (admin desde Empresas) ----------
   Reusa el wizard existente; el responsable sera la central (el admin).
   Por ahora solo Marcaje esta activo; los demas quedan "pronto". */
function openReportPicker(u, onExit) {
  openModal(`
    <div class="modal-head"><span>Reportar por ${u.pickedCompany}</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${u.pickedCompanyName || ''} · el reporte quedará a nombre de la central (Administrador).</p>
    <div class="report-grid" id="rpGrid" style="grid-template-columns:1fr">
      <button class="report-tile" data-report="marcaje">
        <span class="rt-ico">🕐</span>
        <span class="rt-body"><span class="rt-title">Marcaje Manual</span>
          <span class="rt-desc">Registra entradas y salidas que no quedaron en el biométrico.</span></span>
      </button>
      <button class="report-tile" data-report="ausencia">
        <span class="rt-ico">📅</span>
        <span class="rt-body"><span class="rt-title">Ausencia</span>
          <span class="rt-desc">Reposos, permisos y faltas.</span></span>
      </button>
      <div class="report-tile soon"><span class="rt-ico">➕</span>
        <span class="rt-body"><span class="rt-title">Ingreso <span class="badge-soon">pronto</span></span>
          <span class="rt-desc">Nuevo trabajador en la tienda.</span></span></div>
      <div class="report-tile soon"><span class="rt-ico">➖</span>
        <span class="rt-body"><span class="rt-title">Egreso <span class="badge-soon">pronto</span></span>
          <span class="rt-desc">Trabajador que deja la tienda.</span></span></div>
      <div class="report-tile soon"><span class="rt-ico">✏️</span>
        <span class="rt-body"><span class="rt-title">Modificación <span class="badge-soon">pronto</span></span>
          <span class="rt-desc">Corrección de datos de un trabajador.</span></span></div>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  const tile = document.querySelector('#rpGrid [data-report="marcaje"]');
  if (tile) tile.addEventListener('click', () => {
    closeModal();
    launchWizard(u, marcajeReport, onExit);
  });
  const tileAus = document.querySelector('#rpGrid [data-report="ausencia"]');
  if (tileAus) tileAus.addEventListener('click', () => {
    closeModal();
    launchWizard(u, ausenciaReport, onExit);
  });
}

/* ---------- VISTA: MI EMPRESA (solo rol tienda) ---------- */
async function viewMiEmpresa(user) {
  $('#pnlMain').innerHTML = `<div class="pnl-loading">Cargando…</div>`;
  // El catálogo (filtrado) trae solo la propia empresa de la tienda
  await ensureCatalog(user);
  const c = (CATALOG && CATALOG.companies && CATALOG.companies[0]) || null;
  if (!c) {
    $('#pnlMain').innerHTML = `<div class="card"><p class="muted" style="margin:0">No se encontraron los datos de tu empresa. Contacta a Capital Humano.</p></div>`;
    return;
  }
  const tel = phoneDisplay(c.phone);
  const tel2 = phoneDisplay(c.phone2);
  const telLine = [tel, tel2].filter(Boolean).join(' / ') || '—';
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Mi empresa</h1><p>Datos registrados de tu tienda</p></div></div>
    <div class="card miemp-card">
      <div class="miemp-code">${c.code}</div>
      <h2 class="miemp-name">${c.name || ''}</h2>
      <div class="miemp-grid">
        <div><span class="miemp-lbl">Concepto</span><span>${c.concept || '—'}</span></div>
        <div><span class="miemp-lbl">Zona</span><span>${c.zone || '—'}</span></div>
        <div><span class="miemp-lbl">Subzona</span><span>${c.subzone || '—'}</span></div>
        <div><span class="miemp-lbl">Estado</span><span>${statusPill(c.status)}</span></div>
        <div><span class="miemp-lbl">Correo</span><span>${c.email || '—'}</span></div>
        <div><span class="miemp-lbl">Teléfono</span><span>${telLine}</span></div>
      </div>
    </div>

    <div class="pnl-head" style="margin-top:6px"><div><h2 style="font-size:18px;margin:0">Reportar a Nómina</h2>
      <p class="muted" style="margin:2px 0 0">Elige el tipo de novedad que quieres reportar.</p></div></div>
    <div class="report-grid" id="reportGrid">
      <button class="report-tile" data-report="marcaje">
        <span class="rt-ico">🕐</span>
        <span class="rt-body"><span class="rt-title">Marcaje Manual</span>
          <span class="rt-desc">Registra entradas y salidas que no quedaron en el biométrico.</span></span>
      </button>
      <button class="report-tile" data-report="ausencia">
        <span class="rt-ico">📅</span>
        <span class="rt-body"><span class="rt-title">Ausencia</span>
          <span class="rt-desc">Reposos, permisos y faltas.</span></span>
      </button>
      <div class="report-tile soon"><span class="rt-ico">➕</span>
        <span class="rt-body"><span class="rt-title">Ingreso <span class="badge-soon">pronto</span></span>
          <span class="rt-desc">Nuevo trabajador en la tienda.</span></span></div>
      <div class="report-tile soon"><span class="rt-ico">➖</span>
        <span class="rt-body"><span class="rt-title">Egreso <span class="badge-soon">pronto</span></span>
          <span class="rt-desc">Trabajador que deja la tienda.</span></span></div>
      <div class="report-tile soon"><span class="rt-ico">✏️</span>
        <span class="rt-body"><span class="rt-title">Modificación <span class="badge-soon">pronto</span></span>
          <span class="rt-desc">Corrección de datos de un trabajador.</span></span></div>
    </div>`;

  const tile = $('#reportGrid').querySelector('[data-report="marcaje"]');
  if (tile) tile.addEventListener('click', () => {
    launchWizard(user, marcajeReport, () => viewMiEmpresa(user));
  });
  const tileAus = $('#reportGrid').querySelector('[data-report="ausencia"]');
  if (tileAus) tileAus.addEventListener('click', () => {
    launchWizard(user, ausenciaReport, () => viewMiEmpresa(user));
  });
}

export function renderPanel() {
  const user = getSession();
  if (!user) { go('/login'); return; }
  // Limpiar estado en memoria de cualquier sesión previa (evita que datos
  // de un usuario anterior "se filtren" si se cambia de sesión sin recargar).
  CATALOG = null; CU_ROWS = null; SCOPE = null; currentView = 'tiendas';
  mount(shell(user));
  loadAvatar((user.email || '').trim().toLowerCase());
  $('#logoutBtn').addEventListener('click', () => { clearSession(); go('/login'); });
  document.querySelectorAll('#pnlNav button').forEach(b =>
    b.addEventListener('click', () => navigate(b.dataset.view, user)));
  // Rol tienda: solo su propia empresa. Admin/superadmin: arranca en Empresas.
  if (user.kind === 'company') navigate('miempresa', user);
  else navigate('tiendas', user);
}
