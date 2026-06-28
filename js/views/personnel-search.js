/* =====================================================================
   js/views/personnel-search.js  →  vista "Buscar personal"
   Busqueda global de personal por cedula o nombre en todas las empresas
   del alcance del admin. Al hacer clic en un resultado se abre la FICHA
   del trabajador reusando la vista Personal (renderWorkerPhotos) con la
   ficha ya abierta (opts.openCed).

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
let SEARCH_Q = '';        // se conserva al volver de una ficha
let SEARCH_ROWS = null;   // null = aun no se ha buscado
let timer = null;

function ensureStyles() {
  if (document.getElementById('psStyles')) return;
  const st = document.createElement('style');
  st.id = 'psStyles';
  st.textContent = `
  .ps-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .ps-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .ps-search{position:relative;margin:16px 0 6px;max-width:560px}
  .ps-search svg{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:var(--muted)}
  .ps-search input{width:100%;font:inherit;font-size:15px;padding:12px 14px 12px 40px;border:1px solid var(--border);border-radius:11px;background:var(--surface);color:var(--ink);box-sizing:border-box}
  .ps-search input:focus{outline:none;border-color:var(--brand,#2563eb);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
  .ps-count{color:var(--muted);font-size:12px;margin:6px 2px 10px}
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

async function doSearch(q) {
  const r = await fetch('/api/personnel-search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'search', adminId: USER.id, q }),
  }).then(x => x.json()).catch(() => null);
  return (r && r.ok) ? r : { ok: false, rows: [] };
}

export function renderPersonnelSearch(user) {
  USER = user;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="ps-head"><div><h1>Buscar personal</h1>
      <p>Busca a cualquier colaborador por <b>cédula</b> o <b>nombre</b> en todas tus empresas. Toca un resultado para abrir su ficha.</p></div></div>
    <div class="ps-search">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <input id="psInput" placeholder="Cédula o nombre…" value="${esc(SEARCH_Q)}" autocomplete="off">
    </div>
    <div class="ps-count" id="psCount"></div>
    <div class="ps-list" id="psList"></div>`;

  const input = $('#psInput');
  input.addEventListener('input', () => {
    SEARCH_Q = input.value;
    clearTimeout(timer);
    const q = SEARCH_Q.trim();
    if (q.length < 2) {
      SEARCH_ROWS = null;
      paint();
      return;
    }
    $('#psCount').textContent = 'Buscando…';
    timer = setTimeout(runSearch, 280);
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(timer); runSearch(); } });

  // Restaurar resultados previos (al volver de una ficha) o pintar el estado inicial.
  paint();
  input.focus();
  // Coloca el cursor al final del texto restaurado.
  const v = input.value; input.value = ''; input.value = v;
}

async function runSearch() {
  const q = (SEARCH_Q || '').trim();
  if (q.length < 2) { SEARCH_ROWS = null; paint(); return; }
  const countEl = $('#psCount');
  if (countEl) countEl.textContent = 'Buscando…';
  const r = await doSearch(q);
  // Evitar pisar resultados si el texto cambio mientras llegaba la respuesta.
  if ((SEARCH_Q || '').trim() !== q) return;
  SEARCH_ROWS = r.rows || [];
  paint();
}

function paint() {
  const list = $('#psList');
  const countEl = $('#psCount');
  if (!list) return;

  if (SEARCH_ROWS === null) {
    if (countEl) countEl.textContent = '';
    list.innerHTML = `<div class="ps-hint">Escribe al menos 2 caracteres para buscar.</div>`;
    return;
  }
  if (!SEARCH_ROWS.length) {
    if (countEl) countEl.textContent = '';
    list.innerHTML = `<div class="ps-empty">Sin coincidencias para “${esc(SEARCH_Q.trim())}”.</div>`;
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
    return `<div class="ps-row" data-i="${i}">
      <div class="ps-ava" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(w.full_name))}</div>
      <div class="ps-main">
        <div class="ps-name">${esc(w.full_name)}</div>
        <div class="ps-sub">C.I. ${esc(w.id_number)}${w.role ? ' · ' + esc(w.role) : ''}</div>
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
  // Abre la vista Personal de esa empresa con la ficha del trabajador ya
  // desplegada; "Volver" regresa a esta busqueda con el texto y resultados.
  renderWorkerPhotos(USER, w.company_code, () => renderPersonnelSearch(USER), { mode, openCed: w.id_number });
}
