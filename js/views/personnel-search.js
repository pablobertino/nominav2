/* =====================================================================
   js/views/personnel-search.js  →  vista "Buscar personal"
   Busqueda global de personal por cedula, nombre o CARGO en todas las
   empresas del alcance del admin, con filtros (criterios) de SEXO, RANGO
   DE EDAD, ZONA, SUBZONA, CONCEPTO y ESTADO de empresa.

   La busqueda se ejecuta con el boton "Buscar" (o Enter): los campos son
   CRITERIOS, no filtros en vivo. Cada resultado muestra la empresa donde
   esta contratado (ALIAS, Razon Social y Zona/Subzona/Concepto cuando
   aplican). Al tocar un resultado se abre la FICHA del trabajador reusando
   la vista Personal (renderWorkerPhotos con opts.openCed); al volver se
   regresa a ESTA busqueda con criterios y resultados intactos.

   Datos por /api/personnel-search (action 'search' y 'facets').
   Export: renderPersonnelSearch(user)
   ===================================================================== */

import { $ } from '../core/dom.js';
import { renderWorkerPhotos } from './worker-photos.js';

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

let USER = null;
let FACETS = null;          // { zones, subzones, concepts, statuses } cache
// Criterios (se conservan al volver de una ficha).
let C = { q: '', gender: '', ageMin: '', ageMax: '', zone: '', subzone: '', concept: '', status: '' };
let SEARCH_ROWS = null;     // null = aun no se ha buscado

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
  .ps-count{color:var(--muted);font-size:12px;margin:6px 2px 10px}
  .ps-list{display:flex;flex-direction:column;gap:8px}
  .ps-row{display:flex;align-items:center;gap:13px;padding:11px 13px;border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);cursor:pointer;transition:border-color .12s,box-shadow .12s}
  .ps-row:hover{border-color:var(--brand,#2563eb);box-shadow:0 2px 10px rgba(15,23,42,.06)}
  .ps-ava{width:42px;height:42px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px}
  .ps-main{flex:1;min-width:0}
  .ps-name{font-weight:600;color:var(--ink);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps-sub{color:var(--muted);font-size:12px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps-right{display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex:none;text-align:right;max-width:46%}
  .ps-emp{font-size:12px;color:var(--brand,#2563eb);font-weight:700;font-family:ui-monospace,Menlo,monospace}
  .ps-empn{font-size:12px;color:var(--ink);font-weight:600;max-width:230px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps-empmeta{font-size:11px;color:var(--muted);max-width:230px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps-tags{display:flex;gap:5px;margin-top:3px;flex-wrap:wrap;justify-content:flex-end}
  .ps-pill{display:inline-block;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap}
  .ps-act{background:#dcfce7;color:#166534}
  .ps-egr{background:#fee2e2;color:#991b1b}
  .ps-type{background:#eef2ff;color:#3730a3}
  .ps-cst{background:#f1f5f9;color:#475569}
  .ps-empty,.ps-hint{padding:34px 14px;text-align:center;color:var(--muted)}
  @media (max-width:640px){ .ps-right{max-width:50%} .ps-empn,.ps-empmeta{max-width:150px} }
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
  return C.q.trim().length >= 2 || C.gender || C.ageMin !== '' || C.ageMax !== ''
    || C.zone || C.subzone || C.concept || C.status;
}

// Subzonas que pertenecen a la zona elegida (los id de subzona empiezan por
// el id de la zona). Si no hay zona, devuelve todas.
function subzonesFor(zoneId) {
  const all = (FACETS && FACETS.subzones) || [];
  if (!zoneId) return all;
  return all.filter(s => String(s.id).startsWith(zoneId + '_'));
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
    </div>
    <div class="ps-count" id="psCount"></div>
    <div class="ps-list" id="psList"></div>`;

  // Restaurar valores simples.
  $('#psGender').value = C.gender;

  // Cargar facetas (una sola vez) y poblar combos.
  if (!FACETS) {
    const r = await api({ action: 'facets', adminId: USER.id });
    FACETS = (r && r.ok && r.facets) ? r.facets : { zones: [], subzones: [], concepts: [], statuses: [] };
  }
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
  // Cambiar zona repuebla subzona (solo UI, no busca).
  $('#psZone').addEventListener('change', () => {
    C.zone = $('#psZone').value;
    C.subzone = '';
    fillSelect($('#psSubzone'), subzonesFor(C.zone), '', 'Todas');
  });
  $('#psClear').addEventListener('click', () => {
    C = { q: '', gender: '', ageMin: '', ageMax: '', zone: '', subzone: '', concept: '', status: '' };
    SEARCH_ROWS = null;
    renderPersonnelSearch(USER);
  });

  // Restaurar resultados previos (al volver de una ficha) o pintar estado inicial.
  paint();
  input.focus();
  const v = input.value; input.value = ''; input.value = v;
}

// Lee los criterios desde los inputs al estado C.
function gather() {
  C.q = $('#psInput').value;
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
    q: C.q, gender: C.gender || null,
    age_min: C.ageMin === '' ? null : C.ageMin,
    age_max: C.ageMax === '' ? null : C.ageMax,
    zone: C.zone || null, subzone: C.subzone || null,
    concept: C.concept || null, status: C.status || null,
  });
  SEARCH_ROWS = (r && r.ok) ? (r.rows || []) : [];
  paint();
}

function paint() {
  const list = $('#psList');
  const countEl = $('#psCount');
  if (!list) return;

  if (SEARCH_ROWS === null) {
    if (countEl) countEl.textContent = '';
    list.innerHTML = `<div class="ps-hint">Escribe al menos 2 caracteres o elige un filtro, y pulsa <b>Buscar</b>.</div>`;
    return;
  }
  if (!SEARCH_ROWS.length) {
    if (countEl) countEl.textContent = '';
    list.innerHTML = `<div class="ps-empty">Sin coincidencias con esos criterios.</div>`;
    return;
  }
  if (countEl) countEl.textContent = `${SEARCH_ROWS.length} resultado${SEARCH_ROWS.length === 1 ? '' : 's'}${SEARCH_ROWS.length === 80 ? ' (máx.)' : ''}`;

  list.innerHTML = SEARCH_ROWS.map((w, i) => {
    const ci = avatarColor(w.id_number);
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
    return `<div class="ps-row" data-i="${i}">
      <div class="ps-ava" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(w.full_name))}</div>
      <div class="ps-main">
        <div class="ps-name">${esc(w.full_name)}</div>
        <div class="ps-sub">${subParts.join(' · ')}</div>
      </div>
      <div class="ps-right">
        <span class="ps-emp">${esc(w.company_code)}</span>
        <span class="ps-empn">${esc(w.company_name || '')}</span>
        ${empMeta ? `<span class="ps-empmeta">${empMeta}</span>` : ''}
        <div class="ps-tags">${estado}<span class="ps-pill ps-type">${esc(tipo)}</span>${cst}</div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.ps-row').forEach(el =>
    el.addEventListener('click', () => openWorker(SEARCH_ROWS[+el.dataset.i])));
}

function openWorker(w) {
  if (!w) return;
  const mode = NON_STORE_TYPES.has(w.company_type) ? 'enterprise' : 'store';
  renderWorkerPhotos(USER, w.company_code, () => renderPersonnelSearch(USER), { mode, openCed: w.id_number });
}
