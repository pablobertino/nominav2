/* =====================================================================
   views/double-employment.js — Doble empleo
   Personas ACTIVAS en dos o mas tiendas al mismo tiempo.

   Una persona no puede estar activa en dos tiendas a la vez. Pasa cuando
   la ingresan en la tienda nueva pero nadie cierra su contrato en la
   anterior. Mientras siga asi, cuenta DOBLE en la nomina, en los reportes
   y en los envios.

   SOLO LECTURA (decision de Pablo, 2026-07-11): "hay que resolverlos en
   el AX". El portal NO corrige nada. Si lo hiciera, la proxima
   sincronizacion revivira el dato igual, porque la fuente de verdad es el
   sistema. Aca solo se listan; al cerrar el contrato en el sistema, el
   caso desaparece solo en la siguiente sincronizacion.

   Gate: view.dobleempleo (enforced).
   ===================================================================== */
import { $ } from '../core/dom.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const fmtDate = d => {
  if (!d) return '—';
  const [y, m, dd] = String(d).slice(0, 10).split('-');
  return (y && m && dd) ? `${dd}/${m}/${y}` : '—';
};

/* Dias transcurridos desde una fecha (para "hace N dias"). */
function daysSince(d) {
  if (!d) return null;
  const t = Date.parse(String(d).slice(0, 10) + 'T00:00:00');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

async function api(user, payload) {
  const res = await fetch('/api/double-employment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, user }),
  });
  return res.json();
}

let STYLED = false;
function ensureStyles() {
  if (STYLED) return;
  STYLED = true;
  const css = document.createElement('style');
  /* OJO: nunca usar escapes tipo \2713 dentro de este template literal.
     Es escape OCTAL en JS -> SyntaxError -> el modulo no parsea -> portal
     en blanco. Usar los caracteres directos. (Leccion de v5.13.) */
  css.textContent = `
  .de-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}
  .de-head h2{margin:0;font-size:20px;font-weight:700;display:flex;align-items:center;gap:9px}
  .de-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .de-why{display:flex;gap:11px;align-items:flex-start;background:var(--warn-bg,#fff7ed);
          border:1px solid #fed7aa;color:#92400e;border-radius:11px;
          padding:12px 15px;margin:16px 0 0;font-size:12.5px;line-height:1.6}
  .de-why .ic{flex:none;font-size:15px}
  .de-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:11px;margin:14px 0 0}
  .de-kpi{background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;padding:13px 15px}
  .de-kpi small{display:block;font-size:11.5px;color:var(--muted);font-weight:700}
  .de-kpi b{font-size:24px;font-weight:700;line-height:1.25;display:block;margin-top:3px}
  .de-kpi .sub{font-size:11px;color:var(--faint,#94a3b8);font-weight:600;margin-top:2px}
  .de-kpi.bad{border-color:#fecaca;background:#fef2f2}
  .de-kpi.bad b{color:#dc2626}
  .de-filters{display:flex;gap:8px 10px;align-items:center;flex-wrap:wrap;margin:15px 0 0}
  .de-filters input,.de-filters select{font:inherit;font-size:13px;padding:7px 10px;
       border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink)}
  .de-card{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;
        margin-top:13px;overflow:hidden}
  .de-tbl{width:100%;border-collapse:collapse;font-size:13px}
  .de-tbl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;
     color:var(--muted);font-weight:800;padding:10px 14px;background:#fbfcfe;
     border-bottom:1px solid var(--border);white-space:nowrap}
  .de-tbl td{padding:12px 14px;border-bottom:1px solid var(--border-soft,#eef1f5);vertical-align:middle}
  .de-tbl tbody tr:last-child td{border-bottom:none}
  .de-tbl tbody tr:hover{background:var(--bg-soft,#f8fafc)}
  .de-ced{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
  .de-nm{font-weight:700}
  .de-role{font-size:11px;color:var(--muted);margin-top:1px}
  .de-role.ger{color:#dc2626;font-weight:800}
  .de-two{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
  .de-store{border:1px solid var(--border);border-radius:9px;padding:6px 10px;min-width:0}
  .de-store .cc{font-family:ui-monospace,Menlo,monospace;font-weight:800;font-size:12px;color:var(--brand,#2563eb)}
  .de-store .bn{font-size:11px;color:var(--muted);margin-top:1px}
  .de-store .dt{font-size:10.5px;color:var(--faint,#94a3b8);margin-top:2px}
  .de-store.old{background:#fef2f2;border-color:#fecaca}
  .de-store.old .cc{color:#dc2626}
  .de-store.new{background:#f0fdf4;border-color:#bbf7d0}
  .de-store.new .cc{color:#15803d}
  .de-plus{color:var(--faint,#94a3b8);font-weight:800;flex:none}
  .de-tag{display:inline-block;border-radius:999px;padding:2px 8px;font-size:10px;font-weight:800;margin-top:3px}
  .de-tag.proj{background:#fef3c7;color:#92400e;border:1px solid #fde68a}
  .de-tag.open{background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0}
  .de-tag.closed{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
  .de-tag.tmp{background:#fff7ed;color:#c2410c;border:1px solid #fed7aa}
  .de-note{font-size:11.5px;color:var(--muted);margin:10px 2px 0;line-height:1.6}
  .de-empty{padding:52px 20px;text-align:center}
  .de-empty .big{font-size:38px;margin-bottom:10px}
  .de-empty .t{font-weight:700;color:#16a34a;margin-bottom:5px;font-size:15px}
  .de-empty .s{font-size:12.5px;color:var(--muted);max-width:460px;margin:0 auto;line-height:1.6}
  .de-loading{padding:44px;text-align:center;color:var(--muted);font-size:13px}
  @media(max-width:760px){
    .de-tbl thead{display:none}
    .de-tbl td{display:block;border:none;padding:4px 14px}
    .de-tbl tbody tr{display:block;border-bottom:1px solid var(--border);padding:11px 0}
    .de-two{margin-top:6px}
  }`;
  document.head.appendChild(css);
}

/* Pildora del estado de la empresa. "Proyectada" es la mas informativa:
   una tienda que nunca abrio no deberia tener personal activo. */
function statusTag(st) {
  const s = String(st || '').trim();
  if (!s) return '';
  const map = {
    'Abierto':          ['open',   'Abierto'],
    'Cerrado':          ['closed', 'Cerrado'],
    'Cerrada temporal': ['tmp',    'Cerrada temporal'],
    'Proyectada':       ['proj',   'Proyectada'],
  };
  const [cls, txt] = map[s] || ['proj', s];
  return `<span class="de-tag ${cls}">${esc(txt)}</span>`;
}

/* Una tarjeta de empresa. La PRIMERA (mas vieja) se pinta como "anterior"
   (rojo) y la ULTIMA como "nueva" (verde): es la lectura natural del
   problema (entro en la nueva, no lo cerraron en la anterior). */
function storeCard(c, isLast) {
  return `
    <div class="de-store ${isLast ? 'new' : 'old'}">
      <div class="cc">${esc(c.company_code || '')}</div>
      <div class="bn">${esc(c.business_name || '')}</div>
      <div class="dt">desde ${fmtDate(c.start_date)}</div>
      ${statusTag(c.status)}
    </div>`;
}

function rowHtml(r) {
  const comps = Array.isArray(r.companies) ? r.companies : [];
  const cards = comps.map((c, i) => storeCard(c, i === comps.length - 1))
    .join('<span class="de-plus">+</span>');
  const last = comps[comps.length - 1] || {};
  const loc = [last.zone, last.subzone].filter(Boolean).join(' · ') || '—';
  const isGer = String(r.role || '').toUpperCase() === 'GERENTE';
  const ced = `${esc(r.ced_kind || 'V')}-${esc(r.id_number || '')}`;
  return `
    <tr data-ced="${esc(r.id_number || '')}"
        data-search="${esc(((r.full_name || '') + ' ' + (r.id_number || '')).toLowerCase())}">
      <td>
        <div class="de-nm">${esc(r.full_name || '')}</div>
        <div class="de-ced">${ced}</div>
        <div class="de-role ${isGer ? 'ger' : ''}">${esc(r.role || '')}</div>
      </td>
      <td><div class="de-two">${cards}</div></td>
      <td style="color:var(--muted);font-size:12px">${esc(loc)}</td>
    </tr>`;
}

/* ---- exportacion (Excel + CSV + TXT, sobre lo VISIBLE) ---- */
function visibleRows(rows) {
  const q = ($('#deQ')?.value || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(r =>
    ((r.full_name || '') + ' ' + (r.id_number || '')).toLowerCase().includes(q));
}

function flatten(rows) {
  // Una fila POR EMPRESA (formato tabular, mas util para pegar en un correo).
  const out = [];
  rows.forEach(r => {
    (r.companies || []).forEach((c, i) => {
      out.push({
        'Cédula': `${r.ced_kind || 'V'}-${r.id_number}`,
        'Colaborador': r.full_name || '',
        'Cargo': r.role || '',
        'Empresa': c.company_code || '',
        'Razón social': c.business_name || '',
        'Estado empresa': c.status || '',
        'Ingresó': fmtDate(c.start_date),
        'Cuál es': i === (r.companies.length - 1) ? 'La nueva' : 'La anterior',
        'Zona': c.zone || '',
        'Subzona': c.subzone || '',
      });
    });
  });
  return out;
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function expCsv(rows) {
  const data = flatten(rows);
  if (!data.length) return;
  const cols = Object.keys(data[0]);
  const lines = [cols.join(';')];
  data.forEach(d => lines.push(cols.map(c => String(d[c] ?? '').replace(/;/g, ',')).join(';')));
  download('doble_empleo.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

function expTxt(rows) {
  const data = flatten(rows);
  if (!data.length) return;
  const cols = Object.keys(data[0]);
  const w = cols.map(c => Math.max(c.length, ...data.map(d => String(d[c] ?? '').length)));
  const line = a => a.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ');
  const out = [line(cols), w.map(n => '-'.repeat(n)).join('  ')];
  data.forEach(d => out.push(line(cols.map(c => d[c]))));
  download('doble_empleo.txt', out.join('\r\n'), 'text/plain;charset=utf-8');
}

async function expXlsx(rows) {
  const data = flatten(rows);
  if (!data.length) return;
  if (!window.XLSX) {
    await new Promise((ok, err) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = ok; s.onerror = err;
      document.head.appendChild(s);
    });
  }
  const ws = window.XLSX.utils.json_to_sheet(data);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Doble empleo');
  window.XLSX.writeFile(wb, 'doble_empleo.xlsx');
}

export async function renderDoubleEmployment(user) {
  ensureStyles();

  $('#pnlMain').innerHTML = `
    <div class="de-head">
      <div>
        <h2>Doble empleo</h2>
        <p>Personas que figuran trabajando en dos tiendas al mismo tiempo.</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="deXlsx">Excel</button>
        <button class="btn" id="deCsv">CSV</button>
        <button class="btn" id="deTxt">TXT</button>
      </div>
    </div>
    <div id="deBody"><div class="de-loading">Revisando el personal…</div></div>
  `;

  const r = await api(user, { action: 'list' });
  const body = $('#deBody');
  if (!body) return;   // el usuario navego a otra vista mientras cargaba

  if (!r || !r.ok) {
    body.innerHTML = `<div class="de-card"><div class="de-loading">
      ${esc((r && r.error) || 'No se pudo cargar.')}</div></div>`;
    return;
  }

  const rows = r.rows || [];

  if (!rows.length) {
    body.innerHTML = `
      <div class="de-card">
        <div class="de-empty">
          <div class="big">✅</div>
          <div class="t">Sin casos de doble empleo</div>
          <div class="s">Nadie figura activo en dos tiendas al mismo tiempo.
            Esta pantalla se revisa en cada sincronización de personal.</div>
        </div>
      </div>`;
    return;
  }

  // Tiendas distintas involucradas y desde cuando arrastramos el problema.
  const stores = new Set();
  let oldest = null;
  rows.forEach(x => {
    (x.companies || []).forEach(c => c.company_code && stores.add(c.company_code));
    const d = x.last_start;
    if (d && (!oldest || d < oldest)) oldest = d;
  });
  const dias = daysSince(oldest);

  body.innerHTML = `
    <div class="de-why">
      <span class="ic">⚠️</span>
      <div>
        <b>Una persona no puede estar activa en dos tiendas a la vez.</b>
        Suele pasar cuando la ingresan en la tienda nueva pero nadie cierra su contrato en la
        anterior. Mientras siga así, esa persona cuenta doble en la nómina, en los reportes y en
        los envíos.
        <span style="display:block;margin-top:6px">
          <b>Se corrige en el sistema, no en el portal.</b> Hay que cerrar el contrato en la
          tienda que corresponda. Al hacerlo, el caso desaparece solo de esta lista en la
          próxima sincronización.
        </span>
      </div>
    </div>

    <div class="de-kpis">
      <div class="de-kpi bad">
        <small>Casos detectados</small><b>${rows.length}</b>
        <div class="sub">personas en 2 tiendas</div>
      </div>
      <div class="de-kpi">
        <small>Tiendas involucradas</small><b>${stores.size}</b>
        <div class="sub">${esc([...stores].join(' · '))}</div>
      </div>
      <div class="de-kpi">
        <small>El más antiguo</small><b style="font-size:19px">${fmtDate(oldest)}</b>
        <div class="sub">${dias === null ? '—' : (dias === 0 ? 'hoy' : `hace ${dias} día${dias === 1 ? '' : 's'}`)}</div>
      </div>
    </div>

    <div class="de-filters">
      <input type="text" id="deQ" placeholder="Buscar por cédula o nombre" style="width:230px">
    </div>

    <div class="de-card">
      <table class="de-tbl">
        <thead><tr>
          <th>Colaborador</th>
          <th>Está activo en estas dos tiendas</th>
          <th>Ubicación</th>
        </tr></thead>
        <tbody id="deRows">${rows.map(rowHtml).join('')}</tbody>
      </table>
    </div>
    <p class="de-note" id="deFoot"></p>
  `;

  // Nota al pie: si TODOS salieron de la misma tienda el mismo dia, es un
  // traslado en bloque que quedo a medias. Vale la pena decirlo.
  const foot = $('#deFoot');
  const froms = new Set(rows.map(x => (x.companies || [])[0]?.company_code).filter(Boolean));
  const lasts = new Set(rows.map(x => x.last_start).filter(Boolean));
  if (froms.size === 1 && lasts.size === 1) {
    const from = [...froms][0];
    const proj = rows.some(x => (x.companies || [])[0]?.status === 'Proyectada');
    foot.innerHTML = `
      <b>Las ${rows.length} salieron de ${esc(from)} el mismo día (${fmtDate([...lasts][0])}).</b>
      Parece un traslado en bloque que quedó a medias: entraron en la tienda nueva, pero nadie las
      egresó de la anterior.
      ${proj ? `<span style="display:block;margin-top:4px"><b>Dato llamativo:</b>
        ${esc(from)} figura como <b>Proyectada</b> — una tienda que nunca llegó a abrir.
        No debería tener personal activo.</span>` : ''}`;
  } else {
    foot.textContent = `${rows.length} caso${rows.length === 1 ? '' : 's'}. Se listan para que se corrijan en el sistema; el portal no los modifica.`;
  }

  // Buscador (filtra en cliente: son pocos casos).
  $('#deQ')?.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#deRows tr').forEach(tr => {
      tr.style.display = (!q || (tr.dataset.search || '').includes(q)) ? '' : 'none';
    });
  });

  $('#deXlsx')?.addEventListener('click', () => expXlsx(visibleRows(rows)));
  $('#deCsv')?.addEventListener('click', () => expCsv(visibleRows(rows)));
  $('#deTxt')?.addEventListener('click', () => expTxt(visibleRows(rows)));
}
