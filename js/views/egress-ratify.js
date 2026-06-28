/* =====================================================================
   js/views/egress-ratify.js  →  vista "Ratificar egresos"
   El admin revisa el MOTIVO que la tienda puso en cada egreso y decide:
     - Ratificar  : acepta el motivo de la tienda tal cual.
     - Rectificar : lo corrige con otro motivo (+ comentario propio).
     - Reabrir    : vuelve la linea a "pendiente".
   Datos por /api/egress-ratify (list / apply). Catalogo de motivos por
   /api/catalog (egress_reasons). Alcance por empresas del admin.

   Export: renderEgressRatify(user)  — user = { kind:'admin', id, role, name }
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(ymd) {
  if (!ymd) return '—';
  const s = String(ymd).slice(0, 10);
  const [y, m, d] = s.split('-');
  return (y && m && d) ? `${d}/${m}/${y}` : s;
}
function fmtWhen(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt)) return '';
  // Hora Venezuela.
  return dt.toLocaleString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

let ALL_ROWS = [];
let REASONS = [];
let CUR_STATUS = 'pendiente'; // pendiente | ratificado | rectificado | todos
let USER = null;

const STATUSES = [
  { key: 'pendiente', label: 'Pendientes' },
  { key: 'ratificado', label: 'Ratificados' },
  { key: 'rectificado', label: 'Rectificados' },
  { key: 'todos', label: 'Todos' },
];

function ensureStyles() {
  if (document.getElementById('egrStyles')) return;
  const st = document.createElement('style');
  st.id = 'egrStyles';
  st.textContent = `
  .egr-head{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap}
  .egr-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .egr-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .egr-chips{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 4px}
  .egr-chip{font:inherit;font-size:13px;padding:7px 13px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--ink);cursor:pointer;display:flex;align-items:center;gap:7px}
  .egr-chip.on{background:var(--brand,#2563eb);color:#fff;border-color:var(--brand,#2563eb)}
  .egr-chip .egr-n{font-size:11px;font-weight:700;background:rgba(0,0,0,.08);border-radius:999px;padding:1px 7px}
  .egr-chip.on .egr-n{background:rgba(255,255,255,.25)}
  .egr-table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
  .egr-table th{text-align:left;font-weight:600;color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;padding:8px 10px;border-bottom:1px solid var(--border)}
  .egr-table td{padding:11px 10px;border-bottom:1px solid var(--border);vertical-align:top}
  .egr-table tr:hover td{background:var(--bg-soft,#f8fafc)}
  .egr-pill{display:inline-block;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap}
  .egr-pend{background:#fef3c7;color:#92400e}
  .egr-rat{background:#dcfce7;color:#166534}
  .egr-rec{background:#ede9fe;color:#6d28d9}
  .egr-none{color:var(--muted)}
  .egr-mot{font-weight:600;color:var(--ink)}
  .egr-cmt{display:block;color:var(--muted);font-size:11.5px;margin-top:2px;font-style:italic}
  .egr-by{display:block;color:var(--muted);font-size:11px;margin-top:3px}
  .egr-acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
  .egr-b{font:inherit;font-size:12px;padding:6px 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);cursor:pointer;white-space:nowrap}
  .egr-b:hover{background:var(--bg-soft,#f1f5f9)}
  .egr-b-rat{background:#16a34a;color:#fff;border-color:#16a34a}
  .egr-b-rat:hover{background:#15803d}
  .egr-b-rec{background:#7c3aed;color:#fff;border-color:#7c3aed}
  .egr-b-rec:hover{background:#6d28d9}
  .egr-empty{padding:36px 14px;text-align:center;color:var(--muted)}
  .egr-ov{position:fixed;inset:0;background:rgba(15,23,42,.42);display:flex;align-items:center;justify-content:center;z-index:80;padding:16px}
  .egr-modal{background:var(--card,#fff);border-radius:14px;max-width:440px;width:100%;padding:22px;box-shadow:0 18px 48px rgba(15,23,42,.24)}
  .egr-modal h3{margin:0 0 4px;font-size:17px}
  .egr-modal .egr-who{color:var(--muted);font-size:12.5px;margin:0 0 16px}
  .egr-modal label{display:block;font-size:12.5px;font-weight:600;color:var(--ink);margin-bottom:6px}
  .egr-modal select,.egr-modal textarea{width:100%;font:inherit;font-size:13px;padding:9px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);box-sizing:border-box}
  .egr-modal textarea{margin-top:12px;resize:vertical;min-height:64px}
  .egr-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
  `;
  document.head.appendChild(st);
}

function reasonLabel(code) {
  if (!code) return null;
  const r = REASONS.find(x => x.code === code);
  return r ? r.label : code;
}

async function loadReasons() {
  if (REASONS.length) return;
  try {
    const r = await fetch('/api/catalog', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'egress_reasons' }),
    }).then(x => x.json());
    REASONS = (r && r.ok && r.reasons) ? r.reasons : [];
  } catch { REASONS = []; }
}

async function fetchAll() {
  const r = await fetch('/api/egress-ratify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'list', adminId: USER.id, status: null }),
  }).then(x => x.json()).catch(() => null);
  ALL_ROWS = (r && r.ok && r.rows) ? r.rows : [];
  return r;
}

async function apply(payload) {
  return fetch('/api/egress-ratify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, adminId: USER.id }),
  }).then(x => x.json()).catch(() => ({ ok: false, error: 'Error de red.' }));
}

export async function renderEgressRatify(user) {
  USER = user;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="egr-head"><div><h1>Ratificar egresos</h1>
      <p>Revisa el motivo que indicó la tienda en cada egreso. Puedes ratificarlo, rectificarlo o reabrirlo.</p></div></div>
    <div class="pnl-loading" style="margin-top:18px">Cargando…</div>`;
  await Promise.all([loadReasons(), fetchAll()]);
  paint();
}

function counts() {
  const c = { pendiente: 0, ratificado: 0, rectificado: 0, todos: ALL_ROWS.length };
  ALL_ROWS.forEach(r => { c[r.admin_reason_status] = (c[r.admin_reason_status] || 0) + 1; });
  return c;
}

function paint() {
  const c = counts();
  const chips = STATUSES.map(s =>
    `<button class="egr-chip ${s.key === CUR_STATUS ? 'on' : ''}" data-status="${s.key}">
      ${s.label} <span class="egr-n">${c[s.key] || 0}</span></button>`).join('');

  $('#pnlMain').innerHTML = `
    <div class="egr-head"><div><h1>Ratificar egresos</h1>
      <p>Revisa el motivo que indicó la tienda en cada egreso. Puedes ratificarlo, rectificarlo o reabrirlo.</p></div></div>
    <div class="egr-chips" id="egrChips">${chips}</div>
    <div class="card" style="padding:6px 8px"><div id="egrBody"></div></div>`;

  $('#egrChips').querySelectorAll('[data-status]').forEach(b =>
    b.addEventListener('click', () => { CUR_STATUS = b.dataset.status; paint(); }));

  renderTable();
}

function renderTable() {
  const rows = CUR_STATUS === 'todos' ? ALL_ROWS : ALL_ROWS.filter(r => r.admin_reason_status === CUR_STATUS);
  const body = $('#egrBody');
  if (!rows.length) {
    body.innerHTML = `<div class="egr-empty">No hay egresos en este estado.</div>`;
    return;
  }

  body.innerHTML = `
    <table class="egr-table">
      <thead><tr>
        <th>Empresa</th><th>Trabajador</th><th>Fecha egreso</th>
        <th>Motivo (tienda)</th><th>Revisión del admin</th><th style="text-align:right">Acción</th>
      </tr></thead>
      <tbody>${rows.map(rowHtml).join('')}</tbody>
    </table>`;

  body.querySelectorAll('[data-rat]').forEach(b =>
    b.addEventListener('click', () => doRatify(+b.dataset.rat)));
  body.querySelectorAll('[data-rec]').forEach(b =>
    b.addEventListener('click', () => openRectify(+b.dataset.rec)));
  body.querySelectorAll('[data-reopen]').forEach(b =>
    b.addEventListener('click', () => doReopen(+b.dataset.reopen)));
}

function rowHtml(r) {
  const storeMot = r.reason_code
    ? `<span class="egr-mot">${esc(r.reason_label || r.reason_code)}</span>${r.reason_comment ? `<span class="egr-cmt">“${esc(r.reason_comment)}”</span>` : ''}`
    : '<span class="egr-none">— sin motivo —</span>';

  let review = '<span class="egr-pill egr-pend">pendiente</span>';
  if (r.admin_reason_status === 'ratificado') {
    review = `<span class="egr-pill egr-rat">ratificado</span>${r.ratified_by_name ? `<span class="egr-by">por ${esc(r.ratified_by_name)} · ${esc(fmtWhen(r.admin_ratified_at))}</span>` : ''}`;
  } else if (r.admin_reason_status === 'rectificado') {
    review = `<span class="egr-pill egr-rec">rectificado</span>
      <span class="egr-mot" style="display:block;margin-top:4px">${esc(r.admin_reason_label || r.admin_reason_code || '')}</span>
      ${r.admin_reason_comment ? `<span class="egr-cmt">“${esc(r.admin_reason_comment)}”</span>` : ''}
      ${r.ratified_by_name ? `<span class="egr-by">por ${esc(r.ratified_by_name)} · ${esc(fmtWhen(r.admin_ratified_at))}</span>` : ''}`;
  }

  let acts;
  if (r.admin_reason_status === 'pendiente') {
    const ratBtn = r.reason_code ? `<button class="egr-b egr-b-rat" data-rat="${r.line_id}">✓ Ratificar</button>` : '';
    acts = `${ratBtn}<button class="egr-b egr-b-rec" data-rec="${r.line_id}">Rectificar…</button>`;
  } else {
    acts = `<button class="egr-b" data-rec="${r.line_id}">Cambiar…</button>
      <button class="egr-b" data-reopen="${r.line_id}">Reabrir</button>`;
  }

  return `<tr>
    <td><b>${esc(r.company_code)}</b><br><span class="egr-by" style="margin:0">${esc(r.company_name || '')}</span></td>
    <td><b>${esc(r.worker_name)}</b><br><span class="egr-by" style="margin:0">${esc(r.worker_id_number)}</span></td>
    <td>${esc(fmtDate(r.report_date))}</td>
    <td>${storeMot}</td>
    <td>${review}</td>
    <td><div class="egr-acts">${acts}</div></td>
  </tr>`;
}

async function reloadAndRepaint() {
  await fetchAll();
  paint();
}

async function doRatify(lineId) {
  const row = ALL_ROWS.find(r => r.line_id === lineId);
  if (!row) return;
  if (!confirm(`Ratificar el motivo "${reasonLabel(row.reason_code) || ''}" indicado por la tienda?`)) return;
  const r = await apply({ action: 'apply', line_id: lineId, mode: 'ratificar' });
  if (!r.ok) { alert(r.error || 'No se pudo ratificar.'); return; }
  await reloadAndRepaint();
}

async function doReopen(lineId) {
  if (!confirm('Reabrir esta línea y borrar la decisión del admin?')) return;
  const r = await apply({ action: 'apply', line_id: lineId, mode: 'pendiente' });
  if (!r.ok) { alert(r.error || 'No se pudo reabrir.'); return; }
  await reloadAndRepaint();
}

function openRectify(lineId) {
  const row = ALL_ROWS.find(r => r.line_id === lineId);
  if (!row) return;

  // Preseleccion del motivo actual del admin (si ya estaba rectificado);
  // nunca preseleccionamos el de la tienda (regla UX: no asumir).
  const cur = row.admin_reason_status === 'rectificado' ? row.admin_reason_code : '';
  const opts = REASONS.map(x =>
    `<option value="${esc(x.code)}" ${x.code === cur ? 'selected' : ''}>${esc(x.label)}</option>`).join('');

  const ov = document.createElement('div');
  ov.className = 'egr-ov';
  ov.innerHTML = `
    <div class="egr-modal">
      <h3>Rectificar motivo</h3>
      <p class="egr-who">${esc(row.worker_name)} · ${esc(row.company_code)} · egreso ${esc(fmtDate(row.report_date))}</p>
      <p class="egr-who" style="margin-top:-10px">La tienda indicó: <b>${esc(row.reason_label || row.reason_code || '— sin motivo —')}</b>${row.reason_comment ? ` · “${esc(row.reason_comment)}”` : ''}</p>
      <label>Motivo correcto <span style="color:#dc2626">*</span></label>
      <select id="egrSel">
        <option value="" ${cur ? '' : 'selected'} disabled>Selecciona el motivo real…</option>
        ${opts}
      </select>
      <textarea id="egrCmt" maxlength="300" placeholder="Comentario del admin (opcional)">${esc(row.admin_reason_status === 'rectificado' ? (row.admin_reason_comment || '') : '')}</textarea>
      <div class="egr-foot">
        <button class="egr-b" id="egrCancel">Cancelar</button>
        <button class="egr-b egr-b-rec" id="egrSave" disabled>Guardar rectificación</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const sel = ov.querySelector('#egrSel');
  const cmt = ov.querySelector('#egrCmt');
  const save = ov.querySelector('#egrSave');
  const sync = () => { save.disabled = !sel.value; };
  sel.addEventListener('change', sync);
  sync();

  ov.querySelector('#egrCancel').addEventListener('click', () => ov.remove());
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  save.addEventListener('click', async () => {
    if (!sel.value) return;
    save.disabled = true; save.textContent = 'Guardando…';
    const r = await apply({ action: 'apply', line_id: lineId, mode: 'rectificar', admin_code: sel.value, admin_comment: cmt.value });
    if (!r.ok) { alert(r.error || 'No se pudo rectificar.'); save.disabled = false; save.textContent = 'Guardar rectificación'; return; }
    ov.remove();
    await reloadAndRepaint();
  });
}
