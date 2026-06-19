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
  team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  key: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
  circle: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
};

const NAV = [
  ['tiendas', I.store, 'Empresas'],
  ['catalogos', I.catalog, 'Catálogos'],
  ['usuarios', I.users, 'Usuarios'],
  ['equipo', I.team, 'Equipo', 'superonly'],
  ['permisos', I.shield, 'Permisos', 'superonly'],
  ['sync', I.sync, 'Sincronización'],
];

/* ---------- shell ---------- */
function shell(user) {
  const isCompany = user.kind === 'company';
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';
  const nameLabel = isCompany ? user.companyCode : (user.name || user.username);
  const roleLabel = isCompany ? 'tienda' : user.role;
  const initials = (nameLabel || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const email = (user.email || '').trim().toLowerCase();

  // Navegación según rol: la tienda solo ve "Mi empresa".
  const navItems = isCompany
    ? [['miempresa', I.store, 'Mi empresa']]
    : NAV.filter(n => n[3] !== 'superonly' || isSuper);

  return `
  <div class="pnl-layout">
    <aside class="pnl-side">
      <div class="pnl-brand">
        <div class="pnl-logo">${I.logo}</div>
        <div><div class="pnl-bname">Portal de Nómina</div><div class="pnl-bver">v1.20</div></div>
      </div>
      <nav class="pnl-nav" id="pnlNav">
        ${navItems.map(([id, ic, label]) =>
          `<button data-view="${id}" class="${id === currentView ? 'active' : ''}">${ic}<span>${label}</span></button>`
        ).join('')}
      </nav>
    </aside>
    <div class="pnl-content">
      <header class="pnl-topbar">
        <div class="pnl-user">
          <div class="pnl-avatar" id="pnlAvatar">${initials}</div>
          <div class="pnl-uinfo"><div class="pnl-uname">${nameLabel}</div><div class="pnl-urole">${roleLabel}</div></div>
        </div>
        <button id="logoutBtn" class="pnl-logout" title="Cerrar sesión">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
          Salir
        </button>
      </header>
      <main class="pnl-main" id="pnlMain"></main>
    </div>
  </div>`;
}

/* Carga el avatar vía Gravatar (SHA-256 del correo). Si no hay foto,
   Gravatar responde 404 (d=404) y conservamos las iniciales. */
async function loadAvatar(email) {
  if (!email) return;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
    const hash = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    const url = `https://www.gravatar.com/avatar/${hash}?s=72&d=404`;
    const img = new Image();
    img.onload = () => {
      const el = document.getElementById('pnlAvatar');
      if (el) { el.textContent = ''; el.appendChild(img); }
    };
    img.onerror = () => {}; // sin Gravatar: quedan las iniciales
    img.src = url;
    img.alt = '';
  } catch { /* navegador sin crypto.subtle: iniciales */ }
}

/* ---------- helpers de render ---------- */
/* Teléfono: en BD se guarda E.164 (+58...). Mostrar en nacional 0412-XXXXXXX */
function phoneDisplay(e164) {
  if (!e164) return null;
  let s = e164.replace(/[^\d+]/g, '');
  if (s.startsWith('+58')) s = '0' + s.slice(3);
  else if (s.startsWith('58') && s.length === 12) s = '0' + s.slice(2);
  if (/^\d{11}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4); // 0412-1234567
  return e164;
}
/* Para capturar: de E.164 a nacional sin guion (para el input) */
function phoneNational(e164) {
  if (!e164) return '';
  let s = e164.replace(/[^\d+]/g, '');
  if (s.startsWith('+58')) s = '0' + s.slice(3);
  else if (s.startsWith('58') && s.length === 12) s = '0' + s.slice(2);
  return s;
}

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
function viewTiendas(user) {
  const types = [...new Set(CATALOG.companies.map(c => c.type).filter(Boolean))].sort();
  const statuses = [...new Set(CATALOG.companies.map(c => c.status).filter(Boolean))].sort();
  const concepts = CATALOG.concepts.map(c => c.name);

  $('#pnlMain').innerHTML = `
    <div class="pnl-head">
      <div><h1>Empresas</h1><p id="tCount"></p></div>
      <div class="export-wrap">
        <button class="btn" id="exportBtn">Exportar ▾</button>
        <div class="export-menu" id="exportMenu" hidden>
          <button data-fmt="xlsx">Excel (.xlsx)</button>
          <button data-fmt="csv">CSV (.csv)</button>
          <button data-fmt="txt">Texto (.txt)</button>
        </div>
      </div>
    </div>
    <div class="pnl-filters">
      <div class="search">${I.search}<input id="fName" type="text" placeholder="Buscar nombre o código…"></div>
      <select id="fType">${types.map(t => `<option ${t === 'Tienda' ? 'selected' : ''}>${t}</option>`).join('')}<option value="ALL">Todos los tipos</option></select>
      <select id="fStatus"><option value="ALL">Todos los estados</option>${statuses.map(s => `<option ${/abier/i.test(s) ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <select id="fZone"><option value="ALL">Todas las zonas</option>${CATALOG.zones.map(z => `<option value="${z.id}">${z.name}</option>`).join('')}</select>
      <select id="fSub"><option value="ALL">Todas las subzonas</option></select>
      <select id="fConcept"><option value="ALL">Todos los conceptos</option>${concepts.map(c => `<option>${c}</option>`).join('')}</select>
    </div>
    <div class="tablebox">
      <table><thead><tr>
        <th>Código</th><th>Razón social</th><th>Zona / Subzona</th><th>Concepto</th><th>Contacto</th><th>Estado</th><th>Acceso</th>
      </tr></thead><tbody id="tBody"></tbody></table>
    </div>
    <div class="legend">
      <span class="ico-ok">${I.check} con acceso</span>
      <span class="ico-no">${I.circle} sin usuario</span>
    </div>`;

  const fName = $('#fName'), fType = $('#fType'), fStatus = $('#fStatus'),
        fZone = $('#fZone'), fSub = $('#fSub'), fConcept = $('#fConcept');

  let visibleRows = []; // filas actualmente filtradas (para exportar)

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
    visibleRows = rows;
    $('#tBody').innerHTML = rows.map(c => {
      const tel = phoneDisplay(c.phone);
      const tel2 = phoneDisplay(c.phone2);
      const telLine = [tel, tel2].filter(Boolean).join(' / ') || 'sin teléfono';
      const contacto = `
        <div class="contact-cell">
          <div class="contact-lines">
            <span class="${c.email ? '' : 'muted'}">${c.email || 'sin correo'}</span>
            <span class="muted" style="font-size:12px">${telLine}</span>
          </div>
          <button class="email-edit" data-code="${c.code}" data-name="${(c.name||'').replace(/"/g,'')}" data-email="${c.email||''}" data-phone="${c.phone||''}" data-phone2="${c.phone2||''}" title="Editar contacto">${I.pencil}</button>
        </div>`;
      return `
      <tr>
        <td class="code">${c.code}</td>
        <td>${c.name || '—'}</td>
        <td>${c.zone || '—'}${c.subzone ? ' · ' + c.subzone : ''}</td>
        <td>${c.concept || '—'}</td>
        <td>${contacto}</td>
        <td>${statusPill(c.status)}</td>
        <td class="${c.hasAccess ? 'ico-ok' : 'ico-no'}">${c.hasAccess ? I.check : I.circle}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">Sin resultados.</td></tr>';

    $('#tBody').querySelectorAll('.email-edit').forEach(b =>
      b.addEventListener('click', () => contactEditModal(user, b.dataset)));
  }

  fZone.addEventListener('change', () => { fillSubs(); render(); });
  [fName, fType, fStatus, fSub, fConcept].forEach(e => e.addEventListener('input', render));
  fType.addEventListener('change', render);
  render();

  // Exportación (menú desplegable)
  const exportBtn = $('#exportBtn'), exportMenu = $('#exportMenu');
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
  });
  document.addEventListener('click', () => { exportMenu.hidden = true; }, { once: false });
  exportMenu.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { exportMenu.hidden = true; exportTiendas(b.dataset.fmt, visibleRows); }));
}

/* ---------- Exportación de Tiendas (xlsx / csv / txt) ---------- */
function exportRows(rows) {
  // Estructura tabular común a los tres formatos
  return rows.map(c => ({
    'Código': c.code,
    'Razón social': c.name || '',
    'Zona': c.zone || '',
    'Subzona': c.subzone || '',
    'Concepto': c.concept || '',
    'Correo': c.email || '',
    'Teléfono 1 nacional': phoneDisplay(c.phone) || '',
    'Teléfono 1 internacional': c.phone || '',
    'Teléfono 2 nacional': phoneDisplay(c.phone2) || '',
    'Teléfono 2 internacional': c.phone2 || '',
    'Estado': c.status || '',
    'Tiene acceso': c.hasAccess ? 'Sí' : 'No',
  }));
}
function downloadBlob(content, filename, mime) {
  const blob = (content instanceof Blob) ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function tstamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
async function exportTiendas(fmt, rows) {
  const data = exportRows(rows);
  if (!data.length) { alert('No hay filas para exportar con los filtros actuales.'); return; }
  const headers = Object.keys(data[0]);
  const fname = `tiendas_${tstamp()}`;

  if (fmt === 'csv') {
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.join(';')].concat(data.map(r => headers.map(h => esc(r[h])).join(';')));
    // BOM para que Excel abra UTF-8 correctamente
    downloadBlob('\uFEFF' + lines.join('\r\n'), `${fname}.csv`, 'text/csv;charset=utf-8');
    return;
  }

  if (fmt === 'txt') {
    // Texto tabular alineado por columnas
    const widths = headers.map(h => Math.max(h.length, ...data.map(r => String(r[h] ?? '').length)));
    const fmtRow = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
    const lines = [fmtRow(headers), widths.map(w => '-'.repeat(w)).join('  ')]
      .concat(data.map(r => fmtRow(headers.map(h => r[h]))));
    downloadBlob(lines.join('\r\n'), `${fname}.txt`, 'text/plain;charset=utf-8');
    return;
  }

  if (fmt === 'xlsx') {
    // Cargar SheetJS dinámicamente desde CDN solo cuando se necesita
    try {
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar la librería Excel.'));
          document.head.appendChild(s);
        });
      }
      const ws = window.XLSX.utils.json_to_sheet(data, { header: headers });
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Tiendas');
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (e) {
      alert(e.message + ' Revisa tu conexión e inténtalo de nuevo.');
    }
    return;
  }
}

/* Modal para editar datos de contacto (correo + teléfono) de una compañía */
function contactEditModal(user, ds) {
  openModal(`
    <div class="modal-head"><span>Datos de contacto</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${ds.code}${ds.name ? ' · ' + ds.name : ''}</p>
    <label class="flabel">Correo</label>
    <input type="text" id="emInput" value="${ds.email || ''}" placeholder="compania@grupocanaima.com" style="margin-bottom:14px">
    <label class="flabel">Teléfono móvil 1 <span class="muted">(04XX-XXXXXXX)</span></label>
    <input type="text" id="phInput" value="${phoneNational(ds.phone)}" placeholder="04121234567" style="margin-bottom:12px">
    <label class="flabel">Teléfono móvil 2 <span class="muted">(opcional)</span></label>
    <input type="text" id="phInput2" value="${phoneNational(ds.phone2)}" placeholder="04241234567" style="margin-bottom:6px">
    <p class="muted" style="font-size:11.5px;margin:0">Deja los campos vacíos para quitarlos. Se guarda en formato internacional (+58).</p>
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">Guardar</button>
    </div>`);
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const d = await fetch('/api/company-contact', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: user.id, companyCode: ds.code,
        email: $('#emInput').value, phone: $('#phInput').value, phone2: $('#phInput2').value }),
    }).then(r => r.json());
    if (!d.ok) { alert(d.error); return; }
    closeModal();
    const c = CATALOG.companies.find(x => x.code === ds.code);
    if (c) { c.email = d.email; c.phone = d.phone; c.phone2 = d.phone2; }
    viewTiendas(user);
  });
}

/* ---------- VISTA: CATÁLOGOS ---------- */
function viewCatalogos() {
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Catálogos</h1>
      <p>${CATALOG.zones.length} zonas · ${CATALOG.subzones.length} subzonas · ${CATALOG.concepts.length} conceptos</p></div></div>
    <div class="card">
      <h3>Zonas y subzonas</h3>
      <div id="treeBox"></div>
    </div>
    <div class="card">
      <h3>Conceptos <span class="muted">(${CATALOG.concepts.length})</span></h3>
      <div class="concepts">${CATALOG.concepts.map(c => `<span class="concept-tag">${c.name}</span>`).join('')}</div>
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

/* ---------- helper: modal ---------- */
function openModal(html) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.id = 'modalOv';
  ov.innerHTML = `<div class="modal-box">${html}</div>`;
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
  document.body.appendChild(ov);
}
function closeModal() {
  const ex = document.getElementById('modalOv');
  if (ex) ex.remove();
}

/* ---------- bloque de contraseña reutilizable (modal) ---------- */
function pwdBlockHtml() {
  return `
    <p class="flabel" style="margin-bottom:9px">Contraseña inicial</p>
    <label class="radio-row"><input type="radio" name="pwmode" value="temp" checked>
      <span>Generar temporal<br><span class="muted" style="font-size:12px">La cambia al entrar por primera vez</span></span></label>
    <label class="radio-row"><input type="radio" name="pwmode" value="manual">
      <span>Escribir yo la clave<br><span class="muted" style="font-size:12px">Tú defines la contraseña ahora</span></span></label>
    <div id="pwManual" style="display:none;margin-top:4px">
      <input type="text" id="pwInput" placeholder="Mínimo 6 caracteres">
    </div>`;
}
function readPwd() {
  const mode = document.querySelector('input[name=pwmode]:checked').value;
  if (mode === 'temp') return { useTemp: true };
  return { useTemp: false, password: document.getElementById('pwInput').value };
}
function wirePwdBlock() {
  document.querySelectorAll('input[name=pwmode]').forEach(r =>
    r.addEventListener('change', () => {
      document.getElementById('pwManual').style.display =
        document.querySelector('input[name=pwmode]:checked').value === 'manual' ? 'block' : 'none';
    }));
}

/* ---------- VISTA: USUARIOS (de compañía) ---------- */
let CU_ROWS = null;
async function viewUsuarios(user) {
  $('#pnlMain').innerHTML = `<div class="pnl-head"><div><h1>Usuarios</h1><p>Accesos de compañía al portal</p></div></div><div class="pnl-loading">Cargando…</div>`;
  const res = await fetch('/api/company-users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'list', adminId: user.id }),
  });
  const d = await res.json();
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }
  CU_ROWS = d.rows;
  const types = [...new Set(CU_ROWS.map(r => r.type).filter(Boolean))].sort();

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Usuarios</h1><p id="cuCount"></p></div></div>
    <div class="pnl-filters">
      <div class="search">${I.search}<input id="cuName" placeholder="Buscar compañía o código…"></div>
      <select id="cuType"><option value="Tienda">Tipo: Tienda</option>${types.filter(t=>t!=='Tienda').map(t=>`<option>${t}</option>`).join('')}<option value="ALL">Todos los tipos</option></select>
      <select id="cuAccess"><option value="ALL">Todas</option><option value="yes">Con acceso</option><option value="no">Sin acceso</option></select>
    </div>
    <div class="tablebox"><table><thead><tr>
      <th>Código</th><th>Compañía</th><th>Tipo</th><th>Usuario / Correo</th><th>Estado</th><th style="text-align:right">Acciones</th>
    </tr></thead><tbody id="cuBody"></tbody></table></div>`;

  const fName = $('#cuName'), fType = $('#cuType'), fAccess = $('#cuAccess');
  function render() {
    const n = fName.value.toLowerCase();
    const rows = CU_ROWS.filter(r =>
      (`${r.code} ${r.name || ''}`.toLowerCase().includes(n))
      && (fType.value === 'ALL' || r.type === fType.value)
      && (fAccess.value === 'ALL' || (fAccess.value === 'yes' ? !!r.user : !r.user)));
    $('#cuCount').textContent = `${rows.length} de ${CU_ROWS.length} compañías`;
    $('#cuBody').innerHTML = rows.map(r => {
      const u = r.user;
      const userCell = u
        ? `${r.code}<br><span class="muted" style="font-size:12px">${u.email || 'sin correo'}</span>`
        : `<span class="muted" style="font-size:12px">— sin usuario —</span>`;
      const stateCell = u
        ? (u.is_active ? '<span class="pill pill-open">Activo</span>' : '<span class="pill pill-closed">Inactivo</span>')
        : '<span class="pill pill-gray">Sin acceso</span>';
      const actions = u
        ? `<button class="btn btn-mini" data-act="reset" data-code="${r.code}">${I.key} Resetear</button>
           <button class="btn btn-mini" data-act="toggle" data-code="${r.code}" data-active="${u.is_active}">${u.is_active ? 'Desactivar' : 'Activar'}</button>`
        : `<button class="btn btn-mini btn-primary" data-act="create" data-code="${r.code}" data-name="${(r.name||'').replace(/"/g,'')}" data-type="${r.type||''}" data-email="${r.companyEmail||''}">${I.plus} Crear acceso</button>`;
      return `<tr><td class="code">${r.code}</td><td>${r.name || '—'}</td>
        <td><span class="pill pill-gray">${r.type || '—'}</span></td>
        <td style="font-size:13px">${userCell}</td><td>${stateCell}</td>
        <td style="text-align:right;white-space:nowrap">${actions}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">Sin resultados.</td></tr>';

    $('#cuBody').querySelectorAll('button[data-act]').forEach(b =>
      b.addEventListener('click', () => cuAction(b.dataset, user)));
  }
  [fName].forEach(e => e.addEventListener('input', render));
  [fType, fAccess].forEach(e => e.addEventListener('change', render));
  render();
}

function cuAction(ds, user) {
  if (ds.act === 'toggle') {
    cuApi({ action: 'toggle', adminId: user.id, companyCode: ds.code, isActive: !(ds.active === 'true') })
      .then(() => viewUsuarios(user));
    return;
  }
  const isCreate = ds.act === 'create';
  openModal(`
    <div class="modal-head"><span>${isCreate ? 'Crear acceso' : 'Resetear contraseña'}</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${ds.code}${ds.name ? ' · ' + ds.name : ''}${ds.type ? ' · ' + ds.type : ''}</p>
    ${isCreate ? `
      <label class="flabel">Usuario</label>
      <input type="text" id="cuUser" value="${ds.code}" style="margin-bottom:12px">
      <label class="flabel">Correo <span class="muted">(heredado de la compañía, editable)</span></label>
      <input type="text" id="cuEmail" value="${ds.email || ''}" placeholder="compañia@grupocanaima.com" style="margin-bottom:14px">` : ''}
    ${pwdBlockHtml()}
    <div class="modal-actions">
      <button class="btn" id="mCancel">Cancelar</button>
      <button class="btn btn-primary" id="mOk">${isCreate ? 'Crear acceso' : 'Resetear'}</button>
    </div>`);
  wirePwdBlock();
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const pw = readPwd();
    const payload = { adminId: user.id, companyCode: ds.code, ...pw,
      action: isCreate ? 'create' : 'reset',
      email: isCreate ? ($('#cuEmail').value || null) : undefined };
    const d = await cuApi(payload);
    if (!d.ok) { alert(d.error); return; }
    closeModal();
    if (d.tempPassword) alert('Contraseña temporal: ' + d.tempPassword + '\n(Cópiala y entrégala a la tienda.)');
    viewUsuarios(user);
  });
}
async function cuApi(payload) {
  const res = await fetch('/api/company-users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return res.json();
}

/* ---------- VISTA: EQUIPO (admins) ---------- */
async function viewEquipo(user) {
  $('#pnlMain').innerHTML = `<div class="pnl-head"><div><h1>Equipo</h1><p>Administradores del portal</p></div></div><div class="pnl-loading">Cargando…</div>`;
  const d = await auApi({ action: 'list', adminId: user.id });
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }
  const rows = d.rows;
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Equipo</h1><p>${rows.length} miembros</p></div>
      <button class="btn btn-primary" id="auNew">${I.plus} Nuevo miembro</button></div>
    <div class="tablebox"><table><thead><tr>
      <th>Usuario</th><th>Nombre</th><th>Correo</th><th>Rol</th><th>Estado</th><th style="text-align:right">Acciones</th>
    </tr></thead><tbody>
      ${rows.map(a => `<tr>
        <td class="code">${a.username}</td><td>${a.name || '—'}</td><td style="font-size:12px" class="muted">${a.email || '—'}</td>
        <td><span class="pill ${a.role === 'superadmin' ? 'pill-proj' : 'pill-gray'}">${a.role}</span></td>
        <td>${a.is_active ? '<span class="pill pill-open">Activo</span>' : '<span class="pill pill-closed">Inactivo</span>'}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-mini" data-act="reset" data-id="${a.id}" data-u="${a.username}">${I.key} Resetear</button>
          <button class="btn btn-mini" data-act="toggle" data-id="${a.id}" data-active="${a.is_active}">${a.is_active ? 'Desactivar' : 'Activar'}</button>
        </td></tr>`).join('')}
    </tbody></table></div>`;
  $('#auNew').addEventListener('click', () => auCreateModal(user));
  $('#pnlMain').querySelectorAll('button[data-act]').forEach(b =>
    b.addEventListener('click', () => auAction(b.dataset, user)));
}
function auCreateModal(user) {
  openModal(`
    <div class="modal-head"><span>Nuevo miembro</span><button class="modal-x" id="mX">✕</button></div>
    <label class="flabel">Usuario</label><input id="auU" placeholder="ej. yanmira.salazar" style="margin-bottom:12px">
    <label class="flabel">Nombre</label><input id="auN" placeholder="Nombre completo" style="margin-bottom:12px">
    <label class="flabel">Correo <span class="muted">(opcional)</span></label><input id="auE" placeholder="correo@grupocanaima.com" style="margin-bottom:12px">
    <label class="flabel">Rol</label>
    <select id="auR" style="margin-bottom:14px;width:100%"><option value="admin">admin</option><option value="superadmin">superadmin</option></select>
    ${pwdBlockHtml()}
    <div class="modal-actions"><button class="btn" id="mCancel">Cancelar</button><button class="btn btn-primary" id="mOk">Crear</button></div>`);
  wirePwdBlock();
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const pw = readPwd();
    const d = await auApi({ action: 'create', adminId: user.id,
      username: $('#auU').value, name: $('#auN').value, email: $('#auE').value || null,
      role: $('#auR').value, ...pw });
    if (!d.ok) { alert(d.error); return; }
    closeModal();
    if (d.tempPassword) alert('Contraseña temporal: ' + d.tempPassword);
    viewEquipo(user);
  });
}
function auAction(ds, user) {
  if (ds.act === 'toggle') {
    auApi({ action: 'toggle', adminId: user.id, id: ds.id, isActive: !(ds.active === 'true') }).then(() => viewEquipo(user));
    return;
  }
  openModal(`
    <div class="modal-head"><span>Resetear contraseña</span><button class="modal-x" id="mX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px">${ds.u}</p>
    ${pwdBlockHtml()}
    <div class="modal-actions"><button class="btn" id="mCancel">Cancelar</button><button class="btn btn-primary" id="mOk">Resetear</button></div>`);
  wirePwdBlock();
  $('#mX').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mOk').addEventListener('click', async () => {
    const pw = readPwd();
    const d = await auApi({ action: 'reset', adminId: user.id, id: ds.id, ...pw });
    if (!d.ok) { alert(d.error); return; }
    closeModal();
    if (d.tempPassword) alert('Contraseña temporal: ' + d.tempPassword);
    viewEquipo(user);
  });
}
async function auApi(payload) {
  const res = await fetch('/api/admin-users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return res.json();
}

/* ---------- VISTA: PERMISOS (editor de alcance) ---------- */
let SCOPE = null; // estado de edición: {include:[], exclude:[], zones, subzones, companies, target}

async function viewPermisos(user) {
  $('#pnlMain').innerHTML = `<div class="pnl-head"><div><h1>Permisos</h1><p>Alcance de cada admin</p></div></div><div class="pnl-loading">Cargando…</div>`;
  const d = await auApi({ action: 'list', adminId: user.id });
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }
  const admins = d.rows.filter(a => a.role !== 'superadmin'); // superadmin ve todo
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Permisos</h1><p>Alcance de cada admin · el superadmin ve todo</p></div></div>
    ${admins.length === 0 ? '<div class="card"><p class="muted" style="margin:0">No hay admins (no superadmin) aún. Crea uno en la sección Equipo.</p></div>' : `
    <div class="tablebox"><table><thead><tr>
      <th>Usuario</th><th>Nombre</th><th>Estado</th><th style="text-align:right">Alcance</th>
    </tr></thead><tbody>
      ${admins.map(a => `<tr>
        <td class="code">${a.username}</td><td>${a.name || '—'}</td>
        <td>${a.is_active ? '<span class="pill pill-open">Activo</span>' : '<span class="pill pill-closed">Inactivo</span>'}</td>
        <td style="text-align:right"><button class="btn btn-mini btn-primary" data-id="${a.id}" data-u="${a.username}">${I.sliders} Editar alcance</button></td>
      </tr>`).join('')}
    </tbody></table></div>`}`;
  $('#pnlMain').querySelectorAll('button[data-id]').forEach(b =>
    b.addEventListener('click', () => openScopeEditor(user, b.dataset.id, b.dataset.u)));
}

async function openScopeEditor(user, targetId, targetUser) {
  $('#pnlMain').innerHTML = `<div class="pnl-loading">Cargando alcance…</div>`;
  const d = await fetch('/api/admin-scope', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get', adminId: user.id, targetId }),
  }).then(r => r.json());
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }

  SCOPE = {
    target: targetId, targetUser,
    include: d.include.map(x => ({ ...x })),
    exclude: d.exclude.map(x => ({ ...x })),
    zones: d.zones, subzones: d.subzones, companies: d.companies,
  };

  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Alcance de ${targetUser}</h1>
      <p>Define qué tiendas puede gestionar. Alcance final = incluidos − excluidos.</p></div>
      <button class="btn" id="scBack">← Volver</button></div>
    <div class="card">
      <div class="sc-add">
        <select id="scLevel">
          <option value="zone">Zona</option>
          <option value="subzone">Subzona</option>
          <option value="company">Tienda</option>
        </select>
        <div class="search" style="flex:1">${I.search}<input id="scSearch" placeholder="Buscar…" autocomplete="off"></div>
      </div>
      <div id="scResults" class="sc-results"></div>
    </div>
    <div class="cards-row">
      <div class="card" style="flex:1">
        <h3 style="color:var(--success)">Incluidos (<span id="scIncN">0</span>)</h3>
        <div id="scIncList" class="sc-list"></div>
      </div>
      <div class="card" style="flex:1">
        <h3 style="color:var(--danger)">Excluidos (<span id="scExcN">0</span>)</h3>
        <div id="scExcList" class="sc-list"></div>
      </div>
    </div>
    <div class="card" id="scSummary" style="font-size:13px;color:var(--ink-soft)"></div>
    <div class="modal-actions">
      <button class="btn" id="scCancel">Cancelar</button>
      <button class="btn btn-primary" id="scSave">Guardar alcance</button>
    </div>`;

  $('#scBack').addEventListener('click', () => viewPermisos(user));
  $('#scCancel').addEventListener('click', () => viewPermisos(user));
  $('#scSave').addEventListener('click', () => saveScope(user));

  const lvl = $('#scLevel'), search = $('#scSearch');
  lvl.addEventListener('change', () => { search.value = ''; renderScResults(); });
  search.addEventListener('input', renderScResults);
  renderScopeLists();
  renderScResults();
}

// Etiqueta legible de un item de alcance
function scopeLabel(type, value) {
  if (type === 'zone') {
    const z = SCOPE.zones.find(z => String(z.id) === String(value));
    return `Zona: ${z ? z.name : value}`;
  }
  if (type === 'subzone') {
    const s = SCOPE.subzones.find(s => String(s.id) === String(value));
    return `Subzona: ${s ? s.name : value}`;
  }
  const c = SCOPE.companies.find(c => c.company_code === value);
  return `Tienda: ${value}${c ? ' · ' + c.business_name : ''}`;
}

function renderScResults() {
  const level = $('#scLevel').value;
  const q = $('#scSearch').value.toLowerCase();
  let opts = [];
  if (level === 'zone') opts = SCOPE.zones.map(z => ({ value: String(z.id), label: z.name }));
  else if (level === 'subzone') opts = SCOPE.subzones.map(s => ({ value: String(s.id), label: s.name }));
  else opts = SCOPE.companies.map(c => ({ value: c.company_code, label: `${c.company_code} · ${c.business_name}` }));
  if (q) opts = opts.filter(o => o.label.toLowerCase().includes(q));
  opts = opts.slice(0, 30);

  $('#scResults').innerHTML = opts.map(o =>
    `<div class="sc-res-row">
       <span>${o.label}</span>
       <span class="sc-res-btns">
         <button class="sc-inc" data-v="${o.value}" title="Incluir">+ incluir</button>
         <button class="sc-exc" data-v="${o.value}" title="Excluir">− excluir</button>
       </span>
     </div>`).join('') || '<div class="muted" style="padding:8px">Sin coincidencias.</div>';

  $('#scResults').querySelectorAll('.sc-inc').forEach(b =>
    b.addEventListener('click', () => addScope('include', level, b.dataset.v)));
  $('#scResults').querySelectorAll('.sc-exc').forEach(b =>
    b.addEventListener('click', () => addScope('exclude', level, b.dataset.v)));
}

function addScope(bucket, type, value) {
  const list = SCOPE[bucket];
  if (list.some(x => x.scope_type === type && String(x.scope_value) === String(value))) return; // ya está
  list.push({ scope_type: type, scope_value: String(value) });
  renderScopeLists();
}
function removeScope(bucket, type, value) {
  SCOPE[bucket] = SCOPE[bucket].filter(x => !(x.scope_type === type && String(x.scope_value) === String(value)));
  renderScopeLists();
}

function renderScopeLists() {
  const mk = (bucket) => SCOPE[bucket].map(x =>
    `<div class="sc-item"><span>${scopeLabel(x.scope_type, x.scope_value)}</span>
      <button data-b="${bucket}" data-t="${x.scope_type}" data-v="${x.scope_value}" title="Quitar">✕</button></div>`
  ).join('') || '<div class="muted" style="padding:8px">Vacío.</div>';
  $('#scIncList').innerHTML = mk('include');
  $('#scExcList').innerHTML = mk('exclude');
  $('#scIncN').textContent = SCOPE.include.length;
  $('#scExcN').textContent = SCOPE.exclude.length;
  document.querySelectorAll('.sc-item button').forEach(b =>
    b.addEventListener('click', () => removeScope(b.dataset.b, b.dataset.t, b.dataset.v)));

  // Resumen estimado de tiendas
  const est = estimateScope();
  $('#scSummary').innerHTML = `<span class="muted">Resultado estimado:</span> <strong>${est}</strong> tiendas gestionables.`;
}

// Estima cuántas tiendas quedan en el alcance (include − exclude)
function estimateScope() {
  const tiendas = SCOPE.companies; // solo tipo Tienda
  const inSet = new Set();
  SCOPE.include.forEach(x => {
    if (x.scope_type === 'zone') tiendas.filter(c => String(c.zone_id) === String(x.scope_value)).forEach(c => inSet.add(c.company_code));
    else if (x.scope_type === 'subzone') tiendas.filter(c => String(c.subzone_id) === String(x.scope_value)).forEach(c => inSet.add(c.company_code));
    else inSet.add(x.scope_value);
  });
  SCOPE.exclude.forEach(x => {
    if (x.scope_type === 'zone') tiendas.filter(c => String(c.zone_id) === String(x.scope_value)).forEach(c => inSet.delete(c.company_code));
    else if (x.scope_type === 'subzone') tiendas.filter(c => String(c.subzone_id) === String(x.scope_value)).forEach(c => inSet.delete(c.company_code));
    else inSet.delete(x.scope_value);
  });
  return inSet.size;
}

async function saveScope(user) {
  const btn = $('#scSave'); btn.disabled = true; btn.textContent = 'Guardando…';
  const d = await fetch('/api/admin-scope', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save', adminId: user.id, targetId: SCOPE.target,
      include: SCOPE.include, exclude: SCOPE.exclude }),
  }).then(r => r.json());
  if (!d.ok) { alert(d.error); btn.disabled = false; btn.textContent = 'Guardar alcance'; return; }
  viewPermisos(user);
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
        <button class="btn btn-primary" id="syncBtn">${I.sync} Sincronizar ahora</button>
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
async function ensureCatalog(user) {
  if (CATALOG) return;
  $('#pnlMain').innerHTML = '<div class="pnl-loading">Cargando catálogo…</div>';
  // POST con la sesión: el servidor filtra las empresas según rol/alcance
  const res = await fetch('/api/catalog', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user }),
  });
  const d = await res.json();
  if (!d.ok) { $('#pnlMain').innerHTML = `<div class="pnl-loading">Error: ${d.error}</div>`; return; }
  CATALOG = d;
}

async function navigate(view, user) {
  currentView = view;
  document.querySelectorAll('#pnlNav button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  if (view === 'tiendas' || view === 'catalogos') {
    await ensureCatalog(user);
    if (!CATALOG) return;
  }
  if (view === 'tiendas') viewTiendas(user);
  else if (view === 'catalogos') viewCatalogos();
  else if (view === 'usuarios') viewUsuarios(user);
  else if (view === 'equipo') viewEquipo(user);
  else if (view === 'permisos') viewPermisos(user);
  else if (view === 'sync') viewSync(user);
  else if (view === 'miempresa') viewMiEmpresa(user);
}

/* ---------- VISTA: MI EMPRESA (solo rol tienda) ---------- */
async function viewMiEmpresa(user) {
  $('#pnlMain').innerHTML = `<div class="pnl-loading">Cargando…</div>`;
  // El catálogo (filtrado) trae solo la propia empresa de la tienda
  await ensureCatalog(user);
  const c = (CATALOG && CATALOG.companies && CATALOG.companies[0]) || null;
  if (!c) {
    $('#pnlMain').innerHTML = `<div class="card"><p class="muted" style="margin:0">No se encontraron los datos de tu empresa. Contacta a Capital Humano.</p></div>`;
    return;
  }
  const tel = phoneDisplay(c.phone);
  const tel2 = phoneDisplay(c.phone2);
  const telLine = [tel, tel2].filter(Boolean).join(' / ') || '—';
  $('#pnlMain').innerHTML = `
    <div class="pnl-head"><div><h1>Mi empresa</h1><p>Datos registrados de tu tienda</p></div></div>
    <div class="card miemp-card">
      <div class="miemp-code">${c.code}</div>
      <h2 class="miemp-name">${c.name || ''}</h2>
      <div class="miemp-grid">
        <div><span class="miemp-lbl">Concepto</span><span>${c.concept || '—'}</span></div>
        <div><span class="miemp-lbl">Zona</span><span>${c.zone || '—'}</span></div>
        <div><span class="miemp-lbl">Subzona</span><span>${c.subzone || '—'}</span></div>
        <div><span class="miemp-lbl">Estado</span><span>${statusPill(c.status)}</span></div>
        <div><span class="miemp-lbl">Correo</span><span>${c.email || '—'}</span></div>
        <div><span class="miemp-lbl">Teléfono</span><span>${telLine}</span></div>
      </div>
    </div>
    <div class="card" style="display:flex;gap:10px;align-items:center">
      <span class="badge-soon">Próximamente</span>
      <p class="muted" style="margin:0">El envío de reportes de nómina estará disponible aquí muy pronto.</p>
    </div>`;
}

export function renderPanel() {
  const user = getSession();
  if (!user) { go('/login'); return; }
  // Limpiar estado en memoria de cualquier sesión previa (evita que datos
  // de un usuario anterior "se filtren" si se cambia de sesión sin recargar).
  CATALOG = null; CU_ROWS = null; SCOPE = null; currentView = 'tiendas';
  mount(shell(user));
  loadAvatar((user.email || '').trim().toLowerCase());
  $('#logoutBtn').addEventListener('click', () => { clearSession(); go('/login'); });
  document.querySelectorAll('#pnlNav button').forEach(b =>
    b.addEventListener('click', () => navigate(b.dataset.view, user)));
  // Rol tienda: solo su propia empresa. Admin/superadmin: arranca en Empresas.
  if (user.kind === 'company') navigate('miempresa', user);
  else navigate('tiendas', user);
}
