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
import { attachRefresh } from '../core/refresh.js';

let USER = null;
let SL = { process: 'roster', page: 1, size: 25, status: '', from: '', to: '', total: 0, rows: [], note: '' };

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
    body: JSON.stringify({ adminId: USER.id, user: { kind: USER.kind, id: USER.id || null, companyCode: USER.companyCode || null }, ...payload }),
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
  .sl-det{background:var(--bg-soft,#f8fafc);border-radius:8px;padding:8px 11px;margin-top:7px;font-size:12px;color:var(--ink-soft,#475569);line-height:1.55;word-break:break-word}
  .sl-pager{display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:10px;font-size:12.5px;color:var(--muted)}
  .sl-empty{padding:40px 16px;text-align:center;color:var(--muted)}

  /* v5.37: pestanas del detalle (Movimientos / Completadas / Diferencias / ...) */
  .sl-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin:2px 0 0;flex-wrap:wrap}
  .sl-tab{font:inherit;font-size:12.5px;font-weight:600;color:var(--muted);cursor:pointer;padding:7px 12px;
          background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
  .sl-tab:hover{color:var(--ink)}
  .sl-tab.on{color:var(--brand,#2563eb);border-bottom-color:var(--brand,#2563eb);font-weight:700}
  .sl-tn{display:inline-block;margin-left:4px;padding:1px 6px;border-radius:999px;background:#eef2f7;
         color:var(--muted);font-size:10.5px;font-weight:700}
  .sl-tab.on .sl-tn{background:#e6efff;color:var(--brand,#2563eb)}
  .sl-pane{padding-top:11px}
  .sl-pn{font-size:12px;color:var(--ink-soft,#475569);margin:0 0 10px;padding:8px 11px;border-radius:8px;
         background:var(--bg-soft,#f8fafc);border:1px solid var(--border-soft,#eef1f5);line-height:1.6}
  .sl-pn b{color:var(--ink)}
  .sl-mini{width:100%;border-collapse:collapse;font-size:12px;background:var(--card,#fff);
           border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .sl-mini th{background:var(--bg-soft,#f8fafc);text-align:left;font-size:10px;text-transform:uppercase;
              letter-spacing:.04em;color:var(--muted);font-weight:700;padding:7px 9px;
              border-bottom:1px solid var(--border);white-space:nowrap}
  .sl-mini td{padding:7px 9px;border-bottom:1px solid var(--border-soft,#eef1f5);color:var(--ink);vertical-align:middle}
  .sl-mini tr:last-child td{border-bottom:0}
  .sl-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;
           font-variant-numeric:tabular-nums}
  .sl-cc{color:var(--brand,#2563eb);font-weight:700;font-size:11.5px}
  .sl-pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:800;white-space:nowrap}
  .sl-pill.rev{background:#e6efff;color:#1e40af}
  .sl-pill.fix{background:#fdf3e7;color:#b45309}`;
  document.head.appendChild(st);
}

/* ---------- EXPORTAR (patron Empresas: xlsx / csv / txt) ---------- */
function slExportRows() {
  /* v5.37: en Personal de tiendas, el export deja de ser "una fila por corrida"
     y pasa a ser UNA FILA POR CASO: cada ficha completada, cada diferencia,
     cada dato mal escrito. Eso es lo que sirve para trabajar: se abre en Excel,
     se filtra por estado, y se va a corregir al sistema.

     El resumen por corrida no se pierde: va en las columnas Fecha/Origen. */
  if (SL.process === 'roster') {
    const filas = [];
    for (const r of SL.rows) {
      const base = {
        'Fecha': fmtDT(r.run_at),
        'Origen': r.source === 'cron' ? 'Autom\u00e1tica' : 'Manual',
      };
      for (const d of (r.fills || [])) filas.push({
        ...base, 'Tipo': 'Ficha completada', 'Estado': '',
        'C\u00e9dula': d.ced || '', 'Colaborador': d.nom || '', 'Empresa': d.comp || '',
        'Campo': d.campo || '', 'En el portal': '', 'En el sistema': d.valor || '',
      });
      for (const d of (r.diffs || [])) filas.push({
        ...base, 'Tipo': 'Diferencia',
        'Estado': d.estado === 'dato_roto' ? 'Corregir en el sistema' : 'Revisar',
        'C\u00e9dula': d.ced || '', 'Colaborador': d.nom || '', 'Empresa': d.comp || '',
        'Campo': d.campo || '', 'En el portal': d.portal || '', 'En el sistema': d.sistema || '',
      });
      for (const d of (r.rejects || [])) filas.push({
        ...base, 'Tipo': 'Dato mal escrito', 'Estado': 'Corregir en el sistema',
        'C\u00e9dula': d.ced || '', 'Colaborador': d.nom || '', 'Empresa': d.comp || '',
        'Campo': d.campo || '', 'En el portal': '', 'En el sistema': d.valor || '',
      });
      for (const s of (r.detail || [])) {
        if (s.added || s.removed) filas.push({
          ...base, 'Tipo': s.added ? 'Ingreso' : 'Egreso', 'Estado': '',
          'C\u00e9dula': '', 'Colaborador': '', 'Empresa': s.company_code || '',
          'Campo': '', 'En el portal': String(s.added || s.removed), 'En el sistema': '',
        });
        if (s.skipped || s.alert) filas.push({
          ...base, 'Tipo': 'Alerta', 'Estado': 'Tienda saltada',
          'C\u00e9dula': '', 'Colaborador': '', 'Empresa': s.company_code || '',
          'Campo': '', 'En el portal': '', 'En el sistema': s.alert || '',
        });
      }
    }
    // Corridas viejas (sin detalle fino): al menos se exporta el resumen.
    if (!filas.length) {
      return SL.rows.map(r => ({
        'Fecha': fmtDT(r.run_at),
        'Origen': r.source === 'cron' ? 'Autom\u00e1tica' : 'Manual',
        'Tipo': 'Resumen', 'Estado': r.status === 'ok' ? 'OK' : 'Con alerta',
        'C\u00e9dula': '', 'Colaborador': '', 'Empresa': '',
        'Campo': '', 'En el portal': r.summary || '', 'En el sistema': '',
      }));
    }
    return filas;
  }

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
/* Un panel de pestaña. Solo el primero arranca visible. */
function pane(idx, key, visible, inner) {
  return `<div class="sl-pane" id="slPane_${idx}_${key}"${visible ? '' : ' hidden'}>${inner}</div>`;
}

function detHtml(r, idx) {
  if (!r.detail && !r.error) return '';
  const copyBtn = `<div style="margin-top:7px"><button class="sl-more" data-copy="${idx}">Copiar detalle</button> <span id="slCopied_${idx}" style="display:none;font-size:11px;color:var(--success,#15803d)">✓ copiado</span></div>`;

  /* ===================================================================
     v5.37 — EL DETALLE, EN PESTAÑAS (mockup aprobado por Pablo).

     Antes esto era una linea de codigos de tienda: "AA01 · AA02 · AA03...".
     Servia para saber QUE tiendas se tocaron, pero no QUE PASO con la gente.
     Una corrida que completo 755 fichas y encontro 8 diferencias se veia
     igual que uno que no hizo nada.

     Cinco pestañas, y solo aparecen las que tienen contenido:
       Movimientos         — ingresos y egresos por tienda (lo de antes)
       Completadas         — fichas en blanco que se llenaron con el sistema
       Diferencias         — lo que no coincide, con su estatus
       Datos mal escritos  — lo que el sistema mando roto y no se guardo
       Alertas             — tiendas que se saltaron
     =================================================================== */
  if (Array.isArray(r.detail)) {
    const diffs   = Array.isArray(r.diffs)   ? r.diffs   : [];
    const fills   = Array.isArray(r.fills)   ? r.fills   : [];
    const rejects = Array.isArray(r.rejects) ? r.rejects : [];
    const movs    = r.detail.filter(s => s.added || s.removed);
    const alertas = r.detail.filter(s => s.skipped || s.alert);

    const tabs = [];
    if (movs.length)    tabs.push(['mov',  'Movimientos', movs.length]);
    if (fills.length)   tabs.push(['fill', 'Completadas', fills.length]);
    if (diffs.length)   tabs.push(['diff', 'Diferencias', diffs.length]);
    if (rejects.length) tabs.push(['rej',  'Datos mal escritos', rejects.length]);
    if (alertas.length) tabs.push(['alr',  'Alertas', alertas.length]);

    // Corrida vieja (sin las columnas nuevas): se cae al detalle de antes.
    if (!tabs.length) {
      return r.detail.map(st => esc(st.company_code)).join(' · ') + copyBtn;
    }

    const tabsHtml = tabs.map(([k, lbl, n], i) =>
      `<button class="sl-tab${i === 0 ? ' on' : ''}" data-tab="${idx}" data-key="${k}">`
      + `${esc(lbl)} <span class="sl-tn">${n}</span></button>`).join('');

    const panes = [];
    const first = (k) => tabs[0][0] === k;

    if (movs.length) panes.push(pane(idx, 'mov', first('mov'),
      `<table class="sl-mini"><thead><tr><th>Empresa</th><th>Ingresos</th><th>Egresos</th></tr></thead><tbody>`
      + movs.map(s => `<tr><td class="sl-cc">${esc(s.company_code)}</td>`
        + `<td>${s.added ? '<b style="color:#15803d">+' + s.added + '</b>' : '—'}</td>`
        + `<td>${s.removed ? '<b style="color:#b91c1c">−' + s.removed + '</b>' : '—'}</td></tr>`).join('')
      + `</tbody></table>`));

    if (fills.length) panes.push(pane(idx, 'fill', first('fill'),
      `<p class="sl-pn">Fichas que estaban <b>en blanco</b> en el portal y que el sistema sí tenía. `
      + `Se completaron solas. <b>Ningún dato ya cargado fue modificado.</b></p>`
      + `<table class="sl-mini"><thead><tr><th>Cédula</th><th>Colaborador</th><th>Empresa</th><th>Campo</th><th>Dato que se tomó</th></tr></thead><tbody>`
      + fills.slice(0, 300).map(d => `<tr>`
        + `<td class="sl-mono">${esc(d.ced || '')}</td>`
        + `<td>${esc(d.nom || '')}</td>`
        + `<td class="sl-cc">${esc(d.comp || '')}</td>`
        + `<td>${esc(d.campo || '')}</td>`
        + `<td class="sl-mono" style="color:#15803d">${esc(d.valor || '')}</td></tr>`).join('')
      + `</tbody></table>`
      + (fills.length > 300 ? `<p class="sl-pn">Mostrando 300 de ${fills.length}. Usá Exportar para la lista completa.</p>` : '')));

    if (diffs.length) panes.push(pane(idx, 'diff', first('diff'),
      `<p class="sl-pn">El portal <b>no modificó</b> ninguno de estos datos: ya tenían valor, así que solo los señaló.<br>`
      + `<span class="sl-pill rev">Revisar</span> los dos lados tienen dato y no coinciden: hay que decidir cuál vale. `
      + `<span class="sl-pill fix">Corregir en el sistema</span> el portal lo tiene bien y el sistema lo tiene mal escrito.</p>`
      + `<table class="sl-mini"><thead><tr><th>Estado</th><th>Cédula</th><th>Colaborador</th><th>Empresa</th><th>Campo</th><th>En el portal</th><th>En el sistema</th></tr></thead><tbody>`
      + diffs.map(d => `<tr>`
        + `<td>${d.estado === 'dato_roto'
            ? '<span class="sl-pill fix">Corregir en el sistema</span>'
            : '<span class="sl-pill rev">Revisar</span>'}</td>`
        + `<td class="sl-mono">${esc(d.ced || '')}</td>`
        + `<td>${esc(d.nom || '')}</td>`
        + `<td class="sl-cc">${esc(d.comp || '')}</td>`
        + `<td>${esc(d.campo || '')}</td>`
        + `<td class="sl-mono" style="color:#15803d">${esc(d.portal || '')}</td>`
        + `<td class="sl-mono" style="color:#9a3412">${esc(d.sistema || '')}</td></tr>`).join('')
      + `</tbody></table>`));

    if (rejects.length) panes.push(pane(idx, 'rej', first('rej'),
      `<p class="sl-pn">El sistema mandó estos datos <b>mal escritos</b>, así que <b>no se guardaron</b>. `
      + `El portal no arregla datos del sistema: hay que corregirlos allá.</p>`
      + `<table class="sl-mini"><thead><tr><th>Cédula</th><th>Colaborador</th><th>Empresa</th><th>Campo</th><th>Vino así</th></tr></thead><tbody>`
      + rejects.slice(0, 300).map(d => `<tr>`
        + `<td class="sl-mono">${esc(d.ced || '')}</td>`
        + `<td>${esc(d.nom || '')}</td>`
        + `<td class="sl-cc">${esc(d.comp || '')}</td>`
        + `<td>${esc(d.campo || '')}</td>`
        + `<td class="sl-mono" style="color:#9a3412">${esc(d.valor || '')}</td></tr>`).join('')
      + `</tbody></table>`
      + (rejects.length > 300 ? `<p class="sl-pn">Mostrando 300 de ${rejects.length}. Usá Exportar para la lista completa.</p>` : '')));

    if (alertas.length) panes.push(pane(idx, 'alr', first('alr'),
      `<p class="sl-pn">Estas tiendas <b>se saltaron</b>: el sistema devolvió una lista sospechosamente corta `
      + `y el portal prefirió no tocar nada antes que dar de baja a gente que sigue trabajando.</p>`
      + `<table class="sl-mini"><thead><tr><th>Empresa</th><th>Motivo</th></tr></thead><tbody>`
      + alertas.map(s => `<tr><td class="sl-cc">${esc(s.company_code)}</td>`
        + `<td style="color:#b45309">${esc(s.alert || 'Sin detalle')}</td></tr>`).join('')
      + `</tbody></table>`));

    return `<div class="sl-tabs">${tabsHtml}</div>${panes.join('')}${copyBtn}`;
  }

  // v4.63: detalle LEGIBLE para no-programadores (nunca JSON crudo en
  // pantalla); el boton Copiar entrega el detalle tecnico completo.
  const LBL = {
    companies: 'Empresas', zones: 'Zonas', subzones: 'Subzonas', concepts: 'Conceptos',
    updated: 'Actualizados', inserted: 'Nuevos', rows: 'Registros', count: 'Registros',
    changes: 'Cambios', changes_count: 'Cambios', mode: 'Modo', stores: 'Tiendas revisadas',
    added: 'Ingresos', removed: 'Egresos', alerts: 'Alertas', errors: 'Errores',
    skipped: 'Saltadas', total: 'Total', duration_ms: 'Duracion (ms)', incomplete: 'Corrida parcial',
    run_id: 'Corrida', total_stores: 'Tiendas totales',
  };
  const parts = [];
  if (r.error) parts.push(`<div style="color:var(--danger,#b91c1c);margin-bottom:4px">⚠ ${esc(r.error)}</div>`);
  const d = r.detail;
  if (d && typeof d === 'object') {
    const items = [];
    for (const [k, v] of Object.entries(d)) {
      if (v == null) continue;
      if (typeof v === 'object') {
        if (Array.isArray(v)) items.push(`<b>${esc(LBL[k] || k)}:</b> ${v.length}`);
        continue;
      }
      if (typeof v === 'boolean') { if (v) items.push(`<b>${esc(LBL[k] || k)}:</b> sí`); continue; }
      items.push(`<b>${esc(LBL[k] || k)}:</b> ${esc(String(v))}`);
    }
    if (items.length) parts.push(items.join(' · '));
  }
  return parts.join('') + copyBtn;
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
        <td>${esc(r.summary || '')}${hasDet ? `<div id="slDet_${i}" class="sl-det" hidden>${detHtml(r, i)}</div>` : ''}</td>
        <td style="text-align:right;white-space:nowrap">${r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + ' s' : '\u2014'}</td>
        <td>${hasDet ? `<button class="sl-more" data-det="${i}">Detalle</button>` : ''}</td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-det]').forEach(b =>
      b.addEventListener('click', () => {
        const el = $('#slDet_' + b.dataset.det);
        if (el) el.hidden = !el.hidden;
      }));
    /* v5.37: cambiar de pestaña dentro del detalle. Se apaga el panel visible
       y se prende el elegido; los paneles viven en el mismo detalle, asi que
       el filtro por data-tab evita pisar los de OTRA corrida abierta. */
    body.querySelectorAll('[data-tab]').forEach(b =>
      b.addEventListener('click', () => {
        const idx = b.dataset.tab;
        const key = b.dataset.key;
        body.querySelectorAll(`[data-tab="${idx}"]`).forEach(t => t.classList.remove('on'));
        b.classList.add('on');
        body.querySelectorAll(`[id^="slPane_${idx}_"]`).forEach(p => { p.hidden = true; });
        const pane = $(`#slPane_${idx}_${key}`);
        if (pane) pane.hidden = false;
      }));
    // v4.63: Copiar el detalle tecnico completo (JSON) al portapapeles.
    body.querySelectorAll('[data-copy]').forEach(b =>
      b.addEventListener('click', async () => {
        const r = SL.rows[+b.dataset.copy];
        if (!r) return;
        const payload = { fecha: r.run_at, origen: r.source, estado: r.status, resumen: r.summary, error: r.error || undefined, detalle: r.detail };
        try {
          await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
          const ok = $('#slCopied_' + b.dataset.copy);
          if (ok) { ok.style.display = 'inline'; setTimeout(() => { ok.style.display = 'none'; }, 1800); }
        } catch (_) { /* portapapeles no disponible */ }
      }));
  }
  const from = SL.total ? (SL.page - 1) * SL.size + 1 : 0;
  const to = Math.min(SL.page * SL.size, SL.total);
  $('#slRange').textContent = SL.total ? `${from}\u2013${to} de ${SL.total}` : '0 corridas';
  $('#slPrev').disabled = SL.page <= 1;
  $('#slNext').disabled = to >= SL.total;
  $('#slExport').disabled = !SL.rows.length;
}

export async function renderSyncLog(user, presetProcess, backView) {
  USER = user;
  ensureStyles();
  // v4.66: sin preset (entrada por el menu) arranca en Personal de tiendas,
  // el proceso que mas se consulta. Los botones de tarjetas/vistas siguen
  // pasando su propio preset.
  SL = { process: PROC_LBL[presetProcess] ? presetProcess : 'roster', page: 1, size: 25, status: '', from: '', to: '', total: 0, rows: [], note: '' };
  // v4.63: backView = data-view del menu desde donde se abrio (sync,
  // syncreview, axcompare, axhistory): el boton Volver re-navega alli.
  const backBtn = backView
    ? `<button class="sl-btn" id="slBack" style="margin-bottom:10px">← Volver</button>`
    : '';
  $('#pnlMain').innerHTML = `
    ${backBtn}
    <div class="sl-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px"><div>
      <h1>Registro de sincronizaciones</h1>
      <p>Historial de corridas de los procesos programados: qu\u00e9 corri\u00f3, cu\u00e1ndo, c\u00f3mo termin\u00f3 y su detalle.</p>
    </div><span id="slRefresh"></span></div>
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
  if (backView) {
    const bk = $('#slBack');
    if (bk) bk.addEventListener('click', () => {
      const navBtn = document.querySelector(`.pnl-side [data-view="${backView}"]`) || document.querySelector(`[data-view="${backView}"]`);
      if (navBtn) navBtn.click();
    });
  }
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
  // v4.66: chip "hace X min" + boton Recargar, como en Historial.
  attachRefresh('#slRefresh', () => slLoad(), 'synclog');
}
