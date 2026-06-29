/* =====================================================================
   js/views/avisos.js  →  vista "Avisos"
   Sistema de avisos: automaticos del periodo (3 hitos, plantillas editables)
   + manuales (announcements). Admin: lectura + crear/editar/plantillas/horas.
   Company: solo lectura de lo que le corresponde.

   Datos: /api/announcements (actions feed/tpl_get/tpl_save/list_manual/
   save_manual/toggle_manual/delete_manual).
   Export: renderAvisos(user), y un helper gotoAviso(id) para resaltar al
   llegar desde la campanita.

   DOS MODOS (opts.mode):
     - 'inbox'  -> recepcion/lectura, igual que las tiendas. Muestra Novedades
                   de empresas + Periodo de nomina + Comunicados. Sin edicion.
     - 'config' -> gestion (Envio de avisos). Solo plantillas del periodo +
                   comunicados manuales. NO muestra novedades de empresa.
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const SVG = {
  calc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="8" y2="10"/><line x1="12" y1="10" x2="12" y2="10"/><line x1="16" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="8" y2="14"/><line x1="12" y1="14" x2="12" y2="14"/><line x1="8" y1="18" x2="12" y2="18"/></svg>',
  cut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l3-3 3 3 4-5"/></svg>',
  pay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg>',
  man: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>',
  ent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4"/></svg>',
};
const VAR_KEYS = ['#Periodo', '#Fecha_Cierre', '#Fecha_Calculo', '#Fecha_Pago', '#HoraLimite1', '#HoraLimite2'];
const TPL_LABEL = { calc: 'Último día de cálculo', cut: 'Día de cálculo', pay: 'Día de pago' };
const AUD_LABEL = { everyone: 'Todos', all: 'Todos (tiendas y empresas)', stores: 'Tiendas', enterprises: 'Empresas', admins: 'Administradores', editors: 'Editores' };

let AV_USER = null;
let AV_FEED = null;
let AV_TPL = null;      // { templates:{calc,cut,pay}, hora1, hora2 }
let AV_MANUAL = [];     // lista admin
let AV_CHANGES = [];    // novedades de empresa (globales, todos las ven)
let AV_MODE = 'inbox';  // 'inbox' = recepcion (lectura) | 'config' = gestion (envio)

function ensureStyles() {
  if (document.getElementById('avStyles')) return;
  const st = document.createElement('style');
  st.id = 'avStyles';
  st.textContent = `
  .av-head{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap;margin-bottom:4px}
  .av-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .av-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .av-btn{font:inherit;font-size:13px;padding:9px 15px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);cursor:pointer}
  .av-btn-primary{background:var(--brand);color:#fff;border-color:var(--brand)}
  .av-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:0;margin-top:14px;overflow:hidden}
  .av-row{display:flex;gap:14px;align-items:flex-start;padding:15px 18px;border-bottom:1px solid var(--border-soft,#eef0f3)}
  .av-row:last-child{border-bottom:0}
  .av-ic{width:38px;height:38px;flex:0 0 auto;border-radius:10px;display:flex;align-items:center;justify-content:center}
  .av-ic svg{width:20px;height:20px}
  .av-ic.calc{background:#fef3c7;color:#b45309}.av-ic.cut{background:#dbeafe;color:#1e40af}.av-ic.pay{background:#dcfce7;color:#166534}.av-ic.man{background:#f3e8ff;color:#6b21a8}.av-ic.ent{background:#e0f2fe;color:#0369a1}
  .av-body{flex:1;min-width:0}
  .av-title{font-weight:650;font-size:14px;color:var(--ink)}
  .av-text{font-size:12.5px;color:var(--ink-soft,#334155);margin-top:3px;line-height:1.5}
  .av-meta{font-size:11px;color:var(--faint,#94a3b8);margin-top:6px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .av-tag{display:inline-block;font-size:10px;font-weight:700;border-radius:999px;padding:2px 8px}
  .tag-auto{color:#1e40af;background:#dbeafe}.tag-man{color:#6b21a8;background:#f3e8ff}
  .tag-today{color:#9a3412;background:#ffedd5}.tag-off{color:#64748b;background:#e5e7eb}
  .av-actions{display:flex;gap:6px;flex:0 0 auto;flex-wrap:wrap}
  .av-iconbtn{border:1px solid var(--border);background:var(--surface);border-radius:8px;padding:5px 9px;font-size:12px;cursor:pointer;color:var(--ink-soft,#334155)}
  .av-iconbtn:hover{background:var(--border-soft,#eef0f3)}
  .av-empty{background:var(--surface);border:1px dashed var(--border);border-radius:14px;padding:18px;text-align:center;color:var(--muted);font-size:13px}
  .av-sub{margin:22px 2px 2px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--faint,#94a3b8)}

  @keyframes avFlash{0%,100%{background:transparent}25%,75%{background:#fef9c3}}
  .av-flash{animation:avFlash .8s ease-in-out 3}

  /* modales */
  .av-modal-bg{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:flex-start;justify-content:center;padding:48px 16px;z-index:100;overflow:auto}
  .av-modal-bg[hidden]{display:none}
  .av-modal{background:var(--surface);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.28);width:520px;max-width:100%}
  .av-modal-h{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border)}
  .av-modal-h h3{margin:0;font-size:15.5px;color:var(--ink)}
  .av-modal-x{background:none;border:0;font-size:20px;line-height:1;color:var(--muted);cursor:pointer;padding:2px 6px;border-radius:6px}
  .av-modal-x:hover{background:var(--border-soft,#eef0f3);color:var(--ink)}
  .av-modal-b{padding:18px 20px}
  .av-modal-f{display:flex;gap:8px;justify-content:flex-end;padding:14px 20px;border-top:1px solid var(--border)}
  .av-field{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
  .av-field label{font-size:11px;color:var(--muted)}
  .av-field input,.av-field select,.av-field textarea{font:inherit;font-size:13px;padding:8px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink)}
  .av-field textarea{resize:vertical;min-height:90px}
  .av-row2{display:flex;gap:8px}.av-row2>*{flex:1}
  .av-vars{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0}
  .av-varbtn{border:1px solid var(--brand);background:var(--brand-bg);color:var(--brand);border-radius:999px;padding:3px 10px;font-size:11.5px;font-family:ui-monospace,Menlo,monospace;cursor:pointer}
  .av-varbtn:hover{background:#dbeafe}
  .av-preview{background:var(--surface2,#f8fafc);border:1px dashed var(--border);border-radius:10px;padding:11px 13px;font-size:12.5px;color:var(--ink-soft,#334155);line-height:1.5;margin-top:4px}
  .av-preview .pl{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--faint,#94a3b8);margin-bottom:5px;font-weight:700}
  .av-help{font-size:11px;color:var(--muted);margin-top:3px}
  `;
  document.head.appendChild(st);
}

function api(extra) {
  const u = AV_USER.kind === 'company'
    ? { kind: 'company', companyCode: AV_USER.companyCode }
    : { kind: AV_USER.kind, id: AV_USER.id };
  return fetch('/api/announcements', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: u, ...extra }),
  }).then(r => r.json());
}

/* ---------- entrada ----------
   opts.mode: 'inbox' (recepcion/lectura, como las tiendas) | 'config' (gestion).
   panel.js pasa el modo explicito (avisos=inbox, avisosconfig=config). */
export async function renderAvisos(user, opts = {}) {
  AV_USER = user;
  ensureStyles();
  // La gestion (config) solo la pueden ver admin/superadmin (NO editor_personal).
  // En 'inbox' todos ven en modo lectura.
  const canManageRole = user.kind === 'admin' && user.role !== 'editor_personal';
  AV_MODE = (opts.mode === 'config' && canManageRole) ? 'config' : 'inbox';
  const isConfig = AV_MODE === 'config';
  $('#pnlMain').innerHTML = `
    <div class="av-head">
      <div><h1>${isConfig ? 'Env\u00edo de avisos' : 'Avisos'}</h1>
        <p>${isConfig
          ? 'Configura los avisos del per\u00edodo (plantillas) y crea comunicados para tiendas, empresas, administradores o editores.'
          : 'Novedades de empresas, recordatorios del per\u00edodo de n\u00f3mina y comunicados de la administraci\u00f3n.'}</p></div>
      ${isConfig ? `<button class="av-btn av-btn-primary" id="avNew">+ Nuevo aviso</button>` : ''}
    </div>
    <div id="avBody"><div class="av-empty">Cargando\u2026</div></div>
    <div id="avModals"></div>`;

  if (isConfig) $('#avNew').addEventListener('click', () => openManualModal(null));
  await loadAndRender();
  if (opts.focusId) setTimeout(() => gotoAviso(opts.focusId), 300);
}

async function loadAndRender() {
  const isConfig = AV_MODE === 'config';
  let feed;
  try {
    feed = await api({ action: 'feed' });
    if (!feed.ok) throw new Error(feed.error || 'Error');
  } catch (e) {
    $('#avBody').innerHTML = `<div class="av-empty">No se pudieron cargar los avisos.<br><small>${esc(String(e.message || e))}</small></div>`;
    return;
  }
  AV_FEED = feed;
  // marca como visto al entrar a la seccion
  api({ action: 'seen' }).catch(() => {});

  if (isConfig) {
    // Pantalla de configuracion: plantillas + comunicados manuales. NO novedades.
    const [tpl, man] = await Promise.all([api({ action: 'tpl_get' }), api({ action: 'list_manual' })]);
    AV_TPL = tpl && tpl.ok ? tpl : null;
    AV_MANUAL = (man && man.ok) ? man.rows : [];
    renderAdmin();
  } else {
    // Inbox (recepcion): tambien trae las novedades de empresa (globales).
    try {
      const u = AV_USER.kind === 'company'
        ? { kind: 'company', companyCode: AV_USER.companyCode }
        : { kind: AV_USER.kind, id: AV_USER.id };
      const ch = await fetch('/api/notifications', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list_changes', user: u }),
      }).then(r => r.json()).catch(() => null);
      AV_CHANGES = (ch && ch.ok) ? (ch.items || []) : [];
    } catch { AV_CHANGES = []; }
    renderUser();
  }
}

/* ---------- fila: aviso automatico del periodo ---------- */
function autoRow(a) {
  const id = `av-${a.type}`;
  const today = a.today ? `<span class="av-tag tag-today">Hoy</span>` : '';
  return `<div class="av-row" id="${id}">
    <div class="av-ic ${a.type}">${SVG[a.type] || ''}</div>
    <div class="av-body">
      <div class="av-title">${esc(a.title)} ${today}</div>
      <div class="av-text">${esc(a.body)}</div>
      <div class="av-meta"><span>\u{1F4C5} ${esc(a.date || '')}</span></div>
    </div>
  </div>`;
}
/* ---------- fila: comunicado manual ---------- */
function manualRow(m, admin) {
  const id = `av-man-${m.id}`;
  const today = m.today ? `<span class="av-tag tag-today">Hoy</span>` : '';
  const off = (admin && !m.is_active) ? `<span class="av-tag tag-off">Inactivo</span>` : '';
  const date = m.from ? `\u{1F4C5} ${esc(m.from)}${m.to && m.to !== m.from ? ' \u2013 ' + esc(m.to) : ''}` : '';
  const audTag = admin ? `<span class="av-tag tag-man">${esc(AUD_LABEL[m.audience] || m.audience)}</span>` : '';
  const actions = admin
    ? `<button class="av-iconbtn" data-edit="${m.id}">Editar</button>
       <button class="av-iconbtn" data-toggle="${m.id}">${m.is_active ? 'Desactivar' : 'Activar'}</button>`
    : '';
  return `<div class="av-row" id="${id}">
    <div class="av-ic man">${SVG.man}</div>
    <div class="av-body">
      <div class="av-title">${esc(m.title)} ${today} ${off}</div>
      <div class="av-text">${esc(m.body || '')}</div>
      <div class="av-meta">${audTag}<span>${date}</span></div>
    </div>
    <div class="av-actions">${actions}</div>
  </div>`;
}

/* Fecha+hora de la novedad de empresa (detected_at ISO) en hora Caracas. */
function fmtChangeWhen(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt)) return '';
  const car = new Date(dt.getTime() - 4 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  let h = car.getUTCHours(); const ap = h < 12 ? 'a. m.' : 'p. m.';
  h = h % 12; if (h === 0) h = 12;
  return `${p(car.getUTCDate())}/${p(car.getUTCMonth() + 1)}/${car.getUTCFullYear()} ${h}:${p(car.getUTCMinutes())} ${ap}`;
}

/* Fila de novedad de empresa (cambio de estatus / empresa nueva). Globales:
   las ven todos los usuarios. Solo lectura. Solo en el inbox. */
function changeRow(c) {
  const name = c.business_name ? ` \u2014 ${esc(c.business_name)}` : '';
  const when = fmtChangeWhen(c.detected_at);
  let title, text;
  if (c.change_type === 'new') {
    title = `Nueva empresa ${esc(c.company_code)}${name}`;
    text = 'Se agrego al catalogo de empresas.';
  } else {
    title = `${esc(c.company_code)}${name}`;
    text = `Estatus: ${esc(c.old_value || '\u2014')} \u2192 <b>${esc(c.new_value || '\u2014')}</b>`;
  }
  return `<div class="av-row">
    <div class="av-ic ent">${SVG.ent}</div>
    <div class="av-body">
      <div class="av-title">${title}</div>
      <div class="av-text">${text}</div>
      <div class="av-meta"><span>\u{1F4C5} ${esc(when)}</span></div>
    </div>
  </div>`;
}

/* ---------- vista usuario (inbox / recepcion) ---------- */
function renderUser() {
  const auto = (AV_FEED.auto || []);
  const manual = (AV_FEED.manual || []);
  let html = '';
  if (AV_CHANGES.length) {
    html += `<div class="av-sub">Novedades de empresas</div><div class="av-card">${AV_CHANGES.map(changeRow).join('')}</div>`;
  }
  if (auto.length) {
    html += `<div class="av-sub">Per\u00edodo de n\u00f3mina</div><div class="av-card">${auto.map(autoRow).join('')}</div>`;
  }
  if (manual.length) {
    html += `<div class="av-sub">Comunicados</div><div class="av-card">${manual.map(m => manualRow(m, false)).join('')}</div>`;
  }
  if (!html) html = `<div class="av-empty">No hay avisos en este momento.</div>`;
  $('#avBody').innerHTML = html;
}

/* ---------- vista admin (config / Envio de avisos) ----------
   Solo configuracion: las 3 plantillas del periodo (editables por superadmin)
   + comunicados manuales. NO muestra novedades de empresa (eso va en Avisos). */
function renderAdmin() {
  const canEditTpl = !!(AV_TPL && AV_TPL.can_edit_templates);
  let html = `<div class="av-sub">Avisos del per\u00edodo (autom\u00e1ticos)</div>`;
  if (canEditTpl) {
    // Superadmin: SIEMPRE las 3 plantillas editables, haya o no hito hoy.
    html += `<div class="av-card">
      ${['calc', 'cut', 'pay'].map(t => `<div class="av-row">
        <div class="av-ic ${t}">${SVG[t]}</div>
        <div class="av-body"><div class="av-title">${TPL_LABEL[t]}</div>
          <div class="av-text">Plantilla del aviso autom\u00e1tico (se muestra a las tiendas y empresas el d\u00eda del hito).</div></div>
        <div class="av-actions"><button class="av-iconbtn" data-tpl="${t}">Editar plantilla</button></div>
      </div>`).join('')}
    </div>`;
  } else {
    // Admin (no super): solo informativo, sin botones.
    html += `<div class="av-empty">Los avisos del per\u00edodo (\u00faltimo d\u00eda de c\u00e1lculo, d\u00eda de c\u00e1lculo y d\u00eda de pago) se muestran autom\u00e1ticamente a las tiendas y empresas el d\u00eda que corresponde. Solo el superadministrador puede editar sus plantillas.</div>`;
  }

  html += `<div class="av-sub">Comunicados manuales</div>`;
  html += AV_MANUAL.length
    ? `<div class="av-card">${AV_MANUAL.map(m => manualRow({
        id: m.id, title: m.title, body: m.body, audience: m.audience, is_active: m.is_active,
        from: m.starts_on ? fmtDate(m.starts_on) : null, to: m.ends_on ? fmtDate(m.ends_on) : null,
      }, true)).join('')}</div>`
    : `<div class="av-empty">A\u00fan no hay comunicados manuales. Crea uno con "+ Nuevo aviso".</div>`;

  $('#avBody').innerHTML = html;

  $('#avBody').querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', () => openTplModal(b.dataset.tpl)));
  $('#avBody').querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openManualModal(b.dataset.edit)));
  $('#avBody').querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => toggleManual(b.dataset.toggle)));
}

function fmtDate(iso) {
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/* Hoy en Caracas como YYYY-MM-DD (para predeterminar "Mostrar desde"). */
function todayISO() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p; // en-CA ya entrega YYYY-MM-DD
}

/* ---------- resaltar al llegar de la campanita ---------- */
export function gotoAviso(id) {
  const row = document.getElementById('av-man-' + id) || document.getElementById('av-' + id);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('av-flash'); void row.offsetWidth; row.classList.add('av-flash');
  setTimeout(() => row.classList.remove('av-flash'), 2600);
}

/* ---------- variables ---------- */
function insertVar(fieldId, token) {
  const el = document.getElementById(fieldId);
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, s) + token + el.value.slice(e);
  const pos = s + token.length;
  el.focus(); el.setSelectionRange(pos, pos);
  el.dispatchEvent(new Event('input'));
}
function varsHtml(id) {
  return `<div class="av-vars">${VAR_KEYS.map(k => `<button type="button" class="av-varbtn" data-k="${k}" data-target="${id}">${k}</button>`).join('')}</div>`;
}
function wireVars(scope) {
  scope.querySelectorAll('[data-k]').forEach(b =>
    b.addEventListener('click', () => insertVar(b.dataset.target, b.dataset.k)));
}

/* ---------- modal: plantilla automatica ---------- */
function fmtHora12(hhmm) {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm || '')) return hhmm || '';
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h < 12 ? 'a. m.' : 'p. m.'; let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}
function previewVars() {
  const v = (AV_TPL && AV_TPL.vars) || {};
  return {
    '#Periodo': v.Periodo || '',
    '#Fecha_Cierre': v.Fecha_Cierre || '',
    '#Fecha_Calculo': v.Fecha_Calculo || '',
    '#Fecha_Pago': v.Fecha_Pago || '',
    '#HoraLimite1': fmtHora12($('#avtHora1') ? $('#avtHora1').value : ((AV_TPL && AV_TPL.hora1) || '18:00')),
    '#HoraLimite2': fmtHora12($('#avtHora2') ? $('#avtHora2').value : ((AV_TPL && AV_TPL.hora2) || '14:00')),
  };
}
function applyVarsPreview(tpl) {
  const v = previewVars();
  let s = String(tpl || '');
  Object.keys(v).forEach(k => { s = s.split(k).join(v[k]); });
  return s;
}
function tplModalHtml(type) {
  const t = (AV_TPL && AV_TPL.templates && AV_TPL.templates[type]) || { title: '', short: '', text: '' };
  const h1 = (AV_TPL && AV_TPL.hora1) || '18:00';
  const h2 = (AV_TPL && AV_TPL.hora2) || '14:00';
  return `<div class="av-modal-bg" id="avTplBg">
    <div class="av-modal">
      <div class="av-modal-h"><h3>Editar plantilla \u2014 ${TPL_LABEL[type] || type}</h3>
        <button class="av-modal-x" id="avTplX">\u00d7</button></div>
      <div class="av-modal-b">
        <div class="av-field"><label>T\u00edtulo</label><input id="avtTitle" type="text" value="${esc(t.title)}"></div>
        <div class="av-field"><label>Texto corto (campanita)</label><input id="avtShort" type="text" value="${esc(t.short)}"></div>
        <div class="av-field"><label>Mensaje completo</label><textarea id="avtText">${esc(t.text)}</textarea></div>
        ${varsHtml('avtText')}
        <div class="av-help">Pulsa una variable para insertarla en el mensaje. Se reemplaza por el valor real del per\u00edodo vigente.</div>
        <div class="av-field" style="margin-top:12px"><label>Horas l\u00edmite (#HoraLimite1 / #HoraLimite2)</label>
          <div class="av-row2">
            <input id="avtHora1" type="time" value="${esc(h1)}">
            <input id="avtHora2" type="time" value="${esc(h2)}">
          </div>
          <div class="av-help">#HoraLimite1: l\u00edmite general. #HoraLimite2: hora m\u00e1xima del d\u00eda tope (config "Hora l\u00edmite del d\u00eda tope").</div>
        </div>
        <div class="av-preview"><div class="pl">Vista previa</div><div id="avtPrev"></div></div>
      </div>
      <div class="av-modal-f">
        <button class="av-btn" id="avTplCancel">Cancelar</button>
        <button class="av-btn av-btn-primary" id="avTplSave">Guardar plantilla</button>
      </div>
    </div></div>`;
}
function openTplModal(type) {
  $('#avModals').innerHTML = tplModalHtml(type);
  const bg = $('#avTplBg');
  const upd = () => {
    const title = applyVarsPreview($('#avtTitle').value);
    const text = applyVarsPreview($('#avtText').value);
    $('#avtPrev').innerHTML = `<b>${esc(title)}</b><br>${esc(text)}`;
  };
  wireVars(bg);
  ['avtTitle', 'avtText', 'avtHora1', 'avtHora2'].forEach(id => $('#' + id).addEventListener('input', upd));
  upd();
  const close = () => { bg.remove(); };
  $('#avTplX').addEventListener('click', close);
  $('#avTplCancel').addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  $('#avTplSave').addEventListener('click', async () => {
    const r = await api({
      action: 'tpl_save', type,
      title: $('#avtTitle').value, short: $('#avtShort').value, text: $('#avtText').value,
      hora1: $('#avtHora1').value, hora2: $('#avtHora2').value,
    });
    if (!r.ok) { alert(r.error || 'No se pudo guardar.'); return; }
    close();
    await loadAndRender();
  });
}

/* ---------- modal: aviso manual ---------- */
function manualModalHtml(m) {
  const isEdit = !!m;
  return `<div class="av-modal-bg" id="avManBg">
    <div class="av-modal">
      <div class="av-modal-h"><h3>${isEdit ? 'Editar aviso' : 'Nuevo aviso manual'}</h3>
        <button class="av-modal-x" id="avManX">\u00d7</button></div>
      <div class="av-modal-b">
        <div class="av-field"><label>T\u00edtulo</label><input id="avmTitle" type="text" value="${esc(m ? m.title : '')}" placeholder="Ej: Carga excepcional de d\u00edas libres"></div>
        <div class="av-field"><label>Mensaje</label><textarea id="avmBody" placeholder="Texto del comunicado\u2026">${esc(m ? m.body : '')}</textarea></div>
        ${varsHtml('avmBody')}
        <div class="av-help">Opcional: inserta variables del per\u00edodo en el mensaje.</div>
        <div class="av-row2" style="margin-top:12px">
          <div class="av-field"><label>Dirigido a</label>
            <select id="avmAud">
              <option value="everyone"${m && m.audience === 'everyone' ? ' selected' : ''}>Todos (incluye administradores y editores)</option>
              <option value="all"${m && m.audience === 'all' ? ' selected' : ''}>Todos (tiendas y empresas)</option>
              <option value="stores"${m && m.audience === 'stores' ? ' selected' : ''}>Solo tiendas</option>
              <option value="enterprises"${m && m.audience === 'enterprises' ? ' selected' : ''}>Solo empresas (no tiendas)</option>
              <option value="admins"${m && m.audience === 'admins' ? ' selected' : ''}>Solo administradores</option>
              <option value="editors"${m && m.audience === 'editors' ? ' selected' : ''}>Solo editores</option>
            </select></div>
          <div class="av-field"><label>Mostrar desde</label>
            <input id="avmFrom" type="date" value="${m && m.starts_on ? String(m.starts_on).slice(0, 10) : todayISO()}">
            <div class="av-help">El aviso aparece a partir de este día. Para lanzarlo a futuro, elige una fecha posterior.</div></div>
        </div>
        <div class="av-field"><label>Ocultar después de (opcional)</label>
          <input id="avmTo" type="date" value="${m && m.ends_on ? String(m.ends_on).slice(0, 10) : ''}">
          <div class="av-help">Déjalo vacío para que el aviso no caduque.</div></div>
      </div>
      <div class="av-modal-f">
        ${isEdit ? `<button class="av-btn" id="avManDel" style="margin-right:auto;color:#dc2626;border-color:#fecaca">Eliminar</button>` : ''}
        <button class="av-btn" id="avManCancel">Cancelar</button>
        <button class="av-btn av-btn-primary" id="avManSave">Guardar aviso</button>
      </div>
    </div></div>`;
}
async function openManualModal(editId) {
  let m = null;
  if (editId) m = AV_MANUAL.find(x => String(x.id) === String(editId)) || null;
  $('#avModals').innerHTML = manualModalHtml(m);
  const bg = $('#avManBg');
  wireVars(bg);
  const close = () => bg.remove();
  $('#avManX').addEventListener('click', close);
  $('#avManCancel').addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  if (editId) {
    const del = $('#avManDel');
    if (del) del.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este aviso? Esta acción no se puede deshacer.')) return;
      const r = await api({ action: 'delete_manual', id: editId });
      if (!r.ok) { alert(r.error || 'No se pudo eliminar.'); return; }
      close(); await loadAndRender();
    });
  }
  $('#avManSave').addEventListener('click', async () => {
    const payload = {
      action: 'save_manual',
      title: $('#avmTitle').value, body: $('#avmBody').value,
      audience: $('#avmAud').value,
      starts_on: $('#avmFrom').value || null, ends_on: $('#avmTo').value || null,
    };
    if (editId) payload.id = editId;
    const r = await api(payload);
    if (!r.ok) { alert(r.error || 'No se pudo guardar.'); return; }
    close(); await loadAndRender();
  });
}

async function toggleManual(id) {
  const r = await api({ action: 'toggle_manual', id });
  if (!r.ok) { alert(r.error || 'No se pudo cambiar.'); return; }
  await loadAndRender();
}
