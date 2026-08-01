/* =====================================================================
   js/views/wa-routing.js  →  vista "Ruteo de avisos" (WhatsApp)   v6.154
   Donde se decide QUE grupo de WhatsApp recibe los avisos de Naima de cada
   ZONA, y CUALES avisos estan prendidos.

   Tres controles, de mas grueso a mas fino:
     1. Interruptor MAESTRO: apaga TODOS los avisos al instante (sin deploy).
     2. Interruptor POR TIPO: se puede dejar prendido el aviso de Ingresos y
        apagar solo el de Constancias, por ejemplo.
     3. Ruteo por zona: cada zona elige su grupo. Varias zonas pueden apuntar
        al mismo grupo. Zona SIN grupo = no manda aviso (asi se hace el
        rollout gradual: se arranca con una zona piloto y se van sumando).

   Guardar es solo para el superadministrador (gobernanza de la linea, igual
   que el catalogo de Grupos). El resto, con view.whatsapp, ve la pantalla en
   modo lectura.

   En la UI se dice "la linea" / "los grupos", nunca el nombre del proveedor.
   Export: renderWaRouting(user)
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let DATA = null;      // respuesta cruda de 'load'
let ROUTES = {};      // zone_id -> group_id | null  (estado editable)
let TYPES = new Set();
let ENABLED = false;
let RUSER = null;
let DIRTY = false;

async function api(user, payload) {
  return fetch('/api/wa-routing', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null },
      ...payload,
    }),
  }).then(x => x.json()).catch(() => null);
}

function ensureStyles() {
  if (document.getElementById('waRouteStyles')) return;
  const st = document.createElement('style');
  st.id = 'waRouteStyles';
  st.textContent = `
  .wr-wrap{max-width:960px}
  .wr-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:16px}
  .wr-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:9px}
  .wr-head p{margin:3px 0 0;color:var(--muted);font-size:13px;max-width:640px}
  .wr-ic{width:30px;height:30px;border-radius:9px;background:#e9fbf0;color:#128c7e;display:grid;place-items:center;flex:none}
  .wr-card{background:var(--card,#fff);border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-bottom:14px}
  .wr-cardh{padding:12px 16px;border-bottom:1px solid var(--border);font-size:13px;font-weight:700;color:var(--ink-soft,#475569);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
  .wr-cardh .mut{font-weight:400;color:var(--muted);font-size:11.5px}
  /* interruptor maestro */
  .wr-master{display:flex;align-items:center;gap:14px;padding:14px 16px;flex-wrap:wrap}
  .wr-master .txt{flex:1 1 260px;min-width:0}
  .wr-master .txt b{font-size:14px;color:var(--ink)}
  .wr-master .txt div{font-size:12px;color:var(--muted);margin-top:2px}
  .wr-sw{position:relative;width:50px;height:28px;border-radius:999px;background:#cbd5e1;border:none;flex:none;cursor:pointer;transition:background .15s}
  .wr-sw::after{content:'';position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 3px rgba(0,0,0,.25)}
  .wr-sw.on{background:#128c7e}
  .wr-sw.on::after{transform:translateX(22px)}
  .wr-sw:disabled{opacity:.5;cursor:not-allowed}
  .wr-state{font-size:12px;font-weight:700;white-space:nowrap}
  .wr-state.on{color:#1f7a44}
  .wr-state.off{color:#b45309}
  /* tipos */
  .wr-types{display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px}
  .wr-type{display:flex;align-items:center;gap:7px;font-size:12.5px;padding:7px 12px;border-radius:999px;border:1px solid var(--border);background:var(--surface,#fff);color:var(--ink-soft,#475569);cursor:pointer}
  .wr-type.on{background:#e9fbf0;border-color:#9ad9c5;color:#0f5f55;font-weight:600}
  .wr-type input{margin:0;accent-color:#128c7e}
  .wr-type.dis{opacity:.55;cursor:not-allowed}
  /* stats */
  .wr-stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
  .wr-stat{background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;padding:9px 14px;flex:1 1 120px}
  .wr-stat .n{font-size:19px;font-weight:800;color:var(--ink)}
  .wr-stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
  /* filas de zona */
  .wr-row{display:flex;align-items:center;gap:12px;padding:11px 16px;border-top:1px solid var(--border)}
  .wr-row:first-of-type{border-top:none}
  .wr-zn{flex:1 1 auto;min-width:0}
  .wr-zn .name{font-size:13.5px;font-weight:600;color:var(--ink)}
  .wr-zn .sub{font-size:11.5px;color:var(--muted)}
  .wr-row select{font:inherit;font-size:12.5px;padding:7px 9px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink-soft,#475569);max-width:210px}
  .wr-pill{font-size:10.5px;font-weight:700;border-radius:999px;padding:2px 8px;white-space:nowrap}
  .wr-pill.ok{background:#e7f6ec;color:#1f7a44}
  .wr-pill.no{background:#fff4e5;color:#b45309}
  .wr-st{flex:0 0 auto;width:78px;text-align:right}
  .wr-note{background:#eef6ff;border:1px solid #cfe4ff;border-radius:12px;padding:11px 14px;font-size:12.5px;color:#1e40af;margin-bottom:8px}
  .wr-note b{color:#173a8a}
  .wr-foot{font-size:11.5px;color:var(--muted);margin:0 0 14px}
  .wr-save{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-bottom:30px}
  .wr-save .msg{font-size:12.5px;color:var(--muted)}
  .wr-btn{background:#128c7e;color:#fff;border:none;border-radius:10px;padding:9px 18px;font-size:13px;font-weight:600;cursor:pointer}
  .wr-btn:disabled{opacity:.5;cursor:not-allowed}
  @media(max-width:640px){
    .wr-row{flex-wrap:wrap}
    .wr-row select{max-width:none;flex:1 1 100%;order:3}
    .wr-st{width:auto}
  }`;
  document.head.appendChild(st);
}

/* Los 4 numeros de arriba, calculados sobre el estado EDITABLE (se mueven
   mientras el usuario cambia los desplegables, antes de guardar). */
function stats() {
  const zones = (DATA && DATA.zones) || [];
  const assigned = zones.filter(z => ROUTES[z.id]).length;
  const usedGroups = new Set(zones.map(z => ROUTES[z.id]).filter(Boolean)).size;
  return { total: zones.length, assigned, usedGroups, without: zones.length - assigned };
}

function paintStats() {
  const s = stats();
  const box = $('#wrStats');
  if (!box) return;
  box.innerHTML = `
    <div class="wr-stat"><div class="n">${s.total}</div><div class="l">Zonas</div></div>
    <div class="wr-stat"><div class="n">${s.assigned}</div><div class="l">Asignadas</div></div>
    <div class="wr-stat"><div class="n">${s.usedGroups}</div><div class="l">Grupos en uso</div></div>
    <div class="wr-stat"><div class="n">${s.without}</div><div class="l">Sin grupo</div></div>`;
}

function paintMaster() {
  const sw = $('#wrMaster');
  const st = $('#wrMasterState');
  if (!sw || !st) return;
  sw.classList.toggle('on', ENABLED);
  st.textContent = ENABLED ? 'Activado' : 'Desactivado';
  st.className = `wr-state ${ENABLED ? 'on' : 'off'}`;
}

function markDirty() {
  DIRTY = true;
  const b = $('#wrSave');
  if (b && DATA && DATA.can_edit) b.disabled = false;
  const m = $('#wrMsg');
  if (m) m.textContent = 'Hay cambios sin guardar.';
}

function rowsHtml() {
  const ro = !(DATA && DATA.can_edit);
  // Zonas con mas tiendas primero: son las que importa rutear antes.
  const zones = [...((DATA && DATA.zones) || [])].sort((a, b) => (b.stores - a.stores) || a.name.localeCompare(b.name));
  return zones.map(z => {
    const cur = ROUTES[z.id] || '';
    const opts = [`<option value=""${cur ? '' : ' selected'}>— Sin asignar —</option>`]
      .concat(((DATA && DATA.groups) || []).map(g =>
        `<option value="${g.id}"${String(cur) === String(g.id) ? ' selected' : ''}>${esc(g.label)}</option>`))
      .concat(ro ? [] : ['<option value="__new">+ Crear grupo nuevo…</option>'])
      .join('');
    return `<div class="wr-row">
      <div class="wr-zn">
        <div class="name">${esc(z.name)}</div>
        <div class="sub">${z.stores} tienda${z.stores === 1 ? '' : 's'}</div>
      </div>
      <select data-zone="${esc(z.id)}"${ro ? ' disabled' : ''}>${opts}</select>
      <div class="wr-st"><span class="wr-pill ${cur ? 'ok' : 'no'}">${cur ? 'Asignada' : 'Sin grupo'}</span></div>
    </div>`;
  }).join('');
}

function paintRows() {
  const box = $('#wrRows');
  if (!box) return;
  box.innerHTML = rowsHtml();
  box.querySelectorAll('select[data-zone]').forEach(sel => {
    sel.addEventListener('change', () => {
      const zid = sel.dataset.zone;
      if (sel.value === '__new') {
        // "Crear grupo nuevo" es en realidad "andá a la pantalla Grupos":
        // el grupo se crea en WhatsApp y se descubre desde ahi.
        sel.value = ROUTES[zid] || '';
        const nav = document.querySelector('#pnlNav button[data-view="wagrupos"]');
        if (nav) nav.click();
        return;
      }
      ROUTES[zid] = sel.value ? Number(sel.value) : null;
      markDirty();
      paintRows();
      paintStats();
    });
  });
}

function typesHtml() {
  const ro = !(DATA && DATA.can_edit);
  return ((DATA && DATA.catalog) || []).map(t => {
    const on = TYPES.has(t.kind);
    return `<label class="wr-type ${on ? 'on' : ''}${ro ? ' dis' : ''}">
      <input type="checkbox" data-kind="${esc(t.kind)}"${on ? ' checked' : ''}${ro ? ' disabled' : ''}>
      ${t.emoji} ${esc(t.label)}
    </label>`;
  }).join('');
}

function paintTypes() {
  const box = $('#wrTypes');
  if (!box) return;
  box.innerHTML = typesHtml();
  box.querySelectorAll('input[data-kind]').forEach(chk => {
    chk.addEventListener('change', () => {
      const k = chk.dataset.kind;
      if (chk.checked) TYPES.add(k); else TYPES.delete(k);
      markDirty();
      paintTypes();
    });
  });
}

async function save() {
  const btn = $('#wrSave');
  const msg = $('#wrMsg');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  if (msg) msg.textContent = '';

  const routes = ((DATA && DATA.zones) || []).map(z => ({
    zone_id: z.id, wa_group_id: ROUTES[z.id] || null,
  }));
  const r = await api(RUSER, { action: 'save', routes, enabled: ENABLED, types: [...TYPES] });

  if (btn) btn.textContent = 'Guardar ruteo';
  if (!r || !r.ok) {
    if (btn) btn.disabled = false;
    if (msg) msg.textContent = (r && r.error) || 'No se pudo guardar.';
    return;
  }
  DIRTY = false;
  if (msg) {
    msg.textContent = ENABLED
      ? 'Guardado. Los avisos están activos.'
      : 'Guardado. Los avisos siguen apagados.';
  }
}

export async function renderWaRouting(user) {
  ensureStyles();
  RUSER = user;
  DIRTY = false;
  const main = document.getElementById('pnlMain');

  main.innerHTML = `<div class="wr-wrap">
    <div class="wr-head">
      <div>
        <h1><span class="wr-ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg></span>
        Ruteo de avisos</h1>
        <p>Cuando una tienda reporta, <b>Naima</b> publica el acuse de recibo en el grupo de WhatsApp de la <b>zona</b> de esa tienda. Asigná a cada zona su grupo: varias zonas pueden apuntar al mismo.</p>
      </div>
    </div>
    <div id="wrBody"><p style="color:var(--muted);font-size:13px">Cargando…</p></div>
  </div>`;

  const r = await api(user, { action: 'load' });
  const body = $('#wrBody');
  if (!r || !r.ok) {
    body.innerHTML = `<p style="color:#b91c1c;font-size:13px">${esc((r && r.error) || 'No se pudo cargar el ruteo.')}</p>`;
    return;
  }

  DATA = r;
  ENABLED = !!r.enabled;
  TYPES = new Set(r.types || []);
  ROUTES = {};
  (r.zones || []).forEach(z => { ROUTES[z.id] = (r.routes && r.routes[z.id]) || null; });

  const ro = !r.can_edit;
  body.innerHTML = `
    <div class="wr-card">
      <div class="wr-master">
        <div class="txt">
          <b>Avisos de Naima en grupos</b>
          <div>El interruptor general. Apagado, no sale ningún aviso — aunque las zonas tengan grupo asignado.</div>
        </div>
        <span id="wrMasterState" class="wr-state off">Desactivado</span>
        <button id="wrMaster" class="wr-sw" type="button"${ro ? ' disabled' : ''} aria-label="Activar o desactivar los avisos"></button>
      </div>
      <div class="wr-cardh" style="border-top:1px solid var(--border)">
        Qué avisa <span class="mut">podés apagar un tipo suelto sin tocar el resto</span>
      </div>
      <div class="wr-types" id="wrTypes"></div>
    </div>

    <div class="wr-stats" id="wrStats"></div>

    <div class="wr-card">
      <div class="wr-cardh">Zonas <span class="mut">elegí el grupo de cada zona</span></div>
      <div id="wrRows"></div>
    </div>

    <div class="wr-note">
      <b>Cómo funciona:</b> el aviso se rutea por la <b>zona de la tienda</b> que reporta. Podés mandar varias zonas al mismo grupo (por ejemplo, todo el oriente a uno solo) o una zona por grupo. Una zona <b>sin grupo</b> simplemente no genera aviso — útil para ir activando de a poco.
    </div>
    <p class="wr-foot">Los grupos de la lista salen de la pestaña <b>Grupos</b> (los que la línea ya tiene agregados y habilitados).${ro ? ' Solo el superadministrador puede cambiar esta configuración.' : ''}</p>

    <div class="wr-save">
      <span class="msg" id="wrMsg"></span>
      <button class="wr-btn" id="wrSave" type="button" disabled>Guardar ruteo</button>
    </div>`;

  paintMaster();
  paintTypes();
  paintRows();
  paintStats();

  const sw = $('#wrMaster');
  if (sw && !ro) {
    sw.addEventListener('click', () => { ENABLED = !ENABLED; paintMaster(); markDirty(); });
  }
  const btn = $('#wrSave');
  if (btn && !ro) btn.addEventListener('click', save);
}
