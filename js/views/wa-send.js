/* =====================================================================
   js/views/wa-send.js  →  vista "Difusión" (grupo WhatsApp)  v4.90
   Mockup aprobado: _PRUEBAS/wa_difusion_mockup.html (v0-mock1) con dos
   ajustes de Pablo: menú propio WhatsApp > Difusión, y empresas SIEMPRE
   con el alias primero ("0A01 · MANCHESTER 2013, C.A.").

   Flujo (3 pasos): elegir destinatarios (Zona/Subzona/Tipo/Concepto/
   Empresa o cédula individual) → escribir el mensaje → enviar con
   confirmación inline y barra de progreso (la cola se procesa por tandas
   en /api/wa-send action 'process' hasta vaciarse; patrón Comparar).

   Reglas: en la UI se dice "WhatsApp" a secas (nunca el proveedor); sin
   alert/confirm nativos; el envío exige al menos un filtro. Gates del
   server: view.whatsapp (mirar) y wa.send (disparar) — hoy solo
   superadmin. Export: renderWaSend(user)
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const nf = n => Number(n || 0).toLocaleString('es-VE');
const MAX_MESSAGE = 4000;

/* v4.95: picker de emojis curado (clasicos universalmente soportados;
   para el catalogo completo esta el teclado nativo: Win+. / moviles).
   WhatsApp y Green-API los transportan como UTF-8 sin tratamiento. */
const EMOJI_GROUPS = [
  ['Saludos y gestos', ['👋', '🙏', '🙌', '👏', '💪', '👍', '👌', '🤝', '✌️', '☝️']],
  ['Caritas', ['😊', '😀', '😃', '🙂', '😉', '😁', '😎', '🤗', '🥳', '😅']],
  ['Avisos y estados', ['📢', '📣', '🔔', '⚠️', '❗', '✅', '✔️', '❌', '📌', 'ℹ️']],
  ['Trabajo y documentos', ['📋', '📄', '🧾', '📎', '💼', '✍️', '🗂️', '🖊️', '📑', '🔎']],
  ['Fechas y tiempo', ['📅', '🗓️', '⏰', '⏳', '🕐', '🌅', '🌙', '📆', '⏱️', '🕔']],
  ['Pagos y dinero', ['💰', '💵', '💳', '🏦', '🧮', '💸', '🪙', '📈', '📉', '💲']],
  ['Celebración', ['🎉', '🎊', '🎁', '🎈', '🏆', '⭐', '🌟', '✨', '🎂', '🥂']],
  ['Lugares y envíos', ['🏪', '🏢', '🏠', '🚚', '📦', '👟', '👕', '🧸', '🛍️', '🛒']],
  ['Comunicación', ['📱', '💬', '📩', '✉️', '📞', '🔗', '📡', '📬', '📲', '🔊']],
  ['Corazones', ['❤️', '💙', '💚', '💛', '🧡', '💜', '🤍', '💖', '💕', '💝']],
];

let FACETS = null;
let PREVIEW = null;      // resultado vigente de 'preview'
let SENDING = false;

async function api(user, payload) {
  return fetch('/api/wa-send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null },
      ...payload,
    }),
  }).then(x => x.json()).catch(() => null);
}

/* v4.93: grupos habilitados (catalogo de la pantalla WhatsApp > Grupos) */
async function apiGroups(user) {
  return fetch('/api/wa-groups', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null },
      action: 'list',
    }),
  }).then(x => x.json()).catch(() => null);
}

function ensureStyles() {
  if (document.getElementById('waSendStyles')) return;
  const st = document.createElement('style');
  st.id = 'waSendStyles';
  st.textContent = `
  .wa-wrap{max-width:1080px}
  .wa-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:16px}
  .wa-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:9px}
  .wa-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .wa-ic{width:30px;height:30px;border-radius:9px;background:#e9fbf0;color:#128c7e;display:grid;place-items:center;flex:none}
  .wa-inst{display:flex;gap:7px;align-items:center;border-radius:999px;padding:5px 13px;font-size:12px;font-weight:700;border:1px solid var(--border);background:var(--surface,#fff);color:var(--muted)}
  .wa-inst.ok{background:#e9fbf0;border-color:#bbf1d2;color:#0f7a4d}
  .wa-inst.bad{background:#fef2f2;border-color:#fecaca;color:#b91c1c}
  .wa-inst .dot{width:8px;height:8px;border-radius:50%;background:currentColor}
  .wa-card{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;padding:16px 18px;margin-bottom:14px}
  .wa-card h3{font-size:13px;margin:0 0 10px;display:flex;align-items:center;gap:8px;color:var(--ink)}
  .wa-card h3 .n{width:20px;height:20px;border-radius:50%;background:var(--accent,#2563eb);color:#fff;display:grid;place-items:center;font-size:11px;font-weight:800}
  .wa-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px}
  .wa-filters label{font-size:11px;font-weight:700;color:var(--ink-soft,#475569);display:block;margin-bottom:3px}
  .wa-filters select{width:100%;font:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink)}
  .wa-orsep{display:flex;align-items:center;gap:10px;margin:12px 0;color:var(--muted);font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em}
  .wa-orsep::before,.wa-orsep::after{content:'';flex:1;height:1px;background:var(--border-soft,#f1f4f8)}
  .wa-frow{display:flex;gap:9px;align-items:flex-end;flex-wrap:wrap}
  .wa-frow>div{flex:1;min-width:180px}
  .wa-frow label{font-size:11px;font-weight:700;color:var(--ink-soft,#475569);display:block;margin-bottom:3px}
  .wa-frow input{width:100%;font:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink)}
  .wa-btn{border:1px solid var(--border);background:var(--surface,#fff);border-radius:10px;padding:9px 16px;font:inherit;font-size:13px;font-weight:600;color:var(--ink-soft,#475569);cursor:pointer;white-space:nowrap}
  .wa-btn.pri{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:#fff}
  .wa-btn.wa{background:#128c7e;border-color:#128c7e;color:#fff;font-weight:700}
  .wa-btn.danger{color:#b91c1c;border-color:#fecaca}
  .wa-btn:disabled{opacity:.5;cursor:default}
  .wa-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:13px 0 10px}
  .wa-kpi{border:1px solid var(--border);border-radius:11px;padding:11px 14px;background:var(--surface,#fff)}
  .wa-kpi small{display:block;font-size:11px;font-weight:700;color:var(--muted)}
  .wa-kpi b{font-size:22px;color:var(--ink)}
  .wa-kpi.ok{border-color:#bbf1d2;background:#e9fbf0}
  .wa-kpi.ok b{color:#0f7a4d}
  .wa-kpi.bad b{color:#b45309}
  .wa-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .wa-table th{padding:7px 10px;background:#fbfcfe;border-bottom:1px solid var(--border);font-size:10.5px;font-weight:800;color:var(--ink-soft,#475569);text-transform:uppercase;letter-spacing:.04em;text-align:left}
  .wa-table td{padding:8px 10px;border-bottom:1px solid var(--border-soft,#f1f4f8);color:var(--ink)}
  .wa-tel{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}
  .wa-chip{display:inline-block;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:800}
  .wa-chip.ok{background:#e9fbf0;color:#0f7a4d;border:1px solid #bbf1d2}
  .wa-chip.no{background:#f1f5f9;color:#64748b;border:1px solid var(--border)}
  .wa-tblnote{font-size:11px;color:var(--muted);margin-top:6px}
  .wa-msg{width:100%;min-height:120px;font:inherit;font-size:13.5px;padding:11px 13px;border:1px solid var(--border);border-radius:11px;resize:vertical;line-height:1.5;background:var(--surface,#fff);color:var(--ink)}
  .wa-msgfoot{display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:11.5px;color:var(--muted);flex-wrap:wrap;gap:6px}
  .wa-msgfoot code{background:#f1f5f9;border-radius:4px;padding:1px 5px}
  .wa-sendrow{display:flex;gap:10px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
  .wa-note{margin-right:auto;font-size:11.5px;color:#92400e;background:var(--warn-bg,#fffbeb);border:1px solid #fde68a;border-radius:9px;padding:7px 11px}
  .wa-confirm{display:flex;gap:9px;align-items:center;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:9px 13px;font-size:12.5px;color:#991b1b;font-weight:600}
  .wa-prog{border:1px solid #bbf1d2;background:#e9fbf0;border-radius:11px;padding:13px 15px;margin-top:12px}
  .wa-prog b{color:#0f7a4d}
  .wa-pbar{height:9px;background:#d3f5e0;border-radius:999px;margin-top:9px;overflow:hidden}
  .wa-pbar>div{height:100%;width:0%;background:#25d366;border-radius:999px;transition:width .3s}
  .wa-pmeta{display:flex;justify-content:space-between;font-size:11.5px;color:var(--ink-soft,#475569);margin-top:6px}
  .wa-errbox{margin-top:10px;border:1px solid #fecaca;background:#fef2f2;border-radius:10px;padding:10px 13px;font-size:12px;color:#991b1b}
  .wa-errbox ul{margin:6px 0 0 18px}
  .wa-emoji-btn{border:1px solid var(--border);background:var(--surface,#fff);border-radius:8px;padding:4px 10px;font:inherit;font-size:12px;font-weight:700;color:var(--ink-soft,#475569);cursor:pointer;margin-right:8px}
  .wa-emoji-btn.open{background:#e9fbf0;border-color:#bbf1d2;color:#0f7a4d}
  .wa-emoji-panel{border:1px solid var(--border);border-radius:11px;background:var(--surface,#fff);padding:10px 12px;margin-top:8px;max-height:240px;overflow-y:auto}
  .wa-emoji-cat{font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:8px 0 3px}
  .wa-emoji-cat:first-child{margin-top:0}
  .wa-emoji-grid{display:flex;flex-wrap:wrap;gap:2px}
  .wa-emoji{border:none;background:transparent;font-size:21px;line-height:1;padding:5px;border-radius:8px;cursor:pointer}
  .wa-emoji:hover{background:#f1f5f9}`;
  document.head.appendChild(st);
}

const compLabel = c => `${c.company_code} · ${c.business_name || ''}`;   // ALIAS PRIMERO

function fillFacets() {
  const f = FACETS;
  $('#waFZone').innerHTML = '<option value="">Todas</option>'
    + f.zones.map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('');
  $('#waFType').innerHTML = '<option value="">Todos</option>'
    + f.types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  $('#waFConcept').innerHTML = '<option value="">Todos</option>'
    + f.concepts.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  $('#waFCompany').innerHTML = '<option value="">Todas</option>'
    + f.companies.map(c => `<option value="${esc(c.company_code)}">${esc(compLabel(c))}</option>`).join('');
  syncSubzones();
}
function syncSubzones() {
  const z = $('#waFZone').value;
  const subs = (FACETS.subzones || []).filter(s => !z || String(s.zone_id) === z);
  $('#waFSubzone').innerHTML = '<option value="">Todas</option>'
    + subs.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
}

function currentFilters() {
  const grpSel = $('#waFGroup');
  const grp = grpSel ? grpSel.value : '';
  if (grp) return { group_id: Number(grp) };     // el grupo manda sobre todo
  const tel = $('#waFTel').value.trim();
  if (tel) return { direct_phone: tel };         // luego el numero directo
  const ced = $('#waFCed').value.trim();
  if (ced) return { id_number: ced };            // la cédula manda sola
  return {
    zone: $('#waFZone').value || null,
    subzone: $('#waFSubzone').value || null,
    type: $('#waFType').value || null,
    concept: $('#waFConcept').value || null,
    company: $('#waFCompany').value || null,
  };
}
function hasAnyFilter(f) { return Object.values(f).some(v => v); }

function invalidatePreview() {
  PREVIEW = null;
  $('#waKpis').innerHTML = '';
  $('#waTbl').innerHTML = '';
  $('#waTblNote').textContent = '';
  syncSendState();
}

function syncSendState() {
  const msg = $('#waMsg').value.trim();
  const ok = !SENDING && PREVIEW && PREVIEW.with_phone > 0 && msg.length > 0 && msg.length <= MAX_MESSAGE;
  const btn = $('#waSendBtn');
  btn.disabled = !ok;
  btn.textContent = PREVIEW && PREVIEW.with_phone > 0
    ? `📤 Enviar a ${nf(PREVIEW.with_phone)} destinatario${PREVIEW.with_phone === 1 ? '' : 's'}`
    : '📤 Enviar';
  $('#waCount').textContent = `${nf(msg.length)} / ${nf(MAX_MESSAGE)}`;
}

function paintPreview() {
  const p = PREVIEW;
  $('#waKpis').innerHTML = `
    <div class="wa-kpi"><small>En el filtro</small><b>${nf(p.total)}</b></div>
    <div class="wa-kpi ok"><small>📱 Con teléfono (recibirán)</small><b>${nf(p.with_phone)}</b></div>
    <div class="wa-kpi bad"><small>Sin teléfono registrado</small><b>${nf(p.without_phone)}</b></div>`;
  const rows = p.rows || [];
  $('#waTbl').innerHTML = !rows.length ? '' : `
    <table class="wa-table">
      <thead><tr><th>Cédula</th><th>Colaborador</th><th>Empresa</th><th>Teléfono</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${esc(r.id_number)}</td>
        <td><b>${esc(r.full_name || '(sin nombre)')}</b></td>
        <td>${esc(r.company_code)} · ${esc(r.company_name || '')}</td>
        <td class="wa-tel">${esc(r.phone || '—')}</td>
        <td>${r.phone_ok ? '<span class="wa-chip ok">Recibirá</span>' : '<span class="wa-chip no">Sin teléfono</span>'}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  $('#waTblNote').textContent = p.total > rows.length
    ? `Muestra de los primeros ${nf(rows.length)} · ordenados: primero los que recibirán.`
    : 'Ordenados: primero los que recibirán.';
}

async function runBatch(user, batchId, totalToSend) {
  const prog = $('#waProg');
  prog.style.display = '';
  const bar = $('#waPbarFill'), meta = $('#waPmeta');
  let sent = 0, errors = 0, remaining = true, safety = 0;
  while (remaining && safety < 2000) {
    safety++;
    const r = await api(user, { action: 'process', batch_id: batchId });
    if (!r || !r.ok) { errors++; break; }
    sent += r.sent; errors += r.errors;
    remaining = !!r.remaining;
    const done = sent + errors;
    bar.style.width = `${Math.min(100, Math.round(done / Math.max(totalToSend, 1) * 100))}%`;
    meta.innerHTML = `<span>${nf(sent)} de ${nf(totalToSend)} enviados${errors ? ` · ${nf(errors)} error${errors === 1 ? '' : 'es'}` : ''}</span>
      <span>${remaining ? 'enviando…' : 'completado'}</span>`;
  }
  bar.style.width = '100%';
  $('#waProgTitle').innerHTML = errors
    ? `<b>Difusión completada con ${nf(errors)} error${errors === 1 ? '' : 'es'}.</b>`
    : '<b>✅ Difusión completada.</b> Todos los mensajes salieron de la línea.';
  if (errors) {
    const st = await api(user, { action: 'status', batch_id: batchId });
    if (st && st.ok && st.errors && st.errors.length) {
      $('#waErrBox').style.display = '';
      $('#waErrBox').innerHTML = `<b>No se pudo enviar a:</b><ul>${st.errors.map(e =>
        `<li>${esc(e.full_name || '')} (${esc(e.phone_raw || '')}) — ${esc((e.error_text || '').slice(0, 120))}</li>`).join('')}</ul>`;
    }
  }
}

export async function renderWaSend(user) {
  ensureStyles();
  PREVIEW = null; SENDING = false;
  const main = document.getElementById('pnlMain');
  main.innerHTML = `<div class="wa-wrap">
    <div class="wa-head">
      <div>
        <h1><span class="wa-ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5 14.2c-.2.6-1.2 1.2-1.7 1.2-.4.1-1 .1-1.6-.1-.4-.1-.9-.3-1.5-.5a11.6 11.6 0 0 1-4.4-3.9c-.3-.5-.8-1.3-.8-2.2 0-.8.4-1.2.6-1.4.2-.2.4-.3.6-.3h.4c.2 0 .3 0 .5.4l.7 1.7c0 .2.1.3 0 .5l-.3.4-.4.4c-.1.1-.2.3-.1.5.1.2.6 1 1.3 1.7.9.8 1.7 1.1 2 1.2.2.1.4.1.5-.1l.6-.8c.2-.2.3-.2.5-.1l1.7.8c.2.1.4.2.4.3.1.1.1.6-.1 1.2Z"/></svg></span>
        Difusión</h1>
        <p>Envía un mensaje de WhatsApp al personal eligiendo destinatarios por estructura o de forma individual.</p>
      </div>
      <span class="wa-inst" id="waInst"><span class="dot"></span> Verificando línea…</span>
    </div>

    <div class="wa-card">
      <h3><span class="n">1</span> ¿A quién va el mensaje?</h3>
      <div class="wa-filters">
        <div><label>Zona</label><select id="waFZone"><option value="">Todas</option></select></div>
        <div><label>Subzona</label><select id="waFSubzone"><option value="">Todas</option></select></div>
        <div><label>Tipo de empresa</label><select id="waFType"><option value="">Todos</option></select></div>
        <div><label>Concepto / Marca</label><select id="waFConcept"><option value="">Todos</option></select></div>
        <div><label>Empresa</label><select id="waFCompany"><option value="">Todas</option></select></div>
      </div>
      <div class="wa-orsep">o un trabajador individual · o un número directo · o un grupo</div>
      <div class="wa-frow">
        <div><label>Cédula</label><input id="waFCed" placeholder="Ej: 12345678 (si la escribes, manda sola)"></div>
        <div><label>Número directo (pruebas / fuera de nómina)</label><input id="waFTel" placeholder="Ej: 0414-1234567 · manda sobre cédula y filtros"></div>
        <div><label>Grupo habilitado (un solo mensaje al grupo)</label><select id="waFGroup"><option value="">— Ninguno —</option></select></div>
        <button class="wa-btn pri" id="waPreview">Ver destinatarios</button>
        <button class="wa-btn" id="waClear">Limpiar</button>
      </div>
      <div class="wa-kpis" id="waKpis"></div>
      <div id="waTbl"></div>
      <div class="wa-tblnote" id="waTblNote"></div>
    </div>

    <div class="wa-card">
      <h3><span class="n">2</span> Mensaje</h3>
      <textarea class="wa-msg" id="waMsg" placeholder="Escribe aquí el mensaje…"></textarea>
      <div class="wa-emoji-panel" id="waEmojiPanel" style="display:none"></div>
      <div class="wa-msgfoot">
        <span><button class="wa-emoji-btn" id="waEmojiBtn" type="button" title="Insertar emoji">😊 Emojis</button>Formato: <code>*negrita*</code> <code>_cursiva_</code> <code>~tachado~</code></span>
        <span id="waCount">0 / ${nf(MAX_MESSAGE)}</span>
      </div>
    </div>

    <div class="wa-card">
      <h3><span class="n">3</span> Enviar</h3>
      <div class="wa-sendrow" id="waSendRow">
        <span class="wa-note">⚠️ Se enviará desde la línea corporativa del grupo. El envío es espaciado (sin ráfagas) y queda registrado con fecha, autor y filtros usados.</span>
        <button class="wa-btn wa" id="waSendBtn" disabled>📤 Enviar</button>
      </div>
      <div class="wa-prog" id="waProg" style="display:none">
        <span id="waProgTitle"><b>Enviando…</b> el envío es progresivo para cuidar la línea; puedes seguir el avance aquí.</span>
        <div class="wa-pbar"><div id="waPbarFill"></div></div>
        <div class="wa-pmeta" id="waPmeta"></div>
      </div>
      <div class="wa-errbox" id="waErrBox" style="display:none"></div>
    </div>
  </div>`;

  // Estado de la línea (diagnóstico; no bloquea la pantalla si falla)
  api(user, { action: 'state' }).then(r => {
    const el = $('#waInst');
    if (r && r.ok && r.state && r.state.stateInstance === 'authorized') {
      el.className = 'wa-inst ok';
      el.innerHTML = '<span class="dot"></span> Línea conectada' + (r.phone ? ' · ' + esc(r.phone) : '');
    } else {
      el.className = 'wa-inst bad';
      el.innerHTML = '<span class="dot"></span> ' + esc((r && r.state && r.state.stateInstance) || 'Línea no disponible');
    }
  });

  // Grupos habilitados para el combo (catalogo de WhatsApp > Grupos)
  apiGroups(user).then(r => {
    const sel = $('#waFGroup');
    if (!sel || !r || !r.ok) return;
    const en = (r.groups || []).filter(g => g.enabled);
    sel.innerHTML = '<option value="">— Ninguno —</option>'
      + en.map(g => `<option value="${g.id}">${esc(g.alias || g.wa_name || g.chat_id)}</option>`).join('');
  });

  // Facets
  const f = await api(user, { action: 'facets' });
  if (!f || !f.ok) {
    main.querySelector('.wa-card h3').insertAdjacentHTML('afterend',
      `<p style="color:#b91c1c;font-size:12.5px">${esc((f && f.error) || 'No se pudieron cargar los filtros.')}</p>`);
    return;
  }
  FACETS = f;
  fillFacets();

  // Listeners
  $('#waFZone').addEventListener('change', () => { syncSubzones(); invalidatePreview(); });
  ['waFSubzone', 'waFType', 'waFConcept', 'waFCompany'].forEach(id =>
    $('#' + id).addEventListener('change', invalidatePreview));
  $('#waFCed').addEventListener('input', invalidatePreview);
  $('#waFTel').addEventListener('input', invalidatePreview);
  $('#waFGroup').addEventListener('change', invalidatePreview);
  $('#waMsg').addEventListener('input', syncSendState);

  // v4.95: picker de emojis (insercion en la posicion del cursor)
  const emPanel = $('#waEmojiPanel');
  emPanel.innerHTML = EMOJI_GROUPS.map(([title, arr]) =>
    `<div class="wa-emoji-cat">${esc(title)}</div><div class="wa-emoji-grid">${arr.map(e =>
      `<button type="button" class="wa-emoji" data-e="${e}" title="${e}">${e}</button>`).join('')}</div>`).join('');
  $('#waEmojiBtn').addEventListener('click', () => {
    const open = emPanel.style.display === 'none';
    emPanel.style.display = open ? '' : 'none';
    $('#waEmojiBtn').classList.toggle('open', open);
  });
  emPanel.addEventListener('click', ev => {
    const b = ev.target.closest('.wa-emoji');
    if (!b) return;
    const ta = $('#waMsg');
    const em = b.dataset.e;
    const s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    const e2 = ta.selectionEnd != null ? ta.selectionEnd : s;
    ta.value = ta.value.slice(0, s) + em + ta.value.slice(e2);
    const pos = s + em.length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    syncSendState();
  });

  $('#waClear').addEventListener('click', () => {
    ['waFZone', 'waFSubzone', 'waFType', 'waFConcept', 'waFCompany'].forEach(id => { $('#' + id).value = ''; });
    $('#waFCed').value = ''; $('#waFTel').value = ''; $('#waFGroup').value = ''; $('#waMsg').value = '';
    syncSubzones(); invalidatePreview();
  });

  $('#waPreview').addEventListener('click', async () => {
    const filters = currentFilters();
    if (!hasAnyFilter(filters)) {
      $('#waTblNote').textContent = 'Elige al menos un filtro o escribe una cédula.';
      return;
    }
    $('#waPreview').disabled = true; $('#waPreview').textContent = 'Buscando…';
    const r = await api(user, { action: 'preview', ...filters });
    $('#waPreview').disabled = false; $('#waPreview').textContent = 'Ver destinatarios';
    if (!r || !r.ok) { $('#waTblNote').textContent = (r && r.error) || 'No se pudo consultar.'; return; }
    PREVIEW = r;
    paintPreview();
    syncSendState();
  });

  const confirmHtml = () => {
    const n = PREVIEW.with_phone;
    const est = n > 20 ? ` Duración estimada: <b>~${Math.max(1, Math.ceil(n * 3.3 / 60))} min</b> — el envío es pausado a propósito para cuidar la línea.` : '';
    return `<div class="wa-confirm">¿Confirmas la difusión a <b>&nbsp;${nf(n)}&nbsp;</b> destinatario${n === 1 ? '' : 's'}? Esta acción no se puede deshacer.${est}</div>
      <button class="wa-btn danger" id="waConfNo">Cancelar</button>
      <button class="wa-btn wa" id="waConfYes">Sí, enviar ahora</button>`;
  };

  $('#waSendBtn').addEventListener('click', () => {
    if (!PREVIEW || SENDING) return;
    // Confirmación inline (sin modales nativos)
    $('#waSendRow').innerHTML = confirmHtml();
    $('#waConfNo').addEventListener('click', () => renderSendRowIdle(user));
    $('#waConfYes').addEventListener('click', () => doSend(user));
  });

  function renderSendRowIdle() {
    $('#waSendRow').innerHTML = `
      <span class="wa-note">⚠️ Se enviará desde la línea corporativa del grupo. El envío es espaciado (sin ráfagas) y queda registrado con fecha, autor y filtros usados.</span>
      <button class="wa-btn wa" id="waSendBtn" disabled>📤 Enviar</button>`;
    $('#waSendBtn').addEventListener('click', () => {
      if (!PREVIEW || SENDING) return;
      $('#waSendRow').innerHTML = confirmHtml();
      $('#waConfNo').addEventListener('click', () => renderSendRowIdle());
      $('#waConfYes').addEventListener('click', () => doSend(user));
    });
    syncSendState();
  }

  async function doSend(user) {
    if (SENDING) return;
    SENDING = true;
    const filters = currentFilters();
    const message = $('#waMsg').value.trim();
    $('#waSendRow').innerHTML = `<span class="wa-note">Creando lote…</span>`;
    const r = await api(user, { action: 'send', ...filters, message });
    if (!r || !r.ok) {
      SENDING = false;
      $('#waSendRow').innerHTML = `<span class="wa-note" style="background:#fef2f2;border-color:#fecaca;color:#991b1b">${esc((r && r.error) || 'No se pudo crear el envío.')}</span>`;
      setTimeout(() => { renderSendRowIdle(); }, 3500);
      return;
    }
    $('#waSendRow').innerHTML = `<span class="wa-note">Lote creado: ${nf(r.queued)} mensajes en cola.</span>`;
    await runBatch(user, r.batch_id, r.queued);
    SENDING = false;
  }
}
