/* =====================================================================
   js/views/cert-signers.js  →  vista "Firmantes" (catálogo de firmantes de
   constancias de trabajo). Parte del grupo de menú "Solicitudes".

   Los firmantes NO son los admin_users: catálogo propio (nomina_v2.cert_signers)
   con nombre, cargo (default bajo la firma) e imagen de firma (PNG, idealmente
   fondo transparente) en el bucket privado cert-signatures.

   Pantalla (§9.5 del diseño):
     - Grilla: nombre, cargo, preview de la firma, estado activo, acciones
       (Editar / Activar-Desactivar).
     - Alta / edición: nombre + cargo + carga de firma (PNG). Preview del PNG
       sobre un fondo tipo documento. Cómo generar la firma: firmar en papel →
       foto/escaneo → quitar fondo → subir PNG.

   Datos por /api/cert-signers (list / create / update / set_active /
   upload_signature). Escritura = superadmin (gate en el endpoint).

   Export: renderCertSigners(user)  — user = { kind:'admin', id, role, name }
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);

const MAX_SIG_BYTES = 500 * 1024;                 // igual que el endpoint
const DEFAULT_TITLE = 'ANALISTA DE CAPITAL HUMANO';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtWhen(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt)) return '';
  return dt.toLocaleString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', year: 'numeric' });
}

let USER = null;
let ROWS = [];
let CUR_FILTER = 'todos';   // todos | activos | inactivos

/* ---------- estilos ---------- */
function ensureStyles() {
  if (document.getElementById('csgStyles')) return;
  const st = document.createElement('style');
  st.id = 'csgStyles';
  st.textContent = `
  .csg-head{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap}
  .csg-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .csg-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .csg-b{font:inherit;font-size:13px;padding:8px 14px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);cursor:pointer;display:inline-flex;align-items:center;gap:7px}
  .csg-b:hover{background:var(--bg-soft,#f1f5f9)}
  .csg-b-primary{background:var(--brand,#2563eb);color:#fff;border-color:var(--brand,#2563eb)}
  .csg-b-primary:hover{background:#1d4ed8}
  .csg-b-mini{font-size:12px;padding:6px 11px}
  .csg-chips{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 4px}
  .csg-chip{font:inherit;font-size:13px;padding:7px 13px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--ink);cursor:pointer;display:flex;align-items:center;gap:7px}
  .csg-chip.on{background:var(--brand,#2563eb);color:#fff;border-color:var(--brand,#2563eb)}
  .csg-chip .csg-n{font-size:11px;font-weight:700;background:rgba(0,0,0,.08);border-radius:999px;padding:1px 7px}
  .csg-chip.on .csg-n{background:rgba(255,255,255,.25)}
  .csg-table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
  .csg-table th{text-align:left;font-weight:600;color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;padding:8px 10px;border-bottom:1px solid var(--border)}
  .csg-table td{padding:11px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
  .csg-table tr:hover td{background:var(--bg-soft,#f8fafc)}
  .csg-name{font-weight:600;color:var(--ink)}
  .csg-title{color:var(--muted);font-size:12px}
  .csg-when{display:block;color:var(--muted);font-size:11px;margin-top:3px}
  .csg-sigcell{width:150px}
  .csg-sigbox{display:inline-flex;align-items:center;justify-content:center;width:140px;height:52px;border:1px dashed var(--border);border-radius:8px;background:
    repeating-conic-gradient(#f1f5f9 0% 25%, #ffffff 0% 50%) 50% / 14px 14px}
  .csg-sigbox img{max-width:128px;max-height:44px;object-fit:contain;display:block}
  .csg-sigbox .csg-nosig{color:var(--muted);font-size:11px}
  .csg-pill{display:inline-block;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap}
  .csg-on{background:#dcfce7;color:#166534}
  .csg-off{background:#f1f5f9;color:#64748b}
  .csg-acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
  .csg-empty{padding:36px 14px;text-align:center;color:var(--muted)}
  /* modal */
  .csg-ov{position:fixed;inset:0;background:rgba(15,23,42,.42);display:flex;align-items:center;justify-content:center;z-index:80;padding:16px}
  .csg-modal{background:var(--card,#fff);border-radius:14px;max-width:520px;width:100%;padding:22px;box-shadow:0 18px 48px rgba(15,23,42,.24);max-height:90vh;overflow:auto}
  .csg-modal h3{margin:0 0 4px;font-size:17px;color:var(--ink)}
  .csg-modal .csg-sub{color:var(--muted);font-size:12.5px;margin:0 0 16px;line-height:1.5}
  .csg-modal label{display:block;font-size:12.5px;font-weight:600;color:var(--ink);margin:14px 0 6px}
  .csg-modal input[type=text]{width:100%;font:inherit;font-size:13px;padding:9px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);box-sizing:border-box}
  .csg-hint{color:var(--muted);font-size:11.5px;margin:5px 0 0;line-height:1.5}
  .csg-drop{margin-top:8px;border:1.5px dashed var(--border);border-radius:11px;padding:14px;text-align:center;cursor:pointer;background:var(--bg-soft,#f8fafc);transition:border-color .15s,background .15s}
  .csg-drop:hover{border-color:var(--brand,#2563eb)}
  .csg-drop.drag{border-color:var(--brand,#2563eb);background:#eff6ff}
  .csg-drop .csg-drop-t{font-size:12.5px;color:var(--ink);font-weight:600}
  .csg-drop .csg-drop-s{font-size:11.5px;color:var(--muted);margin-top:3px}
  .csg-preview{margin-top:12px;display:none}
  .csg-preview.on{display:block}
  .csg-preview .csg-pv-label{font-size:11.5px;color:var(--muted);margin-bottom:6px}
  .csg-pv-doc{border:1px solid var(--border);border-radius:10px;background:#fff;padding:18px 16px 12px}
  .csg-pv-doc .csg-pv-sig{display:flex;align-items:flex-end;justify-content:center;min-height:58px}
  .csg-pv-doc .csg-pv-sig img{max-width:220px;max-height:70px;object-fit:contain}
  .csg-pv-doc .csg-pv-line{border-top:1px solid #0f172a;margin:6px auto 0;width:240px}
  .csg-pv-doc .csg-pv-nm{text-align:center;font-size:12px;font-weight:700;color:#0f172a;margin-top:5px}
  .csg-pv-doc .csg-pv-ti{text-align:center;font-size:11px;color:#334155}
  .csg-err{display:none;margin-top:12px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:12.5px;padding:9px 11px;border-radius:9px}
  .csg-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
  .csg-cfx p{margin:0 0 4px;color:var(--muted);font-size:13px;line-height:1.5}
  .csg-cfx .csg-strong{color:var(--ink);font-weight:600}
  /* toast */
  .csg-toast-wrap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:120;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
  .csg-toast{pointer-events:auto;display:flex;align-items:center;gap:10px;background:var(--ink,#0f172a);color:#fff;font-size:13px;font-weight:500;padding:11px 16px;border-radius:11px;box-shadow:0 10px 30px rgba(15,23,42,.28);opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s;max-width:90vw}
  .csg-toast.show{opacity:1;transform:translateY(0)}
  .csg-toast .csg-ico{display:inline-flex;width:20px;height:20px;border-radius:999px;align-items:center;justify-content:center;font-size:12px;flex:none}
  .csg-toast-ok .csg-ico{background:#16a34a;color:#fff}
  .csg-toast-info .csg-ico{background:#2563eb;color:#fff}
  `;
  document.head.appendChild(st);
}

/* ---------- toast / confirm / notice (sin nativos) ---------- */
let _toastWrap = null;
function toast(msg, kind = 'ok') {
  if (!_toastWrap) {
    _toastWrap = document.createElement('div');
    _toastWrap.className = 'csg-toast-wrap';
    document.body.appendChild(_toastWrap);
  }
  const t = document.createElement('div');
  t.className = `csg-toast csg-toast-${kind === 'info' ? 'info' : 'ok'}`;
  const ico = kind === 'info' ? '\u2139' : '\u2713';
  t.innerHTML = `<span class="csg-ico">${ico}</span><span>${esc(msg)}</span>`;
  _toastWrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 220); }, 2600);
}
function confirmModal({ title, bodyHtml, okLabel = 'Aceptar', cancelLabel = 'Cancelar', tone = 'default' }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'csg-ov';
    const okClass = tone === 'danger' ? 'csg-b csg-b-primary' : 'csg-b csg-b-primary';
    ov.innerHTML = `
      <div class="csg-modal csg-cfx">
        <h3>${esc(title || '\u00bfConfirmar?')}</h3>
        ${bodyHtml ? `<div>${bodyHtml}</div>` : ''}
        <div class="csg-foot">
          <button class="csg-b" data-cfx-cancel>${esc(cancelLabel)}</button>
          <button class="${okClass}" data-cfx-ok>${esc(okLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const done = (val) => { ov.remove(); resolve(val); };
    ov.querySelector('[data-cfx-cancel]').addEventListener('click', () => done(false));
    ov.querySelector('[data-cfx-ok]').addEventListener('click', () => done(true));
    ov.addEventListener('click', e => { if (e.target === ov) done(false); });
  });
}
function noticeModal(msg) {
  const ov = document.createElement('div');
  ov.className = 'csg-ov';
  ov.innerHTML = `
    <div class="csg-modal csg-cfx">
      <h3>Aviso</h3><p>${esc(msg)}</p>
      <div class="csg-foot"><button class="csg-b csg-b-primary" data-cfx-ok>Entendido</button></div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('[data-cfx-ok]').addEventListener('click', close);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
}

/* ---------- API ---------- */
async function api(payload) {
  return fetch('/api/cert-signers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, adminId: USER.id }),
  }).then(x => x.json()).catch(() => ({ ok: false, error: 'Error de red.' }));
}

async function fetchAll() {
  const r = await api({ action: 'list' });
  ROWS = (r && r.ok && r.signers) ? r.signers : [];
  return r;
}

/* ---------- lectura de la firma (archivo -> {b64, mime, w, h}) ----------
   No recomprime: la firma es liviana y conviene preservar la transparencia
   del PNG. Solo valida tipo y tamaño, y mide dimensiones. */
function readSignatureFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No se seleccionó archivo.'));
    const okType = /image\/(png|webp|jpeg)/i.test(file.type);
    if (!okType) return reject(new Error('La firma debe ser PNG (ideal, con fondo transparente), WEBP o JPG.'));
    if (file.size > MAX_SIG_BYTES) return reject(new Error('La firma pesa demasiado (máximo 500 KB).'));
    const fr = new FileReader();
    fr.onload = () => {
      const dataUrl = String(fr.result || '');
      const img = new Image();
      img.onload = () => resolve({
        dataUrl,
        b64: dataUrl.replace(/^data:[^;]+;base64,/, ''),
        mime: file.type || 'image/png',
        w: img.naturalWidth || null,
        h: img.naturalHeight || null,
      });
      img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      img.src = dataUrl;
    };
    fr.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    fr.readAsDataURL(file);
  });
}

/* ---------- render principal ---------- */
export async function renderCertSigners(user) {
  USER = user;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="csg-head"><div><h1>Firmantes</h1>
      <p>Personas autorizadas a firmar constancias de trabajo. Cada firmante tiene su cargo y su firma digitalizada.</p></div></div>
    <div class="pnl-loading" style="margin-top:18px">Cargando…</div>`;
  await fetchAll();
  paint();
}

function counts() {
  return {
    todos: ROWS.length,
    activos: ROWS.filter(r => r.is_active).length,
    inactivos: ROWS.filter(r => !r.is_active).length,
  };
}

function paint() {
  const c = counts();
  const chips = [
    ['todos', 'Todos'], ['activos', 'Activos'], ['inactivos', 'Inactivos'],
  ].map(([k, l]) =>
    `<button class="csg-chip ${k === CUR_FILTER ? 'on' : ''}" data-f="${k}">${l} <span class="csg-n">${c[k] || 0}</span></button>`).join('');

  $('#pnlMain').innerHTML = `
    <div class="csg-head"><div><h1>Firmantes</h1>
      <p>Personas autorizadas a firmar constancias de trabajo. Cada firmante tiene su cargo y su firma digitalizada.</p></div>
      <button class="csg-b csg-b-primary" id="csgNew">${plusIco()} Nuevo firmante</button></div>
    <div class="csg-chips" id="csgChips">${chips}</div>
    <div class="card" style="padding:6px 8px"><div id="csgBody"></div></div>`;

  $('#csgChips').querySelectorAll('[data-f]').forEach(b =>
    b.addEventListener('click', () => { CUR_FILTER = b.dataset.f; paint(); }));
  $('#csgNew').addEventListener('click', () => openEditor(null));
  renderTable();
}

function plusIco() {
  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
}
function pencilIco() {
  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
}

function renderTable() {
  const rows = CUR_FILTER === 'activos' ? ROWS.filter(r => r.is_active)
    : CUR_FILTER === 'inactivos' ? ROWS.filter(r => !r.is_active)
      : ROWS;
  const body = $('#csgBody');
  if (!rows.length) {
    body.innerHTML = `<div class="csg-empty">${ROWS.length ? 'No hay firmantes en este filtro.' : 'Aún no hay firmantes. Crea el primero con “Nuevo firmante”.'}</div>`;
    return;
  }
  body.innerHTML = `
    <table class="csg-table">
      <thead><tr>
        <th>Firmante</th><th>Cargo (por defecto)</th><th>Firma</th><th>Estado</th><th style="text-align:right">Acciones</th>
      </tr></thead>
      <tbody>${rows.map(rowHtml).join('')}</tbody>
    </table>`;

  body.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => openEditor(+b.dataset.edit)));
  body.querySelectorAll('[data-toggle]').forEach(b =>
    b.addEventListener('click', () => toggleActive(+b.dataset.toggle)));
}

function rowHtml(r) {
  const sig = r.signature_url
    ? `<div class="csg-sigbox"><img src="${esc(r.signature_url)}" alt="firma"></div>`
    : `<div class="csg-sigbox"><span class="csg-nosig">sin firma</span></div>`;
  const pill = r.is_active
    ? '<span class="csg-pill csg-on">Activo</span>'
    : '<span class="csg-pill csg-off">Inactivo</span>';
  const toggleLabel = r.is_active ? 'Desactivar' : 'Activar';
  return `<tr>
    <td><span class="csg-name">${esc(r.full_name)}</span>
      ${r.created_at ? `<span class="csg-when">desde ${esc(fmtWhen(r.created_at))}</span>` : ''}</td>
    <td><span class="csg-title">${esc(r.title || DEFAULT_TITLE)}</span></td>
    <td class="csg-sigcell">${sig}</td>
    <td>${pill}</td>
    <td><div class="csg-acts">
      <button class="csg-b csg-b-mini" data-edit="${r.id}">${pencilIco()} Editar</button>
      <button class="csg-b csg-b-mini" data-toggle="${r.id}">${toggleLabel}</button>
    </div></td>
  </tr>`;
}

/* ---------- alta / edición ---------- */
function openEditor(id) {
  const row = id ? ROWS.find(r => r.id === id) : null;
  const isEdit = !!row;

  const ov = document.createElement('div');
  ov.className = 'csg-ov';
  ov.innerHTML = `
    <div class="csg-modal">
      <h3>${isEdit ? 'Editar firmante' : 'Nuevo firmante'}</h3>
      <p class="csg-sub">El cargo aparece bajo la firma en la constancia y es el valor por defecto para las constancias de este firmante (se puede ajustar en cada una).</p>

      <label>Nombre del firmante <span style="color:#dc2626">*</span></label>
      <input type="text" id="csgName" maxlength="160" placeholder="ej. Lic. Lusmenia Lezama" value="${isEdit ? esc(row.full_name) : ''}">

      <label>Cargo</label>
      <input type="text" id="csgTitle" maxlength="120" placeholder="${esc(DEFAULT_TITLE)}" value="${isEdit ? esc(row.title || '') : ''}">
      <p class="csg-hint">Si lo dejas vacío, se usará “${esc(DEFAULT_TITLE)}”.</p>

      <label>Firma (imagen)</label>
      <div class="csg-drop" id="csgDrop">
        <div class="csg-drop-t">Arrastra el PNG aquí o haz clic para elegir</div>
        <div class="csg-drop-s">PNG con fondo transparente (ideal) · máx. 500 KB</div>
      </div>
      <input type="file" id="csgFile" accept="image/png,image/webp,image/jpeg" style="display:none">
      <p class="csg-hint">Cómo obtenerla: firma en papel → toma foto o escanea → quita el fondo (app o web) → sube el PNG. O genera una en <a href="https://onlinesignatures.net/es" target="_blank" rel="noopener noreferrer" style="color:var(--brand,#2563eb);font-weight:600">onlinesignatures.net</a>.
        ${isEdit ? 'Si no subes una nueva, se conserva la firma actual.' : ''}</p>

      <div class="csg-preview ${(isEdit && row.signature_url) ? 'on' : ''}" id="csgPv">
        <div class="csg-pv-label">Vista previa sobre el documento</div>
        <div class="csg-pv-doc">
          <div class="csg-pv-sig"><img id="csgPvImg" src="${isEdit && row.signature_url ? esc(row.signature_url) : ''}" alt=""></div>
          <div class="csg-pv-line"></div>
          <div class="csg-pv-nm" id="csgPvNm">${isEdit ? esc(row.full_name) : ''}</div>
          <div class="csg-pv-ti" id="csgPvTi">${isEdit ? esc(row.title || DEFAULT_TITLE) : DEFAULT_TITLE}</div>
        </div>
      </div>

      <div class="csg-err" id="csgErr"></div>
      <div class="csg-foot">
        <button class="csg-b" id="csgCancel">Cancelar</button>
        <button class="csg-b csg-b-primary" id="csgSave">${isEdit ? 'Guardar cambios' : 'Crear firmante'}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const nameEl = ov.querySelector('#csgName');
  const titleEl = ov.querySelector('#csgTitle');
  const fileEl = ov.querySelector('#csgFile');
  const drop = ov.querySelector('#csgDrop');
  const pv = ov.querySelector('#csgPv');
  const pvImg = ov.querySelector('#csgPvImg');
  const pvNm = ov.querySelector('#csgPvNm');
  const pvTi = ov.querySelector('#csgPvTi');
  const errBox = ov.querySelector('#csgErr');
  const saveBtn = ov.querySelector('#csgSave');

  let picked = null;   // { b64, mime, w, h } de la firma nueva, o null

  const showErr = (m) => { errBox.textContent = m; errBox.style.display = m ? 'block' : 'none'; };
  const syncPreviewText = () => {
    pvNm.textContent = nameEl.value.trim() || '—';
    pvTi.textContent = (titleEl.value.trim() || DEFAULT_TITLE);
  };
  nameEl.addEventListener('input', syncPreviewText);
  titleEl.addEventListener('input', syncPreviewText);

  const handleFile = async (file) => {
    showErr('');
    try {
      const sig = await readSignatureFile(file);
      picked = { b64: sig.b64, mime: sig.mime, w: sig.w, h: sig.h };
      pvImg.src = sig.dataUrl;
      pv.classList.add('on');
      syncPreviewText();
    } catch (e) {
      picked = null;
      showErr(e.message || 'No se pudo leer la firma.');
    }
  };

  drop.addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', () => { if (fileEl.files && fileEl.files[0]) handleFile(fileEl.files[0]); });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  const close = () => ov.remove();
  ov.querySelector('#csgCancel').addEventListener('click', close);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });

  saveBtn.addEventListener('click', async () => {
    showErr('');
    const full_name = nameEl.value.trim();
    if (!full_name) { showErr('El nombre del firmante es obligatorio.'); nameEl.focus(); return; }
    const title = titleEl.value.trim();

    saveBtn.disabled = true;
    const orig = saveBtn.textContent;
    saveBtn.textContent = 'Guardando\u2026';

    const payload = { full_name, title: title || null };
    if (picked) {
      payload.signature_b64 = picked.b64;
      payload.signature_mime = picked.mime;
      payload.signature_w = picked.w;
      payload.signature_h = picked.h;
    }
    payload.action = isEdit ? 'update' : 'create';
    if (isEdit) payload.id = row.id;

    const d = await api(payload);
    if (!d.ok) {
      showErr(d.error || 'No se pudo guardar.');
      saveBtn.disabled = false; saveBtn.textContent = orig;
      return;
    }
    close();
    await fetchAll();
    paint();
    toast(isEdit ? 'Firmante actualizado' : 'Firmante creado');
  });

  nameEl.focus();
}

/* ---------- activar / desactivar ---------- */
async function toggleActive(id) {
  const row = ROWS.find(r => r.id === id);
  if (!row) return;
  const turningOff = row.is_active;
  const ok = await confirmModal({
    title: turningOff ? 'Desactivar firmante' : 'Activar firmante',
    bodyHtml: turningOff
      ? `<p>El firmante <span class="csg-strong">${esc(row.full_name)}</span> dejará de aparecer para elegir en nuevas constancias.</p>
         <p>Las constancias ya emitidas no se ven afectadas (guardan una copia del firmante).</p>`
      : `<p>El firmante <span class="csg-strong">${esc(row.full_name)}</span> volverá a estar disponible para nuevas constancias.</p>`,
    okLabel: turningOff ? 'Desactivar' : 'Activar',
    tone: turningOff ? 'danger' : 'default',
  });
  if (!ok) return;
  const d = await api({ action: 'set_active', id, is_active: !row.is_active });
  if (!d.ok) { noticeModal(d.error || 'No se pudo cambiar el estado.'); return; }
  await fetchAll();
  paint();
  toast(turningOff ? 'Firmante desactivado' : 'Firmante activado', 'info');
}
