/* =====================================================================
   views/egresados.js — Egresados (v6.135)

   Pantalla de CONSULTA de personas que ya no están activas (fuente:
   ax_egresos, último egreso de cada quien). Pensada para detectar reempleo:
   en los análisis de No reempleables los egresados salieron como la fuente
   natural de recontratación. Solo búsqueda y ficha por ahora — no marca ni
   reingresa nada. Los NO REEMPLEABLES aparecen marcados con un chip rojo.

   Alcance: el listado respeta el alcance del usuario (lo aplica el
   endpoint). Gate: view.egresados (Coordinador y Administrador). Al hacer
   clic se abre la MISMA ficha del no reempleable/egresado (reutilizada de
   no-rehire.js), con "← Volver" de regreso a esta pantalla.
   ===================================================================== */
import { $ } from '../core/dom.js';
import { renderNoRehireFicha } from './no-rehire.js';
import { openWorkerLightbox } from './worker-photos.js';

const PAGE = 50;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const nf = n => Number(n || 0).toLocaleString('es');

const fmtDate = d => {
  if (!d) return '—';
  const [y, m, dd] = String(d).slice(0, 10).split('-');
  return (y && m && dd) ? `${dd}/${m}/${y}` : '—';
};

/* "hace X" a partir de una fecha (para el tiempo egresado). */
function relSince(d) {
  if (!d) return '';
  const t = Date.parse(String(d).slice(0, 10) + 'T00:00:00');
  if (!Number.isFinite(t)) return '';
  let days = Math.max(0, Math.floor((Date.now() - t) / 86400000));
  if (days < 31) return `hace ${days} día${days === 1 ? '' : 's'}`;
  const y = Math.floor(days / 365), mo = Math.floor((days % 365) / 30);
  const parts = [];
  if (y) parts.push(`${y} año${y === 1 ? '' : 's'}`);
  if (mo) parts.push(`${mo} mes${mo === 1 ? '' : 'es'}`);
  return 'hace ' + (parts.join(' y ') || `${days} días`);
}

function initials(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

const cedStr = r => `${Number(r.id_number) >= 80000000 ? 'E' : 'V'}-${r.id_number || ''}`;

async function api(user, payload) {
  const res = await fetch('/api/egresados', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, user }),
  });
  return res.json();
}

let STYLED = false;
function ensureStyles() {
  if (STYLED) return;
  STYLED = true;
  const css = document.createElement('style');
  css.textContent = `
  .eg-head h2{margin:0;font-size:20px;font-weight:700}
  .eg-head p{margin:3px 0 0;color:var(--muted);font-size:13px;max-width:760px}
  .eg-filters{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:15px 0 0}
  .eg-filters input[type=text]{font:inherit;font-size:13px;padding:8px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink);width:280px;max-width:100%}
  .eg-sel{font:inherit;font-size:12.5px;padding:8px 11px;border:1px solid var(--border);border-radius:9px;background:#fff;color:var(--soft)}
  .eg-btn{font:inherit;font-size:13px;font-weight:600;padding:8px 18px;border:1px solid var(--accent,#2563eb);border-radius:9px;background:var(--accent,#2563eb);color:#fff;cursor:pointer}
  .eg-btn:hover{filter:brightness(.95)}
  .eg-empty b{color:var(--ink)}
  .eg-count{font-size:12.5px;color:var(--muted)}
  .eg-card{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;margin-top:13px;overflow:hidden}
  .eg-tbl{width:100%;border-collapse:collapse;font-size:13px}
  .eg-tbl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:800;padding:10px 14px;background:#fbfcfe;border-bottom:1px solid var(--border);white-space:nowrap}
  .eg-tbl td{padding:11px 14px;border-bottom:1px solid var(--border-soft,#eef1f5);vertical-align:middle}
  .eg-tbl tbody tr:last-child td{border-bottom:none}
  .eg-tbl tbody tr{cursor:pointer}
  .eg-tbl tbody tr:hover{background:var(--bg-soft,#f8fafc)}
  .eg-who{display:flex;align-items:center;gap:10px;min-width:0}
  .eg-ava{width:38px;height:38px;border-radius:50%;flex:none;object-fit:cover;border:1px solid var(--border);cursor:zoom-in}
  .eg-ava-ini{width:38px;height:38px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;background:#eef2f7;color:#64748b;font-weight:800;font-size:13px;border:1px solid var(--border)}
  .eg-nm{font-weight:700}
  .eg-ced{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
  .eg-role{font-size:11px;color:var(--muted);margin-top:1px}
  .eg-sub{font-size:11.5px;color:var(--muted);margin-top:1px}
  .eg-pill{display:inline-block;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700;white-space:nowrap}
  .eg-pill.nr{background:#fef2f2;color:#b91c1c;border:1px solid #fca5a5}
  .eg-daychip{font-size:11px;color:var(--muted)}
  .eg-empty{padding:48px 20px;text-align:center;color:var(--muted);font-size:13px}
  .eg-loading{padding:44px;text-align:center;color:var(--muted);font-size:13px}
  .eg-foot{display:flex;align-items:center;gap:12px;padding:11px 14px;border-top:1px solid var(--border);background:#fbfcfe;font-size:12.5px;color:var(--muted)}
  .eg-foot .sp{flex:1}
  .eg-pg{font:inherit;font-size:12.5px;min-width:32px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface,#fff);color:var(--ink);cursor:pointer}
  .eg-pg:hover:not(:disabled):not(.cur){background:var(--bg-soft,#f1f5f9)}
  .eg-pg:disabled{opacity:.45;cursor:default}
  .eg-pg.cur{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:#fff;font-weight:700;cursor:default}
  .eg-pager{display:inline-flex;gap:4px;align-items:center;flex-wrap:wrap}
  .eg-gap{color:var(--muted);padding:0 2px}
  .eg-jump{font-size:12.5px;color:var(--muted);display:inline-flex;gap:6px;align-items:center;margin-left:12px}
  .eg-jump input{font:inherit;font-size:12.5px;width:58px;padding:5px 7px;border:1px solid var(--border);border-radius:7px;background:var(--surface,#fff);color:var(--ink)}
  @media(max-width:760px){
    .eg-tbl thead{display:none}
    .eg-tbl td{display:block;border:none;padding:4px 14px}
    .eg-tbl tbody tr{display:block;border-bottom:1px solid var(--border)!important;padding:11px 0}
  }`;
  document.head.appendChild(css);
}

/* Tiempo de egresado: días desde el último egreso [min, max). */
const TIMES = [
  { v: '', lbl: 'Cualquier tiempo', min: null, max: null },
  { v: '0-30', lbl: 'Menos de 1 mes', min: 0, max: 30 },
  { v: '30-90', lbl: '1 a 3 meses', min: 30, max: 90 },
  { v: '90-180', lbl: '3 a 6 meses', min: 90, max: 180 },
  { v: '180-365', lbl: '6 a 12 meses', min: 180, max: 365 },
  { v: '365-', lbl: 'Más de 1 año', min: 365, max: null },
  { v: 'custom', lbl: 'Personalizado…', min: null, max: null },
];

const SORTS = [
  { v: 'egreso_desc', lbl: 'Egreso más reciente' },
  { v: 'egreso_asc', lbl: 'Egreso más antiguo' },
  { v: 'nombre', lbl: 'Nombre (A–Z)' },
  { v: 'contratos_desc', lbl: 'Más contratos' },
  { v: 'dias_desc', lbl: 'Más días trabajados' },
];

const STATE = { q: '', time: '', minDays: null, maxDays: null, custVal: 6, custUnit: 'm', sort: 'egreso_desc', offset: 0, total: 0, rows: [], queried: false };

function rowHtml(r) {
  const ced = cedStr(r);
  const ava = r.thumb_url
    ? `<img class="eg-ava" data-zoom="1" title="Ampliar foto" src="${esc(r.thumb_url)}" alt="" loading="lazy"
         onerror="this.outerHTML='&lt;span class=&quot;eg-ava-ini&quot;&gt;${esc(initials(r.full_name))}&lt;/span&gt;'">`
    : `<span class="eg-ava-ini">${esc(initials(r.full_name))}</span>`;
  const loc = r.zona ? `${esc(r.zona)}${r.subzona ? ' · ' + esc(r.subzona) : ''}` : 'Sin zona';
  return `
    <tr data-ced="${esc(String(r.id_number))}">
      <td>
        <div class="eg-who">${ava}
          <div style="min-width:0">
            <div class="eg-nm">${esc(r.full_name || 'Sin nombre')}${r.is_no_rehire ? ' <span class="eg-pill nr">No reempleable</span>' : ''}</div>
            <div class="eg-ced">${esc(ced)}</div>
            ${r.role ? `<div class="eg-role">${esc(r.role)}</div>` : ''}
          </div>
        </div>
      </td>
      <td>${esc(r.last_company || '—')}${r.last_company_code ? `<div class="eg-sub">${esc(r.last_company_code)}</div>` : ''}</td>
      <td>${loc}</td>
      <td style="white-space:nowrap">${fmtDate(r.last_egreso)}<div class="eg-daychip">${esc(relSince(r.last_egreso))}</div></td>
      <td style="text-align:center">${r.contratos || 0}</td>
    </tr>`;
}

function paint(user) {
  const body = $('#egBody');
  if (!body) return;
  if (!STATE.rows.length) {
    body.innerHTML = `<div class="eg-card"><div class="eg-empty">${STATE.q ? 'Sin egresados que coincidan con la búsqueda.' : 'No hay egresados en tu alcance.'}</div></div>`;
    return;
  }
  const from = STATE.offset + 1;
  const to = STATE.offset + STATE.rows.length;
  const pages = Math.max(1, Math.ceil(STATE.total / PAGE));
  const cur = Math.min(pages, Math.floor(STATE.offset / PAGE) + 1);
  body.innerHTML = `
    <div class="eg-card">
      <table class="eg-tbl">
        <thead><tr>
          <th>Colaborador</th><th>Última empresa</th><th>Zona / subzona</th><th>Egresó</th><th style="text-align:center">Contratos</th>
        </tr></thead>
        <tbody id="egRows">${STATE.rows.map(rowHtml).join('')}</tbody>
      </table>
      <div class="eg-foot">
        <span>${from}–${to} de ${nf(STATE.total)}</span>
        <span class="sp"></span>
        ${pagerHtml(cur, pages)}
        ${pages > 1 ? `<span class="eg-jump">Ir a <input type="number" id="egJump" min="1" max="${pages}" value="${cur}"> / ${pages}</span>` : ''}
      </div>
    </div>`;

  const byCed = new Map(STATE.rows.map(r => [String(r.id_number), r]));
  $('#egRows')?.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-ced]');
    if (!tr) return;
    const r = byCed.get(tr.dataset.ced);
    if (!r) return;
    if (e.target.closest('[data-zoom]') && r.thumb_url) {
      e.stopPropagation();
      openWorkerLightbox(r.thumb_url, `${r.full_name || ''} · ${cedStr(r)}`, `${r.id_number}.jpg`);
      return;
    }
    renderNoRehireFicha(user, r.id_number, () => renderEgresados(user, { restore: true }));
  });
  const goPage = pg => {
    const p = Math.min(pages, Math.max(1, pg || 1));
    STATE.offset = (p - 1) * PAGE;
    load(user);
  };
  body.querySelector('.eg-pager')?.addEventListener('click', e => {
    const b = e.target.closest('button[data-pg]');
    if (b && !b.disabled) goPage(parseInt(b.dataset.pg, 10));
  });
  const jump = $('#egJump');
  jump?.addEventListener('keydown', e => { if (e.key === 'Enter') goPage(parseInt(jump.value, 10)); });
  jump?.addEventListener('change', () => goPage(parseInt(jump.value, 10)));
}

/* Pager con números y saltos: ‹ 1 … c-1 c c+1 … últ › */
function pagerHtml(cur, pages) {
  if (pages <= 1) return '';
  const items = [];
  items.push(`<button class="eg-pg" data-pg="${cur - 1}" ${cur <= 1 ? 'disabled' : ''}>‹</button>`);
  const want = new Set([1, 2, cur - 1, cur, cur + 1, pages - 1, pages]);
  const list = [...want].filter(p => p >= 1 && p <= pages).sort((a, b) => a - b);
  let prev = 0;
  list.forEach(p => {
    if (prev && p - prev > 1) items.push('<span class="eg-gap">…</span>');
    items.push(`<button class="eg-pg${p === cur ? ' cur' : ''}" data-pg="${p}">${p}</button>`);
    prev = p;
  });
  items.push(`<button class="eg-pg" data-pg="${cur + 1}" ${cur >= pages ? 'disabled' : ''}>›</button>`);
  return `<div class="eg-pager">${items.join('')}</div>`;
}

async function load(user) {
  STATE.queried = true;
  const body = $('#egBody');
  if (body) body.innerHTML = '<div class="eg-loading">Consultando egresados…</div>';
  const r = await api(user, {
    action: 'list', q: STATE.q, min_days: STATE.minDays, max_days: STATE.maxDays,
    sort: STATE.sort, offset: STATE.offset, limit: PAGE,
  });
  if (!$('#egBody')) return;   // navegó a otra vista
  const cnt = $('#egCount');
  if (!r || !r.ok) {
    $('#egBody').innerHTML = `<div class="eg-card"><div class="eg-empty">${esc((r && r.error) || 'No se pudo cargar.')}</div></div>`;
    if (cnt) cnt.textContent = '';
    return;
  }
  STATE.total = r.total || 0;
  STATE.rows = r.rows || [];
  if (cnt) cnt.textContent = `${STATE.total} egresado${STATE.total === 1 ? '' : 's'} en tu alcance`;
  paint(user);
}

export async function renderEgresados(user, opts) {
  ensureStyles();
  const restore = !!(opts && opts.restore && STATE.queried);
  $('#pnlMain').innerHTML = `
    <div class="eg-head">
      <h2>Egresados</h2>
      <p>Personas que ya no están activas, por si sirven para reempleo. Solo consulta: buscá y abrí su ficha con la historia laboral completa. Los <b>no reempleables</b> salen marcados. Respeta tu alcance.</p>
    </div>
    <div class="eg-filters">
      <input type="text" id="egQ" placeholder="Buscar por cédula o nombre" value="${esc(STATE.q)}">
      <select class="eg-sel" id="egTime">${TIMES.map(o => `<option value="${o.v}" ${o.v === STATE.time ? 'selected' : ''}>Tiempo de egresado: ${esc(o.lbl)}</option>`).join('')}</select>
      <span id="egCustom" style="display:${STATE.time === 'custom' ? 'inline-flex' : 'none'};gap:6px;align-items:center">
        <span style="font-size:12.5px;color:var(--muted)">Últimos</span>
        <input type="number" id="egCustVal" min="1" max="999" value="${STATE.custVal || 6}" style="width:66px;font:inherit;font-size:12.5px;padding:8px 9px;border:1px solid var(--border);border-radius:9px;background:#fff;color:var(--ink)">
        <select class="eg-sel" id="egCustUnit" style="min-width:auto">
          <option value="d" ${STATE.custUnit === 'd' ? 'selected' : ''}>días</option>
          <option value="m" ${(STATE.custUnit || 'm') === 'm' ? 'selected' : ''}>meses</option>
          <option value="y" ${STATE.custUnit === 'y' ? 'selected' : ''}>años</option>
        </select>
      </span>
      <button class="eg-btn" id="egGo">Consultar</button>
      <select class="eg-sel" id="egSort">${SORTS.map(o => `<option value="${o.v}" ${o.v === STATE.sort ? 'selected' : ''}>Ordenar: ${esc(o.lbl)}</option>`).join('')}</select>
      <span class="eg-count" id="egCount"></span>
    </div>
    <div id="egBody">${restore
      ? '<div class="eg-loading">Consultando egresados…</div>'
      : `<div class="eg-card"><div class="eg-empty">Elegí el <b>tiempo de egresado</b> o escribí una búsqueda y tocá <b>Consultar</b>.<br>
          <span style="font-size:12px">Son muchos egresados, por eso no se cargan todos de una: filtrá y consultá.</span></div></div>`}</div>`;

  const run = () => {
    STATE.q = ($('#egQ')?.value || '').trim();
    const tv = $('#egTime')?.value || '';
    STATE.time = tv;
    if (tv === 'custom') {
      const n = Math.max(1, parseInt($('#egCustVal')?.value, 10) || 1);
      const u = $('#egCustUnit')?.value || 'm';
      STATE.custVal = n; STATE.custUnit = u;
      const mult = u === 'd' ? 1 : (u === 'y' ? 365 : 30);
      STATE.minDays = 0; STATE.maxDays = n * mult;   // egresados de los últimos N (hacia atrás)
    } else {
      const sel = TIMES.find(o => o.v === tv) || TIMES[0];
      STATE.minDays = sel.min; STATE.maxDays = sel.max;
    }
    STATE.offset = 0;
    load(user);
  };
  const toggleCustom = () => {
    const on = ($('#egTime')?.value === 'custom');
    const el = $('#egCustom'); if (el) el.style.display = on ? 'inline-flex' : 'none';
    return on;
  };
  $('#egGo')?.addEventListener('click', run);
  $('#egQ')?.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  $('#egCustVal')?.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  $('#egCustUnit')?.addEventListener('change', run);
  // Al pasar a "Personalizado" se muestran los campos y se espera Consultar; los presets corren al instante.
  $('#egTime')?.addEventListener('change', () => { const on = toggleCustom(); if (!on) run(); });
  // Cambiar el orden re-consulta desde la página 1 (solo si ya se consultó).
  $('#egSort')?.addEventListener('change', e => { STATE.sort = e.target.value; STATE.offset = 0; if (STATE.queried) load(user); });

  if (restore) await load(user);
}
