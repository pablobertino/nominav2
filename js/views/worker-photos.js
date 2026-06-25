/* =====================================================================
   js/views/worker-photos.js  →  vista "Personal"
   Directorio de personal de UNA empresa: grid de tarjetas con foto +
   ficha completa por colaborador (ver / editar) para llenar workers_master.

   Foto: se comprime EN EL NAVEGADOR a dos versiones cuadradas (recorte
   centrado) desde el original:
     - miniatura 300x300  -> grid y cabecera de la ficha (liviana).
     - grande   800x800   -> visor ampliado y export a AX (nitida).
   Ambas viajan en base64 a /api/worker-photo (accion 'save'); el endpoint
   las sube al Storage privado 'worker-photos' y guarda rutas+metadatos en
   workers_master (tabla maestra por cedula, sin empresa).

   Datos de la persona (nacimiento, genero, banco, contacto...) se editan
   en la ficha y se guardan con la accion 'save_profile' (PATCH a
   workers_master). El Data ID es de la empresa (solo lectura).

   Acceso:
     - tienda: ve su propio roster (companyCode de la sesion).
     - admin/superadmin: eligen empresa primero; el acceso se revalida
       server-side.

   Exporta renderWorkerPhotos(user, companyCode, onExit?), que pinta la
   vista dentro de #pnlMain.
   ===================================================================== */

import { $ } from '../core/dom.js';
import { parseReport10, validateParsed, rosterReplace, rosterClear, rosterAddManual, rosterAgeDays, splitFullName } from '../reports/shared/roster.js';
import { parseReporteAX, validateReporteAX, enterpriseRosterReplace, enterpriseRosterClear } from '../reports/shared/roster-ax.js';

const THUMB = 300;           // miniatura cuadrada (grid)
const FULL = 800;            // version grande cuadrada (visor / AX)
const THUMB_QUALITY = 0.72;
const FULL_QUALITY = 0.82;

/* ---------- API ---------- */
async function api(payload) {
  const res = await fetch('/api/worker-photo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}
function sessionUserPayload(user) {
  return { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null };
}

/* ---------- Compresion en el navegador ---------- */
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const fr = new FileReader();
    fr.onload = () => { img.onload = () => resolve(img); img.onerror = reject; img.src = fr.result; };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}
// Recorte cuadrado centrado a sidexside (mantiene la cara del centro).
function squareCrop(img, side, quality) {
  const s = Math.min(img.width, img.height);
  const sx = (img.width - s) / 2, sy = (img.height - s) / 2;
  const cv = document.createElement('canvas');
  cv.width = side; cv.height = side;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, side, side);
  cx.drawImage(img, sx, sy, s, s, 0, 0, side, side);
  return cv.toDataURL('image/jpeg', quality);
}
function b64Bytes(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  return Math.round(b64.length * 0.75);
}
function stripPrefix(dataUrl) { return String(dataUrl).split(',')[1] || ''; }

/* ---------- Circulo guia (SVG superpuesto) ---------- */
function guideSvg() {
  return `<svg class="wp-guide" viewBox="0 0 100 100" preserveAspectRatio="none"><defs><mask id="wpmc"><rect width="100" height="100" fill="white"/><circle cx="50" cy="50" r="32" fill="black"/></mask></defs><rect width="100" height="100" fill="rgba(15,23,42,0.34)" mask="url(#wpmc)"/><circle cx="50" cy="50" r="32" fill="none" stroke="#fff" stroke-width="0.8" stroke-dasharray="3 2"/></svg>`;
}

/* ---------- helpers ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtDate(iso) {
  if (!iso) return '';
  const d = String(iso).slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : iso;
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return iso;
  const c = new Date(d.getTime() - 4 * 3600 * 1000);
  const z = n => String(n).padStart(2, '0');
  return `${z(c.getUTCDate())}/${z(c.getUTCMonth() + 1)}/${c.getUTCFullYear()} ${z(c.getUTCHours())}:${z(c.getUTCMinutes())}`;
}
function ageFrom(ymd) {
  if (!ymd) return null;
  const t = new Date(), b = new Date(ymd);
  let a = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
  return a;
}
function phoneNat(e164) { if (!e164) return ''; let s = String(e164).replace(/[^\d+]/g, ''); if (s.startsWith('+58')) s = '0' + s.slice(3); return s; }
function phoneDisplay(e164) { const s = phoneNat(e164); return /^\d{11}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4) : (e164 || ''); }
const GEN = { M: 'Masculino', F: 'Femenino' };
const CIV = { S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a' };

/* Iniciales para el avatar "sin foto": primera letra del primer nombre y
   primera del primer apellido. Si solo hay una palabra, usa sus dos primeras
   letras. Sirve para dar identidad visual aunque falte la foto. */
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
/* Color de fondo suave estable por cedula (mismo color siempre para la misma
   persona). Paleta clara y discreta, en armonia con los tokens del portal. */
const AVATAR_BG = ['#dbeafe', '#fae8ff', '#dcfce7', '#fef9c3', '#fee2e2', '#e0e7ff', '#ccfbf1', '#ffedd5'];
const AVATAR_FG = ['#1e40af', '#86198f', '#166534', '#854d0e', '#991b1b', '#3730a3', '#0f766e', '#9a3412'];
function avatarColor(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % AVATAR_BG.length;
}

/* Barra de contexto de empresa (codigo + razon social + RIF/zona/subzona/
   concepto + estado). Compartida por la LISTA y la FICHA para que en ambas
   se vea siempre a que empresa pertenece el personal. */
function companyBarHtml(c) {
  c = c || {};
  const statusPill = /abier/i.test(c.status || '')
    ? '<span class="pill pill-open">Abierta</span>'
    : (c.status ? `<span class="pill pill-gray">${esc(c.status)}</span>` : '');
  return `<div class="ff-emp">
      <div class="ff-emp-main">
        <span class="ff-emp-code">${esc(c.code || '')}</span>
        <span class="ff-emp-name">${esc(c.business_name || '')}</span>
      </div>
      ${c.tax_id ? `<span class="ff-emp-item"><span class="k">RIF</span>${esc(c.tax_id)}</span>` : ''}
      ${c.zone ? `<span class="ff-emp-item"><span class="k">Zona</span>${esc(c.zone)}</span>` : ''}
      ${c.subzone ? `<span class="ff-emp-item"><span class="k">Subzona</span>${esc(c.subzone)}</span>` : ''}
      ${c.concept ? `<span class="ff-emp-item"><span class="k">Concepto</span>${esc(c.concept)}</span>` : ''}
      ${statusPill}
    </div>`;
}

/* ===================== ESTADO ===================== */
let STATE = null;   // { user, cc, onExit, workers, q, company, banks, bankMap, mode, adminId }

/* ===================== ENTRADA ===================== */
/* opts.mode: 'store' (tienda, Reporte 10) | 'enterprise' (empresa no-tienda,
   Reporte AX). En modo enterprise la carga de lista usa /api/enterprise-roster
   (solo admin/superadmin) y se manda el adminId. La foto y la ficha van igual
   a /api/worker-photo (workers_master por cedula), que ya es tabla-aware. */
export async function renderWorkerPhotos(user, companyCode, onExit, opts) {
  const mode = (opts && opts.mode) === 'enterprise' ? 'enterprise' : 'store';
  const adminId = user && user.kind === 'admin' ? (user.id || null) : null;
  STATE = { user, cc: companyCode, onExit: onExit || null, workers: [], q: '', company: null, bankMap: {}, mode, adminId };

  const back = onExit
    ? `<button class="btn" id="wpBack" style="margin-bottom:14px">← Volver</button>`
    : '';

  $('#pnlMain').innerHTML = `
    <div id="wpGridView">
      ${back}
      <div id="wpEmpBar"></div>
      <div class="pnl-head">
        <div><h1>Personal</h1><p id="wpInfo">Cargando personal de ${esc(companyCode)}…</p></div>
        <div class="head-actions">
          <button class="btn" id="wpReporte"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Actualizar lista</button>
          ${mode === 'enterprise' ? '' : `<button class="btn btn-primary" id="wpAddManual"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg> Agregar</button>`}
          <button class="btn wp-btn-danger" id="wpClear"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Limpiar lista</button>
        </div>
      </div>
      <div id="wpRosterBar" class="wp-rosterbar" style="display:none"></div>
      <div class="pnl-filters">
        <div class="search"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><input id="wpSearch" placeholder="Buscar por nombre o cédula…"></div>
      </div>
      <div id="wpGrid" class="wp-grid"><div class="pnl-loading">Cargando…</div></div>
    </div>
    <div id="wpFichaHost"></div>
    <div id="wpModalHost"></div>`;

  if (onExit) $('#wpBack').addEventListener('click', onExit);
  $('#wpSearch').addEventListener('input', e => { STATE.q = e.target.value; paintGrid(); });
  $('#wpReporte').addEventListener('click', STATE.mode === 'enterprise' ? openReporteAXModal : openReporteModal);
  const addBtn = $('#wpAddManual');
  if (addBtn) addBtn.addEventListener('click', openAddManualModal);
  $('#wpClear').addEventListener('click', openClearModal);

  await load();
}

/* Carga (o recarga) el directorio de la empresa y repinta grid + barra.
   Se llama al entrar y despues de cada accion de gestion (actualizar lista,
   agregar manual, limpiar). */
async function load() {
  const d = await api({ action: 'directory', company_code: STATE.cc, user: sessionUserPayload(STATE.user) });
  if (!d.ok) {
    $('#wpGrid').innerHTML = `<div class="card"><p class="muted" style="margin:0">No se pudo cargar: ${esc(d.error || 'error')}</p></div>`;
    $('#wpInfo').textContent = 'Error al cargar';
    return;
  }
  STATE.workers = d.workers || [];
  STATE.company = d.company || { code: STATE.cc };
  STATE.bankMap = d.bank_map || {};
  STATE.meta = d.meta || null;
  STATE.manualCount = d.manual_count || 0;
  STATE.reportCount = d.report_count != null ? d.report_count : (STATE.workers.length - STATE.manualCount);
  const empBar = $('#wpEmpBar');
  if (empBar) empBar.innerHTML = companyBarHtml(STATE.company);
  updateInfo(d);
  paintRosterBar();
  paintGrid();
}

/* Barra de estado del roster: cuando se cargo el Reporte 10, cuantos del
   reporte + cuantos manuales, y aviso si la lista esta vieja. */
function paintRosterBar() {
  const bar = $('#wpRosterBar');
  if (!bar) return;
  const meta = STATE.meta;
  const manual = STATE.manualCount || 0;
  const report = STATE.reportCount || 0;
  if (!meta && !STATE.workers.length) {
    bar.style.display = 'none';
    return;
  }
  let when = 'sin registro de carga';
  let ageTxt = '';
  if (meta && meta.uploaded_at) {
    const d = new Date(meta.uploaded_at);
    if (!isNaN(d)) {
      const c = new Date(d.getTime() - 4 * 3600 * 1000);
      const z = n => String(n).padStart(2, '0');
      when = `${z(c.getUTCDate())}/${z(c.getUTCMonth() + 1)}/${c.getUTCFullYear()}`;
    }
    const age = rosterAgeDays(meta);
    if (age != null) {
      if (age <= 0) ageTxt = '<span class="rb-ok">al día</span>';
      else if (age <= 7) ageTxt = `<span class="rb-ok">hace ${age} día${age === 1 ? '' : 's'}</span>`;
      else ageTxt = `<span class="rb-old">⚠ hace ${age} días — conviene actualizar</span>`;
    }
  }
  bar.style.display = 'flex';
  const repName = STATE.mode === 'enterprise' ? 'Reporte AX' : 'Reporte 10';
  bar.innerHTML = `
    <span class="rb-ic">📋</span>
    <span>Lista cargada del <b>${repName}</b> el <b>${when}</b> · <b>${report}</b> del reporte${manual ? ` + <b>${manual}</b> manual${manual === 1 ? '' : 'es'}` : ''}</span>
    ${ageTxt ? `<span class="rb-sep"></span>${ageTxt}` : ''}`;
}

function updateInfo(d) {
  const total = d.total != null ? d.total : STATE.workers.length;
  const withPhoto = d.with_photo != null ? d.with_photo : STATE.workers.filter(w => w.has_photo).length;
  const el = $('#wpInfo');
  if (el) el.innerHTML = `${total} colaboradores · <b style="color:var(--success)">${withPhoto} con foto</b> · ${total - withPhoto} pendientes`;
}

function bankName(acc) {
  if (!acc) return null;
  return STATE.bankMap[String(acc).slice(0, 4)] || null;
}

/* ===================== GRID ===================== */
function paintGrid() {
  const grid = $('#wpGrid');
  if (!grid) return;
  const q = (STATE.q || '').toLowerCase().trim();
  const list = STATE.workers.filter(w =>
    !q || (w.full_name || '').toLowerCase().includes(q) || (w.id_number || '').includes(q));

  grid.innerHTML = list.map(w => {
    const ci = avatarColor(w.id_number);
    const photo = w.thumb_url
      ? `<img src="${w.thumb_url}" alt="${esc(w.full_name)}" loading="lazy">`
      : `<div class="wp-empty">`
        + `<div class="wp-initials" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(w.full_name))}</div>`
        + `<span class="wp-nophoto"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>Sin foto</span>`
        + `</div>`;
    const badge = w.has_photo
      ? '<span class="wp-badge has">✓ cargada</span>'
      : '<span class="wp-badge no">pendiente</span>';
    const egr = w.end_date ? `<span class="pill pill-out" style="margin-top:4px;display:inline-block">egresó ${fmtDate(w.end_date)}</span>` : '';
    const manualTag = w.source === 'manual' ? '<span class="pill wp-pill-manual" style="margin-top:4px;display:inline-block">manual</span>' : '';
    return `<div class="wp-card" data-ced="${w.id_number}">
      <div class="wp-photo">${photo}${badge}<div class="wp-ov"><span>Ver ficha</span></div></div>
      <div class="wp-body">
        <p class="wp-name">${esc(w.full_name)}</p>
        <span class="wp-ced">${w.ced_kind || ''}-${w.id_number}</span>
        ${w.role ? `<div class="wp-role">${esc(w.role)}</div>` : ''}
        ${egr}${manualTag}
      </div>
    </div>`;
  }).join('') || '<div class="card"><p class="muted" style="margin:0">Sin coincidencias.</p></div>';

  grid.querySelectorAll('.wp-card').forEach(el =>
    el.addEventListener('click', () => openFicha(el.dataset.ced)));
}

/* ===================== FICHA (página) ===================== */
let CUR = null;

function setVal(host, key, text) {
  const el = host.querySelector(`[data-v="${key}"]`);
  if (!el) return;
  const empty = (text == null || text === '');
  el.textContent = empty ? 'Sin dato' : text;
  el.classList.toggle('empty', empty);
}

function openFicha(ced) {
  const w = STATE.workers.find(x => String(x.id_number) === String(ced));
  if (!w) return;
  CUR = w;
  const c = STATE.company || {};

  const host = $('#wpFichaHost');
  host.innerHTML = fichaHtml(w, c);
  $('#wpGridView').style.display = 'none';

  // Cabecera: foto + clic para ver grande
  const ph = host.querySelector('#ffPh');
  if (w.thumb_url) {
    const img = document.createElement('img'); img.src = w.thumb_url;
    ph.insertBefore(img, ph.firstChild);
    ph.classList.add('has');
    ph.addEventListener('click', () => {
      if (host.querySelector('#wpFicha').classList.contains('editing')) return;
      openLightbox(w.full_url || w.thumb_url, `${w.full_name} · ${w.ced_kind}-${w.id_number}`, `${w.ced_kind}-${w.id_number}.jpg`);
    });
  } else {
    const d = document.createElement('div'); d.className = 'noimg'; d.textContent = 'Sin foto';
    ph.insertBefore(d, ph.firstChild);
  }

  paintFichaValues(host, w);
  wireFicha(host, w);
  window.scrollTo(0, 0);
}

function fichaHtml(w, c) {
  const back = STATE.onExit ? 'Volver' : 'Volver a Personal';
  return `
  <div class="wp-ficha" id="wpFicha">
    <button class="ff-back" id="ffBack">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      ${back}
    </button>

    ${companyBarHtml(c)}

    <div class="ff-card">
      <div class="ff-top">
        <div class="ff-ph" id="ffPh"><div class="ff-ph-edit" id="ffPhEdit">Cambiar foto</div></div>
        <div class="ff-id">
          <h2>${esc(w.full_name || '—')}</h2>
          <div class="ced">${w.ced_kind || ''}-${w.id_number}</div>
          <div class="meta"><span class="pill">${esc(w.role || 'Sin cargo')}</span></div>
        </div>
      </div>

      <div class="ff-note" id="ffNote" style="display:none">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span id="ffNoteTxt"></span>
      </div>

      <div class="ff-body">

        <div class="ff-sec">Identidad</div>
        <div class="ff-grid">
          <div class="ff-row full"><span class="ff-lbl">Nombre completo <span class="src excel"><span class="dot"></span></span></span><span class="ff-val" data-v="full_name"></span></div>
          <div class="ff-field full"><label>Primer nombre</label><input id="e_first" type="text"></div>
          <div class="ff-field"><label>Segundo nombre <span class="opt">(opcional)</span></label><input id="e_second" type="text"></div>
          <div class="ff-field full"><label>Apellidos</label><input id="e_last" type="text"></div>

          <div class="ff-row"><span class="ff-lbl">Fecha de nacimiento <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="birth_date"></span></div>
          <div class="ff-row"><span class="ff-lbl">Edad</span><span class="ff-val" data-v="age"></span></div>
          <div class="ff-field"><label>Fecha de nacimiento</label><input id="e_birth" type="date"><div class="ff-hint" id="h_birth"></div></div>
          <div class="ff-field"><label>Edad <span class="opt">(calculada)</span></label><input id="e_age" type="text" readonly></div>

          <div class="ff-row"><span class="ff-lbl">Género <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="gender"></span></div>
          <div class="ff-row"><span class="ff-lbl">Estado civil <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="marital_status"></span></div>
          <div class="ff-field"><label>Género</label><select id="e_gender"><option value="">— Seleccionar —</option><option value="M">M – Masculino</option><option value="F">F – Femenino</option></select></div>
          <div class="ff-field"><label>Estado civil</label><select id="e_marital"><option value="">— Seleccionar —</option><option value="S">S – Soltero/a</option><option value="C">C – Casado/a</option><option value="D">D – Divorciado/a</option><option value="V">V – Viudo/a</option></select></div>
        </div>

        <div class="ff-sec">Cargo</div>
        <div class="ff-grid">
          <div class="ff-row"><span class="ff-lbl">Cargo <span class="src excel"><span class="dot"></span></span></span><span class="ff-val" data-v="role"></span></div>
          <div class="ff-field"><label>Cargo</label><input id="e_role" type="text"></div>
        </div>

        <div class="ff-sec">Datos bancarios</div>
        <div class="ff-grid">
          <div class="ff-row full"><span class="ff-lbl">Cuenta bancaria <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="account_number"></span></div>
          <div class="ff-field full"><label>Número de cuenta <span class="opt">(20 dígitos)</span></label><input id="e_account" type="text" inputmode="numeric" placeholder="01340000000000000000"><div class="ff-hint" id="h_account"></div></div>
        </div>

        <div class="ff-sec">Contacto</div>
        <div class="ff-grid">
          <div class="ff-row"><span class="ff-lbl">Teléfono <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="phone"></span></div>
          <div class="ff-row"><span class="ff-lbl">Correo <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="email"></span></div>
          <div class="ff-field"><label>Teléfono móvil <span class="opt">(04XX-XXXXXXX)</span></label><input id="e_phone" type="text" inputmode="numeric" placeholder="0414-1234567"><div class="ff-hint" id="h_phone"></div></div>
          <div class="ff-field"><label>Correo <span class="opt">(opcional)</span></label><input id="e_email" type="text" placeholder="nombre@correo.com"><div class="ff-hint" id="h_email"></div></div>
          <div class="ff-row full"><span class="ff-lbl">Dirección <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="address"></span></div>
          <div class="ff-field full"><label>Dirección <span class="opt">(opcional)</span></label><input id="e_address" type="text" placeholder="Calle, sector, ciudad"></div>
        </div>

        <div class="ff-sec">Registro</div>
        <div class="ff-grid">
          <div class="ff-row"><span class="ff-lbl">Foto cargada por</span><span class="ff-val" data-v="photo_uploaded_by"></span></div>
          <div class="ff-row"><span class="ff-lbl">Última actualización</span><span class="ff-val" data-v="updated_at"></span></div>
        </div>
      </div>

      <div class="ff-foot">
        <button class="btn btn-ghost-danger" id="ffDel" style="display:none">Quitar foto</button>
        <span style="flex:1"></span>
        <button class="btn" id="ffEdit">Editar</button>
        <button class="btn" id="ffCancel" style="display:none">Cancelar</button>
        <button class="btn btn-primary" id="ffSave" style="display:none">Guardar cambios</button>
      </div>
    </div>

    <p class="ff-legend">La cédula identifica a la persona de forma permanente y no se edita. El nombre completo se arma con el primer/segundo nombre y apellidos. <span class="src excel"><span class="dot"></span> Excel</span> viene del reporte de personal · <span class="src manual"><span class="dot"></span> Manual</span> se captura aquí.</p>
  </div>`;
}

function paintFichaValues(host, w) {
  const age = ageFrom(w.birth_date);
  setVal(host, 'full_name', w.full_name);
  setVal(host, 'birth_date', w.birth_date ? fmtDate(w.birth_date) : '');
  setVal(host, 'age', age != null ? `${age} años` : '');
  setVal(host, 'gender', w.gender ? (GEN[w.gender] || w.gender) : '');
  setVal(host, 'marital_status', w.marital_status ? (CIV[w.marital_status] || w.marital_status) : '');
  setVal(host, 'role', w.role);
  setVal(host, 'account_number', w.account_number ? `${w.account_number}${bankName(w.account_number) ? ' · ' + bankName(w.account_number) : ''}` : '');
  setVal(host, 'phone', w.phone ? phoneDisplay(w.phone) : '');
  setVal(host, 'email', w.email);
  setVal(host, 'address', w.address);
  setVal(host, 'photo_uploaded_by', w.photo_uploaded_by);
  setVal(host, 'updated_at', fmtDateTime(w.updated_at));

  const missing = [];
  if (!w.birth_date) missing.push('nacimiento');
  if (!w.gender) missing.push('género');
  if (!w.marital_status) missing.push('estado civil');
  if (!w.account_number) missing.push('cuenta');
  if (!w.phone) missing.push('teléfono');
  const note = host.querySelector('#ffNote');
  if (missing.length) {
    note.style.display = 'flex';
    host.querySelector('#ffNoteTxt').textContent = `Faltan datos por completar: ${missing.join(', ')}. Tocá Editar para cargarlos.`;
  } else note.style.display = 'none';
}

function wireFicha(host, w) {
  const ficha = host.querySelector('#wpFicha');
  const toView = () => {
    ficha.classList.remove('editing');
    host.querySelector('#ffEdit').style.display = '';
    host.querySelector('#ffCancel').style.display = 'none';
    host.querySelector('#ffSave').style.display = 'none';
    host.querySelector('#ffDel').style.display = 'none';
  };
  const q = s => host.querySelector(s);

  function runValidations() {
    const acc = q('#e_account').value.replace(/\D/g, ''), hA = q('#h_account');
    if (!acc) { hA.textContent = ''; hA.className = 'ff-hint'; }
    else if (acc.length !== 20) { hA.textContent = `Van ${acc.length} de 20 dígitos.`; hA.className = 'ff-hint warn'; }
    else if (!STATE.bankMap[acc.slice(0, 4)]) { hA.textContent = `Prefijo ${acc.slice(0, 4)} no reconocido.`; hA.className = 'ff-hint warn'; }
    else { hA.textContent = `🏦 ${STATE.bankMap[acc.slice(0, 4)]}`; hA.className = 'ff-hint ok'; }

    const ph = q('#e_phone').value.replace(/\D/g, ''), hP = q('#h_phone');
    if (!ph) { hP.textContent = ''; hP.className = 'ff-hint'; }
    else if (ph.length !== 11 || ph[0] !== '0') { hP.textContent = 'Debe tener 11 dígitos (04XX-XXXXXXX).'; hP.className = 'ff-hint warn'; }
    else { hP.textContent = `📱 Se guardará como +58${ph.slice(1)}`; hP.className = 'ff-hint ok'; }

    const b = q('#e_birth').value, hB = q('#h_birth');
    if (!b) { hB.textContent = ''; hB.className = 'ff-hint'; q('#e_age').value = ''; }
    else { const a = ageFrom(b); q('#e_age').value = `${a} años`; hB.textContent = a < 18 ? 'Menor de 18 años' : ''; hB.className = a < 18 ? 'ff-hint warn' : 'ff-hint'; }

    const em = q('#e_email').value.trim(), hE = q('#h_email');
    if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { hE.textContent = 'Formato de correo inválido.'; hE.className = 'ff-hint warn'; }
    else { hE.textContent = ''; hE.className = 'ff-hint'; }
  }

  function toEdit() {
    ficha.classList.add('editing');
    host.querySelector('#ffEdit').style.display = 'none';
    host.querySelector('#ffCancel').style.display = '';
    host.querySelector('#ffSave').style.display = '';
    host.querySelector('#ffDel').style.display = w.thumb_url ? '' : 'none';
    q('#e_first').value = w.first_name || ''; q('#e_second').value = w.second_name || ''; q('#e_last').value = w.last_names || '';
    q('#e_birth').value = w.birth_date || ''; q('#e_gender').value = w.gender || ''; q('#e_marital').value = w.marital_status || '';
    q('#e_role').value = w.role || ''; q('#e_account').value = w.account_number || ''; q('#e_phone').value = phoneNat(w.phone);
    q('#e_email').value = w.email || ''; q('#e_address').value = w.address || '';
    runValidations();
    window.scrollTo(0, 0);
  }

  ['#e_account', '#e_phone', '#e_birth', '#e_email'].forEach(sel => q(sel).addEventListener('input', runValidations));

  async function save() {
    const phRaw = q('#e_phone').value.replace(/\D/g, '');
    const accRaw = q('#e_account').value.replace(/\D/g, '');
    // Validaciones duras antes de enviar.
    if (accRaw && (accRaw.length !== 20 || !STATE.bankMap[accRaw.slice(0, 4)])) { alert('La cuenta bancaria no es válida (20 dígitos y prefijo de banco conocido).'); return; }
    if (phRaw && (phRaw.length !== 11 || phRaw[0] !== '0')) { alert('El teléfono no es válido (04XX-XXXXXXX).'); return; }
    const birth = q('#e_birth').value;
    if (birth && ageFrom(birth) < 18) { if (!confirm('La persona es menor de 18 años. ¿Guardar de todos modos?')) return; }

    const first = q('#e_first').value.trim().toUpperCase();
    const second = q('#e_second').value.trim().toUpperCase();
    const last = q('#e_last').value.trim().toUpperCase();
    const profile = {
      first_name: first || null,
      second_name: second || null,
      last_names: last || null,
      full_name: [first, second, last].filter(Boolean).join(' ') || null,
      birth_date: birth || null,
      gender: q('#e_gender').value || null,
      marital_status: q('#e_marital').value || null,
      role: q('#e_role').value.trim().toUpperCase() || null,
      account_number: accRaw || null,
      bank_code: accRaw ? accRaw.slice(0, 4) : null,
      phone: phRaw ? '+58' + phRaw.slice(1) : null,
      email: q('#e_email').value.trim() || null,
      address: q('#e_address').value.trim() || null,
    };

    const saveB = host.querySelector('#ffSave');
    saveB.disabled = true; saveB.textContent = 'Guardando…';
    const r = await api({
      action: 'save_profile', company_code: STATE.cc, user: sessionUserPayload(STATE.user),
      id_number: w.id_number, profile,
    });
    saveB.disabled = false; saveB.textContent = 'Guardar cambios';
    if (!r.ok) { alert(r.error || 'No se pudo guardar.'); return; }

    // Aplicar en memoria y refrescar.
    Object.assign(w, profile, { updated_at: new Date().toISOString() });
    openFicha(w.id_number);   // reabre en modo ver con datos frescos
    paintGrid();
  }

  q('#ffBack').addEventListener('click', backToGrid);
  q('#ffEdit').addEventListener('click', toEdit);
  q('#ffCancel').addEventListener('click', () => openFicha(w.id_number));
  q('#ffSave').addEventListener('click', save);
  q('#ffPhEdit').addEventListener('click', () => openPhotoModal(w.id_number));
  q('#ffDel').addEventListener('click', () => openPhotoModal(w.id_number));
}

function backToGrid() {
  $('#wpFichaHost').innerHTML = '';
  $('#wpGridView').style.display = '';
  CUR = null;
  window.scrollTo(0, 0);
}

/* ===================== LIGHTBOX (foto grande + descargar) ===================== */
let lbCurrent = null;
function ensureLightbox() {
  if (document.getElementById('wpLb')) return;
  const el = document.createElement('div');
  el.id = 'wpLb'; el.className = 'wp-lb';
  el.innerHTML = `
    <div class="wp-lb-tools">
      <button class="wp-lb-btn" id="wpLbDl"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Descargar</button>
      <button class="wp-lb-btn icon" id="wpLbX">✕</button>
    </div>
    <img id="wpLbImg" src="" alt=""><div class="wp-lb-cap" id="wpLbCap"></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el) closeLightbox(); });
  document.getElementById('wpLbX').addEventListener('click', closeLightbox);
  document.getElementById('wpLbDl').addEventListener('click', async e => {
    e.stopPropagation();
    if (!lbCurrent) return;
    try {
      const resp = await fetch(lbCurrent.src);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = lbCurrent.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { alert('No se pudo descargar la foto.'); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.classList.contains('show')) closeLightbox();
  });
}
function openLightbox(src, cap, filename) {
  if (!src) return;
  ensureLightbox();
  lbCurrent = { src, filename: filename || 'foto.jpg' };
  document.getElementById('wpLbImg').src = src;
  document.getElementById('wpLbCap').textContent = cap || '';
  document.getElementById('wpLb').classList.add('show');
}
function closeLightbox() {
  const el = document.getElementById('wpLb');
  if (el) { el.classList.remove('show'); document.getElementById('wpLbImg').src = ''; }
  lbCurrent = null;
}

/* ===================== MODAL DE FOTO (anterior al lado) ===================== */
function openPhotoModal(ced) {
  const w = STATE.workers.find(x => String(x.id_number) === String(ced));
  if (!w) return;
  let staged = null;
  const host = $('#wpModalHost');

  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="pmX" title="Cerrar">✕</button>
        <h3>Foto del colaborador</h3>
        <p class="wp-who"><b>${esc(w.full_name)}</b> · <span class="wp-ced">${w.ced_kind || ''}-${w.id_number}</span></p>
        <div class="pm-two">
          <div class="pm-col"><div class="pm-col-lbl">Foto actual</div><div class="pm-prev" id="pmCur"><div class="empty">Sin foto aún</div></div></div>
          <div class="pm-arrow">→</div>
          <div class="pm-col"><div class="pm-col-lbl">Nueva foto</div><div class="pm-prev" id="pmNew"><div class="empty">Elegí una foto para previsualizar</div></div></div>
        </div>
        <div class="pm-help"><b>Foto tipo carnet:</b> de frente, hombros visibles, fondo claro y liso, buena luz sin sombras. La cara centrada ocupando el círculo. Sin lentes, gorras ni gestos. El círculo es solo guía.</div>
        <p class="wp-meta" id="pmMeta"></p>
        <input type="file" id="pmFile" accept="image/*" hidden>
        <div class="wp-foot">
          ${w.thumb_url ? '<button class="btn" id="pmDel" style="color:var(--danger);border-color:#f3c2c2">Quitar foto</button>' : ''}
          <span style="flex:1"></span>
          <button class="btn" id="pmCancel">Cancelar</button>
          <button class="btn" id="pmPick">Elegir foto</button>
          <button class="btn btn-primary" id="pmSave" disabled>Guardar</button>
        </div>
      </div>
    </div>`;

  const q = s => host.querySelector(s);
  const closeModal = () => { document.removeEventListener('keydown', onKey); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', onKey);
  q('#pmX').addEventListener('click', closeModal);
  q('#pmCancel').addEventListener('click', closeModal);
  host.querySelector('.wp-modal-vp').addEventListener('click', ev => { if (ev.target === ev.currentTarget) closeModal(); });

  // Columna izquierda: foto actual + circulo guia.
  const cur = q('#pmCur');
  if (w.thumb_url) {
    cur.innerHTML = `<img src="${w.thumb_url}" alt="actual">` + guideSvg();
    cur.querySelector('img').addEventListener('click', () => openLightbox(w.full_url || w.thumb_url, 'Foto actual', `${w.ced_kind}-${w.id_number}.jpg`));
  }

  q('#pmPick').addEventListener('click', () => q('#pmFile').click());
  q('#pmFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const origKB = Math.round(f.size / 1024);
    try {
      const img = await fileToImage(f);
      const thumbUrl = squareCrop(img, THUMB, THUMB_QUALITY);
      const fullUrl = squareCrop(img, FULL, FULL_QUALITY);
      staged = {
        thumb: stripPrefix(thumbUrl), full: stripPrefix(fullUrl),
        previewThumb: thumbUrl, bytes: b64Bytes(fullUrl) + b64Bytes(thumbUrl),
        fullBytes: b64Bytes(fullUrl),
      };
      q('#pmNew').innerHTML = `<img src="${thumbUrl}" alt="nueva">` + guideSvg();
      q('#pmMeta').innerHTML = `Original ${origKB} KB → <b style="color:var(--success)">comprimida ${Math.round(staged.bytes / 1024)} KB</b> · ${FULL}×${FULL} (grande) + ${THUMB}×${THUMB} (miniatura)`;
      q('#pmSave').disabled = false;
    } catch { q('#pmMeta').textContent = 'No se pudo leer la imagen. Probá con otra.'; }
  });

  q('#pmSave').addEventListener('click', async () => {
    if (!staged) return;
    const saveB = q('#pmSave'); saveB.disabled = true; saveB.textContent = 'Guardando…';
    const uploadedBy = STATE.user.kind === 'company' ? STATE.user.companyCode : (STATE.user.name || STATE.user.username || 'admin');
    const r = await api({
      action: 'save', company_code: STATE.cc, user: sessionUserPayload(STATE.user),
      id_number: w.id_number, full_b64: staged.full, thumb_b64: staged.thumb, mime: 'image/jpeg',
      width: FULL, height: FULL, bytes: staged.fullBytes, uploaded_by: uploadedBy,
    });
    if (!r.ok) { saveB.disabled = false; saveB.textContent = 'Guardar'; alert(r.error || 'No se pudo guardar la foto.'); return; }
    w.has_photo = true;
    w.thumb_url = r.thumb_url || w.thumb_url;
    w.full_url = r.full_url || w.full_url;
    w.photo_uploaded_by = uploadedBy;
    w.updated_at = new Date().toISOString();
    closeModal();
    paintGrid();
    if (CUR && CUR.id_number === w.id_number) openFicha(w.id_number);
  });

  const delB = q('#pmDel');
  if (delB) delB.addEventListener('click', async () => {
    if (!confirm(`¿Quitar la foto de ${w.full_name}?`)) return;
    const r = await api({ action: 'remove', company_code: STATE.cc, user: sessionUserPayload(STATE.user), id_number: w.id_number });
    if (!r.ok) { alert(r.error || 'No se pudo quitar.'); return; }
    w.has_photo = false; w.thumb_url = null; w.full_url = null;
    closeModal();
    paintGrid();
    if (CUR && CUR.id_number === w.id_number) openFicha(w.id_number);
  });
}

/* ===================== GESTION DE LA LISTA ===================== */
function wpModalHost() { return $('#wpModalHost'); }
function wpCloseModal() { wpModalHost().innerHTML = ''; }

/* ---- Actualizar lista (cargar Reporte 10) ---- */
function openReporteModal() {
  const host = wpModalHost();
  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="rmX" title="Cerrar">✕</button>
        <h3>Actualizar lista de personal</h3>
        <p class="wp-who">${esc(STATE.cc)} · Carga el <b>Reporte 10</b> del POS para refrescar el personal.</p>

        <div class="wp-drop" id="rmDrop">
          <svg class="wp-di" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <b id="rmDropName">Elegir el archivo .xlsx</b>
          <small id="rmDropHint">Hoja "Datos" · se lee en tu navegador, no se sube el archivo</small>
        </div>
        <input type="file" id="rmFile" accept=".xlsx,.xls" hidden>

        <div id="rmPreview" class="wp-prev" style="display:none"></div>

        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="rmCancel">Cancelar</button>
          <button class="btn" id="rmPick">Elegir archivo</button>
          <button class="btn btn-primary" id="rmSave" disabled>Actualizar lista</button>
        </div>
      </div>
    </div>`;

  let parsed = null, valid = null;
  const q = s => host.querySelector(s);
  const close = () => { document.removeEventListener('keydown', onKey); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#rmX').addEventListener('click', close);
  q('#rmCancel').addEventListener('click', close);
  host.querySelector('.wp-modal-vp').addEventListener('click', ev => { if (ev.target === ev.currentTarget) close(); });
  q('#rmDrop').addEventListener('click', () => q('#rmFile').click());
  q('#rmPick').addEventListener('click', () => q('#rmFile').click());

  q('#rmFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    q('#rmDropName').textContent = f.name;
    q('#rmDropHint').textContent = 'Leyendo…';
    try {
      parsed = await parseReport10(f);
      valid = validateParsed(parsed);
      const prev = q('#rmPreview');
      prev.style.display = 'block';
      if (parsed.missing.length) {
        prev.className = 'wp-prev warn';
        prev.innerHTML = `⚠ Falta(n) la(s) columna(s): <b>${parsed.missing.join(', ')}</b>. Revisa que sea el Reporte 10 correcto (hoja "Datos").`;
        q('#rmSave').disabled = true;
        q('#rmDropHint').textContent = 'Archivo con columnas faltantes';
        return;
      }
      prev.className = 'wp-prev ok';
      const manual = STATE.manualCount || 0;
      prev.innerHTML = `✓ <b>${valid.total} trabajadores</b> (${valid.active} vigentes · ${valid.terminated} egresados)`
        + ` · ${valid.gerentes} gerente(s), ${valid.subgerentes} sub-gerente(s)`
        + (parsed.columnsFound.includes('Cuenta Bancaria') ? ' · cuentas incluidas' : '')
        + (manual ? `<div style="margin-top:6px;font-size:11.5px">Los <b>${manual}</b> colaborador(es) manual(es) que no estén en el reporte se conservan.</div>` : '')
        + (valid.warnings.length ? `<div style="margin-top:6px;font-size:11.5px;color:var(--warn)">${valid.warnings.join(' ')}</div>` : '');
      q('#rmDropHint').textContent = `${valid.total} filas válidas`;
      q('#rmSave').disabled = !valid.okToUpload;
    } catch (err) {
      const prev = q('#rmPreview');
      prev.style.display = 'block'; prev.className = 'wp-prev warn';
      prev.innerHTML = `No se pudo leer el archivo: ${esc(String(err.message || err))}`;
      q('#rmSave').disabled = true;
    }
  });

  q('#rmSave').addEventListener('click', async () => {
    if (!valid || !valid.okToUpload) return;
    const saveB = q('#rmSave'); saveB.disabled = true; saveB.textContent = 'Actualizando…';
    const uploadedBy = STATE.user.kind === 'company' ? STATE.user.companyCode : (STATE.user.name || STATE.user.username || 'admin');
    const r = await rosterReplace(STATE.cc, valid.validRows, { uploadedBy, sourceFile: parsed.fileName });
    if (!r.ok) { saveB.disabled = false; saveB.textContent = 'Actualizar lista'; alert(r.error || 'No se pudo actualizar.'); return; }
    close();
    await load();
  });
}

/* ---- Actualizar lista (cargar Reporte AX) — modo empresa ---- */
function openReporteAXModal() {
  const host = wpModalHost();
  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="axX" title="Cerrar">✕</button>
        <h3>Actualizar lista de personal</h3>
        <p class="wp-who">${esc(STATE.cc)} · Carga el <b>Reporte AX</b> (Excel de AX) para refrescar el personal de la empresa.</p>

        <div class="wp-drop" id="axDrop">
          <svg class="wp-di" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <b id="axDropName">Elegir el archivo .xlsx</b>
          <small id="axDropHint">Se lee en tu navegador, no se sube el archivo</small>
        </div>
        <input type="file" id="axFile" accept=".xlsx,.xls" hidden>

        <div id="axPreview" class="wp-prev" style="display:none"></div>

        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="axCancel">Cancelar</button>
          <button class="btn" id="axPick">Elegir archivo</button>
          <button class="btn btn-primary" id="axSave" disabled>Actualizar lista</button>
        </div>
      </div>
    </div>`;

  let parsed = null, valid = null;
  const q = s => host.querySelector(s);
  const close = () => { document.removeEventListener('keydown', onKey); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#axX').addEventListener('click', close);
  q('#axCancel').addEventListener('click', close);
  host.querySelector('.wp-modal-vp').addEventListener('click', ev => { if (ev.target === ev.currentTarget) close(); });
  q('#axDrop').addEventListener('click', () => q('#axFile').click());
  q('#axPick').addEventListener('click', () => q('#axFile').click());

  q('#axFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    q('#axDropName').textContent = f.name;
    q('#axDropHint').textContent = 'Leyendo…';
    try {
      parsed = await parseReporteAX(f);
      valid = validateReporteAX(parsed, STATE.cc);
      const prev = q('#axPreview');
      prev.style.display = 'block';
      if (parsed.missing.length) {
        prev.className = 'wp-prev warn';
        prev.innerHTML = `⚠ Falta(n) la(s) columna(s): <b>${parsed.missing.join(', ')}</b>. Revisa que sea el Reporte AX correcto.`;
        q('#axSave').disabled = true;
        q('#axDropHint').textContent = 'Archivo con columnas faltantes';
        return;
      }
      if (!valid.total) {
        prev.className = 'wp-prev warn';
        prev.innerHTML = `⚠ El archivo no trae personal para <b>${esc(STATE.cc)}</b>.`
          + (valid.foreignCompanies.length ? ` Trae datos de: <b>${valid.foreignCompanies.join(', ')}</b>.` : '')
          + ` Verifica que sea el Reporte AX de esta empresa.`;
        q('#axSave').disabled = true;
        q('#axDropHint').textContent = 'Sin filas para esta empresa';
        return;
      }
      prev.className = 'wp-prev ok';
      prev.innerHTML = `✓ <b>${valid.total} trabajadores</b> (${valid.active} vigentes · ${valid.terminated} egresados)`
        + (valid.hasAccountCol ? ` · ${valid.withAccount} con cuenta` : '')
        + `<div style="margin-top:6px;font-size:11.5px">El AX actualiza identidad, nacimiento, género, estado civil${valid.hasAccountCol ? ', cuenta y TodoTicket' : ''}. Se conservan cargo, teléfono, correo y dirección capturados aquí.</div>`
        + (valid.warnings.length ? `<div style="margin-top:6px;font-size:11.5px;color:var(--warn)">${valid.warnings.join(' ')}</div>` : '');
      q('#axDropHint').textContent = `${valid.total} filas válidas`;
      q('#axSave').disabled = !valid.okToUpload;
    } catch (err) {
      const prev = q('#axPreview');
      prev.style.display = 'block'; prev.className = 'wp-prev warn';
      prev.innerHTML = `No se pudo leer el archivo: ${esc(String(err.message || err))}`;
      q('#axSave').disabled = true;
    }
  });

  q('#axSave').addEventListener('click', async () => {
    if (!valid || !valid.okToUpload) return;
    const saveB = q('#axSave'); saveB.disabled = true; saveB.textContent = 'Actualizando…';
    const uploadedBy = STATE.user.name || STATE.user.username || 'admin';
    const r = await enterpriseRosterReplace(STATE.cc, valid.validRows, {
      uploadedBy, sourceFile: parsed.fileName, adminId: STATE.adminId,
    });
    if (!r.ok) { saveB.disabled = false; saveB.textContent = 'Actualizar lista'; alert(r.error || 'No se pudo actualizar.'); return; }
    close();
    await load();
  });
}

/* ---- Agregar colaborador manual ---- */
function openAddManualModal() {
  const host = wpModalHost();
  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="amX" title="Cerrar">✕</button>
        <h3>Agregar colaborador</h3>
        <p class="wp-who">${esc(STATE.cc)} · Alta manual de una persona que aún no está en el Reporte 10.</p>

        <div class="wp-ced-anchor">
          <span class="l">🪪 Cédula</span>
          <input id="amCed" inputmode="numeric" placeholder="12345678" maxlength="8">
          <span class="hint-side">identifica · no se podrá cambiar luego</span>
        </div>

        <label class="flabel">Nombre y apellidos</label>
        <input id="amFull" type="text" placeholder="Escribe el nombre completo…">
        <div class="wp-namesplit" id="amSplit" style="display:none"></div>

        <div class="wp-grid2">
          <div><label class="flabel">Cargo</label>
            <input id="amRole" type="text" placeholder="ej. VENDEDOR"></div>
          <div><label class="flabel">Estado</label>
            <select id="amStatus"><option value="vigente">Vigente</option><option value="egresado">Egresado</option></select></div>
        </div>

        <p class="wp-help">Se pide lo mínimo para crearlo en la lista. El resto de la ficha (nacimiento, género, cuenta, contacto, foto) se completa luego abriendo su tarjeta. Entra a la lista de la tienda marcado como <b>manual</b>.</p>

        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="amCancel">Cancelar</button>
          <button class="btn btn-primary" id="amSave" disabled>Crear colaborador</button>
        </div>
      </div>
    </div>`;

  const q = s => host.querySelector(s);
  const close = () => { document.removeEventListener('keydown', onKey); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#amX').addEventListener('click', close);
  q('#amCancel').addEventListener('click', close);
  host.querySelector('.wp-modal-vp').addEventListener('click', ev => { if (ev.target === ev.currentTarget) close(); });

  let split = { first_name: '', second_name: '', last_names: '' };
  function refresh() {
    const ced = q('#amCed').value.replace(/\D/g, '');
    const full = q('#amFull').value.trim();
    if (full) {
      split = splitFullName(full);
      q('#amSplit').style.display = 'block';
      q('#amSplit').innerHTML = `Se guardará dividido — <b>Nombre:</b> ${esc(split.first_name)}`
        + (split.second_name ? ` · <b>2do:</b> ${esc(split.second_name)}` : '')
        + ` · <b>Apellidos:</b> ${esc(split.last_names || '—')}`;
    } else {
      q('#amSplit').style.display = 'none';
    }
    const ok = ced.length >= 6 && ced.length <= 8 && split.first_name && split.last_names;
    q('#amSave').disabled = !ok;
  }
  q('#amCed').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, ''); refresh(); });
  q('#amFull').addEventListener('input', refresh);

  q('#amSave').addEventListener('click', async () => {
    const ced = q('#amCed').value.replace(/\D/g, '');
    if (!split.last_names) { alert('Escribe nombre y apellidos.'); return; }
    const saveB = q('#amSave'); saveB.disabled = true; saveB.textContent = 'Creando…';
    const r = await rosterAddManual(STATE.cc, {
      id_number: ced,
      first_name: split.first_name, second_name: split.second_name, last_names: split.last_names,
      role: q('#amRole').value.trim(),
      egresado: q('#amStatus').value === 'egresado',
    });
    if (!r.ok) { saveB.disabled = false; saveB.textContent = 'Crear colaborador'; alert(r.error || 'No se pudo crear.'); return; }
    close();
    await load();
    // Abrir su ficha para completar el resto de datos.
    if (r.id_number) openFicha(r.id_number);
  });
}

/* ---- Limpiar lista (destructivo) ---- */
function openClearModal() {
  const host = wpModalHost();
  const total = STATE.workers.length;
  const isEnt = STATE.mode === 'enterprise';
  const entidad = isEnt ? 'la empresa' : 'la tienda';
  const repName = isEnt ? 'Reporte AX' : 'Reporte 10';
  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="clX" title="Cerrar">✕</button>
        <h3 style="color:var(--danger)">Limpiar lista de personal</h3>
        <p class="wp-who">${esc(STATE.cc)} · Esta acción vacía <b>toda</b> la lista de ${entidad}.</p>

        <div class="wp-dangerbox">
          <b>Se quitarán los ${total} colaboradores</b> de la lista de ${entidad}${isEnt ? '' : ' (los del Reporte 10 <u>y</u> los manuales)'}.
        </div>
        <div class="wp-okbox">
          ✓ <b>Las fotos y fichas NO se borran.</b> Quedan guardadas en el directorio por cédula. Si la persona vuelve a la lista —por ${repName}${isEnt ? '' : ' o manual'}— su foto y datos reaparecen automáticamente.
        </div>

        <label class="flabel">Para confirmar, escribe el código de ${entidad}: <b>${esc(STATE.cc)}</b></label>
        <input id="clConfirm" autocomplete="off" placeholder="${esc(STATE.cc)}">

        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="clCancel">Cancelar</button>
          <button class="btn wp-btn-danger" id="clOk" disabled>Sí, vaciar la lista</button>
        </div>
      </div>
    </div>`;

  const q = s => host.querySelector(s);
  const close = () => { document.removeEventListener('keydown', onKey); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#clX').addEventListener('click', close);
  q('#clCancel').addEventListener('click', close);
  host.querySelector('.wp-modal-vp').addEventListener('click', ev => { if (ev.target === ev.currentTarget) close(); });
  q('#clConfirm').addEventListener('input', e => {
    q('#clOk').disabled = e.target.value.trim().toUpperCase() !== String(STATE.cc).toUpperCase();
  });
  q('#clOk').addEventListener('click', async () => {
    const okB = q('#clOk'); okB.disabled = true; okB.textContent = 'Vaciando…';
    const r = isEnt
      ? await enterpriseRosterClear(STATE.cc, STATE.adminId)
      : await rosterClear(STATE.cc);
    if (!r.ok) { okB.disabled = false; okB.textContent = 'Sí, vaciar la lista'; alert(r.error || 'No se pudo limpiar.'); return; }
    close();
    await load();
  });
}
