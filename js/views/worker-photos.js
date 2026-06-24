/* =====================================================================
   js/views/worker-photos.js
   Directorio de fichas de colaboradores con foto (tipo carnet).

   Muestra el roster de UNA tienda en un grid de tarjetas; por cada
   persona permite subir su foto. La foto se comprime EN EL NAVEGADOR a
   dos versiones antes de enviarse:
     - completa: lado mayor 300px, JPEG ~0.7 (sin recortar) -> para AX.
     - miniatura: 300x300 recorte cuadrado centrado -> para este grid.
   Ambas viajan en base64 al endpoint /api/worker-photo (accion 'save'),
   que las sube al Storage privado 'worker-photos' y guarda las rutas en
   workers_master (la tabla maestra por cedula, sin empresa).

   Una guia circular punteada ayuda a centrar el rostro; NO recorta la
   version completa, es solo visual.

   Acceso:
     - tienda: ve su propio roster (companyCode de la sesion).
     - admin/superadmin: eligen tienda primero (pickedCompany), igual que
       el resto del panel. El acceso se revalida server-side.

   Exporta renderWorkerPhotos(user, companyCode, onExit?), que pinta la
   vista dentro de #pnlMain.
   ===================================================================== */

import { $ } from '../core/dom.js';

const TARGET = 300;          // lado objetivo (px) de ambas versiones
const FULL_QUALITY = 0.7;    // calidad JPEG de la version completa
const THUMB_QUALITY = 0.72;  // calidad JPEG de la miniatura

/* ---------- API ---------- */
async function api(payload) {
  const res = await fetch('/api/worker-photo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// El endpoint espera identificar al usuario para validar el acceso.
function sessionUserPayload(user) {
  return { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null };
}

/* ---------- Compresion en el navegador ---------- */
// Lee un File a un HTMLImageElement (via dataURL).
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const fr = new FileReader();
    fr.onload = () => { img.onload = () => resolve(img); img.onerror = reject; img.src = fr.result; };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

// Version COMPLETA: sin recortar, lado mayor = TARGET (mantiene proporcion).
// Devuelve { dataUrl, w, h }.
function makeFull(img) {
  let w = img.width, h = img.height;
  if (w >= h && w > TARGET) { h = Math.round(h * TARGET / w); w = TARGET; }
  else if (h > w && h > TARGET) { w = Math.round(w * TARGET / h); h = TARGET; }
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, w, h);
  cx.drawImage(img, 0, 0, w, h);
  return { dataUrl: cv.toDataURL('image/jpeg', FULL_QUALITY), w, h };
}

// Version MINIATURA: recorte cuadrado centrado a TARGETxTARGET (para el grid).
function makeThumb(img) {
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
  const cv = document.createElement('canvas');
  cv.width = TARGET; cv.height = TARGET;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, TARGET, TARGET);
  cx.drawImage(img, sx, sy, side, side, 0, 0, TARGET, TARGET);
  return cv.toDataURL('image/jpeg', THUMB_QUALITY);
}

// base64 -> bytes aproximados (para mostrar el peso).
function b64Bytes(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  return Math.round(b64.length * 0.75);
}
function stripPrefix(dataUrl) { return String(dataUrl).split(',')[1] || ''; }

/* ---------- Circulo guia (SVG superpuesto, no recorta la foto) ----------
   Mascara que oscurece todo menos un circulo central, con su borde. Es solo
   una ayuda visual para centrar el rostro; la foto se guarda completa. */
function guideSvg() {
  return `<svg class="wp-guide" viewBox="0 0 100 100" preserveAspectRatio="none"><defs><mask id="wpmc"><rect width="100" height="100" fill="white"/><circle cx="50" cy="50" r="32" fill="black"/></mask></defs><rect width="100" height="100" fill="rgba(15,23,42,0.34)" mask="url(#wpmc)"/><circle cx="50" cy="50" r="32" fill="none" stroke="#fff" stroke-width="0.8" stroke-dasharray="3 2"/></svg>`;
}

/* ---------- helpers de UI ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = String(iso).slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : iso;
}

/* ===================== VISTA ===================== */

let STATE = null;   // { user, cc, onExit, workers:[], q:'' }

export async function renderWorkerPhotos(user, companyCode, onExit) {
  STATE = { user, cc: companyCode, onExit: onExit || null, workers: [], q: '' };

  const back = onExit
    ? `<button class="btn" id="wpBack" style="margin-bottom:14px">← Volver</button>`
    : '';

  $('#pnlMain').innerHTML = `
    ${back}
    <div class="pnl-head">
      <div><h1>Fichas y fotos</h1>
        <p id="wpInfo">Cargando colaboradores de ${esc(companyCode)}…</p></div>
    </div>
    <div class="pnl-filters">
      <div class="search"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><input id="wpSearch" placeholder="Buscar por nombre o cédula…"></div>
    </div>
    <div id="wpGrid" class="wp-grid"><div class="pnl-loading">Cargando…</div></div>
    <div id="wpModalHost"></div>`;

  if (onExit) $('#wpBack').addEventListener('click', onExit);
  $('#wpSearch').addEventListener('input', e => { STATE.q = e.target.value; paintGrid(); });

  const d = await api({ action: 'directory', company_code: companyCode, user: sessionUserPayload(user) });
  if (!d.ok) {
    $('#wpGrid').innerHTML = `<div class="card"><p class="muted" style="margin:0">No se pudo cargar: ${esc(d.error || 'error')}</p></div>`;
    $('#wpInfo').textContent = 'Error al cargar';
    return;
  }
  STATE.workers = d.workers || [];
  updateInfo(d);
  paintGrid();
}

function updateInfo(d) {
  const total = d.total != null ? d.total : STATE.workers.length;
  const withPhoto = d.with_photo != null ? d.with_photo : STATE.workers.filter(w => w.has_photo).length;
  const el = $('#wpInfo');
  if (el) el.innerHTML = `${total} colaboradores · <b style="color:var(--success)">${withPhoto} con foto</b> · ${total - withPhoto} pendientes`;
}

function paintGrid() {
  const grid = $('#wpGrid');
  if (!grid) return;
  const q = (STATE.q || '').toLowerCase().trim();
  const list = STATE.workers.filter(w =>
    !q || (w.full_name || '').toLowerCase().includes(q) || (w.id_number || '').includes(q));

  grid.innerHTML = list.map(w => {
    const photo = w.thumb_url
      ? `<img src="${w.thumb_url}" alt="${esc(w.full_name)}" loading="lazy">`
      : `<div class="wp-empty"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/><line x1="19" y1="5" x2="19" y2="9"/><line x1="17" y1="7" x2="21" y2="7"/></svg><span>Sin foto</span></div>`;
    const badge = w.has_photo
      ? '<span class="wp-badge has">✓ cargada</span>'
      : '<span class="wp-badge no">pendiente</span>';
    const egr = w.end_date ? `<span class="pill pill-out" style="margin-top:4px;display:inline-block">egresó ${fmtDate(w.end_date)}</span>` : '';
    return `<div class="wp-card">
      <div class="wp-photo" data-ced="${w.id_number}">
        ${photo}${badge}
        <div class="wp-ov"><span>${w.has_photo ? 'Cambiar foto' : 'Subir foto'}</span></div>
      </div>
      <div class="wp-body">
        <p class="wp-name">${esc(w.full_name)}</p>
        <span class="wp-ced">${w.ced_kind || ''}-${w.id_number}</span>
        ${w.role ? `<div class="wp-role">${esc(w.role)}</div>` : ''}
        ${egr}
      </div>
    </div>`;
  }).join('') || '<div class="card"><p class="muted" style="margin:0">Sin coincidencias.</p></div>';

  grid.querySelectorAll('.wp-photo').forEach(el =>
    el.addEventListener('click', () => openPhotoModal(el.dataset.ced)));
}

/* ---------- MODAL: subir/cambiar la foto de UNA persona ---------- */
function openPhotoModal(ced) {
  const w = STATE.workers.find(x => String(x.id_number) === String(ced));
  if (!w) return;

  let staged = null;       // { full, thumb, w, h, bytes } una vez procesada
  const host = $('#wpModalHost');

  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="wpClose" aria-label="Cerrar" title="Cerrar">✕</button>
        <h3>Foto del colaborador</h3>
        <p class="wp-who"><b>${esc(w.full_name)}</b> · <span class="wp-ced">${w.ced_kind || ''}-${w.id_number}</span></p>

        <div class="wp-help">
          <div class="wp-ex" id="wpEx"></div>
          <div class="wp-help-txt"><b>Cómo tomar la foto (tipo carnet):</b> de frente, hombros visibles, fondo claro y liso, buena luz sin sombras. La cara centrada ocupando el círculo. Sin lentes, gorras ni gestos.</div>
        </div>

        <div class="wp-stage" id="wpStage">
          <div class="wp-ph"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><span>Elige una foto para previsualizar</span></div>
        </div>
        <p class="wp-guide-lbl">El círculo es solo una guía para centrar el rostro; la foto se guarda completa.</p>

        <p class="wp-meta" id="wpMeta"></p>

        <input type="file" id="wpFile" accept="image/*" hidden>
        <div class="wp-foot">
          ${w.has_photo ? '<button class="btn" id="wpDel" style="color:var(--danger);border-color:#f3c2c2">Quitar foto</button>' : ''}
          <span style="flex:1"></span>
          <button class="btn" id="wpCancel">Cancelar</button>
          <button class="btn" id="wpPick">Elegir foto</button>
          <button class="btn btn-primary" id="wpSave" disabled>Guardar</button>
        </div>
      </div>
    </div>`;

  const stage = $('#wpStage'), meta = $('#wpMeta'), fileEl = $('#wpFile'), saveB = $('#wpSave');

  // Cerrar el modal: X, boton Cancelar, clic fuera y tecla Escape.
  const closeModal = () => {
    document.removeEventListener('keydown', onKey);
    host.innerHTML = '';
  };
  const onKey = (ev) => { if (ev.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', onKey);
  $('#wpClose').addEventListener('click', closeModal);
  $('#wpCancel').addEventListener('click', closeModal);
  host.querySelector('.wp-modal-vp').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) closeModal();   // clic en el fondo oscuro
  });

  // Ejemplo de encuadre (cara dibujada + circulo guia).
  $('#wpEx').innerHTML = guideSvg()
    + '<svg viewBox="0 0 100 100" style="position:absolute;inset:0"><circle cx="50" cy="40" r="17" fill="#c9b6a0"/><rect x="33" y="62" width="34" height="34" rx="10" fill="#5b6b82"/></svg>';

  function renderStage() {
    stage.innerHTML = staged
      ? `<img src="${staged.preview}" alt="vista previa">`
      : `<div class="wp-ph"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><span>Elige una foto para previsualizar</span></div>`;
    // Circulo guia fijo superpuesto (no recorta la foto completa).
    stage.insertAdjacentHTML('beforeend', guideSvg());
  }
  renderStage();

  $('#wpPick').addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const origKB = Math.round(f.size / 1024);
    try {
      const img = await fileToImage(f);
      const full = makeFull(img);
      const thumb = makeThumb(img);
      staged = {
        full: stripPrefix(full.dataUrl), thumb: stripPrefix(thumb),
        preview: thumb, w: full.w, h: full.h, bytes: b64Bytes(full.dataUrl),
      };
      const outKB = Math.round(staged.bytes / 1024);
      meta.innerHTML = `Original ${origKB} KB → <b style="color:var(--success)">comprimida ${outKB} KB</b> · ${full.w}×${full.h} (completa) + ${TARGET}×${TARGET} (miniatura)`;
      saveB.disabled = false;
      renderStage();
    } catch (err) {
      meta.textContent = 'No se pudo leer la imagen. Prueba con otra.';
    }
  });

  saveB.addEventListener('click', async () => {
    if (!staged) return;
    saveB.disabled = true; saveB.textContent = 'Guardando…';
    const uploadedBy = STATE.user.kind === 'company'
      ? STATE.user.companyCode
      : (STATE.user.name || STATE.user.username || 'admin');
    const r = await api({
      action: 'save', company_code: STATE.cc, user: sessionUserPayload(STATE.user),
      id_number: w.id_number,
      full_b64: staged.full, thumb_b64: staged.thumb, mime: 'image/jpeg',
      width: staged.w, height: staged.h, bytes: staged.bytes,
      uploaded_by: uploadedBy,
    });
    if (!r.ok) {
      saveB.disabled = false; saveB.textContent = 'Guardar';
      alert(r.error || 'No se pudo guardar la foto.');
      return;
    }
    // Actualizar el estado local y refrescar el grid.
    w.has_photo = true;
    w.thumb_url = r.thumb_url || w.thumb_url;
    w.photo_uploaded_at = new Date().toISOString();
    closeModal();
    updateInfo({});
    paintGrid();
  });

  const delB = $('#wpDel');
  if (delB) delB.addEventListener('click', async () => {
    if (!confirm(`¿Quitar la foto de ${w.full_name}?`)) return;
    const r = await api({ action: 'remove', company_code: STATE.cc, user: sessionUserPayload(STATE.user), id_number: w.id_number });
    if (!r.ok) { alert(r.error || 'No se pudo quitar.'); return; }
    w.has_photo = false; w.thumb_url = null; w.photo_uploaded_at = null;
    closeModal();
    updateInfo({});
    paintGrid();
  });
}
