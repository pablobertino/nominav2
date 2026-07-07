/* =====================================================================
   js/views/erp-query.js  →  vista "Consultar sistema"
   (grupo Sincronizacion, solo superadmin)

   Herramienta de diagnostico: consulta CRUDA a la API de empleados del
   sistema por Alias + Fecha (default HOY), con filtro LOCAL opcional por
   cedula. Muestra:
     - Grilla con TODAS las columnas del JSON (scroll horizontal).
     - Bloque con el JSON crudo tal cual llego (formateado).
     - Boton Copiar JSON y boton Descargar CSV (separador ';').

   Datos por /api/erp-query (la key del sistema vive en el servidor).
   Export: renderErpQuery(user)

   Reglas UI del portal:
   - Sin alert/confirm/prompt nativos; mensajes inline.
   - No se menciona el sistema por su nombre en la UI.
   - El filtro por cedula es local: aplica a grilla, JSON y CSV sin volver
     a consultar.
   ===================================================================== */

import { $ } from '../core/dom.js';

let USER = null;
let RAW = [];          // filas tal cual llegaron del sistema
let META = null;       // { alias, fecha, count }

/* Orden preferido de columnas (las del JSON del sistema). Cualquier campo
   extra que llegue y no este aca se agrega al final, en orden alfabetico. */
const COL_ORDER = [
  'ficha', 'nombreCompleto', 'primerNombre', 'segundoNombre',
  'primerApellido', 'segundoApellido', 'apellidos',
  'fechaNacimiento', 'edad', 'genero', 'estadoCivil',
  'telefono', 'correo', 'cuentaBancaria',
  'idCargo', 'idPosicion', 'departamento',
  'inicioContrato', 'finContrato',
  'alias', 'dataArea', 'empresaNombre', 'empresaTipo', 'todoTicket',
];

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
  .eq-bar{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:16px 0 6px}
  .eq-fld{display:flex;flex-direction:column;gap:4px}
  .eq-fld label{font-size:11.5px;font-weight:600;color:var(--muted)}
  .eq-fld input{font:inherit;font-size:13.5px;padding:8px 11px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--ink)}
  .eq-fld input:focus{outline:none;border-color:var(--brand,#2563eb)}
  #eqAlias{width:110px;text-transform:uppercase;font-family:ui-monospace,Menlo,monospace;font-weight:600}
  #eqFecha{width:150px}
  #eqCed{width:140px;font-family:ui-monospace,Menlo,monospace}
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
    .eq-bar{align-items:stretch}
    .eq-fld,#eqAlias,#eqFecha,#eqCed{width:100%}
    .eq-btn-go{justify-content:center}
  }`;
  document.head.appendChild(st);
}

/* Filas visibles = RAW con el filtro local de cedula aplicado. */
function visibleRows() {
  const ced = String(($('#eqCed') && $('#eqCed').value) || '').replace(/[^0-9]/g, '');
  if (!ced) return RAW;
  return RAW.filter(r => String(r.ficha == null ? '' : r.ficha).replace(/[^0-9]/g, '').includes(ced));
}

/* Columnas = orden preferido (las presentes) + extras alfabeticas. */
function columnsOf(rows) {
  const present = new Set();
  rows.forEach(r => Object.keys(r || {}).forEach(k => present.add(k)));
  const cols = COL_ORDER.filter(k => present.has(k));
  const extra = [...present].filter(k => !COL_ORDER.includes(k)).sort();
  return cols.concat(extra);
}

const MONO_COLS = new Set(['ficha', 'cuentaBancaria', 'telefono', 'alias', 'dataArea', 'idCargo', 'idPosicion']);

function paintResults() {
  const host = $('#eqResults');
  if (!host) return;
  if (!META) { host.innerHTML = ''; return; }

  const rows = visibleRows();
  const cols = columnsOf(rows.length ? rows : RAW);
  const filtered = rows.length !== RAW.length;

  let html = `
  <div class="eq-sum">
    <span class="pill">${esc(META.alias)}</span>
    <span class="pill">${esc(META.fecha)}</span>
    <span><b>${rows.length}</b>${filtered ? ` de ${RAW.length}` : ''} fichas</span>
    <span class="eq-spacer"></span>
    <button class="eq-btn" id="eqCopy" ${rows.length ? '' : 'disabled'}>Copiar JSON</button>
    <span class="eq-copied" id="eqCopied">Copiado \u2713</span>
    <button class="eq-btn" id="eqCsv" ${rows.length ? '' : 'disabled'}>Descargar CSV</button>
  </div>`;

  if (!rows.length) {
    html += `<div class="eq-tblwrap"><div class="eq-empty">${filtered
      ? 'Ninguna ficha coincide con esa c\u00e9dula en el resultado.'
      : 'El sistema no devolvi\u00f3 fichas para esa empresa y fecha.'}</div></div>`;
  } else {
    html += `<div class="eq-tblwrap"><table class="eq-tbl"><thead><tr>`
      + cols.map(c => `<th>${esc(c)}</th>`).join('')
      + `</tr></thead><tbody>`
      + rows.map(r => `<tr>` + cols.map(c => {
          const v = r[c];
          const isEmpty = v == null || v === '' || v === '-';
          return `<td class="${MONO_COLS.has(c) ? 'mono' : ''}${isEmpty ? ' empty' : ''}">${isEmpty ? '\u2014' : esc(v)}</td>`;
        }).join('') + `</tr>`).join('')
      + `</tbody></table></div>`;
  }

  html += `
  <div class="eq-jsonhead"><h2>JSON crudo</h2>
    <span style="font-size:12px;color:var(--muted)">tal cual lo devuelve el sistema${filtered ? ' (filtrado por c\u00e9dula)' : ''}</span>
  </div>
  <pre class="eq-json" id="eqJson">${esc(JSON.stringify(rows, null, 2))}</pre>`;

  host.innerHTML = html;

  const btnCopy = $('#eqCopy');
  if (btnCopy) btnCopy.addEventListener('click', async () => {
    const text = JSON.stringify(rows, null, 2);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch {
      // Fallback sin clipboard API (contextos no seguros).
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

/* CSV con separador ';' (formato regional), celdas escapadas y BOM UTF-8
   para que Excel lo abra con acentos correctos. */
function downloadCsv(rows, cols) {
  const cell = v => {
    const s = String(v == null ? '' : v);
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(cell).join(';')]
    .concat(rows.map(r => cols.map(c => cell(r[c])).join(';')));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sistema_${META ? META.alias : 'consulta'}_${META ? META.fecha : ''}.csv`;
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

async function runQuery() {
  const alias = String($('#eqAlias').value || '').trim().toUpperCase();
  const fecha = $('#eqFecha').value || '';
  if (!alias) { setMsg('err', 'Indica el alias de la empresa (ej. AA01).'); return; }

  const btn = $('#eqGo');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Consultando\u2026';
  setMsg('info', 'Consultando el sistema\u2026');
  RAW = []; META = null; paintResults();

  const d = await api({ action: 'query', user: sessionUserPayload(USER), alias, fecha });

  btn.disabled = false;
  btn.textContent = prev;
  if (!d || !d.ok) {
    setMsg('err', (d && d.error) || 'No se pudo consultar el sistema. Intenta de nuevo.');
    return;
  }
  setMsg('', '');
  RAW = d.rows || [];
  META = { alias: d.alias, fecha: d.fecha, count: d.count || RAW.length };
  paintResults();
}

export function renderErpQuery(user) {
  USER = user;
  RAW = []; META = null;
  ensureStyles();
  const today = new Date().toISOString().split('T')[0];
  $('#pnlMain').innerHTML = `
    <div class="eq-head">
      <h1>Consultar sistema</h1>
      <p>Consulta directa de fichas del sistema por empresa y fecha. El resultado se muestra tal cual llega.</p>
    </div>
    <div class="eq-bar">
      <div class="eq-fld"><label for="eqAlias">Alias de empresa</label>
        <input id="eqAlias" type="text" maxlength="10" placeholder="AA01" autocomplete="off" spellcheck="false"></div>
      <div class="eq-fld"><label for="eqFecha">Fecha</label>
        <input id="eqFecha" type="date" value="${today}"></div>
      <div class="eq-fld"><label for="eqCed">C\u00e9dula (opcional, filtro local)</label>
        <input id="eqCed" type="text" inputmode="numeric" maxlength="9" placeholder="12345678" autocomplete="off"></div>
      <button class="eq-btn eq-btn-go" id="eqGo">Consultar</button>
    </div>
    <div class="eq-msg" id="eqMsg"></div>
    <div id="eqResults"></div>`;

  $('#eqGo').addEventListener('click', runQuery);
  $('#eqAlias').addEventListener('keydown', e => { if (e.key === 'Enter') runQuery(); });
  $('#eqFecha').addEventListener('keydown', e => { if (e.key === 'Enter') runQuery(); });
  // El filtro por cedula es LOCAL: re-pinta sin volver a consultar.
  $('#eqCed').addEventListener('input', () => { if (META) paintResults(); });
  $('#eqCed').addEventListener('keydown', e => { if (e.key === 'Enter' && !META) runQuery(); });
}
