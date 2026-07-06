/* =====================================================================
   js/views/personnel-search.js  →  vista "Buscar personal"
   Busqueda global de personal por cedula, nombre o CARGO en todas las
   empresas del alcance del admin, con filtros (criterios) de TIPO de
   empresa, EMPRESA, SEXO, RANGO DE EDAD, ZONA, SUBZONA, CONCEPTO y ESTADO
   de empresa.

   La busqueda se ejecuta con el boton "Buscar" (o Enter): los campos son
   CRITERIOS, no filtros en vivo. Cada resultado muestra la empresa donde
   esta contratado (ALIAS + DataArea, Razon Social y Zona/Subzona/Concepto),
   con su MINIATURA si tiene foto. Resultados ordenados por alias de empresa.
   Se pagina en cliente (25/50/100). Sobre los resultados ya traidos hay un
   FILTRO por coma (coma=OR, espacio=AND; sobre nombre/cedula/cargo/depto) que
   refina en vivo sin volver a buscar; el export respeta ese filtro si esta
   activo, si no incluye todo.

   Al tocar un resultado se abre la FICHA del trabajador reusando la vista
   Personal (renderWorkerPhotos con opts.openCed); al volver se regresa a
   ESTA busqueda con criterios y resultados intactos.

   Datos por /api/personnel-search (action 'search' y 'facets').
   Export: renderPersonnelSearch(user)
   ===================================================================== */

import { $ } from '../core/dom.js';
import { renderWorkerPhotos, openWorkerLightbox } from './worker-photos.js';

const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);

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
function avatarCell(w) {
  // Miniatura si hay foto (URL publica directa, esquema por photo_key). Si no,
  // iniciales de color. onerror quita la img si la URL fallara.
  if (w.thumb_url) {
    return `<div class="ps-ava"><img src="${esc(w.thumb_url)}" alt="" loading="lazy" onerror="this.remove()"></div>`;
  }
  const ci = avatarColor(w.id_number);
  return `<div class="ps-ava" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(w.full_name))}</div>`;
}

/* Iconos de accion por fila (trazo del portal). Foto = camara; ficha =
   tarjeta de persona con lineas. */
function icoPhoto() {
  return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>';
}
function icoFicha() {
  return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="10" r="2"/><path d="M13 9h5M13 13h5M6.5 15.5c.4-1.2 1.4-2 2.5-2s2.1.8 2.5 2"/></svg>';
}

let USER = null;
let FACETS = null;          // { zones, subzones, concepts, statuses, types, companies } cache
let SCOPE = { total: 0, active: 0 };  // totales del alcance (denominador del contador)
// Criterios (se conservan al volver de una ficha).
let C = { q: '', type: '', company: '', photo: '', gender: '', ageMin: '', ageMax: '', zone: '', subzone: '', concept: '', status: '' };
let SEARCH_ROWS = null;     // null = aun no se ha buscado
// Filtro en cliente sobre los resultados ya traidos (separador por coma, igual
// que la vista Personal). No dispara busqueda: refina lo que ya esta en pantalla.
let FQ = '';
// Paginacion en cliente (el export siempre incluye TODO).
let PAGE = 1;
let PER = 50;               // 25 | 50 | 100

/* -------- Filtro en cliente por COMA (mismo criterio que la vista Personal) --
   Normaliza sin acentos ni enie; separa por COMA en grupos (OR) y por espacio
   en palabras (AND). Un trabajador coincide si ALGUN grupo tiene TODOS sus
   tokens en su blob (cedula + nombre + cargo + departamento). Sin texto -> no
   filtra. */
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
  const blob = normSearch(`${w.id_number || ''} ${w.full_name || ''} ${w.role || ''} ${w.department_name || ''}`);
  return groups.some(tokens => tokens.every(t => blob.includes(t)));
}

function ensureStyles() {
  if (document.getElementById('psStyles')) return;
  const st = document.createElement('style');
  st.id = 'psStyles';
  st.textContent = `
  .ps-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .ps-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .ps-searchrow{display:flex;gap:8px;align-items:stretch;margin:16px 0 8px;max-width:620px}
  .ps-search{position:relative;flex:1}
  .ps-search svg{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:var(--muted)}
  .ps-search input{width:100%;font:inherit;font-size:15px;padding:12px 14px 12px 40px;border:1px solid var(--border);border-radius:11px;background:var(--surface);color:var(--ink);box-sizing:border-box}
  .ps-search input:focus{outline:none;border-color:var(--brand,#2563eb);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
  .ps-go{font:inherit;font-size:14px;font-weight:600;padding:0 20px;border:1px solid var(--brand,#2563eb);border-radius:11px;background:var(--brand,#2563eb);color:#fff;cursor:pointer;white-space:nowrap}
  .ps-go:hover{filter:brightness(.96)}
  .ps-filters{display:flex;gap:8px 10px;align-items:center;flex-wrap:wrap;margin:0 0 6px}
  .ps-filters .fg{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted)}
  .ps-filters select,.ps-filters input{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink)}
  .ps-filters input.age{width:58px}
  .ps-clear{font:inherit;font-size:12.5px;padding:7px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);cursor:pointer}
  .ps-clear:hover{background:var(--bg-soft,#f1f5f9)}
  .ps-export-wrap{position:relative}
  .ps-export-btn{font:inherit;font-size:12.5px;padding:7px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);cursor:pointer}
  .ps-export-btn:hover{background:var(--bg-soft,#f1f5f9)}
  .ps-export-menu{position:absolute;z-index:30;top:calc(100% + 6px);right:0;min-width:150px;background:var(--card,#fff);border:1px solid var(--border);border-radius:11px;box-shadow:0 8px 28px rgba(15,23,42,.14);padding:6px;display:flex;flex-direction:column;gap:2px}
  .ps-export-menu[hidden]{display:none}
  .ps-export-menu button{font:inherit;font-size:13px;text-align:left;padding:9px 11px;border:0;border-radius:8px;background:transparent;color:var(--ink);cursor:pointer}
  .ps-export-menu button:hover{background:var(--bg-soft,#f1f5f9)}
  .ps-count{color:var(--muted);font-size:12px;margin:6px 2px 10px}
  .ps-filterbar{margin:2px 0 10px}
  .ps-filterbar[hidden]{display:none}
  .ps-filterbar .fb{display:flex;align-items:center;gap:8px;max-width:460px;padding:8px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface)}
  .ps-filterbar svg{flex:none;color:var(--muted)}
  .ps-filterbar input{flex:1;font:inherit;font-size:13.5px;border:0;background:transparent;color:var(--ink);outline:none}
  .ps-list{display:flex;flex-direction:column;gap:8px}
  .ps-row{display:flex;align-items:center;gap:13px;padding:11px 13px;border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);transition:border-color .12s,box-shadow .12s}
  .ps-row:hover{border-color:var(--brand,#2563eb);box-shadow:0 2px 10px rgba(15,23,42,.06)}
  .ps-ava{width:42px;height:42px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;overflow:hidden}
  .ps-ava img{width:100%;height:100%;object-fit:cover;display:block}
  .ps-main{flex:0 1 auto;min-width:0;max-width:34%}
  .ps-name{font-weight:600;color:var(--ink);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps-sub{color:var(--muted);font-size:12px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps-right{display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex:none;text-align:right;max-width:46%;margin-left:auto}
  .ps-emp{font-size:12px;color:var(--brand,#2563eb);font-weight:700;font-family:ui-monospace,Menlo,monospace}
  .ps-emp .da{color:var(--muted);font-weight:600}
  .ps-empn{font-size:12px;color:var(--ink);font-weight:600;max-width:230px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps-empmeta{font-size:11px;color:var(--muted);max-width:230px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps-tags{display:flex;gap:5px;margin-top:3px;flex-wrap:wrap;justify-content:flex-end}
  .ps-pill{display:inline-block;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap}
  .ps-act{background:#dcfce7;color:#166534}
  .ps-egr{background:#fee2e2;color:#991b1b}
  .ps-type{background:#eef2ff;color:#3730a3}
  .ps-cst{background:#f1f5f9;color:#475569}
  .ps-empty,.ps-hint{padding:34px 14px;text-align:center;color:var(--muted)}
  .ps-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:14px 2px 4px}
  .ps-pager[hidden]{display:none}
  .ps-pager .pg-per{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted)}
  .ps-pager .pg-per select{font:inherit;font-size:12.5px;padding:5px 8px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink)}
  .ps-pager .pg-nav{display:flex;align-items:center;gap:5px}
  .ps-pager .pg-nav button{min-width:32px;height:32px;padding:0 9px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);cursor:pointer;font:inherit;font-size:12.5px}
  .ps-pager .pg-nav button:hover:not(:disabled){background:var(--bg-soft,#f1f5f9)}
  .ps-pager .pg-nav button:disabled{opacity:.45;cursor:default}
  .ps-pager .pg-nav button.on{background:var(--brand,#2563eb);color:#fff;border-color:var(--brand,#2563eb)}
  .ps-pager .pg-info{font-size:12px;color:var(--muted)}
  @media (max-width:640px){ .ps-right{max-width:50%} .ps-empn,.ps-empmeta{max-width:150px} }
  /* Acciones por fila: dos botones iconizados (foto / ficha) con estilo del
     portal. El de foto se deshabilita (gris) cuando el trabajador no tiene
     foto. */
  .ps-actions{display:flex;gap:6px;flex:none;align-items:center}
  .ps-iconbtn{width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink-soft,#475569);cursor:pointer;transition:background .12s,border-color .12s,color .12s}
  .ps-iconbtn:hover{background:var(--brand-bg,#eff6ff);border-color:var(--brand,#2563eb);color:var(--brand,#2563eb)}
  .ps-iconbtn:disabled{opacity:.45;cursor:default;background:var(--bg-soft,#f1f5f9);color:var(--faint,#94a3b8);border-color:var(--border)}
  .ps-iconbtn:disabled:hover{background:var(--bg-soft,#f1f5f9);border-color:var(--border);color:var(--faint,#94a3b8)}

  /* MOVIL (<=768px): la fila de resultado se vuelve TARJETA apilada, para que
     el NOMBRE se lea completo (en escritorio .ps-main va limitado al 34% y en
     pantalla chica el nombre se recortaba a las iniciales). */
  @media (max-width:768px){
    .ps-searchrow{max-width:none;flex-wrap:wrap}
    .ps-search{flex:1 1 100%}
    .ps-go{flex:1 1 100%;padding:12px 20px}
    .ps-filters{gap:9px}
    .ps-filters .fg{flex:1 1 100%;justify-content:space-between}
    .ps-filters .fg select,.ps-filters .fg input{flex:1 1 auto;min-width:0}
    .ps-filters .ps-clear,.ps-filters .ps-export-wrap{flex:1 1 auto}
    .ps-filterbar .fb{max-width:none}
    /* Tarjeta de resultado: avatar + nombre a lo ancho arriba; empresa debajo. */
    .ps-row{flex-wrap:wrap;align-items:flex-start;gap:11px;padding:13px 14px}
    .ps-ava{order:1;width:46px;height:46px}
    .ps-main{flex:1 1 0;min-width:0;max-width:none;order:2}
    .ps-name{white-space:normal;font-size:15px;line-height:1.25}
    .ps-sub{white-space:normal}
    .ps-actions{order:3;flex:none}
    .ps-right{order:4;flex:1 1 100%;max-width:none;align-items:flex-start;text-align:left;
      margin-left:0;padding-top:10px;border-top:1px solid var(--border-soft,#eef1f5);gap:3px}
    .ps-empn,.ps-empmeta{max-width:none;white-space:normal}
    .ps-tags{justify-content:flex-start}
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

function hasCriteria() {
  return C.q.trim().length >= 2 || C.type || C.company || C.photo || C.gender || C.ageMin !== '' || C.ageMax !== ''
    || C.zone || C.subzone || C.concept || C.status;
}

// Subzonas que pertenecen a la zona elegida (los id de subzona empiezan por
// el id de la zona). Si no hay zona, devuelve todas.
function subzonesFor(zoneId) {
  const all = (FACETS && FACETS.subzones) || [];
  if (!zoneId) return all;
  return all.filter(s => String(s.id).startsWith(zoneId + '_'));
}
// Empresas del combo, filtradas por el tipo elegido (si hay).
function companiesFor(type) {
  const all = (FACETS && FACETS.companies) || [];
  if (!type) return all;
  return all.filter(c => c.type === type);
}
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

export async function renderPersonnelSearch(user) {
  USER = user;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="ps-head"><div><h1>Buscar personal</h1>
      <p>Busca por <b>cédula</b>, <b>nombre</b> o <b>cargo</b>, y refina con los filtros. Pulsa <b>Buscar</b> (o Enter).</p></div></div>
    <div class="ps-searchrow">
      <div class="ps-search">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="psInput" placeholder="Cédula, nombre o cargo…" value="${esc(C.q)}" autocomplete="off">
      </div>
      <button class="ps-go" id="psGo">Buscar</button>
    </div>
    <div class="ps-filters">
      <span class="fg">Tipo <select id="psType"><option value="">Todos</option></select></span>
      <span class="fg">Empresa <select id="psCompany"><option value="">Todas</option></select></span>
      <span class="fg">Foto <select id="psPhoto"><option value="">Todas</option><option value="with">Con foto</option><option value="without">Sin foto</option></select></span>
      <span class="fg">Sexo
        <select id="psGender">
          <option value="">Todos</option>
          <option value="M">Masculino</option>
          <option value="F">Femenino</option>
        </select>
      </span>
      <span class="fg">Edad
        <input id="psAgeMin" class="age" type="number" min="0" max="120" inputmode="numeric" placeholder="mín" value="${esc(C.ageMin)}">
        <span>–</span>
        <input id="psAgeMax" class="age" type="number" min="0" max="120" inputmode="numeric" placeholder="máx" value="${esc(C.ageMax)}">
      </span>
      <span class="fg">Zona <select id="psZone"><option value="">Todas</option></select></span>
      <span class="fg">Subzona <select id="psSubzone"><option value="">Todas</option></select></span>
      <span class="fg">Concepto <select id="psConcept"><option value="">Todos</option></select></span>
      <span class="fg">Estado <select id="psStatus"><option value="">Todos</option></select></span>
      <button class="ps-clear" id="psClear">Limpiar</button>
      <div class="ps-export-wrap">
        <button class="ps-export-btn" id="psExportBtn" type="button">Exportar ▾</button>
        <div class="ps-export-menu" id="psExportMenu" hidden>
          <button data-fmt="xlsx">Excel (.xlsx)</button>
          <button data-fmt="csv">CSV (.csv)</button>
          <button data-fmt="txt">Texto (.txt)</button>
        </div>
      </div>
    </div>
    <div class="ps-count" id="psCount"></div>
    <div class="ps-filterbar" id="psFilterBar" hidden>
      <div class="fb">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="psFilter" type="text" placeholder="Filtrar resultados por nombre, cédula, cargo o depto. (separa con coma)…" autocomplete="off">
      </div>
    </div>
    <div class="ps-list" id="psList"></div>
    <div class="ps-pager" id="psPager" hidden></div>`;

  // Restaurar valores simples.
  $('#psGender').value = C.gender;
  { const ph = $('#psPhoto'); if (ph) ph.value = (C.photo === 'with' || C.photo === 'without') ? C.photo : ''; }

  // Cargar facetas (una sola vez) y poblar combos.
  if (!FACETS) {
    const r = await api({ action: 'facets', adminId: USER.id });
    FACETS = (r && r.ok && r.facets) ? r.facets : { zones: [], subzones: [], concepts: [], statuses: [], types: [], companies: [] };
    SCOPE = (r && r.ok && r.totals) ? r.totals : { total: 0, active: 0 };
  }
  // Tipo de empresa.
  const tSel = $('#psType');
  if (tSel) {
    tSel.innerHTML = '<option value="">Todos</option>'
      + (FACETS.types || []).map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    tSel.value = (FACETS.types || []).includes(C.type) ? C.type : '';
  }
  // Empresa (filtrada por tipo).
  fillCompanySelect($('#psCompany'), companiesFor(C.type), C.company);
  fillSelect($('#psZone'), FACETS.zones || [], C.zone, 'Todas');
  fillSelect($('#psSubzone'), subzonesFor(C.zone), C.subzone, 'Todas');
  fillSelect($('#psConcept'), FACETS.concepts || [], C.concept, 'Todos');
  const stSel = $('#psStatus');
  if (stSel) {
    stSel.innerHTML = '<option value="">Todos</option>'
      + (FACETS.statuses || []).map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    stSel.value = (FACETS.statuses || []).includes(C.status) ? C.status : '';
  }

  // Eventos.
  const input = $('#psInput');
  input.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
  $('#psGo').addEventListener('click', runSearch);
  // Tipo repuebla empresa (solo UI, no busca).
  $('#psType').addEventListener('change', () => {
    C.type = $('#psType').value; C.company = '';
    fillCompanySelect($('#psCompany'), companiesFor(C.type), '');
  });
  $('#psCompany').addEventListener('change', () => { C.company = $('#psCompany').value; });
  { const ph = $('#psPhoto'); if (ph) ph.addEventListener('change', () => { C.photo = ph.value; }); }
  // Cambiar zona repuebla subzona (solo UI, no busca).
  $('#psZone').addEventListener('change', () => {
    C.zone = $('#psZone').value;
    C.subzone = '';
    fillSelect($('#psSubzone'), subzonesFor(C.zone), '', 'Todas');
  });
  $('#psClear').addEventListener('click', () => {
    C = { q: '', type: '', company: '', photo: '', gender: '', ageMin: '', ageMax: '', zone: '', subzone: '', concept: '', status: '' };
    FQ = '';
    SEARCH_ROWS = null;
    renderPersonnelSearch(USER);
  });

  // Export.
  const exBtn = $('#psExportBtn'), exMenu = $('#psExportMenu');
  exBtn.addEventListener('click', (e) => { e.stopPropagation(); exMenu.hidden = !exMenu.hidden; });
  exMenu.addEventListener('click', (e) => e.stopPropagation());
  exMenu.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { exMenu.hidden = true; doExport(b.dataset.fmt); }));
  document.addEventListener('click', () => { const em = $('#psExportMenu'); if (em) em.hidden = true; });

  // Filtro en cliente por coma (refina los resultados ya traidos, no busca).
  const filterEl = $('#psFilter');
  if (filterEl) {
    filterEl.value = FQ || '';
    filterEl.addEventListener('input', () => { FQ = filterEl.value; PAGE = 1; paint(); });
  }

  // Restaurar resultados previos (al volver de una ficha) o pintar estado inicial.
  paint();
  input.focus();
  const v = input.value; input.value = ''; input.value = v;
}

// Lee los criterios desde los inputs al estado C.
function gather() {
  C.q = $('#psInput').value;
  C.type = $('#psType').value;
  C.company = $('#psCompany').value;
  { const ph = $('#psPhoto'); C.photo = ph ? ph.value : ''; }
  C.gender = $('#psGender').value;
  C.ageMin = $('#psAgeMin').value.trim();
  C.ageMax = $('#psAgeMax').value.trim();
  C.zone = $('#psZone').value;
  C.subzone = $('#psSubzone').value;
  C.concept = $('#psConcept').value;
  C.status = $('#psStatus').value;
}

async function runSearch() {
  gather();
  if (!hasCriteria()) {
    SEARCH_ROWS = null;
    paint();
    return;
  }
  const countEl = $('#psCount');
  if (countEl) countEl.textContent = 'Buscando…';
  const r = await api({
    action: 'search', adminId: USER.id,
    q: C.q, type: C.type || null, company: C.company || null,
    gender: C.gender || null,
    age_min: C.ageMin === '' ? null : C.ageMin,
    age_max: C.ageMax === '' ? null : C.ageMax,
    zone: C.zone || null, subzone: C.subzone || null,
    concept: C.concept || null, status: C.status || null,
    photo: C.photo || null,
  });
  SEARCH_ROWS = (r && r.ok) ? (r.rows || []) : [];
  FQ = '';
  PAGE = 1;
  paint();
}

function paint() {
  const list = $('#psList');
  const countEl = $('#psCount');
  const pager = $('#psPager');
  const filterBar = $('#psFilterBar');
  if (!list) return;

  if (SEARCH_ROWS === null) {
    if (countEl) countEl.textContent = '';
    if (pager) pager.hidden = true;
    if (filterBar) filterBar.hidden = true;
    list.innerHTML = `<div class="ps-hint">Escribe al menos 2 caracteres o elige un filtro, y pulsa <b>Buscar</b>.</div>`;
    return;
  }
  if (!SEARCH_ROWS.length) {
    if (countEl) countEl.textContent = '';
    if (pager) pager.hidden = true;
    if (filterBar) filterBar.hidden = true;
    list.innerHTML = `<div class="ps-empty">Sin coincidencias con esos criterios.</div>`;
    return;
  }

  // Hay resultados: mostrar el filtro por coma y aplicarlo en cliente.
  if (filterBar) filterBar.hidden = false;
  const groups = parseSearchGroups(FQ || '');
  const shown = groups.length ? SEARCH_ROWS.filter(w => matchesSearch(w, groups)) : SEARCH_ROWS;

  const totalAll = SEARCH_ROWS.length;
  const total = shown.length;
  if (countEl) {
    const capNote = totalAll === 5000 ? ' (máx.; refina para acotar)' : '';
    // Denominador fijo = todo el personal del alcance (SCOPE.total). El % es
    // cuantos resultados dio la busqueda sobre ese universo.
    const uni = SCOPE.total || 0;
    const pct = uni > 0 ? Math.round((totalAll / uni) * 100) : null;
    const scopeNote = uni > 0 ? ` de ${uni} en tu alcance${pct != null ? ` · ${pct}%` : ''}` : '';
    if (groups.length) {
      // Con filtro por coma: subconjunto filtrado, y aparte el total de la
      // busqueda con su % sobre el alcance.
      countEl.textContent = `${total} de ${totalAll} filtrados · ${totalAll}${scopeNote}${capNote}`;
    } else {
      countEl.textContent = `${totalAll} resultado${totalAll === 1 ? '' : 's'}${scopeNote}${capNote}`;
    }
  }

  if (!total) {
    if (pager) pager.hidden = true;
    list.innerHTML = `<div class="ps-empty">Ninguno coincide con el filtro.</div>`;
    return;
  }

  // Paginacion en cliente sobre el conjunto filtrado.
  const pages = Math.max(1, Math.ceil(total / PER));
  if (PAGE > pages) PAGE = pages;
  const start = (PAGE - 1) * PER;
  const pageRows = shown.slice(start, start + PER);

  list.innerHTML = pageRows.map((w, i) => {
    const egr = w.end_date || w.is_active === false;
    const estado = egr
      ? '<span class="ps-pill ps-egr">egresado</span>'
      : '<span class="ps-pill ps-act">activo</span>';
    const tipo = NON_STORE_TYPES.has(w.company_type) ? (w.company_type || 'Empresa') : 'Tienda';
    const cst = w.company_status ? `<span class="ps-pill ps-cst">${esc(w.company_status)}</span>` : '';
    // Sub-linea trabajador: C.I. · cargo · sexo · edad.
    const subParts = [`C.I. ${esc(w.id_number)}`];
    if (w.role) subParts.push(esc(w.role));
    if (w.gender === 'M' || w.gender === 'F') subParts.push(w.gender);
    if (w.age != null) subParts.push(`${w.age} años`);
    // Empresa: zona · subzona · concepto (solo lo que exista).
    const empMeta = [w.zona, w.subzona, w.concepto].filter(Boolean).map(esc).join(' · ');
    const hasPhoto = !!w.thumb_url;
    const acts = `<div class="ps-actions">
        <button type="button" class="ps-iconbtn" data-photo="${start + i}" title="${hasPhoto ? 'Ver foto' : 'Sin foto'}" ${hasPhoto ? '' : 'disabled'}>${icoPhoto()}</button>
        <button type="button" class="ps-iconbtn" data-ficha="${start + i}" title="Ver ficha">${icoFicha()}</button>
      </div>`;
    return `<div class="ps-row">
      ${avatarCell(w)}
      <div class="ps-main">
        <div class="ps-name">${esc(w.full_name)}</div>
        <div class="ps-sub">${subParts.join(' · ')}</div>
      </div>
      ${acts}
      <div class="ps-right">
        <span class="ps-emp">${esc(w.company_code)}${w.data_area ? ` · <span class="da">${esc(w.data_area)}</span>` : ''}</span>
        <span class="ps-empn">${esc(w.company_name || '')}</span>
        ${empMeta ? `<span class="ps-empmeta">${empMeta}</span>` : ''}
        <div class="ps-tags">${estado}<span class="ps-pill ps-type">${esc(tipo)}</span>${cst}</div>
      </div>
    </div>`;
  }).join('');

  // Acciones por fila: foto abre el visor grande (miniatura publica); ficha
  // abre el detalle del trabajador. La fila ya NO abre nada por si sola.
  list.querySelectorAll('[data-ficha]').forEach(b =>
    b.addEventListener('click', () => openWorker(shown[+b.dataset.ficha])));
  list.querySelectorAll('[data-photo]').forEach(b =>
    b.addEventListener('click', () => {
      const w = shown[+b.dataset.photo];
      if (!w || !w.thumb_url) return;
      openWorkerLightbox(w.thumb_url, `${w.full_name} · C.I. ${w.id_number}`, `${w.id_number}.jpg`);
    }));

  paintPager(pager, total, pages, start, pageRows.length);
}

// Paginador (selector 25/50/100 + navegacion).
function paintPager(pager, total, pages, start, shownCount) {
  if (!pager) return;
  pager.hidden = false;
  const from = total === 0 ? 0 : start + 1;
  const to = start + shownCount;
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
      <select id="psPer">
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

  const perSel = pager.querySelector('#psPer');
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

function openWorker(w) {
  if (!w) return;
  const mode = NON_STORE_TYPES.has(w.company_type) ? 'enterprise' : 'store';
  renderWorkerPhotos(USER, w.company_code, () => renderPersonnelSearch(USER), { mode, openCed: w.id_number });
}

/* -------- Exportacion (xlsx / csv / txt). Si hay filtro por coma activo,
   exporta lo filtrado; si no, TODOS los resultados de la busqueda. -------- */
const MARITAL_LABEL = { S: 'Soltero(a)', C: 'Casado(a)', D: 'Divorciado(a)', V: 'Viudo(a)' };
function exportRows() {
  const groups = parseSearchGroups(FQ || '');
  const src = groups.length ? (SEARCH_ROWS || []).filter(w => matchesSearch(w, groups)) : (SEARCH_ROWS || []);
  return src.map(w => ({
    'Cédula': w.id_number || '',
    'Nombre': w.full_name || '',
    'Cargo': w.role || '',
    'Sexo': w.gender || '',
    'Edad': w.age != null ? w.age : '',
    'Estado civil': MARITAL_LABEL[w.marital_status] || w.marital_status || '',
    'Teléfono': w.phone || '',
    'Correo': w.email || '',
    'Cuenta banco': w.account_number || '',
    'Dirección': w.address || '',
    'Departamento': w.department_name || '',
    'Estado': (w.end_date || w.is_active === false) ? 'Egresado' : 'Activo',
    'Empresa (alias)': w.company_code || '',
    'DataArea': w.data_area || '',
    'Empresa': w.company_name || '',
    'Tipo': w.company_type || '',
    'Zona': w.zona || '',
    'Subzona': w.subzona || '',
    'Concepto': w.concepto || '',
    'Estado empresa': w.company_status || '',
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
  if (!data.length) { alert('No hay resultados para exportar. Haz una búsqueda primero.'); return; }
  const headers = Object.keys(data[0]);
  const fname = `buscar_personal_${tstamp()}`;

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
      window.XLSX.utils.book_append_sheet(wb, ws, 'Buscar personal');
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (e) {
      alert(e.message + ' Revisa tu conexión e inténtalo de nuevo.');
    }
    return;
  }
}
