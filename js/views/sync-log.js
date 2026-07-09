/* =====================================================================
   js/views/sync-log.js  →  vista "Registro de sincronizaciones" (v4.59)
   Solo superadmin. Se abre desde los botones "Registro" de las tres
   tarjetas de Configurar (no tiene item de menu propio).

   Un solo lugar para los TRES procesos programados (combo Proceso):
     - Catalogo de empresas   (sync_runs)
     - Estado de pago         (pay_sync_run)
     - Personal de tiendas    (roster_sync_log agrupado por corrida)

   Filtros: proceso, desde/hasta, estado. Paginado server-side. Detalle
   expandible por corrida (en Personal: fila por tienda con +/-/alerta).
   EXPORTAR xlsx/csv/txt con el patron de Empresas (REGLA GLOBAL de
   Pablo: "siempre el exportar debe hacerse asi en todos lados").

   Datos por /api/sync-log. Export: renderSyncLog(user, presetProcess?)
   ===================================================================== */

import { $ } from '../core/dom.js';

let USER = null;
let SL = { process: 'companies', page: 1, size: 25, status: '', from: '', to: '', total: 0, rows: [], note: '' };

const PROC_LBL = {
  companies: 'Cat\u00e1logo de empresas',
  pay: 'Estado de pago',
  roster: 'Personal de tiendas',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDT(iso) {
  if (!iso) return '';
  const d = new Date(iso); const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function api(payload) {
  return fetch('/api/sync-log', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminId: USER.id, ...payload }),
  }).then(x => x.json()).catch(() => null);
}

function ensureStyles() {
  if (document.getElementById('slStyles')) return;
  const st = document.createElement('style');
  st.id = 'slStyles';
  st.textContent = `
  .sl-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .sl-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .sl-bar{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:16px 0 12px}
  .sl-bar .fg{display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:600;color:var(--muted)}
  .sl-bar input,.sl-bar select{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink)}
  .sl-bar input:focus,.sl-bar select:focus{outline:none;border-color:var(--brand,#2563eb)}
  .sl-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;font-weight:600;padding:8px 14px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);cursor:pointer}
  .sl-btn:hover:not(:disabled){background:var(--bg-soft,#f1f5f9)}
  .sl-btn:disabled{opacity:.5;cursor:default}
  .sl-note{font-size:12px;color:var(--muted);margin:0 0 10px}
  .sl-tblwrap{border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);overflow:auto}
  .sl-tbl{border-collapse:collapse;width:100%;font-size:13px}
  .sl-tbl th{background:var(--bg-soft,#f8fafc);text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700;padding:9px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
  .sl-tbl td{padding:9px 12px;border-bottom:1px solid var(--border-soft,#eef1f5);vertical-align:top;color:var(--ink)}
  .sl-tbl tr:hover td{background:var(--bg-soft,#f8fafc)}
  .sl-st{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;white-space:nowrap}
  .sl-st.ok{background:var(--success-bg,#f0fdf4);color:var(--success,#15803d);border:1px solid #bbf7d0}
  .sl-st.error{background:var(--danger-bg,#fef2f2);color:var(--danger,#b91c1c);border:1px solid #f3c2c2}
  .sl-st.alerta{background:var(--warn-bg,#fff7ed);color:#b45309;border:1px solid #fed7aa}
  .sl-more{background:none;border:0;color:var(--brand,#2563eb);cursor:pointer;padding:0;font:inherit;font-size:12.5px;text-decoration:underline}
  .sl-det{background:var(--bg-soft,#f8fafc);border-radius:8px;padding:8px 11px;margin-top:7px;font-size:12px;color:var(--ink-soft,#475569);line-height:1.55;white-space:pre-wrap;word-break:break-word}
  .sl-pager{display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:10px;font-size:12.5px;color:var(--muted)}
  .sl-empty{padding:40px 16px;text-align:center;color:var(--muted)}`;
  document.head.appendChild(st);
}

/* ---------- EXPORTAR (patron Empresas: xlsx / csv / txt) ---------- */
function slExportRows() {
  return SL.rows.map(r => ({
    'Proceso': PROC_LBL[SL.process],
    'Fecha': fmtDT(r.run_at),
    'Origen': r.source === 'cron' ? 'Autom\u00e1tica' : 'Manual',
    'Estado': r.status === 'ok' ? 'OK' : (r.status === 'alerta' ? 'Con alerta' : 'Error'),
    'Resumen': r.summary || '',
    'Error': r.error || '',
    'Duraci\u00f3n (s)': r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) : '',
    'Detalle': detailText(r),
  }));
}
function detailText(r) {
  if (!r.detail) return '';
  if (Array.isArray(r.detail)) {
    return r.detail.map(st => `${st.company_code}${st.added ? ' +' + st.added : ''}${st.removed ? ' -' + st.removed : ''}${st.skipped ? ' [ALERTA: ' + (st.alert || '') + ']' : ''}`).join(' | ');
  }
  try { return JSON.stringify(r.detail); } catch (_) { return ''; }
}
function slDownloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function slTstamp() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
async function slDoExport(fmt) {
  const data = slExportRows();
  if (!data.length) return;
  const headers = Object.keys(data[0]);
  const fname = `registro_sync_${SL.process}_${slTstamp()}`;
  if (fmt === 'csv') {
    const escv = v => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [headers.join(';')].concat(data.map(r => headers.map(h => escv(r[h])).join(';')));
    slDownloadBlob('\uFEFF' + lines.join('\r\n'), `${fname}.csv`, 'text/csv;charset=utf-8');
    return;
  }
  if (fmt === 'txt') {
    const widths = headers.map(h => Math.max(h.length, ...data.map(r => String(r[h] ?? '').length)));
    const fmtRow = cells => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
    const lines = [fmtRow(headers), widths.map(w => '-'.repeat(w)).join('  ')]
      .concat(data.map(r => fmtRow(headers.map(h => r[h]))));
    slDownloadBlob(lines.join('\r\n'), `${fname}.txt`, 'text/plain;charset=utf-8');
    return;
  }
  if (fmt === 'xlsx') {
    try {
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar la librer\u00eda de Excel.'));
          document.head.appendChild(s);
        });
      }
      const ws = window.XLSX.utils.json_to_sheet(data, { header: headers });
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Registro');
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (_) { /* sin conexion al CDN: reintentar luego */ }
  }
}
function slOpenExportMenu(btn) {
  const old = document.getElementById('slExpMenu');
  if (old) { old.remove(); return; }
  const r = btn.getBoundingClientRect();
  const m = document.createElement('div');
  m.id = 'slExpMenu';
  m.style.cssText = `position:fixed;top:${r.bottom + 6}px;left:${Math.max(8, r.right - 170)}px;z-index:1100;background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;box-shadow:0 10px 32px rgba(15,23,42,.18);padding:6px;min-width:170px;display:flex;flex-direction:column;gap:2px`;
  const item = (lbl, fmt) => {
    const b = document.createElement('button');
    b.textContent = lbl;
    b.style.cssText = 'font:inherit;font-size:13px;text-align:left;padding:8px 12px;border:0;border-radius:8px;background:transparent;color:var(--ink);cursor:pointer';
    b.addEventListener('mouseenter', () => { b.style.background = 'var(--bg-soft,#f1f5f9)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', () => { m.remove(); slDoExport(fmt); });
    return b;
  };
  m.appendChild(item('Excel (.xlsx)', 'xlsx'));
  m.appendChild(item('CSV (.csv)', 'csv'));
  m.appendChild(item('Texto (.txt)', 'txt'));
  document.body.appendChild(m);
  setTimeout(() => {
    const away = ev => { if (!m.contains(ev.target) && ev.target !== btn) { m.remove(); document.removeEventListener('click', away); } };
    document.addEventListener('click', away);
  }, 0);
}

/* ---------- carga y pintado ---------- */
async function slLoad() {
  const list = $('#slBody');
  if (list) list.innerHTML = '<tr><td colspan="6" class="sl-empty">Cargando\u2026</td></tr>';
  const r = await api({
    process: SL.process, page: SL.page, page_size: SL.size,
    status: SL.status, from: SL.from, to: SL.to,
  });
  if (!r || !r.ok) {
    if (list) list.innerHTML = `<tr><td colspan="6" class="sl-empty">No se pudo cargar${r && r.error ? ': ' + esc(r.error) : ''}.</td></tr>`;
    return;
  }
  SL.total = r.total || 0;
  SL.rows = r.rows || [];
  SL.note = r.note || '';
  slPaint();
}
function detHtml(r) {
  if (!r.detail && !r.error) return '';
  if (Array.isArray(r.detail)) {
    return r.detail.map(st => st.skipped
      ? `<span style="color:#b45309">${esc(st.company_code)} \u26a0 ${esc(st.alert || '')}</span>`
      : `${esc(st.company_code)} ${st.added ? '+' + st.added : ''}${st.removed ? '\u2212' + st.removed : ''}`
    ).join(' \u00b7 ');
  }
  const parts = [];
  if (r.error) parts.push('\u26a0 ' + esc(r.error));
  if (r.detail) { try { parts.push(esc(JSON.stringify(r.detail, null, 1))); } catch (_) { /* nada */ } }
  return parts.join('\n');
}
function slPaint() {
  const note = $('#slNote');
  if (note) note.textContent = SL.note || '';
  const body = $('#slBody');
  if (!body) return;
  if (!SL.rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="sl-empty">Sin corridas con estos filtros.</td></tr>';
  } else {
    body.innerHTML = SL.rows.map((r, i) => {
      const st = esc(r.status || 'ok');
      const stLbl = r.status === 'ok' ? 'OK' : (r.status === 'alerta' ? 'Con alerta' : 'Error');
      const hasDet = !!(r.detail || r.error);
      return `<tr>
        <td>${fmtDT(r.run_at)}</td>
        <td>${r.source === 'cron' ? 'Autom\u00e1tica' : 'Manual'}</td>
        <td><span class="sl-st ${st}">${stLbl}</span></td>
        <td>${esc(r.summary || '')}${hasDet ? `<div id="slDet_${i}" class="sl-det" hidden>${detHtml(r)}</div>` : ''}</td>
        <td style="text-align:right;white-space:nowrap">${r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + ' s' : '\u2014'}</td>
        <td>${hasDet ? `<button class="sl-more" data-det="${i}">Detalle</button>` : ''}</td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-det]').forEach(b =>
      b.addEventListener('click', () => {
        const el = $('#slDet_' + b.dataset.det);
        if (el) el.hidden = !el.hidden;
      }));
  }
  const from = SL.total ? (SL.page - 1) * SL.size + 1 : 0;
  const to = Math.min(SL.page * SL.size, SL.total);
  $('#slRange').textContent = SL.total ? `${from}\u2013${to} de ${SL.total}` : '0 corridas';
  $('#slPrev').disabled = SL.page <= 1;
  $('#slNext').disabled = to >= SL.total;
  $('#slExport').disabled = !SL.rows.length;
}

export async function renderSyncLog(user, presetProcess) {
  USER = user;
  ensureStyles();
  SL = { process: PROC_LBL[presetProcess] ? presetProcess : 'companies', page: 1, size: 25, status: '', from: '', to: '', total: 0, rows: [], note: '' };
  $('#pnlMain').innerHTML = `
    <div class="sl-head"><div>
      <h1>Registro de sincronizaciones</h1>
      <p>Historial de corridas de los procesos programados: qu\u00e9 corri\u00f3, cu\u00e1ndo, c\u00f3mo termin\u00f3 y su detalle.</p>
    </div></div>
    <div class="sl-bar">
      <span class="fg">Proceso<select id="slProc">
        <option value="companies">Cat\u00e1logo de empresas</option>
        <option value="pay">Estado de pago</option>
        <option value="roster">Personal de tiendas</option>
      </select></span>
      <span class="fg">Desde<input type="date" id="slFrom"></span>
      <span class="fg">Hasta<input type="date" id="slTo"></span>
      <span class="fg">Estado<select id="slSt"><option value="">Todos</option><option value="ok">OK</option><option value="error">Error / alerta</option></select></span>
      <span class="fg">Por p\u00e1gina<select id="slSize"><option selected>25</option><option>50</option><option>100</option></select></span>
      <button class="sl-btn" id="slGo">Aplicar</button>
      <span style="flex:1"></span>
      <button class="sl-btn" id="slExport" title="Exportar lo que se ve"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg> Exportar</button>
    </div>
    <p class="sl-note" id="slNote"></p>
    <div class="sl-tblwrap"><table class="sl-tbl">
      <thead><tr><th>Fecha</th><th>Origen</th><th>Estado</th><th>Resumen</th><th style="text-align:right">Duraci\u00f3n</th><th></th></tr></thead>
      <tbody id="slBody"></tbody>
    </table></div>
    <div class="sl-pager">
      <span id="slRange"></span>
      <button class="sl-btn" id="slPrev">\u2190 Anterior</button>
      <button class="sl-btn" id="slNext">Siguiente \u2192</button>
    </div>`;

  $('#slProc').value = SL.process;
  const apply = () => {
    SL.process = $('#slProc').value;
    SL.from = $('#slFrom').value;
    SL.to = $('#slTo').value;
    SL.status = $('#slSt').value;
    SL.size = +$('#slSize').value;
    SL.page = 1;
    slLoad();
  };
  $('#slGo').addEventListener('click', apply);
  ['#slProc', '#slSt', '#slSize'].forEach(sel => $(sel).addEventListener('change', apply));
  $('#slPrev').addEventListener('click', () => { if (SL.page > 1) { SL.page--; slLoad(); } });
  $('#slNext').addEventListener('click', () => { if (SL.page * SL.size < SL.total) { SL.page++; slLoad(); } });
  $('#slExport').addEventListener('click', () => slOpenExportMenu($('#slExport')));

  await slLoad();
}
