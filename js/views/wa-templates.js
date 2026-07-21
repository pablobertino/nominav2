/* =====================================================================
   js/views/wa-templates.js  →  vista "Mensajes" (WhatsApp > Mensajes)
   Mockup aprobado: _PRUEBAS/wa_mensajes_grupos_A_programable.html (v6.56)

   Catalogo de mensajes de WhatsApp A GRUPOS. Cada mensaje tiene comodines de
   FECHAS DEL CICLO que se reemplazan con los datos reales al enviar.

   v6.56 REDISENO "SOLO GRUPOS" (pedido de Pablo). El destino de un mensaje ya
   NO es el roster de personas (@c.us) sino uno o varios GRUPOS de WhatsApp
   (@g.us) donde la linea corporativa (Naima) ya es miembro. Cambios de fondo
   respecto de la version por-personas:
     - Se quita "cumpleanos" (un grupo no cumple anios).
     - Se quita el alcance por persona/cedula/zona (6 filtros) y el contador
       de telefonos. En su lugar, un SELECTOR DE GRUPOS con casillas.
     - Se quitan los comodines #Nombre/#Empresa: en un grupo el mensaje es UNO
       SOLO para todos. Quedan solo las fechas del ciclo.
     - El canal Portal pasa a ser una opcion secundaria ("tambien publicarlo
       en el portal"), no un canal en igualdad con WhatsApp.
     - ALCANCE POR USUARIO: cada quien elige solo los grupos que tiene
       asignados (wa_group_admins); el superadmin, todos. Igual que Difusion.

   Se CONSERVA lo valioso: las fechas del ciclo (se recalculan solas cada
   quincena), la programacion (a mano / fecha del ciclo / fecha fija / cada
   tanto) con la tabla de prevision, y el cron que ya dispara solo.

   DOS DECISIONES DE DISENO previas, que siguen vigentes:
   1) SINTAXIS #Nombre (aca ya solo #Fecha_*), la MISMA de Avisos.
   2) EDICION EN PAGINA, no en modal (textarea largo + chips + preview).

   El motor de plantillas y el preview viven en el SERVIDOR
   (functions/api/wa-templates.js): si el front tuviera su propia copia,
   el preview podria mostrar algo distinto de lo que se termina enviando.

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
  cat: {},        // catalogos (se conservan, ya no se usan para el alcance)
  cycle: {},      // fechas del ciclo vigente
  groups: [],     // v6.56: grupos elegibles del actor [{id, chat_id, wa_name, alias}]
  groupsMode: 'admin',
  canEdit: false,
  cur: null,      // code en edicion (null = alta)
  orig: '',       // body original (para "Restaurar")
  isNew: false,
  selGroups: new Set(),   // v6.56: ids de grupos elegidos en el editor
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
const iconOf = t => ICONS[t.code] || (t.nature === 'ciclo' ? '💬' : '📣');

/* Las naturalezas que se listan en la vista y como se agrupan. El orden
   importa. v6.55: se quito 'credencial'. v6.56: se quito 'cumpleanos' (un
   grupo no cumple anios). Lo que queda es lo util para grupos: envios
   puntuales y programados por el ciclo de nomina. */
const NATURES = [
  { key: 'ciclo',   title: 'Ciclo de nómina · automáticos' },
  { key: 'puntual', title: 'Envíos puntuales' },
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
  .tag-sc{color:#0f7a4d;background:#e9fbf0}
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

  /* ---- v6.56: selector de grupos ---- */
  .wt-gtools{display:flex;gap:9px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
  .wt-search{display:flex;align-items:center;gap:7px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:7px 11px;flex:1;min-width:170px}
  .wt-search input{border:0;outline:0;font:inherit;font-size:13px;width:100%;background:transparent;color:var(--ink)}
  .wt-search svg{color:var(--muted);flex:none}
  .wt-glist{border:1px solid var(--border);border-radius:11px;overflow:hidden}
  .wt-grow{display:flex;align-items:center;gap:11px;padding:11px 13px;border-top:1px solid var(--border-soft,#f1f4f8);cursor:pointer}
  .wt-grow:first-child{border-top:0}
  .wt-grow:hover{background:var(--border-soft,#f8fafc)}
  .wt-grow.on{background:#e9fbf0}
  .wt-grow input{width:17px;height:17px;accent-color:#128c7e;flex:none;cursor:pointer}
  .wt-gav{width:34px;height:34px;border-radius:9px;background:#e9fbf0;color:#128c7e;display:grid;place-items:center;flex:none}
  .wt-gname{font-weight:650;font-size:13.5px;color:var(--ink)}
  .wt-gmeta{font-size:11.5px;color:var(--muted);margin-top:1px}
  .wt-gsum{background:#e9fbf0;border:1px solid #bbf1d2;border-radius:10px;padding:9px 13px;font-size:12.5px;color:#0f7a4d;margin-top:11px}
  .wt-gsum b{color:#0b5e3a}
  .wt-gempty{padding:16px;text-align:center;color:var(--muted);font-size:12.5px}

  /* ---- canal portal (secundario) ---- */
  .wt-chsec{display:flex;gap:10px;align-items:flex-start;border:1px dashed var(--border);border-radius:10px;padding:11px 13px;background:var(--border-soft,#fbfcfe);cursor:pointer}
  .wt-chsec input{width:16px;height:16px;margin-top:2px;accent-color:var(--brand);flex:none}
  .wt-chsec b{font-size:13px;display:block}
  .wt-chsec span{font-size:11.5px;color:var(--muted);display:block;margin-top:2px;line-height:1.45}

  /* ---- FASE 2: programacion ---- */
  .wt-seg{display:inline-flex;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface);flex-wrap:wrap}
  .wt-seg button{border:0;background:var(--surface);padding:8px 13px;font:inherit;font-size:12.5px;font-weight:600;color:var(--muted);cursor:pointer;border-right:1px solid var(--border)}
  .wt-seg button:last-child{border-right:0}
  .wt-seg button.on{background:var(--brand);color:#fff}
  .wt-g2{display:grid;grid-template-columns:1fr 1fr;gap:11px}
  @media(max-width:760px){.wt-g2{grid-template-columns:1fr}}
  .wt-tl{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:11px}
  .wt-tl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint,#94a3b8);padding:7px 9px;border-bottom:1px solid var(--border)}
  .wt-tl td{padding:8px 9px;border-bottom:1px solid var(--border-soft,#f1f4f8)}
  .wt-tl tr:last-child td{border-bottom:0}
  .wt-tl tr.past{opacity:.5}
  .wt-tl .next{color:var(--brand);font-weight:700}
  .wt-tag2{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;background:#dbeafe;color:#1e40af}
  .wt-runbox{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--border-soft,#f1f4f8)}
  .wt-runst{font-size:11.5px;color:var(--muted)}
  .wt-runst b.ok{color:#15803d}
  .wt-runst b.err{color:var(--danger,#dc2626)}

  .wt-pv{position:sticky;top:16px}
  .wt-phone{background:#e5ddd5;border-radius:14px;padding:14px 12px;background-image:radial-gradient(rgba(0,0,0,.03) 1px,transparent 1px);background-size:14px 14px}
  .wt-pvgh{display:flex;align-items:center;gap:8px;margin-bottom:9px}
  .wt-pvgav{width:26px;height:26px;border-radius:50%;background:#128c7e;color:#fff;display:grid;place-items:center;font-size:12px;flex:none}
  .wt-pvgn{font-size:12px;font-weight:700;color:#0b5e3a;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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

/* ---------- resumen legible de los grupos destino (para la lista) ---------- */
function groupsLabel(t) {
  const ids = Array.isArray(t.group_ids) ? t.group_ids : [];
  if (!ids.length) return 'Sin grupos';
  const names = ids.map(id => {
    const g = ST.groups.find(x => Number(x.id) === Number(id));
    return g ? (g.alias || g.wa_name || g.chat_id) : null;
  }).filter(Boolean);
  if (!names.length) return `${ids.length} grupo${ids.length === 1 ? '' : 's'}`;
  if (names.length <= 2) return names.join(' · ');
  return `${names.slice(0, 2).join(' · ')} +${names.length - 2}`;
}

const CHAN_LBL = { wa: '💬 Grupos', portal: '📋 Portal', 'wa+portal': '💬 Grupos + 📋 Portal' };

/* ---------------- lista ---------------- */
function rowHtml(t) {
  return `
    <div class="wt-row">
      <div class="wt-ic${t.nature === 'puntual' ? ' pt' : ''}">${iconOf(t)}</div>
      <div class="wt-body">
        <div class="wt-title">${esc(t.label)}</div>
        <div class="wt-text">${esc(t.description || '')}</div>
        <div class="wt-meta">
          <span class="wt-tag tag-eq">${esc(CHAN_LBL[t.channel] || t.channel)}</span>
          <span class="wt-tag tag-sc">${esc(groupsLabel(t))}</span>
          ${(t.trigger_kind && t.trigger_kind !== 'manual')
            ? `<span class="wt-tag tag-reach">${esc(triggerLabel(t))}</span>` : ''}
          ${t.is_active ? '' : '<span class="wt-tag tag-off">Inactivo</span>'}
          <span>· ${(t.body || '').length} caracteres</span>
          ${(t.last_status === 'error')
            ? '<span class="wt-tag tag-off" style="color:#991b1b;background:#fee2e2">⚠ Última corrida falló</span>' : ''}
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
    // v6.56: los mensajes de sistema (credenciales) no se listan aca.
    if (t.is_system || t.nature === 'credencial') return;
    const n = t.nature || 'puntual';
    (byNature[n] = byNature[n] || []).push(t);
  });

  const secs = NATURES.map(sec => {
    const rows = byNature[sec.key] || [];
    // La seccion 'ciclo' no se pinta vacia (para no prometer algo que aun no
    // existe); 'puntual' siempre se pinta porque lleva el boton "+ Nuevo".
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
      <p>Mensajes de WhatsApp que se envían a los grupos. Las fechas del ciclo se reemplazan con los datos reales al enviar.</p>
    </div>
  </div>
  ${secs}
  <div class="wt-note">
    <b>Cómo funcionan estos mensajes.</b> Cada mensaje va a uno o varios <b>grupos de WhatsApp</b> donde la línea ya
    está adentro. Podés usar comodines de fecha (por ejemplo <code>#Fecha_Cierre</code> o <code>#Fecha_Pago</code>)
    que se reemplazan con las fechas reales del período vigente: salen del calendario de nómina y se recalculan solas
    cada quincena, no hay que cargarlas a mano.
    <br><br>Un envío puede salir <b>a mano</b> (al toque) o <b>programado</b> (en una fecha del ciclo, una fecha fija o
    cada cierto tiempo), y en ese caso se dispara solo. En un grupo el mensaje es <b>uno solo para todos</b>, por eso no
    hay comodines personales como #Nombre.
  </div>`;
}

/* ---------------- editor: selector de grupos (v6.56) ---------------- */
function groupMeta(g) {
  // v6.56.1: conteo de miembros si el discover ya lo trajo (participants).
  // Si aun no se sincronizo, se cae al texto generico (mejor que "0").
  const n = g.participants;
  return (n != null && Number.isFinite(Number(n)))
    ? `${Number(n).toLocaleString('es-VE')} miembro${Number(n) === 1 ? '' : 's'}`
    : 'Grupo de WhatsApp';
}

function groupsPaneHtml() {
  const gs = ST.groups || [];
  const rows = gs.map(g => {
    const on = ST.selGroups.has(Number(g.id));
    const name = g.alias || g.wa_name || g.chat_id;
    return `
      <label class="wt-grow${on ? ' on' : ''}" data-grp="${esc(g.id)}">
        <input type="checkbox" data-gchk="${esc(g.id)}"${on ? ' checked' : ''}${ST.canEdit ? '' : ' disabled'}>
        <span class="wt-gav"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
        <div style="min-width:0"><div class="wt-gname">${esc(name)}</div><div class="wt-gmeta">${esc(groupMeta(g))}</div></div>
      </label>`;
  }).join('');

  const tools = (gs.length > 4 && ST.canEdit)
    ? `<div class="wt-gtools">
         <div class="wt-search">
           <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
           <input id="wtGSearch" placeholder="Buscar grupo…">
         </div>
         <button type="button" class="wt-btn" id="wtGAll" style="padding:7px 12px">Marcar todos</button>
       </div>`
    : '';

  const sub = ST.groupsMode === 'admin'
    ? 'Solo se muestran los grupos que tenés asignados.'
    : 'Podés elegir uno o varios. La línea ya está dentro de estos grupos.';

  return `
  <div class="wt-pane">
    <div class="wt-pane-h">¿A qué grupos va?</div>
    <p class="wt-pane-s">${sub}</p>
    ${gs.length ? tools + `<div class="wt-glist" id="wtGList">${rows}</div>` +
      `<div class="wt-gsum" id="wtGSum"></div>`
      : `<div class="wt-gempty">No tenés grupos asignados. Pedile al superadministrador que te autorice en la pantalla <b>Grupos</b>.</div>`}
  </div>

  <div class="wt-pane">
    <div class="wt-pane-h">¿También publicarlo en el portal?</div>
    <p class="wt-pane-s">Opcional. Además de mandarlo a los grupos, puede aparecer en la cartelera de Avisos.</p>
    <label class="wt-chsec" id="wtChPtWrap">
      <input type="checkbox" id="wtChPt">
      <span style="flex:1"><b>📋 Publicar también en el portal</b>
        <span>Aparece en la cartelera al entrar al sistema. Por defecto el mensaje va solo a los grupos de WhatsApp.</span></span>
    </label>
  </div>`;
}

/* ---------- FASE 2: panel "¿Cuándo sale?" ---------- */
const TRIGGERS = [
  { k: 'manual', lbl: 'A mano' },
  { k: 'cycle',  lbl: 'Fecha del ciclo' },
  { k: 'date',   lbl: 'Fecha fija' },
  { k: 'every',  lbl: 'Cada tanto' },
];
const CYCLE_FIELDS = [
  { v: 'cutoff_date',     lbl: 'Cierre de la quincena' },
  { v: 'report_deadline', lbl: 'Límite para cargar reportes' },
  { v: 'milestone_date',  lbl: 'Día del cálculo' },
  { v: 'pay_date',        lbl: 'Día del pago' },
  { v: 'claim_deadline',  lbl: 'Límite de reclamos' },
];
const OFFSETS = [
  { v: -3, lbl: '3 días antes' }, { v: -2, lbl: '2 días antes' },
  { v: -1, lbl: '1 día antes' },  { v: 0,  lbl: 'El mismo día' },
  { v: 1,  lbl: '1 día después' },
];

function triggerLabel(t) {
  if (t.trigger_kind === 'cycle') {
    const f = CYCLE_FIELDS.find(x => x.v === t.cycle_field);
    const o = OFFSETS.find(x => x.v === t.cycle_offset);
    return `⚡ ${(o ? o.lbl : t.cycle_offset + ' días')} · ${f ? f.lbl.toLowerCase() : t.cycle_field}`;
  }
  if (t.trigger_kind === 'date') return `⚡ El ${esc(String(t.trigger_date || '').slice(0, 10))}`;
  if (t.trigger_kind === 'every') return `⚡ Cada ${t.trigger_every_days} día${t.trigger_every_days === 1 ? '' : 's'}`;
  return 'A mano';
}

function schedPaneHtml(t) {
  const k = t.trigger_kind || 'manual';
  const hours = Array.from({ length: 24 }, (_, i) => i);
  return `
  <div class="wt-pane">
    <div class="wt-pane-h">¿Cuándo sale?</div>
    <p class="wt-pane-s">Puede ser un envío a mano (al toque), o programado para que salga solo.</p>

    <div class="wt-seg" id="wtTrg">
      ${TRIGGERS.map(x => `<button type="button" data-trg="${x.k}" class="${k === x.k ? 'on' : ''}">${x.lbl}</button>`).join('')}
    </div>

    <!-- a mano -->
    <div id="wtTrgManual" style="margin-top:14px;${k === 'manual' ? '' : 'display:none'}">
      <div class="wt-banner" style="background:#e9fbf0;border-color:#bbf1d2;color:#0f7a4d;margin:0">
        <span class="ic">📤</span>
        <div><b>Envío a mano.</b> Este mensaje no sale solo: se manda cuando vos toques
        <b>Enviar ahora</b>${ST.isNew ? ' (disponible una vez creado)' : ''}. Útil para un aviso puntual.</div>
      </div>
    </div>

    <!-- ciclo -->
    <div id="wtTrgCycle" style="margin-top:14px;${k === 'cycle' ? '' : 'display:none'}">
      <div class="wt-g2">
        <div class="wt-field" style="margin-bottom:0">
          <label>Hito del ciclo de nómina</label>
          <select id="wtCycField">${CYCLE_FIELDS.map(f =>
            `<option value="${f.v}"${t.cycle_field === f.v ? ' selected' : ''}>${f.lbl}</option>`).join('')}</select>
        </div>
        <div class="wt-field" style="margin-bottom:0">
          <label>Cuándo, respecto de esa fecha</label>
          <select id="wtCycOff">${OFFSETS.map(o =>
            `<option value="${o.v}"${Number(t.cycle_offset || 0) === o.v ? ' selected' : ''}>${o.lbl}</option>`).join('')}</select>
        </div>
      </div>
      <div id="wtSched"></div>
      <div class="wt-help" style="margin-top:8px">
        Las fechas salen del calendario de nómina y se recalculan solas cada quincena.
        <b>No hay que cargarlas a mano nunca.</b>
      </div>
      <div class="wt-banner" style="background:#e9fbf0;border-color:#bbf1d2;color:#0f7a4d;margin:12px 0 0">
        <span class="ic">🔁</span>
        <div><b>Sale solo, quincena tras quincena.</b> Una vez programado, se dispara automáticamente en la fecha
        calculada de cada período, con las fechas ya actualizadas.
        <span id="wtPortalRepl" style="display:none"> Si además va al portal, el aviso de la quincena pasada se archiva
        y queda solo el vigente; los avisos que creaste a mano no se tocan.</span></div>
      </div>
    </div>

    <!-- fecha fija -->
    <div id="wtTrgDate" class="wt-field" style="margin:14px 0 0;${k === 'date' ? '' : 'display:none'}">
      <label>Día del envío</label>
      <input type="date" id="wtTrgDateV" value="${esc(String(t.trigger_date || '').slice(0, 10))}">
    </div>

    <!-- cada tanto -->
    <div id="wtTrgEvery" class="wt-field" style="margin:14px 0 0;${k === 'every' ? '' : 'display:none'}">
      <label>Cada cuántos días</label>
      <input type="number" id="wtTrgEveryV" min="1" max="365" value="${Number(t.trigger_every_days) || 15}">
      <div class="wt-help">15 = cada quincena aproximada. Para las fechas exactas de nómina, usá <b>Fecha del ciclo</b>.</div>
    </div>

    <!-- hora (para todos los automáticos) -->
    <div id="wtTrgHour" class="wt-field" style="margin:14px 0 0;max-width:220px;${k === 'manual' ? 'display:none' : ''}">
      <label>A partir de qué hora</label>
      <select id="wtTrgHourV">${hours.map(h =>
        `<option value="${h}"${Number(t.trigger_hour != null ? t.trigger_hour : 8) === h ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select>
      <div class="wt-help">Hora de Venezuela. El sistema revisa cada 15 minutos, así que puede salir hasta 15 min después.</div>
    </div>

    ${(!ST.isNew) ? `
      <div class="wt-runbox">
        <button class="wt-btn" id="wtRun">▶ Enviar ahora${t.trigger_kind === 'manual' ? '' : ' (probar)'}</button>
        <span class="wt-runst" id="wtRunSt">${t.last_status
          ? (t.last_status === 'running'
              ? '⏳ Corriendo… (si queda colgada, se reintenta sola)'
              : `Última corrida: <b class="${t.last_status === 'ok' ? 'ok' : 'err'}">${t.last_status === 'ok' ? 'OK' : 'con errores'}</b>`
                + (t.last_sent != null ? ` · ${t.last_sent} grupo${t.last_sent === 1 ? '' : 's'}` : '')
                + (t.last_fire_on ? ` · ${esc(String(t.last_fire_on).slice(0, 10))}` : '')
                + (t.last_error ? ` · ${esc(t.last_error)}` : ''))
          : 'Todavía no corrió.'}</span>
      </div>
      ${t.trigger_kind !== 'manual' ? `<div class="wt-help" style="margin-top:8px">
        Si un envío automático falla o queda colgado, el sistema <b>lo reintenta solo</b> a los
        ${Number(t.retry_minutes) || 20} minutos. Sin esto, un mensaje atado a una fecha del ciclo se
        saltaría la quincena entera si justo ese día algo fallaba.
      </div>` : ''}` : ''}
  </div>`;
}

function editorHtml(t) {
  const vars = (ST.vars.puntual || []).map(v =>
    `<button class="wt-varbtn" data-v="${esc(v.v)}" title="${esc(v.d)}">${esc(v.v)}</button>`).join('');
  const help = 'Tocá un comodín para insertarlo. Las fechas del ciclo (<b>#Fecha_Cierre</b>, <b>#Fecha_Pago</b>…) '
    + 'salen del calendario de nómina y se recalculan solas cada quincena: no hay que cargarlas nunca. '
    + '<b>En un grupo el mensaje es uno solo para todos</b>, por eso no hay #Nombre ni #Empresa.';

  const ro = ST.canEdit ? '' : ' disabled';
  const firstGroup = ST.groups[0];
  const pvGroupName = firstGroup ? (firstGroup.alias || firstGroup.wa_name || firstGroup.chat_id) : 'Grupo de WhatsApp';
  const pvInitial = (pvGroupName || 'G').trim().charAt(0).toUpperCase();

  return `
  <div class="wt-top">
    <button class="wt-back" id="wtBack">← Volver</button>
    <div class="wt-ttl">
      <h1>${ST.isNew ? 'Nuevo mensaje' : esc(t.label)}</h1>
      <p>${ST.isNew ? 'Elegí a qué grupos va, qué dice y cuándo sale.' : esc(t.description || '')}</p>
    </div>
    <div class="wt-acts">
      <span class="wt-saved" id="wtSaved">✓ Guardado</span>
      ${ST.canEdit ? `
        ${(!ST.isNew && !t.is_system) ? '<button class="wt-btn wt-btn-danger" id="wtDel">Borrar</button>' : ''}
        ${!ST.isNew ? '<button class="wt-btn" id="wtRestore">Restaurar</button>' : ''}
        <button class="wt-btn wt-btn-primary" id="wtSave">${ST.isNew ? 'Crear' : 'Guardar'}</button>` : ''}
    </div>
  </div>

  <div class="wt-cols">
    <div>
      <div class="wt-pane">
        <div class="wt-pane-h">Contenido</div>
        <div class="wt-field" style="margin-top:11px">
          <label>Nombre (interno, para reconocerlo)</label>
          <input type="text" id="wtLabel" value="${esc(t.label || '')}" placeholder="Ej. Recordatorio de cierre a los grupos de nómina"${ro}>
        </div>
        <div class="wt-field">
          <label>Mensaje</label>
          <textarea id="wtBody" placeholder="*Recordatorio de nómina* 📌&#10;&#10;El cierre de la quincena #Periodo es el #Fecha_Cierre."${ro}>${esc(t.body || '')}</textarea>
          ${ST.canEdit ? `<div class="wt-vars">${vars}</div><div class="wt-help">${help}</div>` : ''}
        </div>
        <p class="wt-err" id="wtErr" style="display:none"></p>
      </div>
      ${groupsPaneHtml()}
      ${schedPaneHtml(t)}
    </div>

    <div class="wt-pv">
      <div class="wt-pane">
        <div class="wt-pane-h">Vista previa</div>
        <div style="height:11px"></div>
        <div class="wt-phone">
          <div class="wt-pvgh">
            <span class="wt-pvgav">${esc(pvInitial)}</span>
            <span class="wt-pvgn" id="wtPvGn">${esc(pvGroupName)}</span>
          </div>
          <div class="wt-bubble" id="wtPv">…</div>
        </div>
        <div class="wt-pvmeta" id="wtPvMeta"></div>
        <div class="wt-pvmeta" style="margin-top:9px">
          Las fechas son las <b>reales</b> del período vigente${ST.cycle.periodo ? ` (${esc(ST.cycle.periodo)})` : ''}. Así se ve tal como llega al grupo.
        </div>
      </div>
    </div>
  </div>`;
}

/* El preview lo resuelve el SERVIDOR, con el mismo motor que usa el envio. Si
   el front tuviera su propia copia del motor, el preview podria mostrar algo
   distinto de lo que termina llegando. Se debouncea con cada tecla. */
let pvTimer = null;
function schedulePreview() {
  clearTimeout(pvTimer);
  pvTimer = setTimeout(doPreview, 280);
}
async function doPreview() {
  const ta = $('#wtBody');
  const box = $('#wtPv');
  if (!ta || !box) return;
  const t = curTpl();
  const d = await api({
    action: 'preview', user: userPayload(ST.user),
    code: ST.cur, body: ta.value,
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

/* ---------- v6.56: selector de grupos (reemplaza el contador de alcance) ---- */
function paintGroupSum() {
  const box = $('#wtGSum');
  if (!box) return;
  const n = ST.selGroups.size;
  if (!n) {
    box.style.background = '#fff7ed';
    box.style.borderColor = '#fed7aa';
    box.style.color = '#9a3412';
    box.innerHTML = '⚠️ No elegiste ningún grupo todavía.';
    return;
  }
  box.style.background = '#e9fbf0';
  box.style.borderColor = '#bbf1d2';
  box.style.color = '#0f7a4d';
  box.innerHTML = `✓ Seleccionado${n === 1 ? '' : 's'} <b>${n} grupo${n === 1 ? '' : 's'}</b>.`;
}

function toggleGroup(id, on) {
  const n = Number(id);
  if (on) ST.selGroups.add(n); else ST.selGroups.delete(n);
  const row = document.querySelector(`.wt-grow[data-grp="${id}"]`);
  if (row) row.classList.toggle('on', on);
  paintGroupSum();
}

function curTpl() {
  if (ST.isNew) {
    return { code: null, label: '', body: '', nature: 'puntual', channel: 'wa',
             group_ids: [], is_system: false,
             trigger_kind: 'manual', cycle_offset: 0, trigger_hour: 8 };
  }
  return ST.rows.find(r => r.code === ST.cur) || null;
}

/* FASE 2: la previsión de disparos. Cuando se elige "2 días antes del límite
   de reportes", muestra CUÁNDO saldría de verdad, quincena por quincena. */
let schTimer = null;
function scheduleSched() {
  clearTimeout(schTimer);
  schTimer = setTimeout(doSched, 260);
}
async function doSched() {
  const box = $('#wtSched');
  const f = $('#wtCycField'), o = $('#wtCycOff');
  if (!box || !f || !o) return;
  const d = await api({
    action: 'preview_schedule', user: userPayload(ST.user),
    cycle_field: f.value, cycle_offset: Number(o.value),
  });
  if (!d || !d.ok || !(d.rows || []).length) {
    box.innerHTML = `<div class="wt-help" style="margin-top:10px">${esc((d && d.error) || 'No hay períodos cargados hacia adelante.')}</div>`;
    return;
  }
  const nextIx = d.rows.findIndex(r => !r.past);
  box.innerHTML = `
    <table class="wt-tl">
      <thead><tr><th>Período</th><th>Fecha del hito</th><th>Este mensaje saldría</th></tr></thead>
      <tbody>${d.rows.map((r, i) => `
        <tr class="${r.past ? 'past' : ''}">
          <td>${esc(r.period)}</td>
          <td>${esc(r.target_txt)}</td>
          <td>${r.past
            ? `<b>${esc(r.fire_txt)}</b> · ya pasó`
            : `<b class="${i === nextIx ? 'next' : ''}">${esc(r.fire_txt)}</b>${i === nextIx ? ' <span class="wt-tag2">próximo</span>' : ''}`}</td>
        </tr>`).join('')}</tbody>
    </table>`;
}

/* Correr la regla AHORA. Delega en el mismo endpoint que golpea el cron: no
   hay un "modo prueba" que se comporte distinto del real. Para un mensaje
   'a mano', esto ES el envio (no una prueba). */
async function runNow() {
  const btn = $('#wtRun');
  const st = $('#wtRunSt');
  if (!btn) return;
  const t = curTpl();
  const isManual = t && t.trigger_kind === 'manual';
  const armedTxt = isManual ? '¿Seguro? Envía a los grupos' : '¿Seguro? Envía de verdad';
  const idleTxt = isManual ? '▶ Enviar ahora' : '▶ Enviar ahora (probar)';
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = armedTxt;
    setTimeout(() => {
      if (btn && btn.dataset.armed === '1') { btn.dataset.armed = '0'; btn.textContent = idleTxt; }
    }, 4000);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  const d = await api({ action: 'run_now', user: userPayload(ST.user), code: ST.cur });
  btn.disabled = false;
  btn.dataset.armed = '0';
  btn.textContent = idleTxt;
  if (!d || !d.ok) {
    st.innerHTML = `<b class="err">${esc((d && d.error) || 'Falló.')}</b>`;
    return;
  }
  const bits = [];
  if (d.sent) bits.push(`${d.sent} grupo${d.sent === 1 ? '' : 's'}`);
  if (d.errors) bits.push(`${d.errors} con error`);
  if (d.announcement_id) bits.push('aviso publicado en el portal');
  if (!bits.length) bits.push(d.note || 'no había grupos a los que enviar');
  st.innerHTML = `<b class="${d.errors ? 'err' : 'ok'}">${esc(bits.join(' · '))}</b>`;
  await reload();
}

function openEditor(code) {
  const t = code ? ST.rows.find(r => r.code === code) : null;
  ST.isNew = !code;
  ST.cur = code || null;
  const tpl = t || curTpl();
  ST.orig = tpl.body || '';
  // Grupos seleccionados: los de la plantilla, acotados a los elegibles del
  // actor (por si le revocaron alguno desde que se creo la regla).
  const eligible = new Set(ST.groups.map(g => Number(g.id)));
  ST.selGroups = new Set((tpl.group_ids || []).map(Number).filter(id => eligible.has(id)));

  $('#wtList').style.display = 'none';
  const host = $('#wtEdit');
  host.style.display = '';
  host.innerHTML = editorHtml(tpl);
  window.scrollTo(0, 0);

  $('#wtBack').addEventListener('click', backToList);

  if (ST.canEdit) {
    $('#wtBody').addEventListener('input', schedulePreview);
    host.querySelectorAll('[data-v]').forEach(b =>
      b.addEventListener('click', () => insert(b.dataset.v)));
    const rst = $('#wtRestore');
    if (rst) rst.addEventListener('click', () => { $('#wtBody').value = ST.orig; doPreview(); });
    $('#wtSave').addEventListener('click', save);
    const del = $('#wtDel');
    if (del) del.addEventListener('click', doDelete);

    // Selector de grupos.
    const gl = $('#wtGList');
    if (gl) {
      gl.querySelectorAll('[data-gchk]').forEach(c =>
        c.addEventListener('change', () => toggleGroup(c.dataset.gchk, c.checked)));
      const all = $('#wtGAll');
      if (all) all.addEventListener('click', () => {
        const anyOff = ST.groups.some(g => !ST.selGroups.has(Number(g.id)));
        ST.groups.forEach(g => toggleGroup(g.id, anyOff));
        gl.querySelectorAll('[data-gchk]').forEach(c => {
          c.checked = ST.selGroups.has(Number(c.dataset.gchk));
        });
      });
      const sr = $('#wtGSearch');
      if (sr) sr.addEventListener('input', () => {
        const q = sr.value.trim().toLowerCase();
        gl.querySelectorAll('.wt-grow').forEach(row => {
          const nm = (row.querySelector('.wt-gname').textContent || '').toLowerCase();
          row.style.display = (!q || nm.includes(q)) ? '' : 'none';
        });
      });
    }
    paintGroupSum();

    // Canal Portal (checkbox secundario): al activarlo, el banner de "sale
    // solo" menciona el reemplazo del aviso.
    const pt = $('#wtChPt');
    if (pt) {
      pt.checked = (tpl.channel === 'portal' || tpl.channel === 'wa+portal');
      const syncPortalNote = () => {
        const w = pt.closest('.wt-chsec'); if (w) w.classList.toggle('on', pt.checked);
        const rep = $('#wtPortalRepl'); if (rep) rep.style.display = pt.checked ? '' : 'none';
      };
      pt.addEventListener('change', syncPortalNote);
      syncPortalNote();
    }

    // Programacion.
    const seg = $('#wtTrg');
    if (seg) {
      seg.querySelectorAll('[data-trg]').forEach(b =>
        b.addEventListener('click', () => setTrigger(b.dataset.trg)));
      const cf = $('#wtCycField'), co = $('#wtCycOff');
      if (cf) cf.addEventListener('change', scheduleSched);
      if (co) co.addEventListener('change', scheduleSched);
      const run = $('#wtRun');
      if (run) run.addEventListener('click', runNow);
      if ((tpl.trigger_kind || 'manual') === 'cycle') doSched();
    }
  }
  doPreview();
}

/* Cambia el tipo de disparo: pinta el segmented y deja visible SOLO el bloque
   de ese tipo. La hora aplica a todos los automaticos, pero no a 'manual'. */
function setTrigger(kind) {
  const seg = $('#wtTrg');
  if (!seg) return;
  seg.querySelectorAll('[data-trg]').forEach(b =>
    b.classList.toggle('on', b.dataset.trg === kind));

  const show = (id, on) => { const e = $(id); if (e) e.style.display = on ? '' : 'none'; };
  show('#wtTrgManual', kind === 'manual');
  show('#wtTrgCycle',  kind === 'cycle');
  show('#wtTrgDate',   kind === 'date');
  show('#wtTrgEvery',  kind === 'every');
  show('#wtTrgHour',   kind !== 'manual');

  if (kind === 'cycle') doSched();
}

/* Lee el disparo del formulario. Devuelve solo lo que aplica al tipo elegido. */
function readTrigger() {
  const seg = $('#wtTrg');
  if (!seg) return { trigger_kind: 'manual' };
  const on = seg.querySelector('[data-trg].on');
  const kind = on ? on.dataset.trg : 'manual';
  const t = { trigger_kind: kind };
  if (kind === 'manual') return t;

  const h = $('#wtTrgHourV');
  t.trigger_hour = h ? Number(h.value) : 8;

  if (kind === 'cycle') {
    t.cycle_field = $('#wtCycField').value;
    t.cycle_offset = Number($('#wtCycOff').value);
  } else if (kind === 'date') {
    t.trigger_date = $('#wtTrgDateV').value;
  } else if (kind === 'every') {
    t.trigger_every_days = Number($('#wtTrgEveryV').value);
  }
  return t;
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

/* v6.56: el canal se arma del checkbox secundario "Portal". WhatsApp (grupos)
   va siempre; el Portal es un extra. */
function readChannel() {
  const pt = $('#wtChPt');
  return (pt && pt.checked) ? 'wa+portal' : 'wa';
}

function readGroupIds() {
  return Array.from(ST.selGroups);
}

async function save() {
  const btn = $('#wtSave');
  const err = $('#wtErr');
  err.style.display = 'none';

  // Guardia de UI: al menos un grupo (salvo que sea SOLO portal, que aca no
  // se ofrece: WhatsApp a grupos es el canal base).
  if (!ST.selGroups.size) {
    err.textContent = 'Elegí al menos un grupo de destino.';
    err.style.display = '';
    return;
  }

  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = ST.isNew ? 'Creando…' : 'Guardando…';

  const payload = {
    action: ST.isNew ? 'create' : 'save',
    user: userPayload(ST.user),
    code: ST.cur,
    label: $('#wtLabel').value,
    body: $('#wtBody').value,
    channel: readChannel(),
    group_ids: readGroupIds(),
  };
  Object.assign(payload, readTrigger());   // FASE 2: el disparo

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
  // Refrescar el catalogo en memoria y recargar (la seccion pudo cambiar).
  const row = ST.rows.find(r => r.code === ST.cur);
  if (row) {
    row.label = $('#wtLabel').value;
    row.body = $('#wtBody').value;
    row.channel = payload.channel;
    row.group_ids = payload.group_ids;
    Object.assign(row, readTrigger());
  }
  ST.orig = $('#wtBody').value;
  await reload();
  const s = $('#wtSaved');
  s.style.display = 'inline';
  setTimeout(() => { s.style.display = 'none'; }, 1800);
}

async function doDelete() {
  const err = $('#wtErr');
  const btn = $('#wtDel');
  // Sin confirm() del navegador (regla del portal): dos clics deliberados.
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
    ST.groups = d.groups || [];
    ST.groupsMode = d.groups_mode || 'admin';
    ST.canEdit = !!d.can_edit;
  }
}

export async function renderWaTemplates(user) {
  ensureStyles();
  ST.user = user;
  ST.cur = null;
  ST.isNew = false;
  ST.selGroups = new Set();
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
  ST.groups = d.groups || [];
  ST.groupsMode = d.groups_mode || 'admin';
  ST.canEdit = !!d.can_edit;
  paintList();

  // Si falta el secret portal_base_url, #LinkPortal saldria vacio (aunque en
  // grupos ya no se usa; el aviso conserva el mensaje). Se avisa igual.
  if (d.warn) {
    $('#wtList').insertAdjacentHTML('afterbegin',
      `<div class="wt-banner red"><span class="ic">⚠️</span><div>${esc(d.warn)}</div></div>`);
  }
}
