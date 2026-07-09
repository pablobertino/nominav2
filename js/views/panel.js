/* =====================================================================
   views/panel.js — Panel principal con sidebar y secciones.
   Hito actual: Tiendas (6 filtros, default tipo=Tienda) y Catálogos
   (árbol zonas→subzonas + conceptos). Usuarios/Permisos/Sync se montan
   como secciones; por ahora Sync reusa el flujo existente.
   ===================================================================== */
import { $, mount } from '../core/dom.js';
import { getSession, clearSession } from '../core/session.js';
import { go } from '../core/router.js';
import { registerBackHandler } from '../core/back-nav.js';
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
import { renderPersonnelIncomplete } from './personnel-incomplete.js';
import { renderPersonnelDocs } from './personnel-docs.js';
import { renderDepartmentCargos } from './department-cargos.js';
import { renderCertSigners } from './cert-signers.js';
import { renderCertRequests } from './cert-requests.js';
import { renderAxReview, renderAxCompare, renderAxHistory } from './ax-review.js';
import { renderErpQuery } from './erp-query.js';
import { renderSyncLog } from './sync-log.js';
import { renderResetData } from './reset-data.js';
import { renderRoles } from './roles.js';
import { injectPeriodTimeline } from './period-timeline.js';
import { renderPayGrid } from './pay-grid.js';
import { renderDepartments } from './departments.js';
import { axRosterPull, rosterCooldownMessage } from '../reports/shared/roster-ax.js';

/* Tipos de empresa que NO son tienda: pueden tener departamentos y usuarios
   de empresa. (companies.company_type) */
const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);

let CATALOG = null;       // { companies, zones, subzones, concepts }
let currentView = 'tiendas';

/* Catalogo geografico (estados + ciudades) para el modal de Empresas. Se
   carga una sola vez (perezoso) desde /api/logistic-geo y se cachea en el
   modulo. GEO = { states:[{id,name}], cities:[{state,name,municipality}] }. */
let GEO = null;
async function loadGeo() {
  if (GEO) return GEO;
  try {
    const d = await fetch('/api/logistic-geo').then(r => r.json());
    if (d && d.ok) GEO = { states: d.states || [], cities: d.cities || [] };
    else GEO = { states: [], cities: [] };
  } catch { GEO = { states: [], cities: [] }; }
  return GEO;
}

/* Filtros de la vista Empresas persistidos a nivel de modulo: al entrar a una
   empresa (Personal/Departamentos), sincronizar y volver, viewTiendas se
   re-ejecuta desde cero; guardar aqui lo elegido evita tener que volver a
   filtrar. Se setea en cada render y se restaura al construir la vista.
   null = primera vez (usa los defaults). selStatus va como Array. */
let TIENDAS_FILTERS = null;  // { name, type, statuses:[], zone, sub, concept }

/* ---------- iconos ---------- */
const I = {
  // v4.46: iconos de Comparar (flechas de intercambio) e Historial (reloj).
  compare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
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
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
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
    ['datosincompletos', I.bizreport, 'Datos incompletos'],
    ['egmotivos', I.check, 'Ratificar egresos'],
    ['rostersync', I.sync, 'Carga de personal'],
  ] },
  { title: 'Reportes', items: [
    ['historial', I.history, 'Historial'],
    ['estadisticas', I.chart, 'Estadísticas'],
    ['reportempresas', I.bizreport, 'Análisis'],
    ['estadopago', I.wallet, 'Estado de pago'],
  ] },
  { title: 'Comunicación', items: [
    ['avisos', I.bell, 'Avisos'],
    ['avisosconfig', I.megaphone, 'Envío de avisos'],
  ] },
  { title: 'Solicitudes', items: [
    ['constancias', I.docs, 'Constancias'],
    ['firmantes', I.pencil, 'Firmantes', 'superonly'],
  ] },
  { title: 'Sincronización', items: [
    ['syncreview', I.sync, 'Sincronizar', 'adminonly'],
    ['axcompare', I.compare, 'Comparar', 'adminonly'],
    ['axhistory', I.history, 'Historial', 'adminonly'],
    ['synclog', I.docs, 'Registro', 'adminonly'],
    ['erpquery', I.search, 'Consultar API', 'adminonly'],
    ['sync', I.cog, 'Configurar', 'superonly'],
  ] },
  { title: 'Administración', items: [
    ['equipo', I.team, 'Equipo'],
    ['permisos', I.shield, 'Permisos', 'superonly'],
    ['roles', I.shield, 'Roles', 'superonly'],
    ['config', I.cog, 'Configuración', 'superonly'],
    ['resetdata', I.trash, 'Reiniciar datos', 'superonly'],
  ] },
];

/* Todos los view validos para admin/super (para resaltar el activo, etc.). */
const NAV_ALL = [...NAV_LOOSE, ...NAV_GROUPS.flatMap(g => g.items.map(it => [...it, g.superonly ? 'superonly' : null]))];

/* ---------- NAVEGACION (tienda / company) ----------
   Mismo esquema agrupado que admin/super (items sueltos arriba + grupos
   colapsables), basado en la estructura del superadmin. Los `view` no cambian.
   Sueltos: Inicio, Mi empresa, Documentos, Calendario.
   Personal: Personal (fichas/fotos).
   Reportes: Historial, Mis estadisticas.
   Comunicacion: Avisos. */
const NAV_COMPANY_LOOSE = [
  ['dashboard', I.grid, 'Inicio'],
  ['miempresa', I.store, 'Mi empresa'],
  ['documentos', I.docs, 'Documentos'],
  ['calendario', I.calendar, 'Calendario'],
];
const NAV_COMPANY_GROUPS = [
  { title: 'Personal', items: [
    ['fotos', I.photo, 'Personal'],
  ] },
  { title: 'Solicitudes', items: [
    ['constancias', I.docs, 'Constancias'],
  ] },
  { title: 'Reportes', items: [
    ['historial', I.history, 'Historial'],
    ['misstats', I.chart, 'Mis estadísticas'],
  ] },
  { title: 'Comunicación', items: [
    ['avisos', I.bell, 'Avisos'],
  ] },
];

/* ---------- NAVEGACION (editor de personal) ----------
   Mismo esquema agrupado que admin/super. Los `view` no cambian.
   Sueltos: Inicio, Calendario.
   Organizacion: Empresas.
   Personal: Buscar, Carga de personal.
   Comunicacion: Avisos. */
const NAV_EDITOR_LOOSE = [
  ['dashboard', I.grid, 'Inicio'],
  ['calendario', I.calendar, 'Calendario'],
];
const NAV_EDITOR_GROUPS = [
  { title: 'Organización', items: [
    ['tiendas', I.store, 'Empresas'],
  ] },
  { title: 'Personal', items: [
    ['buscar', I.search, 'Buscar'],
    ['datosincompletos', I.bizreport, 'Datos incompletos'],
    ['rostersync', I.sync, 'Carga de personal'],
  ] },
  { title: 'Comunicación', items: [
    ['avisos', I.bell, 'Avisos'],
  ] },
];

/* ---------- NAVEGACION (gestor de empresa) ----------
   Rol para personas que gestionan una o varias empresas (no-tienda) dentro
   de su alcance, con o sin departamento. Puede CONSULTAR, REPORTAR y
   GESTIONAR el personal de sus empresas, pero NO administrar el portal
   (sin Estructura, Ratificar egresos, Carga de personal, Analisis, Estado
   de pago, Envio de avisos, ni el grupo Administracion). El alcance lo
   limita el backend igual que a un admin (no es superadmin -> filtra por
   get_admin_companies). Los `view` no cambian.
   Sueltos: Inicio, Documentos, Calendario.
   Organizacion: Empresas (desde ahi entra a Personal y a Reportar).
   Personal: Buscar.
   Reportes: Historial, Mis estadisticas.
   Comunicacion: Avisos. */
const NAV_GESTOR_LOOSE = [
  ['dashboard', I.grid, 'Inicio'],
  ['documentos', I.docs, 'Documentos'],
  ['calendario', I.calendar, 'Calendario'],
];
const NAV_GESTOR_GROUPS = [
  { title: 'Organización', items: [
    ['tiendas', I.store, 'Empresas'],
  ] },
  { title: 'Personal', items: [
    ['buscar', I.search, 'Buscar'],
    ['datosincompletos', I.bizreport, 'Datos incompletos'],
  ] },
  { title: 'Solicitudes', items: [
    ['constancias', I.docs, 'Constancias'],
  ] },
  { title: 'Reportes', items: [
    ['historial', I.history, 'Historial'],
    ['reportempresas', I.bizreport, 'Análisis'],
  ] },
  { title: 'Comunicación', items: [
    ['avisos', I.bell, 'Avisos'],
  ] },
];

/* Etiquetas legibles de rol para la topbar. */
const ROLE_LABELS = { superadmin: 'superadmin', admin: 'admin', editor_personal: 'editor_personal', gestor_empresa: 'gestor de empresa' };

/* ---------- Roles del equipo (dinamicos desde la BD) ----------
   Catalogo de roles asignables a miembros (todos menos 'tienda'), con la
   etiqueta visible que se edita en la vista Roles. Se carga al entrar a
   Equipo via /api/roles accion 'options' y alimenta el combo de Nuevo
   miembro y el de Cambiar rol. Si la carga falla, se usa el fallback
   historico para no bloquear la pantalla. */
const ADMIN_ROLES_FALLBACK = [
  { code: 'admin', label: 'Administrador', is_system: false },
  { code: 'gestor_empresa', label: 'Gestor de empresa', is_system: false },
  { code: 'editor_personal', label: 'Editor de personal', is_system: false },
  { code: 'superadmin', label: 'Superadmin', is_system: true },
];
let ADMIN_ROLES = null;
async function ensureAdminRoles(user) {
  if (ADMIN_ROLES) return ADMIN_ROLES;
  try {
    const d = await fetch('/api/roles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'options', user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null } }),
    }).then(r => r.json());
    if (d && d.ok && Array.isArray(d.roles) && d.roles.length) ADMIN_ROLES = d.roles;
  } catch (_) { /* fallback abajo */ }
  return ADMIN_ROLES || ADMIN_ROLES_FALLBACK;
}
function escRoleLbl(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function adminRoleOptionsHtml(selected) {
  return (ADMIN_ROLES || ADMIN_ROLES_FALLBACK).map(r =>
    `<option value="${r.code}"${r.code === selected ? ' selected' : ''}>${escRoleLbl(r.label)}</option>`).join('');
}

/* ---------- shell ---------- */
function shell(user) {
  const isCompany = user.kind === 'company';
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  const isEditorPersonal = user.kind === 'admin' && user.role === 'editor_personal';
  const isGestor = user.kind === 'admin' && user.role === 'gestor_empresa';
  // La campanita se muestra para admin/superadmin, editor_personal Y usuarios
  // company. El editor solo recibe avisos dirigidos a "Editores" (solo lectura);
  // no gestiona el seteo de avisos.
  const showBell = (user.kind === 'company') || (user.kind === 'admin');
  const nameLabel = isCompany ? user.companyCode : (user.name || user.username);
  const roleLabel = isCompany ? 'tienda' : (ROLE_LABELS[user.role] || user.role);
  const initials = (nameLabel || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const email = (user.email || '').trim().toLowerCase();

  // Navegación según rol. Todos los roles usan el MISMO esquema agrupado
  // (items sueltos arriba + grupos colapsables), basado en el del superadmin.
  //  - company:        NAV_COMPANY_LOOSE + NAV_COMPANY_GROUPS
  //  - editor_personal:NAV_EDITOR_LOOSE  + NAV_EDITOR_GROUPS
  //  - admin/super:    NAV_LOOSE         + NAV_GROUPS (Administracion solo super)
  let navLoose, navGroups;
  if (isCompany) {
    navLoose = NAV_COMPANY_LOOSE; navGroups = NAV_COMPANY_GROUPS;
  } else if (isEditorPersonal) {
    navLoose = NAV_EDITOR_LOOSE; navGroups = NAV_EDITOR_GROUPS;
  } else if (isGestor) {
    navLoose = NAV_GESTOR_LOOSE; navGroups = NAV_GESTOR_GROUPS;
  } else {
    navLoose = NAV_LOOSE; navGroups = NAV_GROUPS.filter(g => !g.superonly || isSuper);
  }

  // Botón de navegación. data-label alimenta el tooltip del modo riel.
  const navBtn = ([id, ic, label]) =>
    `<button data-view="${id}" data-label="${label}" class="${id === currentView ? 'active' : ''}">${ic}<span>${label}</span></button>`;

  // HTML del nav: items sueltos en .nav-loose + grupos con encabezado-chevron.
  const chev = '<svg class="nav-ghead-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  // Filtro por ITEM: 'superonly' solo el super; 'adminonly' cualquier usuario
  // administrativo (v4.57: los endpoints aplican la matriz de permisos, asi
  // que el menu abre la puerta y el permiso decide adentro).
  const itemVisible = (it) => it[3] === 'superonly' ? isSuper
    : it[3] === 'adminonly' ? user.kind === 'admin'
    : true;
  const navHtml = `<div class="nav-loose">${navLoose.filter(itemVisible).map(navBtn).join('')}</div>`
    + navGroups.map((g, gi) => {
        const items = g.items.filter(itemVisible);
        if (!items.length) return '';
        return `
        <div class="nav-group" data-group="${gi}">
          <button type="button" class="nav-ghead" data-group-toggle="${gi}"><span class="gh-label">${g.title}</span>${chev}</button>
          <div class="nav-gitems">${items.map(navBtn).join('')}</div>
        </div>`;
      }).join('');

  return `
  <style>
    .pnl-topbar-right{position:relative;display:flex;align-items:center;gap:10px}
    .pnl-bell{position:relative;background:none;border:0;cursor:pointer;color:var(--muted);padding:6px;border-radius:8px;display:flex;align-items:center}
    .pnl-bell:hover{background:var(--bg-soft,#f1f2f4);color:var(--text,#0f172a)}
    .pnl-bell-badge{position:absolute;top:-1px;right:-1px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:#e11d48;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;line-height:1}
    .pnl-bell-badge.is-solic{background:#16a34a}
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
        <div class="pnl-bwrap"><div class="pnl-bname">Portal de Nómina</div><div class="pnl-bver">v4.68</div></div>
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
let BELL_AUTO = [], BELL_MANUAL = [], BELL_EMPRESA = [], BELL_SOLIC = [];

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
/* Item de la campanita para una constancia lista (tienda). Verde. */
function bellSolicHtml(s) {
  const worker = s.worker_full_name ? escHtml(s.worker_full_name) : 'Constancia';
  return `<div class="pnl-bell-item" data-goto-solic="1" style="cursor:pointer">`
    + `<span class="ic" style="color:#16a34a">\u2705</span>`
    + `<div><div><b>Constancia lista</b> \u2014 ${worker}</div>`
    + `<div class="muted" style="font-size:11px;margin-top:2px">Ya puedes descargarla en Constancias</div></div></div>`;
}
function bellRender() {
  const pop = document.getElementById('pnlBellPop');
  if (!pop) return;
  let html = `<h4>Avisos <a id="pnlBellAll" style="font-size:11.5px;font-weight:500;cursor:pointer">Ver todos</a></h4>`;
  if (BELL_SOLIC.length) {
    html += `<div class="bell-group">Solicitudes</div>` + BELL_SOLIC.map(bellSolicHtml).join('');
  }
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
  // clic en un aviso de constancia lista -> ir a Constancias
  pop.querySelectorAll('[data-goto-solic]').forEach(el =>
    el.addEventListener('click', () => {
      pop.hidden = true;
      navigate('constancias', BELL_USER);
    }));
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
  // unreadRojo = avisos que fuerzan ROJO (nomina, comunicados, novedades).
  // unreadSolic = constancias listas (solo company) -> VERDE si no hay rojo.
  let unreadRojo = 0;
  let unreadSolic = 0;
  // 1) feed de avisos (todos los usuarios)
  try {
    const a = await fetch('/api/announcements', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'feed',
        user: user.kind === 'company' ? { kind: 'company', companyCode: user.companyCode } : { kind: 'admin', id: user.id },
      }),
    }).then(x => x.json());
    if (a && a.ok) { BELL_AUTO = a.auto || []; BELL_MANUAL = a.manual || []; unreadRojo += (a.unread || 0); }
  } catch (_) { /* nada */ }
  // 2) novedades de empresa (solo admin)
  if (user.kind === 'admin') {
    try {
      const r = await fetch('/api/notifications', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', adminId: user.id }),
      }).then(x => x.json());
      if (r && r.ok) { BELL_EMPRESA = r.items || []; unreadRojo += (r.unread || 0); }
    } catch (_) { /* nada */ }
  }
  // 3) constancias listas -> aviso VERDE. Para tienda (company) y para
  //    gestor_empresa (admin con alcance de empresas).
  const esGestor = user.kind === 'admin' && user.role === 'gestor_empresa';
  if (user.kind === 'company' || esGestor) {
    try {
      const actor = user.kind === 'company'
        ? { kind: 'company', companyCode: user.companyCode }
        : { kind: 'admin', id: user.id };
      const c = await fetch('/api/cert-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bell', actor }),
      }).then(x => x.json());
      if (c && c.ok) { BELL_SOLIC = c.items || []; unreadSolic += (c.unread || 0); }
    } catch (_) { /* nada */ }
  }
  const total = unreadRojo + unreadSolic;
  if (total > 0) {
    badge.textContent = total > 99 ? '99+' : String(total);
    // Rojo PRIMA: solo verde si no hay ningun aviso rojo.
    badge.classList.toggle('is-solic', unreadRojo === 0 && unreadSolic > 0);
    badge.style.display = 'flex';
  } else {
    badge.classList.remove('is-solic');
    badge.style.display = 'none';
  }
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
        // marcar visto las constancias listas (company o gestor)
        const esGestorSeen = user.kind === 'admin' && user.role === 'gestor_empresa';
        if (user.kind === 'company' || esGestorSeen) {
          try {
            const actor = user.kind === 'company'
              ? { kind: 'company', companyCode: user.companyCode }
              : { kind: 'admin', id: user.id };
            await fetch('/api/cert-requests', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'bell_seen', actor }),
            });
          } catch (_) { /* nada */ }
          badge.classList.remove('is-solic');
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
  // Chip "% con foto" (opcion C del mockup empresas_personal_foto):
  // cobertura de fotos del roster (photoCount/photoTotal de /api/catalog).
  // Semaforo: verde >=90, ambar 50-89, rojo <50. El detalle exacto va en
  // el title. Si el RPC no trae datos (photoTotal 0), no se muestra nada.
  let photoChip = '';
  if (c.photoTotal > 0) {
    const pct = Math.round((c.photoCount / c.photoTotal) * 100);
    const cls = pct >= 90 ? 'ph-ok' : pct >= 50 ? 'ph-mid' : 'ph-low';
    photoChip = `<span class="ph-chip ${cls}" title="${c.photoCount} de ${c.photoTotal} con foto">`
      + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>${pct}%</span>`;
  }
  return `<div class="cell-personal">`
    + `<div class="l1">${c.staffCount}${photoChip}</div>`
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
  const isGestor = user.kind === 'admin' && user.role === 'gestor_empresa';
  // El gestor de empresa NO administra: sin "Sincronizar todo", sin editar
  // contacto y sin Departamentos; pero SI puede entrar a Personal y Reportar.
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  const canSyncAll = isAdmin && !isGestor;
  const canEditContact = !isEditor && !isGestor;
  const canDepartments = !isEditor && !isGestor;
  const canReport = !isEditor;   // gestor si reporta; editor no
  // Direccion + contacto de la empresa: SOLO superadmin edita; el resto abre
  // el modal en modo consulta (campos disabled, sin boton Guardar).
  const canEditCompany = isSuper;
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
        ${canSyncAll ? `<button class="btn btn-primary" id="syncAllBtn">${I.sync} Sincronizar todo</button>` : ''}
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
      <div class="search">${I.search}<input id="fName" type="text" placeholder="Buscar nombre, c\u00f3digo o DataArea\u2026"></div>
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
    <div class="tablebox scroll-x tbl-stickyact">
      <table><thead><tr>
        <th>Código</th><th>Razón social</th><th>Tipo</th><th>Ubicación / Concepto</th><th>Contacto</th><th>Personal</th><th>Estado</th><th>Acceso</th><th style="text-align:right">Reportar</th>
      </tr></thead><tbody id="tBody"></tbody></table>
    </div>
    <div class="emp-cards" id="tCards"></div>
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
      return (`${c.code} ${c.name || ''} ${c.dataArea || ''}`.toLowerCase().includes(n))
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
    // Host activo: en movil TARJETAS en #tCards; en escritorio filas en #tBody.
    const mobile = window.matchMedia('(max-width:768px)').matches;
    const tableBox = $('#pnlMain').querySelector('.tablebox');
    const cardsBox = $('#tCards');
    if (tableBox) tableBox.style.display = mobile ? 'none' : '';
    if (cardsBox) cardsBox.style.display = mobile ? '' : 'none';
    const host = mobile ? cardsBox : $('#tBody');
    if (!rows.length) {
      host.innerHTML = mobile
        ? '<div class="emp-empty">Sin resultados.</div>'
        : '<tr><td colspan="9" class="empty">Sin resultados.</td></tr>';
    } else {
      host.innerHTML = rows.map(c => mobile ? empCard(c) : empRow(c)).join('');
    }
    wireEmpRows(host);
  }

  // ---- Fila de ESCRITORIO (<tr>) ----
  function empRow(c) {
      const tel = phoneDisplay(c.phone);
      const tel2 = phoneDisplay(c.phone2);
      const telLine = [tel, tel2].filter(Boolean).join(' / ') || 'sin teléfono';
      const contacto = `
        <div class="contact-cell">
          <div class="contact-lines">
            <span class="${c.email ? '' : 'muted'}">${c.email || 'sin correo'}</span>
            <span class="muted" style="font-size:12px">${telLine}</span>
          </div>
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
        <td style="text-align:right;white-space:nowrap"><button class="btn btn-mini" data-photos-code="${c.code}" data-photos-name="${(c.name||'').replace(/"/g,'')}" title="Personal / fichas" style="margin-right:4px">${I.photo} Personal</button>${(canDepartments && NON_STORE_TYPES.has(c.type)) ? `<button class="btn btn-mini" data-dep-code="${c.code}" title="Departamentos" style="margin-right:4px">${I.grid} Deptos${c.deptCount ? ` <span class="dep-count">${c.deptCount}</span>` : ''}</button>` : ''}${canReport ? `<button class="btn btn-mini" data-report-code="${c.code}" data-report-name="${(c.name||'').replace(/"/g,'')}" title="Reportar" style="margin-right:4px">${I.bizreport} Reportar</button>` : ''}<button class="btn btn-mini" data-addr-code="${c.code}" data-addr-name="${(c.name||'').replace(/"/g,'')}" title="${canEditCompany ? 'Editar direccion y contacto' : 'Ver direccion y contacto'}">${I.pin} Direcci\u00f3n</button></td>
      </tr>`;
  }

  // ---- Tarjeta MOVIL (<div>) ----
  // Empresas NO tiene "abrir fila": la accion principal es Personal. Cabecera
  // (icono por tipo + codigo/alias + razon social + estado a la derecha),
  // datos en pares (Tipo, Ubicacion, Concepto, Personal, Correo, Telefono,
  // Acceso) y acciones abajo: Personal (texto) + secundarias solo-icono
  // (Reportar / Deptos / Direccion). Mismos data-* que la fila -> wireEmpRows.
  function empCard(c) {
    const tel = phoneDisplay(c.phone);
    const tel2 = phoneDisplay(c.phone2);
    const telLine = [tel, tel2].filter(Boolean).join(' / ') || 'sin tel\u00e9fono';
    const rows = [];
    rows.push(['Tipo', typePill(c.type)]);
    rows.push(['Ubicaci\u00f3n', `${c.zone || '\u2014'}${c.subzone ? ' \u00b7 ' + c.subzone : ''}`]);
    if (c.concept) rows.push(['Concepto', c.concept]);
    rows.push(['Personal', personalCell(c)]);
    rows.push(['Correo', c.email ? c.email : '<span class="muted">sin correo</span>']);
    rows.push(['Tel\u00e9fono', `<span class="muted">${telLine}</span>`]);
    rows.push(['Acceso', c.hasAccess
      ? `<span class="emp-acc yes">${I.check} con acceso</span>`
      : `<span class="emp-acc no">${I.circle} sin usuario</span>`]);
    const grid = rows.map(([k, v]) => `<span class="hc-k">${k}</span><span class="hc-v">${v}</span>`).join('');

    const nameEsc = (c.name || '').replace(/"/g, '');
    // Acciones: Personal (principal, con texto) + iconos segun permisos.
    const iconBtns = []
      .concat(canReport
        ? [`<button class="btn hc-ib" data-report-code="${c.code}" data-report-name="${nameEsc}" title="Reportar" aria-label="Reportar">${I.bizreport}</button>`]
        : [])
      .concat((canDepartments && NON_STORE_TYPES.has(c.type))
        ? [`<button class="btn hc-ib" data-dep-code="${c.code}" title="Departamentos" aria-label="Departamentos">${I.grid}${c.deptCount ? `<span class="dep-count">${c.deptCount}</span>` : ''}</button>`]
        : [])
      .concat([`<button class="btn hc-ib" data-addr-code="${c.code}" data-addr-name="${nameEsc}" title="${canEditCompany ? 'Editar direccion y contacto' : 'Ver direccion y contacto'}" aria-label="Direccion">${I.pin}</button>`])
      .join('');
    const acts = `<div class="hc-acts">
      <button class="btn hc-detail" data-photos-code="${c.code}" data-photos-name="${nameEsc}">${I.photo} Personal</button>
      ${iconBtns}
    </div>`;

    return `<div class="emp-card">
      <div class="hc-top">
        <div class="hc-ic"><span class="alias ${tyClass(c.type)}">${(c.code || '').slice(0, 4)}</span></div>
        <div class="hc-tt">
          <div class="hc-t1 alias ${tyClass(c.type)}">${c.code}${c.dataArea ? ` <span class="darea">${c.dataArea}</span>` : ''}</div>
          <div class="hc-t2">${c.name || '\u2014'}${c.taxId ? ` \u00b7 RIF ${c.taxId}` : ''}</div>
        </div>
        ${statusPill(c.status)}
      </div>
      <div class="hc-grid">${grid}</div>
      ${acts}
    </div>`;
  }

  // ---- Cableado de listeners sobre el host activo (tabla o tarjetas) ----
  // Mismos data-* en fila y tarjeta -> un solo conjunto de listeners.
  function wireEmpRows(host) {
    host.querySelectorAll('[data-addr-code]').forEach(b =>
      b.addEventListener('click', () => {
        const c = CATALOG.companies.find(x => x.code === b.dataset.addrCode);
        companyEditModal(user, c, canEditCompany);
      }));
    host.querySelectorAll('[data-report-code]').forEach(b =>
      b.addEventListener('click', () => {
        const rc = CATALOG.companies.find(x => x.code === b.dataset.reportCode);
        const u = { ...user, pickedCompany: b.dataset.reportCode, pickedCompanyName: b.dataset.reportName, pickedCompanyType: rc ? rc.type : null };
        openReportPicker(u, () => viewTiendas(user));
      }));
    host.querySelectorAll('[data-photos-code]').forEach(b =>
      b.addEventListener('click', () => {
        // Admin/superadmin entra a las fichas/fotos de la empresa elegida.
        // El "Volver" regresa a la lista de Empresas. Si la empresa NO es
        // tienda, se entra en modo 'enterprise' (carga por Reporte AX).
        const c = CATALOG.companies.find(x => x.code === b.dataset.photosCode);
        const mode = c && NON_STORE_TYPES.has(c.type) ? 'enterprise' : 'store';
        currentView = 'fotos';
        document.querySelectorAll('#pnlNav button').forEach(x => x.classList.remove('active'));
        let removeFotoBack = null;
        const backToTiendas = () => {
          if (removeFotoBack) { removeFotoBack(); removeFotoBack = null; }
          currentView = 'tiendas'; CATALOG = null; navigate('tiendas', user);
        };
        removeFotoBack = pushBackInterceptor(() => { backToTiendas(); return true; });
        renderWorkerPhotos(user, b.dataset.photosCode, backToTiendas, { mode });
      }));
    host.querySelectorAll('[data-dep-code]').forEach(b =>
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
/* Modal unificado de Empresa: contacto (correo/tel1/tel2) + direccion
   (estado -> ciudad dependientes, municipio deducido, direccion larga).
   - canEdit === true  => superadmin: campos editables, boton Guardar.
   - canEdit === false => resto de roles: modo consulta (disabled, sin Guardar).
   Los combos Estado/Ciudad se llenan del catalogo geografico (/api/logistic-geo,
   cacheado en GEO). La ciudad determina el municipio (se guarda deducido, no se
   elige). No usa alert/confirm nativos: los errores van en un aviso inline. */
async function companyEditModal(user, c, canEdit) {
  if (!c) return;
  const ro = canEdit ? '' : ' disabled';
  const title = canEdit ? 'Editar empresa' : 'Datos de la empresa';

  openModal(`
    <div class="modal-head"><span>${title}</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 14px">${c.code}${c.name ? ' · ' + c.name : ''}${canEdit ? '' : ' · <span style="color:var(--muted)">solo consulta</span>'}</p>

    <div class="ce-sec-title" style="font-weight:600;font-size:12.5px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em">Contacto</div>
    <label class="flabel">Correo</label>
    <input type="text" id="emInput" value="${(c.email || '').replace(/"/g,'&quot;')}" placeholder="compania@grupocanaima.com" style="margin-bottom:12px"${ro}>
    <div style="display:flex;gap:10px;margin-bottom:14px">
      <div style="flex:1"><label class="flabel">Teléfono 1 <span class="muted">(04XX)</span></label>
        <input type="text" id="phInput" value="${phoneNational(c.phone)}" placeholder="04121234567"${ro}></div>
      <div style="flex:1"><label class="flabel">Teléfono 2 <span class="muted">(opcional)</span></label>
        <input type="text" id="phInput2" value="${phoneNational(c.phone2)}" placeholder="04241234567"${ro}></div>
    </div>

    <div class="ce-sec-title" style="font-weight:600;font-size:12.5px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em">Dirección</div>
    <label class="flabel">Estado</label>
    <select id="stInput" style="width:100%;margin-bottom:12px"${ro}><option value="">— Cargando… —</option></select>
    <label class="flabel">Ciudad</label>
    <select id="ctInput" style="width:100%;margin-bottom:12px"${ro}><option value="">— Seleccione un estado —</option></select>
    <label class="flabel">Municipio</label>
    <select id="muInput" style="width:100%;margin-bottom:12px"${ro}><option value="">— Seleccione una ciudad —</option></select>
    <label class="flabel">Dirección completa</label>
    <textarea id="adInput" rows="3" placeholder="Av., calle, edificio, local, punto de referencia…" style="margin-bottom:6px;resize:vertical;width:100%"${ro}>${(c.address || '').replace(/</g,'&lt;')}</textarea>
    <p class="muted" style="font-size:11.5px;margin:0">${canEdit ? 'El teléfono se guarda en formato internacional (+58). Deja un campo vacío para quitarlo.' : 'Esta vista es de solo lectura.'}</p>

    <div class="ce-err" id="ceErr" style="display:none;margin-top:12px;padding:9px 12px;border-radius:8px;background:#fee2e2;color:#991b1b;font-size:12.5px"></div>

    <div class="modal-actions">
      <button class="btn" id="mCancel">${canEdit ? 'Cancelar' : 'Cerrar'}</button>
      ${canEdit ? '<button class="btn btn-primary" id="mOk">Guardar</button>' : ''}
    </div>`);

  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);

  const stSel = $('#stInput'), ctSel = $('#ctInput'), muSel = $('#muInput');
  const errBox = $('#ceErr');
  const showErr = msg => { errBox.textContent = msg; errBox.style.display = 'block'; };
  const hideErr = () => { errBox.style.display = 'none'; };

  // Poblar los combos con el catalogo geografico (perezoso).
  const geo = await loadGeo();
  const curState = (c.state || '').trim();
  const curCity = (c.city || '').trim();
  const curMuni = (c.municipality || '').trim();
  const stateExists = geo.states.some(s => s.name === curState);
  stSel.innerHTML = '<option value="">— Sin estado —</option>'
    + geo.states.map(s => `<option value="${s.name.replace(/"/g,'&quot;')}"${s.name === curState ? ' selected' : ''}>${s.name}</option>`).join('')
    + (curState && !stateExists ? `<option value="${curState.replace(/"/g,'&quot;')}" selected>${curState} (actual)</option>` : '');

  // Helpers de catalogo por estado seleccionado.
  function stateId() {
    const stObj = geo.states.find(s => s.name === stSel.value);
    return stObj ? stObj.id : null;
  }
  function citiesOfState() {
    const sid = stateId();
    return sid ? geo.cities.filter(ci => ci.state === sid) : [];
  }
  // Municipios distintos del estado (ordenados).
  function munisOfState() {
    const set = new Set(citiesOfState().map(ci => ci.municipality).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b, 'es'));
  }
  function muniOfCity(cityName) {
    const hit = citiesOfState().find(ci => ci.name === cityName);
    return (hit && hit.municipality) ? hit.municipality : '';
  }

  // Rellena Ciudad segun el estado. preserveCity=true usa la ciudad actual de
  // la empresa; si no, conserva la seleccion vigente del combo.
  function fillCities(preserveCity) {
    const list = citiesOfState();
    const keep = preserveCity ? curCity : ctSel.value;
    const cityExists = list.some(ci => ci.name === keep);
    ctSel.innerHTML = '<option value="">— Sin ciudad —</option>'
      + list.map(ci => `<option value="${ci.name.replace(/"/g,'&quot;')}"${ci.name === keep ? ' selected' : ''}>${ci.name}</option>`).join('')
      + (keep && !cityExists ? `<option value="${keep.replace(/"/g,'&quot;')}" selected>${keep} (actual)</option>` : '');
  }

  // Rellena Municipio con los del estado. selectMuni = municipio a marcar
  // (normalmente el de la ciudad elegida). Conserva un municipio 'actual'
  // fuera de catalogo si hiciera falta.
  function fillMunis(selectMuni) {
    const list = munisOfState();
    const keep = selectMuni != null ? selectMuni : muSel.value;
    const exists = list.some(m => m === keep);
    muSel.innerHTML = '<option value="">— Sin municipio —</option>'
      + list.map(m => `<option value="${m.replace(/"/g,'&quot;')}"${m === keep ? ' selected' : ''}>${m}</option>`).join('')
      + (keep && !exists ? `<option value="${keep.replace(/"/g,'&quot;')}" selected>${keep} (actual)</option>` : '');
  }

  // Al cambiar la CIUDAD: el municipio se ajusta al de esa ciudad.
  function onCityChange() {
    fillMunis(muniOfCity(ctSel.value));
  }
  // Al cambiar el MUNICIPIO: la ciudad salta a la PRIMERA ciudad de ese
  // municipio (si hay varias, la primera del catalogo).
  function onMuniChange() {
    const m = muSel.value;
    if (!m) return;
    const first = citiesOfState().find(ci => ci.municipality === m);
    if (first) {
      // Asegurar que la opcion exista y seleccionarla.
      if (![...ctSel.options].some(o => o.value === first.name)) fillCities(false);
      ctSel.value = first.name;
    }
  }

  // Carga inicial: Estado -> Ciudad (actual) -> Municipio (el de la ciudad, o
  // el municipio actual guardado si la ciudad no lo resuelve).
  fillCities(true);
  fillMunis(muniOfCity(curCity) || curMuni);

  if (canEdit) {
    stSel.addEventListener('change', () => { fillCities(false); fillMunis(muniOfCity(ctSel.value)); hideErr(); });
    ctSel.addEventListener('change', () => { onCityChange(); hideErr(); });
    muSel.addEventListener('change', () => { onMuniChange(); hideErr(); });
    ['emInput','phInput','phInput2','adInput'].forEach(id => {
      const el = $('#' + id); if (el) el.addEventListener('input', hideErr);
    });

    $('#mOk').addEventListener('click', async () => {
      hideErr();
      const btn = $('#mOk'); btn.disabled = true; btn.textContent = 'Guardando…';
      // Municipio = el elegido en el combo (o el deducido de la ciudad si el
      // combo quedara vacio).
      const muni = muSel.value || muniOfCity(ctSel.value) || '';
      let d;
      try {
        d = await fetch('/api/company-contact', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            adminId: user.id, companyCode: c.code,
            email: $('#emInput').value, phone: $('#phInput').value, phone2: $('#phInput2').value,
            address: $('#adInput').value, state: stSel.value, city: ctSel.value, municipality: muni,
          }),
        }).then(r => r.json());
      } catch (e) { d = { ok: false, error: 'No se pudo guardar (red).' }; }
      if (!d || !d.ok) { showErr((d && d.error) || 'No se pudo guardar.'); btn.disabled = false; btn.textContent = 'Guardar'; return; }
      closeModal();
      // Refrescar el objeto en memoria y re-render.
      c.email = d.email; c.phone = d.phone; c.phone2 = d.phone2;
      c.address = d.address; c.state = d.state; c.city = d.city; c.municipality = d.municipality;
      viewTiendas(user);
    });
  }
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

/* ---------- VISTA: ESTRUCTURA (antes "Catalogos") ----------
   Dos vistas jerarquicas que COMPARTEN el mismo filtro de estados:
   - Zonas y subzonas: expandir una zona muestra sus subzonas, con barra de
     distribucion por estado y conteo de empresas.
   - Conceptos: expandir un concepto muestra en que zonas esta presente.
   Todo se calcula EN VIVO desde CATALOG (ya filtrado por alcance en el
   backend). 4 stat-cards + filtro de estados (Activas por defecto) +
   exportar (xlsx/csv/txt) respetando el filtro. No usa datos hardcodeados.

   Estados reales de companies.status -> 5 claves del grafico:
     Abierto -> open · Cerrada temporal -> temp · Cerrado -> closed
     Proyectada -> proj · Nulo/vacio -> none */
const EST_ST_KEYS = ['open', 'temp', 'closed', 'proj', 'none'];
const EST_ST_LABEL = { open: 'Abierta', temp: 'Cerrada temporal', closed: 'Cerrada', proj: 'Proyectada', none: 'Sin estado' };
const EST_ST_COLOR = { open: '#16a34a', temp: '#d97706', closed: '#dc2626', proj: '#7c3aed', none: '#cbd5e1' };

/* status real -> indice 0..4 en el vector [open,temp,closed,proj,none] */
function estStatusKey(status) {
  const x = (status || '').toLowerCase();
  if (x.includes('abier')) return 'open';
  if (x.includes('cerrad') && x.includes('temp')) return 'temp';
  if (x.includes('cerrad')) return 'closed';
  if (x.includes('proyect')) return 'proj';
  return 'none';   // Nulo, vacio o desconocido
}

/* Estado del modulo Estructura (persistido entre re-renders de la vista). */
let EST_TAB = 'zonas';
const EST_EXP_Z = new Set();   // zonas expandidas (por id)
const EST_EXP_C = new Set();   // conceptos expandidos (por nombre)
let EST_SEL = null;            // Set de estados seleccionados; null = init (Activas)

function estSelSet() {
  if (!EST_SEL) EST_SEL = new Set(['open', 'temp']);   // Activas por defecto
  return EST_SEL;
}
function estSumSel(vec) {
  const sel = estSelSet();
  return EST_ST_KEYS.reduce((a, k, i) => a + (sel.has(k) ? vec[i] : 0), 0);
}
function estSumVecs(vecs) {
  const out = [0, 0, 0, 0, 0];
  vecs.forEach(v => v.forEach((n, i) => out[i] += n));
  return out;
}

/* Construye la estructura de datos desde CATALOG (en vivo):
   zones: [{id,name,letter, subs:[{id,name, vec:[5]}], vec:[5]}]
   concepts: [{name, zonas:[{id,letter,name, vec:[5]}], vec:[5]}] */
function estBuildData() {
  const comps = CATALOG.companies || [];
  const zById = {}; (CATALOG.zones || []).forEach(z => { zById[z.id] = z; });
  const sById = {}; (CATALOG.subzones || []).forEach(s => { sById[s.id] = s; });

  // ---- Zonas y subzonas ----
  const zoneMap = {};   // zoneId -> { id,name,letter, subMap:{subId:{id,name,vec}}, vec, noSub:vec }
  (CATALOG.zones || []).forEach(z => {
    zoneMap[z.id] = { id: z.id, name: z.name, letter: z.letter || '', subMap: {}, vec: [0,0,0,0,0] };
  });
  comps.forEach(c => {
    const zid = c.zoneId;
    if (zid == null || !zoneMap[zid]) return;   // empresa sin zona valida -> fuera del arbol de zonas
    const ki = EST_ST_KEYS.indexOf(estStatusKey(c.status));
    zoneMap[zid].vec[ki]++;
    const sid = c.subzoneId;
    if (sid != null && sById[sid]) {
      if (!zoneMap[zid].subMap[sid]) zoneMap[zid].subMap[sid] = { id: sid, name: sById[sid].name, vec: [0,0,0,0,0] };
      zoneMap[zid].subMap[sid].vec[ki]++;
    }
  });
  const zones = Object.values(zoneMap).map(z => ({
    id: z.id, name: z.name, letter: z.letter,
    vec: z.vec,
    subs: Object.values(z.subMap),
  }));

  // ---- Conceptos -> zonas ----
  // company.concept es el NOMBRE del concepto (string) o null.
  const cMap = {};   // conceptName -> { name, zMap:{zoneId:{id,letter,name,vec}} }
  comps.forEach(c => {
    const cn = c.concept;
    if (!cn) return;   // sin concepto -> fuera de la vista de conceptos
    if (!cMap[cn]) cMap[cn] = { name: cn, zMap: {} };
    const zid = c.zoneId;
    const z = zid != null ? zById[zid] : null;
    const zkey = z ? z.id : '__none__';
    if (!cMap[cn].zMap[zkey]) {
      cMap[cn].zMap[zkey] = { id: zkey, letter: z ? (z.letter || '') : '', name: z ? z.name : 'Sin zona', vec: [0,0,0,0,0] };
    }
    const ki = EST_ST_KEYS.indexOf(estStatusKey(c.status));
    cMap[cn].zMap[zkey].vec[ki]++;
  });
  const concepts = Object.values(cMap).map(c => ({
    name: c.name,
    zonas: Object.values(c.zMap),
    vec: estSumVecs(Object.values(c.zMap).map(z => z.vec)),
  }));

  return { zones, concepts };
}

function estEnsureStyles() {
  if (document.getElementById('estStyles')) return;
  const st = document.createElement('style');
  st.id = 'estStyles';
  st.textContent = `
  .est-tabs{display:flex;gap:4px;border-bottom:0;margin-bottom:0;}
  .est-tab{font-family:inherit;font-size:13.5px;font-weight:600;padding:9px 16px;border:0;background:none;
    color:var(--muted,#64748b);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;display:flex;align-items:center;gap:7px;}
  .est-tab:hover{color:var(--ink,#0f172a);}
  .est-tab.on{color:var(--brand,#2563eb);border-bottom-color:var(--brand,#2563eb);}
  .est-tab .cnt{font-size:11px;background:var(--border-soft,#f1f4f8);color:var(--muted,#64748b);border-radius:20px;padding:1px 7px;font-weight:700;}
  .est-tab.on .cnt{background:var(--brand-bg,#eff4ff);color:var(--brand,#2563eb);}
  .est-tabbar{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;
    border-bottom:1px solid var(--border,#e6eaf0);margin-bottom:14px;}
  .est-bar-wrap{display:flex;align-items:center;gap:10px;min-width:160px;}
  .est-bar-track{flex:1;height:9px;background:var(--border-soft,#f1f4f8);border-radius:6px;overflow:hidden;display:flex;}
  .est-bar-seg{height:100%;}
  .est-bar-n{font-weight:700;font-variant-numeric:tabular-nums;min-width:24px;text-align:right;}
  .est-pchip{display:inline-flex;align-items:center;justify-content:center;height:26px;border-radius:8px;
    font-weight:700;font-size:12px;margin-right:10px;flex-shrink:0;padding:0 8px;}
  .est-pchip.zone{min-width:26px;background:var(--brand-bg,#eff4ff);color:var(--brand,#2563eb);}
  .est-pchip.concept{background:#f3eefe;color:#7c3aed;}
  .est-pname{font-weight:600;}
  .est-chev{width:13px;height:13px;stroke:var(--faint,#94a3b8);transition:transform .15s;margin-right:4px;vertical-align:middle;}
  tr.est-open .est-chev{transform:rotate(90deg);}
  tr.est-exp{cursor:pointer;}
  tr.est-exp:hover .est-pname{color:var(--brand,#2563eb);}
  tr.est-sub{background:#fbfcfe;}
  tr.est-sub td{padding-top:8px;padding-bottom:8px;font-size:13px;color:var(--ink-soft,#475569);}
  tr.est-sub td:first-child{padding-left:48px;position:relative;}
  tr.est-sub.est-hidden{display:none;}
  .est-subtag{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:24px;
    background:#eef2f8;color:var(--ink-soft,#475569);font-size:12px;font-weight:700;border-radius:7px;padding:0 7px;margin-right:9px;}
  .est-legend{display:flex;gap:16px;flex-wrap:wrap;margin:12px 2px 0;font-size:12px;color:var(--muted,#64748b);}
  .est-legend span{display:inline-flex;align-items:center;gap:6px;}
  .est-legend i{width:10px;height:10px;border-radius:3px;display:inline-block;}
  #estStWrap{flex:0 0 auto;}
  #estStBtn{width:auto;white-space:nowrap;}
  .est-ms-menu{position:absolute;right:0;top:calc(100% + 6px);background:#fff;border:1px solid var(--border,#e6eaf0);
    border-radius:10px;box-shadow:0 12px 28px rgba(15,23,42,.14);z-index:30;min-width:230px;padding:6px;}
  .est-ms-quick{display:flex;gap:4px;padding:4px;}
  .est-ms-quick button{flex:1;font-family:inherit;font-size:12px;font-weight:600;padding:6px 4px;border-radius:7px;
    border:1px solid var(--border,#e6eaf0);background:#fff;color:var(--ink-soft,#475569);cursor:pointer;}
  .est-ms-quick button:hover{background:var(--brand-bg,#eff4ff);color:var(--brand,#2563eb);border-color:var(--brand-bg,#eff4ff);}
  .est-ms-sep{height:1px;background:var(--border,#e6eaf0);margin:6px 2px;}
  .est-ms-opt{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:7px;cursor:pointer;font-size:13px;}
  .est-ms-opt:hover{background:var(--border-soft,#f1f4f8);}
  .est-ms-opt .dot{width:9px;height:9px;border-radius:3px;flex-shrink:0;}
  .est-ms-opt span.lbl{flex:1;}
  .est-ms-opt .est-ms-count{color:var(--muted,#64748b);font-size:12px;font-variant-numeric:tabular-nums;}
  `;
  document.head.appendChild(st);
}

/* barra de distribucion por estado (solo los estados seleccionados). */
function estSegHtml(vec, maxRef) {
  const sel = estSelSet();
  const total = estSumSel(vec);
  if (!total) return '<div class="est-bar-track"></div>';
  const segs = EST_ST_KEYS.map((k, i) => {
    if (!sel.has(k) || !vec[i]) return '';
    return `<div class="est-bar-seg" style="width:${vec[i] / maxRef * 100}%;background:${EST_ST_COLOR[k]}" title="${EST_ST_LABEL[k]}: ${vec[i]}"></div>`;
  }).join('');
  return `<div class="est-bar-track">${segs}</div>`;
}

let EST_DATA = null;   // { zones, concepts } construido en vivo

function estStLabelText() {
  const sel = estSelSet();
  const n = sel.size;
  if (n === 0) return 'Sin estados';
  if (n === 5) return 'Todos';
  if (n === 2 && sel.has('open') && sel.has('temp')) return 'Activas';
  if (n === 1) return EST_ST_LABEL[[...sel][0]];
  return `${n} estados`;
}

function viewCatalogos() {
  estEnsureStyles();
  EST_DATA = estBuildData();
  const sel = estSelSet();

  // Conteos por estado (universo completo, para el menu de estados).
  const allVec = estSumVecs(EST_DATA.zones.map(z => z.vec));
  // Empresas sin zona no entran en el arbol de zonas; para el total de
  // empresas del filtro usamos el conteo real sobre companies.
  const compByKey = [0,0,0,0,0];
  (CATALOG.companies || []).forEach(c => { compByKey[EST_ST_KEYS.indexOf(estStatusKey(c.status))]++; });

  $('#pnlMain').innerHTML = `
    <div class="pnl-head">
      <div><h1>Estructura</h1><p id="estSubtitle">Zonas y subzonas de la organizaci\u00f3n</p></div>
      <div class="head-actions">
        <div class="export-wrap">
          <button class="btn" id="estExportBtn">Exportar \u25be</button>
          <div class="export-menu" id="estExportMenu" hidden>
            <button data-fmt="xlsx">Excel (.xlsx)</button>
            <button data-fmt="csv">CSV (.csv)</button>
            <button data-fmt="txt">Texto (.txt)</button>
          </div>
        </div>
      </div>
    </div>
    <div id="estStats"></div>
    <div class="est-tabbar">
      <div class="est-tabs">
        <button class="est-tab on" data-tab="zonas">Zonas y subzonas <span class="cnt">${EST_DATA.zones.length}</span></button>
        <button class="est-tab" data-tab="conceptos">Conceptos <span class="cnt">${EST_DATA.concepts.length}</span></button>
      </div>
      <div class="ms-wrap" id="estStWrap" style="position:relative;margin-bottom:8px">
        <button class="ms-toggle" id="estStBtn"><span style="color:var(--faint,#94a3b8);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin-right:2px">Estados:</span> <span id="estStLabel">${estStLabelText()}</span>
          ${I.chevron.replace('<svg', '<svg class="ms-caret"')}</button>
        <div class="est-ms-menu" id="estStMenu" hidden>
          <div class="est-ms-quick">
            <button data-q="active">Activas</button>
            <button data-q="all">Todos</button>
            <button data-q="none">Ninguno</button>
          </div>
          <div class="est-ms-sep"></div>
          ${EST_ST_KEYS.map((k, i) => `<label class="est-ms-opt"><input type="checkbox" value="${k}" ${sel.has(k) ? 'checked' : ''}><i class="dot" style="background:${EST_ST_COLOR[k]}"></i><span class="lbl">${EST_ST_LABEL[k]}</span><span class="est-ms-count">${compByKey[i]}</span></label>`).join('')}
        </div>
      </div>
    </div>
    <div id="estTabZonas">
      <div class="pnl-filters">
        <div class="search">${I.search}<input id="estZSearch" placeholder="Buscar zona, subzona o c\u00f3digo\u2026"></div>
        <select id="estZSort">
          <option value="emp_desc">Orden: M\u00e1s empresas</option>
          <option value="emp_asc">Orden: Menos empresas</option>
          <option value="name">Orden: Nombre (A\u2192Z)</option>
          <option value="letter">Orden: Letra</option>
        </select>
        <button class="btn" id="estZExpand">Expandir todo</button>
      </div>
      <div class="tablebox scroll-x">
        <table><thead><tr><th>Zona</th><th style="text-align:right">Subzonas</th><th style="text-align:right">Empresas</th><th>Distribuci\u00f3n por estado</th></tr></thead>
        <tbody id="estZBody"></tbody></table>
      </div>
    </div>
    <div id="estTabConceptos" hidden>
      <div class="pnl-filters">
        <div class="search">${I.search}<input id="estCSearch" placeholder="Buscar concepto o zona\u2026"></div>
        <select id="estCSort">
          <option value="emp_desc">Orden: M\u00e1s empresas</option>
          <option value="name">Orden: Nombre (A\u2192Z)</option>
        </select>
        <button class="btn" id="estCExpand">Expandir todo</button>
      </div>
      <div class="tablebox scroll-x">
        <table><thead><tr><th>Concepto</th><th style="text-align:right">Zonas</th><th style="text-align:right">Empresas</th><th>Distribuci\u00f3n por estado</th></tr></thead>
        <tbody id="estCBody"></tbody></table>
      </div>
    </div>
    <div class="est-legend">
      ${EST_ST_KEYS.map(k => `<span><i style="background:${EST_ST_COLOR[k]}"></i>${EST_ST_LABEL[k]}</span>`).join('')}
    </div>`;

  // Pestanas
  $('#pnlMain').querySelectorAll('.est-tab').forEach(b =>
    b.addEventListener('click', () => {
      EST_TAB = b.dataset.tab;
      $('#pnlMain').querySelectorAll('.est-tab').forEach(x => x.classList.toggle('on', x === b));
      $('#estTabZonas').hidden = EST_TAB !== 'zonas';
      $('#estTabConceptos').hidden = EST_TAB !== 'conceptos';
      $('#estSubtitle').textContent = EST_TAB === 'zonas'
        ? 'Zonas y subzonas de la organizaci\u00f3n'
        : 'Conceptos y las zonas donde est\u00e1n presentes';
    }));
  // estado inicial de pestana
  $('#pnlMain').querySelectorAll('.est-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === EST_TAB));
  $('#estTabZonas').hidden = EST_TAB !== 'zonas';
  $('#estTabConceptos').hidden = EST_TAB !== 'conceptos';
  $('#estSubtitle').textContent = EST_TAB === 'zonas'
    ? 'Zonas y subzonas de la organizaci\u00f3n' : 'Conceptos y las zonas donde est\u00e1n presentes';

  // Menu de estados (compartido)
  const stBtn = $('#estStBtn'), stMenu = $('#estStMenu');
  stBtn.addEventListener('click', (e) => { e.stopPropagation(); stMenu.hidden = !stMenu.hidden; });
  stMenu.addEventListener('click', (e) => e.stopPropagation());
  stMenu.querySelectorAll('input[type=checkbox]').forEach(cb =>
    cb.addEventListener('change', () => {
      if (cb.checked) sel.add(cb.value); else sel.delete(cb.value);
      $('#estStLabel').textContent = estStLabelText();
      estRerender();
    }));
  stMenu.querySelectorAll('.est-ms-quick button').forEach(b =>
    b.addEventListener('click', () => {
      sel.clear();
      if (b.dataset.q === 'all') EST_ST_KEYS.forEach(k => sel.add(k));
      else if (b.dataset.q === 'active') { sel.add('open'); sel.add('temp'); }
      stMenu.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = sel.has(cb.value));
      $('#estStLabel').textContent = estStLabelText();
      estRerender();
    }));
  document.addEventListener('click', () => { if (stMenu) stMenu.hidden = true; });

  // Filtros / orden / expandir
  $('#estZSearch').addEventListener('input', estRenderZonas);
  $('#estZSort').addEventListener('change', estRenderZonas);
  $('#estZExpand').addEventListener('click', () => {
    if (EST_EXP_Z.size >= EST_DATA.zones.length) { EST_EXP_Z.clear(); $('#estZExpand').textContent = 'Expandir todo'; }
    else { EST_DATA.zones.forEach(z => EST_EXP_Z.add(z.id)); $('#estZExpand').textContent = 'Contraer todo'; }
    estRenderZonas();
  });
  $('#estCSearch').addEventListener('input', estRenderConceptos);
  $('#estCSort').addEventListener('change', estRenderConceptos);
  $('#estCExpand').addEventListener('click', () => {
    if (EST_EXP_C.size >= EST_DATA.concepts.length) { EST_EXP_C.clear(); $('#estCExpand').textContent = 'Expandir todo'; }
    else { EST_DATA.concepts.forEach(c => EST_EXP_C.add(c.name)); $('#estCExpand').textContent = 'Contraer todo'; }
    estRenderConceptos();
  });

  // Exportacion
  const expBtn = $('#estExportBtn'), expMenu = $('#estExportMenu');
  expBtn.addEventListener('click', (e) => { e.stopPropagation(); expMenu.hidden = !expMenu.hidden; });
  document.addEventListener('click', () => { expMenu.hidden = true; });
  expMenu.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { expMenu.hidden = true; estExport(b.dataset.fmt); }));

  estRerender();
}

/* Re-pinta stats + ambas tablas (tras cambiar el filtro de estados). */
function estRerender() {
  estRenderStats();
  estRenderZonas();
  estRenderConceptos();
}

function estRenderStats() {
  const host = $('#estStats');
  if (!host) return;
  const zonasVis = EST_DATA.zones.filter(z => estSumSel(z.vec) > 0).length;
  const subsVis = EST_DATA.zones.reduce((a, z) => a + z.subs.filter(s => estSumSel(s.vec) > 0).length, 0);
  const concVis = EST_DATA.concepts.filter(c => estSumSel(c.vec) > 0).length;
  const empTotal = (CATALOG.companies || []).reduce((a, c) => a + (estSelSet().has(estStatusKey(c.status)) ? 1 : 0), 0);
  const sel = estSelSet();
  const hint = (sel.size === 2 && sel.has('open') && sel.has('temp')) ? 'activas (abierta + cerr. temporal)'
    : sel.size === 5 ? 'todos los estados' : 'con el filtro actual';
  host.innerHTML = `
    <div class="emp-stats"><div class="emp-srow">
      <div class="emp-stat"><div class="k">Zonas</div><div class="v">${zonasVis}</div><div class="hint">con empresas visibles</div></div>
      <div class="emp-stat"><div class="k">Subzonas</div><div class="v">${subsVis}</div><div class="hint">con empresas visibles</div></div>
      <div class="emp-stat"><div class="k">Conceptos</div><div class="v">${concVis}</div><div class="hint">marcas / formatos</div></div>
      <div class="emp-stat"><div class="k">Empresas</div><div class="v">${empTotal}</div><div class="hint">${hint}</div></div>
    </div></div>`;
}

function estRenderZonas() {
  const body = $('#estZBody');
  if (!body) return;
  const q = ($('#estZSearch') && $('#estZSearch').value || '').toLowerCase().trim();
  let rows = EST_DATA.zones.map(z => ({ ...z, sel: estSumSel(z.vec) })).filter(z => z.sel > 0);
  if (q) {
    rows = rows.filter(z => z.name.toLowerCase().includes(q) || (z.letter || '').toLowerCase() === q
      || z.subs.some(s => s.name.toLowerCase().includes(q) || ((z.letter || '') + (s.name || '')).toLowerCase().includes(q)));
    rows.forEach(z => { if (z.subs.some(s => s.name.toLowerCase().includes(q))) EST_EXP_Z.add(z.id); });
  }
  const maxRef = Math.max(1, ...rows.map(z => z.sel));
  const sort = ($('#estZSort') && $('#estZSort').value) || 'emp_desc';
  rows.sort((a, b) => {
    if (sort === 'emp_desc') return b.sel - a.sel || a.name.localeCompare(b.name, 'es');
    if (sort === 'emp_asc') return a.sel - b.sel || a.name.localeCompare(b.name, 'es');
    if (sort === 'letter') return (a.letter || '').localeCompare(b.letter || '');
    return a.name.localeCompare(b.name, 'es');
  });
  if (!rows.length) { body.innerHTML = '<tr><td colspan="4" class="empty">Sin zonas con empresas en los estados elegidos.</td></tr>'; return; }
  body.innerHTML = rows.map(z => {
    const isOpen = EST_EXP_Z.has(z.id);
    const head = `<tr class="est-exp ${isOpen ? 'est-open' : ''}" data-z="${z.id}">
      <td><svg class="est-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg><span class="est-pchip zone">${z.letter || '\u2014'}</span><span class="est-pname">${z.name}</span></td>
      <td style="text-align:right">${z.subs.filter(s => estSumSel(s.vec) > 0).length}</td>
      <td style="text-align:right;font-weight:600">${z.sel}</td>
      <td><div class="est-bar-wrap">${estSegHtml(z.vec, maxRef)}<span class="est-bar-n">${z.sel}</span></div></td></tr>`;
    const subs = z.subs.map(s => ({ ...s, sel: estSumSel(s.vec) })).filter(s => s.sel > 0)
      .sort((a, b) => b.sel - a.sel || a.name.localeCompare(b.name, 'es'))
      .map(s => `<tr class="est-sub ${isOpen ? '' : 'est-hidden'}">
        <td><span class="est-subtag">${z.letter || ''}</span>${s.name}</td>
        <td style="text-align:right" class="muted">\u2014</td>
        <td style="text-align:right;font-weight:600">${s.sel}</td>
        <td><div class="est-bar-wrap">${estSegHtml(s.vec, maxRef)}<span class="est-bar-n">${s.sel}</span></div></td></tr>`).join('');
    return head + subs;
  }).join('');
  body.querySelectorAll('.est-exp').forEach(tr => tr.addEventListener('click', () => {
    const id = tr.dataset.z;
    // los ids de zona pueden ser numericos o string; comparar laxo
    const zid = EST_DATA.zones.find(z => String(z.id) === String(id)).id;
    if (EST_EXP_Z.has(zid)) EST_EXP_Z.delete(zid); else EST_EXP_Z.add(zid);
    estRenderZonas();
  }));
}

function estRenderConceptos() {
  const body = $('#estCBody');
  if (!body) return;
  const q = ($('#estCSearch') && $('#estCSearch').value || '').toLowerCase().trim();
  let rows = EST_DATA.concepts.map(c => {
    const zs = c.zonas.map(z => ({ ...z, sel: estSumSel(z.vec) })).filter(z => z.sel > 0);
    return { name: c.name, zonas: zs, sel: zs.reduce((a, z) => a + z.sel, 0), zoneCount: zs.length, vec: estSumVecs(zs.map(z => z.vec)) };
  }).filter(c => c.sel > 0);
  if (q) {
    rows = rows.filter(c => c.name.toLowerCase().includes(q) || c.zonas.some(z => z.name.toLowerCase().includes(q)));
    rows.forEach(c => { if (c.zonas.some(z => z.name.toLowerCase().includes(q))) EST_EXP_C.add(c.name); });
  }
  const maxRef = Math.max(1, ...rows.map(c => c.sel));
  const sort = ($('#estCSort') && $('#estCSort').value) || 'emp_desc';
  rows.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'es') : (b.sel - a.sel || a.name.localeCompare(b.name, 'es')));
  if (!rows.length) { body.innerHTML = '<tr><td colspan="4" class="empty">Sin conceptos con empresas en los estados elegidos.</td></tr>'; return; }
  body.innerHTML = rows.map(c => {
    const isOpen = EST_EXP_C.has(c.name);
    const head = `<tr class="est-exp ${isOpen ? 'est-open' : ''}" data-c="${c.name.replace(/"/g, '&quot;')}">
      <td><svg class="est-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg><span class="est-pchip concept">${c.name}</span></td>
      <td style="text-align:right">${c.zoneCount}</td>
      <td style="text-align:right;font-weight:600">${c.sel}</td>
      <td><div class="est-bar-wrap">${estSegHtml(c.vec, maxRef)}<span class="est-bar-n">${c.sel}</span></div></td></tr>`;
    const childs = c.zonas.slice().sort((a, b) => b.sel - a.sel).map(z =>
      `<tr class="est-sub ${isOpen ? '' : 'est-hidden'}">
        <td><span class="est-subtag">${z.letter || ''}</span>${z.name}</td>
        <td style="text-align:right" class="muted">\u2014</td>
        <td style="text-align:right;font-weight:600">${z.sel}</td>
        <td><div class="est-bar-wrap">${estSegHtml(z.vec, maxRef)}<span class="est-bar-n">${z.sel}</span></div></td></tr>`).join('');
    return head + childs;
  }).join('');
  body.querySelectorAll('.est-exp').forEach(tr => tr.addEventListener('click', () => {
    const name = tr.dataset.c;
    if (EST_EXP_C.has(name)) EST_EXP_C.delete(name); else EST_EXP_C.add(name);
    estRenderConceptos();
  }));
}

/* Exporta la pestana activa (xlsx/csv/txt) respetando el filtro de estados.
   Zonas: una fila por zona y subzona. Conceptos: una fila por concepto y
   zona. Reusa downloadBlob/tstamp del modulo. */
async function estExport(fmt) {
  const sel = estSelSet();
  const selKeys = EST_ST_KEYS.filter(k => sel.has(k));
  let data, sheet, fbase;
  if (EST_TAB === 'zonas') {
    data = [];
    EST_DATA.zones.map(z => ({ ...z, sel: estSumSel(z.vec) })).filter(z => z.sel > 0)
      .sort((a, b) => b.sel - a.sel).forEach(z => {
        const row = { 'Nivel': 'Zona', 'Zona': z.name, 'Letra': z.letter || '', 'Subzona': '', 'Empresas': z.sel };
        selKeys.forEach(k => row[EST_ST_LABEL[k]] = z.vec[EST_ST_KEYS.indexOf(k)]);
        data.push(row);
        z.subs.map(s => ({ ...s, sel: estSumSel(s.vec) })).filter(s => s.sel > 0)
          .sort((a, b) => b.sel - a.sel).forEach(s => {
            const sr = { 'Nivel': 'Subzona', 'Zona': z.name, 'Letra': z.letter || '', 'Subzona': s.name, 'Empresas': s.sel };
            selKeys.forEach(k => sr[EST_ST_LABEL[k]] = s.vec[EST_ST_KEYS.indexOf(k)]);
            data.push(sr);
          });
      });
    sheet = 'Zonas'; fbase = 'estructura_zonas';
  } else {
    data = [];
    EST_DATA.concepts.map(c => {
      const zs = c.zonas.map(z => ({ ...z, sel: estSumSel(z.vec) })).filter(z => z.sel > 0);
      return { name: c.name, zonas: zs, sel: zs.reduce((a, z) => a + z.sel, 0), vec: estSumVecs(zs.map(z => z.vec)) };
    }).filter(c => c.sel > 0).sort((a, b) => b.sel - a.sel).forEach(c => {
      const row = { 'Nivel': 'Concepto', 'Concepto': c.name, 'Zona': '', 'Empresas': c.sel };
      selKeys.forEach(k => row[EST_ST_LABEL[k]] = c.vec[EST_ST_KEYS.indexOf(k)]);
      data.push(row);
      c.zonas.slice().sort((a, b) => b.sel - a.sel).forEach(z => {
        const zr = { 'Nivel': 'Zona', 'Concepto': c.name, 'Zona': z.name, 'Empresas': z.sel };
        selKeys.forEach(k => zr[EST_ST_LABEL[k]] = z.vec[EST_ST_KEYS.indexOf(k)]);
        data.push(zr);
      });
    });
    sheet = 'Conceptos'; fbase = 'estructura_conceptos';
  }
  if (!data.length) { alert('No hay datos para exportar con el filtro actual.'); return; }
  const headers = Object.keys(data[0]);
  const fname = `${fbase}_${tstamp()}`;

  if (fmt === 'csv') {
    const esc = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [headers.join(';')].concat(data.map(r => headers.map(h => esc(r[h])).join(';')));
    downloadBlob('\uFEFF' + lines.join('\r\n'), `${fname}.csv`, 'text/csv;charset=utf-8');
    return;
  }
  if (fmt === 'txt') {
    const widths = headers.map(h => Math.max(h.length, ...data.map(r => String(r[h] ?? '').length)));
    const fmtRow = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
    const lines = [fmtRow(headers), widths.map(w => '-'.repeat(w)).join('  ')].concat(data.map(r => fmtRow(headers.map(h => r[h]))));
    downloadBlob(lines.join('\r\n'), `${fname}.txt`, 'text/plain;charset=utf-8');
    return;
  }
  if (fmt === 'xlsx') {
    try {
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar la librer\u00eda Excel.'));
          document.head.appendChild(s);
        });
      }
      const ws = window.XLSX.utils.json_to_sheet(data, { header: headers });
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, sheet);
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (e) { alert(e.message + ' Revisa tu conexi\u00f3n e int\u00e9ntalo de nuevo.'); }
    return;
  }
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

/* ---------- VISTA: USUARIOS (grilla unificada: portal + osTicket) ----------
   Una sola grilla, SOLO tiendas. Cada fila cruza dos mundos por company_code:
     - Acceso al PORTAL de Nomina (company_users): estado + crear/resetear/toggle/correo.
     - osTicket: REMITENTE (el From de los tickets) y, aparte, ACCESO CON CLAVE
       (ClientAccount / login del cliente).
   Endpoints: /api/company-users (portal) y /api/osticket-users (osTicket).
   No se tocan los endpoints: se cruzan en el cliente.
   Reutiliza: cuAction/cuApi (acciones portal), ouSyncOne/ouSyncAll/ouApi
   (remitente osTicket), exportUsuariosPortal (exportacion). */
let CU_ROWS = null;       // filas crudas de company-users (para acciones/exportar)
let USERS_ROWS = [];      // filas combinadas (tienda + portal + osticket)
let USERS_USER = null;    // user de sesion
let USERS_F = { q: '', portal: 'all', ost: 'all', key: 'all', zone: 'all', subzone: 'all' };
// Catalogos de zona/subzona (para los combos del filtro). Se llenan en load.
let USERS_CATS = { zones: [], subzones: [] };
// Filtro por ESTADO de la empresa (multi-select, igual que en Empresas).
// null = primera vez (arranca en "Activas" = Abierto + Cerrada temporal).
// Cuando se inicializa pasa a ser un Set de estados seleccionados.
let USERS_STATUS_SEL = null;

async function viewUsuarios(user) {
  USERS_USER = user;
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Usuarios</h1><p>Acceso al portal y osTicket por tienda, en una sola vista</p></div>
      <div class="head-actions" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="uSyncAll">${I.sync} Sincronizar remitentes</button>
        <div class="export-wrap">
          <button class="btn" id="uExportBtn">Exportar \u25be</button>
          <div class="export-menu" id="uExportMenu" hidden>
            <button data-fmt="xlsx">Excel (.xlsx)</button>
            <button data-fmt="csv">CSV (.csv)</button>
            <button data-fmt="txt">Texto (.txt)</button>
          </div>
        </div>
      </div></div>
    <div id="usersBody"><div class="pnl-loading">Cargando\u2026</div></div>`;
  usersLoad(user);
}

/* Carga en paralelo portal + osTicket y arma las filas combinadas. */
async function usersLoad(user) {
  const body = $('#usersBody');
  const [pu, ou] = await Promise.all([
    fetch('/api/company-users', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', adminId: user.id }) }).then(r => r.json()).catch(() => ({ ok: false })),
    ouApi({ action: 'list', adminId: user.id }).catch(() => ({ ok: false })),
  ]);
  if (!pu.ok) { body.innerHTML = `<div class="pnl-loading">Error cargando accesos del portal.</div>`; return; }
  if (!ou.ok) { body.innerHTML = `<div class="pnl-loading">Error cargando osTicket: ${ou.error || ''}</div>`; return; }

  CU_ROWS = pu.rows || [];
  // Catalogos de zona/subzona para los combos del filtro.
  USERS_CATS = { zones: pu.zones || [], subzones: pu.subzones || [] };
  // Solo tiendas del lado portal, indexadas por codigo.
  const portalByCode = {};
  CU_ROWS.filter(r => r.type === 'Tienda').forEach(r => { portalByCode[r.code] = r; });
  const ostByCode = {};
  (ou.tiendas || []).forEach(t => { ostByCode[t.code] = t; });

  // Universo de tiendas = union de ambos lados (por si alguno falta).
  const codes = new Set([...Object.keys(portalByCode), ...Object.keys(ostByCode)]);
  USERS_ROWS = [...codes].sort().map(code => {
    const p = portalByCode[code] || null;
    const o = ostByCode[code] || null;
    const name = (p && p.name) || (o && o.name) || '';
    const email = (p && ((p.user && p.user.email) || p.companyEmail)) || (o && o.email) || null;
    const phone1 = p ? phoneDisplay(p.companyPhone) : '';
    const phone2 = p ? phoneDisplay(p.companyPhone2) : '';
    return {
      code, name, email,
      // Estado de la EMPRESA ligada (Abierto/Cerrado/Cerrada temporal/...).
      // Viene del lado portal (company-users list ya trae c.status). Si esa
      // tienda no existiera del lado portal, queda null (se trata como "sin
      // estado" -> no se oculta por el filtro).
      status: (p && p.status) || null,
      // Zona/subzona (de la empresa ligada) para los filtros nuevos.
      zoneId: (p && p.zoneId) || null,
      zoneName: (p && p.zoneName) || null,
      subzoneId: (p && p.subzoneId) || null,
      subzoneName: (p && p.subzoneName) || null,
      phoneLine: [phone1, phone2].filter(Boolean).join(' / '),
      portal: p,
      portalState: p && p.user ? (p.user.is_active ? 'Activo' : 'Inactivo') : 'Sin acceso',
      ost: o,
    };
  });

  const sumPortal = USERS_ROWS.filter(r => r.portalState === 'Activo').length;
  const S = ou.summary || {};
  usersRender(user, {
    portalActivo: sumPortal,
    synced: S.synced || 0,
    pending: S.pending || 0,
    no_email: S.no_email || 0,
    with_access: S.with_access || 0,
  });

  // Exportacion (reusa exportUsuariosPortal con las tiendas del portal).
  const eb = $('#uExportBtn'), em = $('#uExportMenu');
  if (eb && em) {
    eb.addEventListener('click', (e) => { e.stopPropagation(); em.hidden = !em.hidden; });
    document.addEventListener('click', () => { em.hidden = true; });
    em.querySelectorAll('button').forEach(b =>
      b.addEventListener('click', () => { em.hidden = true; exportUsuariosPortal(b.dataset.fmt, CU_ROWS.filter(r => r.type === 'Tienda')); }));
  }
  const sa = $('#uSyncAll');
  if (sa) sa.addEventListener('click', () => ouSyncAll(user));
}

/* Fecha ISO -> 'DD/MM' hora Caracas (para el chip de clave). */
function usersDayMonth(iso) {
  if (!iso) return '';
  const dt = new Date(iso); if (isNaN(dt)) return '';
  const car = new Date(dt.getTime() - 4 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(car.getUTCDate())}/${p(car.getUTCMonth() + 1)}`;
}

function usersRender(user, sum) {
  const body = $('#usersBody');
  // Estados de empresa presentes en las filas (para el multi-select).
  const USERS_STATUSES = [...new Set(USERS_ROWS.map(r => r.status).filter(Boolean))].sort();
  // "Activas" por defecto: Abierto + Cerrada temporal.
  const USERS_ACTIVE_STATES = USERS_STATUSES.filter(s => /abier/i.test(s) || (/cerrad/i.test(s) && /temp/i.test(s)));
  // Primera vez: arranca en Activas (o todas si no hubiera activos). Luego se
  // conserva la seleccion del usuario entre re-render de filas.
  if (USERS_STATUS_SEL === null) {
    USERS_STATUS_SEL = new Set(USERS_ACTIVE_STATES.length ? USERS_ACTIVE_STATES : USERS_STATUSES);
  } else {
    // Depurar estados que ya no existan (por si cambio el universo).
    USERS_STATUS_SEL = new Set([...USERS_STATUS_SEL].filter(s => USERS_STATUSES.includes(s)));
  }
  body.innerHTML = `
    <div class="sum-cards">
      <div class="sum-card portal"><div class="n">${sum.portalActivo}</div><div class="l">Con acceso activo al portal</div></div>
      <div class="sum-card ok"><div class="n">${sum.synced}</div><div class="l">Remitente en osTicket</div></div>
      <div class="sum-card pend"><div class="n">${sum.pending}</div><div class="l">osTicket pendientes</div></div>
      <div class="sum-card none"><div class="n">${sum.no_email}</div><div class="l">Sin correo</div></div>
      <div class="sum-card acc"><div class="n">${sum.with_access}</div><div class="l">Con clave de acceso osTicket</div></div>
    </div>
    <div class="pnl-filters">
      <div class="search">${I.search}<input id="uSearch" placeholder="Buscar tienda o codigo\u2026"></div>
      <select id="uPortal">
        <option value="all">Estado portal: Todos</option>
        <option value="Activo">Activo</option>
        <option value="Inactivo">Inactivo</option>
        <option value="Sin acceso">Sin acceso</option>
      </select>
      <select id="uOst">
        <option value="all">osTicket: Todos</option>
        <option value="synced">Remitente creado</option>
        <option value="pending">Pendientes</option>
        <option value="no_email">Sin correo</option>
      </select>
      <select id="uKey">
        <option value="all">Clave osTicket: Todos</option>
        <option value="yes">Con clave</option>
        <option value="no">Sin clave</option>
      </select>
      <select id="uZone"><option value="all">Zona: Todas</option></select>
      <select id="uSubzone"><option value="all">Subzona: Todas</option></select>
      <div class="ms-wrap" id="uStatusWrap">
        <button type="button" class="ms-toggle" id="uStatusBtn">
          <span class="ms-label" id="uStatusLabel">Estados</span>
          ${I.chevron.replace('<svg', '<svg class="ms-caret"')}
        </button>
        <div class="ms-menu" id="uStatusMenu" hidden>
          <div class="ms-quick">
            <button type="button" data-q="active">Activas</button>
            <button type="button" data-q="all">Todos</button>
            <button type="button" data-q="none">Ninguno</button>
          </div>
          <div class="ms-sep"></div>
          ${USERS_STATUSES.map(s => `<label class="ms-opt"><input type="checkbox" value="${s}" ${USERS_STATUS_SEL.has(s) ? 'checked' : ''}><span>${/nulo|vac/i.test(s) ? 'Sin estado' : s}</span><span class="ms-count">${USERS_ROWS.filter(r => r.status === s).length}</span></label>`).join('')}
        </div>
      </div>
    </div>
    <p id="uCount" class="muted" style="font-size:12.5px;margin:0 2px 10px"></p>
    <div class="tablebox scroll-x u-compact"><table><thead>
      <tr>
        <th rowspan="2">Codigo</th><th rowspan="2">Tienda</th><th rowspan="2">Correo / Telefono</th>
        <th class="grp grp-portal" colspan="2">Acceso al portal</th>
        <th class="grp grp-ost" colspan="2">osTicket</th>
      </tr>
      <tr>
        <th class="grp-portal">Estado</th><th class="grp-portal" style="text-align:right">Acciones</th>
        <th class="grp-ost">Estado</th><th class="grp-ost" style="text-align:right">Acciones</th>
      </tr>
    </thead><tbody id="uBody"></tbody></table></div>
    <div class="usr-cards" id="uCards"></div>`;

  const fq = $('#uSearch'), fp = $('#uPortal'), fo = $('#uOst'), fk = $('#uKey');
  fq.value = USERS_F.q; fp.value = USERS_F.portal; fo.value = USERS_F.ost; fk.value = USERS_F.key;
  fq.addEventListener('input', () => { USERS_F.q = fq.value; usersRenderRows(user); });
  [fp, fo, fk].forEach(el => el.addEventListener('change', () => {
    USERS_F.portal = fp.value; USERS_F.ost = fo.value; USERS_F.key = fk.value; usersRenderRows(user);
  }));

  // ----- Combos Zona / Subzona (dependientes; ligados a la empresa) -----
  // Solo se listan las zonas/subzonas que existen en las filas cargadas.
  const fz = $('#uZone'), fsz = $('#uSubzone');
  const zonesInRows = new Set(USERS_ROWS.map(r => r.zoneId).filter(Boolean));
  const uZones = (USERS_CATS.zones || []).filter(z => zonesInRows.has(z.id));
  function uFillZones() {
    if (!fz) return;
    fz.innerHTML = '<option value="all">Zona: Todas</option>'
      + uZones.map(z => `<option value="${z.id}">${z.name}</option>`).join('');
    fz.value = uZones.some(z => z.id === USERS_F.zone) ? USERS_F.zone : 'all';
    if (fz.value === 'all') USERS_F.zone = 'all';
  }
  function uFillSubzones() {
    if (!fsz) return;
    const subzInRows = new Set(USERS_ROWS.map(r => r.subzoneId).filter(Boolean));
    let subs = (USERS_CATS.subzones || []).filter(s => subzInRows.has(s.id));
    // Si hay una zona elegida, acotar las subzonas a esa zona.
    if (USERS_F.zone !== 'all') subs = subs.filter(s => s.zone_id === USERS_F.zone);
    fsz.innerHTML = '<option value="all">Subzona: Todas</option>'
      + subs.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    fsz.value = subs.some(s => s.id === USERS_F.subzone) ? USERS_F.subzone : 'all';
    if (fsz.value === 'all') USERS_F.subzone = 'all';
  }
  uFillZones();
  uFillSubzones();
  if (fz) fz.addEventListener('change', () => {
    USERS_F.zone = fz.value;
    // Al cambiar de zona, la subzona vuelve a "Todas" y se recalcula el combo.
    USERS_F.subzone = 'all';
    uFillSubzones();
    usersRenderRows(user);
  });
  if (fsz) fsz.addEventListener('change', () => {
    USERS_F.subzone = fsz.value; usersRenderRows(user);
  });

  // ----- Multi-select de ESTADO de empresa (igual que en Empresas) -----
  const uMsWrap = $('#uStatusWrap'), uMsBtn = $('#uStatusBtn'), uMsMenu = $('#uStatusMenu'), uMsLabel = $('#uStatusLabel');
  function uUpdateStatusLabel() {
    const n = USERS_STATUS_SEL.size;
    if (n === 0) uMsLabel.textContent = 'Sin estados';
    else if (n === USERS_STATUSES.length) uMsLabel.textContent = 'Todos los estados';
    else if (USERS_ACTIVE_STATES.length && n === USERS_ACTIVE_STATES.length && USERS_ACTIVE_STATES.every(s => USERS_STATUS_SEL.has(s)))
      uMsLabel.textContent = 'Activas';
    else if (n === 1) uMsLabel.textContent = /nulo|vac/i.test([...USERS_STATUS_SEL][0]) ? 'Sin estado' : [...USERS_STATUS_SEL][0];
    else uMsLabel.textContent = `${n} estados`;
  }
  if (uMsBtn) {
    uMsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = uMsMenu.hidden;
      uMsMenu.hidden = !open;
      uMsWrap.classList.toggle('open', open);
    });
    uMsMenu.addEventListener('click', (e) => e.stopPropagation());
    uMsMenu.querySelectorAll('input[type=checkbox]').forEach(cb =>
      cb.addEventListener('change', () => {
        if (cb.checked) USERS_STATUS_SEL.add(cb.value); else USERS_STATUS_SEL.delete(cb.value);
        uUpdateStatusLabel(); usersRenderRows(user);
      }));
    uMsMenu.querySelectorAll('.ms-quick button').forEach(b =>
      b.addEventListener('click', () => {
        USERS_STATUS_SEL.clear();
        if (b.dataset.q === 'all') USERS_STATUSES.forEach(s => USERS_STATUS_SEL.add(s));
        else if (b.dataset.q === 'active') USERS_ACTIVE_STATES.forEach(s => USERS_STATUS_SEL.add(s));
        // 'none' deja el set vacio
        uMsMenu.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = USERS_STATUS_SEL.has(cb.value); });
        uUpdateStatusLabel(); usersRenderRows(user);
      }));
    // Cerrar el menu al hacer clic fuera.
    document.addEventListener('click', () => {
      if (!uMsMenu.hidden) { uMsMenu.hidden = true; uMsWrap.classList.remove('open'); }
    });
    uUpdateStatusLabel();
  }

  usersRenderRows(user);
}

function usersRenderRows(user) {
  const q = USERS_F.q.toLowerCase();
  // Set de estados seleccionados (multi-select). Si es null (aun no se
  // inicializo), no filtra por estado.
  const selSt = USERS_STATUS_SEL;
  const rows = USERS_ROWS.filter(r => {
    if (q && !(`${r.code} ${r.name || ''}`.toLowerCase().includes(q))) return false;
    if (USERS_F.portal !== 'all' && r.portalState !== USERS_F.portal) return false;
    if (USERS_F.ost !== 'all' && (!r.ost || r.ost.state !== USERS_F.ost)) return false;
    if (USERS_F.key === 'yes' && !(r.ost && r.ost.has_access)) return false;
    if (USERS_F.key === 'no' && (r.ost && r.ost.has_access)) return false;
    // Filtro por ZONA / SUBZONA (ligadas a la empresa de la tienda).
    if (USERS_F.zone !== 'all' && r.zoneId !== USERS_F.zone) return false;
    if (USERS_F.subzone !== 'all' && r.subzoneId !== USERS_F.subzone) return false;
    // Filtro por ESTADO de empresa (multi-select, igual criterio que Empresas):
    // - Si el usuario eligio "Ninguno" (set vacio): no pasa nada.
    // - Las tiendas SIN estado (null/nulo/vacio) NO se ocultan (se muestran
    //   como "sin estado") salvo que el set este vacio.
    // - El resto pasa solo si su estado esta en el set.
    if (selSt) {
      const hasStatus = !!(r.status && !/nulo|vac/i.test(r.status));
      const passStatus = selSt.size === 0 ? false : (!hasStatus ? true : selSt.has(r.status));
      if (!passStatus) return false;
    }
    return true;
  });
  $('#uCount').textContent = `${rows.length} de ${USERS_ROWS.length} tiendas`;

  const portalCell = (r) => {
    const u = r.portal && r.portal.user;
    const baseSt = !r.portal ? '<span class="pill pill-gray">Sin datos</span>'
      : u ? (u.is_active ? '<span class="pill pill-open">Activo</span>' : '<span class="pill pill-closed">Inactivo</span>')
          : '<span class="pill pill-gray">Sin acceso</span>';
    // Bajo el pill, el ultimo acceso al portal (solo si la tienda tiene usuario).
    const st = u ? `${baseSt}${lastLoginLabel(u.last_login_at)}` : baseSt;
    let acts = '';
    if (r.portal) {
      acts = u
        ? `<button class="btn btn-mini" data-p="email" data-code="${r.code}" data-name="${(r.name||'').replace(/"/g,'')}" data-email="${(u.email||'').replace(/"/g,'')}">${I.pencil} Correo</button>
           <button class="btn btn-mini" data-p="reset" data-code="${r.code}">${I.key} Resetear</button>
           <button class="btn btn-mini" data-p="toggle" data-code="${r.code}" data-active="${u.is_active}">${u.is_active ? 'Desactivar' : 'Activar'}</button>`
        : `<button class="btn btn-mini btn-primary" data-p="create" data-code="${r.code}" data-name="${(r.name||'').replace(/"/g,'')}" data-type="Tienda" data-email="${r.portal.companyEmail||''}">${I.plus} Crear acceso</button>`;
    }
    return { st, acts };
  };

  const ostCell = (r) => {
    const o = r.ost;
    if (!o) return { st: '<span class="pill pill-gray">\u2014</span>', acts: '' };
    const idTag = o.osticket_user_id ? `<span class="id-tag">#${o.osticket_user_id}</span>` : '';
    // Estructura identica al mockup: el pill + su #id van juntos en UN span
    // (misma linea); la segunda linea (clave) la separa el gap del flex
    // column de .ost-state. Sin <br> (evita el salto doble).
    const statePill = o.state === 'synced'
        ? `<span class="ost-remit"><span class="pill pill-open">Remitente</span>${idTag}</span>`
      : o.state === 'pending' ? '<span class="pill pill-temp">Pendiente</span>'
      : '<span class="pill pill-gray">Sin correo</span>';
    const keyLine = o.has_access
      ? `<span class="acc-line">${I.key} Con clave${o.access_granted_at ? ' \u00b7 ' + usersDayMonth(o.access_granted_at) : ''}</span>`
      : (o.state === 'no_email' ? '' : '<span class="acc-none">sin clave</span>');
    const st = `<div class="ost-state">${statePill}${keyLine}</div>`;

    let acts = '';
    if (o.state === 'no_email') {
      acts = `<button class="btn btn-mini" disabled style="opacity:.5" title="Carga un correo en Empresas">Falta correo</button>`;
    } else {
      const remit = o.state === 'synced'
        ? `<button class="btn btn-mini" data-o="sync" data-code="${r.code}">Re-sincronizar</button>`
        : `<button class="btn btn-mini btn-primary" data-o="sync" data-code="${r.code}">Crear remitente</button>`;
      const key = o.has_access
        ? `<button class="btn btn-mini" data-o="grant" data-code="${r.code}">${I.key} Resetear</button>`
        : `<button class="btn btn-mini btn-violet" data-o="grant" data-code="${r.code}">${I.key} Dar acceso</button>`;
      acts = remit + ' ' + key;
    }
    return { st, acts };
  };

  // ---- Host activo: en movil TARJETAS en #uCards; escritorio filas en #uBody ----
  const mobile = window.matchMedia('(max-width:768px)').matches;
  const tableBox = $('#pnlMain').querySelector('.tablebox');
  const cardsBox = $('#uCards');
  if (tableBox) tableBox.style.display = mobile ? 'none' : '';
  if (cardsBox) cardsBox.style.display = mobile ? '' : 'none';
  const host = mobile ? cardsBox : $('#uBody');

  const desktopRow = (r) => {
    const p = portalCell(r), o = ostCell(r);
    const correo = r.email || '<span class="muted" style="font-size:12px">\u2014</span>';
    const tel = r.phoneLine ? `<br><span class="muted">${r.phoneLine}</span>` : '';
    return `<tr>
      <td class="code">${r.code}</td>
      <td>${r.name || '\u2014'}</td>
      <td style="font-size:12.5px">${correo}${tel}</td>
      <td class="grp-portal">${p.st}</td>
      <td class="grp-portal" style="text-align:right"><div class="cell-actions">${p.acts}</div></td>
      <td class="grp-ost">${o.st}</td>
      <td class="grp-ost" style="text-align:right"><div class="cell-actions">${o.acts}</div></td>
    </tr>`;
  };

  // ---- Tarjeta MOVIL: cabecera (codigo + tienda + estado empresa) y dos
  // sub-secciones tintadas "Acceso al portal" (azul) y "osTicket" (verde),
  // cada una con su estado y sus acciones. Mismos data-* que la fila. ----
  const mobileCard = (r) => {
    const p = portalCell(r), o = ostCell(r);
    const correo = r.email ? `<span class="usr-mail">${r.email}</span>` : '<span class="muted">sin correo</span>';
    const tel = r.phoneLine ? `<span class="usr-tel muted">${r.phoneLine}</span>` : '';
    const stPill = r.status && !/nulo|vac/i.test(r.status) ? statusPill(r.status) : '';
    return `<div class="usr-card">
      <div class="hc-top">
        <div class="hc-ic"><span class="alias ty-tienda">${(r.code || '').slice(0, 4)}</span></div>
        <div class="hc-tt">
          <div class="hc-t1">${r.code}</div>
          <div class="hc-t2">${r.name || '\u2014'}</div>
        </div>
        ${stPill}
      </div>
      <div class="usr-contact">${correo}${tel}</div>
      <div class="usr-sec portal">
        <div class="usr-sec-h"><span class="usr-sec-t">Acceso al portal</span>${p.st}</div>
        ${p.acts ? `<div class="usr-sec-acts">${p.acts}</div>` : ''}
      </div>
      <div class="usr-sec ost">
        <div class="usr-sec-h"><span class="usr-sec-t">osTicket</span>${o.st}</div>
        ${o.acts ? `<div class="usr-sec-acts">${o.acts}</div>` : ''}
      </div>
    </div>`;
  };

  if (!rows.length) {
    host.innerHTML = mobile
      ? '<div class="usr-empty">Sin resultados.</div>'
      : '<tr><td colspan="7" class="empty">Sin resultados.</td></tr>';
  } else {
    host.innerHTML = rows.map(r => mobile ? mobileCard(r) : desktopRow(r)).join('');
  }
  wireUserRows(host, user);
}

// ---- Cableado de acciones sobre el host activo (tabla o tarjetas) ----
// Mismos data-* en fila y tarjeta -> un solo conjunto de listeners.
function wireUserRows(host, user) {
  // Acciones PORTAL (reusa cuAction con {act,code,name,email,type,active}).
  host.querySelectorAll('button[data-p]').forEach(b =>
    b.addEventListener('click', () => cuAction({
      act: b.dataset.p, code: b.dataset.code, name: b.dataset.name,
      email: b.dataset.email, type: b.dataset.type, active: b.dataset.active,
    }, user)));
  // Acciones osTICKET.
  host.querySelectorAll('button[data-o="sync"]').forEach(b =>
    b.addEventListener('click', () => ouSyncOne(user, b.dataset.code, b)));
  host.querySelectorAll('button[data-o="grant"]').forEach(b =>
    b.addEventListener('click', () => ouGrantAccess(user, b.dataset.code, b)));
}

/* Modal: otorgar/resetear ACCESO CON CLAVE de una tienda en osTicket.
   Usuario prellenado = codigo de tienda; clave fija (no fuerza cambio).
   Llama /api/osticket-users action grant_access y muestra credenciales. */
function ouGrantAccess(user, code, btn) {
  const row = USERS_ROWS.find(r => r.code === code);
  const has = !!(row && row.ost && row.ost.has_access);
  openModal(`
    <div class="modal-head"><span>${has ? 'Resetear' : 'Dar'} acceso osTicket</span><button class="modal-x" id="mX">\u2715</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${code}${row && row.name ? ' \u00b7 ' + row.name : ''} \u00b7 acceso de cliente a osTicket (usuario + clave).</p>
    <label class="flabel">Usuario (osTicket)</label>
    <input type="text" id="ogUser" value="${code}" style="margin-bottom:12px">
    <label class="flabel">Clave</label>
    <input type="text" id="ogPass" placeholder="minimo 6 caracteres" autocomplete="off" style="margin-bottom:6px">
    <p class="muted" style="font-size:11.5px;margin:0">La clave es fija (no se fuerza el cambio al entrar). Se mostrara aqui para que la entregues; anotala.</p>
    <p id="ogErr" style="color:var(--danger);font-size:12.5px;margin:10px 0 0;display:none"></p>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">${has ? 'Resetear' : 'Crear'} acceso</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const uname = $('#ogUser').value.trim();
    const pass = $('#ogPass').value;
    const err = $('#ogErr');
    if (!uname) { err.textContent = 'Indica el usuario.'; err.style.display = 'block'; return; }
    if (!pass || pass.length < 6) { err.textContent = 'La clave debe tener al menos 6 caracteres.'; err.style.display = 'block'; return; }
    const b = $('#mOk'); b.disabled = true; const orig = b.textContent; b.textContent = 'Guardando\u2026';
    let d;
    try { d = await ouApi({ action: 'grant_access', adminId: user.id, code, username: uname, password: pass }); }
    catch (e) { d = { ok: false, error: 'Error de conexion: ' + (e && e.message || e) }; }
    if (!d.ok) { err.textContent = d.error || 'No se pudo crear el acceso.'; err.style.display = 'block'; b.disabled = false; b.textContent = orig; return; }
    openModal(`
      <div class="modal-head"><span>Acceso osTicket listo</span><button class="modal-x" id="mX">\u2715</button></div>
      <p style="margin:0 0 4px">\u2705 Acceso ${d.account_created ? 'creado' : 'actualizado'} para la tienda <b>${code}</b>.</p>
      <div style="margin-top:12px;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft,#f7f7f9)">
        ${copyFieldHtml('Usuario', uname, 'ogrUser')}
        ${copyFieldHtml('Clave', pass, 'ogrPass')}
        ${d.portal_url ? copyFieldHtml('Portal de clientes (URL)', d.portal_url, 'ogrUrl') : ''}
        <button class="btn" data-copy-all type="button" style="width:100%;margin-top:2px">Copiar todo (portal + usuario + clave)</button>
        ${d.portal_url ? `<a class="btn" href="${d.portal_url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener" style="display:block;text-align:center;margin-top:8px;text-decoration:none">Abrir el portal de clientes \u2197</a>` : ''}
        <p class="muted" style="font-size:11.5px;margin:10px 0 0;line-height:1.5">Entra al portal de clientes de osTicket con ese usuario y clave.</p>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" id="mClose">Listo</button></div>`);
    const finish = () => { closeModal(); viewUsuarios(user); };
    $('#mX').addEventListener('click', finish);
    $('#mClose').addEventListener('click', finish);
    document.querySelectorAll('[data-copy]').forEach(x =>
      x.addEventListener('click', () => { const el = document.getElementById(x.dataset.copy); if (el) { el.select(); copyToClipboard(el.value, x); } }));
    const all = document.querySelector('[data-copy-all]');
    if (all) all.addEventListener('click', () => {
      const us = document.getElementById('ogrUser'), pw = document.getElementById('ogrPass'), ur = document.getElementById('ogrUrl');
      const lines = [];
      if (ur) lines.push(`Portal: ${ur.value}`);
      lines.push(`Usuario: ${us ? us.value : ''}`);
      lines.push(`Clave: ${pw ? pw.value : ''}`);
      copyToClipboard(lines.join('\n'), all);
    });
  });
}

/* ===== Exportacion de la grilla unificada (xlsx / csv / txt) =====
   Recibe filas crudas de company-users (tiendas). Reutilizada por la vista
   unificada. ===== */
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

/* ===== Sincronizacion de REMITENTES osTicket (reutilizada por la vista
   unificada) =====
   ouSyncOne: crea/re-sincroniza el usuario-tienda (el From de los tickets).
   ouSyncAll: crea/actualiza en tandas todas las pendientes con correo.
   ouApi: wrapper del endpoint /api/osticket-users. ===== */

/* Sincroniza UNA tienda (boton de fila). */
async function ouSyncOne(user, code, btn) {
  user = user || USERS_USER;   // respaldo: nunca depender de un user nulo
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Sincronizando…';
  const d = await ouApi({ action: 'sync', adminId: user.id, codes: [code] });
  if (!d.ok) { alert(d.error || 'No se pudo sincronizar.'); btn.disabled = false; btn.textContent = orig; return; }
  const r = (d.results && d.results[0]) || null;
  if (r && !r.ok) { alert(`${code}: ${r.error || 'error'}`); btn.disabled = false; btn.textContent = orig; return; }
  // refrescar la grilla unificada para reflejar el nuevo estado + tarjetas
  viewUsuarios(user);
}

/* Sincroniza TODAS las pendientes con correo (boton masivo).
   Abre un modal de progreso (barra + bitacora + conteo) e itera por dentro
   las TANDAS que exige el limite de subrequests de Cloudflare, hasta
   terminar TODAS. El usuario ve un solo proceso que avanza solo; no tiene
   que volver a pulsar el boton. Mismo patron que "Sincronizar todo" de
   Empresas (sin alert/confirm nativos: modal propio). */
async function ouSyncAll(user) {
  user = user || USERS_USER;   // respaldo: nunca depender de un user nulo
  const pend = (USERS_ROWS || []).filter(r => r.ost && r.ost.state === 'pending').length;
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
  const closeAndRefresh = () => { closeModal(); viewUsuarios(user); };

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

/* ---------- VISTA: EQUIPO (por rol: 3 grillas) ----------
   Superadmin en una fila destacada arriba (ve todo, sin alcance ni osTicket).
   Debajo, tres grillas independientes: Admins, Gestores de empresa y Editores
   de personal. Cada una con sus StatsCards y columnas segun sus
   particularidades:
     - admins:  alcance Tiendas + Empresas · osTicket como AGENTE (#staff)
     - gestor:  alcance SOLO Empresas/deptos · osTicket como CLIENTE (#user)
     - editor:  alcance Tiendas + Empresas · SIN osTicket
   Las acciones (data-act) las maneja auAction, sin cambios. */

/* Resumen de alcance -> texto corto. `sc` = {inc:{type:n}, exc:{type:n}}.
   kind: 'store' muestra zonas/subzonas (reglas) + total real de tiendas;
   'ent' muestra total real de empresas no-tienda + deptos. Los totales
   reales vienen de counts (RPC admin_scope_counts): alcance resuelto
   (include - exclude) separado por tipo. Asi no se cuentan mal las empresas
   que entran por zona/subzona/departamento. */
function scopeSummaryHtml(sc, kind, counts) {
  const inc = (sc && sc.inc) || {};
  const exc = (sc && sc.exc) || {};
  const cnt = counts || {};
  const parts = [];
  if (kind === 'store') {
    // Detalle de reglas por zona/subzona (lo que administra el editor).
    const z = inc.zone || 0, s = inc.subzone || 0;
    if (z) parts.push(`${z} zona${z === 1 ? '' : 's'}`);
    if (s) parts.push(`${s} subzona${s === 1 ? '' : 's'}`);
    // Total REAL de tiendas resueltas (tipo Tienda), no el conteo de reglas.
    const t = cnt.tiendas || 0;
    if (t) parts.push(`${t} tienda${t === 1 ? '' : 's'}`);
  } else {
    // Total REAL de empresas no-tienda resueltas + detalle de deptos.
    const e = cnt.empresas || 0, d = inc.department || 0;
    if (e) parts.push(`${e} empresa${e === 1 ? '' : 's'}`);
    if (d) parts.push(`${d} depto${d === 1 ? '' : 's'}`);
  }
  const exN = kind === 'store'
    ? (exc.zone || 0) + (exc.subzone || 0) + (exc.company || 0)
    : (exc.company || 0) + (exc.department || 0);
  if (!parts.length && !exN) return '<span class="sc-none">\u2014</span>';
  let html = parts.join(' \u00b7 ') || '<span class="sc-none">\u2014</span>';
  if (exN) html += ` <span class="sc-minus">\u2212${exN}</span>`;
  return html;
}

/* Celda de alcance para admin/editor: dos lineas (Tiendas / Empresas). */
function scopeCellBoth(a) {
  return `<div class="scope-cell">`
    + `<span class="sc-chip"><span class="k">Tiendas</span> ${scopeSummaryHtml(a.scope, 'store', a.scope_counts)}</span>`
    + `<span class="sc-chip"><span class="k">Empresas</span> ${scopeSummaryHtml(a.scope, 'ent', a.scope_counts)}</span>`
    + `</div>`;
}
/* Celda de alcance para gestor: SOLO empresas/deptos. */
function scopeCellEnt(a) {
  return `<div class="scope-cell">`
    + `<span class="sc-chip"><span class="k">Empresas</span> ${scopeSummaryHtml(a.scope, 'ent', a.scope_counts)}</span>`
    + `</div>`;
}

/* Celda osTicket AGENTE (admins). */
function ostAgentCell(a) {
  return a.osticket_staff_id
    ? `<span class="ost-remit"><span class="pill pill-open">Agente</span><span class="id-tag">#${a.osticket_staff_id}</span></span>`
    : '<span class="pill pill-gray">Sin agente</span>';
}
/* Celda osTicket CLIENTE (gestores). */
function ostClientCell(a) {
  return a.osticket_user_id
    ? `<span class="ost-remit"><span class="pill pill-acc">Cliente</span><span class="id-tag">#${a.osticket_user_id}</span></span>`
    : '<span class="pill pill-gray">Sin cliente</span>';
}

/* Botones de accion comunes (rol/resetear/activar) para un miembro. `self`
   es true si la fila es el propio usuario logueado (no puede cambiarse rol
   ni desactivarse). */
function auRowCommonActs(a, self, isSuper = true) {
  // El cambio de ROL es exclusivo de superadmin (create/update_role son
  // SUPER_ONLY en el backend). Para un admin no-super no se muestra.
  const roleBtn = (self || !isSuper) ? ''
    : `<button class="btn btn-mini" data-act="role" data-id="${a.id}" data-u="${a.username}" data-role="${a.role}" title="Cambiar rol">Rol</button>`;
  const resetBtn = `<button class="btn btn-mini" data-act="reset" data-id="${a.id}" data-u="${a.username}">${I.key} Resetear</button>`;
  const toggleBtn = self ? ''
    : `<button class="btn btn-mini" data-act="toggle" data-id="${a.id}" data-active="${a.is_active}">${a.is_active ? 'Desactivar' : 'Activar'}</button>`;
  return { roleBtn, resetBtn, toggleBtn };
}

/* StatsCard reutilizable. */
function statCard(cls, n, label) {
  return `<div class="sum-card ${cls}"><div class="n">${n}</div><div class="l">${label}</div></div>`;
}

/* Estado (pill activo/inactivo). */
function estadoPill(a) {
  return a.is_active ? '<span class="pill pill-open">Activo</span>' : '<span class="pill pill-closed">Inactivo</span>';
}

/* Ultimo acceso al portal (last_login_at). Formato corto en hora de Caracas.
   Devuelve una linea gris bajo el estado; 'Nunca' si aun no ha entrado. */
function lastLoginLabel(iso) {
  if (!iso) return '<div class="cell-lastlogin none">Ultimo acceso: nunca</div>';
  const dt = new Date(iso);
  if (isNaN(dt)) return '';
  const car = new Date(dt.getTime() - 4 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  let h = car.getUTCHours(); const ap = h < 12 ? 'a.m.' : 'p.m.';
  h = h % 12; if (h === 0) h = 12;
  const fecha = `${p(car.getUTCDate())}/${p(car.getUTCMonth() + 1)}/${car.getUTCFullYear()}`;
  const hora = `${h}:${p(car.getUTCMinutes())} ${ap}`;
  return `<div class="cell-lastlogin">Ultimo acceso: ${fecha} \u00b7 ${hora}</div>`;
}

async function viewEquipo(user) {
  $('#pnlMain').innerHTML = `<div class="pnl-head"><div><h1>Equipo</h1><p>Miembros del portal por rol</p></div></div><div class="pnl-loading">Cargando\u2026</div>`;
  const d = await auApi({ action: 'list', adminId: user.id });
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }
  const rows = d.rows || [];

  // El editor de equipo completo (crear miembros, cambiar roles, ver todos
  // los roles) es de superadmin. Un admin no-super entra a Equipo para VER y
  // gestionar (reset/toggle/osTicket) SOLO los gestores de su alcance; el
  // backend ya le devuelve unicamente esos gestores.
  const isSuper = user.role === 'superadmin';

  const supers = rows.filter(a => a.role === 'superadmin');
  const admins = rows.filter(a => a.role === 'admin');
  const gestores = rows.filter(a => a.role === 'gestor_empresa');
  const editores = rows.filter(a => a.role === 'editor_personal');

  const emailCell = (a) => a.email
    ? `<td class="cell-mail" data-label="Correo">${a.email}</td>`
    : '<td class="cell-mail" data-label="Correo"><span class="muted">\u2014</span></td>';

  // ---- Fila superadmin (destacada, fuera de las grillas) ----
  const suHtml = supers.map(a => {
    const initials = (a.name || a.username || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    return `<div class="su-card">
      <div class="su-av">${initials}</div>
      <div class="su-info">
        <div class="su-name">${a.name || a.username}</div>
        <div class="su-sub"><span class="su-user">${a.username}</span>
          <span class="pill pill-role">superadmin</span>
          <span>\u00b7 Ve todo \u00b7 sin alcance ni osTicket</span></div>
        ${lastLoginLabel(a.last_login_at)}
      </div>
      <div class="su-acts">
        <button class="btn btn-mini" data-act="reset" data-id="${a.id}" data-u="${a.username}">${I.key} Resetear</button>
      </div>
    </div>`;
  }).join('');

  // ---- Grilla ADMINS ----
  const adminStats = {
    total: admins.length,
    withAgent: admins.filter(a => a.osticket_staff_id).length,
    noAgent: admins.filter(a => !a.osticket_staff_id).length,
    off: admins.filter(a => !a.is_active).length,
  };
  const adminRows = admins.map(a => {
    const self = String(a.id) === String(user.id);
    const { roleBtn, resetBtn, toggleBtn } = auRowCommonActs(a, self, isSuper);
    return `<tr>
      <td class="code" data-label="Usuario">${a.username}</td>
      <td class="cell-name" data-label="Nombre">${a.name || '\u2014'}</td>
      ${emailCell(a)}
      <td data-label="Alcance">${scopeCellBoth(a)}</td>
      <td data-label="osTicket">${ostAgentCell(a)}</td>
      <td data-label="Estado">${estadoPill(a)}${lastLoginLabel(a.last_login_at)}</td>
      <td class="cell-actcell" style="text-align:right"><div class="cell-actions">
        <button class="btn btn-mini" data-act="scope-store" data-id="${a.id}" data-u="${a.username}" title="Alcance de tiendas">${I.sliders} Tiendas</button>
        <button class="btn btn-mini" data-act="scope-ent" data-id="${a.id}" data-u="${a.username}" title="Alcance de empresas">${I.sliders} Empresas</button>
        ${roleBtn}
        <button class="btn btn-mini" data-act="osticket-agent" data-id="${a.id}" data-u="${a.username}" data-staff="${a.osticket_staff_id || ''}" title="Agente osTicket (crear/resetear; se sincroniza al guardar el alcance)">osTicket</button>
        ${resetBtn}
        ${toggleBtn}
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">Sin administradores.</td></tr>';

  // ---- Grilla GESTORES ----
  const gestorStats = {
    total: gestores.length,
    withClient: gestores.filter(a => a.osticket_user_id).length,
    noClient: gestores.filter(a => !a.osticket_user_id).length,
    off: gestores.filter(a => !a.is_active).length,
  };
  const gestorRows = gestores.map(a => {
    const self = String(a.id) === String(user.id);
    const { roleBtn, resetBtn, toggleBtn } = auRowCommonActs(a, self, isSuper);
    return `<tr>
      <td class="code" data-label="Usuario">${a.username}</td>
      <td class="cell-name" data-label="Nombre">${a.name || '\u2014'}</td>
      ${emailCell(a)}
      <td data-label="Alcance">${scopeCellEnt(a)}</td>
      <td data-label="osTicket">${ostClientCell(a)}</td>
      <td data-label="Estado">${estadoPill(a)}${lastLoginLabel(a.last_login_at)}</td>
      <td class="cell-actcell" style="text-align:right"><div class="cell-actions">
        ${isSuper ? `<button class="btn btn-mini" data-act="scope-ent" data-id="${a.id}" data-u="${a.username}" title="Alcance de empresas">${I.sliders} Empresas</button>` : ''}
        ${roleBtn}
        <button class="btn btn-mini" data-act="osticket" data-id="${a.id}" data-u="${a.username}" title="Crear/actualizar como cliente de osTicket">osTicket</button>
        ${resetBtn}
        ${toggleBtn}
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">Sin gestores de empresa.</td></tr>';

  // ---- Grilla EDITORES ----
  const editorStats = {
    total: editores.length,
    on: editores.filter(a => a.is_active).length,
    off: editores.filter(a => !a.is_active).length,
  };
  const editorRows = editores.map(a => {
    const self = String(a.id) === String(user.id);
    const { roleBtn, resetBtn, toggleBtn } = auRowCommonActs(a, self, isSuper);
    return `<tr>
      <td class="code" data-label="Usuario">${a.username}</td>
      <td class="cell-name" data-label="Nombre">${a.name || '\u2014'}</td>
      ${emailCell(a)}
      <td data-label="Alcance">${scopeCellBoth(a)}</td>
      <td data-label="Estado">${estadoPill(a)}${lastLoginLabel(a.last_login_at)}</td>
      <td class="cell-actcell" style="text-align:right"><div class="cell-actions">
        <button class="btn btn-mini" data-act="scope-store" data-id="${a.id}" data-u="${a.username}" title="Alcance de tiendas">${I.sliders} Tiendas</button>
        <button class="btn btn-mini" data-act="scope-ent" data-id="${a.id}" data-u="${a.username}" title="Alcance de empresas">${I.sliders} Empresas</button>
        ${roleBtn}
        ${resetBtn}
        ${toggleBtn}
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">Sin editores de personal.</td></tr>';

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Equipo</h1><p>${isSuper ? `${rows.length} miembros \u00b7 cada rol con sus columnas y acciones` : `${gestores.length} gestor${gestores.length === 1 ? '' : 'es'} de empresa en tu alcance`}</p></div>
      ${isSuper ? `<div class="head-actions">
        <button class="btn" id="auSyncClients" title="Crear/actualizar los gestores de empresa como clientes de osTicket">${I.sync} Gestores osTicket</button>
        <button class="btn btn-primary" id="auNew">${I.plus} Nuevo miembro</button>
      </div>` : ''}</div>

    ${isSuper ? suHtml : ''}

    ${isSuper ? `<div class="role-block">
      <div class="role-head">
        <span class="role-title">Administradores</span>
        <span class="role-badge rb-admin">admin</span>
        <span class="role-desc">Alcance de Tiendas y Empresas \u00b7 osTicket: <span style="display:inline-flex;align-items:center;padding:1px 9px;border-radius:999px;background:#eff4ff;color:#1e40af;font-weight:600">Agente</span></span>
      </div>
      <div class="sum-cards c4">
        ${statCard('total', adminStats.total, 'Administradores')}
        ${statCard('ok', adminStats.withAgent, 'Con agente osTicket')}
        ${statCard('none', adminStats.noAgent, 'Sin agente')}
        ${statCard('off', adminStats.off, 'Inactivos')}
      </div>
      <div class="tablebox scroll-x u-compact tbl-cards"><table><thead><tr>
        <th>Usuario</th><th>Nombre</th><th>Correo</th><th>Alcance</th><th>osTicket (agente)</th><th>Estado</th><th style="text-align:right">Acciones</th>
      </tr></thead><tbody>${adminRows}</tbody></table></div>
    </div>` : ''}

    <div class="role-block">
      <div class="role-head">
        <span class="role-title">Gestores de empresa</span>
        <span class="role-badge rb-gestor">gestor</span>
        <span class="role-desc">Alcance solo de Empresas / departamentos \u00b7 osTicket: <span style="display:inline-flex;align-items:center;padding:1px 9px;border-radius:999px;background:#f0fdf4;color:#15803d;font-weight:600">Usuario</span></span>
      </div>
      <div class="sum-cards c4">
        ${statCard('total', gestorStats.total, 'Gestores')}
        ${statCard('acc', gestorStats.withClient, 'Con cliente osTicket')}
        ${statCard('none', gestorStats.noClient, 'Sin cliente')}
        ${statCard('off', gestorStats.off, 'Inactivos')}
      </div>
      <div class="tablebox scroll-x u-compact tbl-cards"><table><thead><tr>
        <th>Usuario</th><th>Nombre</th><th>Correo</th><th>Alcance (empresas)</th><th>osTicket (cliente)</th><th>Estado</th><th style="text-align:right">Acciones</th>
      </tr></thead><tbody>${gestorRows}</tbody></table></div>
    </div>

    ${isSuper ? `<div class="role-block">
      <div class="role-head">
        <span class="role-title">Editores de personal</span>
        <span class="role-badge rb-editor">editor</span>
        <span class="role-desc">Alcance de Tiendas y Empresas \u00b7 sin osTicket</span>
      </div>
      <div class="sum-cards c3">
        ${statCard('total', editorStats.total, 'Editores')}
        ${statCard('ok', editorStats.on, 'Activos')}
        ${statCard('off', editorStats.off, 'Inactivos')}
      </div>
      <div class="tablebox scroll-x u-compact tbl-cards"><table><thead><tr>
        <th>Usuario</th><th>Nombre</th><th>Correo</th><th>Alcance</th><th>Estado</th><th style="text-align:right">Acciones</th>
      </tr></thead><tbody>${editorRows}</tbody></table></div>
    </div>` : ''}`;

  if (isSuper) {
    $('#auNew').addEventListener('click', () => auCreateModal(user));
    $('#auSyncClients').addEventListener('click', () => auSyncClientsAll(user));
  }
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
    <select id="auR" style="margin-bottom:14px;width:100%">${adminRoleOptionsHtml('admin')}</select>
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
  if (ds.act === 'scope-store') { openScopeEditor(user, ds.id, ds.u, 'store', 'equipo'); return; }
  if (ds.act === 'scope-ent') { openScopeEditor(user, ds.id, ds.u, 'enterprise', 'equipo'); return; }
  if (ds.act === 'role') { auRoleModal(ds, user); return; }
  if (ds.act === 'osticket') { auSyncClientOne(ds, user); return; }
  if (ds.act === 'osticket-agent') { auAgentInfo(ds, user); return; }
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

/* Modal reutilizable para crear/resetear el AGENTE osTicket de un admin.
   Pide usuario (prellenado) + bloque de clave (temporal autogenerada o una
   que defina el superadmin). onDone(creds) recibe {username, password} donde
   password puede ser '' si eligio temporal (el backend genera la temporal).
   `meta` = { id, username, name, mode:'create'|'reset' }.
   Este modal NO llama al backend por si mismo cuando es 'create' desde el
   flujo de alcance (deja que saveScope re-empuje); para 'reset' directo desde
   Equipo, si llama a reset_agent. Se distingue por meta.direct. */
function agentModal(user, meta, onDone) {
  const isReset = meta.mode === 'reset';
  const titulo = isReset ? 'Resetear clave del agente' : 'Crear agente osTicket';
  const who = meta.name && meta.name !== meta.username ? `${meta.username} \u00b7 ${meta.name}` : meta.username;
  openModal(`
    <div class="modal-head"><span>${titulo}</span><button class="modal-x" id="mX">\u2715</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 14px">${who} \u00b7 agente (staff) de osTicket. Con esto ve su bandeja de tickets.</p>
    <label class="flabel">Usuario (osTicket)</label>
    <input type="text" id="agUser" value="${meta.username || ''}" style="margin-bottom:14px">
    ${pwdBlockHtml()}
    <p id="agErr" style="color:var(--danger);font-size:12.5px;margin:10px 0 0;display:none"></p>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">${isReset ? 'Resetear clave' : 'Crear agente'}</button>
    </div>`);
  wirePwdBlock();
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const uname = $('#agUser').value.trim();
    const err = $('#agErr');
    if (!uname) { err.textContent = 'Indica el usuario.'; err.style.display = 'block'; return; }
    const pw = readPwd();   // { useTemp:true } | { useTemp:false, password }
    // Si define clave manual, validar minimo 6.
    if (!pw.useTemp && (!pw.password || pw.password.length < 6)) {
      err.textContent = 'La clave debe tener al menos 6 caracteres.'; err.style.display = 'block'; return;
    }
    // password que se envia al backend: '' cuando es temporal (el backend la
    // genera). onDone recibe estas credenciales.
    const creds = { username: uname, password: pw.useTemp ? '' : pw.password };
    if (meta.direct) {
      // Reset directo desde Equipo: llamamos reset_agent aqui mismo.
      const btn = $('#mOk'); btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Guardando\u2026';
      let r;
      try {
        r = await fetch('/api/admin-scope', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reset_agent', adminId: user.id, targetId: meta.id,
            username: uname, password: creds.password }),
        }).then(x => x.json());
      } catch (e) { r = { ok: false, error: 'Error de conexion: ' + (e && e.message || e) }; }
      if (!r || !r.ok) { err.textContent = (r && r.error) || 'No se pudo guardar.'; err.style.display = 'block'; btn.disabled = false; btn.textContent = orig; return; }
      closeModal();
      // Mostrar credenciales (reusa el modal de resultado, sin conteo de bandeja).
      agentCredsModal(user, r, meta.username, () => viewEquipo(user));
    } else {
      // Flujo de creacion desde guardar alcance: delega en onDone.
      if (onDone) onDone(creds);
    }
  });
}

/* Modal simple de credenciales del agente (usado por el reset directo). */
function agentCredsModal(user, r, targetUser, done) {
  const credUser = r.agent_username || targetUser;
  openModal(`
    <div class="modal-head"><span>Agente osTicket listo</span><button class="modal-x" id="mX">\u2715</button></div>
    <p style="margin:0 0 4px">\u2705 Agente ${r.agent_created ? 'creado' : 'actualizado'}${r.staff_id ? ` <span class="muted">(#${r.staff_id})</span>` : ''}.</p>
    <div style="margin-top:12px;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft,#f7f7f9)">
      ${copyFieldHtml('Usuario', credUser, 'acrUser')}
      ${copyFieldHtml('Clave', r.temp_password || '', 'acrPass')}
      <button class="btn" data-copy-all type="button" style="width:100%;margin-top:2px">Copiar usuario y clave</button>
      <p class="muted" style="font-size:11.5px;margin:10px 0 0;line-height:1.5">Entr\u00e9gaselas al agente. Debera cambiar la clave al entrar. No se vuelve a mostrar.</p>
    </div>
    <div class="modal-actions"><button class="btn btn-primary" id="mClose">Listo</button></div>`);
  const finish = () => { closeModal(); if (done) done(); };
  $('#mX').addEventListener('click', finish);
  $('#mClose').addEventListener('click', finish);
  document.querySelectorAll('[data-copy]').forEach(b =>
    b.addEventListener('click', () => { const el = document.getElementById(b.dataset.copy); if (el) { el.select(); copyToClipboard(el.value, b); } }));
  const all = document.querySelector('[data-copy-all]');
  if (all) all.addEventListener('click', () => {
    const u = document.getElementById('acrUser'), pw = document.getElementById('acrPass');
    copyToClipboard(`Usuario: ${u ? u.value : ''}\nClave: ${pw ? pw.value : ''}`, all);
  });
}

/* Boton osTicket de la grilla ADMINS. Abre un menu breve:
   - si el admin YA tiene agente: ofrece resetear la clave o ir al alcance.
   - si NO tiene agente: explica que se crea al guardar el alcance y ofrece ir.
   ds trae: id, u, staff (osticket_staff_id o vacio). */
function auAgentInfo(ds, user) {
  const hasAgent = ds.staff && ds.staff !== 'null' && ds.staff !== '';
  openModal(`
    <div class="modal-head"><span>Agente osTicket</span><button class="modal-x" id="mX">\u2715</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 12px">${ds.u}${hasAgent ? ` \u00b7 agente #${ds.staff}` : ''}</p>
    ${hasAgent
      ? `<p style="margin:0 0 12px;line-height:1.6">Este admin ya tiene agente en osTicket. Puedes <b>resetear su clave</b> (para entregarsela de nuevo) o ir a su <b>alcance de tiendas</b> para reajustar su bandeja.</p>`
      : `<p style="margin:0 0 12px;line-height:1.6">Este admin <b>aun no tiene agente</b> en osTicket. El agente se crea al guardar su <b>alcance de tiendas</b> (o de empresas): alli se pide el usuario y la clave, y se sincroniza su bandeja.</p>`}
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cerrar</button>
      ${hasAgent ? `<button class="btn" id="mReset">${I.key} Resetear clave</button>` : ''}
      <button class="btn btn-primary" id="mGo">${I.sliders} Ir al alcance de tiendas</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mGo').addEventListener('click', () => { closeModal(); openScopeEditor(user, ds.id, ds.u, 'store', 'equipo'); });
  const rb = $('#mReset');
  if (rb) rb.addEventListener('click', () => { closeModal(); agentModal(user, { id: ds.id, username: ds.u, mode: 'reset', direct: true }); });
}


/* Modal para cambiar el rol de un miembro del Equipo. Solo superadmin (lo
   exige el backend). El <select> ofrece admin / gestor de empresa / editor de
   personal (superadmin no es elegible aqui). Preselecciona el rol actual
   (ds.role). El backend rechaza: cambiar el propio rol y quitar el ultimo
   superadmin. El error se muestra dentro del modal (sin alert nativo). */
function auRoleModal(ds, user) {
  // Roles desde la BD (cache ADMIN_ROLES, cargado al entrar a Equipo).
  // superadmin no es elegible aqui (se excluye). Fallback: lista historica.
  const ROLE_OPTS = (ADMIN_ROLES || ADMIN_ROLES_FALLBACK)
    .filter(r => r.code !== 'superadmin')
    .map(r => ({ v: r.code, l: r.label }));
  const cur = ds.role || '';
  const opts = ROLE_OPTS.map(o =>
    `<option value="${o.v}"${o.v === cur ? ' selected' : ''}>${o.l}</option>`).join('');
  openModal(`
    <div class="modal-head"><span>Cambiar rol</span><button class="modal-x" id="mX">\u2715</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${ds.u}</p>
    <label class="flabel">Rol</label>
    <select id="auRoleSel" style="width:100%;margin-bottom:8px">${opts}</select>
    <p class="muted" style="font-size:11.5px;margin:0">Rol actual: <b>${ROLE_LABELS[cur] || cur || '\u2014'}</b>. El superadmin no se asigna desde aqui.</p>
    <p id="auRoleErr" style="color:var(--danger);font-size:12.5px;margin:10px 0 0;display:none"></p>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Guardar rol</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const role = $('#auRoleSel').value;
    const err = $('#auRoleErr');
    if (role === cur) { closeModal(); return; }
    const btn = $('#mOk'); btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Guardando\u2026';
    let d;
    try { d = await auApi({ action: 'update_role', adminId: user.id, id: ds.id, role }); }
    catch (e) { d = { ok: false, error: 'Error de conexion: ' + (e && e.message || e) }; }
    if (!d.ok) {
      err.textContent = d.error || 'No se pudo cambiar el rol.';
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = orig;
      return;
    }
    closeModal();
    // Si hubo acciones/avisos de osTicket por la transicion de rol, mostrarlos
    // antes de refrescar la grilla.
    const ost = d.osticket;
    const hasInfo = ost && ((ost.steps && ost.steps.length) || (ost.warnings && ost.warnings.length));
    if (hasInfo) {
      const stepsHtml = (ost.steps || []).map(s => `<li>\u2705 ${s}</li>`).join('');
      const warnHtml = (ost.warnings || []).map(w => `<li style="color:var(--danger)">\u26a0\ufe0f ${w}</li>`).join('');
      openModal(`
        <div class="modal-head"><span>Rol actualizado</span><button class="modal-x" id="mX2">\u2715</button></div>
        <p style="margin:0 0 10px">${ds.u}: <b>${ROLE_LABELS[d.prev_role] || d.prev_role}</b> \u2192 <b>${ROLE_LABELS[d.role] || d.role}</b></p>
        <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7">${stepsHtml}${warnHtml}</ul>
        <div class="modal-actions"><button class="btn btn-primary" id="mClose2">Listo</button></div>`);
      const fin = () => { closeModal(); viewEquipo(user); };
      $('#mX2').addEventListener('click', fin);
      $('#mClose2').addEventListener('click', fin);
    } else {
      viewEquipo(user);
    }
  });
}

/* Crea/actualiza UN gestor_empresa como cliente de osTicket (boton por fila).
   Abre un modal que pide el usuario (prellenado con el del portal) y una clave
   FIJA que tu defines; con eso el gestor entra al portal de clientes de
   osTicket con usuario + clave (osTicket no le fuerza el cambio). El backend
   valida rol y correo. Sin alert nativo. */
function auSyncClientOne(ds, user) {
  openModal(`
    <div class="modal-head"><span>Acceso osTicket del gestor</span><button class="modal-x" id="mX">\u2715</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${ds.u} \u00b7 se crea/actualiza su cliente de osTicket y su acceso (usuario + clave).</p>
    <label class="flabel">Usuario (osTicket)</label>
    <input type="text" id="ocUser" value="${ds.u}" style="margin-bottom:12px">
    <label class="flabel">Clave</label>
    <input type="text" id="ocPass" placeholder="minimo 6 caracteres" autocomplete="off" style="margin-bottom:6px">
    <p class="muted" style="font-size:11.5px;margin:0">La clave es fija (no se fuerza el cambio al entrar). Se mostrara aqui para que se la entregues; anotala.</p>
    <p id="ocErr" style="color:var(--danger);font-size:12.5px;margin:10px 0 0;display:none"></p>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Crear acceso</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const uname = $('#ocUser').value.trim();
    const pass = $('#ocPass').value;
    const err = $('#ocErr');
    if (!uname) { err.textContent = 'Indica el usuario.'; err.style.display = 'block'; return; }
    if (!pass || pass.length < 6) { err.textContent = 'La clave debe tener al menos 6 caracteres.'; err.style.display = 'block'; return; }
    const btn = $('#mOk'); btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Creando\u2026';
    let d;
    try { d = await auApi({ action: 'sync_client', adminId: user.id, id: ds.id, username: uname, password: pass }); }
    catch (e) { d = { ok: false, error: 'Error de conexion: ' + (e && e.message || e) }; }
    if (!d.ok) {
      err.textContent = d.error || 'No se pudo crear el acceso.';
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = orig;
      return;
    }
    // Exito: mostrar credenciales copiables.
    openModal(`
      <div class="modal-head"><span>Acceso osTicket listo</span><button class="modal-x" id="mX">\u2715</button></div>
      <p style="margin:0 0 4px">\u2705 Cliente osTicket ${d.created ? 'creado' : 'actualizado'} y acceso ${d.account_created ? 'creado' : 'actualizado'} para <b>${ds.u}</b>.</p>
      <div style="margin-top:12px;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft,#f7f7f9)">
        ${copyFieldHtml('Usuario', uname, 'ocrUser')}
        ${copyFieldHtml('Clave', pass, 'ocrPass')}
        <button class="btn" data-copy-all type="button" style="width:100%;margin-top:2px">Copiar usuario y clave</button>
        <p class="muted" style="font-size:11.5px;margin:10px 0 0;line-height:1.5">Entregaselo a <b>${ds.u}</b>. Entra en el portal de clientes de osTicket con ese usuario y clave.</p>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" id="mClose">Listo</button></div>`);
    const finish = () => { closeModal(); viewEquipo(user); };
    $('#mX').addEventListener('click', finish);
    $('#mClose').addEventListener('click', finish);
    document.querySelectorAll('[data-copy]').forEach(b =>
      b.addEventListener('click', () => {
        const el = document.getElementById(b.dataset.copy);
        if (el) { el.select(); copyToClipboard(el.value, b); }
      }));
    const all = document.querySelector('[data-copy-all]');
    if (all) all.addEventListener('click', () => {
      const us = document.getElementById('ocrUser');
      const pw = document.getElementById('ocrPass');
      copyToClipboard(`Usuario: ${us ? us.value : ''}\nClave: ${pw ? pw.value : ''}`, all);
    });
  });
}

/* Crea/actualiza TODOS los gestor_empresa activos con correo como clientes de
   osTicket (boton de cabecera). Muestra un resumen con el detalle por gestor. */
async function auSyncClientsAll(user) {
  const btn = document.getElementById('auSyncClients');
  if (btn) { btn.disabled = true; btn.innerHTML = 'Sincronizando\u2026'; }
  let d;
  try { d = await auApi({ action: 'sync_clients_all', adminId: user.id }); }
  catch (e) { d = { ok: false, error: 'Error de conexion: ' + (e && e.message || e) }; }
  if (!d.ok) {
    openModal(`
      <div class="modal-head"><span>No se pudo sincronizar</span><button class="modal-x" id="mX">\u2715</button></div>
      <p style="margin:0">\u26a0\ufe0f ${d.error || 'Error desconocido.'}</p>
      <div class="modal-actions"><button class="btn btn-primary" id="mClose">Listo</button></div>`);
    const fin = () => { closeModal(); viewEquipo(user); };
    $('#mX').addEventListener('click', fin);
    $('#mClose').addEventListener('click', fin);
    return;
  }
  const detalle = (d.results || []).map(r =>
    r.ok
      ? `<div>\u2705 <b>${r.username}</b> \u2014 ${r.created ? 'creado' : 'actualizado'}${r.user_id ? ` <span class="muted">(#${r.user_id})</span>` : ''}</div>`
      : `<div style="color:var(--danger)">\u2715 <b>${r.username}</b> \u2014 ${r.error || 'error'}</div>`
  ).join('') || '<p class="muted" style="margin:0">No hay gestores de empresa activos con correo.</p>';
  openModal(`
    <div class="modal-head"><span>Gestores en osTicket</span><button class="modal-x" id="mX">\u2715</button></div>
    <p style="margin:0 0 10px">Procesados: <b>${d.processed}</b> \u00b7 correctos: <b>${d.ok_count}</b>${d.fail_count ? ` \u00b7 con error: <b>${d.fail_count}</b>` : ''}.</p>
    <div style="max-height:50vh;overflow:auto;font-size:13px;line-height:1.8">${detalle}</div>
    <div class="modal-actions"><button class="btn btn-primary" id="mClose">Listo</button></div>`);
  const finish = () => { closeModal(); viewEquipo(user); };
  $('#mX').addEventListener('click', finish);
  $('#mClose').addEventListener('click', finish);
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
    <div class="tablebox tbl-cards"><table><thead><tr>
      <th>Usuario</th><th>Nombre</th><th>Rol</th><th>Estado</th><th style="text-align:right">Alcance</th>
    </tr></thead><tbody>
      ${admins.map(a => `<tr>
        <td class="code" data-label="Usuario">${a.username}</td><td data-label="Nombre">${a.name || '—'}</td>
        <td data-label="Rol"><span class="pill pill-gray">${ROLE_LABELS[a.role] || a.role}</span></td>
        <td data-label="Estado">${a.is_active ? '<span class="pill pill-open">Activo</span>' : '<span class="pill pill-closed">Inactivo</span>'}</td>
        <td data-label="Alcance" style="text-align:right;white-space:nowrap"><button class="btn btn-mini" data-id="${a.id}" data-u="${a.username}" data-kind="store" style="margin-right:4px">${I.sliders} Tiendas</button><button class="btn btn-mini" data-id="${a.id}" data-u="${a.username}" data-kind="enterprise">${I.sliders} Empresas</button></td>
      </tr>`).join('')}
    </tbody></table></div>`}`;
  $('#pnlMain').querySelectorAll('button[data-id]').forEach(b =>
    b.addEventListener('click', () => openScopeEditor(user, b.dataset.id, b.dataset.u, b.dataset.kind || 'store')));
}

async function openScopeEditor(user, targetId, targetUser, kind = 'store', origin = 'permisos') {
  $('#pnlMain').innerHTML = `<div class="pnl-loading">Cargando alcance\u2026</div>`;
  const d = await fetch('/api/admin-scope', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get', adminId: user.id, targetId }),
  }).then(r => r.json());
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }

  SCOPE = {
    target: targetId, targetUser, origin,
    kind, isEnt: kind === 'enterprise',
    include: d.include.map(x => ({ ...x })),
    exclude: d.exclude.map(x => ({ ...x })),
    zones: d.zones, subzones: d.subzones, companies: d.companies,
    departments: d.departments || [],
  };

  // A donde vuelve al Cancelar / Volver / terminar de guardar.
  const backTo = () => (origin === 'equipo' ? viewEquipo(user) : viewPermisos(user));
  SCOPE.backTo = backTo;

  // Aviso de que vera el agente en osTicket segun este alcance. El agente ve
  // en su bandeja los remitentes (usuarios de osTicket) de TODO su alcance
  // (tiendas + empresas). Las que aun no tengan remitente se suman cuando se
  // creen en Usuarios -> osTicket.
  const ostInfo = `<div class="sc-ostinfo">`
    + `<span class="sc-ostinfo-ic">\u{1F3AB}</span>`
    + `<div>En <b>osTicket</b>, este agente vera en su bandeja los tickets de los remitentes `
    + `de <b>todo su alcance</b> (tiendas y empresas de esta lista) que ya tengan usuario de osTicket. `
    + `Al guardar se crea/actualiza el agente y se sincroniza su bandeja. `
    + `${SCOPE.isEnt ? 'Aunque estas sean empresas (no tiendas), tambien aportan su remitente a la bandeja.' : ''}</div></div>`;

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Alcance de ${SCOPE.isEnt ? 'Empresas' : 'Tiendas'} \u00b7 ${targetUser}</h1>
      <p>${SCOPE.isEnt ? 'Define qu\u00e9 empresas (no tiendas) o departamentos puede gestionar. Alcance final = incluidos \u2212 excluidos.' : 'Define qu\u00e9 tiendas puede gestionar. Alcance final = incluidos \u2212 excluidos.'}</p></div>
      <button class="btn" id="scBack">\u2190 Volver</button></div>
    ${ostInfo}
    <div class="card">
      <div class="sc-add">
        <select id="scLevel">
          ${SCOPE.isEnt
            ? '<option value="company">Empresa (todo)</option><option value="department">Departamento</option>'
            : '<option value="zone">Zona</option><option value="subzone">Subzona</option><option value="company">Tienda</option>'}
        </select>
        <div class="search" style="flex:1">${I.search}<input id="scSearch" placeholder="Buscar\u2026" autocomplete="off"></div>
        ${SCOPE.isEnt ? `<button class="btn" id="scNewDept" title="Crear un departamento" style="white-space:nowrap;display:none">${I.plus} Nuevo departamento</button>` : ''}
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

  $('#scBack').addEventListener('click', backTo);
  $('#scCancel').addEventListener('click', backTo);
  $('#scSave').addEventListener('click', () => saveScope(user));

  const lvl = $('#scLevel'), search = $('#scSearch');
  const newDeptBtn = $('#scNewDept');
  // El boton "Nuevo departamento" solo aplica al nivel Departamento.
  function syncNewDeptBtn() {
    if (newDeptBtn) newDeptBtn.style.display = (lvl.value === 'department') ? '' : 'none';
  }
  lvl.addEventListener('change', () => { search.value = ''; syncNewDeptBtn(); renderScResults(); });
  search.addEventListener('input', renderScResults);
  if (newDeptBtn) newDeptBtn.addEventListener('click', () => openScNewDeptModal(user));
  syncNewDeptBtn();
  renderScopeLists();
  renderScResults();
}

/* Modal para crear un departamento SIN salir del editor de alcance.
   Pide empresa (no-tienda del catalogo del scope) + nombre, crea via
   /api/departments y recarga SCOPE.departments conservando lo ya marcado
   (include/exclude en memoria). Tras crear, deja el nivel en Departamento y
   filtra por la empresa elegida para ubicar el nuevo facilmente. */
function openScNewDeptModal(user) {
  const nonStore = (SCOPE.companies || []).filter(c => NON_STORE_TYPES.has(c.company_type));
  if (!nonStore.length) {
    openModal(`
      <div class="modal-head"><span>Nuevo departamento</span><button class="modal-x" id="mX">\u2715</button></div>
      <p class="muted" style="font-size:13px;margin:0">No hay empresas (no tiendas) en el cat\u00e1logo para crear un departamento.</p>
      <div class="modal-actions"><button class="btn btn-primary" id="mOk">Entendido</button></div>`);
    $('#mX').addEventListener('click', closeModal);
    $('#mOk').addEventListener('click', closeModal);
    return;
  }
  const opts = nonStore
    .sort((a, b) => a.company_code.localeCompare(b.company_code))
    .map(c => `<option value="${c.company_code}">${c.company_code} \u00b7 ${(c.business_name || '').replace(/"/g, '&quot;')}</option>`).join('');
  openModal(`
    <div class="modal-head"><span>Nuevo departamento</span><button class="modal-x" id="mX">\u2715</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">Se crea el departamento en la empresa elegida; luego puedes incluirlo en el alcance.</p>
    <label class="flabel">Empresa</label>
    <select id="scdCompany" style="width:100%;margin-bottom:12px">${opts}</select>
    <label class="flabel">Nombre del departamento</label>
    <input type="text" id="scdName" placeholder="ej. Tributos" style="margin-bottom:6px">
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Crear departamento</button>
    </div>`);
  setTimeout(() => { const i = document.getElementById('scdName'); if (i) i.focus(); }, 30);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const cc = $('#scdCompany').value;
    const name = $('#scdName').value.trim();
    if (!name) { alert('Falta el nombre del departamento.'); return; }
    const btn = $('#mOk'); btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Creando\u2026';
    const r = await fetch('/api/departments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', adminId: user.id, company_code: cc, name }),
    }).then(x => x.json()).catch(() => ({ ok: false, error: 'Error de red.' }));
    if (!r.ok) { alert(r.error || 'No se pudo crear.'); btn.disabled = false; btn.textContent = orig; return; }
    // Recargar SOLO el catalogo de departamentos del scope, conservando lo
    // que el usuario ya marco (include/exclude viven en memoria en SCOPE).
    try {
      const d = await fetch('/api/admin-scope', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', adminId: user.id, targetId: SCOPE.target }),
      }).then(x => x.json());
      if (d.ok) SCOPE.departments = d.departments || SCOPE.departments;
    } catch { /* si falla, el nuevo aparecera al reabrir */ }
    closeModal();
    // Dejar el nivel en Departamento y filtrar por la empresa para ubicarlo.
    const lvl = $('#scLevel'); if (lvl) lvl.value = 'department';
    const search = $('#scSearch'); if (search) search.value = cc;
    const newDeptBtn = $('#scNewDept'); if (newDeptBtn) newDeptBtn.style.display = '';
    renderScResults();
  });
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
function scopeResultModal(user, p, targetUser, backTo) {
  const done = backTo || (() => viewPermisos(user));
  const staffTag = p.staff_id ? ` <span class="muted">(#${p.staff_id})</span>` : '';
  const pend = p.scope_pending_user > 0
    ? `<p class="muted" style="font-size:12px;margin:6px 0 0;line-height:1.5">`
      + `${p.scope_pending_user} de su alcance a\u00fan no tienen usuario en osTicket; `
      + `se sumar\u00e1n a medida que las sincronices en Usuarios \u2192 osTicket.</p>`
    : '';

  // Bloque de credenciales: cuando se creo o se reseteo la clave en esta corrida.
  const credUser = p.agent_username || targetUser;
  const creds = (p.temp_password) ? `
    <div style="margin-top:16px;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft,#f7f7f9)">
      <p class="flabel" style="margin:0 0 10px;display:flex;align-items:center;gap:6px">\u{1F511} Credenciales del agente</p>
      ${copyFieldHtml('Usuario', credUser, 'scrUser')}
      ${copyFieldHtml('Clave', p.temp_password, 'scrPass')}
      <button class="btn" data-copy-both type="button" style="width:100%;margin-top:2px">Copiar usuario y clave juntos</button>
      <p class="muted" style="font-size:11.5px;margin:10px 0 0;line-height:1.5">`
      + `Entr\u00e9gaselas a <b>${targetUser}</b>. La clave la deber\u00e1 cambiar al entrar por primera vez. `
      + `<b>No se vuelve a mostrar</b>, c\u00f3piala ahora.</p>
    </div>` : '';

  openModal(`
    <div class="modal-head"><span>Alcance sincronizado con osTicket</span><button class="modal-x" id="mX">\u2715</button></div>
    <p style="margin:0 0 4px">\u2705 Alcance guardado y reflejado en osTicket.</p>
    <p style="margin:0">Agente: <b>${targetUser}</b>${staffTag}<br>
      En su bandeja: <b>${p.scope_count}</b> de ${p.scope_total} con usuario en osTicket.</p>
    ${pend}
    ${creds}
    <div class="modal-actions">
      <button class="btn btn-primary" id="mClose">Listo</button>
    </div>`);

  const finish = () => { closeModal(); done(); };
  $('#mX').addEventListener('click', finish);
  $('#mClose').addEventListener('click', finish);
  // El modal se cierra SOLO con sus botones (X / Listo); no al hacer clic fuera.

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
    if (u && pw) copyToClipboard(`Usuario: ${u.value}\nClave: ${pw.value}`, both);
  });
}

async function saveScope(user) {
  const btn = $('#scSave'); btn.disabled = true; btn.textContent = 'Guardando\u2026';
  const targetUser = SCOPE.targetUser || 'el agente';
  const backTo = SCOPE.backTo || (() => viewPermisos(user));
  // 1) Guardar el alcance en el portal (la verdad). Esto no debe fallar por osTicket.
  const d = await fetch('/api/admin-scope', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save', adminId: user.id, targetId: SCOPE.target,
      include: SCOPE.include, exclude: SCOPE.exclude }),
  }).then(r => r.json());
  if (!d.ok) { alert(d.error); btn.disabled = false; btn.textContent = 'Guardar alcance'; return; }

  // 2) Empujar el alcance a osTicket (agente + bandeja). Aplica IGUAL para
  //    Tiendas y Empresas: el agente ve los remitentes de TODO su alcance.
  btn.textContent = 'Sincronizando con osTicket\u2026';
  const targetId = SCOPE.target;
  const pushScope = async (extra = {}) => {
    try {
      return await fetch('/api/admin-scope', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'push_to_osticket', adminId: user.id, targetId, ...extra }),
      }).then(r => r.json());
    } catch (e) {
      return { ok: false, error: 'No se pudo contactar el servidor: ' + e.message };
    }
  };

  let p = await pushScope();

  // 2z) El target no es agente (gestor/editor): el backend no crea agente.
  //     El alcance ya quedo guardado en el portal; volvemos sin pedir clave.
  //     La sincronizacion osTicket del gestor se hace como CLIENTE desde el
  //     boton osTicket de su fila (no aqui).
  if (p && p.ok && p.skipped) {
    backTo();
    return;
  }

  // 2a) El agente aun no existe: el backend pide crearlo. Lanzamos el modal de
  //     creacion (usuario + clave temporal/definida) y, al confirmar, se
  //     re-empuja el alcance con esas credenciales.
  if (p && p.ok && p.needs_agent) {
    // El alcance ya se guardo; restauramos el boton por si se cancela el modal
    // (evita que quede colgado en "Sincronizando...").
    btn.disabled = false; btn.textContent = 'Guardar alcance';
    agentModal(user, { id: targetId, username: p.username, name: p.name, mode: 'create' }, async (creds) => {
      const btn2 = $('#mOk'); if (btn2) { btn2.disabled = true; btn2.textContent = 'Creando agente\u2026'; }
      const p2 = await pushScope({ username: creds.username, password: creds.password });
      if (!p2 || !p2.ok) {
        const err = $('#agErr');
        if (err) { err.textContent = (p2 && p2.error) || 'No se pudo crear el agente.'; err.style.display = 'block'; }
        if (btn2) { btn2.disabled = false; btn2.textContent = 'Crear agente'; }
        return;
      }
      closeModal();
      scopeResultModal(user, p2, targetUser, backTo);
    });
    return;
  }

  if (!p || !p.ok) {
    // El alcance SI se guardo; solo fallo el reflejo en osTicket.
    alert('\u26a0\ufe0f El alcance se guardo, pero no se pudo sincronizar con osTicket:\n'
      + ((p && p.error) || 'error desconocido')
      + '\n\nPuedes reintentar volviendo a guardar el alcance.');
    backTo();
    return;
  }

  // 3) Resultado OK. Mostrar el modal con conteo y credenciales copiables.
  scopeResultModal(user, p, targetUser, backTo);
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
    <td data-label="Fecha">${fmtDeadline(r.finished_at || r.started_at)}</td>
    <td data-label="Empresa"><b>${escHtml(r.company_code)}</b>${r.business_name ? `<br><span class="muted" style="font-size:11px">${escHtml(r.business_name)}</span>` : ''}</td>
    <td data-label="Origen">${originLabel(r)}</td>
    <td data-label="Estado">${r.status === 'ok' ? '<span class="pill pill-open">OK</span>' : '<span class="pill pill-closed">Error</span>'}</td>
    <td data-label="Resultado">${resultCell(r)}</td>
    <td data-label="Cambios">${changesCell(r)}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty">Aún no hay sincronizaciones de personal.</td></tr>';

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Sinc. Personal</h1><p>Últimas sincronizaciones de personal desde AX${runs.length ? ` · ${runs.length}` : ''}</p></div></div>
    <div class="card">
      <table class="cfg-cat-table tbl-cards"><thead><tr><th>Fecha</th><th>Empresa</th><th>Origen</th><th>Estado</th><th>Resultado</th><th>Cambios</th></tr></thead><tbody>${rows}</tbody></table>
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

/* ---------- Estado de pago: programacion del cron (config propia) ----------
   Tarjeta DENTRO de la pantalla de Sincronizacion. Frecuencia variable por
   dia (segun el calendario de quincenas): Dia de Calculo -> cada X min;
   Dia de Pago -> cada Y min; resto -> 1 vez al dia a una hora. Mas un boton
   para refrescar la tabla cache ahora mismo. Endpoint: /api/pay-sync-config. */
async function paySyncApi(payload) {
  return fetch('/api/pay-sync-config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(r => r.json());
}

async function renderPaySyncCard(user) {
  const host = document.getElementById('payCfgCard');
  if (!host) return;
  const escH = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const res = await paySyncApi({ action: 'get', adminId: user.id });
  if (!res.ok) {
    host.innerHTML = `<div class="card"><p class="muted" style="margin:0">Estado de pago: no se pudo cargar la configuracion (${escH(res.error || 'error')}).</p></div>`;
    return;
  }
  const cfg = res.config || { enabled: true, calc_minutes: 60, pay_minutes: 60, daily_hour: 6 };

  const lastHtml = (c) => {
    if (!c || !c.last_run_at) return '<span class="muted">Aun no se ha ejecutado.</span>';
    const when = fmtDeadline(c.last_run_at);
    const src = c.last_source === 'cron' ? 'automatica' : 'manual';
    const dur = c.last_duration_ms != null ? ` \u00b7 ${(c.last_duration_ms / 1000).toFixed(1)} s` : '';
    if (c.last_status === 'ok') {
      const r = c.last_result || {};
      return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="pill pill-open">\u2705 OK</span><b>${when}</b><span class="muted">${src}${dur}</span></div>`
        + `<div style="margin-top:8px">${r.companies || 0} empresas \u00b7 ${r.rows || 0} registros (index 0 y -1)</div>`;
    }
    const err = (c.last_result && c.last_result.error) || 'error desconocido';
    return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="pill pill-closed">\u274c Error</span><b>${when}</b><span class="muted">${src}${dur}</span></div>`
      + `<div style="margin-top:8px;color:var(--danger)">${escH(err)}</div>`;
  };
  const hourOpts = Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}" ${cfg.daily_hour === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');

  host.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3 style="margin:0;font-size:15px">Estado de pago del periodo</h3>
        <div class="head-actions"><button class="btn" id="payLogBtn" title="Ver el registro completo de corridas">Registro</button><button class="btn" id="payRunBtn">${I.sync} Actualizar ahora</button></div>
      </div>
      <p class="cfg-desc" style="margin:0 0 6px">Refresca la tabla con el estado de pago (index 0 y -1) de todas las empresas; de ahi leen la tienda, el admin y el superadmin. Asi no se llama al API en cada visita.</p>
      <div id="payLast" style="margin:0 0 12px">${lastHtml(cfg)}</div>
      <p class="cfg-desc" style="margin:0 0 12px">El cron revisa cada ~15 min y actualiza con mayor frecuencia el <b>Dia de Calculo</b> y el <b>Dia de Pago</b> (cuando los estatus cambian); el resto de los dias, una vez al dia.</p>
      <div class="cfg-grid3">
        <div><label class="flabel">Estado</label>
          <select id="payEnabled"><option value="1" ${cfg.enabled ? 'selected' : ''}>Activa</option><option value="0" ${!cfg.enabled ? 'selected' : ''}>Inactiva</option></select></div>
        <div><label class="flabel">Dia de Calculo <span class="muted">(cada X min)</span></label>
          <input type="number" id="payCalcMin" min="1" max="1440" value="${cfg.calc_minutes ?? 60}"></div>
        <div><label class="flabel">Dia de Pago <span class="muted">(cada Y min)</span></label>
          <input type="number" id="payPayMin" min="1" max="1440" value="${cfg.pay_minutes ?? 60}"></div>
      </div>
      <div class="cfg-grid3" style="margin-top:12px">
        <div><label class="flabel">Resto de dias <span class="muted">(hora, Caracas)</span></label>
          <select id="payDailyHour">${hourOpts}</select></div>
      </div>
      <details style="margin-top:14px">
        <summary class="muted" style="cursor:pointer;font-size:12.5px">Opciones avanzadas</summary>
        <div style="margin-top:10px"><label class="flabel">URL del portal <span class="muted">(donde corre /api/sync-period-pay)</span></label>
          <input type="text" id="payUrl" value="${escH(cfg.endpoint_url || '')}" placeholder="https://nominav2.pages.dev">
          <p class="muted" style="font-size:11.5px;margin:6px 0 0">El cron llama a esta URL para refrescar la tabla. Si se deja vacio, usa el valor por defecto.</p></div>
      </details>
      <div class="cfg-foot"><span class="cfg-saved" id="paySaved">\u2713 Guardado</span><button class="btn btn-primary" id="paySave">Guardar programacion</button></div>
    </div>`;

  $('#paySave').addEventListener('click', async () => {
    const btn = $('#paySave'); btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Guardando\u2026';
    const r = await paySyncApi({
      action: 'set', adminId: user.id,
      enabled: $('#payEnabled').value === '1',
      calc_minutes: parseInt($('#payCalcMin').value, 10),
      pay_minutes: parseInt($('#payPayMin').value, 10),
      daily_hour: parseInt($('#payDailyHour').value, 10),
      endpoint_url: $('#payUrl').value.trim(),
    });
    btn.disabled = false; btn.textContent = orig;
    if (!r.ok) { alert(r.error || 'No se pudo guardar.'); return; }
    const sv = $('#paySaved'); if (sv) { sv.style.display = 'inline'; setTimeout(() => sv.style.display = 'none', 1800); }
  });

  $('#payRunBtn').addEventListener('click', async () => {
    const btn = $('#payRunBtn'); btn.disabled = true; const orig = btn.innerHTML; btn.textContent = 'Actualizando\u2026';
    const last = $('#payLast'); if (last) last.innerHTML = '<span class="muted">Actualizando la tabla\u2026</span>';
    let r;
    try { r = await paySyncApi({ action: 'run', adminId: user.id }); }
    catch (e) { r = { ok: false, error: String(e.message || e) }; }
    const fresh = await paySyncApi({ action: 'get', adminId: user.id });
    if (fresh.ok && last) last.innerHTML = lastHtml(fresh.config || {});
    btn.disabled = false; btn.innerHTML = orig;
    if (r && !r.ok) { alert(r.error || 'No se pudo actualizar.'); }
  });
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
      return `<tr><td data-label="Fecha">${when}</td><td data-label="Origen">${origin}</td><td data-label="Estado">${est}</td><td data-label="Cambios">${result}</td><td data-label="Duración" style="text-align:right">${dur}</td></tr>`;
    }).join('');
    return `<div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">Últimas ejecuciones</h3>
      <table class="cfg-cat-table tbl-cards"><thead><tr><th>Fecha</th><th>Origen</th><th>Estado</th><th>Cambios</th><th style="text-align:right">Duración</th></tr></thead><tbody>${rows}</tbody></table>
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
      <div class="head-actions"><button class="btn" id="syncLogBtn" title="Ver el registro completo de corridas">Registro</button><button class="btn btn-primary" id="syncBtn">${I.sync} Sincronizar ahora</button></div>
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

    <div id="payCfgCard"></div>

    <div id="rosterCfgCard">
    <div class="card">
      <div class="cfg-card-head"><h3 style="margin:0;font-size:15px">Personal de tiendas · ingresos y egresos</h3>
        <div class="head-actions"><button class="btn" id="rsLogBtn" title="Ver el registro completo de corridas">Registro</button><button class="btn" id="rsRunBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> Ejecutar ahora</button></div>
      </div>
      <p class="cfg-desc" style="margin:0 0 6px">Ingresa a los trabajadores nuevos y retira a los egresados de cada tienda, segun el sistema. <b>No modifica los datos de los que ya estan</b> (nombre, cargo, ficha: eso sigue manual). El maestro global nunca se toca: un egreso solo sale de la tienda y su historial se conserva.</p>
      <div id="rsLast" style="margin:0 0 12px"><span class="muted">Sin corridas todavía.</span></div>
      <p class="cfg-desc" style="margin:0 0 12px">Reglas de seguridad: egreso solo con fin de contrato explícito (nunca por ausencia) y si el sistema devuelve una lista sospechosamente corta, esa tienda se salta con alerta.</p>
      <div class="cfg-grid3">
        <div><label class="flabel">Estado</label>
          <select id="rsEnabled"><option value="0">Inactiva</option><option value="1">Activa</option></select></div>
        <div><label class="flabel">Frecuencia</label><select id="rsFreq"><option value="hourly">Cada hora</option><option value="6h">Cada 6 horas</option><option value="12h">Cada 12 horas</option><option value="daily">Una vez al día</option><option value="2d">Cada 2 días</option></select></div>
        <div id="rsHourWrap" style="display:none"><label class="flabel">Hora ancla (Caracas)</label><select id="rsHour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('')}</select>
          <p class="muted" style="font-size:11px;margin:6px 0 0">Diaria/2 días: corre a esta hora. Cada 6/12 h: corre en las horas alineadas al ancla (ej. 06 → 06, 12, 18, 00).</p></div>
        <div><label class="flabel">Reintento si falla <span class="muted">(minutos, 0 = no)</span></label>
          <input type="number" id="rsRetry" min="0" max="720" value="30" style="width:110px"></div>
      </div>
      <details style="margin-top:14px">
        <summary class="muted" style="cursor:pointer;font-size:12.5px">Opciones avanzadas</summary>
        <div style="margin-top:10px"><label class="flabel">URL del portal <span class="muted">(donde corre /api/sync-roster)</span></label>
          <input type="text" id="rsUrl" value="" placeholder="https://nominav2.pages.dev">
          <p class="muted" style="font-size:11.5px;margin:6px 0 0">El cron llama a esta URL. Si se deja vacío, usa el valor por defecto.</p></div>
      </details>
      <div class="cfg-foot"><span class="cfg-saved" id="rsSaved">✓ Guardado</span><button class="btn btn-primary" id="rsSave">Guardar programación</button></div>
      <div id="rsRuns" style="margin-top:14px"></div>
    </div></div>

    <div id="syncRuns">${runsHtml(cfgRes.runs)}</div>`;

  wireRunToggles();
  applySyncCooldown(cfg);

  /* ---- v4.56: tarjeta "Personal de tiendas · ingresos y egresos" ---- */
  (function initRosterCard() {
    const rsApi = (payload) => fetch('/api/sync-roster', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: user.id, ...payload }),
    }).then(x => x.json()).catch(() => null);
    const fmtDT = (iso) => {
      const d = new Date(iso); const p = n => String(n).padStart(2, '0');
      return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const paintLast = (c) => {
      const el = $('#rsLast'); if (!el) return;
      if (!c || !c.last_run_at) { el.innerHTML = '<span class="muted">Sin corridas todavía. Ejecuta una manual para probar (no modifica a nadie que ya esté).</span>'; return; }
      const s = c.last_summary || {};
      const okPill = c.last_status === 'ok'
        ? '<span class="pill pill-open">✅ OK</span>'
        : '<span class="pill" style="background:#fef2f2;color:#b91c1c">⚠ Error</span>';
      el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${okPill}<b>${fmtDT(c.last_run_at)}</b><span class="muted">${c.last_source === 'cron' ? 'automática' : 'manual'} · ${(((c.last_duration_ms || 0)) / 1000).toFixed(1)} s</span></div>`
        + `<div style="margin-top:8px">${s.stores != null ? s.stores : 0} tiendas revisadas · <b>${s.added || 0}</b> ingreso(s) · <b>${s.removed || 0}</b> egreso(s)`
        + `${s.alerts ? ` · <span style="color:#b45309">${s.alerts} con alerta</span>` : ''}${s.incomplete ? ' · <span style="color:#b45309">corrida parcial (continúa en la próxima)</span>' : ''}</div>`;
    };
    const paintRuns = (runs) => {
      const el = $('#rsRuns'); if (!el) return;
      if (!runs || !runs.length) { el.innerHTML = ''; return; }
      const rows = runs.map(g => {
        const det = (g.stores || []).map(st => st.skipped
          ? `<span title="${(st.alert || '').replace(/"/g, '&quot;')}" style="color:#b45309">${st.company_code} ⚠</span>`
          : `${st.company_code} ${st.added ? '+' + st.added : ''}${st.removed ? '−' + st.removed : ''}`
        ).join(' · ');
        return `<tr><td data-label="Fecha">${fmtDT(g.run_at)}</td>`
          + `<td data-label="Origen">${g.source === 'cron' ? 'Automática' : 'Manual'}</td>`
          + `<td data-label="Ingresos"><b>${g.added}</b></td>`
          + `<td data-label="Egresos"><b>${g.removed}</b></td>`
          + `<td data-label="Tiendas" style="font-size:12px;color:var(--muted)">${det || '—'}</td></tr>`;
      }).join('');
      el.innerHTML = `<h3 style="margin:0 0 10px;font-size:14px">Últimas corridas con movimiento</h3>`
        + `<table class="cfg-cat-table tbl-cards"><thead><tr><th>Fecha</th><th>Origen</th><th>Ingresos</th><th>Egresos</th><th>Tiendas</th></tr></thead><tbody>${rows}</tbody></table>`;
    };
    const rsHourVis = () => {
      const f = $('#rsFreq').value;
      $('#rsHourWrap').style.display = (f === 'hourly') ? 'none' : '';
    };
    async function loadRs() {
      const [c, r] = await Promise.all([rsApi({ action: 'get_config' }), rsApi({ action: 'runs' })]);
      const rc = c && c.config;
      if (rc) {
        $('#rsEnabled').value = rc.enabled ? '1' : '0';
        $('#rsFreq').value = rc.frequency || 'daily';
        $('#rsHour').value = String(rc.daily_hour != null ? rc.daily_hour : 6);
        $('#rsUrl').value = rc.endpoint_url || '';
        $('#rsRetry').value = String(rc.retry_minutes != null ? rc.retry_minutes : 30);
        paintLast(rc);
      }
      rsHourVis();
      if (r && r.ok) paintRuns(r.runs);
    }
    $('#rsFreq').addEventListener('change', rsHourVis);
    $('#rsSave').addEventListener('click', async () => {
      const b = $('#rsSave'); b.disabled = true;
      const r = await rsApi({
        action: 'save_config',
        config: {
          enabled: $('#rsEnabled').value === '1',
          frequency: $('#rsFreq').value,
          daily_hour: +$('#rsHour').value,
          retry_minutes: +$('#rsRetry').value,
          endpoint_url: $('#rsUrl').value.trim(),
        },
      });
      b.disabled = false;
      const chip = $('#rsSaved');
      if (chip && r && r.ok) { chip.classList.add('show'); setTimeout(() => chip.classList.remove('show'), 2000); }
    });
    $('#rsRunBtn').addEventListener('click', async () => {
      const b = $('#rsRunBtn'); b.disabled = true;
      const prev = b.innerHTML; b.textContent = 'Ejecutando…';
      const r = await rsApi({ source: 'manual' });
      b.disabled = false; b.innerHTML = prev;
      const el = $('#rsLast');
      if (!r || !r.ok) {
        if (el) el.innerHTML = `<span style="color:#b91c1c">⚠ ${(r && r.error) || 'No se pudo ejecutar.'}</span>`;
        return;
      }
      loadRs();
    });
    // v4.59: acceso al Registro de sincronizaciones (pagina unificada) con
    // el proceso de cada tarjeta preseleccionado.
    const lgR = $('#rsLogBtn');
    if (lgR) lgR.addEventListener('click', () => renderSyncLog(user, 'roster', 'sync'));
    const lgC = $('#syncLogBtn');
    if (lgC) lgC.addEventListener('click', () => renderSyncLog(user, 'companies', 'sync'));
    // payLogBtn se pinta DESPUES (renderPaySyncCard corre tras este bloque):
    // delegacion a nivel documento, registrada una sola vez.
    if (!window.__payLogNav) {
      window.__payLogNav = true;
      document.addEventListener('click', (ev) => {
        const b = ev.target && ev.target.closest && ev.target.closest('#payLogBtn');
        if (b) renderSyncLog(user, 'pay', 'sync');
      });
    }
    loadRs();
  })();
  // Tarjeta de programacion del Estado de pago (cron aparte, config propia).
  renderPaySyncCard(user);

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
  // Boton de Feriados: visible para todos. Superadmin gestiona; el resto solo
  // consulta (la sub-vista se abre en modo lectura).
  const ferBtn = `<button class="btn" id="pFeriados" title="Ver feriados nacionales y bancarios">${I.calendar || ''} Feriados</button>`;

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
        ${ferBtn}
        ${genBtn}
      </div>
    </div>
    <div class="tablebox scroll-x tbl-cards"><table><thead><tr>
      <th>Quincena</th><th>Período</th>
      <th class="grp grp-first">Código Pago</th><th class="grp grp-last">Rango de Pago</th>
      <th>Último día de cálculo</th><th>Día de Cálculo</th><th>Día de Pago</th>
      <th>Plazo Reclamo</th>
      <th>Tope de reporte</th><th>Estado</th>${isSuper ? '<th style="text-align:right">Acciones</th>' : ''}
    </tr></thead><tbody id="pBody"></tbody></table></div>
    <p class="muted" style="font-size:12px;margin:14px 2px 0;line-height:1.6">El “último día de cálculo” es la última fecha que entra en el cálculo de la quincena (un día antes del día de cálculo): última oportunidad para cargar novedades, ese día hasta la hora tope. Las dos columnas con fondo azul son el <strong>período de pago</strong>; su rango termina justo en el último día de cálculo. Sábados y domingos se resaltan en ámbar. La columna <strong>Plazo Reclamo</strong> es la ventana para reclamar un cálculo errado: va del Día de Pago a su cierre (ese número de días hábiles después, saltando fines de semana y feriados nacionales). El estado es temporal (Pasado / En curso / Futuro) y, si la quincena fue ajustada a mano, lleva además el distintivo <span class="pill pill-mod" style="font-size:10px">Modificada</span>. ${isSuper ? 'Como superadmin puedes ajustar una quincena puntual; el resto solo la consulta.' : 'Esta vista es de solo lectura.'}</p>`;

  const NCOLS = isSuper ? 11 : 10;

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
        <td class="code" data-label="Quincena">${p.name}</td>
        <td data-label="Período">${rangeCell(p.range_start, p.range_end)}</td>
        <td class="grp grp-first" data-label="Código Pago"><span class="pp-code">${p.pay_code || '—'}</span></td>
        <td class="grp grp-last" data-label="Rango de Pago">${rangeCell(p.pay_from, p.pay_to)}</td>
        <td class="hito-cell" data-label="Último día de cálculo">${dateCell(p.milestone_date)}</td>
        <td data-label="Día de Cálculo">${dateCell(p.cutoff_date, { countdown: isCurr ? countdown(p.cutoff_date, today) : '' })}</td>
        <td data-label="Día de Pago">${dateCell(p.pay_date, { countdown: isCurr ? countdown(p.pay_date, today) : '' })}</td>
        <td class="claim-cell" data-label="Plazo Reclamo">${p.claim_deadline ? rangeCell(p.pay_date, p.claim_deadline) : '<span class="muted">—</span>'}</td>
        <td data-label="Tope de reporte">${fmtDeadline(p.report_deadline)}</td>
        <td data-label="Estado">${periodEstado(p, rel)}</td>
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

  // Boton Feriados -> sub-vista (todos la ven; superadmin ademas gestiona).
  const fb = $('#pFeriados');
  if (fb) fb.addEventListener('click', () => viewHolidays(user));
}

/* ====================== SUB-VISTA: FERIADOS ======================
   Gestion de nomina_v2.feriado (solo superadmin). Se abre desde el boton
   "Feriados" de la vista Quincenas y la reemplaza; el boton "Volver"
   regresa a Quincenas. Lista con filtro Todos/Nacionales/Bancarios, alta y
   edicion via modal, y un boton "Sugerir" que pre-carga el anio con las
   fechas fijas + las moviles calculadas con el algoritmo de Pascua
   (Computus), sin dependencias externas. Los cambios sobre feriados
   nacionales recalculan el Plazo Reclamo en el backend. */

let HOL_YEAR = null;
let HOL_FILTER = 'all';

/* ---- Catalogo de ICONOS de feriado ----
   Cada icono es un SVG de trazo (neutro, hereda color). Se guarda en la BD el
   CODIGO corto (flag, cross, ...) y aqui se mapea a su SVG. Reutilizable por
   la tabla de Feriados, el selector del modal y la linea de tiempo. */
const HOL_ICONS = {
  flag:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22V4a1 1 0 0 1 1-1h13l-2.5 4L20 11H6"/></svg>',
  cross:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M8 7h8"/></svg>',
  crown:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3.5 3L12 5l5.5 6L21 8l-2 10H5L3 8z"/><path d="M5 18h14"/></svg>',
  pray:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v7"/><path d="M9 10c0-2 1.3-3 3-3s3 1 3 3v4a5 5 0 0 1-5 5H8l-3-3 3.5-3.5"/><path d="M9 10l-3.5 3.5"/></svg>',
  mask:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5s2 8 9 8 9-8 9-8c0 0-1 12-9 12S3 5 3 5z"/><circle cx="8.5" cy="8" r="1"/><circle cx="15.5" cy="8" r="1"/></svg>',
  tools:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0 5 5l-1.7 1.7 4 4a1.5 1.5 0 0 1-2 2l-4-4-1.7 1.7a4 4 0 0 0-5-5l1.7-1.7-4-4a1.5 1.5 0 0 1 2-2l4 4z"/></svg>',
  star:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.6L20 9.3l-4 4 1 6-5-2.8L7 19.3l1-6-4-4 5.4-.7z"/></svg>',
  tree:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l5 6h-3l4 5h-4l3 4H7l3-4H6l4-5H7l5-6z"/><path d="M12 18v3"/></svg>',
  sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/><path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14z"/></svg>',
};
// Etiqueta legible de cada icono (para el selector del modal).
const HOL_ICON_LABEL = {
  flag: 'Bandera (patrio)', cross: 'Cruz (Semana Santa)', crown: 'Corona (virgen)',
  pray: 'Manos (santo)', mask: 'Mascara (carnaval)', tools: 'Trabajo',
  star: 'Estrella (Reyes)', tree: 'Navidad', sparkles: 'Ano nuevo',
};
const HOL_ICON_ORDER = ['flag', 'cross', 'crown', 'pray', 'mask', 'tools', 'star', 'tree', 'sparkles'];

// SVG de un codigo de icono (o '' si no hay / no existe).
function holIconSvg(code) { return (code && HOL_ICONS[code]) ? HOL_ICONS[code] : ''; }

// Icono por DEFECTO segun el nombre del feriado. Se usa al "Sugerir feriados"
// y al generar un anio nuevo, para que cada feriado nazca con su icono (y asi
// "se lleve" el icono al anio siguiente sin copiar filas). Mismo mapeo que el
// backfill de la BD.
function holIconFor(nombre) {
  const s = String(nombre || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (s.includes('independencia') || s.includes('carabobo') || s.includes('libertador') || s.includes('resistencia indigena')) return 'flag';
  if (s.includes('jueves santo') || s.includes('viernes santo') || s.includes('corpus')) return 'cross';
  if (s.includes('divina pastora') || s.includes('coromoto') || s.includes('chiquinquira') || s.includes('inmaculada')) return 'crown';
  if (s.includes('san jose gregorio') || s.includes('san jose') || s.includes('san pedro')) return 'pray';
  if (s.includes('reyes')) return 'star';
  if (s.includes('carnaval')) return 'mask';
  if (s.includes('trabajador')) return 'tools';
  if (s.includes('navidad') || s.includes('nochebuena')) return 'tree';
  if (s.includes('ano nuevo') || s.includes('fin de ano')) return 'sparkles';
  return null;
}

async function holidaysApi(payload) {
  try {
    const r = await fetch('/api/holidays', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

/* ---- Computus (Meeus/Jones/Butcher): Domingo de Pascua gregoriana ----
   Sin dependencias. De la Pascua salen las moviles por desplazamiento. */
function holEaster(anio) {
  const a = anio % 19, b = Math.floor(anio / 100), c = anio % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(anio, mes - 1, dia));
}
function holAddDays(f, n) { const x = new Date(f); x.setUTCDate(x.getUTCDate() + n); return x; }
function holIso(f) { return f.toISOString().slice(0, 10); }

// Feriados FIJOS de Venezuela con sus flags Sudeban. [mesDia, nombre, nac, ban]
const HOL_FIJOS = [
  ['01-01', 'Año Nuevo', true, true],
  ['01-06', 'Día de Reyes', false, true],
  ['01-14', 'Día de la Divina Pastora', false, true],
  ['03-19', 'Día de San José', false, true],
  ['05-01', 'Día del Trabajador', true, true],
  ['06-24', 'Batalla de Carabobo', true, true],
  ['06-29', 'San Pedro y San Pablo', false, true],
  ['07-05', 'Día de la Independencia', true, true],
  ['07-24', 'Natalicio del Libertador', true, true],
  ['09-11', 'Virgen de Coromoto', false, true],
  ['10-12', 'Día de la Resistencia Indígena', true, true],
  ['10-26', 'San José Gregorio Hernández', false, true],
  ['11-18', 'Virgen de Chiquinquirá', false, true],
  ['12-08', 'Inmaculada Concepción', false, true],
  ['12-24', 'Nochebuena', false, true],
  ['12-25', 'Navidad', true, true],
  ['12-31', 'Fin de Año', false, true],
];

// Genera todos los feriados de un anio: fijos + moviles (Computus).
// Devuelve objetos {fecha, nombre, es_nacional, es_bancario, movil}.
function holGenerar(anio) {
  const out = HOL_FIJOS.map(([md, nombre, nac, ban]) =>
    ({ fecha: anio + '-' + md, nombre, es_nacional: nac, es_bancario: ban, movil: false, icono: holIconFor(nombre) }));
  const p = holEaster(anio);
  [
    [holAddDays(p, -48), 'Lunes de Carnaval', true, true],
    [holAddDays(p, -47), 'Martes de Carnaval', true, true],
    [holAddDays(p, -3), 'Jueves Santo', true, true],
    [holAddDays(p, -2), 'Viernes Santo', true, true],
    [holAddDays(p, 60), 'Corpus Christi', false, true],
  ].forEach(([f, nombre, nac, ban]) =>
    out.push({ fecha: holIso(f), nombre, es_nacional: nac, es_bancario: ban, movil: true, icono: holIconFor(nombre) }));
  out.sort((a, b) => a.fecha < b.fecha ? -1 : 1);
  return out;
}

const HOL_DOW = ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa'];
function holDow(iso) { const [y, m, d] = iso.split('-').map(Number); return HOL_DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; }
function holFmt(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`; }

// Modal de mensaje simple (reemplaza alert). Solo cierra con su boton Aceptar
// (openModal no cierra al hacer clic fuera). onOk opcional se corre al cerrar.
function holInfo(titulo, htmlMsg, onOk) {
  openModal(`
    <div class="modal-head"><span>${titulo}</span></div>
    <p style="font-size:13.5px;color:var(--ink-soft,#334155);margin:10px 0 0;line-height:1.55">${htmlMsg}</p>
    <div class="modal-actions">
      <button class="btn btn-primary" id="mOk">Aceptar</button>
    </div>`);
  $('#mOk').addEventListener('click', () => { closeModal(); if (onOk) onOk(); });
}

async function viewHolidays(user) {
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';

  const yd = await holidaysApi({ action: 'years' });
  const existing = (yd.ok && yd.years.length) ? yd.years.slice() : [];
  const thisYear = new Date().getFullYear();
  const years = [...new Set([...existing, thisYear, thisYear + 1])].sort();
  if (!HOL_YEAR || !years.includes(HOL_YEAR)) HOL_YEAR = existing.includes(thisYear) ? thisYear : (existing.length ? existing[existing.length - 1] : thisYear);

  $('#pnlMain').innerHTML = `
    <div class="pnl-head">
      <div><h1>Feriados</h1><p>Nacionales y bancarios${isSuper ? ' · gestión (solo superadmin)' : ' · consulta'}</p></div>
      <div class="pnl-filters" style="margin:0">
        <button class="btn" id="hBack">${I.chevronLeft || ''} Volver al calendario</button>
        <select id="hYear">${years.map(y => `<option ${y === HOL_YEAR ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <div class="chip-row" id="hFilter" style="margin:0">
          <button class="chip ${HOL_FILTER === 'all' ? 'on' : ''}" data-f="all">Todos</button>
          <button class="chip ${HOL_FILTER === 'nac' ? 'on' : ''}" data-f="nac">Nacionales</button>
          <button class="chip ${HOL_FILTER === 'ban' ? 'on' : ''}" data-f="ban">Bancarios</button>
        </div>
        ${isSuper ? `<button class="btn" id="hSuggest">${I.sparkles || ''} Sugerir feriados</button>
        <button class="btn btn-primary" id="hAdd">${I.plus} Agregar feriado</button>` : ''}
      </div>
    </div>
    <div class="tablebox scroll-x tbl-cards"><table><thead><tr>
      <th>Fecha</th><th>Nombre</th><th>Nacional</th><th>Bancario</th>
      <th>Ejecución bancaria</th><th>Móvil</th><th>Icono</th>${isSuper ? '<th style="text-align:right">Acciones</th>' : ''}
    </tr></thead><tbody id="hBody"></tbody></table></div>`;

  $('#hBack').addEventListener('click', () => viewPeriods(user));
  $('#hYear').addEventListener('change', (e) => { HOL_YEAR = parseInt(e.target.value, 10); loadHol(); });
  $('#hFilter').querySelectorAll('.chip').forEach(b =>
    b.addEventListener('click', () => { HOL_FILTER = b.dataset.f; $('#hFilter').querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b)); loadHol(); }));
  if (isSuper) {
    $('#hAdd').addEventListener('click', () => holEditModal(user, null));
    $('#hSuggest').addEventListener('click', () => holSuggest(user));
  }

  loadHol();

  async function loadHol() {
    const NC = isSuper ? 8 : 7;
    $('#hBody').innerHTML = `<tr><td colspan="${NC}" class="pnl-loading">Cargando…</td></tr>`;
    const d = await holidaysApi({ action: 'list', year: HOL_YEAR, filter: HOL_FILTER });
    if (!d.ok) { $('#hBody').innerHTML = `<tr><td colspan="${NC}" class="empty">Error: ${d.error}</td></tr>`; return; }
    const rows = d.holidays || [];
    if (!rows.length) {
      const msg = HOL_FILTER === 'nac' ? `Ningún feriado nacional en ${HOL_YEAR}.`
        : HOL_FILTER === 'ban' ? `Ningún feriado bancario en ${HOL_YEAR}.`
        : (isSuper ? `Este año aún no tiene feriados cargados. Usa “Sugerir feriados” para pre-cargarlos.`
                   : `Este año aún no tiene feriados cargados.`);
      $('#hBody').innerHTML = `<tr><td colspan="${NC}" class="empty">${msg}</td></tr>`;
      return;
    }
    $('#hBody').innerHTML = rows.map(f => `<tr>
      <td class="code" data-label="Fecha">${holFmt(f.fecha)} <span class="muted" style="font-size:11px">${holDow(f.fecha)}</span></td>
      <td data-label="Nombre">${f.nombre}</td>
      <td data-label="Nacional">${f.es_nacional ? '<span class="pill" style="background:#dbeafe;color:#1e40af">Nacional</span>' : '<span class="muted">—</span>'}</td>
      <td data-label="Bancario">${f.es_bancario ? '<span class="pill" style="background:#f1f5f9;color:#475569">Bancario</span>' : '<span class="muted">—</span>'}</td>
      <td data-label="Ejecución bancaria">${f.fecha_ejecucion ? `<span class="muted">${holFmt(f.fecha_ejecucion)}</span>` : '<span class="muted">—</span>'}</td>
      <td data-label="Móvil">${f.movil ? '<span class="pill" style="background:#f3e8ff;color:#7c3aed">Móvil</span>' : '<span class="muted">—</span>'}</td>
      <td data-label="Icono">${f.icono && HOL_ICONS[f.icono] ? `<span title="${HOL_ICON_LABEL[f.icono] || f.icono}" style="display:inline-flex;width:20px;height:20px;color:var(--ink,#1e293b)">${HOL_ICONS[f.icono]}</span>` : '<span class="muted">—</span>'}</td>
      ${isSuper ? `<td data-label="Acciones" style="text-align:right;white-space:nowrap">
        <button class="btn btn-mini" data-hedit="${f.id}">Editar</button>
        <button class="btn btn-mini" data-hdel="${f.id}" data-hnom="${(f.nombre || '').replace(/"/g, '&quot;')}" data-hnac="${f.es_nacional ? 1 : 0}" data-hfec="${f.fecha}">Eliminar</button>
      </td>` : ''}
    </tr>`).join('');
    if (isSuper) {
      $('#hBody').querySelectorAll('[data-hedit]').forEach(b =>
        b.addEventListener('click', () => { const f = rows.find(x => String(x.id) === b.dataset.hedit); holEditModal(user, f); }));
      $('#hBody').querySelectorAll('[data-hdel]').forEach(b =>
        b.addEventListener('click', () => holDelete(user, b.dataset.hdel, b.dataset.hnom, b.dataset.hnac === '1', b.dataset.hfec)));
    }
  }

  // Expone loadHol para que los modales refresquen tras guardar.
  viewHolidays._reload = loadHol;
}

// Modal de alta/edicion de un feriado. f=null para alta.
function holEditModal(user, f) {
  const isEdit = !!f;
  openModal(`
    <div class="modal-head"><span>${isEdit ? 'Editar' : 'Agregar'} feriado</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 14px">Los campos nacional/bancario definen cómo afecta a los cálculos.</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><label class="flabel">Fecha</label><input type="date" id="hFecha" value="${isEdit ? f.fecha : ''}"></div>
      <div><label class="flabel">Ejecución bancaria <span class="muted">(opcional)</span></label><input type="date" id="hEjec" value="${isEdit && f.fecha_ejecucion ? f.fecha_ejecucion : ''}"></div>
    </div>
    <label class="flabel" style="margin-top:12px">Nombre</label>
    <input type="text" id="hNombre" value="${isEdit ? (f.nombre || '').replace(/"/g, '&quot;') : ''}" placeholder="ej. Día de la Independencia">
    <div style="display:flex;gap:20px;margin-top:14px">
      <label class="flabel" style="display:flex;align-items:center;gap:7px;margin:0"><input type="checkbox" id="hNac" ${isEdit && f.es_nacional ? 'checked' : ''}> Nacional</label>
      <label class="flabel" style="display:flex;align-items:center;gap:7px;margin:0"><input type="checkbox" id="hBan" ${isEdit && f.es_bancario ? 'checked' : ''}> Bancario</label>
      <label class="flabel" style="display:flex;align-items:center;gap:7px;margin:0"><input type="checkbox" id="hMov" ${isEdit && f.movil ? 'checked' : ''}> Móvil</label>
    </div>
    <label class="flabel" style="margin-top:14px">Icono <span class="muted">(para el calendario y la línea de tiempo)</span></label>
    <div id="hIconPick" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
      <button type="button" class="hicon" data-ic="" title="Sin icono" style="width:38px;height:38px;border:1px solid var(--border);border-radius:9px;background:var(--surface);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted,#94a3b8);font-size:11px">—</button>
      ${HOL_ICON_ORDER.map(code => `<button type="button" class="hicon" data-ic="${code}" title="${HOL_ICON_LABEL[code]}" style="width:38px;height:38px;border:1px solid var(--border);border-radius:9px;background:var(--surface);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ink,#1e293b)"><span style="width:20px;height:20px;display:inline-flex">${HOL_ICONS[code]}</span></button>`).join('')}
    </div>
    <div class="modal-actions">
      <span id="hErr" style="flex:1;color:var(--danger,#dc2626);font-size:12.5px;line-height:1.4;text-align:left"></span>
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Guardar</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  // Selector de icono: estado + resaltado. En edicion preselecciona el icono
  // guardado; en alta arranca vacio y auto-sugiere segun el nombre (sin pisar
  // una eleccion manual del usuario).
  let selectedIcon = isEdit ? (f.icono || '') : '';
  let iconTouched = false;
  const paintIconPick = () => {
    const wrap = $('#hIconPick'); if (!wrap) return;
    wrap.querySelectorAll('.hicon').forEach(b => {
      const on = (b.dataset.ic || '') === (selectedIcon || '');
      b.style.borderColor = on ? 'var(--brand,#2563eb)' : 'var(--border)';
      b.style.boxShadow = on ? '0 0 0 2px rgba(37,99,235,.18)' : 'none';
      b.style.background = on ? 'var(--brand-bg,#eff6ff)' : 'var(--surface)';
    });
  };
  const iconWrap = $('#hIconPick');
  if (iconWrap) iconWrap.querySelectorAll('.hicon').forEach(b =>
    b.addEventListener('click', () => { selectedIcon = b.dataset.ic || ''; iconTouched = true; paintIconPick(); }));
  // Auto-sugerencia por nombre (solo si el usuario no eligio icono a mano).
  const nomEl = $('#hNombre');
  if (nomEl) nomEl.addEventListener('input', () => {
    if (iconTouched) return;
    const sug = holIconFor(nomEl.value);
    selectedIcon = sug || '';
    paintIconPick();
  });
  paintIconPick();
  $('#mOk').addEventListener('click', async () => {
    const payload = {
      action: isEdit ? 'update' : 'create', adminId: user.id,
      fecha: $('#hFecha').value, fecha_ejecucion: $('#hEjec').value || null,
      nombre: $('#hNombre').value, es_nacional: $('#hNac').checked,
      es_bancario: $('#hBan').checked, movil: $('#hMov').checked,
      icono: selectedIcon || null,
    };
    if (isEdit) payload.id = f.id;
    const err = $('#hErr');
    if (!payload.fecha || !payload.nombre.trim()) { if (err) err.textContent = 'La fecha y el nombre son obligatorios.'; return; }
    if (err) err.textContent = '';
    const btn = $('#mOk'); btn.disabled = true; btn.textContent = 'Guardando…';
    const d = await holidaysApi(payload);
    if (!d.ok) { if (err) err.textContent = d.error || 'No se pudo guardar.'; btn.disabled = false; btn.textContent = 'Guardar'; return; }
    closeModal();
    if (viewHolidays._reload) viewHolidays._reload();
  });
}

// Confirmacion de borrado (modal, cierra solo con boton).
function holDelete(user, id, nombre, esNac, fecha) {
  openModal(`
    <div class="modal-head"><span>Eliminar feriado</span></div>
    <p style="font-size:13.5px;color:var(--ink-soft,#334155);margin:10px 0 0;line-height:1.55">Vas a eliminar <b>“${nombre}”</b> (${holFmt(fecha)}).${esNac ? '<br><br>Es un feriado <b>nacional</b>: al eliminarlo se recalculará el Plazo Reclamo de las quincenas afectadas.' : ''}<br><br>¿Continuar?</p>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-ghost-danger" id="mOk">Eliminar</button>
    </div>`);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const btn = $('#mOk'); btn.disabled = true; btn.textContent = 'Eliminando…';
    const d = await holidaysApi({ action: 'delete', adminId: user.id, id });
    if (!d.ok) { holInfo('No se pudo eliminar', d.error || 'Ocurrió un error al eliminar el feriado.'); return; }
    closeModal();
    if (viewHolidays._reload) viewHolidays._reload();
  });
}

// "Sugerir feriados": pre-carga el anio con fijos + moviles (Computus). Solo
// agrega los que faltan (por fecha+nombre); nunca pisa los existentes. Cada
// alta va por el endpoint create. Los flags vienen prellenados segun Sudeban;
// el superadmin los revisa y completa los lunes bancarios a mano.
function holSuggest(user) {
  const anio = HOL_YEAR;
  openModal(`
    <div class="modal-head"><span>Sugerir feriados de ${anio}</span></div>
    <p style="font-size:13px;color:var(--ink-soft,#334155);margin:10px 0 0;line-height:1.55">Se completarán los feriados que <b>falten</b> en ${anio}: los <b>fijos</b> de Venezuela y los <b>móviles</b> (Carnaval, Semana Santa y Corpus) calculados con el algoritmo de Pascua gregoriana. No se toca ningún feriado ya cargado.<br><br>Los flags <b>nacional/bancario</b> vienen prellenados según Sudeban; revísalos y completa a mano los <b>lunes bancarios</b> (fecha de ejecución).</p>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Completar faltantes</button>
    </div>`);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const btn = $('#mOk'); btn.disabled = true; btn.textContent = 'Cargando…';
    // Traer lo existente para no duplicar.
    const cur = await holidaysApi({ action: 'list', year: anio, filter: 'all' });
    const have = new Set(((cur.ok && cur.holidays) || []).map(h => h.fecha + '|' + h.nombre));
    const props = holGenerar(anio).filter(h => !have.has(h.fecha + '|' + h.nombre));
    let added = 0, failed = 0, lastErr = '';
    for (const h of props) {
      const d = await holidaysApi({ action: 'create', adminId: user.id, ...h, fecha_ejecucion: null });
      if (d.ok) added++; else { failed++; lastErr = d.error || lastErr; }
    }
    closeModal();
    if (viewHolidays._reload) viewHolidays._reload();
    // Tres casos: nada que agregar / se agregaron (quiza con fallos) / todos fallaron.
    if (props.length === 0) {
      holInfo('Sin cambios', `El año ${anio} ya tiene todos los feriados fijos y móviles cargados.`);
    } else if (added === 0) {
      holInfo('No se pudieron agregar', `Ninguno de los ${failed} feriados se pudo crear.${lastErr ? `<br><br><span style="color:var(--danger,#dc2626)">${lastErr}</span>` : ''}`);
    } else {
      holInfo('Feriados agregados', `Se agregaron <b>${added}</b> feriados a ${anio}${failed ? ` (${failed} no se pudieron crear).` : '.'} Revisa los flags y completa a mano los lunes bancarios (fecha de ejecución).`);
    }
  });
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
      'Plazo Reclamo': p.claim_deadline ? (fmtDate(p.pay_date, true) + ' - ' + fmtDate(p.claim_deadline, true)) : '',
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
      <div><label class="flabel">Plazo reclamo <span class="muted">(días hábiles)</span></label><input type="text" id="pe_cd" value="${p.claim_days != null ? p.claim_days : ''}" placeholder="5"></div>
    </div>
    <label class="flabel" style="margin-top:12px">Motivo del ajuste <span class="muted">(opcional)</span></label>
    <input type="text" id="pe_note" value="${(p.override_note||'').replace(/"/g,'&quot;')}" placeholder="ej. corrida por feriado" style="margin-bottom:6px">
    <p class="muted" style="font-size:11.5px;margin:0">El último día de cálculo y el tope de reporte se recalculan solos a partir del día de cálculo, el margen y la hora. El <b>Plazo Reclamo</b> se recalcula desde el Día de Pago contando ese número de días hábiles (salta fines de semana y feriados nacionales).</p>
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
      claim_days: $('#pe_cd').value,
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
        <button class="cfg-side-item" data-tab="constancias"><span class="cfg-side-ic">📄</span> Constancias</button>
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
  else if (CFG_TAB === 'constancias') cfgRenderConstancias(user, body);
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

/* ===== Pestana CONSTANCIAS (valores por defecto del PDF) ===== */
function cfgRenderConstancias(user, body) {
  const grupo = CFG_DATA.settings.filter(s => s.grupo === 'Constancias');
  body.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3>Constancias de trabajo</h3><span class="cfg-saved" id="savedCert">✓ Guardado</span></div>
      <p class="cfg-desc" style="margin:0 0 8px">Valores por defecto que se precargan al crear una constancia. El <b>salario</b> se expresa en bolívares (VES) y el <b>cesta ticket</b> en dólares (USD); ambos son editables por solicitud antes de emitir el PDF.</p>
      <div id="certFields">${grupo.length ? grupo.map(cfgFieldRow).join('') : '<p class="muted" style="margin:0">No hay parámetros de constancias configurados.</p>'}</div>
      <div class="cfg-foot"><button class="btn btn-primary" id="saveCert">Guardar cambios</button></div>
    </div>`;
  const btn = $('#saveCert');
  if (btn) btn.addEventListener('click', () =>
    cfgSaveSection(user, $('#certFields'), $('#savedCert'), $('#saveCert')));
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
      <td data-label="Tipo"><b>${t.label}</b></td>
      <td data-label="Cód. AX"><span class="pill pill-ax">${t.ax_code}</span></td>
      <td data-label="Atrás">${atras}</td><td data-label="Futuro">${fut}</td>
      <td data-label="Documento">${doc}</td><td data-label="Exigencia">${enf}</td><td data-label="Estado">${estado}</td>
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
      <table class="cfg-cat-table tbl-cards"><thead><tr>
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
      <td data-label="#" style="font-family:monospace;color:var(--muted)">${i + 1}</td>
      <td data-label="Causa"><b>${c.label}</b><br><span class="muted" style="font-size:11px;font-family:monospace">${c.code}</span></td>
      <td data-label="Tipo">${tipo}</td><td data-label="Estado">${estado}</td>
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
      <table class="cfg-cat-table tbl-cards"><thead><tr>
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
      <td data-label="#" style="font-family:monospace;color:var(--muted)">${i + 1}</td>
      <td data-label="Motivo"><b>${r.label}</b><br><span class="muted" style="font-size:11px;font-family:monospace">${r.code}</span></td>
      <td data-label="Tipo">${tipo}</td><td data-label="Estado">${estado}</td>
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
      <table class="cfg-cat-table tbl-cards"><thead><tr>
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
      <td data-label="Cargo"><b>${c.label}</b><br><span class="muted" style="font-size:11px;font-family:monospace">${c.code}</span></td>
      <td data-label="Cód. plantilla"><span class="pill pill-ax">${c.ax_code}</span></td>
      <td data-label="Responsable">${resp}</td><td data-label="En ingreso">${ing}</td>
      <td data-label="Patrones" style="font-size:11.5px;color:var(--muted)">${pats}</td>
      <td data-label="Estado">${estado}</td>
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
      <table class="cfg-cat-table tbl-cards"><thead><tr>
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
      <td data-label="Prefijo" style="font-family:monospace;font-weight:600">${b.code}</td>
      <td data-label="Banco"><b>${b.name}</b></td>
      <td data-label="Estado">${estado}</td>
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
      <table class="cfg-cat-table tbl-cards"><thead><tr>
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
      <td data-label="Prefijo" style="font-family:monospace;font-weight:600">${o.code}</td>
      <td data-label="Operadora"><b>${o.name}</b></td>
      <td data-label="Estado">${estado}</td>
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
      <table class="cfg-cat-table tbl-cards"><thead><tr>
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
      <td data-label="Documento"><b>${d.name}</b>${d.note ? `<br><span class="muted" style="font-size:11px">${d.note}</span>` : ''}</td>
      <td data-label="Exigencia">${enfPill(d.enforcement)}</td>
      <td data-label="Estado">${estado}</td>
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
      <table class="cfg-cat-table tbl-cards"><thead><tr>
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

/* ---------- Guardian del boton Atras del navegador ----------
   El portal es un SPA: sin esto, dar "Atras" en el navegador SALE del portal
   (vuelve al login o a la pagina previa) porque las vistas cambian sin tocar
   el historial. Con el guardian, cada navegacion empuja una entrada al
   historial y el boton Atras funciona como "volver a la vista anterior DENTRO
   del portal". En la vista raiz, Atras no hace nada (se repone la trampa).
   VIEW_STACK guarda el recorrido de vistas para saber a cual volver.

   INTERCEPTORES: componentes con navegacion interna (el wizard con sus pasos,
   una sub-vista, un modal) pueden registrar una funcion con pushBackInterceptor.
   Al dar Atras, el guardian consulta el ULTIMO interceptor: si devuelve true,
   el back se "consumio" adentro (p.ej. retrocedio un paso) y NO se cambia de
   vista; si devuelve false, el interceptor ya no aplica (se descarta) y el
   back sigue su curso normal (volver a la vista anterior del portal). */
let VIEW_STACK = [];
let NAV_USER = null;
let BACK_GUARD_ON = false;
let BACK_INTERCEPTORS = [];

/* Registra un interceptor de back. Devuelve una funcion para quitarlo (que el
   componente debe llamar al desmontarse / salir). fn() debe devolver true si
   consumio el back, false si ya no aplica. */
function pushBackInterceptor(fn) {
  BACK_INTERCEPTORS.push(fn);
  // Aseguramos una entrada extra en el historial para "tener con que" consumir
  // el primer Atras dentro del componente sin salir de la vista.
  if (BACK_GUARD_ON) { try { history.pushState({ gcTrap: true }, '', location.href); } catch (_) {} }
  return function removeInterceptor() {
    const i = BACK_INTERCEPTORS.indexOf(fn);
    if (i !== -1) BACK_INTERCEPTORS.splice(i, 1);
  };
}

function installBackGuard(user) {
  if (BACK_GUARD_ON) return;
  BACK_GUARD_ON = true;
  NAV_USER = user;
  // Conectar el bus de back-nav: los componentes (wizard, etc.) registran sus
  // interceptores via core/back-nav.js sin depender de este modulo.
  registerBackHandler(pushBackInterceptor);
  // Entrada base (trampa): asegura que siempre haya algo que "consumir" al dar
  // Atras estando en la raiz, sin salir del portal.
  try { history.replaceState({ gcView: currentView, root: true }, '', location.href); } catch (_) {}
  window.addEventListener('popstate', () => {
    // 1) Si hay un interceptor activo, dejarlo intentar consumir el back.
    if (BACK_INTERCEPTORS.length) {
      const top = BACK_INTERCEPTORS[BACK_INTERCEPTORS.length - 1];
      let consumed = false;
      try { consumed = !!top(); } catch (_) { consumed = false; }
      if (consumed) {
        // Reponer la entrada para que el proximo Atras vuelva a entrar aqui.
        try { history.pushState({ gcTrap: true }, '', location.href); } catch (_) {}
        return;
      }
      // El interceptor ya no aplica (p.ej. wizard en el paso 1): descartarlo y
      // seguir con la navegacion normal de vistas.
      BACK_INTERCEPTORS.pop();
    }
    // 2) Navegacion normal por vistas del portal.
    if (VIEW_STACK.length > 1) {
      VIEW_STACK.pop();                     // descartar la actual
      const prev = VIEW_STACK[VIEW_STACK.length - 1];
      navigate(prev, NAV_USER, true);       // fromHistory: no re-empuja
    } else {
      // Estamos en la raiz: reponer una entrada para que el proximo Atras
      // tampoco salga. La vista no cambia.
      try { history.pushState({ gcView: currentView, root: true }, '', location.href); } catch (_) {}
    }
  });
}

async function navigate(view, user, fromHistory = false) {
  NAV_USER = user;
  // Al cambiar de vista por el menu, se abandonan los interceptores activos
  // (p.ej. el wizard): dejan de tener sentido.
  if (!fromHistory) BACK_INTERCEPTORS = [];
  // Mantener el stack y el historial del navegador sincronizados. Si venimos
  // del boton Atras (fromHistory) NO empujamos (ya lo maneja el guardian).
  if (!fromHistory) {
    if (VIEW_STACK[VIEW_STACK.length - 1] !== view) {
      VIEW_STACK.push(view);
      if (BACK_GUARD_ON) {
        try { history.pushState({ gcView: view }, '', location.href); } catch (_) {}
      }
    }
  }
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
  else if (view === 'equipo') { await ensureAdminRoles(user); viewEquipo(user); }
  else if (view === 'permisos') viewPermisos(user);
  else if (view === 'firmantes') renderCertSigners(user);
  else if (view === 'constancias') renderCertRequests(user);
  else if (view === 'sync') viewSync(user);
  else if (view === 'syncreview') renderAxReview(user);
  else if (view === 'axcompare') renderAxCompare(user);
  else if (view === 'axhistory') renderAxHistory(user);
  else if (view === 'erpquery') renderErpQuery(user);
  else if (view === 'synclog') renderSyncLog(user);
  else if (view === 'resetdata') renderResetData(user);
  else if (view === 'roles') renderRoles(user);
  else if (view === 'rostersync') viewRosterSync(user);
  else if (view === 'config') viewConfig(user);
  else if (view === 'historial') renderHistory(user);
  else if (view === 'estadisticas') renderReportStats(user);
  else if (view === 'reportempresas') renderCompanyReports(user);
  else if (view === 'estadopago') renderPayGrid(user);
  else if (view === 'misstats') renderMyStats(user);
  else if (view === 'avisos') renderAvisos(user, { mode: 'inbox' });
  else if (view === 'avisosconfig') renderAvisos(user, { mode: 'config' });
  else if (view === 'egmotivos') renderEgressRatify(user);
  else if (view === 'buscar') renderPersonnelSearch(user);
  else if (view === 'datosincompletos') renderPersonnelIncomplete(user);
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

/* ---------- Cajon movil (<=768px) ----------
   En movil el sidebar es un cajon deslizante que reutiliza la clase
   .hidden-nav. Diferencias respecto al escritorio:
     - Arranca OCULTO (en escritorio arranca visible).
     - Al abrir se muestra un backdrop oscuro; tocarlo (o elegir un item del
       menu) lo cierra.
     - body.nav-open refleja el estado ABIERTO para que el CSS pinte el
       backdrop (el cajon en si lo maneja .hidden-nav sobre .pnl-layout).
   Todo se activa solo bajo el media query; en escritorio esta funcion deja
   el layout intacto (visible, sin backdrop). */
const MOBILE_MQ = '(max-width:768px)';
function setupMobileDrawer(layout) {
  if (!layout) return;
  const mq = window.matchMedia(MOBILE_MQ);

  // Backdrop (hermano del layout, en el body). Se crea una sola vez.
  let backdrop = document.getElementById('pnlBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'pnlBackdrop';
    document.body.appendChild(backdrop);
  }

  const isOpen = () => !layout.classList.contains('hidden-nav');
  // Sincroniza body.nav-open (para el CSS del backdrop) con el estado real.
  const syncOpenClass = () => document.body.classList.toggle('nav-open', mq.matches && isOpen());
  const closeDrawer = () => { layout.classList.add('hidden-nav'); syncOpenClass(); };

  // Estado inicial segun el ancho: movil -> oculto; escritorio -> visible.
  const applyMode = () => {
    if (mq.matches) layout.classList.add('hidden-nav');   // movil: cajon cerrado
    else layout.classList.remove('hidden-nav', 'rail');   // escritorio: menu normal
    syncOpenClass();
  };
  applyMode();

  // Cambios de tamano (girar el telefono, redimensionar): re-aplicar modo.
  if (mq.addEventListener) mq.addEventListener('change', applyMode);
  else if (mq.addListener) mq.addListener(applyMode);   // Safari viejo

  // El hamburguesa/reopen ya togglean .hidden-nav; enganchamos el sync del
  // backdrop despues de ellos (capturamos en el propio boton).
  const ham = document.getElementById('pnlHam');
  const reopen = document.getElementById('pnlReopen');
  if (ham) ham.addEventListener('click', () => setTimeout(syncOpenClass, 0));
  if (reopen) reopen.addEventListener('click', () => setTimeout(syncOpenClass, 0));

  // Tocar el backdrop cierra el cajon.
  backdrop.addEventListener('click', closeDrawer);

  // Elegir un item del menu cierra el cajon (solo en movil).
  const nav = document.getElementById('pnlNav');
  if (nav) nav.addEventListener('click', (e) => {
    if (mq.matches && e.target.closest('button[data-view]')) closeDrawer();
  });
}

export function renderPanel() {
  const user = getSession();
  if (!user) { go('/login'); return; }
  // Limpiar estado en memoria de cualquier sesión previa (evita que datos
  // de un usuario anterior "se filtren" si se cambia de sesión sin recargar).
  CATALOG = null; CU_ROWS = null; SCOPE = null; USERS_USER = null; TIENDAS_FILTERS = null; currentView = 'dashboard';
  mount(shell(user));
  loadAvatar((user.email || '').trim().toLowerCase());
  // v4.64: menu por permisos (grupo Sincronizacion). Los items adminonly se
  // pintan y luego se PODAN segun la matriz de Roles del propio usuario
  // (permisos view.* enforced, consultados via /api/my-perms). Superadmin
  // no consulta: ve todo. Si la consulta falla, el menu queda como esta y
  // los endpoints gatean igual (defensa en profundidad).
  (async function applySyncMenuPerms() {
    if (!(user.kind === 'admin' && user.role !== 'superadmin')) return;
    const MAP = { syncreview: 'view.syncreview', axcompare: 'view.axcompare', axhistory: 'view.axhistory', synclog: 'view.synclog', erpquery: 'view.erpquery' };
    try {
      const r = await fetch('/api/my-perms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null }, codes: Object.values(MAP) }),
      }).then(x => x.json());
      if (!r || !r.ok || r.super) return;
      let group = null;
      Object.entries(MAP).forEach(([view, code]) => {
        if (r.perms && r.perms[code]) return;
        const btn = document.querySelector(`#pnlNav [data-view="${view}"]`) || document.querySelector(`.pnl-side [data-view="${view}"]`);
        if (btn) { btn.style.display = 'none'; group = btn.closest('.nav-group') || group; }
      });
      if (group) {
        const anyVisible = [...group.querySelectorAll('button[data-view]')].some(b => b.style.display !== 'none');
        if (!anyVisible) group.style.display = 'none';
      }
    } catch (_) { /* sin cambios en el menu */ }
  })();
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
  // --- Cajon movil (<=768px) ---
  // En movil el sidebar es un cajon off-canvas: reutiliza la clase
  // .hidden-nav (misma que el hamburguesa) pero ARRANCA oculto y muestra un
  // backdrop al abrir. body.nav-open refleja el estado "abierto" para el CSS.
  setupMobileDrawer(layout);
  // Campanita de novedades (solo admins; si no existe el boton, no hace nada).
  initBell(user);
  // Guardian del boton Atras: convierte el Atras del navegador en "volver a la
  // vista anterior dentro del portal" y evita salirse de la pagina por error.
  VIEW_STACK = [];
  installBackGuard(user);
  // Landing unificado: ambos arrancan en el Dashboard (Inicio).
  navigate('dashboard', user);
}
