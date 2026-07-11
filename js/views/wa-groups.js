/* =====================================================================
   js/views/wa-groups.js  →  vista "Grupos" (grupo WhatsApp)  v4.93
   Mockup aprobado: _PRUEBAS/wa_grupos_mockup.html (v0-mock1).

   Catalogo de grupos de WhatsApp donde la linea corporativa ES MIEMBRO.
   "Buscar grupos de la linea" consulta al proveedor (via /api/wa-groups
   action discover), refresca el nombre real y conserva alias/toggle.
   El superadmin habilita cuales pueden usarse como destino en Difusion
   y les pone un alias interno del portal.

   FUTURO: habilitar grupos por admin (tabla puente wa_group_admins);
   esta pantalla ganara una columna de asignacion.
   Export: renderWaGroups(user)
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let GROUPS = [];

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
  st.id = 'waGroupsStyles';   // regla v4.89: id = nombre largo de la vista
  st.textContent = `
  .wg-wrap{max-width:1040px}
  .wg-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:16px}
  .wg-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:9px}
  .wg-head p{margin:3px 0 0;color:var(--muted);font-size:13px;max-width:640px}
  .wg-ic{width:30px;height:30px;border-radius:9px;background:#e9fbf0;color:#128c7e;display:grid;place-items:center;flex:none}
  .wg-btn{border:1px solid var(--border);background:var(--surface,#fff);border-radius:10px;padding:9px 16px;font:inherit;font-size:13px;font-weight:600;color:var(--ink-soft,#475569);cursor:pointer;white-space:nowrap}
  .wg-btn.wa{background:#128c7e;border-color:#128c7e;color:#fff;font-weight:700}
  .wg-btn.mini{padding:6px 12px;font-size:12px;border-radius:8px}
  .wg-btn:disabled{opacity:.5;cursor:default}
  .wg-card{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;padding:16px 18px;margin-bottom:14px}
  .wg-hint{font-size:12px;color:#92400e;background:var(--warn-bg,#fffbeb);border:1px solid #fde68a;border-radius:9px;padding:8px 12px;margin-bottom:13px}
  .wg-table{width:100%;border-collapse:collapse;font-size:13px}
  .wg-table th{padding:8px 10px;background:#fbfcfe;border-bottom:1px solid var(--border);font-size:10.5px;font-weight:800;color:var(--ink-soft,#475569);text-transform:uppercase;letter-spacing:.04em;text-align:left}
  .wg-table td{padding:9px 10px;border-bottom:1px solid var(--border-soft,#f1f4f8);vertical-align:middle;color:var(--ink)}
  .wg-gname{font-weight:700}
  .wg-gid{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10.5px;color:var(--muted)}
  .wg-table td input{width:100%;font:inherit;font-size:12.5px;padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--surface,#fff);color:var(--ink)}
  .wg-table td input::placeholder{color:#b6bfcc}
  .wg-sw{position:relative;display:inline-block;width:38px;height:21px;cursor:pointer}
  .wg-sw i{position:absolute;inset:0;background:#d7dde6;border-radius:999px;transition:.15s}
  .wg-sw i::after{content:'';position:absolute;top:2.5px;left:3px;width:16px;height:16px;background:#fff;border-radius:50%;transition:.15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
  .wg-sw.on i{background:#25d366}
  .wg-sw.on i::after{left:19px}
  .wg-en{display:inline-block;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:800;background:#e9fbf0;color:#0f7a4d;border:1px solid #bbf1d2}
  .wg-off{display:inline-block;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:800;background:#f1f5f9;color:#64748b;border:1px solid var(--border)}
  .wg-saved{font-size:11px;color:#0f7a4d;font-weight:700;margin-left:6px}
  .wg-err{font-size:11px;color:#b91c1c;font-weight:700;margin-left:6px}
  .wg-note{font-size:11px;color:var(--muted);margin-top:8px}
  .wg-empty{text-align:center;padding:36px 20px;color:var(--muted)}
  .wg-empty .big{font-size:34px;margin-bottom:8px}
  .wg-empty b{color:var(--ink)}`;
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

function paintTable(user) {
  const box = $('#wgBody');
  if (!GROUPS.length) {
    box.innerHTML = `<div class="wg-empty">
      <div class="big">👥</div>
      <b>Aún no hay grupos descubiertos.</b><br>
      La línea corporativa debe ser <b>miembro</b> de un grupo de WhatsApp para poder verlo y enviarle.<br>
      Agrégala al grupo desde WhatsApp y pulsa «Buscar grupos de la línea».
    </div>`;
    $('#wgNote').textContent = '';
    return;
  }
  box.innerHTML = `<table class="wg-table">
    <thead><tr>
      <th style="width:34%">Grupo en WhatsApp</th>
      <th style="width:30%">Alias interno (opcional)</th>
      <th style="width:13%">Difusión</th>
      <th style="width:13%">Estado</th>
      <th></th>
    </tr></thead>
    <tbody>${GROUPS.map(g => `<tr data-id="${g.id}">
      <td><div class="wg-gname">${esc(g.wa_name || '(sin nombre)')}</div><div class="wg-gid">${esc(g.chat_id)}</div></td>
      <td><input class="wg-alias" value="${esc(g.alias || '')}" placeholder="Sin alias" maxlength="80"></td>
      <td><span class="wg-sw ${g.enabled ? 'on' : ''}" title="Habilitar para difusión"><i></i></span></td>
      <td>${g.enabled ? '<span class="wg-en">Habilitado</span>' : '<span class="wg-off">No habilitado</span>'}</td>
      <td><button class="wg-btn mini wg-save">Guardar</button><span class="wg-fb"></span></td>
    </tr>`).join('')}</tbody>
  </table>`;

  const latest = GROUPS.map(g => g.refreshed_at).filter(Boolean).sort().pop();
  $('#wgNote').textContent = `${latest ? 'Última búsqueda: ' + fmtWhen(latest) + ' · ' : ''}${GROUPS.length} grupo${GROUPS.length === 1 ? '' : 's'} · Los no habilitados jamás aparecen en Difusión.`;

  // Toggle (solo visual hasta Guardar)
  box.querySelectorAll('.wg-sw').forEach(sw => sw.addEventListener('click', () => sw.classList.toggle('on')));

  // Guardar por fila
  box.querySelectorAll('.wg-save').forEach(btn => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    const id = Number(tr.dataset.id);
    const alias = tr.querySelector('.wg-alias').value;
    const enabled = tr.querySelector('.wg-sw').classList.contains('on');
    const fb = tr.querySelector('.wg-fb');
    btn.disabled = true; fb.className = 'wg-fb'; fb.textContent = '';
    const r = await api(user, { action: 'save', id, alias, enabled });
    btn.disabled = false;
    if (r && r.ok) {
      const i = GROUPS.findIndex(x => x.id === id);
      if (i >= 0) GROUPS[i] = r.group;
      tr.querySelector('td:nth-child(4)').innerHTML = r.group.enabled
        ? '<span class="wg-en">Habilitado</span>' : '<span class="wg-off">No habilitado</span>';
      fb.className = 'wg-fb wg-saved'; fb.textContent = '✓ guardado';
      setTimeout(() => { fb.textContent = ''; }, 2500);
    } else {
      fb.className = 'wg-fb wg-err'; fb.textContent = (r && r.error) || 'Error';
    }
  }));
}

export async function renderWaGroups(user) {
  ensureStyles();
  GROUPS = [];
  const main = document.getElementById('pnlMain');
  main.innerHTML = `<div class="wg-wrap">
    <div class="wg-head">
      <div>
        <h1><span class="wg-ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg></span>
        Grupos</h1>
        <p>Grupos de WhatsApp donde participa la línea corporativa. Habilita los que pueden usarse como destino en Difusión y ponles un nombre interno del portal.</p>
      </div>
      <button class="wg-btn wa" id="wgDiscover">🔄 Buscar grupos de la línea</button>
    </div>
    <div class="wg-card">
      <div class="wg-hint">💡 Solo aparecen grupos donde la línea<span id="wgPhone"></span> <b>es miembro</b>. Si falta uno, agrégala al grupo desde WhatsApp y vuelve a buscar. El nombre real se refresca en cada búsqueda; el alias es tuyo y no se toca.</div>
      <div id="wgBody"><div class="wg-empty">Cargando…</div></div>
      <div class="wg-note" id="wgNote"></div>
    </div>
  </div>`;

  $('#wgDiscover').addEventListener('click', async () => {
    const btn = $('#wgDiscover');
    btn.disabled = true; btn.textContent = 'Buscando…';
    const r = await api(user, { action: 'discover' });
    btn.disabled = false; btn.textContent = '🔄 Buscar grupos de la línea';
    if (r && r.ok) {
      GROUPS = r.groups || [];
      paintTable(user);
    } else {
      $('#wgNote').textContent = (r && r.error) || 'No se pudo consultar la línea.';
    }
  });

  const r = await api(user, { action: 'list' });
  GROUPS = (r && r.ok && r.groups) || [];
  if (r && r.ok && r.phone) {
    const sp = $('#wgPhone');
    if (sp) sp.textContent = ' (' + r.phone + ')';
  }
  paintTable(user);
}
