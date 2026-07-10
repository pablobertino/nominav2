/* =====================================================================
   js/views/bank-accounts.js  →  DATOS BANCARIOS · Cuentas (v4.82)

   Grilla nominal exportable de la cuenta bancaria del personal VIGENTE.
   Mockup aprobado: _PRUEBAS/bancos_cuentas_mockup.html (v0-mock1).

   - Admin/super: alcance completo con filtros (búsqueda multi-palabra sin
     acentos, banco, con/sin cuenta, tipo, empresa, zona) y columnas
     Empresa/Zona. Tienda/empresa: SOLO su personal; filtros estructurales
     y columnas de empresa ocultos (el server los ignora igual).
   - Banco como chip (prefijo de color + nombre completo, nunca siglas).
   - Cuenta en monoespaciada con botón copiar; filas sin cuenta/inválida
     en ámbar con el motivo (vacía, longitud, banco desconocido).
   - Paginación server-side (50 por página). Exportar (patrón global):
     xlsx/csv/txt de TODO el filtro (pide hasta 10.000 filas al server).

   Datos por /api/bank-accounts (gate view.bankaccounts, sembrado a todos
   los roles; RPC nomina_v2.bank_accounts_list, cuenta efectiva
   master→roster). Export: renderBankAccounts(user)
   ===================================================================== */

import { $ } from '../core/dom.js';
import { attachRefresh } from '../core/refresh.js';

let USER = null;
let F = { q: '', bank: '', has: '', type: '', company: '', zone: '' };
let PAGE = { limit: 50, offset: 0 };
let RAW = { cards: {}, total: 0, banks: [], companies: [], zones: [], rows: [] };
let COMBOS_READY = false;

const TIPOS = ['Tienda', 'Importadora', 'Administrativa', 'Externa', 'Servicio', 'Tienda en línea'];
const BK_COLORS = { '0102': '#c62828', '0134': '#0e9f6e', '0105': '#1e40af', '0191': '#7e22ce', '0108': '#0ea5e9' };
const BK_OTHER = '#64748b';
const WARN = '#b45309';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const nf = n => Number(n || 0).toLocaleString('es-VE');
const pf = (n, t) => t ? (100 * n / t).toLocaleString('es-VE', { maximumFractionDigits: 1 }) + '%' : '0%';
const fmtAcct = a => a ? a.replace(/^(\d{4})(\d{4})(\d{2})(\d{10})$/, '$1-$2-$3-$4') : '';
const isCompany = () => USER && USER.kind === 'company';

async function api(extra) {
  return fetch('/api/bank-accounts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: { kind: USER.kind, id: USER.id || null, companyCode: USER.companyCode || null },
      q: F.q, bank: F.bank, has: F.has, type: F.type, company: F.company, zone: F.zone,
      limit: PAGE.limit, offset: PAGE.offset,
      ...(extra || {}),
    }),
  }).then(x => x.json()).catch(() => null);
}

function ensureStyles() {
  if (document.getElementById('bkacStyles')) return;
  const st = document.createElement('style');
  st.id = 'bkacStyles';
  st.textContent = `
  .bkac-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .bkac-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .bkac-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:14px 0}
  .bkac-k{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;padding:12px 15px}
  .bkac-k .kl{font-size:11.5px;color:var(--muted);font-weight:600}
  .bkac-k .kv{font-size:22px;font-weight:800;margin-top:3px;color:var(--ink)}
  .bkac-k .kv small{font-size:12px;color:var(--muted);font-weight:600;margin-left:5px}
  .bkac-k.warn .kv{color:${WARN}}
  .bkac-bar{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin:0 0 13px}
  .bkac-bar select,.bkac-bar input{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink)}
  .bkac-bar input{min-width:230px}
  .bkac-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;font-weight:600;padding:7px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink);cursor:pointer;white-space:nowrap}
  .bkac-btn:hover:not(:disabled){background:var(--bg-soft,#f1f5f9)}
  .bkac-btn.pri{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:#fff}
  .bkac-expwrap{position:relative;margin-left:auto}
  .bkac-expmenu{position:absolute;right:0;top:calc(100% + 6px);background:var(--card,#fff);border:1px solid var(--border);border-radius:11px;box-shadow:0 10px 34px rgba(15,23,42,.14);min-width:225px;padding:6px;z-index:60;display:none}
  .bkac-expmenu.open{display:block}
  .bkac-expmenu button{display:flex;gap:10px;align-items:center;width:100%;border:0;background:transparent;text-align:left;padding:9px 11px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;color:var(--ink)}
  .bkac-expmenu button:hover{background:var(--bg-soft,#f1f5f9)}
  .bkac-expmenu small{color:var(--muted);display:block;font-size:11px}
  .bkac-expico{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;flex:none}
  .bkac-box{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;overflow:hidden}
  .bkac-tblwrap{overflow:auto}
  .bkac-tbl{border-collapse:collapse;width:100%;font-size:13px}
  .bkac-tbl th{background:var(--bg-soft,#fbfcfe);color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;padding:10px 13px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}
  .bkac-tbl td{padding:10px 13px;border-bottom:1px solid var(--border-soft,#f1f4f8);vertical-align:middle;color:var(--ink)}
  .bkac-tbl tbody tr:last-child td{border-bottom:0}
  .bkac-tbl tbody tr:hover{background:var(--bg-soft,#fafcff)}
  .bkac-ced{font-variant-numeric:tabular-nums;color:var(--ink-soft,#475569);white-space:nowrap}
  .bkac-nm b{display:block;font-weight:650}
  .bkac-nm small{color:var(--muted);font-size:11.5px}
  .bkac-emp small{display:block;color:var(--muted);font-size:11px}
  .bkac-bank{display:inline-flex;align-items:center;gap:8px;white-space:nowrap}
  .bkac-pref{min-width:36px;height:21px;padding:0 6px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;font-family:ui-monospace,monospace;flex:none}
  .bkac-acct{font-family:ui-monospace,'Cascadia Mono',Consolas,monospace;font-size:12.5px;letter-spacing:.03em;white-space:nowrap}
  .bkac-copy{border:0;background:transparent;cursor:pointer;color:var(--muted);padding:3px;border-radius:6px;vertical-align:-3px;margin-left:6px;font:inherit}
  .bkac-copy:hover{background:var(--bg-soft,#f1f5f9);color:var(--accent,#2563eb)}
  .bkac-noacct{display:inline-flex;align-items:center;gap:6px;background:var(--warn-bg,#fffbeb);border:1px solid #fde68a;color:#92400e;font-size:11.5px;font-weight:700;border-radius:999px;padding:3px 10px;white-space:nowrap}
  .bkac-foot{display:flex;align-items:center;gap:12px;padding:10px 15px;background:var(--bg-soft,#fbfcfe);border-top:1px solid var(--border);font-size:12.5px;color:var(--muted)}
  .bkac-foot .sp{flex:1}
  .bkac-pg{border:1px solid var(--border);background:var(--surface,#fff);border-radius:8px;padding:5px 11px;font:inherit;font-size:12.5px;cursor:pointer;color:var(--ink-soft,#475569)}
  .bkac-pg:disabled{opacity:.4;cursor:default}
  .bkac-empty{padding:26px 12px;text-align:center;color:var(--muted);font-size:13px}
  .bkac-legend{font-size:11.5px;color:var(--muted);margin-top:11px;line-height:1.6}`;
  document.head.appendChild(st);
}

/* ---------- export (patrón global: xlsx / csv ; / txt alineado) ---------- */
function exportCols() {
  const admin = !isCompany();
  const cols = [
    ['Cedula', r => r.id_number],
    ['Nombre', r => r.full_name],
    ['Cargo', r => r.role || ''],
  ];
  if (admin) cols.push(
    ['Empresa', r => r.company_name || ''],
    ['Codigo', r => r.company_code],
    ['Tipo', r => r.type || ''],
    ['Zona', r => r.zone || ''],
  );
  cols.push(
    ['Banco', r => r.bank || ''],
    ['Prefijo', r => r.pref || ''],
    ['NumeroCuenta', r => r.acct || ''],
    ['Motivo', r => r.reason || ''],
  );
  return cols;
}
async function fetchAllForExport() {
  const r = await api({ limit: 10000, offset: 0 });
  return (r && r.ok) ? (r.rows || []) : null;
}
function dl(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
}
async function expXlsx(rows) {
  if (!window.XLSX) {
    await new Promise((ok, bad) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = ok; s.onerror = bad; document.head.appendChild(s);
    });
  }
  const cols = exportCols();
  const data = [cols.map(c => c[0]), ...rows.map(r => cols.map(c => c[1](r)))];
  const ws = window.XLSX.utils.aoa_to_sheet(data);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Cuentas');
  window.XLSX.writeFile(wb, 'cuentas_bancarias.xlsx');
}
function expCsv(rows) {
  const cols = exportCols();
  const line = a => a.map(v => {
    const s = String(v == null ? '' : v);
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';');
  const txt = [line(cols.map(c => c[0])), ...rows.map(r => line(cols.map(c => c[1](r))))].join('\r\n');
  dl(new Blob(['\ufeff' + txt], { type: 'text/csv;charset=utf-8' }), 'cuentas_bancarias.csv');
}
function expTxt(rows) {
  const cols = exportCols();
  const grid = [cols.map(c => c[0]), ...rows.map(r => cols.map(c => String(c[1](r) == null ? '' : c[1](r))))];
  const w = cols.map((_, i) => Math.max(...grid.map(g => g[i].length)));
  const txt = grid.map(g => g.map((v, i) => v.padEnd(w[i] + 2)).join('').trimEnd()).join('\r\n');
  dl(new Blob(['\ufeff' + txt], { type: 'text/plain;charset=utf-8' }), 'cuentas_bancarias.txt');
}
async function runExport(kind, btn) {
  const old = btn.textContent; btn.textContent = 'Generando…'; btn.disabled = true;
  try {
    const rows = await fetchAllForExport();
    if (!rows) return;
    if (kind === 'xlsx') await expXlsx(rows);
    else if (kind === 'csv') expCsv(rows);
    else expTxt(rows);
  } finally { btn.textContent = old; btn.disabled = false; }
}

/* ---------- pintura ---------- */
function paintCards() {
  const c = RAW.cards || {};
  $('#bkacKTot').textContent = nf(c.tot);
  $('#bkacKCon').innerHTML = `${nf(c.con)} <small>${pf(c.con, c.tot)}</small>`;
  $('#bkacKSin').innerHTML = `${nf(c.sin)} <small>${pf(c.sin, c.tot)}</small>`;
  const kb = $('#bkacKBk'); if (kb) kb.textContent = nf(c.banks);
  $('#bkacSub').innerHTML = `Cuenta bancaria del personal <b>vigente</b>${isCompany() ? '' : ' de tu alcance'} · <b>${nf(c.tot)}</b> colaboradores`;
}
function paintRows() {
  const admin = !isCompany();
  const rows = RAW.rows || [];
  const tb = $('#bkacTb');
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="9"><div class="bkac-empty">Sin resultados con estos filtros.</div></td></tr>`;
  } else {
    tb.innerHTML = rows.map(r => {
      const color = r.pref ? (BK_COLORS[r.pref] || BK_OTHER) : null;
      const bankCell = r.pref
        ? `<span class="bkac-bank"><span class="bkac-pref" style="background:${color}">${esc(r.pref)}</span>${esc(r.bank || '')}</span>`
        : `<span class="bkac-noacct">⚠ ${esc(r.reason || 'Sin cuenta')}</span>`;
      const acctCell = r.acct
        ? `<span class="bkac-acct">${esc(fmtAcct(r.acct))}</span><button class="bkac-copy" title="Copiar cuenta" data-acct="${esc(r.acct)}">⧉</button>`
        : '<span style="color:var(--muted)">—</span>';
      return `<tr>
        <td class="bkac-ced">${esc(r.id_number)}</td>
        <td class="bkac-nm"><b>${esc(r.full_name || '(sin nombre)')}</b><small>${esc(r.role || '')}</small></td>
        ${admin ? `<td class="bkac-emp">${esc(r.company_name || r.company_code)}<small>${esc(r.company_code)} · ${esc(r.type || '')}</small></td>` : ''}
        <td>${bankCell}</td>
        <td>${acctCell}</td>
        ${admin ? `<td style="color:var(--muted)">${esc(r.zone || '')}</td>` : ''}
      </tr>`;
    }).join('');
  }
  const from = RAW.total ? PAGE.offset + 1 : 0;
  const to = Math.min(PAGE.offset + PAGE.limit, RAW.total);
  const pages = Math.max(1, Math.ceil(RAW.total / PAGE.limit));
  const cur = Math.floor(PAGE.offset / PAGE.limit) + 1;
  $('#bkacFt').textContent = `Mostrando ${nf(from)}–${nf(to)} de ${nf(RAW.total)}`;
  $('#bkacPgInfo').innerHTML = `Página <b>${nf(cur)}</b> de <b>${nf(pages)}</b>`;
  $('#bkacPrev').disabled = PAGE.offset <= 0;
  $('#bkacNext').disabled = PAGE.offset + PAGE.limit >= RAW.total;
}
function paintCombos() {
  if (COMBOS_READY) return;
  const bk = $('#bkacFBank');
  bk.innerHTML = '<option value="">Banco: Todos</option>'
    + (RAW.banks || []).map(b => `<option value="${esc(b.code)}">${esc(b.code)} · ${esc(b.name)}</option>`).join('');
  if (!isCompany()) {
    $('#bkacFComp').innerHTML = '<option value="">Empresa: Todas</option>'
      + (RAW.companies || []).map(c => `<option value="${esc(c.code)}">${esc(c.name || c.code)}</option>`).join('');
    $('#bkacFZone').innerHTML = '<option value="">Zona: Todas</option>'
      + (RAW.zones || []).map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('');
  }
  COMBOS_READY = true;
}

async function load() {
  $('#bkacTb').innerHTML = `<tr><td colspan="9"><div class="bkac-empty">Cargando…</div></td></tr>`;
  const r = await api({});
  if (!r || !r.ok) {
    $('#bkacTb').innerHTML = `<tr><td colspan="9"><div class="bkac-empty">No se pudo cargar${r && r.error ? ': ' + esc(r.error) : ''}.</div></td></tr>`;
    return;
  }
  RAW = r;
  paintCards(); paintCombos(); paintRows();
}
function resetAndLoad() { PAGE.offset = 0; load(); }

export async function renderBankAccounts(user) {
  USER = user;
  ensureStyles();
  F = { q: '', bank: '', has: '', type: '', company: '', zone: '' };
  PAGE = { limit: 50, offset: 0 };
  COMBOS_READY = false;
  const admin = !isCompany();

  $('#pnlMain').innerHTML = `
    <div class="bkac-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px"><div>
      <h1>Datos bancarios · Cuentas</h1>
      <p id="bkacSub">Cargando…</p>
    </div><span id="bkacRefresh"></span></div>

    <div class="bkac-cards">
      <div class="bkac-k"><div class="kl">👥 Colaboradores</div><div class="kv" id="bkacKTot">—</div></div>
      <div class="bkac-k"><div class="kl">💳 Con cuenta</div><div class="kv" id="bkacKCon">—</div></div>
      <div class="bkac-k warn"><div class="kl">⚠ Sin cuenta o inválida</div><div class="kv" id="bkacKSin">—</div></div>
      ${admin ? '<div class="bkac-k"><div class="kl">🏦 Bancos distintos</div><div class="kv" id="bkacKBk">—</div></div>' : ''}
    </div>

    <div class="bkac-bar">
      <input id="bkacFQ" placeholder="Cédula, nombre o n° de cuenta…">
      <select id="bkacFBank"><option value="">Banco: Todos</option></select>
      <select id="bkacFHas">
        <option value="">Cuenta: Todas</option>
        <option value="si">Con cuenta</option>
        <option value="no">Sin cuenta / inválida</option>
      </select>
      ${admin ? `
      <select id="bkacFType"><option value="">Tipo: Todos</option>${TIPOS.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>
      <select id="bkacFComp"><option value="">Empresa: Todas</option></select>
      <select id="bkacFZone"><option value="">Zona: Todas</option></select>` : ''}
      <button class="bkac-btn" id="bkacClear">Limpiar</button>
      <div class="bkac-expwrap">
        <button class="bkac-btn pri" id="bkacExpBtn">Exportar ▾</button>
        <div class="bkac-expmenu" id="bkacExpM">
          <button data-exp="xlsx"><span class="bkac-expico" style="background:#16a34a">XLS</span><span>Excel (.xlsx)<small>Todo lo filtrado</small></span></button>
          <button data-exp="csv"><span class="bkac-expico" style="background:#2563eb">CSV</span><span>CSV (;)<small>Separador ; con BOM UTF-8</small></span></button>
          <button data-exp="txt"><span class="bkac-expico" style="background:#64748b">TXT</span><span>Texto alineado<small>Columnas de ancho fijo</small></span></button>
        </div>
      </div>
    </div>

    <div class="bkac-box">
      <div class="bkac-tblwrap"><table class="bkac-tbl">
        <thead><tr>
          <th>Cédula</th><th>Colaborador</th>${admin ? '<th>Empresa</th>' : ''}
          <th>Banco</th><th>N° de cuenta</th>${admin ? '<th>Zona</th>' : ''}
        </tr></thead>
        <tbody id="bkacTb"></tbody>
      </table></div>
      <div class="bkac-foot">
        <span id="bkacFt">—</span>
        <span class="sp"></span>
        <button class="bkac-pg" id="bkacPrev" disabled>‹ Anterior</button>
        <span id="bkacPgInfo"></span>
        <button class="bkac-pg" id="bkacNext" disabled>Siguiente ›</button>
      </div>
    </div>

    <p class="bkac-legend"><b>Fuente:</b> cuenta efectiva del colaborador (la editada en su ficha; si no tiene, la del roster de su empresa) — el mismo criterio de Estadísticas. El banco se deriva de los 4 primeros dígitos contra el catálogo. <b>Exportar</b> respeta los filtros y saca todo el resultado, no solo la página visible.</p>`;

  /* eventos */
  let qTimer = null;
  $('#bkacFQ').addEventListener('input', e => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { F.q = e.target.value.trim(); resetAndLoad(); }, 350);
  });
  $('#bkacFBank').addEventListener('change', e => { F.bank = e.target.value; resetAndLoad(); });
  $('#bkacFHas').addEventListener('change', e => { F.has = e.target.value; resetAndLoad(); });
  if (admin) {
    $('#bkacFType').addEventListener('change', e => { F.type = e.target.value; resetAndLoad(); });
    $('#bkacFComp').addEventListener('change', e => { F.company = e.target.value; resetAndLoad(); });
    $('#bkacFZone').addEventListener('change', e => { F.zone = e.target.value; resetAndLoad(); });
  }
  $('#bkacClear').addEventListener('click', () => {
    F = { q: '', bank: '', has: '', type: '', company: '', zone: '' };
    $('#bkacFQ').value = ''; $('#bkacFBank').value = ''; $('#bkacFHas').value = '';
    if (admin) { $('#bkacFType').value = ''; $('#bkacFComp').value = ''; $('#bkacFZone').value = ''; }
    resetAndLoad();
  });
  $('#bkacPrev').addEventListener('click', () => { PAGE.offset = Math.max(0, PAGE.offset - PAGE.limit); load(); });
  $('#bkacNext').addEventListener('click', () => { PAGE.offset += PAGE.limit; load(); });
  $('#bkacExpBtn').addEventListener('click', () => $('#bkacExpM').classList.toggle('open'));
  $('#bkacExpM').addEventListener('click', e => {
    const b = e.target.closest('button[data-exp]');
    if (!b) return;
    $('#bkacExpM').classList.remove('open');
    runExport(b.dataset.exp, $('#bkacExpBtn'));
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.bkac-expwrap')) { const m = $('#bkacExpM'); if (m) m.classList.remove('open'); }
  });
  $('#pnlMain').addEventListener('click', e => {
    const c = e.target.closest('.bkac-copy');
    if (c && c.dataset.acct) {
      navigator.clipboard.writeText(c.dataset.acct).then(() => {
        c.textContent = '✓'; setTimeout(() => { c.textContent = '⧉'; }, 900);
      }).catch(() => {});
    }
  });

  await load();
  attachRefresh('#bkacRefresh', () => load(), 'bankaccounts');
}
