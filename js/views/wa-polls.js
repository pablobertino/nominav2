/* =====================================================================
   js/views/wa-polls.js  →  vista "Encuestas" (WhatsApp)  v6.54  (Fase A)
   Crea y publica encuestas de WhatsApp en un grupo habilitado, y guarda
   el registro de cada una (historial). Backend: /api/wa-polls.

   SOLO GRUPOS (como Difusion): el destino es un grupo habilitado.
   Limites de WhatsApp/Green-API que la UI respeta:
     - pregunta <= 255 caracteres
     - entre 2 y 12 opciones, unicas; cada una <= 100 caracteres
   Fase B (futura): leer los votos. Por eso el backend ya guarda el
   idMessage de cada encuesta; aqui todavia no se muestran resultados.

   Export: renderWaPolls(user)
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const Q_MAX = 255;
const OPT_MAX = 100;
const OPT_MIN_N = 2;
const OPT_MAX_N = 12;

let USER = null;
let GROUPS = [];   // grupos habilitados para el selector
let POLLS = [];    // historial

async function api(user, payload) {
  return fetch('/api/wa-polls', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null },
      ...payload,
    }),
  }).then(x => x.json()).catch(() => null);
}

function ensureStyles() {
  if (document.getElementById('waPollsStyles')) return;
  const st = document.createElement('style');
  st.id = 'waPollsStyles';
  st.textContent = `
  .wp-wrap{max-width:900px}
  .wp-head{margin-bottom:16px}
  .wp-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:9px}
  .wp-head p{margin:3px 0 0;color:var(--muted);font-size:13px;max-width:640px}
  .wp-ic{width:30px;height:30px;border-radius:9px;background:#e9fbf0;color:#128c7e;display:grid;place-items:center;flex:none}
  .wp-card{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;padding:18px;margin-bottom:14px}
  .wp-card h3{margin:0 0 14px;font-size:15px;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:8px}
  .wp-card h3 .n{background:#128c7e;color:#fff;border-radius:50%;width:20px;height:20px;display:inline-grid;place-items:center;font-size:12px}
  .wp-lbl{display:block;font-size:12.5px;font-weight:600;color:var(--ink-soft,#475569);margin:0 0 6px}
  .wp-inp{width:100%;font:inherit;font-size:14px;padding:9px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink)}
  .wp-inp::placeholder{color:#b6bfcc}
  .wp-count{float:right;font-size:11px;color:var(--muted);font-weight:600}
  .wp-count.over{color:#b91c1c}
  .wp-opt{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .wp-opt .grip{color:#cbd5e1;font-size:15px;flex:none}
  .wp-opt input{flex:1}
  .wp-opt .rm{border:1px solid #fecaca;background:#fff;border-radius:8px;width:34px;height:34px;font-size:16px;line-height:1;color:#b91c1c;cursor:pointer;flex:none}
  .wp-opt .rm:hover{background:#fef2f2}
  .wp-opt .rm:disabled{opacity:.35;cursor:default}
  .wp-addopt{border:1px dashed var(--border);background:transparent;border-radius:9px;padding:8px 12px;font:inherit;font-size:13px;font-weight:600;color:var(--pri,#2563eb);cursor:pointer;margin-top:2px}
  .wp-addopt:hover{background:#eef2ff;border-color:var(--pri,#2563eb)}
  .wp-addopt:disabled{opacity:.4;cursor:default}
  .wp-row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;margin-top:4px}
  .wp-row > div{flex:1;min-width:200px}
  .wp-sel{width:100%;font:inherit;font-size:14px;padding:9px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink)}
  .wp-check{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--ink-soft,#475569);cursor:pointer;user-select:none;padding:9px 0}
  .wp-check input{width:17px;height:17px;accent-color:#128c7e;cursor:pointer}
  .wp-actions{display:flex;align-items:center;gap:12px;margin-top:16px;padding-top:14px;border-top:1px solid var(--border-soft,#f1f4f8)}
  .wp-btn{border:1px solid var(--border);background:var(--surface,#fff);border-radius:10px;padding:10px 20px;font:inherit;font-size:14px;font-weight:700;color:var(--ink-soft,#475569);cursor:pointer}
  .wp-btn.wa{background:#128c7e;border-color:#128c7e;color:#fff}
  .wp-btn:disabled{opacity:.5;cursor:default}
  .wp-fb{font-size:13px;font-weight:600}
  .wp-fb.ok{color:#0f7a4d}
  .wp-fb.err{color:#b91c1c}
  .wp-preview{background:#f0f7ff;border:1px solid #cfe3ff;border-radius:11px;padding:12px 14px;margin-top:14px}
  .wp-preview .pq{font-weight:700;font-size:14px;color:var(--ink);margin-bottom:8px}
  .wp-preview .po{display:flex;align-items:center;gap:9px;padding:7px 10px;background:#fff;border:1px solid #dbe7f5;border-radius:8px;margin-bottom:5px;font-size:13px}
  .wp-preview .po .dot{width:15px;height:15px;border-radius:50%;border:2px solid #9db8d8;flex:none}
  .wp-preview .po.multi .dot{border-radius:4px}
  .wp-preview .cap{font-size:11px;color:var(--muted);margin-top:6px}
  .wp-hist table{width:100%;border-collapse:collapse;font-size:13px}
  .wp-hist th{padding:8px 10px;background:#fbfcfe;border-bottom:1px solid var(--border);font-size:10.5px;font-weight:800;color:var(--ink-soft,#475569);text-transform:uppercase;letter-spacing:.04em;text-align:left}
  .wp-hist td{padding:10px;border-bottom:1px solid var(--border-soft,#f1f4f8);vertical-align:top;color:var(--ink)}
  .wp-hist .q{font-weight:600}
  .wp-hist .opts{font-size:11.5px;color:var(--muted);margin-top:3px}
  .wp-badge{display:inline-block;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:800}
  .wp-badge.sent{background:#e9fbf0;color:#0f7a4d;border:1px solid #bbf1d2}
  .wp-badge.error{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
  .wp-empty{text-align:center;padding:30px 20px;color:var(--muted)}
  .wp-empty .big{font-size:30px;margin-bottom:6px}
  .wp-note{font-size:11px;color:var(--muted);margin-top:8px}`;
  document.head.appendChild(st);
}

function fmtWhen(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('es-VE', {
      timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', year: '2-digit',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch (_) { return ''; }
}

/* Estado del formulario (fuente de verdad para el preview). */
function formState() {
  const q = $('#wpQ') ? $('#wpQ').value : '';
  const opts = [...document.querySelectorAll('.wp-opt input')].map(i => i.value);
  const grpSel = $('#wpGroup');
  const grp = grpSel ? grpSel.value : '';
  const multi = $('#wpMulti') ? $('#wpMulti').checked : false;
  return { q, opts, grp, multi };
}

function cleanOpts(opts) {
  const seen = new Set(); const out = [];
  for (const x of opts) {
    const s = String(x || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out;
}

function renderPreview() {
  const host = $('#wpPreview');
  if (!host) return;
  const { q, opts, multi } = formState();
  const clean = cleanOpts(opts);
  const qt = q.trim();
  if (!qt && clean.length < OPT_MIN_N) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="pq">${esc(qt || '(pregunta…)')}</div>
    ${clean.map(o => `<div class="po ${multi ? 'multi' : ''}"><span class="dot"></span>${esc(o)}</div>`).join('')}
    <div class="cap">Vista previa · ${multi ? 'admite varias respuestas' : 'una sola respuesta'}</div>`;
}

/* Habilita/inhabilita el boton publicar segun validez. */
function refreshValidity() {
  const { q, opts, grp } = formState();
  const clean = cleanOpts(opts);
  const qt = q.trim();
  const ok = qt.length > 0 && qt.length <= Q_MAX
    && clean.length >= OPT_MIN_N && clean.length <= OPT_MAX_N
    && clean.every(o => o.length <= OPT_MAX)
    && !!Number(grp || 0);
  const btn = $('#wpSend');
  if (btn) btn.disabled = !ok;
  // contador de la pregunta
  const c = $('#wpQCount');
  if (c) { c.textContent = `${qt.length}/${Q_MAX}`; c.classList.toggle('over', qt.length > Q_MAX); }
}

function optRow(value = '') {
  const div = document.createElement('div');
  div.className = 'wp-opt';
  div.innerHTML = `<span class="grip">⋮⋮</span>
    <input class="wp-inp" maxlength="${OPT_MAX}" placeholder="Opción" value="${esc(value)}">
    <button class="rm" title="Quitar opción">×</button>`;
  div.querySelector('input').addEventListener('input', () => { renderPreview(); refreshValidity(); });
  div.querySelector('.rm').addEventListener('click', () => {
    const rows = document.querySelectorAll('.wp-opt');
    if (rows.length <= OPT_MIN_N) return;   // siempre al menos 2
    div.remove();
    syncOptButtons();
    renderPreview(); refreshValidity();
  });
  return div;
}

function syncOptButtons() {
  const rows = document.querySelectorAll('.wp-opt');
  rows.forEach(r => { r.querySelector('.rm').disabled = rows.length <= OPT_MIN_N; });
  const add = $('#wpAddOpt');
  if (add) add.disabled = rows.length >= OPT_MAX_N;
}

function paintHistory() {
  const host = $('#wpHist');
  if (!POLLS.length) {
    host.innerHTML = `<div class="wp-empty"><div class="big">📊</div>
      Aún no has publicado encuestas. Crea una arriba y aparecerá aquí.</div>`;
    return;
  }
  host.innerHTML = `<table>
    <thead><tr>
      <th style="width:44%">Encuesta</th>
      <th style="width:22%">Grupo</th>
      <th style="width:16%">Fecha</th>
      <th style="width:10%">Estado</th>
    </tr></thead>
    <tbody>${POLLS.map(p => {
      const opts = Array.isArray(p.options) ? p.options : [];
      return `<tr>
        <td><div class="q">${esc(p.question)}</div>
          <div class="opts">${opts.map(o => esc(o)).join(' · ')}${p.multiple_answers ? ' · (varias respuestas)' : ''}</div></td>
        <td>${esc(p.group_name || '—')}</td>
        <td>${fmtWhen(p.created_at)}<div class="opts">${esc(p.created_by || '')}</div></td>
        <td>${p.status === 'sent'
          ? '<span class="wp-badge sent">Publicada</span>'
          : '<span class="wp-badge error">Error</span>'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

export async function renderWaPolls(user) {
  ensureStyles();
  USER = user; GROUPS = []; POLLS = [];
  const main = document.getElementById('pnlMain');
  main.innerHTML = `<div class="wp-wrap">
    <div class="wp-head">
      <h1><span class="wp-ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/></svg></span>
        Encuestas</h1>
      <p>Crea y publica una encuesta de WhatsApp en un grupo del grupo Canaima. Cada encuesta queda registrada abajo.</p>
    </div>

    <div class="wp-card">
      <h3><span class="n">1</span> La pregunta</h3>
      <span class="wp-count" id="wpQCount">0/${Q_MAX}</span>
      <input class="wp-inp" id="wpQ" maxlength="${Q_MAX}" placeholder="Ej: ¿Qué horario prefieres para la reunión?">
    </div>

    <div class="wp-card">
      <h3><span class="n">2</span> Las opciones <span style="font-weight:500;color:var(--muted);font-size:12px">(entre ${OPT_MIN_N} y ${OPT_MAX_N})</span></h3>
      <div id="wpOpts"></div>
      <button class="wp-addopt" id="wpAddOpt">＋ Agregar opción</button>
      <div class="wp-row" style="margin-top:16px">
        <label class="wp-check"><input type="checkbox" id="wpMulti"> Permitir varias respuestas</label>
      </div>
    </div>

    <div class="wp-card">
      <h3><span class="n">3</span> Publicar</h3>
      <div class="wp-row">
        <div>
          <label class="wp-lbl">Grupo donde se publica</label>
          <select class="wp-sel" id="wpGroup"><option value="">— Elige un grupo —</option></select>
        </div>
      </div>
      <div id="wpPreview"></div>
      <div class="wp-actions">
        <button class="wp-btn wa" id="wpSend" disabled>📊 Publicar encuesta</button>
        <span class="wp-fb" id="wpFb"></span>
      </div>
      <div class="wp-note" id="wpNote"></div>
    </div>

    <div class="wp-card wp-hist">
      <h3>Encuestas publicadas</h3>
      <div id="wpHist"><div class="wp-empty">Cargando…</div></div>
    </div>
  </div>`;

  // Opciones iniciales: 2 filas vacias.
  const optsBox = $('#wpOpts');
  optsBox.appendChild(optRow());
  optsBox.appendChild(optRow());
  syncOptButtons();

  $('#wpAddOpt').addEventListener('click', () => {
    const rows = document.querySelectorAll('.wp-opt');
    if (rows.length >= OPT_MAX_N) return;
    optsBox.appendChild(optRow());
    syncOptButtons();
    renderPreview(); refreshValidity();
  });

  $('#wpQ').addEventListener('input', () => { renderPreview(); refreshValidity(); });
  $('#wpMulti').addEventListener('change', () => { renderPreview(); });
  $('#wpGroup').addEventListener('change', refreshValidity);

  // Publicar
  $('#wpSend').addEventListener('click', async () => {
    const { q, opts, grp, multi } = formState();
    const clean = cleanOpts(opts);
    const btn = $('#wpSend'); const fb = $('#wpFb');
    btn.disabled = true; fb.className = 'wp-fb'; fb.textContent = 'Publicando…';
    const r = await api(USER, {
      action: 'send',
      question: q.trim(),
      options: clean,
      multiple: multi,
      group_id: Number(grp || 0),
    });
    if (r && r.ok) {
      fb.className = 'wp-fb ok'; fb.textContent = '✓ Encuesta publicada';
      if (r.poll) { POLLS.unshift(r.poll); paintHistory(); }
      // limpiar el formulario para la siguiente
      $('#wpQ').value = '';
      $('#wpOpts').innerHTML = '';
      $('#wpOpts').appendChild(optRow());
      $('#wpOpts').appendChild(optRow());
      $('#wpMulti').checked = false;
      $('#wpGroup').value = '';
      syncOptButtons(); renderPreview(); refreshValidity();
      setTimeout(() => { if (fb.textContent.startsWith('✓')) { fb.textContent = ''; fb.className = 'wp-fb'; } }, 4000);
    } else {
      fb.className = 'wp-fb err'; fb.textContent = (r && r.error) || 'No se pudo publicar.';
      btn.disabled = false;
    }
  });

  // Cargar grupos + historial
  const [g, l] = await Promise.all([
    api(user, { action: 'groups' }),
    api(user, { action: 'list' }),
  ]);
  GROUPS = (g && g.ok && g.groups) || [];
  POLLS = (l && l.ok && l.polls) || [];

  const sel = $('#wpGroup');
  if (GROUPS.length) {
    sel.innerHTML = '<option value="">— Elige un grupo —</option>' +
      GROUPS.map(x => `<option value="${x.id}">${esc(x.alias || x.wa_name || x.chat_id)}</option>`).join('');
    $('#wpNote').textContent = '';
  } else {
    sel.innerHTML = '<option value="">— No hay grupos habilitados —</option>';
    $('#wpNote').textContent = 'No hay grupos habilitados para publicar. Habilita alguno en WhatsApp → Grupos.';
  }
  paintHistory();
  refreshValidity();
}
