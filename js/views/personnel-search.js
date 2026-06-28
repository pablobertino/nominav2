/* =====================================================================
   js/views/personnel-search.js  →  vista "Buscar personal"
   Busqueda global de personal por cedula, nombre o CARGO en todas las
   empresas del alcance del admin, con filtros opcionales de SEXO y RANGO
   DE EDAD. Al hacer clic en un resultado se abre la FICHA del trabajador
   reusando la vista Personal (renderWorkerPhotos con opts.openCed); al
   volver de la ficha se regresa a ESTA busqueda (texto + filtros + resultados).

   Datos por /api/personnel-search (action 'search').
   Export: renderPersonnelSearch(user)
   ===================================================================== */

import { $ } from '../core/dom.js';
import { renderWorkerPhotos } from './worker-photos.js';

// Tipos de empresa que NO son tienda -> la ficha se abre en modo 'enterprise'.
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
// Estado que se conserva al volver de una ficha.
let SEARCH_Q = '';
let SEARCH_GENDER = '';     // '' | 'M' | 'F'
let SEARCH_AGE_MIN = '';
let SEARCH_AGE_MAX = '';
let SEARCH_ROWS = null;     // null = aun no se ha buscado
let timer = null;

function ensureStyles() {
  if (document.getElementById('psStyles')) return;
  const st = document.createElement('style');
  st.id = 'psStyles';
  st.textContent = `
  .ps-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .ps-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .ps-search{position:relative;margin:16px 0 8px;max-width:560px}
  .ps-search svg{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:var(--muted)}
  .ps-search input{width:100%;font:inherit;font-size:15px;padding:12px 14px 12px 40px;border:1px solid var(--border);border-radius:11px;background:var(--surface);color:var(--ink);box-sizing:border-box}
  .ps-search input:focus{outline:none;border-color:var(--brand,#2563eb);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
  .ps-filters{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 6px}
  .ps-filters .fg{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted)}
  .ps-filters select,.ps-filters input{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink)}
  .ps-filters input.age{width:62px}
  .ps-clear{font:inherit;font-size:12.5px;padding:7px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);cursor:pointer}
  .ps-clear:hover{background:var(--bg-soft,#f1f5f9)}
  .ps-count{color:var(--muted);font-size:12px;margin:4px 2px 10px}
  .ps-list{display:flex;flex-direction:column;gap:8px}
  .ps-row{display:flex;align-items:center;gap:13px;padding:11px 13px;border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);cursor:pointer;transition:border-color .12s,box-shadow .12s}
  .ps-row:hover{border-color:var(--brand,#2563eb);box-shadow:0 2px 10px rgba(15,23,42,.06)}
  .ps-ava{width:42px;height:42px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px}
  .ps-main{flex:1;min-width:0}
  .ps-name{font-weight:600;color:var(--ink);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps-sub{color:var(--muted);font-size:12px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps-right{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none;text-align:right}
  .ps-emp{font-size:12px;color:var(--ink);font-weight:600}
  .ps-empn{font-size:11px;color:var(--muted);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps-tags{display:flex;gap:5px;margin-top:2px}
  .ps-pill{display:inline-block;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap}
  .ps-act{background:#dcfce7;color:#166534}
  .ps-egr{background:#fee2e2;color:#991b1b}
  .ps-type{background:#eef2ff;color:#3730a3}
  .ps-empty,.ps-hint{padding:34px 14px;text-align:center;color:var(--muted)}
  `;
  document.head.appendChild(st);
}

function hasFilters() {
  return SEARCH_GENDER !== '' || String(SEARCH_AGE_MIN) !== '' || String(SEARCH_AGE_MAX) !== '';
}

async function doSearch() {
  const r = await fetch('/api/personnel-search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'search', adminId: USER.id,
      q: SEARCH_Q, gender: SEARCH_GENDER || null,
      age_min: SEARCH_AGE_MIN === '' ? null : SEARCH_AGE_MIN,
      age_max: SEARCH_AGE_MAX === '' ? null : SEARCH_AGE_MAX,
    }),
  }).then(x => x.json()).catch(() => null);
  return (r && r.ok) ? r : { ok: false, rows: [] };
}

export function renderPersonnelSearch(user) {
  USER = user;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="ps-head"><div><h1>Buscar personal</h1>
      <p>Busca por <b>cédula</b>, <b>nombre</b> o <b>cargo</b> en todas tus empresas. Refina por sexo y edad. Toca un resultado para abrir su ficha.</p></div></div>
    <div class="ps-search">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <input id="psInput" placeholder="Cédula, nombre o cargo…" value="${esc(SEARCH_Q)}" autocomplete="off">
    </div>
    <div class="ps-filters">
      <span class="fg">Sexo
        <select id="psGender">
          <option value="">Todos</option>
          <option value="M" ${SEARCH_GENDER === 'M' ? 'selected' : ''}>Masculino</option>
          <option value="F" ${SEARCH_GENDER === 'F' ? 'selected' : ''}>Femenino</option>
        </select>
      </span>
      <span class="fg">Edad
        <input id="psAgeMin" class="age" type="number" min="0" max="120" inputmode="numeric" placeholder="mín" value="${esc(SEARCH_AGE_MIN)}">
        <span>–</span>
        <input id="psAgeMax" class="age" type="number" min="0" max="120" inputmode="numeric" placeholder="máx" value="${esc(SEARCH_AGE_MAX)}">
      </span>
      <button class="ps-clear" id="psClear">Limpiar filtros</button>
    </div>
    <div class="ps-count" id="psCount"></div>
    <div class="ps-list" id="psList"></div>`;

  const input = $('#psInput');
  input.addEventListener('input', () => {
    SEARCH_Q = input.value;
    clearTimeout(timer);
    if (SEARCH_Q.trim().length < 2) { SEARCH_ROWS = null; paint(); return; }
    $('#psCount').textContent = 'Buscando…';
    timer = setTimeout(runSearch, 280);
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(timer); runSearch(); } });

  // Cambios de filtro: re-buscan de inmediato (si hay texto suficiente).
  const onFilter = () => {
    SEARCH_GENDER = $('#psGender').value;
    SEARCH_AGE_MIN = $('#psAgeMin').value.trim();
    SEARCH_AGE_MAX = $('#psAgeMax').value.trim();
    clearTimeout(timer);
    if (SEARCH_Q.trim().length >= 2) runSearch();
  };
  $('#psGender').addEventListener('change', onFilter);
  $('#psAgeMin').addEventListener('input', onFilter);
  $('#psAgeMax').addEventListener('input', onFilter);
  $('#psClear').addEventListener('click', () => {
    SEARCH_GENDER = ''; SEARCH_AGE_MIN = ''; SEARCH_AGE_MAX = '';
    $('#psGender').value = ''; $('#psAgeMin').value = ''; $('#psAgeMax').value = '';
    clearTimeout(timer);
    if (SEARCH_Q.trim().length >= 2) runSearch(); else { SEARCH_ROWS = null; paint(); }
  });

  // Restaurar resultados previos (al volver de una ficha) o pintar estado inicial.
  paint();
  input.focus();
  const v = input.value; input.value = ''; input.value = v; // cursor al final
}

async function runSearch() {
  const q = (SEARCH_Q || '').trim();
  if (q.length < 2) { SEARCH_ROWS = null; paint(); return; }
  const countEl = $('#psCount');
  if (countEl) countEl.textContent = 'Buscando…';
  // Marca para evitar pisar resultados si cambia el criterio mientras llega la respuesta.
  const stamp = JSON.stringify([q, SEARCH_GENDER, SEARCH_AGE_MIN, SEARCH_AGE_MAX]);
  runSearch._stamp = stamp;
  const r = await doSearch();
  if (runSearch._stamp !== stamp) return;
  SEARCH_ROWS = r.rows || [];
  paint();
}

function paint() {
  const list = $('#psList');
  const countEl = $('#psCount');
  if (!list) return;

  if (SEARCH_ROWS === null) {
    if (countEl) countEl.textContent = '';
    list.innerHTML = `<div class="ps-hint">Escribe al menos 2 caracteres para buscar.${hasFilters() ? ' Los filtros de sexo/edad se aplican sobre la búsqueda.' : ''}</div>`;
    return;
  }
  if (!SEARCH_ROWS.length) {
    if (countEl) countEl.textContent = '';
    list.innerHTML = `<div class="ps-empty">Sin coincidencias para “${esc(SEARCH_Q.trim())}”${hasFilters() ? ' con esos filtros' : ''}.</div>`;
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
    // Sub-linea: C.I. · cargo · sexo · edad (solo lo que exista).
    const subParts = [`C.I. ${esc(w.id_number)}`];
    if (w.role) subParts.push(esc(w.role));
    if (w.gender === 'M' || w.gender === 'F') subParts.push(w.gender);
    if (w.age != null) subParts.push(`${w.age} años`);
    return `<div class="ps-row" data-i="${i}">
      <div class="ps-ava" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(w.full_name))}</div>
      <div class="ps-main">
        <div class="ps-name">${esc(w.full_name)}</div>
        <div class="ps-sub">${subParts.join(' · ')}</div>
      </div>
      <div class="ps-right">
        <span class="ps-emp">${esc(w.company_code)}</span>
        <span class="ps-empn">${esc(w.company_name || '')}</span>
        <div class="ps-tags">${estado}<span class="ps-pill ps-type">${esc(tipo)}</span></div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.ps-row').forEach(el =>
    el.addEventListener('click', () => openWorker(SEARCH_ROWS[+el.dataset.i])));
}

function openWorker(w) {
  if (!w) return;
  const mode = NON_STORE_TYPES.has(w.company_type) ? 'enterprise' : 'store';
  // Abre la vista Personal de esa empresa con la ficha ya desplegada. "Volver"
  // en la ficha regresa a ESTA busqueda (texto + filtros + resultados intactos).
  renderWorkerPhotos(USER, w.company_code, () => renderPersonnelSearch(USER), { mode, openCed: w.id_number });
}
