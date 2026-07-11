/* =====================================================================
   js/views/wa-templates.js  →  vista "Mensajes" (WhatsApp > Mensajes)
   Mockup aprobado: _PRUEBAS/wa_mensajes_mockup.html (v0-mock3).

   Catalogo de mensajes predeterminados de WhatsApp. Cada mensaje tiene
   comodines que se reemplazan con los datos reales al enviar.

   DOS DECISIONES DE DISENO, ambas de Pablo:

   1) SINTAXIS #Nombre, no {{nombre}}. Las plantillas de Avisos YA usan
      #Periodo, #Fecha_Pago... Inventar otra sintaxis aca dejaria el portal
      con dos formas distintas de escribir lo mismo. Se calca el patron de
      Avisos: chips clicables, preview, mismas ideas.

   2) EDICION EN PAGINA, no en modal. El editor tiene textarea largo, chips
      y preview en vivo: apretado en un modal de 580px se usa mal. Se usa el
      patron de Empresas -> fichas: se oculta la lista y se pinta el detalle,
      con un "Volver".

   El motor de plantillas vive en el SERVIDOR (functions/api/wa-templates.js),
   y el preview tambien: si el preview lo armara el front con su propia copia
   del motor, podria mostrar algo distinto de lo que se termina enviando.

   Gates: view.wa.templates (ver) / wa.templates (editar).
   Export: renderWaTemplates(user)
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ST = {
  user: null,
  rows: [],
  vars: {},
  canEdit: false,
  cur: null,     // code en edicion
  orig: '',      // body original (para "Restaurar")
};

async function api(payload) {
  const res = await fetch('/api/wa-templates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}
const userPayload = (u) => ({ kind: u.kind, id: u.id || null, companyCode: u.companyCode || null });

const ICONS = { cred_portal: '🔑', cred_osticket: '🎫' };
const iconOf = c => ICONS[c] || '💬';

function ensureStyles() {
  if (document.getElementById('waTemplatesStyles')) return;
  const st = document.createElement('style');
  st.id = 'waTemplatesStyles';
  st.textContent = `
  .wt-head{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap;margin-bottom:4px}
  .wt-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .wt-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .wt-btn{font:inherit;font-size:13px;padding:9px 15px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);cursor:pointer;display:inline-flex;align-items:center;gap:7px}
  .wt-btn:hover{background:var(--border-soft,#eef0f3)}
  .wt-btn-primary{background:var(--brand);color:#fff;border-color:var(--brand)}
  .wt-btn-primary:hover{filter:brightness(.94)}
  .wt-btn:disabled{opacity:.5;cursor:default}
  .wt-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;margin-top:14px;overflow:hidden}
  .wt-row{display:flex;gap:14px;align-items:flex-start;padding:15px 18px;border-bottom:1px solid var(--border-soft,#eef0f3)}
  .wt-row:last-child{border-bottom:0}
  .wt-ic{width:38px;height:38px;flex:0 0 auto;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:19px;background:#dbeafe}
  .wt-ic.tk{background:#f3e8ff}
  .wt-body{flex:1;min-width:0}
  .wt-title{font-weight:650;font-size:14px;color:var(--ink)}
  .wt-text{font-size:12.5px;color:var(--ink-soft,#334155);margin-top:3px;line-height:1.5}
  .wt-meta{font-size:11px;color:var(--faint,#94a3b8);margin-top:7px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .wt-tag{display:inline-block;font-size:10px;font-weight:700;border-radius:999px;padding:2px 8px}
  .tag-eq{color:#1e40af;background:#dbeafe}
  .tag-sec{color:#9a3412;background:#ffedd5}
  .tag-off{color:#64748b;background:#e5e7eb}
  .wt-sub{margin:22px 2px 2px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--faint,#94a3b8)}

  .wt-top{display:flex;align-items:center;gap:12px;margin-bottom:16px}
  .wt-back{border:1px solid var(--border);background:var(--surface);border-radius:9px;padding:7px 13px;font:inherit;font-size:13px;color:var(--ink-soft,#334155);cursor:pointer}
  .wt-back:hover{background:var(--border-soft,#eef0f3)}
  .wt-ttl{flex:1;min-width:0}
  .wt-ttl h1{margin:0;font-size:20px;font-weight:700;color:var(--ink)}
  .wt-ttl p{margin:2px 0 0;font-size:12.5px;color:var(--muted)}
  .wt-acts{display:flex;gap:8px;align-items:center}
  .wt-saved{font-size:12.5px;color:#15803d;font-weight:600;display:none}

  .wt-cols{display:grid;grid-template-columns:1fr 400px;gap:18px;align-items:start}
  @media(max-width:1000px){.wt-cols{grid-template-columns:1fr}}
  .wt-pane{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px}
  .wt-pane-h{font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:0 0 11px}

  .wt-field{display:flex;flex-direction:column;gap:4px;margin-bottom:14px}
  .wt-field label{font-size:11px;color:var(--muted)}
  .wt-field input,.wt-field textarea{font:inherit;font-size:13.5px;padding:9px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink)}
  .wt-field textarea{resize:vertical;min-height:330px;line-height:1.65}
  .wt-field input:focus,.wt-field textarea:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(37,99,235,.10)}
  .wt-vars{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0}
  .wt-varbtn{border:1px solid var(--brand);background:var(--brand-bg,#eff6ff);color:var(--brand);border-radius:999px;padding:3px 10px;font-size:11.5px;font-family:ui-monospace,Menlo,monospace;cursor:pointer}
  .wt-varbtn:hover{background:#dbeafe}
  .wt-varbtn.sec{border-color:#c2410c;background:#fff7ed;color:#9a3412}
  .wt-varbtn.sec:hover{background:#ffedd5}
  .wt-varbtn.cond{border-color:#7c3aed;background:#f5f3ff;color:#6d28d9;font-family:inherit;font-weight:600}
  .wt-varbtn.cond:hover{background:#ede9fe}
  .wt-help{font-size:11px;color:var(--muted);margin-top:5px;line-height:1.5}

  .wt-pv{position:sticky;top:16px}
  .wt-sel{width:100%;font:inherit;font-size:12px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink-soft,#334155);margin-bottom:12px}
  .wt-phone{background:#e5ddd5;border-radius:14px;padding:14px 12px;background-image:radial-gradient(rgba(0,0,0,.03) 1px,transparent 1px);background-size:14px 14px}
  .wt-bubble{background:#dcf8c6;border-radius:12px 12px 12px 3px;padding:10px 12px;font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;box-shadow:0 1px 1px rgba(0,0,0,.08);color:#0f172a;min-height:40px}
  .wt-pvmeta{margin-top:10px;font-size:11px;color:var(--faint,#94a3b8);line-height:1.5}

  .wt-banner{display:flex;gap:9px;align-items:flex-start;border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.55;margin-bottom:14px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412}
  .wt-banner.red{background:#fef2f2;border-color:#fecaca;color:#991b1b}
  .wt-banner .ic{flex:none}
  .wt-banner b{font-weight:800}
  .wt-note{margin-top:22px;padding:13px 15px;background:#fffdf7;border:1px solid #fde68a;border-radius:11px;font-size:12px;color:#92400e;line-height:1.6}
  .wt-note b{font-weight:800}
  .wt-note code{font-family:ui-monospace,monospace;font-size:11px;background:#fef3c7;padding:1px 4px;border-radius:3px}
  .wt-err{color:var(--danger);font-size:12.5px;margin:10px 0 0}`;
  document.head.appendChild(st);
}

/* ---------------- lista ---------------- */
function listHtml() {
  const rows = ST.rows.map(t => `
    <div class="wt-row">
      <div class="wt-ic${t.code === 'cred_osticket' ? ' tk' : ''}">${iconOf(t.code)}</div>
      <div class="wt-body">
        <div class="wt-title">${esc(t.label)}</div>
        <div class="wt-text">${esc(t.description || '')}</div>
        <div class="wt-meta">
          <span class="wt-tag tag-eq">${esc(t.scope === 'equipo' ? 'Equipo' : t.scope)}</span>
          ${t.allows_secret ? '<span class="wt-tag tag-sec">🔒 Lleva clave</span>' : ''}
          ${t.is_active ? '' : '<span class="wt-tag tag-off">Inactivo</span>'}
          <span>· ${(t.body || '').length} caracteres</span>
          ${t.updated_by ? `<span>· editado por ${esc(t.updated_by)}</span>` : ''}
        </div>
      </div>
      <div class="wt-acts">
        <button class="wt-btn" data-edit="${esc(t.code)}">${ST.canEdit ? '✎ Editar' : 'Ver'}</button>
      </div>
    </div>`).join('');

  return `
  <div class="wt-head">
    <div>
      <h1>Mensajes</h1>
      <p>Textos predeterminados de WhatsApp. Los comodines se reemplazan con los datos reales al enviar.</p>
    </div>
  </div>
  <div class="wt-sub">Credenciales · se envían desde Equipo</div>
  <div class="wt-card">${rows || '<div class="wt-row"><div class="wt-body"><div class="wt-text">No hay mensajes cargados.</div></div></div>'}</div>
  <div class="wt-note">
    <b>Cómo se usa esto en Equipo.</b> Cada mensaje se envía en el momento en que su clave existe y está en pantalla,
    que son dos momentos distintos:
    <br>· <b>Credenciales del portal</b> → al crear el miembro, o al tocar <b>Resetear</b>.
    <br>· <b>Credenciales de osTicket</b> → al tocar <b>osTicket</b> (crear o resetear su acceso).
    <br><br>Las claves <b>no se guardan</b>: el mensaje se arma al enviar y en el historial de WhatsApp la clave queda
    enmascarada (<code>••••••••</code>). Un miembro sin teléfono no puede recibir nada: hay que cargarle el número en
    <b>Equipo → Editar</b>.
  </div>`;
}

/* ---------------- editor (pagina, no modal) ---------------- */
function editorHtml(t) {
  const vars = (ST.vars[t.code] || []).map(v =>
    `<button class="wt-varbtn${v.secret ? ' sec' : ''}" data-v="${esc(v.v)}" title="${esc(v.d)}">${esc(v.v)}${v.secret ? ' 🔒' : ''}</button>`).join('');
  const condBtn = t.code === 'cred_portal'
    ? '<button class="wt-varbtn cond" data-cond="1">＋ Bloque “solo si tiene osTicket”</button>' : '';
  const help = t.code === 'cred_portal'
    ? 'Tocá un comodín para insertarlo. Lo que pongas dentro del bloque <b>#SiOsticket</b> solo se envía a los roles que tienen osTicket; para los demás desaparece solo.'
    : 'Tocá un comodín para insertarlo donde tengas el cursor.';
  /* Los dos avisos son DISTINTOS a proposito: los riesgos son distintos. La
     clave del portal caduca al primer ingreso (v5.08); la de osTicket no
     vence nunca. */
  const secTxt = t.code === 'cred_osticket'
    ? 'Este mensaje incluye <b>#ClaveOsticket</b>, y esa clave <b>no vence</b>: una vez enviada, queda viva en el chat. Enviala solo si estás de acuerdo con eso.'
    : 'Este mensaje incluye <b>#Clave</b>. Solo se envía cuando la clave es <b>temporal</b>: el portal obliga a cambiarla al primer ingreso. Si la clave es fija, el envío se bloquea.';

  const ro = ST.canEdit ? '' : ' disabled';

  return `
  <div class="wt-top">
    <button class="wt-back" id="wtBack">← Volver</button>
    <div class="wt-ttl">
      <h1>${esc(t.label)}</h1>
      <p>${esc(t.description || '')}</p>
    </div>
    <div class="wt-acts">
      <span class="wt-saved" id="wtSaved">✓ Guardado</span>
      ${ST.canEdit ? `
        <button class="wt-btn" id="wtRestore">Restaurar</button>
        <button class="wt-btn wt-btn-primary" id="wtSave">Guardar</button>` : ''}
    </div>
  </div>

  ${t.allows_secret ? `<div class="wt-banner"><span class="ic">🔒</span><div>${secTxt}</div></div>` : ''}

  <div class="wt-cols">
    <div class="wt-pane">
      <div class="wt-pane-h">Contenido</div>
      <div class="wt-field">
        <label>Nombre</label>
        <input type="text" id="wtLabel" value="${esc(t.label)}"${ro}>
      </div>
      <div class="wt-field">
        <label>Mensaje</label>
        <textarea id="wtBody"${ro}>${esc(t.body || '')}</textarea>
        ${ST.canEdit ? `<div class="wt-vars">${vars}${condBtn}</div><div class="wt-help">${help}</div>` : ''}
      </div>
      <p class="wt-err" id="wtErr" style="display:none"></p>
    </div>

    <div class="wt-pv">
      <div class="wt-pane">
        <div class="wt-pane-h">Vista previa</div>
        <select class="wt-sel" id="wtSample">
          <option value="agent">Ejemplo: Administrador (con osTicket)</option>
          <option value="client">Ejemplo: Gestor de empresa (con osTicket)</option>
          <option value="none">Ejemplo: Supervisor Tiendas (sin osTicket)</option>
        </select>
        <div class="wt-phone"><div class="wt-bubble" id="wtPv">…</div></div>
        <div class="wt-pvmeta" id="wtPvMeta"></div>
      </div>
    </div>
  </div>`;
}

/* El preview lo resuelve el SERVIDOR, con el mismo motor que usa el envio. Si
   el front tuviera su propia copia del motor, el preview podria mostrar algo
   distinto de lo que termina llegando. Se debouncea: se dispara con cada tecla. */
let pvTimer = null;
function schedulePreview() {
  clearTimeout(pvTimer);
  pvTimer = setTimeout(doPreview, 280);
}
async function doPreview() {
  const ta = $('#wtBody');
  const box = $('#wtPv');
  if (!ta || !box) return;
  const sel = $('#wtSample');
  const d = await api({
    action: 'preview', user: userPayload(ST.user),
    code: ST.cur, body: ta.value, sample: sel ? sel.value : 'agent',
  });
  if (!d || !d.ok) {
    box.textContent = (d && d.error) || 'No se pudo generar la vista previa.';
    return;
  }
  // El *negrita* de WhatsApp se muestra en negrita: asi se ve como va a llegar.
  box.innerHTML = esc(d.text).replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
  const m = $('#wtPvMeta');
  if (m) m.textContent = `${d.text.length} caracteres`;
}

function openEditor(code) {
  const t = ST.rows.find(r => r.code === code);
  if (!t) return;
  ST.cur = code;
  ST.orig = t.body || '';

  $('#wtList').style.display = 'none';
  const host = $('#wtEdit');
  host.style.display = '';
  host.innerHTML = editorHtml(t);
  window.scrollTo(0, 0);

  $('#wtBack').addEventListener('click', backToList);
  const sel = $('#wtSample');
  if (sel) sel.addEventListener('change', doPreview);

  if (ST.canEdit) {
    $('#wtBody').addEventListener('input', schedulePreview);
    host.querySelectorAll('[data-v]').forEach(b =>
      b.addEventListener('click', () => insert(b.dataset.v)));
    const c = host.querySelector('[data-cond]');
    if (c) c.addEventListener('click', () => insert('\n#SiOsticket\n\n#FinSiOsticket\n'));
    $('#wtRestore').addEventListener('click', () => {
      $('#wtBody').value = ST.orig;
      doPreview();
    });
    $('#wtSave').addEventListener('click', save);
  }
  doPreview();
}

function backToList() {
  ST.cur = null;
  const host = $('#wtEdit');
  host.style.display = 'none';
  host.innerHTML = '';
  $('#wtList').style.display = '';
  paintList();
  window.scrollTo(0, 0);
}

function insert(txt) {
  const ta = $('#wtBody');
  const s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
  const e = ta.selectionEnd != null ? ta.selectionEnd : s;
  ta.value = ta.value.slice(0, s) + txt + ta.value.slice(e);
  const p = s + txt.length;
  ta.focus();
  ta.setSelectionRange(p, p);
  schedulePreview();
}

async function save() {
  const btn = $('#wtSave');
  const err = $('#wtErr');
  err.style.display = 'none';
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Guardando…';
  const d = await api({
    action: 'save', user: userPayload(ST.user),
    code: ST.cur, label: $('#wtLabel').value, body: $('#wtBody').value,
  });
  btn.disabled = false;
  btn.textContent = orig;
  if (!d || !d.ok) {
    err.textContent = (d && d.error) || 'No se pudo guardar.';
    err.style.display = '';
    return;
  }
  // Refrescar el catalogo en memoria (la lista muestra el largo y el autor).
  const t = ST.rows.find(r => r.code === ST.cur);
  if (t) { t.label = $('#wtLabel').value; t.body = $('#wtBody').value; }
  ST.orig = $('#wtBody').value;
  const s = $('#wtSaved');
  s.style.display = 'inline';
  setTimeout(() => { s.style.display = 'none'; }, 1800);
}

function paintList() {
  $('#wtList').innerHTML = listHtml();
  document.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => openEditor(b.dataset.edit)));
}

export async function renderWaTemplates(user) {
  ensureStyles();
  ST.user = user;
  ST.cur = null;
  const main = document.getElementById('pnlMain');
  main.innerHTML = '<div id="wtList"></div><div id="wtEdit" style="display:none"></div>';

  const d = await api({ action: 'list', user: userPayload(user) });
  if (!d || !d.ok) {
    $('#wtList').innerHTML = `<div class="wt-head"><div><h1>Mensajes</h1></div></div>
      <p style="color:var(--danger);font-size:13px;margin-top:14px">${esc((d && d.error) || 'No se pudieron cargar los mensajes.')}</p>`;
    return;
  }
  ST.rows = d.rows || [];
  ST.vars = d.vars || {};
  ST.canEdit = !!d.can_edit;
  paintList();

  // Si falta el secret portal_base_url, #LinkPortal saldria vacio en el mensaje.
  // Mejor avisarlo aca que mandarle a la gente un texto con un link en blanco.
  if (d.warn) {
    $('#wtList').insertAdjacentHTML('afterbegin',
      `<div class="wt-banner red"><span class="ic">⚠️</span><div>${esc(d.warn)}</div></div>`);
  }
}
