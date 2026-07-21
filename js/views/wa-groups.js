/* =====================================================================
   js/views/wa-groups.js  →  vista "Grupos" (grupo WhatsApp)  v6.53
   Mockup aprobado: _PRUEBAS/wa_grupos_reforma_mockup.html (v0-mock2).

   Catalogo de grupos de WhatsApp donde la linea corporativa ES MIEMBRO.
   "Sincronizar con WhatsApp" (action discover) refleja la linea AHORA:
   agrega los grupos nuevos, refresca nombres y QUITA los que ya no la
   tienen. El superadmin habilita cuales pueden usarse en Difusion, les
   pone alias interno y gestiona quien puede publicar en cada uno.

   Reforma v6.53: la tabla queda limpia (sin chips de admins en la fila);
   los "autorizados" se gestionan en una PAGINA PROPIA (con Volver), en
   dos columnas: equipo disponible (con buscador) y autorizados del grupo.
   La fila solo muestra un contador que abre esa pagina.

   Acciones nuevas de esta version:
     - discover ahora sincroniza (agrega + quita)   [backend v6.53]
     - remove_all: vaciar el catalogo               [backend v6.53]
   Export: renderWaGroups(user)
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let GROUPS = [];
let ASSIGN = [];   // [{group_id, admin_id}]
let ADMINS = [];   // admins activos no-super [{id,name,username,role?}]
let USER = null;   // usuario en sesion (para las llamadas api)
let AUTH_GID = 0;  // grupo abierto en la pagina de autorizados (0 = lista)

async function api(user, payload) {
  return fetch('/api/wa-groups', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null },
      ...payload,
    }),
  }).then(x => x.json()).catch(() => null);
}

function ensureStyles() {
  if (document.getElementById('waGroupsStyles')) return;
  const st = document.createElement('style');
  st.id = 'waGroupsStyles';
  st.textContent = `
  .wg-wrap{max-width:1080px}
  .wg-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:16px}
  .wg-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:9px}
  .wg-head p{margin:3px 0 0;color:var(--muted);font-size:13px;max-width:660px}
  .wg-ic{width:30px;height:30px;border-radius:9px;background:#e9fbf0;color:#128c7e;display:grid;place-items:center;flex:none}
  .wg-btn{border:1px solid var(--border);background:var(--surface,#fff);border-radius:10px;padding:9px 16px;font:inherit;font-size:13px;font-weight:600;color:var(--ink-soft,#475569);cursor:pointer;white-space:nowrap}
  .wg-btn.wa{background:#128c7e;border-color:#128c7e;color:#fff;font-weight:700}
  .wg-btn.mini{padding:6px 12px;font-size:12px;border-radius:8px}
  .wg-btn.danger{color:#b91c1c;border-color:#fecaca;background:#fff}
  .wg-btn.danger:hover{background:#fef2f2}
  .wg-btn:disabled{opacity:.5;cursor:default}
  .wg-headbtns{display:flex;gap:8px;flex-wrap:wrap}
  .wg-card{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;padding:16px 18px;margin-bottom:14px}
  .wg-hint{font-size:12px;color:#92400e;background:var(--warn-bg,#fffbeb);border:1px solid #fde68a;border-radius:9px;padding:8px 12px;margin-bottom:13px}
  .wg-table{width:100%;border-collapse:collapse;font-size:13px}
  .wg-table th{padding:8px 10px;background:#fbfcfe;border-bottom:1px solid var(--border);font-size:10.5px;font-weight:800;color:var(--ink-soft,#475569);text-transform:uppercase;letter-spacing:.04em;text-align:left}
  .wg-table td{padding:10px;border-bottom:1px solid var(--border-soft,#f1f4f8);vertical-align:middle;color:var(--ink)}
  .wg-gname{font-weight:700}
  .wg-gid{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10.5px;color:var(--muted)}
  .wg-table td input.wg-alias{width:100%;font:inherit;font-size:12.5px;padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--surface,#fff);color:var(--ink)}
  .wg-table td input.wg-alias::placeholder{color:#b6bfcc}
  .wg-sw{position:relative;display:inline-block;width:38px;height:21px;cursor:pointer}
  .wg-sw i{position:absolute;inset:0;background:#d7dde6;border-radius:999px;transition:.15s}
  .wg-sw i::after{content:'';position:absolute;top:2.5px;left:3px;width:16px;height:16px;background:#fff;border-radius:50%;transition:.15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
  .wg-sw.on i{background:#25d366}
  .wg-sw.on i::after{left:19px}
  .wg-en{display:inline-block;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:800;background:#e9fbf0;color:#0f7a4d;border:1px solid #bbf1d2}
  .wg-off{display:inline-block;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:800;background:#f1f5f9;color:#64748b;border:1px solid var(--border)}
  .wg-authbtn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);background:#fff;border-radius:999px;padding:4px 11px 4px 9px;font:inherit;font-size:12px;font-weight:600;color:var(--ink-soft,#475569);cursor:pointer}
  .wg-authbtn:hover{border-color:var(--pri,#2563eb);color:var(--pri,#2563eb)}
  .wg-authbtn .cnt{background:var(--pri,#2563eb);color:#fff;border-radius:999px;min-width:18px;height:18px;display:inline-grid;place-items:center;font-size:11px;font-weight:800;padding:0 5px}
  .wg-authbtn.zero .cnt{background:#cbd5e1}
  .wg-authbtn .arw{color:var(--muted);font-weight:800}
  .wg-rowacts{display:flex;gap:6px;justify-content:flex-end}
  .wg-saved{font-size:11px;color:#0f7a4d;font-weight:700;margin-left:6px}
  .wg-err{font-size:11px;color:#b91c1c;font-weight:700;margin-left:6px}
  .wg-note{font-size:11px;color:var(--muted);margin-top:8px}
  .wg-fb{font-size:11px;font-weight:700;margin-left:6px}
  .wg-empty{text-align:center;padding:36px 20px;color:var(--muted)}
  .wg-empty .big{font-size:34px;margin-bottom:8px}
  .wg-empty b{color:var(--ink)}
  /* confirmacion inline (barra roja) */
  .wg-confirm{font-size:12.5px;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:9px;padding:10px 13px;margin-bottom:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .wg-confirm .sp{flex:1;min-width:180px}
  /* ---------- pagina de autorizados ---------- */
  .wg-back{display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:13px;font-weight:600;color:var(--ink-soft,#475569);cursor:pointer;margin-bottom:14px;border:none;background:none}
  .wg-back:hover{color:var(--pri,#2563eb)}
  .wg-ptitle{display:flex;align-items:center;gap:10px;margin-bottom:3px}
  .wg-ptitle .gn{font-size:19px;font-weight:700;color:var(--ink)}
  .wg-psub{color:var(--muted);font-size:13px;margin-bottom:18px}
  .wg-psub .gid2{font-family:ui-monospace,monospace;font-size:11px}
  .wg-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:720px){.wg-cols{grid-template-columns:1fr}}
  .wg-col{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;padding:0;overflow:hidden}
  .wg-colh{padding:12px 15px;border-bottom:1px solid var(--border);font-size:12.5px;font-weight:800;color:var(--ink-soft,#475569);display:flex;align-items:center;justify-content:space-between;background:#fbfcfe}
  .wg-colh .n{background:#eef2f7;border-radius:999px;padding:1px 9px;font-size:11px;color:var(--muted)}
  .wg-colh.auth{background:#e9fbf0;color:#0f7a4d;border-color:#bbf1d2}
  .wg-colh.auth .n{background:#bbf1d2;color:#0f7a4d}
  .wg-search{padding:11px 13px;border-bottom:1px solid var(--border-soft,#f1f4f8)}
  .wg-search input{width:100%;font:inherit;font-size:13px;padding:8px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink)}
  .wg-plist{max-height:360px;overflow:auto}
  .wg-prow{display:flex;align-items:center;gap:11px;padding:9px 14px;border-bottom:1px solid var(--border-soft,#f1f4f8)}
  .wg-prow:last-child{border-bottom:none}
  .wg-av{width:30px;height:30px;border-radius:50%;background:#e8eefb;color:#3b60c4;display:grid;place-items:center;font-size:12px;font-weight:800;flex:none}
  .wg-av.on{background:#d1fae5;color:#0f7a4d}
  .wg-pmeta{flex:1;min-width:0}
  .wg-pn{font-weight:600;font-size:13px;color:var(--ink)}
  .wg-pr{font-size:11px;color:var(--muted)}
  .wg-padd{border:1px solid var(--border);background:#fff;border-radius:8px;width:30px;height:30px;font-size:17px;line-height:1;color:var(--pri,#2563eb);cursor:pointer;flex:none}
  .wg-padd:hover{background:#eef2ff}
  .wg-prm{border:1px solid #fecaca;background:#fff;border-radius:8px;width:30px;height:30px;font-size:15px;line-height:1;color:#b91c1c;cursor:pointer;flex:none}
  .wg-prm:hover{background:#fef2f2}
  .wg-colempty{padding:26px 16px;text-align:center;color:var(--muted);font-size:12.5px}
  .wg-roletag{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;padding:1px 7px;border-radius:999px;background:#fef3c7;color:#92400e;margin-left:6px}`;
  document.head.appendChild(st);
}

function fmtWhen(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('es-VE', {
      timeZone: 'America/Caracas', day: '2-digit', month: '2-digit',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch (_) { return ''; }
}

function initials(name) {
  const p = String(name || '').trim().split(/\s+/);
  return ((p[0] || '')[0] || '' ) + ((p[1] || '')[0] || '');
}

function countAuth(gid) {
  return ASSIGN.filter(a => a.group_id === gid).length;
}

/* ------------------------------------------------------------------ */
/* VISTA 1: LISTA DE GRUPOS                                           */
/* ------------------------------------------------------------------ */
function paintTable() {
  const box = $('#wgBody');
  if (!GROUPS.length) {
    box.innerHTML = `<div class="wg-empty">
      <div class="big">👥</div>
      <b>Aún no hay grupos.</b><br>
      La línea corporativa debe ser <b>miembro</b> de un grupo de WhatsApp para poder verlo y enviarle.<br>
      Agrégala al grupo desde WhatsApp y pulsa «Sincronizar con WhatsApp».
    </div>`;
    $('#wgNote').textContent = '';
    return;
  }
  box.innerHTML = `<table class="wg-table">
    <thead><tr>
      <th style="width:28%">Grupo en WhatsApp</th>
      <th style="width:22%">Alias interno (opcional)</th>
      <th style="width:9%">Miembros</th>
      <th style="width:10%">Difusión</th>
      <th style="width:10%">Estado</th>
      <th style="width:12%">Autorizados</th>
      <th></th>
    </tr></thead>
    <tbody>${GROUPS.map(g => {
      const n = countAuth(g.id);
      const memb = (g.participants != null && Number.isFinite(Number(g.participants)))
        ? `${Number(g.participants).toLocaleString('es-VE')}`
        : '<span style="color:var(--muted)" title="Se completa al sincronizar">—</span>';
      return `<tr data-id="${g.id}">
      <td><div class="wg-gname">${esc(g.wa_name || '(sin nombre)')}</div><div class="wg-gid">${esc(g.chat_id)}</div></td>
      <td><input class="wg-alias" value="${esc(g.alias || '')}" placeholder="Sin alias" maxlength="80"></td>
      <td>${memb}</td>
      <td><span class="wg-sw ${g.enabled ? 'on' : ''}" title="Habilitar para difusión"><i></i></span></td>
      <td>${g.enabled ? '<span class="wg-en">Habilitado</span>' : '<span class="wg-off">No habilitado</span>'}</td>
      <td><button class="wg-authbtn ${n ? '' : 'zero'} wg-openauth"><span class="cnt">${n}</span> ${n === 1 ? 'autorizado' : 'autorizados'} <span class="arw">›</span></button></td>
      <td><div class="wg-rowacts"><button class="wg-btn mini wg-save">Guardar</button> <button class="wg-btn mini danger wg-remove">Quitar</button><span class="wg-fb"></span></div></td>
    </tr>`;
    }).join('')}</tbody>
  </table>`;

  const latest = GROUPS.map(g => g.refreshed_at).filter(Boolean).sort().pop();
  $('#wgNote').textContent = `${latest ? 'Última sincronización: ' + fmtWhen(latest) + ' · ' : ''}${GROUPS.length} grupo${GROUPS.length === 1 ? '' : 's'} · Los no habilitados jamás aparecen en Difusión.`;

  // Toggle (solo visual hasta Guardar)
  box.querySelectorAll('.wg-sw').forEach(sw => sw.addEventListener('click', () => sw.classList.toggle('on')));

  // Abrir pagina de autorizados
  box.querySelectorAll('.wg-openauth').forEach(btn => btn.addEventListener('click', () => {
    const id = Number(btn.closest('tr').dataset.id);
    openAuthPage(id);
  }));

  // Guardar por fila (alias + enabled)
  box.querySelectorAll('.wg-save').forEach(btn => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    const id = Number(tr.dataset.id);
    const alias = tr.querySelector('.wg-alias').value;
    const enabled = tr.querySelector('.wg-sw').classList.contains('on');
    const fb = tr.querySelector('.wg-fb');
    btn.disabled = true; fb.className = 'wg-fb'; fb.textContent = '';
    const r = await api(USER, { action: 'save', id, alias, enabled });
    btn.disabled = false;
    if (r && r.ok) {
      const i = GROUPS.findIndex(x => x.id === id);
      if (i >= 0) GROUPS[i] = r.group;
      // El estado "Habilitado/No habilitado" esta en la 5a celda (tras sumar
      // la columna Miembros en la 3a). Se repinta sin recargar toda la tabla.
      tr.querySelector('td:nth-child(5)').innerHTML = r.group.enabled
        ? '<span class="wg-en">Habilitado</span>' : '<span class="wg-off">No habilitado</span>';
      fb.className = 'wg-fb wg-saved'; fb.textContent = '✓ guardado';
      setTimeout(() => { fb.textContent = ''; fb.className = 'wg-fb'; }, 2500);
    } else {
      fb.className = 'wg-fb wg-err'; fb.textContent = (r && r.error) || 'Error';
    }
  }));

  // Quitar un grupo (confirmacion inline en la celda de acciones)
  box.querySelectorAll('.wg-remove').forEach(btn => btn.addEventListener('click', () => {
    const tr = btn.closest('tr');
    const id = Number(tr.dataset.id);
    const g = GROUPS.find(x => x.id === id) || {};
    const n = countAuth(id);
    const cell = btn.closest('td');
    const warn = g.enabled
      ? ' Está <b>habilitado</b> para Difusión.'
      : (n ? ` Tiene <b>${n}</b> autorizado${n === 1 ? '' : 's'}.` : '');
    cell.innerHTML = `<div style="font-size:11.5px;color:#991b1b;margin-bottom:5px">¿Quitar «${esc(g.wa_name || g.alias || 'este grupo')}»?${warn}</div>
      <div class="wg-rowacts"><button class="wg-btn mini danger wg-rmyes">Sí, quitar</button> <button class="wg-btn mini wg-rmno">Cancelar</button><span class="wg-fb"></span></div>`;
    cell.querySelector('.wg-rmno').addEventListener('click', () => paintTable());
    cell.querySelector('.wg-rmyes').addEventListener('click', async () => {
      const yes = cell.querySelector('.wg-rmyes');
      const fb = cell.querySelector('.wg-fb');
      yes.disabled = true; fb.className = 'wg-fb'; fb.textContent = '';
      const r = await api(USER, { action: 'remove', id });
      if (r && r.ok) {
        GROUPS = GROUPS.filter(x => x.id !== id);
        ASSIGN = ASSIGN.filter(a => a.group_id !== id);
        paintTable();
      } else {
        yes.disabled = false;
        fb.className = 'wg-fb wg-err'; fb.textContent = (r && r.error) || 'Error';
      }
    });
  }));
}

/* ------------------------------------------------------------------ */
/* VISTA 2: PAGINA DE AUTORIZADOS DE UN GRUPO                         */
/* ------------------------------------------------------------------ */
function openAuthPage(gid) {
  AUTH_GID = gid;
  $('#wgListView').style.display = 'none';
  $('#wgAuthView').style.display = '';
  paintAuth();
  window.scrollTo(0, 0);
}

function backToList() {
  AUTH_GID = 0;
  $('#wgAuthView').style.display = 'none';
  $('#wgListView').style.display = '';
  paintTable();
  window.scrollTo(0, 0);
}

function paintAuth(filter = '') {
  const g = GROUPS.find(x => x.id === AUTH_GID) || {};
  const mine = ASSIGN.filter(a => a.group_id === AUTH_GID).map(a => a.admin_id);
  const f = filter.trim().toLowerCase();

  // columna izquierda: equipo NO autorizado (filtrable)
  const avail = ADMINS.filter(a => !mine.includes(a.id))
    .filter(a => !f || (a.name || '').toLowerCase().includes(f) || (a.username || '').toLowerCase().includes(f));
  // columna derecha: autorizados
  const auth = ADMINS.filter(a => mine.includes(a.id));

  const host = $('#wgAuthView');
  host.innerHTML = `
    <button class="wg-back" id="wgBack">‹ Volver a Grupos</button>
    <div class="wg-ptitle">
      <span class="wg-ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg></span>
      <span class="gn">${esc(g.wa_name || '(sin nombre)')}</span>
    </div>
    <div class="wg-psub">Quién del equipo puede publicar en este grupo desde <b>Difusión</b>. El superadministrador siempre puede; aquí autorizas al resto. <span class="gid2">${esc(g.chat_id || '')}</span></div>
    <div class="wg-cols">
      <div class="wg-col">
        <div class="wg-colh">Equipo <span class="n">${avail.length}</span></div>
        <div class="wg-search"><input id="wgSearch" placeholder="🔍 Buscar por nombre…" value="${esc(filter)}"></div>
        <div class="wg-plist" id="wgAvail">${
          avail.length ? avail.map(a => `
            <div class="wg-prow" data-aid="${a.id}">
              <div class="wg-av">${esc(initials(a.name || a.username))}</div>
              <div class="wg-pmeta"><div class="wg-pn">${esc(a.name || a.username)}${a.role === 'coordinador' ? '<span class="wg-roletag">Coordinador</span>' : ''}</div><div class="wg-pr">${esc(a.username || '')}</div></div>
              <button class="wg-padd" title="Autorizar">+</button>
            </div>`).join('')
          : `<div class="wg-colempty">${f ? 'Nadie coincide con la búsqueda.' : 'Todo el equipo ya está autorizado.'}</div>`
        }</div>
      </div>
      <div class="wg-col">
        <div class="wg-colh auth">✓ Autorizados en este grupo <span class="n">${auth.length}</span></div>
        <div class="wg-plist" id="wgAuthed">${
          auth.length ? auth.map(a => `
            <div class="wg-prow" data-aid="${a.id}">
              <div class="wg-av on">${esc(initials(a.name || a.username))}</div>
              <div class="wg-pmeta"><div class="wg-pn">${esc(a.name || a.username)}${a.role === 'coordinador' ? '<span class="wg-roletag">Coordinador</span>' : ''}</div><div class="wg-pr">${esc(a.username || '')}</div></div>
              <button class="wg-prm" title="Quitar autorización">×</button>
            </div>`).join('')
          : `<div class="wg-colempty">Nadie autorizado todavía.<br>Agrega personas del equipo desde la izquierda.</div>`
        }</div>
      </div>
    </div>`;

  $('#wgBack').addEventListener('click', backToList);

  const search = $('#wgSearch');
  search.addEventListener('input', () => {
    const pos = search.selectionStart;
    paintAuth(search.value);
    const s2 = $('#wgSearch');
    if (s2) { s2.focus(); try { s2.setSelectionRange(pos, pos); } catch (_) {} }
  });

  // Autorizar (grant)
  $('#wgAvail').querySelectorAll('.wg-padd').forEach(btn => btn.addEventListener('click', async () => {
    const aid = Number(btn.closest('.wg-prow').dataset.aid);
    btn.disabled = true;
    const r = await api(USER, { action: 'grant', group_id: AUTH_GID, admin_id: aid });
    if (r && r.ok) { ASSIGN = r.assign || ASSIGN; paintAuth(search.value); }
    else { btn.disabled = false; }
  }));

  // Quitar autorizacion (revoke)
  $('#wgAuthed').querySelectorAll('.wg-prm').forEach(btn => btn.addEventListener('click', async () => {
    const aid = Number(btn.closest('.wg-prow').dataset.aid);
    btn.disabled = true;
    const r = await api(USER, { action: 'revoke', group_id: AUTH_GID, admin_id: aid });
    if (r && r.ok) { ASSIGN = r.assign || ASSIGN; paintAuth(search.value); }
    else { btn.disabled = false; }
  }));
}

/* ------------------------------------------------------------------ */
/* RENDER PRINCIPAL                                                    */
/* ------------------------------------------------------------------ */
export async function renderWaGroups(user) {
  ensureStyles();
  GROUPS = []; ASSIGN = []; ADMINS = []; USER = user; AUTH_GID = 0;
  const main = document.getElementById('pnlMain');
  main.innerHTML = `<div class="wg-wrap">
    <div id="wgListView">
      <div class="wg-head">
        <div>
          <h1><span class="wg-ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg></span>
          Grupos</h1>
          <p>Grupos de WhatsApp donde participa la línea corporativa. Habilita los que pueden usarse como destino en Difusión y gestiona quién puede publicar en cada uno.</p>
        </div>
        <div class="wg-headbtns">
          <button class="wg-btn danger" id="wgRemoveAll">🗑 Quitar todos</button>
          <button class="wg-btn wa" id="wgDiscover">🔄 Sincronizar con WhatsApp</button>
        </div>
      </div>
      <div class="wg-card">
        <div class="wg-hint">💡 <b>Sincronizar</b> refleja lo que hay en WhatsApp ahora: agrega los grupos nuevos donde entró la línea<span id="wgPhone"></span> y quita los que ya no la tienen. El nombre real se refresca; el alias y los autorizados son tuyos y se conservan.</div>
        <div id="wgConfirmAll"></div>
        <div id="wgBody"><div class="wg-empty">Cargando…</div></div>
        <div class="wg-note" id="wgNote"></div>
      </div>
    </div>
    <div id="wgAuthView" style="display:none"></div>
  </div>`;

  // Sincronizar
  $('#wgDiscover').addEventListener('click', async () => {
    const btn = $('#wgDiscover');
    btn.disabled = true; btn.textContent = 'Sincronizando…';
    const r = await api(user, { action: 'discover' });
    btn.disabled = false; btn.textContent = '🔄 Sincronizar con WhatsApp';
    if (r && r.ok) {
      GROUPS = r.groups || [];
      ASSIGN = r.assign || ASSIGN;
      ADMINS = r.admins || ADMINS;
      paintTable();
      const parts = [];
      if (r.found != null) parts.push(`${r.found} en la línea`);
      if (r.removed) parts.push(`${r.removed} quitado${r.removed === 1 ? '' : 's'}`);
      if (parts.length) {
        const note = $('#wgNote');
        note.textContent = `Sincronizado: ${parts.join(' · ')}. ` + note.textContent;
      }
    } else {
      $('#wgNote').textContent = (r && r.error) || 'No se pudo consultar la línea.';
    }
  });

  // Quitar todos (confirmacion inline)
  $('#wgRemoveAll').addEventListener('click', () => {
    if (!GROUPS.length) return;
    const host = $('#wgConfirmAll');
    host.innerHTML = `<div class="wg-confirm">
      <span class="sp">¿Quitar <b>los ${GROUPS.length}</b> grupos del catálogo? Esto también borra sus autorizados. Podrás volver a traerlos con «Sincronizar».</span>
      <button class="wg-btn mini danger" id="wgRmAllYes">Sí, quitar todos</button>
      <button class="wg-btn mini" id="wgRmAllNo">Cancelar</button></div>`;
    $('#wgRmAllNo').addEventListener('click', () => { host.innerHTML = ''; });
    $('#wgRmAllYes').addEventListener('click', async () => {
      const yes = $('#wgRmAllYes'); yes.disabled = true;
      const r = await api(user, { action: 'remove_all' });
      if (r && r.ok) {
        GROUPS = []; ASSIGN = [];
        host.innerHTML = '';
        paintTable();
      } else {
        yes.disabled = false;
        host.querySelector('.sp').textContent = (r && r.error) || 'No se pudo completar.';
      }
    });
  });

  const r = await api(user, { action: 'list' });
  GROUPS = (r && r.ok && r.groups) || [];
  ASSIGN = (r && r.ok && r.assign) || [];
  ADMINS = (r && r.ok && r.admins) || [];
  if (r && r.ok && r.phone) {
    const sp = $('#wgPhone');
    if (sp) sp.textContent = ' (' + r.phone + ')';
  }
  paintTable();
}
