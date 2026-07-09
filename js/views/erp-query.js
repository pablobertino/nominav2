/* =====================================================================
   js/views/erp-query.js  →  vista "Consultar API"
   (grupo Sincronizacion, solo superadmin)

   Herramienta MANUAL de consulta y diagnostico de las APIs registradas en
   nomina_v2.api_catalog (v4.41, Req 1 fase B). Permite:
     - Elegir la API en un selector (catalogo desde el servidor).
     - Ver y completar SOLO los filtros que esa API define (dinamicos).
     - Consultar y ver el resultado tal cual llega: grilla con todas las
       columnas + JSON crudo + Copiar JSON + Descargar CSV.
     - Ver SIEMPRE que API se consulto, con que parametros, y el status.
     - Filtro LOCAL opcional (no viaja): acota grilla/JSON/CSV en memoria.

   Este modulo NO modifica datos (y su endpoint tampoco, por diseño).
   Datos por /api/erp-query (catalog | query). La key vive en el servidor.
   Export: renderErpQuery(user)

   Reglas UI del portal: sin alert/confirm/prompt; mensajes inline; no se
   menciona el sistema por su nombre en la UI.
   ===================================================================== */

import { $ } from '../core/dom.js';

let USER = null;
let APIS = [];         // catalogo de APIs activas (del servidor)
let CUR = null;        // API seleccionada (objeto del catalogo)
let RAW = [];          // filas tal cual llegaron
let META = null;       // { api_code, api_label, params_sent, status, count }

/* Orden preferido de columnas para la API de fichas; cualquier campo que no
   este aca (u otra API) se agrega despues en orden alfabetico. */
const COL_ORDER = [
  'ficha', 'nombreCompleto', 'primerNombre', 'segundoNombre',
  'primerApellido', 'segundoApellido', 'apellidos',
  'fechaNacimiento', 'edad', 'genero', 'estadoCivil',
  'telefono', 'correo', 'cuentaBancaria',
  'idCargo', 'idPosicion', 'departamento',
  'inicioContrato', 'finContrato',
  'alias', 'dataArea', 'empresaNombre', 'empresaTipo', 'todoTicket',
];
const MONO_COLS = new Set(['ficha', 'cuentaBancaria', 'telefono', 'alias', 'dataArea', 'idCargo', 'idPosicion']);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(payload) {
  return fetch('/api/erp-query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(x => x.json()).catch(() => null);
}
function sessionUserPayload(user) {
  return { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null };
}

function ensureStyles() {
  if (document.getElementById('eqStyles')) return;
  const st = document.createElement('style');
  st.id = 'eqStyles';
  st.textContent = `
  .eq-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .eq-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .eq-apibar{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:16px 0 2px}
  .eq-bar{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:10px 0 6px}
  .eq-fld{display:flex;flex-direction:column;gap:4px}
  .eq-fld label{font-size:11.5px;font-weight:600;color:var(--muted)}
  .eq-fld input,.eq-fld select{font:inherit;font-size:13.5px;padding:8px 11px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--ink)}
  .eq-fld input:focus,.eq-fld select:focus{outline:none;border-color:var(--brand,#2563eb)}
  .eq-fld input.mono{text-transform:uppercase;font-family:ui-monospace,Menlo,monospace;font-weight:600}
  #eqApi{min-width:260px}
  .eq-apinote{font-size:12px;color:var(--muted);margin:4px 0 0}
  .eq-btn{display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:13.5px;font-weight:600;padding:9px 15px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--ink);cursor:pointer;white-space:nowrap;line-height:1}
  .eq-btn:hover:not(:disabled){background:var(--bg-soft,#f1f5f9)}
  .eq-btn:disabled{opacity:.5;cursor:default}
  .eq-btn svg{width:15px;height:15px}
  .eq-btn-go{background:var(--brand,#2563eb);border-color:var(--brand,#2563eb);color:#fff}
  .eq-btn-go:hover:not(:disabled){background:#1d4ed8}
  .eq-msg{margin:10px 0;font-size:13px;border-radius:10px;padding:10px 13px;display:none}
  .eq-msg.err{display:block;background:var(--danger-bg,#fef2f2);border:1px solid #f3c2c2;color:var(--danger,#b91c1c)}
  .eq-msg.info{display:block;background:var(--brand-bg,#eff6ff);border:1px solid #bfdbfe;color:#1e40af}
  .eq-sum{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0 8px;font-size:13px;color:var(--muted)}
  .eq-sum b{color:var(--ink)}
  .eq-sum .pill{background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:3px 11px;font-size:12px;font-weight:600;color:var(--ink)}
  .eq-sum .pill.api{background:var(--brand-bg,#eff6ff);border-color:#bfdbfe;color:#1e40af}
  .eq-sum .pill.stat{background:var(--success-bg,#f0fdf4);border-color:#bbf7d0;color:var(--success,#15803d)}
  .eq-spacer{flex:1}
  .eq-tblwrap{border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);overflow:auto;max-height:60vh}
  .eq-tbl{border-collapse:collapse;font-size:12.5px;min-width:100%}
  .eq-tbl th{position:sticky;top:0;background:var(--bg-soft,#f8fafc);text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap;z-index:1}
  .eq-tbl td{padding:7px 10px;border-bottom:1px solid var(--border-soft,#eef1f5);white-space:nowrap;color:var(--ink)}
  .eq-tbl tr:hover td{background:var(--bg-soft,#f8fafc)}
  .eq-tbl td.mono{font-family:ui-monospace,Menlo,monospace}
  .eq-tbl td.empty{color:var(--faint,#94a3b8)}
  .eq-empty{padding:44px 16px;text-align:center;color:var(--muted)}
  .eq-jsonhead{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:20px 0 8px}
  .eq-jsonhead h2{margin:0;font-size:15px;font-weight:700;color:var(--ink)}
  .eq-copied{font-size:12px;color:var(--success,#16a34a);font-weight:600;opacity:0;transition:opacity .2s}
  .eq-copied.show{opacity:1}
  .eq-json{border:1px solid var(--border);border-radius:12px;background:#0f172a;color:#e2e8f0;padding:14px 16px;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.5;overflow:auto;max-height:50vh;white-space:pre;margin:0 0 20px}
  @media (max-width:640px){
    .eq-apibar,.eq-bar{align-items:stretch}
    .eq-fld,#eqApi{width:100%}
    .eq-btn-go{justify-content:center}
  }`;
  document.head.appendChild(st);
}

/* Filas visibles = RAW con el filtro LOCAL aplicado (no viaja al servidor:
   busca el texto en TODOS los valores de cada fila). */
function visibleRows() {
  const q = String(($('#eqLocal') && $('#eqLocal').value) || '').trim().toLowerCase();
  if (!q) return RAW;
  return RAW.filter(r => Object.values(r || {}).some(v =>
    String(v == null ? '' : v).toLowerCase().includes(q)));
}

/* Columnas = orden preferido (las presentes) + extras alfabeticas. */
function columnsOf(rows) {
  const present = new Set();
  rows.forEach(r => Object.keys(r || {}).forEach(k => present.add(k)));
  const cols = COL_ORDER.filter(k => present.has(k));
  const extra = [...present].filter(k => !COL_ORDER.includes(k)).sort();
  return cols.concat(extra);
}

function paintResults() {
  const host = $('#eqResults');
  if (!host) return;
  if (!META) { host.innerHTML = ''; return; }

  const rows = visibleRows();
  const cols = columnsOf(rows.length ? rows : RAW);
  const filtered = rows.length !== RAW.length;
  const paramPills = Object.keys(META.params_sent || {})
    .map(k => `<span class="pill">${esc(k)}: ${esc(META.params_sent[k])}</span>`).join('');

  let html = `
  <div class="eq-sum">
    <span class="pill api">${esc(META.api_label || META.api_code)}</span>
    ${paramPills}
    <span class="pill stat">HTTP ${esc(META.status || 200)}</span>
    <span><b>${rows.length}</b>${filtered ? ` de ${RAW.length}` : ''} registros</span>
    <span class="eq-spacer"></span>
    <button class="eq-btn" id="eqCopy" ${rows.length ? '' : 'disabled'}>Copiar JSON</button>
    <span class="eq-copied" id="eqCopied">Copiado \u2713</span>
    <button class="eq-btn" id="eqCsv" ${rows.length ? '' : 'disabled'}>Descargar CSV</button>
  </div>`;

  if (!rows.length) {
    html += `<div class="eq-tblwrap"><div class="eq-empty">${filtered
      ? 'Ning\u00fan registro coincide con el filtro local.'
      : 'La API no devolvi\u00f3 registros para esos par\u00e1metros.'}</div></div>`;
  } else {
    html += `<div class="eq-tblwrap"><table class="eq-tbl"><thead><tr>`
      + cols.map(c => `<th>${esc(c)}</th>`).join('')
      + `</tr></thead><tbody>`
      + rows.map(r => `<tr>` + cols.map(c => {
          const v = r[c];
          const isEmpty = v == null || v === '' || v === '-';
          const cell = (v != null && typeof v === 'object') ? JSON.stringify(v) : v;
          return `<td class="${MONO_COLS.has(c) ? 'mono' : ''}${isEmpty ? ' empty' : ''}">${isEmpty ? '\u2014' : esc(cell)}</td>`;
        }).join('') + `</tr>`).join('')
      + `</tbody></table></div>`;
  }

  html += `
  <div class="eq-jsonhead"><h2>JSON crudo</h2>
    <span style="font-size:12px;color:var(--muted)">tal cual lo devuelve la API${filtered ? ' (con el filtro local aplicado)' : ''}</span>
  </div>
  <pre class="eq-json" id="eqJson">${esc(JSON.stringify(rows, null, 2))}</pre>`;

  host.innerHTML = html;

  const btnCopy = $('#eqCopy');
  if (btnCopy) btnCopy.addEventListener('click', async () => {
    const text = JSON.stringify(rows, null, 2);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { ok = false; }
    }
    const chip = $('#eqCopied');
    if (chip) {
      chip.textContent = ok ? 'Copiado \u2713' : 'No se pudo copiar';
      chip.classList.add('show');
      setTimeout(() => chip.classList.remove('show'), 1800);
    }
  });

  const btnCsv = $('#eqCsv');
  if (btnCsv) btnCsv.addEventListener('click', () => downloadCsv(rows, cols));
}

/* CSV con separador ';' (formato regional), celdas escapadas y BOM UTF-8. */
function downloadCsv(rows, cols) {
  const cell = v => {
    const raw = (v != null && typeof v === 'object') ? JSON.stringify(v) : v;
    const s = String(raw == null ? '' : raw);
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(cell).join(';')]
    .concat(rows.map(r => cols.map(c => cell(r[c])).join(';')));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const tag = META ? META.api_code : 'consulta';
  a.download = `api_${tag}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 300);
}

function setMsg(kind, text) {
  const el = $('#eqMsg');
  if (!el) return;
  el.className = 'eq-msg' + (kind ? ' ' + kind : '');
  el.textContent = text || '';
}

/* Pinta los FILTROS de la API seleccionada (dinamicos desde el catalogo). */
function paintParams() {
  const host = $('#eqParams');
  if (!host) return;
  const note = $('#eqApiNote');
  if (note) note.textContent = CUR && CUR.note ? CUR.note : '';
  if (!CUR) { host.innerHTML = ''; return; }

  const today = new Date().toISOString().split('T')[0];
  const defs = Array.isArray(CUR.params) ? CUR.params : [];
  host.innerHTML = defs.map(d => {
    const req = d.required ? '' : ' <span style="font-weight:400">(opcional)</span>';
    const hint = d.note ? ` title="${esc(d.note)}"` : '';
    if (d.type === 'date') {
      return `<div class="eq-fld"><label for="eqP_${esc(d.key)}"${hint}>${esc(d.label || d.key)}${req}</label>
        <input id="eqP_${esc(d.key)}" data-param="${esc(d.key)}" type="date" value="${today}" style="width:150px"></div>`;
    }
    if (d.type === 'company') {
      return `<div class="eq-fld"><label for="eqP_${esc(d.key)}"${hint}>${esc(d.label || d.key)}${req}</label>
        <input id="eqP_${esc(d.key)}" data-param="${esc(d.key)}" type="text" class="mono" maxlength="10" placeholder="AA01" autocomplete="off" spellcheck="false" style="width:110px"></div>`;
    }
    return `<div class="eq-fld"><label for="eqP_${esc(d.key)}"${hint}>${esc(d.label || d.key)}${req}</label>
      <input id="eqP_${esc(d.key)}" data-param="${esc(d.key)}" type="text" autocomplete="off" style="width:170px"></div>`;
  }).join('')
  + `<div class="eq-fld"><label for="eqLocal">Filtro local <span style="font-weight:400">(no viaja)</span></label>
      <input id="eqLocal" type="text" placeholder="c\u00e9dula, nombre\u2026" autocomplete="off" style="width:160px"></div>
     <button class="eq-btn eq-btn-go" id="eqGo">Consultar</button>`;

  // Enter en cualquier filtro consulta; el filtro local repinta en vivo.
  host.querySelectorAll('[data-param]').forEach(inp =>
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') runQuery(); }));
  const loc = $('#eqLocal');
  if (loc) {
    loc.addEventListener('input', () => { if (META) paintResults(); });
    loc.addEventListener('keydown', e => { if (e.key === 'Enter' && !META) runQuery(); });
  }
  $('#eqGo').addEventListener('click', runQuery);
}

async function runQuery() {
  if (!CUR) { setMsg('err', 'Elige primero qu\u00e9 API consultar.'); return; }
  const params = {};
  document.querySelectorAll('#eqParams [data-param]').forEach(inp => {
    params[inp.dataset.param] = inp.value;
  });

  const btn = $('#eqGo');
  if (btn) { btn.disabled = true; btn.textContent = 'Consultando\u2026'; }
  setMsg('info', `Consultando ${CUR.label}\u2026`);
  RAW = []; META = null; paintResults();

  const d = await api({ action: 'query', user: sessionUserPayload(USER), api_code: CUR.code, params });

  if (btn) { btn.disabled = false; btn.textContent = 'Consultar'; }
  if (!d || !d.ok) {
    const parts = [(d && d.error) || 'No se pudo consultar.'];
    if (d && d.status) parts.push(`HTTP ${d.status}.`);
    if (d && d.detail) parts.push(String(d.detail).slice(0, 200));
    setMsg('err', parts.join(' '));
    return;
  }
  setMsg('', '');
  RAW = d.rows || [];
  META = { api_code: d.api_code, api_label: d.api_label, params_sent: d.params_sent || {}, status: d.status, count: d.count || RAW.length };
  paintResults();
}

export async function renderErpQuery(user) {
  USER = user;
  RAW = []; META = null; CUR = null;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="eq-head">
      <h1>Consultar API</h1>
      <p>Herramienta manual de consulta y diagn\u00f3stico: elige una API, completa sus filtros y revisa la respuesta tal cual llega. No modifica datos.</p>
    </div>
    <div class="eq-apibar">
      <div class="eq-fld"><label for="eqApi">API</label>
        <select id="eqApi"><option value="">Cargando cat\u00e1logo\u2026</option></select>
        <div class="eq-apinote" id="eqApiNote"></div></div>
    </div>
    <div class="eq-bar" id="eqParams"></div>
    <div class="eq-msg" id="eqMsg"></div>
    <div id="eqResults"></div>`;

  const sel = $('#eqApi');
  const d = await api({ action: 'catalog', user: sessionUserPayload(user) });
  if (!d || !d.ok || !(d.apis || []).length) {
    sel.innerHTML = `<option value="">Sin APIs en el cat\u00e1logo</option>`;
    setMsg('err', (d && d.error) || 'No se pudo cargar el cat\u00e1logo de APIs.');
    return;
  }
  APIS = d.apis;
  sel.innerHTML = APIS.map(a => `<option value="${esc(a.code)}">${esc(a.label)}</option>`).join('');
  CUR = APIS[0];
  paintParams();
  sel.addEventListener('change', () => {
    CUR = APIS.find(a => a.code === sel.value) || null;
    RAW = []; META = null; setMsg('', '');
    paintParams(); paintResults();
  });
}
