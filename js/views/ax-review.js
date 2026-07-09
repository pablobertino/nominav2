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
import { renderSyncLog } from './sync-log.js';
import { attachRefresh } from '../core/refresh.js';
import { renderWorkerPhotos, openWorkerLightbox } from './worker-photos.js';

/* Tipos de empresa que NO son tienda (mismo criterio que Buscar): definen
   el modo de la vista Personal al saltar a la ficha. */
const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);

let USER = null;
let ROWS = [];             // filas pendientes (del backend)
let FACETS = null;         // { types, companies, zones, subzones, concepts }
const SELECTED = new Set();  // ids de change_set seleccionados
const OPEN = new Set();       // ids expandidos
// Criterios de filtro (encadenados).
let C = { type: '', company: '', zone: '', subzone: '', concept: '' };
// Estado del flujo de comparacion.
let CMP_ROWS = [];        // diferencias detectadas (del dry-run)
let CMP_SCOPE = null;      // filtro usado en la comparacion (para re-detectar por empresa)
let CMP_FACETS = null;     // catalogo completo para los combos del modal Comparar
let CMP_FILTER = { type: '', company: '', zone: '', subzone: '', concept: '' };
let CMP_PARTIAL = [];      // empresas con respuesta parcial del sistema (aviso)

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
  .axr-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}
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
  .axr-ava.haspic{cursor:zoom-in;background:#eef2f7}
  .axr-ava img{width:100%;height:100%;object-fit:cover;display:block}
  .axr-rowacts{display:flex;gap:6px;flex:none;align-items:center}
  .axr-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink-soft,#475569);cursor:pointer;padding:0}
  .axr-iconbtn:hover{background:var(--bg-soft,#f1f5f9)}
  .axr-iconbtn svg{width:15px;height:15px}
  .axr-iconbtn.ok{color:var(--success,#16a34a);border-color:#bbf7d0;background:var(--success-bg,#f0fdf4)}
  .axr-who{flex:0 1 auto;min-width:0;max-width:46%}
  .axr-flex{flex:1}
  .axr-nm{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .axr-sub{color:var(--muted);font-size:12px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .axr-edit{font-size:11px;color:var(--muted);margin-top:2px}
  .axr-meta{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex:none;text-align:right}
  .axr-emp{font-size:12px;color:var(--brand,#2563eb);font-weight:700;font-family:ui-monospace,Menlo,monospace}
  .axr-emeta{font-size:10.5px;color:var(--muted);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .axr-nf{font-size:11px;color:var(--warn,#c2410c);background:var(--warn-bg,#fff7ed);border:1px solid var(--warn-bd,#fed7aa);padding:2px 8px;border-radius:999px;font-weight:600}
  .axr-bank{font-size:11px;color:#b91c1c;background:#fef2f2;border:1px solid #f3c2c2;padding:2px 8px;border-radius:999px;font-weight:700;white-space:nowrap}
  .axr-row.bank{border-color:#f3c2c2}
  .axr-row.bank.sel{border-color:var(--brand,#2563eb)}
  .axr-tbl tr.bankrow td{background:#fef2f2}
  .axr-tbl tr.bankrow .fld{color:#b91c1c}
  .axr-btn-bank{background:#fef2f2;border-color:#f3c2c2;color:#b91c1c}
  .axr-btn-bank:hover:not(:disabled){background:#fee2e2}
  .axr-count.bankn{background:#b91c1c}
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
  /* Boton Comparar */
  .axr-btn-cmp{background:var(--brand-bg,#eff6ff);border-color:#bfdbfe;color:var(--brand,#2563eb)}
  .axr-btn-cmp:hover:not(:disabled){background:#dbeafe}
  .axr-btn-adopt{background:#f5f3ff;border-color:#ddd6fe;color:#6d28d9}
  .axr-btn-adopt:hover:not(:disabled){background:#ede9fe}
  /* Panel de comparacion (modal grande) */
  .axr-cmp{background:var(--card,#fff);border-radius:16px;max-width:860px;width:100%;box-shadow:0 20px 60px rgba(15,23,42,.3);max-height:88vh;display:flex;flex-direction:column;overflow:hidden}
  .axr-cmp-head{padding:18px 22px 12px;border-bottom:1px solid var(--border)}
  .axr-cmp-head h3{margin:0;font-size:18px}
  .axr-cmp-head p{margin:3px 0 0;color:var(--muted);font-size:12.5px}
  .axr-cmp-body{padding:14px 22px;overflow:auto;flex:1}
  .axr-cmp-foot{padding:12px 22px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .axr-cmp-lot{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .axr-drow{border:1px solid var(--border);border-radius:12px;margin-bottom:8px;overflow:hidden}
  .axr-drow.done{opacity:.55}
  .axr-dhead{display:flex;align-items:center;gap:12px;padding:11px 14px;background:var(--bg-soft,#f8fafc)}
  .axr-dhead .nm{font-weight:600;font-size:13.5px}
  .axr-dhead .sub{color:var(--muted);font-size:11.5px}
  .axr-dtag{margin-left:auto;font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px}
  .axr-dtag.pend{background:var(--warn-bg,#fff7ed);color:var(--warn,#c2410c);border:1px solid var(--warn-bd,#fed7aa)}
  .axr-dtag.ok{background:var(--success-bg,#f0fdf4);color:var(--success,#15803d);border:1px solid #bbf7d0}
  .axr-dtbl{width:100%;border-collapse:collapse;font-size:12.5px}
  .axr-dtbl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700;padding:7px 14px;background:#fff;border-bottom:1px solid var(--border)}
  .axr-dtbl td{padding:7px 14px;border-bottom:1px solid var(--border-soft,#eef1f5);vertical-align:top}
  .axr-dtbl .fld{font-weight:600;width:120px}
  .axr-vsys{color:#6d28d9;font-weight:600}
  .axr-vpor{color:var(--brand,#2563eb);font-weight:600}
  .axr-dacts{display:flex;gap:8px;justify-content:flex-end;padding:10px 14px;background:var(--bg-soft,#f8fafc)}
  /* Historial (v4.44) */
  .axr-hctrl{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px}
  .axr-hctrl .fg{display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:600;color:var(--muted)}
  .axr-hctrl input,.axr-hctrl select{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink)}
  .axr-hctrl input:focus,.axr-hctrl select:focus{outline:none;border-color:var(--brand,#2563eb)}
  .axr-hrow{border:1px solid var(--border);border-radius:12px;margin-bottom:8px;padding:11px 14px;display:flex;gap:12px;align-items:flex-start}
  .axr-hava{width:36px;height:36px;border-radius:9px;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;overflow:hidden}
  .axr-hava img{width:100%;height:100%;object-fit:cover;display:block}
  .axr-hmain{flex:1;min-width:0}
  .axr-hnm{font-weight:600;font-size:13.5px}
  .axr-hsub{color:var(--muted);font-size:11.5px;margin-top:1px}
  .axr-hflds{font-size:12px;color:var(--ink-soft,#475569);margin-top:5px;line-height:1.5}
  .axr-hflds .fl{white-space:nowrap}
  .axr-hwho{font-size:11px;color:var(--muted);margin-top:4px}
  .axr-hside{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none}
  .axr-hst{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px}
  .axr-hst.pending{background:var(--warn-bg,#fff7ed);color:var(--warn,#c2410c);border:1px solid var(--warn-bd,#fed7aa)}
  .axr-hst.published{background:var(--success-bg,#f0fdf4);color:var(--success,#15803d);border:1px solid #bbf7d0}
  .axr-hst.discarded{background:var(--danger-bg,#fef2f2);color:var(--danger,#b91c1c);border:1px solid #f3c2c2}
  .axr-hor{font-size:10.5px;color:var(--muted);background:var(--bg-soft,#f8fafc);border:1px solid var(--border);border-radius:999px;padding:2px 8px}
  .axr-hpager{display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:6px;font-size:12.5px;color:var(--muted)}
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

/* La ficha incluye un cambio de CUENTA BANCARIA (dato sensible: se resalta
   en rojo y se publica por separado del resto). */
function rowHasBank(r) {
  return (r.fields || []).some(f =>
    f.field === 'account_number' || f.label === 'Cuenta' || f.label === 'Cuenta bancaria');
}
function isBankField(f) {
  return f.field === 'account_number' || f.label === 'Cuenta' || f.label === 'Cuenta bancaria';
}

/* ---------- Acciones por fila: ficha / copiar (v4.39) ---------- */
/* Salta a la vista Personal con la ficha de esta persona abierta (mismo
   patron que Buscar). Al salir de Personal, vuelve a Sincronizar. */
function gotoFicha(r) {
  if (!r) return;
  const mode = NON_STORE_TYPES.has(r.company_type) ? 'enterprise' : 'store';
  renderWorkerPhotos(USER, r.company_code, () => renderAxReview(USER), { mode, openCed: r.id_number });
}

/* Texto ordenado del cambio pendiente para el portapapeles. */
function rowCopyText(r) {
  const L = [];
  L.push(r.full_name || '(sin nombre)');
  L.push(`C.I.: ${(r.ced_kind || 'V')}-${r.id_number}`);
  L.push(`Empresa: ${[r.company_code, r.company_name].filter(Boolean).join(' · ')}`);
  const ubi = [r.zona, r.subzona, r.concepto].filter(Boolean).join(' · ');
  if (ubi) L.push(ubi);
  const fields = r.fields || [];
  L.push(`Cambios pendientes (${fields.length}):`);
  fields.forEach(f => L.push(`- ${f.label}: ${f.old == null ? '(vacio)' : f.old} → ${f.new == null ? '(vacio)' : f.new}`));
  if (r.changed_by || r.changed_at) {
    L.push(`Editado${r.changed_by ? ` por ${r.changed_by}` : ''}${r.changed_at ? ` · ${fmtDateTime(r.changed_at)}` : ''}`);
  }
  L.push(`Ficha: ${String(r.id_number).replace(/[^0-9]/g, '')}`);
  return L.join('\n');
}

/* Copia al portapapeles con fallback (execCommand) y feedback en el boton. */
async function copyToClipboard(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      ok = document.execCommand('copy'); ta.remove();
    } catch (__) { ok = false; }
  }
  if (btn && ok) {
    const prev = btn.innerHTML;
    btn.classList.add('ok');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    setTimeout(() => { btn.classList.remove('ok'); btn.innerHTML = prev; }, 1200);
  }
  return ok;
}

export async function renderAxReview(user) {
  USER = user;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="axr-head"><div>
      <h1>Sincronizar</h1>
      <p>Revisa los cambios de fichas pendientes y decide qué se <b>publica</b> y qué se <b>anula</b>. Al final, usa <b>Actualizar</b> en Personal para revertir lo anulado.</p>
    </div><span id="axrRefresh"></span></div>
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
      <button class="axr-btn" data-synclog="syncreview" title="Registro de sincronizaciones (corridas programadas)">Registro</button>
        <button class="axr-btn axr-btn-pub" id="axrPubSafe"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg> Publicar sin cuenta <span class="axr-count" id="axrPubSafeN">0</span></button>
      <button class="axr-btn axr-btn-bank" id="axrPubBank"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg> Publicar con cuenta <span class="axr-count bankn" id="axrPubBankN">0</span></button>
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
  $('#axrPubSafe').addEventListener('click', () => confirmAction('publish', 'nobank'));
  $('#axrPubBank').addEventListener('click', () => confirmAction('publish', 'bank'));
  $('#axrDisAll').addEventListener('click', () => confirmAction('discard', 'all'));

  await load();
  attachRefresh('#axrRefresh', load, 'sincronizar');
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
    const bank = rowHasBank(r);
    const ci = avatarColor(r.id_number);
    const fields = r.fields || [];
    const chg = fields.map(f => `<tr${isBankField(f) ? ' class="bankrow"' : ''}>
      <td class="fld">${esc(f.label)}${isBankField(f) ? ' ⚠' : ''}</td>
      <td><span class="axr-old ${f.old == null ? 'empty' : ''}">${f.old == null ? '(vacío)' : esc(f.old)}</span></td>
      <td class="axr-arr">→</td>
      <td><span class="axr-new ${f.new == null ? 'empty' : ''}">${f.new == null ? '(vacío)' : esc(f.new)}</span></td>
    </tr>`).join('');
    const emeta = [r.zona, r.subzona, r.concepto].filter(Boolean).map(esc).join(' · ');
    const n = fields.length;
    return `<div class="axr-row ${bank ? 'bank ' : ''}${isSel ? 'sel' : ''} ${isOpen ? 'open' : ''}" data-id="${r.id}">
      <div class="axr-rowhead" data-toggle="${r.id}">
        <div class="axr-chk ${isSel ? 'on' : ''}" data-check="${r.id}">${isSel ? '✓' : ''}</div>
        ${r.thumb_url
          ? `<div class="axr-ava haspic" data-pic="${r.id}" title="Ver foto"><img src="${esc(r.thumb_url)}" alt="" loading="lazy" onerror="this.remove()"></div>`
          : `<div class="axr-ava" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(r.full_name))}</div>`}
        <div class="axr-who">
          <div class="axr-nm">${esc(r.full_name || '(sin nombre)')}</div>
          <div class="axr-sub">${esc(r.ced_kind || '')}-${esc(r.id_number)} · ${esc(r.company_name || r.company_code)}</div>
          ${(r.changed_by || r.changed_at) ? `<div class="axr-edit">Editado${r.changed_by ? ` por <b>${esc(r.changed_by)}</b>` : ''}${r.changed_at ? ' · ' + esc(fmtDateTime(r.changed_at)) : ''}</div>` : ''}
        </div>
        <div class="axr-rowacts">
          <button type="button" class="axr-iconbtn" data-goficha="${r.id}" title="Ver ficha"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M15 8h4M15 12h4M5.5 18c.7-1.8 2.1-2.8 3.5-2.8s2.8 1 3.5 2.8"/></svg></button>
          <button type="button" class="axr-iconbtn" data-copy="${r.id}" title="Copiar datos"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        </div>
        <span class="axr-flex"></span>
        <div class="axr-meta">
          <span class="axr-emp">${esc(r.company_code)}</span>
          ${emeta ? `<span class="axr-emeta">${emeta}</span>` : ''}
          ${bank ? '<span class="axr-bank">⚠ Cuenta bancaria</span>' : ''}
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
      if (ev.target.closest('[data-check],[data-pic],[data-goficha],[data-copy]')) return;
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
  // v4.39: foto (lightbox), ir a la ficha y copiar datos.
  list.querySelectorAll('[data-pic]').forEach(el =>
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      const r = ROWS.find(x => x.id === +el.dataset.pic);
      if (!r || !r.thumb_url) return;
      openWorkerLightbox(r.thumb_url, `${r.full_name || ''} · C.I. ${r.id_number}`, `${r.id_number}.jpg`);
    }));
  list.querySelectorAll('[data-goficha]').forEach(el =>
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      gotoFicha(ROWS.find(x => x.id === +el.dataset.goficha));
    }));
  list.querySelectorAll('[data-copy]').forEach(el =>
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      const r = ROWS.find(x => x.id === +el.dataset.copy);
      if (r) copyToClipboard(rowCopyText(r), el);
    }));

  updateBars();
}

function updateBars() {
  const n = SELECTED.size, vis = visibleRows();
  const nBank = vis.filter(rowHasBank).length;
  const nSafe = vis.length - nBank;
  const sb = $('#axrSelBar'); if (sb) sb.hidden = n === 0;
  const sn = $('#axrSelN'); if (sn) sn.textContent = n;
  const sfN = $('#axrPubSafeN'); if (sfN) sfN.textContent = nSafe;
  const bkN = $('#axrPubBankN'); if (bkN) bkN.textContent = nBank;
  const ps = $('#axrPubSafe'); if (ps) ps.disabled = nSafe === 0;
  const pb = $('#axrPubBank'); if (pb) pb.disabled = nBank === 0;
  const da = $('#axrDisAll'); if (da) da.disabled = vis.length === 0;
}

/* Resuelve las filas objetivo segun el modo: 'one' (un id), 'sel'
   (seleccionadas visibles), 'all' (todas las visibles). Devuelve las filas
   completas (para el resumen del modal) y el criterio para el backend. */
function targetsFor(scope, id) {
  const vis = visibleRows();
  if (scope === 'one') return vis.filter(r => r.id === id);
  if (scope === 'sel') return vis.filter(r => SELECTED.has(r.id));
  if (scope === 'nobank') return vis.filter(r => !rowHasBank(r));
  if (scope === 'bank') return vis.filter(r => rowHasBank(r));
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
  const banky = isPub && targets.some(rowHasBank);

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
          ? `Se publicarán los cambios de <b>${n} ficha${n === 1 ? '' : 's'}</b>. Solo se envía lo que se editó en cada ficha; el resto de los datos queda intacto.${banky ? '<br><br><b>⚠ Incluye cambio de CUENTA BANCARIA.</b> Verifica los números de cuenta en el detalle antes de publicar: este dato afecta el pago.' : ''}`
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
  let finished = false;   // v4.53: tras el exito, el boton pasa a ser SOLO Cerrar
  goB.addEventListener('click', async () => {
    if (finished) { close(); return; }
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
    if (done > 0) {
      res.className = 'res ok';
      res.innerHTML = isPub
        ? `✓ <b>${done}</b> ficha(s) publicada(s)${rej ? ` · ${rej} no se pudo enviar` : ''}.`
        : `✓ <b>${done}</b> ficha(s) anulada(s).`;
    } else {
      // Nada que hacer (ej. la fila ya estaba resuelta y la lista de la
      // pantalla estaba desactualizada): mensaje claro, no un check enganoso.
      res.className = 'res err';
      res.textContent = 'ℹ ' + ((r.message || `Nada para ${isPub ? 'publicar' : 'anular'}: los cambios ya estaban resueltos.`)) + ' La lista se actualizó.';
    }
    // v4.53 FIX: la lista se recarga DE INMEDIATO (antes solo recargaba el
    // boton principal al cerrar; el boton Cancelar renombrado a "Cerrar"
    // cerraba SIN recargar y la ficha publicada quedaba pintada como
    // fantasma, invitando a re-publicar "0"). Ademas queda UN solo Cerrar
    // y el listener original ya no re-dispara la accion (flag finished).
    finished = true;
    goB.textContent = 'Cerrar';
    goB.disabled = false;
    const cancelBtn = wrap.querySelector('#axrCancel');
    if (cancelBtn) cancelBtn.style.display = 'none';
    load();
  });
}

/* ===================== FLUJO COMPARAR (portal vs sistema) =====================
   Comparar detecta diferencias reales (ambos lados con valor distinto) entre
   el portal y el sistema, y permite resolver cada una: Publicar (portal ->
   sistema) o Adoptar (sistema -> portal). Todo en su propio panel; la lista
   principal de Sincronizar no se toca hasta resolver. */

/* Paso 1: modal con combos propios (Tipo, Empresa, Zona->Subzona, Concepto).
   Carga el catalogo COMPLETO del alcance del actor via detect_scope (no solo
   las empresas con pendientes). Al confirmar, dispara la comparacion por
   empresa en bucle con progreso. */
/* Paso 1 (v4.46: pagina propia en el menu). Combos de alcance (Tipo,
   Empresa, Zona->Subzona, Concepto) con el catalogo COMPLETO del actor via
   detect_scope. Al confirmar, dispara la comparacion por empresa en bucle
   con progreso (panel modal existente). */
function slRegBtn(view) {
  // v4.63: acceso al Registro de sincronizaciones desde las vistas del grupo
  // (con Volver a la vista de origen). El permiso hcm.log decide adentro.
  return `<button class="btn" data-synclog="${view}" title="Registro de sincronizaciones (corridas programadas)">Registro</button>`;
}
// v4.63: delegacion global (una sola vez): cualquier boton [data-synclog]
// de estas vistas abre el Registro con Volver a la vista de origen.
if (!window.__slRegNav) {
  window.__slRegNav = true;
  document.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest && ev.target.closest('[data-synclog]');
    if (b && USER) renderSyncLog(USER, undefined, b.dataset.synclog);
  });
}

export async function renderAxCompare(user) {
  USER = user;
  ensureStyles();
  CMP_FILTER = { type: '', company: '', zone: '', subzone: '', concept: '' };
  $('#pnlMain').innerHTML = `
    <div class="axr-head"><div>
      <h1>Comparar</h1>
      <p>Compara el portal contra el sistema, empresa por empresa, y resuelve cada diferencia: <b>Publicar</b> (portal → sistema) o <b>Adoptar</b> (sistema → portal).</p>
    </div><div class="head-actions">${slRegBtn('axcompare')}</div></div>
    <div style="margin:16px 0 14px;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.5;background:var(--brand-bg,#eff6ff);border:1px solid #bfdbfe;color:#1e40af">
      Solo se listan diferencias reales: un valor en el portal y otro distinto en el sistema. Los datos que faltan de un lado no aparecen (esos se resuelven con <b>Actualizar</b> en Personal).
    </div>
    <div id="cmpScopeBody"><div class="axr-loading">Cargando empresas…</div></div>
    <div class="axr-toolbar" style="margin-top:14px">
      <span class="axr-spacer"></span>
      <button class="axr-btn axr-btn-cmp" id="cmpStart" disabled>Comparar</button>
    </div>`;

  // Catalogo completo del alcance (facetas) via detect_scope sin filtro.
  let sc;
  try { sc = await api({ action: 'detect_scope', user: sessionUserPayload(USER), filter: {} }); }
  catch (e) { sc = { ok: false, error: String(e && e.message || e) }; }
  const scopeBody = $('#cmpScopeBody');
  if (!sc || !sc.ok) {
    scopeBody.innerHTML = `<div class="axr-empty">No se pudo cargar el catálogo${sc && sc.error ? ': ' + esc(sc.error) : ''}.</div>`;
    return;
  }
  CMP_FACETS = sc.facets || emptyFacetsCli();

  scopeBody.innerHTML = `
    <div class="axr-filters" style="margin:0">
      <span class="fg">Tipo <select id="cmpType"></select></span>
      <span class="fg">Empresa <select id="cmpEmp"></select></span>
      <span class="fg">Zona <select id="cmpZone"></select></span>
      <span class="fg">Subzona <select id="cmpSub"></select></span>
      <span class="fg">Concepto <select id="cmpCon"></select></span>
      <button class="axr-clear" id="cmpFClear">Limpiar</button>
    </div>
    <div id="cmpScopeCount" style="margin-top:10px;font-size:12.5px;color:var(--muted)"></div>`;

  const startBtn = $('#cmpStart');
  const countEl = $('#cmpScopeCount');

  const cmpCompaniesFor = (type) => (CMP_FACETS.companies || []).filter(c => !type || c.type === type);
  const cmpSubsFor = (zoneId) => (CMP_FACETS.subzones || []).filter(s => !zoneId || String(s.zone_id) === String(zoneId));
  const buildCmp = () => {
    fillSelect($('#cmpType'), (CMP_FACETS.types || []).map(t => ({ id: t, name: t })), CMP_FILTER.type, 'Todos', x => x.id, x => x.name);
    fillSelect($('#cmpEmp'), cmpCompaniesFor(CMP_FILTER.type), CMP_FILTER.company, 'Todas', x => x.code, x => `${x.code} · ${x.name || ''}`);
    fillSelect($('#cmpZone'), (CMP_FACETS.zones || []), CMP_FILTER.zone, 'Todas', x => x.id, x => x.name);
    fillSelect($('#cmpSub'), cmpSubsFor(CMP_FILTER.zone), CMP_FILTER.subzone, 'Todas', x => x.id, x => x.name);
    fillSelect($('#cmpCon'), (CMP_FACETS.concepts || []), CMP_FILTER.concept, 'Todos', x => x.id, x => x.name);
  };
  const codesForFilter = () => (CMP_FACETS.companies || []).filter(c =>
    (!CMP_FILTER.type || c.type === CMP_FILTER.type) &&
    (!CMP_FILTER.company || c.code === CMP_FILTER.company) &&
    (!CMP_FILTER.zone || String(c.zone_id) === String(CMP_FILTER.zone)) &&
    (!CMP_FILTER.subzone || String(c.subzone_id) === String(CMP_FILTER.subzone)) &&
    (!CMP_FILTER.concept || String(c.concept_id) === String(CMP_FILTER.concept))
  ).map(c => c.code);
  const refreshCount = () => {
    const codes = codesForFilter();
    countEl.textContent = codes.length
      ? `${codes.length} empresa${codes.length === 1 ? '' : 's'} en el alcance. Se compararan una por una.`
      : 'Ninguna empresa en el alcance.';
    startBtn.disabled = codes.length === 0;
    startBtn.textContent = codes.length ? `Comparar (${codes.length})` : 'Comparar';
  };

  buildCmp(); refreshCount();
  $('#cmpType').addEventListener('change', e => { CMP_FILTER.type = e.target.value; CMP_FILTER.company = ''; buildCmp(); refreshCount(); });
  $('#cmpEmp').addEventListener('change', e => { CMP_FILTER.company = e.target.value; refreshCount(); });
  $('#cmpZone').addEventListener('change', e => { CMP_FILTER.zone = e.target.value; CMP_FILTER.subzone = ''; buildCmp(); refreshCount(); });
  $('#cmpSub').addEventListener('change', e => { CMP_FILTER.subzone = e.target.value; refreshCount(); });
  $('#cmpCon').addEventListener('change', e => { CMP_FILTER.concept = e.target.value; refreshCount(); });
  $('#cmpFClear').addEventListener('click', () => { CMP_FILTER = { type: '', company: '', zone: '', subzone: '', concept: '' }; buildCmp(); refreshCount(); });

  startBtn.addEventListener('click', () => {
    const codes = codesForFilter();
    if (!codes.length) return;
    runCompare({ ...CMP_FILTER }, codes);
  });
}

function emptyFacetsCli() {
  return { types: [], companies: [], zones: [], subzones: [], concepts: [] };
}

/* Paso 2: comparar EMPRESA POR EMPRESA en bucle con progreso, acumulando
   diferencias. Cada empresa = 1 llamada 'detect' con company_code (liviana,
   ~4 subrequests, nunca revienta el limite de Cloudflare). */
async function runCompare(filter, codes) {
  CMP_SCOPE = filter;         // se guarda para re-detectar por empresa al resolver
  CMP_ROWS = [];
  CMP_PARTIAL = [];
  const total = codes.length;

  const wrap = document.createElement('div');
  wrap.className = 'axr-modal-vp';
  wrap.id = 'axrCmpPanel';
  wrap.innerHTML = `
    <div class="axr-cmp">
      <div class="axr-cmp-head">
        <h3>Comparación con el sistema</h3>
        <p id="cmpSub">Comparando 0 de ${total}…</p>
      </div>
      <div class="axr-cmp-body" id="cmpBody">
        <div class="axr-loading">
          <div style="margin-bottom:12px">Comparando empresa por empresa…</div>
          <div style="height:8px;border-radius:999px;background:var(--border-soft,#eef1f5);overflow:hidden;max-width:360px;margin:0 auto">
            <div id="cmpBar" style="height:100%;width:0;background:var(--brand,#2563eb);transition:width .2s"></div>
          </div>
        </div>
      </div>
      <div class="axr-cmp-foot">
        <span id="cmpFootInfo" style="color:var(--muted);font-size:12.5px"></span>
        <span class="axr-spacer"></span>
        <button class="axr-btn" id="cmpClose">Cerrar</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  let cancelled = false;
  // Al cerrar: si estamos sobre la bandeja de Sincronizar, recargarla; si
  // venimos de la pagina Comparar (v4.46), no hay bandeja que recargar.
  const close = () => {
    cancelled = true; document.removeEventListener('keydown', onKey); wrap.remove();
    if ($('#axrList')) load();
  };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('#cmpClose').addEventListener('click', close);

  const sub = wrap.querySelector('#cmpSub');
  const bar = wrap.querySelector('#cmpBar');
  const footInfo = wrap.querySelector('#cmpFootInfo');

  let scanned = 0, okCount = 0;
  const failed = [];
  const partial = [];

  // Bucle secuencial: una empresa por llamada.
  for (let i = 0; i < codes.length; i++) {
    if (cancelled) return;
    const cc = codes[i];
    if (sub) sub.textContent = `Comparando ${i + 1} de ${total}… (${cc})`;
    if (bar) bar.style.width = `${Math.round(((i) / total) * 100)}%`;

    let r;
    try { r = await api({ action: 'detect', user: sessionUserPayload(USER), company_code: cc }); }
    catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    if (cancelled) return;

    if (!r || !r.ok) { failed.push(cc); continue; }
    scanned += (r.scanned || 0);
    okCount += (r.companies_ok || 0);
    (r.companies_failed || []).forEach(f => failed.push(f));
    (r.companies_partial || []).forEach(p => partial.push(p));
    // Acumular diferencias de esta empresa.
    (r.rows || []).forEach(row => CMP_ROWS.push(row));
    // Repintar incremental (para ver avanzar los resultados).
    if (CMP_ROWS.length) paintCompare();
  }

  if (cancelled) return;
  if (bar) bar.style.width = '100%';
  CMP_PARTIAL = partial;
  if (sub) sub.textContent = `${scanned} ficha(s) revisada(s) · ${CMP_ROWS.length} con diferencias`
    + (failed.length ? ` · ${failed.length} empresa(s) sin respuesta` : '')
    + (partial.length ? ` · ${partial.length} con datos incompletos` : '');
  // Aviso de cobertura: si el sistema respondio parcial en alguna empresa, el
  // resultado NO es confiable (puede ocultar diferencias). Se avisa claramente.
  const notes = [];
  if (partial.length) {
    const ej = partial.slice(0, 4).map(p => `${p.company_code} (${p.matched}/${p.roster})`).join(', ');
    notes.push(`⚠ El sistema respondió incompleto en ${partial.length} empresa(s): ${ej}${partial.length > 4 ? '…' : ''}. Vuelve a comparar esas empresas más tarde; el resultado puede estar ocultando diferencias.`);
  }
  if (failed.length) {
    notes.push(`Sin respuesta: ${failed.slice(0, 6).join(', ')}${failed.length > 6 ? '…' : ''}.`);
  }
  if (footInfo) footInfo.innerHTML = notes.length
    ? `<span style="color:var(--warn,#c2410c)">${esc(notes.join(' '))}</span>` : '';
  paintCompare();
}

/* Pinta la lista de diferencias dentro del panel. Cada ficha con sus campos
   (Sistema vs Portal) y dos acciones: Publicar / Adoptar. */
function paintCompare() {
  const body = $('#cmpBody');
  if (!body) return;
  if (!CMP_ROWS.length) {
    // Si el sistema respondio incompleto en alguna empresa, NO mostramos el
    // "todo bien" tranquilizador: avisamos que el resultado no es confiable.
    if (CMP_PARTIAL && CMP_PARTIAL.length) {
      const ej = CMP_PARTIAL.slice(0, 6).map(p => `${p.company_code} (${p.matched}/${p.roster})`).join(', ');
      body.innerHTML = `<div class="axr-empty">
        <div class="big" style="color:var(--warn,#c2410c)">⚠</div>
        <div><b>No se pudo comparar completo.</b></div>
        <div style="margin-top:6px;max-width:520px;margin-left:auto;margin-right:auto">El sistema respondió con datos incompletos en ${CMP_PARTIAL.length} empresa(s): ${esc(ej)}${CMP_PARTIAL.length > 6 ? '…' : ''}. No se encontraron diferencias en lo que sí respondió, pero podrían estar ocultándose. Vuelve a comparar esas empresas más tarde.</div>
      </div>`;
      return;
    }
    body.innerHTML = `<div class="axr-empty"><div class="big">✓</div><div>No hay diferencias entre el portal y el sistema.</div></div>`;
    return;
  }
  // Barra de lote arriba.
  const pend = CMP_ROWS.filter(r => !r._done);
  const lot = pend.length > 1
    ? `<div class="axr-cmp-lot">
         <button class="axr-btn axr-btn-pub" id="cmpPubAll">Publicar todas (${pend.length})</button>
         <button class="axr-btn axr-btn-adopt" id="cmpAdoptAll">Adoptar todas (${pend.length})</button>
       </div>` : '';

  body.innerHTML = lot + CMP_ROWS.map((r, i) => {
    const tag = r._done
      ? `<span class="axr-dtag ok">${r._done === 'publish' ? 'Publicado' : 'Adoptado'}</span>`
      : `<span class="axr-dtag pend">${r.field_count} dif.</span>`;
    const trs = (r.fields || []).map(f => `<tr>
      <td class="fld">${esc(f.label)}</td>
      <td><span class="axr-vsys">${f.erp == null ? '(vacío)' : esc(f.erp)}</span></td>
      <td><span class="axr-vpor">${f.portal == null ? '(vacío)' : esc(f.portal)}</span></td>
    </tr>`).join('');
    const acts = r._done ? '' : `<div class="axr-dacts">
        <button class="axr-btn axr-btn-adopt" data-adopt="${i}">Adoptar (sistema)</button>
        <button class="axr-btn axr-btn-pub" data-pub="${i}">Publicar (portal)</button>
      </div>`;
    return `<div class="axr-drow ${r._done ? 'done' : ''}">
      <div class="axr-dhead">
        <div><div class="nm">${esc(r.full_name || '(sin nombre)')}</div>
          <div class="sub">${esc(r.ced_kind || '')}-${esc(r.id_number)} · ${esc(r.company_code)}</div></div>
        ${tag}
      </div>
      <table class="axr-dtbl"><thead><tr><th>Campo</th><th>Sistema</th><th>Portal</th></tr></thead><tbody>${trs}</tbody></table>
      ${acts}
    </div>`;
  }).join('');

  body.querySelectorAll('[data-pub]').forEach(el =>
    el.addEventListener('click', () => confirmCompare('publish', [CMP_ROWS[+el.dataset.pub]])));
  body.querySelectorAll('[data-adopt]').forEach(el =>
    el.addEventListener('click', () => confirmCompare('adopt', [CMP_ROWS[+el.dataset.adopt]])));
  const pa = $('#cmpPubAll'); if (pa) pa.addEventListener('click', () => confirmCompare('publish', pend));
  const aa = $('#cmpAdoptAll'); if (aa) aa.addEventListener('click', () => confirmCompare('adopt', pend));
}

/* Confirmacion de una accion de comparacion (publish/adopt) sobre 1..N filas.
   verb: 'publish' (portal->sistema) | 'adopt' (sistema->portal). */
function confirmCompare(verb, rows) {
  rows = (rows || []).filter(r => r && !r._done);
  if (!rows.length) return;
  const isPub = verb === 'publish';
  const n = rows.length;
  const ids = rows.map(r => r.id_number);

  const wrap = document.createElement('div');
  wrap.className = 'axr-modal-vp';
  const listHtml = rows.slice(0, 10).map(r =>
    `<div class="it"><span>${esc(r.full_name || r.id_number)} <span style="color:var(--muted)">${esc(r.ced_kind || '')}-${esc(r.id_number)}</span></span><span style="color:var(--muted)">${r.field_count} campo(s)</span></div>`).join('');
  const more = n > 10 ? `<div style="color:var(--muted);font-size:12px;margin-top:6px">… y ${n - 10} más</div>` : '';
  wrap.innerHTML = `
    <div class="axr-modal">
      <h3>${isPub ? 'Publicar al sistema' : 'Adoptar del sistema'}</h3>
      <p class="who">${n} ficha${n === 1 ? '' : 's'}</p>
      <div class="box" style="${isPub
        ? 'background:var(--warn-bg,#fff7ed);border:1px solid var(--warn-bd,#fed7aa);color:#b45309'
        : 'background:#f5f3ff;border:1px solid #ddd6fe;color:#6d28d9'}">
        ${isPub
          ? `Se enviará al sistema el valor del <b>portal</b> en los campos que difieren. El sistema quedará igual al portal en esas fichas.`
          : `Se escribirá en el <b>portal</b> el valor del <b>sistema</b> en los campos que difieren. El dato actual del portal se reemplaza. Esta acción no se puede deshacer desde aquí.`}
      </div>
      <div class="lst">${listHtml}${more}</div>
      <div class="res" id="cmpRes"></div>
      <div class="foot">
        <button class="axr-btn" id="cmpCxl">Cancelar</button>
        <button class="axr-btn ${isPub ? 'axr-btn-pub' : 'axr-btn-adopt'}" id="cmpGo">${isPub ? 'Publicar' : 'Adoptar'}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('#cmpCxl').addEventListener('click', close);

  const goB = wrap.querySelector('#cmpGo');
  goB.addEventListener('click', async () => {
    goB.disabled = true; goB.textContent = isPub ? 'Publicando…' : 'Adoptando…';
    const res = wrap.querySelector('#cmpRes');
    res.className = 'res'; res.textContent = '';
    // Empresas involucradas en las fichas a resolver (para que el backend
    // re-detecte SOLO esas empresas, no todo el alcance -> evita el limite de
    // subrequests y es preciso).
    const codes = [...new Set(rows.map(r => r.company_code).filter(Boolean))];
    let r;
    try {
      if (isPub) {
        // 1) marcar como pendientes (origin erp_detect) las detectadas.
        const mark = await api({ action: 'detect_commit', user: sessionUserPayload(USER), company_codes: codes, id_numbers: ids });
        if (!mark || !mark.ok) { r = mark; }
        else {
          // 2) publicar esas fichas.
          r = await api({ action: 'publish', user: sessionUserPayload(USER), id_numbers: ids });
        }
      } else {
        r = await api({ action: 'adopt', user: sessionUserPayload(USER), company_codes: codes, id_numbers: ids });
      }
    } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }

    if (!r || !r.ok) {
      res.className = 'res err';
      res.textContent = '⚠ ' + ((r && r.error) || 'No se pudo completar la acción.');
      goB.disabled = false; goB.textContent = 'Reintentar';
      return;
    }
    const done = isPub ? (r.published || []).length : (r.adopted || []).length;
    res.className = 'res ok';
    res.innerHTML = isPub
      ? `✓ <b>${done}</b> ficha(s) publicada(s) al sistema.`
      : `✓ <b>${done}</b> ficha(s) actualizada(s) con el valor del sistema.`;
    // Marcar las filas como resueltas en el panel.
    const doneSet = new Set(ids.map(String));
    CMP_ROWS.forEach(row => { if (doneSet.has(String(row.id_number))) row._done = verb; });
    goB.textContent = 'Listo';
    goB.disabled = false;
    // v4.53: clonar el boton elimina el listener original (evita que
    // "Cerrar" re-dispare la accion) y se oculta el otro boton.
    const goB2 = goB.cloneNode(true);
    goB.replaceWith(goB2);
    goB2.onclick = () => { close(); paintCompare(); };
    const cxl = wrap.querySelector('#cmpCxl'); if (cxl) cxl.style.display = 'none';
  });
}

/* ===================== HISTORIAL (v4.44) =====================
   Bitacora completa de Sincronizar (ax_change_set: pendientes, publicados y
   anulados; historial permanente). Panel grande con busqueda por cedula o
   nombre, filtros por estado y origen, orden por fecha y paginado SERVER-SIDE
   (el count exacto lo trae el endpoint 'history'). Solo lectura. */
let HIST = { page: 1, size: 50, q: '', status: '', origin: '', dir: 'desc', total: 0, rows: [] };

const HIST_STATUS_LBL = { pending: 'Pendiente', published: 'Publicado', discarded: 'Anulado' };
const HIST_ORIGIN_LBL = { edit: 'Edición', erp_detect: 'Comparación', auto_sync: 'Automático' };

export async function renderAxHistory(user) {
  USER = user;
  ensureStyles();
  HIST = { page: 1, size: 50, q: '', status: '', origin: '', dir: 'desc', total: 0, rows: [] };
  $('#pnlMain').innerHTML = `
    <div class="axr-head"><div>
      <h1>Historial</h1>
      <p id="hSub">Todo lo que pasó por Sincronizar: pendientes, publicados y anulados. Solo lectura; publicar y anular se hacen en la bandeja.</p>
    </div><div class="head-actions">${slRegBtn('axhistory')}</div><span id="hRefresh"></span></div>
    <div class="axr-hctrl" style="margin-top:16px">
      <span class="fg">Buscar<input id="hQ" type="text" placeholder="Cédula o nombre…" style="width:200px"></span>
      <span class="fg">Estado<select id="hSt"><option value="">Todos</option><option value="pending">Pendiente</option><option value="published">Publicado</option><option value="discarded">Anulado</option></select></span>
      <span class="fg">Origen<select id="hOr"><option value="">Todos</option><option value="edit">Edición</option><option value="erp_detect">Comparación</option></select></span>
      <span class="fg">Orden<select id="hDir"><option value="desc">Más recientes primero</option><option value="asc">Más antiguos primero</option></select></span>
      <span class="fg">Por página<select id="hSize"><option>25</option><option selected>50</option><option>100</option></select></span>
      <button class="axr-btn" id="hGo">Aplicar</button>
    </div>
    <div id="hList" style="margin-top:6px"><div class="axr-loading">Cargando…</div></div>
    <div class="axr-hpager" id="hPager" hidden>
      <span id="hRange"></span>
      <button class="axr-btn" id="hPrev">← Anterior</button>
      <button class="axr-btn" id="hNext">Siguiente →</button>
    </div>`;

  const apply = () => {
    HIST.q = $('#hQ').value.trim();
    HIST.status = $('#hSt').value;
    HIST.origin = $('#hOr').value;
    HIST.dir = $('#hDir').value;
    HIST.size = +$('#hSize').value;
    HIST.page = 1;
    histLoad(document);
  };
  $('#hGo').addEventListener('click', apply);
  $('#hQ').addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
  ['#hSt', '#hOr', '#hDir', '#hSize'].forEach(sel =>
    $(sel).addEventListener('change', apply));
  $('#hPrev').addEventListener('click', () => { if (HIST.page > 1) { HIST.page--; histLoad(document); } });
  $('#hNext').addEventListener('click', () => {
    if (HIST.page * HIST.size < HIST.total) { HIST.page++; histLoad(document); }
  });

  await histLoad(document);
  attachRefresh('#hRefresh', () => histLoad(document), 'historial');
}

async function histLoad(wrap) {
  const list = wrap.querySelector('#hList');
  list.innerHTML = '<div class="axr-loading">Cargando…</div>';
  const r = await api({
    action: 'history', user: sessionUserPayload(USER),
    page: HIST.page, page_size: HIST.size, q: HIST.q,
    status: HIST.status, origin: HIST.origin, dir: HIST.dir,
  });
  if (!r || !r.ok) {
    list.innerHTML = `<div class="axr-empty">No se pudo cargar el historial${r && r.error ? ': ' + esc(r.error) : ''}.</div>`;
    return;
  }
  HIST.total = r.total || 0;
  HIST.rows = r.rows || [];
  paintHistory(wrap);
}

function paintHistory(wrap) {
  const list = wrap.querySelector('#hList');
  const sub = wrap.querySelector('#hSub');
  if (sub) sub.textContent = `${HIST.total} registro${HIST.total === 1 ? '' : 's'} en tu alcance${HIST.q || HIST.status || HIST.origin ? ' con estos filtros' : ''}.`;

  if (!HIST.rows.length) {
    list.innerHTML = '<div class="axr-empty">Sin registros con estos filtros.</div>';
    const pg0 = wrap.querySelector('#hPager'); if (pg0) pg0.hidden = true;
    return;
  }

  list.innerHTML = HIST.rows.map(r => {
    const ci = avatarColor(r.id_number);
    const ava = r.thumb_url
      ? `<div class="axr-hava"><img src="${esc(r.thumb_url)}" alt="" loading="lazy" onerror="this.remove()"></div>`
      : `<div class="axr-hava" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(r.full_name))}</div>`;
    const flds = (r.fields || []).map(f =>
      `<span class="fl"><b>${esc(f.label)}:</b> ${f.old == null ? '(vacío)' : esc(f.old)} → ${f.new == null ? '(vacío)' : esc(f.new)}</span>`
    ).join(' · ');
    const who = [];
    if (r.changed_by || r.changed_at) who.push(`Editado${r.changed_by ? ` por <b>${esc(r.changed_by)}</b>` : ''}${r.changed_at ? ' · ' + esc(fmtDateTime(r.changed_at)) : ''}`);
    if (r.status !== 'pending' && (r.resolved_by || r.resolved_at)) {
      who.push(`${r.status === 'published' ? 'Publicado' : 'Anulado'}${r.resolved_by ? ` por <b>${esc(r.resolved_by)}</b>` : ''}${r.resolved_at ? ' · ' + esc(fmtDateTime(r.resolved_at)) : ''}`);
    }
    return `<div class="axr-hrow">
      ${ava}
      <div class="axr-hmain">
        <div class="axr-hnm">${esc(r.full_name || '(sin nombre)')}</div>
        <div class="axr-hsub">${esc(r.ced_kind || '')}-${esc(r.id_number)} · ${esc(r.company_code)}${r.company_name ? ' · ' + esc(r.company_name) : ''}</div>
        <div class="axr-hflds">${flds}</div>
        ${who.length ? `<div class="axr-hwho">${who.join('  ·  ')}</div>` : ''}
      </div>
      <div class="axr-hside">
        <span class="axr-hst ${esc(r.status)}">${HIST_STATUS_LBL[r.status] || esc(r.status)}</span>
        <span class="axr-hor">${HIST_ORIGIN_LBL[r.origin] || esc(r.origin)}</span>
      </div>
    </div>`;
  }).join('');

  const pager = wrap.querySelector('#hPager');
  const from = (HIST.page - 1) * HIST.size + 1;
  const to = Math.min(HIST.page * HIST.size, HIST.total);
  pager.hidden = false;
  wrap.querySelector('#hRange').textContent = `${from}–${to} de ${HIST.total}`;
  wrap.querySelector('#hPrev').disabled = HIST.page <= 1;
  wrap.querySelector('#hNext').disabled = to >= HIST.total;
}
