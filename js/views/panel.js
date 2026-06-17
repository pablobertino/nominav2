/* =====================================================================
   views/panel.js — Vista interna tras login (provisional)
   Por ahora muestra: quién entró + el auditor de la API de empresas
   consumiendo /api/empresas (key protegida en el Worker).
   Esta vista evolucionará al panel real (usuarios + alcance).
   ===================================================================== */
import { $, mount } from '../core/dom.js';
import { getSession, clearSession } from '../core/session.js';
import { go } from '../core/router.js';

function template(user) {
  const who = user.kind === 'admin'
    ? `${user.name || user.username} · <strong>${user.role}</strong>`
    : `Tienda <strong>${user.companyCode}</strong>`;
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  return `
  <div class="panel-wrap">
    <header class="panel-head">
      <div>
        <p class="panel-title">Portal de Nómina</p>
        <p class="panel-sub">Sesión: ${who}</p>
      </div>
      <button id="logoutBtn" class="btn-ghost">Cerrar sesión</button>
    </header>

    ${isSuper ? `
    <section class="panel-card" style="margin-bottom:var(--sp-5)">
      <div class="panel-card-head">
        <h2>Sincronización de catálogo (AX → Supabase)</h2>
        <button id="syncBtn" class="btn-primary btn-sm">Sincronizar ahora</button>
      </div>
      <div id="syncStatus" class="audit-status">Vuelca empresas, zonas, subzonas y conceptos desde la API a la base.</div>
    </section>` : ''}

    <section class="panel-card">
      <div class="panel-card-head">
        <h2>Auditor de empresas (API AX)</h2>
        <button id="reloadBtn" class="btn-primary btn-sm">Cargar empresas</button>
      </div>
      <div id="auditStatus" class="audit-status">Pulsa "Cargar empresas".</div>

      <div id="auditStats" class="audit-stats" style="display:none"></div>

      <div class="audit-filters" id="auditFilters" style="display:none">
        <input id="fName" type="text" placeholder="Buscar por nombre o código…" />
        <select id="fType"><option value="ALL">Todos los tipos</option></select>
        <select id="fStatus"><option value="ALL">Todos los estados</option></select>
      </div>

      <div class="audit-scroll">
        <table class="audit-table">
          <thead><tr id="thead"></tr></thead>
          <tbody id="tbody"></tbody>
        </table>
      </div>
    </section>
  </div>`;
}

let DATA = [];
const COLS = ['alias','companyId','companyName','rif','concepto','tipoEmpresa','zona','subzona','status'];

function badge(status) {
  const s = (status || '').toLowerCase();
  let cls = 'b-unk';
  if (s.includes('abier')) cls = 'b-open';
  else if (s.includes('cerrad') && s.includes('temp')) cls = 'b-temp';
  else if (s.includes('cerrad')) cls = 'b-closed';
  else if (s.includes('proyect')) cls = 'b-proj';
  return `<span class="badge ${cls}">${status || '—'}</span>`;
}

function renderTable() {
  const fName = ($('#fName')?.value || '').toLowerCase();
  const fType = $('#fType')?.value || 'ALL';
  const fStatus = $('#fStatus')?.value || 'ALL';
  const rows = DATA.filter(c => {
    const hay = `${c.alias||''} ${c.companyName||''}`.toLowerCase();
    return hay.includes(fName)
      && (fType === 'ALL' || (c.tipoEmpresa||'') === fType)
      && (fStatus === 'ALL' || (c.status||'') === fStatus);
  });
  $('#thead').innerHTML = COLS.map(c => `<th>${c}</th>`).join('');
  $('#tbody').innerHTML = rows.map(c =>
    '<tr>' + COLS.map(col =>
      col === 'status' ? `<td>${badge(c[col])}</td>` : `<td>${c[col] ?? '—'}</td>`
    ).join('') + '</tr>'
  ).join('') || `<tr><td colspan="${COLS.length}">Sin resultados.</td></tr>`;
}

async function loadEmpresas() {
  const st = $('#auditStatus');
  st.textContent = '⏳ Consultando la API…';
  st.className = 'audit-status';
  try {
    const res = await fetch('/api/empresas');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Error desconocido');
    DATA = data.companies;
    st.textContent = `✅ ${data.count} empresas (DAT excluida)`;
    st.className = 'audit-status ok';

    // stats
    const open = DATA.filter(c => (c.status||'').toLowerCase().includes('abier')).length;
    const types = new Set(DATA.map(c => c.tipoEmpresa).filter(Boolean));
    $('#auditStats').style.display = 'flex';
    $('#auditStats').innerHTML =
      `<div><b>${DATA.length}</b> total</div><div><b>${open}</b> abiertas</div><div><b>${types.size}</b> tipos</div>`;

    // filtros
    $('#auditFilters').style.display = 'flex';
    const types2 = [...new Set(DATA.map(c => c.tipoEmpresa).filter(Boolean))].sort();
    const stats2 = [...new Set(DATA.map(c => c.status).filter(Boolean))].sort();
    $('#fType').innerHTML = '<option value="ALL">Todos los tipos</option>' + types2.map(t => `<option>${t}</option>`).join('');
    $('#fStatus').innerHTML = '<option value="ALL">Todos los estados</option>' + stats2.map(s => `<option>${s}</option>`).join('');

    renderTable();
  } catch (err) {
    st.textContent = '❌ ' + err.message;
    st.className = 'audit-status err';
  }
}

async function syncCatalog(user) {
  const st = $('#syncStatus');
  const btn = $('#syncBtn');
  st.textContent = '⏳ Sincronizando con la API…';
  st.className = 'audit-status';
  btn.disabled = true;
  try {
    const res = await fetch('/api/sync-companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: user.id }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Error desconocido');
    const s = data.synced;
    st.textContent = `✅ Sincronizado: ${s.companies} empresas, ${s.zones} zonas, ${s.subzones} subzonas, ${s.concepts} conceptos.`;
    st.className = 'audit-status ok';
  } catch (err) {
    st.textContent = '❌ ' + err.message;
    st.className = 'audit-status err';
  } finally {
    btn.disabled = false;
  }
}

export function renderPanel() {
  const user = getSession();
  if (!user) { go('/login'); return; }
  mount(template(user));

  $('#logoutBtn').addEventListener('click', () => { clearSession(); go('/login'); });
  $('#reloadBtn').addEventListener('click', loadEmpresas);
  const syncBtn = $('#syncBtn');
  if (syncBtn) syncBtn.addEventListener('click', () => syncCatalog(user));
  ['fName','fType','fStatus'].forEach(id => {
    const e = $('#' + id);
    if (e) e.addEventListener('input', renderTable);
  });
}
