/* =====================================================================
   js/views/cert-requests.js  →  vista "Mis solicitudes" (Constancias de
   Trabajo). Parte del grupo de menú "Solicitudes".

   Vista UNIFICADA tienda/gestor + admin:
     - Tienda/gestor: ve SOLO sus solicitudes; crea eligiendo empleados de su
       empresa + destinatario.
     - Admin: dos secciones (tabs):
         • "Bandeja"        → solicitudes de SU alcance para revisar/generar/
                              rechazar (endpoint cert-admin).
         • "Mis solicitudes"→ lo que el propio admin pidió (endpoint
                              cert-requests, igual que la tienda). Con combo de
                              empresa (columna Empresa siempre visible).
       Al crear, el admin elige empresa (tienda/empresa) y, opcional,
       departamento, y luego el picker de empleados (como en los reportes).

   Circuito: el SOLICITANTE solo elige empleados + destinatario. El salario,
   bono y firmante los completa el ADMIN en la revisión (panel de revisión de
   esta misma vista). "Generar" produce el PDF (endpoint cert-admin -> modulo
   _cert-pdf) y deja la constancia 'disponible'; el solicitante la descarga
   desde "Mis solicitudes" (endpoint cert-download, URL firmada).

   Endpoints:
     /api/cert-requests  (solicitante): companies, departments, roster, create,
                                         mine, cancel
     /api/cert-admin     (admin):       inbox, detail, save_line, generate, reject
     /api/cert-download  (descarga):    url (signed URL del PDF)

   Export: renderCertRequests(user)
     user = { kind:'admin', id, role, name } | { kind:'company', companyCode, companyType }
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);

const DEFAULT_RECIPIENT = 'A quien pueda interesar';
const DEFAULT_SIGNER_TITLE = 'ANALISTA DE CAPITAL HUMANO';

/* ---------- estado del módulo ---------- */
let USER = null;
let IS_ADMIN = false;
let TAB = 'mine';                 // admin: 'inbox' | 'mine'; company: siempre 'mine'
let COMPANIES = [];              // combo de empresas del alcance (admin/gestor)
let MINE = [];                   // solicitudes propias
let INBOX = [];                  // bandeja admin
let MINE_COMPANY = '';          // filtro de empresa (mis solicitudes, admin)
let MINE_STATUS = '';
let INBOX_COMPANY = '';
let INBOX_STATUS = '';

/* ---------- utils ---------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(String(d).length <= 10 ? d + 'T00:00:00' : d);
  if (isNaN(dt)) return '—';
  return dt.toLocaleDateString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (isNaN(dt)) return '—';
  return dt.toLocaleString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
/* Desfase legible entre dos instantes (solicitud -> generacion). Devuelve
   algo como "2 h 15 min", "3 d 4 h" o "12 min". '' si falta algun dato. */
function fmtDelay(fromIso, toIso) {
  if (!fromIso || !toIso) return '';
  const a = new Date(fromIso), b = new Date(toIso);
  if (isNaN(a) || isNaN(b)) return '';
  let ms = b - a;
  if (ms < 0) ms = 0;
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'menos de 1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), rm = min % 60;
  if (h < 24) return rm ? `${h} h ${rm} min` : `${h} h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}
/* Cédula: solo número al entrar; letra V/E automática (>80M → E) salvo override;
   se muestra con puntos de miles. */
function cedLetter(numStr, override) {
  if (override === 'V' || override === 'E') return override;
  const n = parseInt(String(numStr || '').replace(/\D/g, ''), 10);
  if (!n) return 'V';
  return n > 80000000 ? 'E' : 'V';
}
function fmtCedula(numStr, override) {
  const digits = String(numStr || '').replace(/\D/g, '');
  if (!digits) return '';
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cedLetter(digits, override)}-${grouped}`;
}
/* Número Bs con formato VE (miles con punto, decimales con coma). */
function fmtBs(n) {
  const v = typeof n === 'number' ? n : parseFloat(String(n == null ? '' : n).replace(/\./g, '').replace(',', '.'));
  if (isNaN(v)) return '';
  return v.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/* Parseo de un input Bs (formato VE) a Number. */
function parseBs(s) {
  const v = parseFloat(String(s == null ? '' : s).replace(/\./g, '').replace(',', '.'));
  return isNaN(v) ? null : v;
}

const STATUS_META = {
  solicitada: { label: 'solicitada', cls: 'cr-sol' },
  en_revision: { label: 'en revisión', cls: 'cr-rev' },
  generada: { label: 'generada', cls: 'cr-gen' },
  disponible: { label: 'disponible', cls: 'cr-disp' },
  rechazada: { label: 'rechazada', cls: 'cr-rech' },
  anulada: { label: 'anulada', cls: 'cr-anul' },
};
function statusPill(st) {
  const m = STATUS_META[st] || { label: st || '—', cls: 'cr-anul' };
  return `<span class="cr-pill ${m.cls}">${esc(m.label)}</span>`;
}

/* ---------- estilos ---------- */
function ensureStyles() {
  if (document.getElementById('crStyles')) return;
  const st = document.createElement('style');
  st.id = 'crStyles';
  st.textContent = `
  .cr-head{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap}
  .cr-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .cr-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .cr-b{font:inherit;font-size:13px;padding:8px 14px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);cursor:pointer;display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
  .cr-b:hover{background:var(--bg-soft,#f1f5f9)}
  .cr-b:disabled{opacity:.55;cursor:not-allowed}
  .cr-b-primary{background:var(--brand,#2563eb);color:#fff;border-color:var(--brand,#2563eb)}
  .cr-b-primary:hover{background:#1d4ed8}
  .cr-b-success{background:#16a34a;color:#fff;border-color:#16a34a}
  .cr-b-success:hover{background:#15803d}
  .cr-b-warn{color:#b45309;border-color:#f0d9a8}
  .cr-b-warn:hover{background:#fef6e7}
  .cr-b-mini{font-size:12px;padding:6px 11px}
  .cr-tabs{display:flex;gap:6px;margin:14px 0 4px;border-bottom:1px solid var(--border)}
  .cr-tab{font:inherit;font-size:13.5px;font-weight:600;padding:9px 14px;border:0;background:none;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
  .cr-tab.on{color:var(--brand,#2563eb);border-bottom-color:var(--brand,#2563eb)}
  .cr-tab .cr-n{font-size:11px;font-weight:700;background:var(--bg-soft,#eef2f7);border-radius:999px;padding:1px 7px;margin-left:6px}
  .cr-tab.on .cr-n{background:#dbeafe;color:#1e40af}
  .cr-filters{display:flex;gap:10px;margin:14px 0;flex-wrap:wrap}
  .cr-filters select{height:38px;border:1px solid var(--border);border-radius:9px;padding:0 12px;font:inherit;font-size:13px;background:var(--surface);color:var(--ink)}
  .cr-seal{display:flex;gap:10px;align-items:flex-start;margin:0 0 14px;padding:11px 13px;border:1px solid #f0d9a8;background:#fef6e7;border-radius:9px;font-size:12.5px;color:#92400e;line-height:1.45}
  .cr-seal svg{flex-shrink:0;margin-top:1px}
  .cr-seal b{color:#7c3a06}
  .cr-table{width:100%;border-collapse:collapse;margin-top:4px;font-size:13px}
  .cr-table th{text-align:left;font-weight:600;color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;padding:9px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
  .cr-table td{padding:11px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
  .cr-table tr:hover td{background:var(--bg-soft,#f8fafc)}
  .cr-strong{font-weight:600;color:var(--ink)}
  .cr-sub{color:var(--muted);font-size:11.5px}
  .cr-acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
  .cr-empty{padding:36px 14px;text-align:center;color:var(--muted)}
  .cr-pill{display:inline-block;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap}
  .cr-sol{background:#eef1f5;color:#475569}.cr-rev{background:#fef6e7;color:#92400e}
  .cr-gen{background:#eff4ff;color:#1e3a8a}.cr-disp{background:#e7f7ee;color:#166534}
  .cr-rech{background:#fdecec;color:#991b1b}.cr-anul{background:#eef1f5;color:#64748b}
  /* panel/inline (crear + revisar) */
  .cr-back{cursor:pointer;color:var(--muted);display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;border:0;background:none;font:inherit;padding:4px 0;margin-bottom:8px}
  .cr-back:hover{color:var(--ink)}
  .cr-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px 22px;margin-bottom:16px;box-shadow:0 1px 3px rgba(15,23,42,.04)}
  .cr-card h3{margin:0 0 4px;font-size:15px;font-weight:650;color:var(--ink)}
  .cr-card .cr-cardsub{font-size:12.5px;color:var(--muted);margin:0 0 16px}
  .cr-field{margin-bottom:14px}
  .cr-field label{display:block;font-size:12.5px;font-weight:600;color:var(--ink);margin-bottom:5px}
  .cr-field input,.cr-field select,.cr-field textarea{width:100%;height:42px;border:1px solid var(--border);border-radius:9px;padding:0 12px;font:inherit;font-size:13.5px;background:var(--surface);color:var(--ink);box-sizing:border-box}
  .cr-field textarea{height:auto;padding:10px 12px;resize:vertical}
  .cr-hint{font-size:11.5px;color:var(--faint,#94a3b8);margin-top:4px}
  .cr-grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}
  .cr-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 14px}
  @media(max-width:640px){.cr-grid2,.cr-grid3{grid-template-columns:1fr}}
  .cr-ced{display:grid;grid-template-columns:74px 1fr;gap:8px}
  .cr-calc{background:var(--bg-soft,#fbfcfe);border:1px solid var(--border);border-radius:9px;padding:12px 14px;margin-bottom:12px}
  .cr-calc .cr-eq{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-top:6px;flex-wrap:wrap}
  .cr-picker{border:1px solid var(--border);border-radius:9px;max-height:280px;overflow:auto}
  .cr-erow{display:flex;align-items:center;gap:11px;padding:10px 13px;border-bottom:1px solid var(--border);cursor:pointer}
  .cr-erow:last-child{border-bottom:0}
  .cr-erow:hover{background:var(--bg-soft,#fafbfd)}
  .cr-erow input{width:16px;height:16px;accent-color:var(--brand,#2563eb);flex:none}
  .cr-erow .cr-en{font-weight:600;font-size:13px;color:var(--ink)}
  .cr-erow .cr-em{font-size:11.5px;color:var(--muted)}
  .cr-erow .cr-esp{flex:1}
  .cr-avatar{width:34px;height:34px;border-radius:8px;object-fit:cover;flex:none;background:var(--bg-soft,#eef2f7)}
  .cr-avatar-ph{width:34px;height:34px;border-radius:8px;flex:none;background:var(--bg-soft,#eef2f7);display:flex;align-items:center;justify-content:center;color:var(--faint,#94a3b8);font-size:12px;font-weight:700}
  .cr-chosen{font-size:12px;color:var(--brand,#2563eb);font-weight:600;margin-top:8px}
  .cr-savebar{position:sticky;bottom:14px;margin-top:16px;background:var(--surface);border:1px solid var(--border);border-radius:11px;box-shadow:0 8px 30px rgba(15,23,42,.08);padding:12px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .cr-savebar .cr-sp{flex:1}
  .cr-savebar .cr-muted{color:var(--muted);font-size:12.5px}
  /* revisión: paper preview */
  .cr-rev{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start}
  @media(max-width:960px){.cr-rev{grid-template-columns:1fr}}
  .cr-paper{background:#fff;border:1px solid var(--border);border-radius:9px;box-shadow:0 8px 30px rgba(15,23,42,.06);padding:30px 34px;font-family:"Times New Roman",Georgia,serif;color:#111;font-size:13px;line-height:1.55;min-height:520px;display:flex;flex-direction:column}
  .cr-paper .cr-ph{font-weight:700;font-style:italic;font-size:14px}
  .cr-paper .cr-prif{font-weight:700;font-style:italic;font-size:11.5px;margin-bottom:20px}
  .cr-paper .cr-tit{text-align:center;font-weight:700;text-decoration:underline;font-size:15px;margin:22px 0 20px}
  .cr-paper p{margin:0 0 13px;text-align:justify}
  .cr-paper .cr-u{text-decoration:underline;font-weight:700}
  .cr-paper .cr-mark{background:#fff7d6;outline:1px dashed #d4a72c}
  .cr-paper .cr-firma{text-align:center;margin-top:34px}
  .cr-paper .cr-firma img{max-height:52px;max-width:220px;object-fit:contain;display:block;margin:0 auto}
  .cr-paper .cr-firma-line{width:230px;border-top:1px solid #333;margin:4px auto 3px}
  .cr-paper .cr-firma-nm{font-style:italic}
  .cr-paper .cr-firma-cg{font-weight:700;font-size:12px}
  .cr-paper .cr-foot{margin-top:auto;padding-top:14px;font-size:9.5px;font-style:italic;text-align:center;color:#333;border-top:1px solid #ddd;line-height:1.4}
  .cr-revnav{display:flex;align-items:center;gap:8px}
  .cr-revnav .cr-count{font-size:12.5px;color:var(--muted)}
  /* modal genérico (confirm / motivo) */
  .cr-ov{position:fixed;inset:0;background:rgba(15,23,42,.42);display:flex;align-items:center;justify-content:center;z-index:80;padding:16px}
  .cr-modal{background:var(--card,#fff);border-radius:14px;max-width:480px;width:100%;padding:22px;box-shadow:0 18px 48px rgba(15,23,42,.24);max-height:90vh;overflow:auto}
  .cr-modal h3{margin:0 0 6px;font-size:17px;color:var(--ink)}
  .cr-modal p{margin:0 0 6px;color:var(--muted);font-size:13px;line-height:1.5}
  .cr-modal textarea{width:100%;min-height:80px;border:1px solid var(--border);border-radius:9px;padding:10px 11px;font:inherit;font-size:13px;background:var(--surface);color:var(--ink);box-sizing:border-box;margin-top:8px;resize:vertical}
  .cr-modal-err{display:none;margin-top:10px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:12.5px;padding:9px 11px;border-radius:9px}
  .cr-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
  /* toast */
  .cr-toast-wrap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:120;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
  .cr-toast{pointer-events:auto;display:flex;align-items:center;gap:10px;background:var(--ink,#0f172a);color:#fff;font-size:13px;font-weight:500;padding:11px 16px;border-radius:11px;box-shadow:0 10px 30px rgba(15,23,42,.28);opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s;max-width:90vw}
  .cr-toast.show{opacity:1;transform:translateY(0)}
  .cr-toast .cr-ico{display:inline-flex;width:20px;height:20px;border-radius:999px;align-items:center;justify-content:center;font-size:12px;flex:none}
  .cr-toast-ok .cr-ico{background:#16a34a}.cr-toast-info .cr-ico{background:#2563eb}.cr-toast-err .cr-ico{background:#dc2626}

  /* MOVIL (<=768px): la tabla de solicitudes (bandeja / mis solicitudes) se
     aplana en TARJETAS: se oculta el thead y cada <tr> se apila con pares
     etiqueta->valor (la etiqueta sale de data-label en cada <td>). Antes se
     cortaba a la derecha (columnas Origen/Fecha/Estado/acciones). Tambien se
     apilan filtros y el formulario de crear/revisar. */
  @media (max-width:768px){
    .cr-filters{flex-direction:column}
    .cr-filters select{width:100%}
    /* Tabla -> tarjetas */
    .cr-table{display:block}
    .cr-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
    .cr-table tbody{display:flex;flex-direction:column;gap:11px}
    .cr-table tbody tr{display:block;border:1px solid var(--border);border-radius:12px;
      background:var(--surface);box-shadow:0 1px 3px rgba(15,23,42,.05);padding:6px 14px}
    .cr-table tbody tr:hover td{background:none}
    .cr-table tbody td{display:flex;align-items:baseline;justify-content:space-between;gap:14px;
      padding:8px 0;border:0;border-bottom:1px solid var(--border);text-align:right;white-space:normal}
    .cr-table tbody td:last-child{border-bottom:0}
    .cr-table tbody td::before{content:attr(data-label);flex-shrink:0;text-align:left;
      color:var(--muted);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
    /* La celda de acciones ocupa toda la fila, botones alineados a la derecha. */
    .cr-table tbody td.cr-actcell{justify-content:flex-end}
    .cr-table tbody td.cr-actcell::before{display:none}
    .cr-acts{justify-content:flex-end;width:100%}
    /* Formularios de crear/revisar: grids a una columna, preview debajo. */
    .cr-grid2,.cr-grid3{grid-template-columns:1fr}
    .cr-rev{grid-template-columns:1fr}
  }
  `;
  document.head.appendChild(st);
}

/* ---------- toast / confirm / notice (sin nativos) ---------- */
let _toastWrap = null;
function toast(msg, kind = 'ok') {
  if (!_toastWrap) { _toastWrap = document.createElement('div'); _toastWrap.className = 'cr-toast-wrap'; document.body.appendChild(_toastWrap); }
  const t = document.createElement('div');
  t.className = `cr-toast cr-toast-${kind === 'info' ? 'info' : kind === 'err' ? 'err' : 'ok'}`;
  const ico = kind === 'info' ? '\u2139' : kind === 'err' ? '\u2715' : '\u2713';
  t.innerHTML = `<span class="cr-ico">${ico}</span><span>${esc(msg)}</span>`;
  _toastWrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 220); }, 2800);
}
function confirmModal({ title, bodyHtml, okLabel = 'Aceptar', cancelLabel = 'Cancelar' }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'cr-ov';
    ov.innerHTML = `
      <div class="cr-modal">
        <h3>${esc(title || '¿Confirmar?')}</h3>
        ${bodyHtml ? `<div>${bodyHtml}</div>` : ''}
        <div class="cr-foot">
          <button class="cr-b" data-c>${esc(cancelLabel)}</button>
          <button class="cr-b cr-b-primary" data-o>${esc(okLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const done = v => { ov.remove(); resolve(v); };
    ov.querySelector('[data-c]').addEventListener('click', () => done(false));
    ov.querySelector('[data-o]').addEventListener('click', () => done(true));
    // Se cierra SOLO con sus botones (Cancelar / Aceptar); no al hacer clic fuera.
  });
}
/* Modal para pedir un motivo (rechazo/anulación). Resuelve string o null. */
function reasonModal({ title, placeholder, okLabel = 'Confirmar' }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'cr-ov';
    ov.innerHTML = `
      <div class="cr-modal">
        <h3>${esc(title || 'Motivo')}</h3>
        <p>Este texto quedará registrado y visible para el solicitante.</p>
        <textarea id="crReason" placeholder="${esc(placeholder || 'Escribe el motivo…')}"></textarea>
        <div class="cr-modal-err" id="crReasonErr"></div>
        <div class="cr-foot">
          <button class="cr-b" data-c>Cancelar</button>
          <button class="cr-b cr-b-primary" data-o>${esc(okLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const ta = ov.querySelector('#crReason');
    const err = ov.querySelector('#crReasonErr');
    const done = v => { ov.remove(); resolve(v); };
    ov.querySelector('[data-c]').addEventListener('click', () => done(null));
    ov.querySelector('[data-o]').addEventListener('click', () => {
      const v = ta.value.trim();
      if (!v) { err.textContent = 'El motivo es obligatorio.'; err.style.display = 'block'; ta.focus(); return; }
      done(v);
    });
    // Se cierra SOLO con sus botones (Cancelar / Confirmar); no al hacer clic fuera.
    ta.focus();
  });
}

/* ---------- API helpers ---------- */
// admin/superadmin pueden editar y RE-generar una constancia ya emitida
// (gestor_empresa y editor_personal no).
function isPowerAdmin() {
  return USER && USER.kind === 'admin' && (USER.role === 'admin' || USER.role === 'superadmin');
}
function actorPayload() {
  return USER.kind === 'company'
    ? { actor: { kind: 'company', companyCode: USER.companyCode } }
    : { actor: { kind: 'admin', id: USER.id } };
}
function userPayload() {
  return USER.kind === 'company'
    ? { user: { kind: 'company', companyCode: USER.companyCode } }
    : { user: { kind: 'admin', id: USER.id } };
}
async function apiReq(payload) {
  return fetch('/api/cert-requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...actorPayload(), ...payload }),
  }).then(x => x.json()).catch(() => ({ ok: false, error: 'Error de red.' }));
}
async function apiAdmin(payload) {
  return fetch('/api/cert-admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...userPayload(), ...payload }),
  }).then(x => x.json()).catch(() => ({ ok: false, error: 'Error de red.' }));
}

/* =====================================================================
   RENDER PRINCIPAL
   ===================================================================== */
export async function renderCertRequests(user) {
  USER = user;
  IS_ADMIN = user.kind === 'admin';
  TAB = IS_ADMIN ? 'inbox' : 'mine';
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="cr-head"><div><h1>Constancias de trabajo</h1>
      <p>Solicitud, revisión y descarga de constancias laborales.</p></div></div>
    <div class="pnl-loading" style="margin-top:18px">Cargando…</div>`;
  // Cargar empresas (para combos) + datos segun rol.
  if (IS_ADMIN) {
    // El admin NO tiene "Mis solicitudes": inicia solicitudes que quedan a
    // nombre de la empresa (la ve la tienda) y las gestiona desde la Bandeja.
    const [comp] = await Promise.all([apiReq({ action: 'companies' })]);
    COMPANIES = (comp && comp.ok && comp.companies) ? comp.companies : [];
    await loadInbox();
  } else {
    await loadMine();
  }
  paint();
}

async function loadMine() {
  const p = { action: 'mine' };
  if (IS_ADMIN && MINE_COMPANY) p.company_code = MINE_COMPANY;
  const r = await apiReq(p);
  MINE = (r && r.ok && r.requests) ? r.requests : [];
}
async function loadInbox() {
  const p = { action: 'inbox' };
  if (INBOX_COMPANY) p.company_code = INBOX_COMPANY;
  if (INBOX_STATUS) p.status = INBOX_STATUS;
  const r = await apiAdmin(p);
  INBOX = (r && r.ok && r.requests) ? r.requests : [];
}

/* Aplana solicitudes → filas por línea (una constancia por fila). */
function flatten(requests) {
  const rows = [];
  (requests || []).forEach(req => {
    (req.lines || []).forEach(l => rows.push({ req, line: l }));
  });
  return rows;
}

function companyName(code) {
  const c = COMPANIES.find(x => x.company_code === code);
  return c ? c.business_name : code;
}

function paint() {
  $('#pnlMain').innerHTML = `
    <div class="cr-head">
      <div><h1>Constancias de trabajo</h1>
        <p>${IS_ADMIN ? 'Revisa y genera las constancias de tu alcance. Tambien puedes iniciar una solicitud para una empresa (quedara en su lista).' : 'Solicita constancias para tu personal y descárgalas cuando estén listas.'}</p></div>
      <button class="cr-b cr-b-primary" id="crNew">${plusIco()} Nueva solicitud</button>
    </div>
    <div id="crBody"></div>`;

  const nb = $('#crNew');
  if (nb) nb.addEventListener('click', () => openCreate());

  if (IS_ADMIN) renderInbox();
  else renderMine();
}

function plusIco() {
  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
}
function sealNote(text) {
  return `<div class="cr-seal">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="5"/><path d="M12 14v7"/><path d="M8 21h8"/></svg>
    <div>${text}</div></div>`;
}
function companyOptions(selected, allLabel) {
  const opts = [`<option value="">${esc(allLabel || 'Todas las empresas')}</option>`]
    .concat(COMPANIES.map(c =>
      `<option value="${esc(c.company_code)}" ${c.company_code === selected ? 'selected' : ''}>${esc(c.company_code)} - ${esc(c.business_name)}</option>`));
  return opts.join('');
}
function statusOptions(selected) {
  const list = [['', 'Todos los estados'], ['solicitada', 'Solicitada'], ['en_revision', 'En revisión'],
    ['generada', 'Generada'], ['disponible', 'Disponible'], ['rechazada', 'Rechazada'], ['anulada', 'Anulada']];
  return list.map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(l)}</option>`).join('');
}

/* =====================================================================
   BANDEJA (admin): filas por línea, con Revisar / Rechazar
   ===================================================================== */
function renderInbox() {
  const body = $('#crBody');
  const filters = `
    <div class="cr-filters">
      <select id="crInbCompany">${companyOptions(INBOX_COMPANY)}</select>
      <select id="crInbStatus">${statusOptions(INBOX_STATUS)}</select>
    </div>`;
  const rows = flatten(INBOX);
  if (!rows.length) {
    body.innerHTML = filters + `<div class="cr-empty">No hay solicitudes en tu alcance con estos filtros.</div>`;
    bindInboxFilters();
    return;
  }
  body.innerHTML = filters + `
    <table class="cr-table">
      <thead><tr>
        <th>Solicitud</th><th>Empresa</th><th>Empleado</th><th>Origen</th><th>Fecha</th><th>Estado</th><th></th>
      </tr></thead>
      <tbody>${rows.map(inboxRow).join('')}</tbody>
    </table>`;
  bindInboxFilters();
  body.querySelectorAll('[data-review]').forEach(b =>
    b.addEventListener('click', () => openReview(+b.dataset.review)));
  body.querySelectorAll('[data-reject]').forEach(b =>
    b.addEventListener('click', () => rejectLine(+b.dataset.reject)));
  body.querySelectorAll('[data-download]').forEach(b =>
    b.addEventListener('click', () => downloadConstancia(+b.dataset.download, b)));
}
function bindInboxFilters() {
  const cc = $('#crInbCompany'), st = $('#crInbStatus');
  if (cc) cc.addEventListener('change', async () => { INBOX_COMPANY = cc.value; await loadInbox(); renderInbox(); });
  if (st) st.addEventListener('change', async () => { INBOX_STATUS = st.value; await loadInbox(); renderInbox(); });
}
function inboxRow({ req, line }) {
  const canAct = line.status === 'solicitada' || line.status === 'en_revision';
  let acts;
  if (canAct) {
    acts = `<button class="cr-b cr-b-mini cr-b-warn" data-reject="${line.id}">Rechazar</button>
       <button class="cr-b cr-b-mini cr-b-primary" data-review="${line.id}">Revisar</button>`;
  } else if (line.status === 'rechazada') {
    acts = `<span class="cr-sub">${esc(line.reject_reason || 'rechazada')}</span>`;
  } else if (line.status === 'disponible') {
    // Ya emitida: el admin puede verla/editarla y descargar el PDF.
    acts = `<button class="cr-b cr-b-mini" data-review="${line.id}">Ver</button>
       <button class="cr-b cr-b-mini cr-b-primary" data-download="${line.id}">${dlIco()} Descargar</button>`;
  } else {
    acts = `<button class="cr-b cr-b-mini" data-review="${line.id}">Ver</button>`;
  }
  // Bajo el estado: si ya fue generada, cuando y cuanto tardo desde la solicitud.
  let genSub = '';
  if ((line.status === 'generada' || line.status === 'disponible') && line.generated_at) {
    const delay = fmtDelay(req.requested_at, line.generated_at);
    genSub = `<div class="cr-sub">${esc(fmtDateTime(line.generated_at))}${delay ? ' · ' + esc(delay) : ''}</div>`;
  }
  // Origen de la solicitud: la inicio un admin o la pidio la propia tienda.
  const origen = req.created_via === 'admin'
    ? '<span class="cr-pill cr-gen">Iniciada por admin</span>'
    : '<span class="cr-pill cr-sol">Pedida por la tienda</span>';
  return `<tr>
    <td data-label="Solicitud"><span class="cr-strong">#${req.id}</span></td>
    <td data-label="Empresa">${esc(companyName(req.company_code))}<div class="cr-sub">${esc(req.company_code)}</div></td>
    <td data-label="Empleado"><span class="cr-strong">${esc(line.worker_full_name)}</span><div class="cr-sub">${esc(fmtCedula(line.worker_id_number))}</div></td>
    <td data-label="Origen">${origen}</td>
    <td data-label="Fecha">${esc(fmtDateTime(req.requested_at))}</td>
    <td data-label="Estado">${statusPill(line.status)}${genSub}</td>
    <td class="cr-actcell"><div class="cr-acts">${acts}</div></td>
  </tr>`;
}

/* =====================================================================
   MIS SOLICITUDES: filas por línea; tienda/gestor y admin (mismo look)
   ===================================================================== */
function renderMine() {
  const body = $('#crBody');
  const adminFilter = IS_ADMIN
    ? `<select id="crMineCompany">${companyOptions(MINE_COMPANY)}</select>` : '';
  const filters = `
    <div class="cr-filters">
      ${adminFilter}
      <select id="crMineStatus">${statusOptions(MINE_STATUS)}</select>
    </div>`;
  const seal = sealNote('Al descargar una constancia, <b>imprímela y colócale el sello húmedo</b> de la empresa para que tenga validez. El sello es físico (no viene en el PDF).');

  let rows = flatten(MINE);
  if (MINE_STATUS) rows = rows.filter(r => r.line.status === MINE_STATUS);

  if (!rows.length) {
    body.innerHTML = filters + seal + `<div class="cr-empty">${MINE.length ? 'No hay constancias con este filtro.' : 'Aún no has creado solicitudes. Empieza con “Nueva solicitud”.'}</div>`;
    bindMineFilters();
    return;
  }
  body.innerHTML = filters + seal + `
    <table class="cr-table">
      <thead><tr>
        <th>Solicitud</th>${IS_ADMIN ? '<th>Empresa</th>' : ''}<th>Empleado</th><th>Destinatario</th><th>Fecha</th><th>Estado</th><th></th>
      </tr></thead>
      <tbody>${rows.map(mineRow).join('')}</tbody>
    </table>`;
  bindMineFilters();
  body.querySelectorAll('[data-cancel]').forEach(b =>
    b.addEventListener('click', () => cancelRequest(+b.dataset.cancel)));
  body.querySelectorAll('[data-download]').forEach(b =>
    b.addEventListener('click', () => downloadConstancia(+b.dataset.download, b)));
}
function bindMineFilters() {
  const cc = $('#crMineCompany'), st = $('#crMineStatus');
  if (cc) cc.addEventListener('change', async () => { MINE_COMPANY = cc.value; await loadMine(); renderMine(); });
  if (st) st.addEventListener('change', () => { MINE_STATUS = st.value; renderMine(); });
}
function mineRow({ req, line }) {
  let acts = '';
  if (line.status === 'disponible') {
    acts = `<button class="cr-b cr-b-mini cr-b-primary" data-download="${line.id}">${dlIco()} Descargar</button>`;
  } else if (line.status === 'generada') {
    // Snapshot generado pero el PDF aun no quedo listo (reintento pendiente).
    acts = `<span class="cr-sub">PDF en proceso…</span>`;
  } else if (line.status === 'rechazada') {
    acts = `<span class="cr-sub">${esc(line.reject_reason || 'rechazada')}</span>`;
  } else if (line.status === 'solicitada' || line.status === 'en_revision') {
    // Anular solo lo hace admin/superadmin (desde su gestion); la tienda espera.
    acts = `<span class="cr-sub">en proceso</span>`;
  }
  // Bajo el estado: fecha en que quedo lista (generada/disponible).
  let genSub = '';
  if ((line.status === 'generada' || line.status === 'disponible') && line.generated_at) {
    genSub = `<div class="cr-sub">lista ${esc(fmtDate(line.generated_at))}</div>`;
  }
  return `<tr>
    <td data-label="Solicitud"><span class="cr-strong">#${req.id}</span></td>
    ${IS_ADMIN ? `<td data-label="Empresa">${esc(companyName(req.company_code))}<div class="cr-sub">${esc(req.company_code)}</div></td>` : ''}
    <td data-label="Empleado"><span class="cr-strong">${esc(line.worker_full_name)}</span><div class="cr-sub">${esc(fmtCedula(line.worker_id_number))}</div></td>
    <td data-label="Destinatario">${esc(line.recipient || req.recipient || DEFAULT_RECIPIENT)}</td>
    <td data-label="Fecha">${esc(fmtDate(req.requested_at))}</td>
    <td data-label="Estado">${statusPill(line.status)}${genSub}</td>
    <td class="cr-actcell"><div class="cr-acts">${acts}</div></td>
  </tr>`;
}
function dlIco() {
  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>';
}

/* Descarga el PDF de una constancia: pide una URL firmada al backend, baja el
   PDF como blob y lo guarda con el nombre amable (blob URL respeta 'download'
   aunque la URL firmada sea de otro dominio). Fallback a abrir en pestana. */
async function downloadConstancia(lineId, btn) {
  const orig = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Preparando…'; }
  let d;
  try {
    d = await fetch('/api/cert-download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...actorPayload(), action: 'url', line_id: lineId }),
    }).then(x => x.json());
  } catch { d = { ok: false, error: 'Error de red.' }; }
  if (!d || !d.ok || !d.url) {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    toast((d && d.error) || 'No se pudo obtener la constancia.', 'err');
    return;
  }
  const fname = d.filename || 'Constancia de trabajo.pdf';
  // Bajar el PDF como blob para poder imponer el nombre del archivo.
  try {
    const resp = await fetch(d.url);
    if (!resp.ok) throw new Error('fetch pdf ' + resp.status);
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
  } catch {
    // Fallback: abrir la URL firmada directamente (el navegador usara su
    // propio nombre, pero al menos se descarga/visualiza).
    const w = window.open(d.url, '_blank', 'noopener');
    if (!w) {
      const a = document.createElement('a');
      a.href = d.url; a.target = '_blank'; a.rel = 'noopener'; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
    }
  }
  if (btn) { btn.disabled = false; btn.innerHTML = orig; }
}

async function cancelRequest(reqId) {
  const ok = await confirmModal({
    title: 'Anular solicitud',
    bodyHtml: `<p>Se anulará la solicitud <span class="cr-strong">#${reqId}</span> y todas sus líneas aún no generadas. Esta acción no se puede deshacer.</p>`,
    okLabel: 'Anular', cancelLabel: 'Volver',
  });
  if (!ok) return;
  const d = await apiReq({ action: 'cancel', request_id: reqId });
  if (!d.ok) { toast(d.error || 'No se pudo anular.', 'err'); return; }
  await loadMine();
  renderMine();
  toast('Solicitud anulada', 'info');
}

/* =====================================================================
   CREAR SOLICITUD (inline)
   ===================================================================== */
let CREATE = null;   // { company_code, department, recipient, roster:[], selected:Set, note }

async function openCreate() {
  CREATE = {
    company_code: USER.kind === 'company' ? USER.companyCode : '',
    department: '',
    departments: [],
    recipient: DEFAULT_RECIPIENT,
    roster: [],
    selected: new Set(),
    note: '',
  };
  // La tienda tiene empresa fija: cargar su roster directo.
  paintCreate();
  if (CREATE.company_code) await onCompanyChosen();
}

function paintCreate() {
  const isCompany = USER.kind === 'company';
  const companySel = isCompany ? '' : `
    <div class="cr-field">
      <label>Empresa</label>
      <select id="crcCompany">
        <option value="">Elige una empresa…</option>
        ${COMPANIES.map(c => `<option value="${esc(c.company_code)}" ${c.company_code === CREATE.company_code ? 'selected' : ''}>${esc(c.company_code)} - ${esc(c.business_name)}</option>`).join('')}
      </select>
      <div class="cr-hint">Puedes lanzar la solicitud por cualquier empresa de tu alcance.</div>
    </div>`;

  const deptSel = (!isCompany && CREATE.departments.length) ? `
    <div class="cr-field">
      <label>Departamento <span style="font-weight:400;color:var(--muted)">(opcional)</span></label>
      <select id="crcDept">
        <option value="">Todos los departamentos</option>
        ${CREATE.departments.map(d => `<option value="${esc(String(d.id))}" ${String(d.id) === String(CREATE.department) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
      </select>
    </div>` : '';

  $('#pnlMain').innerHTML = `
    <button class="cr-back" id="crcBack">‹ Volver</button>
    <div class="cr-head"><div><h1>Nueva constancia de trabajo</h1>
      <p>Elige a quién va dirigida y a los empleados. Se generará una constancia por empleado.</p></div></div>

    <div class="cr-card">
      <h3>Destinatario</h3>
      <p class="cr-cardsub">Por defecto va dirigida “${esc(DEFAULT_RECIPIENT)}”. Puedes reemplazarlo por un nombre o entidad específica.</p>
      <div class="cr-field">
        <label>Dirigida a</label>
        <input id="crcRecipient" value="${esc(CREATE.recipient)}" maxlength="160">
        <div class="cr-hint">Ej.: “Banco de Venezuela”, “Consulado de España”, o deja el texto por defecto.</div>
      </div>
    </div>

    <div class="cr-card">
      <h3>Empresa y empleados</h3>
      <p class="cr-cardsub">El salario, el bono y el firmante los completa el administrador al revisar. Aquí solo eliges a quién va dirigida y a qué empleados.</p>
      ${companySel}
      ${deptSel}
      <div class="cr-field" style="margin-bottom:10px">
        <input id="crcSearch" placeholder="Buscar por nombre o cédula…" ${CREATE.company_code ? '' : 'disabled'}>
      </div>
      <div id="crcPickerWrap">
        ${CREATE.company_code ? '<div class="pnl-loading">Cargando personal…</div>' : '<div class="cr-empty">Elige una empresa para ver su personal.</div>'}
      </div>
      <div class="cr-chosen" id="crcChosen"></div>
    </div>

    <div class="cr-savebar">
      <span class="cr-muted" id="crcInfo">${CREATE.company_code ? esc(companyLabel(CREATE.company_code)) : 'Sin empresa seleccionada'}</span>
      <span class="cr-sp"></span>
      <button class="cr-b" id="crcCancel">Cancelar</button>
      <button class="cr-b cr-b-primary" id="crcSend" disabled>Enviar solicitud</button>
    </div>`;

  $('#crcBack').addEventListener('click', () => paint());
  $('#crcCancel').addEventListener('click', () => paint());
  const rec = $('#crcRecipient');
  rec.addEventListener('input', () => { CREATE.recipient = rec.value; });
  const comp = $('#crcCompany');
  if (comp) comp.addEventListener('change', async () => {
    CREATE.company_code = comp.value; CREATE.department = ''; CREATE.departments = [];
    CREATE.roster = []; CREATE.selected.clear();
    paintCreate();
    if (CREATE.company_code) await onCompanyChosen();
  });
  const dept = $('#crcDept');
  if (dept) dept.addEventListener('change', async () => {
    CREATE.department = dept.value;
    await reloadRoster();
  });
  const search = $('#crcSearch');
  if (search) {
    let deb;
    search.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => reloadRoster(search.value), 260); });
  }
  $('#crcSend').addEventListener('click', submitCreate);
  refreshChosen();
}

function companyLabel(code) {
  const c = COMPANIES.find(x => x.company_code === code);
  if (c) return `Empresa: ${c.company_code} - ${c.business_name}`;
  return USER.kind === 'company' ? `Empresa: ${USER.companyCode}` : `Empresa: ${code}`;
}

async function onCompanyChosen() {
  // Cargar departamentos (solo para admin/no-tienda) y roster.
  if (USER.kind !== 'company') {
    const dr = await apiReq({ action: 'departments', company_code: CREATE.company_code });
    CREATE.departments = (dr && dr.ok && dr.departments) ? dr.departments : [];
    // Re-pintar para que aparezca el combo de departamento si hay.
    if (CREATE.departments.length) paintCreate();
  }
  await reloadRoster();
}

async function reloadRoster(q) {
  const wrap = $('#crcPickerWrap');
  if (wrap) wrap.innerHTML = '<div class="pnl-loading">Cargando personal…</div>';
  const r = await apiReq({
    action: 'roster', company_code: CREATE.company_code,
    department: CREATE.department || null, q: q != null ? q : ($('#crcSearch') ? $('#crcSearch').value : ''),
  });
  CREATE.roster = (r && r.ok && r.workers) ? r.workers : [];
  renderPicker();
}

function renderPicker() {
  const wrap = $('#crcPickerWrap');
  if (!wrap) return;
  if (!CREATE.roster.length) {
    wrap.innerHTML = '<div class="cr-empty">No se encontró personal con estos criterios.</div>';
    return;
  }
  wrap.innerHTML = `<div class="cr-picker">${CREATE.roster.map(pickerRow).join('')}</div>`;
  wrap.querySelectorAll('[data-ced]').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT') return; // el change lo maneja el checkbox
      const cb = row.querySelector('input');
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const cb = row.querySelector('input');
    cb.addEventListener('change', () => {
      const ced = row.dataset.ced;
      if (cb.checked) CREATE.selected.add(ced); else CREATE.selected.delete(ced);
      refreshChosen();
    });
  });
}
function pickerRow(w) {
  const ced = String(w.id_number || '');
  const checked = CREATE.selected.has(ced) ? 'checked' : '';
  const avatar = w.thumb_url
    ? `<img class="cr-avatar" src="${esc(w.thumb_url)}" alt="" loading="lazy">`
    : `<div class="cr-avatar-ph">${esc((w.full_name || '?').slice(0, 1).toUpperCase())}</div>`;
  const meta = [fmtCedula(ced), w.role || '', w.start_date ? 'Ingreso ' + fmtDate(w.start_date) : '', w.department_name || '']
    .filter(Boolean).join(' · ');
  return `<label class="cr-erow" data-ced="${esc(ced)}">
    <input type="checkbox" ${checked}>
    ${avatar}
    <span><div class="cr-en">${esc(w.full_name)}</div><div class="cr-em">${esc(meta)}</div></span>
    <span class="cr-esp"></span>
  </label>`;
}
function refreshChosen() {
  const n = CREATE.selected.size;
  const ch = $('#crcChosen');
  if (ch) ch.textContent = n ? `${n} empleado${n === 1 ? '' : 's'} seleccionado${n === 1 ? '' : 's'}` : '';
  const send = $('#crcSend');
  if (send) send.disabled = !(CREATE.company_code && n > 0);
  const info = $('#crcInfo');
  if (info && CREATE.company_code) info.textContent = companyLabel(CREATE.company_code);
}

async function submitCreate() {
  const send = $('#crcSend');
  if (!CREATE.company_code || !CREATE.selected.size) return;
  send.disabled = true; const orig = send.textContent; send.textContent = 'Enviando…';
  const d = await apiReq({
    action: 'create',
    company_code: CREATE.company_code,
    recipient: CREATE.recipient || DEFAULT_RECIPIENT,
    workers: [...CREATE.selected],
    note: CREATE.note || null,
  });
  if (!d.ok) { toast(d.error || 'No se pudo crear la solicitud.', 'err'); send.disabled = false; send.textContent = orig; return; }
  // Recargar y volver a la lista. El admin ve la nueva solicitud en su Bandeja
  // (queda a nombre de la empresa); la tienda la vera en su propia lista.
  if (IS_ADMIN) await loadInbox();
  else await loadMine();
  paint();
  toast(`Solicitud enviada (${d.lines} constancia${d.lines === 1 ? '' : 's'})`);
}

/* =====================================================================
   REVISAR (admin): panel por línea con salario/bono/firmante + preview
   ===================================================================== */
let REVIEW = null;  // { req, lines:[], defaults, signers, idx, edited:{...por line_id} }

async function openReview(lineId) {
  // Buscar la solicitud a la que pertenece esa línea dentro del INBOX.
  let target = null;
  for (const req of INBOX) {
    const l = (req.lines || []).find(x => x.id === lineId);
    if (l) { target = { req, line: l }; break; }
  }
  if (!target) { toast('No se encontró la constancia.', 'err'); return; }

  $('#pnlMain').innerHTML = `<div class="pnl-loading">Cargando solicitud…</div>`;
  const d = await apiAdmin({ action: 'detail', request_id: target.req.id });
  if (!d.ok) { toast(d.error || 'No se pudo abrir la solicitud.', 'err'); paint(); return; }

  const defaults = d.defaults || {};
  const signers = d.signers || [];
  // Prefill de cada línea con defaults si vienen vacíos.
  const lines = (d.lines || []).map(l => prefillLine(l, defaults, signers));
  const startIdx = Math.max(0, lines.findIndex(l => l.id === lineId));
  REVIEW = { req: d.request, lines, defaults, signers, idx: startIdx, edited: {} };
  paintReview();
}

function prefillLine(l, defaults, signers) {
  const out = { ...l };
  if (out.salary_amount == null || out.salary_amount === '') out.salary_amount = defaults.salary_default_ves != null ? defaults.salary_default_ves : null;
  if (out.bonus_usd == null || out.bonus_usd === '') out.bonus_usd = defaults.cestaticket_default_usd != null ? defaults.cestaticket_default_usd : null;
  if (!out.recipient) out.recipient = REVIEW && REVIEW.req ? REVIEW.req.recipient : (out.recipient || DEFAULT_RECIPIENT);
  // Firmante por defecto: el primero activo, si la línea no trae uno.
  if (out.signer_id == null && signers.length) {
    out.signer_id = signers[0].id;
    out.signer_name_snap = out.signer_name_snap || signers[0].full_name;
    out.signer_title_snap = out.signer_title_snap || signers[0].title || DEFAULT_SIGNER_TITLE;
  }
  return out;
}

function curLine() { return REVIEW.lines[REVIEW.idx]; }

/* Recolecta el patch actual desde los inputs del panel (para guardar/generar). */
function collectPatch() {
  const g = id => { const el = $('#' + id); return el ? el.value : null; };
  const cedNum = String(g('rvCed') || '').replace(/\D/g, '');
  const cedLet = g('rvCedLet') || undefined;
  const patch = {
    worker_full_name: (g('rvName') || '').trim() || null,
    worker_id_number: cedNum || null,
    worker_role: (g('rvRole') || '').trim() || null,
    start_date: g('rvStart') || null,
    salary_amount: parseBs(g('rvSalary')),
    bonus_usd: parseBs(g('rvBonusUsd')),
    bonus_rate: parseBs(g('rvBonusRate')),
    bonus_amount: parseBs(g('rvBonusAmount')),
    recipient: (g('rvRecipient') || '').trim() || DEFAULT_RECIPIENT,
    city: (g('rvCity') || '').trim() || null,
    signer_id: g('rvSigner') ? (parseInt(g('rvSigner'), 10) || null) : null,
    signer_title_snap: (g('rvSignerTitle') || '').trim() || null,
  };
  // snapshot del nombre del firmante (del combo).
  if (patch.signer_id) {
    const s = REVIEW.signers.find(x => x.id === patch.signer_id);
    if (s) patch.signer_name_snap = s.full_name;
  }
  // guardar la letra de cédula elegida no es columna; se recalcula al render.
  void cedLet;
  return patch;
}
/* Fusiona el patch en la línea en memoria (para navegar sin perder cambios). */
function stashCurrent() {
  const line = curLine();
  const patch = collectPatch();
  REVIEW.lines[REVIEW.idx] = { ...line, ...patch };
  REVIEW.edited[line.id] = true;
}

function paintReview() {
  const req = REVIEW.req;
  const line = curLine();
  const total = REVIEW.lines.length;
  const emitida = line.status === 'generada' || line.status === 'disponible';
  const cerrada = line.status === 'rechazada' || line.status === 'anulada';
  // Editable si: pendiente (solicitada/en_revision), o si esta emitida y el
  // actor es admin/superadmin (puede corregir y RE-generar). Rechazada/anulada
  // siempre en solo lectura.
  const canEdit = !cerrada && (!emitida || isPowerAdmin());
  const readonly = !canEdit;

  // Franja informativa de generacion (cuando ya fue emitida): cuando se genero
  // y cuanto tardo el admin desde la solicitud.
  let genBanner = '';
  if (emitida && line.generated_at) {
    const delay = fmtDelay(req.requested_at, line.generated_at);
    genBanner = `<p style="margin:3px 0 0;font-size:12px;color:var(--muted)">Generada el <b>${esc(fmtDateTime(line.generated_at))}</b>${delay ? ` · ${esc(delay)} después de la solicitud` : ''}.</p>`;
  }

  const estadoTxt = readonly
    ? (cerrada ? 'Solo lectura (' + esc(line.status) + ')' : 'Emitida (' + esc(line.status) + ') — solo lectura')
    : (emitida ? 'Constancia emitida — puedes corregir y RE-generar el PDF.' : 'Todos los campos son editables antes de generar.');

  $('#pnlMain').innerHTML = `
    <button class="cr-back" id="rvBack">‹ Volver a la bandeja</button>
    <div class="cr-head">
      <div><h1>Revisar constancia — #${req.id}</h1>
        <p>${esc(companyName(req.company_code))} · Empleado ${REVIEW.idx + 1} de ${total} · ${estadoTxt}</p>
        ${genBanner}</div>
      <div class="cr-revnav">
        <button class="cr-b cr-b-mini" id="rvPrev" ${REVIEW.idx === 0 ? 'disabled' : ''}>‹ Anterior</button>
        <span class="cr-count">${REVIEW.idx + 1}/${total}</span>
        <button class="cr-b cr-b-mini" id="rvNext" ${REVIEW.idx >= total - 1 ? 'disabled' : ''}>Siguiente ›</button>
      </div>
    </div>
    <div class="cr-rev">
      <div id="rvForm">${reviewForm(line, readonly)}</div>
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Previsualización</div>
        <div id="rvPaper">${reviewPaper(line)}</div>
        ${sealNote('<b>Recuerda el sello húmedo.</b> Tras imprimir la constancia, estámpale el <b>sello húmedo</b> de la empresa para que tenga validez. Es físico y NO forma parte del PDF.')}
      </div>
    </div>
    <div class="cr-savebar">
      <span class="cr-muted">Empleado <b>${REVIEW.idx + 1} de ${total}</b>${readonly ? '' : (emitida ? ' · corrige y RE-genera' : ' · guarda o genera cada uno')}.</span>
      <span class="cr-sp"></span>
      ${line.status === 'disponible' ? `<button class="cr-b" id="rvDownload">${dlIco()} Descargar</button>` : ''}
      ${readonly ? '' : (emitida ? `
        <button class="cr-b" id="rvSave">Guardar cambios</button>
        <button class="cr-b cr-b-success" id="rvGen">Regenerar PDF</button>` : `
        <button class="cr-b cr-b-warn" id="rvReject">Rechazar</button>
        <button class="cr-b" id="rvSave">Guardar cambios</button>
        <button class="cr-b cr-b-success" id="rvGen">Generar</button>
        ${total > 1 ? '<button class="cr-b cr-b-success" id="rvGenAll">Generar todas</button>' : ''}`)}
    </div>`;

  bindReview(readonly);
}

function reviewForm(line, readonly) {
  const dis = readonly ? 'disabled' : '';
  const cedNum = String(line.worker_id_number || '').replace(/\D/g, '');
  const letter = cedLetter(cedNum);
  const signerOpts = REVIEW.signers.map(s =>
    `<option value="${s.id}" ${String(s.id) === String(line.signer_id) ? 'selected' : ''}>${esc(s.full_name)} — ${esc(s.title || DEFAULT_SIGNER_TITLE)}</option>`).join('');
  const startVal = line.start_date ? String(line.start_date).slice(0, 10) : '';
  const cityVal = line.city || '';
  return `
    <div class="cr-card" style="margin-bottom:14px">
      <h3>Datos del empleado <span style="font-weight:400;color:var(--muted);font-size:12px">(automáticos · editables)</span></h3>
      <div class="cr-grid2">
        <div class="cr-field"><label>Nombre</label><input id="rvName" value="${esc(line.worker_full_name || '')}" ${dis}></div>
        <div class="cr-field"><label>Cédula</label>
          <div class="cr-ced">
            <select id="rvCedLet" ${dis}><option ${letter === 'V' ? 'selected' : ''}>V</option><option ${letter === 'E' ? 'selected' : ''}>E</option></select>
            <input id="rvCed" value="${esc(cedNum)}" placeholder="solo números" ${dis}>
          </div>
          <div class="cr-hint">Se muestra ${esc(fmtCedula(cedNum, letter))}.</div>
        </div>
        <div class="cr-field"><label>Cargo</label><input id="rvRole" value="${esc(line.worker_role || '')}" ${dis}></div>
        <div class="cr-field"><label>Fecha de ingreso</label><input type="date" id="rvStart" value="${esc(startVal)}" ${dis}></div>
      </div>
    </div>

    <div class="cr-card" style="margin-bottom:14px">
      <h3>Montos <span style="font-weight:400;color:var(--muted);font-size:12px">(editables)</span></h3>
      <div class="cr-field"><label>Salario base (Bs.)</label><input id="rvSalary" value="${esc(fmtBs(line.salary_amount))}" ${dis}></div>
      <div class="cr-calc">
        <div style="font-size:12.5px;font-weight:600;color:var(--ink);margin-bottom:8px">Bono Cestaticket Socialista</div>
        <div class="cr-grid3">
          <div class="cr-field" style="margin-bottom:6px"><label>USD</label><input id="rvBonusUsd" value="${esc(fmtBs(line.bonus_usd))}" ${dis}></div>
          <div class="cr-field" style="margin-bottom:6px"><label>Tasa (Bs/USD)</label><input id="rvBonusRate" value="${esc(line.bonus_rate != null ? fmtBs(line.bonus_rate) : '')}" ${dis}></div>
          <div class="cr-field" style="margin-bottom:6px"><label>Monto (Bs.)</label><input id="rvBonusAmount" value="${esc(line.bonus_amount != null ? fmtBs(line.bonus_amount) : '')}" ${dis}></div>
        </div>
        ${readonly ? '' : `<div class="cr-eq">
          <button class="cr-b cr-b-mini cr-b-primary" id="rvCalc" type="button">Calcular</button>
          <span id="rvCalcNote">USD × tasa → escribe el Monto solo al pulsar Calcular. El Monto queda editable.</span>
        </div>`}
      </div>
    </div>

    <div class="cr-card">
      <h3>Emisión</h3>
      <div class="cr-field"><label>Dirigida a (destinatario)</label><input id="rvRecipient" value="${esc(line.recipient || DEFAULT_RECIPIENT)}" ${dis}></div>
      <div class="cr-grid2">
        <div class="cr-field"><label>Ciudad</label><input id="rvCity" value="${esc(cityVal)}" ${dis}><div class="cr-hint">Sale de la empresa · editable.</div></div>
        <div class="cr-field"><label>Fecha de expedición</label><input type="date" id="rvIssue" value="${esc(new Date().toISOString().slice(0, 10))}" ${dis}><div class="cr-hint">Referencial · el PDF usará la fecha de generación.</div></div>
      </div>
      <div class="cr-field"><label>Firmante</label>
        <select id="rvSigner" ${dis}>${signerOpts || '<option value="">— sin firmantes activos —</option>'}</select>
        ${REVIEW.signers.length ? '' : '<div class="cr-hint">No hay firmantes activos. Créalos en la vista “Firmantes”.</div>'}
      </div>
      <div class="cr-field"><label>Cargo bajo la firma</label><input id="rvSignerTitle" value="${esc(line.signer_title_snap || DEFAULT_SIGNER_TITLE)}" ${dis}>
        <div class="cr-hint">Default = cargo del firmante · editable por constancia.</div></div>
    </div>`;
}

function reviewPaper(line) {
  const name = line.worker_full_name || '—';
  const ced = fmtCedula(line.worker_id_number);
  const role = line.worker_role || '—';
  const start = line.start_date ? fmtDate(line.start_date) : '—';
  const salary = line.salary_amount != null ? fmtBs(line.salary_amount) : '—';
  const salaryWords = numeroALetrasBs(line.salary_amount);
  const bonus = line.bonus_amount != null ? fmtBs(line.bonus_amount) : null;
  const bonusWords = line.bonus_amount != null ? numeroALetrasBs(line.bonus_amount) : null;
  const city = line.city || '—';
  const today = fmtDate(new Date().toISOString());
  const signerName = line.signer_name_snap || (REVIEW.signers.find(s => String(s.id) === String(line.signer_id)) || {}).full_name || '—';
  const signerTitle = line.signer_title_snap || DEFAULT_SIGNER_TITLE;
  const footer = [line.company_addr_snap, line.company_phone_snap ? 'Teléfonos: ' + line.company_phone_snap : '', line.company_email_snap]
    .filter(Boolean).join(' · ') || '—';
  const bonusFrag = bonus
    ? `, adicional un bono mensual de Cestaticket Socialista de <b class="cr-mark">${esc(bonusWords)} (Bs. ${esc(bonus)})</b>`
    : '';
  return `<div class="cr-paper">
    <div class="cr-ph">${esc(line.company_name_snap || companyName(REVIEW.req.company_code))}</div>
    <div class="cr-prif">RIF: ${esc(line.company_rif_snap || '—')}</div>
    <div style="font-style:italic">Señores:</div>
    <div style="font-weight:700">${esc((line.recipient || DEFAULT_RECIPIENT).toUpperCase())}.</div>
    <div style="font-style:italic">Presente. -</div>
    <div class="cr-tit">CONSTANCIA DE TRABAJO</div>
    <p>Por medio de la presente se hace constar que el (la) ciudadano (a) <b>${esc(name)}</b>, venezolano (a), mayor de edad, de este domicilio, titular de la cédula de identidad <b>${esc(ced || '—')}</b>, presta sus servicios para esta empresa desde el <span class="cr-u">${esc(start)}</span>, ocupando el Cargo de <b>${esc(role)}</b>, devengando un salario mensual de <b class="cr-mark">${esc(salaryWords)} (Bs. ${esc(salary)})</b>${bonusFrag}.</p>
    <p>Constancia que se expide a petición de la parte interesada en la ciudad de ${esc(city)}, a los ${esc(today)}.</p>
    <div class="cr-firma">
      <div style="font-style:italic">Atentamente;</div>
      <div style="height:20px"></div>
      <div class="cr-firma-nm" style="font-family:'Segoe Script','Brush Script MT',cursive;font-size:20px;color:#1a1a1a">${esc(signerName)}</div>
      <div class="cr-firma-line"></div>
      <div class="cr-firma-nm">${esc(signerName)}</div>
      <div class="cr-firma-cg">${esc(signerTitle)}</div>
    </div>
    <div class="cr-foot">${esc(footer)}</div>
  </div>`;
}

function refreshPaper() {
  // Toma los valores actuales del form (sin persistir) y repinta el paper.
  const line = { ...curLine(), ...collectPatch() };
  const el = $('#rvPaper');
  if (el) el.innerHTML = reviewPaper(line);
}

function bindReview(readonly) {
  $('#rvBack').addEventListener('click', async () => {
    // Al volver, refrescamos la bandeja para reflejar cambios.
    await loadInbox(); await loadMine(); paint();
  });
  const prev = $('#rvPrev'), next = $('#rvNext');
  if (prev) prev.addEventListener('click', () => { if (!readonly) stashCurrent(); REVIEW.idx--; paintReview(); });
  if (next) next.addEventListener('click', () => { if (!readonly) stashCurrent(); REVIEW.idx++; paintReview(); });

  // Descargar disponible tambien en solo-lectura (antes del return).
  const bDl = $('#rvDownload');
  if (bDl) bDl.addEventListener('click', () => downloadConstancia(curLine().id, bDl));

  if (readonly) return;

  // Recalcular preview en vivo al cambiar campos que salen en el paper.
  ['rvName', 'rvCed', 'rvCedLet', 'rvRole', 'rvStart', 'rvSalary', 'rvRecipient', 'rvCity', 'rvSignerTitle']
    .forEach(id => { const el = $('#' + id); if (el) el.addEventListener('input', refreshPaper); });
  const signer = $('#rvSigner');
  if (signer) signer.addEventListener('change', () => {
    const s = REVIEW.signers.find(x => String(x.id) === signer.value);
    if (s) { const t = $('#rvSignerTitle'); if (t && !t.value.trim()) t.value = s.title || DEFAULT_SIGNER_TITLE; }
    refreshPaper();
  });
  const bonusAmt = $('#rvBonusAmount');
  if (bonusAmt) bonusAmt.addEventListener('input', refreshPaper);

  const calc = $('#rvCalc');
  if (calc) calc.addEventListener('click', () => {
    const usd = parseBs($('#rvBonusUsd').value) || 0;
    const rate = parseBs($('#rvBonusRate').value) || 0;
    const amount = usd * rate;
    $('#rvBonusAmount').value = fmtBs(amount);
    const note = $('#rvCalcNote');
    if (note) note.innerHTML = `Calculado: ${fmtBs(usd)} USD × ${fmtBs(rate)} = <b>Bs. ${fmtBs(amount)}</b> · editable manual.`;
    refreshPaper();
  });

  const bSave = $('#rvSave'); if (bSave) bSave.addEventListener('click', () => saveCurrent(false));
  const bGen = $('#rvGen'); if (bGen) bGen.addEventListener('click', () => generateCurrent());
  const genAll = $('#rvGenAll');
  if (genAll) genAll.addEventListener('click', () => generateAll());
  const bRej = $('#rvReject'); if (bRej) bRej.addEventListener('click', () => rejectLine(curLine().id));
}

async function saveCurrent(silent) {
  const line = curLine();
  const patch = collectPatch();
  const d = await apiAdmin({ action: 'save_line', line_id: line.id, patch });
  if (!d.ok) { toast(d.error || 'No se pudo guardar.', 'err'); return false; }
  REVIEW.lines[REVIEW.idx] = { ...line, ...patch, status: line.status === 'solicitada' ? 'en_revision' : line.status };
  if (!silent) toast('Cambios guardados');
  return true;
}

async function generateCurrent() {
  const line = curLine();
  const patch = collectPatch();
  if (patch.salary_amount == null) { toast('Falta el salario base.', 'err'); return; }
  if (!patch.signer_id && !patch.signer_name_snap) { toast('Falta el firmante.', 'err'); return; }

  const emitida = line.status === 'generada' || line.status === 'disponible';
  const sinBono = patch.bonus_amount == null || patch.bonus_amount === '' || Number(patch.bonus_amount) === 0;
  const worker = esc(patch.worker_full_name || line.worker_full_name);

  // Aviso (no bloqueante) si va SIN cestaticket: se puede generar solo con
  // salario y luego editar/regenerar para agregarlo.
  const bonoWarn = sinBono
    ? `<p class="cr-sub" style="background:#fef6e7;border:1px solid #f0d9a8;color:#92400e;border-radius:8px;padding:9px 11px;margin-top:8px">⚠️ Esta constancia se generará <b>sin bono Cestaticket</b> (solo salario). Puedes editarla y regenerarla después para agregarlo.</p>`
    : '';

  const cuerpo = emitida
    ? `<p>Se <b>reemplazará</b> el PDF de la constancia de <span class="cr-strong">${worker}</span> con los datos actuales.</p>${bonoWarn}`
    : `<p>Se generará el PDF de la constancia de <span class="cr-strong">${worker}</span> y quedará <span class="cr-strong">disponible</span> para descargar.</p>${bonoWarn}<p class="cr-sub">Recuerda el sello húmedo al imprimirla.</p>`;

  const ok = await confirmModal({
    title: emitida ? 'Regenerar constancia' : 'Generar constancia',
    bodyHtml: cuerpo,
    okLabel: emitida ? 'Regenerar' : 'Generar',
  });
  if (!ok) return;
  const gb = $('#rvGen'); const gbOrig = gb ? gb.textContent : null;
  if (gb) { gb.disabled = true; gb.textContent = emitida ? 'Regenerando…' : 'Generando…'; }
  const d = await apiAdmin({ action: 'generate', line_id: line.id, patch });
  if (gb) { gb.disabled = false; gb.textContent = gbOrig; }
  if (!d.ok) { toast((d.results && d.results[0] && d.results[0].error) || d.error || 'No se pudo generar.', 'err'); return; }
  const res0 = d.results && d.results[0];
  const newStatus = (res0 && res0.pdf_key) ? 'disponible' : 'generada';
  // Al regenerar, actualizamos tambien generated_at localmente (aprox ahora).
  REVIEW.lines[REVIEW.idx] = { ...line, ...patch, status: newStatus, pdf_key: res0 ? res0.pdf_key : null, generated_at: new Date().toISOString() };
  toast(emitida
    ? (newStatus === 'disponible' ? 'Constancia regenerada' : 'Constancia regenerada (PDF en proceso)')
    : (newStatus === 'disponible' ? 'Constancia generada y disponible' : 'Constancia generada (PDF en proceso)'));
  await loadInbox(); await loadMine();
  // Si era pendiente, avanzar al siguiente pendiente; si era regeneracion,
  // quedarse en la misma para ver el resultado.
  if (!emitida) {
    const nextPending = REVIEW.lines.findIndex((l, i) => i !== REVIEW.idx && (l.status === 'solicitada' || l.status === 'en_revision'));
    if (nextPending >= 0) { REVIEW.idx = nextPending; paintReview(); return; }
  }
  paintReview();
}

async function generateAll() {
  stashCurrent();
  const pend = REVIEW.lines.filter(l => l.status === 'solicitada' || l.status === 'en_revision');
  if (!pend.length) { toast('No hay constancias pendientes.', 'info'); return; }
  // Validar mínimos.
  for (const l of pend) {
    if (l.salary_amount == null || l.salary_amount === '') { toast(`Falta el salario en ${l.worker_full_name}.`, 'err'); return; }
    if (l.signer_id == null && !l.signer_name_snap) { toast(`Falta el firmante en ${l.worker_full_name}.`, 'err'); return; }
  }
  const ok = await confirmModal({
    title: 'Generar todas',
    bodyHtml: `<p>Se generarán los PDF de ${pend.length} constancia${pend.length === 1 ? '' : 's'} de la solicitud #${REVIEW.req.id} y quedarán <span class="cr-strong">disponibles</span> para descargar.</p>`,
    okLabel: 'Generar todas',
  });
  if (!ok) return;
  const items = pend.map(l => ({ line_id: l.id, patch: linePatch(l) }));
  const d = await apiAdmin({ action: 'generate', lines: items });
  if (!d.ok) { toast(d.error || 'No se pudieron generar.', 'err'); return; }
  toast(`${d.generated} constancia${d.generated === 1 ? '' : 's'} generada${d.generated === 1 ? '' : 's'}`);
  await loadInbox(); await loadMine();
  paint();
}
/* Extrae de una línea (en memoria) el patch de campos editables. */
function linePatch(l) {
  return {
    worker_full_name: l.worker_full_name, worker_id_number: String(l.worker_id_number || '').replace(/\D/g, ''),
    worker_role: l.worker_role, start_date: l.start_date ? String(l.start_date).slice(0, 10) : null,
    salary_amount: l.salary_amount, bonus_usd: l.bonus_usd, bonus_rate: l.bonus_rate, bonus_amount: l.bonus_amount,
    recipient: l.recipient || DEFAULT_RECIPIENT, city: l.city,
    signer_id: l.signer_id, signer_name_snap: l.signer_name_snap, signer_title_snap: l.signer_title_snap,
  };
}

async function rejectLine(lineId) {
  const reason = await reasonModal({
    title: 'Rechazar constancia',
    placeholder: 'Ej.: el trabajador ya alcanzó el tope de constancias del año.',
    okLabel: 'Rechazar',
  });
  if (!reason) return;
  const d = await apiAdmin({ action: 'reject', line_id: lineId, reason });
  if (!d.ok) { toast((d.results && d.results[0] && d.results[0].error) || d.error || 'No se pudo rechazar.', 'err'); return; }
  toast('Constancia rechazada', 'info');
  await loadInbox(); await loadMine();
  // Si estamos en el panel de revisión, refrescar; si no, volver a bandeja.
  if (REVIEW && REVIEW.lines.some(l => l.id === lineId)) {
    const i = REVIEW.lines.findIndex(l => l.id === lineId);
    if (i >= 0) REVIEW.lines[i].status = 'rechazada', REVIEW.lines[i].reject_reason = reason;
    paintReview();
  } else {
    paint();
  }
}

/* =====================================================================
   Número → letras (Bolívares, formato VE mayúsculas). Suficiente para
   montos de salario/bono (hasta millones). "TRESCIENTOS BOLIVARES CON 00/100".
   ===================================================================== */
function numeroALetrasBs(n) {
  const v = typeof n === 'number' ? n : parseBs(n);
  if (v == null || isNaN(v)) return '—';
  const entero = Math.floor(Math.abs(v));
  const cent = Math.round((Math.abs(v) - entero) * 100);
  const centStr = String(cent).padStart(2, '0');
  const letras = enteroALetras(entero).toUpperCase().trim();
  const moneda = entero === 1 ? 'BOLIVAR' : 'BOLIVARES';
  return `${letras} ${moneda} CON ${centStr}/100`;
}
function enteroALetras(num) {
  if (num === 0) return 'cero';
  if (num < 0) return 'menos ' + enteroALetras(-num);
  const UNI = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
    'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve',
    'veinte', 'veintiuno', 'veintidos', 'veintitres', 'veinticuatro', 'veinticinco', 'veintiseis', 'veintisiete', 'veintiocho', 'veintinueve'];
  const DEC = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
  const CEN = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

  function menor1000(n) {
    let out = '';
    const c = Math.floor(n / 100), resto = n % 100;
    if (c) out += (n === 100 ? 'cien' : CEN[c]) + ' ';
    if (resto < 30) out += UNI[resto];
    else {
      const d = Math.floor(resto / 10), u = resto % 10;
      out += DEC[d] + (u ? ' y ' + UNI[u] : '');
    }
    return out.trim();
  }

  let out = '';
  const millones = Math.floor(num / 1000000);
  const miles = Math.floor((num % 1000000) / 1000);
  const resto = num % 1000;
  if (millones) out += (millones === 1 ? 'un millon' : menor1000(millones) + ' millones') + ' ';
  if (miles) out += (miles === 1 ? 'mil' : menor1000(miles) + ' mil') + ' ';
  if (resto) out += menor1000(resto);
  return out.trim();
}
