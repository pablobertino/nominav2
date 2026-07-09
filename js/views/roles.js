/* =====================================================================
   js/views/roles.js  →  vista "Roles" (solo superadmin)
   Matriz de Roles y Permisos sobre nomina_v2.roles / permissions /
   role_permissions — las mismas tablas que decide can() en el servidor.
   Mockup aprobado: _PRUEBAS\roles_mockup.html (v0-mock6).

   Dos pantallas:
     1) GRILLA de roles: tipo (sistema / ve todo / estandar), # permisos,
        # usuarios; Renombrar / Desactivar (solo roles no-sistema); Nuevo rol.
     2) DETALLE de un rol: permisos agrupados por dominio (Vistas primero,
        con subgrupos del menu), modo lectura/edicion, buscador, "Todo el
        grupo", copiar desde otro rol, y la regla "USAR IMPLICA VER": los
        config.* encienden y sostienen su view.cfg.* correspondiente.

   El guardado reemplaza la matriz del rol via /api/roles (accion save);
   el servidor re-aplica la regla usar->ver e invalida el cache de permisos.
   superadmin no se edita (todo por codigo); tienda si (pasa por permSet).
   ===================================================================== */

import { $ } from '../core/dom.js';

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
  ['Personal', ['view.buscar', 'view.datosincompletos', 'view.egmotivos', 'view.rostersync', 'view.fotos']],
  ['Reportes', ['view.historial', 'view.estadisticas', 'view.reportempresas', 'view.estadopago', 'view.misstats']],
  ['Comunicacion', ['view.avisos', 'view.avisosconfig']],
  ['Solicitudes', ['view.solicitudes']],
  ['Sincronizacion', ['view.sync', 'view.syncreview']],
  ['Administracion', ['view.equipo', 'view.permisos', 'view.config', 'view.roles']],
  ['Empresa (tienda)', ['view.miempresa']],
  ['Ver pestañas de Configuracion', ['view.cfg.referencias', 'view.cfg.cargos', 'view.cfg.incidencias', 'view.cfg.calendario', 'view.cfg.sincronizacion', 'view.cfg.osticket', 'view.cfg.ajustes']],
];

/* ===================== ESTILOS ===================== */
function ensureStyles() {
  if (document.getElementById('rlStyles')) return;
  const st = document.createElement('style');
  st.id = 'rlStyles';
  st.textContent = `
  .rl-tablebox{border:1px solid var(--border,#e6eaf0);border-radius:14px;overflow:hidden;background:var(--card,#fff);box-shadow:0 1px 3px rgba(15,23,42,.04),0 8px 30px rgba(15,23,42,.05)}
  .rl-tablebox table{width:100%;border-collapse:collapse;font-size:13.5px}
  .rl-tablebox th{background:#fbfcfe;font-weight:600;color:var(--ink-soft,#475569);font-size:12px;text-transform:uppercase;letter-spacing:.03em;text-align:left;padding:13px 18px;border-bottom:1px solid var(--border,#e6eaf0);white-space:nowrap}
  .rl-tablebox td{padding:15px 18px;border-bottom:1px solid var(--border-soft,#f1f4f8);vertical-align:middle}
  .rl-tablebox tbody tr:last-child td{border-bottom:0}
  .rl-tablebox tbody tr{transition:background .1s;cursor:pointer}
  .rl-tablebox tbody tr:hover{background:#fafbfd}
  .rl-rname{font-weight:600;font-size:14px}
  .rl-rdesc{font-size:12px;color:var(--muted,#64748b);margin-top:2px;font-family:ui-monospace,Menlo,monospace}
  .rl-num{text-align:right;font-variant-numeric:tabular-nums}
  .rl-pill{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:999px;font-size:11.5px;font-weight:600;white-space:nowrap}
  .rl-pill::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.9}
  .rl-pill-sys{background:#0f172a;color:#fff}.rl-pill-sys::before{background:#93c5fd}
  .rl-pill-ro{background:#fef6e7;color:#92400e}
  .rl-pill-gray{background:var(--border-soft,#f1f4f8);color:var(--ink-soft,#475569)}.rl-pill-gray::before{display:none}
  .rl-pill-off{background:#fdecec;color:#991b1b}
  .rl-rowacts{display:flex;gap:6px;justify-content:flex-end;align-items:center}
  .rl-chev{color:var(--faint,#94a3b8)}
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
  const d = await api({ action: 'matrix', user: userPayload(ST.user) });
  if (d.ok) { ST.roles = d.roles || []; ST.permissions = d.permissions || []; ST.grants = d.grants || {}; }
}

/* ===================== PANTALLA 1: GRILLA ===================== */
function rolePill(r) {
  if (!r.is_active) return '<span class="rl-pill rl-pill-off">inactivo</span>';
  if (r.is_system) return '<span class="rl-pill rl-pill-sys">sistema</span>';
  if (r.readonly_scope) return '<span class="rl-pill rl-pill-ro">ve todo</span>';
  return '<span class="rl-pill rl-pill-gray">estandar</span>';
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
    const acts = r.is_system
      ? ''
      : `<button class="btn btn-sm" data-ren="${esc(r.code)}">Renombrar</button>`
        + (r.is_active
          ? `<button class="btn btn-sm" style="color:var(--danger,#dc2626);border-color:#f6cccc" data-tog="${esc(r.code)}" data-to="off">Desactivar</button>`
          : `<button class="btn btn-sm" data-tog="${esc(r.code)}" data-to="on">Activar</button>`);
    return `<tr data-open="${esc(r.code)}">
      <td><div class="rl-rname">${esc(r.label || r.code)}</div><div class="rl-rdesc">${esc(r.code)}</div></td>
      <td>${rolePill(r)}</td>
      <td>${okindPill(r)}</td>
      <td class="rl-num">${r.perm_count == null ? 'todos' : r.perm_count}</td>
      <td class="rl-num">${r.user_count}</td>
      <td><div class="rl-rowacts">${acts}<svg class="rl-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></div></td>
    </tr>`;
  }).join('');

  $('#pnlMain').innerHTML = `
    <div class="pnl-head">
      <div><h1>Roles</h1><p>Toca un rol para ver o editar sus permisos. El alcance por empresa se configura aparte, en Permisos.</p></div>
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
      openDetail(String(tr.dataset.open));
    }));
  document.querySelectorAll('#pnlMain [data-ren]').forEach(b =>
    b.addEventListener('click', (e) => { e.stopPropagation(); openRenameModal(String(b.dataset.ren)); }));
  document.querySelectorAll('#pnlMain [data-tog]').forEach(b =>
    b.addEventListener('click', (e) => { e.stopPropagation(); openToggleModal(String(b.dataset.tog), b.dataset.to === 'on'); }));
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
        <div class="search"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><input id="rlSearch" placeholder="Buscar permiso (documento, roster, cargo…)"></div>
        <span style="font-size:12.5px;color:var(--muted,#64748b)"><b id="rlOnCount2">${isSuperRole ? ST.permissions.length : ST.work.size}</b> de ${ST.permissions.length} permisos activos</span>
      </div>
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
    <h3>Renombrar rol</h3>
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
