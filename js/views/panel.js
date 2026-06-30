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
import { egresoReport } from '../reports/report-egreso.js';
import { ingresoReport } from '../reports/report-ingreso.js';
import { modificacionReport } from '../reports/report-modificacion.js';
import { renderHistory } from '../reports/history.js';
import { renderWorkerPhotos } from './worker-photos.js';
import { renderDashboard } from './dashboard.js';
import { renderReportStats } from './report-stats.js';
import { renderCompanyReports, renderMyStats } from './company-reports.js';
import { renderAvisos, gotoAviso as avisosGoto } from './avisos.js';
import { renderEgressRatify } from './egress-ratify.js';
import { renderPersonnelSearch } from './personnel-search.js';
import { renderPersonnelDocs } from './personnel-docs.js';
import { renderDepartmentCargos } from './department-cargos.js';
import { injectPeriodTimeline } from './period-timeline.js';
import { renderDepartments } from './departments.js';
import { axRosterPull, rosterCooldownMessage } from '../reports/shared/roster-ax.js';

/* Tipos de empresa que NO son tienda: pueden tener departamentos y usuarios
   de empresa. (companies.company_type) */
const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);

let CATALOG = null;       // { companies, zones, subzones, concepts }
let currentView = 'tiendas';

/* Filtros de la vista Empresas persistidos a nivel de modulo: al entrar a una
   empresa (Personal/Departamentos), sincronizar y volver, viewTiendas se
   re-ejecuta desde cero; guardar aqui lo elegido evita tener que volver a
   filtrar. Se setea en cada render y se restaura al construir la vista.
   null = primera vez (usa los defaults). selStatus va como Array. */
let TIENDAS_FILTERS = null;  // { name, type, statuses:[], zone, sub, concept }

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
  photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>',
  docs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/></svg>',
  bizreport: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l5-4v18"/><path d="M19 21V11l-5-4"/><path d="M9 9v0M9 13v0M9 17v0"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  megaphone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>',
};

/* ---------- NAVEGACION (admin / superadmin) ----------
   Estructura agrupada para el sidebar. Los `view` (data-view) NO cambian:
   son los identificadores internos que enruta navigate(). Solo cambian las
   ETIQUETAS visibles y la organizacion en grupos colapsables.
   Renombres visibles respecto a la version anterior:
     catalogos      -> "Estructura"
     rostersync     -> "Carga de personal"  (antes "Sinc. Personal")
     reportempresas -> "Analisis"           (antes "Reportes de empresas")
     avisosconfig   -> "Envio de avisos"
   `superonly:true` en un item lo limita a superadmin.
   Los items SUELTOS (sin grupo) van arriba; el resto en grupos. */
const NAV_LOOSE = [
  ['dashboard', I.grid, 'Inicio'],
  ['usuarios', I.users, 'Usuarios'],
  ['documentos', I.docs, 'Documentos'],
  ['calendario', I.calendar, 'Calendario'],
];
const NAV_GROUPS = [
  { title: 'Organización', items: [
    ['tiendas', I.store, 'Empresas'],
    ['catalogos', I.catalog, 'Estructura'],
  ] },
  { title: 'Personal', items: [
    ['buscar', I.search, 'Buscar'],
    ['egmotivos', I.check, 'Ratificar egresos'],
    ['rostersync', I.sync, 'Carga de personal'],
  ] },
  { title: 'Reportes', items: [
    ['historial', I.history, 'Historial'],
    ['estadisticas', I.chart, 'Estadísticas'],
    ['reportempresas', I.bizreport, 'Análisis'],
  ] },
  { title: 'Comunicación', items: [
    ['avisos', I.bell, 'Avisos'],
    ['avisosconfig', I.megaphone, 'Envío de avisos'],
  ] },
  { title: 'Administración', superonly: true, items: [
    ['equipo', I.team, 'Equipo'],
    ['permisos', I.shield, 'Permisos'],
    ['sync', I.sync, 'Sincronización'],
    ['config', I.cog, 'Configuración'],
  ] },
];

/* Todos los view validos para admin/super (para resaltar el activo, etc.). */
const NAV_ALL = [...NAV_LOOSE, ...NAV_GROUPS.flatMap(g => g.items.map(it => [...it, g.superonly ? 'superonly' : null]))];

/* Etiquetas legibles de rol para la topbar. */
const ROLE_LABELS = { superadmin: 'superadmin', admin: 'admin', editor_personal: 'editor_personal' };

/* ---------- shell ---------- */
function shell(user) {
  const isCompany = user.kind === 'company';
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  const isEditorPersonal = user.kind === 'admin' && user.role === 'editor_personal';
  // La campanita se muestra para admin/superadmin, editor_personal Y usuarios
  // company. El editor solo recibe avisos dirigidos a "Editores" (solo lectura);
  // no gestiona el seteo de avisos.
  const showBell = (user.kind === 'company') || (user.kind === 'admin');
  const nameLabel = isCompany ? user.companyCode : (user.name || user.username);
  const roleLabel = isCompany ? 'tienda' : (ROLE_LABELS[user.role] || user.role);
  const initials = (nameLabel || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const email = (user.email || '').trim().toLowerCase();

  // Navegación según rol.
  //  - company y editor_personal: lista PLANA (pocos items, sin agrupar).
  //  - admin / superadmin: menú AGRUPADO (items sueltos arriba + grupos).
  // navFlat: arreglo de [view, icon, label] para los roles planos.
  // navGroups: null salvo para admin/super (alli se usa el agrupado).
  let navFlat = null, navGroups = null;
  if (isCompany) {
    navFlat = [['dashboard', I.grid, 'Inicio'], ['miempresa', I.store, 'Mi empresa'], ['fotos', I.photo, 'Personal'], ['documentos', I.docs, 'Documentos'], ['calendario', I.calendar, 'Calendario'], ['historial', I.history, 'Historial'], ['misstats', I.chart, 'Mis estadísticas'], ['avisos', I.bell, 'Avisos']];
  } else if (isEditorPersonal) {
    const allow = ['dashboard', 'tiendas', 'buscar', 'calendario', 'rostersync', 'avisos'];
    navFlat = NAV_ALL.filter(n => allow.includes(n[0])).map(n => [n[0], n[1], n[2]]);
  } else {
    navGroups = NAV_GROUPS.filter(g => !g.superonly || isSuper);
  }

  // Botón de navegación. data-label alimenta el tooltip del modo riel.
  const navBtn = ([id, ic, label]) =>
    `<button data-view="${id}" data-label="${label}" class="${id === currentView ? 'active' : ''}">${ic}<span>${label}</span></button>`;

  // HTML del nav: plano (navFlat, dentro de .nav-loose) o agrupado
  // (NAV_LOOSE en .nav-loose + grupos con encabezado-chevron).
  const chev = '<svg class="nav-ghead-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  const navHtml = navFlat
    ? `<div class="nav-loose">${navFlat.map(navBtn).join('')}</div>`
    : `<div class="nav-loose">${NAV_LOOSE.map(navBtn).join('')}</div>`
      + navGroups.map((g, gi) => `
        <div class="nav-group" data-group="${gi}">
          <button type="button" class="nav-ghead" data-group-toggle="${gi}"><span class="gh-label">${g.title}</span>${chev}</button>
          <div class="nav-gitems">${g.items.map(navBtn).join('')}</div>
        </div>`).join('');

  return `
  <style>
    .pnl-topbar-right{position:relative;display:flex;align-items:center;gap:10px}
    .pnl-bell{position:relative;background:none;border:0;cursor:pointer;color:var(--muted);padding:6px;border-radius:8px;display:flex;align-items:center}
    .pnl-bell:hover{background:var(--bg-soft,#f1f2f4);color:var(--text,#0f172a)}
    .pnl-bell-badge{position:absolute;top:-1px;right:-1px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:#e11d48;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;line-height:1}
    .pnl-bell-pop{position:absolute;top:calc(100% + 8px);right:0;width:340px;max-width:calc(100vw - 24px);max-height:70vh;overflow:auto;background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.16);z-index:60}
    .pnl-bell-pop h4{margin:0;padding:12px 14px;border-bottom:1px solid var(--border,#e5e7eb);font-size:13px;position:sticky;top:0;background:var(--card,#fff);display:flex;justify-content:space-between;align-items:center}
    .pnl-bell-pop h4 a{color:var(--brand,#2563eb);text-decoration:none}
    .bell-group{padding:8px 14px 4px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--faint,#94a3b8)}
    .pnl-bell-item{padding:10px 14px;border-bottom:1px solid var(--border,#f1f2f4);font-size:12.5px;line-height:1.45;display:flex;gap:9px;align-items:flex-start}
    .pnl-bell-item .ic{flex:0 0 auto;line-height:1.3;color:var(--muted,#64748b)}
    .pnl-bell-item .muted{color:var(--muted,#64748b)}
    .pnl-bell-item:last-child{border-bottom:0}
    .pnl-bell-empty{padding:18px 14px;color:var(--muted);font-size:12.5px;text-align:center}
  </style>
  <div class="pnl-layout" id="pnlLayout">
    <button class="nav-reopen" id="pnlReopen" title="Mostrar menú" aria-label="Mostrar menú">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <aside class="pnl-side">
      <div class="pnl-brand">
        <div class="pnl-logo">${I.logo}</div>
        <div class="pnl-bwrap"><div class="pnl-bname">Portal de Nómina</div><div class="pnl-bver">v2.84</div></div>
        <button class="pnl-collapse" id="pnlRail" title="Colapsar menú" aria-label="Colapsar menú">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
      </div>
      <nav class="pnl-nav" id="pnlNav">
        ${navHtml}
      </nav>
    </aside>
    <div class="pnl-content">
      <header class="pnl-topbar">
        <button class="pnl-ham" id="pnlHam" title="Ocultar/mostrar menú" aria-label="Ocultar o mostrar menú">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <div class="pnl-user">
          <div class="pnl-avatar" id="pnlAvatar">${initials}</div>
          <div class="pnl-uinfo"><div class="pnl-uname">${nameLabel}</div><div class="pnl-urole">${roleLabel}</div></div>
        </div>
        <div class="pnl-topbar-right">
          ${showBell ? `<button class="pnl-bell" id="pnlBell" title="Novedades de empresas" aria-label="Novedades">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            <span class="pnl-bell-badge" id="pnlBellBadge" style="display:none">0</span>
          </button>
          <div class="pnl-bell-pop" id="pnlBellPop" hidden></div>` : ''}
          <button id="logoutBtn" class="pnl-logout" title="Cerrar sesión">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
            Salir
          </button>
        </div>
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

/* ---------- Campanita de novedades de empresas ----------
   Muestra empresas nuevas y cambios de estatus detectados en cada
   sincronizacion. El contador (sin leer) es por administrador. */
let BELL_ITEMS = [];
let BELL_INT = null;
let BELL_USER = null;
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
const BELL_SVG = {
  calc: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="18" x2="12" y2="18"/></svg>',
  cut: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l3-3 3 3 4-5"/></svg>',
  pay: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
  man: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-5v12L3 13v-2z"/></svg>',
};

/* Estado de la campanita: feed de avisos (todos) + novedades de empresa (admin). */
let BELL_AUTO = [], BELL_MANUAL = [], BELL_EMPRESA = [];

function bellAutoHtml(a) {
  return `<div class="pnl-bell-item">`
    + `<span class="ic">${BELL_SVG[a.type] || ''}</span>`
    + `<div><div><b>${escHtml(a.title)}</b></div>`
    + `<div class="muted">${escHtml(a.short || '')}</div>`
    + `<div class="muted" style="font-size:11px;margin-top:2px">\u{1F4C5} ${escHtml(a.date || '')}</div></div></div>`;
}
function bellManualHtml(m) {
  // En la campanita el manual muestra SOLO el titulo; el detalle se lee en Avisos.
  return `<div class="pnl-bell-item" data-goto="${escHtml(String(m.id))}" style="cursor:pointer">`
    + `<span class="ic">${BELL_SVG.man}</span>`
    + `<div><div><b>${escHtml(m.title)}</b></div>`
    + `<div class="muted" style="font-size:11px;margin-top:2px">Ver detalle en Avisos</div></div></div>`;
}
function bellEmpresaHtml(c) {
  const when = fmtDeadline(c.detected_at);
  const name = c.business_name ? ` \u2014 ${escHtml(c.business_name)}` : '';
  if (c.change_type === 'new') {
    return `<div class="pnl-bell-item" data-goto-ent="1" style="cursor:pointer"><span class="ic">\u2795</span><div><b>Nueva empresa</b> ${escHtml(c.company_code)}${name}`
      + `<div class="muted" style="font-size:11px;margin-top:2px">${when}</div></div></div>`;
  }
  return `<div class="pnl-bell-item" data-goto-ent="1" style="cursor:pointer"><span class="ic">\u{1F504}</span><div><b>${escHtml(c.company_code)}</b>${name}`
    + `<div style="margin-top:2px">Estatus: ${escHtml(c.old_value || '\u2014')} \u2192 <b>${escHtml(c.new_value || '\u2014')}</b></div>`
    + `<div class="muted" style="font-size:11px;margin-top:2px">${when}</div></div></div>`;
}
function bellRender() {
  const pop = document.getElementById('pnlBellPop');
  if (!pop) return;
  let html = `<h4>Avisos <a id="pnlBellAll" style="font-size:11.5px;font-weight:500;cursor:pointer">Ver todos</a></h4>`;
  if (BELL_AUTO.length) {
    html += `<div class="bell-group">Per\u00edodo de n\u00f3mina</div>` + BELL_AUTO.map(bellAutoHtml).join('');
  }
  if (BELL_MANUAL.length) {
    html += `<div class="bell-group">Comunicados</div>` + BELL_MANUAL.map(bellManualHtml).join('');
  }
  if (BELL_EMPRESA.length) {
    html += `<div class="bell-group">Novedades de empresas</div>` + BELL_EMPRESA.map(bellEmpresaHtml).join('');
  }
  if (html.indexOf('pnl-bell-item') < 0) html += '<div class="pnl-bell-empty">Sin avisos.</div>';
  pop.innerHTML = html;
  // "Ver todos" -> ir a la seccion Avisos
  const all = document.getElementById('pnlBellAll');
  if (all) all.addEventListener('click', () => { pop.hidden = true; navigate('avisos', BELL_USER); });
  // clic en un manual -> ir a Avisos y resaltar
  pop.querySelectorAll('[data-goto]').forEach(el =>
    el.addEventListener('click', () => {
      pop.hidden = true;
      navigate('avisos', BELL_USER);
      setTimeout(() => { try { avisosGoto(el.dataset.goto); } catch (_) {} }, 350);
    }));
  // clic en una novedad de empresa -> ir a la pantalla de Avisos (seccion
  // Novedades de empresas). Son globales y de solo lectura; solo navegamos.
  pop.querySelectorAll('[data-goto-ent]').forEach(el =>
    el.addEventListener('click', () => {
      pop.hidden = true;
      navigate('avisos', BELL_USER);
    }));
}
async function bellLoad(user) {
  const badge = document.getElementById('pnlBellBadge');
  if (!badge) return;
  let unread = 0;
  // 1) feed de avisos (todos los usuarios)
  try {
    const a = await fetch('/api/announcements', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'feed',
        user: user.kind === 'company' ? { kind: 'company', companyCode: user.companyCode } : { kind: 'admin', id: user.id },
      }),
    }).then(x => x.json());
    if (a && a.ok) { BELL_AUTO = a.auto || []; BELL_MANUAL = a.manual || []; unread += (a.unread || 0); }
  } catch (_) { /* nada */ }
  // 2) novedades de empresa (solo admin)
  if (user.kind === 'admin') {
    try {
      const r = await fetch('/api/notifications', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', adminId: user.id }),
      }).then(x => x.json());
      if (r && r.ok) { BELL_EMPRESA = r.items || []; unread += (r.unread || 0); }
    } catch (_) { /* nada */ }
  }
  if (unread > 0) { badge.textContent = unread > 99 ? '99+' : String(unread); badge.style.display = 'flex'; }
  else { badge.style.display = 'none'; }
  const pop = document.getElementById('pnlBellPop');
  if (pop && !pop.hidden) bellRender();
}
function initBell(user) {
  BELL_USER = user;
  const bell = document.getElementById('pnlBell');
  const pop = document.getElementById('pnlBellPop');
  if (!bell || !pop) return;
  bell.addEventListener('click', async (e) => {
    e.stopPropagation();
    const opening = pop.hidden;
    pop.hidden = !pop.hidden;
    if (opening) {
      bellRender();
      const badge = document.getElementById('pnlBellBadge');
      if (badge && badge.style.display !== 'none') {
        badge.style.display = 'none';
        // marcar visto en ambas fuentes
        try {
          await fetch('/api/announcements', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'seen',
              user: user.kind === 'company' ? { kind: 'company', companyCode: user.companyCode } : { kind: 'admin', id: user.id },
            }),
          });
        } catch (_) { /* nada */ }
        if (user.kind === 'admin') {
          try {
            await fetch('/api/notifications', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'seen', adminId: user.id }),
            });
          } catch (_) { /* nada */ }
        }
      }
    }
  });
  document.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !bell.contains(e.target)) pop.hidden = true;
  });
  bellLoad(user);
  if (BELL_INT) clearInterval(BELL_INT);
  BELL_INT = setInterval(() => bellLoad(user), 5 * 60 * 1000);
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
  // Estado nulo/vacio o sin valor: se muestra como un guion discreto, igual
  // que zona/subzona/concepto cuando no existen.
  if (!s || x.includes('nulo') || x.includes('vac')) return '<span class="muted">—</span>';
  return `<span class="pill pill-gray">${s}</span>`;
}

/* Color del alias segun el tipo de empresa, para identificarlas de un vistazo
   en la grilla. Devuelve una clase CSS (ver tokens .ty-* abajo). */
function tyClass(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('tienda en l')) return 'ty-online';
  if (t.includes('tienda')) return 'ty-tienda';
  if (t.includes('import')) return 'ty-import';
  if (t.includes('extern')) return 'ty-externa';
  if (t.includes('admin')) return 'ty-admin';
  if (t.includes('servic')) return 'ty-servicio';
  return 'ty-tienda';
}

/* Celda "Personal": cantidad + chip de metodo + frescura + quien cargo.
   Lee staffCount/rosterAt/rosterBy/rosterSource que arma /api/catalog. */
const ROSTER_METHODS = {
  ax_api:    { cls: 'm-s',   label: 'S',   full: 'Sincronización (API AX)' },
  report10:  { cls: 'm-r10', label: 'R10', full: 'Reporte 10 (Excel POS)' },
  reporte_ax:{ cls: 'm-rax', label: 'RAX', full: 'Reporte AX (Excel)' },
};
function methodChip(source) {
  const m = ROSTER_METHODS[source];
  if (!m) return '<span class="m m-man" title="Sin carga registrada">—</span>';
  return `<span class="m ${m.cls}" title="${m.full}">${m.label}</span>`;
}
/* Fecha de carga -> 'DD/MM/AAAA' Caracas + frescura (al dia / hace Nd). */
function rosterFresh(iso) {
  if (!iso) return '<span class="fresh-mid">sin carga</span>';
  const dt = new Date(iso);
  if (isNaN(dt)) return '<span class="fresh-mid">sin carga</span>';
  const car = new Date(dt.getTime() - 4 * 3600 * 1000);
  const z = n => String(n).padStart(2, '0');
  const when = `${z(car.getUTCDate())}/${z(car.getUTCMonth() + 1)}/${car.getUTCFullYear()}`;
  // dias transcurridos
  const today = new Date();
  const days = Math.floor((today - dt) / 86400000);
  let cls = 'fresh-ok', tail = ` · hace ${days}d`;
  if (days <= 0) { tail = ' · al día'; cls = 'fresh-ok'; }
  else if (days <= 7) cls = 'fresh-ok';
  else if (days <= 15) cls = 'fresh-mid';
  else cls = 'fresh-old';
  return `<span class="${cls}">${when}${tail}</span>`;
}
function personalCell(c) {
  if (!c.staffCount) return '<span class="muted">— sin lista —</span>';
  const by = c.rosterBy ? `<br>${String(c.rosterBy).replace(/</g, '&lt;')}` : '';
  return `<div class="cell-personal">`
    + `<div class="l1">${c.staffCount}</div>`
    + `<div class="l2">${methodChip(c.rosterSource)} ${rosterFresh(c.rosterAt)}${by}</div>`
    + `</div>`;
}

/* Color por tipo de empresa (mismos hex que los tokens .ty-* del alias).
   Se usa para el punto/borde de las stat cards y la pildora de Tipo. */
const TYPE_COLORS = {
  'Tienda': '#2563eb', 'Importadora': '#9333ea', 'Externa': '#0d9488',
  'Administrativa': '#d97706', 'Servicio': '#dc2626', 'Tienda en línea': '#db2777',
};
const TYPE_ORDER = ['Tienda', 'Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea'];

/* Pildora de tipo de empresa para la grilla (punto de color + etiqueta). */
function typePill(type) {
  const color = TYPE_COLORS[type] || 'var(--muted)';
  return `<span class="tpill" style="--tc:${color}"><span class="d"></span>${type || '—'}</span>`;
}

/* Stat cards de Estructura (solo principal): linea 1 con totales
   (Empresas / Zonas / Subzonas / Tipos) + linea 2 con el desglose por tipo.
   Se calcula del catalogo visible (ya filtrado por alcance en el backend). */
function empStatsHtml(companies) {
  const total = companies.length;
  const zones = new Set(companies.map(c => c.zoneId).filter(Boolean)).size;
  const subs = new Set(companies.map(c => c.subzoneId).filter(Boolean)).size;
  const staff = companies.reduce((a, c) => a + (c.staffCount || 0), 0);
  // Desglose del personal: no-tiendas (enterprise_workers) vs tiendas
  // (store_workers), segun el tipo de empresa.
  const staffEnt = companies.reduce((a, c) => a + (NON_STORE_TYPES.has(c.type) ? (c.staffCount || 0) : 0), 0);
  const staffStore = staff - staffEnt;
  const byType = {};
  companies.forEach(c => { const t = c.type || '—'; byType[t] = (byType[t] || 0) + 1; });
  const present = Object.keys(byType);
  const ordered = TYPE_ORDER.filter(t => present.includes(t))
    .concat(present.filter(t => !TYPE_ORDER.includes(t)).sort());
  const tienda = byType['Tienda'] || 0;
  const otras = total - tienda;
  const hint = otras > 0 ? `${tienda} tiendas · ${otras} otras` : `${tienda} tiendas`;
  const tcards = ordered.map(t => {
    const color = TYPE_COLORS[t] || 'var(--muted)';
    return `<div class="emp-tcard" style="--tc:${color}">`
      + `<div class="nm"><span class="d"></span>${t}</div>`
      + `<div class="v">${byType[t]}</div></div>`;
  }).join('');
  return `
    <div class="emp-stats">
      <div class="emp-srow">
        <div class="emp-stat"><div class="k">Empresas</div><div class="v">${total}</div><div class="hint">${hint}</div></div>
        <div class="emp-stat"><div class="k">Zonas</div><div class="v">${zones}</div><div class="hint">con empresas</div></div>
        <div class="emp-stat"><div class="k">Subzonas</div><div class="v">${subs}</div><div class="hint">con empresas</div></div>
        <div class="emp-stat"><div class="k">Empleados</div><div class="v">${staff}</div><div class="hint">${staffStore} en tiendas · ${staffEnt} en otras</div></div>
      </div>
      <div class="emp-types">${tcards}</div>
    </div>`;
}

/* ---------- VISTA: TIENDAS ---------- */
function viewTiendas(user) {
  const isAdmin = user.kind === 'admin';
  const isEditor = user.kind === 'admin' && user.role === 'editor_personal';
  const types = [...new Set(CATALOG.companies.map(c => c.type).filter(Boolean))].sort();
  const statuses = [...new Set(CATALOG.companies.map(c => c.status).filter(Boolean))].sort();
  const concepts = CATALOG.concepts.map(c => c.name);

  // Estados "activos" por defecto: una tienda activa está Abierta o Cerrada temporal.
  const ACTIVE_STATES = statuses.filter(s => /abier/i.test(s) || (/cerrad/i.test(s) && /temp/i.test(s)));
  // Conjunto seleccionado. Si ya hay filtros guardados (volviendo de una
  // empresa), se restauran; si no, arranca en los activos (o todos).
  const selStatus = TIENDAS_FILTERS
    ? new Set(TIENDAS_FILTERS.statuses.filter(s => statuses.includes(s)))
    : new Set(ACTIVE_STATES.length ? ACTIVE_STATES : statuses);

  $('#pnlMain').innerHTML = `
    <div class="pnl-head">
      <div><h1>Empresas</h1><p id="tCount"></p></div>
      <div style="display:flex;gap:8px;align-items:center">
        ${isAdmin ? `<button class="btn btn-primary" id="syncAllBtn">${I.sync} Sincronizar todo</button>` : ''}
        <div class="export-wrap">
          <button class="btn" id="exportBtn">Exportar ▾</button>
          <div class="export-menu" id="exportMenu" hidden>
            <button data-fmt="xlsx">Excel (.xlsx)</button>
            <button data-fmt="csv">CSV (.csv)</button>
            <button data-fmt="txt">Texto (.txt)</button>
          </div>
        </div>
      </div>
    </div>
    ${empStatsHtml(CATALOG.companies)}
    <div class="pnl-filters">
      <div class="search">${I.search}<input id="fName" type="text" placeholder="Buscar nombre o código…"></div>
      <select id="fType"><option value="ALL" selected>Todos los tipos</option>${types.map(t => `<option>${t}</option>`).join('')}</select>
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
          ${statuses.map(s => `<label class="ms-opt"><input type="checkbox" value="${s}" ${selStatus.has(s) ? 'checked' : ''}><span>${/nulo|vac/i.test(s) ? 'Sin estado' : s}</span><span class="ms-count">${CATALOG.companies.filter(c => c.status === s).length}</span></label>`).join('')}
        </div>
      </div>
      <select id="fZone"><option value="ALL">Todas las zonas</option>${CATALOG.zones.map(z => `<option value="${z.id}">${z.name}</option>`).join('')}</select>
      <select id="fSub"><option value="ALL">Todas las subzonas</option></select>
      <select id="fConcept"><option value="ALL">Todos los conceptos</option>${concepts.map(c => `<option>${c}</option>`).join('')}</select>
      <select id="fSort">
        <option value="code">Orden: Código</option>
        <option value="sync_recent">Sinc.: reciente primero</option>
        <option value="sync_old">Sinc.: antigua / nunca primero</option>
      </select>
    </div>
    <div class="tablebox">
      <table><thead><tr>
        <th>Código</th><th>Razón social</th><th>Tipo</th><th>Ubicación / Concepto</th><th>Contacto</th><th>Personal</th><th>Estado</th><th>Acceso</th><th style="text-align:right">Reportar</th>
      </tr></thead><tbody id="tBody"></tbody></table>
    </div>
    <div class="legend">
      <span class="ico-ok">${I.check} con acceso</span>
      <span class="ico-no">${I.circle} sin usuario</span>
    </div>`;

  const fName = $('#fName'), fType = $('#fType'),
        fZone = $('#fZone'), fSub = $('#fSub'), fConcept = $('#fConcept'), fSort = $('#fSort');

  // Restaurar los valores de los selects/buscador desde los filtros guardados
  // (volviendo de una empresa). Las subzonas se rellenan segun la zona elegida.
  if (TIENDAS_FILTERS) {
    fName.value = TIENDAS_FILTERS.name || '';
    if ([...fType.options].some(o => o.value === TIENDAS_FILTERS.type)) fType.value = TIENDAS_FILTERS.type;
    if ([...fZone.options].some(o => o.value === TIENDAS_FILTERS.zone)) fZone.value = TIENDAS_FILTERS.zone;
    if (TIENDAS_FILTERS.sort && [...fSort.options].some(o => o.value === TIENDAS_FILTERS.sort)) fSort.value = TIENDAS_FILTERS.sort;
  }

  // Persiste el estado actual de los filtros a nivel de modulo.
  function persistFilters() {
    TIENDAS_FILTERS = {
      name: fName.value,
      type: fType.value,
      statuses: [...selStatus],
      zone: fZone.value,
      sub: fSub.value,
      concept: fConcept.value,
      sort: fSort.value,
    };
  }

  let visibleRows = []; // filas actualmente filtradas (para exportar)

  // ----- Multi-select de estados -----
  const msWrap = $('#fStatusWrap'), msBtn = $('#fStatusBtn'), msMenu = $('#fStatusMenu'), msLabel = $('#fStatusLabel');
  function updateStatusLabel() {
    const n = selStatus.size;
    if (n === 0) msLabel.textContent = 'Sin estados';
    else if (n === statuses.length) msLabel.textContent = 'Todos los estados';
    else if (ACTIVE_STATES.length && n === ACTIVE_STATES.length && ACTIVE_STATES.every(s => selStatus.has(s)))
      msLabel.textContent = 'Activas';
    else if (n === 1) msLabel.textContent = /nulo|vac/i.test([...selStatus][0]) ? 'Sin estado' : [...selStatus][0];
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
    persistFilters();
    const n = fName.value.toLowerCase();
    const rows = CATALOG.companies.filter(c => {
      // El filtro de estados aplica a TIENDAS con estado real (Abierta/
      // Cerrada/etc.). Las empresas sin estado (no-tienda, o tiendas con
      // estado vacio/nulo) se muestran como "—" y NO se ocultan por este
      // filtro pensado para estados de tienda; solo se ocultan si el usuario
      // elige "Ninguno" (selStatus vacio).
      const isStore = c.type === 'Tienda';
      const hasStatus = !!(c.status && !/nulo|vac/i.test(c.status));
      const passStatus = selStatus.size === 0 ? false
        : !hasStatus ? true
        : selStatus.has(c.status);
      return (`${c.code} ${c.name || ''}`.toLowerCase().includes(n))
        && (fType.value === 'ALL' || c.type === fType.value)
        && passStatus
        && (fZone.value === 'ALL' || c.zoneId === fZone.value)
        && (fSub.value === 'ALL' || c.subzoneId === fSub.value)
        && (fConcept.value === 'ALL' || c.concept === fConcept.value);
    });
    // Orden por sincronizacion (por dias) o por codigo (default). Empresas
    // sin carga (rosterAt nulo) van al final en "reciente" y al principio en
    // "antigua/nunca" (son las que mas necesitan sincronizarse).
    const sortMode = fSort.value;
    if (sortMode === 'sync_recent' || sortMode === 'sync_old') {
      const ts = c => { const t = c.rosterAt ? Date.parse(c.rosterAt) : NaN; return isNaN(t) ? null : t; };
      rows.sort((a, b) => {
        const ta = ts(a), tb = ts(b);
        if (ta == null && tb == null) return a.code < b.code ? -1 : 1;
        if (sortMode === 'sync_recent') {
          if (ta == null) return 1;
          if (tb == null) return -1;
          return tb - ta;
        }
        if (ta == null) return -1;
        if (tb == null) return 1;
        return ta - tb;
      });
    }
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
          ${isEditor ? '' : `<button class="email-edit" data-code="${c.code}" data-name="${(c.name||'').replace(/"/g,'')}" data-email="${c.email||''}" data-phone="${c.phone||''}" data-phone2="${c.phone2||''}" title="Editar contacto">${I.pencil}</button>`}
        </div>`;
      return `
      <tr>
        <td class="code-cell"><div class="alias ${tyClass(c.type)}">${c.code}</div>${c.dataArea ? `<div class="darea">${c.dataArea}</div>` : ''}</td>
        <td class="name-cell"><div class="nm">${c.name || '—'}</div>${c.taxId ? `<div class="rif">RIF ${c.taxId}</div>` : ''}</td>
        <td>${typePill(c.type)}</td>
        <td class="zc-cell"><div class="zc1">${c.zone || '—'}${c.subzone ? ' · ' + c.subzone : ''}</div><div class="zc2">${c.concept || '—'}</div></td>
        <td>${contacto}</td>
        <td>${personalCell(c)}</td>
        <td>${statusPill(c.status)}</td>
        <td class="${c.hasAccess ? 'ico-ok' : 'ico-no'}">${c.hasAccess ? I.check : I.circle}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn btn-mini" data-photos-code="${c.code}" data-photos-name="${(c.name||'').replace(/"/g,'')}" style="margin-right:4px">Personal</button>${(!isEditor && NON_STORE_TYPES.has(c.type)) ? `<button class="btn btn-mini" data-dep-code="${c.code}" style="margin-right:4px">Departamentos</button>` : ''}${isEditor ? '' : `<button class="btn btn-mini" data-report-code="${c.code}" data-report-name="${(c.name||'').replace(/"/g,'')}">Reportar</button>`}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="9" class="empty">Sin resultados.</td></tr>';

    $('#tBody').querySelectorAll('.email-edit').forEach(b =>
      b.addEventListener('click', () => contactEditModal(user, b.dataset)));
    $('#tBody').querySelectorAll('[data-report-code]').forEach(b =>
      b.addEventListener('click', () => {
        const rc = CATALOG.companies.find(x => x.code === b.dataset.reportCode);
        const u = { ...user, pickedCompany: b.dataset.reportCode, pickedCompanyName: b.dataset.reportName, pickedCompanyType: rc ? rc.type : null };
        openReportPicker(u, () => viewTiendas(user));
      }));
    $('#tBody').querySelectorAll('[data-photos-code]').forEach(b =>
      b.addEventListener('click', () => {
        // Admin/superadmin entra a las fichas/fotos de la empresa elegida.
        // El "Volver" regresa a la lista de Empresas. Si la empresa NO es
        // tienda, se entra en modo 'enterprise' (carga por Reporte AX).
        const c = CATALOG.companies.find(x => x.code === b.dataset.photosCode);
        const mode = c && NON_STORE_TYPES.has(c.type) ? 'enterprise' : 'store';
        currentView = 'fotos';
        document.querySelectorAll('#pnlNav button').forEach(x => x.classList.remove('active'));
        renderWorkerPhotos(user, b.dataset.photosCode, () => { currentView = 'tiendas'; CATALOG = null; navigate('tiendas', user); }, { mode });
      }));
    $('#tBody').querySelectorAll('[data-dep-code]').forEach(b =>
      b.addEventListener('click', () => {
        const c = CATALOG.companies.find(x => x.code === b.dataset.depCode);
        if (!c) return;
        renderDepartments(user, c, () => { navigate('tiendas', user); });
      }));
  }

  fZone.addEventListener('change', () => { fillSubs(); render(); });
  [fName, fSub, fConcept].forEach(e => e.addEventListener('input', render));
  fType.addEventListener('change', render);
  fSort.addEventListener('change', render);
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

  // Sincronizar todo (solo admin): recorre las empresas visibles.
  const syncAllBtn = $('#syncAllBtn');
  if (syncAllBtn) syncAllBtn.addEventListener('click', () => openSyncAllModal(user, visibleRows));
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

/* ---------- Sincronizar todo (admin): recorre las empresas visibles ----------
   La API de AX exige alias, asi que no hay un llamado masivo: se itera empresa
   por empresa (axRosterPull por alias) en secuencia, con barra de progreso y
   bitacora. "El ultimo reporte manda": la lista de AX reemplaza el roster de
   cada empresa; fotos y contacto se conservan. Al cerrar, refresca la grilla. */
function openSyncAllModal(user, rows) {
  const list = (rows || []).slice();
  const total = list.length;

  openModal(`
    <div class="modal-head"><span>Sincronizar personal desde AX</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 12px">Trae el personal de AX para las <b>${total}</b> empresa(s) visibles (según el filtro actual), una por una. Tip: ordená por “Sinc.: antigua / nunca primero” y filtrá para actualizar solo las pendientes.</p>
    <div class="sa-okbox">✓ <b>El último reporte manda:</b> la lista de AX reemplaza el roster de cada empresa. Las fotos y los datos de contacto (teléfono/correo/dirección) se conservan.</div>
    <div id="saProg" style="display:none;margin-top:14px">
      <div class="sa-bar"><div class="sa-fill" id="saFill"></div></div>
      <p id="saStat" class="muted" style="font-size:12.5px;margin:8px 0 6px"></p>
      <div id="saLog" class="sa-log"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="saCancel">Cancelar</button>
      <button class="btn btn-primary" id="saStart"${total ? '' : ' disabled'}>Comenzar (${total})</button>
    </div>`);

  let phase = 'idle';   // idle | running | done
  let stopped = false;
  let anySynced = false;

  const fillEl = $('#saFill'), statEl = $('#saStat'), logEl = $('#saLog');
  const setFill = p => { if (fillEl) fillEl.style.width = Math.round(p) + '%'; };
  const logRow = (code, ok, info) => {
    if (!logEl) return;
    const row = document.createElement('div');
    const cls = ok === 'skip' ? 'skip' : (ok ? 'ok' : 'fail');
    const icon = ok === 'skip' ? '–' : (ok ? '✓' : '✕');
    row.className = 'sa-row ' + cls;
    row.innerHTML = `<span class="c">${code}</span><span class="r">${icon} ${info}</span>`;
    logEl.appendChild(row); logEl.scrollTop = logEl.scrollHeight;
  };
  const closeAndMaybeRefresh = () => {
    closeModal();
    if (anySynced) { CATALOG = null; navigate('tiendas', user); }
  };

  $('#mX').addEventListener('click', () => { if (phase !== 'running') closeAndMaybeRefresh(); });
  $('#saCancel').addEventListener('click', () => {
    if (phase === 'running') { stopped = true; const b = $('#saCancel'); b.textContent = 'Deteniendo…'; b.disabled = true; }
    else closeAndMaybeRefresh();
  });

  $('#saStart').addEventListener('click', async () => {
    if (!total || phase === 'running') return;
    phase = 'running';
    $('#saStart').style.display = 'none';
    $('#saCancel').textContent = 'Detener';
    $('#saProg').style.display = 'block';
    const uploadedBy = user.name || user.username || 'admin';
    let ok = 0, fail = 0, skipped = 0;
    for (let i = 0; i < list.length; i++) {
      if (stopped) break;
      const c = list[i];
      if (statEl) statEl.textContent = `(${i + 1}/${total}) ${c.code} — ${c.name || ''}…`;
      setFill(i / total * 100);
      let r;
      try { r = await axRosterPull(c.code, { uploadedBy, adminId: user.id, source: 'bulk' }); }
      catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
      if (r && r.ok) {
        ok++; anySynced = true;
        const s = r.summary || {};
        const chg = s.changes ? ` · ${s.changes} cambio${s.changes === 1 ? '' : 's'}` : '';
        logRow(c.code, true, `${s.total != null ? s.total : '?'} personas${chg}`);
      } else if (r && r.error === 'cooldown') {
        skipped++; logRow(c.code, 'skip', rosterCooldownMessage(r));
      } else {
        fail++; logRow(c.code, false, (r && r.error) || 'error');
      }
      setFill((i + 1) / total * 100);
    }
    phase = 'done';
    setFill(100);
    const omit = skipped ? `, <b>${skipped}</b> omitida(s) por limite` : '';
    if (statEl) statEl.innerHTML = stopped
      ? `Detenido · <b>${ok}</b> sincronizada(s), <b>${fail}</b> con error${omit}.`
      : `Listo · <b>${ok}</b> sincronizada(s), <b>${fail}</b> con error${omit} de ${total}.`;
    const b = $('#saCancel'); b.disabled = false; b.textContent = 'Cerrar';
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
/* Los modales se cierran SOLO con sus botones (X / Cancelar / accion). No se
   cierran al hacer clic afuera, para evitar perder lo escrito por un clic
   accidental fuera del recuadro. */
function openModal(html) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.id = 'modalOv';
  ov.innerHTML = `<div class="modal-box">${html}</div>`;
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
    <div class="pnl-head" style="padding-top:0">
      <p id="cuCount" class="muted" style="font-size:13px;margin:0"></p>
      <div class="export-wrap">
        <button class="btn" id="cuExportBtn">Exportar ▾</button>
        <div class="export-menu" id="cuExportMenu" hidden>
          <button data-fmt="xlsx">Excel (.xlsx)</button>
          <button data-fmt="csv">CSV (.csv)</button>
          <button data-fmt="txt">Texto (.txt)</button>
        </div>
      </div>
    </div>
    <div class="pnl-filters">
      <div class="search">${I.search}<input id="cuName" placeholder="Buscar compañía o código…"></div>
      <select id="cuType"><option value="Tienda">Tipo: Tienda</option>${types.filter(t=>t!=='Tienda').map(t=>`<option>${t}</option>`).join('')}<option value="ALL">Todos los tipos</option></select>
      <select id="cuAccess"><option value="ALL">Todas</option><option value="yes">Con acceso</option><option value="no">Sin acceso</option></select>
    </div>
    <div class="tablebox"><table><thead><tr>
      <th>Código</th><th>Compañía</th><th>Tipo</th><th>Usuario</th><th>Correo</th><th>Teléfono</th><th>Estado</th><th style="text-align:right">Acciones</th>
    </tr></thead><tbody id="cuBody"></tbody></table></div>`;

  let cuVisible = [];   // filas actualmente filtradas (para exportar)

  const fName = $('#cuName'), fType = $('#cuType'), fAccess = $('#cuAccess');
  function render() {
    const n = fName.value.toLowerCase();
    const rows = CU_ROWS.filter(r =>
      (`${r.code} ${r.name || ''}`.toLowerCase().includes(n))
      && (fType.value === 'ALL' || r.type === fType.value)
      && (fAccess.value === 'ALL' || (fAccess.value === 'yes' ? !!r.user : !r.user)));
    cuVisible = rows;
    $('#cuCount').textContent = `${rows.length} de ${CU_ROWS.length} compañías`;
    $('#cuBody').innerHTML = rows.map(r => {
      const u = r.user;
      // Correo: el del usuario si existe; si no, el de la compañía.
      const correo = (u && u.email) || r.companyEmail || null;
      const correoCell = correo
        ? correo
        : '<span class="muted" style="font-size:12px">—</span>';
      // Teléfono: de la compañía (no vive en el usuario). Muestra ambos si hay.
      const tel = phoneDisplay(r.companyPhone);
      const tel2 = phoneDisplay(r.companyPhone2);
      const telLine = [tel, tel2].filter(Boolean).join(' / ');
      const telCell = telLine || '<span class="muted" style="font-size:12px">—</span>';
      const userCell = u
        ? `<span class="code">${r.code}</span>`
        : '<span class="muted" style="font-size:12px">— sin usuario —</span>';
      const stateCell = u
        ? (u.is_active ? '<span class="pill pill-open">Activo</span>' : '<span class="pill pill-closed">Inactivo</span>')
        : '<span class="pill pill-gray">Sin acceso</span>';
      const actions = u
        ? `<button class="btn btn-mini" data-act="email" data-code="${r.code}" data-name="${(r.name||'').replace(/"/g,'')}" data-email="${(u.email||'').replace(/"/g,'')}">${I.pencil} Correo</button>
           <button class="btn btn-mini" data-act="reset" data-code="${r.code}">${I.key} Resetear</button>
           <button class="btn btn-mini" data-act="toggle" data-code="${r.code}" data-active="${u.is_active}">${u.is_active ? 'Desactivar' : 'Activar'}</button>`
        : `<button class="btn btn-mini btn-primary" data-act="create" data-code="${r.code}" data-name="${(r.name||'').replace(/"/g,'')}" data-type="${r.type||''}" data-email="${r.companyEmail||''}">${I.plus} Crear acceso</button>`;
      return `<tr><td class="code">${r.code}</td><td>${r.name || '—'}</td>
        <td><span class="pill pill-gray">${r.type || '—'}</span></td>
        <td style="font-size:13px">${userCell}</td>
        <td style="font-size:13px">${correoCell}</td>
        <td style="font-size:13px">${telCell}</td>
        <td>${stateCell}</td>
        <td style="text-align:right;white-space:nowrap">${actions}</td></tr>`;
    }).join('') || '<tr><td colspan="8" class="empty">Sin resultados.</td></tr>';

    $('#cuBody').querySelectorAll('button[data-act]').forEach(b =>
      b.addEventListener('click', () => cuAction(b.dataset, user)));
  }
  [fName].forEach(e => e.addEventListener('input', render));
  [fType, fAccess].forEach(e => e.addEventListener('change', render));
  render();

  // Exportación (menú desplegable) de la grilla de accesos.
  const cuExpBtn = $('#cuExportBtn'), cuExpMenu = $('#cuExportMenu');
  cuExpBtn.addEventListener('click', (e) => { e.stopPropagation(); cuExpMenu.hidden = !cuExpMenu.hidden; });
  document.addEventListener('click', () => { cuExpMenu.hidden = true; });
  cuExpMenu.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { cuExpMenu.hidden = true; exportUsuariosPortal(b.dataset.fmt, cuVisible); }));
}

/* Exportación de la grilla de Accesos al portal (xlsx / csv / txt) */
async function exportUsuariosPortal(fmt, rows) {
  const data = (rows || []).map(r => {
    const u = r.user;
    return {
      'Código': r.code,
      'Compañía': r.name || '',
      'Tipo': r.type || '',
      'Usuario': u ? r.code : '',
      'Correo': (u && u.email) || r.companyEmail || '',
      'Teléfono 1': phoneDisplay(r.companyPhone) || '',
      'Teléfono 2': phoneDisplay(r.companyPhone2) || '',
      'Estado': u ? (u.is_active ? 'Activo' : 'Inactivo') : 'Sin acceso',
    };
  });
  if (!data.length) { alert('No hay filas para exportar con los filtros actuales.'); return; }
  const headers = Object.keys(data[0]);
  const fname = `accesos_portal_${tstamp()}`;

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
      window.XLSX.utils.book_append_sheet(wb, ws, 'Accesos');
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (e) {
      alert(e.message + ' Revisa tu conexión e inténtalo de nuevo.');
    }
    return;
  }
}

/* ===== Pestana USUARIOS OSTICKET (sincronizacion) =====
   Lista las tiendas con su estado en osTicket (sincronizada / pendiente /
   sin correo) y permite crear/re-sincronizar el usuario-tienda (el "From"
   de los tickets), individual o masivamente. Reusa /api/osticket-users. */
let OU_ROWS = null;
let OU_SUMMARY = null;
let OU_FILTER = 'all';   // all | synced | pending | no_email
let OU_USER = null;      // user de la sesion (para que ouRender/ouSyncOne no dependan del parametro)

async function usuariosOsticketTab(user, body) {
  OU_USER = user;   // fijar el user de sesion para ouRender/ouSyncOne
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
  $('#ouSyncAll').addEventListener('click', () => ouSyncAll(OU_USER));
  ouRender();
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

function ouRender() {
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
    b.addEventListener('click', () => ouSyncOne(OU_USER, b.dataset.ousync, b)));
}

/* Sincroniza UNA tienda (boton de fila). */
async function ouSyncOne(user, code, btn) {
  user = user || OU_USER;   // respaldo: nunca depender de un user nulo
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Sincronizando…';
  const d = await ouApi({ action: 'sync', adminId: user.id, codes: [code] });
  if (!d.ok) { alert(d.error || 'No se pudo sincronizar.'); btn.disabled = false; btn.textContent = orig; return; }
  const r = (d.results && d.results[0]) || null;
  if (r && !r.ok) { alert(`${code}: ${r.error || 'error'}`); btn.disabled = false; btn.textContent = orig; return; }
  // refrescar la pestana para reflejar el nuevo estado + tarjetas
  usuariosOsticketTab(user, $('#usersBody'));
}

/* Sincroniza TODAS las pendientes con correo (boton masivo).
   Abre un modal de progreso (barra + bitacora + conteo) e itera por dentro
   las TANDAS que exige el limite de subrequests de Cloudflare, hasta
   terminar TODAS. El usuario ve un solo proceso que avanza solo; no tiene
   que volver a pulsar el boton. Mismo patron que "Sincronizar todo" de
   Empresas (sin alert/confirm nativos: modal propio). */
async function ouSyncAll(user) {
  user = user || OU_USER;   // respaldo: nunca depender de un user nulo
  const pend = OU_SUMMARY ? OU_SUMMARY.pending : 0;
  if (!pend) {
    openModal(`
      <div class="modal-head"><span>Sincronizar en osTicket</span><button class="modal-x" id="mX">\u2715</button></div>
      <p style="margin:0 0 4px">No hay tiendas pendientes con correo para sincronizar.</p>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Las tiendas sin correo aparecen como \u201cSin correo\u201d; cargales un correo en Empresas para poder crearlas.</p>
      <div class="modal-actions"><button class="btn btn-primary" id="mOk">Entendido</button></div>`);
    $('#mX').addEventListener('click', closeModal);
    $('#mOk').addEventListener('click', closeModal);
    return;
  }

  openModal(`
    <div class="modal-head"><span>Sincronizar tiendas en osTicket</span><button class="modal-x" id="mX">\u2715</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 12px">Se crearan o actualizaran los usuarios-tienda (el remitente de los tickets) de las <b>${pend}</b> tienda(s) pendientes con correo. El proceso avanza por tandas automaticamente; puede tardar un momento.</p>
    <div class="sa-okbox">\u2713 Cada tienda se crea una sola vez; re-ejecutar es seguro (idempotente). Las que fallen por datos quedan pendientes y puedes reintentar.</div>
    <div id="ouProg" style="display:none;margin-top:14px">
      <div class="sa-bar"><div class="sa-fill" id="ouFill"></div></div>
      <p id="ouStat" class="muted" style="font-size:12.5px;margin:8px 0 6px"></p>
      <div id="ouLog" class="sa-log"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="ouCancel">Cancelar</button>
      <button class="btn btn-primary" id="ouStart">Comenzar (${pend})</button>
    </div>`);

  let phase = 'idle';   // idle | running | done
  let stopped = false;

  const fillEl = $('#ouFill'), statEl = $('#ouStat'), logEl = $('#ouLog');
  const setFill = p => { if (fillEl) fillEl.style.width = Math.round(p) + '%'; };
  const logRow = (code, ok, info) => {
    if (!logEl) return;
    const row = document.createElement('div');
    row.className = 'sa-row ' + (ok ? 'ok' : 'fail');
    row.innerHTML = `<span class="c">${code}</span><span class="r">${ok ? '\u2713' : '\u2715'} ${info}</span>`;
    logEl.appendChild(row); logEl.scrollTop = logEl.scrollHeight;
  };
  const closeAndRefresh = () => { closeModal(); usuariosOsticketTab(user, $('#usersBody')); };

  $('#mX').addEventListener('click', () => { if (phase !== 'running') closeAndRefresh(); });
  $('#ouCancel').addEventListener('click', () => {
    if (phase === 'running') { stopped = true; const b = $('#ouCancel'); b.textContent = 'Deteniendo\u2026'; b.disabled = true; }
    else closeAndRefresh();
  });

  $('#ouStart').addEventListener('click', async () => {
    if (phase === 'running') return;
    phase = 'running';
    $('#ouStart').style.display = 'none';
    $('#ouCancel').textContent = 'Detener';
    $('#ouProg').style.display = 'block';

    const LIMIT = 12;          // tiendas por tanda (servidor tope 20)
    const totalAtStart = pend;
    let okTotal = 0, failTotal = 0, batches = 0;
    let lastRemaining = Infinity;
    let guard = 0;
    const maxGuard = Math.ceil(totalAtStart / LIMIT) + 8;

    while (!stopped) {
      guard++;
      if (guard > maxGuard) break;
      if (statEl) statEl.textContent = `Tanda ${batches + 1}\u2026 (${okTotal}/${totalAtStart} sincronizadas)`;
      let d;
      try {
        d = await ouApi({ action: 'sync', adminId: user.id, all: true, limit: LIMIT });
      } catch (e) {
        logRow('\u2014', false, 'Error de conexion: ' + (e && e.message || e));
        break;
      }
      if (!d.ok) { logRow('\u2014', false, d.error || 'No se pudo sincronizar.'); break; }
      // Bitacora por tienda de esta tanda.
      (d.results || []).forEach(r => {
        if (r.ok) logRow(r.code, true, r.created ? 'creada' : 'actualizada');
        else logRow(r.code, false, r.error || 'error');
      });
      okTotal += d.ok_count || 0;
      failTotal += d.fail_count || 0;
      batches++;
      // Progreso por lo que falta (remaining) respecto al total inicial.
      const done = Math.max(0, totalAtStart - (d.remaining || 0));
      setFill(totalAtStart ? done / totalAtStart * 100 : 100);
      if (d.done || d.remaining === 0) break;
      // Corte de seguridad: si remaining no baja, las que quedan fallan siempre.
      if (d.remaining >= lastRemaining) {
        if (statEl) statEl.innerHTML = `Se detuvo el avance: <b>${d.remaining}</b> tienda(s) no se pudieron sincronizar (revisa sus datos en osTicket).`;
        break;
      }
      lastRemaining = d.remaining;
      await new Promise(r => setTimeout(r, 400));   // respiro entre tandas
    }

    phase = 'done';
    setFill(100);
    if (statEl) statEl.innerHTML = stopped
      ? `Detenido \u00b7 <b>${okTotal}</b> sincronizada(s)${failTotal ? `, <b>${failTotal}</b> con error` : ''}.`
      : `Listo \u00b7 <b>${okTotal}</b> sincronizada(s)${failTotal ? `, <b>${failTotal}</b> con error` : ''} en ${batches} tanda(s).`;
    const b = $('#ouCancel'); b.disabled = false; b.textContent = 'Cerrar';
  });
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
  if (ds.act === 'email') {
    openModal(`
      <div class="modal-head"><span>Editar correo del usuario</span><button class="modal-x" id="mX">✕</button></div>
      <p class="muted" style="font-size:12.5px;margin:0 0 16px">${ds.code}${ds.name ? ' · ' + ds.name : ''}</p>
      <label class="flabel">Correo del usuario <span class="muted">(acceso al portal)</span></label>
      <input type="text" id="cuEmailEdit" value="${ds.email || ''}" placeholder="usuario@grupocanaima.com" style="margin-bottom:8px">
      <p class="muted" style="font-size:11.5px;margin:0">Es uno de los identificadores de inicio de sesión (la compañía también puede entrar con su código ${ds.code}). Déjalo vacío para quitarlo.</p>
      <div class="modal-actions">
        <button class="btn" id="mCancel">Cancelar</button>
        <button class="btn btn-primary" id="mOk">Guardar</button>
      </div>`);
    $('#mX').addEventListener('click', closeModal);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mOk').addEventListener('click', async () => {
      const d = await cuApi({ action: 'update_email', adminId: user.id, companyCode: ds.code, email: $('#cuEmailEdit').value });
      if (!d.ok) { alert(d.error); return; }
      closeModal();
      viewUsuarios(user);
    });
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
        <td><span class="pill ${a.role === 'superadmin' ? 'pill-proj' : 'pill-gray'}">${ROLE_LABELS[a.role] || a.role}</span></td>
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
    <label class="flabel">Usuario</label><input id="auU" placeholder="ej. nombre.apellido" style="margin-bottom:12px">
    <label class="flabel">Nombre</label><input id="auN" placeholder="Nombre completo" style="margin-bottom:12px">
    <label class="flabel">Correo <span class="muted">(opcional)</span></label><input id="auE" placeholder="correo@grupocanaima.com" style="margin-bottom:12px">
    <label class="flabel">Rol</label>
    <select id="auR" style="margin-bottom:14px;width:100%"><option value="admin">admin</option><option value="editor_personal">Editor de personal</option><option value="superadmin">superadmin</option></select>
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
    <div class="pnl-head"><div><h1>Permisos</h1><p>Alcance de cada admin · Tiendas y Empresas por separado · el superadmin ve todo</p></div></div>
    ${admins.length === 0 ? '<div class="card"><p class="muted" style="margin:0">No hay admins (no superadmin) aún. Crea uno en la sección Equipo.</p></div>' : `
    <div class="tablebox"><table><thead><tr>
      <th>Usuario</th><th>Nombre</th><th>Rol</th><th>Estado</th><th style="text-align:right">Alcance</th>
    </tr></thead><tbody>
      ${admins.map(a => `<tr>
        <td class="code">${a.username}</td><td>${a.name || '—'}</td>
        <td><span class="pill pill-gray">${ROLE_LABELS[a.role] || a.role}</span></td>
        <td>${a.is_active ? '<span class="pill pill-open">Activo</span>' : '<span class="pill pill-closed">Inactivo</span>'}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn btn-mini" data-id="${a.id}" data-u="${a.username}" data-kind="store" style="margin-right:4px">${I.sliders} Tiendas</button><button class="btn btn-mini" data-id="${a.id}" data-u="${a.username}" data-kind="enterprise">${I.sliders} Empresas</button></td>
      </tr>`).join('')}
    </tbody></table></div>`}`;
  $('#pnlMain').querySelectorAll('button[data-id]').forEach(b =>
    b.addEventListener('click', () => openScopeEditor(user, b.dataset.id, b.dataset.u, b.dataset.kind || 'store')));
}

async function openScopeEditor(user, targetId, targetUser, kind = 'store') {
  $('#pnlMain').innerHTML = `<div class="pnl-loading">Cargando alcance…</div>`;
  const d = await fetch('/api/admin-scope', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get', adminId: user.id, targetId }),
  }).then(r => r.json());
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }

  SCOPE = {
    target: targetId, targetUser,
    kind, isEnt: kind === 'enterprise',
    include: d.include.map(x => ({ ...x })),
    exclude: d.exclude.map(x => ({ ...x })),
    zones: d.zones, subzones: d.subzones, companies: d.companies,
    departments: d.departments || [],
  };

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Alcance de ${SCOPE.isEnt ? 'Empresas' : 'Tiendas'} · ${targetUser}</h1>
      <p>${SCOPE.isEnt ? 'Define qué empresas (no tiendas) o departamentos puede gestionar. Alcance final = incluidos − excluidos.' : 'Define qué tiendas puede gestionar. Alcance final = incluidos − excluidos.'}</p></div>
      <button class="btn" id="scBack">← Volver</button></div>
    <div class="card">
      <div class="sc-add">
        <select id="scLevel">
          ${SCOPE.isEnt
            ? '<option value="company">Empresa (todo)</option><option value="department">Departamento</option>'
            : '<option value="zone">Zona</option><option value="subzone">Subzona</option><option value="company">Tienda</option>'}
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
  if (type === 'department') {
    const dep = SCOPE.departments.find(d => String(d.id) === String(value));
    const cc = dep ? dep.company_code : '';
    const comp = SCOPE.companies.find(c => c.company_code === cc);
    return `Depto: ${dep ? dep.name : value}${cc ? ' · ' + cc : ''}${comp ? ' (' + comp.business_name + ')' : ''}`;
  }
  const c = SCOPE.companies.find(c => c.company_code === value);
  const noun = (c && NON_STORE_TYPES.has(c.company_type)) ? 'Empresa' : 'Tienda';
  return `${noun}: ${value}${c ? ' · ' + c.business_name : ''}`;
}

function renderScResults() {
  const level = $('#scLevel').value;
  const q = $('#scSearch').value.toLowerCase();
  let opts = [];
  if (level === 'zone') opts = SCOPE.zones.map(z => ({ value: String(z.id), label: z.name }));
  else if (level === 'subzone') opts = SCOPE.subzones.map(s => ({ value: String(s.id), label: s.name }));
  else if (level === 'department') {
    const nonStore = new Set(SCOPE.companies.filter(c => NON_STORE_TYPES.has(c.company_type)).map(c => c.company_code));
    opts = SCOPE.departments.filter(d => nonStore.has(d.company_code)).map(d => {
      const comp = SCOPE.companies.find(c => c.company_code === d.company_code);
      return { value: String(d.id), label: `${d.company_code} · ${d.name}${comp ? ' — ' + comp.business_name : ''}` };
    });
  }
  else {
    const comps = SCOPE.companies.filter(c => SCOPE.isEnt
      ? NON_STORE_TYPES.has(c.company_type)
      : !NON_STORE_TYPES.has(c.company_type));
    opts = comps.map(c => ({ value: c.company_code, label: `${c.company_code} · ${c.business_name}` }));
  }
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

// Filtra que items de alcance se MUESTRAN segun el modo (Tiendas/Empresas).
// Los que no matchean siguen en SCOPE (se conservan al guardar): asi el
// editor de Empresas no pisa el alcance de Tiendas ni viceversa.
function scopeMatchesMode(x) {
  if (SCOPE.isEnt) {
    if (x.scope_type === 'department') return true;
    if (x.scope_type !== 'company') return false;
    const c = SCOPE.companies.find(c => c.company_code === x.scope_value);
    return !!(c && NON_STORE_TYPES.has(c.company_type));
  }
  // modo Tiendas: los departamentos pertenecen a Empresas, no se muestran aqui
  if (x.scope_type === 'department') return false;
  if (x.scope_type !== 'company') return true;
  const c = SCOPE.companies.find(c => c.company_code === x.scope_value);
  return !c || !NON_STORE_TYPES.has(c.company_type);
}

function renderScopeLists() {
  const mk = (bucket) => SCOPE[bucket].filter(scopeMatchesMode).map(x =>
    `<div class="sc-item"><span>${scopeLabel(x.scope_type, x.scope_value)}</span>
      <button data-b="${bucket}" data-t="${x.scope_type}" data-v="${x.scope_value}" title="Quitar">✕</button></div>`
  ).join('') || '<div class="muted" style="padding:8px">Vacío.</div>';
  $('#scIncList').innerHTML = mk('include');
  $('#scExcList').innerHTML = mk('exclude');
  $('#scIncN').textContent = SCOPE.include.filter(scopeMatchesMode).length;
  $('#scExcN').textContent = SCOPE.exclude.filter(scopeMatchesMode).length;
  document.querySelectorAll('.sc-item button').forEach(b =>
    b.addEventListener('click', () => removeScope(b.dataset.b, b.dataset.t, b.dataset.v)));

  const est = estimateScope();
  $('#scSummary').innerHTML = `<span class="muted">Resultado estimado:</span> <strong>${est}</strong> ${SCOPE.isEnt ? 'empresas' : 'tiendas'} gestionables.`;
}

// Estima cuántas tiendas/empresas quedan en el alcance (include − exclude),
// contando IGUAL que la funcion real get_admin_companies: el universo de
// zona/subzona/departamento es SOLO empresas activas; las empresas asignadas
// por codigo se cuentan aparte, esten activas o no.
function estimateScope() {
  const universe = SCOPE.companies.filter(c => c.is_active && (SCOPE.isEnt
    ? NON_STORE_TYPES.has(c.company_type)
    : !NON_STORE_TYPES.has(c.company_type)));
  const inSet = new Set();
  const deptCompany = (val) => { const d = SCOPE.departments.find(d => String(d.id) === String(val)); return d ? d.company_code : null; };
  SCOPE.include.filter(scopeMatchesMode).forEach(x => {
    if (x.scope_type === 'zone') universe.filter(c => String(c.zone_id) === String(x.scope_value)).forEach(c => inSet.add(c.company_code));
    else if (x.scope_type === 'subzone') universe.filter(c => String(c.subzone_id) === String(x.scope_value)).forEach(c => inSet.add(c.company_code));
    else if (x.scope_type === 'department') { const cc = deptCompany(x.scope_value); if (cc) inSet.add(cc); }
    else inSet.add(x.scope_value);
  });
  SCOPE.exclude.filter(scopeMatchesMode).forEach(x => {
    if (x.scope_type === 'zone') universe.filter(c => String(c.zone_id) === String(x.scope_value)).forEach(c => inSet.delete(c.company_code));
    else if (x.scope_type === 'subzone') universe.filter(c => String(c.subzone_id) === String(x.scope_value)).forEach(c => inSet.delete(c.company_code));
    else if (x.scope_type === 'department') { /* excluir un depto no quita la empresa del conteo */ }
    else inSet.delete(x.scope_value);
  });
  return inSet.size;
}

/* Copia un texto al portapapeles y da feedback breve en el botón.
   Usa el API moderno y cae a execCommand si el navegador no lo permite. */
async function copyToClipboard(text, btn) {
  const done = () => {
    if (!btn) return;
    const orig = btn.dataset.orig || btn.textContent;
    btn.dataset.orig = orig;
    btn.textContent = '✓ Copiado';
    btn.classList.add('ok');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('ok'); }, 1400);
  };
  try {
    await navigator.clipboard.writeText(text);
    done();
  } catch {
    // Fallback: seleccionar un textarea temporal y ejecutar copy
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy'); ta.remove();
      done();
    } catch { alert('No se pudo copiar automáticamente. Selecciona el texto y cópialo a mano.'); }
  }
}

/* Una fila "campo + botón copiar": valor en input readonly seleccionable. */
function copyFieldHtml(label, value, id) {
  return `
    <div style="margin-bottom:12px">
      <label class="flabel" style="display:block;margin-bottom:5px">${label}</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="${id}" value="${String(value).replace(/"/g, '&quot;')}" readonly
          onclick="this.select()"
          style="flex:1;font-family:monospace;font-size:14px;background:var(--bg-soft,#f5f5f7)">
        <button class="btn" data-copy="${id}" type="button" style="white-space:nowrap">Copiar</button>
      </div>
    </div>`;
}

/* Modal de resultado de la sincronización con osTicket. Muestra el conteo y,
   si se creó el agente, el usuario y la clave temporal en campos copiables. */
function scopeResultModal(user, p, targetUser) {
  const staffTag = p.staff_id ? ` <span class="muted">(#${p.staff_id})</span>` : '';
  const pend = p.scope_pending_user > 0
    ? `<p class="muted" style="font-size:12px;margin:6px 0 0;line-height:1.5">`
      + `${p.scope_pending_user} tienda(s) de su alcance aún no tienen usuario en osTicket; `
      + `se sumarán a medida que las sincronices en Usuarios → osTicket.</p>`
    : '';

  // Bloque de credenciales: solo cuando se creó el agente en esta corrida.
  const creds = (p.agent_created && p.temp_password) ? `
    <div style="margin-top:16px;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft,#f7f7f9)">
      <p class="flabel" style="margin:0 0 10px;display:flex;align-items:center;gap:6px">🔑 Credenciales del nuevo agente</p>
      ${copyFieldHtml('Usuario', targetUser, 'scrUser')}
      ${copyFieldHtml('Clave temporal', p.temp_password, 'scrPass')}
      <button class="btn" data-copy-both type="button" style="width:100%;margin-top:2px">Copiar usuario y clave juntos</button>
      <p class="muted" style="font-size:11.5px;margin:10px 0 0;line-height:1.5">`
      + `Entrégaselas a <b>${targetUser}</b>. La clave la deberá cambiar al entrar por primera vez. `
      + `<b>No se vuelve a mostrar</b>, cópiala ahora.</p>
    </div>` : '';

  openModal(`
    <div class="modal-head"><span>Alcance sincronizado con osTicket</span><button class="modal-x" id="mX">✕</button></div>
    <p style="margin:0 0 4px">✅ Alcance guardado y reflejado en osTicket.</p>
    <p style="margin:0">Agente: <b>${targetUser}</b>${staffTag}<br>
      Tiendas en su bandeja: <b>${p.scope_count}</b> de ${p.scope_total} con usuario en osTicket.</p>
    ${pend}
    ${creds}
    <div class="modal-actions">
      <button class="btn btn-primary" id="mClose">Listo</button>
    </div>`);

  const finish = () => { closeModal(); viewPermisos(user); };
  $('#mX').addEventListener('click', finish);
  $('#mClose').addEventListener('click', finish);
  // Cerrar al hacer clic fuera también vuelve a la lista
  const ov = document.getElementById('modalOv');
  if (ov) ov.addEventListener('click', e => { if (e.target === ov) finish(); });

  // Botones de copiado por campo
  document.querySelectorAll('[data-copy]').forEach(b =>
    b.addEventListener('click', () => {
      const el = document.getElementById(b.dataset.copy);
      if (el) { el.select(); copyToClipboard(el.value, b); }
    }));
  // Copiar ambos juntos (formato "Usuario: x  Clave: y")
  const both = document.querySelector('[data-copy-both]');
  if (both) both.addEventListener('click', () => {
    const u = document.getElementById('scrUser');
    const pw = document.getElementById('scrPass');
    if (u && pw) copyToClipboard(`Usuario: ${u.value}\nClave temporal: ${pw.value}`, both);
  });
}

async function saveScope(user) {
  const btn = $('#scSave'); btn.disabled = true; btn.textContent = 'Guardando…';
  const targetUser = SCOPE.targetUser || 'el agente';
  // 1) Guardar el alcance en el portal (la verdad). Esto no debe fallar por osTicket.
  const d = await fetch('/api/admin-scope', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save', adminId: user.id, targetId: SCOPE.target,
      include: SCOPE.include, exclude: SCOPE.exclude }),
  }).then(r => r.json());
  if (!d.ok) { alert(d.error); btn.disabled = false; btn.textContent = 'Guardar alcance'; return; }

  // Las EMPRESAS (no-tienda) no tienen bandeja de tienda en osTicket: el
  // alcance se guarda en el portal y no se sincroniza con osTicket.
  if (SCOPE.isEnt) { viewPermisos(user); return; }

  // 2) Empujar el alcance a osTicket (agente + bandeja). Reflejo del portal.
  btn.textContent = 'Sincronizando con osTicket…';
  let p;
  try {
    p = await fetch('/api/admin-scope', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'push_to_osticket', adminId: user.id, targetId: SCOPE.target }),
    }).then(r => r.json());
  } catch (e) {
    p = { ok: false, error: 'No se pudo contactar el servidor: ' + e.message };
  }

  if (!p || !p.ok) {
    // El alcance SÍ se guardó; solo falló el reflejo en osTicket.
    alert('⚠️ El alcance se guardó, pero no se pudo sincronizar con osTicket:\n'
      + ((p && p.error) || 'error desconocido')
      + '\n\nPuedes reintentar volviendo a guardar el alcance.');
    viewPermisos(user);
    return;
  }

  // 3) Resultado OK. Mostrar el modal con conteo y credenciales copiables.
  scopeResultModal(user, p, targetUser);
}

/* ---------- VISTA: placeholders ---------- */
function viewSoon(title, msg) {
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>${title}</h1></div></div>
    <div class="card"><p class="muted" style="margin:0">${msg}</p></div>`;
}

/* ---------- Modal de detalle de cambios (compartido) ----------
   Lo usan la grilla de empresas (Sincronizacion) y la de personal. */
function syncChangesModal(title, bodyHtml) {
  openModal(`
    <div class="modal-head"><span>${escHtml(title)}</span><button class="modal-x" id="mX">✕</button></div>
    <div style="max-height:60vh;overflow:auto;font-size:13px;line-height:1.8">${bodyHtml}</div>
    <div class="modal-actions"><button class="btn" id="mCancel">Cerrar</button></div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
}

/* ---------- VISTA: SINC. PERSONAL (admin / editor / superadmin) ----------
   Bitacora de sincronizaciones de personal (roster) con alcance por empresa.
   El detalle de cambios se carga a demanda y se muestra en un modal. */
async function rosterRunsApi(payload) {
  return fetch('/api/roster-runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(r => r.json());
}
function rosterChangeLine(c) {
  const ced = c.id_number ? ` <span class="muted">(${escHtml(c.id_number)})</span>` : '';
  const who = `<b>${escHtml(c.worker_name || c.id_number || '—')}</b>${c.worker_name && c.id_number ? ced : ''}`;
  if (c.change_type === 'new') return `<div>➕ Ingresó ${who}${c.new_value ? ` — ${escHtml(c.new_value)}` : ''}</div>`;
  if (c.change_type === 'removed') return `<div>➖ Salió de la lista ${who}</div>`;
  return `<div>🔄 ${who}: ${escHtml(c.old_value || '—')} → <b>${escHtml(c.new_value || '—')}</b></div>`;
}
async function viewRosterSync(user) {
  $('#pnlMain').innerHTML = `<div class="pnl-head"><div><h1>Sinc. Personal</h1><p>Sincronizaciones de personal desde AX</p></div></div><div class="pnl-loading">Cargando…</div>`;
  const res = await rosterRunsApi({ action: 'get', adminId: user.id });
  if (!res.ok) {
    $('#pnlMain').innerHTML = `<div class="pnl-head"><div><h1>Sinc. Personal</h1></div></div><div class="card"><p class="muted" style="margin:0">Error: ${escHtml(res.error || 'no se pudo cargar')}</p></div>`;
    return;
  }
  const runs = res.runs || [];
  const originLabel = (r) => (r.source === 'bulk' ? 'Todo' : 'Manual') + (r.triggered_by_name ? ' · ' + escHtml(r.triggered_by_name) : '');
  const resultCell = (r) => {
    if (r.status !== 'ok') return `<span style="color:var(--danger)">${escHtml((r.error || '').slice(0, 60))}</span>`;
    const s = r.result || {};
    return `${s.total != null ? s.total : '?'} pers.${s.active != null ? ` · ${s.active} act` : ''}`;
  };
  const changesCell = (r) => {
    if (!r.changes_count) return '<span class="muted">Sin cambios</span>';
    return `<button class="rs-chg" data-run="${r.id}" style="background:none;border:0;color:var(--brand,#2563eb);cursor:pointer;padding:0;font:inherit;text-decoration:underline">${r.changes_count} cambio${r.changes_count === 1 ? '' : 's'}</button>`;
  };
  const rows = runs.map(r => `<tr>
    <td>${fmtDeadline(r.finished_at || r.started_at)}</td>
    <td><b>${escHtml(r.company_code)}</b>${r.business_name ? `<br><span class="muted" style="font-size:11px">${escHtml(r.business_name)}</span>` : ''}</td>
    <td>${originLabel(r)}</td>
    <td>${r.status === 'ok' ? '<span class="pill pill-open">OK</span>' : '<span class="pill pill-closed">Error</span>'}</td>
    <td>${resultCell(r)}</td>
    <td>${changesCell(r)}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty">Aún no hay sincronizaciones de personal.</td></tr>';

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Sinc. Personal</h1><p>Últimas sincronizaciones de personal desde AX${runs.length ? ` · ${runs.length}` : ''}</p></div></div>
    <div class="card">
      <table class="cfg-cat-table"><thead><tr><th>Fecha</th><th>Empresa</th><th>Origen</th><th>Estado</th><th>Resultado</th><th>Cambios</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted" style="font-size:12px;margin:12px 2px 0">Muestra las sincronizaciones de personal de tus empresas (las tuyas y las que hizo cualquiera sobre ellas). Haz clic en los cambios para ver el detalle.</p>
    </div>`;

  $('#pnlMain').querySelectorAll('.rs-chg').forEach(btn =>
    btn.addEventListener('click', async () => {
      const run = runs.find(x => String(x.id) === btn.dataset.run);
      btn.disabled = true;
      const d = await rosterRunsApi({ action: 'changes', adminId: user.id, run_id: btn.dataset.run });
      btn.disabled = false;
      if (!d.ok) { alert(d.error || 'No se pudo cargar el detalle.'); return; }
      const bodyHtml = (d.changes && d.changes.length) ? d.changes.map(rosterChangeLine).join('') : '<p class="muted" style="margin:0">Sin cambios.</p>';
      const title = `Cambios · ${run ? run.company_code : ''}${run && run.business_name ? ' — ' + run.business_name : ''}`;
      syncChangesModal(title, bodyHtml);
    }));
}

/* ---------- VISTA: SYNC ----------
   Sincronizacion del catalogo de empresas (AX -> Supabase):
   - ejecucion manual ("Sincronizar ahora"),
   - programacion automatica (cron en Supabase que revisa cada ~15 min y
     ejecuta segun la frecuencia elegida aqui),
   - estado de la ultima ejecucion (cuando y con que resultado).
   El cron y el boton manual llaman al MISMO endpoint /api/sync-companies;
   cada corrida queda registrada en nomina_v2.sync_config / sync_runs. */
/* Cooldown del boton manual: deshabilita el boton y muestra una cuenta
   regresiva. El limite real tambien lo valida el servidor; esto es la capa
   de UX. Se alimenta de sync_config.last_manual_run_at + cooldown. */
let SYNC_CD_TIMER = null;
const SYNC_UNIT_MS = { minutes: 60000, hours: 3600000, days: 86400000 };
function syncCdTotalMs(c) {
  return (c.manual_cooldown_value || 0) * (SYNC_UNIT_MS[c.manual_cooldown_unit] || 60000);
}
function syncFmtLeft(ms) {
  const s = Math.ceil(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}
function applySyncCooldown(c) {
  const btn = document.getElementById('syncBtn');
  if (!btn) return;
  if (SYNC_CD_TIMER) { clearInterval(SYNC_CD_TIMER); SYNC_CD_TIMER = null; }
  const total = syncCdTotalMs(c || {});
  const last = (c && c.last_manual_run_at) ? new Date(c.last_manual_run_at).getTime() : 0;
  const tick = () => {
    const left = (total > 0 && last) ? (last + total - Date.now()) : 0;
    if (left > 0) { btn.disabled = true; btn.textContent = `Disponible en ${syncFmtLeft(left)}`; return true; }
    btn.disabled = false; btn.innerHTML = `${I.sync} Sincronizar ahora`;
    if (SYNC_CD_TIMER) { clearInterval(SYNC_CD_TIMER); SYNC_CD_TIMER = null; }
    return false;
  };
  if (tick()) SYNC_CD_TIMER = setInterval(tick, 1000);
}

const SYNC_FREQ_LABEL = {
  hourly: 'Cada hora', '6h': 'Cada 6 horas', '12h': 'Cada 12 horas',
  daily: 'Una vez al día', '2d': 'Cada 2 días',
};
async function syncCfgApi(payload) {
  return fetch('/api/sync-config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(r => r.json());
}

async function viewSync(user) {
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  $('#pnlMain').innerHTML = `<div class="pnl-head"><div><h1>Sincronización</h1><p>Catálogo de empresas · AX → Supabase</p></div></div>`
    + (isSuper ? `<div class="pnl-loading">Cargando…</div>`
               : `<div class="card"><p class="muted" style="margin:0">Solo el superadmin puede sincronizar.</p></div>`);
  if (!isSuper) return;

  const escH = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const lastRunHtml = (cfg) => {
    if (!cfg || !cfg.last_run_at) return '<span class="muted">Aún no se ha ejecutado.</span>';
    const when = fmtDeadline(cfg.last_run_at);
    const src = cfg.last_source === 'cron' ? 'automática' : 'manual';
    const dur = cfg.last_duration_ms != null ? ` · ${(cfg.last_duration_ms / 1000).toFixed(1)} s` : '';
    if (cfg.last_status === 'ok') {
      const r = cfg.last_result || {};
      return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="pill pill-open">✅ OK</span><b>${when}</b><span class="muted">${src}${dur}</span></div>`
        + `<div style="margin-top:8px">${r.companies || 0} empresas · ${r.zones || 0} zonas · ${r.subzones || 0} subzonas · ${r.concepts || 0} conceptos</div>`;
    }
    const err = (cfg.last_result && cfg.last_result.error) || 'error desconocido';
    return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="pill pill-closed">❌ Error</span><b>${when}</b><span class="muted">${src}${dur}</span></div>`
      + `<div style="margin-top:8px;color:var(--danger)">${escH(err)}</div>`;
  };

  const runChangesMap = {};   // id -> [changes] (para el modal de detalle)
  const changeLine = (c) => {
    const name = c.business_name ? ` — ${escH(c.business_name)}` : '';
    if (c.change_type === 'new') return `<div>➕ Nueva empresa <b>${escH(c.company_code)}</b>${name}</div>`;
    return `<div>🔄 <b>${escH(c.company_code)}</b>${name}: ${escH(c.old_value || '—')} → <b>${escH(c.new_value || '—')}</b></div>`;
  };
  const changesCell = (r) => {
    const cs = r.changes || [];
    if (!cs.length) return '<span class="muted">Sin cambios</span>';
    return `<button class="sync-chg-toggle" data-run="${r.id}" style="background:none;border:0;color:var(--brand,#2563eb);cursor:pointer;padding:0;font:inherit;text-decoration:underline">${cs.length} cambio${cs.length === 1 ? '' : 's'}</button>`;
  };
  const runsHtml = (runs) => {
    if (!runs || !runs.length) return '';
    const rows = runs.map(r => {
      runChangesMap[r.id] = r.changes || [];
      const when = fmtDeadline(r.finished_at || r.started_at);
      const origin = r.source === 'cron' ? 'Automática' : `Manual${r.triggered_by_name ? ' · ' + escH(r.triggered_by_name) : ''}`;
      const dur = r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)} s` : '—';
      const est = r.status === 'ok' ? '<span class="pill pill-open">OK</span>' : '<span class="pill pill-closed">Error</span>';
      const result = r.status === 'ok' ? changesCell(r)
        : `<span style="color:var(--danger)">${escH((r.error || '').slice(0, 70))}</span>`;
      return `<tr><td>${when}</td><td>${origin}</td><td>${est}</td><td>${result}</td><td style="text-align:right">${dur}</td></tr>`;
    }).join('');
    return `<div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">Últimas ejecuciones</h3>
      <table class="cfg-cat-table"><thead><tr><th>Fecha</th><th>Origen</th><th>Estado</th><th>Cambios</th><th style="text-align:right">Duración</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  };
  const wireRunToggles = () => {
    document.querySelectorAll('.sync-chg-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const cs = runChangesMap[btn.dataset.run] || [];
        if (!cs.length) return;
        syncChangesModal('Cambios de la sincronización', cs.map(changeLine).join(''));
      });
    });
  };

  const cfgRes = await syncCfgApi({ action: 'get', adminId: user.id });
  if (!cfgRes.ok) {
    $('#pnlMain').innerHTML = `<div class="pnl-head"><div><h1>Sincronización</h1></div></div><div class="card"><p class="muted" style="margin:0">Error: ${escH(cfgRes.error || 'no se pudo cargar')}</p></div>`;
    return;
  }
  const cfg = cfgRes.config || { enabled: true, frequency: 'daily', daily_hour: 6 };

  const hourOpts = Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}" ${cfg.daily_hour === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
  const freqOpts = Object.entries(SYNC_FREQ_LABEL).map(([v, l]) =>
    `<option value="${v}" ${cfg.frequency === v ? 'selected' : ''}>${l}</option>`).join('');
  const showHour = (cfg.frequency === 'daily' || cfg.frequency === '2d');

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Sincronización</h1><p>Catálogo de empresas · AX → Supabase</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="syncBtn">${I.sync} Sincronizar ahora</button></div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">Última sincronización</h3>
      <div id="syncLast">${lastRunHtml(cfg)}</div>
      <p class="muted" style="font-size:12px;margin:12px 0 0">Vuelca empresas, zonas, subzonas y conceptos desde la API de AX. Es un upsert: actualiza lo que viene, no borra lo ausente.</p>
    </div>

    <div class="card">
      <div class="cfg-card-head"><h3 style="margin:0;font-size:15px">Programación automática</h3><span class="cfg-saved" id="syncSaved">✓ Guardado</span></div>
      <p class="cfg-desc" style="margin:0 0 14px">El sistema revisa cada ~15 minutos y ejecuta la sincronización cuando corresponde según la frecuencia. Por defecto, una vez al día.</p>
      <div class="cfg-grid3">
        <div><label class="flabel">Estado</label>
          <select id="syncEnabled"><option value="1" ${cfg.enabled ? 'selected' : ''}>Activa</option><option value="0" ${!cfg.enabled ? 'selected' : ''}>Inactiva</option></select></div>
        <div><label class="flabel">Frecuencia</label><select id="syncFreq">${freqOpts}</select></div>
        <div id="syncHourWrap" style="${showHour ? '' : 'display:none'}"><label class="flabel">Hora (Caracas)</label><select id="syncHour">${hourOpts}</select></div>
      </div>
      <div class="cfg-grid3" style="margin-top:12px">
        <div><label class="flabel">Límite del botón manual</label>
          <div style="display:flex;gap:8px">
            <input type="number" id="syncCdVal" min="0" max="999" value="${cfg.manual_cooldown_value ?? 10}" style="width:90px">
            <select id="syncCdUnit">
              <option value="minutes" ${cfg.manual_cooldown_unit === 'minutes' ? 'selected' : ''}>minutos</option>
              <option value="hours" ${cfg.manual_cooldown_unit === 'hours' ? 'selected' : ''}>horas</option>
              <option value="days" ${cfg.manual_cooldown_unit === 'days' ? 'selected' : ''}>días</option>
            </select>
          </div>
          <p class="muted" style="font-size:11px;margin:6px 0 0">Tiempo mínimo entre sincronizaciones manuales (0 = sin límite). Aplica a todos.</p>
        </div>
      </div>
      <details style="margin-top:14px">
        <summary class="muted" style="cursor:pointer;font-size:12.5px">Opciones avanzadas</summary>
        <div style="margin-top:10px"><label class="flabel">URL del portal <span class="muted">(donde corre /api/sync-companies)</span></label>
          <input type="text" id="syncUrl" value="${escH(cfg.endpoint_url || '')}" placeholder="https://nominav2.pages.dev">
          <p class="muted" style="font-size:11.5px;margin:6px 0 0">El cron llama a esta URL para ejecutar la sincronización. Debe ser la dirección pública del portal en producción. Si se deja vacío, usa el valor por defecto.</p></div>
      </details>
      <div class="cfg-foot"><button class="btn btn-primary" id="syncSave">Guardar programación</button></div>
    </div>

    <div id="syncRuns">${runsHtml(cfgRes.runs)}</div>`;

  wireRunToggles();
  applySyncCooldown(cfg);

  // Mostrar/ocultar la hora según la frecuencia elegida
  $('#syncFreq').addEventListener('change', (e) => {
    const sh = (e.target.value === 'daily' || e.target.value === '2d');
    $('#syncHourWrap').style.display = sh ? '' : 'none';
  });

  // Guardar programación
  $('#syncSave').addEventListener('click', async () => {
    const btn = $('#syncSave'); btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Guardando…';
    const r = await syncCfgApi({
      action: 'set', adminId: user.id,
      enabled: $('#syncEnabled').value === '1',
      frequency: $('#syncFreq').value,
      daily_hour: parseInt($('#syncHour').value, 10),
      endpoint_url: $('#syncUrl').value.trim(),
      manual_cooldown_value: parseInt($('#syncCdVal').value, 10),
      manual_cooldown_unit: $('#syncCdUnit').value,
    });
    btn.disabled = false; btn.textContent = orig;
    if (!r.ok) { alert(r.error || 'No se pudo guardar.'); return; }
    const sv = $('#syncSaved'); if (sv) { sv.style.display = 'inline'; setTimeout(() => sv.style.display = 'none', 1800); }
  });

  // Sincronizar ahora (manual) -> relee la config para mostrar el resultado real
  $('#syncBtn').addEventListener('click', async () => {
    const btn = $('#syncBtn'); const last = $('#syncLast');
    btn.disabled = true; last.innerHTML = '<span class="muted">Sincronizando…</span>';
    let msg = null;
    try {
      const res = await fetch('/api/sync-companies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminId: user.id, source: 'manual' }),
      });
      const d = await res.json();
      if (d.ok) CATALOG = null; // forzar recarga al volver a Empresas
      else if (res.status === 429 || d.error === 'cooldown') msg = d.message || 'Sincronización reciente. Espera antes de volver a intentar.';
      else msg = d.error || 'No se pudo sincronizar.';
    } catch (e) { msg = 'Error de conexión.'; }
    const fresh = await syncCfgApi({ action: 'get', adminId: user.id });
    if (fresh.ok) {
      $('#syncLast').innerHTML = lastRunHtml(fresh.config || {});
      $('#syncRuns').innerHTML = runsHtml(fresh.runs);
      wireRunToggles();
      applySyncCooldown(fresh.config || {});
    } else {
      btn.disabled = false;
    }
    if (msg) { const sl = $('#syncLast'); if (sl) sl.insertAdjacentHTML('afterbegin', `<div style="color:var(--danger);margin-bottom:8px">${escH(msg)}</div>`); }
    bellLoad(user); // una sync manual puede haber generado novedades
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
  // Linea de tiempo de la quincena vigente, arriba de la tabla de Quincenas.
  injectPeriodTimeline($('#pnlMain'));
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
  const [st, ty, ca, cg, bn, op, di, de, er] = await Promise.all([
    cfgSettings({ action: 'list', adminId: user.id }),
    cfgCatalogs({ action: 'absence_list', adminId: user.id }),
    cfgCatalogs({ action: 'causa_list', adminId: user.id }),
    cfgCatalogs({ action: 'cargo_list', adminId: user.id }),
    cfgCatalogs({ action: 'banco_list', adminId: user.id }),
    cfgCatalogs({ action: 'operadora_list', adminId: user.id }),
    cfgCatalogs({ action: 'incdoc_list', adminId: user.id, incidence_code: 'ingreso' }),
    cfgCatalogs({ action: 'incdoc_list', adminId: user.id, incidence_code: 'egreso' }),
    cfgCatalogs({ action: 'egress_reason_list', adminId: user.id }),
  ]);
  if (!st.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${st.error}</div>`; return; }
  CFG_DATA = { settings: st.settings || [], types: (ty.ok && ty.types) || [], causas: (ca.ok && ca.causas) || [], cargos: (cg.ok && cg.cargos) || [], bancos: (bn.ok && bn.bancos) || [], operadoras: (op.ok && op.operadoras) || [], docsIngreso: (di.ok && di.docs) || [], docsEgreso: (de.ok && de.docs) || [], egressReasons: (er.ok && er.reasons) || [] };

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Configuración</h1><p>Parámetros, catálogos e integraciones del portal</p></div></div>
    <div class="cfg-layout">
      <nav class="cfg-side" id="cfgSide">
        <div class="cfg-side-group">Catálogos de reportes</div>
        <button class="cfg-side-item" data-tab="aus"><span class="cfg-side-ic">📅</span> Tipos de ausencia</button>
        <button class="cfg-side-item" data-tab="mar"><span class="cfg-side-ic">🕐</span> Causas de marcaje</button>
        <button class="cfg-side-item" data-tab="motegreso"><span class="cfg-side-ic">🔴</span> Motivos de egreso</button>
        <div class="cfg-side-group">Datos de ingreso</div>
        <button class="cfg-side-item" data-tab="car"><span class="cfg-side-ic">👔</span> Cargos</button>
        <button class="cfg-side-item" data-tab="ban"><span class="cfg-side-ic">🏦</span> Bancos</button>
        <button class="cfg-side-item" data-tab="ope"><span class="cfg-side-ic">📱</span> Operadoras</button>
        <div class="cfg-side-group">Empresas</div>
        <button class="cfg-side-item" data-tab="depcargos"><span class="cfg-side-ic">🏷️</span> Cargos de departamento</button>
        <div class="cfg-side-group">Documentos</div>
        <button class="cfg-side-item" data-tab="dingreso"><span class="cfg-side-ic">➕</span> Ingresos</button>
        <button class="cfg-side-item" data-tab="degreso"><span class="cfg-side-ic">🔴</span> Egresos</button>
        <div class="cfg-side-group">Sistema</div>
        <button class="cfg-side-item" data-tab="cor"><span class="cfg-side-ic">📆</span> Corte y períodos</button>
        <button class="cfg-side-item" data-tab="int"><span class="cfg-side-ic">🔌</span> Integraciones</button>
      </nav>
      <div class="cfg-panel-wrap" id="cfgBody"></div>
    </div>`;

  $('#pnlMain').querySelectorAll('.cfg-side-item').forEach(b =>
    b.addEventListener('click', () => { CFG_TAB = b.dataset.tab; cfgRenderTab(user); }));
  cfgRenderTab(user);
}

function cfgRenderTab(user) {
  $('#pnlMain').querySelectorAll('.cfg-side-item').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === CFG_TAB));
  const body = $('#cfgBody');
  if (CFG_TAB === 'aus') cfgRenderAusencia(user, body);
  else if (CFG_TAB === 'mar') cfgRenderCausas(user, body);
  else if (CFG_TAB === 'car') cfgRenderCargos(user, body);
  else if (CFG_TAB === 'ban') cfgRenderBancos(user, body);
  else if (CFG_TAB === 'ope') cfgRenderOperadoras(user, body);
  else if (CFG_TAB === 'depcargos') renderDepartmentCargos(user, body);
  else if (CFG_TAB === 'dingreso') cfgRenderIncDocs(user, body, 'ingreso');
  else if (CFG_TAB === 'degreso') cfgRenderIncDocs(user, body, 'egreso');
  else if (CFG_TAB === 'motegreso') cfgRenderEgressReasons(user, body);
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

/* ===== Pestana MOTIVOS DE EGRESO ===== */
function cfgRenderEgressReasons(user, body) {
  const rows = (CFG_DATA.egressReasons || []).map((r, i) => {
    const tipo = r.is_other ? '<span class="pill pill-warn2">texto libre</span>' : '';
    const estado = r.is_active ? '<span class="pill pill-open">activo</span>' : '<span class="pill pill-closed">inactivo</span>';
    return `<tr>
      <td style="font-family:monospace;color:var(--muted)">${i + 1}</td>
      <td><b>${r.label}</b><br><span class="muted" style="font-size:11px;font-family:monospace">${r.code}</span></td>
      <td>${tipo}</td><td>${estado}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-mini" data-edit-egr="${r.code}">${I.pencil}</button>
        <button class="btn btn-mini" data-toggle-egr="${r.code}" data-active="${r.is_active}">${r.is_active ? 'Desactivar' : 'Activar'}</button>
      </td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">Sin motivos.</td></tr>';

  body.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3>Motivos de egreso</h3>
        <button class="btn btn-primary btn-mini" id="egrNew">${I.plus} Nuevo motivo</button></div>
      <p class="cfg-desc" style="margin:0 0 14px">Motivos que la tienda elige al reportar un egreso (obligatorio). El tipo "texto libre" es el "Otro": sugiere escribir el detalle en el comentario.</p>
      <table class="cfg-cat-table"><thead><tr>
        <th>#</th><th>Motivo</th><th>Tipo</th><th>Estado</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>`;

  $('#egrNew').addEventListener('click', () => cfgEgressReasonModal(user, null));
  body.querySelectorAll('[data-edit-egr]').forEach(b =>
    b.addEventListener('click', () => cfgEgressReasonModal(user, (CFG_DATA.egressReasons || []).find(r => r.code === b.dataset.editEgr))));
  body.querySelectorAll('[data-toggle-egr]').forEach(b =>
    b.addEventListener('click', async () => {
      const r = await cfgCatalogs({ action: 'egress_reason_toggle', adminId: user.id, code: b.dataset.toggleEgr, active: !(b.dataset.active === 'true') });
      if (!r.ok) { alert(r.error); return; }
      await cfgReloadCatalogs(user); cfgRenderTab(user);
    }));
}

function cfgEgressReasonModal(user, r) {
  const isNew = !r;
  openModal(`
    <div class="modal-head"><span>${isNew ? 'Nuevo motivo' : 'Editar motivo'}</span><button class="modal-x" id="mX">✕</button></div>
    <label class="flabel">Nombre (lo ve la tienda)</label>
    <input id="er_label" value="${r ? r.label.replace(/"/g,'&quot;') : ''}" placeholder="Bajo rendimiento" style="margin-bottom:12px">
    <label class="flabel">Código (interno)</label>
    <input id="er_code" value="${r ? r.code : ''}" ${r ? 'readonly' : ''} placeholder="bajo_rendimiento" style="font-family:monospace;margin-bottom:12px">
    <label class="radio-row" style="margin-bottom:8px"><input type="checkbox" id="er_other" ${r && r.is_other ? 'checked' : ''}>
      <span>Tipo "Otro" <span class="muted" style="font-size:12px">(sugiere escribir el detalle en el comentario)</span></span></label>
    <label class="radio-row"><input type="checkbox" id="er_active" ${!r || r.is_active ? 'checked' : ''}> <span>Activo</span></label>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Guardar</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const res = await cfgCatalogs({ action: 'egress_reason_save', adminId: user.id,
      reason: { code: $('#er_code').value, label: $('#er_label').value,
        is_other: $('#er_other').checked, is_active: $('#er_active').checked } });
    if (!res.ok) { alert(res.error); return; }
    closeModal();
    await cfgReloadCatalogs(user); cfgRenderTab(user);
  });
}

/* ===== Pestana CARGOS ===== */
function cfgRenderCargos(user, body) {
  const rows = (CFG_DATA.cargos || []).map(c => {
    const resp = c.can_be_responsible
      ? `<span class="pill pill-open">${c.responsible_role || 'Responsable'}</span>`
      : '<span style="color:var(--muted)">—</span>';
    const ing = c.selectable_on_ingreso ? '<span class="pill pill-open">sí</span>' : '<span class="pill pill-closed">no</span>';
    const estado = c.is_active ? '<span class="pill pill-open">activo</span>' : '<span class="pill pill-closed">inactivo</span>';
    const pats = (c.patterns || []).map(p => p.pattern).join(', ') || '<span style="color:var(--muted)">—</span>';
    return `<tr>
      <td><b>${c.label}</b><br><span class="muted" style="font-size:11px;font-family:monospace">${c.code}</span></td>
      <td><span class="pill pill-ax">${c.ax_code}</span></td>
      <td>${resp}</td><td>${ing}</td>
      <td style="font-size:11.5px;color:var(--muted)">${pats}</td>
      <td>${estado}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-mini" data-edit-car="${c.code}">${I.pencil}</button>
        <button class="btn btn-mini" data-toggle-car="${c.code}" data-active="${c.is_active}">${c.is_active ? 'Desactivar' : 'Activar'}</button>
      </td></tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">Sin cargos.</td></tr>';

  body.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3>Cargos</h3>
        <button class="btn btn-primary btn-mini" id="carNew">${I.plus} Nuevo cargo</button></div>
      <p class="cfg-desc" style="margin:0 0 14px">Catálogo único de cargos. La <b>etiqueta</b> es lo que ve la tienda; el <b>código de plantilla</b> es lo que se exporta (puede diferir, ej. Cajero → CAJEROS). Quien puede ser <b>responsable</b> y los <b>patrones</b> de lectura de la lista de personal se definen aquí.</p>
      <table class="cfg-cat-table"><thead><tr>
        <th>Cargo</th><th>Cód. plantilla</th><th>Responsable</th><th>En ingreso</th><th>Patrones (lista de personal)</th><th>Estado</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>`;

  $('#carNew').addEventListener('click', () => cfgCargoModal(user, null));
  body.querySelectorAll('[data-edit-car]').forEach(b =>
    b.addEventListener('click', () => cfgCargoModal(user, CFG_DATA.cargos.find(c => c.code === b.dataset.editCar))));
  body.querySelectorAll('[data-toggle-car]').forEach(b =>
    b.addEventListener('click', async () => {
      const r = await cfgCatalogs({ action: 'cargo_toggle', adminId: user.id, code: b.dataset.toggleCar, active: !(b.dataset.active === 'true') });
      if (!r.ok) { alert(r.error); return; }
      await cfgReloadCatalogs(user); cfgRenderTab(user);
    }));
}

function cfgCargoModal(user, c) {
  const isNew = !c;
  const pats = c && c.patterns ? c.patterns.map(p => p.pattern).join(', ') : '';
  openModal(`
    <div class="modal-head"><span>${isNew ? 'Nuevo cargo' : 'Editar cargo'}</span><button class="modal-x" id="mX">✕</button></div>
    <div class="cfg-grid2">
      <div><label class="flabel">Nombre (lo ve la tienda)</label><input id="cg_label" value="${c ? c.label.replace(/"/g,'&quot;') : ''}" placeholder="Cajero"></div>
      <div><label class="flabel">Código de plantilla</label><input id="cg_ax" value="${c ? (c.ax_code||'') : ''}" placeholder="CAJEROS" style="font-family:monospace;text-transform:uppercase"></div>
    </div>
    <div class="cfg-grid2" style="margin-top:12px">
      <div><label class="flabel">Código (interno)</label><input id="cg_code" value="${c ? c.code : ''}" ${c ? 'readonly' : ''} placeholder="CAJERO" style="font-family:monospace;text-transform:uppercase"></div>
      <div><label class="flabel">Estado</label>
        <select id="cg_active"><option value="1" ${!c || c.is_active ? 'selected' : ''}>Activo</option><option value="0" ${c && !c.is_active ? 'selected' : ''}>Inactivo</option></select></div>
    </div>
    <div class="cfg-grid3" style="margin-top:12px">
      <div><label class="flabel">Puede ser responsable</label>
        <select id="cg_resp"><option value="0" ${!c || !c.can_be_responsible ? 'selected' : ''}>No</option><option value="1" ${c && c.can_be_responsible ? 'selected' : ''}>Sí</option></select></div>
      <div><label class="flabel">Rol de responsable</label>
        <select id="cg_role"><option value="">—</option><option value="Gerente" ${c && c.responsible_role==='Gerente'?'selected':''}>Gerente</option><option value="Sub-Gerente" ${c && c.responsible_role==='Sub-Gerente'?'selected':''}>Sub-Gerente</option></select></div>
      <div><label class="flabel">Aparece en Ingreso</label>
        <select id="cg_ing"><option value="1" ${!c || c.selectable_on_ingreso ? 'selected' : ''}>Sí</option><option value="0" ${c && !c.selectable_on_ingreso ? 'selected' : ''}>No</option></select></div>
    </div>
    <div style="margin-top:14px"><label class="flabel">Patrones de la lista de personal <span class="muted">(separados por coma)</span></label>
      <input id="cg_pats" value="${pats.replace(/"/g,'&quot;')}" placeholder="CAJERO, CAJEROS, CAJERA">
      <p class="muted" style="font-size:11.5px;margin:6px 0 0">Texto del cargo en el Reporte 10 que debe reconocerse como este cargo. Lo más específico (ej. SUB GERENTE) debe ir en su propio cargo para que gane sobre GERENTE.</p></div>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Guardar</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const canResp = $('#cg_resp').value === '1';
    const role = $('#cg_role').value;
    if (canResp && !role) { alert('Si el cargo puede ser responsable, elige el rol (Gerente o Sub-Gerente).'); return; }
    const r = await cfgCatalogs({ action: 'cargo_save', adminId: user.id,
      cargo: {
        code: $('#cg_code').value, label: $('#cg_label').value, ax_code: $('#cg_ax').value,
        can_be_responsible: canResp, responsible_role: canResp ? role : null,
        selectable_on_ingreso: $('#cg_ing').value === '1', is_active: $('#cg_active').value === '1',
        patterns: $('#cg_pats').value.split(',').map(s => s.trim()).filter(Boolean),
      } });
    if (!r.ok) { alert(r.error); return; }
    closeModal();
    await cfgReloadCatalogs(user); cfgRenderTab(user);
  });
}

/* ===== Pestana BANCOS ===== */
function cfgRenderBancos(user, body) {
  const rows = (CFG_DATA.bancos || []).map(b => {
    const estado = b.is_active ? '<span class="pill pill-open">activo</span>' : '<span class="pill pill-closed">inactivo</span>';
    return `<tr>
      <td style="font-family:monospace;font-weight:600">${b.code}</td>
      <td><b>${b.name}</b></td>
      <td>${estado}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-mini" data-edit-ban="${b.code}">${I.pencil}</button>
        <button class="btn btn-mini" data-toggle-ban="${b.code}" data-active="${b.is_active}">${b.is_active ? 'Desactivar' : 'Activar'}</button>
      </td></tr>`;
  }).join('') || '<tr><td colspan="4" class="empty">Sin bancos.</td></tr>';

  body.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3>Bancos</h3>
        <button class="btn btn-primary btn-mini" id="banNew">${I.plus} Nuevo banco</button></div>
      <p class="cfg-desc" style="margin:0 0 14px">Prefijo de 4 dígitos de la cuenta bancaria (20 dígitos en total). Si el prefijo no está activo aquí, la cuenta no se acepta en los reportes.</p>
      <table class="cfg-cat-table"><thead><tr>
        <th>Prefijo</th><th>Banco</th><th>Estado</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>`;

  $('#banNew').addEventListener('click', () => cfgBancoModal(user, null));
  body.querySelectorAll('[data-edit-ban]').forEach(b =>
    b.addEventListener('click', () => cfgBancoModal(user, CFG_DATA.bancos.find(x => x.code === b.dataset.editBan))));
  body.querySelectorAll('[data-toggle-ban]').forEach(b =>
    b.addEventListener('click', async () => {
      const r = await cfgCatalogs({ action: 'banco_toggle', adminId: user.id, code: b.dataset.toggleBan, active: !(b.dataset.active === 'true') });
      if (!r.ok) { alert(r.error); return; }
      await cfgReloadCatalogs(user); cfgRenderTab(user);
    }));
}

function cfgBancoModal(user, b) {
  const isNew = !b;
  openModal(`
    <div class="modal-head"><span>${isNew ? 'Nuevo banco' : 'Editar banco'}</span><button class="modal-x" id="mX">✕</button></div>
    <label class="flabel">Prefijo (4 dígitos)</label>
    <input id="bn_code" value="${b ? b.code : ''}" ${b ? 'readonly' : ''} placeholder="0134" maxlength="4" inputmode="numeric" style="font-family:monospace;margin-bottom:12px">
    <label class="flabel">Nombre del banco</label>
    <input id="bn_name" value="${b ? b.name.replace(/"/g,'&quot;') : ''}" placeholder="Banesco" style="margin-bottom:12px">
    <label class="radio-row"><input type="checkbox" id="bn_active" ${!b || b.is_active ? 'checked' : ''}> <span>Activo</span></label>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Guardar</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#bn_code').addEventListener('input', function(){ this.value = this.value.replace(/[^0-9]/g,'').slice(0,4); });
  $('#mOk').addEventListener('click', async () => {
    const r = await cfgCatalogs({ action: 'banco_save', adminId: user.id,
      banco: { code: $('#bn_code').value, name: $('#bn_name').value, is_active: $('#bn_active').checked } });
    if (!r.ok) { alert(r.error); return; }
    closeModal();
    await cfgReloadCatalogs(user); cfgRenderTab(user);
  });
}

/* ===== Pestana OPERADORAS ===== */
function cfgRenderOperadoras(user, body) {
  const rows = (CFG_DATA.operadoras || []).map(o => {
    const estado = o.is_active ? '<span class="pill pill-open">activa</span>' : '<span class="pill pill-closed">inactiva</span>';
    return `<tr>
      <td style="font-family:monospace;font-weight:600">${o.code}</td>
      <td><b>${o.name}</b></td>
      <td>${estado}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-mini" data-edit-ope="${o.code}">${I.pencil}</button>
        <button class="btn btn-mini" data-toggle-ope="${o.code}" data-active="${o.is_active}">${o.is_active ? 'Desactivar' : 'Activar'}</button>
      </td></tr>`;
  }).join('') || '<tr><td colspan="4" class="empty">Sin operadoras.</td></tr>';

  body.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3>Operadoras móviles</h3>
        <button class="btn btn-primary btn-mini" id="opeNew">${I.plus} Nueva operadora</button></div>
      <p class="cfg-desc" style="margin:0 0 14px">Prefijo de 4 dígitos del teléfono móvil (04XX). Si el prefijo no está activo aquí, el teléfono no se acepta. El número se guarda en formato internacional (+58).</p>
      <table class="cfg-cat-table"><thead><tr>
        <th>Prefijo</th><th>Operadora</th><th>Estado</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>`;

  $('#opeNew').addEventListener('click', () => cfgOperadoraModal(user, null));
  body.querySelectorAll('[data-edit-ope]').forEach(b =>
    b.addEventListener('click', () => cfgOperadoraModal(user, CFG_DATA.operadoras.find(x => x.code === b.dataset.editOpe))));
  body.querySelectorAll('[data-toggle-ope]').forEach(b =>
    b.addEventListener('click', async () => {
      const r = await cfgCatalogs({ action: 'operadora_toggle', adminId: user.id, code: b.dataset.toggleOpe, active: !(b.dataset.active === 'true') });
      if (!r.ok) { alert(r.error); return; }
      await cfgReloadCatalogs(user); cfgRenderTab(user);
    }));
}

function cfgOperadoraModal(user, o) {
  const isNew = !o;
  openModal(`
    <div class="modal-head"><span>${isNew ? 'Nueva operadora' : 'Editar operadora'}</span><button class="modal-x" id="mX">✕</button></div>
    <label class="flabel">Prefijo (4 dígitos)</label>
    <input id="op_code" value="${o ? o.code : ''}" ${o ? 'readonly' : ''} placeholder="0414" maxlength="4" inputmode="numeric" style="font-family:monospace;margin-bottom:12px">
    <label class="flabel">Operadora</label>
    <input id="op_name" value="${o ? o.name.replace(/"/g,'&quot;') : ''}" placeholder="Movistar" style="margin-bottom:12px">
    <label class="radio-row"><input type="checkbox" id="op_active" ${!o || o.is_active ? 'checked' : ''}> <span>Activa</span></label>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Guardar</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#op_code').addEventListener('input', function(){ this.value = this.value.replace(/[^0-9]/g,'').slice(0,4); });
  $('#mOk').addEventListener('click', async () => {
    const r = await cfgCatalogs({ action: 'operadora_save', adminId: user.id,
      operadora: { code: $('#op_code').value, name: $('#op_name').value, is_active: $('#op_active').checked } });
    if (!r.ok) { alert(r.error); return; }
    closeModal();
    await cfgReloadCatalogs(user); cfgRenderTab(user);
  });
}

/* ===== Pestanas DOCUMENTOS: Ingresos / Egresos =====
   Recaudos por tipo de incidencia (required_docs con incidence_code).
   Ingreso pide varios (Cedula, RIF, Soporte bancario, Sintesis curricular);
   Egreso normalmente uno (Carta de renuncia). ABM completo: crear, editar,
   activar/desactivar. La exigencia (block/warn/optional) se respeta al
   reportar: 'warn' deja enviar y queda pendiente; 'block' obliga a adjuntar. */
function cfgRenderIncDocs(user, body, inc) {
  const list = inc === 'ingreso' ? (CFG_DATA.docsIngreso || []) : (CFG_DATA.docsEgreso || []);
  const titulo = inc === 'ingreso' ? 'Recaudos de ingreso' : 'Documentos de egreso';
  const desc = inc === 'ingreso'
    ? 'Documentos que se piden a cada trabajador que ingresa. Cada uno viaja como un ticket aparte en osTicket; los que la tienda no adjunte quedan registrados como pendientes.'
    : 'Documentos del egreso (ej. carta de renuncia). Si la tienda no adjunta, puede indicar una causa o queda pendiente.';
  const enfPill = (e) => e === 'block' ? '<span class="pill pill-block">bloquea</span>'
    : e === 'optional' ? '<span class="pill pill-opt">opcional</span>'
    : '<span class="pill pill-warn2">advierte</span>';
  const rows = list.map(d => {
    const estado = d.is_active ? '<span class="pill pill-open">activo</span>' : '<span class="pill pill-closed">inactivo</span>';
    return `<tr>
      <td><b>${d.name}</b>${d.note ? `<br><span class="muted" style="font-size:11px">${d.note}</span>` : ''}</td>
      <td>${enfPill(d.enforcement)}</td>
      <td>${estado}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-mini" data-edit-doc="${d.id}">${I.pencil}</button>
        <button class="btn btn-mini" data-toggle-doc="${d.id}" data-active="${d.is_active}">${d.is_active ? 'Desactivar' : 'Activar'}</button>
      </td></tr>`;
  }).join('') || '<tr><td colspan="4" class="empty">Sin documentos. Agrega uno con “Nuevo documento”.</td></tr>';

  body.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3>${titulo}</h3>
        <button class="btn btn-primary btn-mini" id="docNew">${I.plus} Nuevo documento</button></div>
      <p class="cfg-desc" style="margin:0 0 14px">${desc}</p>
      <table class="cfg-cat-table"><thead><tr>
        <th>Documento</th><th>Exigencia</th><th>Estado</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>`;

  $('#docNew').addEventListener('click', () => cfgIncDocModal(user, inc, null));
  body.querySelectorAll('[data-edit-doc]').forEach(b =>
    b.addEventListener('click', () => cfgIncDocModal(user, inc, list.find(d => String(d.id) === b.dataset.editDoc))));
  body.querySelectorAll('[data-toggle-doc]').forEach(b =>
    b.addEventListener('click', async () => {
      const r = await cfgCatalogs({ action: 'incdoc_toggle', adminId: user.id, id: b.dataset.toggleDoc, active: !(b.dataset.active === 'true') });
      if (!r.ok) { alert(r.error); return; }
      await cfgReloadCatalogs(user); cfgRenderTab(user);
    }));
}

function cfgIncDocModal(user, inc, d) {
  const isNew = !d;
  openModal(`
    <div class="modal-head"><span>${isNew ? 'Nuevo documento' : 'Editar documento'}</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${inc === 'ingreso' ? 'Recaudo de ingreso' : 'Documento de egreso'}</p>
    <label class="flabel">Nombre del documento</label>
    <input id="id_name" value="${d ? d.name.replace(/"/g,'&quot;') : ''}" placeholder="${inc === 'ingreso' ? 'Cédula' : 'Carta de renuncia'}" style="margin-bottom:12px">
    <label class="flabel">Exigencia</label>
    <select id="id_enf" style="width:100%;margin-bottom:12px">
      <option value="block" ${d && d.enforcement==='block'?'selected':''}>Bloquea (no deja enviar sin él)</option>
      <option value="warn" ${!d || d.enforcement==='warn'?'selected':''}>Advierte (deja enviar, queda pendiente)</option>
      <option value="optional" ${d && d.enforcement==='optional'?'selected':''}>Opcional</option>
    </select>
    <label class="flabel">Nota / instrucción <span class="muted">(opcional)</span></label>
    <input id="id_note" value="${d && d.note ? d.note.replace(/"/g,'&quot;') : ''}" placeholder="ej. ambos lados de la cédula" style="margin-bottom:6px">
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Guardar</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const name = $('#id_name').value.trim();
    if (!name) { alert('Falta el nombre del documento.'); return; }
    const r = await cfgCatalogs({ action: 'incdoc_save', adminId: user.id, incidence_code: inc,
      doc: { id: d ? d.id : null, name, enforcement: $('#id_enf').value, note: $('#id_note').value, is_required: true, is_active: d ? d.is_active : true } });
    if (!r.ok) { alert(r.error); return; }
    closeModal();
    await cfgReloadCatalogs(user); cfgRenderTab(user);
  });
}

/* Recarga catalogos (tras un cambio) sin recargar toda la vista */
async function cfgReloadCatalogs(user) {
  const [ty, ca, cg, bn, op, di, de, er] = await Promise.all([
    cfgCatalogs({ action: 'absence_list', adminId: user.id }),
    cfgCatalogs({ action: 'causa_list', adminId: user.id }),
    cfgCatalogs({ action: 'cargo_list', adminId: user.id }),
    cfgCatalogs({ action: 'banco_list', adminId: user.id }),
    cfgCatalogs({ action: 'operadora_list', adminId: user.id }),
    cfgCatalogs({ action: 'incdoc_list', adminId: user.id, incidence_code: 'ingreso' }),
    cfgCatalogs({ action: 'incdoc_list', adminId: user.id, incidence_code: 'egreso' }),
    cfgCatalogs({ action: 'egress_reason_list', adminId: user.id }),
  ]);
  if (ty.ok) CFG_DATA.types = ty.types || [];
  if (ca.ok) CFG_DATA.causas = ca.causas || [];
  if (cg.ok) CFG_DATA.cargos = cg.cargos || [];
  if (bn.ok) CFG_DATA.bancos = bn.bancos || [];
  if (op.ok) CFG_DATA.operadoras = op.operadoras || [];
  if (di.ok) CFG_DATA.docsIngreso = di.docs || [];
  if (de.ok) CFG_DATA.docsEgreso = de.docs || [];
  if (er.ok) CFG_DATA.egressReasons = er.reasons || [];
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
  if (view === 'dashboard') { renderDashboard(user); return; }
  if (view === 'tiendas' || view === 'catalogos') {
    await ensureCatalog(user);
    if (!CATALOG) return;
  }
  if (view === 'tiendas') viewTiendas(user);
  else if (view === 'catalogos') viewCatalogos();
  else if (view === 'usuarios') viewUsuarios(user);
  else if (view === 'quincenas') viewPeriods(user);
  else if (view === 'calendario') viewPeriods(user);
  else if (view === 'equipo') viewEquipo(user);
  else if (view === 'permisos') viewPermisos(user);
  else if (view === 'sync') viewSync(user);
  else if (view === 'rostersync') viewRosterSync(user);
  else if (view === 'config') viewConfig(user);
  else if (view === 'historial') renderHistory(user);
  else if (view === 'estadisticas') renderReportStats(user);
  else if (view === 'reportempresas') renderCompanyReports(user);
  else if (view === 'misstats') renderMyStats(user);
  else if (view === 'avisos') renderAvisos(user, { mode: 'inbox' });
  else if (view === 'avisosconfig') renderAvisos(user, { mode: 'config' });
  else if (view === 'egmotivos') renderEgressRatify(user);
  else if (view === 'buscar') renderPersonnelSearch(user);
  else if (view === 'documentos') renderPersonnelDocs(user, null);
  else if (view === 'miempresa') viewMiEmpresa(user);
  else if (view === 'fotos') {
    // Vista de fichas/fotos. Para la tienda usa su propia company; para
    // admin/superadmin se entra eligiendo tienda desde Empresas (boton de
    // fila), no por este item de menu. Si la empresa del usuario de compania
    // es no-tienda (ej. 0A01), se entra en modo 'enterprise' (enterprise_workers).
    if (user.kind === 'company') renderWorkerPhotos(user, user.companyCode, null, { mode: NON_STORE_TYPES.has(user.companyType) ? 'enterprise' : 'store' });
    else viewTiendas(user);  // admin: elige tienda en Empresas
  }
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
      <button class="report-tile" data-report="ingreso">
        <span class="rt-ico">➕</span>
        <span class="rt-body"><span class="rt-title">Ingreso</span>
          <span class="rt-desc">Nuevo trabajador en la tienda.</span></span>
      </button>
      <button class="report-tile" data-report="egreso">
        <span class="rt-ico">🔴</span>
        <span class="rt-body"><span class="rt-title">Egreso</span>
          <span class="rt-desc">Trabajador que deja la tienda.</span></span>
      </button>
      <button class="report-tile" data-report="modificacion">
        <span class="rt-ico">✏️</span>
        <span class="rt-body"><span class="rt-title">Modificación</span>
          <span class="rt-desc">Corrección de datos de un trabajador.</span></span>
      </button>
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
  const tileIng = document.querySelector('#rpGrid [data-report="ingreso"]');
  if (tileIng) tileIng.addEventListener('click', () => {
    closeModal();
    launchWizard(u, ingresoReport, onExit);
  });
  const tileEgr = document.querySelector('#rpGrid [data-report="egreso"]');
  if (tileEgr) tileEgr.addEventListener('click', () => {
    closeModal();
    launchWizard(u, egresoReport, onExit);
  });
  const tileMod = document.querySelector('#rpGrid [data-report="modificacion"]');
  if (tileMod) tileMod.addEventListener('click', () => {
    closeModal();
    launchWizard(u, modificacionReport, onExit);
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
      <button class="report-tile" data-report="ingreso">
        <span class="rt-ico">➕</span>
        <span class="rt-body"><span class="rt-title">Ingreso</span>
          <span class="rt-desc">Nuevo trabajador en la tienda.</span></span>
      </button>
      <button class="report-tile" data-report="egreso">
        <span class="rt-ico">🔴</span>
        <span class="rt-body"><span class="rt-title">Egreso</span>
          <span class="rt-desc">Trabajador que deja la tienda.</span></span>
      </button>
      <button class="report-tile" data-report="modificacion">
        <span class="rt-ico">✏️</span>
        <span class="rt-body"><span class="rt-title">Modificación</span>
          <span class="rt-desc">Corrección de datos de un trabajador.</span></span>
      </button>
    </div>`;

  const tile = $('#reportGrid').querySelector('[data-report="marcaje"]');
  if (tile) tile.addEventListener('click', () => {
    launchWizard(user, marcajeReport, () => viewMiEmpresa(user));
  });
  const tileAus = $('#reportGrid').querySelector('[data-report="ausencia"]');
  if (tileAus) tileAus.addEventListener('click', () => {
    launchWizard(user, ausenciaReport, () => viewMiEmpresa(user));
  });
  const tileIng = $('#reportGrid').querySelector('[data-report="ingreso"]');
  if (tileIng) tileIng.addEventListener('click', () => {
    launchWizard(user, ingresoReport, () => viewMiEmpresa(user));
  });
  const tileEgr = $('#reportGrid').querySelector('[data-report="egreso"]');
  if (tileEgr) tileEgr.addEventListener('click', () => {
    launchWizard(user, egresoReport, () => viewMiEmpresa(user));
  });
  const tileMod = $('#reportGrid').querySelector('[data-report="modificacion"]');
  if (tileMod) tileMod.addEventListener('click', () => {
    launchWizard(user, modificacionReport, () => viewMiEmpresa(user));
  });
}

export function renderPanel() {
  const user = getSession();
  if (!user) { go('/login'); return; }
  // Limpiar estado en memoria de cualquier sesión previa (evita que datos
  // de un usuario anterior "se filtren" si se cambia de sesión sin recargar).
  CATALOG = null; CU_ROWS = null; SCOPE = null; OU_USER = null; TIENDAS_FILTERS = null; currentView = 'dashboard';
  mount(shell(user));
  loadAvatar((user.email || '').trim().toLowerCase());
  $('#logoutBtn').addEventListener('click', () => { clearSession(); go('/login'); });
  document.querySelectorAll('#pnlNav button[data-view]').forEach(b =>
    b.addEventListener('click', () => navigate(b.dataset.view, user)));
  // Toggle de los grupos colapsables del menú (admin/super). Por CSP no se usa
  // onclick inline. Todos arrancan desplegados; este boton pliega/despliega.
  // En modo riel no se pliega (los grupos se muestran como iconos sueltos).
  const layout = document.getElementById('pnlLayout');
  document.querySelectorAll('#pnlNav [data-group-toggle]').forEach(h =>
    h.addEventListener('click', () => {
      if (layout && layout.classList.contains('rail')) return;
      h.closest('.nav-group').classList.toggle('collapsed');
    }));
  // Controles del menú: riel (solo iconos) y ocultar (off-canvas). No se
  // recuerda el estado entre sesiones: arranca siempre expandido y visible.
  const railBtn = document.getElementById('pnlRail');
  const hamBtn = document.getElementById('pnlHam');
  const reopenBtn = document.getElementById('pnlReopen');
  if (railBtn && layout) railBtn.addEventListener('click', () => layout.classList.toggle('rail'));
  if (hamBtn && layout) hamBtn.addEventListener('click', () => layout.classList.toggle('hidden-nav'));
  if (reopenBtn && layout) reopenBtn.addEventListener('click', () => layout.classList.remove('hidden-nav'));
  // Campanita de novedades (solo admins; si no existe el boton, no hace nada).
  initBell(user);
  // Landing unificado: ambos arrancan en el Dashboard (Inicio).
  navigate('dashboard', user);
}
