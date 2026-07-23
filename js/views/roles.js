/* =====================================================================
   js/views/roles.js  →  vista "Roles" (solo superadmin)
   Matriz de Roles y Permisos sobre nomina_v2.roles / permissions /
   role_permissions — las mismas tablas que decide can() en el servidor.
   Mockup aprobado: _PRUEBAS\roles_mockup.html (v0-mock6).

   Dos pantallas:
     1) GRILLA de roles: tipo (sistema / todas las empresas / estandar),
        # permisos, # usuarios; Editar y, en el menu "...", Desactivar (solo
        roles no-sistema); Nuevo rol.
     2) DETALLE de un rol: permisos agrupados por dominio (Vistas primero,
        con subgrupos del menu), modo lectura/edicion, buscador, "Todo el
        grupo", copiar desde otro rol, y la regla "USAR IMPLICA VER": los
        config.* encienden y sostienen su view.cfg.* correspondiente.

   El guardado reemplaza la matriz del rol via /api/roles (accion save);
   el servidor re-aplica la regla usar->ver e invalida el cache de permisos.
   superadmin no se edita (todo por codigo); tienda si (pasa por permSet).
   ===================================================================== */

import { $ } from '../core/dom.js';
/* v5.06: al tocar el catalogo de roles (crear / editar / activar / desactivar)
   hay que TIRAR el cache de roles del panel (ADMIN_ROLES, module scope), o el
   combo de Equipo > Nuevo miembro sigue mostrando el catalogo viejo hasta que
   el usuario recargue con F5. Se usa un hook GLOBAL y no un import de panel.js
   a proposito: panel.js ya importa esta vista, y un import de vuelta crearia un
   ciclo ESM justo en el modulo raiz del portal (el tipo de cosa que rompe el
   build de Pages y no se ve en local). El guard deja la vista funcionando aunque
   el hook no exista. */
function dropRolesCache() {
  if (typeof window !== 'undefined' && typeof window.__invalidateAdminRoles === 'function') {
    window.__invalidateAdminRoles();
  }
}

async function api(payload) {
  const res = await fetch('/api/roles', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}
function userPayload(user) {
  return { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null };
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* Regla "usar implica ver" (espejo del servidor). */
const IMPLIES = {
  'config.referencias': 'view.cfg.referencias',
  'config.cargos': 'view.cfg.cargos',
  'config.incidencias': 'view.cfg.incidencias',
  'config.calendario': 'view.cfg.calendario',
  'config.sincronizacion': 'view.cfg.sincronizacion',
  'config.osticket': 'view.cfg.osticket',
  'settings.save': 'view.cfg.ajustes',
};
const IMPLIED_BY = {};
Object.entries(IMPLIES).forEach(([u, v]) => { IMPLIED_BY[v] = u; });

/* Subgrupos del dominio "Vistas" (orden del menu del portal). Lo que no
   este mapeado cae en "Otras vistas". */
const VIEW_SUBGROUPS = [
  ['Menu principal', ['view.dashboard', 'view.usuarios', 'view.documentos', 'view.calendario']],
  ['Organizacion', ['view.empresas', 'view.estructura']],
  ['Personal', ['view.buscar', 'view.datosincompletos', 'view.dobleempleo', 'view.movimientos', 'view.egmotivos', 'view.rostersync', 'view.fotos']],
  ['Reportes', ['view.historial', 'view.estadisticas', 'view.reportempresas', 'view.estadopago', 'view.misstats']],
  ['Comunicacion', ['view.avisos', 'view.avisosconfig']],
  ['Solicitudes', ['view.solicitudes', 'view.firmantes']],
  ['Sincronizacion', ['view.synclog', 'view.syncpend', 'view.sync', 'view.syncreview', 'view.axhistory', 'view.axcompare', 'view.erpquery']],
  ['Datos bancarios', ['view.bankstats', 'view.banksync', 'view.bankhist', 'view.bankaccounts']],
  ['WhatsApp', ['view.whatsapp']],
  ['Administracion', ['view.equipo', 'view.permisos', 'view.config', 'view.roles', 'view.resetdata']],
  ['Empresa (tienda)', ['view.miempresa']],
  ['Ver pestañas de Configuracion', ['view.cfg.referencias', 'view.cfg.cargos', 'view.cfg.incidencias', 'view.cfg.calendario', 'view.cfg.sincronizacion', 'view.cfg.osticket', 'view.cfg.ajustes']],
];

/* v4.70: CATALOGO DEL MENU para el editor visual (modo "Menu").
   Calcado del NAV real de shell(): grupos -> items (data-view real) con su
   permiso view.* y las ACCIONES (permisos de uso) que viven dentro de cada
   menu. Las etiquetas y ayudas de cada accion salen de ST.permissions (BD).
   Un mismo code puede colgar de VARIOS menus (ej. report.* en Empresas, Mi
   empresa y Personal; hcm.publish en Sincronizar y Comparar): la piel
   sincroniza por code contra ST.work, no hay duplicacion real en BD. */
const MENU_CATALOG = [
  { g: '', items: [
    { id: 'dashboard', lbl: 'Inicio', view: 'view.dashboard', acts: [] },
    { id: 'miempresa', lbl: 'Mi empresa', view: 'view.miempresa', acts: ['report.marcaje', 'report.ausencia', 'report.ingreso', 'report.egreso', 'report.modificacion'] },
    { id: 'usuarios', lbl: 'Usuarios', view: 'view.usuarios', acts: ['compuser.create', 'compuser.reset', 'compuser.toggle', 'compuser.email', 'entuser.create', 'entuser.update', 'entuser.reset', 'entuser.toggle', 'entuser.scope'] },
    { id: 'documentos', lbl: 'Documentos', view: 'view.documentos', acts: ['docs.create', 'docs.version', 'docs.edit', 'docs.archive', 'docs.delete', 'docs.categories'] },
    { id: 'calendario', lbl: 'Calendario', view: 'view.calendario', acts: [] },
  ] },
  { g: 'Organizacion', items: [
    { id: 'tiendas', lbl: 'Empresas', view: 'view.empresas', acts: ['company.contact', 'company.responsables', 'dept.create', 'dept.rename', 'dept.toggle', 'dept.delete', 'report.marcaje', 'report.ausencia', 'report.ingreso', 'report.egreso', 'report.modificacion'] },
    { id: 'catalogos', lbl: 'Estructura', view: 'view.estructura', acts: [] },
  ] },
  { g: 'Personal', items: [
    // v5.03: los botones de emitir reportes tambien viven en la vista Personal
    // (ficha del trabajador). Es el MISMO code que en Empresas y Mi empresa: la
    // piel sincroniza por code (un solo estado en ST.work -> una sola fila en BD).
    { id: 'fotos', lbl: 'Personal', view: 'view.fotos', acts: ['photo.manage', 'ficha.edit', 'dept.assign', 'bankref.upload', 'rif.upload', 'report.marcaje', 'report.ausencia', 'report.ingreso', 'report.egreso', 'report.modificacion'] },
    { id: 'buscar', lbl: 'Buscar', view: 'view.buscar', acts: [] },
    { id: 'datosincompletos', lbl: 'Datos incompletos', view: 'view.datosincompletos', acts: [] },
    // v5.19: Doble empleo. Solo consulta (los casos se corrigen en el sistema),
    // por eso no tiene acciones: el permiso de vista es todo lo que hay.
    { id: 'dobleempleo', lbl: 'Doble empleo', view: 'view.dobleempleo', acts: [] },
    // v5.80: No reempleables (pantalla completa, con motivos) y Verificar
    // candidato (consulta sin motivos, apta para tiendas). Ninguna tiene
    // acciones: la lista se mantiene en el sistema, el portal solo consulta.
    { id: 'norehire', lbl: 'No reempleables', view: 'view.norehire', acts: [] },
    { id: 'norehirecheck', lbl: 'Verificar candidato', view: 'view.norehirecheck', acts: [] },
    // v5.93: Movimientos. Solo consulta (los movimientos se derivan de los
    // cortes quincenales del sistema), por eso sin acciones.
    // v6.36: etiqueta renombrada a "Rotacion"; id y permiso NO cambian.
    { id: 'movimientos', lbl: 'Rotación', view: 'view.movimientos', acts: [] },
    // v6.37: Movimientos de la quincena (vista operativa). Solo consulta.
    { id: 'movquincena', lbl: 'Movimientos', view: 'view.movquincena', acts: [] },
    { id: 'egmotivos', lbl: 'Ratificar egresos', view: 'view.egmotivos', acts: ['egress.ratify'] },
    { id: 'rostersync', lbl: 'Carga de personal', view: 'view.rostersync', acts: ['roster.upload', 'roster.upload_ax', 'roster.upload_api', 'roster.manual', 'roster.clear'] },
  ] },
  { g: 'Reportes', items: [
    { id: 'historial', lbl: 'Historial', view: 'view.historial', acts: ['report.attention'] },
    { id: 'estadisticas', lbl: 'Estadisticas', view: 'view.estadisticas', acts: [] },
    { id: 'misstats', lbl: 'Mis estadisticas', view: 'view.misstats', acts: [] },
    { id: 'reportempresas', lbl: 'Analisis', view: 'view.reportempresas', acts: [] },
    { id: 'estadopago', lbl: 'Estado de pago', view: 'view.estadopago', acts: [] },
  ] },
  { g: 'Comunicacion', items: [
    { id: 'avisos', lbl: 'Avisos', view: 'view.avisos', acts: [] },
    { id: 'avisosconfig', lbl: 'Envio de avisos', view: 'view.avisosconfig', acts: ['avisos.templates', 'avisos.manual'] },
  ] },
  { g: 'Solicitudes', items: [
    { id: 'constancias', lbl: 'Constancias', view: 'view.solicitudes', acts: ['cert.request', 'cert.generate', 'cert.reject', 'cert.cancel'] },
    { id: 'firmantes', lbl: 'Firmantes', view: 'view.firmantes', acts: ['cert.signers'] },
  ] },
  /* v5.55 — CALCADO DEL MENU REAL (v5.48).

     El catalogo se habia quedado en la version vieja: nombres que ya no existen
     ("Registro", "Sincronizar", "Configurar (sincronizaciones)"), el orden de
     antes, y — lo importante — LA PAGINA DIFERENCIAS NO ESTABA. Se podia entrar
     a Roles y no encontrarla por ningun lado, aunque es donde se decide sobre
     cuentas bancarias.

     Ahora refleja el menu tal cual, con sus tres subtitulos:

       CORRIDA AUTOMATICA
         Ultima corrida
           └ Diferencias      <- colgaba de la corrida y no existia aca
         Configurar
       ENVIAR AL SISTEMA
         Publicar
         Historial de envios
       HERRAMIENTAS
         Comparar
         Consultar API

     `sub`   = subtitulo de seccion (el rotulo gris del menu real).
     `child` = cuelga de la linea de arriba (la indentacion del menu).

     ⚠ view.syncpend se CREO en BD junto con este cambio. No existia: la pagina
     se protegia solo con 'adminonly' en el menu, o sea que NO se podia dar ni
     quitar por rol. Nace con enforced=false porque el gate real sigue siendo
     'adminonly'; cuando el menu pase a mirar el permiso, se sube a true. */
  { g: 'Sincronizacion', items: [
    { id: 'synclog', lbl: 'Ultima corrida', view: 'view.synclog', acts: ['hcm.log'], sub: 'Corrida automatica' },
    { id: 'syncpend', lbl: 'Diferencias', view: 'view.syncpend', acts: ['hcm.sync', 'hcm.publish', 'hcm.discard'], child: true },
    { id: 'sync', lbl: 'Configurar', view: 'view.sync', acts: [] },

    // v5.24: Publicar publica (sin la cuenta) y anula -> dos llaves.
    { id: 'syncreview', lbl: 'Publicar', view: 'view.syncreview', acts: ['hcm.publish', 'hcm.discard'], sub: 'Enviar al sistema' },
    { id: 'axhistory', lbl: 'Historial de envios', view: 'view.axhistory', acts: [] },

    { id: 'axcompare', lbl: 'Comparar', view: 'view.axcompare', acts: ['hcm.sync', 'hcm.publish'], sub: 'Herramientas' },
    { id: 'erpquery', lbl: 'Consultar API', view: 'view.erpquery', acts: ['hcm.query'] },
  ] },
  // v4.81: grupo Datos bancarios (v4.78-4.80) en el editor visual.
  // v5.23/v5.24: banksync YA NO publica la ficha completa: publica SOLO la
  // cuenta bancaria. Por eso su llave es hcm.publish.bank (el dato que define
  // a que cuenta se le paga), no la generica hcm.publish.
  { g: 'Datos bancarios', items: [
    { id: 'bankstats', lbl: 'Estadisticas', view: 'view.bankstats', acts: [] },
    { id: 'banksync', lbl: 'Sincronizar', view: 'view.banksync', acts: ['hcm.publish.bank', 'hcm.discard'] },
    { id: 'bankhist', lbl: 'Historial', view: 'view.bankhist', acts: [] },
    // v4.82: Cuentas, habilitada a todos los roles (grilla de solo lectura).
    { id: 'bankaccounts', lbl: 'Cuentas', view: 'view.bankaccounts', acts: [] },
  ] },
  // v4.90/v4.97: grupo WhatsApp. Conceder view.whatsapp + wa.send desde
  // aqui habilita Difusion al rol (cada admin limitado a los grupos que
  // el superadmin le asigne en la pantalla Grupos). La pantalla Grupos
  // NO se ofrece: es gobernanza exclusiva de superadmin.
  { g: 'WhatsApp', items: [
    { id: 'wadifusion', lbl: 'Difusión', view: 'view.whatsapp', acts: ['wa.send'] },
  ] },
  { g: 'Administracion', items: [
    { id: 'equipo', lbl: 'Equipo', view: 'view.equipo', acts: ['team.create', 'team.reset', 'team.toggle', 'team.role', 'team.scope', 'team.osticket', 'team.scope_override'] },
    { id: 'permisos', lbl: 'Permisos (alcance)', view: 'view.permisos', acts: [] },
    { id: 'roles', lbl: 'Roles', view: 'view.roles', acts: [] },
    { id: 'config', lbl: 'Configuracion', view: 'view.config', acts: ['config.referencias', 'config.cargos', 'config.incidencias', 'config.calendario', 'config.sincronizacion', 'config.osticket', 'settings.save'] },
    { id: 'resetdata', lbl: 'Reiniciar datos', view: 'view.resetdata', acts: [] },
  ] },
];

/* ===================== ESTILOS ===================== */
function ensureStyles() {
  if (document.getElementById('rlStyles')) return;
  const st = document.createElement('style');
  st.id = 'rlStyles';
  st.textContent = `
  /* v5.25: el menu "..." es un absolute dentro de la <td>. Con overflow:hidden
     en el contenedor, el desplegable de las ultimas filas quedaba CORTADO. Se
     pasa a overflow:visible; el radius de las esquinas lo sostienen el thead y
     la ultima fila, asi que visualmente no cambia nada. */
  .rl-tablebox{border:1px solid var(--border,#e6eaf0);border-radius:14px;overflow:visible;background:var(--card,#fff);box-shadow:0 1px 3px rgba(15,23,42,.04),0 8px 30px rgba(15,23,42,.05)}
  .rl-tablebox table{width:100%;border-collapse:collapse;font-size:13.5px}
  .rl-tablebox thead tr:first-child th:first-child{border-top-left-radius:13px}
  .rl-tablebox thead tr:first-child th:last-child{border-top-right-radius:13px}
  .rl-tablebox tbody tr:last-child td:first-child{border-bottom-left-radius:13px}
  .rl-tablebox tbody tr:last-child td:last-child{border-bottom-right-radius:13px}
  .rl-tablebox th{background:#fbfcfe;font-weight:600;color:var(--ink-soft,#475569);font-size:12px;text-transform:uppercase;letter-spacing:.03em;text-align:left;padding:13px 18px;border-bottom:1px solid var(--border,#e6eaf0);white-space:nowrap}
  .rl-tablebox td{padding:15px 18px;border-bottom:1px solid var(--border-soft,#f1f4f8);vertical-align:middle}
  .rl-tablebox tbody tr:last-child td{border-bottom:0}
  .rl-tablebox tbody tr{transition:background .1s;cursor:pointer}
  .rl-tablebox tbody tr:hover{background:#fafbfd}
  .rl-rname{font-weight:600;font-size:14px}
  .rl-rdesc{font-size:12px;color:var(--muted,#64748b);margin-top:2px;font-family:ui-monospace,Menlo,monospace}
  /* v5.27: los numeros se alinean a la derecha en la CELDA y en el HEADER.
     Antes solo la celda lo hacia -> el titulo quedaba a la izquierda y el
     numero a la derecha, con ese zigzag. */
  .rl-num{text-align:right;font-variant-numeric:tabular-nums}
  .rl-tablebox th.rl-num{text-align:right}
  /* Nota bajo la pildora de Tipo: la particularidad del rol. */
  .rl-note{font-size:11.5px;color:var(--muted,#64748b);margin-top:5px;line-height:1.35;max-width:230px}
  /* El conteo de Usuarios es tocable: abre quienes lo tienen. */
  .rl-ucnt{border:0;background:none;font:inherit;font-variant-numeric:tabular-nums;color:var(--brand,#2563eb);font-weight:650;cursor:pointer;padding:2px 7px;border-radius:7px;text-decoration:underline;text-underline-offset:2px;text-decoration-color:#bfd3f7}
  .rl-ucnt:hover{background:#eff4ff}
  .rl-ucnt.zero{color:var(--faint,#94a3b8);cursor:default;text-decoration:none}
  .rl-ucnt.zero:hover{background:none}
  /* Lista de usuarios del rol (modal). */
  .rl-ul{display:flex;flex-direction:column;gap:2px;max-height:46vh;overflow:auto;margin-top:4px}
  .rl-ur{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:9px}
  .rl-ur:hover{background:var(--border-soft,#f1f4f8)}
  .rl-uav{width:31px;height:31px;border-radius:50%;background:#eff4ff;color:#1e40af;display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:700;flex:none}
  .rl-ug{flex:1;min-width:0}
  .rl-un{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rl-us{font-size:11.5px;color:var(--muted,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rl-uoff{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;background:#fdecec;color:#991b1b;flex:none}
  .rl-pill{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:999px;font-size:11.5px;font-weight:600;white-space:nowrap}
  .rl-pill::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.9}
  .rl-pill-sys{background:#0f172a;color:#fff}.rl-pill-sys::before{background:#93c5fd}
  .rl-pill-ro{background:#fef6e7;color:#92400e}
  .rl-pill-gray{background:var(--border-soft,#f1f4f8);color:var(--ink-soft,#475569)}.rl-pill-gray::before{display:none}
  .rl-pill-off{background:#fdecec;color:#991b1b}
  .rl-rowacts{display:flex;gap:6px;justify-content:flex-end;align-items:center}
  /* v5.27: el chevron de la fila se quito (era redundante). .rl-chev sigue
     definido porque lo usa el boton "Volver" del detalle. */
  .rl-chev{color:var(--faint,#94a3b8)}
  /* v5.25: menu "..." por fila. Desactivar era un boton suelto pegado al
     chevron que abre el detalle: un clic desviado y estabas en un modal
     destructivo. Ahora vive detras del menu, separado del chevron, y ademas
     hay una franja muerta (.rl-chevpad) entre el menu y la flecha. */
  .rl-kebab{position:relative;display:inline-flex}
  .rl-kbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--border,#e6eaf0);border-radius:8px;background:var(--card,#fff);color:var(--muted,#64748b);cursor:pointer;padding:0}
  .rl-kbtn:hover{background:var(--border-soft,#f1f4f8);color:var(--ink,#0f172a)}
  .rl-kbtn.open{background:var(--border-soft,#f1f4f8);color:var(--ink,#0f172a)}
  .rl-kmenu{display:none;position:absolute;top:calc(100% + 6px);right:0;min-width:186px;background:var(--card,#fff);border:1px solid var(--border,#e6eaf0);border-radius:11px;box-shadow:0 10px 34px rgba(15,23,42,.16);z-index:40;padding:5px;text-align:left}
  .rl-kmenu.open{display:block}
  .rl-kitem{display:flex;align-items:center;gap:9px;width:100%;padding:9px 11px;border:0;background:none;font:inherit;font-size:13px;color:var(--ink,#0f172a);border-radius:7px;cursor:pointer;text-align:left}
  .rl-kitem:hover{background:var(--border-soft,#f1f4f8)}
  .rl-kitem svg{width:15px;height:15px;flex:none;color:var(--muted,#64748b)}
  .rl-kitem.danger{color:var(--danger,#dc2626)}
  .rl-kitem.danger svg{color:var(--danger,#dc2626)}
  .rl-kitem.danger:hover{background:#fef2f2}
  .rl-ksep{height:1px;background:var(--border-soft,#f1f4f8);margin:4px 6px}
  /* Franja muerta: separaba el menu del chevron. El chevron ya no esta
     (v5.27), pero el padding sostiene el aire al borde derecho. */
  .rl-chevpad{width:10px;flex:none}
  .rl-back{cursor:pointer;color:var(--muted,#64748b);display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;border:0;background:none;font-family:inherit;padding:4px 0;margin-bottom:6px}
  .rl-back:hover{color:var(--ink,#0f172a)}
  .rl-viewbadge{font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:999px;background:var(--border-soft,#f1f4f8);color:var(--muted,#64748b);letter-spacing:.03em;vertical-align:middle}
  .rl-viewbadge.editing{background:#fef6e7;color:#92400e}
  .rl-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
  .rl-copybar{display:flex;align-items:center;gap:8px;background:#eff4ff;border:1px solid #cfe0ff;border-radius:8px;padding:8px 12px;font-size:12.5px;color:#1e3a8a;margin-bottom:14px;flex-wrap:wrap}
  .rl-copybar select{height:30px;border:1px solid #cfe0ff;border-radius:6px;font-family:inherit;font-size:12.5px;padding:0 6px;background:#fff}
  .rl-copybar .sp{flex:1}
  .rl-copybar.locked{opacity:.5;pointer-events:none}
  .rl-mini-note{font-size:11.5px;color:var(--faint,#94a3b8)}
  .rl-dom{border:1px solid var(--border,#e6eaf0);border-radius:10px;margin-bottom:10px;overflow:visible;background:var(--card,#fff)}
  .rl-dom-h{display:flex;align-items:center;gap:12px;padding:12px 14px;cursor:pointer;user-select:none;border-radius:9px 9px 0 0}
  .rl-dom.collapsed .rl-dom-h{border-radius:9px}
  .rl-dom-h:hover{background:var(--border-soft,#f1f4f8)}
  .rl-dom-title{font-weight:650;font-size:13.5px}
  .rl-dom-count{font-size:11.5px;color:var(--muted,#64748b);font-weight:600;font-variant-numeric:tabular-nums}
  .rl-dom-h .sp{flex:1}
  .rl-dom-selall{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--brand,#2563eb);font-weight:600}
  .rl-dom-selall input{width:15px;height:15px;accent-color:var(--brand,#2563eb)}
  .viewmode .rl-dom-selall{display:none}
  .rl-dchev{width:16px;height:16px;color:var(--faint,#94a3b8);transition:transform .18s}
  .rl-dom.collapsed .rl-dchev{transform:rotate(-90deg)}
  .rl-dom-note{font-size:11.5px;color:var(--muted,#64748b);padding:2px 14px 10px;font-style:italic}
  .rl-dom.collapsed .rl-dom-note{display:none}
  .rl-dom-sub{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--faint,#94a3b8);padding:8px 4px 3px;grid-column:1/-1}
  .rl-dom-body{padding:4px 14px 12px;display:grid;grid-template-columns:1fr 1fr;gap:2px 22px}
  .rl-dom.collapsed .rl-dom-body{display:none}
  @media(max-width:640px){.rl-dom-body{grid-template-columns:1fr}}
  .rl-perm{display:flex;align-items:flex-start;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border-soft,#f1f4f8);min-width:0}
  .rl-perm .rl-sw{margin-top:2px}
  .rl-perm .txt{flex:1;min-width:0;cursor:pointer}
  .viewmode .rl-perm .txt{cursor:default}
  .rl-perm .plabel{font-size:13px;font-weight:500}
  .rl-perm .pcode{font-size:10.5px;color:var(--faint,#94a3b8);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .rl-perm.implied .plabel::after{content:" · encendido por 'usar'";color:var(--brand,#2563eb);font-weight:600;font-size:10.5px}
  .rl-qh{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--border-soft,#f1f4f8);color:var(--muted,#64748b);font-size:10.5px;font-weight:700;cursor:help;flex:none;user-select:none;vertical-align:2px;margin-left:4px}
  .rl-qh:hover{background:#eff4ff;color:var(--brand,#2563eb)}
  .rl-qh .tip{display:none;position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);width:250px;max-width:70vw;background:#0f172a;color:#e5edff;font-size:11.5px;font-weight:400;line-height:1.45;padding:9px 11px;border-radius:8px;z-index:60;box-shadow:0 8px 24px rgba(15,23,42,.28);text-align:left;white-space:normal}
  .rl-qh .tip::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:#0f172a}
  .rl-qh:hover .tip,.rl-qh.open .tip{display:block}
  .rl-sw{position:relative;width:38px;height:22px;flex-shrink:0;cursor:pointer;display:inline-block}
  .rl-sw input{opacity:0;width:0;height:0;position:absolute}
  .rl-sw .track{position:absolute;inset:0;background:var(--border,#e6eaf0);border-radius:999px;transition:background .15s}
  .rl-sw .knob{position:absolute;top:2px;left:2px;width:18px;height:18px;background:#fff;border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .15s}
  .rl-sw input:checked + .track{background:var(--brand,#2563eb)}
  .rl-sw input:checked ~ .knob{left:18px}
  .rl-sw.impliedlock input:checked + .track{background:#93b8f5}
  .viewmode .rl-sw{pointer-events:none}
  .viewmode .rl-sw .knob{box-shadow:none}
  .viewmode .rl-sw input:not(:checked) + .track{background:var(--border-soft,#f1f4f8)}
  .viewmode .rl-sw input:not(:checked) ~ .knob{background:#cbd5e1}
  .rl-supernote{background:#eff4ff;border:1px solid #cfe0ff;border-radius:10px;padding:12px 16px;font-size:13px;color:#1e3a8a;margin-bottom:14px}
  /* ===== v4.70 editor visual de menu (modo Menu) ===== */
  .rl-mode{display:inline-flex;border:1px solid var(--border,#e6eaf0);border-radius:9px;overflow:hidden}
  .rl-mode button{font:inherit;font-size:12.5px;font-weight:600;padding:7px 13px;border:0;background:var(--card,#fff);color:var(--muted,#64748b);cursor:pointer}
  .rl-mode button.on{background:var(--brand,#2563eb);color:#fff}
  .rl-me{display:grid;grid-template-columns:320px 1fr;gap:14px;align-items:start}
  @media(max-width:860px){.rl-me{grid-template-columns:1fr}}
  .rl-me-menu{border:1px solid var(--border,#e6eaf0);border-radius:13px;overflow:hidden;background:var(--card,#fff)}
  .rl-me-g{padding:3px 0}
  .rl-me-g + .rl-me-g{border-top:1px solid var(--border-soft,#f1f4f8)}
  .rl-me-gl{display:flex;align-items:center;gap:8px;padding:9px 14px 3px;font-size:10.5px;font-weight:800;letter-spacing:.08em;color:var(--faint,#94a3b8);text-transform:uppercase}
  .rl-me-it{display:flex;align-items:center;gap:9px;padding:7px 14px;cursor:pointer;border-left:3px solid transparent}
  .rl-me-it:hover{background:#eff6ff}
  .rl-me-it.sel{background:#eff6ff;border-left-color:var(--brand,#2563eb)}
  .rl-me-it.off .melbl{color:var(--faint,#94a3b8);text-decoration:line-through;text-decoration-color:#cbd5e1}
  .rl-me-it .melbl{font-size:13px;font-weight:550;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* v5.55: el menu real tiene SUBTITULOS dentro de un grupo (Corrida automatica /
     Enviar al sistema / Herramientas) y una linea INDENTADA (Diferencias cuelga
     de Ultima corrida). El editor mostraba las 7 lineas planas y en otro orden:
     no se parecia al menu que el rol iba a ver. */
  .rl-me-sub{font-size:9.5px;font-weight:800;letter-spacing:.07em;color:var(--faint,#94a3b8);
             text-transform:uppercase;padding:9px 14px 2px}
  .rl-me-g .rl-me-sub:first-child{padding-top:4px}
  /* La hija: sangrada y con la guia vertical, igual que en el menu del portal. */
  .rl-me-it.child{padding-left:30px;position:relative}
  .rl-me-it.child::before{content:'';position:absolute;left:20px;top:0;bottom:50%;
                          width:1px;background:var(--border,#e6eaf0)}
  .rl-me-it.child::after{content:'';position:absolute;left:20px;top:50%;width:5px;height:1px;
                         background:var(--border,#e6eaf0)}
  .rl-me-it .mecnt{font-size:9.5px;color:var(--muted,#64748b);background:var(--border-soft,#f1f4f8);border-radius:999px;padding:1px 6px;font-weight:700}
  .rl-me-sw{position:relative;width:32px;height:18px;flex:none;cursor:pointer;display:inline-block}
  .rl-me-sw input{opacity:0;width:0;height:0;position:absolute}
  .rl-me-sw .tk{position:absolute;inset:0;background:var(--border,#e6eaf0);border-radius:999px;transition:.15s}
  .rl-me-sw .tk::before{content:'';position:absolute;width:14px;height:14px;border-radius:99px;background:#fff;top:2px;left:2px;transition:.15s;box-shadow:0 1px 2px rgba(0,0,0,.22)}
  .rl-me-sw input:checked + .tk{background:var(--brand,#2563eb)}
  .rl-me-sw input:checked + .tk::before{left:16px}
  .viewmode .rl-me-sw{pointer-events:none;opacity:.75}
  .rl-me-det{border:1px solid var(--border,#e6eaf0);border-radius:13px;background:var(--card,#fff);padding:16px 18px;position:sticky;top:12px}
  .rl-me-emp{color:var(--muted,#64748b);text-align:center;padding:60px 16px;font-size:13px}
  .rl-me-dh{display:flex;align-items:center;gap:11px;flex-wrap:wrap}
  .rl-me-dh h3{margin:0;font-size:15.5px}
  .rl-me-dh .mecode{font-size:11px;color:var(--faint,#94a3b8);font-family:ui-monospace,Menlo,monospace}
  .rl-me-vis{margin-left:auto;display:flex;align-items:center;gap:8px;background:var(--border-soft,#f1f4f8);border-radius:10px;padding:7px 11px;font-size:12px;font-weight:600;color:var(--ink-soft,#475569)}
  .rl-me-arow{display:flex;align-items:center;gap:11px;padding:9px 11px;border:1px solid var(--border,#e6eaf0);border-radius:10px;margin-top:7px}
  .rl-me-arow.off{opacity:.55}
  .rl-me-arow .an{font-size:12.5px;font-weight:600}
  .rl-me-arow .ad{font-size:11px;color:var(--muted,#64748b)}
  .rl-me-arow .ag{flex:1;min-width:0}
  .rl-me-arow .ac{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--faint,#94a3b8)}
  .rl-me-warn{margin-top:10px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:12px;border-radius:9px;padding:8px 11px}
  `;
  document.head.appendChild(st);
}

/* ===================== ESTADO ===================== */
let ST = null;   // { user, roles, permissions, grants, cur, editing, work:Set, q }

/* ===================== ENTRADA ===================== */
export async function renderRoles(user) {
  ensureStyles();
  ST = { user, roles: [], permissions: [], grants: {}, cur: null, editing: false, work: new Set(), q: '' };
  $('#pnlMain').innerHTML = '<div class="pnl-loading">Cargando roles…</div>';
  const d = await api({ action: 'matrix', user: userPayload(user) });
  if (!d.ok) {
    $('#pnlMain').innerHTML = `<div class="card"><p class="muted" style="margin:0">No se pudo cargar: ${esc(d.error || 'error')}</p></div>`;
    return;
  }
  ST.roles = d.roles || [];
  ST.permissions = d.permissions || [];
  ST.grants = d.grants || {};
  paintList();
}

async function reload() {
  dropRolesCache();   // v5.06: el catalogo cambio -> Equipo debe releerlo
  const d = await api({ action: 'matrix', user: userPayload(ST.user) });
  if (d.ok) { ST.roles = d.roles || []; ST.permissions = d.permissions || []; ST.grants = d.grants || {}; }
}

/* ===================== PANTALLA 1: GRILLA ===================== */
/* v5.25/v5.27: la columna Tipo dice DOS cosas distintas que antes se pisaban:
     - la PILDORA: si el rol es de sistema (no se edita ni se desactiva) o
       estandar (se edita libremente).
     - la NOTA de abajo: su particularidad real, la que hay que saber.
   Antes la pildora decia "ve todo" para el Auditor, lo cual era falso (tiene
   24 de 110 permisos) y ademas ocultaba que ese rol SI era editable. */
function rolePill(r) {
  if (!r.is_active) return '<span class="rl-pill rl-pill-off">inactivo</span>';
  if (r.is_system) return '<span class="rl-pill rl-pill-sys">sistema</span>';
  if (r.readonly_scope) return '<span class="rl-pill rl-pill-ro">todas las empresas</span>';
  return '<span class="rl-pill rl-pill-gray">estandar</span>';
}

/* Nota bajo la pildora: que tiene de particular ESTE rol. Vacia = nada que
   aclarar (un rol estandar normal no necesita explicacion). */
function roleNote(r) {
  if (!r.is_active) return 'Nadie puede tenerlo mientras este inactivo.';
  if (r.code === 'superadmin') return 'Tiene todos los permisos por diseño. No se edita.';
  if (r.code === 'tienda') return 'Es el acceso de cada tienda. No se edita ni se borra.';
  if (r.is_system) return 'El portal lo necesita para funcionar. No se edita.';
  if (r.readonly_scope) return 'Su alcance no se puede acotar: siempre ve todas las empresas.';
  return '';
}
// v4.61: tipo de acceso osTicket del rol (que se crea para sus usuarios).
function okindPill(r) {
  const k = r.osticket_kind || 'none';
  if (k === 'agent') return '<span class="rl-pill" style="background:#eff4ff;color:#1e40af" title="Sus usuarios se crean como AGENTES del panel osTicket">Agente</span>';
  if (k === 'client') return '<span class="rl-pill" style="background:#f0fdf4;color:#15803d" title="Sus usuarios se crean como USUARIOS del portal osTicket">Usuario</span>';
  return '<span class="rl-pill rl-pill-gray" title="Sus usuarios no tienen acceso a osTicket">—</span>';
}
function paintList() {
  const rows = ST.roles.map(r => {
    /* v5.25: la columna de acciones se reformula.
       Antes: [Editar] [Desactivar] [>]  -> Desactivar quedaba PEGADO al chevron
       que abre el detalle. Un clic corto y caias en un modal destructivo.
       Ahora: [Editar] [...] | [>]       -> lo destructivo vive dentro del menu
       "...", con una franja muerta antes de la flecha. Editar queda a mano
       porque es inocuo; Desactivar exige dos gestos. */
    const acts = r.is_system
      ? ''
      : `<button class="btn btn-sm" data-ren="${esc(r.code)}">Editar</button>
         <span class="rl-kebab">
           <button class="rl-kbtn" data-kb="${esc(r.code)}" title="Más acciones" aria-label="Más acciones">
             <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>
           </button>
           <div class="rl-kmenu" data-kmenu="${esc(r.code)}">
             <button class="rl-kitem" data-open2="${esc(r.code)}">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
               Ver permisos
             </button>
             <div class="rl-ksep"></div>
             ${r.is_active
               ? `<button class="rl-kitem danger" data-tog="${esc(r.code)}" data-to="off">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>
                    Desactivar rol
                  </button>`
               : `<button class="rl-kitem" data-tog="${esc(r.code)}" data-to="on">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                    Activar rol
                  </button>`}
           </div>
         </span>`;
    const note = roleNote(r);
    /* v5.27: se saca el chevron ">" del final. Era redundante: la fila entera
       ya abre el detalle, hay [Editar], y el menu "..." tiene "Ver permisos".
       Tres caminos a lo mismo + una flecha decorativa era ruido. */
    return `<tr data-open="${esc(r.code)}">
      <td><div class="rl-rname">${esc(r.label || r.code)}</div><div class="rl-rdesc">${esc(r.code)}</div></td>
      <td>${rolePill(r)}${note ? `<div class="rl-note">${esc(note)}</div>` : ''}</td>
      <td>${okindPill(r)}</td>
      <td class="rl-num">${r.perm_count == null ? 'todos' : r.perm_count}</td>
      <td class="rl-num">${r.user_count
        ? `<button class="rl-ucnt" data-users="${esc(r.code)}" title="Ver quiénes tienen este rol">${r.user_count}</button>`
        : '<span class="rl-ucnt zero">0</span>'}</td>
      <td><div class="rl-rowacts">${acts}</div></td>
    </tr>`;
  }).join('');

  $('#pnlMain').innerHTML = `
    <div class="pnl-head">
      <div><h1>Roles</h1><p>Toca un rol para ver o editar sus permisos. El alcance por empresa (qué tiendas ve cada usuario) se configura aparte, en <b>Permisos</b>.</p></div>
      <div class="head-actions">
        <button class="btn" id="rlShadow">Registro shadow</button>
        <button class="btn btn-primary" id="rlNew"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg> Nuevo rol</button>
      </div>
    </div>
    <div class="rl-tablebox">
      <table>
        <thead><tr><th>Rol</th><th>Tipo</th><th>osTicket</th><th class="rl-num">Permisos</th><th class="rl-num">Usuarios</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div id="rlModalHost"></div>`;

  document.querySelectorAll('#pnlMain tr[data-open]').forEach(tr =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      // v5.25: un clic dentro del menu "..." no debe abrir el detalle.
      if (e.target.closest('.rl-kebab')) return;
      openDetail(String(tr.dataset.open));
    }));
  document.querySelectorAll('#pnlMain [data-ren]').forEach(b =>
    b.addEventListener('click', (e) => { e.stopPropagation(); openRenameModal(String(b.dataset.ren)); }));
  // v5.27: el numero de Usuarios abre la lista de quienes tienen el rol.
  document.querySelectorAll('#pnlMain [data-users]').forEach(b =>
    b.addEventListener('click', (e) => { e.stopPropagation(); openRoleUsersModal(String(b.dataset.users)); }));

  /* v5.25: menu "..." por fila. Un solo menu abierto a la vez; cierra al
     tocar fuera o con Escape. */
  const closeKebabs = () => {
    document.querySelectorAll('#pnlMain .rl-kmenu.open').forEach(m => m.classList.remove('open'));
    document.querySelectorAll('#pnlMain .rl-kbtn.open').forEach(b => b.classList.remove('open'));
  };
  document.querySelectorAll('#pnlMain [data-kb]').forEach(b =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = document.querySelector(`#pnlMain [data-kmenu="${CSS.escape(b.dataset.kb)}"]`);
      const wasOpen = menu && menu.classList.contains('open');
      closeKebabs();
      if (menu && !wasOpen) { menu.classList.add('open'); b.classList.add('open'); }
    }));
  // "Ver permisos" del menu: lo mismo que tocar la fila.
  document.querySelectorAll('#pnlMain [data-open2]').forEach(b =>
    b.addEventListener('click', (e) => {
      e.stopPropagation(); closeKebabs(); openDetail(String(b.dataset.open2));
    }));
  document.querySelectorAll('#pnlMain [data-tog]').forEach(b =>
    b.addEventListener('click', (e) => {
      e.stopPropagation(); closeKebabs();
      openToggleModal(String(b.dataset.tog), b.dataset.to === 'on');
    }));
  // Clic fuera / Escape cierran el menu. El listener se re-crea en cada
  // paintList(); como el DOM se reemplaza entero, no se acumulan.
  document.addEventListener('click', closeKebabs);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeKebabs(); });

  const nw = $('#rlNew');
  if (nw) nw.addEventListener('click', openNewRoleModal);
  const sh = $('#rlShadow');
  if (sh) sh.addEventListener('click', openShadowLogModal);
}

/* ===================== PANTALLA 2: DETALLE ===================== */
function roleByCode(code) { return ST.roles.find(r => r.code === code) || null; }

/* Estructura de grupos: Vistas primero (con subgrupos), luego los dominios
   de acciones en el orden de sort_order del catalogo. */
function buildGroups() {
  const perms = ST.permissions;
  const byDomain = new Map();
  perms.forEach(p => {
    if (!byDomain.has(p.domain)) byDomain.set(p.domain, []);
    byDomain.get(p.domain).push(p);
  });
  const groups = [];
  // 1) Vistas con subgrupos.
  const vistas = byDomain.get('Vistas') || [];
  if (vistas.length) {
    const used = new Set();
    const subs = [];
    VIEW_SUBGROUPS.forEach(([title, codes]) => {
      const items = codes.map(c => vistas.find(p => p.code === c)).filter(Boolean);
      items.forEach(p => used.add(p.code));
      if (items.length) subs.push({ title, items });
    });
    const rest = vistas.filter(p => !used.has(p.code));
    if (rest.length) subs.push({ title: 'Otras vistas', items: rest });
    groups.push({ key: 'Vistas', title: 'Vistas · acceso a pantallas', subs, note: `Los "Ver · ..." de Configuracion se encienden solos si activas el "usar" correspondiente (regla: usar implica ver).` });
    byDomain.delete('Vistas');
  }
  // 2) El resto por dominio, en orden de aparicion (sort_order asc del select).
  for (const [domain, items] of byDomain) {
    let note = '';
    if (domain === 'Configuracion') note = 'Al encender un permiso de aqui, su "Ver" en el grupo Vistas se activa automaticamente y queda fijo mientras el "usar" siga encendido.';
    groups.push({ key: domain, title: domain, subs: [{ title: null, items }], note });
  }
  return groups;
}

function permRowHtml(p, checked) {
  const isImpliedView = !!IMPLIED_BY[p.code];
  const lockNow = isImpliedView && ST.work.has(IMPLIED_BY[p.code]);
  const help = p.help ? `<span class="rl-qh" data-qh>?<span class="tip">${esc(p.help)}</span></span>` : '';
  return `<div class="rl-perm${lockNow ? ' implied' : ''}" data-code="${esc(p.code)}">
    <label class="rl-sw${lockNow ? ' impliedlock' : ''}"><input type="checkbox" data-perm="${esc(p.code)}"${checked ? ' checked' : ''}${lockNow ? ' disabled' : ''}><span class="track"></span><span class="knob"></span></label>
    <span class="txt" data-txt><span class="plabel">${esc(p.label || p.code)}</span>${p.enforced
      ? `<span title="Este permiso YA SE APLICA: el servidor lo exige de verdad." style="display:inline-block;margin-left:6px;font-size:9.5px;font-weight:800;letter-spacing:.05em;padding:1px 7px;border-radius:999px;background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d;vertical-align:middle">APLICADO</span>`
      : ''}${help}<div class="pcode">${esc(p.code)}</div></span>
  </div>`;
}

function openDetail(code) {
  const r = roleByCode(code);
  if (!r) return;
  ST.cur = code;
  ST.editing = false;
  ST.q = '';
  const isSuperRole = code === 'superadmin';
  ST.work = isSuperRole
    ? new Set(ST.permissions.map(p => p.code))          // superadmin: todo, solo lectura
    : new Set((ST.grants[code] || []).filter(c => ST.permissions.some(p => p.code === c)));

  const groups = buildGroups();
  const groupHtml = groups.map((g, gi) => {
    const total = g.subs.reduce((a, s) => a + s.items.length, 0);
    const on = g.subs.reduce((a, s) => a + s.items.filter(p => ST.work.has(p.code)).length, 0);
    const body = g.subs.map(s =>
      (s.title ? `<div class="rl-dom-sub">${esc(s.title)}</div>` : '')
      + s.items.map(p => permRowHtml(p, ST.work.has(p.code))).join('')
    ).join('');
    const collapsed = gi > 1 ? ' collapsed' : '';
    return `<div class="rl-dom${collapsed}" data-dom="${gi}">
      <div class="rl-dom-h" data-domtoggle="${gi}">
        <span class="rl-dom-title">${esc(g.title)}</span><span class="rl-dom-count" data-domcount="${gi}">${on}/${total}</span>
        <span class="sp"></span>
        <label class="rl-dom-selall"><input type="checkbox" data-domall="${gi}"> Todo el grupo</label>
        <svg class="rl-dchev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
      </div>
      <div class="rl-dom-body">${body}</div>
      ${g.note ? `<div class="rl-dom-note">${esc(g.note)}</div>` : ''}
    </div>`;
  }).join('');

  const otherRoles = ST.roles.filter(x => x.code !== code && x.code !== 'superadmin' && x.is_active);
  const copyOpts = otherRoles.map(x => `<option value="${esc(x.code)}">${esc(x.label || x.code)}</option>`).join('');

  $('#pnlMain').innerHTML = `
    <div id="rlDetail" class="viewmode">
      <button class="rl-back" id="rlBack"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg> Volver a roles</button>
      <div class="pnl-head">
        <div><h1>${esc(r.label || r.code)} ${rolePill(r)} <span class="rl-viewbadge" id="rlMode">solo lectura</span></h1>
          <p id="rlSub"><b id="rlOnCount">${isSuperRole ? 'Todos los' : ST.work.size}</b> permisos activos · ${r.user_count} usuario${r.user_count === 1 ? '' : 's'} lo tiene${r.user_count === 1 ? '' : 'n'} asignado.</p></div>
        <div class="head-actions" id="rlViewActs">${isSuperRole ? '' : `<button class="btn btn-primary" id="rlEdit"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg> Editar</button>`}</div>
        <div class="head-actions" id="rlEditActs" style="display:none">
          <button class="btn" id="rlReset" title="Vuelve a los permisos estándar de este rol">Restablecer</button>
          <button class="btn" id="rlCancel">Cancelar</button>
          <button class="btn btn-primary" id="rlSave">Guardar cambios</button>
        </div>
      </div>
      ${isSuperRole ? '<div class="rl-supernote">El superadministrador tiene <b>todos los permisos por diseño</b> (no depende de la matriz). Esta vista es solo informativa.</div>' : ''}
      <div class="rl-copybar locked" id="rlCopybar">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copiar permisos desde otro rol:
        <select id="rlCopySel"><option value="">— elegir rol —</option>${copyOpts}</select>
        <button class="btn btn-sm" id="rlCopyGo">Aplicar</button>
        <span class="sp"></span><span class="rl-mini-note">Disponible en modo edicion.</span>
      </div>
      <div class="rl-toolbar">
        <div class="rl-mode"><button id="rlModeMenu" class="on" type="button">Menú</button><button id="rlModeAdv" type="button">Avanzada</button></div>
        <div class="search"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><input id="rlSearch" placeholder="Buscar permiso (documento, roster, cargo…)"></div>
        <span style="font-size:12.5px;color:var(--muted,#64748b)"><b id="rlOnCount2">${isSuperRole ? ST.permissions.length : ST.work.size}</b> de ${ST.permissions.length} permisos activos</span>
      </div>
      <div id="rlMenuEd"></div>
      <div id="rlGroups">${groupHtml}</div>
      <div id="rlModalHost"></div>
    </div>`;

  wireDetail(r, isSuperRole);
  window.scrollTo(0, 0);
}

function wireDetail(r, isSuperRole) {
  const root = $('#rlDetail');
  const q = s => root.querySelector(s);

  q('#rlBack').addEventListener('click', () => { paintList(); window.scrollTo(0, 0); });

  // Plegar/desplegar grupos (no dispara sobre el "Todo el grupo").
  root.querySelectorAll('[data-domtoggle]').forEach(h =>
    h.addEventListener('click', (e) => {
      if (e.target.closest('.rl-dom-selall')) return;
      h.closest('.rl-dom').classList.toggle('collapsed');
    }));

  // Buscador: filtra filas por etiqueta/code; con texto, expande y oculta
  // grupos sin coincidencias; vacio, restaura.
  const searchEl = q('#rlSearch');
  if (searchEl) searchEl.addEventListener('input', () => {
    const needle = searchEl.value.trim().toLowerCase();
    root.querySelectorAll('.rl-dom').forEach(dom => {
      let visible = 0;
      dom.querySelectorAll('.rl-perm').forEach(row => {
        const hit = !needle || row.textContent.toLowerCase().includes(needle);
        row.style.display = hit ? '' : 'none';
        if (hit) visible++;
      });
      // Subtitulos: ocultarlos si su bloque quedo vacio es complejo; con
      // busqueda activa simplemente se dejan (son livianos).
      dom.style.display = visible ? '' : 'none';
      if (needle) dom.classList.remove('collapsed');
    });
    if (!needle) {
      root.querySelectorAll('.rl-dom').forEach((dom, i) => { dom.style.display = ''; if (i > 1) dom.classList.add('collapsed'); else dom.classList.remove('collapsed'); });
    }
  });

  // Ayuda "?": hover en escritorio (CSS); en tactil se abre/cierra tocando.
  root.querySelectorAll('[data-qh]').forEach(qh =>
    qh.addEventListener('click', (e) => {
      e.stopPropagation();
      root.querySelectorAll('[data-qh].open').forEach(o => { if (o !== qh) o.classList.remove('open'); });
      qh.classList.toggle('open');
    }));
  root.addEventListener('click', () => root.querySelectorAll('[data-qh].open').forEach(o => o.classList.remove('open')));

  // v4.70: editor visual (modo Menu). Se monta ANTES del corte de superadmin
  // para que el super tambien lo vea (en solo lectura, switches bloqueados
  // por CSS .viewmode).
  initMenuEditor(root);

  // El texto de la fila togglea su switch (solo en modo edicion).
  root.querySelectorAll('[data-txt]').forEach(t =>
    t.addEventListener('click', (e) => {
      if (e.target.closest('[data-qh]')) return;
      if (root.classList.contains('viewmode')) return;
      const inp = t.parentElement.querySelector('input[data-perm]');
      if (inp && !inp.disabled) { inp.checked = !inp.checked; inp.dispatchEvent(new Event('change')); }
    }));

  if (isSuperRole) return;   // solo lectura total

  const modeBadge = q('#rlMode');
  const toView = () => {
    root.classList.add('viewmode');
    q('#rlViewActs').style.display = '';
    q('#rlEditActs').style.display = 'none';
    q('#rlCopybar').classList.add('locked');
    modeBadge.textContent = 'solo lectura';
    modeBadge.classList.remove('editing');
    ST.editing = false;
  };
  const toEdit = () => {
    root.classList.remove('viewmode');
    q('#rlViewActs').style.display = 'none';
    q('#rlEditActs').style.display = '';
    q('#rlCopybar').classList.remove('locked');
    modeBadge.textContent = 'editando';
    modeBadge.classList.add('editing');
    ST.editing = true;
  };

  q('#rlEdit').addEventListener('click', toEdit);
  q('#rlCancel').addEventListener('click', () => openDetail(r.code));   // descarta cambios
  q('#rlReset').addEventListener('click', () => openResetModal(r));

  // --- contadores ---
  const refreshCounts = () => {
    const onTotal = ST.work.size;
    const c1 = q('#rlOnCount'); if (c1) c1.textContent = onTotal;
    const c2 = q('#rlOnCount2'); if (c2) c2.textContent = onTotal;
    root.querySelectorAll('.rl-dom').forEach(dom => {
      const gi = dom.dataset.dom;
      const inputs = dom.querySelectorAll('input[data-perm]');
      let on = 0;
      inputs.forEach(i => { if (ST.work.has(i.dataset.perm)) on++; });
      const cnt = dom.querySelector(`[data-domcount="${gi}"]`);
      if (cnt) cnt.textContent = `${on}/${inputs.length}`;
    });
  };

  // --- regla usar implica ver ---
  const applyImply = (useCode, on) => {
    const viewCode = IMPLIES[useCode];
    if (!viewCode) return;
    const vInp = root.querySelector(`input[data-perm="${viewCode}"]`);
    if (!vInp) return;
    const row = vInp.closest('.rl-perm');
    const sw = vInp.closest('.rl-sw');
    if (on) {
      ST.work.add(viewCode);
      vInp.checked = true;
      vInp.disabled = true;
      if (sw) sw.classList.add('impliedlock');
      if (row) row.classList.add('implied');
    } else {
      vInp.disabled = false;
      if (sw) sw.classList.remove('impliedlock');
      if (row) row.classList.remove('implied');
      // el "ver" queda como estaba (encendido); el usuario decide apagarlo.
    }
  };

  // --- switches ---
  root.querySelectorAll('input[data-perm]').forEach(inp => {
    inp.addEventListener('change', () => {
      const code = inp.dataset.perm;
      if (inp.checked) ST.work.add(code); else ST.work.delete(code);
      if (IMPLIES[code]) applyImply(code, inp.checked);
      refreshCounts();
    });
  });
  // Estado inicial de los locks (por si el rol ya trae config.* encendidos).
  Object.keys(IMPLIES).forEach(useCode => { if (ST.work.has(useCode)) applyImply(useCode, true); });
  refreshCounts();

  // --- "Todo el grupo" ---
  root.querySelectorAll('input[data-domall]').forEach(master => {
    master.addEventListener('change', () => {
      const dom = master.closest('.rl-dom');
      dom.querySelectorAll('input[data-perm]').forEach(inp => {
        if (inp.disabled && !master.checked) return;   // los implied no se apagan en bloque
        if (inp.checked !== master.checked) {
          inp.checked = master.checked;
          inp.dispatchEvent(new Event('change'));
        }
      });
    });
  });

  // --- copiar desde otro rol ---
  q('#rlCopyGo').addEventListener('click', () => {
    if (!ST.editing) return;
    const src = q('#rlCopySel').value;
    if (!src) return;
    const srcGrants = new Set((ST.grants[src] || []).filter(c => ST.permissions.some(p => p.code === c)));
    ST.work = srcGrants;
    root.querySelectorAll('input[data-perm]').forEach(inp => {
      inp.disabled = false;
      const sw = inp.closest('.rl-sw'); if (sw) sw.classList.remove('impliedlock');
      const row = inp.closest('.rl-perm'); if (row) row.classList.remove('implied');
      inp.checked = ST.work.has(inp.dataset.perm);
    });
    Object.keys(IMPLIES).forEach(useCode => { if (ST.work.has(useCode)) applyImply(useCode, true); });
    refreshCounts();
  });

  // --- guardar ---
  q('#rlSave').addEventListener('click', async () => {
    const saveB = q('#rlSave');
    saveB.disabled = true; saveB.textContent = 'Guardando…';
    const d = await api({ action: 'save', user: userPayload(ST.user), role_code: r.code, grants: [...ST.work] });
    saveB.disabled = false; saveB.textContent = 'Guardar cambios';
    if (!d.ok) { openMsgModal('No se pudo guardar', d.error || 'Error al guardar la matriz.'); return; }
    await reload();
    openDetail(r.code);   // reabre en modo lectura con datos frescos
  });

  toView();
}

/* ===================== v4.70 EDITOR VISUAL (modo Menu) =====================
   Piel master-detail sobre la MISMA matriz: cada switch del editor visual
   opera el checkbox correspondiente de la matriz avanzada (#rlGroups,
   oculta en este modo) y le dispara 'change', de modo que TODA la logica
   existente (ST.work, usar-implica-ver, contadores, guardar, copiar,
   restablecer) funciona sin duplicarse. La piel se repinta tras cada
   cambio leyendo ST.work. */
let ME_SEL = null;      // id del menu seleccionado en el master-detail
let ME_MODE = 'menu';   // 'menu' | 'adv'

function permMeta(code) { return ST.permissions.find(p => p.code === code) || null; }
function meItems() { return MENU_CATALOG.flatMap(g => g.items); }

function paintMenuEditor(root) {
  const host = root.querySelector('#rlMenuEd');
  if (!host) return;
  const exists = c => !!permMeta(c);
  const onSet = c => ST.work.has(c);

  // --- columna izquierda: el menu clonado ---
  const menuHtml = MENU_CATALOG.map(g => {
    const items = g.items.filter(it => exists(it.view));
    if (!items.length) return '';
    return `<div class="rl-me-g">
      ${g.g ? `<div class="rl-me-gl">${esc(g.g)}</div>` : ''}
      ${items.map(it => {
        const on = onSet(it.view);
        const acts = it.acts.filter(exists);
        const nOn = acts.filter(onSet).length;
        const orphan = !on && nOn > 0;
        /* v5.55: el subtitulo va ANTES de su item (asi lo dibuja el menu real).
           `child` sangra la linea: Diferencias cuelga de Ultima corrida. */
        const sub = it.sub ? `<div class="rl-me-sub">${esc(it.sub)}</div>` : '';
        return sub + `<div class="rl-me-it ${ME_SEL === it.id ? 'sel' : ''} ${on ? '' : 'off'} ${it.child ? 'child' : ''}" data-meit="${esc(it.id)}">
          <span class="melbl">${esc(it.lbl)}</span>
          ${orphan ? '<span title="Acciones activas en un menu apagado" style="width:7px;height:7px;border-radius:99px;background:#c2410c;flex:none"></span>' : ''}
          ${acts.length ? `<span class="mecnt">${nOn}/${acts.length}</span>` : ''}
          <label class="rl-me-sw"><input type="checkbox" data-mev="${esc(it.view)}"${on ? ' checked' : ''}><span class="tk"></span></label>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');

  // --- panel derecho: detalle del menu seleccionado ---
  const it = meItems().find(x => x.id === ME_SEL) || null;
  let detHtml = '<div class="rl-me-emp">👈 Toca un menú para ver y editar sus acciones.</div>';
  if (it && exists(it.view)) {
    const on = onSet(it.view);
    const acts = it.acts.filter(exists);
    const rows = acts.map(c => {
      const p = permMeta(c);
      const aon = onSet(c);
      return `<div class="rl-me-arow ${aon ? '' : 'off'}">
        <div class="ag"><div class="an">${esc(p.label || c)}</div>${p.help ? `<div class="ad">${esc(p.help)}</div>` : ''}</div>
        <span class="ac">${esc(c)}</span>
        <label class="rl-me-sw"><input type="checkbox" data-mea="${esc(c)}"${aon ? ' checked' : ''}><span class="tk"></span></label>
      </div>`;
    }).join('');
    const orphan = !on && acts.some(onSet);
    detHtml = `
      <div class="rl-me-dh">
        <div><h3>${esc(it.lbl)}</h3><div class="mecode">${esc(it.view)}</div></div>
        <div class="rl-me-vis">Este rol ${on ? 'VE' : 'NO ve'} este menú
          <label class="rl-me-sw"><input type="checkbox" data-mev="${esc(it.view)}"${on ? ' checked' : ''}><span class="tk"></span></label></div>
      </div>
      ${orphan ? '<div class="rl-me-warn">⚠ Hay acciones activas en un menú que este rol no ve. No es un error (el servidor protege igual), pero conviene revisarlo.</div>' : ''}
      ${acts.length
        ? rows
        : '<div class="rl-me-arow off"><div class="ag"><div class="an">Sin acciones adicionales</div><div class="ad">Con ver el menú alcanza.</div></div></div>'}`;
  }

  host.innerHTML = `<div class="rl-me"><div class="rl-me-menu">${menuHtml}</div><div class="rl-me-det">${detHtml}</div></div>`;

  // Seleccion de item (clic en la fila, no en el switch).
  host.querySelectorAll('[data-meit]').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('.rl-me-sw')) return;
    ME_SEL = el.dataset.meit;
    paintMenuEditor(root);
  }));

  // Switches (vista y acciones): operan el checkbox REAL de la matriz
  // avanzada y le disparan change, reusando toda su logica. v5.03: el relay
  // ASIGNA el valor pedido (no invierte a ciegas): con un mismo code en varios
  // items del menu (report.* en Empresas / Mi empresa / Personal) los switches
  // duplicados quedan sincronizados por construccion — el repintado final los
  // repinta a todos desde ST.work, que es el unico estado que viaja a BD.
  const relay = (code, want) => {
    const target = root.querySelector(`#rlGroups input[data-perm="${code}"]`);
    if (target && !target.disabled && target.checked !== want) {
      target.checked = want;
      target.dispatchEvent(new Event('change'));
    }
    paintMenuEditor(root);
  };
  host.querySelectorAll('input[data-mev]').forEach(inp =>
    inp.addEventListener('change', () => relay(inp.dataset.mev, inp.checked)));
  host.querySelectorAll('input[data-mea]').forEach(inp =>
    inp.addEventListener('change', () => relay(inp.dataset.mea, inp.checked)));
}

function initMenuEditor(root) {
  ME_SEL = null;
  ME_MODE = 'menu';
  const groupsEl = root.querySelector('#rlGroups');
  const meEl = root.querySelector('#rlMenuEd');
  const searchInp = root.querySelector('#rlSearch');
  const searchWrap = searchInp ? searchInp.closest('.search') : null;
  const bMenu = root.querySelector('#rlModeMenu');
  const bAdv = root.querySelector('#rlModeAdv');
  const apply = () => {
    const menu = ME_MODE === 'menu';
    if (meEl) meEl.style.display = menu ? '' : 'none';
    if (groupsEl) groupsEl.style.display = menu ? 'none' : '';
    if (searchWrap) searchWrap.style.display = menu ? 'none' : '';
    if (bMenu) bMenu.classList.toggle('on', menu);
    if (bAdv) bAdv.classList.toggle('on', !menu);
    if (menu) paintMenuEditor(root);   // repinta desde ST.work al entrar
  };
  if (bMenu) bMenu.addEventListener('click', () => { ME_MODE = 'menu'; apply(); });
  if (bAdv) bAdv.addEventListener('click', () => { ME_MODE = 'adv'; apply(); });
  apply();
}

/* ===================== MODALES (propios; cierran solo con botones) ===================== */
function modalHost() { return document.getElementById('rlModalHost'); }
function baseModal(inner) {
  const host = modalHost();
  host.innerHTML = `<div class="wp-modal-vp"><div class="wp-modal">${inner}</div></div>`;
  return host;
}
function closeModal(host, onKey) {
  if (onKey) document.removeEventListener('keydown', onKey);
  host.innerHTML = '';
}

function openMsgModal(title, msg) {
  const host = baseModal(`
    <h3>${esc(title)}</h3>
    <div class="wp-prev warn" style="display:block">${esc(msg)}</div>
    <div class="wp-foot"><span style="flex:1"></span><button class="btn btn-primary" id="rmOk">Entendido</button></div>`);
  const onKey = ev => { if (ev.key === 'Escape') closeModal(host, onKey); };
  document.addEventListener('keydown', onKey);
  host.querySelector('#rmOk').addEventListener('click', () => closeModal(host, onKey));
}

/* Registro del shadow: discrepancias gate-legacy vs matriz, persistidas por
   shadowCan en nomina_v2.perm_shadow_log (v4.30). Solo lectura. */
async function openShadowLogModal() {
  const host = baseModal(`
    <button class="wp-x" id="slX" title="Cerrar">✕</button>
    <h3>Registro del shadow</h3>
    <p class="wp-help" style="margin-top:2px">Cada fila es una llamada real donde el gate vigente y la matriz <b>no coincidieron</b> (se respetó el gate vigente). Vacío = matriz alineada con la realidad. Últimas 200.</p>
    <div id="slBody" style="max-height:52vh;overflow:auto;border:1px solid var(--border,#e6eaf0);border-radius:10px">
      <div class="pnl-loading" style="padding:26px">Cargando…</div>
    </div>
    <div class="wp-foot"><span style="flex:1"></span>
      <button class="btn" id="slRefresh">Actualizar</button>
      <button class="btn btn-primary" id="slOk">Cerrar</button>
    </div>`);
  const mod = host.querySelector('.wp-modal');
  if (mod) { mod.style.maxWidth = '860px'; mod.style.width = 'calc(100vw - 40px)'; }
  const q = s => host.querySelector(s);
  const onKey = ev => { if (ev.key === 'Escape') closeModal(host, onKey); };
  document.addEventListener('keydown', onKey);
  q('#slX').addEventListener('click', () => closeModal(host, onKey));
  q('#slOk').addEventListener('click', () => closeModal(host, onKey));

  const fmtAt = iso => {
    try {
      return new Date(iso).toLocaleString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return String(iso || '').slice(0, 16); }
  };
  const load = async () => {
    const body = q('#slBody');
    body.innerHTML = '<div class="pnl-loading" style="padding:26px">Cargando…</div>';
    const d = await api({ action: 'shadow_log', user: userPayload(ST.user) });
    if (!d.ok) { body.innerHTML = `<div style="padding:18px;color:var(--danger,#dc2626);font-size:13px">${esc(d.error || 'No se pudo cargar.')}</div>`; return; }
    const rows = d.rows || [];
    if (!rows.length) {
      body.innerHTML = '<div style="padding:26px;text-align:center;color:var(--muted,#64748b);font-size:13px">Sin discrepancias registradas ✔<br><span style="font-size:11.5px">La matriz coincide con lo que los gates vigentes están decidiendo.</span></div>';
      return;
    }
    body.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr>
        <th style="text-align:left;padding:8px 10px;background:#fbfcfe;border-bottom:1px solid var(--border,#e6eaf0);white-space:nowrap">Cuándo</th>
        <th style="text-align:left;padding:8px 10px;background:#fbfcfe;border-bottom:1px solid var(--border,#e6eaf0)">Endpoint · acción</th>
        <th style="text-align:left;padding:8px 10px;background:#fbfcfe;border-bottom:1px solid var(--border,#e6eaf0)">Permiso</th>
        <th style="text-align:left;padding:8px 10px;background:#fbfcfe;border-bottom:1px solid var(--border,#e6eaf0)">Quién</th>
        <th style="text-align:left;padding:8px 10px;background:#fbfcfe;border-bottom:1px solid var(--border,#e6eaf0);white-space:nowrap">Gate → Matriz</th>
      </tr></thead>
      <tbody>${rows.map(r => `
        <tr>
          <td style="padding:7px 10px;border-bottom:1px solid var(--border-soft,#f1f4f8);white-space:nowrap;font-variant-numeric:tabular-nums">${esc(fmtAt(r.at))}</td>
          <td style="padding:7px 10px;border-bottom:1px solid var(--border-soft,#f1f4f8)">${esc(r.endpoint || '')}<span style="color:var(--muted,#64748b)"> · ${esc(r.action || '')}</span></td>
          <td style="padding:7px 10px;border-bottom:1px solid var(--border-soft,#f1f4f8);font-family:ui-monospace,Menlo,monospace;font-size:11px">${esc(r.code || '')}</td>
          <td style="padding:7px 10px;border-bottom:1px solid var(--border-soft,#f1f4f8)">${esc(r.actor || '—')}<span style="color:var(--muted,#64748b)"> (${esc(r.role_code || '?')})</span></td>
          <td style="padding:7px 10px;border-bottom:1px solid var(--border-soft,#f1f4f8);white-space:nowrap">${r.legacy ? 'permite' : 'niega'} → <b style="color:${r.nuevo ? 'var(--success,#16a34a)' : 'var(--danger,#dc2626)'}">${r.nuevo ? 'permitiría' : 'negaría'}</b></td>
        </tr>`).join('')}</tbody>
    </table>`;
  };
  q('#slRefresh').addEventListener('click', load);
  load();
}

/* v5.27: quienes tienen este rol. El conteo de la grilla mostraba "7" y ahi
   moria: para saber QUIENES eran habia que ir a Equipo y filtrar a ojo.
   Solo lectura: los cambios de rol se siguen haciendo en Equipo. */
async function openRoleUsersModal(code) {
  const r = roleByCode(code);
  if (!r) return;
  const host = baseModal(`
    <button class="wp-x" id="ruX" title="Cerrar">✕</button>
    <h3>Quién tiene este rol</h3>
    <p class="wp-who"><b>${esc(r.label || code)}</b> · <span class="wp-ced">${esc(code)}</span></p>
    <div id="ruBody"><div class="pnl-loading" style="padding:26px">Cargando…</div></div>
    <div class="wp-foot"><span style="flex:1"></span>
      <button class="btn btn-primary" id="ruOk">Cerrar</button>
    </div>`);
  const q = s => host.querySelector(s);
  const onKey = ev => { if (ev.key === 'Escape') closeModal(host, onKey); };
  document.addEventListener('keydown', onKey);
  q('#ruX').addEventListener('click', () => closeModal(host, onKey));
  q('#ruOk').addEventListener('click', () => closeModal(host, onKey));

  const ini = s => String(s || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';

  const d = await api({ action: 'role_users', user: userPayload(ST.user), role_code: code });
  const body = q('#ruBody');
  if (!body) return;   // el modal se cerro mientras cargaba
  if (!d.ok) {
    body.innerHTML = `<div class="wp-prev warn" style="display:block">${esc(d.error || 'No se pudo cargar la lista.')}</div>`;
    return;
  }
  const users = d.users || [];
  if (!users.length) {
    body.innerHTML = '<div style="padding:22px;text-align:center;color:var(--muted,#64748b);font-size:13px">Ningún usuario tiene este rol.</div>';
    return;
  }
  const isTienda = d.kind === 'company';
  body.innerHTML = `
    <p class="wp-help" style="margin:0 0 2px">${users.length} ${isTienda
      ? `tienda${users.length === 1 ? '' : 's'} con acceso. Se administran en <b>Usuarios</b>.`
      : `usuario${users.length === 1 ? '' : 's'}. El rol se cambia en <b>Equipo</b>.`}</p>
    <div class="rl-ul">${users.map(u => `
      <div class="rl-ur">
        <div class="rl-uav">${esc(ini(u.name))}</div>
        <div class="rl-ug">
          <div class="rl-un">${esc(u.name)}</div>
          <div class="rl-us">${esc(u.username || '')}${u.sub ? ` · ${esc(u.sub)}` : ''}</div>
        </div>
        ${u.is_active === false ? '<span class="rl-uoff">inactivo</span>' : ''}
      </div>`).join('')}</div>`;
}

function openNewRoleModal() {
  const host = baseModal(`
    <button class="wp-x" id="nrX" title="Cerrar">✕</button>
    <h3>Nuevo rol</h3>
    <label class="flabel">Nombre visible</label>
    <input id="nrLabel" type="text" maxlength="60" placeholder="ej. Auditor">
    <label class="flabel" style="margin-top:10px">Codigo interno <span class="opt">(minusculas, sin espacios)</span></label>
    <input id="nrCode" type="text" maxlength="31" placeholder="ej. auditor" style="font-family:ui-monospace,Menlo,monospace">
    <label class="flabel" style="margin-top:10px">Acceso a osTicket <span class="opt">(obligatorio)</span></label>
    <select id="nrOkind">
      <option value="">— Elegir —</option>
      <option value="agent">Agente (panel del staff)</option>
      <option value="client">Usuario (portal de tickets)</option>
      <option value="none">Ninguno (sin acceso a osTicket)</option>
    </select>
    <p class="wp-help" style="margin-top:6px">Define qué acceso de osTicket se crea para los usuarios de este rol. Hoy: tiendas y gestores son <b>Usuarios</b>; los administradores son <b>Agentes</b>.</p>
    <div id="nrMsg" class="wp-prev" style="display:none"></div>
    <p class="wp-help">El rol nace <b>sin permisos</b>: al crearlo, abrilo y asignale los que corresponda. El alcance de empresas se define aparte, en Permisos.</p>
    <div class="wp-foot"><span style="flex:1"></span>
      <button class="btn" id="nrCancel">Cancelar</button>
      <button class="btn btn-primary" id="nrSave" disabled>Crear rol</button>
    </div>`);
  const q = s => host.querySelector(s);
  const onKey = ev => { if (ev.key === 'Escape') closeModal(host, onKey); };
  document.addEventListener('keydown', onKey);
  q('#nrX').addEventListener('click', () => closeModal(host, onKey));
  q('#nrCancel').addEventListener('click', () => closeModal(host, onKey));

  const labelEl = q('#nrLabel'), codeEl = q('#nrCode'), saveB = q('#nrSave'), okindEl = q('#nrOkind');
  let codeTouched = false;
  const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 31);
  const refresh = () => {
    if (!codeTouched) codeEl.value = slug(labelEl.value);
    saveB.disabled = !(labelEl.value.trim().length >= 2 && /^[a-z][a-z0-9_]{2,30}$/.test(codeEl.value) && okindEl.value);
  };
  labelEl.addEventListener('input', refresh);
  codeEl.addEventListener('input', () => { codeTouched = true; refresh(); });
  okindEl.addEventListener('change', refresh);
  setTimeout(() => labelEl.focus(), 30);

  saveB.addEventListener('click', async () => {
    saveB.disabled = true; saveB.textContent = 'Creando…';
    const d = await api({ action: 'create', user: userPayload(ST.user), code: codeEl.value, label: labelEl.value.trim(), osticket_kind: okindEl.value });
    if (!d.ok) {
      saveB.disabled = false; saveB.textContent = 'Crear rol';
      const m = q('#nrMsg'); m.style.display = 'block'; m.className = 'wp-prev warn'; m.textContent = d.error || 'No se pudo crear.';
      return;
    }
    closeModal(host, onKey);
    await reload();
    paintList();
  });
}

function openRenameModal(code) {
  const r = roleByCode(code);
  if (!r) return;
  const host = baseModal(`
    <button class="wp-x" id="rnX" title="Cerrar">✕</button>
    <h3>Editar rol</h3>
    <p class="wp-who"><span class="wp-ced">${esc(code)}</span></p>
    <label class="flabel">Nombre visible</label>
    <input id="rnLabel" type="text" maxlength="60" value="${esc(r.label || '')}">
    <label class="flabel" style="margin-top:10px">Acceso a osTicket</label>
    <select id="rnOkind">
      <option value="agent"${(r.osticket_kind || 'none') === 'agent' ? ' selected' : ''}>Agente (panel del staff)</option>
      <option value="client"${(r.osticket_kind || 'none') === 'client' ? ' selected' : ''}>Usuario (portal de tickets)</option>
      <option value="none"${(r.osticket_kind || 'none') === 'none' ? ' selected' : ''}>Ninguno (sin acceso a osTicket)</option>
    </select>
    <p class="wp-help" style="margin-top:6px">Cambiarlo solo afecta a los accesos que se creen a partir de ahora; los existentes no se tocan.</p>
    <div id="rnMsg" class="wp-prev" style="display:none"></div>
    <div class="wp-foot"><span style="flex:1"></span>
      <button class="btn" id="rnCancel">Cancelar</button>
      <button class="btn btn-primary" id="rnSave">Guardar</button>
    </div>`);
  const q = s => host.querySelector(s);
  const onKey = ev => { if (ev.key === 'Escape') closeModal(host, onKey); };
  document.addEventListener('keydown', onKey);
  q('#rnX').addEventListener('click', () => closeModal(host, onKey));
  q('#rnCancel').addEventListener('click', () => closeModal(host, onKey));
  setTimeout(() => q('#rnLabel').focus(), 30);
  q('#rnSave').addEventListener('click', async () => {
    const saveB = q('#rnSave');
    saveB.disabled = true; saveB.textContent = 'Guardando…';
    const d = await api({ action: 'rename', user: userPayload(ST.user), role_code: code, label: q('#rnLabel').value.trim() });
    if (!d.ok) {
      saveB.disabled = false; saveB.textContent = 'Guardar';
      const m = q('#rnMsg'); m.style.display = 'block'; m.className = 'wp-prev warn'; m.textContent = d.error || 'No se pudo renombrar.';
      return;
    }
    // v4.61: si cambio el tipo osTicket, guardarlo tambien (solo no-sistema).
    const nk = q('#rnOkind') ? q('#rnOkind').value : null;
    if (nk && nk !== (r.osticket_kind || 'none')) {
      const d2 = await api({ action: 'set_osticket', user: userPayload(ST.user), role_code: code, osticket_kind: nk });
      if (!d2.ok) {
        saveB.disabled = false; saveB.textContent = 'Guardar';
        const m = q('#rnMsg'); m.style.display = 'block'; m.className = 'wp-prev warn'; m.textContent = d2.error || 'El nombre se guardo, pero el acceso osTicket no se pudo cambiar.';
        return;
      }
    }
    closeModal(host, onKey);
    await reload();
    paintList();
  });
}

/* Restablecer al estandar: repone la matriz del rol desde el snapshot
   role_permissions_default (la matriz auditada). Confirmacion previa. */
function openResetModal(r) {
  const host = baseModal(`
    <button class="wp-x" id="rsX" title="Cerrar">✕</button>
    <h3>Restablecer al estándar</h3>
    <p class="wp-who"><b>${esc(r.label || r.code)}</b> · <span class="wp-ced">${esc(r.code)}</span></p>
    <div class="wp-dangerbox">Los permisos de este rol volverán al <b>estándar del portal</b> (la matriz auditada). Los cambios manuales hechos después se pierden. Se aplica de inmediato.</div>
    <div id="rsMsg" class="wp-prev" style="display:none"></div>
    <div class="wp-foot"><span style="flex:1"></span>
      <button class="btn" id="rsCancel">Cancelar</button>
      <button class="btn btn-primary" id="rsGo">Sí, restablecer</button>
    </div>`);
  const q = s => host.querySelector(s);
  const onKey = ev => { if (ev.key === 'Escape') closeModal(host, onKey); };
  document.addEventListener('keydown', onKey);
  q('#rsX').addEventListener('click', () => closeModal(host, onKey));
  q('#rsCancel').addEventListener('click', () => closeModal(host, onKey));
  q('#rsGo').addEventListener('click', async () => {
    const goB = q('#rsGo');
    goB.disabled = true; goB.textContent = 'Restableciendo…';
    const d = await api({ action: 'reset_default', user: userPayload(ST.user), role_code: r.code });
    if (!d.ok) {
      goB.disabled = false; goB.textContent = 'Sí, restablecer';
      const m = q('#rsMsg'); m.style.display = 'block'; m.className = 'wp-prev warn'; m.textContent = d.error || 'No se pudo restablecer.';
      return;
    }
    closeModal(host, onKey);
    await reload();
    openDetail(r.code);
  });
}

function openToggleModal(code, toOn) {
  const r = roleByCode(code);
  if (!r) return;
  const host = baseModal(`
    <button class="wp-x" id="tgX" title="Cerrar">✕</button>
    <h3 style="${toOn ? '' : 'color:var(--danger,#dc2626)'}">${toOn ? 'Activar rol' : 'Desactivar rol'}</h3>
    <p class="wp-who"><b>${esc(r.label || code)}</b> · <span class="wp-ced">${esc(code)}</span></p>
    ${toOn
      ? '<div class="wp-okbox">El rol volvera a estar disponible y sus permisos se aplicaran de nuevo.</div>'
      : `<div class="wp-dangerbox">Los usuarios <b>no podran tener este rol</b> mientras este inactivo. ${r.user_count ? `Ahora lo tienen <b>${r.user_count}</b> usuario(s): hay que cambiarles el rol primero.` : 'Sus permisos quedan guardados por si se reactiva.'}</div>`}
    <div id="tgMsg" class="wp-prev" style="display:none"></div>
    <div class="wp-foot"><span style="flex:1"></span>
      <button class="btn" id="tgCancel">Cancelar</button>
      <button class="btn ${toOn ? 'btn-primary' : 'wp-btn-danger'}" id="tgGo">${toOn ? 'Activar' : 'Sí, desactivar'}</button>
    </div>`);
  const q = s => host.querySelector(s);
  const onKey = ev => { if (ev.key === 'Escape') closeModal(host, onKey); };
  document.addEventListener('keydown', onKey);
  q('#tgX').addEventListener('click', () => closeModal(host, onKey));
  q('#tgCancel').addEventListener('click', () => closeModal(host, onKey));
  q('#tgGo').addEventListener('click', async () => {
    const goB = q('#tgGo');
    goB.disabled = true; goB.textContent = toOn ? 'Activando…' : 'Desactivando…';
    const d = await api({ action: 'toggle', user: userPayload(ST.user), role_code: code, is_active: toOn });
    if (!d.ok) {
      goB.disabled = false; goB.textContent = toOn ? 'Activar' : 'Sí, desactivar';
      const m = q('#tgMsg'); m.style.display = 'block'; m.className = 'wp-prev warn'; m.textContent = d.error || 'No se pudo cambiar el estado.';
      return;
    }
    closeModal(host, onKey);
    await reload();
    paintList();
  });
}
