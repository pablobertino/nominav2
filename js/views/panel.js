/* =====================================================================
   views/panel.js — Panel principal con sidebar y secciones.
   Hito actual: Tiendas (6 filtros, default tipo=Tienda) y Catálogos
   (árbol zonas→subzonas + conceptos). Usuarios/Permisos/Sync se montan
   como secciones; por ahora Sync reusa el flujo existente.
   ===================================================================== */
import { $, mount } from '../core/dom.js';
import { getSession, clearSession } from '../core/session.js';
import { go } from '../core/router.js';

let CATALOG = null;       // { companies, zones, subzones, concepts }
let currentView = 'tiendas';

/* ---------- iconos ---------- */
const I = {
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4"/></svg>',
  catalog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
  circle: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/></svg>',
};

const NAV = [
  ['tiendas', I.store, 'Tiendas'],
  ['catalogos', I.catalog, 'Catálogos'],
  ['usuarios', I.users, 'Usuarios'],
  ['permisos', I.shield, 'Permisos'],
  ['sync', I.sync, 'Sincronización'],
];

/* ---------- shell ---------- */
function shell(user) {
  const initials = (user.kind === 'admin' ? (user.name || user.username) : user.companyCode)
    .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const roleLabel = user.kind === 'admin' ? user.role : 'tienda';
  const nameLabel = user.kind === 'admin' ? (user.name || user.username) : user.companyCode;

  return `
  <div class="pnl-layout">
    <aside class="pnl-side">
      <div class="pnl-brand">
        <div class="pnl-logo">${I.logo}</div>
        <div><div class="pnl-bname">Portal de Nómina</div><div class="pnl-bver">v1.03</div></div>
      </div>
      <nav class="pnl-nav" id="pnlNav">
        ${NAV.map(([id, ic, label]) =>
          `<button data-view="${id}" class="${id === currentView ? 'active' : ''}">${ic}<span>${label}</span></button>`
        ).join('')}
      </nav>
      <div class="pnl-user">
        <div class="pnl-avatar">${initials}</div>
        <div class="pnl-uinfo"><div class="pnl-uname">${nameLabel}</div><div class="pnl-urole">${roleLabel}</div></div>
        <button id="logoutBtn" class="pnl-logout" title="Cerrar sesión" aria-label="Cerrar sesión">⎋</button>
      </div>
    </aside>
    <main class="pnl-main" id="pnlMain"></main>
  </div>`;
}

/* ---------- helpers de render ---------- */
function statusPill(s) {
  const x = (s || '').toLowerCase();
  if (x.includes('abier')) return '<span class="pill pill-open">Abierta</span>';
  if (x.includes('cerrad') && x.includes('temp')) return '<span class="pill pill-temp">Cerrada temp.</span>';
  if (x.includes('cerrad')) return '<span class="pill pill-closed">Cerrada</span>';
  if (x.includes('proyect')) return '<span class="pill pill-proj">Proyectada</span>';
  if (x.includes('nulo')) return '<span class="pill pill-gray">Nulo</span>';
  return `<span class="pill pill-gray">${s || '—'}</span>`;
}

/* ---------- VISTA: TIENDAS ---------- */
function viewTiendas() {
  const types = [...new Set(CATALOG.companies.map(c => c.type).filter(Boolean))].sort();
  const statuses = [...new Set(CATALOG.companies.map(c => c.status).filter(Boolean))].sort();
  const concepts = CATALOG.concepts.map(c => c.name);

  $('#pnlMain').innerHTML = `
    <div class="pnl-head">
      <div><h1>Tiendas</h1><p id="tCount"></p></div>
      <button class="btn" id="exportBtn">Exportar</button>
    </div>
    <div class="pnl-filters">
      <div class="search">${I.search}<input id="fName" type="text" placeholder="Buscar nombre o código…"></div>
      <select id="fType">${types.map(t => `<option ${t === 'Tienda' ? 'selected' : ''}>${t}</option>`).join('')}<option value="ALL">Todos los tipos</option></select>
      <select id="fStatus"><option value="ALL">Todos los estados</option>${statuses.map(s => `<option>${s}</option>`).join('')}</select>
      <select id="fZone"><option value="ALL">Todas las zonas</option>${CATALOG.zones.map(z => `<option value="${z.id}">${z.name}</option>`).join('')}</select>
      <select id="fSub"><option value="ALL">Todas las subzonas</option></select>
      <select id="fConcept"><option value="ALL">Todos los conceptos</option>${concepts.map(c => `<option>${c}</option>`).join('')}</select>
    </div>
    <div class="tablebox">
      <table><thead><tr>
        <th>Código</th><th>Razón social</th><th>Zona / Subzona</th><th>Concepto</th><th>Estado</th><th>Acceso</th>
      </tr></thead><tbody id="tBody"></tbody></table>
    </div>
    <div class="legend">
      <span class="ico-ok">${I.check} con acceso</span>
      <span class="ico-no">${I.circle} sin usuario</span>
    </div>`;

  const fName = $('#fName'), fType = $('#fType'), fStatus = $('#fStatus'),
        fZone = $('#fZone'), fSub = $('#fSub'), fConcept = $('#fConcept');

  function fillSubs() {
    fSub.innerHTML = '<option value="ALL">Todas las subzonas</option>';
    if (fZone.value !== 'ALL') {
      CATALOG.subzones.filter(s => s.zone_id === fZone.value)
        .forEach(s => fSub.innerHTML += `<option value="${s.id}">${s.name}</option>`);
    }
  }

  function render() {
    const n = fName.value.toLowerCase();
    const rows = CATALOG.companies.filter(c => {
      return (`${c.code} ${c.name || ''}`.toLowerCase().includes(n))
        && (fType.value === 'ALL' || c.type === fType.value)
        && (fStatus.value === 'ALL' || c.status === fStatus.value)
        && (fZone.value === 'ALL' || c.zoneId === fZone.value)
        && (fSub.value === 'ALL' || c.subzoneId === fSub.value)
        && (fConcept.value === 'ALL' || c.concept === fConcept.value);
    });
    $('#tCount').textContent = `${rows.length} de ${CATALOG.companies.length} entidades`;
    $('#tBody').innerHTML = rows.map(c => `
      <tr>
        <td class="code">${c.code}</td>
        <td>${c.name || '—'}</td>
        <td>${c.zone || '—'}${c.subzone ? ' · ' + c.subzone : ''}</td>
        <td>${c.concept || '—'}</td>
        <td>${statusPill(c.status)}</td>
        <td class="${c.hasAccess ? 'ico-ok' : 'ico-no'}">${c.hasAccess ? I.check : I.circle}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">Sin resultados.</td></tr>';
  }

  fZone.addEventListener('change', () => { fillSubs(); render(); });
  [fName, fType, fStatus, fSub, fConcept].forEach(e => e.addEventListener('input', render));
  fType.addEventListener('change', render);
  render();
}

/* ---------- VISTA: CATÁLOGOS ---------- */
function viewCatalogos() {
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Catálogos</h1>
      <p>${CATALOG.zones.length} zonas · ${CATALOG.subzones.length} subzonas · ${CATALOG.concepts.length} conceptos</p></div></div>
    <div class="cards-row">
      <div class="card" style="flex:1.3">
        <h3>Zonas y subzonas</h3>
        <div id="treeBox"></div>
      </div>
      <div class="card">
        <h3>Conceptos <span class="muted">(${CATALOG.concepts.length})</span></h3>
        <div class="concepts">${CATALOG.concepts.map(c => `<span class="concept-tag">${c.name}</span>`).join('')}</div>
      </div>
    </div>`;

  const tree = $('#treeBox');
  CATALOG.zones.forEach(z => {
    const subs = CATALOG.subzones.filter(s => s.zone_id === z.id);
    const total = CATALOG.companies.filter(c => c.zoneId === z.id).length;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="tree-zone">
        <span class="zname">${I.chevron} ${z.name} <span class="muted">(${z.letter || ''})</span></span>
        <span class="muted">${subs.length} sub · ${total}</span>
      </div>
      <div class="tree-subs">${subs.map(s => {
        const n = CATALOG.companies.filter(c => c.subzoneId === s.id).length;
        return `<div class="tree-sub"><span>${s.name}</span><span class="muted">${n}</span></div>`;
      }).join('')}</div>`;
    const head = wrap.querySelector('.tree-zone'), body = wrap.querySelector('.tree-subs');
    head.addEventListener('click', () => { head.classList.toggle('open'); body.classList.toggle('open'); });
    tree.appendChild(wrap);
  });
}

/* ---------- VISTA: placeholders ---------- */
function viewSoon(title, msg) {
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>${title}</h1></div></div>
    <div class="card"><p class="muted" style="margin:0">${msg}</p></div>`;
}

/* ---------- VISTA: SYNC ---------- */
function viewSync(user) {
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Sincronización</h1><p>Catálogo AX → Supabase</p></div></div>
    <div class="card">
      ${isSuper ? `
      <div class="sync-row">
        <div class="muted" id="syncStatus">Vuelca empresas, zonas, subzonas y conceptos desde la API.</div>
        <button class="btn btn-primary" id="syncBtn">Sincronizar ahora</button>
      </div>` : `<p class="muted" style="margin:0">Solo el superadmin puede sincronizar.</p>`}
    </div>`;
  if (!isSuper) return;
  $('#syncBtn').addEventListener('click', async () => {
    const st = $('#syncStatus'), btn = $('#syncBtn');
    st.textContent = 'Sincronizando…'; btn.disabled = true;
    try {
      const res = await fetch('/api/sync-companies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminId: user.id }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      st.textContent = `✅ ${d.synced.companies} empresas, ${d.synced.zones} zonas, ${d.synced.subzones} subzonas, ${d.synced.concepts} conceptos.`;
      CATALOG = null; // forzar recarga al volver a Tiendas
    } catch (e) { st.textContent = '❌ ' + e.message; }
    finally { btn.disabled = false; }
  });
}

/* ---------- navegación ---------- */
async function ensureCatalog() {
  if (CATALOG) return;
  $('#pnlMain').innerHTML = '<div class="pnl-loading">Cargando catálogo…</div>';
  const res = await fetch('/api/catalog');
  const d = await res.json();
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }
  CATALOG = d;
}

async function navigate(view, user) {
  currentView = view;
  document.querySelectorAll('#pnlNav button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  if (view === 'tiendas' || view === 'catalogos') {
    await ensureCatalog();
    if (!CATALOG) return;
  }
  if (view === 'tiendas') viewTiendas();
  else if (view === 'catalogos') viewCatalogos();
  else if (view === 'usuarios') viewSoon('Usuarios', 'Sección en construcción: creación de usuarios y reseteo de contraseñas.');
  else if (view === 'permisos') viewSoon('Permisos', 'Sección en construcción: asignación de alcance por zona, subzona o tienda.');
  else if (view === 'sync') viewSync(user);
}

export function renderPanel() {
  const user = getSession();
  if (!user) { go('/login'); return; }
  mount(shell(user));
  $('#logoutBtn').addEventListener('click', () => { clearSession(); go('/login'); });
  document.querySelectorAll('#pnlNav button').forEach(b =>
    b.addEventListener('click', () => navigate(b.dataset.view, user)));
  navigate('tiendas', user);
}
