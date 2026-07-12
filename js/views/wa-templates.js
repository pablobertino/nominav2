/* =====================================================================
   js/views/wa-templates.js  →  vista "Mensajes" (WhatsApp > Mensajes)
   Mockups aprobados:
     _PRUEBAS/wa_mensajes_mockup.html        (v0-mock3, credenciales)
     _PRUEBAS/mensajes_alcance_mockup.html   (FASE 1, alcance)

   Catalogo de mensajes de WhatsApp. Cada mensaje tiene comodines que se
   reemplazan con los datos reales al enviar.

   DOS DECISIONES DE DISENO, ambas de Pablo:

   1) SINTAXIS #Nombre, no {{nombre}}. Las plantillas de Avisos YA usan
      #Periodo, #Fecha_Pago... Inventar otra sintaxis aca dejaria el portal
      con dos formas distintas de escribir lo mismo. Se calca el patron de
      Avisos: chips clicables, preview, mismas ideas.

   2) EDICION EN PAGINA, no en modal. El editor tiene textarea largo, chips
      y preview en vivo: apretado en un modal de 580px se usa mal. Se usa el
      patron de Empresas -> fichas: se oculta la lista y se pinta el detalle,
      con un "Volver".

   FASE 1 — MENSAJES POR NATURALEZA (nature):
     credencial -> los 2 de siempre. Los dispara Equipo, llevan clave, NO
                   tienen alcance (el destinatario es el miembro).
     puntual    -> envio manual CON ALCANCE sobre el roster. Lo nuevo.
     ciclo / cumpleanos -> [FASE 2] automaticos.

   EL ALCANCE reusa los 6 filtros de Difusion (zone, subzone, type, concept,
   company, id_number), que el RPC wa_recipients ya resuelve. No se inventa
   vocabulario nuevo.

   EL CONTADOR EN VIVO es la pieza central de la pantalla, no un adorno: hoy
   solo 233 de 2.676 personas activas tienen telefono cargado. Un envio al
   concepto SHOE BOX (612 personas) le llegaria a 3. Sin ver ese numero antes
   de mandar, uno cree que le llego a todos.

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
  cat: {},       // catalogos de alcance (zonas, subzonas, conceptos, tipos, empresas)
  cycle: {},     // fechas del ciclo vigente
  canEdit: false,
  cur: null,     // code en edicion (null = alta)
  orig: '',      // body original (para "Restaurar")
  isNew: false,
  scope: {},     // alcance en edicion
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
const iconOf = t => ICONS[t.code] || (t.nature === 'puntual' ? '📣' : '💬');

/* Las 4 naturalezas y como se agrupan en la lista. El orden importa: primero
   lo que ya existia (credenciales), despues lo nuevo. */
const NATURES = [
  { key: 'credencial', title: 'Credenciales · se envían desde Equipo' },
  { key: 'ciclo',      title: 'Ciclo de nómina · automáticos' },
  { key: 'cumpleanos', title: 'Celebraciones · automáticos' },
  { key: 'puntual',    title: 'Envíos puntuales' },
];

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
  .wt-btn-danger{color:var(--danger,#dc2626);border-color:#f6cccc}
  .wt-btn-danger:hover{background:#fef2f2}
  .wt-btn:disabled{opacity:.5;cursor:default}
  .wt-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;margin-top:14px;overflow:hidden}
  .wt-row{display:flex;gap:14px;align-items:flex-start;padding:15px 18px;border-bottom:1px solid var(--border-soft,#eef0f3)}
  .wt-row:last-child{border-bottom:0}
  .wt-ic{width:38px;height:38px;flex:0 0 auto;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:19px;background:#dbeafe}
  .wt-ic.tk{background:#f3e8ff}
  .wt-ic.pt{background:#e0e7ff}
  .wt-body{flex:1;min-width:0}
  .wt-title{font-weight:650;font-size:14px;color:var(--ink)}
  .wt-text{font-size:12.5px;color:var(--ink-soft,#334155);margin-top:3px;line-height:1.5}
  .wt-meta{font-size:11px;color:var(--faint,#94a3b8);margin-top:7px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .wt-tag{display:inline-block;font-size:10px;font-weight:700;border-radius:999px;padding:2px 8px}
  .tag-eq{color:#1e40af;background:#dbeafe}
  .tag-sec{color:#9a3412;background:#ffedd5}
  .tag-off{color:#64748b;background:#e5e7eb}
  .tag-sc{color:#3730a3;background:#e0e7ff}
  .tag-reach{color:#9a3412;background:#fff7ed}
  .wt-sub{margin:22px 2px 2px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--faint,#94a3b8);display:flex;align-items:center;gap:9px}
  .wt-empty{padding:22px 18px;text-align:center;color:var(--muted);font-size:13px}

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
  .wt-pane{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin-bottom:16px}
  .wt-pane-h{font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px}
  .wt-pane-s{font-size:12px;color:var(--muted);margin:0 0 13px}

  .wt-field{display:flex;flex-direction:column;gap:4px;margin-bottom:14px}
  .wt-field label{font-size:11px;color:var(--muted)}
  .wt-field input,.wt-field textarea,.wt-field select{font:inherit;font-size:13.5px;padding:9px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink)}
  .wt-field textarea{resize:vertical;min-height:240px;line-height:1.65}
  .wt-field input:focus,.wt-field textarea:focus,.wt-field select:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(37,99,235,.10)}
  .wt-vars{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0}
  .wt-varbtn{border:1px solid var(--brand);background:var(--brand-bg,#eff6ff);color:var(--brand);border-radius:999px;padding:3px 10px;font-size:11.5px;font-family:ui-monospace,Menlo,monospace;cursor:pointer}
  .wt-varbtn:hover{background:#dbeafe}
  .wt-varbtn.sec{border-color:#c2410c;background:#fff7ed;color:#9a3412}
  .wt-varbtn.sec:hover{background:#ffedd5}
  .wt-varbtn.cond{border-color:#7c3aed;background:#f5f3ff;color:#6d28d9;font-family:inherit;font-weight:600}
  .wt-varbtn.cond:hover{background:#ede9fe}
  .wt-help{font-size:11px;color:var(--muted);margin-top:5px;line-height:1.5}

  /* ---- alcance ---- */
  .wt-g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:11px}
  @media(max-width:760px){.wt-g3{grid-template-columns:1fr}}
  .wt-chan{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:14px}
  @media(max-width:760px){.wt-chan{grid-template-columns:1fr}}
  .wt-ch{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border);border-radius:10px;padding:11px 12px;cursor:pointer;background:var(--surface)}
  .wt-ch.on{border-color:var(--brand);border-width:2px;padding:10px 11px}
  .wt-ch input{width:16px;height:16px;margin-top:2px;accent-color:var(--brand);flex:none}
  .wt-ch b{font-size:13px;display:block}
  .wt-ch span{font-size:11.5px;color:var(--muted);display:block;margin-top:2px;line-height:1.45}

  /* ---- contador de destinatarios (la pieza clave) ---- */
  .wt-reach{border:1px solid #cfe0ff;background:#eff4ff;border-radius:12px;padding:14px 16px}
  .wt-rtop{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .wt-rbig{font-size:26px;font-weight:800;color:#1e3a8a;font-variant-numeric:tabular-nums;line-height:1}
  .wt-rlbl{font-size:12.5px;color:#1e40af}
  .wt-bar{height:8px;background:#dbeafe;border-radius:99px;margin-top:11px;overflow:hidden;display:flex}
  .wt-bar i{display:block;height:100%}
  .wt-bar .has{background:#16a34a}
  .wt-bar .no{background:#fca5a5}
  .wt-leg{display:flex;gap:16px;margin-top:9px;font-size:11.5px;color:#1e40af;flex-wrap:wrap}
  .wt-leg span{display:flex;align-items:center;gap:6px}
  .wt-dot{width:8px;height:8px;border-radius:99px;flex:none}
  .wt-names{margin-top:11px;padding-top:10px;border-top:1px solid #cfe0ff;font-size:11.5px;color:#1e40af;line-height:1.6}

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

/* ---------- resumen legible del alcance (para la lista) ---------- */
function scopeLabel(sf) {
  const s = sf || {};
  const bits = [];
  const nameOf = (arr, id) => {
    const r = (arr || []).find(x => String(x.id) === String(id));
    return r ? r.name : id;
  };
  if (s.type) bits.push(s.type);
  if (s.zone) bits.push(nameOf(ST.cat.zones, s.zone));
  if (s.subzone) bits.push(nameOf(ST.cat.subzones, s.subzone));
  if (s.concept) bits.push(nameOf(ST.cat.concepts, s.concept));
  if (s.company) bits.push(s.company);
  if (s.id_number) bits.push(`cédula ${s.id_number}`);
  return bits.length ? bits.join(' · ') : 'Todos';
}

const CHAN_LBL = { wa: '💬 WhatsApp', portal: '📋 Portal', 'wa+portal': '💬 WhatsApp + 📋 Portal' };

/* ---------------- lista ---------------- */
function rowHtml(t) {
  const isCred = t.nature === 'credencial';
  return `
    <div class="wt-row">
      <div class="wt-ic${t.code === 'cred_osticket' ? ' tk' : (t.nature === 'puntual' ? ' pt' : '')}">${iconOf(t)}</div>
      <div class="wt-body">
        <div class="wt-title">${esc(t.label)}</div>
        <div class="wt-text">${esc(t.description || '')}</div>
        <div class="wt-meta">
          ${isCred
            ? `<span class="wt-tag tag-eq">Equipo</span>`
            : `<span class="wt-tag tag-eq">${esc(CHAN_LBL[t.channel] || t.channel)}</span>
               <span class="wt-tag tag-sc">${esc(scopeLabel(t.scope_filters))}</span>`}
          ${t.allows_secret ? '<span class="wt-tag tag-sec">🔒 Lleva clave</span>' : ''}
          ${t.is_active ? '' : '<span class="wt-tag tag-off">Inactivo</span>'}
          <span>· ${(t.body || '').length} caracteres</span>
          ${t.updated_by ? `<span>· editado por ${esc(t.updated_by)}</span>` : ''}
        </div>
      </div>
      <div class="wt-acts">
        <button class="wt-btn" data-edit="${esc(t.code)}">${ST.canEdit ? '✎ Editar' : 'Ver'}</button>
      </div>
    </div>`;
}

function listHtml() {
  const byNature = {};
  ST.rows.forEach(t => {
    const n = t.nature || 'puntual';
    (byNature[n] = byNature[n] || []).push(t);
  });

  const secs = NATURES.map(sec => {
    const rows = byNature[sec.key] || [];
    // Las secciones de FASE 2 (ciclo, cumpleanos) todavia no tienen mensajes:
    // no se pintan vacias para no prometer algo que aun no existe.
    if (!rows.length && sec.key !== 'puntual') return '';
    if (sec.key === 'puntual') {
      return `
        <div class="wt-sub">${esc(sec.title)}</div>
        <div class="wt-card">
          ${rows.map(rowHtml).join('')}
          ${ST.canEdit
            ? `<div class="wt-row" style="justify-content:center;padding:20px">
                 <button class="wt-btn wt-btn-primary" id="wtNew">+ Nuevo mensaje</button>
               </div>`
            : (rows.length ? '' : '<div class="wt-empty">No hay mensajes puntuales.</div>')}
        </div>`;
    }
    return `<div class="wt-sub">${esc(sec.title)}</div>
            <div class="wt-card">${rows.map(rowHtml).join('')}</div>`;
  }).join('');

  return `
  <div class="wt-head">
    <div>
      <h1>Mensajes</h1>
      <p>Textos predeterminados de WhatsApp. Los comodines se reemplazan con los datos reales al enviar.</p>
    </div>
  </div>
  ${secs}
  <div class="wt-note">
    <b>Cómo se usa esto en Equipo.</b> Cada mensaje de credenciales se envía en el momento en que su clave existe y
    está en pantalla, que son dos momentos distintos:
    <br>· <b>Credenciales del portal</b> → al crear el miembro, o al tocar <b>Resetear</b>.
    <br>· <b>Credenciales de osTicket</b> → al tocar <b>osTicket</b> (crear o resetear su acceso).
    <br><br>Las claves <b>no se guardan</b>: el mensaje se arma al enviar y en el historial de WhatsApp la clave queda
    enmascarada (<code>••••••••</code>). Un miembro sin teléfono no puede recibir nada: hay que cargarle el número en
    <b>Equipo → Editar</b>.
  </div>`;
}

/* ---------------- editor ---------------- */
function scopePaneHtml(t) {
  const s = ST.scope || {};
  const opt = (arr, sel, lblKey) => (arr || []).map(x =>
    `<option value="${esc(x.id != null ? x.id : x)}"${String(sel || '') === String(x.id != null ? x.id : x) ? ' selected' : ''}>${esc(lblKey ? x[lblKey] : (x.name || x))}</option>`).join('');

  const ch = t.channel || 'wa';
  const hasWa = ch === 'wa' || ch === 'wa+portal';
  const hasPt = ch === 'portal' || ch === 'wa+portal';

  return `
  <div class="wt-pane">
    <div class="wt-pane-h">¿Por dónde sale?</div>
    <p class="wt-pane-s">El portal lo ven quienes entran al sistema. WhatsApp le llega al trabajador.</p>
    <div class="wt-chan">
      <label class="wt-ch${hasPt ? ' on' : ''}" id="wtChPtWrap">
        <input type="checkbox" id="wtChPt"${hasPt ? ' checked' : ''}>
        <span style="flex:1"><b>📋 Portal</b>
          <span>Aparece en la cartelera al entrar. Llega al <b>100%</b> de quienes usan el portal.</span></span>
      </label>
      <label class="wt-ch${hasWa ? ' on' : ''}" id="wtChWaWrap">
        <input type="checkbox" id="wtChWa"${hasWa ? ' checked' : ''}>
        <span style="flex:1"><b>💬 WhatsApp</b>
          <span>Llega al teléfono. Solo a quienes lo tengan cargado.</span></span>
      </label>
    </div>
  </div>

  <div class="wt-pane">
    <div class="wt-pane-h">¿A quién le llega?</div>
    <p class="wt-pane-s">Los mismos filtros de Difusión. Dejá en blanco lo que no quieras acotar.</p>
    <div class="wt-g3">
      <div class="wt-field">
        <label>Tipo</label>
        <select id="wtScType"><option value="">Todos</option>${opt(ST.cat.types, s.type)}</select>
      </div>
      <div class="wt-field">
        <label>Zona</label>
        <select id="wtScZone"><option value="">Todas</option>${opt(ST.cat.zones, s.zone, 'name')}</select>
      </div>
      <div class="wt-field">
        <label>Subzona</label>
        <select id="wtScSub"><option value="">Todas</option></select>
      </div>
    </div>
    <div class="wt-g3">
      <div class="wt-field">
        <label>Concepto</label>
        <select id="wtScCon"><option value="">Todos</option>${opt(ST.cat.concepts, s.concept, 'name')}</select>
      </div>
      <div class="wt-field">
        <label>Tienda</label>
        <select id="wtScComp"><option value="">Todas</option>${(ST.cat.companies || []).map(c =>
          `<option value="${esc(c.company_code)}"${String(s.company || '') === c.company_code ? ' selected' : ''}>${esc(c.company_code)} · ${esc(c.business_name || '')}</option>`).join('')}</select>
      </div>
      <div class="wt-field">
        <label>Persona (cédula)</label>
        <input type="text" id="wtScCed" value="${esc(s.id_number || '')}" placeholder="Ej. 31668004">
      </div>
    </div>

    <div class="wt-reach" id="wtReach">
      <div class="wt-rtop"><span class="wt-rbig">…</span><span class="wt-rlbl">calculando…</span></div>
    </div>
  </div>`;
}

function editorHtml(t) {
  const isCred = t.nature === 'credencial';
  const varsKey = isCred ? t.code : 'puntual';
  const vars = (ST.vars[varsKey] || []).map(v =>
    `<button class="wt-varbtn${v.secret ? ' sec' : ''}" data-v="${esc(v.v)}" title="${esc(v.d)}">${esc(v.v)}${v.secret ? ' 🔒' : ''}</button>`).join('');
  const condBtn = t.code === 'cred_portal'
    ? '<button class="wt-varbtn cond" data-cond="1">＋ Bloque “solo si tiene osTicket”</button>' : '';
  const help = t.code === 'cred_portal'
    ? 'Tocá un comodín para insertarlo. Lo que pongas dentro del bloque <b>#SiOsticket</b> solo se envía a los roles que tienen osTicket; para los demás desaparece solo.'
    : isCred
    ? 'Tocá un comodín para insertarlo donde tengas el cursor.'
    : 'Tocá un comodín para insertarlo. Las fechas del ciclo (<b>#Fecha_Cierre</b>, <b>#Fecha_Pago</b>…) salen del calendario de nómina y se recalculan solas cada quincena: no hay que cargarlas nunca.';

  /* Los dos avisos de clave son DISTINTOS a proposito: los riesgos son
     distintos. La clave del portal caduca al primer ingreso (v5.08); la de
     osTicket no vence nunca. */
  const secTxt = t.code === 'cred_osticket'
    ? 'Este mensaje incluye <b>#ClaveOsticket</b>, y esa clave <b>no vence</b>: una vez enviada, queda viva en el chat. Enviala solo si estás de acuerdo con eso.'
    : 'Este mensaje incluye <b>#Clave</b>. Solo se envía cuando la clave es <b>temporal</b>: el portal obliga a cambiarla al primer ingreso. Si la clave es fija, el envío se bloquea.';

  const ro = ST.canEdit ? '' : ' disabled';

  return `
  <div class="wt-top">
    <button class="wt-back" id="wtBack">← Volver</button>
    <div class="wt-ttl">
      <h1>${ST.isNew ? 'Nuevo mensaje' : esc(t.label)}</h1>
      <p>${ST.isNew ? 'Definí qué dice, a quién le llega y por dónde sale.' : esc(t.description || '')}</p>
    </div>
    <div class="wt-acts">
      <span class="wt-saved" id="wtSaved">✓ Guardado</span>
      ${ST.canEdit ? `
        ${(!ST.isNew && !t.is_system) ? '<button class="wt-btn wt-btn-danger" id="wtDel">Borrar</button>' : ''}
        ${!ST.isNew ? '<button class="wt-btn" id="wtRestore">Restaurar</button>' : ''}
        <button class="wt-btn wt-btn-primary" id="wtSave">${ST.isNew ? 'Crear' : 'Guardar'}</button>` : ''}
    </div>
  </div>

  ${t.allows_secret ? `<div class="wt-banner"><span class="ic">🔒</span><div>${secTxt}</div></div>` : ''}

  <div class="wt-cols">
    <div>
      <div class="wt-pane">
        <div class="wt-pane-h">Contenido</div>
        <div class="wt-field" style="margin-top:11px">
          <label>Nombre ${isCred ? '' : '(interno, para reconocerlo)'}</label>
          <input type="text" id="wtLabel" value="${esc(t.label || '')}" placeholder="Ej. Recordatorio de cierre a tiendas"${ro}>
        </div>
        <div class="wt-field">
          <label>Mensaje</label>
          <textarea id="wtBody" placeholder="Hola #Nombre 👋&#10;&#10;Te recordamos que el cierre de la quincena #Periodo es el #Fecha_Cierre."${ro}>${esc(t.body || '')}</textarea>
          ${ST.canEdit ? `<div class="wt-vars">${vars}${condBtn}</div><div class="wt-help">${help}</div>` : ''}
        </div>
        <p class="wt-err" id="wtErr" style="display:none"></p>
      </div>
      ${isCred ? '' : scopePaneHtml(t)}
    </div>

    <div class="wt-pv">
      <div class="wt-pane">
        <div class="wt-pane-h">Vista previa</div>
        ${isCred ? `
          <select class="wt-sel" id="wtSample" style="margin-top:11px">
            <option value="agent">Ejemplo: Administrador (con osTicket)</option>
            <option value="client">Ejemplo: Gestor de empresa (con osTicket)</option>
            <option value="none">Ejemplo: Supervisor Tiendas (sin osTicket)</option>
          </select>` : '<div style="height:11px"></div>'}
        <div class="wt-phone"><div class="wt-bubble" id="wtPv">…</div></div>
        <div class="wt-pvmeta" id="wtPvMeta"></div>
        ${isCred ? '' : `<div class="wt-pvmeta" style="margin-top:9px">
          Las fechas son las <b>reales</b> del período vigente${ST.cycle.periodo ? ` (${esc(ST.cycle.periodo)})` : ''}.
        </div>`}
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
  const t = curTpl();
  const d = await api({
    action: 'preview', user: userPayload(ST.user),
    code: ST.cur, body: ta.value, sample: sel ? sel.value : 'agent',
    nature: t ? t.nature : 'puntual',
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

/* ---------- contador de destinatarios (en vivo) ----------
   El numero que importa NO es "cuantos caen en el alcance" sino "cuantos van
   a RECIBIR". Hoy solo 233 de 2.676 tienen telefono: un envio al concepto
   SHOE BOX (612 personas) le llega a 3. Sin esto a la vista, uno manda y cree
   que llego. */
let rcTimer = null;
function scheduleReach() {
  clearTimeout(rcTimer);
  rcTimer = setTimeout(doReach, 320);
}
function readScope() {
  const v = id => { const e = $(id); return e ? e.value.trim() : ''; };
  return {
    type: v('#wtScType'), zone: v('#wtScZone'), subzone: v('#wtScSub'),
    concept: v('#wtScCon'), company: v('#wtScComp'),
    id_number: v('#wtScCed').replace(/\D/g, ''),
  };
}
async function doReach() {
  const box = $('#wtReach');
  if (!box) return;
  ST.scope = readScope();
  const d = await api({ action: 'preview_scope', user: userPayload(ST.user), scope: ST.scope });
  if (!d || !d.ok) {
    box.innerHTML = `<div class="wt-rlbl">${esc((d && d.error) || 'No se pudo calcular el alcance.')}</div>`;
    return;
  }
  const total = d.total || 0, wp = d.with_phone || 0, np = d.without_phone || 0;
  const pct = total ? Math.round((wp / total) * 1000) / 10 : 0;
  // Coma decimal: en el resto del portal los numeros van en es-VE ("0,5%"),
  // y un "0.5%" suelto canta como pegado de otro idioma.
  const pctTxt = String(pct).replace('.', ',');
  const wa = $('#wtChWa');
  const waOn = wa ? wa.checked : true;

  const names = (d.sample || []).filter(r => r.phone_ok).slice(0, 4).map(r => r.full_name);
  box.innerHTML = `
    <div class="wt-rtop">
      <span class="wt-rbig">${total.toLocaleString('es-VE')}</span>
      <span class="wt-rlbl">persona${total === 1 ? '' : 's'} en el alcance</span>
    </div>
    <div class="wt-bar">
      <i class="has" style="width:${pct}%"></i><i class="no" style="width:${100 - pct}%"></i>
    </div>
    <div class="wt-leg">
      <span><i class="wt-dot" style="background:#16a34a"></i> <b>${wp.toLocaleString('es-VE')}</b> con teléfono → reciben el WhatsApp</span>
      <span><i class="wt-dot" style="background:#fca5a5"></i> <b>${np.toLocaleString('es-VE')}</b> sin teléfono → no reciben nada</span>
    </div>
    ${names.length ? `<div class="wt-names">Por ejemplo: ${esc(names.join(', '))}${wp > names.length ? `, y ${wp - names.length} más.` : '.'}</div>` : ''}
    ${(waOn && total > 0 && wp === 0)
      ? `<div class="wt-banner" style="margin:11px 0 0"><span class="ic">⚠️</span><div>
           <b>Nadie de este alcance tiene teléfono cargado.</b> Si el mensaje sale solo por WhatsApp,
           no lo va a recibir nadie. Los teléfonos se cargan en <b>Personal → Editar</b>.</div></div>`
      : (waOn && pct > 0 && pct < 25)
      ? `<div class="wt-banner" style="margin:11px 0 0"><span class="ic">⚠️</span><div>
           Solo el <b>${pctTxt}%</b> de este alcance tiene teléfono. El resto no se entera por WhatsApp.</div></div>`
      : ''}`;
}

/* Subzonas dependientes de la zona (si no, se ofrecen subzonas de otra zona
   y el alcance queda vacio sin que se entienda por que). */
function fillSubs(selected) {
  const zEl = $('#wtScZone'), sEl = $('#wtScSub');
  if (!zEl || !sEl) return;
  const z = zEl.value;
  const subs = (ST.cat.subzones || []).filter(s => !z || String(s.zone_id) === String(z));
  sEl.innerHTML = '<option value="">Todas</option>' + subs.map(s =>
    `<option value="${esc(s.id)}"${String(selected || '') === String(s.id) ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
}

function curTpl() {
  if (ST.isNew) {
    return { code: null, label: '', body: '', nature: 'puntual', channel: 'wa',
             scope_filters: {}, allows_secret: false, is_system: false };
  }
  return ST.rows.find(r => r.code === ST.cur) || null;
}

function openEditor(code) {
  const t = code ? ST.rows.find(r => r.code === code) : null;
  ST.isNew = !code;
  ST.cur = code || null;
  const tpl = t || curTpl();
  ST.orig = tpl.body || '';
  ST.scope = { ...(tpl.scope_filters || {}) };

  $('#wtList').style.display = 'none';
  const host = $('#wtEdit');
  host.style.display = '';
  host.innerHTML = editorHtml(tpl);
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
    const rst = $('#wtRestore');
    if (rst) rst.addEventListener('click', () => { $('#wtBody').value = ST.orig; doPreview(); });
    $('#wtSave').addEventListener('click', save);
    const del = $('#wtDel');
    if (del) del.addEventListener('click', doDelete);

    // Alcance (solo en los no-credencial).
    if ($('#wtScZone')) {
      fillSubs(ST.scope.subzone);
      $('#wtScZone').addEventListener('change', () => { fillSubs(null); scheduleReach(); });
      ['#wtScType', '#wtScSub', '#wtScCon', '#wtScComp'].forEach(id =>
        $(id).addEventListener('change', scheduleReach));
      $('#wtScCed').addEventListener('input', scheduleReach);
      // Los canales repintan el aviso ("nadie tiene telefono" solo aplica a WA).
      ['#wtChWa', '#wtChPt'].forEach(id => {
        const e = $(id);
        if (e) e.addEventListener('change', () => {
          const w = e.closest('.wt-ch');
          if (w) w.classList.toggle('on', e.checked);
          doReach();
        });
      });
      doReach();
    }
  }
  doPreview();
}

function backToList() {
  ST.cur = null;
  ST.isNew = false;
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

function readChannel() {
  const wa = $('#wtChWa'), pt = $('#wtChPt');
  if (!wa && !pt) return 'wa';
  const w = wa && wa.checked, p = pt && pt.checked;
  if (w && p) return 'wa+portal';
  if (p) return 'portal';
  return 'wa';
}

async function save() {
  const btn = $('#wtSave');
  const err = $('#wtErr');
  err.style.display = 'none';
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = ST.isNew ? 'Creando…' : 'Guardando…';

  const t = curTpl();
  const isCred = t && t.nature === 'credencial';
  const payload = {
    action: ST.isNew ? 'create' : 'save',
    user: userPayload(ST.user),
    code: ST.cur,
    label: $('#wtLabel').value,
    body: $('#wtBody').value,
  };
  if (!isCred) {
    payload.channel = readChannel();
    payload.scope_filters = readScope();
  }

  const d = await api(payload);
  btn.disabled = false;
  btn.textContent = orig;
  if (!d || !d.ok) {
    err.textContent = (d && d.error) || 'No se pudo guardar.';
    err.style.display = '';
    return;
  }

  if (ST.isNew) {
    await reload();
    backToList();
    return;
  }
  // Refrescar el catalogo en memoria (la lista muestra el largo y el autor).
  const row = ST.rows.find(r => r.code === ST.cur);
  if (row) {
    row.label = $('#wtLabel').value;
    row.body = $('#wtBody').value;
    if (!isCred) { row.channel = payload.channel; row.scope_filters = payload.scope_filters; }
  }
  ST.orig = $('#wtBody').value;
  const s = $('#wtSaved');
  s.style.display = 'inline';
  setTimeout(() => { s.style.display = 'none'; }, 1800);
}

async function doDelete() {
  const err = $('#wtErr');
  const btn = $('#wtDel');
  // Sin confirm() del navegador (regla del portal): se pide confirmacion en el
  // propio boton, que cambia de texto. Dos clics deliberados para borrar.
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = '¿Seguro? Tocá otra vez';
    setTimeout(() => {
      if (btn && btn.dataset.armed === '1') { btn.dataset.armed = '0'; btn.textContent = 'Borrar'; }
    }, 4000);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Borrando…';
  const d = await api({ action: 'delete', user: userPayload(ST.user), code: ST.cur });
  if (!d || !d.ok) {
    btn.disabled = false;
    btn.dataset.armed = '0';
    btn.textContent = 'Borrar';
    err.textContent = (d && d.error) || 'No se pudo borrar.';
    err.style.display = '';
    return;
  }
  await reload();
  backToList();
}

function paintList() {
  $('#wtList').innerHTML = listHtml();
  document.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => openEditor(b.dataset.edit)));
  const nw = $('#wtNew');
  if (nw) nw.addEventListener('click', () => openEditor(null));
}

async function reload() {
  const d = await api({ action: 'list', user: userPayload(ST.user) });
  if (d && d.ok) {
    ST.rows = d.rows || [];
    ST.vars = d.vars || {};
    ST.cat = d.catalogs || {};
    ST.cycle = d.cycle || {};
    ST.canEdit = !!d.can_edit;
  }
}

export async function renderWaTemplates(user) {
  ensureStyles();
  ST.user = user;
  ST.cur = null;
  ST.isNew = false;
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
  ST.cat = d.catalogs || {};
  ST.cycle = d.cycle || {};
  ST.canEdit = !!d.can_edit;
  paintList();

  // Si falta el secret portal_base_url, #LinkPortal saldria vacio en el mensaje.
  // Mejor avisarlo aca que mandarle a la gente un texto con un link en blanco.
  if (d.warn) {
    $('#wtList').insertAdjacentHTML('afterbegin',
      `<div class="wt-banner red"><span class="ic">⚠️</span><div>${esc(d.warn)}</div></div>`);
  }
}
