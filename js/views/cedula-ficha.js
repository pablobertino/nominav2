/* =====================================================================
   cedula-ficha.js — Cédula de identidad (IMAGEN) en la ficha. Fase 1.
   Va en la seccion DOCUMENTOS junto a Referencia Bancaria y RIF.

   La cedula es una FOTO (no un PDF): se captura desde camara/archivo, se
   RECORTA y ROTA en el navegador, se REDIMENSIONA (lado largo 1600px), se
   mejora la legibilidad (auto-contraste + enfoque suave, opcional) y se
   COMPRIME a JPEG (~0.82, adaptativo) para que quede legible y liviana
   (~300-500 KB). Se guarda como DOCUMENTO DE RESPALDO; NO reemplaza la
   cedula de la ficha. Sin OCR en Fase 1 (las cedulas se deterioran).

   Exporta: initCedulaCard(host, w, STATE, onRender)
   ===================================================================== */

const MAX_EDGE = 1600;              // lado largo del guardado
const MAX_OUT_BYTES = 950 * 1024;   // tope duro del JPG final
const Q_STEPS = [0.82, 0.78, 0.72, 0.66, 0.6];
const LOWRES_WARN = 1000;           // aviso si el recorte queda por debajo

/* ---------- API ---------- */
async function docApi(payload) {
  const res = await fetch('/api/personal-doc', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}
function sessUser(u) { return { kind: u.kind, id: u.id || null, companyCode: u.companyCode || null }; }
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
function fmtKB(bytes) { return bytes >= 1024 * 1024 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB'; }

/* ---------- estilos ---------- */
function ensureStyles() {
  if (document.getElementById('ceddoc-styles')) return;
  const st = document.createElement('style');
  st.id = 'ceddoc-styles';
  st.textContent = `
  #cedulaSlot{display:block;width:100%}
  .ced-card{border:1px solid #e5e7eb;border-radius:12px;background:#fbfcfe;padding:13px 15px;margin-top:8px;width:100%}
  .ced-top{display:flex;align-items:center;gap:13px;flex-wrap:wrap}
  .ced-top .sp{flex:1}
  .ced-ic{width:40px;height:40px;border-radius:10px;background:#ecfeff;color:#0891b2;display:flex;align-items:center;justify-content:center;flex:none}
  .ced-ic svg{width:20px;height:20px}
  .ced-thumb{width:66px;height:42px;border-radius:7px;object-fit:cover;border:1px solid #e5e7eb;flex:none;cursor:pointer;background:#eef2f7}
  .ced-body{flex:1;min-width:0}
  .ced-title{font-size:14px;font-weight:700;color:#111827;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
  .ced-sub{color:#6b7280;font-size:12.5px;margin-top:2px;line-height:1.45}
  .ced-badge{font-size:10px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;border-radius:999px;padding:2px 8px}
  .ced-badge.ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534}
  .ced-badge.none{background:#f3f4f6;border:1px solid #e5e7eb;color:#6b7280}
  .ced-none{font-size:12.5px;color:#64748b}
  .ced-lnk{color:#7c3aed;cursor:pointer;font-weight:650;text-decoration:none}
  .ced-lnk:hover{text-decoration:underline}
  .ced-del{color:#dc2626;font-weight:650;cursor:pointer;font-size:12.5px;margin-right:8px}
  .ced-del:hover{text-decoration:underline}
  .ced-btn{border:1px solid #7c3aed;background:#fff;color:#7c3aed;border-radius:9px;padding:7px 13px;font-size:12.5px;font-weight:700;cursor:pointer;display:inline-flex;gap:7px;align-items:center}
  .ced-btn:hover{background:#f5f3ff}
  .ced-btn svg{width:14px;height:14px}
  .ced-help{margin-top:10px;padding-top:10px;border-top:1px dashed #e5e7eb;font-size:12px}

  .ced-ov{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:20px;z-index:9000}
  .ced-modal{background:#fff;border-radius:16px;width:620px;max-width:100%;max-height:94vh;overflow:auto;box-shadow:0 24px 70px rgba(15,23,42,.32);color:#111827}
  .ced-mh{display:flex;align-items:center;gap:11px;padding:16px 20px;border-bottom:1px solid #eceff3}
  .ced-mh .ic{width:34px;height:34px;border-radius:9px;background:#ecfeff;color:#0891b2;display:flex;align-items:center;justify-content:center;flex:none}
  .ced-mh .ic svg{width:18px;height:18px}
  .ced-mh b{font-size:15px}.ced-mh small{display:block;color:#6b7280;font-size:12px}
  .ced-mh .x{margin-left:auto;border:0;background:transparent;color:#6b7280;cursor:pointer;font-size:20px}
  .ced-mb{padding:18px 20px}
  .ced-steps{display:flex;gap:6px;margin-bottom:16px}
  .ced-stp{flex:1;height:5px;border-radius:999px;background:#e5e7eb}.ced-stp.on{background:#7c3aed}
  .ced-srcgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .ced-src{border:2px dashed #e5e7eb;border-radius:13px;padding:22px 14px;text-align:center;cursor:pointer;background:#fff}
  .ced-src:hover{border-color:#7c3aed;background:#f5f3ff}
  .ced-src .big{font-size:26px}.ced-src b{display:block;margin-top:6px;font-size:13.5px}.ced-src span{color:#6b7280;font-size:11.5px}
  .ced-tips{display:flex;gap:9px;align-items:flex-start;background:#fffbeb;border:1px solid #fde68a;border-radius:11px;padding:11px 13px;margin-top:14px;font-size:12px;color:#92400e;line-height:1.5}
  .ced-stage{position:relative;overflow:hidden;background:#0f172a;border-radius:12px;padding:16px;display:flex;align-items:center;justify-content:center;min-height:240px;user-select:none;touch-action:none}
  .ced-cwrap{position:relative;line-height:0}
  .ced-cbox{position:absolute;border:2px solid #fff;box-shadow:0 0 0 9999px rgba(15,23,42,.55);cursor:move}
  .ced-h{position:absolute;width:14px;height:14px;background:#fff;border:1px solid #7c3aed;border-radius:3px}
  .ced-ctrls{display:flex;gap:8px;align-items:center;justify-content:center;margin-top:12px;flex-wrap:wrap}
  .ced-chip{font-size:11.5px;color:#6b7280;background:#f1f5f9;border-radius:999px;padding:4px 10px;font-weight:600}
  .ced-chip b{color:#111827}
  .ced-gbtn{border:1px solid #e5e7eb;background:#fff;border-radius:9px;padding:6px 11px;font-size:12.5px;font-weight:700;color:#374151;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
  .ced-gbtn:hover{background:#f8fafc}
  .ced-gbtn svg{width:15px;height:15px}
  .ced-toggle{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#374151;margin-top:14px;cursor:pointer;user-select:none;font-weight:600}
  .ced-toggle input{width:16px;height:16px}
  .ced-prevrow{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
  .ced-prev{border:1px solid #e5e7eb;border-radius:10px;max-width:320px;width:100%}
  .ced-warn{font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 12px;margin-top:12px;line-height:1.45}
  .ced-info{font-size:12.5px;color:#1e40af;background:#eff6ff;border:1px solid #bfdbfe;border-radius:11px;padding:11px 13px;margin-top:14px;font-weight:600}
  .ced-mf{display:flex;gap:9px;align-items:center;padding:14px 20px;border-top:1px solid #eceff3;background:#fbfcfe}
  .ced-mf .note{font-size:11px;color:#6b7280;margin-right:auto;max-width:280px;line-height:1.4}
  .ced-mf .go{border:1px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:9px;padding:9px 15px;font-weight:700;cursor:pointer}
  .ced-mf .go:disabled{background:#cbd5e1;border-color:#cbd5e1;cursor:not-allowed}
  .ced-mf .cancel{border:1px solid #e5e7eb;background:#fff;color:#374151;border-radius:9px;padding:9px 14px;font-weight:600;cursor:pointer}
  .ced-spin{display:inline-block;width:16px;height:16px;border:2px solid #ddd6fe;border-top-color:#7c3aed;border-radius:50%;animation:cedspin .7s linear infinite;vertical-align:-3px}
  @keyframes cedspin{to{transform:rotate(360deg)}}
  `;
  document.head.appendChild(st);
}

/* ===================== TARJETA EN LA FICHA ===================== */
export async function initCedulaCard(host, w, STATE, onRender) {
  const slot = host.querySelector('#cedulaSlot');
  if (!slot) return;
  ensureStyles();
  const canUpload = !!(STATE.can && STATE.can.cedula);
  const fire = () => { try { if (typeof onRender === 'function') onRender(); } catch (_) { /* noop */ } };

  const render = (docs) => {
    const latest = (docs || []).find(d => d.estado !== 'anulada') || null;
    if (!canUpload && !latest) { slot.innerHTML = ''; fire(); return; }

    let left;
    if (latest) {
      const dat = latest.datos || {};
      const fecha = (latest.created_at || '').slice(0, 10);
      const peso = dat.bytes ? ' · ' + fmtKB(dat.bytes) : '';
      left = `
        <img class="ced-thumb" id="cedThumb" alt="cédula" data-path="${esc(latest.storage_path || '')}">
        <div class="ced-body">
          <div class="ced-title">Cédula de identidad <span class="ced-badge ok">cargada</span></div>
          <div class="ced-sub">Imagen cargada el ${esc(fecha)}${peso} · <span class="ced-lnk" data-ced="view" data-path="${esc(latest.storage_path || '')}">Ver imagen</span></div>
        </div>`;
    } else {
      left = `
        <div class="ced-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8.5" cy="11" r="2"/><path d="M5.5 16c.6-1.2 1.7-1.8 3-1.8s2.4.6 3 1.8"/><path d="M14 10h5M14 13.5h4"/></svg></div>
        <div class="ced-body">
          <div class="ced-title">Cédula de identidad <span class="ced-badge none">sin cargar</span></div>
          <div class="ced-sub">Adjunta una foto de la cédula. La recortamos y comprimimos para que quede legible y liviana.</div>
        </div>`;
    }
    const UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
    const btn = canUpload
      ? `<button class="ced-btn" data-ced="upload">${UP} ${latest ? 'Cargar / reemplazar' : 'Cargar cédula'}</button>`
      : '';
    const delLink = (latest && canUpload) ? `<a class="ced-del" data-ced="del" data-id="${latest.id}">Quitar</a>` : '';

    slot.innerHTML = `
      <div class="ced-card">
        <div class="ced-top">${left}<span class="sp"></span>${delLink}${btn}</div>
        <div class="ced-help"><a class="ced-lnk" href="/guias/foto-cedula.html" target="_blank" rel="noopener">¿Cómo fotografiar la cédula? ↗</a></div>
      </div>`;

    const up = slot.querySelector('[data-ced="upload"]');
    if (up) up.addEventListener('click', () => openUploadModal(w, STATE, () => refresh()));
    const del = slot.querySelector('[data-ced="del"]');
    if (del) del.addEventListener('click', () => removeDoc(STATE, del.dataset.id, () => refresh()));
    slot.querySelectorAll('[data-ced="view"]').forEach(el => el.addEventListener('click', () => viewImg(STATE, el.dataset.path)));
    const thumb = slot.querySelector('#cedThumb');
    if (thumb) {
      thumb.addEventListener('click', () => viewImg(STATE, thumb.dataset.path));
      signUrl(STATE, thumb.dataset.path).then(u => { if (u) thumb.src = u; });
    }
    fire();
  };

  const refresh = async () => {
    try {
      const r = await docApi({ action: 'list', id_number: w.id_number, doc_type: 'cedula', user: sessUser(STATE.user) });
      render(r && r.ok ? r.documents : []);
    } catch (_) { render([]); }
  };

  render(null);
  refresh();
}

async function signUrl(STATE, path) {
  if (!path) return null;
  try { const r = await docApi({ action: 'sign', storage_path: path, user: sessUser(STATE.user) }); return (r && r.ok) ? r.signed_url : null; }
  catch (_) { return null; }
}
async function viewImg(STATE, path) {
  const u = await signUrl(STATE, path);
  if (u) window.open(u, '_blank', 'noopener'); else alert('No se pudo abrir la imagen. Intenta de nuevo.');
}
async function removeDoc(STATE, id, done) {
  const n = parseInt(id, 10);
  if (!n) return;
  if (!confirm('¿Quitar esta cédula de la ficha? Podés volver a cargar otra cuando quieras.')) return;
  try {
    const r = await docApi({ action: 'annul', id: n, user: sessUser(STATE.user) });
    if (r && r.ok) { if (done) done(); }
    else alert('No se pudo quitar: ' + ((r && r.error) || 'error'));
  } catch (e) { alert('No se pudo quitar. Intenta de nuevo.'); }
}

/* ===================== MODAL: captura -> recorte -> confirmar ===================== */
function openUploadModal(w, STATE, onSaved) {
  ensureStyles();
  const ov = document.createElement('div');
  ov.className = 'ced-ov';
  ov.innerHTML = `
    <div class="ced-modal">
      <div class="ced-mh">
        <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8.5" cy="11" r="2"/><path d="M5.5 16c.6-1.2 1.7-1.8 3-1.8s2.4.6 3 1.8"/><path d="M14 10h5M14 13.5h4"/></svg></div>
        <div><b>Cargar cédula de identidad</b><small>${esc(w.full_name || '')} · ${esc((w.ced_kind || 'V') + '-' + w.id_number)}</small></div>
        <button class="x" data-ced-close>×</button>
      </div>
      <div class="ced-mb" id="cedBody"></div>
      <div class="ced-mf" id="cedFoot" style="display:none">
        <span class="note" id="cedNote"></span>
        <button class="cancel" id="cedBack" style="display:none">← Atrás</button>
        <button class="cancel" data-ced-close>Cancelar</button>
        <button class="go" id="cedGo">Continuar</button>
      </div>
      <input type="file" accept="image/*" id="cedFile" style="display:none">
      <input type="file" accept="image/*" capture="environment" id="cedCam" style="display:none">
    </div>`;
  document.body.appendChild(ov);

  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelectorAll('[data-ced-close]').forEach(b => b.addEventListener('click', close));

  const body = ov.querySelector('#cedBody');
  const foot = ov.querySelector('#cedFoot');
  const goBtn = ov.querySelector('#cedGo');
  const backBtn = ov.querySelector('#cedBack');
  const note = ov.querySelector('#cedNote');
  const fileInput = ov.querySelector('#cedFile');
  const camInput = ov.querySelector('#cedCam');

  // estado del editor
  let img = null, rot = 0, enhance = true;
  let stageScale = 1, rotW = 0, rotH = 0;
  let box = { x: 0, y: 0, w: 0, h: 0 };  // en px del stage

  fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });
  camInput.addEventListener('change', () => { if (camInput.files[0]) loadFile(camInput.files[0]); });

  stepSource();

  function stepSource() {
    foot.style.display = 'none';
    body.innerHTML = `
      <div class="ced-steps"><div class="ced-stp on"></div><div class="ced-stp"></div><div class="ced-stp"></div></div>
      <div class="ced-srcgrid">
        <div class="ced-src" data-pick="cam"><div class="big">📷</div><b>Tomar foto</b><span>abre la cámara</span></div>
        <div class="ced-src" data-pick="file"><div class="big">🖼️</div><b>Elegir archivo</b><span>una foto ya tomada</span></div>
      </div>
      <div class="ced-tips"><span>💡</span><span><b>Para que se lea bien:</b> sin flash (evita el reflejo del plástico), sobre una superficie mate y oscura, llenando el encuadre, con buena luz y de frente. Ver el <b>tutorial completo</b> desde la ficha.</span></div>`;
    body.querySelector('[data-pick="cam"]').addEventListener('click', () => camInput.click());
    body.querySelector('[data-pick="file"]').addEventListener('click', () => fileInput.click());
  }

  function loadFile(file) {
    if (!file.type || !/^image\//.test(file.type)) { body.innerHTML = `<div class="ced-warn">Ese archivo no es una imagen. Subí una foto de la cédula (JPG o PNG).</div>`; return; }
    if (file.size > 15 * 1024 * 1024) { body.innerHTML = `<div class="ced-warn">La imagen supera 15 MB. Reducila un poco y volvé a intentar.</div>`; return; }
    body.innerHTML = `<div style="text-align:center;padding:30px;color:#64748b"><span class="ced-spin"></span> Cargando la imagen…</div>`;
    // La CSP del portal es default-src 'self': un blob: (createObjectURL) se
    // bloquea al asignarlo a <img>. Usamos FileReader -> data: (mismo patron
    // probado en la foto carnet), que sí está permitido.
    const fr = new FileReader();
    fr.onload = () => {
      const im = new Image();
      im.onload = () => { img = im; rot = 0; stepCrop(); };
      im.onerror = () => { body.innerHTML = `<div class="ced-warn">No se pudo abrir la imagen. Si es una foto de iPhone (formato HEIC), guardala o compartila como <b>JPG</b> y volvé a intentar.</div>`; };
      im.src = fr.result;
    };
    fr.onerror = () => { body.innerHTML = `<div class="ced-warn">No se pudo leer el archivo.</div>`; };
    fr.readAsDataURL(file);
  }

  function rotatedSize() {
    const swap = (rot % 180) !== 0;
    return { w: swap ? img.height : img.width, h: swap ? img.width : img.height };
  }

  function stepCrop() {
    const rs = rotatedSize(); rotW = rs.w; rotH = rs.h;
    const maxW = 520, maxH = 300;
    stageScale = Math.min(maxW / rotW, maxH / rotH, 1);
    const dw = Math.round(rotW * stageScale), dh = Math.round(rotH * stageScale);

    body.innerHTML = `
      <div class="ced-steps"><div class="ced-stp on"></div><div class="ced-stp on"></div><div class="ced-stp"></div></div>
      <div class="ced-stage">
        <div class="ced-cwrap" id="cedWrap" style="width:${dw}px;height:${dh}px">
          <canvas id="cedCanvas" width="${dw}" height="${dh}" style="width:${dw}px;height:${dh}px;border-radius:6px"></canvas>
          <div class="ced-cbox" id="cedCbox">
            <div class="ced-h" data-h="nw" style="left:-8px;top:-8px"></div>
            <div class="ced-h" data-h="ne" style="right:-8px;top:-8px"></div>
            <div class="ced-h" data-h="sw" style="left:-8px;bottom:-8px"></div>
            <div class="ced-h" data-h="se" style="right:-8px;bottom:-8px"></div>
          </div>
        </div>
      </div>
      <div class="ced-ctrls">
        <button class="ced-gbtn" data-rot="-90" title="Girar a la izquierda"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg> Izquierda</button>
        <button class="ced-gbtn" data-rot="90" title="Girar a la derecha">Derecha <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
        <span class="ced-chip">Arrastrá las esquinas para recortar al borde de la cédula</span>
      </div>`;

    // dibujar la imagen rotada en el canvas del stage
    const canvas = body.querySelector('#cedCanvas');
    drawRotatedTo(canvas, dw, dh);

    // caja inicial: margen del 8%
    box = { x: dw * 0.08, y: dh * 0.08, w: dw * 0.84, h: dh * 0.84 };
    const cbox = body.querySelector('#cedCbox');
    layoutBox(cbox);
    wireCrop(body.querySelector('#cedWrap'), cbox, dw, dh);

    body.querySelectorAll('[data-rot]').forEach(b => b.addEventListener('click', () => { rot = (rot + parseInt(b.dataset.rot, 10) + 360) % 360; stepCrop(); }));

    foot.style.display = 'flex';
    note.innerHTML = 'Se comprime en el navegador; no sube el archivo pesado.';
    backBtn.style.display = ''; backBtn.textContent = '← Cambiar foto'; backBtn.onclick = stepSource;
    goBtn.textContent = 'Continuar';
    goBtn.disabled = false;
    goBtn.onclick = stepConfirm;
  }

  function drawRotatedTo(canvas, dw, dh) {
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    // trasladar/rotar para pintar la imagen escalada a dw x dh (ya rotada)
    if (rot === 90) { ctx.translate(dw, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(img, 0, 0, dh, dw); }
    else if (rot === 180) { ctx.translate(dw, dh); ctx.rotate(Math.PI); ctx.drawImage(img, 0, 0, dw, dh); }
    else if (rot === 270) { ctx.translate(0, dh); ctx.rotate(-Math.PI / 2); ctx.drawImage(img, 0, 0, dh, dw); }
    else { ctx.drawImage(img, 0, 0, dw, dh); }
    ctx.restore();
  }

  function layoutBox(cbox) {
    cbox.style.left = box.x + 'px'; cbox.style.top = box.y + 'px';
    cbox.style.width = box.w + 'px'; cbox.style.height = box.h + 'px';
  }

  function wireCrop(wrap, cbox, dw, dh) {
    const MIN = 40;
    let mode = null, hd = null, start = null;
    const onDown = (e, m, h) => { mode = m; hd = h; start = pt(e); start.box = { ...box }; e.preventDefault(); document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp); };
    const pt = e => ({ x: (e.touches ? e.touches[0].clientX : e.clientX), y: (e.touches ? e.touches[0].clientY : e.clientY) });
    const onMove = (e) => {
      if (!mode) return;
      const p = pt(e); const dx = p.x - start.x, dy = p.y - start.y; const b = start.box;
      if (mode === 'move') {
        box.x = clamp(b.x + dx, 0, dw - b.w); box.y = clamp(b.y + dy, 0, dh - b.h); box.w = b.w; box.h = b.h;
      } else {
        let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
        if (hd.indexOf('w') >= 0) x1 = clamp(b.x + dx, 0, x2 - MIN);
        if (hd.indexOf('e') >= 0) x2 = clamp(b.x + b.w + dx, x1 + MIN, dw);
        if (hd.indexOf('n') >= 0) y1 = clamp(b.y + dy, 0, y2 - MIN);
        if (hd.indexOf('s') >= 0) y2 = clamp(b.y + b.h + dy, y1 + MIN, dh);
        box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
      layoutBox(cbox);
    };
    const onUp = () => { mode = null; document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
    cbox.addEventListener('pointerdown', e => { if (e.target === cbox) onDown(e, 'move', null); });
    cbox.querySelectorAll('.ced-h').forEach(h => h.addEventListener('pointerdown', e => { e.stopPropagation(); onDown(e, 'resize', h.dataset.h); }));
  }

  function stepConfirm() {
    // recorte en px de la imagen rotada full-res
    const sx = box.x / stageScale, sy = box.y / stageScale, sw = box.w / stageScale, sh = box.h / stageScale;
    const longSrc = Math.max(sw, sh);
    const scale = Math.min(MAX_EDGE / longSrc, 1);
    const outW = Math.max(1, Math.round(sw * scale)), outH = Math.max(1, Math.round(sh * scale));

    // canvas full-res de la imagen rotada, para recortar con calidad
    const rc = document.createElement('canvas'); rc.width = rotW; rc.height = rotH;
    drawRotatedTo(rc, rotW, rotH);

    const out = document.createElement('canvas'); out.width = outW; out.height = outH;
    const octx = out.getContext('2d'); octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = 'high';
    octx.drawImage(rc, sx, sy, sw, sh, 0, 0, outW, outH);

    if (enhance) enhanceCanvas(out);

    const { dataUrl, bytes, quality } = exportJpeg(out);
    const lowres = longSrc < LOWRES_WARN;

    body.innerHTML = `
      <div class="ced-steps"><div class="ced-stp on"></div><div class="ced-stp on"></div><div class="ced-stp on"></div></div>
      <div class="ced-prevrow">
        <img class="ced-prev" id="cedPrev" src="${dataUrl}" alt="cédula recortada">
        <div style="flex:1;min-width:170px">
          <div style="font-size:13px;font-weight:700;margin-bottom:6px">Lista para guardar</div>
          <span class="ced-chip" id="cedMeta">${fmtKB(bytes)} · ${outW}×${outH} · JPG</span>
          <label class="ced-toggle"><input type="checkbox" id="cedEnh" ${enhance ? 'checked' : ''}> Mejorar legibilidad <span style="font-weight:400;color:#6b7280">(contraste + enfoque)</span></label>
          <div style="font-size:12px;color:#6b7280;line-height:1.5;margin-top:8px">Recortada y comprimida. Queda como <b>documento de respaldo</b>; un responsable la revisa visualmente.</div>
        </div>
      </div>
      ${lowres ? `<div class="ced-warn"><b>Baja resolución:</b> la cédula quedó chica (${Math.round(longSrc)} px). Se puede guardar, pero para que se lea mejor conviene acercarse más y repetir la foto.</div>` : ''}
      <div class="ced-info">Se guarda como respaldo. La cédula de la ficha no se toca; esta imagen es solo el soporte.</div>`;

    // guardar el ultimo render para el save
    let current = { dataUrl, bytes, quality, outW, outH };

    const enhChk = body.querySelector('#cedEnh');
    enhChk.addEventListener('change', () => {
      enhance = enhChk.checked;
      const out2 = document.createElement('canvas'); out2.width = outW; out2.height = outH;
      const c2 = out2.getContext('2d'); c2.imageSmoothingQuality = 'high';
      c2.drawImage(rc, sx, sy, sw, sh, 0, 0, outW, outH);
      if (enhance) enhanceCanvas(out2);
      const r2 = exportJpeg(out2);
      current = { dataUrl: r2.dataUrl, bytes: r2.bytes, quality: r2.quality, outW, outH };
      body.querySelector('#cedPrev').src = r2.dataUrl;
      body.querySelector('#cedMeta').textContent = `${fmtKB(r2.bytes)} · ${outW}×${outH} · JPG`;
    });

    foot.style.display = 'flex';
    note.textContent = '';
    backBtn.style.display = ''; backBtn.textContent = '← Volver a recortar'; backBtn.onclick = stepCrop;
    goBtn.textContent = 'Guardar cédula';
    goBtn.disabled = false;
    goBtn.onclick = () => doSave(current);
  }

  async function doSave(cur) {
    goBtn.disabled = true; goBtn.innerHTML = '<span class="ced-spin"></span> Guardando…';
    const payload = {
      action: 'save', user: sessUser(STATE.user), id_number: w.id_number, doc_type: 'cedula',
      mime: 'image/jpeg',
      datos: { bytes: cur.bytes, width: cur.outW, height: cur.outH, quality: cur.quality, enhanced: enhance },
      validaciones: {},
      pdf_base64: cur.dataUrl,   // el endpoint acepta data URL y quita el prefijo
    };
    try {
      const r = await docApi(payload);
      if (r && r.ok) { if (onSaved) onSaved(); close(); }
      else { body.insertAdjacentHTML('beforeend', `<div class="ced-warn">No se pudo guardar: ${esc((r && r.error) || 'error')}</div>`); goBtn.disabled = false; goBtn.textContent = 'Reintentar'; }
    } catch (e) {
      body.insertAdjacentHTML('beforeend', `<div class="ced-warn">No se pudo guardar: ${esc(String(e && e.message || e))}</div>`); goBtn.disabled = false; goBtn.textContent = 'Reintentar';
    }
  }
}

/* ---------- helpers de imagen ---------- */
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// export JPEG con calidad adaptativa para entrar bajo el tope
function exportJpeg(canvas) {
  let last = null;
  for (const q of Q_STEPS) {
    const dataUrl = canvas.toDataURL('image/jpeg', q);
    const bytes = Math.round((dataUrl.length - (dataUrl.indexOf(',') + 1)) * 3 / 4);
    last = { dataUrl, bytes, quality: q };
    if (bytes <= MAX_OUT_BYTES) return last;
  }
  return last;
}

// auto-contraste (estira el histograma de luminancia) + enfoque suave
function enhanceCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  autoContrast(id);
  const sharp = sharpen(id, canvas.width, canvas.height, 0.35);
  ctx.putImageData(sharp, 0, 0);
}

function autoContrast(id) {
  const d = id.data, n = d.length, hist = new Uint32Array(256);
  for (let i = 0; i < n; i += 4) {
    const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    hist[l]++;
  }
  const total = n / 4;
  const loCut = total * 0.005, hiCut = total * 0.995;
  let cum = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= loCut) { lo = v; break; } }
  cum = 0; for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= hiCut) { hi = v; break; } }
  if (hi <= lo) return;
  const scale = 255 / (hi - lo);
  for (let i = 0; i < n; i += 4) {
    d[i] = clamp((d[i] - lo) * scale, 0, 255);
    d[i + 1] = clamp((d[i + 1] - lo) * scale, 0, 255);
    d[i + 2] = clamp((d[i + 2] - lo) * scale, 0, 255);
  }
}

// enfoque suave: kernel [0,-a,0,-a,1+4a,-a,0,-a,0] (suma 1)
function sharpen(id, w, h, a) {
  const src = id.data;
  const out = new ImageData(w, h);
  const dst = out.data;
  const c = 1 + 4 * a;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const up = y > 0 ? src[i - w * 4 + k] : src[i + k];
        const dn = y < h - 1 ? src[i + w * 4 + k] : src[i + k];
        const lf = x > 0 ? src[i - 4 + k] : src[i + k];
        const rt = x < w - 1 ? src[i + 4 + k] : src[i + k];
        dst[i + k] = clamp(c * src[i + k] - a * (up + dn + lf + rt), 0, 255);
      }
      dst[i + 3] = src[i + 3];
    }
  }
  return out;
}
