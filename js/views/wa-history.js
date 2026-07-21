/* =====================================================================
   js/views/wa-history.js  →  vista "Historial" (WhatsApp)   v6.62
   La BITACORA de los envios: cada corrida (wa_batches) con su resultado
   real (wa_outbox), separada de la DEFINICION del mensaje (que se edita en
   Mensajes). Version minima acordada con Pablo: VER + DETALLE, todos con
   permiso ven todo. El borrado/papelera y las acciones en lote quedan para
   una iteracion posterior.

   Muestra:
     - Lista de corridas (mas recientes primero): fecha/hora, origen
       (Difusion o que Mensaje/regla), autor, nº de destinos, y el resumen
       OK / error / pendiente del envio real.
     - Detalle expandible por corrida: destino por destino (grupo o persona),
       con su estado y el error si lo hubo. Tambien el texto que se envio.
     - Filtros por origen (todos / mensajes / difusion / credenciales) y por
       fecha (desde / hasta).

   En la UI se dice "la linea" / "WhatsApp" / "grupos" (nunca el proveedor).
   Export: renderWaHistory(user)
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const nf = n => Number(n || 0).toLocaleString('es-VE');

let ROWS = [];         // corridas crudas (de 'list')
let TEMPLATES = {};    // code -> label de mensaje
let EXPANDED = new Set();   // ids de corridas con el detalle abierto
let DETAILS = {};      // batch_id -> detalle cargado (cache en memoria)
let FILTERS = { origin: 'all', from: '', to: '' };
let HUSER = null;

async function api(user, payload) {
  return fetch('/api/wa-history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null },
      ...payload,
    }),
  }).then(x => x.json()).catch(() => null);
}

function ensureStyles() {
  if (document.getElementById('waHistStyles')) return;
  const st = document.createElement('style');
  st.id = 'waHistStyles';
  st.textContent = `
  .wh-wrap{max-width:1080px}
  .wh-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:16px}
  .wh-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:9px}
  .wh-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .wh-ic{width:30px;height:30px;border-radius:9px;background:#e9fbf0;color:#128c7e;display:grid;place-items:center;flex:none}
  .wh-filters{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:14px}
  .wh-filters .fld{display:flex;flex-direction:column;gap:4px}
  .wh-filters label{font-size:11px;font-weight:700;color:var(--ink-soft,#475569)}
  .wh-filters select,.wh-filters input{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink)}
  .wh-filters .sp{flex:1}
  .wh-clear{border:1px solid var(--border);background:var(--surface,#fff);border-radius:9px;padding:8px 13px;font:inherit;font-size:12.5px;font-weight:600;color:var(--ink-soft,#475569);cursor:pointer}
  .wh-count{font-size:12.5px;color:var(--muted);margin:0 2px 10px}
  .wh-list{display:flex;flex-direction:column;gap:9px}
  .wh-card{border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);overflow:hidden}
  .wh-row{display:flex;align-items:center;gap:13px;padding:12px 15px;cursor:pointer}
  .wh-row:hover{background:#fbfcfe}
  .wh-when{flex:none;min-width:118px}
  .wh-when b{display:block;font-size:13px;color:var(--ink);font-weight:700}
  .wh-when small{font-size:11px;color:var(--muted)}
  .wh-mid{flex:1;min-width:0}
  .wh-org{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .wh-badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:800}
  .wh-badge.rule{background:#eef4ff;color:#1d4ed8;border:1px solid #c7d8fb}
  .wh-badge.broadcast{background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0}
  .wh-badge.cred{background:#faf5ff;color:#7c3aed;border:1px solid #e9d5ff}
  .wh-badge.other{background:#f1f5f9;color:#64748b;border:1px solid var(--border)}
  .wh-org .by{font-size:12px;color:var(--muted)}
  .wh-prev{font-size:12.5px;color:var(--ink-soft,#475569);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .wh-kpis{flex:none;display:flex;gap:7px;align-items:center}
  .wh-pill{display:inline-flex;align-items:center;gap:5px;border-radius:8px;padding:3px 9px;font-size:11.5px;font-weight:800;white-space:nowrap}
  .wh-pill.ok{background:#e9fbf0;color:#0f7a4d;border:1px solid #bbf1d2}
  .wh-pill.err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
  .wh-pill.pend{background:#fffbeb;color:#92400e;border:1px solid #fde68a}
  .wh-pill.none{background:#f1f5f9;color:#64748b;border:1px solid var(--border)}
  .wh-chev{flex:none;color:var(--faint,#94a3b8);transition:transform .15s}
  .wh-card.open .wh-chev{transform:rotate(90deg)}
  .wh-detail{border-top:1px solid var(--border);background:#fbfcfe;padding:14px 16px;display:none}
  .wh-card.open .wh-detail{display:block}
  .wh-msg{background:var(--surface,#fff);border:1px solid var(--border);border-radius:10px;padding:10px 13px;font-size:12.5px;color:var(--ink);white-space:pre-wrap;line-height:1.5;max-height:160px;overflow-y:auto;margin-bottom:12px}
  .wh-dtitle{font-size:10.5px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:0 0 7px}
  .wh-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .wh-table th{padding:6px 10px;background:#f5f8fc;border-bottom:1px solid var(--border);font-size:10.5px;font-weight:800;color:var(--ink-soft,#475569);text-transform:uppercase;letter-spacing:.04em;text-align:left}
  .wh-table td{padding:7px 10px;border-bottom:1px solid var(--border-soft,#f1f4f8);color:var(--ink);vertical-align:top}
  .wh-table tr:last-child td{border-bottom:0}
  .wh-st{display:inline-block;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:800}
  .wh-st.ok{background:#e9fbf0;color:#0f7a4d;border:1px solid #bbf1d2}
  .wh-st.err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
  .wh-st.pend{background:#fffbeb;color:#92400e;border:1px solid #fde68a}
  .wh-err{color:#b91c1c;font-size:11.5px;margin-top:3px}
  .wh-dload{color:var(--muted);font-size:12.5px;padding:8px 2px}
  .wh-empty{text-align:center;color:var(--muted);font-size:13px;padding:34px 16px;border:1px dashed var(--border);border-radius:12px}
  .wh-gname{font-weight:600}
  .wh-jid{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;color:var(--faint,#94a3b8)}`;
  document.head.appendChild(st);
}

/* Fecha ISO -> {dia, hora} en hora de Caracas (UTC-4). */
function fmtWhen(iso) {
  if (!iso) return { dia: '—', hora: '' };
  const dt = new Date(iso);
  if (isNaN(dt)) return { dia: '—', hora: '' };
  const c = new Date(dt.getTime() - 4 * 3600 * 1000);
  const z = n => String(n).padStart(2, '0');
  const dia = `${z(c.getUTCDate())}/${z(c.getUTCMonth() + 1)}/${c.getUTCFullYear()}`;
  let h = c.getUTCHours(); const ap = h < 12 ? 'a.m.' : 'p.m.';
  h = h % 12; if (h === 0) h = 12;
  const hora = `${h}:${z(c.getUTCMinutes())} ${ap}`;
  return { dia, hora };
}

/* Etiqueta + clase del origen de una corrida. */
function originInfo(r) {
  if (r.origin_kind === 'rule') {
    const lbl = TEMPLATES[r.rule_code] || r.rule_code || 'Mensaje';
    return { cls: 'rule', txt: '💬 ' + lbl };
  }
  if (r.origin_kind === 'broadcast') {
    return { cls: 'broadcast', txt: '📣 Difusión' + (r.origin_label ? ' · ' + r.origin_label : '') };
  }
  if (r.origin_kind === 'cred') {
    return { cls: 'cred', txt: '🔑 Credenciales' + (r.origin_label ? ' · ' + r.origin_label : '') };
  }
  return { cls: 'other', txt: 'Otro' };
}

/* Primera linea del mensaje, recortada, para la vista previa de la fila. */
function preview(msg) {
  const first = String(msg || '').split('\n').find(l => l.trim()) || '';
  return first.length > 90 ? first.slice(0, 90) + '…' : first;
}

/* Resumen OK/error/pendiente de una corrida -> pildoras. */
function kpisHtml(r) {
  const parts = [];
  if (r.sent_ok) parts.push(`<span class="wh-pill ok">✓ ${nf(r.sent_ok)}</span>`);
  if (r.sent_error) parts.push(`<span class="wh-pill err">✕ ${nf(r.sent_error)}</span>`);
  if (r.sent_pending) parts.push(`<span class="wh-pill pend">⏳ ${nf(r.sent_pending)}</span>`);
  // Corrida sin outbox (se cortó antes de crear destinos, o formato viejo sin
  // detalle): mostramos el total previsto de la corrida como referencia.
  if (!parts.length) {
    parts.push(`<span class="wh-pill none">${nf(r.total)} previsto${r.total === 1 ? '' : 's'}</span>`);
  }
  return parts.join('');
}

/* ¿La corrida pasa los filtros de origen/fecha? */
function passFilters(r) {
  if (FILTERS.origin !== 'all' && r.origin_kind !== FILTERS.origin) return false;
  if (FILTERS.from || FILTERS.to) {
    const c = new Date(new Date(r.created_at).getTime() - 4 * 3600 * 1000);
    const ymd = `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, '0')}-${String(c.getUTCDate()).padStart(2, '0')}`;
    if (FILTERS.from && ymd < FILTERS.from) return false;
    if (FILTERS.to && ymd > FILTERS.to) return false;
  }
  return true;
}

function rowHtml(r) {
  const w = fmtWhen(r.created_at);
  const o = originInfo(r);
  const by = r.created_by ? `<span class="by">por ${esc(r.created_by)}</span>` : '';
  const open = EXPANDED.has(r.id);
  return `<div class="wh-card${open ? ' open' : ''}" data-batch="${esc(r.id)}">
    <div class="wh-row" data-toggle="${esc(r.id)}">
      <div class="wh-when"><b>${w.dia}</b><small>${w.hora}</small></div>
      <div class="wh-mid">
        <div class="wh-org"><span class="wh-badge ${o.cls}">${esc(o.txt)}</span>${by}</div>
        <div class="wh-prev">${esc(preview(r.message))}</div>
      </div>
      <div class="wh-kpis">${kpisHtml(r)}</div>
      <svg class="wh-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
    </div>
    <div class="wh-detail" id="wh-det-${esc(r.id)}">
      <div class="wh-dload">Cargando detalle…</div>
    </div>
  </div>`;
}

/* Pinta el detalle de una corrida (destino por destino) dentro de su panel. */
function paintDetail(batchId, data) {
  const host = document.getElementById('wh-det-' + batchId);
  if (!host) return;
  if (!data || !data.ok) {
    host.innerHTML = `<div class="wh-dload" style="color:#b91c1c">${esc((data && data.error) || 'No se pudo cargar el detalle.')}</div>`;
    return;
  }
  const b = data.batch;
  const rows = data.detail || [];
  const isCred = b.origin_kind === 'cred';

  // Cabecera de columnas segun el tipo: grupos vs persona (credenciales).
  const head = isCred
    ? `<tr><th>Persona</th><th>Teléfono</th><th>Estado</th></tr>`
    : `<tr><th>Grupo</th><th>Estado</th></tr>`;

  const body = rows.length ? rows.map(d => {
    const stCls = d.bucket === 'ok' ? 'ok' : d.bucket === 'error' ? 'err' : 'pend';
    const stTxt = d.bucket === 'ok' ? 'Enviado' : d.bucket === 'error' ? 'Error' : 'Pendiente';
    const errLine = d.error_text ? `<div class="wh-err">${esc(d.error_text)}</div>` : '';
    if (isCred) {
      return `<tr>
        <td>${esc(d.full_name || d.company_code || '—')}</td>
        <td class="wh-jid">${esc(d.phone_raw || '—')}</td>
        <td><span class="wh-st ${stCls}">${stTxt}</span>${errLine}</td>
      </tr>`;
    }
    const gname = d.group_name
      ? `<span class="wh-gname">${esc(d.group_name)}</span>`
      : `<span class="wh-jid">${esc(d.chat_id || '—')}</span>`;
    return `<tr>
      <td>${gname}</td>
      <td><span class="wh-st ${stCls}">${stTxt}</span>${errLine}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="${isCred ? 3 : 2}" style="color:var(--muted);padding:12px">Esta corrida no llegó a registrar destinos (se cortó antes de enviar).</td></tr>`;

  host.innerHTML = `
    <div class="wh-dtitle">Mensaje enviado</div>
    <div class="wh-msg">${esc(b.message)}</div>
    <div class="wh-dtitle">${isCred ? 'Destinatario' : 'Grupos'} (${nf(rows.length)})</div>
    <table class="wh-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

async function toggleDetail(user, batchId) {
  const card = document.querySelector(`.wh-card[data-batch="${batchId}"]`);
  if (!card) return;
  if (EXPANDED.has(batchId)) {
    EXPANDED.delete(batchId);
    card.classList.remove('open');
    return;
  }
  EXPANDED.add(batchId);
  card.classList.add('open');
  // Cargar el detalle una sola vez (cache en DETAILS).
  if (DETAILS[batchId]) { paintDetail(batchId, DETAILS[batchId]); return; }
  const d = await api(user, { action: 'detail', batch_id: batchId });
  DETAILS[batchId] = d;
  // Puede haberse cerrado mientras cargaba; paintDetail es no-op si no está.
  paintDetail(batchId, d);
}

function renderList() {
  const host = $('#whList');
  if (!host) return;
  const rows = ROWS.filter(passFilters);
  $('#whCount').textContent = rows.length === ROWS.length
    ? `${nf(rows.length)} corrida${rows.length === 1 ? '' : 's'}`
    : `${nf(rows.length)} de ${nf(ROWS.length)} corrida${ROWS.length === 1 ? '' : 's'}`;
  if (!rows.length) {
    host.innerHTML = `<div class="wh-empty">No hay corridas que coincidan con los filtros.</div>`;
    return;
  }
  host.innerHTML = rows.map(rowHtml).join('');
  // Cablear el toggle de cada fila. Si estaba expandida, repintar su detalle.
  host.querySelectorAll('[data-toggle]').forEach(el =>
    el.addEventListener('click', () => toggleDetail(HUSER, el.dataset.toggle)));
  rows.forEach(r => {
    if (EXPANDED.has(r.id) && DETAILS[r.id]) paintDetail(r.id, DETAILS[r.id]);
  });
}

export async function renderWaHistory(user) {
  ensureStyles();
  HUSER = user;
  EXPANDED = new Set();
  DETAILS = {};
  const main = document.getElementById('pnlMain');
  main.innerHTML = `<div class="wh-wrap">
    <div class="wh-head">
      <div>
        <h1><span class="wh-ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg></span>
        Historial</h1>
        <p>Los envíos que ya salieron de la línea, con su resultado. Cada corrida es un envío; el detalle muestra grupo por grupo si llegó o falló.</p>
      </div>
    </div>

    <div class="wh-filters">
      <div class="fld">
        <label>Origen</label>
        <select id="whOrigin">
          <option value="all">Todos</option>
          <option value="rule">Mensajes (reglas)</option>
          <option value="broadcast">Difusión</option>
          <option value="cred">Credenciales</option>
        </select>
      </div>
      <div class="fld">
        <label>Desde</label>
        <input type="date" id="whFrom">
      </div>
      <div class="fld">
        <label>Hasta</label>
        <input type="date" id="whTo">
      </div>
      <div class="sp"></div>
      <button class="wh-clear" id="whClear">Limpiar filtros</button>
    </div>

    <p class="wh-count" id="whCount"></p>
    <div class="wh-list" id="whList"><div class="wh-dload">Cargando historial…</div></div>
  </div>`;

  // Listeners de filtros.
  $('#whOrigin').addEventListener('change', () => { FILTERS.origin = $('#whOrigin').value; renderList(); });
  $('#whFrom').addEventListener('change', () => { FILTERS.from = $('#whFrom').value; renderList(); });
  $('#whTo').addEventListener('change', () => { FILTERS.to = $('#whTo').value; renderList(); });
  $('#whClear').addEventListener('click', () => {
    FILTERS = { origin: 'all', from: '', to: '' };
    $('#whOrigin').value = 'all'; $('#whFrom').value = ''; $('#whTo').value = '';
    renderList();
  });

  // Cargar las corridas.
  const d = await api(user, { action: 'list' });
  if (!d || !d.ok) {
    $('#whList').innerHTML = `<div class="wh-empty" style="color:#b91c1c">${esc((d && d.error) || 'No se pudo cargar el historial.')}</div>`;
    return;
  }
  ROWS = d.rows || [];
  TEMPLATES = d.templates || {};
  renderList();
}
