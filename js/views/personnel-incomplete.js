/* =====================================================================
   js/views/personnel-incomplete.js  →  vista "Datos incompletos"
   Reporte de personal ACTIVO con datos faltantes, dentro del alcance del
   admin. Un combo de campos (checkbox) define que se evalua: Sexo, Fecha
   nac., Cuenta banco, Telefono, Correo, Direccion (por defecto los 5
   primeros, Direccion sin tildar). La lista muestra por trabajador que
   campos le faltan (de entre los tildados). Filtros de alcance: zona,
   subzona, concepto, estado de empresa. Exporta (xlsx/csv/txt) respetando
   lo filtrado, con el mismo patron que Empresas.

   Datos por /api/personnel-search (action 'incomplete' y 'facets').
   Export: renderPersonnelIncomplete(user)
   ===================================================================== */

import { $ } from '../core/dom.js';
import { renderWorkerPhotos, openWorkerLightbox } from './worker-photos.js';

const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);

// Campos evaluables. key = valor que entiende el backend; label = UI;
// col = titulo de columna en export.
const FIELDS = [
  { key: 'gender',     label: 'Sexo',         col: 'Sexo' },
  { key: 'birth_date', label: 'Fecha nac.',   col: 'Fecha nacimiento' },
  { key: 'account',    label: 'Cuenta banco', col: 'Cuenta banco' },
  { key: 'phone',      label: 'Teléfono',     col: 'Teléfono' },
  { key: 'email',      label: 'Correo',       col: 'Correo' },
  { key: 'address',    label: 'Dirección',    col: 'Dirección' },
  { key: 'marital',    label: 'Estado civil', col: 'Estado civil' },
  { key: 'role',       label: 'Cargo',        col: 'Cargo' },
  { key: 'department', label: 'Departamento', col: 'Departamento' },
  { key: 'photo',      label: 'Foto',         col: 'Foto' },
];
const FIELD_LABEL = Object.fromEntries(FIELDS.map(f => [f.key, f.label]));
// Por defecto tildados los 5 primeros (Direccion NO).
const DEFAULT_FIELDS = ['gender', 'birth_date', 'account', 'phone', 'email'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
const AVATAR_BG = ['#dbeafe', '#fae8ff', '#dcfce7', '#fef9c3', '#fee2e2', '#e0e7ff', '#ccfbf1', '#ffedd5'];
const AVATAR_FG = ['#1e40af', '#86198f', '#166534', '#854d0e', '#991b1b', '#3730a3', '#0f766e', '#9a3412'];
function avatarColor(seed) {
  const s = String(seed || ''); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % AVATAR_BG.length;
}
/* Fecha ISO -> 'dd/mm/aa hh:mm' hora Caracas (para "Actualizó: X · fecha"). */
function fmtDT(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  const c = new Date(d.getTime() - 4 * 3600 * 1000);
  const z = n => String(n).padStart(2, '0');
  return `${z(c.getUTCDate())}/${z(c.getUTCMonth() + 1)}/${String(c.getUTCFullYear()).slice(2)} ${z(c.getUTCHours())}:${z(c.getUTCMinutes())}`;
}
/* v4.22: linea "Actualizó" con SEMAFORO, SIEMPRE visible (mismo criterio que
   las tarjetas de Personal): punto verde (edicion <=7 dias) / ambar (<=30) /
   gris (>30) + nombre corto (primer nombre + inicial de apellido + rol) +
   fecha ('hoy' o dd/mm/aa Caracas). Sin ediciones: punto hueco + 'Sin
   ediciones' + '—'. Tooltip con el texto completo. */
function caracasYMD(d) {
  const c = new Date(d.getTime() - 4 * 3600 * 1000);
  const z = n => String(n).padStart(2, '0');
  return `${c.getUTCFullYear()}-${z(c.getUTCMonth() + 1)}-${z(c.getUTCDate())}`;
}
function updLineHtml(w) {
  if (!w.profile_updated_by) {
    return `<span class="pi-upd none" title="Esta ficha aún no tiene ediciones registradas"><i class="pi-upddot none"></i><span class="uw">Sin ediciones</span><span class="ud">—</span></span>`;
  }
  const by = String(w.profile_updated_by);
  let who = by;
  const m = by.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) {
    const parts = m[1].trim().split(/\s+/).filter(Boolean);
    const nm = parts.length >= 2 ? `${parts[0]} ${parts[1].charAt(0).toUpperCase()}.` : (parts[0] || m[1]);
    who = `${nm} (${m[2]})`;
  }
  let dot = 'old', dt = '—';
  const d = w.profile_updated_at ? new Date(w.profile_updated_at) : null;
  if (d && !isNaN(d)) {
    const days = (Date.now() - d.getTime()) / 86400000;
    dot = days <= 7 ? 'ok' : (days <= 30 ? 'mid' : 'old');
    dt = caracasYMD(d) === caracasYMD(new Date()) ? 'hoy' : fmtDT(w.profile_updated_at).slice(0, 8);
  }
  const tip = `Ficha actualizada por ${by}${w.profile_updated_at ? ' · ' + fmtDT(w.profile_updated_at) : ''}`;
  return `<span class="pi-upd" title="${esc(tip)}"><i class="pi-upddot ${dot}"></i><span class="uw">Actualizó: ${esc(who)}</span><span class="ud">${dt}</span></span>`;
}
/* Iconos de accion por fila (trazo del portal). Foto = camara; ficha =
   tarjeta de persona con lineas. */
function icoPhoto() {
  return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>';
}
function icoFicha() {
  return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="10" r="2"/><path d="M13 9h5M13 13h5M6.5 15.5c.4-1.2 1.4-2 2.5-2s2.1.8 2.5 2"/></svg>';
}

/* -------- Busqueda en cliente (mismo criterio que la vista Personal) --------
   Normaliza sin acentos ni enie; separa por COMA en grupos (OR) y por espacio
   en palabras (AND). Un trabajador coincide si ALGUN grupo tiene TODOS sus
   tokens en su blob (cedula + nombre + cargo). Sin texto -> no filtra. */
function normSearch(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00f1/g, 'n');
}
function parseSearchGroups(q) {
  return normSearch(q)
    .split(',')
    .map(g => g.split(/\s+/).filter(Boolean))
    .filter(g => g.length);
}
function matchesSearch(w, groups) {
  if (!groups.length) return true;
  const blob = normSearch(`${w.id_number || ''} ${w.full_name || ''} ${w.role || ''}`);
  return groups.some(tokens => tokens.every(t => blob.includes(t)));
}

let USER = null;
let FACETS = null;
let SCOPE_COUNT = 0;  // universo ACTIVO del alcance con filtros aplicados (denominador del contador)
// Estado: campos evaluados + filtros de alcance + resultados.
let C = { fields: DEFAULT_FIELDS.slice(), zone: '', subzone: '', concept: '', status: '', q: '', type: '', company: '', photo: '' };
let ROWS = null;   // null = aun no consultado
// Paginacion en cliente (el export siempre incluye TODO, no la pagina).
let PAGE = 1;
let PER = 50;      // 25 | 50 | 100

function ensureStyles() {
  if (document.getElementById('piStyles')) return;
  const st = document.createElement('style');
  st.id = 'piStyles';
  st.textContent = `
  .pi-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .pi-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .pi-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:16px 0 6px}
  .pi-fields-wrap{position:relative}
  .pi-fields-btn{display:inline-flex;align-items:center;gap:8px;font:inherit;font-size:13px;padding:9px 13px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--ink);cursor:pointer}
  .pi-fields-btn:hover{background:var(--bg-soft,#f1f5f9)}
  .pi-fields-menu{position:absolute;z-index:30;top:calc(100% + 6px);left:0;min-width:220px;background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 28px rgba(15,23,42,.14);padding:8px}
  .pi-fields-menu[hidden]{display:none}
  .pi-fopt{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:8px;font-size:13.5px;color:var(--ink);cursor:pointer}
  .pi-fopt:hover{background:var(--bg-soft,#f1f5f9)}
  .pi-fopt input{width:16px;height:16px;accent-color:var(--brand,#2563eb)}
  .pi-filters{display:flex;gap:8px 10px;align-items:center;flex-wrap:wrap}
  .pi-filters .fg{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted)}
  .pi-filters select{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink)}
  .pi-go{font:inherit;font-size:14px;font-weight:600;padding:9px 20px;border:1px solid var(--brand,#2563eb);border-radius:10px;background:var(--brand,#2563eb);color:#fff;cursor:pointer;white-space:nowrap}
  .pi-go:hover{filter:brightness(.96)}
  .pi-clear{font:inherit;font-size:12.5px;padding:8px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);cursor:pointer}
  .pi-clear:hover{background:var(--bg-soft,#f1f5f9)}
  .pi-export-wrap{position:relative;margin-left:auto}
  .pi-export-btn{font:inherit;font-size:13px;padding:9px 14px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--ink);cursor:pointer}
  .pi-export-btn:hover{background:var(--bg-soft,#f1f5f9)}
  .pi-export-menu{position:absolute;z-index:30;top:calc(100% + 6px);right:0;min-width:150px;background:var(--card,#fff);border:1px solid var(--border);border-radius:11px;box-shadow:0 8px 28px rgba(15,23,42,.14);padding:6px;display:flex;flex-direction:column;gap:2px}
  .pi-export-menu[hidden]{display:none}
  .pi-export-menu button{font:inherit;font-size:13px;text-align:left;padding:9px 11px;border:0;border-radius:8px;background:transparent;color:var(--ink);cursor:pointer}
  .pi-export-menu button:hover{background:var(--bg-soft,#f1f5f9)}
  .pi-count{color:var(--muted);font-size:12px;margin:8px 2px 10px}
  .pi-searchbar{margin:4px 0 0}
  .pi-search{display:flex;align-items:center;gap:8px;max-width:420px;padding:8px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface)}
  .pi-search svg{flex:none;color:var(--muted)}
  .pi-search input{flex:1;font:inherit;font-size:13.5px;border:0;background:transparent;color:var(--ink);outline:none}
  .pi-searchbar[hidden]{display:none}
  .pi-list{display:flex;flex-direction:column;gap:8px}
  .pi-row{display:flex;align-items:center;gap:13px;padding:11px 13px;border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);transition:border-color .12s,box-shadow .12s}
  .pi-row:hover{border-color:var(--brand,#2563eb);box-shadow:0 2px 10px rgba(15,23,42,.06)}
  .pi-ava{width:42px;height:42px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;overflow:hidden}
  .pi-ava.haspic{cursor:zoom-in}
  .pi-ava img{width:100%;height:100%;object-fit:cover;display:block}
  .pi-main{flex:0 1 auto;min-width:0;max-width:34%}
  .pi-name{font-weight:600;color:var(--ink);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pi-sub{color:var(--muted);font-size:12px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pi-right{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex:none;text-align:right;max-width:52%;margin-left:auto}
  .pi-emp{font-size:12px;color:var(--brand,#2563eb);font-weight:700;font-family:ui-monospace,Menlo,monospace}
  .pi-empn{font-size:11.5px;color:var(--ink);max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pi-upd{font-size:11px;color:var(--ink-soft,#475569);display:inline-flex;align-items:center;gap:5px;max-width:100%}
  .pi-upd .uw{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .pi-upd .ud{color:var(--faint,#94a3b8);flex:none;font-variant-numeric:tabular-nums}
  .pi-upd.none{color:var(--faint,#94a3b8)}
  .pi-upd.none .uw{font-weight:500;font-style:italic}
  .pi-upddot{width:7px;height:7px;border-radius:50%;flex:none}
  .pi-upddot.ok{background:#22c55e}
  .pi-upddot.mid{background:#f59e0b}
  .pi-upddot.old{background:#cbd5e1}
  .pi-upddot.none{width:6px;height:6px;background:transparent;border:1.5px solid #d3dae4}
  .pi-miss{display:flex;gap:5px;margin-top:2px;flex-wrap:wrap;justify-content:flex-end}
  .pi-tag{display:inline-block;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;background:#fef3c7;color:#92400e;white-space:nowrap}
  .pi-empty,.pi-hint{padding:34px 14px;text-align:center;color:var(--muted)}
  .pi-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:14px 2px 4px}
  .pi-pager .pg-per{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted)}
  .pi-pager .pg-per select{font:inherit;font-size:12.5px;padding:5px 8px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink)}
  .pi-pager .pg-nav{display:flex;align-items:center;gap:5px}
  .pi-pager .pg-nav button{min-width:32px;height:32px;padding:0 9px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);cursor:pointer;font:inherit;font-size:12.5px}
  .pi-pager .pg-nav button:hover:not(:disabled){background:var(--bg-soft,#f1f5f9)}
  .pi-pager .pg-nav button:disabled{opacity:.45;cursor:default}
  .pi-pager .pg-nav button.on{background:var(--brand,#2563eb);color:#fff;border-color:var(--brand,#2563eb)}
  .pi-pager .pg-info{font-size:12px;color:var(--muted)}
  /* Acciones por fila: botones iconizados (foto / ficha) estilo portal; el de
     foto se deshabilita (gris) si el trabajador no tiene foto. */
  .pi-actions{display:flex;gap:6px;flex:none;align-items:center}
  .pi-iconbtn{width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink-soft,#475569);cursor:pointer;transition:background .12s,border-color .12s,color .12s}
  .pi-iconbtn:hover{background:var(--brand-bg,#eff6ff);border-color:var(--brand,#2563eb);color:var(--brand,#2563eb)}
  .pi-iconbtn:disabled{opacity:.45;cursor:default;background:var(--bg-soft,#f1f5f9);color:var(--faint,#94a3b8);border-color:var(--border)}
  .pi-iconbtn:disabled:hover{background:var(--bg-soft,#f1f5f9);border-color:var(--border);color:var(--faint,#94a3b8)}

  /* MOVIL (<=768px): la fila de resultado se vuelve TARJETA apilada, para que
     el NOMBRE se lea completo (en escritorio .pi-main va limitado al 34% y en
     pantalla chica el nombre se recortaba a las iniciales). */
  @media (max-width:768px){
    .pi-bar{gap:9px}
    .pi-fields-wrap,.pi-go,.pi-clear,.pi-export-wrap{flex:1 1 auto}
    .pi-fields-btn{width:100%;justify-content:space-between}
    .pi-export-wrap{margin-left:0}
    .pi-filters{flex:1 1 100%;gap:9px}
    .pi-filters .fg{flex:1 1 100%;justify-content:space-between}
    .pi-filters .fg select{flex:1 1 auto;min-width:0}
    .pi-search{max-width:none}
    /* Tarjeta de resultado: avatar + nombre a lo ancho arriba; empresa debajo. */
    .pi-row{flex-wrap:wrap;align-items:flex-start;gap:11px;padding:13px 14px}
    .pi-ava{order:1;width:46px;height:46px}
    .pi-main{flex:1 1 0;min-width:0;max-width:none;order:2}
    .pi-name{white-space:normal;font-size:15px;line-height:1.25}
    .pi-sub{white-space:normal}
    .pi-actions{order:3;flex:none}
    .pi-right{order:4;flex:1 1 100%;max-width:none;align-items:flex-start;text-align:left;
      margin-left:0;padding-top:10px;border-top:1px solid var(--border-soft,#eef1f5);gap:3px}
    .pi-empn{max-width:none;white-space:normal}
    .pi-miss{justify-content:flex-start}
  }
  `;
  document.head.appendChild(st);
}

async function api(payload) {
  return fetch('/api/personnel-search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(x => x.json()).catch(() => null);
}

function subzonesFor(zoneId) {
  const all = (FACETS && FACETS.subzones) || [];
  if (!zoneId) return all;
  return all.filter(s => String(s.id).startsWith(zoneId + '_'));
}
/* Empresas del combo, filtradas por el tipo elegido (si hay). Cada item trae
   { code, name, type }. Sin tipo -> todas las del alcance. */
function companiesFor(type) {
  const all = (FACETS && FACETS.companies) || [];
  if (!type) return all;
  return all.filter(c => c.type === type);
}
/* Llena el combo de empresas (value=code). Conserva la seleccion si sigue
   siendo valida tras cambiar el tipo. */
function fillCompanySelect(sel, items, current) {
  if (!sel) return;
  sel.innerHTML = '<option value="">Todas</option>'
    + items.map(c => `<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.name)}</option>`).join('');
  sel.value = items.some(c => String(c.code) === String(current)) ? current : '';
}
function fillSelect(sel, items, current, placeholder) {
  if (!sel) return;
  sel.innerHTML = `<option value="">${placeholder}</option>`
    + items.map(it => `<option value="${esc(it.id)}">${esc(it.name)}</option>`).join('');
  sel.value = items.some(it => String(it.id) === String(current)) ? current : '';
}

export async function renderPersonnelIncomplete(user) {
  USER = user;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="pi-head"><div><h1>Datos incompletos</h1>
      <p>Personal <b>activo</b> con datos faltantes. Elige qué campos evaluar, refina por alcance y pulsa <b>Generar</b>. Para listar por foto, tilda <b>Foto</b> en Campos o usa el filtro <b>Foto</b>.</p></div></div>
    <div class="pi-bar">
      <div class="pi-fields-wrap">
        <button class="pi-fields-btn" id="piFieldsBtn" type="button">
          <span id="piFieldsLabel">Campos</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <div class="pi-fields-menu" id="piFieldsMenu" hidden>
          ${FIELDS.map(f => `<label class="pi-fopt"><input type="checkbox" value="${f.key}" ${C.fields.includes(f.key) ? 'checked' : ''}><span>${f.label}</span></label>`).join('')}
        </div>
      </div>
      <div class="pi-filters">
        <span class="fg">Tipo <select id="piType"><option value="">Todos</option></select></span>
        <span class="fg">Empresa <select id="piCompany"><option value="">Todas</option></select></span>
        <span class="fg">Foto <select id="piPhoto"><option value="">Todas</option><option value="with">Con foto</option><option value="without">Sin foto</option></select></span>
        <span class="fg">Zona <select id="piZone"><option value="">Todas</option></select></span>
        <span class="fg">Subzona <select id="piSubzone"><option value="">Todas</option></select></span>
        <span class="fg">Concepto <select id="piConcept"><option value="">Todos</option></select></span>
        <span class="fg">Estado <select id="piStatus"><option value="">Todos</option></select></span>
      </div>
      <button class="pi-go" id="piGo">Generar</button>
      <button class="pi-clear" id="piClear">Limpiar</button>
      <div class="pi-export-wrap">
        <button class="pi-export-btn" id="piExportBtn" type="button">Exportar ▾</button>
        <div class="pi-export-menu" id="piExportMenu" hidden>
          <button data-fmt="xlsx">Excel (.xlsx)</button>
          <button data-fmt="csv">CSV (.csv)</button>
          <button data-fmt="txt">Texto (.txt)</button>
        </div>
      </div>
    </div>
    <div class="pi-searchbar" id="piSearchBar" hidden>
      <div class="pi-search">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="piSearch" type="text" placeholder="Filtrar por nombre, cédula o cargo (separa con coma)…" autocomplete="off">
      </div>
    </div>
    <div class="pi-count" id="piCount"></div>
    <div class="pi-list" id="piList"></div>
    <div class="pi-pager" id="piPager" hidden></div>`;

  // Facetas (cache) y combos.
  if (!FACETS) {
    const r = await api({ action: 'facets', adminId: USER.id });
    FACETS = (r && r.ok && r.facets) ? r.facets : { zones: [], subzones: [], concepts: [], statuses: [], types: [], companies: [] };
  }
  // Tipo de empresa (combo).
  const tSel = $('#piType');
  if (tSel) {
    tSel.innerHTML = '<option value="">Todos</option>'
      + (FACETS.types || []).map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    tSel.value = (FACETS.types || []).includes(C.type) ? C.type : '';
  }
  // Empresa (combo), filtrada por el tipo elegido.
  fillCompanySelect($('#piCompany'), companiesFor(C.type), C.company);
  const phSel = $('#piPhoto');
  if (phSel) phSel.value = (C.photo === 'with' || C.photo === 'without') ? C.photo : '';
  fillSelect($('#piZone'), FACETS.zones || [], C.zone, 'Todas');
  fillSelect($('#piSubzone'), subzonesFor(C.zone), C.subzone, 'Todas');
  fillSelect($('#piConcept'), FACETS.concepts || [], C.concept, 'Todos');
  const stSel = $('#piStatus');
  if (stSel) {
    stSel.innerHTML = '<option value="">Todos</option>'
      + (FACETS.statuses || []).map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    stSel.value = (FACETS.statuses || []).includes(C.status) ? C.status : '';
  }

  updateFieldsLabel();

  // Combo de campos (abrir/cerrar + checkboxes).
  const fBtn = $('#piFieldsBtn'), fMenu = $('#piFieldsMenu');
  fBtn.addEventListener('click', (e) => { e.stopPropagation(); fMenu.hidden = !fMenu.hidden; });
  fMenu.addEventListener('click', (e) => e.stopPropagation());
  fMenu.querySelectorAll('input[type=checkbox]').forEach(cb =>
    cb.addEventListener('change', () => {
      C.fields = [...fMenu.querySelectorAll('input:checked')].map(x => x.value);
      updateFieldsLabel();
    }));

  // Filtros.
  $('#piType').addEventListener('change', () => {
    C.type = $('#piType').value; C.company = '';
    fillCompanySelect($('#piCompany'), companiesFor(C.type), '');
  });
  $('#piCompany').addEventListener('change', () => { C.company = $('#piCompany').value; });
  $('#piPhoto').addEventListener('change', () => { C.photo = $('#piPhoto').value; });
  $('#piZone').addEventListener('change', () => {
    C.zone = $('#piZone').value; C.subzone = '';
    fillSelect($('#piSubzone'), subzonesFor(C.zone), '', 'Todas');
  });
  $('#piSubzone').addEventListener('change', () => { C.subzone = $('#piSubzone').value; });
  $('#piConcept').addEventListener('change', () => { C.concept = $('#piConcept').value; });
  $('#piStatus').addEventListener('change', () => { C.status = $('#piStatus').value; });

  $('#piGo').addEventListener('click', run);
  const searchEl = $('#piSearch');
  if (searchEl) {
    searchEl.value = C.q || '';
    searchEl.addEventListener('input', () => { C.q = searchEl.value; PAGE = 1; paint(); });
  }
  $('#piClear').addEventListener('click', () => {
    C = { fields: DEFAULT_FIELDS.slice(), zone: '', subzone: '', concept: '', status: '', q: '', type: '', company: '', photo: '' };
    ROWS = null;
    renderPersonnelIncomplete(USER);
  });

  // Export.
  const exBtn = $('#piExportBtn'), exMenu = $('#piExportMenu');
  exBtn.addEventListener('click', (e) => { e.stopPropagation(); exMenu.hidden = !exMenu.hidden; });
  exMenu.addEventListener('click', (e) => e.stopPropagation());
  exMenu.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { exMenu.hidden = true; doExport(b.dataset.fmt); }));

  // Cerrar menus al hacer clic fuera.
  document.addEventListener('click', closeMenus);

  paint();
}

function closeMenus() {
  const fm = $('#piFieldsMenu'), em = $('#piExportMenu');
  if (fm) fm.hidden = true;
  if (em) em.hidden = true;
}

function updateFieldsLabel() {
  const el = $('#piFieldsLabel');
  if (!el) return;
  const n = C.fields.length;
  el.textContent = n === 0 ? 'Campos (ninguno)'
    : n === FIELDS.length ? 'Campos: todos'
    : `Campos: ${n}`;
}

async function run() {
  if (!C.fields.length) {
    const countEl = $('#piCount');
    if (countEl) countEl.textContent = 'Elige al menos un campo a evaluar.';
    ROWS = null; paint(); return;
  }
  const countEl = $('#piCount');
  if (countEl) countEl.textContent = 'Generando…';
  const r = await api({
    action: 'incomplete', adminId: USER.id,
    fields: C.fields,
    zone: C.zone || null, subzone: C.subzone || null,
    concept: C.concept || null, status: C.status || null,
    type: C.type || null, company: C.company || null,
    photo: C.photo || null,
  });
  ROWS = (r && r.ok) ? (r.rows || []) : [];
  SCOPE_COUNT = (r && r.ok && Number.isFinite(r.scope_count)) ? r.scope_count : 0;
  PAGE = 1;
  paint();
}

function avatarCell(w, idx) {
  // Miniatura si hay foto (URL publica directa): la FOTO MISMA es clicable y
  // abre el visor (v4.42, igual que Sincronizar). Sin foto: iniciales.
  if (w.thumb_url) {
    return `<div class="pi-ava haspic" data-avpic="${idx}" title="Ver foto"><img src="${esc(w.thumb_url)}" alt="" loading="lazy" onerror="this.remove()"></div>`;
  }
  const ci = avatarColor(w.id_number);
  return `<div class="pi-ava" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(w.full_name))}</div>`;
}

function paint() {
  const list = $('#piList');
  const countEl = $('#piCount');
  const searchBar = $('#piSearchBar');
  const pager = $('#piPager');
  if (!list) return;

  if (ROWS === null) {
    if (countEl) countEl.textContent = '';
    if (searchBar) searchBar.hidden = true;   // sin reporte aun: sin buscador
    if (pager) pager.hidden = true;
    list.innerHTML = `<div class="pi-hint">Elige los campos a evaluar y pulsa <b>Generar</b>.</div>`;
    return;
  }
  if (!ROWS.length) {
    if (countEl) countEl.textContent = '';
    if (searchBar) searchBar.hidden = true;   // nada que buscar
    if (pager) pager.hidden = true;
    list.innerHTML = `<div class="pi-empty">Ningún trabajador activo tiene esos campos incompletos. 🎉</div>`;
    return;
  }

  // Hay resultados: mostrar el buscador y aplicar el filtro de texto en cliente.
  if (searchBar) searchBar.hidden = false;
  const groups = parseSearchGroups(C.q || '');
  const shown = groups.length ? ROWS.filter(w => matchesSearch(w, groups)) : ROWS;

  if (countEl) {
    // Denominador (Forma B) = personal ACTIVO del alcance CON los filtros
    // aplicados (tipo/empresa/zona/subzona/concepto/estado), sin criterios.
    // El % es cuantos activos filtrados tienen datos incompletos.
    const uni = SCOPE_COUNT || 0;
    const pct = uni > 0 ? Math.round((ROWS.length / uni) * 100) : null;
    const den = uni > 0 ? ` de ${uni} activos` : '';
    const pctNote = pct != null ? ` · ${pct}%` : '';
    if (groups.length) {
      countEl.textContent = `${shown.length} de ${ROWS.length} filtrados · ${ROWS.length}${den} con datos incompletos${pctNote}`;
    } else {
      countEl.textContent = `${ROWS.length}${den} con datos incompletos${pctNote}`;
    }
  }

  if (!shown.length) {
    if (pager) pager.hidden = true;
    list.innerHTML = `<div class="pi-empty">Ninguno coincide con la búsqueda.</div>`;
    return;
  }

  // Paginacion en cliente sobre 'shown'.
  const total = shown.length;
  const pages = Math.max(1, Math.ceil(total / PER));
  if (PAGE > pages) PAGE = pages;
  const start = (PAGE - 1) * PER;
  const pageRows = shown.slice(start, start + PER);

  list.innerHTML = pageRows.map((w, i) => {
    const sub = [`C.I. ${esc(w.id_number)}`];
    if (w.role) sub.push(esc(w.role));
    if (w.department_name) sub.push(esc(w.department_name));
    const empn = [w.company_name, w.zona, w.concepto].filter(Boolean).map(esc).join(' · ');
    const tags = (w.missing || []).map(m => `<span class="pi-tag">falta ${esc(FIELD_LABEL[m] || m)}</span>`).join('');
    // v4.22: quien actualizo la ficha de ultimo, con semaforo y SIEMPRE
    // visible (sin dato: 'Sin ediciones'). Mismo criterio que Personal.
    const updLine = updLineHtml(w);
    const hasPhoto = !!w.thumb_url;
    const acts = `<div class="pi-actions">
        <button type="button" class="pi-iconbtn" data-ficha="${start + i}" title="Ver ficha">${icoFicha()}</button>
        <button type="button" class="pi-iconbtn" data-copy="${start + i}" title="Copiar datos">${icoCopy()}</button>
      </div>`;
    return `<div class="pi-row">
      ${avatarCell(w, start + i)}
      <div class="pi-main">
        <div class="pi-name">${esc(w.full_name)}</div>
        <div class="pi-sub">${sub.join(' · ')}</div>
      </div>
      ${acts}
      <div class="pi-right">
        <span class="pi-emp">${esc(w.company_code)}${w.data_area ? ` · <span style="color:var(--muted);font-weight:600">${esc(w.data_area)}</span>` : ''}</span>
        ${empn ? `<span class="pi-empn">${empn}</span>` : ''}
        ${updLine}
        <div class="pi-miss">${tags}</div>
      </div>
    </div>`;
  }).join('');

  // Acciones por fila: foto abre el visor grande; ficha abre el detalle. La
  // fila ya NO abre nada por si sola.
  list.querySelectorAll('[data-ficha]').forEach(b =>
    b.addEventListener('click', () => openWorker(shown[+b.dataset.ficha])));
  list.querySelectorAll('[data-copy]').forEach(b =>
    b.addEventListener('click', () => copyWorkerData(shown[+b.dataset.copy], b)));
  list.querySelectorAll('[data-avpic]').forEach(b =>
    b.addEventListener('click', () => {
      const w = shown[+b.dataset.avpic];
      if (!w || !w.thumb_url) return;
      openWorkerLightbox(w.thumb_url, `${w.full_name} · C.I. ${w.id_number}`, `${w.id_number}.jpg`);
    }));

  paintPager(pager, total, pages, start, pageRows.length);
}

// Dibuja el paginador (selector 25/50/100 + navegacion). Se oculta si todo
// cabe en una pagina Y el usuario no cambio el tamano.
function paintPager(pager, total, pages, start, shownCount) {
  if (!pager) return;
  pager.hidden = false;
  const from = total === 0 ? 0 : start + 1;
  const to = start + shownCount;
  // Botones de pagina: primera, ultima y una ventana alrededor de la actual.
  const nums = [];
  const push = (n) => { if (n >= 1 && n <= pages && !nums.includes(n)) nums.push(n); };
  push(1); push(2);
  for (let n = PAGE - 1; n <= PAGE + 1; n++) push(n);
  push(pages - 1); push(pages);
  nums.sort((a, b) => a - b);
  let btns = '';
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) btns += `<span style="color:var(--faint);padding:0 2px">…</span>`;
    btns += `<button data-pg="${n}" class="${n === PAGE ? 'on' : ''}">${n}</button>`;
    prev = n;
  }
  pager.innerHTML = `
    <div class="pg-per">Mostrar
      <select id="piPer">
        <option value="25" ${PER === 25 ? 'selected' : ''}>25</option>
        <option value="50" ${PER === 50 ? 'selected' : ''}>50</option>
        <option value="100" ${PER === 100 ? 'selected' : ''}>100</option>
      </select> por página
    </div>
    <div class="pg-nav">
      <button data-pg="prev" ${PAGE <= 1 ? 'disabled' : ''}>‹</button>
      ${btns}
      <button data-pg="next" ${PAGE >= pages ? 'disabled' : ''}>›</button>
    </div>
    <div class="pg-info">${from}–${to} de ${total}</div>`;

  const perSel = pager.querySelector('#piPer');
  if (perSel) perSel.addEventListener('change', () => { PER = parseInt(perSel.value, 10) || 50; PAGE = 1; paint(); });
  pager.querySelectorAll('.pg-nav button[data-pg]').forEach(b =>
    b.addEventListener('click', () => {
      const v = b.dataset.pg;
      if (v === 'prev') PAGE = Math.max(1, PAGE - 1);
      else if (v === 'next') PAGE = Math.min(pages, PAGE + 1);
      else PAGE = parseInt(v, 10) || 1;
      paint();
    }));
}

// Abre la ficha del trabajador (reusa Personal). Al pulsar Volver en la ficha,
// regresa a ESTA vista con el reporte intacto (ROWS/estado se conservan).
function openWorker(w) {
  if (!w) return;
  const mode = NON_STORE_TYPES.has(w.company_type) ? 'enterprise' : 'store';
  renderWorkerPhotos(USER, w.company_code, () => renderPersonnelIncomplete(USER), { mode, openCed: w.id_number });
}

/* ---------- Copiar datos de la ficha al portapapeles (v4.39) ---------- */
function icoCopy() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
}
function workerCopyText(w) {
  const MAR = { S: 'Soltero(a)', C: 'Casado(a)', D: 'Divorciado(a)', V: 'Viudo(a)', O: 'Conviviente', R: 'Union registrada' };
  const L = [];
  L.push(w.full_name || '(sin nombre)');
  L.push(`C.I.: ${(w.ced_kind || 'V')}-${w.id_number}`);
  const emp = [w.company_code, w.company_name].filter(Boolean).join(' · ');
  if (emp) L.push(`Empresa: ${emp}`);
  const ubi = [w.zona, w.subzona, w.concepto].filter(Boolean).join(' · ');
  if (ubi) L.push(ubi);
  if (w.department) L.push(`Departamento: ${w.department}`);
  if (w.role) L.push(`Cargo: ${w.role}`);
  if (w.gender) L.push(`Sexo: ${w.gender === 'M' ? 'Masculino' : w.gender === 'F' ? 'Femenino' : w.gender}`);
  if (w.birth_date) L.push(`Nacimiento: ${String(w.birth_date).slice(0, 10)}${w.age != null ? ` (${w.age} años)` : ''}`);
  else if (w.age != null) L.push(`Edad: ${w.age} años`);
  if (w.marital_status) L.push(`Estado civil: ${MAR[w.marital_status] || w.marital_status}`);
  if (w.phone) L.push(`Teléfono: ${String(w.phone).startsWith('+58') ? '0' + String(w.phone).slice(3) : w.phone}`);
  if (w.email) L.push(`Correo: ${w.email}`);
  if (w.account_number) L.push(`Cuenta: ${w.account_number}`);
  if (w.address) L.push(`Dirección: ${w.address}`);
  L.push(`Ficha: ${String(w.id_number).replace(/[^0-9]/g, '')}`);
  return L.join('\n');
}
async function copyWorkerData(w, btn) {
  if (!w) return;
  const text = workerCopyText(w);
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      ok = document.execCommand('copy'); ta.remove();
    } catch (__) { ok = false; }
  }
  if (btn && ok) {
    const prev = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    setTimeout(() => { btn.innerHTML = prev; }, 1200);
  }
}

/* -------- Exportacion (xlsx / csv / txt), mismo patron que Empresas --------
   Exporta lo que se ve: si hay busqueda activa, respeta el filtro de texto
   (mismos grupos coma/espacio que la lista). Sin busqueda, exporta todo. */
function exportRows() {
  const groups = parseSearchGroups(C.q || '');
  const src = groups.length ? (ROWS || []).filter(w => matchesSearch(w, groups)) : (ROWS || []);
  return src.map(w => ({
    'Cédula': w.id_number || '',
    'Nombre': w.full_name || '',
    'Cargo': w.role || '',
    'Estado civil': w.marital_status || '',
    'Departamento': w.department_name || '',
    'Foto': w.photo_key ? 'Sí' : 'No',
    'Empresa (alias)': w.company_code || '',
    'DataArea': w.data_area || '',
    'Empresa': w.company_name || '',
    'Tipo': w.company_type || '',
    'Zona': w.zona || '',
    'Subzona': w.subzona || '',
    'Concepto': w.concepto || '',
    'Datos faltantes': (w.missing || []).map(m => FIELD_LABEL[m] || m).join(', '),
    'Ficha actualizada por': w.profile_updated_by || '',
    'Ficha actualizada el': w.profile_updated_at ? fmtDT(w.profile_updated_at) : '',
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
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
async function doExport(fmt) {
  const data = exportRows();
  if (!data.length) { alert('No hay filas para exportar. Genera el reporte primero.'); return; }
  const headers = Object.keys(data[0]);
  const fname = `datos_incompletos_${tstamp()}`;

  if (fmt === 'csv') {
    const escv = (v) => {
      const s = String(v ?? '');
      return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.join(';')].concat(data.map(r => headers.map(h => escv(r[h])).join(';')));
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
      window.XLSX.utils.book_append_sheet(wb, ws, 'Datos incompletos');
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (e) {
      alert(e.message + ' Revisa tu conexión e inténtalo de nuevo.');
    }
    return;
  }
}
