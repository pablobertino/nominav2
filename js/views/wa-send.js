/* =====================================================================
   js/views/wa-send.js  →  vista "Difusión" (grupo WhatsApp)  v4.90-v5.05
   Mockup aprobado: _PRUEBAS/wa_difusion_mockup.html (v0-mock1) con dos
   ajustes de Pablo: menú propio WhatsApp > Difusión, y empresas SIEMPRE
   con el alias primero ("0A01 · MANCHESTER 2013, C.A.").

   v4.99 CAMBIO DE RUMBO (pedido de Pablo): el destino operativo real de
   las difusiones son los TELEFONOS DE LAS EMPRESAS/TIENDAS (companies.
   phone/phone2, ~90% de cobertura en activas), no el roster de personas
   (~4%). El Paso 1 ahora tiene DOS modos:
     🏪 Empresas / Tiendas (default): filtros de estructura + "Solo
        activas"; se envía 1 mensaje POR TELEFONO válido de cada empresa.
     👤 Personas: buscador (nombre o cédula) para ir AGREGANDO personas
        una a una a una lista manual; se envía a esa lista.
   Número directo y grupo habilitado se mantienen y MANDAN sobre todo.

   v5.05 (mockup aprobado _PRUEBAS/wa_excluir_destinatarios_mockup.html,
   v0-mock1): la grilla del preview permite QUITAR destinatarios antes de
   enviar — la X de cada fila, o los checkboxes + "Quitar seleccionadas"
   (con check maestro). Las quitadas quedan visibles, atenuadas y con
   "Deshacer"; los KPIs y el boton de enviar muestran el NETO (con el bruto
   tachado al lado). Los excluidos VIAJAN al 'send' (que re-consulta el RPC:
   si no viajaran, se enviaria igual a quienes se quitaron) y quedan en
   wa_batches.filters.excluded. Ademas, aviso ambar sobre la grilla con los
   que NO tienen telefono (no se envian; se puede copiar la lista para ir a
   pedirles el numero). El preview pasa a 1000 filas: el universo entra
   completo y por eso excluir sobre la grilla es fiable.

   Reglas: en la UI se dice "WhatsApp" a secas (nunca el proveedor); sin
   alert/confirm nativos. Gates del server: view.whatsapp (mirar) y
   wa.send (disparar); admins no-super solo ven sus grupos asignados
   (v4.97). Export: renderWaSend(user)
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
let TARGET = 'companies';   // v4.99: 'companies' | 'people'
let PEOPLE = [];            // v4.99: lista manual [{id_number, full_name, ...}]
/* v5.05: destinatarios QUITADOS a mano en la grilla del preview (X de la fila,
   o checkbox + "Quitar seleccionadas"). Clave: company_code en modo Empresas,
   cedula en modo Personas. VIAJAN al 'send' (que re-consulta el RPC y los
   filtra alli; si no viajaran, se enviaria igual a quienes se quitaron).
   Se limpian al invalidar el preview: si cambian los filtros el conjunto ya
   no tiene sentido, y arrastrar exclusiones invisibles seria un bug callado. */
let EXCLUDED = new Set();
let SELECTED = new Set();   // v5.05: tildados en la grilla (para quitar en lote)

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
  .wa-inst.warn{background:var(--warn-bg,#fffbeb);border-color:#fde68a;color:#92400e}
  .wa-inst.bad{background:#fef2f2;border-color:#fecaca;color:#b91c1c}
  .wa-inst .dot{width:8px;height:8px;border-radius:50%;background:currentColor}
  .wa-card{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;padding:16px 18px;margin-bottom:14px}
  .wa-card h3{font-size:13px;margin:0 0 10px;display:flex;align-items:center;gap:8px;color:var(--ink)}
  .wa-card h3 .n{width:20px;height:20px;border-radius:50%;background:var(--accent,#2563eb);color:#fff;display:grid;place-items:center;font-size:11px;font-weight:800}
  .wa-seg{display:inline-flex;border:1px solid var(--border);border-radius:11px;overflow:hidden;margin-bottom:12px}
  .wa-segbtn{border:none;background:var(--surface,#fff);font:inherit;font-size:12.5px;font-weight:700;color:var(--ink-soft,#475569);padding:8px 16px;cursor:pointer}
  .wa-segbtn+.wa-segbtn{border-left:1px solid var(--border)}
  .wa-segbtn.on{background:var(--accent,#2563eb);color:#fff}
  .wa-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px}
  .wa-filters label{font-size:11px;font-weight:700;color:var(--ink-soft,#475569);display:block;margin-bottom:3px}
  .wa-filters select{width:100%;font:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink)}
  .wa-check{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:var(--ink);cursor:pointer;padding:8px 0}
  .wa-check input{width:15px;height:15px;accent-color:var(--accent,#2563eb);cursor:pointer}
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
  .wa-kpi.msg{border-color:#c7d8fb;background:#eef4ff}
  .wa-kpi.msg b{color:#1d4ed8}
  .wa-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .wa-table th{padding:7px 10px;background:#fbfcfe;border-bottom:1px solid var(--border);font-size:10.5px;font-weight:800;color:var(--ink-soft,#475569);text-transform:uppercase;letter-spacing:.04em;text-align:left}
  .wa-table td{padding:8px 10px;border-bottom:1px solid var(--border-soft,#f1f4f8);color:var(--ink)}
  .wa-tel{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}
  .wa-chip{display:inline-block;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:800}
  .wa-chip.ok{background:#e9fbf0;color:#0f7a4d;border:1px solid #bbf1d2}
  .wa-chip.no{background:#f1f5f9;color:#64748b;border:1px solid var(--border)}
  .wa-chip.off{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
  .wa-tblnote{font-size:11px;color:var(--muted);margin-top:6px}
  .wa-pres{border:1px solid var(--border);border-radius:11px;margin-top:10px;max-height:260px;overflow-y:auto}
  .wa-padd{border:1px solid #bbf1d2;background:#e9fbf0;color:#0f7a4d;border-radius:8px;font:inherit;font-size:12px;font-weight:800;padding:3px 11px;cursor:pointer}
  .wa-padd:disabled{opacity:.45;cursor:default}
  .wa-plist{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  .wa-pchip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 8px 4px 12px;font-size:12px;font-weight:700;background:#eef4ff;color:#1d4ed8;border:1px solid #c7d8fb}
  .wa-pchip.no{background:#f1f5f9;color:#64748b;border-color:var(--border)}
  .wa-pchip .x{cursor:pointer;font-weight:900;color:#6d8dd8;font-size:14px;line-height:1}
  .wa-pchip .x:hover{color:#b91c1c}
  .wa-msg{width:100%;min-height:220px;font:inherit;font-size:13.5px;padding:11px 13px;border:1px solid var(--border);border-radius:11px;resize:vertical;line-height:1.5;background:var(--surface,#fff);color:var(--ink)}
  .wa-msgfoot{display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:11.5px;color:var(--muted);flex-wrap:wrap;gap:6px}
  .wa-msgfoot code{background:#f1f5f9;border-radius:4px;padding:1px 5px}
  .wa-sendrow{display:flex;gap:10px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
  /* v6.187 — adjunto (imagen o PDF) */
  .wa-media{margin-top:14px;border-top:1px solid #eef2f7;padding-top:12px}
  .wa-media-pick{display:inline-flex;align-items:center;gap:10px;cursor:pointer}
  .wa-media-btn{font-size:12.5px;font-weight:600;color:#0f766e;background:#f0fdfa;border:1px solid #ccfbf1;
    border-radius:9px;padding:7px 12px}
  .wa-media-pick:hover .wa-media-btn{background:#ccfbf1}
  .wa-media-hint{font-size:11.5px;color:#94a3b8}
  .wa-media-box{margin-top:10px}
  .wa-media-file{display:flex;align-items:center;gap:11px;border:1px solid #e2e8f0;border-radius:10px;
    padding:9px 11px;background:#fff}
  .wa-media-file img{width:56px;height:56px;object-fit:cover;border-radius:8px;flex:none;border:1px solid #eef2f7}
  .wa-media-pdf{width:56px;height:56px;border-radius:8px;flex:none;display:flex;align-items:center;
    justify-content:center;background:#fef2f2;color:#b91c1c;font-size:12px;font-weight:700;border:1px solid #fee2e2}
  .wa-media-meta{flex:1;min-width:0}
  .wa-media-meta b{display:block;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .wa-media-meta span{font-size:11.5px;color:#94a3b8}
  .wa-media-x{border:0;background:none;color:#94a3b8;font-size:15px;cursor:pointer;padding:4px 6px;border-radius:6px}
  .wa-media-x:hover{background:#f1f5f9;color:#0f172a}
  .wa-media-mode{margin-top:11px;display:flex;flex-direction:column;gap:6px}
  .wa-media-mode label{font-size:12.5px;color:#334155;cursor:pointer;font-weight:400}
  .wa-media-mode input{margin-right:6px;accent-color:#2563eb;vertical-align:-1px}
  .wa-media-mode input:disabled+b,.wa-media-mode input:disabled{opacity:.45;cursor:not-allowed}
  .wa-media-warn{background:#fef6e7;border-left:3px solid #b45309;border-radius:0 8px 8px 0;
    padding:8px 11px;font-size:12px;color:#8a5a00;margin-top:4px;line-height:1.5}

  /* v6.180 — lista de grupos con casillas + vista previa por grupo */
  .wa-grplist{display:flex;flex-direction:column;gap:2px;border:1px solid var(--border,#e2e8f0);border-radius:9px;
    padding:6px;background:#fff;max-height:190px;overflow-y:auto}
  .wa-grp{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:7px;cursor:pointer;font-size:13px}
  .wa-grp:hover{background:#f8fafc}
  .wa-grp input{width:15px;height:15px;accent-color:#2563eb;flex:none;cursor:pointer}
  .wa-grp-n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .wa-grp-z{font-size:11px;color:#94a3b8;white-space:nowrap}
  .wa-zsw{display:block;margin-top:9px;font-size:12.5px;color:#334155;cursor:pointer;font-weight:500}
  .wa-zsw input{width:14px;height:14px;accent-color:#2563eb;vertical-align:-2px;margin-right:5px}
  .wa-zhint{display:block;font-size:11px;color:#94a3b8;font-weight:400;margin:2px 0 0 19px}
  .wa-zoneprev{margin-top:12px;border-top:1px solid #eef2f7;padding-top:12px}
  .wa-zp-h{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;margin-bottom:8px}
  .wa-zp{background:#f0f7f2;border:1px solid #d6e9dc;border-radius:10px;padding:9px 12px;margin-bottom:7px}
  .wa-zp-n{font-size:11.5px;color:#64748b;margin-bottom:5px;font-weight:600}
  .wa-zp-s{font-weight:400;color:#94a3b8}
  .wa-zp-b{font-size:13px;color:#0f172a;line-height:1.5;white-space:pre-wrap;word-break:break-word}
  .wa-why{font-size:12px;color:#b45309;font-weight:600;margin-right:10px;align-self:center}
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
  .wa-emoji:hover{background:#f1f5f9}
  /* ===== v5.05: excluir destinatarios + aviso de sin telefono ===== */
  .wa-warn{display:flex;gap:9px;align-items:flex-start;background:var(--warn-bg,#fffbeb);border:1px solid #fde68a;color:#92400e;border-radius:10px;padding:9px 12px;font-size:12px;margin-bottom:9px;line-height:1.5}
  .wa-warn .ic{flex:none;font-size:14px;line-height:1.2}
  .wa-warn b{font-weight:800}
  .wa-warn code{background:#fef3c7;border-radius:4px;padding:1px 5px;font-size:11px;font-family:ui-monospace,SFMono-Regular,monospace}
  .wa-warn .lnk{color:#92400e;text-decoration:underline;cursor:pointer;font-weight:700;white-space:nowrap;background:none;border:none;font-family:inherit;font-size:12px;padding:0}
  .wa-exbar{display:flex;gap:9px;align-items:center;flex-wrap:wrap;background:#f8fafc;border:1px solid var(--border);border-radius:10px;padding:8px 12px;margin-bottom:9px;font-size:12.5px}
  .wa-exbar .cnt{font-weight:700;color:var(--ink)}
  .wa-exbar .sp{flex:1}
  .wa-exbar.hasex{background:#fef2f2;border-color:#fecaca}
  .wa-exbar.hasex .cnt{color:#991b1b}
  .wa-exbtn{border:1px solid var(--border);background:var(--surface,#fff);border-radius:9px;padding:6px 12px;font:inherit;font-size:12px;font-weight:700;color:var(--ink-soft,#475569);cursor:pointer;white-space:nowrap}
  .wa-exbtn:hover{background:#f8fafc}
  .wa-exbtn.danger{color:#b91c1c;border-color:#fecaca;background:#fff}
  .wa-exbtn.danger:hover{background:#fef2f2}
  .wa-exbtn:disabled{opacity:.45;cursor:default}
  .wa-kpi .was{font-size:12px;color:var(--faint,#94a3b8);text-decoration:line-through;font-weight:700;margin-left:6px}
  .wa-table th.sel,.wa-table td.sel{width:34px;padding-left:12px;padding-right:0}
  .wa-table th.act,.wa-table td.act{width:70px;text-align:center;padding-left:0}
  .wa-table input[type=checkbox]{width:15px;height:15px;accent-color:var(--accent,#2563eb);cursor:pointer;margin:0;vertical-align:middle}
  .wa-x{border:none;background:transparent;color:var(--faint,#94a3b8);font-size:16px;font-weight:900;line-height:1;cursor:pointer;padding:3px 6px;border-radius:6px;font-family:inherit}
  .wa-x:hover{color:#b91c1c;background:#fef2f2}
  .wa-undo{border:none;background:transparent;color:var(--accent,#2563eb);font-size:11px;font-weight:800;cursor:pointer;padding:3px 6px;border-radius:6px;white-space:nowrap;font-family:inherit}
  .wa-undo:hover{background:#eef4ff}
  .wa-chip.ex{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
  .wa-table tr.excl td{background:#fdfdfe;color:var(--faint,#94a3b8)}
  .wa-table tr.excl td b{color:var(--faint,#94a3b8);font-weight:600}
  .wa-table tr.excl .wa-tel{text-decoration:line-through}
  .wa-table tr.excl td.nm b{text-decoration:line-through}
  .wa-table tr.nophone td{background:#fffdf7}`;
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

/* v6.51 SOLO GRUPOS: el único destino es un grupo habilitado. Se quitaron
   los modos empresas/personas/numero directo (el backend ya los rechaza). */
function currentFilters() {
  return {
    group_ids: gruposMarcados(),
    zone_greeting: !!($('#waZoneGreet') && $('#waZoneGreet').checked),
  };
}

/* v6.187 — Adjunto en curso: { path, mime, file_name, bytes, es_imagen }.
   Se llena al subir el archivo y se manda con el envio. */
let MEDIA = null;

/* Limite REAL del pie de foto en WhatsApp. El proveedor acepta mas, pero el
   telefono lo corta y nadie se entera hasta que el mensaje ya salio. */
const CAPTION_MAX = 1024;

function modoMedia() {
  const r = document.querySelector('input[name="waMMode"]:checked');
  return r ? r.value : 'caption';
}

/* v6.180 — Los grupos marcados en la lista de casillas. */
function gruposMarcados() {
  return Array.from(document.querySelectorAll('#waGrpList input[type=checkbox]:checked'))
    .map(c => Number(c.value)).filter(Boolean);
}

/* Zonas de un grupo, tal como las devolvio el backend. */
const ZONAS_GRUPO = new Map();

/* Saludo con las zonas — MISMA regla que armarMensaje() en wa-send.js.
   Se repite aca solo para la vista previa; la que manda es la del backend. */
function saludoZonasVista(zonas) {
  if (!zonas || !zonas.length) return '';
  const b = zonas.map(z => `*${z}*`);
  const t = b.length === 1 ? b[0] : b.slice(0, -1).join(', ') + ' y ' + b[b.length - 1];
  return `Equipo${zonas.length > 1 ? 's' : ''} de ${t}:`;
}

/* ===================== v5.05: EXCLUIR DESTINATARIOS =====================
   Helpers de conteo NETO (universo del preview menos lo excluido). La clave
   de cada fila es company_code (Empresas) o id_number (Personas). Las filas
   SIN telefono no se pueden excluir: no se envian igual, y ofrecer quitarlas
   confundiria. */
function rowKey(r) { return String(r.company_code || r.id_number || ''); }
function previewRows() { return (PREVIEW && PREVIEW.rows) || []; }
function rowMsgs(r) {
  // Empresas: 1 mensaje por telefono valido. Personas/grupo/directo: 1.
  if (PREVIEW && PREVIEW.target === 'companies') return (r.phones || []).length;
  return r.phone_ok ? 1 : 0;
}
/* Solo las que pueden recibir (tienen telefono): son las excluibles. */
function sendableRows() { return previewRows().filter(r => r.phone_ok); }
function noPhoneRows() { return previewRows().filter(r => !r.phone_ok); }
function activeRows() { return sendableRows().filter(r => !EXCLUDED.has(rowKey(r))); }
function netEntities() { return activeRows().length; }
function netMsgs() { return activeRows().reduce((a, r) => a + rowMsgs(r), 0); }
function grossMsgs() { return sendableRows().reduce((a, r) => a + rowMsgs(r), 0); }
/* El grupo y el numero directo son destinatarios sinteticos (1 fila): no
   tiene sentido excluirlos (para eso se limpia el campo). */
function excludable() {
  if (!PREVIEW) return false;
  if (gruposMarcados().length) return false;
  if ($('#waFTel') && $('#waFTel').value.trim()) return false;
  return true;
}

function invalidatePreview() {
  PREVIEW = null;
  EXCLUDED = new Set();   // v5.05: el conjunto viejo ya no aplica al nuevo filtro
  SELECTED = new Set();
  $('#waKpis').innerHTML = '';
  $('#waWarn').innerHTML = '';
  $('#waExbar').innerHTML = '';
  $('#waTbl').innerHTML = '';
  $('#waTblNote').textContent = '';
  syncSendState();
}

/* v4.99: cuantos MENSAJES saldran (empresas pueden tener 2 telefonos)
   v5.05: descontando los excluidos a mano. */
function msgCount() {
  return PREVIEW ? netMsgs() : 0;
}

function syncSendState() {
  const msg = $('#waMsg').value.trim();
  const largoOk = msg.length > 0 && msg.length <= MAX_MESSAGE;
  const btn = $('#waSendBtn');

  /* v6.188 — Un boton apagado sin explicacion es una trampa: el usuario le da
     clic, no pasa nada, y concluye que la pantalla esta rota. Aca se dice que
     falta. Reportado en vivo: "le hago clic al boton y no sale el mensaje" —
     y lo que faltaba era marcar un grupo. */
  const porQue = (motivo) => { const w = $('#waWhy'); if (w) w.textContent = motivo || ''; };

  /* v6.186 — Con grupos marcados, el boton NO depende del preview.
     Antes exigia PREVIEW, que solo se llena al pulsar "Ver destinatario"...
     y marcar un grupo llama a invalidatePreview(), que lo borra. Con el
     preview roto desde la v6.180 eso dejaba el boton apagado para siempre.
     Pero ademas el requisito ya no tiene sentido: la vista previa por grupo
     muestra, textual, lo que va a recibir cada uno. Pedir un segundo preview
     de los mismos grupos que estan tildados ahi arriba es puro tramite. */
  const grupos = gruposMarcados().length;
  if (grupos > 0) {
    /* v6.187: con imagen y texto en un solo mensaje, el pie tiene su propio
       limite. Se bloquea aca ademas de en el servidor, para que el usuario
       lo vea antes y no despues de mandar siete grupos. */
    const pieOk = !(MEDIA && MEDIA.es_imagen && modoMedia() === 'caption' && msg.length > CAPTION_MAX);
    if (btn) {
      btn.disabled = SENDING || !largoOk || !pieOk;
      const conArchivo = MEDIA ? (MEDIA.es_imagen ? ' con imagen' : ' con PDF') : '';
      btn.textContent = `📤 Enviar a ${nf(grupos)} grupo${grupos === 1 ? '' : 's'}${conArchivo}`;
    }
    porQue(!largoOk
      ? (msg.length ? 'El mensaje supera el máximo.' : 'Falta escribir el mensaje.')
      : (!pieOk ? 'El texto no entra como pie de foto.' : ''));
    $('#waCount').textContent = `${nf(msg.length)} / ${nf(MAX_MESSAGE)}`;
    return;
  }

  // Sin grupos marcados no hay a dónde enviar: hay que decirlo.
  if (!PREVIEW) {
    if (btn) { btn.disabled = true; btn.textContent = '📤 Enviar'; }
    porQue(largoOk
      ? 'Marcá al menos un grupo arriba.'
      : 'Marcá al menos un grupo y escribí el mensaje.');
    $('#waCount').textContent = `${nf(msg.length)} / ${nf(MAX_MESSAGE)}`;
    return;
  }
  porQue('');

  const n = msgCount();
  const ok = !SENDING && PREVIEW && n > 0 && largoOk;
  if (btn) {
    btn.disabled = !ok;
    const ent = netEntities();
    btn.textContent = PREVIEW && n > 0
      ? (PREVIEW.target === 'companies'
        ? `📤 Enviar a ${nf(ent)} empresa${ent === 1 ? '' : 's'} · ${nf(n)} mensaje${n === 1 ? '' : 's'}`
        : `📤 Enviar a ${nf(n)} destinatario${n === 1 ? '' : 's'}`)
      : '📤 Enviar';
  }
  $('#waCount').textContent = `${nf(msg.length)} / ${nf(MAX_MESSAGE)}`;
}

/* v5.05: aviso AMBAR sobre la grilla con los que NO tienen telefono (no se
   envian y quedan fuera del conteo). Sirve para ACTUAR: copiar la lista y
   pedirle el telefono a esas empresas. */
function paintNoPhoneWarn() {
  const box = $('#waWarn');
  if (!box) return;
  const np = noPhoneRows();
  if (!np.length) { box.innerHTML = ''; return; }
  const isComp = PREVIEW.target === 'companies';
  const ent = isComp ? 'empresa' : 'persona';
  const list = np.map(r => isComp
    ? `<code>${esc(r.company_code)}</code> ${esc(r.business_name || '')}`
    : `<code>${esc(r.id_number)}</code> ${esc(r.full_name || '')}`).join(' &nbsp;·&nbsp; ');
  box.innerHTML = `<div class="wa-warn">
    <span class="ic">⚠️</span>
    <div>
      <b>${nf(np.length)} ${ent}${np.length === 1 ? '' : 's'} del filtro no tiene${np.length === 1 ? '' : 'n'} teléfono registrado</b> y queda${np.length === 1 ? '' : 'n'} fuera del envío.
      <div style="margin-top:5px;font-size:11.5px">${list}</div>
      <div style="margin-top:5px"><button type="button" class="lnk" id="waNpCopy">Copiar la lista</button></div>
    </div>
  </div>`;
  const cp = $('#waNpCopy');
  if (cp) cp.addEventListener('click', () => {
    const txt = np.map(r => isComp
      ? `${r.company_code} · ${r.business_name || ''}`
      : `${r.id_number} · ${r.full_name || ''}`).join('\n');
    navigator.clipboard.writeText(txt).then(() => {
      cp.textContent = '✓ Copiado';
      setTimeout(() => { cp.textContent = 'Copiar la lista'; }, 1800);
    }).catch(() => { cp.textContent = 'No se pudo copiar'; });
  });
}

/* v5.05: barra de exclusiones (contador + acciones en lote). */
function paintExbar() {
  const box = $('#waExbar');
  if (!box) return;
  if (!excludable() || !sendableRows().length) { box.innerHTML = ''; return; }
  const n = EXCLUDED.size;
  const menos = grossMsgs() - netMsgs();
  const ent = PREVIEW.target === 'companies' ? 'empresa' : 'persona';
  const txt = n
    ? `${nf(n)} ${ent}${n === 1 ? '' : 's'} excluida${n === 1 ? '' : 's'} · ${nf(menos)} mensaje${menos === 1 ? '' : 's'} menos`
    : `Ninguna ${ent} excluida`;
  box.innerHTML = `<div class="wa-exbar${n ? ' hasex' : ''}">
    <span class="cnt">${esc(txt)}</span>
    <span class="sp"></span>
    <button type="button" class="wa-exbtn danger" id="waExRm"${SELECTED.size ? '' : ' disabled'}>Quitar seleccionadas${SELECTED.size ? ` (${nf(SELECTED.size)})` : ''}</button>
    <button type="button" class="wa-exbtn" id="waExRestore"${n ? '' : ' disabled'}>Restaurar todas</button>
  </div>`;
  const rm = $('#waExRm');
  if (rm) rm.addEventListener('click', () => {
    SELECTED.forEach(k => EXCLUDED.add(k));
    SELECTED = new Set();
    repaintPreview();
  });
  const rs = $('#waExRestore');
  if (rs) rs.addEventListener('click', () => { EXCLUDED = new Set(); repaintPreview(); });
}

/* Repinta todo lo que depende de las exclusiones (KPIs, aviso, barra, tabla y
   boton de enviar). Se llama tras cada cambio de EXCLUDED / SELECTED. */
function repaintPreview() { paintPreview(); syncSendState(); }

/* Cablea checkboxes, check maestro, X y Deshacer de la tabla. */
function wirePreviewRows() {
  const tbl = $('#waTbl');
  if (!tbl) return;
  tbl.querySelectorAll('[data-wax]').forEach(b => b.addEventListener('click', () => {
    EXCLUDED.add(b.dataset.wax); SELECTED.delete(b.dataset.wax); repaintPreview();
  }));
  tbl.querySelectorAll('[data-waundo]').forEach(b => b.addEventListener('click', () => {
    EXCLUDED.delete(b.dataset.waundo); repaintPreview();
  }));
  tbl.querySelectorAll('[data-wac]').forEach(c => c.addEventListener('change', () => {
    if (c.checked) SELECTED.add(c.dataset.wac); else SELECTED.delete(c.dataset.wac);
    paintExbar(); syncAllChk();
  }));
  const all = $('#waChkAll');
  if (all) all.addEventListener('change', () => {
    activeRows().forEach(r => {
      if (all.checked) SELECTED.add(rowKey(r)); else SELECTED.delete(rowKey(r));
    });
    repaintPreview();
  });
  syncAllChk();
}
function syncAllChk() {
  const all = $('#waChkAll');
  if (!all) return;
  const act = activeRows();
  const on = act.filter(r => SELECTED.has(rowKey(r))).length;
  all.checked = act.length > 0 && on === act.length;
  all.indeterminate = on > 0 && on < act.length;
  all.disabled = act.length === 0;
}

/* Celdas de seleccion/accion por fila + orden (recibiran, excluidas, sin
   telefono) + chip de estado. Compartidos por las dos tablas. Las filas SIN
   telefono no se pueden excluir: no se envian igual. */
function exCells(r, canEx) {
  if (!canEx) return { sel: '', act: '' };
  if (!r.phone_ok) return { sel: '<td class="sel"></td>', act: '<td class="act"></td>' };
  const k = rowKey(r);
  const ex = EXCLUDED.has(k);
  return {
    sel: `<td class="sel">${ex ? '' : `<input type="checkbox" data-wac="${esc(k)}"${SELECTED.has(k) ? ' checked' : ''}>`}</td>`,
    act: `<td class="act">${ex
      ? `<button type="button" class="wa-undo" data-waundo="${esc(k)}" title="Volver a incluir">Deshacer</button>`
      : `<button type="button" class="wa-x" data-wax="${esc(k)}" title="Quitar del envío">✕</button>`}</td>`,
  };
}
function exOrdered(rows) {
  return [
    ...rows.filter(r => r.phone_ok && !EXCLUDED.has(rowKey(r))),
    ...rows.filter(r => r.phone_ok && EXCLUDED.has(rowKey(r))),
    ...rows.filter(r => !r.phone_ok),
  ];
}
function exStatusChip(r, isComp) {
  if (!r.phone_ok) return '<span class="wa-chip no">Sin teléfono</span>';
  if (EXCLUDED.has(rowKey(r))) return '<span class="wa-chip ex">Excluida</span>';
  const n = isComp ? (r.phones || []).length : 1;
  return `<span class="wa-chip ok">Recibirá${n > 1 ? ' ×' + n : ''}</span>`;
}
function exRowCls(r) {
  if (!r.phone_ok) return 'nophone';
  return EXCLUDED.has(rowKey(r)) ? 'excl' : '';
}

function paintPreview() {
  const p = PREVIEW;
  const canEx = excludable();
  const hasEx = EXCLUDED.size > 0;
  const selTh = canEx ? '<th class="sel"><input type="checkbox" id="waChkAll" title="Seleccionar todas las que recibirán"></th>' : '';
  const actTh = canEx ? '<th class="act"></th>' : '';
  const entNet = netEntities(), entGross = sendableRows().length;
  if (p.target === 'companies') {
    const msgNetN = netMsgs(), msgGrossN = grossMsgs();
    $('#waKpis').innerHTML = `
      <div class="wa-kpi"><small>Empresas en el filtro</small><b>${nf(p.total)}</b></div>
      <div class="wa-kpi ok"><small>🏪 Con teléfono (recibirán)</small><b>${nf(entNet)}</b>${hasEx ? `<span class="was">${nf(entGross)}</span>` : ''}</div>
      <div class="wa-kpi bad"><small>Sin teléfono registrado</small><b>${nf(p.without_phone)}</b></div>
      <div class="wa-kpi msg"><small>📤 Mensajes a enviar</small><b>${nf(msgNetN)}</b>${hasEx ? `<span class="was">${nf(msgGrossN)}</span>` : ''}</div>`;
    paintNoPhoneWarn();
    paintExbar();
    const rows = exOrdered(p.rows || []);
    $('#waTbl').innerHTML = !rows.length ? '' : `
      <table class="wa-table">
        <thead><tr>${selTh}<th>Código</th><th>Empresa</th><th>Tipo</th><th>Teléfonos de la empresa</th><th></th>${actTh}</tr></thead>
        <tbody>${rows.map(r => {
      const c = exCells(r, canEx);
      return `<tr class="${exRowCls(r)}">${c.sel}
          <td><b>${esc(r.company_code)}</b></td>
          <td class="nm"><b>${esc(r.business_name || '(sin nombre)')}</b>${r.is_active ? '' : ' <span class="wa-chip off">Inactiva</span>'}</td>
          <td>${esc(r.tipo || '')}</td>
          <td class="wa-tel">${(r.phones || []).length ? (r.phones || []).map(esc).join(' · ') : '—'}</td>
          <td>${exStatusChip(r, true)}</td>${c.act}
        </tr>`;
    }).join('')}</tbody>
      </table>`;
    $('#waTblNote').textContent = (p.total > (p.rows || []).length
      ? `Muestra de las primeras ${nf((p.rows || []).length)} · ` : '')
      + 'Ordenadas: primero las que recibirán, luego las excluidas y las que no tienen teléfono. '
      + 'Se envía un mensaje a cada teléfono registrado de la empresa.';
    wirePreviewRows();
    return;
  }
  $('#waKpis').innerHTML = `
    <div class="wa-kpi"><small>En el filtro</small><b>${nf(p.total)}</b></div>
    <div class="wa-kpi ok"><small>📱 Con teléfono (recibirán)</small><b>${nf(entNet)}</b>${hasEx ? `<span class="was">${nf(entGross)}</span>` : ''}</div>
    <div class="wa-kpi bad"><small>Sin teléfono registrado</small><b>${nf(p.without_phone)}</b></div>`;
  paintNoPhoneWarn();
  paintExbar();
  const rows = exOrdered(p.rows || []);
  $('#waTbl').innerHTML = !rows.length ? '' : `
    <table class="wa-table">
      <thead><tr>${selTh}<th>Cédula</th><th>Colaborador</th><th>Empresa</th><th>Teléfono</th><th></th>${actTh}</tr></thead>
      <tbody>${rows.map(r => {
    const c = exCells(r, canEx);
    return `<tr class="${exRowCls(r)}">${c.sel}
        <td>${esc(r.id_number)}</td>
        <td class="nm"><b>${esc(r.full_name || '(sin nombre)')}</b></td>
        <td>${esc(r.company_code)}${r.company_name ? ' · ' + esc(r.company_name) : ''}</td>
        <td class="wa-tel">${esc(r.phone || '—')}</td>
        <td>${exStatusChip(r, false)}</td>${c.act}
      </tr>`;
  }).join('')}</tbody>
    </table>`;
  $('#waTblNote').textContent = (p.total > (p.rows || []).length
    ? `Muestra de los primeros ${nf((p.rows || []).length)} · ` : '')
    + 'Ordenados: primero los que recibirán, luego los excluidos y los que no tienen teléfono.';
  wirePreviewRows();
}

/* ================= v4.99: modo Personas (lista manual) ================= */

function paintPeopleResults(rows) {
  const box = $('#waPResults');
  if (!rows || !rows.length) {
    box.innerHTML = '<div style="padding:14px;text-align:center;font-size:12px;color:var(--muted)">Sin resultados: prueba con otro nombre o cédula.</div>';
    return;
  }
  const inList = new Set(PEOPLE.map(p => p.id_number));
  box.innerHTML = `<table class="wa-table">
    <thead><tr><th>Cédula</th><th>Colaborador</th><th>Empresa</th><th>Teléfono</th><th></th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr>
      <td>${esc(r.id_number)}</td>
      <td><b>${esc(r.full_name || '(sin nombre)')}</b></td>
      <td>${esc(r.company_code)}${r.company_name ? ' · ' + esc(r.company_name) : ''}</td>
      <td class="wa-tel">${esc(r.phone || '—')}</td>
      <td>${inList.has(r.id_number)
        ? '<span class="wa-chip ok">En la lista</span>'
        : r.phone_ok
          ? `<button class="wa-padd" data-i="${i}">＋ Agregar</button>`
          : '<span class="wa-chip no">Sin teléfono</span>'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
  box.querySelectorAll('.wa-padd').forEach(btn => btn.addEventListener('click', () => {
    const r = rows[Number(btn.dataset.i)];
    if (!r || PEOPLE.some(p => p.id_number === r.id_number)) return;
    PEOPLE.push(r);
    paintPeopleList();
    paintPeopleResults(rows);
    invalidatePreview();
  }));
}

function paintPeopleList() {
  const box = $('#waPList');
  if (!PEOPLE.length) {
    box.innerHTML = '<span style="font-size:12px;color:var(--muted)">Aún no has agregado personas: busca arriba y usa ＋ Agregar.</span>';
    return;
  }
  box.innerHTML = `<span style="font-size:12px;font-weight:800;color:var(--ink)">Lista (${nf(PEOPLE.length)}):</span> `
    + PEOPLE.map(p => `<span class="wa-pchip${p.phone_ok ? '' : ' no'}" title="${esc(p.company_code)} · ${esc(p.phone || 'sin teléfono')}">
        ${esc(p.full_name || p.id_number)}<span class="x" data-id="${esc(p.id_number)}" title="Quitar de la lista">×</span>
      </span>`).join('');
  box.querySelectorAll('.wa-pchip .x').forEach(x => x.addEventListener('click', () => {
    PEOPLE = PEOPLE.filter(p => p.id_number !== x.dataset.id);
    paintPeopleList();
    invalidatePreview();
  }));
}

function setTarget(t) {
  TARGET = t;
  document.querySelectorAll('.wa-segbtn').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  $('#waTgtCompanies').style.display = t === 'companies' ? '' : 'none';
  $('#waTgtPeople').style.display = t === 'people' ? '' : 'none';
  invalidatePreview();
}

/* v6.180 — Vista previa por grupo. Es la pieza que hace confiable al saludo:
   antes de mandar nada se ve, textual, lo que va a leer cada grupo. Sin esto,
   "encabezar con la zona" es un interruptor a ciegas. */
function pintarPrevioZonas() {
  const box = $('#waZonePrev');
  if (!box) return;
  const ids = gruposMarcados();
  const con = !!($('#waZoneGreet') && $('#waZoneGreet').checked);
  const base = ($('#waMsg') && $('#waMsg').value.trim()) || '';
  if (!ids.length) { box.style.display = 'none'; box.innerHTML = ''; return; }

  box.style.display = '';
  box.innerHTML = `<div class="wa-zp-h">Así se va a ver en cada grupo (${ids.length})</div>`
    + ids.map(id => {
        const zonas = ZONAS_GRUPO.get(id) || [];
        const sal = con ? saludoZonasVista(zonas) : '';
        const inp = document.querySelector(`#waGrpList input[value="${id}"]`);
        const nom = inp ? inp.parentElement.querySelector('.wa-grp-n').textContent : '';
        const cuerpo = base || '(escribí el mensaje arriba)';
        return `<div class="wa-zp">
          <div class="wa-zp-n">${esc(nom)}${zonas.length ? '' : ' <span class="wa-zp-s">· sin zona, va sin encabezado</span>'}</div>
          <div class="wa-zp-b">${sal ? `<b>${esc(sal)}</b><br><br>` : ''}${esc(cuerpo).replace(/\n/g, '<br>')}</div>
        </div>`;
      }).join('');
}

/* Pausa entre grupos: 8 a 15 segundos AL AZAR. El azar no es capricho —
   un ritmo metronomico es tan delator como no tener pausa. */
const pausaGrupo = () => 8000 + Math.floor(Math.random() * 7000);
const dormir = ms => new Promise(r => setTimeout(r, ms));

/* =====================================================================
   v6.187 — Adjuntar un archivo a la difusion.
   Se sube apenas se elige: el aviso de "pesa mas de 5 MB" o "ese tipo no
   sirve" tiene que llegar mientras se arma el mensaje, no despues de
   pulsar Enviar con siete grupos marcados.
   ===================================================================== */
function pintarMedia() {
  const box = $('#waMediaBox'), modo = $('#waMediaMode');
  if (!box) return;
  if (!MEDIA) {
    box.style.display = 'none'; box.innerHTML = '';
    if (modo) modo.style.display = 'none';
    avisarCaption();
    return;
  }
  const kb = MEDIA.bytes > 1048576
    ? `${(MEDIA.bytes / 1048576).toFixed(1)} MB`
    : `${Math.round(MEDIA.bytes / 1024)} KB`;
  box.style.display = '';
  box.innerHTML = `
    <div class="wa-media-file">
      ${MEDIA.preview
        ? `<img src="${MEDIA.preview}" alt="">`
        : '<span class="wa-media-pdf">PDF</span>'}
      <div class="wa-media-meta"><b>${esc(MEDIA.file_name)}</b><span>${kb}${
        MEDIA.opt
          ? ` · optimizada desde ${(MEDIA.opt.antes / 1048576).toFixed(1)} MB${
              MEDIA.opt.w < MEDIA.opt.wOrig ? ` y ${MEDIA.opt.wOrig}px` : ''}`
          : ''}</span></div>
      <button type="button" class="wa-media-x" id="waMediaDel" title="Quitar">✕</button>
    </div>`;
  const del = $('#waMediaDel');
  if (del) del.addEventListener('click', () => {
    MEDIA = null;
    const inp = $('#waFile'); if (inp) inp.value = '';
    pintarMedia(); pintarPrevioZonas(); syncSendState();
  });

  /* Con PDF el pie de foto se ve mal en el telefono, asi que se fuerza el
     modo de dos mensajes y se explica por que. */
  if (modo) {
    modo.style.display = '';
    const cap = modo.querySelector('input[value="caption"]');
    const sep = modo.querySelector('input[value="separate"]');
    if (!MEDIA.es_imagen) {
      if (cap) { cap.checked = false; cap.disabled = true; }
      if (sep) sep.checked = true;
    } else if (cap) {
      cap.disabled = false;
    }
  }
  avisarCaption();
}

/* Aviso del limite del pie de foto. Se calcula en vivo mientras se escribe:
   enterarse al pulsar Enviar seria tarde. */
function avisarCaption() {
  const w = $('#waMediaWarn');
  if (!w) return;
  const msg = ($('#waMsg') && $('#waMsg').value.trim()) || '';
  const excede = MEDIA && MEDIA.es_imagen && modoMedia() === 'caption' && msg.length > CAPTION_MAX;
  w.style.display = excede ? '' : 'none';
  if (excede) {
    w.innerHTML = `El texto tiene <b>${nf(msg.length)}</b> caracteres y WhatsApp corta el pie de foto en
      <b>${nf(CAPTION_MAX)}</b>. Acortalo, o elegí <b>Dos mensajes</b>.`;
  }
}

/* =====================================================================
   v6.188 — Optimizar la imagen ANTES de subirla.

   POR QUE VALE LA PENA: WhatsApp recomprime las imagenes a JPEG de todas
   formas. Subir un PNG de 2,5 MB solo gasta la subida del usuario y el
   espacio del bucket — el que recibe ve exactamente lo mismo. Achicando a
   1600 px de ancho y JPEG al 85% queda en 200-400 KB sin diferencia
   visible, y ademas entra comodo en el limite de 5 MB.

   1600 px es el ancho maximo que WhatsApp conserva; mas grande se
   desperdicia. Y si el original ya es mas chico NO se agranda: reencodar
   una imagen chica solo la empeora.

   SE RESPETA EL ORIGINAL SI NO HAY GANANCIA: si el resultado pesa igual o
   mas -pasa con capturas de pantalla planas, donde el PNG gana- se manda
   el archivo tal cual. Optimizar por optimizar no es optimizar.
   ===================================================================== */
const MAX_LADO = 1600;
const JPEG_Q = 0.85;

function optimizarImagen(file) {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) return resolve({ file, optimizada: false });
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const escala = Math.min(1, MAX_LADO / Math.max(img.width, img.height));
        const w = Math.round(img.width * escala), h = Math.round(img.height * escala);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        // Fondo blanco: el JPEG no tiene transparencia y sin esto los PNG
        // con fondo transparente salen con manchas negras.
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        c.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (!blob || blob.size >= file.size) return resolve({ file, optimizada: false });
          const nombre = file.name.replace(/\.[^.]+$/, '') + '.jpg';
          resolve({
            file: new File([blob], nombre, { type: 'image/jpeg' }),
            optimizada: true,
            antes: file.size, despues: blob.size,
            w, h, wOrig: img.width, hOrig: img.height,
          });
        }, 'image/jpeg', JPEG_Q);
      } catch (_) {
        URL.revokeObjectURL(url);
        resolve({ file, optimizada: false });
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ file, optimizada: false }); };
    img.src = url;
  });
}

async function subirMedia(user, original) {
  const box = $('#waMediaBox');
  if (box) { box.style.display = ''; box.innerHTML = '<span class="wa-note">Preparando el archivo…</span>'; }

  const opt = await optimizarImagen(original);
  const file = opt.file;
  if (box) box.innerHTML = '<span class="wa-note">Subiendo el archivo…</span>';

  const b64 = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = () => rej(new Error('No se pudo leer el archivo.'));
    fr.readAsDataURL(file);
  });

  const r = await api(user, {
    action: 'upload_media', file_name: file.name, mime: file.type, base64: b64,
  });
  if (!r || !r.ok) {
    MEDIA = null;
    if (box) {
      box.style.display = '';
      box.innerHTML = `<span class="wa-note" style="background:#fef2f2;border-color:#fecaca;color:#991b1b">${esc((r && r.error) || 'No se pudo subir el archivo.')}</span>`;
    }
    const inp = $('#waFile'); if (inp) inp.value = '';
    syncSendState();
    return;
  }
  MEDIA = {
    path: r.path, mime: r.mime, file_name: r.file_name, bytes: r.bytes,
    es_imagen: !!r.es_imagen,
    // Vista previa local: no se vuelve a bajar del bucket para mirarla.
    preview: r.es_imagen ? URL.createObjectURL(file) : null,
    opt: opt.optimizada ? opt : null,
  };
  pintarMedia();
  syncSendState();
}

async function runBatch(user, batchId, totalToSend) {
  const prog = $('#waProg');
  prog.style.display = '';
  const bar = $('#waPbarFill'), meta = $('#waPmeta');
  let sent = 0, errors = 0, remaining = true, safety = 0;
  /* v6.180: con VARIOS grupos el backend manda de a uno y no duerme; la pausa
     la pone este bucle. Con uno solo se comporta como siempre. */
  const multi = totalToSend > 1;
  while (remaining && safety < 2000) {
    safety++;
    const r = await api(user, { action: 'process', batch_id: batchId });
    if (!r || !r.ok) { errors++; break; }
    sent += r.sent; errors += r.errors;
    remaining = !!r.remaining;
    const done = sent + errors;
    bar.style.width = `${Math.min(100, Math.round(done / Math.max(totalToSend, 1) * 100))}%`;
    const ult = (r.enviados && r.enviados.length) ? r.enviados[r.enviados.length - 1] : '';
    meta.innerHTML = `<span>${nf(sent)} de ${nf(totalToSend)} enviados${errors ? ` · ${nf(errors)} error${errors === 1 ? '' : 'es'}` : ''}${ult ? ` · último: ${esc(ult)}` : ''}</span>
      <span>${remaining ? 'enviando…' : 'completado'}</span>`;

    // Pausa con cuenta regresiva a la vista: que se entienda que la espera es
    // a proposito y que nadie cierre la pestaña pensando que se colgo.
    if (remaining && multi) {
      let resta = Math.round(pausaGrupo() / 1000);
      while (resta > 0) {
        meta.innerHTML = `<span>${nf(sent)} de ${nf(totalToSend)} enviados${errors ? ` · ${nf(errors)} error${errors === 1 ? '' : 'es'}` : ''}</span>
          <span>siguiente grupo en ${resta}s…</span>`;
        await dormir(1000);
        resta--;
      }
    }
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
  PREVIEW = null; SENDING = false; TARGET = 'companies'; PEOPLE = [];
  const main = document.getElementById('pnlMain');
  main.innerHTML = `<div class="wa-wrap">
    <div class="wa-head">
      <div>
        <h1><span class="wa-ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5 14.2c-.2.6-1.2 1.2-1.7 1.2-.4.1-1 .1-1.6-.1-.4-.1-.9-.3-1.5-.5a11.6 11.6 0 0 1-4.4-3.9c-.3-.5-.8-1.3-.8-2.2 0-.8.4-1.2.6-1.4.2-.2.4-.3.6-.3h.4c.2 0 .3 0 .5.4l.7 1.7c0 .2.1.3 0 .5l-.3.4-.4.4c-.1.1-.2.3-.1.5.1.2.6 1 1.3 1.7.9.8 1.7 1.1 2 1.2.2.1.4.1.5-.1l.6-.8c.2-.2.3-.2.5-.1l1.7.8c.2.1.4.2.4.3.1.1.1.6-.1 1.2Z"/></svg></span>
        Difusión</h1>
        <p>Publica un mensaje de WhatsApp en un grupo del grupo Canaima.</p>
      </div>
      <span class="wa-inst" id="waInst"><span class="dot"></span> Verificando línea…</span>
    </div>

    <div class="wa-card">
      <h3><span class="n">1</span> ¿En qué grupo se publica?</h3>
      <div class="wa-seg" id="waSeg" style="display:none">
        <button type="button" class="wa-segbtn on" data-t="companies">🏪 Empresas / Tiendas</button>
        <button type="button" class="wa-segbtn" data-t="people">👤 Personas</button>
      </div>

      <div id="waTgtCompanies" style="display:none">
        <div class="wa-filters" id="waFiltersGrid">
          <div><label>Zona</label><select id="waFZone"><option value="">Todas</option></select></div>
          <div><label>Subzona</label><select id="waFSubzone"><option value="">Todas</option></select></div>
          <div><label>Tipo de empresa</label><select id="waFType"><option value="">Todos</option></select></div>
          <div><label>Concepto / Marca</label><select id="waFConcept"><option value="">Todos</option></select></div>
          <div><label>Empresa</label><select id="waFCompany"><option value="">Todas</option></select></div>
          <div><label>&nbsp;</label><label class="wa-check"><input type="checkbox" id="waFActive" checked> Solo activas</label></div>
        </div>
        <div class="wa-tblnote">El mensaje va a los <b>teléfonos registrados de cada empresa</b> (si tiene dos, recibe en ambos).</div>
      </div>

      <div id="waTgtPeople" style="display:none">
        <div class="wa-frow">
          <div style="flex:2"><label>Buscar persona (nombre o cédula)</label><input id="waPQ" placeholder="Ej: MARIA GONZALEZ · 20536694"></div>
          <button class="wa-btn pri" id="waPSearch">🔎 Buscar</button>
        </div>
        <div class="wa-pres" id="waPResults" style="display:none"></div>
        <div class="wa-plist" id="waPList"></div>
      </div>

      <div class="wa-orsep" id="waOrsep">Grupo donde se va a publicar</div>
      <div class="wa-frow">
        <div id="waTelBox" style="display:none"><label>Número directo (pruebas / fuera de nómina)</label><input id="waFTel" placeholder="Ej: 0414-1234567"></div>
        <div id="waGrpBox" style="flex:2"><label>Grupos habilitados (uno o varios)</label>
          <div id="waGrpList" class="wa-grplist"><span class="wa-note">Cargando grupos…</span></div>
          <label class="wa-zsw"><input type="checkbox" id="waZoneGreet" checked>
            Encabezar cada mensaje con la zona del grupo
            <span class="wa-zhint">El grupo de Margarita recibe "Equipo de *Margarita*:". Los grupos sin zona no llevan encabezado.</span>
          </label>
        </div>
        <button class="wa-btn pri" id="waPreview">Ver destinatario</button>
        <button class="wa-btn" id="waClear">Limpiar</button>
      </div>
      <div class="wa-kpis" id="waKpis"></div>
      <div id="waWarn"></div>
      <div id="waExbar"></div>
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
      <div id="waZonePrev" class="wa-zoneprev" style="display:none"></div>

      <!-- v6.187 — Adjunto (imagen o PDF). Se sube al elegirlo, no al enviar:
           asi el error de tamaño o de tipo aparece mientras se arma el
           mensaje y no cuando ya se le dio a Enviar. -->
      <div class="wa-media">
        <label class="wa-media-pick">
          <input type="file" id="waFile" accept="image/jpeg,image/png,image/webp,application/pdf" hidden>
          <span class="wa-media-btn">📎 Adjuntar imagen o PDF</span>
          <span class="wa-media-hint">JPG, PNG, WebP o PDF · hasta 5 MB</span>
        </label>
        <div id="waMediaBox" class="wa-media-box" style="display:none"></div>
        <div id="waMediaMode" class="wa-media-mode" style="display:none">
          <label><input type="radio" name="waMMode" value="caption" checked>
            <b>Un solo mensaje</b> — la imagen con el texto de pie</label>
          <label><input type="radio" name="waMMode" value="separate">
            <b>Dos mensajes</b> — primero el archivo y después el texto</label>
          <div class="wa-media-warn" id="waMediaWarn" style="display:none"></div>
        </div>
      </div>
    </div>

    <div class="wa-card">
      <h3><span class="n">3</span> Enviar</h3>
      <div class="wa-sendrow" id="waSendRow">
        <span class="wa-note">⚠️ Se publicará en los grupos marcados desde la línea corporativa, uno detrás de otro. Queda registrado con fecha y autor.</span>
        <span class="wa-why" id="waWhy"></span>
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

  // Estado de la línea (diagnóstico; no bloquea la pantalla si falla).
  // v4.98: el server ademas verifica el delay de linea (pausa real entre
  // salidas) y lo corrige solo si esta bajo; aqui solo se informa.
  // v5.15: el server manda el estado YA TRADUCIDO (r.line = {level,title,
  // hint}). Antes esta pildora pintaba el codigo crudo del proveedor: el dia
  // que la linea se cayo, al usuario le aparecio literalmente "yellowCard".
  // Ahora dice que pasa y que hacer, y si el estado es grave se avisa arriba
  // del boton de enviar (no tiene sentido preparar una difusion que no va a
  // salir).
  api(user, { action: 'state' }).then(r => {
    const el = $('#waInst');
    if (!el) return;
    const L = (r && r.ok && r.line) ? r.line : null;

    if (!L) {
      el.className = 'wa-inst bad';
      el.innerHTML = '<span class="dot"></span> No se pudo verificar la línea';
      return;
    }

    const cls = L.level === 'ok' ? 'ok' : (L.level === 'warn' ? 'warn' : 'bad');
    el.className = 'wa-inst ' + cls;
    // El telefono solo se muestra cuando la linea esta sana (con la linea
    // caida, el numero no aporta: lo que importa es el problema).
    const tel = (L.level === 'ok' && r.phone) ? ' · ' + esc(r.phone) : '';
    el.innerHTML = '<span class="dot"></span> ' + esc(L.title) + tel;
    el.title = L.hint || '';

    if (L.level === 'ok') {
      if (r.delay_ms) {
        el.title = `${L.hint} Ritmo: 1 mensaje cada ${(r.delay_ms / 1000).toLocaleString('es-VE')} s`;
      }
      /* v6.159: la etiqueta decia "3,5s" fijo, pero el objetivo subio a 15 s
         en la v6.73 y nadie actualizo el texto: mostraba un numero falso. Ahora
         sale el valor real que quedo aplicado. */
      if (r.delay_fixed) {
        const seg = (Number(r.delay_ms || 0) / 1000).toLocaleString('es-VE');
        el.insertAdjacentHTML('afterend',
          `<span class="wa-inst ok" style="margin-left:6px" title="El ritmo de la línea estaba por debajo del mínimo seguro y el portal lo corrigió automáticamente. Aplica en ~5 minutos.">🛡️ Ritmo ajustado a ${esc(seg)}s</span>`);
      }
      /* v6.159: el acuse de lectura. Solo se avisa cuando el portal lo acaba
         de corregir; si ya estaba bien no se dice nada (no es informacion que
         el usuario necesite ver todos los dias). */
      if (r.typing_fixed) {
        el.insertAdjacentHTML('afterend',
          `<span class="wa-inst ok" style="margin-left:6px" title="La línea no mostraba el indicador «escribiendo…» antes de publicar. El portal lo activó; aplica en ~5 minutos.">⌨️ «Escribiendo…» activado</span>`);
      }
      if (r.read_fixed) {
        el.insertAdjacentHTML('afterend',
          `<span class="wa-inst ok" style="margin-left:6px" title="La línea no marcaba como leídos los mensajes de los grupos donde responde. El portal lo activó; aplica en ~5 minutos.">👀 Acuse de lectura activado</span>`);
      }
      if (!r.delay_fixed && r.delay_error) {
        el.title = 'No se pudo verificar el ritmo de línea: ' + r.delay_error;
      }
      return;
    }

    // Linea con problemas: aviso visible arriba del boton de enviar. Sin
    // esto, el usuario arma la difusion completa y recien falla al final.
    const row = $('#waSendRow');
    if (row && !$('#waLineWarn')) {
      const grave = L.level === 'bad';
      row.insertAdjacentHTML('beforebegin', `
        <div id="waLineWarn" style="display:flex;gap:9px;align-items:flex-start;border-radius:10px;padding:10px 13px;font-size:12.5px;line-height:1.5;margin-bottom:10px;${grave
          ? 'background:#fef2f2;border:1px solid #fecaca;color:#991b1b'
          : 'background:var(--warn-bg,#fffbeb);border:1px solid #fde68a;color:#92400e'}">
          <span style="flex:none">${grave ? '⛔' : '⚠️'}</span>
          <div><b>${esc(L.title)}.</b> ${esc(L.hint || '')}</div>
        </div>`);
    }
  });

  // Grupos habilitados para el combo (catalogo de WhatsApp > Grupos).
  // v4.97: para un admin no-super, list devuelve mode:'admin' con SOLO sus
  // grupos asignados; la pantalla se reduce al destino grupo (empresas,
  // personas y numero directo son de superadmin).
  apiGroups(user).then(r => {
    const sel = $('#waGrpList');
    if (!sel || !r || !r.ok) return;
    const en = (r.groups || []).filter(g => g.enabled);
    en.forEach(g => ZONAS_GRUPO.set(Number(g.id), g.zonas || []));
    sel.innerHTML = en.length
      ? en.map(g => {
          const z = (g.zonas || []);
          return `<label class="wa-grp"><input type="checkbox" value="${g.id}">
            <span class="wa-grp-n">${esc(g.alias || g.wa_name || g.chat_id)}</span>
            <span class="wa-grp-z">${z.length ? esc(z.join(' · ')) : 'sin zona'}</span></label>`;
        }).join('')
      : '<span class="wa-note">No hay grupos habilitados.</span>';
    sel.addEventListener('change', () => { invalidatePreview(); pintarPrevioZonas(); syncSendState(); });
    pintarPrevioZonas();
    if (r.mode === 'admin') {
      ['waSeg', 'waTgtCompanies', 'waTgtPeople', 'waTelBox'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      const os = $('#waOrsep');
      if (os) os.textContent = 'elige los grupos asignados a los que enviarás';
      if (!en.length) {
        $('#waTblNote').textContent = 'Aún no tienes grupos asignados: pídele al superadministrador que te autorice en la pantalla Grupos.';
      }
    }
  });

  // Facets (filtros del modo Empresas/Tiendas)
  const f = await api(user, { action: 'facets' });
  if (!f || !f.ok) {
    main.querySelector('.wa-card h3').insertAdjacentHTML('afterend',
      `<p style="color:#b91c1c;font-size:12.5px">${esc((f && f.error) || 'No se pudieron cargar los filtros.')}</p>`);
    return;
  }
  FACETS = f;
  fillFacets();

  // Listeners
  $('#waSeg').addEventListener('click', ev => {
    const b = ev.target.closest('.wa-segbtn');
    if (b && b.dataset.t !== TARGET) setTarget(b.dataset.t);
  });
  $('#waFZone').addEventListener('change', () => { syncSubzones(); invalidatePreview(); });
  ['waFSubzone', 'waFType', 'waFConcept', 'waFCompany'].forEach(id =>
    $('#' + id).addEventListener('change', invalidatePreview));
  $('#waFActive').addEventListener('change', invalidatePreview);
  $('#waFTel').addEventListener('input', invalidatePreview);
  $('#waMsg').addEventListener('input', () => { syncSendState(); pintarPrevioZonas(); avisarCaption(); });
  if ($('#waFile')) $('#waFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) subirMedia(user, f);
  });
  document.querySelectorAll('input[name="waMMode"]').forEach(r =>
    r.addEventListener('change', () => { avisarCaption(); syncSendState(); }));
  if ($('#waZoneGreet')) $('#waZoneGreet').addEventListener('change', pintarPrevioZonas);
  paintPeopleList();

  // v4.99: buscador de personas (modo lista manual)
  const doSearch = async () => {
    const q = $('#waPQ').value.trim();
    if (q.length < 2) { $('#waPResults').style.display = 'none'; return; }
    const btn = $('#waPSearch');
    btn.disabled = true; btn.textContent = 'Buscando…';
    const r = await api(user, { action: 'search_people', q });
    btn.disabled = false; btn.textContent = '🔎 Buscar';
    $('#waPResults').style.display = '';
    paintPeopleResults((r && r.ok && r.rows) || []);
  };
  $('#waPSearch').addEventListener('click', doSearch);
  $('#waPQ').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); doSearch(); } });

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
    $('#waFActive').checked = true;
    $('#waFTel').value = ''; $('#waMsg').value = '';
    document.querySelectorAll('#waGrpList input[type=checkbox]').forEach(c => { c.checked = false; });
    MEDIA = null;
    if ($('#waFile')) $('#waFile').value = '';
    pintarMedia();
    pintarPrevioZonas();
    $('#waPQ').value = ''; $('#waPResults').style.display = 'none'; $('#waPResults').innerHTML = '';
    PEOPLE = [];
    paintPeopleList();
    syncSubzones(); invalidatePreview();
  });

  $('#waPreview').addEventListener('click', async () => {
    const filters = currentFilters();
    if (filters.target === 'people' && !filters.people.length) {
      $('#waTblNote').textContent = 'Agrega al menos una persona a la lista con el buscador.';
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
    /* v6.188 — Rama de GRUPOS. Sin esto, PREVIEW.target reventaba con
       PREVIEW en null: era el tercer sitio del mismo camino que daba por
       hecho que siempre habia un preview hecho. */
    const gs = gruposMarcados().length;
    if (gs > 0) {
      const arch = MEDIA ? ` con ${MEDIA.es_imagen ? 'la imagen' : 'el PDF'} <b>${esc(MEDIA.file_name)}</b>` : '';
      const modo = MEDIA
        ? (modoMedia() === 'caption' ? ' (un solo mensaje, con el texto de pie)' : ' (dos mensajes: archivo y luego texto)')
        : '';
      // ~11,5s de pausa promedio entre grupos (8-15 con jitter).
      const seg = Math.round((gs - 1) * 11.5);
      const est = gs > 1
        ? ` Va a tardar alrededor de <b>${seg < 60 ? seg + ' s' : Math.ceil(seg / 60) + ' min'}</b>: el envío es pausado a propósito para cuidar la línea.`
        : '';
      return `<div class="wa-confirm">¿Confirmás la publicación en
        <b>&nbsp;${nf(gs)}&nbsp;</b> grupo${gs === 1 ? '' : 's'}${arch}${modo}?
        Esta acción no se puede deshacer.${est}</div>
        <button class="wa-btn danger" id="waConfNo">Cancelar</button>
        <button class="wa-btn wa" id="waConfYes">Sí, enviar ahora</button>`;
    }

    const n = msgCount();   // v5.05: neto (sin los excluidos a mano)
    const ent = netEntities();
    const nEx = EXCLUDED.size;
    const who = PREVIEW.target === 'companies'
      ? `<b>&nbsp;${nf(ent)}&nbsp;</b> empresa${ent === 1 ? '' : 's'} (<b>${nf(n)}</b> mensaje${n === 1 ? '' : 's'})`
      : `<b>&nbsp;${nf(n)}&nbsp;</b> destinatario${n === 1 ? '' : 's'}`;
    const exTxt = nEx ? ` Se omitirán <b>${nf(nEx)}</b> que quitaste de la lista.` : '';
    const est = n > 20 ? ` Duración estimada: <b>~${Math.max(1, Math.ceil(n * 3.3 / 60))} min</b> — el envío es pausado a propósito para cuidar la línea.` : '';
    return `<div class="wa-confirm">¿Confirmas la difusión a ${who}?${exTxt} Esta acción no se puede deshacer.${est}</div>
      <button class="wa-btn danger" id="waConfNo">Cancelar</button>
      <button class="wa-btn wa" id="waConfYes">Sí, enviar ahora</button>`;
  };

  $('#waSendBtn').addEventListener('click', () => {
    /* v6.188 — El clic NO exige PREVIEW cuando hay grupos marcados.
       Este era el bug de "le hago clic y no pasa nada": la v6.186 quito la
       exigencia de PREVIEW para HABILITAR el boton, pero la dejo aca, en el
       manejador. Resultado: el boton se veia activo, se pulsaba, y la
       primera linea hacia return en silencio. Mismo tipo de error que la
       propia v6.186 -cambiar un lado y dejar el otro-, esta vez dentro del
       mismo archivo. */
    if (SENDING) return;
    if (!PREVIEW && !gruposMarcados().length) return;
    // Confirmación inline (sin modales nativos)
    $('#waSendRow').innerHTML = confirmHtml();
    $('#waConfNo').addEventListener('click', () => renderSendRowIdle(user));
    $('#waConfYes').addEventListener('click', () => doSend(user));
  });

  function renderSendRowIdle() {
    $('#waSendRow').innerHTML = `
      <span class="wa-note">⚠️ Se publicará en los grupos marcados desde la línea corporativa, uno detrás de otro. Queda registrado con fecha y autor.</span>
      <span class="wa-why" id="waWhy"></span>
      <button class="wa-btn wa" id="waSendBtn" disabled>📤 Enviar</button>`;
    $('#waSendBtn').addEventListener('click', () => {
      /* v6.188 — El clic NO exige PREVIEW cuando hay grupos marcados.
       Este era el bug de "le hago clic y no pasa nada": la v6.186 quito la
       exigencia de PREVIEW para HABILITAR el boton, pero la dejo aca, en el
       manejador. Resultado: el boton se veia activo, se pulsaba, y la
       primera linea hacia return en silencio. Mismo tipo de error que la
       propia v6.186 -cambiar un lado y dejar el otro-, esta vez dentro del
       mismo archivo. */
    if (SENDING) return;
    if (!PREVIEW && !gruposMarcados().length) return;
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
    const r = await api(user, {
      action: 'send', ...filters, message,
      // v6.187: el archivo ya esta en el bucket; aca solo viaja la referencia.
      media: MEDIA ? { path: MEDIA.path, mime: MEDIA.mime, file_name: MEDIA.file_name } : null,
      media_mode: MEDIA ? modoMedia() : null,
    });
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
