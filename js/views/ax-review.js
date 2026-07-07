/* =====================================================================
   js/views/ax-review.js  →  vista "Sincronizar"
   Pagina de REVISION y PUBLICACION de cambios de fichas hacia el ERP.
   Lista los conjuntos de cambios pendientes (del alcance del usuario),
   permite ver por ficha el detalle Previo -> Modificado por campo, y
   PUBLICAR o ANULAR: individual (por ficha), en lote (seleccion multiple)
   o TODO. Toda accion pasa por un modal de confirmacion propio.

   Datos por /api/ax-review (action 'list' | 'publish' | 'discard').
   Export: renderAxReview(user)

   Reglas UI del portal:
   - Sin alert/confirm/prompt nativos: modal propio que cierra solo con sus
     botones (nunca al clic fuera).
   - Filtros encadenados (Tipo -> Empresa; Zona -> Subzona; Concepto), igual
     que Buscar / Datos incompletos. Los combos solo muestran lo presente en
     los pendientes (facetas que devuelve el backend).
   - No se menciona el ERP por nombre en la UI.
   ===================================================================== */

import { $ } from '../core/dom.js';

let USER = null;
let ROWS = [];             // filas pendientes (del backend)
let FACETS = null;         // { types, companies, zones, subzones, concepts }
const SELECTED = new Set();  // ids de change_set seleccionados
const OPEN = new Set();       // ids expandidos
// Criterios de filtro (encadenados).
let C = { type: '', company: '', zone: '', subzone: '', concept: '' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initialsOf(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}
const AVATAR_BG = ['#dbeafe', '#fae8ff', '#dcfce7', '#fef9c3', '#fee2e2', '#e0e7ff', '#ccfbf1', '#ffedd5'];
const AVATAR_FG = ['#1e40af', '#86198f', '#166534', '#854d0e', '#991b1b', '#3730a3', '#0f766e', '#9a3412'];
function avatarColor(seed) {
  const s = String(seed || ''); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % AVATAR_BG.length;
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return String(iso).slice(0, 16).replace('T', ' ');
  const c = new Date(d.getTime() - 4 * 3600 * 1000);  // Caracas GMT-4
  const z = n => String(n).padStart(2, '0');
  return `${z(c.getUTCDate())}/${z(c.getUTCMonth() + 1)}/${c.getUTCFullYear()} ${z(c.getUTCHours())}:${z(c.getUTCMinutes())}`;
}

async function api(payload) {
  return fetch('/api/ax-review', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(x => x.json()).catch(() => null);
}
function sessionUserPayload(user) {
  return { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null };
}

function ensureStyles() {
  if (document.getElementById('axrStyles')) return;
  const st = document.createElement('style');
  st.id = 'axrStyles';
  st.textContent = `
  .axr-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .axr-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .axr-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0 6px}
  .axr-stat{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:15px 17px}
  .axr-stat .k{font-size:12px;color:var(--muted);font-weight:600;display:flex;align-items:center;gap:7px}
  .axr-stat .k svg{width:15px;height:15px}
  .axr-stat .v{font-size:27px;font-weight:700;margin-top:6px;line-height:1}
  .axr-stat.pend .v{color:var(--warn,#c2410c)}
  .axr-stat.flds .v{color:var(--brand,#2563eb)}
  .axr-stat.emps .v{color:var(--ink)}
  @media (max-width:640px){ .axr-stats{grid-template-columns:1fr} }
  .axr-filters{display:flex;gap:8px 10px;align-items:center;flex-wrap:wrap;margin:14px 0 6px}
  .axr-filters .fg{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted)}
  .axr-filters select{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink)}
  .axr-clear{font:inherit;font-size:12.5px;padding:7px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);cursor:pointer}
  .axr-clear:hover{background:var(--bg-soft,#f1f5f9)}
  .axr-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}
  .axr-spacer{flex:1}
  .axr-btn{display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:13.5px;font-weight:600;padding:8px 13px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--ink);cursor:pointer;white-space:nowrap;line-height:1}
  .axr-btn:hover:not(:disabled){background:var(--bg-soft,#f1f5f9)}
  .axr-btn svg{width:15px;height:15px}
  .axr-btn:disabled{opacity:.5;cursor:default}
  .axr-btn-pub{background:var(--warn-bg,#fff7ed);border-color:var(--warn-bd,#fed7aa);color:var(--warn,#c2410c)}
  .axr-btn-pub:hover:not(:disabled){background:#ffedd5}
  .axr-btn-dis{color:var(--danger,#dc2626);border-color:#f3c2c2}
  .axr-btn-dis:hover:not(:disabled){background:var(--danger-bg,#fef2f2)}
  .axr-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--warn,#c2410c);color:#fff;font-size:11px;font-weight:700}
  .axr-selbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 13px;border:1px solid var(--brand,#2563eb);background:var(--brand-bg,#eff6ff);border-radius:11px;margin-bottom:12px}
  .axr-selbar[hidden]{display:none}
  .axr-selbar b{color:var(--brand,#2563eb)}
  .axr-note{color:var(--muted);font-size:12px;margin:0 2px 12px}
  .axr-list{display:flex;flex-direction:column;gap:8px}
  .axr-row{border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);overflow:hidden}
  .axr-row.sel{border-color:var(--brand,#2563eb);box-shadow:0 0 0 1px var(--brand,#2563eb) inset}
  .axr-rowhead{display:flex;align-items:center;gap:13px;padding:12px 14px;cursor:pointer}
  .axr-rowhead:hover{background:var(--bg-soft,#f8fafc)}
  .axr-chk{width:20px;height:20px;border-radius:6px;border:2px solid var(--border);flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;background:var(--surface)}
  .axr-chk.on{background:var(--brand,#2563eb);border-color:var(--brand,#2563eb)}
  .axr-ava{width:40px;height:40px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;overflow:hidden}
  .axr-who{flex:1;min-width:0}
  .axr-nm{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .axr-sub{color:var(--muted);font-size:12px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .axr-edit{font-size:11px;color:var(--muted);margin-top:2px}
  .axr-meta{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex:none;text-align:right}
  .axr-emp{font-size:12px;color:var(--brand,#2563eb);font-weight:700;font-family:ui-monospace,Menlo,monospace}
  .axr-emeta{font-size:10.5px;color:var(--muted);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .axr-nf{font-size:11px;color:var(--warn,#c2410c);background:var(--warn-bg,#fff7ed);border:1px solid var(--warn-bd,#fed7aa);padding:2px 8px;border-radius:999px;font-weight:600}
  .axr-chev{width:18px;height:18px;color:var(--faint,#94a3b8);transition:transform .18s;flex:none}
  .axr-row.open .axr-chev{transform:rotate(180deg)}
  .axr-detail{display:none;padding:4px 16px 16px;border-top:1px solid var(--border-soft,#eef1f5);background:var(--bg-soft,#f8fafc)}
  .axr-row.open .axr-detail{display:block}
  .axr-tbl{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
  .axr-tbl th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700;padding:6px 10px;border-bottom:1px solid var(--border)}
  .axr-tbl td{padding:8px 10px;border-bottom:1px solid var(--border-soft,#eef1f5);vertical-align:top}
  .axr-tbl .fld{font-weight:600;color:var(--ink);width:130px}
  .axr-old{color:var(--muted);text-decoration:line-through;text-decoration-color:#cbd5e1}
  .axr-arr{color:var(--faint,#94a3b8);padding:0 8px}
  .axr-new{color:var(--success,#16a34a);font-weight:600}
  .axr-new.empty,.axr-old.empty{color:var(--faint,#94a3b8);font-style:italic;text-decoration:none}
  .axr-rowfoot{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
  .axr-empty{padding:48px 16px;text-align:center;color:var(--muted)}
  .axr-empty .big{font-size:34px;margin-bottom:8px}
  .axr-loading{padding:40px;text-align:center;color:var(--muted)}
  /* Modal propio (cierra solo con botones) */
  .axr-modal-vp{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px}
  .axr-modal{background:var(--card,#fff);border-radius:16px;max-width:520px;width:100%;padding:22px 24px;box-shadow:0 20px 60px rgba(15,23,42,.3);max-height:85vh;overflow:auto}
  .axr-modal h3{margin:0 0 4px;font-size:18px}
  .axr-modal .who{color:var(--muted);font-size:13px;margin:0 0 14px}
  .axr-modal .box{border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.5}
  .axr-modal .box.pub{background:var(--warn-bg,#fff7ed);border:1px solid var(--warn-bd,#fed7aa);color:var(--warn,#b45309)}
  .axr-modal .box.dis{background:var(--danger-bg,#fef2f2);border:1px solid #f3c2c2;color:var(--danger,#b91c1c)}
  .axr-modal .lst{margin:12px 0 0;max-height:200px;overflow:auto}
  .axr-modal .lst .it{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:4px 0;border-bottom:1px solid var(--border-soft,#eef1f5)}
  .axr-modal .res{margin-top:12px;border-radius:10px;padding:10px 13px;font-size:12.5px;display:none}
  .axr-modal .res.ok{background:var(--success-bg,#f0fdf4);border:1px solid #bbf7d0;color:var(--success,#15803d);display:block}
  .axr-modal .res.err{background:var(--danger-bg,#fef2f2);border:1px solid #f3c2c2;color:var(--danger,#b91c1c);display:block}
  .axr-modal .foot{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
  `;
  document.head.appendChild(st);
}

/* ---------- Combos encadenados ---------- */
function companiesFor(type) {
  const all = (FACETS && FACETS.companies) || [];
  return type ? all.filter(c => c.type === type) : all;
}
function subzonesFor(zoneId) {
  const all = (FACETS && FACETS.subzones) || [];
  return zoneId ? all.filter(s => String(s.zone_id) === String(zoneId)) : all;
}
function fillSelect(sel, items, cur, ph, mapId, mapName) {
  if (!sel) return;
  sel.innerHTML = `<option value="">${ph}</option>`
    + items.map(it => `<option value="${esc(mapId(it))}">${esc(mapName(it))}</option>`).join('');
  const vals = items.map(it => String(mapId(it)));
  sel.value = vals.includes(String(cur)) ? cur : '';
}
function buildFilters() {
  fillSelect($('#axrType'), (FACETS.types || []).map(t => ({ id: t, name: t })), C.type, 'Todos', x => x.id, x => x.name);
  fillSelect($('#axrEmp'), companiesFor(C.type), C.company, 'Todas', x => x.code, x => `${x.code} · ${x.name || ''}`);
  fillSelect($('#axrZone'), (FACETS.zones || []), C.zone, 'Todas', x => x.id, x => x.name);
  fillSelect($('#axrSub'), subzonesFor(C.zone), C.subzone, 'Todas', x => x.id, x => x.name);
  fillSelect($('#axrCon'), (FACETS.concepts || []), C.concept, 'Todos', x => x.id, x => x.name);
}

function visibleRows() {
  return ROWS.filter(r =>
    (!C.type || r.company_type === C.type) &&
    (!C.company || r.company_code === C.company) &&
    (!C.zone || String(r.zone_id) === String(C.zone)) &&
    (!C.subzone || String(r.subzone_id) === String(C.subzone)) &&
    (!C.concept || String(r.concept_id) === String(C.concept))
  );
}

export async function renderAxReview(user) {
  USER = user;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="axr-head"><div>
      <h1>Sincronizar</h1>
      <p>Revisa los cambios de fichas pendientes y decide qué se <b>publica</b> y qué se <b>anula</b>. Al final, usa <b>Actualizar</b> en Personal para revertir lo anulado.</p>
    </div></div>
    <div class="axr-stats">
      <div class="axr-stat pend"><div class="k"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg> Fichas pendientes</div><div class="v" id="axrSPend">—</div></div>
      <div class="axr-stat flds"><div class="k"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg> Campos a publicar</div><div class="v" id="axrSFlds">—</div></div>
      <div class="axr-stat emps"><div class="k"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14"/></svg> Empresas afectadas</div><div class="v" id="axrSEmps">—</div></div>
    </div>
    <div class="axr-filters">
      <span class="fg">Tipo <select id="axrType"><option value="">Todos</option></select></span>
      <span class="fg">Empresa <select id="axrEmp"><option value="">Todas</option></select></span>
      <span class="fg">Zona <select id="axrZone"><option value="">Todas</option></select></span>
      <span class="fg">Subzona <select id="axrSub"><option value="">Todas</option></select></span>
      <span class="fg">Concepto <select id="axrCon"><option value="">Todos</option></select></span>
      <button class="axr-clear" id="axrClear">Limpiar</button>
    </div>
    <div class="axr-toolbar">
      <span class="axr-spacer"></span>
      <button class="axr-btn axr-btn-pub" id="axrPubAll"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg> Publicar todo <span class="axr-count" id="axrPubAllN">0</span></button>
      <button class="axr-btn axr-btn-dis" id="axrDisAll"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg> Anular todo</button>
    </div>
    <div class="axr-selbar" id="axrSelBar" hidden>
      <b id="axrSelN">0</b> <span>seleccionada(s)</span>
      <span class="axr-spacer"></span>
      <button class="axr-btn axr-btn-pub" id="axrPubSel">Publicar seleccionadas</button>
      <button class="axr-btn axr-btn-dis" id="axrDisSel">Anular seleccionadas</button>
      <button class="axr-btn" id="axrSelClear">Quitar selección</button>
    </div>
    <div class="axr-note" id="axrNote"></div>
    <div class="axr-list" id="axrList"><div class="axr-loading">Cargando…</div></div>`;

  // Eventos de filtros.
  $('#axrType').addEventListener('change', e => { C.type = e.target.value; C.company = ''; buildFilters(); SELECTED.clear(); paint(); });
  $('#axrEmp').addEventListener('change', e => { C.company = e.target.value; SELECTED.clear(); paint(); });
  $('#axrZone').addEventListener('change', e => { C.zone = e.target.value; C.subzone = ''; buildFilters(); SELECTED.clear(); paint(); });
  $('#axrSub').addEventListener('change', e => { C.subzone = e.target.value; SELECTED.clear(); paint(); });
  $('#axrCon').addEventListener('change', e => { C.concept = e.target.value; SELECTED.clear(); paint(); });
  $('#axrClear').addEventListener('click', () => { C = { type: '', company: '', zone: '', subzone: '', concept: '' }; buildFilters(); SELECTED.clear(); paint(); });
  $('#axrSelClear').addEventListener('click', () => { SELECTED.clear(); paint(); });
  $('#axrPubSel').addEventListener('click', () => confirmAction('publish', 'sel'));
  $('#axrDisSel').addEventListener('click', () => confirmAction('discard', 'sel'));
  $('#axrPubAll').addEventListener('click', () => confirmAction('publish', 'all'));
  $('#axrDisAll').addEventListener('click', () => confirmAction('discard', 'all'));

  await load();
}

async function load() {
  const r = await api({ action: 'list', user: sessionUserPayload(USER) });
  if (!r || !r.ok) {
    $('#axrList').innerHTML = `<div class="axr-empty">No se pudo cargar${r && r.error ? ': ' + esc(r.error) : ''}.</div>`;
    return;
  }
  ROWS = r.rows || [];
  FACETS = r.facets || { types: [], companies: [], zones: [], subzones: [], concepts: [] };
  SELECTED.clear();
  buildFilters();
  paint();
}

function paint() {
  const rows = visibleRows();
  // Stats sobre lo visible.
  const sP = $('#axrSPend'); if (sP) sP.textContent = rows.length;
  const sF = $('#axrSFlds'); if (sF) sF.textContent = rows.reduce((a, r) => a + (r.field_count || (r.fields || []).length), 0);
  const sE = $('#axrSEmps'); if (sE) sE.textContent = new Set(rows.map(r => r.company_code)).size;

  const note = $('#axrNote');
  if (note) note.textContent = rows.length
    ? `${rows.length} ficha${rows.length === 1 ? '' : 's'} con cambios sin publicar. Toca una fila para ver el detalle.`
    : '';

  const list = $('#axrList');
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = `<div class="axr-empty"><div class="big">✓</div><div>No hay cambios pendientes${(C.type || C.company || C.zone || C.subzone || C.concept) ? ' con estos filtros' : ' en tu alcance'}.</div></div>`;
    updateBars();
    return;
  }

  list.innerHTML = rows.map(r => {
    const isSel = SELECTED.has(r.id), isOpen = OPEN.has(r.id);
    const ci = avatarColor(r.id_number);
    const fields = r.fields || [];
    const chg = fields.map(f => `<tr>
      <td class="fld">${esc(f.label)}</td>
      <td><span class="axr-old ${f.old == null ? 'empty' : ''}">${f.old == null ? '(vacío)' : esc(f.old)}</span></td>
      <td class="axr-arr">→</td>
      <td><span class="axr-new ${f.new == null ? 'empty' : ''}">${f.new == null ? '(vacío)' : esc(f.new)}</span></td>
    </tr>`).join('');
    const emeta = [r.zona, r.subzona, r.concepto].filter(Boolean).map(esc).join(' · ');
    const n = fields.length;
    return `<div class="axr-row ${isSel ? 'sel' : ''} ${isOpen ? 'open' : ''}" data-id="${r.id}">
      <div class="axr-rowhead" data-toggle="${r.id}">
        <div class="axr-chk ${isSel ? 'on' : ''}" data-check="${r.id}">${isSel ? '✓' : ''}</div>
        <div class="axr-ava" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(r.full_name))}</div>
        <div class="axr-who">
          <div class="axr-nm">${esc(r.full_name || '(sin nombre)')}</div>
          <div class="axr-sub">${esc(r.ced_kind || '')}-${esc(r.id_number)} · ${esc(r.company_name || r.company_code)}</div>
          ${r.changed_by ? `<div class="axr-edit">Editado por <b>${esc(r.changed_by)}</b>${r.changed_at ? ' · ' + esc(fmtDateTime(r.changed_at)) : ''}</div>` : ''}
        </div>
        <div class="axr-meta">
          <span class="axr-emp">${esc(r.company_code)}</span>
          ${emeta ? `<span class="axr-emeta">${emeta}</span>` : ''}
          <span class="axr-nf">${n} campo${n === 1 ? '' : 's'}</span>
        </div>
        <svg class="axr-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </div>
      <div class="axr-detail">
        <table class="axr-tbl"><thead><tr><th>Campo</th><th>Previo</th><th></th><th>Modificado</th></tr></thead><tbody>${chg}</tbody></table>
        <div class="axr-rowfoot">
          <button class="axr-btn axr-btn-dis" data-discard="${r.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg> Anular</button>
          <button class="axr-btn axr-btn-pub" data-publish="${r.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg> Publicar</button>
        </div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-toggle]').forEach(el =>
    el.addEventListener('click', ev => {
      if (ev.target.closest('[data-check]')) return;
      const id = +el.dataset.toggle;
      if (OPEN.has(id)) OPEN.delete(id); else OPEN.add(id);
      paint();
    }));
  list.querySelectorAll('[data-check]').forEach(el =>
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      const id = +el.dataset.check;
      if (SELECTED.has(id)) SELECTED.delete(id); else SELECTED.add(id);
      paint();
    }));
  list.querySelectorAll('[data-publish]').forEach(el =>
    el.addEventListener('click', () => confirmAction('publish', 'one', +el.dataset.publish)));
  list.querySelectorAll('[data-discard]').forEach(el =>
    el.addEventListener('click', () => confirmAction('discard', 'one', +el.dataset.discard)));

  updateBars();
}

function updateBars() {
  const n = SELECTED.size, total = visibleRows().length;
  const sb = $('#axrSelBar'); if (sb) sb.hidden = n === 0;
  const sn = $('#axrSelN'); if (sn) sn.textContent = n;
  const pubN = $('#axrPubAllN'); if (pubN) pubN.textContent = total;
  const pa = $('#axrPubAll'); if (pa) pa.disabled = total === 0;
  const da = $('#axrDisAll'); if (da) da.disabled = total === 0;
}

/* Resuelve las filas objetivo segun el modo: 'one' (un id), 'sel'
   (seleccionadas visibles), 'all' (todas las visibles). Devuelve las filas
   completas (para el resumen del modal) y el criterio para el backend. */
function targetsFor(scope, id) {
  const vis = visibleRows();
  if (scope === 'one') return vis.filter(r => r.id === id);
  if (scope === 'sel') return vis.filter(r => SELECTED.has(r.id));
  return vis;   // all
}

/* Modal de confirmacion (siempre). verb: 'publish' | 'discard'. */
function confirmAction(verb, scope, id) {
  const targets = targetsFor(scope, id);
  if (!targets.length) return;
  const isPub = verb === 'publish';
  const ids = targets.map(t => t.id_number);
  const n = targets.length;
  const totalFields = targets.reduce((a, t) => a + (t.field_count || (t.fields || []).length), 0);

  const host = document.body;
  const wrap = document.createElement('div');
  wrap.className = 'axr-modal-vp';
  const listHtml = targets.slice(0, 10).map(t =>
    `<div class="it"><span>${esc(t.full_name || t.id_number)} <span style="color:var(--muted)">${esc(t.ced_kind || '')}-${esc(t.id_number)}</span></span><span style="color:var(--muted)">${(t.field_count || (t.fields || []).length)} campo(s)</span></div>`
  ).join('');
  const more = n > 10 ? `<div style="color:var(--muted);font-size:12px;margin-top:6px">… y ${n - 10} más</div>` : '';

  wrap.innerHTML = `
    <div class="axr-modal">
      <h3>${isPub ? 'Publicar cambios' : 'Anular cambios'}</h3>
      <p class="who">${n} ficha${n === 1 ? '' : 's'} · ${totalFields} campo${totalFields === 1 ? '' : 's'}</p>
      <div class="box ${isPub ? 'pub' : 'dis'}">
        ${isPub
          ? `Se publicarán los cambios de <b>${n} ficha${n === 1 ? '' : 's'}</b>. Solo se envía lo que se editó en cada ficha; el resto de los datos queda intacto.`
          : `Se anularán los cambios de <b>${n} ficha${n === 1 ? '' : 's'}</b>. No se enviarán. El dato en el portal se mantiene hasta que uses <b>Actualizar</b> en Personal, que trae la versión vigente.`}
      </div>
      <div class="lst">${listHtml}${more}</div>
      <div class="res" id="axrRes"></div>
      <div class="foot">
        <button class="axr-btn" id="axrCancel">Cancelar</button>
        <button class="axr-btn ${isPub ? 'axr-btn-pub' : 'axr-btn-dis'}" id="axrGo">${isPub ? 'Publicar' : 'Sí, anular'}</button>
      </div>
    </div>`;
  host.appendChild(wrap);

  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  // No cierra al clic fuera (regla del portal): el vp no cierra.
  wrap.querySelector('#axrCancel').addEventListener('click', close);

  const goB = wrap.querySelector('#axrGo');
  goB.addEventListener('click', async () => {
    goB.disabled = true; goB.textContent = isPub ? 'Publicando…' : 'Anulando…';
    const res = wrap.querySelector('#axrRes');
    res.className = 'res'; res.textContent = '';
    const payload = { action: verb, user: sessionUserPayload(USER) };
    if (scope === 'all') payload.all = true;
    else payload.id_numbers = ids;
    let r;
    try { r = await api(payload); }
    catch (e) { r = { ok: false, error: String(e && e.message || e) }; }

    if (!r || !r.ok) {
      res.className = 'res err';
      res.textContent = '⚠ ' + ((r && r.error) || 'No se pudo completar la acción.');
      goB.disabled = false; goB.textContent = isPub ? 'Reintentar' : 'Reintentar';
      return;
    }
    const done = isPub ? (r.published || []).length : (r.discarded || []).length;
    const rej = (r.rejected_count || 0);
    res.className = 'res ok';
    res.innerHTML = isPub
      ? `✓ <b>${done}</b> ficha(s) publicada(s)${rej ? ` · ${rej} no se pudo enviar` : ''}.`
      : `✓ <b>${done}</b> ficha(s) anulada(s).`;
    goB.textContent = 'Cerrar';
    goB.disabled = false;
    goB.onclick = () => { close(); load(); };   // recargar la lista al cerrar
    // Cancelar pasa a "Cerrar" tambien.
    const cancelBtn = wrap.querySelector('#axrCancel');
    if (cancelBtn) cancelBtn.textContent = 'Cerrar';
  });
}
