/* =====================================================================
   js/views/personnel-docs.js  →  vista "Documentos"
   Biblioteca global de documentos del personal (modelos de cartas,
   planillas, formatos). Admin/superadmin suben, editan, versionan y
   archivan; las empresas solo ven y descargan.

   El archivo se lee en el navegador y viaja en base64 a /api/personnel-docs.
   Exporta renderPersonnelDocs(user, onExit?) que pinta dentro de #pnlMain.

   v1.87:
   - Lista AGRUPADA por categoria (secciones colapsables, orden alfabetico).
   - Descripcion con editor enriquecido (HTML); el backend la sanitiza.
   - Modal de subida a 2 columnas (datos | descripcion grande).
   - Nueva version: confirmacion del salto vX -> vX+1 con checkbox.
   - Pantalla de gestion de categorias (solo superadmin): crear/renombrar/
     color/activar-desactivar. Color autoasignado al crear, editable.
   ===================================================================== */

import { $ } from '../core/dom.js';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx';
const MIME_OK = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];
const NO_CAT = '__none__';   // clave del grupo "Sin categoria"

/* ---------- API ---------- */
async function api(payload) {
  const res = await fetch('/api/personnel-docs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}
function sessionUser(user) {
  return { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null };
}

/* ---------- helpers ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}
function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  const c = new Date(d.getTime() - 4 * 3600 * 1000);
  const z = n => String(n).padStart(2, '0');
  return `${z(c.getUTCDate())}/${z(c.getUTCMonth() + 1)}/${c.getUTCFullYear()} ${z(c.getUTCHours())}:${z(c.getUTCMinutes())}`;
}
function extKind(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'pdf') return 'pdf';
  if (e === 'xls' || e === 'xlsx') return 'xls';
  return 'word';
}
const FILE_ICON = {
  word: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13l1.5 5 1.5-4 1.5 4 1.5-5"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h1.5a1.5 1.5 0 0 0 0-3H9v6"/></svg>',
  xls: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13l6 6M15 13l-6 6"/></svg>',
};
const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

/* Etiquetas HTML permitidas en la descripcion (espejo del sanitizador del
   backend). Se usan para limpiar el HTML del editor en el cliente antes de
   renderizarlo, como segunda barrera (el backend ya devuelve limpio). */
const DESC_ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'BR', 'P', 'A']);
function cleanDescHtml(html) {
  const tpl = document.createElement('div');
  tpl.innerHTML = String(html || '');
  const walk = (node) => {
    [...node.childNodes].forEach(ch => {
      if (ch.nodeType === 1) {
        if (!DESC_ALLOWED.has(ch.tagName)) {
          // sustituye el elemento no permitido por su texto
          ch.replaceWith(document.createTextNode(ch.textContent || ''));
          return;
        }
        // limpia atributos salvo href seguro en <a>
        [...ch.attributes].forEach(at => {
          if (ch.tagName === 'A' && at.name === 'href' && /^https?:\/\//i.test(at.value)) return;
          ch.removeAttribute(at.name);
        });
        if (ch.tagName === 'A') { ch.setAttribute('target', '_blank'); ch.setAttribute('rel', 'noopener noreferrer'); }
        walk(ch);
      }
    });
  };
  walk(tpl);
  return tpl.innerHTML;
}
/* Convierte HTML de descripcion a texto plano (para el buscador). */
function descText(html) {
  const t = document.createElement('div');
  t.innerHTML = String(html || '');
  return (t.textContent || '').toLowerCase();
}

/* Lee un File a base64 (sin el prefijo data:). Rechaza con un Error legible
   (no con el ProgressEvent crudo) para poder mostrar un mensaje claro. */
function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error((fr.error && fr.error.message) || 'No se pudo leer el archivo.'));
    fr.onabort = () => reject(new Error('La lectura del archivo se canceló.'));
    try {
      fr.readAsDataURL(file);
    } catch (e) {
      reject(new Error('No se pudo abrir el archivo: ' + (e && e.message ? e.message : e)));
    }
  });
}

/* ---------- Editor enriquecido (contenteditable + execCommand) ----------
   Genera la barra + area. Devuelve el HTML del bloque; el cableado de los
   botones se hace con wireRte(scopeEl). Sin onclick inline (CSP). */
const RTE_BTNS = [
  { cmd: 'bold', label: '<b>B</b>', title: 'Negrita' },
  { cmd: 'italic', label: '<i>I</i>', title: 'Cursiva' },
  { cmd: 'underline', label: '<span style="text-decoration:underline">U</span>', title: 'Subrayado' },
  { sep: true },
  { cmd: 'insertUnorderedList', label: '•', title: 'Lista con viñetas' },
  { cmd: 'insertOrderedList', label: '1.', title: 'Lista numerada' },
  { sep: true },
  { cmd: 'createLink', label: '🔗', title: 'Enlace', link: true },
  { cmd: 'removeFormat', label: '⌫', title: 'Quitar formato' },
];
function rteHtml(id, initialHtml, placeholder) {
  const bar = RTE_BTNS.map(b => b.sep
    ? '<span class="rte-sep"></span>'
    : `<button type="button" class="rte-b" data-cmd="${b.cmd}"${b.link ? ' data-link="1"' : ''} title="${esc(b.title)}">${b.label}</button>`).join('');
  return `<div class="rte">
    <div class="rte-bar">${bar}</div>
    <div class="rte-area" id="${id}" contenteditable="true" data-ph="${esc(placeholder || '')}">${initialHtml || ''}</div>
  </div>`;
}
function wireRte(scopeEl) {
  const area = scopeEl.querySelector('.rte-area');
  scopeEl.querySelectorAll('.rte-b').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault()); // no perder el foco/seleccion
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      area.focus();
      if (btn.dataset.link) {
        const url = prompt('Dirección del enlace (https://…):');
        if (url && /^https?:\/\//i.test(url)) document.execCommand('createLink', false, url);
      } else {
        document.execCommand(cmd, false, null);
      }
    });
  });
}
function rteValue(scopeEl) {
  const area = scopeEl.querySelector('.rte-area');
  if (!area) return null;
  return cleanDescHtml(area.innerHTML);
}

/* ===================== ESTADO ===================== */
let STATE = null;   // { user, onExit, canManage, isSuper, docs, cats, q, catFilter, scope, collapsed:Set }

/* ===================== ENTRADA ===================== */
export async function renderPersonnelDocs(user, onExit) {
  const canManage = user.kind === 'admin'; // admin o superadmin
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  STATE = { user, onExit: onExit || null, canManage, isSuper, docs: [], cats: [], q: '', catFilter: '', scope: 'active', collapsed: new Set() };

  const back = onExit ? `<button class="btn" id="pdBack" style="margin-bottom:14px">← Volver</button>` : '';
  const headBtns = [];
  if (isSuper) headBtns.push(`<button class="btn" id="pdCats"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> Categorías</button>`);
  if (canManage) headBtns.push(`<button class="btn btn-primary" id="pdNew"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg> Subir documento</button>`);

  const roBanner = canManage ? '' : `
    <div class="pd-ro">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      Estos son los modelos oficiales. Descarga el que necesites; usa siempre la versión vigente. Solo Capital Humano puede modificarlos.
    </div>`;

  $('#pnlMain').innerHTML = `
    ${back}
    <div class="pnl-head">
      <div><h1>Documentos</h1><p id="pdInfo">Cargando…</p></div>
      <div class="head-actions">${headBtns.join('')}</div>
    </div>
    ${roBanner}
    <div class="pnl-filters">
      <div class="search"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><input id="pdSearch" placeholder="Buscar por título o descripción…"></div>
      <select id="pdCat" class="filt"><option value="">Todas las categorías</option></select>
      ${canManage ? `<select id="pdScope" class="filt"><option value="active">Solo activos</option><option value="all">Incluir archivados</option><option value="archived">Solo archivados</option></select>` : ''}
    </div>
    <div id="pdList" class="pd-groups"><div class="pnl-loading">Cargando…</div></div>
    <div id="pdModalHost"></div>`;

  if (onExit) $('#pdBack').addEventListener('click', onExit);
  if (isSuper) $('#pdCats').addEventListener('click', openCategoriesModal);
  if (canManage) $('#pdNew').addEventListener('click', () => openUploadModal(null));
  $('#pdSearch').addEventListener('input', e => { STATE.q = e.target.value; paintList(); });
  $('#pdCat').addEventListener('change', e => { STATE.catFilter = e.target.value; paintList(); });
  if (canManage) $('#pdScope').addEventListener('change', e => { STATE.scope = e.target.value; load(); });

  await load();
}

async function load() {
  const d = await api({ action: 'list', user: sessionUser(STATE.user), scope: STATE.scope });
  if (!d.ok) {
    $('#pdList').innerHTML = `<div class="card"><p class="muted" style="margin:0">No se pudo cargar: ${esc(d.error || 'error')}</p></div>`;
    $('#pdInfo').textContent = 'Error al cargar';
    return;
  }
  STATE.docs = d.documents || [];
  STATE.cats = (d.categories || []).slice().sort((a, b) => (a.label || '').localeCompare(b.label || '', 'es'));
  // poblar el combo de categorias una vez (alfabetico)
  const sel = $('#pdCat');
  if (sel && sel.options.length <= 1) {
    STATE.cats.forEach(c => { sel.innerHTML += `<option value="${c.id}">${esc(c.label)}</option>`; });
  }
  paintList();
}

/* Agrupa los documentos (ya filtrados) por categoria. Devuelve un array de
   grupos { key, label, color, docs[] } en orden ALFABETICO por label, con
   "Sin categoria" al final. Incluye categorias activas aunque esten vacias. */
function buildGroups(rows) {
  const byKey = {};
  // sembrar las categorias activas (para que las vacias tambien aparezcan)
  STATE.cats.forEach(c => {
    if (c.is_active === false) return;
    byKey[c.id] = { key: String(c.id), label: c.label, color: c.color || '#94a3b8', docs: [] };
  });
  rows.forEach(d => {
    const k = d.category_id ? String(d.category_id) : NO_CAT;
    if (!byKey[k]) {
      byKey[k] = k === NO_CAT
        ? { key: NO_CAT, label: 'Sin categoría', color: '#94a3b8', docs: [] }
        : { key: k, label: d.category || 'Categoría', color: d.category_color || '#94a3b8', docs: [] };
    }
    byKey[k].docs.push(d);
  });
  const groups = Object.values(byKey);
  groups.sort((a, b) => {
    if (a.key === NO_CAT) return 1;
    if (b.key === NO_CAT) return -1;
    return (a.label || '').localeCompare(b.label || '', 'es');
  });
  return groups;
}

function paintList() {
  const list = $('#pdList');
  if (!list) return;
  const q = (STATE.q || '').toLowerCase().trim();
  const cf = STATE.catFilter;
  const rows = STATE.docs.filter(d =>
    (!q || (d.title || '').toLowerCase().includes(q) || descText(d.description).includes(q))
    && (!cf || String(d.category_id) === String(cf)));

  const activos = STATE.docs.filter(d => !d.is_archived).length;
  const arch = STATE.docs.length - activos;
  $('#pdInfo').textContent = STATE.canManage
    ? `${activos} activo${activos === 1 ? '' : 's'}${arch ? ` · ${arch} archivado${arch === 1 ? '' : 's'}` : ''}`
    : `${rows.length} documento${rows.length === 1 ? '' : 's'} disponible${rows.length === 1 ? '' : 's'}`;

  // Si hay filtro de categoria activo, no agrupamos (ya es una sola).
  let groups = buildGroups(rows);
  if (cf) groups = groups.filter(g => g.docs.length);   // con filtro: solo la elegida

  if (!groups.length || rows.length === 0 && !STATE.cats.length) {
    list.innerHTML = '<div class="card"><p class="muted" style="margin:0">Sin documentos.</p></div>';
    return;
  }

  list.innerHTML = groups.map(g => {
    const collapsed = STATE.collapsed.has(g.key) || (g.docs.length === 0);
    const cnt = g.docs.length === 0 ? 'vacío' : `${g.docs.length} documento${g.docs.length === 1 ? '' : 's'}`;
    const body = g.docs.length
      ? g.docs.map(cardHtml).join('')
      : '<div class="pd-empty">Sin documentos en esta categoría.</div>';
    return `<div class="pd-grp${collapsed ? ' col' : ''}${g.docs.length === 0 ? ' empty' : ''}" data-key="${esc(g.key)}">
      <div class="pd-grp-h" data-toggle="${esc(g.key)}">
        <span class="pd-grp-chev">▾</span>
        <span class="pd-grp-dot" style="background:${esc(g.color)}"></span>
        <span class="pd-grp-name">${esc(g.label)}</span>
        <span class="pd-grp-count">· ${cnt}</span>
      </div>
      <div class="pd-grp-body">${body}</div>
    </div>`;
  }).join('');

  // toggles de grupo
  list.querySelectorAll('[data-toggle]').forEach(h => h.addEventListener('click', () => {
    const k = h.dataset.toggle;
    if (STATE.collapsed.has(k)) STATE.collapsed.delete(k); else STATE.collapsed.add(k);
    const grp = h.closest('.pd-grp');
    if (grp) grp.classList.toggle('col');
  }));

  // listeners de acciones
  list.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => downloadCurrent(+b.dataset.dl)));
  list.querySelectorAll('[data-ver]').forEach(b => b.addEventListener('click', () => openVersionsModal(+b.dataset.ver)));
  list.querySelectorAll('[data-aud]').forEach(b => b.addEventListener('click', () => openAuditModal(+b.dataset.aud)));
  list.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEditModal(+b.dataset.edit)));
  list.querySelectorAll('[data-upv]').forEach(b => b.addEventListener('click', () => openUploadModal(+b.dataset.upv)));
  list.querySelectorAll('[data-arch]').forEach(b => b.addEventListener('click', () => openArchiveModal(+b.dataset.arch)));
  list.querySelectorAll('[data-rest]').forEach(b => b.addEventListener('click', () => restoreDoc(+b.dataset.rest)));
}

function catPill(d) {
  if (!d.category) return '';
  const col = d.category_color || '#94a3b8';
  return `<span class="pill pd-cat" style="background:${esc(col)}1a;color:${esc(col)}"><span class="pd-cat-dot" style="background:${esc(col)}"></span>${esc(d.category)}</span> `;
}

function cardHtml(d) {
  const k = extKind(d.file_ext);
  const archCls = d.is_archived ? ' arch' : '';
  const pills = STATE.canManage
    ? `${d.is_archived ? '<span class="pill pd-arch">archivado</span>' : '<span class="pill pd-active">activo</span>'} `
      + catPill(d)
      + `<span class="pill pd-ver">v${d.current_version}</span>`
    : catPill(d) + `<span class="pill pd-ver">v${d.current_version}</span>`;

  const meta = STATE.canManage
    ? `<span class="m">Creado por <b>${esc(d.created_by)}</b></span>`
      + `<span class="m">Últ. cambio <b>${esc(d.updated_by)}</b> · ${fmtWhen(d.updated_at)}</span>`
      + (d.is_archived ? `<span class="m" style="color:var(--warn)">Archivado por <b>${esc(d.archived_by || '')}</b>${d.archive_reason ? ' — ' + esc(d.archive_reason) : ''}</span>` : '')
    : `<span class="m">Actualizado ${fmtWhen(d.file_uploaded_at || d.updated_at)}</span>`;

  const fileLine = d.file_name
    ? `<div class="pd-file">📎 ${esc(d.file_name)}${d.file_size ? ' · ' + fmtSize(d.file_size) : ''}</div>`
    : '<div class="pd-file" style="color:var(--warn)">Sin archivo aún</div>';

  // Descripcion: viene como HTML sanitizado del backend; se limpia de nuevo
  // en el cliente y se inyecta como HTML (no escapar).
  const descHtml = d.description ? `<div class="pd-desc">${cleanDescHtml(d.description)}</div>` : '';

  let acts;
  if (STATE.canManage) {
    acts = `
      <div class="pd-arow">
        <button class="btn btn-mini" data-ver="${d.id}">⤓ Versiones (${d.current_version})</button>
        <button class="btn btn-mini" data-aud="${d.id}">🕘 Historial</button>
      </div>
      <div class="pd-arow">
        <button class="btn btn-mini" data-dl="${d.id}">${DL_ICON} Descargar</button>
        <button class="btn btn-mini" data-edit="${d.id}">✎ Editar</button>
        <button class="btn btn-mini" data-upv="${d.id}">↑ Nueva versión</button>
        ${d.is_archived
          ? `<button class="btn btn-mini" data-rest="${d.id}">♻ Restaurar</button>`
          : `<button class="btn btn-mini pd-danger" data-arch="${d.id}">⊘ Archivar</button>`}
      </div>`;
  } else {
    acts = `<button class="btn btn-primary btn-mini" data-dl="${d.id}">${DL_ICON} Descargar</button>`;
  }

  return `<div class="pd-card${archCls}">
    <div class="pd-ic ${k}">${FILE_ICON[k]}</div>
    <div class="pd-main">
      <div class="pd-title">${esc(d.title)} ${pills}</div>
      ${descHtml}
      <div class="pd-meta">${meta}</div>
      ${fileLine}
    </div>
    <div class="pd-acts">${acts}</div>
  </div>`;
}

/* ---------- DESCARGA ---------- */
async function downloadCurrent(id) {
  const r = await api({ action: 'download', user: sessionUser(STATE.user), document_id: id });
  if (!r.ok) { alert(r.error || 'No se pudo descargar.'); return; }
  triggerDownload(r.url, r.file_name);
}
function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name || '';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ===================== MODALES ===================== */
function modalHost() { return $('#pdModalHost'); }
function closeModal() { modalHost().innerHTML = ''; }

/* ---- Subir documento nuevo / nueva versión ---- */
function openUploadModal(id) {
  const isNew = !id;
  const doc = id ? STATE.docs.find(d => d.id === id) : null;
  const catOpts = STATE.cats.filter(c => c.is_active !== false || (doc && String(doc.category_id) === String(c.id)))
    .map(c => `<option value="${c.id}">${esc(c.label)}</option>`).join('');

  if (isNew) {
    // Modal ANCHO a dos columnas: izquierda datos, derecha descripcion grande.
    modalHost().innerHTML = `
      <div class="modal-ov">
        <div class="modal wide2">
          <button class="modal-x" id="pmX">✕</button>
          <h3>Subir documento</h3>
          <p class="pd-sub">Nuevo modelo para la biblioteca del personal.</p>
          <div class="pd-upgrid">
            <div class="pd-upleft">
              <label class="flabel">Título</label>
              <input id="pmTitle" placeholder="ej. Carta de despido — No superación período de prueba">
              <label class="flabel">Categoría <span class="opt">(opcional)</span></label>
              <select id="pmCat"><option value="">— Sin categoría —</option>${catOpts}</select>
              <label class="flabel">Archivo</label>
              <div class="pd-drop" id="pmDrop">
                <svg class="pd-di" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                <b id="pmDropName">Elegir archivo</b>
                <small id="pmDropHint">Word, PDF o Excel · hasta 10 MB</small>
              </div>
              <label class="flabel">Comentario de esta versión <span class="opt">(qué cambió)</span></label>
              <input id="pmComment" placeholder="Versión inicial">
            </div>
            <div class="pd-upright">
              <label class="flabel">Descripción <span class="opt">(para qué sirve, cómo se llena)</span></label>
              ${rteHtml('pmDesc', '', 'Instrucciones de uso del documento…')}
            </div>
          </div>
          <input type="file" id="pmFile" accept="${ACCEPT}" hidden>
          <div class="modal-actions">
            <button class="btn" id="pmCancel">Cancelar</button>
            <button class="btn btn-primary" id="pmSave" disabled>Crear documento</button>
          </div>
        </div>
      </div>`;
    wireRte(modalHost());
  } else {
    // Nueva version: confirmacion del salto vN -> vN+1 + checkbox.
    const next = (doc.current_version || 0) + 1;
    modalHost().innerHTML = `
      <div class="modal-ov">
        <div class="modal">
          <button class="modal-x" id="pmX">✕</button>
          <h3>Subir nueva versión</h3>
          <p class="pd-sub">${esc(doc.title)}</p>
          <div class="pd-vbox">
            <span class="pd-vchip"><span class="from">v${doc.current_version}</span><span class="arr">→</span><span class="to">v${next}</span></span>
            <p>Al guardar, el archivo actual pasa al historial y <b>v${next}</b> queda como versión vigente. Esto es permanente.</p>
          </div>
          <label class="flabel">Archivo nuevo</label>
          <div class="pd-drop" id="pmDrop">
            <svg class="pd-di" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <b id="pmDropName">Elegir archivo</b>
            <small id="pmDropHint">Word, PDF o Excel · hasta 10 MB</small>
          </div>
          <label class="flabel">Comentario de esta versión <span class="opt">(qué cambió)</span></label>
          <input id="pmComment" placeholder="ej. Se corrigió el encabezado y la fecha">
          <label class="pd-vconfirm"><input type="checkbox" id="pmConfirm"> Confirmo que quiero reemplazar la versión vigente por <b>v${next}</b>.</label>
          <input type="file" id="pmFile" accept="${ACCEPT}" hidden>
          <div class="modal-actions">
            <button class="btn" id="pmCancel">Cancelar</button>
            <button class="btn btn-primary" id="pmSave" disabled>Guardar v${next}</button>
          </div>
        </div>
      </div>`;
  }

  let staged = null;
  const q = s => modalHost().querySelector(s);
  const refreshSave = () => {
    // En nueva version exige archivo + confirmacion; en nuevo solo archivo.
    const okFile = !!staged;
    const okConfirm = isNew ? true : !!(q('#pmConfirm') && q('#pmConfirm').checked);
    q('#pmSave').disabled = !(okFile && okConfirm);
  };
  q('#pmX').addEventListener('click', closeModal);
  q('#pmCancel').addEventListener('click', closeModal);
  q('#pmDrop').addEventListener('click', () => q('#pmFile').click());
  if (!isNew) q('#pmConfirm').addEventListener('change', refreshSave);
  q('#pmFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > MAX_BYTES) { alert('El archivo supera 10 MB.'); return; }
    if (f.type && !MIME_OK.includes(f.type)) {
      if (!confirm('El tipo de archivo no parece Word/PDF/Excel. ¿Intentar de todos modos?')) return;
    }
    staged = { name: f.name, size: f.size, mime: f.type || '', file: f };
    q('#pmDropName').textContent = f.name;
    q('#pmDropHint').textContent = `${fmtSize(f.size)} · listo para guardar`;
    refreshSave();
  });

  q('#pmSave').addEventListener('click', async () => {
    if (!staged) { alert('Elige un archivo.'); return; }
    if (isNew && !q('#pmTitle').value.trim()) { alert('Falta el título.'); return; }
    const saveB = q('#pmSave'); saveB.disabled = true; const lbl = saveB.textContent; saveB.textContent = 'Subiendo…';
    let b64;
    try {
      b64 = await fileToB64(staged.file);
    } catch (err) {
      saveB.disabled = false; saveB.textContent = lbl;
      alert('No se pudo leer el archivo seleccionado. Es posible que se haya movido, renombrado o que esté abierto en otro programa. Vuelve a elegirlo e inténtalo de nuevo.\n\nDetalle: ' + (err && err.message ? err.message : err));
      return;
    }
    if (!b64) {
      saveB.disabled = false; saveB.textContent = lbl;
      alert('El archivo quedó vacío al leerlo. Vuelve a elegirlo e inténtalo de nuevo.');
      return;
    }
    const payload = {
      user: sessionUser(STATE.user),
      file_b64: b64, file_name: staged.name, mime: staged.mime,
      comment: q('#pmComment').value.trim(),
    };
    let r;
    try {
      if (isNew) {
        r = await api({ action: 'create', ...payload,
          title: q('#pmTitle').value.trim(),
          category_id: q('#pmCat').value || null,
          description: rteValue(modalHost()) });
      } else {
        r = await api({ action: 'upload_version', document_id: id, ...payload });
      }
    } catch (err) {
      saveB.disabled = false; saveB.textContent = lbl;
      alert('Hubo un problema de red al guardar. Revisa tu conexión e inténtalo de nuevo.');
      return;
    }
    if (!r.ok) { saveB.disabled = false; saveB.textContent = lbl; alert(r.error || 'No se pudo guardar.'); return; }
    closeModal();
    await load();
  });
}

/* ---- Editar título/categoría/descripción ---- */
function openEditModal(id) {
  const d = STATE.docs.find(x => x.id === id);
  if (!d) return;
  const catOpts = STATE.cats.filter(c => c.is_active !== false || String(c.id) === String(d.category_id))
    .map(c => `<option value="${c.id}" ${String(c.id) === String(d.category_id) ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
  modalHost().innerHTML = `
    <div class="modal-ov">
      <div class="modal wide2">
        <button class="modal-x" id="peX">✕</button>
        <h3>Editar documento</h3>
        <p class="pd-sub">Cambia el título, la categoría o la descripción. El archivo no se toca aquí (usa “Nueva versión”).</p>
        <div class="pd-upgrid">
          <div class="pd-upleft">
            <label class="flabel">Título</label>
            <input id="peTitle" value="${esc(d.title)}">
            <label class="flabel">Categoría</label>
            <select id="peCat"><option value="">— Sin categoría —</option>${catOpts}</select>
          </div>
          <div class="pd-upright">
            <label class="flabel">Descripción</label>
            ${rteHtml('peDesc', cleanDescHtml(d.description || ''), 'Instrucciones de uso del documento…')}
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="peCancel">Cancelar</button>
          <button class="btn btn-primary" id="peSave">Guardar cambios</button>
        </div>
      </div>
    </div>`;
  wireRte(modalHost());
  const q = s => modalHost().querySelector(s);
  q('#peX').addEventListener('click', closeModal);
  q('#peCancel').addEventListener('click', closeModal);
  q('#peSave').addEventListener('click', async () => {
    const title = q('#peTitle').value.trim();
    if (!title) { alert('Falta el título.'); return; }
    const r = await api({ action: 'update', user: sessionUser(STATE.user), document_id: id,
      title, category_id: q('#peCat').value || null, description: rteValue(modalHost()) });
    if (!r.ok) { alert(r.error || 'No se pudo guardar.'); return; }
    closeModal();
    await load();
  });
}

/* ---- Versiones ---- */
async function openVersionsModal(id) {
  modalHost().innerHTML = `<div class="modal-ov"><div class="modal wide"><div class="pnl-loading">Cargando versiones…</div></div></div>`;
  const r = await api({ action: 'versions', user: sessionUser(STATE.user), document_id: id });
  if (!r.ok) { alert(r.error || 'No se pudo cargar.'); closeModal(); return; }
  const rows = (r.versions || []).map(v => `
    <div class="pd-ver-row">
      <div class="pd-ver-num ${v.is_current ? '' : 'old'}">v${v.version_no}</div>
      <div class="pd-ver-body">
        <div class="pd-ver-file">${esc(v.original_name)} ${v.is_current ? '<span class="pill pd-active" style="margin-left:6px">vigente</span>' : ''}</div>
        ${v.comment ? `<div class="pd-ver-cmt">${esc(v.comment)}</div>` : ''}
        <div class="pd-ver-who">Subida por <b>${esc(v.uploaded_by)}</b> · ${fmtWhen(v.uploaded_at)}${v.size_bytes ? ' · ' + fmtSize(v.size_bytes) : ''}</div>
      </div>
      <button class="btn btn-mini" data-vurl="${esc(v.url || '')}" data-vname="${esc(v.original_name)}">${DL_ICON} v${v.version_no}</button>
    </div>`).join('');
  modalHost().innerHTML = `
    <div class="modal-ov">
      <div class="modal wide">
        <button class="modal-x" id="pvX">✕</button>
        <h3>Versiones · ${esc(r.title)}</h3>
        <p class="pd-sub">La más reciente es la vigente. Puedes descargar cualquier versión anterior.</p>
        ${rows || '<p class="muted">Sin versiones.</p>'}
        <div class="modal-actions"><button class="btn btn-primary" id="pvClose">Cerrar</button></div>
      </div>
    </div>`;
  const q = s => modalHost().querySelector(s);
  q('#pvX').addEventListener('click', closeModal);
  q('#pvClose').addEventListener('click', closeModal);
  modalHost().querySelectorAll('[data-vurl]').forEach(b =>
    b.addEventListener('click', () => { if (b.dataset.vurl) triggerDownload(b.dataset.vurl, b.dataset.vname); }));
}

/* ---- Auditoría ---- */
async function openAuditModal(id) {
  const d = STATE.docs.find(x => x.id === id);
  modalHost().innerHTML = `<div class="modal-ov"><div class="modal wide"><div class="pnl-loading">Cargando historial…</div></div></div>`;
  const r = await api({ action: 'audit', user: sessionUser(STATE.user), document_id: id });
  if (!r.ok) { alert(r.error || 'No se pudo cargar.'); closeModal(); return; }
  const dot = { create: 'pd-a-create', edit: 'pd-a-edit', upload_version: 'pd-a-ver', archive: 'pd-a-arch', restore: 'pd-a-rest', download: 'pd-a-dl' };
  const rows = (r.audit || []).map(a => `
    <div class="pd-aud-row">
      <span class="pd-aud-dot ${dot[a.action] || 'pd-a-edit'}"></span>
      <span class="pd-aud-txt"><b>${esc(a.actor)}</b> ${esc(a.detail || a.action)}</span>
      <span class="pd-aud-when">${fmtWhen(a.created_at)}</span>
    </div>`).join('');
  modalHost().innerHTML = `
    <div class="modal-ov">
      <div class="modal wide">
        <button class="modal-x" id="paX">✕</button>
        <h3>Historial de cambios · ${esc(d ? d.title : '')}</h3>
        <p class="pd-sub">Rastro completo de quién hizo qué y cuándo.</p>
        ${rows || '<p class="muted">Sin movimientos.</p>'}
        <div class="modal-actions"><button class="btn btn-primary" id="paClose">Cerrar</button></div>
      </div>
    </div>`;
  const q = s => modalHost().querySelector(s);
  q('#paX').addEventListener('click', closeModal);
  q('#paClose').addEventListener('click', closeModal);
}

/* ---- Archivar ---- */
function openArchiveModal(id) {
  const d = STATE.docs.find(x => x.id === id);
  if (!d) return;
  modalHost().innerHTML = `
    <div class="modal-ov">
      <div class="modal">
        <button class="modal-x" id="paaX">✕</button>
        <h3 style="color:var(--warn)">Archivar documento</h3>
        <p class="pd-sub">${esc(d.title)}</p>
        <div class="pd-warnbox">El documento <b>no se borra</b>: se oculta de la lista activa y deja de verse en las tiendas. Conserva todas sus versiones y su historial, y puedes <b>restaurarlo</b> cuando quieras. Queda registrado quién lo archivó.</div>
        <label class="flabel">Motivo <span class="opt">(opcional, queda en el historial)</span></label>
        <input id="paaReason" placeholder="ej. Reemplazado por el nuevo formato 2026">
        <div class="modal-actions">
          <button class="btn" id="paaCancel">Cancelar</button>
          <button class="btn pd-danger" id="paaOk">Archivar</button>
        </div>
      </div>
    </div>`;
  const q = s => modalHost().querySelector(s);
  q('#paaX').addEventListener('click', closeModal);
  q('#paaCancel').addEventListener('click', closeModal);
  q('#paaOk').addEventListener('click', async () => {
    const r = await api({ action: 'archive', user: sessionUser(STATE.user), document_id: id, reason: q('#paaReason').value.trim() });
    if (!r.ok) { alert(r.error || 'No se pudo archivar.'); return; }
    closeModal();
    await load();
  });
}

async function restoreDoc(id) {
  const d = STATE.docs.find(x => x.id === id);
  if (d && !confirm(`¿Restaurar "${d.title}"? Volverá a la lista activa y las tiendas podrán verlo.`)) return;
  const r = await api({ action: 'restore', user: sessionUser(STATE.user), document_id: id });
  if (!r.ok) { alert(r.error || 'No se pudo restaurar.'); return; }
  await load();
}

/* ===================== GESTION DE CATEGORIAS (solo superadmin) ===================== */
async function openCategoriesModal() {
  modalHost().innerHTML = `<div class="modal-ov"><div class="modal"><div class="pnl-loading">Cargando categorías…</div></div></div>`;
  const r = await api({ action: 'cat_list', user: sessionUser(STATE.user) });
  if (!r.ok) { alert(r.error || 'No se pudo cargar.'); closeModal(); return; }
  // alfabetico
  const cats = (r.categories || []).slice().sort((a, b) => (a.label || '').localeCompare(b.label || '', 'es'));

  const rowsHtml = cats.map(c => {
    const off = c.is_active === false;
    const col = c.color || '#94a3b8';
    return `<div class="pd-catrow${off ? ' off' : ''}" data-id="${c.id}">
      <span class="pd-catdot" style="background:${esc(col)}" data-color="${c.id}" title="Cambiar color"></span>
      <span class="pd-catname">${esc(c.label)}${off ? ' <span class="pill pd-arch">inactiva</span>' : ''}</span>
      <span class="pd-catcode">${esc(c.code || '')}</span>
      <span class="pd-catacts">
        <button class="btn btn-mini" data-rename="${c.id}">✎ Renombrar</button>
        <button class="btn btn-mini" data-toggle2="${c.id}" data-active="${off ? '1' : '0'}">${off ? 'Activar' : 'Desactivar'}</button>
      </span>
    </div>`;
  }).join('');

  modalHost().innerHTML = `
    <div class="modal-ov">
      <div class="modal">
        <button class="modal-x" id="pcX">✕</button>
        <h3>Categorías de documentos</h3>
        <p class="pd-sub">Crea, renombra o cambia el color, y activa o desactiva. Las inactivas no aparecen al subir, pero los documentos ya asignados las conservan. El orden es alfabético.</p>
        <div id="pcRows">${rowsHtml || '<p class="muted">Sin categorías.</p>'}</div>
        <div class="pd-catadd">
          <input id="pcNew" type="text" placeholder="Nueva categoría (ej. Vacaciones)">
          <button class="btn btn-primary" id="pcAdd">+ Agregar</button>
        </div>
        <div class="modal-actions"><button class="btn btn-primary" id="pcClose">Cerrar</button></div>
      </div>
    </div>`;

  const host = modalHost();
  const q = s => host.querySelector(s);
  q('#pcX').addEventListener('click', () => { closeModal(); load(); });
  q('#pcClose').addEventListener('click', () => { closeModal(); load(); });

  q('#pcAdd').addEventListener('click', async () => {
    const label = q('#pcNew').value.trim();
    if (!label) { q('#pcNew').focus(); return; }
    const res = await api({ action: 'cat_save', user: sessionUser(STATE.user), category: { label } });
    if (!res.ok) { alert(res.error || 'No se pudo crear.'); return; }
    await openCategoriesModal();
  });
  q('#pcNew').addEventListener('keydown', e => { if (e.key === 'Enter') q('#pcAdd').click(); });

  host.querySelectorAll('[data-rename]').forEach(b => b.addEventListener('click', async () => {
    const id = +b.dataset.rename;
    const cur = cats.find(c => String(c.id) === String(id));
    const label = prompt('Nuevo nombre de la categoría:', cur ? cur.label : '');
    if (label == null) return;
    if (!label.trim()) { alert('El nombre no puede quedar vacío.'); return; }
    const res = await api({ action: 'cat_save', user: sessionUser(STATE.user), category: { id, label: label.trim() } });
    if (!res.ok) { alert(res.error || 'No se pudo renombrar.'); return; }
    await openCategoriesModal();
  }));

  host.querySelectorAll('[data-toggle2]').forEach(b => b.addEventListener('click', async () => {
    const id = +b.dataset.toggle2;
    const willActivate = b.dataset.active === '1';
    const res = await api({ action: 'cat_toggle', user: sessionUser(STATE.user), id, active: willActivate });
    if (!res.ok) { alert(res.error || 'No se pudo cambiar.'); return; }
    await openCategoriesModal();
  }));

  // cambiar color: paleta rapida en un mini-popover (prompt simple con hex)
  host.querySelectorAll('[data-color]').forEach(dot => dot.addEventListener('click', async () => {
    const id = +dot.dataset.color;
    const cur = cats.find(c => String(c.id) === String(id));
    const hex = prompt('Color de la categoría (hex, ej. #2b6cff):', (cur && cur.color) || '#2b6cff');
    if (hex == null) return;
    if (!/^#[0-9a-fA-F]{6}$/.test(hex.trim())) { alert('Formato inválido. Usa #RRGGBB (ej. #2b6cff).'); return; }
    const res = await api({ action: 'cat_save', user: sessionUser(STATE.user), category: { id, label: cur.label, color: hex.trim() } });
    if (!res.ok) { alert(res.error || 'No se pudo cambiar el color.'); return; }
    await openCategoriesModal();
  }));
}
