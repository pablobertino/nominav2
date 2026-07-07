/* =====================================================================
   js/views/ax-probe.js  →  vista "Consultar sistema" (diagnostico)
   Herramienta de superadmin para consultar la API de empleados del sistema
   (ERP) por alias/fecha/cedula y ver:
     - la respuesta en una GRILLA (para verificar rapido)
     - el JSON CRUDO tal cual llega (con boton copiar)
     - descargar CSV
   La consulta pasa por /api/ax-probe (el servidor pone la clave; nunca llega
   al navegador).

   Reglas UI del portal: sin alert/confirm/prompt nativos; feedback inline.
   Export: renderAxProbe(user)
   ===================================================================== */

import { $ } from '../core/dom.js';

let USER = null;
let RAW = null;        // ultimo JSON crudo recibido
let ROWS = [];         // arreglo de empleados normalizado para la grilla

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function sessionUserPayload(user) {
  return { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null };
}
function todayISO() {
  const d = new Date();
  const c = new Date(d.getTime() - 4 * 3600 * 1000);  // Caracas GMT-4
  const z = n => String(n).padStart(2, '0');
  return `${c.getUTCFullYear()}-${z(c.getUTCMonth() + 1)}-${z(c.getUTCDate())}`;
}

// Columnas de la grilla (orden y etiqueta). Se leen tal cual del objeto ERP.
const COLS = [
  ['ficha', 'Ficha'],
  ['nombreCompleto', 'Nombre completo'],
  ['departamento', 'Departamento'],
  ['idCargo', 'Cargo'],
  ['telefono', 'Teléfono'],
  ['correo', 'Correo'],
  ['primerNombre', 'Primer nombre'],
  ['segundoNombre', 'Segundo nombre'],
  ['primerApellido', 'Primer apellido'],
  ['segundoApellido', 'Segundo apellido'],
  ['apellidos', 'Apellidos'],
  ['cuentaBancaria', 'Cuenta'],
  ['fechaNacimiento', 'Nacimiento'],
  ['edad', 'Edad'],
  ['genero', 'Género'],
  ['estadoCivil', 'Estado civil'],
  ['idPosicion', 'Posición'],
  ['dataArea', 'Área'],
  ['inicioContrato', 'Inicio'],
  ['finContrato', 'Fin'],
  ['todoTicket', 'TodoTicket'],
];

function ensureStyles() {
  if (document.getElementById('axpStyles')) return;
  const st = document.createElement('style');
  st.id = 'axpStyles';
  st.textContent = `
  .axp-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .axp-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .axp-bar{display:flex;gap:10px 12px;align-items:flex-end;flex-wrap:wrap;margin:18px 0 8px}
  .axp-fg{display:flex;flex-direction:column;gap:5px}
  .axp-fg label{font-size:12px;font-weight:600;color:var(--muted)}
  .axp-fg input{font:inherit;font-size:14px;padding:9px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);min-width:150px}
  .axp-btn{display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:13.5px;font-weight:600;padding:9px 14px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--ink);cursor:pointer;white-space:nowrap;line-height:1}
  .axp-btn:hover:not(:disabled){background:var(--bg-soft,#f1f5f9)}
  .axp-btn:disabled{opacity:.5;cursor:default}
  .axp-btn svg{width:15px;height:15px}
  .axp-btn-go{background:var(--brand,#2563eb);border-color:var(--brand,#2563eb);color:#fff}
  .axp-btn-go:hover:not(:disabled){background:var(--brand-strong,#1d4ed8)}
  .axp-meta{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:6px 0 12px;font-size:12.5px;color:var(--muted)}
  .axp-badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-weight:700;font-size:12px}
  .axp-badge.ok{background:var(--success-bg,#f0fdf4);color:var(--success,#15803d);border:1px solid #bbf7d0}
  .axp-badge.err{background:var(--danger-bg,#fef2f2);color:var(--danger,#b91c1c);border:1px solid #f3c2c2}
  .axp-tabs{display:flex;gap:8px;margin:14px 0 10px}
  .axp-tab{font:inherit;font-size:13px;font-weight:600;padding:8px 14px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--muted);cursor:pointer}
  .axp-tab.on{background:var(--brand-bg,#eff6ff);border-color:#bfdbfe;color:var(--brand,#2563eb)}
  .axp-panel{display:none}
  .axp-panel.on{display:block}
  .axp-tblwrap{width:100%;overflow-x:auto;border:1px solid var(--border);border-radius:12px}
  .axp-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
  .axp-tbl th{position:sticky;top:0;background:var(--ink,#1e293b);color:#fff;font-weight:600;padding:9px 12px;text-align:left;white-space:nowrap;font-size:11.5px}
  .axp-tbl td{padding:8px 12px;border-bottom:1px solid var(--border-soft,#eef1f5);white-space:nowrap}
  .axp-tbl tr:hover td{background:var(--bg-soft,#f8fafc)}
  .axp-dash{color:var(--faint,#94a3b8)}
  .axp-json{position:relative}
  .axp-json pre{margin:0;padding:16px;background:#0f172a;color:#e2e8f0;border-radius:12px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.55;overflow:auto;max-height:60vh;white-space:pre}
  .axp-copy{position:absolute;top:12px;right:12px}
  .axp-empty{padding:44px 16px;text-align:center;color:var(--muted)}
  .axp-empty .big{font-size:32px;margin-bottom:8px}
  .axp-loading{padding:40px;text-align:center;color:var(--muted)}
  .axp-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--ink,#1e293b);color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;z-index:1200;box-shadow:0 8px 24px rgba(0,0,0,.2)}
  `;
  document.head.appendChild(st);
}

async function api(payload) {
  return fetch('/api/ax-probe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(x => x.json()).catch(() => null);
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'axp-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

export async function renderAxProbe(user) {
  USER = user;
  ensureStyles();
  RAW = null; ROWS = [];
  $('#pnlMain').innerHTML = `
    <div class="axp-head"><div>
      <h1>Consultar sistema</h1>
      <p>Consulta la API de empleados del sistema y verifica lo que trae. Muestra la grilla y el JSON tal cual llega.</p>
    </div></div>
    <div class="axp-bar">
      <div class="axp-fg"><label>Empresa (alias)</label><input id="axpAlias" placeholder="Ej. AA01" autocomplete="off"></div>
      <div class="axp-fg"><label>Fecha de corte</label><input id="axpFecha" type="date"></div>
      <div class="axp-fg"><label>Cédula (opcional)</label><input id="axpFicha" placeholder="Filtrar una ficha" autocomplete="off"></div>
      <button class="axp-btn axp-btn-go" id="axpGo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg> Consultar</button>
      <button class="axp-btn" id="axpCsv" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg> CSV</button>
    </div>
    <div class="axp-meta" id="axpMeta"></div>
    <div class="axp-tabs">
      <button class="axp-tab on" id="axpTabGrid" data-tab="grid">Grilla</button>
      <button class="axp-tab" id="axpTabJson" data-tab="json">JSON crudo</button>
    </div>
    <div class="axp-panel on" id="axpPanelGrid">
      <div class="axp-empty" id="axpGridEmpty"><div class="big">🔎</div><div>Introduce un alias y consulta para ver el personal del sistema.</div></div>
      <div class="axp-tblwrap" id="axpGridWrap" style="display:none"><table class="axp-tbl"><thead id="axpThead"></thead><tbody id="axpTbody"></tbody></table></div>
    </div>
    <div class="axp-panel" id="axpPanelJson">
      <div class="axp-empty" id="axpJsonEmpty"><div class="big">{ }</div><div>El JSON crudo aparecerá aquí tras la consulta.</div></div>
      <div class="axp-json" id="axpJsonWrap" style="display:none">
        <button class="axp-btn axp-copy" id="axpCopy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copiar</button>
        <pre id="axpJsonPre"></pre>
      </div>
    </div>`;

  $('#axpFecha').value = todayISO();
  $('#axpGo').addEventListener('click', runQuery);
  $('#axpAlias').addEventListener('keydown', e => { if (e.key === 'Enter') runQuery(); });
  $('#axpFicha').addEventListener('keydown', e => { if (e.key === 'Enter') runQuery(); });
  $('#axpCsv').addEventListener('click', downloadCSV);
  $('#axpCopy').addEventListener('click', copyJson);
  document.querySelectorAll('[data-tab]').forEach(el =>
    el.addEventListener('click', () => switchTab(el.dataset.tab)));
}

function switchTab(tab) {
  $('#axpTabGrid').classList.toggle('on', tab === 'grid');
  $('#axpTabJson').classList.toggle('on', tab === 'json');
  $('#axpPanelGrid').classList.toggle('on', tab === 'grid');
  $('#axpPanelJson').classList.toggle('on', tab === 'json');
}

async function runQuery() {
  const alias = $('#axpAlias').value.trim();
  const fecha = $('#axpFecha').value;
  const ficha = $('#axpFicha').value.replace(/[^0-9]/g, '');
  if (!alias) { toast('Escribe el alias de la empresa.'); $('#axpAlias').focus(); return; }

  const meta = $('#axpMeta');
  meta.innerHTML = '';
  $('#axpGridEmpty').style.display = 'block';
  $('#axpGridEmpty').innerHTML = `<div class="axp-loading">Consultando el sistema…</div>`;
  $('#axpGridWrap').style.display = 'none';
  $('#axpJsonEmpty').style.display = 'block';
  $('#axpJsonWrap').style.display = 'none';
  $('#axpCsv').disabled = true;

  const go = $('#axpGo'); go.disabled = true;
  let r;
  try { r = await api({ user: sessionUserPayload(USER), alias, fecha, ficha }); }
  catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  go.disabled = false;

  if (!r) {
    meta.innerHTML = `<span class="axp-badge err">Sin respuesta</span>`;
    $('#axpGridEmpty').innerHTML = `<div class="big">⚠</div><div>No se recibió respuesta del servidor.</div>`;
    return;
  }

  RAW = ('raw' in r) ? r.raw : r;
  // Datos para grilla: si hay ficha, usar filtered; si no, el arreglo crudo.
  let arr = Array.isArray(r.filtered) && ficha ? r.filtered
    : (Array.isArray(RAW) ? RAW : (RAW && (RAW.empleados || RAW.data || RAW.items)) || []);
  ROWS = Array.isArray(arr) ? arr : [];

  // Meta.
  const badges = [];
  badges.push(`<span class="axp-badge ${r.ok ? 'ok' : 'err'}">HTTP ${r.status != null ? r.status : '—'}</span>`);
  if (r.count != null) badges.push(`<span>Empleados: <b>${r.count}</b></span>`);
  if (ficha) badges.push(`<span>Filtro ficha: <b>${esc(ficha)}</b> (${ROWS.length})</span>`);
  if (r.parse_error) badges.push(`<span class="axp-badge err">Respuesta no-JSON</span>`);
  if (r.url) badges.push(`<span style="color:var(--faint,#94a3b8)">${esc(r.url)}</span>`);
  if (!r.ok && r.error) badges.push(`<span class="axp-badge err">${esc(r.error)}</span>`);
  meta.innerHTML = badges.join(' ');

  paintJson();
  paintGrid();
  $('#axpCsv').disabled = ROWS.length === 0;
}

function paintGrid() {
  const empty = $('#axpGridEmpty'), wrap = $('#axpGridWrap');
  if (!ROWS.length) {
    empty.style.display = 'block';
    empty.innerHTML = `<div class="big">∅</div><div>El sistema no devolvió empleados para esos parámetros.</div>`;
    wrap.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  wrap.style.display = 'block';
  $('#axpThead').innerHTML = `<tr>${COLS.map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr>`;
  $('#axpTbody').innerHTML = ROWS.map(e => `<tr>${
    COLS.map(([key]) => {
      const v = e[key];
      return `<td>${(v == null || v === '' || v === '-') ? '<span class="axp-dash">—</span>' : esc(v)}</td>`;
    }).join('')
  }</tr>`).join('');
}

function paintJson() {
  const empty = $('#axpJsonEmpty'), wrap = $('#axpJsonWrap');
  if (RAW == null) {
    empty.style.display = 'block'; wrap.style.display = 'none'; return;
  }
  empty.style.display = 'none';
  wrap.style.display = 'block';
  let txt;
  try { txt = (typeof RAW === 'string') ? RAW : JSON.stringify(RAW, null, 2); }
  catch { txt = String(RAW); }
  $('#axpJsonPre').textContent = txt;
}

async function copyJson() {
  const txt = $('#axpJsonPre').textContent || '';
  try {
    await navigator.clipboard.writeText(txt);
    toast('JSON copiado al portapapeles.');
  } catch {
    // Fallback: seleccionar el contenido.
    const range = document.createRange();
    range.selectNodeContents($('#axpJsonPre'));
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    toast('Selecciona y copia (Ctrl+C).');
  }
}

function downloadCSV() {
  if (!ROWS.length) { toast('No hay datos para exportar.'); return; }
  const headers = COLS.map(([, label]) => label);
  const keyList = COLS.map(([key]) => key);
  const escCsv = v => {
    const s = (v == null) ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(';')];
  ROWS.forEach(e => lines.push(keyList.map(k => escCsv(e[k])).join(';')));
  const alias = $('#axpAlias').value.trim() || 'sistema';
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `consulta_${alias}_${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
