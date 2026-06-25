/* =====================================================================
   js/views/personnel-docs.js  →  vista "Documentos"
   Biblioteca global de documentos del personal (modelos de cartas,
   planillas, formatos). Admin/superadmin suben, editan, versionan y
   archivan; las empresas solo ven y descargan.

   El archivo se lee en el navegador y viaja en base64 a /api/personnel-docs.
   Exporta renderPersonnelDocs(user, onExit?) que pinta dentro de #pnlMain.
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

/* Lee un File a base64 (sin el prefijo data:). */
function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

/* ===================== ESTADO ===================== */
let STATE = null;   // { user, onExit, canManage, docs, cats, q, catFilter, scope }

/* ===================== ENTRADA ===================== */
export async function renderPersonnelDocs(user, onExit) {
  const canManage = user.kind === 'admin'; // admin o superadmin
  STATE = { user, onExit: onExit || null, canManage, docs: [], cats: [], q: '', catFilter: '', scope: 'active' };

  const back = onExit ? `<button class="btn" id="pdBack" style="margin-bottom:14px">← Volver</button>` : '';
  const newBtn = canManage
    ? `<button class="btn btn-primary" id="pdNew"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg> Subir documento</button>`
    : '';
  const roBanner = canManage ? '' : `
    <div class="pd-ro">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      Estos son los modelos oficiales. Descarga el que necesites; usa siempre la versión vigente. Solo Capital Humano puede modificarlos.
    </div>`;

  $('#pnlMain').innerHTML = `
    ${back}
    <div class="pnl-head">
      <div><h1>Documentos</h1><p id="pdInfo">Cargando…</p></div>
      ${newBtn}
    </div>
    ${roBanner}
    <div class="pnl-filters">
      <div class="search"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><input id="pdSearch" placeholder="Buscar por título o descripción…"></div>
      <select id="pdCat" class="filt"><option value="">Todas las categorías</option></select>
      ${canManage ? `<select id="pdScope" class="filt"><option value="active">Solo activos</option><option value="all">Incluir archivados</option><option value="archived">Solo archivados</option></select>` : ''}
    </div>
    <div id="pdList" class="pd-list"><div class="pnl-loading">Cargando…</div></div>
    <div id="pdModalHost"></div>`;

  if (onExit) $('#pdBack').addEventListener('click', onExit);
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
  STATE.cats = d.categories || [];
  // poblar el combo de categorias una vez
  const sel = $('#pdCat');
  if (sel && sel.options.length <= 1) {
    STATE.cats.forEach(c => { sel.innerHTML += `<option value="${c.id}">${esc(c.label)}</option>`; });
  }
  paintList();
}

function paintList() {
  const list = $('#pdList');
  if (!list) return;
  const q = (STATE.q || '').toLowerCase().trim();
  const cf = STATE.catFilter;
  const rows = STATE.docs.filter(d =>
    (!q || (d.title || '').toLowerCase().includes(q) || (d.description || '').toLowerCase().includes(q))
    && (!cf || String(d.category_id) === String(cf)));

  const activos = STATE.docs.filter(d => !d.is_archived).length;
  const arch = STATE.docs.length - activos;
  $('#pdInfo').textContent = STATE.canManage
    ? `${activos} activos${arch ? ` · ${arch} archivados` : ''}`
    : `${rows.length} documento${rows.length === 1 ? '' : 's'} disponible${rows.length === 1 ? '' : 's'}`;

  list.innerHTML = rows.map(cardHtml).join('')
    || '<div class="card"><p class="muted" style="margin:0">Sin documentos.</p></div>';

  // listeners
  list.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => downloadCurrent(+b.dataset.dl)));
  list.querySelectorAll('[data-ver]').forEach(b => b.addEventListener('click', () => openVersionsModal(+b.dataset.ver)));
  list.querySelectorAll('[data-aud]').forEach(b => b.addEventListener('click', () => openAuditModal(+b.dataset.aud)));
  list.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEditModal(+b.dataset.edit)));
  list.querySelectorAll('[data-upv]').forEach(b => b.addEventListener('click', () => openUploadModal(+b.dataset.upv)));
  list.querySelectorAll('[data-arch]').forEach(b => b.addEventListener('click', () => openArchiveModal(+b.dataset.arch)));
  list.querySelectorAll('[data-rest]').forEach(b => b.addEventListener('click', () => restoreDoc(+b.dataset.rest)));
}

function cardHtml(d) {
  const k = extKind(d.file_ext);
  const archCls = d.is_archived ? ' arch' : '';
  const pills = STATE.canManage
    ? `${d.is_archived ? '<span class="pill pd-arch">archivado</span>' : '<span class="pill pd-active">activo</span>'} `
      + `${d.category ? `<span class="pill pd-cat">${esc(d.category)}</span> ` : ''}`
      + `<span class="pill pd-ver">v${d.current_version}</span>`
    : `${d.category ? `<span class="pill pd-cat">${esc(d.category)}</span> ` : ''}<span class="pill pd-ver">v${d.current_version}</span>`;

  const meta = STATE.canManage
    ? `<span class="m">Creado por <b>${esc(d.created_by)}</b></span>`
      + `<span class="m">Últ. cambio <b>${esc(d.updated_by)}</b> · ${fmtWhen(d.updated_at)}</span>`
      + (d.is_archived ? `<span class="m" style="color:var(--warn)">Archivado por <b>${esc(d.archived_by || '')}</b>${d.archive_reason ? ' — ' + esc(d.archive_reason) : ''}</span>` : '')
    : `<span class="m">Actualizado ${fmtWhen(d.file_uploaded_at || d.updated_at)}</span>`;

  const fileLine = d.file_name
    ? `<div class="pd-file">📎 ${esc(d.file_name)}${d.file_size ? ' · ' + fmtSize(d.file_size) : ''}</div>`
    : '<div class="pd-file" style="color:var(--warn)">Sin archivo aún</div>';

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
      ${d.description ? `<div class="pd-desc">${esc(d.description)}</div>` : ''}
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
  const catOpts = STATE.cats.map(c => `<option value="${c.id}">${esc(c.label)}</option>`).join('');

  modalHost().innerHTML = `
    <div class="modal-ov">
      <div class="modal">
        <button class="modal-x" id="pmX">✕</button>
        <h3>${isNew ? 'Subir documento' : 'Subir nueva versión'}</h3>
        <p class="pd-sub">${isNew ? 'Nuevo modelo para la biblioteca del personal.' : esc(doc.title)}</p>
        ${isNew ? `
          <label class="flabel">Título</label>
          <input id="pmTitle" placeholder="ej. Carta de despido — No superación período de prueba">
          <label class="flabel">Categoría <span class="opt">(opcional)</span></label>
          <select id="pmCat"><option value="">— Sin categoría —</option>${catOpts}</select>
          <label class="flabel">Descripción <span class="opt">(para qué sirve, cómo se llena)</span></label>
          <textarea id="pmDesc" placeholder="Instrucciones de uso del documento…"></textarea>
        ` : `
          <div class="pd-curbox">Versión actual: <b>v${doc.current_version}</b>${doc.file_name ? ' · ' + esc(doc.file_name) : ''}. Al subir, pasará a <b>v${doc.current_version + 1}</b> y la actual quedará en el historial.</div>
        `}
        <div class="pd-drop" id="pmDrop">
          <svg class="pd-di" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <b id="pmDropName">Elegir archivo</b>
          <small id="pmDropHint">Word, PDF o Excel · hasta 10 MB</small>
        </div>
        <input type="file" id="pmFile" accept="${ACCEPT}" hidden>
        <label class="flabel">Comentario de esta versión <span class="opt">(qué cambió)</span></label>
        <input id="pmComment" placeholder="${isNew ? 'Versión inicial' : 'ej. Se corrigió el encabezado y la fecha'}">
        <div class="modal-actions">
          <button class="btn" id="pmCancel">Cancelar</button>
          <button class="btn btn-primary" id="pmSave" disabled>${isNew ? 'Crear documento' : 'Guardar nueva versión'}</button>
        </div>
      </div>
    </div>`;

  let staged = null;
  const q = s => modalHost().querySelector(s);
  q('#pmX').addEventListener('click', closeModal);
  q('#pmCancel').addEventListener('click', closeModal);
  q('#pmDrop').addEventListener('click', () => q('#pmFile').click());
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
    q('#pmSave').disabled = false;
  });

  q('#pmSave').addEventListener('click', async () => {
    if (!staged) { alert('Elige un archivo.'); return; }
    if (isNew && !q('#pmTitle').value.trim()) { alert('Falta el título.'); return; }
    const saveB = q('#pmSave'); saveB.disabled = true; saveB.textContent = 'Subiendo…';
    const b64 = await fileToB64(staged.file);
    const payload = {
      user: sessionUser(STATE.user),
      file_b64: b64, file_name: staged.name, mime: staged.mime,
      comment: q('#pmComment').value.trim(),
    };
    let r;
    if (isNew) {
      r = await api({ action: 'create', ...payload,
        title: q('#pmTitle').value.trim(),
        category_id: q('#pmCat').value || null,
        description: q('#pmDesc').value.trim() });
    } else {
      r = await api({ action: 'upload_version', document_id: id, ...payload });
    }
    if (!r.ok) { saveB.disabled = false; saveB.textContent = isNew ? 'Crear documento' : 'Guardar nueva versión'; alert(r.error || 'No se pudo guardar.'); return; }
    closeModal();
    await load();
  });
}

/* ---- Editar título/categoría/descripción ---- */
function openEditModal(id) {
  const d = STATE.docs.find(x => x.id === id);
  if (!d) return;
  const catOpts = STATE.cats.map(c => `<option value="${c.id}" ${String(c.id) === String(d.category_id) ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
  modalHost().innerHTML = `
    <div class="modal-ov">
      <div class="modal">
        <button class="modal-x" id="peX">✕</button>
        <h3>Editar documento</h3>
        <p class="pd-sub">Cambia el título, la categoría o la descripción. El archivo no se toca aquí (usa “Nueva versión”).</p>
        <label class="flabel">Título</label>
        <input id="peTitle" value="${esc(d.title)}">
        <label class="flabel">Categoría</label>
        <select id="peCat"><option value="">— Sin categoría —</option>${catOpts}</select>
        <label class="flabel">Descripción</label>
        <textarea id="peDesc">${esc(d.description || '')}</textarea>
        <div class="modal-actions">
          <button class="btn" id="peCancel">Cancelar</button>
          <button class="btn btn-primary" id="peSave">Guardar cambios</button>
        </div>
      </div>
    </div>`;
  const q = s => modalHost().querySelector(s);
  q('#peX').addEventListener('click', closeModal);
  q('#peCancel').addEventListener('click', closeModal);
  q('#peSave').addEventListener('click', async () => {
    const title = q('#peTitle').value.trim();
    if (!title) { alert('Falta el título.'); return; }
    const r = await api({ action: 'update', user: sessionUser(STATE.user), document_id: id,
      title, category_id: q('#peCat').value || null, description: q('#peDesc').value.trim() });
    if (!r.ok) { alert(r.error || 'No se pudo guardar.'); return; }
    closeModal();
    await load();
  });
}

/* ---- Versiones ---- */
async function openVersionsModal(id) {
  const d = STATE.docs.find(x => x.id === id);
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
