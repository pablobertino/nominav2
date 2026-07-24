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
import { renderDoubleEmployment } from './double-employment.js';
import { renderNoRehire, mountNoRehireConfigCard } from './no-rehire.js';
import { renderNoRehireVerify } from './no-rehire-verify.js';
import { renderMovements } from './movements.js';
import { renderMovQuincena } from './mov-quincena.js';
import { renderCambioCargo, renderCambioCargoHist } from './cambio-cargo.js';
import { renderPersonnelDocs } from './personnel-docs.js';
import { renderDepartmentCargos } from './department-cargos.js';
import { renderCertSigners } from './cert-signers.js';
import { renderCertRequests } from './cert-requests.js';
import { renderAxReview, renderAxCompare, renderAxHistory } from './ax-review.js';
import { renderBankStats } from './bank-stats.js';
import { renderBankAccounts } from './bank-accounts.js';
import { renderScopeOverridesEditor, decorateScovBadges, countScovOverrides } from './scope-overrides.js';
import { renderWaSend } from './wa-send.js';
import { renderWaGroups } from './wa-groups.js';
import { renderWaTemplates } from './wa-templates.js';
import { renderWaPolls } from './wa-polls.js';
import { renderWaHistory } from './wa-history.js';
import { renderErpQuery } from './erp-query.js';
import { renderSyncLog, renderSyncRun } from './sync-log.js';
import { renderSyncPending } from './sync-pending.js';   // v5.40
import { renderResetData } from './reset-data.js';
import { renderRoles } from './roles.js';
import { injectPeriodTimeline } from './period-timeline.js';
import { renderPayGrid } from './pay-grid.js';
import { renderDepartments } from './departments.js';
/* v5.39: se quito el import de roster-ax.js. El boton "Sincronizar personal"
   dejo de usar /api/ax-roster (el motor que pisaba datos y descartaba los
   cambios pendientes) y ahora llama a /api/sync-roster, el mismo motor que la
   sincronizacion automatica. Con eso quedaron sin uso `axRosterPull` y
   `rosterCooldownMessage` (sync-roster no tiene cooldown por empresa). */

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
  // v5.16: triangulo de alerta (vista Doble empleo).
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  // v5.73: persona tachada (vista No reempleables).
  userx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="8" x2="22" y2="13"/><line x1="22" y1="8" x2="17" y2="13"/></svg>',
  // v5.79: persona con visto (vista Verificar candidato).
  usercheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>',
  // v5.93: flechas ida/vuelta (vista Movimientos).
  moves: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>',
  // v6.37: persona con flecha (vista Movimientos de la quincena).
  movesq: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M15 11h7"/><path d="m19 7 3 4-3 4"/></svg>',
  // Cambio de Cargo: flechas arriba/abajo (ascenso/descenso).
  updown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v18"/><path d="m3 7 4-4 4 4"/><path d="M17 21V3"/><path d="m21 17-4 4-4-4"/></svg>',
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
    // v5.16: Doble empleo. El badge con el numero de casos lo inyecta
    // paintDoubleEmpBadge() al cargar el panel (solo si hay casos).
    ['dobleempleo', I.alert, 'Doble empleo'],
    // v5.73: No reempleables. OJO §4 del resumen: agregar el item ACA no
    // alcanza para editor/gestor — cada rol tiene SU array (abajo).
    ['norehire', I.userx, 'No reempleables'],
    ['norehirecheck', I.usercheck, 'Verificar candidato'],
    // v5.93: Movimientos del periodo (ingresos/egresos/traslados/cambios de
    // cargo), derivados de los cortes quincenales. Permiso propio
    // view.movimientos, gobernable desde Roles.
    // v6.36: etiqueta renombrada a "Rotacion" (la clave interna NO cambia).
    // "Movimientos" pasa a ser la futura vista operativa de quincena.
    ['movimientos', I.moves, 'Rotación'],
    // v6.37: Movimientos de la quincena (vista operativa: ingresados,
    // trasladados, egresados y cambios de cargo con fichas). Permiso propio
    // view.movquincena, gobernable desde Roles. Fuente: roster vivo (RPC
    // get_quincena_moves), NO los cortes de snapshot de Rotacion.
    ['movquincena', I.movesq, 'Movimientos'],
    ['egmotivos', I.check, 'Ratificar egresos'],
    ['rostersync', I.sync, 'Carga de personal'],
  ] },
  // Cargos: consola de escritura (ascensos/descensos/traslados/egresos) con
  // circuito sugerir->aprobar->exportar plantilla AX. Dos pantallas SEPARADAS:
  // el wizard (cambiocargo) y el Historial (cargohistorial). Ambas gobernadas
  // por view.cambiocargo (gerente_zona + supervisor_tiendas + admin).
  { title: 'Cargos', items: [
    ['cambiocargo', I.updown, 'Cambio de Cargo'],
    ['cargohistorial', I.history, 'Pendientes'],
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
  /* v5.48 — EL MENU MUESTRA DE DONDE SALE CADA COSA.

     El problema (Pablo, 2026-07-14): "al ver el Pendiente no lo relacionamos
     con la ultima sincronizacion tan intuitivamente". Y tenia razon: la pagina
     aparecia con 5 casos adentro y nada decia quien los puso ahi. El menu los
     listaba uno al lado del otro:

         Pendientes  ①      <- lo que quedo por decidir
         Comparar           <- otra cosa (consulta manual)
         Registro           <- que paso en la corrida

     Pendientes y Registro son LAS DOS MITADES DE LA MISMA CORRIDA, y el menu
     los presentaba como hermanos sin relacion, con Comparar metido en el medio.

     Ahora la INDENTACION hace el trabajo que ninguna etiqueta hacia bien:

         SINCRONIZACION
           ─ CORRIDA AUTOMATICA
             Última corrida            <- el hecho
               └ Diferencias  ①        <- lo que dejo por decidir
             Configurar                <- lo que la gobierna
           ─ ENVIAR AL SISTEMA
             Publicar  ⑪
             Historial de envios
           ─ HERRAMIENTAS
             Comparar
             Consultar API

     Tres cambios, cada uno con su razon:

     1. `Diferencias` CUELGA de `Ultima corrida`. Se lee que una sale de la
        otra. El item lleva el prefijo '>' para indentarse.

     2. `Configurar` se muda a CORRIDA AUTOMATICA. Es lo que gobierna esa
        corrida (cada cuanto arranca), no una herramienta suelta. Estaba en
        HERRAMIENTAS, lejos de lo que configura.

     3. `Historial` pasa a `Historial de envios`. Antes se llamaba igual de
        parecido que `Registro` y se confundian: cada uno es la bitacora de un
        flujo OPUESTO.

     Y `Comparar` baja a HERRAMIENTAS, que es lo que es: una consulta que el
     usuario dispara a mano, no el resultado de la corrida automatica.

     Los `view` (data-view) NO cambian: son los que enruta navigate() y los que
     gobierna la matriz de permisos. Solo cambian etiquetas y orden. */
  { title: 'Sincronización', items: [
    ['--', 'Corrida automática'],
    ['synclog', I.docs, 'Últimas sincronizaciones', 'adminonly'],
    ['>syncpend', I.alert, 'Diferencias', 'adminonly'],
    ['sync', I.cog, 'Configurar', 'superonly'],
    ['--', 'Enviar al sistema'],
    ['syncreview', I.sync, 'Publicar', 'adminonly'],
    ['axhistory', I.history, 'Historial de envíos', 'adminonly'],
    ['--', 'Herramientas'],
    ['axcompare', I.compare, 'Comparar', 'adminonly'],
    ['erpquery', I.search, 'Consultar API', 'adminonly'],
  ] },
  // v4.78: grupo DATOS BANCARIOS (aprobado por Pablo). Nace con Estadisticas;
  // Sincronizar e Historial (clones filtrados a cuentas) llegan en v4.79/80,
  // y a futuro otros instrumentos (pago movil) seran nuevos items aqui.
  { title: 'Datos bancarios', items: [
    ['bankstats', I.chart, 'Estadísticas', 'adminonly'],
    ['banksync', I.sync, 'Sincronizar', 'adminonly'],
    ['bankhist', I.history, 'Historial', 'adminonly'],
    // v4.82: Cuentas SIN adminonly: todos los roles del equipo la ven (con
    // su alcance); el permiso view.bankaccounts la gobierna desde Roles.
    ['bankaccounts', I.wallet, 'Cuentas'],
  ] },
  // v4.90: grupo WHATSAPP (aprobado por Pablo). v4.97: Difusion SIN
  // superonly: la gobierna view.whatsapp (enforced) desde Roles; un admin
  // con el permiso la ve, restringida a sus grupos asignados. Grupos
  // (catalogo/asignacion) sigue superonly: es gobernanza no delegable.
  { title: 'WhatsApp', items: [
    ['wadifusion', I.megaphone, 'Difusión'],
    ['wamensajes', I.pencil, 'Mensajes'],
    ['waencuestas', I.chart, 'Encuestas'],
    ['wahistorial', I.history, 'Historial'],
    ['wagrupos', I.team, 'Grupos', 'superonly'],
  ] },
  { title: 'Administración', items: [
    ['equipo', I.team, 'Equipo'],
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
    // v5.79: primer item de no-reempleables para TIENDAS. Solo la consulta
    // (view.norehirecheck): identidad y si puede o no ser contratado, sin
    // motivos. La pantalla completa (view.norehire) sigue siendo de admin.
    ['norehirecheck', I.usercheck, 'Verificar candidato'],
  ] },
  { title: 'Solicitudes', items: [
    ['constancias', I.docs, 'Constancias'],
  ] },
  { title: 'Datos bancarios', items: [
    ['bankaccounts', I.wallet, 'Cuentas'],
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
    ['norehire', I.userx, 'No reempleables'],
    ['norehirecheck', I.usercheck, 'Verificar candidato'],
    ['rostersync', I.sync, 'Carga de personal'],
  ] },
  { title: 'Datos bancarios', items: [
    ['bankaccounts', I.wallet, 'Cuentas'],
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
    ['norehire', I.userx, 'No reempleables'],
    ['norehirecheck', I.usercheck, 'Verificar candidato'],
  ] },
  { title: 'Solicitudes', items: [
    ['constancias', I.docs, 'Constancias'],
  ] },
  { title: 'Reportes', items: [
    ['historial', I.history, 'Historial'],
    ['reportempresas', I.bizreport, 'Análisis'],
  ] },
  { title: 'Datos bancarios', items: [
    /* v5.59 — LOS TRES ITEMS EXISTEN PARA EL GESTOR.

       El bug (Pablo, 2026-07-14): se le daba Estadisticas e Historial al rol
       Gestor desde la matriz de Roles, se guardaba bien, la BD los tenia... y
       en el menu seguia apareciendo SOLO Cuentas.

       La razon: el Gestor no usa NAV_GROUPS. Tiene su propio array, y aca
       adentro solo estaba `bankaccounts`. Y applyMenuPerms() SOLO PUEDE
       ESCONDER lo que ya existe: nunca agrega. Si el boton no esta en el array,
       no hay permiso que lo haga aparecer.

       Con los items presentes, la matriz de Roles pasa a gobernarlos de verdad:
       si manana se le quita view.bankstats al Gestor, el item desaparece solo.

       Sin `banksync` a proposito: Sincronizar queda para superadmin y admin.
       Sin flag 'adminonly': en este array no aporta (todos los que llegan aca
       ya son gestor_empresa) y solo seria una segunda regla que mantener. */
    ['bankstats', I.chart, 'Estadísticas'],
    ['bankhist', I.history, 'Historial'],
    ['bankaccounts', I.wallet, 'Cuentas'],
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
  { code: 'admin', label: 'Administrador', is_system: false, osticket_kind: 'agent', readonly_scope: false },
  { code: 'gestor_empresa', label: 'Gestor de empresa', is_system: false, osticket_kind: 'client', readonly_scope: false },
  { code: 'editor_personal', label: 'Editor de personal', is_system: false, osticket_kind: 'none', readonly_scope: false },
  { code: 'superadmin', label: 'Superadmin', is_system: true, osticket_kind: 'agent', readonly_scope: false },
];
let ADMIN_ROLES = null;
/* v5.06: invalidador del cache, expuesto como hook GLOBAL (no export, para no
   crear un ciclo ESM: panel.js ya importa roles.js). La vista Roles lo llama
   tras crear / editar / activar / desactivar un rol, para que Equipo vea el
   catalogo nuevo SIN recargar la pagina (bug: se creaba "Gerente Zona" en Roles
   y el combo de Nuevo miembro seguia mostrando el catalogo viejo hasta un F5). */
if (typeof window !== 'undefined') {
  window.__invalidateAdminRoles = () => { ADMIN_ROLES = null; };
}
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
/* v5.10: escape generico (lo usa el modal de credenciales). panel.js solo
   tenia escRoleLbl, acotado a las etiquetas de rol. */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* v5.10: error DENTRO del modal (regla del portal: sin alert/confirm nativos).
   Los modales de Equipo ya lo hacian asi (auRoleModal, auSyncClientOne); el de
   crear miembro se habia quedado con alert(). */
function modalErrAu(sel, txt) {
  const el = document.querySelector(sel);
  if (!el) return;
  el.textContent = txt || 'No se pudo completar la accion.';
  el.style.display = '';
}
/* Opciones del combo de rol (Nuevo miembro / Cambiar rol). v5.06: se excluyen
   los roles de SISTEMA. 'superadmin' no se asigna desde el modal (el server lo
   rechaza en create y en update_role) y 'tienda' es el login de empresa: si
   aparecian en el combo, era ofrecer algo que iba a fallar. */
function adminRoleOptionsHtml(selected, hideCoord = false) {
  return (ADMIN_ROLES || ADMIN_ROLES_FALLBACK)
    .filter(r => !r.is_system)
    .filter(r => !hideCoord || r.code !== 'coordinador')
    .map(r => `<option value="${r.code}"${r.code === selected ? ' selected' : ''}>${escRoleLbl(r.label)}</option>`).join('');
}
/* Etiqueta visible de un rol (topbar). v5.06: sale del catalogo vivo, asi un
   rol nuevo no muestra el code crudo ('gerente_zona' -> 'Gerente Zona'). */
function roleLabelOf(code) {
  const cat = ADMIN_ROLES || ADMIN_ROLES_FALLBACK;
  const hit = cat.find(r => r.code === code);
  return (hit && hit.label) || ROLE_LABELS[code] || code;
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
  const roleLabel = isCompany ? 'tienda' : roleLabelOf(user.role);   // v5.06: label del catalogo vivo
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

  /* Boton de navegacion. data-label alimenta el tooltip del modo riel.
     v5.48: el prefijo '>' (item hijo) se saca del data-view — es presentacion,
     no identidad. El router y la matriz de permisos siguen viendo `syncpend`.
     La clase .nav-child es la que lo indenta. */
  const navBtn = (it) => {
    const [raw, ic, label] = it;
    const id = raw.startsWith('>') ? raw.slice(1) : raw;
    const child = raw.startsWith('>') ? ' nav-child' : '';
    return `<button data-view="${id}" data-label="${label}" class="${id === currentView ? 'active' : ''}${child}">${ic}<span>${label}</span></button>`;
  };

  // HTML del nav: items sueltos en .nav-loose + grupos con encabezado-chevron.
  const chev = '<svg class="nav-ghead-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  // Filtro por ITEM: 'superonly' solo el super; 'adminonly' cualquier usuario
  // administrativo (v4.57: los endpoints aplican la matriz de permisos, asi
  // que el menu abre la puerta y el permiso decide adentro).
  /* v5.44: un item ['--', 'Texto'] es un SUBTITULO dentro del grupo, no un
     boton. Siempre visible (no navega ni tiene permiso), pero no cuenta para
     saber si el grupo tiene contenido: un grupo con solo subtitulos no se
     pinta.

     v5.48: un view con prefijo '>' es un item HIJO: se indenta y cuelga del
     item de arriba. Sirve para mostrar que una pagina SALE de otra (Diferencias
     sale de la Ultima corrida). El prefijo es solo de presentacion: se saca
     antes de enrutar y antes de mirar permisos, asi que `>syncpend` navega y se
     gatea exactamente igual que `syncpend`. */
  const isSubtitle = (it) => it[0] === '--';
  const isChild = (it) => typeof it[0] === 'string' && it[0].startsWith('>');
  const viewOf = (it) => isChild(it) ? it[0].slice(1) : it[0];
  const itemVisible = (it) => isSubtitle(it) ? true
    : it[3] === 'superonly' ? isSuper
    : it[3] === 'adminonly' ? user.kind === 'admin'
    : true;
  const navHtml = `<div class="nav-loose">${navLoose.filter(itemVisible).map(navBtn).join('')}</div>`
    + navGroups.map((g, gi) => {
        const items = g.items.filter(itemVisible);
        // Un grupo que solo tiene subtitulos (todos sus botones cayeron por
        // permisos) no se pinta: seria una cabecera con encabezados adentro.
        if (!items.some(it => !isSubtitle(it))) return '';

        /* v5.56 — LOS GRUPOS ARRANCAN CERRADOS (Pablo, 2026-07-14: "ya son
           muchos"). Con 8 grupos abiertos, el menu medía mas que la pantalla y
           habia que hacer scroll para llegar a Administracion.

           EXCEPCION: el grupo donde estas parado queda ABIERTO. Si se cerraran
           todos, al entrar a cualquier pantalla el menu no mostraria donde
           estas: perderias la referencia justo cuando mas la necesitas. */
        const tengoElActivo = items.some(it => !isSubtitle(it) && viewOf(it) === currentView);
        const cerrado = tengoElActivo ? '' : ' collapsed';

        return `
        <div class="nav-group${cerrado}" data-group="${gi}">
          <button type="button" class="nav-ghead" data-group-toggle="${gi}"><span class="gh-label">${g.title}</span>${chev}</button>
          <div class="nav-gitems">${items.map(it => isSubtitle(it)
            ? `<div class="nav-sub">${it[1]}</div>`
            : navBtn(it)).join('')}</div>
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
        <div class="pnl-bwrap"><div class="pnl-bname">Portal de Nómina</div><div class="pnl-bver">v6.93</div></div>
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

/* v6.18: fecha de ultima modificacion de la empresa en AX (modifiedDateTime
   de la API de Catalogos), pintada DEBAJO del Estado. NULL = sin fecha (el
   1900-01-01, dateNull de AX, ya llega como NULL desde sync-companies) ->
   no se pinta nada, ni un guion. Hora Caracas. */
function axModCell(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d) || d.getUTCFullYear() <= 1900) return '';
  const c = new Date(d.getTime() - 4 * 3600 * 1000);
  const z = n => String(n).padStart(2, '0');
  return `<div style="font-size:10.5px;color:var(--faint,#94a3b8);margin-top:3px;white-space:nowrap" title="Última modificación de la empresa en AX">mod. ${z(c.getUTCDate())}/${z(c.getUTCMonth() + 1)}/${c.getUTCFullYear()}</div>`;
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
/* v6.17: etiqueta de la quincena calendario en curso (hora Caracas) para
   el tooltip de la barrita: "01–15 jul" o "16–31 jul". */
function qLabel() {
  const car = new Date(Date.now() - 4 * 3600 * 1000);
  const d = car.getUTCDate(), m = car.getUTCMonth(), y = car.getUTCFullYear();
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  if (d <= 15) return `01–15 ${meses[m]}`;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `16–${last} ${meses[m]}`;
}
function personalCell(c) {
  /* v6.17 (mockup aprobado): numero grande = activos VIGENTES hoy (v6.15)
     + chip % foto, y debajo la BARRITA DE LA QUINCENA EN CURSO con los 4
     estados (rpc get_roster_breakdown via /api/catalog):
       verde  estables  = vigentes que ya estaban antes de la quincena
       agua   nuevos    = ingresaron esta quincena y siguen
       azul   traslados = fin cumplido esta quincena, activos en otra empresa
       rojo   egresos   = fin cumplido esta quincena sin destino
     La barra aparece SIEMPRE que la quincena tenga a alguien (v6.19,
     feedback de Pablo sobre la v6.17: "sin movimiento = sin barra" hacia
     parecer que faltaba un dato al lado de las filas que si la tenian).
     Empresa quieta = barra ENTERA VERDE con "N est.": estabilidad visible.
     Solo sin nadie en la quincena (0 en los 4) no hay nada que pintar.
     "Quincena en curso (fechas)" va en el TOOLTIP, no en texto (Pablo).
     Frescura: si la corrida automatica refresco en <=2 dias, la linea de
     abajo dice "\u{1F504} al dia" en verde en vez del "hace Nd" que asustaba. */
  const est = c.bkEst || 0, nue = c.bkNew || 0, tra = c.bkTras || 0, egr = c.bkEgr || 0;
  const moved = (nue + tra + egr) > 0;
  if (!c.staffCount && !c.rosterAt && !moved) return '<span class="muted">— sin lista —</span>';
  const by = c.rosterBy ? `<br>${String(c.rosterBy).replace(/</g, '&lt;')}` : '';
  let photoChip = '';
  if (c.photoTotal > 0) {
    const pct = Math.round((c.photoCount / c.photoTotal) * 100);
    const cls = pct >= 90 ? 'ph-ok' : pct >= 50 ? 'ph-mid' : 'ph-low';
    photoChip = `<span class="ph-chip ${cls}" title="${c.photoCount} de ${c.photoTotal} con foto">`
      + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>${pct}%</span>`;
  }
  // Numero grande: 0 activos se pinta apagado (sin drama, inconfundible).
  const num = c.staffCount
    ? `${c.staffCount}`
    : `<span style="color:var(--faint,#94a3b8)">0</span>`;
  // Barrita de la quincena (solo con movimiento). Estilos inline a proposito:
  // la celda vive dentro de la grilla de Empresas y asi no depende del bloque
  // CSS de la vista.
  let bar = '';
  if ((est + nue + tra + egr) > 0) {   // v6.19: estables solos tambien pintan
    const tot = est + nue + tra + egr;
    const segs = [[est, '#0e9f6e'], [nue, '#5eead4'], [tra, '#3b82f6'], [egr, '#ef4444']]
      .filter(s => s[0] > 0)
      .map(s => `<i style="display:block;height:100%;width:${(s[0] / tot * 100).toFixed(1)}%;background:${s[1]}"></i>`)
      .join('');
    const leg = [
      est ? `<span style="color:#0e9f6e"><b>${est}</b> est.</span>` : '',
      nue ? `<span style="color:#0d9488"><b>${nue}</b> nuevos</span>` : '',
      tra ? `<span style="color:#1d4ed8"><b>${tra}</b> tras.</span>` : '',
      egr ? `<span style="color:#b91c1c"><b>${egr}</b> egr.</span>` : '',
    ].filter(Boolean).join('');
    const tip = `Quincena en curso (${qLabel()}): ${est} estables · ${nue} nuevos · ${tra} traslados · ${egr} egresos · Activos hoy: ${c.staffCount || 0}`;
    bar = `<div style="margin-top:4px;max-width:160px" title="${tip}">`
      + `<div style="display:flex;height:6px;border-radius:4px;overflow:hidden;background:#eef1f5">${segs}</div>`
      + `<div style="display:flex;gap:7px;font-size:10px;margin-top:2px;flex-wrap:wrap">${leg}</div>`
      + `</div>`;
  }
  // Frescura de la corrida automatica (<=2 dias): la lista esta al dia
  // aunque la CARGA manual sea vieja; no hay que invitar a recargar.
  let l2;
  const ar = c.autoRefreshedAt ? new Date(c.autoRefreshedAt) : null;
  if (ar && !isNaN(ar) && (Date.now() - ar.getTime()) <= 2 * 86400000) {
    const cd = new Date(ar.getTime() - 4 * 3600 * 1000);
    const z = n => String(n).padStart(2, '0');
    l2 = `<span style="color:#0e9f6e;font-weight:600" title="La corrida automática mantiene esta lista (último refresco ${z(cd.getUTCDate())}/${z(cd.getUTCMonth() + 1)})">\u{1F504} al día</span> · ${methodChip(c.rosterSource)} ${rosterFresh(c.rosterAt)}${by}`;
  } else {
    l2 = `${methodChip(c.rosterSource)} ${rosterFresh(c.rosterAt)}${by}`;
  }
  return `<div class="cell-personal">`
    + `<div class="l1">${num}${photoChip}</div>`
    + bar
    + `<div class="l2">${l2}</div>`
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
async function viewTiendas(user) {
  await ensureReportPerms(user);   // v5.04: el boton Reportar sale de la matriz
  const isAdmin = user.kind === 'admin';
  const isEditor = user.kind === 'admin' && user.role === 'editor_personal';
  const isGestor = user.kind === 'admin' && user.role === 'gestor_empresa';
  // El gestor de empresa NO administra: sin "Sincronizar todo", sin editar
  // contacto y sin Departamentos; pero SI puede entrar a Personal y Reportar.
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  const canSyncAll = isAdmin && !isGestor;
  const canEditContact = !isEditor && !isGestor;
  const canDepartments = !isEditor && !isGestor;
  // v5.04: antes era `!isEditor` (rol legacy) y cualquier rol nuevo sin
  // permisos de reportar veia el boton y cobraba 403 al usarlo. Ahora manda
  // la matriz: se pinta solo si tiene AL MENOS UN report.* concedido (el
  // picker que abre muestra unicamente los tipos permitidos).
  const canReport = !isEditor && canReportAny();
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
        ${canSyncAll ? `<button class="btn btn-primary" id="syncAllBtn">${I.sync} Sincronizar personal</button>` : ''}
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
        <option value="staff_desc">Personal: más primero</option>
        <option value="staff_asc">Personal: menos primero</option>
        <option value="photo_desc">Fotos: mayor % primero</option>
        <option value="photo_asc">Fotos: menor % primero</option>
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
    // v5.22: el combo de Subzona nace con UNA sola opcion ("Todas"); sus opciones
    // las llena fillSubs() en funcion de la zona elegida. Al volver de Personal se
    // restauraba la zona pero NUNCA se repoblaba el combo, asi que el valor guardado
    // (ej. El Recreo) no encontraba su <option> y el combo quedaba vacio.
    // Hay que poblar PRIMERO y asignar DESPUES.
    fillSubs();
    if (TIENDAS_FILTERS.sub && [...fSub.options].some(o => o.value === TIENDAS_FILTERS.sub)) {
      fSub.value = TIENDAS_FILTERS.sub;
    }
    if (TIENDAS_FILTERS.concept && [...fConcept.options].some(o => o.value === TIENDAS_FILTERS.concept)) {
      fConcept.value = TIENDAS_FILTERS.concept;
    }
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
    // v6.64: orden por CANTIDAD DE PERSONAL (activos vigentes hoy). Empresas
    // sin lista (staffCount 0/nulo) van al final en "mas primero" y al
    // principio en "menos primero". Empate -> por codigo (orden estable).
    else if (sortMode === 'staff_desc' || sortMode === 'staff_asc') {
      const n = c => Number(c.staffCount) || 0;
      rows.sort((a, b) => {
        const na = n(a), nb = n(b);
        if (na !== nb) return sortMode === 'staff_desc' ? nb - na : na - nb;
        return a.code < b.code ? -1 : 1;
      });
    }
    // v6.64: orden por % DE FOTOS (con foto / total del roster). Solo tiene
    // sentido donde hay base (photoTotal > 0); las empresas sin personal
    // cargado NO tienen un % real, asi que van SIEMPRE al final en ambos
    // sentidos (no es que tengan 0% de fotos, es que no hay a quien
    // fotografiar). Empate de % -> por codigo.
    else if (sortMode === 'photo_desc' || sortMode === 'photo_asc') {
      const pct = c => (c.photoTotal > 0) ? (c.photoCount / c.photoTotal) : null;
      rows.sort((a, b) => {
        const pa = pct(a), pb = pct(b);
        if (pa == null && pb == null) return a.code < b.code ? -1 : 1;
        if (pa == null) return 1;   // sin base: al final
        if (pb == null) return -1;
        if (pa !== pb) return sortMode === 'photo_desc' ? pb - pa : pa - pb;
        return a.code < b.code ? -1 : 1;
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
        <td>${statusPill(c.status)}${axModCell(c.axModifiedAt)}</td>
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
    // v6.18: ultima modificacion de la empresa en AX (solo si hay fecha).
    if (c.axModifiedAt) rows.push(['Mod. en AX', axModCell(c.axModifiedAt)]);
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
  // Estructura tabular común a los tres formatos. v6.49: se agregan RIF, Tipo,
  // Personal activo, desglose de la quincena (estables/nuevos/traslados/egresos)
  // y Departamentos, para que el export refleje lo que vive en la grilla.
  return rows.map(c => ({
    'Código': c.code,
    'Razón social': c.name || '',
    'RIF': c.taxId || '',
    'Tipo': c.type || '',
    'Zona': c.zone || '',
    'Subzona': c.subzone || '',
    'Concepto': c.concept || '',
    'Correo': c.email || '',
    'Teléfono 1 nacional': phoneDisplay(c.phone) || '',
    'Teléfono 1 internacional': c.phone || '',
    'Teléfono 2 nacional': phoneDisplay(c.phone2) || '',
    'Teléfono 2 internacional': c.phone2 || '',
    'Personal activo': c.staffCount || 0,
    'Estables (quincena)': c.bkEst || 0,
    'Nuevos (quincena)': c.bkNew || 0,
    'Traslados (quincena)': c.bkTras || 0,
    'Egresos (quincena)': c.bkEgr || 0,
    'Departamentos': c.deptCount || 0,
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
  const fname = `empresas_${tstamp()}`;

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
      window.XLSX.utils.book_append_sheet(wb, ws, 'Empresas');
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

/* ---------- Sincronizar personal (admin): las TIENDAS visibles ----------
   v5.39 — REAPUNTADO AL MOTOR BUENO.

   Antes este boton llamaba a /api/ax-roster, un motor de otra era cuya regla
   era "el ultimo reporte manda": PISABA los datos del portal con los de AX
   (vaciando cuentas que AX no tiene) y DESCARTABA los cambios pendientes de
   publicar. Era el unico lugar del portal que hacia eso.

   Ahora llama a /api/sync-roster, el mismo motor que "Ejecutar ahora" y que el
   cron: rellena huecos, marca las diferencias, y NO PISA NADA que ya tenga
   valor. Un solo motor, una sola verdad.

   Lo que este boton sigue aportando (y "Ejecutar ahora" no): el parametro
   `only` — sincroniza SOLO las empresas visibles con el filtro actual, en vez
   de las 132 tiendas. Sin eso seria un duplicado.

   Va por TANDAS (limite de 50 subrequests de Cloudflare): cada llamada procesa
   unas pocas tiendas y devuelve next_offset. Los acumuladores (acc_*) y el
   `only` viajan en CADA tanda, o la siguiente volveria a la lista completa. */
function openSyncAllModal(user, rows) {
  /* Solo TIENDAS: el motor sincroniza tiendas abiertas. Si el filtro trae
     Importadoras o Externas, el backend las descarta igual — pero el contador
     del modal tiene que decir la verdad de entrada. */
  const stores = (rows || []).filter(c => c.type === 'Tienda');
  const only = stores.map(c => c.code);
  const total = only.length;
  const dropped = (rows || []).length - total;

  openModal(`
    <div class="modal-head"><span>Sincronizar personal</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 12px">Trae el personal de las <b>${total}</b> tienda(s) visibles con el filtro actual.${dropped ? ` <span style="color:var(--muted)">(${dropped} empresa(s) del filtro no son tiendas y no se sincronizan aquí.)</span>` : ''}</p>
    <div class="sa-okbox">✓ <b>No se pisa ningún dato.</b> Se completan los campos vacíos con lo que trae el sistema, se ingresan los trabajadores nuevos y se retiran los que tienen fecha de egreso. Lo que ya tiene valor en el portal queda intacto; si hay diferencias, se marcan para revisar.</div>
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
  const logRow = (txt, cls) => {
    if (!logEl) return;
    const row = document.createElement('div');
    row.className = 'sa-row ' + (cls || 'ok');
    row.innerHTML = txt;
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

    /* El estado de la corrida viaja de tanda en tanda. Sin esto, cada tanda
       arrancaria de cero: el resumen final solo contaria la ULTIMA. */
    let acc = { offset: 0, run_id: null };
    let last = null;

    while (!stopped) {
      if (statEl) {
        const hechas = Math.min(acc.offset, total);
        statEl.textContent = `Sincronizando… (${hechas}/${total} tiendas)`;
      }
      setFill(Math.min(acc.offset, total) / total * 100);

      let r;
      try {
        r = await fetch('/api/sync-roster', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: 'manual',
            adminId: user.id,
            only,                  // <- las tiendas del filtro. Va en CADA tanda.
            offset: acc.offset,
            run_id: acc.run_id,
            // acumuladores de las tandas anteriores
            acc_filled: acc.acc_filled, acc_diffs: acc.acc_diffs,
            acc_rej_account: acc.acc_rej_account,
            acc_rej_phone: acc.acc_rej_phone,
            acc_rej_email: acc.acc_rej_email,
            acc_rej_detail: acc.acc_rej_detail,
            acc_diff_detail: acc.acc_diff_detail,
          }),
        }).then(x => x.json());
      } catch (e) {
        r = { ok: false, error: String(e && e.message || e) };
      }

      if (!r || !r.ok) {
        logRow(`<span class="r">✕ ${(r && r.error) || 'Error de red'}</span>`, 'fail');
        phase = 'done';
        if (statEl) statEl.innerHTML = 'La sincronización se detuvo por un error.';
        const b = $('#saCancel'); b.disabled = false; b.textContent = 'Cerrar';
        return;
      }

      anySynced = true;
      last = r;
      acc = {
        offset: r.next_offset || 0,
        run_id: r.run_id,
        acc_filled: r.acc_filled, acc_diffs: r.acc_diffs,
        acc_rej_account: r.acc_rej_account,
        acc_rej_phone: r.acc_rej_phone,
        acc_rej_email: r.acc_rej_email,
        acc_rej_detail: r.acc_rej_detail,
        acc_diff_detail: r.acc_diff_detail,
      };

      if (r.done) break;
    }

    phase = 'done';
    setFill(100);

    const s = last || {};
    const partes = [];
    if (s.added)    partes.push(`<b>${s.added}</b> ingreso(s)`);
    if (s.removed)  partes.push(`<b>${s.removed}</b> egreso(s)`);
    if (s.filled)   partes.push(`<b>${s.filled}</b> dato(s) completado(s)`);
    if (s.diff_review) partes.push(`<b>${s.diff_review}</b> por revisar`);
    if (s.diff_broken) partes.push(`<b>${s.diff_broken}</b> a corregir en el sistema`);
    if (s.alerts)   partes.push(`<b>${s.alerts}</b> alerta(s)`);

    logRow(partes.length
      ? partes.join(' · ')
      : 'Sin cambios: todo estaba al día.', partes.length ? 'ok' : 'skip');

    if (statEl) {
      statEl.innerHTML = stopped
        ? `Detenido · <b>${s.stores || 0}</b> de ${total} tienda(s) procesada(s).`
        : `Listo · <b>${s.stores || 0}</b> tienda(s) sincronizada(s).`;
    }
    logRow('<a href="#" id="saGoLog">Ver el detalle en el Registro →</a>', 'skip');
    const goLog = document.getElementById('saGoLog');
    if (goLog) goLog.addEventListener('click', (e) => {
      e.preventDefault();
      closeModal();
      navigate('synclog', user);
    });

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
/* Bloque de contrasena inicial, compartido por varios modales.
   v5.10: el subtitulo de "Generar temporal" ahora depende del CONTEXTO. Decia
   siempre "La cambia al entrar por primera vez", y para el PORTAL eso es cierto
   desde v5.08 (el login intercepta y obliga a cambiarla). Pero el mismo bloque
   lo reusa el modal del agente de osTicket, donde es FALSO: osTicket no fuerza
   nada. Estabamos prometiendo algo que no pasaba. */
function pwdBlockHtml(ctx) {
  const forced = ctx !== 'osticket';
  const sub = forced
    ? 'La cambia al entrar por primera vez'
    : 'Clave provisional (osTicket no le va a pedir que la cambie)';
  return `
    <p class="flabel" style="margin-bottom:9px">Contraseña inicial</p>
    <label class="radio-row"><input type="radio" name="pwmode" value="temp" checked>
      <span>Generar temporal<br><span class="muted" style="font-size:12px">${sub}</span></span></label>
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

/* ---------- VISTA: EQUIPO (bloques DINAMICOS por rol, v5.00) ----------
   Superadmin en una fila destacada arriba (ve todo, sin alcance ni osTicket).
   Debajo, UN BLOQUE POR CADA ROL del catalogo (tabla roles, via /api/roles
   'options'): un rol creado en la vista Roles aparece aqui con sus miembros
   sin tocar codigo. La especializacion de columnas/stats/acciones la dicta
   el osticket_kind del rol:
     - agent  -> como los administradores: alcance Tiendas + Empresas ·
                 osTicket como AGENTE (#staff)
     - client -> como los gestores: alcance SOLO Empresas/deptos · osTicket
                 como CLIENTE (#user)
     - none   -> como los editores: alcance Tiendas + Empresas · SIN osTicket
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
  const scovBtn = (!isSuper || a.role === 'superadmin') ? ''
    : `<button class="btn btn-mini au-scov" data-id="${a.id}" data-u="${a.username}" data-name="${(a.name || '').replace(/"/g, '&quot;')}" data-role="${a.role}" title="Alcances por sección (override)">⚡</button>`;
  const roleBtn = (self || !isSuper) ? scovBtn
    : scovBtn + `<button class="btn btn-mini" data-act="role" data-id="${a.id}" data-u="${a.username}" data-role="${a.role}" title="Cambiar rol">Rol</button>`;
  /* v5.07: boton Editar (nombre / correo / telefono). El telefono es lo que
     habilita enviarle las credenciales por WhatsApp, y hasta ahora solo se
     podia cargar AL CREAR: los miembros ya existentes no tenian como. */
  const editBtn = `<button class="btn btn-mini" data-act="edit" data-id="${a.id}" data-u="${a.username}" data-name="${(a.name || '').replace(/"/g, '&quot;')}" data-mail="${(a.email || '').replace(/"/g, '&quot;')}" data-tel="${(a.phone || '').replace(/"/g, '&quot;')}" title="Editar nombre, correo y telefono">Editar</button>`;
  const resetBtn = `<button class="btn btn-mini" data-act="reset" data-id="${a.id}" data-u="${a.username}" data-name="${(a.name || '').replace(/"/g, '&quot;')}">${I.key} Resetear</button>`;
  const toggleBtn = self ? ''
    : `<button class="btn btn-mini" data-act="toggle" data-id="${a.id}" data-active="${a.is_active}">${a.is_active ? 'Desactivar' : 'Activar'}</button>`;
  return { roleBtn, editBtn, resetBtn, toggleBtn };
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

/* ---------- Alcance por seccion (overrides) desde Equipo (v4.85) ----------
   Modal lanzado por el boton #auScov de la cabecera de Equipo. Selector de
   miembro (no-super activos) + bloque injectScopeOverridesBlock (modulo
   js/views/scope-overrides.js, mockup aprobado equipo_alcance_overrides).
   Listener por DELEGACION global (instalacion unica): sobrevive re-renders
   de viewEquipo y evita problemas de timing con su fetch inicial. */
async function openEquipoScovModal(user) {
  openModal(`
    <div class="modal-head"><span>⚡ Alcances por sección</span><button class="modal-x" id="scovX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 12px">El miembro conserva su alcance base en todo el portal; aquí puedes darle un alcance <b>distinto solo para una sección</b> (p.ej. tesorería: cuentas de todas las tiendas).</p>
    <label style="display:block;font-size:12px;font-weight:700;color:var(--ink-soft,#475569);margin-bottom:5px">Miembro del equipo</label>
    <select id="scovMember" style="width:100%;font:inherit;font-size:13px;padding:8px 11px;border:1px solid var(--border,#e6eaf0);border-radius:9px;background:var(--surface,#fff);color:var(--ink)">
      <option value="">Cargando miembros…</option>
    </select>
    <div id="scovHost"></div>`);
  $('#scovX').addEventListener('click', closeModal);

  const d = await auApi({ action: 'list', adminId: user.id });
  const sel = document.getElementById('scovMember');
  if (!sel) return; // modal cerrado antes de cargar
  if (!d || !d.ok) { sel.innerHTML = '<option value="">No se pudo cargar el equipo</option>'; return; }
  const members = (d.rows || []).filter(a => a.role !== 'superadmin' && a.is_active !== false
    && (user.role === 'superadmin' || a.role !== 'coordinador'));
  if (!members.length) { sel.innerHTML = '<option value="">Sin miembros elegibles</option>'; return; }
  sel.innerHTML = '<option value="">— Elige un miembro —</option>'
    + members.map(a => `<option value="${a.id}">${(a.name || a.username || ('#' + a.id))} · ${a.role || ''}</option>`).join('');
  sel.addEventListener('change', () => {
    const host = document.getElementById('scovHost');
    if (!host) return;
    host.innerHTML = '';
    const m = members.find(x => String(x.id) === sel.value);
    if (m) renderScopeOverridesEditor(user, m, async () => { await viewEquipo(user); decorateScovBadges(user); });
  });
}
// Delegacion global del boton ⚡ por fila de Equipo (instalacion unica).
// Click en .au-scov -> editor de pagina completa (scope-overrides.js);
// el volver re-pinta Equipo y decora los badges de overrides.
if (!window.__scovEquipoWired) {
  window.__scovEquipoWired = true;
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('.au-scov') : null;
    if (!b) return;
    const u = getSession();
    if (!u) return;
    const member = {
      id: parseInt(b.dataset.id, 10),
      username: b.dataset.u || '',
      name: b.dataset.name || '',
      role: b.dataset.role || '',
    };
    renderScopeOverridesEditor(u, member, async () => { await viewEquipo(u); decorateScovBadges(u); });
  });
}

/* ===================== v6.43: EQUIPO REFORMADO (mockup equipo_reforma) ====
   La fila queda con DOS controles (boton Alcance + menu ⋯), los bloques por
   rol explican en lenguaje llano con "Ver permisos" en solo lectura, la barra
   trae buscador + combo de rol con contadores + filtro de estado, y todo el
   alcance de un miembro vive en su PAGINA de Alcance con ← Volver. */
function ensureEqCss() {
  if (document.getElementById('eqRevampCss')) return;
  const st = document.createElement('style');
  st.id = 'eqRevampCss';
  st.textContent = `
    .eq-ctl{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 16px}
    .eq-search{display:flex;align-items:center;gap:7px;background:var(--card,#fff);border:1px solid var(--border,#e6eaf0);border-radius:10px;padding:8px 11px;flex:1;min-width:230px}
    .eq-search input{border:0;outline:0;font:inherit;font-size:13px;width:100%;background:transparent;color:var(--ink,#0f172a)}
    .eq-search svg{color:var(--muted,#64748b);flex:none}
    .eq-sel{padding:8px 11px;border:1px solid var(--border,#e6eaf0);border-radius:10px;background:var(--card,#fff);font:inherit;font-size:13px;color:var(--ink,#0f172a)}
    .eq-desc{font-size:12.8px;color:var(--ink-soft,#475569);margin-top:6px;line-height:1.55;max-width:920px}
    .eq-meta{display:flex;gap:14px;align-items:center;margin-top:7px;flex-wrap:wrap;font-size:12px;color:var(--muted,#64748b)}
    .eq-meta b{color:var(--ink,#0f172a)}
    .eq-permlnk{font-size:12px;color:var(--brand,#2563eb);font-weight:700;cursor:pointer;background:none;border:0;padding:0;font-family:inherit}
    .eq-permlnk:hover{text-decoration:underline}
    .eq-permpanel{background:#fbfcfe;border-top:1px dashed var(--border,#e6eaf0);padding:12px 18px;font-size:12.3px;color:var(--ink-soft,#475569)}
    .eq-permpanel .dom{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--faint,#94a3b8);margin:10px 0 5px}
    .eq-perm{display:inline-block;padding:3px 9px;border-radius:8px;border:1px solid #c4e8d9;background:#e9f7f1;color:#0e7a55;font-size:11.5px;margin:0 5px 5px 0}
    .eq-permnote{margin-top:8px;font-size:11.5px;color:var(--faint,#94a3b8)}
    .eq-acts{display:inline-flex;gap:6px;align-items:center}
    .eq-scope-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid #c7d8f7;border-radius:9px;background:#eff4ff;color:#1e40af;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:inherit}
    .eq-scope-btn:hover{background:#e0ebff}
    .eq-kb{width:30px;height:30px;border:1px solid var(--border,#e6eaf0);border-radius:9px;background:var(--card,#fff);cursor:pointer;font-size:16px;line-height:1;color:var(--muted,#64748b);display:inline-flex;align-items:center;justify-content:center}
    .eq-kb:hover{color:var(--ink,#0f172a);border-color:var(--muted,#64748b)}
    .eq-pop{position:fixed;z-index:95;min-width:195px;background:var(--card,#fff);border:1px solid var(--border,#e6eaf0);border-radius:11px;box-shadow:0 10px 26px rgba(15,23,42,.15);padding:5px;display:none;text-align:left}
    .eq-pop.open{display:block}
    .eq-pop button{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:8px 11px;border:0;background:none;border-radius:8px;font:inherit;font-size:12.5px;color:var(--ink-soft,#475569);cursor:pointer}
    .eq-pop button:hover{background:var(--bg-soft,#f1f5f9)}
    .eq-sep{height:1px;background:var(--border-soft,#f1f4f8);margin:4px 6px}
    .eq-pop .eq-danger{color:#b91c1c}
    .eq-pop .eq-danger:hover{background:#fef2f2}
    .eq-empty{padding:16px;text-align:center;color:var(--muted,#64748b);font-size:12.5px}
    .alc-back{display:inline-flex;align-items:center;gap:7px;background:none;border:0;color:var(--brand,#2563eb);font-size:13.5px;font-weight:700;cursor:pointer;padding:0;margin-bottom:12px;font-family:inherit}
    .alc-back:hover{text-decoration:underline}
    .alc-card2{background:var(--card,#fff);border:1px solid var(--border,#e6eaf0);border-radius:14px;overflow:hidden}
    .alc-tabs{display:flex;gap:2px;padding:6px 16px 0;background:#fbfcfe;border-bottom:1px solid var(--border,#e6eaf0);flex-wrap:wrap}
    .alc-tab{padding:10px 15px;font-size:13px;font-weight:700;color:var(--muted,#64748b);cursor:pointer;border:0;background:none;border-bottom:2.5px solid transparent;margin-bottom:-1px;font-family:inherit}
    .alc-tab.on{color:var(--brand,#2563eb);border-bottom-color:var(--brand,#2563eb)}
    .alc-body{padding:18px 20px}
    /* v6.46: arbol Zona ▸ Subzona ▸ tienda (pestaña Tiendas) */
    .sctree-tools{display:flex;gap:9px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
    .sctree-tools .search{display:flex;align-items:center;gap:7px;background:var(--card,#fff);border:1px solid var(--border,#e6eaf0);border-radius:10px;padding:8px 11px;flex:1;min-width:220px}
    .sctree-tools .search input{border:0;outline:0;font:inherit;font-size:13px;width:100%;background:transparent;color:var(--ink,#0f172a)}
    .sctree-tools .search svg{color:var(--muted,#64748b);flex:none}
    .sctree-sum{background:var(--bg-soft,#f1f5f9);border-radius:10px;padding:9px 13px;font-size:12.3px;color:var(--ink-soft,#475569);margin-bottom:12px}
    .sctree-sum b{color:var(--ink,#0f172a)}
    .sctree-sum .exc{color:#b45309}
    .sctree{border:1px solid var(--border,#e6eaf0);border-radius:11px;overflow:auto;max-height:56vh}
    .zrow{display:flex;align-items:center;gap:9px;padding:8px 13px;border-top:1px solid var(--border-soft,#f1f4f8);font-size:12.8px}
    .zrow:first-child{border-top:0}
    .zrow input[type=checkbox]{accent-color:var(--brand,#2563eb);width:15px;height:15px;margin:0;cursor:pointer;flex:none}
    .zrow .zn{font-weight:600}
    .zrow .zc{color:var(--faint,#94a3b8);font-size:11.5px;margin-left:auto;white-space:nowrap}
    .zrow.child{padding-left:44px;background:#fbfcfe}
    .zrow.child2{padding-left:76px;background:var(--card,#fff)}
    .zrow .toggle{cursor:pointer;color:var(--faint,#94a3b8);font-size:11px;user-select:none;width:14px;text-align:center;flex:none}
    .zrow .minus{font-size:10.5px;color:#b45309;background:#fdf3e7;border-radius:6px;padding:0 6px;margin-left:6px}
    .zrow.tienda .tcode{font-family:Consolas,monospace;font-size:11.5px;color:var(--ink-soft,#475569)}
    .zrow.tienda .tname{color:var(--muted,#64748b);font-size:11.5px}
    .zrow.tienda.excl{opacity:.7}
    .zrow.tienda .badge-exc{font-size:10px;color:#b45309;background:#fdf3e7;border-radius:6px;padding:0 6px;margin-left:auto}
    /* v6.47: arbol Empresa ▸ departamentos (pestaña Empresas) */
    .zrow.empresa .ecode{font-family:Consolas,monospace;font-size:11.5px;color:var(--ink-soft,#475569)}
    .zrow.empresa .etype{font-size:10px;color:var(--muted,#64748b);background:var(--bg-soft,#f1f5f9);border-radius:6px;padding:0 6px}
    .zrow.dept{padding-left:52px;background:#fbfcfe}
    .zrow.dept .dname{color:var(--ink-soft,#475569)}`;
  document.head.appendChild(st);
}
// Menu ⋯ de la fila: flotante position:fixed, asi NINGUNA grilla ni overflow
// puede taparlo o recortarlo. Instalacion unica; cierra con clic afuera y con
// cualquier scroll (incluido el scroll-x interno de las tablas: capture).
if (typeof window !== 'undefined' && !window.__eqKebabWired) {
  window.__eqKebabWired = true;
  document.addEventListener('click', (e) => {
    const kb = e.target && e.target.closest ? e.target.closest('.eq-kb') : null;
    document.querySelectorAll('.eq-pop.open').forEach(p => { if (!kb || p !== kb.nextElementSibling) p.classList.remove('open'); });
    if (kb) {
      const pop = kb.nextElementSibling;
      const open = pop.classList.toggle('open');
      if (open) {
        const r = kb.getBoundingClientRect();
        pop.style.top = (r.bottom + 5) + 'px';
        pop.style.left = Math.max(8, r.right - 200) + 'px';
      }
    }
  });
  window.addEventListener('scroll', () => {
    document.querySelectorAll('.eq-pop.open').forEach(p => p.classList.remove('open'));
  }, { passive: true, capture: true });
}
/* Matriz de permisos (solo lectura) para el "Ver permisos" de los bloques.
   /api/roles action=matrix esta gateada por view.roles: el coordinador la
   tiene en LECTURA (v6.43); editar sigue en la vista Roles, solo superadmin. */
let EQ_MATRIX = null;
async function eqEnsureMatrix(user) {
  if (EQ_MATRIX) return EQ_MATRIX;
  try {
    const d = await fetch('/api/roles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'matrix', user: { kind: user.kind, id: user.id || null } }),
    }).then(r => r.json());
    if (d && d.ok) EQ_MATRIX = d;
  } catch (_) { /* el panel muestra el aviso */ }
  return EQ_MATRIX;
}
async function eqTogglePermPanel(user, btn) {
  const code = btn.dataset.pp;
  const panel = document.getElementById('pp-' + code);
  if (!panel) return;
  if (panel.style.display !== 'none') { panel.style.display = 'none'; btn.textContent = 'Ver permisos \u25be'; return; }
  btn.textContent = 'Ver permisos \u25b4';
  panel.style.display = '';
  if (panel.dataset.loaded) return;
  panel.innerHTML = '<span style="color:var(--faint,#94a3b8)">Cargando permisos\u2026</span>';
  const m = await eqEnsureMatrix(user);
  if (!m) { panel.innerHTML = '<span style="color:var(--faint,#94a3b8)">No se pudo cargar la matriz de permisos.</span>'; return; }
  const granted = new Set((m.grants && m.grants[code]) || []);
  const byDomain = {};
  (m.permissions || []).forEach(p => { if (granted.has(p.code)) (byDomain[p.domain] = byDomain[p.domain] || []).push(p); });
  const doms = Object.keys(byDomain).sort();
  panel.innerHTML = doms.length
    ? doms.map(d => `<div class="dom">${esc(d)}</div>` + byDomain[d].map(p => `<span class="eq-perm">${esc(p.label)}</span>`).join('')).join('')
      + `<div class="eq-permnote">${granted.size} permisos concedidos \u00b7 solo lectura \u2014 se editan en <b>Administraci\u00f3n \u2192 Roles</b>.</div>`
    : '<span style="color:var(--faint,#94a3b8)">Este rol no tiene permisos concedidos.</span>';
  panel.dataset.loaded = '1';
}
/* v6.44: PAGINA DE ALCANCE unificada de un miembro — UNA sola pantalla con
   ← Volver y PESTAÑAS (mockup equipo_reforma): Tiendas · Empresas · Por
   seccion. Cada pestaña monta el editor REAL adentro (#alcBody) en modo
   embedded; al guardar se vuelve a esta misma pagina con la pestaña activa.
   Cambiar de pestaña o ← Volver descartan lo no guardado (como el mockup). */
function renderAlcancePage(user, m, active) {
  ensureEqCss();
  const kind = m.kind || 'agent';
  const tabs = [];
  if (kind !== 'client') tabs.push(['store', '\u{1F3EC} Tiendas']);
  tabs.push(['ent', '\u{1F3E2} Empresas']);
  tabs.push(['scov', '\u26a1 Por secci\u00f3n']);
  const first = tabs.some(t => t[0] === active) ? active : tabs[0][0];
  $('#pnlMain').innerHTML = `
    <button class="alc-back" id="alcBack" type="button">\u2190 Volver a Equipo</button>
    <div class="pnl-head" style="margin-bottom:10px"><div><h1>Alcance \u00b7 ${esc(m.name || m.username)}</h1>
      <p>Tiendas, empresas (con departamentos) y overrides por secci\u00f3n \u2014 todo en una sola p\u00e1gina.</p></div></div>
    <div class="alc-card2">
      <div class="alc-tabs">${tabs.map(([k, t]) => `<button class="alc-tab${k === first ? ' on' : ''}" data-tab="${k}" type="button">${t}</button>`).join('')}</div>
      <div class="alc-body" id="alcBody"><div class="pnl-loading">Cargando\u2026</div></div>
    </div>`;
  $('#alcBack').addEventListener('click', () => viewEquipo(user));
  const mount = (k) => {
    const back = () => renderAlcancePage(user, m, k);
    if (k === 'scov') {
      renderScopeOverridesEditor(user, { id: parseInt(m.id, 10), username: m.username || '', name: m.name || '', role: m.role || '' }, back, { host: '#alcBody', embedded: true });
    } else {
      openScopeEditor(user, m.id, m.username, k === 'ent' ? 'enterprise' : 'store', back, { host: '#alcBody', embedded: true });
    }
  };
  $('#pnlMain').querySelectorAll('.alc-tab').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.alc-tab').forEach(x => x.classList.toggle('on', x === b));
    mount(b.dataset.tab);
  }));
  mount(first);

  /* v6.45: contador de overrides en la pestaña ⚡ (mockup: "⚡ Por sección · N").
     Una sola consulta al montar la página; si el miembro no tiene overrides se
     deja la etiqueta limpia (sin "· 0"). Silencioso ante error. */
  (async () => {
    const tabBtn = $('#pnlMain').querySelector('.alc-tab[data-tab="scov"]');
    if (!tabBtn) return;
    const n = await countScovOverrides(user, m.id);
    if (n > 0 && tabBtn.isConnected) tabBtn.textContent = `\u26a1 Por secci\u00f3n \u00b7 ${n}`;
  })();
}

async function viewEquipo(user) {
  ensureEqCss();
  $('#pnlMain').innerHTML = `<div class="pnl-head"><div><h1>Equipo</h1><p>Miembros del portal por rol</p></div></div><div class="pnl-loading">Cargando\u2026</div>`;
  const d = await auApi({ action: 'list', adminId: user.id });
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }
  const rows = d.rows || [];

  // El editor de equipo completo (crear miembros, cambiar roles, ver todos
  // los roles) es de superadmin. Un admin no-super entra a Equipo para VER y
  // gestionar (reset/toggle/osTicket) SOLO los gestores de su alcance; el
  // backend ya le devuelve unicamente esos gestores.
  const isSuper = user.role === 'superadmin';
  /* v6.42: el COORDINADOR gestiona el Equipo como el superadmin (ve a todos,
     crea miembros, cambia roles, alcances, claves) con UNA regla de
     jerarquia: no toca superadmins ni a otros coordinadores, y no asigna el
     rol coordinador. El backend (admin-users v6.41) ya lo exige; aqui la UI
     deja de ofrecer botones que van a fallar. */
  const isCoord = user.role === 'coordinador';
  const isMgr = isSuper || isCoord;
  // ¿Este usuario puede TOCAR a este miembro? superadmin: a todos. admin
  // no-super: su lista ya viene filtrada a lo tocable. coordinador: solo
  // roles por debajo del suyo.
  const canTouch = (a) => isCoord ? (a.role !== 'superadmin' && a.role !== 'coordinador') : true;

  const supers = rows.filter(a => a.role === 'superadmin');

  // v5.00: catalogo de roles desde la BD (con osticket_kind/readonly_scope).
  const roleCatalog = await ensureAdminRoles(user);
  const gestoresCount = rows.filter(a => a.role === 'gestor_empresa').length;

  /* v5.07: la celda de Correo pasa a ser CONTACTO: correo + telefono. El
     telefono se necesita a la vista para saber a quien se le puede mandar las
     credenciales por WhatsApp y a quien le falta cargarselo. */
  const emailCell = (a) => {
    const mail = a.email
      ? `<div class="ct-mail">${a.email}</div>`
      : '<div class="ct-mail"><span class="muted">—</span></div>';
    const tel = a.phone
      ? `<div class="ct-tel">📱 ${a.phone}</div>`
      : '<div class="ct-tel none">Sin teléfono</div>';
    return `<td class="cell-mail" data-label="Contacto">${mail}${tel}</td>`;
  };

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
        ${isSuper ? `<button class="btn btn-mini" data-act="reset" data-id="${a.id}" data-u="${a.username}">${I.key} Resetear</button>` : ''}
      </div>
    </div>`;
  }).join('');

  // ---- Bloques DINAMICOS por rol (v5.00) ----
  // Overrides cosmeticos de los 3 roles historicos (titulos y badges de
  // siempre); cualquier otro rol usa su label de la tabla y estilo estandar.
  const TITLE_BY_CODE = { admin: 'Administradores', gestor_empresa: 'Gestores de empresa', editor_personal: 'Editores de personal', coordinador: 'Coordinador', auditor: 'Auditores', gerente_zona: 'Gerentes de Zona', supervisor_tiendas: 'Supervisores de Tiendas' };
  const BADGE_BY_CODE = { admin: 'rb-admin', gestor_empresa: 'rb-gestor', editor_personal: 'rb-editor' };
  const STAT_BY_CODE = { admin: 'Administradores', gestor_empresa: 'Gestores', editor_personal: 'Editores' };
  /* v6.43: cada bloque explica en LENGUAJE LLANO que hace el rol (mockup).
     Los que no esten aqui usan un fallback armado de osticket_kind. */
  const DESC_BY_CODE = {
    coordinador: 'Todo lo del Administrador <b>más la gestión del Equipo</b>: crea miembros, resetea claves, cambia alcances y activa o desactiva usuarios. No toca superadmins ni a otros coordinadores, ni Roles / Configuración / Reiniciar datos.',
    admin: 'Operan el día a día de su alcance: <b>editan fichas</b>, publican cambios al sistema, cargan personal y atienden tickets como <b>agentes de osTicket</b>. No gestionan usuarios del Equipo.',
    auditor: '<b>Solo consulta</b>: personal, movimientos, rotación y estadísticas de su alcance, sin editar fichas ni publicar al sistema. Sin osTicket.',
    editor_personal: 'Cargan y corrigen datos del personal de su alcance. Sin publicación al sistema ni osTicket.',
    gestor_empresa: 'Ven <b>solo su empresa y sus departamentos</b>: gestionan la ficha y las fotos de su gente, y abren tickets como <b>clientes de osTicket</b>.',
    gerente_zona: 'Consultan y gestionan <b>las tiendas de su zona</b>. Sin osTicket.',
    supervisor_tiendas: 'Supervisan las tiendas de su alcance en modo consulta. Sin osTicket.',
  };

  const pillAgente = '<span style="display:inline-flex;align-items:center;padding:1px 9px;border-radius:999px;background:#eff4ff;color:#1e40af;font-weight:600">Agente</span>';
  const pillCliente = '<span style="display:inline-flex;align-items:center;padding:1px 9px;border-radius:999px;background:#f0fdf4;color:#15803d;font-weight:600">Usuario</span>';

  function roleRowHtml(a, kind) {
    const self = String(a.id) === String(user.id);
    /* v6.43 (mockup): la fila queda con DOS controles — el boton Alcance
       (pagina unificada) y el menu ⋯ con el resto de las acciones.
       Jerarquia por fila: sin acciones si este usuario no puede tocarlo. */
    const touch = canTouch(a);
    const scopeTd = kind === 'client'
      ? `<td data-label="Alcance">${scopeCellEnt(a)}</td>`
      : `<td data-label="Alcance">${scopeCellBoth(a)}</td>`;
    const ostTd = kind === 'agent' ? `<td data-label="osTicket">${ostAgentCell(a)}</td>`
      : kind === 'client' ? `<td data-label="osTicket">${ostClientCell(a)}</td>` : '';
    const dd = `data-id="${a.id}" data-u="${a.username}" data-name="${(a.name || '').replace(/"/g, '&quot;')}" data-role="${a.role}"`;
    const alcBtn = isMgr
      ? `<button class="eq-scope-btn" data-act="alcance" ${dd} data-kind="${kind}" title="Alcance de tiendas, empresas y por sección">◩ Alcance</button>`
      : '';
    const kebab = `<div class="eq-kebab" style="display:inline-block"><button class="eq-kb" type="button" title="Más acciones">⋯</button>
      <div class="eq-pop">
        ${(isMgr && !self) ? `<button data-act="role" ${dd}>🎭 Cambiar rol</button>` : ''}
        <button data-act="edit" ${dd} data-mail="${(a.email || '').replace(/"/g, '&quot;')}" data-tel="${(a.phone || '').replace(/"/g, '&quot;')}">✎ Editar datos</button>
        ${kind === 'agent' ? `<button data-act="osticket-agent" ${dd} data-staff="${a.osticket_staff_id || ''}">🎫 osTicket</button>`
          : kind === 'client' ? `<button data-act="osticket" ${dd}>🎫 osTicket</button>` : ''}
        <button data-act="reset" ${dd}>🔑 Resetear clave</button>
        ${self ? '' : `<div class="eq-sep"></div>
        <button class="eq-danger" data-act="toggle" data-id="${a.id}" data-active="${a.is_active}">${a.is_active ? '○ Desactivar' : '● Activar'}</button>`}
      </div></div>`;
    return `<tr data-eqrow data-txt="${((a.username || '') + ' ' + (a.name || '') + ' ' + (a.email || '')).toLowerCase().replace(/"/g, '')}" data-on="${a.is_active ? '1' : '0'}">
      <td class="code" data-label="Usuario">${a.username}</td>
      <td class="cell-name" data-label="Nombre">${a.name || '\u2014'}</td>
      ${emailCell(a)}
      ${scopeTd}
      ${ostTd}
      <td data-label="Estado">${estadoPill(a)}${lastLoginLabel(a.last_login_at)}</td>
      <td class="cell-actcell" style="text-align:right">${touch ? `<div class="eq-acts">${alcBtn}${kebab}</div>` : ''}</td>
    </tr>`;
  }

  function roleBlockHtml(r, members) {
    const kind = r.osticket_kind || 'none';
    const title = TITLE_BY_CODE[r.code] || r.label || r.code;
    const badgeCls = BADGE_BY_CODE[r.code] || 'rb-admin';
    const off = members.filter(a => !a.is_active).length;
    /* v6.43 (mockup): la cabecera del bloque explica el rol en lenguaje
       llano, resume en una linea (miembros/activos/osTicket) y ofrece
       "Ver permisos" en solo lectura. Las stat-cards grandes se van: eran
       cuatro tarjetas para decir lo que ahora dice una linea. */
    const desc = DESC_BY_CODE[r.code]
      || `${kind === 'client' ? 'Alcance solo de empresas y departamentos' : 'Alcance de tiendas y empresas'}${r.readonly_scope ? ' \u00b7 solo lectura' : ''}${kind === 'agent' ? ' \u00b7 atiende tickets como agente de osTicket.' : kind === 'client' ? ' \u00b7 abre tickets como cliente de osTicket.' : ' \u00b7 sin osTicket.'}`;
    const ostMeta = kind === 'agent' ? ` \u00b7 <b>${members.filter(a => a.osticket_staff_id).length}</b> con agente osTicket`
      : kind === 'client' ? ` \u00b7 <b>${members.filter(a => a.osticket_user_id).length}</b> con cliente osTicket` : '';
    const permBtn = isMgr ? `<button class="eq-permlnk" data-pp="${r.code}" type="button">Ver permisos \u25be</button>` : '';
    const ostTh = kind === 'agent' ? '<th>osTicket (agente)</th>' : kind === 'client' ? '<th>osTicket (cliente)</th>' : '';
    const scopeTh = kind === 'client' ? '<th>Alcance (empresas)</th>' : '<th>Alcance</th>';
    const cols = kind === 'none' ? 6 : 7;
    const bodyRows = members.map(a => roleRowHtml(a, kind)).join('')
      || `<tr><td colspan="${cols}" class="empty">Sin miembros con este rol.</td></tr>`;
    return `<div class="role-block" data-eqblock="${r.code}">
      <div class="role-head" style="display:block">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="role-title">${escRoleLbl(title)}</span>
          <span class="role-badge ${badgeCls}">${escRoleLbl(r.code)}</span>
        </div>
        <div class="eq-desc">${desc}</div>
        <div class="eq-meta"><span><b>${members.length}</b> miembro${members.length === 1 ? '' : 's'} \u00b7 <b>${members.length - off}</b> activo${members.length - off === 1 ? '' : 's'}${ostMeta}</span>${permBtn}</div>
      </div>
      <div class="eq-permpanel" id="pp-${r.code}" style="display:none"></div>
      <div class="tablebox scroll-x u-compact tbl-cards"><table><thead><tr>
        <th>Usuario</th><th>Nombre</th><th>Contacto</th>${scopeTh}${ostTh}<th>Estado</th><th style="text-align:right">Acciones</th>
      </tr></thead><tbody>${bodyRows}</tbody></table></div>
      <div class="eq-empty" style="display:none">Sin coincidencias con los filtros.</div>
    </div>`;
  }

  // Un bloque por rol del catalogo (sin superadmin, que va en su fila
  // destacada). Con miembros siempre; vacio solo si es el bloque de gestores
  // de un admin no-super (su unica vista) o para que superadmin vea que el
  // rol existe cuando acaba de crearlo... criterio: superadmin ve bloques
  // CON miembros; no-super ve solo su bloque de gestores (backend ya filtra).
  // Ademas: usuarios con un rol fuera del catalogo (rol desactivado) se
  // muestran en un bloque generico para que nadie quede invisible.
  const known = new Set(roleCatalog.map(r => r.code));
  const orphanCodes = [...new Set(rows.map(a => a.role))]
    .filter(c => c && c !== 'superadmin' && !known.has(c));
  const blockDefs = roleCatalog.filter(r => r.code !== 'superadmin')
    .concat(orphanCodes.map(c => ({ code: c, label: c + ' (rol fuera de catalogo)', osticket_kind: 'none', readonly_scope: false })));
  const blocksHtml = blockDefs.map(r => {
    const members = rows.filter(a => a.role === r.code);
    if (!isMgr) {
      // Admin no-super: SOLO su bloque de gestores (visible aunque vacio).
      return r.code === 'gestor_empresa' ? roleBlockHtml(r, members) : '';
    }
    return members.length ? roleBlockHtml(r, members) : '';
  }).join('');

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Equipo</h1><p>${isMgr ? `${rows.length} miembros \u00b7 un bloque por rol, seg\u00fan el cat\u00e1logo de Roles` : `${gestoresCount} gestor${gestoresCount === 1 ? '' : 'es'} de empresa en tu alcance`}</p></div>
      ${isMgr ? `<div class="head-actions">
        ${isSuper ? `<button class="btn" id="auSyncClients" title="Crear/actualizar los gestores de empresa como clientes de osTicket">${I.sync} Gestores osTicket</button>` : ''}
        <button class="btn btn-primary" id="auNew">${I.plus} Nuevo miembro</button>
      </div>` : ''}</div>

    ${isMgr ? `<div class="eq-ctl">
      <div class="eq-search">${I.search}<input id="eqQ" placeholder="Buscar por nombre, usuario o correo\u2026" autocomplete="off"></div>
      <select class="eq-sel" id="eqRol">
        <option value="all">Rol: todos (${rows.length})</option>
        ${blockDefs.map(r => { const n = rows.filter(a => a.role === r.code).length; return n ? `<option value="${r.code}">${escRoleLbl(TITLE_BY_CODE[r.code] || r.label || r.code)} (${n})</option>` : ''; }).join('')}
      </select>
      <select class="eq-sel" id="eqSt">
        <option value="all">Estado: todos</option>
        <option value="on" selected>Solo activos</option>
        <option value="off">Solo inactivos</option>
      </select>
    </div>` : ''}

    ${isMgr ? suHtml : ''}

    ${blocksHtml}`;

  if (isMgr) {
    $('#auNew').addEventListener('click', () => auCreateModal(user));
    if (isSuper) $('#auSyncClients').addEventListener('click', () => auSyncClientsAll(user));
    /* v6.43: filtros client-side (buscador / rol / estado). La tarjeta del
       superadmin queda fuera de los filtros a proposito: siempre visible.
       Un bloque cuyo rol no coincide se oculta entero; uno sin filas tras
       filtrar muestra "Sin coincidencias". */
    const applyEqFilters = () => {
      const q = ($('#eqQ').value || '').trim().toLowerCase();
      const rol = $('#eqRol').value;
      const st = $('#eqSt').value;
      document.querySelectorAll('[data-eqblock]').forEach(b => {
        const rolOk = rol === 'all' || b.dataset.eqblock === rol;
        let vis = 0;
        b.querySelectorAll('tr[data-eqrow]').forEach(tr => {
          const on = tr.dataset.on === '1';
          const ok = (st === 'all' || (st === 'on' && on) || (st === 'off' && !on))
            && (!q || (tr.dataset.txt || '').includes(q));
          tr.style.display = ok ? '' : 'none';
          if (ok) vis++;
        });
        b.style.display = rolOk ? '' : 'none';
        const en = b.querySelector('.eq-empty');
        if (en) en.style.display = (rolOk && !vis && b.querySelector('tr[data-eqrow]')) ? '' : 'none';
      });
    };
    $('#eqQ').addEventListener('input', applyEqFilters);
    $('#eqRol').addEventListener('change', applyEqFilters);
    $('#eqSt').addEventListener('change', applyEqFilters);
    applyEqFilters();
    // v6.43: "Ver permisos" de cada bloque (matriz viva, solo lectura).
    document.querySelectorAll('.eq-permlnk').forEach(btn =>
      btn.addEventListener('click', () => eqTogglePermPanel(user, btn)));
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
    <label class="flabel">Teléfono <span class="muted">(opcional · para enviarle sus datos por WhatsApp)</span></label><input id="auT" placeholder="ej. 0414-1234567" style="margin-bottom:12px">
    <label class="flabel">Rol</label>
    <select id="auR" style="margin-bottom:14px;width:100%">${adminRoleOptionsHtml('admin', user.role !== 'superadmin')}</select>
    ${pwdBlockHtml()}
    <p id="auNewErr" style="color:var(--danger);font-size:12.5px;margin:10px 0 0;display:none"></p>
    <div class="modal-actions"><button class="btn" id="mCancel">Cancelar</button><button class="btn btn-primary" id="mOk">Crear</button></div>`);
  wirePwdBlock();
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const pw = readPwd();
    const d = await auApi({ action: 'create', adminId: user.id,
      username: $('#auU').value, name: $('#auN').value, email: $('#auE').value || null,
      phone: $('#auT').value || null,   // v5.07
      role: $('#auR').value, ...pw });
    if (!d.ok) { modalErrAu('#auNewErr', d.error); return; }
    /* v5.10: la clave ya NO se muestra con un alert(). Va al modal de
       credenciales, que la deja copiar (sola o con el usuario y el link) y
       ofrece mandarsela por WhatsApp. Al cerrar, se repinta Equipo. */
    const pwd = d.tempPassword || pw.password;
    if (d.id && pwd) {
      credModal(user, {
        id: d.id, kind: 'portal', password: pwd, useTemp: !!pw.useTemp,
        title: 'Miembro creado',
        okText: `Se creó el usuario de ${$('#auN').value.trim() || $('#auU').value.trim()}`,
        onClose: () => viewEquipo(user),
      });
      return;
    }
    closeModal();
    viewEquipo(user);
  });
}
function auAction(ds, user) {
  // v6.43: la fila de Equipo ya no tiene Tiendas/Empresas/⚡ sueltos: un solo
  // boton Alcance abre la pagina unificada del miembro.
  if (ds.act === 'alcance') {
    renderAlcancePage(user, { id: ds.id, username: ds.u, name: ds.name || ds.u, role: ds.role || '', kind: ds.kind || 'agent' });
    return;
  }
  if (ds.act === 'scope-store') { openScopeEditor(user, ds.id, ds.u, 'store', 'equipo'); return; }
  if (ds.act === 'scope-ent') { openScopeEditor(user, ds.id, ds.u, 'enterprise', 'equipo'); return; }
  if (ds.act === 'role') { auRoleModal(ds, user); return; }
  if (ds.act === 'edit') { auEditModal(ds, user); return; }   // v5.07
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
    <p id="auRstErr" style="color:var(--danger);font-size:12.5px;margin:10px 0 0;display:none"></p>
    <div class="modal-actions"><button class="btn" id="mCancel">Cancelar</button><button class="btn btn-primary" id="mOk">Resetear</button></div>`);
  wirePwdBlock();
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const pw = readPwd();
    const d = await auApi({ action: 'reset', adminId: user.id, id: ds.id, ...pw });
    if (!d.ok) { modalErrAu('#auRstErr', d.error); return; }
    // v5.10: la clave nueva va al modal de credenciales, no a un alert().
    const pwd = d.tempPassword || pw.password;
    if (pwd) {
      credModal(user, {
        id: ds.id, kind: 'portal', password: pwd, useTemp: !!pw.useTemp,
        title: 'Contraseña reseteada',
        okText: `Se cambió la clave de ${ds.name || ds.u}`,
        onClose: () => viewEquipo(user),
      });
      return;
    }
    closeModal();
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
    ${pwdBlockHtml('osticket')}
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
      agentCredsModal(user, r, meta.username, () => viewEquipo(user), meta.id);
    } else {
      // Flujo de creacion desde guardar alcance: delega en onDone.
      if (onDone) onDone(creds);
    }
  });
}

/* Credenciales del agente de osTicket (reset directo desde Equipo).
   v5.10: pasa a usar credModal, la misma pieza que las credenciales del portal.
   Antes tenia su propio modal, que ademas decia "Debera cambiar la clave al
   entrar": eso NO es cierto para osTicket (v5.08 solo intercepta el login del
   PORTAL; osTicket no fuerza nada). credModal avisa lo contrario, que es lo
   que realmente pasa: esa clave no vence. */
function agentCredsModal(user, r, targetUser, done, memberId) {
  const credUser = r.agent_username || targetUser;
  credModal(user, {
    // El id del miembro no viene en la respuesta del reset: lo pasa el llamador
    // (meta.id). Sin el, credModal no puede resolver el mensaje.
    id: memberId || r.admin_id || null,
    kind: 'osticket',
    password: r.temp_password || '',
    osticketUser: credUser,
    title: 'Agente osTicket listo',
    okText: `Agente ${r.agent_created ? 'creado' : 'actualizado'}${r.staff_id ? ` (#${r.staff_id})` : ''}`,
    onClose: done,
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
/* v5.07: editar los datos de CONTACTO de un miembro (nombre, correo, telefono).
   Hasta ahora el correo y el nombre solo se podian poner AL CREAR: si un miembro
   ya existia, no habia forma de cargarle el telefono (que es lo que necesita el
   envio de credenciales por WhatsApp). El rol y la clave siguen teniendo sus
   propios botones (Rol / Resetear): aca no se tocan. */
function auEditModal(ds, user) {
  openModal(`
    <div class="modal-head"><span>Editar datos</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${ds.u}</p>
    <label class="flabel">Nombre</label><input id="aeN" placeholder="Nombre completo" style="margin-bottom:12px">
    <label class="flabel">Correo <span class="muted">(opcional)</span></label><input id="aeE" placeholder="correo@grupocanaima.com" style="margin-bottom:12px">
    <label class="flabel">Teléfono <span class="muted">(opcional · para enviarle sus datos por WhatsApp)</span></label><input id="aeT" placeholder="ej. 0414-1234567" style="margin-bottom:4px">
    <p id="auEditErr" style="color:var(--danger);font-size:12.5px;margin:10px 0 0;display:none"></p>
    <div class="modal-actions" style="margin-top:14px">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Guardar</button>
    </div>`);
  $('#aeN').value = ds.name || '';
  $('#aeE').value = ds.mail || '';
  $('#aeT').value = ds.tel || '';
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const err = $('#auEditErr');
    const btn = $('#mOk');
    btn.disabled = true; btn.textContent = 'Guardando…';
    let d;
    try {
      d = await auApi({ action: 'update_contact', adminId: user.id, id: ds.id,
        name: $('#aeN').value, email: $('#aeE').value || null, phone: $('#aeT').value || null });
    } catch (e) { d = { ok: false, error: 'Error de conexion: ' + ((e && e.message) || e) }; }
    if (!d || !d.ok) {
      btn.disabled = false; btn.textContent = 'Guardar';
      err.textContent = (d && d.error) || 'No se pudo guardar.';
      err.style.display = '';
      return;
    }
    closeModal();
    viewEquipo(user);
  });
}

/* ================= v5.10: MODAL DE CREDENCIALES =================
   Mockup aprobado: _PRUEBAS/equipo_credenciales_mockup.html (v0-mock1).

   Reemplaza los alert() con los que hasta ahora se mostraba la clave recien
   generada. El alert era pobre de verdad: no se podia copiar comodo, no decia
   el usuario ni el link, y si lo cerrabas sin anotar la clave, se perdia (habia
   que resetear de nuevo).

   Ahora: ficha con usuario / clave / enlace (copiables uno a uno o todo junto),
   el aviso que corresponda segun la clave CADUQUE o no, y el envio por WhatsApp
   con el texto de WhatsApp > Mensajes, mostrado ANTES de mandarlo.

   opts = { id, kind:'portal'|'osticket', password, useTemp, osticketUser,
            title, okText, onClose } */
async function credModal(user, opts) {
  openModal(`
    <div class="modal-head"><span>${esc(opts.title || 'Credenciales')}</span><button class="modal-x" id="mX">✕</button></div>
    <div id="crBody"><p class="muted" style="font-size:12.5px">Cargando…</p></div>`);

  const close = () => { closeModal(); if (opts.onClose) opts.onClose(); };
  $('#mX').addEventListener('click', close);

  const d = await auApi({
    action: 'cred_preview', adminId: user.id,
    id: opts.id, kind: opts.kind, password: opts.password,
    useTemp: !!opts.useTemp, osticketUser: opts.osticketUser || null,
  });

  if (!d || !d.ok) {
    // Si algo falla, al menos NO perder la clave: se muestra igual.
    $('#crBody').innerHTML = `
      <p style="color:var(--danger);font-size:12.5px;margin:0 0 12px">${esc((d && d.error) || 'No se pudo preparar el mensaje.')}</p>
      <p style="font-size:13px;margin:0 0 14px">Clave: <b style="font-family:ui-monospace,monospace">${esc(opts.password || '')}</b></p>
      <div class="modal-actions"><button class="btn btn-primary" id="crClose">Cerrar</button></div>`;
    $('#crClose').addEventListener('click', close);
    return;
  }

  const m = d.member;
  const isOst = d.kind === 'osticket';
  const uname = isOst ? (m.osticket_usuario || m.username) : m.username;

  /* El aviso depende de si la clave CADUCA. Tres situaciones distintas y no
     conviene mentir en ninguna:
       - portal + temporal -> caduca al primer ingreso (v5.08). Es el buen caso.
       - portal + fija     -> no caduca. Ademas el server NO la manda por WA.
       - osTicket          -> nunca caduca (osTicket no fuerza el cambio). */
  let note;
  if (isOst) {
    note = `<div class="cr-note fija"><span>⚠️</span><div>Esta clave de osTicket <b>no vence</b> y el sistema no le va a pedir que la cambie. Cópiala y entrégala por un medio seguro.</div></div>`;
  } else if (d.temp) {
    note = `<div class="cr-note temp"><span>🔒</span><div>Es una <b>clave temporal</b>: al entrar por primera vez, el portal le va a exigir que defina una propia. Después de eso, esta deja de servir.</div></div>`;
  } else {
    note = `<div class="cr-note fija"><span>⚠️</span><div>Esta clave <b>no caduca</b>: la persona la va a poder usar indefinidamente. Cópiala y entrégala por un medio seguro.</div></div>`;
  }

  /* v6.55 SOLO GRUPOS: el envio de credenciales por WhatsApp fue
     descontinuado (la linea solo publica en grupos, no a numeros
     particulares). El modal sigue MOSTRANDO usuario/clave/enlace para
     copiarlos y entregarlos por el medio que corresponda; solo se retira el
     boton "Enviar por WhatsApp" y su vista previa. Forzar canWa=false apaga
     ambos de un solo lugar. */
  const canWa = false;
  /* v6.55: sin envio por WhatsApp, no se muestra ni el aviso de "sin
     telefono" ni la vista previa del mensaje. El modal queda enfocado en
     mostrar la clave para copiarla. */
  const waBox = '';

  $('#crBody').innerHTML = `
    <div class="cr-ok">✓ ${esc(opts.okText || 'Listo')}</div>

    <div class="cr-card">
      <div class="cr-r"><span class="k">Sistema</span><span class="v">${isOst ? '🎫 Sistema de tickets' : '🔑 Portal de Nómina'}</span></div>
      <div class="cr-r"><span class="k">Nombre</span><span class="v">${esc(m.name)}<span class="muted" style="font-weight:400"> · ${esc(m.rol)}</span></span></div>
      <div class="cr-r"><span class="k">Enlace</span><span class="v" style="font-size:12.5px">${esc(d.link || '—')}</span>${d.link ? `<button class="cr-cp" data-c="${esc(d.link)}">Copiar</button>` : ''}</div>
      <div class="cr-r"><span class="k">Usuario</span><span class="v mono">${esc(uname)}</span><button class="cr-cp" data-c="${esc(uname)}">Copiar</button></div>
      <div class="cr-r pw"><span class="k">Clave</span><span class="v mono">${esc(opts.password || '')}</span><button class="cr-cp" data-c="${esc(opts.password || '')}">Copiar</button></div>
    </div>

    ${note}
    ${waBox}
    <p id="crErr" style="color:var(--danger);font-size:12.5px;margin:12px 0 0;display:none"></p>

    <div class="modal-actions" style="margin-top:16px">
      <button class="btn" id="crCopyAll">📋 Copiar todo</button>
      <span style="flex:1"></span>
      <button class="btn" id="crClose">Cerrar</button>
      ${canWa && m.phone ? '<button class="btn btn-wa" id="crWa">Enviar por WhatsApp</button>' : ''}
    </div>`;

  // Copiar todo: incluye nombre y rol (pedido de Pablo), para poder pegarlo
  // en un correo o un chat y que se entienda de quien es sin escribir nada mas.
  const allText = [
    isOst ? 'Sistema de tickets' : 'Portal de Nómina',
    `${m.name} · ${m.rol}`,
    `Enlace: ${d.link || ''}`,
    `Usuario: ${uname}`,
    `Clave: ${opts.password || ''}`,
  ].join('\n');

  const flash = (btn, txt) => {
    const o = btn.textContent;
    btn.textContent = txt;
    setTimeout(() => { btn.textContent = o; }, 1400);
  };
  document.querySelectorAll('.cr-cp').forEach(b =>
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.c).then(() => flash(b, '✓')).catch(() => flash(b, '✗'));
    }));
  $('#crCopyAll').addEventListener('click', () => {
    const b = $('#crCopyAll');
    navigator.clipboard.writeText(allText).then(() => flash(b, '✓ Copiado')).catch(() => flash(b, 'No se pudo copiar'));
  });
  $('#crClose').addEventListener('click', close);

  const wa = $('#crWa');
  if (wa) wa.addEventListener('click', async () => {
    const err = $('#crErr');
    err.style.display = 'none';
    wa.disabled = true;
    wa.textContent = 'Enviando…';
    const r = await auApi({
      action: 'cred_whatsapp', adminId: user.id,
      id: opts.id, kind: opts.kind, password: opts.password,
      useTemp: !!opts.useTemp, osticketUser: opts.osticketUser || null,
    });
    if (!r || !r.ok) {
      wa.disabled = false;
      wa.textContent = 'Enviar por WhatsApp';
      err.textContent = (r && r.error) || 'No se pudo enviar.';
      err.style.display = '';
      return;
    }
    wa.textContent = '✓ Enviado';
    const box = document.querySelector('.cr-wa');
    if (box) box.outerHTML = `<div class="cr-sent">✓ Mensaje enviado a ${esc(r.phone || '')}</div>`;
  });
}

function auRoleModal(ds, user) {
  // Roles desde la BD (cache ADMIN_ROLES, cargado al entrar a Equipo).
  // superadmin no es elegible aqui (se excluye). v6.42: 'coordinador' solo
  // lo asigna el superadmin (el backend lo rechaza para otros).
  const ROLE_OPTS = (ADMIN_ROLES || ADMIN_ROLES_FALLBACK)
    .filter(r => r.code !== 'superadmin')
    .filter(r => user.role === 'superadmin' || r.code !== 'coordinador')
    .map(r => ({ v: r.code, l: r.label }));
  const cur = ds.role || '';
  const opts = ROLE_OPTS.map(o =>
    `<option value="${o.v}"${o.v === cur ? ' selected' : ''}>${o.l}</option>`).join('');
  openModal(`
    <div class="modal-head"><span>Cambiar rol</span><button class="modal-x" id="mX">\u2715</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${ds.u}</p>
    <label class="flabel">Rol</label>
    <select id="auRoleSel" style="width:100%;margin-bottom:8px">${opts}</select>
    <p class="muted" style="font-size:11.5px;margin:0">Rol actual: <b>${roleLabelOf(cur) || '\u2014'}</b>. El superadmin no se asigna desde aqui.</p>
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

/* ============================ v6.46 ============================
   ARBOL Zona ▸ Subzona ▸ tienda para la pestaña Tiendas del Alcance.
   Sustituye la UI "incluidos − excluidos" SOLO en modo Tiendas embebido.
   NO cambia el modelo ni el guardado: opera sobre SCOPE.include/exclude
   (los mismos arrays que saveScope envia a /api/admin-scope). La semantica
   es identica a addScope/removeScope/estimateScope:
     - marcar una zona/subzona la INCLUYE; desmarcar una tienda dentro de un
       nivel incluido la EXCLUYE (exclude company).
     - el checkbox de zona/subzona refleja el estado agregado de sus tiendas
       (todas dentro = marcado; ninguna = vacio; mezcla = indeterminado).
   Aprobado en _PRUEBAS/arbol_tiendas_borrador.html. */
const SCOPE_TREE = { expanded: new Set(), q: '' };

function sctIndexes() {
  const byZone = {}, bySub = {}, subByZone = {};
  // Universo = tiendas activas (mismo criterio que estimateScope en modo Tiendas).
  (SCOPE.companies || []).filter(c => c.is_active && !NON_STORE_TYPES.has(c.company_type)).forEach(c => {
    (byZone[c.zone_id] = byZone[c.zone_id] || []).push(c);
    (bySub[c.subzone_id] = bySub[c.subzone_id] || []).push(c);
  });
  (SCOPE.subzones || []).forEach(s => { (subByZone[s.zone_id] = subByZone[s.zone_id] || []).push(s); });
  const zones = (SCOPE.zones || []).filter(z => (byZone[z.id] || []).length);
  return { byZone, bySub, subByZone, zones };
}

// Conjunto EFECTIVO de company_codes (include − exclude), igual que estimateScope.
function sctEffective(ix) {
  const inSet = new Set();
  SCOPE.include.forEach(x => {
    if (x.scope_type === 'zone') (ix.byZone[x.scope_value] || []).forEach(c => inSet.add(c.company_code));
    else if (x.scope_type === 'subzone') (ix.bySub[x.scope_value] || []).forEach(c => inSet.add(c.company_code));
    else if (x.scope_type === 'company') inSet.add(x.scope_value);
  });
  SCOPE.exclude.forEach(x => {
    if (x.scope_type === 'zone') (ix.byZone[x.scope_value] || []).forEach(c => inSet.delete(c.company_code));
    else if (x.scope_type === 'subzone') (ix.bySub[x.scope_value] || []).forEach(c => inSet.delete(c.company_code));
    else if (x.scope_type === 'company') inSet.delete(x.scope_value);
  });
  return inSet;
}
function sctLevelState(companies, eff) {
  let on = 0; companies.forEach(c => { if (eff.has(c.company_code)) on++; });
  return on === 0 ? 'none' : (on === companies.length ? 'all' : 'some');
}
function sctHas(list, type, val) { return list.some(x => x.scope_type === type && String(x.scope_value) === String(val)); }
function sctDel(list, type, val) { const i = list.findIndex(x => x.scope_type === type && String(x.scope_value) === String(val)); if (i >= 0) list.splice(i, 1); }
function sctAdd(list, type, val) { if (!sctHas(list, type, val)) list.push({ scope_type: type, scope_value: String(val) }); }

function sctToggleTienda(code, checked) {
  const ix = sctIndexes();
  const isIn = sctEffective(ix).has(code);
  if (checked && !isIn) {
    sctDel(SCOPE.exclude, 'company', code);
    if (!sctEffective(ix).has(code)) sctAdd(SCOPE.include, 'company', code);
  } else if (!checked && isIn) {
    sctDel(SCOPE.include, 'company', code);
    sctAdd(SCOPE.exclude, 'company', code);
  }
  renderTiendasTree();
}
function sctSetLevel(kind, id, companies, checked) {
  const ix = sctIndexes();
  companies.forEach(c => { sctDel(SCOPE.include, 'company', c.company_code); sctDel(SCOPE.exclude, 'company', c.company_code); });
  if (kind === 'subzone') {
    sctDel(SCOPE.include, 'subzone', id); sctDel(SCOPE.exclude, 'subzone', id);
    const sz = (SCOPE.subzones || []).find(s => s.id === id);
    if (checked) {
      if (!(sz && sctHas(SCOPE.include, 'zone', sz.zone_id))) sctAdd(SCOPE.include, 'subzone', id);
    } else if (sz && sctHas(SCOPE.include, 'zone', sz.zone_id)) {
      companies.forEach(c => sctAdd(SCOPE.exclude, 'company', c.company_code));
    }
  } else {
    sctDel(SCOPE.include, 'zone', id); sctDel(SCOPE.exclude, 'zone', id);
    (ix.subByZone[id] || []).forEach(s => { sctDel(SCOPE.include, 'subzone', s.id); sctDel(SCOPE.exclude, 'subzone', s.id); });
    if (checked) sctAdd(SCOPE.include, 'zone', id);
  }
  renderTiendasTree();
}

function sctMatch(q, ...txts) { if (!q) return true; return txts.join(' ').toLowerCase().includes(q); }

// Monta el arbol dentro de #sctHost (creado por openScopeEditor en modo Tiendas).
function renderTiendasTree() {
  const host = document.getElementById('sctHost');
  if (!host) return;
  const ix = sctIndexes();
  const eff = sctEffective(ix);
  const q = (SCOPE_TREE.q || '').trim().toLowerCase();
  const zActivas = ix.zones.filter(z => (ix.byZone[z.id] || []).some(c => eff.has(c.company_code))).length;
  const excN = SCOPE.exclude.filter(x => x.scope_type === 'company' && !NON_STORE_TYPES.has((SCOPE.companies.find(c => c.company_code === x.scope_value) || {}).company_type)).length;
  const sumHtml = `Resumen: <b>${zActivas} zona${zActivas === 1 ? '' : 's'} \u00b7 ${eff.size} tienda${eff.size === 1 ? '' : 's'}</b>`
    + (excN ? ` \u00b7 <b class="exc">\u2212${excN} exclusi\u00f3n${excN === 1 ? '' : 'es'}</b>` : '');

  const ck = (state) => `<input type="checkbox" ${state === 'all' ? 'checked' : ''} data-ind="${state === 'some' ? '1' : ''}">`;
  let rows = '';
  ix.zones.forEach(z => {
    const zComps = ix.byZone[z.id] || [];
    const subs = (ix.subByZone[z.id] || []).filter(s => (ix.bySub[s.id] || []).length).sort((a, b) => a.name.localeCompare(b.name));
    const zoneMatch = sctMatch(q, z.name);
    const anyChild = q ? (subs.some(s => sctMatch(q, s.name)) || zComps.some(c => sctMatch(q, c.company_code, c.business_name))) : true;
    if (q && !zoneMatch && !anyChild) return;
    const open = q ? true : SCOPE_TREE.expanded.has(z.id);
    const excZ = zComps.filter(c => sctHas(SCOPE.exclude, 'company', c.company_code)).length;
    rows += `<div class="zrow" data-lvl="zone" data-id="${z.id}">
      <span class="toggle" data-tgl="${z.id}">${open ? '\u25be' : '\u25b8'}</span>
      ${ck(sctLevelState(zComps, eff))}
      <span class="zn">${escRoleLbl(z.name)}</span>${excZ ? `<span class="minus">\u2212${excZ}</span>` : ''}
      <span class="zc">${subs.length} subzona${subs.length === 1 ? '' : 's'} \u00b7 ${zComps.length} tienda${zComps.length === 1 ? '' : 's'}</span></div>`;
    if (!open) return;
    subs.forEach(s => {
      const sComps = ix.bySub[s.id] || [];
      const subMatch = sctMatch(q, s.name);
      const anyT = q ? sComps.some(c => sctMatch(q, c.company_code, c.business_name)) : true;
      if (q && !zoneMatch && !subMatch && !anyT) return;
      const sOpen = q ? (subMatch || anyT) : SCOPE_TREE.expanded.has(s.id);
      const excS = sComps.filter(c => sctHas(SCOPE.exclude, 'company', c.company_code)).length;
      rows += `<div class="zrow child" data-lvl="subzone" data-id="${s.id}">
        <span class="toggle" data-tgl="${s.id}">${sOpen ? '\u25be' : '\u25b8'}</span>
        ${ck(sctLevelState(sComps, eff))}
        <span class="zn">${escRoleLbl(s.name)}</span>${excS ? `<span class="minus">\u2212${excS}</span>` : ''}
        <span class="zc">${sComps.length} tienda${sComps.length === 1 ? '' : 's'}</span></div>`;
      if (!sOpen) return;
      sComps.slice().sort((a, b) => a.company_code.localeCompare(b.company_code)).forEach(c => {
        if (q && !zoneMatch && !subMatch && !sctMatch(q, c.company_code, c.business_name)) return;
        const on = eff.has(c.company_code);
        rows += `<div class="zrow child2 tienda${on ? '' : ' excl'}" data-lvl="tienda">
          <span class="toggle"></span>
          <input type="checkbox" ${on ? 'checked' : ''} data-ck-t="${c.company_code}">
          <span class="tcode">${c.company_code}</span> \u00b7 <span class="tname">${escRoleLbl(c.business_name || '')}</span>
          ${on ? '' : '<span class="badge-exc">excluida</span>'}</div>`;
      });
    });
  });

  host.innerHTML = `
    <div class="sctree-tools">
      <div class="search">${I.search}<input id="sctQ" placeholder="Filtrar zona, subzona o tienda\u2026" autocomplete="off" value="${(SCOPE_TREE.q || '').replace(/"/g, '&quot;')}"></div>
      <button class="btn btn-mini" id="sctMark">Marcar todo</button>
      <button class="btn btn-mini" id="sctClear">Desmarcar todo</button>
      <button class="btn btn-mini" id="sctExp">Expandir</button>
      <button class="btn btn-mini" id="sctCol">Colapsar</button>
    </div>
    <div class="sctree-sum">${sumHtml}</div>
    <div class="sctree">${rows || '<div style="padding:14px;color:var(--muted,#64748b);font-size:12.5px">Sin coincidencias.</div>'}</div>`;

  host.querySelectorAll('.sctree input[type=checkbox][data-ind="1"]').forEach(c => c.indeterminate = true);
  const qi = document.getElementById('sctQ');
  if (qi) qi.addEventListener('input', () => { SCOPE_TREE.q = qi.value; renderTiendasTree(); });
  host.querySelectorAll('[data-tgl]').forEach(t => t.addEventListener('click', () => {
    const id = t.dataset.tgl; if (SCOPE_TREE.expanded.has(id)) SCOPE_TREE.expanded.delete(id); else SCOPE_TREE.expanded.add(id);
    renderTiendasTree();
  }));
  host.querySelectorAll('input[data-ck-t]').forEach(c => c.addEventListener('change', () => sctToggleTienda(c.dataset.ckT, c.checked)));
  host.querySelectorAll('[data-lvl="zone"]').forEach(row => {
    const c = row.querySelector('input[type=checkbox]'); const id = row.dataset.id;
    if (c) c.addEventListener('change', () => sctSetLevel('zone', id, ix.byZone[id] || [], c.checked));
  });
  host.querySelectorAll('[data-lvl="subzone"]').forEach(row => {
    const c = row.querySelector('input[type=checkbox]'); const id = row.dataset.id;
    if (c) c.addEventListener('change', () => sctSetLevel('subzone', id, ix.bySub[id] || [], c.checked));
  });
  document.getElementById('sctMark')?.addEventListener('click', () => {
    // Marcar todo = incluir todas las zonas con tiendas; limpia excludes/company sueltos de tiendas.
    ix.zones.forEach(z => sctAdd(SCOPE.include, 'zone', z.id));
    SCOPE.include = SCOPE.include.filter(x => !(x.scope_type === 'company' && !NON_STORE_TYPES.has((SCOPE.companies.find(c => c.company_code === x.scope_value) || {}).company_type)));
    SCOPE.exclude = SCOPE.exclude.filter(x => !(x.scope_type === 'company' && !NON_STORE_TYPES.has((SCOPE.companies.find(c => c.company_code === x.scope_value) || {}).company_type)) && x.scope_type !== 'zone' && x.scope_type !== 'subzone');
    renderTiendasTree();
  });
  document.getElementById('sctClear')?.addEventListener('click', () => {
    // Desmarcar todo = quitar todo el alcance de TIENDAS (deja intacto Empresas).
    SCOPE.include = SCOPE.include.filter(x => !sctIsStoreScope(x));
    SCOPE.exclude = SCOPE.exclude.filter(x => !sctIsStoreScope(x));
    renderTiendasTree();
  });
  document.getElementById('sctExp')?.addEventListener('click', () => { ix.zones.forEach(z => SCOPE_TREE.expanded.add(z.id)); (SCOPE.subzones || []).forEach(s => SCOPE_TREE.expanded.add(s.id)); renderTiendasTree(); });
  document.getElementById('sctCol')?.addEventListener('click', () => { SCOPE_TREE.expanded.clear(); renderTiendasTree(); });
}

// ¿Este item de alcance pertenece al mundo TIENDAS? (zona/subzona siempre;
// company solo si es tienda). Empresas/departamentos no se tocan aqui.
function sctIsStoreScope(x) {
  if (x.scope_type === 'zone' || x.scope_type === 'subzone') return true;
  if (x.scope_type === 'department') return false;
  if (x.scope_type === 'company') { const c = SCOPE.companies.find(c => c.company_code === x.scope_value); return !c || !NON_STORE_TYPES.has(c.company_type); }
  return false;
}

/* ============================ v6.47 ============================
   ARBOL Empresa ▸ departamentos para la pestaña Empresas del Alcance.
   Misma logica que Tiendas, en 2 niveles. Opera sobre SCOPE.include
   (aqui exclude no se usa: acotar = incluir solo ciertos deptos):
     - empresa marcada entera -> include company (toda la empresa).
     - empresa acotada        -> include department por cada depto marcado.
     - marcar TODOS los deptos de una empresa colapsa a include company.
   El backend cuenta por empresa; department restringe el personal a ese
   depto de la empresa duena. Muestra empresas no-tienda AUNQUE esten
   inactivas (igual que el editor viejo: filtra por NON_STORE_TYPES, no por
   is_active). Aprobado en _PRUEBAS/arbol_empresas_borrador.html. */
const EMP_TREE = { expanded: new Set(), q: '' };

function sceCompanies() {
  return (SCOPE.companies || []).filter(c => NON_STORE_TYPES.has(c.company_type))
    .slice().sort((a, b) => (a.company_type + a.company_code).localeCompare(b.company_type + b.company_code));
}
function sceDepts(cc) { return (SCOPE.departments || []).filter(d => String(d.company_code) === String(cc)); }
function sceHas(type, val) { return SCOPE.include.some(x => x.scope_type === type && String(x.scope_value) === String(val)); }
function sceAdd(type, val) { if (!sceHas(type, val)) SCOPE.include.push({ scope_type: type, scope_value: String(val) }); }
function sceDel(type, val) { const i = SCOPE.include.findIndex(x => x.scope_type === type && String(x.scope_value) === String(val)); if (i >= 0) SCOPE.include.splice(i, 1); }

// Estado del checkbox de una empresa: 'all' | 'some' | 'none'.
function sceCompState(cc) {
  if (sceHas('company', cc)) return 'all';
  const deps = sceDepts(cc);
  const marked = deps.filter(d => sceHas('department', d.id)).length;
  if (marked === 0) return 'none';
  if (deps.length && marked === deps.length) return 'all';
  return 'some';
}
function sceDeptChecked(cc, id) { return sceHas('company', cc) ? true : sceHas('department', id); }

function sceToggleCompany(cc, checked) {
  sceDel('company', cc);
  sceDepts(cc).forEach(d => sceDel('department', d.id));
  if (checked) sceAdd('company', cc);
  renderEmpresasTree();
}
function sceToggleDept(cc, id, checked) {
  const deps = sceDepts(cc);
  if (sceHas('company', cc)) {
    // estaba completa: pasar a modo deptos (todos menos el que se desmarca)
    sceDel('company', cc);
    deps.forEach(d => { if (String(d.id) !== String(id)) sceAdd('department', d.id); });
    if (checked) sceAdd('department', id); else sceDel('department', id);
  } else {
    if (checked) sceAdd('department', id); else sceDel('department', id);
  }
  // si quedaron TODOS marcados, colapsar a company completa
  const marked = deps.filter(d => sceHas('department', d.id)).length;
  if (deps.length && marked === deps.length) { deps.forEach(d => sceDel('department', d.id)); sceAdd('company', cc); }
  renderEmpresasTree();
}

function renderEmpresasTree() {
  const host = document.getElementById('sceHost');
  if (!host) return;
  const comps = sceCompanies();
  const q = (EMP_TREE.q || '').trim().toLowerCase();
  const empN = comps.filter(c => sceCompState(c.company_code) !== 'none').length;
  let deptGrant = 0;
  comps.forEach(c => {
    const st = sceCompState(c.company_code), deps = sceDepts(c.company_code);
    if (st === 'all') deptGrant += (deps.length || 0);
    else if (st === 'some') deptGrant += deps.filter(d => sceHas('department', d.id)).length;
  });
  const sumHtml = `Resumen: <b>${empN} empresa${empN === 1 ? '' : 's'}</b>` + (deptGrant ? ` \u00b7 <b>${deptGrant} departamento${deptGrant === 1 ? '' : 's'} con acceso</b>` : '');

  const ck = (state) => `<input type="checkbox" ${state === 'all' ? 'checked' : ''} data-ind="${state === 'some' ? '1' : ''}">`;
  const match = (qq, ...t) => !qq || t.join(' ').toLowerCase().includes(qq);
  let rows = '';
  comps.forEach(c => {
    const cc = c.company_code, deps = sceDepts(cc).slice().sort((a, b) => a.name.localeCompare(b.name));
    const compMatch = match(q, cc, c.business_name, c.company_type);
    const anyDept = q ? deps.some(d => match(q, d.name)) : true;
    if (q && !compMatch && !anyDept) return;
    const st = sceCompState(cc);
    const open = q ? true : EMP_TREE.expanded.has(cc);
    const hasDeps = deps.length > 0;
    const grantTxt = st === 'all' ? (hasDeps ? `todos los ${deps.length} deptos` : 'acceso completo')
      : st === 'some' ? `${deps.filter(d => sceHas('department', d.id)).length} de ${deps.length} deptos`
        : (hasDeps ? `${deps.length} deptos` : 'sin departamentos');
    rows += `<div class="zrow empresa" data-lvl="empresa" data-cc="${cc}">
      <span class="toggle" data-tgl="${hasDeps ? cc : ''}">${hasDeps ? (open ? '\u25be' : '\u25b8') : ''}</span>
      ${ck(st)}
      <span class="ecode">${cc}</span> <span class="zn">${escRoleLbl(c.business_name || '')}</span>
      <span class="etype">${escRoleLbl(c.company_type || '')}</span>
      <span class="zc">${grantTxt}</span></div>`;
    if (hasDeps && open) {
      deps.forEach(d => {
        if (q && !compMatch && !match(q, d.name)) return;
        rows += `<div class="zrow dept" data-lvl="dept">
          <span class="toggle"></span>
          <input type="checkbox" ${sceDeptChecked(cc, d.id) ? 'checked' : ''} data-cc="${cc}" data-did="${d.id}">
          <span class="dname">${escRoleLbl(d.name || '')}</span></div>`;
      });
    }
  });

  host.innerHTML = `
    <div class="sctree-tools">
      <div class="search">${I.search}<input id="sceQ" placeholder="Filtrar empresa o departamento\u2026" autocomplete="off" value="${(EMP_TREE.q || '').replace(/"/g, '&quot;')}"></div>
      <button class="btn btn-mini" id="sceMark">Marcar todo</button>
      <button class="btn btn-mini" id="sceClear">Desmarcar todo</button>
      <button class="btn btn-mini" id="sceExp">Expandir</button>
      <button class="btn btn-mini" id="sceCol">Colapsar</button>
    </div>
    <div class="sctree-sum">${sumHtml}</div>
    <div class="sctree">${rows || '<div style="padding:14px;color:var(--muted,#64748b);font-size:12.5px">Sin coincidencias.</div>'}</div>`;

  host.querySelectorAll('.sctree input[type=checkbox][data-ind="1"]').forEach(c => c.indeterminate = true);
  const qi = document.getElementById('sceQ');
  if (qi) qi.addEventListener('input', () => { EMP_TREE.q = qi.value; renderEmpresasTree(); });
  host.querySelectorAll('[data-tgl]').forEach(t => t.addEventListener('click', () => {
    const id = t.dataset.tgl; if (!id) return;
    if (EMP_TREE.expanded.has(id)) EMP_TREE.expanded.delete(id); else EMP_TREE.expanded.add(id);
    renderEmpresasTree();
  }));
  host.querySelectorAll('[data-lvl="empresa"]').forEach(row => {
    const c = row.querySelector('input[type=checkbox]'); const cc = row.dataset.cc;
    if (c) c.addEventListener('change', () => sceToggleCompany(cc, c.checked));
  });
  host.querySelectorAll('input[data-did]').forEach(c => c.addEventListener('change', () => sceToggleDept(c.dataset.cc, c.dataset.did, c.checked)));
  document.getElementById('sceMark')?.addEventListener('click', () => {
    // limpiar todo lo de EMPRESAS (company no-tienda + department) y marcar todas enteras
    SCOPE.include = SCOPE.include.filter(x => !sceIsEntScope(x));
    comps.forEach(c => sceAdd('company', c.company_code));
    renderEmpresasTree();
  });
  document.getElementById('sceClear')?.addEventListener('click', () => {
    SCOPE.include = SCOPE.include.filter(x => !sceIsEntScope(x));
    SCOPE.exclude = SCOPE.exclude.filter(x => !sceIsEntScope(x));
    renderEmpresasTree();
  });
  document.getElementById('sceExp')?.addEventListener('click', () => { comps.forEach(c => { if (sceDepts(c.company_code).length) EMP_TREE.expanded.add(c.company_code); }); renderEmpresasTree(); });
  document.getElementById('sceCol')?.addEventListener('click', () => { EMP_TREE.expanded.clear(); renderEmpresasTree(); });
}

// ¿Este item de alcance pertenece al mundo EMPRESAS? (department siempre;
// company solo si es empresa no-tienda). Zonas/subzonas/tiendas no se tocan aqui.
function sceIsEntScope(x) {
  if (x.scope_type === 'department') return true;
  if (x.scope_type === 'zone' || x.scope_type === 'subzone') return false;
  if (x.scope_type === 'company') { const c = SCOPE.companies.find(c => c.company_code === x.scope_value); return !!c && NON_STORE_TYPES.has(c.company_type); }
  return false;
}

async function openScopeEditor(user, targetId, targetUser, kind = 'store', origin = 'permisos', opts = {}) {
  /* v6.44: el editor puede montarse DENTRO de un host (la pestaña Tiendas o
     Empresas de la pagina de Alcance) en modo embedded: sin su pnl-head ni
     ← propios — el shell de pestañas ya los tiene. Suelto (#pnlMain) sigue
     funcionando exactamente igual que siempre. */
  const HOST = opts.host || '#pnlMain';
  $(HOST).innerHTML = `<div class="pnl-loading">Cargando alcance\u2026</div>`;
  const d = await fetch('/api/admin-scope', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get', adminId: user.id, targetId }),
  }).then(r => r.json());
  if (!d.ok) { $(HOST).innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }

  SCOPE = {
    target: targetId, targetUser, origin,
    kind, isEnt: kind === 'enterprise',
    sel: new Set(),   // v6.06: seleccion multiple (checkboxes) de la lista superior
    include: d.include.map(x => ({ ...x })),
    exclude: d.exclude.map(x => ({ ...x })),
    zones: d.zones, subzones: d.subzones, companies: d.companies,
    departments: d.departments || [],
  };

  // A donde vuelve al Cancelar / Volver / terminar de guardar. v6.43: origin
  // tambien puede ser una FUNCION (la pagina de Alcance de Equipo pasa su
  // propio volver); el string 'equipo' y el default historico siguen igual.
  const backTo = () => (typeof origin === 'function' ? origin()
    : origin === 'equipo' ? viewEquipo(user) : viewPermisos(user));
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

  $(HOST).innerHTML = `
    ${opts.embedded ? `<p class="muted" style="font-size:12.5px;margin:0 0 12px">${SCOPE.isEnt ? 'Define qu\u00e9 empresas (no tiendas) o departamentos puede gestionar. Alcance final = incluidos \u2212 excluidos.' : 'Define qu\u00e9 tiendas puede gestionar. Alcance final = incluidos \u2212 excluidos.'}</p>` : `<div class="pnl-head"><div><h1>Alcance de ${SCOPE.isEnt ? 'Empresas' : 'Tiendas'} \u00b7 ${targetUser}</h1>
      <p>${SCOPE.isEnt ? 'Define qu\u00e9 empresas (no tiendas) o departamentos puede gestionar. Alcance final = incluidos \u2212 excluidos.' : 'Define qu\u00e9 tiendas puede gestionar. Alcance final = incluidos \u2212 excluidos.'}</p></div>
      <button class="btn" id="scBack">\u2190 Volver</button></div>`}
    ${ostInfo}
    ${SCOPE.isEnt ? `<div id="sceHost"></div>` : `<div id="sctHost"></div>`}
    <div class="modal-actions">
      <button class="btn" id="scCancel">Cancelar</button>
      <button class="btn btn-primary" id="scSave">Guardar alcance</button>
    </div>`;

  const scBk = $('#scBack');
  if (scBk) scBk.addEventListener('click', backTo);
  $('#scCancel').addEventListener('click', backTo);
  $('#scSave').addEventListener('click', () => saveScope(user));

  // v6.46/v6.47: ambos modos usan arbol con checkboxes (sin scLevel/scSearch/
  // listas incluidos-excluidos). Empresas -> arbol Empresa ▸ deptos; Tiendas ->
  // arbol Zona ▸ Subzona ▸ tienda. Ambos operan sobre SCOPE.include/exclude y
  // guardan con saveScope (osTicket incluido), sin cambios en el guardado.
  if (SCOPE.isEnt) {
    EMP_TREE.expanded = new Set();
    EMP_TREE.q = '';
    renderEmpresasTree();
  } else {
    SCOPE_TREE.expanded = new Set();
    SCOPE_TREE.q = '';
    renderTiendasTree();
  }
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
  // v6.06: LISTAS DISJUNTAS — lo ya incluido o excluido NO se ofrece de
  // nuevo: la lista superior es siempre "lo pendiente por decidir".
  const taken = new Set(
    [...SCOPE.include, ...SCOPE.exclude]
      .filter(x => x.scope_type === level)
      .map(x => String(x.scope_value)));
  const total = opts.length;
  opts = opts.filter(o => !taken.has(String(o.value)));
  const pend = opts.length;
  if (q) opts = opts.filter(o => o.label.toLowerCase().includes(q));
  const MAXV = 400;
  const overflow = opts.length > MAXV;
  opts = opts.slice(0, MAXV);
  if (!(SCOPE.sel instanceof Set)) SCOPE.sel = new Set();
  [...SCOPE.sel].forEach(v => { if (taken.has(v)) SCOPE.sel.delete(v); });
  const selN = SCOPE.sel.size;
  const allVis = opts.length > 0 && opts.every(o => SCOPE.sel.has(String(o.value)));

  $('#scResults').innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:7px 10px 9px;border-bottom:1px solid var(--border);margin-bottom:4px;font-size:12.5px">
      <label style="display:inline-flex;align-items:center;gap:6px;font-weight:600;cursor:pointer"><input type="checkbox" id="scSelAll" ${allVis ? 'checked' : ''} ${opts.length ? '' : 'disabled'}> Seleccionar visibles</label>
      <span class="muted">Quedan <b>${pend}</b> sin decidir de ${total}${overflow ? ` (mostrando ${MAXV})` : ''}</span>
      <span style="flex:1"></span>
      <button class="btn btn-mini" id="scBulkInc" ${selN ? '' : 'disabled'} style="color:var(--success)">+ Incluir seleccionados (${selN})</button>
      <button class="btn btn-mini" id="scBulkExc" ${selN ? '' : 'disabled'} style="color:var(--danger)">&minus; Excluir seleccionados (${selN})</button>
    </div>
    ${opts.map(o =>
    `<div class="sc-res-row">
       <label style="display:inline-flex;align-items:center;margin-right:4px;cursor:pointer"><input type="checkbox" data-ck="${o.value}" ${SCOPE.sel.has(String(o.value)) ? 'checked' : ''}></label>
       <span style="flex:1">${o.label}</span>
       <span class="sc-res-btns">
         <button class="sc-inc" data-v="${o.value}" title="Incluir">+ incluir</button>
         <button class="sc-exc" data-v="${o.value}" title="Excluir">&minus; excluir</button>
       </span>
     </div>`).join('') || `<div class="muted" style="padding:8px">${(pend === 0 && total > 0) ? 'Todo decidido en este nivel: no queda nada pendiente.' : 'Sin coincidencias.'}</div>`}`;

  $('#scResults').querySelectorAll('.sc-inc').forEach(b =>
    b.addEventListener('click', () => addScope('include', level, b.dataset.v)));
  $('#scResults').querySelectorAll('.sc-exc').forEach(b =>
    b.addEventListener('click', () => addScope('exclude', level, b.dataset.v)));
  // v6.06: seleccion multiple + acciones en lote.
  $('#scResults').querySelectorAll('input[data-ck]').forEach(ck =>
    ck.addEventListener('change', () => {
      const v = String(ck.dataset.ck);
      if (ck.checked) SCOPE.sel.add(v); else SCOPE.sel.delete(v);
      renderScResults();
    }));
  const selAll = document.getElementById('scSelAll');
  if (selAll) selAll.addEventListener('change', (e) => {
    opts.forEach(o => { if (e.target.checked) SCOPE.sel.add(String(o.value)); else SCOPE.sel.delete(String(o.value)); });
    renderScResults();
  });
  document.getElementById('scBulkInc')?.addEventListener('click', () => addScopeBulk('include', level));
  document.getElementById('scBulkExc')?.addEventListener('click', () => addScopeBulk('exclude', level));
}

function addScope(bucket, type, value) {
  const list = SCOPE[bucket];
  if (!list.some(x => x.scope_type === type && String(x.scope_value) === String(value))) {
    list.push({ scope_type: type, scope_value: String(value) });
  }
  if (SCOPE.sel instanceof Set) SCOPE.sel.delete(String(value));
  renderScopeLists();
  renderScResults();   // v6.06: lo decidido desaparece de la lista superior
}
/* v6.06: accion en lote sobre los checkboxes de la lista superior. */
function addScopeBulk(bucket, type) {
  const sel = (SCOPE.sel instanceof Set) ? [...SCOPE.sel] : [];
  sel.forEach(v => {
    if (!SCOPE[bucket].some(x => x.scope_type === type && String(x.scope_value) === String(v))) {
      SCOPE[bucket].push({ scope_type: type, scope_value: String(v) });
    }
  });
  SCOPE.sel = new Set();
  renderScopeLists();
  renderScResults();
}
function removeScope(bucket, type, value) {
  SCOPE[bucket] = SCOPE[bucket].filter(x => !(x.scope_type === type && String(x.scope_value) === String(value)));
  renderScopeLists();
  renderScResults();   // v6.06: al quitarlo, vuelve a la lista superior
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

/* ===== v5.65 · LA MISMA SENAL AL GUARDAR, EN LOS TRES BOTONES =====
   Configurar tiene tres botones "Guardar programacion" (Empresas, Estado de
   pago, Personal). Solo el de Estado de pago avisaba que habia guardado: los
   otros dos se quedaban mudos, y no habia forma de saber si el clic hizo algo.

   Esto centraliza el efecto: boton deshabilitado -> "Guardando..." -> ✓ Guardado
   (que se apaga solo a los 2.5s). Un solo lugar que arreglar la proxima vez.

   Se le pasa el id del boton, el id del span del ✓, y la funcion que guarda
   (que debe devolver { ok, error }). */
async function cfgSaveFlash(btnId, savedId, doSave) {
  const btn = document.getElementById(btnId);
  const ok  = document.getElementById(savedId);
  if (!btn) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Guardando\u2026';
  if (ok) ok.style.display = 'none';
  try {
    const r = await doSave();
    if (r && r.ok === false) {
      // El error se muestra donde el usuario esta mirando: en el boton.
      btn.textContent = '\u2717 No se guard\u00f3';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2600);
      return r;
    }
    btn.textContent = orig;
    btn.disabled = false;
    if (ok) {
      ok.style.display = 'inline';
      setTimeout(() => { ok.style.display = 'none'; }, 2500);
    }
    return r;
  } catch (e) {
    btn.textContent = '\u2717 No se guard\u00f3';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2600);
    return { ok: false, error: String(e && e.message || e) };
  }
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
      <div class="cfg-foot"><span class="cfg-saved" id="syncSaved">\u2713 Guardado</span><button class="btn btn-primary" id="syncSave">Guardar programación</button></div>
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
        <div id="rsHourWrap" style="display:none"><label class="flabel">Hora ancla (Caracas)</label>
          <!-- v5.69: input type="time" en vez del select de horas en punto. Pablo
               pidio poder programar 13:15, no solo 13:00. La BD ahora guarda
               daily_hour + daily_minute. -->
          <input type="time" id="rsTime" value="06:00" step="60" style="width:130px">
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
    </div></div>

    <!-- v5.75: tarjeta de No reempleables. El placeholder vive en este
         template pero la tarjeta la monta no-rehire.js (mountNoRehireConfigCard,
         llamada desde navigate al entrar a 'sync'), para no engordar viewSync. -->
    <!-- v6.09: tarjeta "Egresos del sistema". Placeholder aqui; la monta
         ax-egresos-card.js (import dinamico tras renderPaySyncCard), patron
         v5.75 de No reempleables: viewSync no engorda. -->
    <div id="axEgCfgCard"></div>

    <div id="norehireCfgCard"></div>

    <!-- v5.58 — SE SACAN LAS DOS TABLAS DE HISTORIAL (Pablo).

         Aca vivian "Ultimas corridas con movimiento" (personal) y "Ultimas
         ejecuciones" (empresas — nadie sabia bien que era, y era eso).

         Las dos son HISTORIAL, y el historial ya tiene su lugar: "Ultimas
         sincronizaciones", que ademas lo hace mejor (filtros, paginado, detalle
         por corrida, exportar). Tenerlas tambien aca las duplicaba y sumaba dos
         tablas a una pagina que es de CONFIGURACION, no de consulta.

         Configurar responde "como y cuando corre". Que paso, se mira en el
         registro. Los botones "Ver el registro" de cada tarjeta llevan alli. -->`;

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
      /* v5.36: el resumen cuenta TODO lo que hizo la corrida. Antes decia solo
         "132 tiendas · 0 ingresos · 0 egresos": la corrida de las 15:35 escribio
         888 telefonos y no lo dijo, parecia que no habia hecho nada. */
      const bits = [`${s.stores != null ? s.stores : 0} tiendas revisadas`,
                    `<b>${s.added || 0}</b> ingreso(s)`,
                    `<b>${s.removed || 0}</b> egreso(s)`];
      if (s.filled) bits.push(`<span style="color:#0e9f6e"><b>${s.filled}</b> ficha(s) completada(s)</span>`);
      // Los dos estatus de diferencia van separados: no son lo mismo.
      //   por revisar = los dos lados tienen dato distinto -> lo decide un humano
      //   a corregir  = el portal lo tiene bien, el sistema lo tiene mal escrito
      if (s.diff_review) bits.push(`<span style="color:#1e40af"><b>${s.diff_review}</b> por revisar</span>`);
      if (s.diff_broken) bits.push(`<span style="color:#b45309"><b>${s.diff_broken}</b> a corregir en el sistema</span>`);
      if (s.alerts) bits.push(`<span style="color:#b45309">${s.alerts} con alerta</span>`);
      if (s.incomplete) bits.push(`<span style="color:#b45309">corrida parcial (continúa en la próxima)</span>`);

      el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${okPill}<b>${fmtDT(c.last_run_at)}</b><span class="muted">${c.last_source === 'cron' ? 'automática' : 'manual'} · ${(((c.last_duration_ms || 0)) / 1000).toFixed(1)} s</span></div>`
        + `<div style="margin-top:8px">${bits.join(' · ')}</div>`;
    };
    /* v5.58 — LA TABLA DE HISTORIAL SE FUE A "ULTIMAS SINCRONIZACIONES".
       Vivia aca ("Ultimas corridas con movimiento") duplicando lo que el registro
       ya hace mejor: filtros, paginado, detalle por corrida y exportar. Y sumaba
       una tabla a una pagina que es de CONFIGURACION, no de consulta.
       Se deja como no-op porque loadRs() la sigue llamando tras cada corrida. */
    const paintRuns = () => {};

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
        // v5.69: hora + minuto en un solo campo HH:MM.
        {
          const h = rc.daily_hour   != null ? rc.daily_hour   : 6;
          const m = rc.daily_minute != null ? rc.daily_minute : 0;
          $('#rsTime').value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }
        $('#rsUrl').value = rc.endpoint_url || '';
        $('#rsRetry').value = String(rc.retry_minutes != null ? rc.retry_minutes : 30);
        paintLast(rc);
      }
      rsHourVis();
      if (r && r.ok) paintRuns(r.runs);
    }
    $('#rsFreq').addEventListener('change', rsHourVis);
    // v5.65: mismo efecto que los otros dos (cfgSaveFlash).
    $('#rsSave').addEventListener('click', () => cfgSaveFlash('rsSave', 'rsSaved', async () => {
      const r = await rsApi({
        action: 'save_config',
        config: {
          enabled: $('#rsEnabled').value === '1',
          frequency: $('#rsFreq').value,
          daily_hour: +($('#rsTime').value || '06:00').split(':')[0],
          daily_minute: +($('#rsTime').value || '06:00').split(':')[1],
          retry_minutes: +$('#rsRetry').value,
          endpoint_url: $('#rsUrl').value.trim(),
        },
      });
      if (!r || !r.ok) { alert((r && r.error) || 'No se pudo guardar.'); return r || { ok: false }; }
      return r;
    }));
    $('#rsRunBtn').addEventListener('click', async () => {
      const b = $('#rsRunBtn'); b.disabled = true;
      const prev = b.innerHTML; b.textContent = 'Ejecutando…';
      const el = $('#rsLast');

      /* v5.14: la corrida va POR TANDAS de tiendas. Antes era UNA sola llamada
         que intentaba las 132 tiendas de golpe, y Cloudflare la mataba por
         exceso de subrequests (tope 50 por invocacion; cada tienda cuesta 2 o
         mas): la sincronizacion NUNCA pudo completarse, ni a mano ni por cron.
         Ahora el server hace de a 10 tiendas y devuelve next_offset; aca se
         encadenan las tandas mostrando el avance. */
      let offset = 0, runId = null;
      // v5.31: `rej` acumula los datos que NO se escribieron por venir mal
      // formateados desde el sistema. Viaja entre tandas: si no, el resumen
      // final solo contaria los de la ULTIMA tanda de 10 tiendas.
      let acc = { added: 0, removed: 0, alerts: 0, stores: 0 };
      let rej = { account: 0, phone: 0, email: 0 };
      let filled = 0;          // v5.34: fichas incompletas que se completaron solas
      let rejDetail = [];      // v5.34: QUIENES vienen mal del sistema (para corregir en AX)
      let diffs = 0;           // v5.35: fichas con diferencia contra el sistema
      let diffDetail = [];     // v5.35: el detalle de cada diferencia
      let total = 0;
      let r = null;
      let guard = 0;

      while (guard < 60) {
        guard++;
        r = await rsApi({
          source: 'manual', offset, run_id: runId,
          acc_added: acc.added, acc_removed: acc.removed,
          acc_alerts: acc.alerts, acc_stores: acc.stores,
          // v5.31: los rechazos por formato tambien viajan entre tandas.
          acc_rej_account: rej.account,
          acc_rej_phone: rej.phone,
          acc_rej_email: rej.email,
          acc_filled: filled,          // v5.34
          acc_rej_detail: rejDetail,   // v5.34
          acc_diffs: diffs,            // v5.35
          acc_diff_detail: diffDetail, // v5.35
        });
        if (!r || !r.ok) break;

        // El server devuelve los totales YA acumulados (no los de la tanda).
        rej = {
          account: Number(r.acc_rej_account) || 0,
          phone: Number(r.acc_rej_phone) || 0,
          email: Number(r.acc_rej_email) || 0,
        };
        filled = Number(r.acc_filled) || 0;
        if (Array.isArray(r.acc_rej_detail)) rejDetail = r.acc_rej_detail;
        diffs = Number(r.acc_diffs) || 0;
        if (Array.isArray(r.acc_diff_detail)) diffDetail = r.acc_diff_detail;

        runId = r.run_id || runId;
        total = r.total_stores || total;
        // El server devuelve los totales ya acumulados (le pasamos los previos).
        acc = { added: r.added || 0, removed: r.removed || 0, alerts: r.alerts || 0, stores: r.stores || 0 };

        if (el && total) {
          const pct = Math.round((acc.stores / total) * 100);
          el.innerHTML = `<div style="font-size:12.5px;color:var(--muted);margin-bottom:5px">
              Revisando tiendas… <b style="color:var(--ink)">${acc.stores} / ${total}</b>
            </div>
            <div style="height:7px;border-radius:999px;background:var(--border-soft,#eef1f5);overflow:hidden;max-width:340px">
              <div style="height:100%;width:${pct}%;background:var(--brand,#2563eb);transition:width .25s"></div>
            </div>`;
        }

        if (r.done) break;
        if (r.next_offset == null || r.next_offset <= offset) break;   // nunca bucle infinito
        offset = r.next_offset;
      }

      b.disabled = false; b.innerHTML = prev;
      if (!r || !r.ok) {
        if (el) el.innerHTML = `<span style="color:#b91c1c">⚠ ${(r && r.error) || 'No se pudo ejecutar.'}</span>`;
        return;
      }

      /* v5.34 — FICHAS QUE SE COMPLETARON SOLAS.
         Gente que ya estaba cargada pero con la ficha a medias (cuenta,
         telefono o correo vacios). El sistema tenia el dato y ahora se tomo.
         No se piso nada: solo se llenaron huecos. */
      if (filled > 0 && el) {
        el.insertAdjacentHTML('beforeend',
          `<div style="margin-top:10px;padding:11px 13px;background:#f0fdf4;border:1px solid #bbf7d0;`
          + `border-radius:9px;font-size:12.5px;color:#166534;line-height:1.55">`
          + `<b>✓ ${filled} ficha${filled === 1 ? '' : 's'} se completó${filled === 1 ? '' : 'aron'} con datos del sistema.</b> `
          + `Tenían la cuenta bancaria, el teléfono o el correo en blanco, y el sistema `
          + `sí los tenía. Los datos que ya estaban cargados en el portal no se tocaron.`
          + `</div>`);
      }

      /* v5.34 — LOS DATOS QUE VIENEN MAL, CON NOMBRE Y APELLIDO.
         Decision de Pablo: el portal NO arregla datos del ERP. Si un correo
         viene sin arroba, o un telefono con un prefijo que no existe, NO se
         guarda — se avisa, y se corrige en el sistema, que es donde vive el dato.

         Pero avisar "4 correos mal escritos" y nada mas es inutil: no hay forma
         de saber CUALES ni de ir a arreglarlos. Pablo lo pidio explicito: "debo
         poder ver cuales son los casos". Asi que el aviso ahora TRAE LA LISTA
         (cedula, nombre, empresa, campo, y el valor crudo tal cual vino), se
         puede desplegar, y se puede copiar para trabajarla en AX. */
      const totalRej = rej.account + rej.phone + rej.email;
      if (totalRej > 0 && el) {
        const partes = [];
        if (rej.email) partes.push(`${rej.email} correo${rej.email === 1 ? '' : 's'}`);
        if (rej.phone) partes.push(`${rej.phone} teléfono${rej.phone === 1 ? '' : 's'}`);
        if (rej.account) partes.push(`${rej.account} cuenta${rej.account === 1 ? '' : 's'} bancaria${rej.account === 1 ? '' : 's'}`);

        // La lista, si el server la mando (puede venir vacia si algo fallo).
        const filas = (rejDetail || []).map(d => `
          <tr>
            <td style="padding:5px 8px;border-bottom:1px solid #f3e4cf;white-space:nowrap">${esc(d.ced || '')}</td>
            <td style="padding:5px 8px;border-bottom:1px solid #f3e4cf">${esc(d.nom || '')}</td>
            <td style="padding:5px 8px;border-bottom:1px solid #f3e4cf;white-space:nowrap">${esc(d.comp || '')}</td>
            <td style="padding:5px 8px;border-bottom:1px solid #f3e4cf;white-space:nowrap">${esc(d.campo || '')}</td>
            <td style="padding:5px 8px;border-bottom:1px solid #f3e4cf;font-family:ui-monospace,monospace;font-size:11.5px;color:#9a3412">${esc(d.valor || '')}</td>
          </tr>`).join('');

        const tabla = filas ? `
          <details style="margin-top:9px">
            <summary style="cursor:pointer;font-weight:700;font-size:12px;color:#92400e;user-select:none">
              Ver los ${rejDetail.length} caso${rejDetail.length === 1 ? '' : 's'} · corregir en el sistema
            </summary>
            <div style="margin-top:8px;max-height:280px;overflow:auto;border:1px solid #f3ddc0;border-radius:7px;background:#fff">
              <table style="width:100%;border-collapse:collapse;font-size:12px">
                <thead>
                  <tr style="background:#fdf3e7;position:sticky;top:0">
                    <th style="padding:6px 8px;text-align:left;font-size:11px;color:#92400e">Cédula</th>
                    <th style="padding:6px 8px;text-align:left;font-size:11px;color:#92400e">Colaborador</th>
                    <th style="padding:6px 8px;text-align:left;font-size:11px;color:#92400e">Empresa</th>
                    <th style="padding:6px 8px;text-align:left;font-size:11px;color:#92400e">Campo</th>
                    <th style="padding:6px 8px;text-align:left;font-size:11px;color:#92400e">Valor que llegó</th>
                  </tr>
                </thead>
                <tbody>${filas}</tbody>
              </table>
            </div>
            <button class="btn btn-sm" id="rsCopyRej" style="margin-top:8px">Copiar la lista</button>
          </details>` : '';

        el.insertAdjacentHTML('beforeend',
          `<div style="margin-top:10px;padding:11px 13px;background:#fdf3e7;border:1px solid #f3ddc0;`
          + `border-radius:9px;font-size:12.5px;color:#92400e;line-height:1.55">`
          + `<b>⚠ ${totalRej} dato${totalRej === 1 ? '' : 's'} no se pudo${totalRej === 1 ? '' : 'ieron'} guardar.</b> `
          + `${partes.join(', ')} ${totalRej === 1 ? 'venía' : 'venían'} mal escrito${totalRej === 1 ? '' : 's'} desde el sistema `
          + `(por ejemplo, un correo sin arroba). El portal no los corrige por su cuenta: `
          + `se arreglan en el sistema y entran solos en la próxima sincronización.`
          + tabla
          + `</div>`);

        // Copiar la lista al portapapeles (para trabajarla en AX).
        const cp = document.getElementById('rsCopyRej');
        if (cp) cp.addEventListener('click', () => {
          const txt = ['Cedula\tColaborador\tEmpresa\tCampo\tValor que llego']
            .concat((rejDetail || []).map(d =>
              `${d.ced || ''}\t${d.nom || ''}\t${d.comp || ''}\t${d.campo || ''}\t${d.valor || ''}`))
            .join('\n');
          navigator.clipboard.writeText(txt).then(() => {
            cp.textContent = '✓ Copiada';
            setTimeout(() => { cp.textContent = 'Copiar la lista'; }, 1800);
          });
        });
      }

      /* (El aviso de datos rechazados vive ARRIBA, junto con la lista de casos
         que Pablo pidio para poder ir a corregirlos en el sistema.) */

      /* ===================================================================
         v5.35 — DIFERENCIAS CON EL SISTEMA (pedido de Pablo 2026-07-13)

         Estos son los campos que el portal YA TIENE LLENOS y que NO COINCIDEN
         con lo que trae el sistema. La sincronizacion NO LOS TOCA (esa regla no
         se rompe), pero antes tampoco los AVISABA: la diferencia quedaba
         invisible y los dos sistemas se separaban en silencio, para siempre.

         DOS ESTATUS, y la distincion importa:

         🔵 PENDIENTE DE REVISAR (conflicto)
            Los dos lados tienen valor y son distintos. NADIE sabe cual es el
            bueno. Lo tiene que decidir una persona.
            ej: portal 0414-1234567 / sistema 0424-1234567

         🟠 PENDIENTE DE CORREGIR EN EL SISTEMA (dato roto)
            El portal lo tiene BIEN y el sistema lo tiene MAL FORMATEADO.
            Aca SI sabemos cual es el bueno: el del portal. No hay nada que
            decidir; hay que ir a arreglarlo en el sistema.
            ej: portal erick@grupocanaima.net / sistema erickgrupocanaimanet

         Sin el segundo estatus, un correo roto en el sistema se quedaba roto y
         NADIE lo veia: el validador solo miraba los campos VACIOS. Los 4 que se
         corrigieron hoy aparecieron de pura suerte, porque estaban vacios en el
         portal. Si hubieran tenido correo cargado, seguirian rotos. */
      if (diffs > 0 && el) {
        const rotos  = (diffDetail || []).filter(d => d.estado === 'dato_roto');
        const confl  = (diffDetail || []).filter(d => d.estado === 'conflicto');

        const pill = (est) => est === 'dato_roto'
          ? '<span style="display:inline-block;padding:1px 7px;border-radius:99px;background:#fef3c7;color:#92400e;font-size:10.5px;font-weight:800;white-space:nowrap">Corregir en el sistema</span>'
          : '<span style="display:inline-block;padding:1px 7px;border-radius:99px;background:#dbeafe;color:#1e40af;font-size:10.5px;font-weight:800;white-space:nowrap">Revisar</span>';

        const filas = (diffDetail || []).map(d => `
          <tr>
            <td style="padding:5px 8px;border-bottom:1px solid #dbe6f5">${pill(d.estado)}</td>
            <td style="padding:5px 8px;border-bottom:1px solid #dbe6f5;white-space:nowrap">${esc(d.ced || '')}</td>
            <td style="padding:5px 8px;border-bottom:1px solid #dbe6f5">${esc(d.nom || '')}</td>
            <td style="padding:5px 8px;border-bottom:1px solid #dbe6f5;white-space:nowrap">${esc(d.comp || '')}</td>
            <td style="padding:5px 8px;border-bottom:1px solid #dbe6f5;white-space:nowrap">${esc(d.campo || '')}</td>
            <td style="padding:5px 8px;border-bottom:1px solid #dbe6f5;font-family:ui-monospace,monospace;font-size:11.5px;color:#166534">${esc(d.portal || '')}</td>
            <td style="padding:5px 8px;border-bottom:1px solid #dbe6f5;font-family:ui-monospace,monospace;font-size:11.5px;color:#9a3412">${esc(d.sistema || '')}</td>
          </tr>`).join('');

        const resumen = [];
        if (confl.length) resumen.push(`<b>${confl.length}</b> por revisar`);
        if (rotos.length) resumen.push(`<b>${rotos.length}</b> por corregir en el sistema`);

        el.insertAdjacentHTML('beforeend',
          `<div style="margin-top:10px;padding:11px 13px;background:#eff6ff;border:1px solid #bfdbfe;`
          + `border-radius:9px;font-size:12.5px;color:#1e40af;line-height:1.55">`
          + `<b>◈ ${diffs} ficha${diffs === 1 ? '' : 's'} con diferencias.</b> `
          + `${resumen.join(' · ')}. `
          + `El portal <b>no tocó</b> ninguno de estos datos: solo los marcó.`
          + `<details style="margin-top:9px">`
          + `<summary style="cursor:pointer;font-weight:700;font-size:12px;color:#1e40af;user-select:none">`
          + `Ver las ${(diffDetail || []).length} diferencia${(diffDetail || []).length === 1 ? '' : 's'}</summary>`
          + `<div style="margin-top:8px;max-height:300px;overflow:auto;border:1px solid #bfdbfe;border-radius:7px;background:#fff">`
          + `<table style="width:100%;border-collapse:collapse;font-size:12px">`
          + `<thead><tr style="background:#eff6ff;position:sticky;top:0">`
          + `<th style="padding:6px 8px;text-align:left;font-size:11px;color:#1e40af">Estado</th>`
          + `<th style="padding:6px 8px;text-align:left;font-size:11px;color:#1e40af">Cédula</th>`
          + `<th style="padding:6px 8px;text-align:left;font-size:11px;color:#1e40af">Colaborador</th>`
          + `<th style="padding:6px 8px;text-align:left;font-size:11px;color:#1e40af">Empresa</th>`
          + `<th style="padding:6px 8px;text-align:left;font-size:11px;color:#1e40af">Campo</th>`
          + `<th style="padding:6px 8px;text-align:left;font-size:11px;color:#1e40af">En el portal</th>`
          + `<th style="padding:6px 8px;text-align:left;font-size:11px;color:#1e40af">En el sistema</th>`
          + `</tr></thead><tbody>${filas}</tbody></table></div>`
          + `<button class="btn btn-sm" id="rsCopyDiff" style="margin-top:8px">Copiar la lista</button>`
          + `</details></div>`);

        const cd = document.getElementById('rsCopyDiff');
        if (cd) cd.addEventListener('click', () => {
          const txt = ['Estado\tCedula\tColaborador\tEmpresa\tCampo\tEn el portal\tEn el sistema']
            .concat((diffDetail || []).map(d =>
              `${d.estado === 'dato_roto' ? 'Corregir en el sistema' : 'Revisar'}`
              + `\t${d.ced || ''}\t${d.nom || ''}\t${d.comp || ''}\t${d.campo || ''}`
              + `\t${d.portal || ''}\t${d.sistema || ''}`))
            .join('\n');
          navigator.clipboard.writeText(txt).then(() => {
            cd.textContent = '✓ Copiada';
            setTimeout(() => { cd.textContent = 'Copiar la lista'; }, 1800);
          });
        });
      }

      /* v5.36 — ENLACE AL REGISTRO.
         Los avisos de arriba se pierden al recargar la pantalla. El Registro
         guarda el detalle y se puede volver a mirar manana. */
      if (el && (filled || diffs || acc.added || acc.removed || acc.alerts)) {
        el.insertAdjacentHTML('beforeend',
          `<div style="margin-top:12px"><a href="#" id="rsToReg" `
          + `style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;`
          + `font-weight:700;color:var(--brand);text-decoration:none">`
          + `Ver el detalle en el Registro `
          + `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" `
          + `stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">`
          + `<path d="M5 12h14M12 5l7 7-7 7"/></svg></a></div>`);
        const toReg = document.getElementById('rsToReg');
        if (toReg) toReg.addEventListener('click', (ev) => {
          ev.preventDefault();
          renderSyncLog(user, 'roster', 'sync');
        });
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
  // v6.09: tarjeta "Egresos del sistema" (cron propio, ax_sync_config).
  // Modulo aparte con import dinamico: viewSync no engorda (patron v5.75).
  import('./ax-egresos-card.js').then(m => m.mountAxEgresosCard(user)).catch(() => {});

  // Mostrar/ocultar la hora según la frecuencia elegida
  $('#syncFreq').addEventListener('change', (e) => {
    const sh = (e.target.value === 'daily' || e.target.value === '2d');
    $('#syncHourWrap').style.display = sh ? '' : 'none';
  });

  // Guardar programación
  // v5.65: usa cfgSaveFlash — el mismo efecto que Estado de pago (boton
  // deshabilitado -> "Guardando..." -> ✓ Guardado). Antes se quedaba mudo.
  $('#syncSave').addEventListener('click', () => cfgSaveFlash('syncSave', 'syncSaved', async () => {
    const r = await syncCfgApi({
      action: 'set', adminId: user.id,
      enabled: $('#syncEnabled').value === '1',
      frequency: $('#syncFreq').value,
      daily_hour: parseInt($('#syncHour').value, 10),
      endpoint_url: $('#syncUrl').value.trim(),
      manual_cooldown_value: parseInt($('#syncCdVal').value, 10),
      manual_cooldown_unit: $('#syncCdUnit').value,
    });
    /* v5.65: el efecto (deshabilitar, "Guardando...", ✓) lo maneja cfgSaveFlash.
       Aca solo se avisa del error y se refresca la ficha.
       El bug viejo: este codigo YA buscaba $('#syncSaved') y le ponia display
       inline... pero ese span NO EXISTIA en el HTML. Escribia sobre null y no
       pasaba nada. Por eso el boton se sentia muerto. */
    if (!r.ok) { alert(r.error || 'No se pudo guardar.'); return r; }
    return r;
  }));

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
        <button class="cfg-side-item" data-tab="params"><span class="cfg-side-ic">⚙️</span> Parámetros</button>
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
  else if (CFG_TAB === 'params') cfgRenderParams(user, body);
  else if (CFG_TAB === 'int') cfgRenderIntegraciones(user, body);
}

/* v6.25: PARÁMETROS DEL PORTAL (tabla portal_params, endpoint
   /api/portal-params, solo superadmin). Valores que gobiernan reglas del
   portal; el primero es gap_continuidad_dias=30 (antigüedad de Grupo:
   pausas de hasta N días entre empleos no cortan el tramo continuo).
   Los parámetros se CREAN por migración; acá solo se editan valores. */
function cfgParamsApi(payload) {
  return fetch('/api/portal-params', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload) }).then(r => r.json());
}
async function cfgRenderParams(user, body) {
  body.innerHTML = '<div class="pnl-loading">Cargando…</div>';
  const r = await cfgParamsApi({ action: 'list', adminId: user.id });
  if (!r.ok) { body.innerHTML = `<div class="pnl-loading">Error: ${r.error || 'no se pudo cargar'}</div>`; return; }
  const escP = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTs = ts => { if (!ts) return ''; const d = new Date(ts); return isNaN(d) ? '' : d.toLocaleString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  body.innerHTML = `
    <div class="card">
      <h3 style="margin:0 0 4px">⚙️ Parámetros del portal</h3>
      <p class="muted" style="margin:0 0 6px;font-size:12.5px">Valores que gobiernan reglas del portal. Los cambios aplican de inmediato en los cálculos que los usan. Los parámetros nuevos se crean por migración; acá se editan sus valores.</p>
      ${(r.params || []).map(p => `
        <div style="display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid #eef1f5">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:13px">${escP(p.label || p.key)}</div>
            <div class="muted" style="font-size:11px;margin-top:2px">clave: ${escP(p.key)}${p.updated_at ? ` · último cambio: ${escP(fmtTs(p.updated_at))}${p.updated_by ? ' por ' + escP(p.updated_by) : ''}` : ''}</div>
          </div>
          <input data-pkey="${escP(p.key)}" type="${/_dias$/.test(p.key) ? 'number' : 'text'}" ${/_dias$/.test(p.key) ? 'min="0" max="365"' : ''} value="${escP(p.value)}"
                 style="width:110px;padding:8px 10px;border:1px solid #e5e7eb;border-radius:10px;font-size:13px;text-align:center">
          <button data-psave="${escP(p.key)}" style="padding:8px 16px;border:none;border-radius:10px;background:#2563eb;color:#fff;font-size:13px;font-weight:600;cursor:pointer">Guardar</button>
          <span data-pmsg="${escP(p.key)}" style="font-size:12px;align-self:center;min-width:110px"></span>
        </div>`).join('') || '<p class="muted">Sin parámetros.</p>'}
    </div>`;
  body.querySelectorAll('[data-psave]').forEach(btn => btn.addEventListener('click', async () => {
    const key = btn.dataset.psave;
    const inp = body.querySelector(`[data-pkey="${key}"]`);
    const msg = body.querySelector(`[data-pmsg="${key}"]`);
    const value = (inp.value || '').trim();
    if (/_dias$/.test(key) && (!/^\d{1,3}$/.test(value) || Number(value) > 365)) {
      msg.textContent = '✗ Número de días (0-365)'; msg.style.color = '#b91c1c'; return;
    }
    btn.disabled = true; msg.textContent = 'Guardando…'; msg.style.color = '#64748b';
    const res = await cfgParamsApi({ action: 'save', adminId: user.id, key, value });
    btn.disabled = false;
    if (res.ok) {
      msg.textContent = '✓ Guardado'; msg.style.color = '#0e9f6e';
      const audit = body.querySelector(`[data-pkey="${key}"]`).closest('div[style*="border-top"]').querySelector('.muted');
      if (audit && res.param) audit.textContent = `clave: ${key} · último cambio: ${fmtTs(res.param.updated_at)} por ${res.param.updated_by || ''}`;
    } else { msg.textContent = `✗ ${res.error || 'Error'}`; msg.style.color = '#b91c1c'; }
  }));
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
/* v4.75: colores de la JERARQUIA de cargos (aprobados en el mockup de
   fichas): 1 Gerente ambar, 2 Sub-Gerente morado, 3 Cajero azul,
   4 Vendedor verde, 5 Depositario gris. Fuera de 1..5 -> neutro. Este
   mismo mapa colorea el borde de las fichas de tienda (worker-photos). */
const CARGO_RANK_COLORS = { 1: '#b45309', 2: '#7e22ce', 3: '#2b6cff', 4: '#0e9f6e', 5: '#64748b' };
function cargoRankColor(n) { return CARGO_RANK_COLORS[n] || '#94a3b8'; }
function cargoRankBadge(n) {
  if (n == null || n === '') return '<span style="color:var(--muted)">—</span>';
  return `<span style="display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;background:${cargoRankColor(n)};color:#fff;font-weight:800;font-size:13px">${n}</span>`;
}

function cfgRenderCargos(user, body) {
  const rows = (CFG_DATA.cargos || []).map(c => {
    const resp = c.can_be_responsible
      ? `<span class="pill pill-open">${c.responsible_role || 'Responsable'}</span>`
      : '<span style="color:var(--muted)">—</span>';
    const ing = c.selectable_on_ingreso ? '<span class="pill pill-open">sí</span>' : '<span class="pill pill-closed">no</span>';
    const estado = c.is_active ? '<span class="pill pill-open">activo</span>' : '<span class="pill pill-closed">inactivo</span>';
    const pats = (c.patterns || []).map(p => p.pattern).join(', ') || '<span style="color:var(--muted)">—</span>';
    return `<tr>
      <td data-label="Jerarquía" style="text-align:center">${cargoRankBadge(c.sort_order)}</td>
      <td data-label="Cargo"><b>${c.label}</b><br><span class="muted" style="font-size:11px;font-family:monospace">${c.code}</span></td>
      <td data-label="Cód. plantilla"><span class="pill pill-ax">${c.ax_code}</span></td>
      <td data-label="Responsable">${resp}</td><td data-label="En ingreso">${ing}</td>
      <td data-label="Patrones" style="font-size:11.5px;color:var(--muted)">${pats}</td>
      <td data-label="Estado">${estado}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-mini" data-edit-car="${c.code}">${I.pencil}</button>
        <button class="btn btn-mini" data-toggle-car="${c.code}" data-active="${c.is_active}">${c.is_active ? 'Desactivar' : 'Activar'}</button>
      </td></tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">Sin cargos.</td></tr>';

  body.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3>Cargos</h3>
        <button class="btn btn-primary btn-mini" id="carNew">${I.plus} Nuevo cargo</button></div>
      <p class="cfg-desc" style="margin:0 0 14px">Catálogo único de cargos. La <b>jerarquía</b> (1 = más arriba) ordena las fichas del personal en las tiendas y les da su color distintivo. La <b>etiqueta</b> es lo que ve la tienda; el <b>código de plantilla</b> es lo que se exporta (puede diferir, ej. Cajero → CAJEROS). Quien puede ser <b>responsable</b> y los <b>patrones</b> de lectura de la lista de personal se definen aquí.</p>
      <table class="cfg-cat-table tbl-cards"><thead><tr>
        <th style="text-align:center">Jerarquía</th><th>Cargo</th><th>Cód. plantilla</th><th>Responsable</th><th>En ingreso</th><th>Patrones (lista de personal)</th><th>Estado</th><th></th>
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
    <div class="cfg-grid3" style="margin-top:12px">
      <div><label class="flabel">Código (interno)</label><input id="cg_code" value="${c ? c.code : ''}" ${c ? 'readonly' : ''} placeholder="CAJERO" style="font-family:monospace;text-transform:uppercase"></div>
      <div><label class="flabel">Jerarquía <span class="muted">(1 = más arriba)</span></label><input id="cg_hier" type="number" min="1" max="99" value="${c && c.sort_order != null ? c.sort_order : ''}" placeholder="ej. 3"></div>
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
        hierarchy: $('#cg_hier').value,
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
  if (view === 'tiendas') await viewTiendas(user);
  else if (view === 'catalogos') viewCatalogos();
  else if (view === 'usuarios') viewUsuarios(user);
  else if (view === 'quincenas') viewPeriods(user);
  else if (view === 'calendario') viewPeriods(user);
  else if (view === 'equipo') { await ensureAdminRoles(user); await viewEquipo(user); decorateScovBadges(user); }
  /* v6.42: 'permisos' muere del menu y del router. Era el editor de alcance
     como pagina suelta; el alcance se gestiona fila por fila en Equipo
     (Tiendas / Empresas / ⚡), que siempre fue el mismo editor. */
  else if (view === 'firmantes') renderCertSigners(user);
  else if (view === 'constancias') renderCertRequests(user);
  else if (view === 'sync') { await viewSync(user); if (currentView === 'sync') mountNoRehireConfigCard(user); }
  else if (view === 'syncreview') renderAxReview(user);
  else if (view === 'axcompare') renderAxCompare(user);
  else if (view === 'axhistory') renderAxHistory(user);
  else if (view === 'bankstats') renderBankStats(user);
  else if (view === 'banksync') renderAxReview(user, 'account_number');
  else if (view === 'bankhist') renderAxHistory(user, 'account_number');
  else if (view === 'bankaccounts') renderBankAccounts(user);
  else if (view === 'wadifusion') renderWaSend(user);
  else if (view === 'wamensajes') renderWaTemplates(user);
  else if (view === 'waencuestas') renderWaPolls(user);
  else if (view === 'wahistorial') renderWaHistory(user);
  else if (view === 'wagrupos') renderWaGroups(user);
  else if (view === 'erpquery') renderErpQuery(user);
  else if (view === 'synclog') renderSyncLog(user);
  /* v5.58 — EL DETALLE ES UNA PAGINA, NO UN DESPLEGABLE.
     Pablo lo pidio 6 o 7 veces y yo lo segui metiendo inline dentro de la fila
     del Registro. El mockup aprobado (_PRUEBAS/sync_resumen_mockup.html) SIEMPRE
     fue una pagina aparte: cabecera propia, ficha de la corrida con los cuatro
     numeros, aviso, y las pestanas debajo. Aca esta.
     `runId` viaja por el estado del modulo (SL_OPEN), no por la URL: el portal
     no tiene router de verdad. */
  else if (view === 'syncrun') renderSyncRun(user);
  else if (view === 'syncpend') renderSyncPending(user);   // v5.40
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
  else if (view === 'dobleempleo') renderDoubleEmployment(user);
  else if (view === 'norehire') renderNoRehire(user);
  else if (view === 'norehirecheck') renderNoRehireVerify(user);
  else if (view === 'movimientos') renderMovements(user);
  else if (view === 'movquincena') renderMovQuincena(user);
  else if (view === 'cambiocargo') renderCambioCargo(user);
  else if (view === 'cargohistorial') renderCambioCargoHist(user);
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

/* ---------- v5.04: PERMISOS DE REPORTAR (matriz de Roles) ----------
   Los botones de emitir reportes viven en TRES superficies (Empresas ->
   boton Reportar, el picker que abre, y Mi empresa). El servidor ya gatea
   de verdad (reports.js: report.marcaje/ausencia/ingreso/egreso/
   modificacion, gate real desde v4.74), pero la UI los pintaba por ROL
   LEGACY (canReport = !isEditor) o sin gate alguno: un rol sin ningun
   report.* (ej. Supervisor Tiendas) veia los botones y cobraba un 403 al
   usarlos. Mismo patron que v5.01 en Personal: se consulta my-perms una
   vez por sesion de panel y se cachea en module scope.
   Fallo de red / respuesta vacia => permisivo (el server protege igual y
   nadie se queda sin reportar por un error transitorio). */
const REPORT_CODES = ['report.marcaje', 'report.ausencia', 'report.ingreso', 'report.egreso', 'report.modificacion'];
let REPORT_PERMS = null;   // { 'report.marcaje': bool, ... } | null (aun no resuelto)

async function ensureReportPerms(user) {
  if (REPORT_PERMS) return REPORT_PERMS;
  const allow = () => { REPORT_PERMS = {}; REPORT_CODES.forEach(c => { REPORT_PERMS[c] = true; }); return REPORT_PERMS; };
  if (user.kind === 'admin' && user.role === 'superadmin') return allow();
  try {
    const r = await fetch('/api/my-perms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null }, codes: REPORT_CODES }),
    }).then(x => x.json());
    if (!r || !r.ok) return allow();
    if (r.super) return allow();
    REPORT_PERMS = {};
    REPORT_CODES.forEach(c => { REPORT_PERMS[c] = !!(r.perms && r.perms[c]); });
    return REPORT_PERMS;
  } catch (_) { return allow(); }
}
function canReportKind(kind) { return !REPORT_PERMS || !!REPORT_PERMS[`report.${kind}`]; }
function canReportAny() { return !REPORT_PERMS || REPORT_CODES.some(c => REPORT_PERMS[c]); }

/* Definicion de los 5 tiles: un solo sitio para el picker (Empresas) y para
   Mi empresa, asi no se duplica el HTML ni el gate. */
const REPORT_TILES = [
  { kind: 'marcaje', ico: '🕐', title: 'Marcaje Manual', desc: 'Registra entradas y salidas que no quedaron en el biométrico.' },
  { kind: 'ausencia', ico: '📅', title: 'Ausencia', desc: 'Reposos, permisos y faltas.' },
  { kind: 'ingreso', ico: '➕', title: 'Ingreso', desc: 'Nuevo trabajador en la tienda.' },
  { kind: 'egreso', ico: '🔴', title: 'Egreso', desc: 'Trabajador que deja la tienda.' },
  { kind: 'modificacion', ico: '✏️', title: 'Modificación', desc: 'Corrección de datos de un trabajador.' },
];
const REPORT_FN = {
  marcaje: marcajeReport, ausencia: ausenciaReport, ingreso: ingresoReport,
  egreso: egresoReport, modificacion: modificacionReport,
};
function reportTilesHtml() {
  return REPORT_TILES.filter(t => canReportKind(t.kind)).map(t => `
      <button class="report-tile" data-report="${t.kind}">
        <span class="rt-ico">${t.ico}</span>
        <span class="rt-body"><span class="rt-title">${t.title}</span>
          <span class="rt-desc">${t.desc}</span></span>
      </button>`).join('');
}
/* Cablea los tiles visibles de un host contra launchWizard. */
function wireReportTiles(host, u, onExit) {
  if (!host) return;
  REPORT_TILES.forEach(t => {
    const el = host.querySelector(`[data-report="${t.kind}"]`);
    if (el) el.addEventListener('click', () => { if (host.id === 'rpGrid') closeModal(); launchWizard(u, REPORT_FN[t.kind], onExit); });
  });
}

/* ---------- Selector de tipo de reporte (admin desde Empresas) ----------
   Reusa el wizard existente; el responsable sera la central (el admin).
   v5.04: solo se pintan los tipos que el rol tiene concedidos en la matriz. */
function openReportPicker(u, onExit) {
  openModal(`
    <div class="modal-head"><span>Reportar por ${u.pickedCompany}</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${u.pickedCompanyName || ''} · el reporte quedará a nombre de la central (Administrador).</p>
    <div class="report-grid" id="rpGrid" style="grid-template-columns:1fr">${reportTilesHtml()}</div>`);
  $('#mX').addEventListener('click', closeModal);
  wireReportTiles(document.querySelector('#rpGrid'), u, onExit);
}

/* ---------- VISTA: MI EMPRESA (solo rol tienda) ---------- */
async function viewMiEmpresa(user) {
  $('#pnlMain').innerHTML = `<div class="pnl-loading">Cargando…</div>`;
  // El catálogo (filtrado) trae solo la propia empresa de la tienda
  await ensureCatalog(user);
  await ensureReportPerms(user);   // v5.04: que tipos puede emitir este rol
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

    ${canReportAny() ? `<div class="pnl-head" style="margin-top:6px"><div><h2 style="font-size:18px;margin:0">Reportar a Nómina</h2>
      <p class="muted" style="margin:2px 0 0">Elige el tipo de novedad que quieres reportar.</p></div></div>
    <div class="report-grid" id="reportGrid">${reportTilesHtml()}</div>` : ''}`;

  wireReportTiles($('#reportGrid'), user, () => viewMiEmpresa(user));
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

/* ===================== v5.16: BADGE DE DOBLE EMPLEO =====================
   Pinta un contador rojo junto al item "Doble empleo" del menu, y publica
   el numero para que el Inicio muestre su tarjeta de aviso.

   Por que un badge: si nadie entra a la vista, nadie se entera. Son
   personas contando DOBLE en la nomina; tiene que verse sin buscarlo.

   Silencioso ante error: el endpoint gatea con view.dobleempleo, asi que
   un usuario sin permiso recibe 403 y aca no se pinta nada. Cualquier otra
   falla (red, backend) tampoco puede romper la carga del panel. */
let DOUBLE_EMP_N = 0;
export function getDoubleEmpCount() { return DOUBLE_EMP_N; }

async function paintDoubleEmpBadge(user) {
  try {
    const r = await fetch('/api/double-employment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'count', user }),
    }).then(x => x.json());

    if (!r || !r.ok || !r.n) return;   // sin permiso o sin casos: nada que mostrar
    DOUBLE_EMP_N = Number(r.n) || 0;
    if (!DOUBLE_EMP_N) return;

    const btn = document.querySelector('.pnl-side [data-view="dobleempleo"]');
    if (!btn || btn.querySelector('.pnl-badge')) return;

    if (!document.getElementById('pnlBadgeCss')) {
      const st = document.createElement('style');
      st.id = 'pnlBadgeCss';
      st.textContent = `
        .pnl-badge{margin-left:auto;background:#dc2626;color:#fff;border-radius:999px;
          min-width:19px;height:19px;padding:0 6px;font-size:11px;font-weight:800;
          display:inline-flex;align-items:center;justify-content:center;flex:none;
          line-height:1}
        .rail .pnl-badge{position:absolute;top:3px;right:3px;min-width:16px;height:16px;
          padding:0 4px;font-size:10px;margin-left:0}
        .rail [data-view="dobleempleo"]{position:relative}
        .rail [data-view="syncpend"]{position:relative}
        /* v5.40: el badge de Pendientes es AMBAR, no rojo. Doble empleo es una
           alarma (gente cobrando dos veces); Pendientes es trabajo por hacer.
           Si todo es rojo, nada es rojo. */
        .pnl-badge.warn{background:#d97706}`;
      document.head.appendChild(st);
    }

    const b = document.createElement('span');
    b.className = 'pnl-badge';
    b.textContent = String(DOUBLE_EMP_N);
    b.title = `${DOUBLE_EMP_N} persona${DOUBLE_EMP_N === 1 ? '' : 's'} activa${DOUBLE_EMP_N === 1 ? '' : 's'} en dos tiendas a la vez`;
    btn.appendChild(b);

    // El Inicio puede haberse pintado antes que esta respuesta: se le avisa.
    document.dispatchEvent(new CustomEvent('doubleemp:count', { detail: { n: DOUBLE_EMP_N } }));
  } catch (_) { /* un badge no rompe el panel */ }
}

/* ===================== v5.40: BADGE DE PENDIENTES =====================
   Contador ambar junto a "Pendientes" (Recibir del sistema).

   Misma razon que el de Doble empleo: si nadie entra a la vista, nadie se
   entera. Las 3 cuentas bancarias en conflicto llevaban semanas ahi porque
   vivian dentro de una fila expandible del Registro. Un numero en el menu
   convierte "algo que hay que ir a mirar" en "algo que te esta esperando".

   Ambar, no rojo: Doble empleo es una ALARMA (gente cobrando dos veces);
   esto es TRABAJO POR HACER. Si todo es rojo, nada es rojo.

   Cuenta SOLO los conflictos (los que necesitan una decision). Los datos mal
   escritos y las tiendas saltadas no van al badge: no se resuelven desde el
   portal, asi que un numero que no baja nunca es ruido.

   Silencioso ante error: un badge no puede romper la carga del panel. */
export async function paintSyncPendBadge(user) {
  try {
    const r = await fetch('/api/sync-pending', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminId: user.id,
        user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null },
      }),
    }).then(x => x.json());

    if (!r || !r.ok || !r.counts) return;
    const n = Number(r.counts.conflicts) || 0;

    const btn = document.querySelector('.pnl-side [data-view="syncpend"]');
    if (!btn) return;

    /* ⚠ v5.51: ANTES ESTO SE PINTABA UNA SOLA VEZ Y NUNCA MAS.

       El codigo decia: si ya hay un badge, no hagas nada (`return`). Resultado
       (Pablo, 2026-07-14): corres la sincronizacion, los conflictos bajan de 5
       a 3, la pagina lo muestra bien... y el menu SIGUE DICIENDO 5. Habia que
       recargar el navegador para verlo.

       Un numero que no cambia cuando el dato cambio no es un numero: es una
       mentira. Ahora se reescribe: si bajo, baja; si llego a cero, se va. */
    let b = btn.querySelector('.pnl-badge');

    if (!n) { if (b) b.remove(); return; }   // resueltos todos: sin badge

    if (!b) {
      b = document.createElement('span');
      btn.appendChild(b);
    }
    b.className = 'pnl-badge warn';
    b.textContent = String(n);
    b.title = `${n} dato${n === 1 ? '' : 's'} que necesita${n === 1 ? '' : 'n'} una decisi\u00f3n`;
  } catch (_) { /* un badge no rompe el panel */ }
}

export function renderPanel() {
  const user = getSession();
  if (!user) { go('/login'); return; }
  // Limpiar estado en memoria de cualquier sesión previa (evita que datos
  // de un usuario anterior "se filtren" si se cambia de sesión sin recargar).
  CATALOG = null; CU_ROWS = null; SCOPE = null; USERS_USER = null; TIENDAS_FILTERS = null; currentView = 'dashboard';
  mount(shell(user));
  loadAvatar((user.email || '').trim().toLowerCase());
  /* v5.06: la etiqueta de rol de la topbar sale del catalogo de Roles, pero
     shell() se pinta ANTES de que exista (ensureAdminRoles solo corre al entrar
     a Equipo). Se precarga en segundo plano y se repinta la pastilla: asi un rol
     nuevo muestra su nombre ('Gerente Zona') y no el code crudo
     ('gerente_zona'). Si falla, queda el fallback historico. */
  if (user.kind === 'admin') {
    (async () => {
      try {
        await ensureAdminRoles(user);
        const el = document.querySelector('.pnl-urole');
        if (el) el.textContent = roleLabelOf(user.role);
      } catch (_) { /* queda la etiqueta inicial */ }
    })();
  }
  // v4.69: MENU DINAMICO (Etapa 1 del editor visual de roles). Todos los
  // items del nav (menos los superonly) se pintan y luego se PODAN segun la
  // matriz de Roles del propio actor (permisos view.* enforced, via
  // /api/my-perms). Aplica a todos los roles no-super, INCLUIDAS las
  // tiendas (resolveActor las evalua con el rol 'tienda'). Superadmin no
  // consulta: ve todo. Si la consulta falla o viene vacia, el menu queda
  // como esta y los endpoints gatean igual (defensa en profundidad, y
  // nadie se queda sin menu por un error de red).
  (async function applyMenuPerms() {
    if (user.kind === 'admin' && user.role === 'superadmin') return;
    if (user.kind !== 'admin' && user.kind !== 'company') return;
    // data-view -> permiso view.* que gobierna el item. Los superonly del
    // nav (firmantes, sync, permisos, roles, config, resetdata) NO estan
    // en el MAP: su gate sigue siendo isSuper en shell() (defensa doble).
    const MAP = {
      dashboard: 'view.dashboard', miempresa: 'view.miempresa',
      usuarios: 'view.usuarios', documentos: 'view.documentos',
      calendario: 'view.calendario',
      tiendas: 'view.empresas', catalogos: 'view.estructura',
      fotos: 'view.fotos', buscar: 'view.buscar',
      datosincompletos: 'view.datosincompletos', egmotivos: 'view.egmotivos',
      dobleempleo: 'view.dobleempleo',
      norehire: 'view.norehire',
      norehirecheck: 'view.norehirecheck',
      movimientos: 'view.movimientos',
      movquincena: 'view.movquincena',
      cambiocargo: 'view.cambiocargo',
      cargohistorial: 'view.cambiocargo',
      rostersync: 'view.rostersync',
      historial: 'view.historial', estadisticas: 'view.estadisticas',
      misstats: 'view.misstats', reportempresas: 'view.reportempresas',
      estadopago: 'view.estadopago',
      avisos: 'view.avisos', avisosconfig: 'view.avisosconfig',
      constancias: 'view.solicitudes',
      syncreview: 'view.syncreview', axcompare: 'view.axcompare',
      axhistory: 'view.axhistory', synclog: 'view.synclog', erpquery: 'view.erpquery',
      // v5.40: Pendientes reusa el permiso del Registro (view.synclog). Son la
      // misma informacion vista de dos formas: el Registro la cuenta por corrida
      // y Pendientes la junta por caso. Quien puede ver una, puede ver la otra;
      // crear un permiso nuevo solo agregaria un lugar mas donde equivocarse.
      syncpend: 'view.synclog',
      bankstats: 'view.bankstats', banksync: 'view.banksync', bankhist: 'view.bankhist',
      bankaccounts: 'view.bankaccounts',
      wadifusion: 'view.whatsapp',
      wamensajes: 'view.wa.templates',
      waencuestas: 'view.whatsapp',
      wahistorial: 'view.whatsapp',
      wagrupos: 'view.whatsapp',
      equipo: 'view.equipo',
    };
    try {
      const r = await fetch('/api/my-perms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null }, codes: [...new Set(Object.values(MAP))] }),
      }).then(x => x.json());
      if (!r || !r.ok || r.super) return;
      // Anti-bloqueo: si NINGUN permiso vino concedido, algo anda mal
      // (matriz vacia o backend caido). Mejor menu completo que vacio.
      if (!Object.values(r.perms || {}).some(Boolean)) return;
      Object.entries(MAP).forEach(([view, code]) => {
        if (r.perms && r.perms[code]) return;
        document.querySelectorAll(`.pnl-side [data-view="${view}"]`).forEach(btn => { btn.style.display = 'none'; });
      });
      // Ocultar grupos que quedaron sin items visibles.
      document.querySelectorAll('.pnl-side .nav-group').forEach(g => {
        const anyVisible = [...g.querySelectorAll('button[data-view]')].some(b => b.style.display !== 'none');
        if (!anyVisible) g.style.display = 'none';
      });
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
  // v5.16: badge de DOBLE EMPLEO en el menu. Solo pinta si hay casos y si el
  // usuario tiene el permiso (el endpoint gatea; si no lo tiene, devuelve 403
  // y no se pinta nada). Silencioso ante cualquier error: un badge no puede
  // romper la carga del panel.
  paintDoubleEmpBadge(user);
  // v5.40: badge de PENDIENTES (conflictos que esperan una decision). Mismo
  // criterio: silencioso, y solo pinta si hay algo.
  if (user.kind === 'admin') paintSyncPendBadge(user);
  // Guardian del boton Atras: convierte el Atras del navegador en "volver a la
  // vista anterior dentro del portal" y evita salirse de la pagina por error.
  VIEW_STACK = [];
  installBackGuard(user);
  // Landing unificado: ambos arrancan en el Dashboard (Inicio).
  navigate('dashboard', user);
}
