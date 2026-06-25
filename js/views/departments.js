/* =====================================================================
   js/views/departments.js  →  vista "Departamentos de una empresa"
   ABM de departamentos de UNA empresa no-tienda. Se entra desde el boton
   "Departamentos" en la fila de la empresa (vista Empresas). Manual, no
   viene de AX. Una empresa puede tener 0..N.

   Reglas:
     - Solo empresas NO-tienda (lo valida tambien el backend).
     - Un departamento solo se elimina si NO tiene usuario de empresa
       asignado (alcance); si lo tiene, primero se quita o se desactiva.
     - Muestra que Usuario de Empresa reporta hoy por cada departamento
       (1 persona por combinacion Empresa-Departamento).

   Exporta renderDepartments(user, company, onExit) donde:
     - company = { code, name, taxId, type, zone, subzone, concept, status }
       (la fila de CATALOG.companies del panel).
     - onExit  = callback para el boton Volver (regresa a Empresas).
   Pinta dentro de #pnlMain. Reusa clases CSS globales del portal.
   ===================================================================== */

import { $ } from '../core/dom.js';

const PLUS = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
const PENCIL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

let USER = null;
let COMPANY = null;
let ON_EXIT = null;
let ROWS = null;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function api(payload) {
  const res = await fetch('/api/departments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

/* ---- modal (clases globales del portal) ---- */
function openModal(html) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'modal-ov'; ov.id = 'depModalOv';
  ov.innerHTML = `<div class="modal-box">${html}</div>`;
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
  document.body.appendChild(ov);
}
function closeModal() {
  const ex = document.getElementById('depModalOv');
  if (ex) ex.remove();
}

/* Barra de contexto de empresa (misma que Personal). */
function companyBarHtml(c) {
  c = c || {};
  const statusPill = /abier/i.test(c.status || '')
    ? '<span class="pill pill-open">Abierta</span>'
    : (c.status ? `<span class="pill pill-gray">${esc(c.status)}</span>` : '');
  return `<div class="ff-emp">
      <div class="ff-emp-main">
        <span class="ff-emp-code">${esc(c.code || '')}</span>
        <span class="ff-emp-name">${esc(c.name || '')}</span>
      </div>
      ${c.taxId ? `<span class="ff-emp-item"><span class="k">RIF</span>${esc(c.taxId)}</span>` : ''}
      ${c.type ? `<span class="ff-emp-item"><span class="k">Tipo</span>${esc(c.type)}</span>` : ''}
      ${c.zone ? `<span class="ff-emp-item"><span class="k">Zona</span>${esc(c.zone)}</span>` : ''}
      ${statusPill}
    </div>`;
}

export async function renderDepartments(user, company, onExit) {
  USER = user; COMPANY = company; ON_EXIT = onExit || null;

  $('#pnlMain').innerHTML = `
    <button class="btn" id="depBack" style="margin-bottom:12px">← Volver a Empresas</button>
    <div id="depEmpBar">${companyBarHtml(company)}</div>
    <div class="pnl-head">
      <div><h1>Departamentos</h1><p id="depInfo">Cargando…</p></div>
      <div class="head-actions">
        <button class="btn btn-primary" id="depNew">${PLUS} Nuevo departamento</button>
      </div>
    </div>
    <div id="depBody"><div class="pnl-loading">Cargando…</div></div>
    <p class="muted" style="font-size:12px;margin:14px 2px 0;line-height:1.6">
      Un departamento solo se puede eliminar si no tiene usuario de empresa asignado (si lo tiene, primero se quita el
      alcance o se desactiva). La columna “Usuario de empresa” muestra quién reporta hoy por ese departamento —
      una sola persona por combinación Empresa-Departamento.
    </p>`;

  if (ON_EXIT) $('#depBack').addEventListener('click', ON_EXIT);
  $('#depNew').addEventListener('click', () => openDeptModal(null));

  await load();
}

async function load() {
  const d = await api({ action: 'list', adminId: USER.id, company_code: COMPANY.code });
  const body = $('#depBody');
  if (!d.ok) {
    body.innerHTML = `<div class="card"><p class="muted" style="margin:0">No se pudo cargar: ${esc(d.error || 'error')}</p></div>`;
    const info = $('#depInfo'); if (info) info.textContent = 'Error al cargar';
    return;
  }
  ROWS = d.departments || [];
  const conUsuario = ROWS.filter(x => x.users_count > 0).length;
  const info = $('#depInfo');
  if (info) info.textContent = `${ROWS.length} departamento${ROWS.length === 1 ? '' : 's'} · ${conUsuario} con usuario asignado`;

  if (!ROWS.length) {
    body.innerHTML = `<div class="card"><p class="muted" style="margin:0">Esta empresa aún no tiene departamentos. Crea el primero con “Nuevo departamento”.</p></div>`;
    return;
  }

  const rows = ROWS.map(dep => {
    const estado = dep.is_active ? '<span class="pill pill-open">Activo</span>' : '<span class="pill pill-closed">Inactivo</span>';
    // users_count: cuantas personas reportan por este depto (deberia ser 0 o 1).
    const userCell = dep.users_count > 0
      ? `<span class="muted">${dep.users_count} usuario${dep.users_count === 1 ? '' : 's'}</span>`
      : '<span class="muted" style="color:var(--faint)">— sin usuario —</span>';
    const delDisabled = dep.users_count > 0;
    return `<tr>
      <td><b>${esc(dep.name)}</b></td>
      <td>${userCell}</td>
      <td>${estado}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-mini" data-rename="${dep.id}" data-name="${esc(dep.name)}">${PENCIL} Renombrar</button>
        <button class="btn btn-mini" data-toggle="${dep.id}" data-active="${dep.is_active}">${dep.is_active ? 'Desactivar' : 'Activar'}</button>
        <button class="btn btn-mini" data-del="${dep.id}" data-name="${esc(dep.name)}" ${delDisabled ? 'disabled style="opacity:.5" title="Tiene usuario asignado; quítalo primero"' : 'style="color:var(--danger);border-color:#f3c2c2"'}>Eliminar</button>
      </td>
    </tr>`;
  }).join('');

  body.innerHTML = `
    <div class="tablebox"><table><thead><tr>
      <th>Departamento</th><th>Usuario de empresa</th><th>Estado</th><th style="text-align:right">Acciones</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;

  body.querySelectorAll('[data-rename]').forEach(b =>
    b.addEventListener('click', () => openDeptModal({ id: b.dataset.rename, name: b.dataset.name })));
  body.querySelectorAll('[data-toggle]').forEach(b =>
    b.addEventListener('click', async () => {
      const r = await api({ action: 'toggle', adminId: USER.id, id: b.dataset.toggle, is_active: !(b.dataset.active === 'true') });
      if (!r.ok) { alert(r.error); return; }
      load();
    }));
  body.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => {
      if (b.disabled) return;
      if (!confirm(`¿Eliminar el departamento "${b.dataset.name}"? Esta acción no se puede deshacer.`)) return;
      api({ action: 'delete', adminId: USER.id, id: b.dataset.del }).then(r => {
        if (!r.ok) { alert(r.error); return; }
        load();
      });
    }));
}

function openDeptModal(dep) {
  const isNew = !dep;
  openModal(`
    <div class="modal-head"><span>${isNew ? 'Nuevo departamento' : 'Renombrar departamento'}</span><button class="modal-x" id="depX">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 16px"><span style="font-family:ui-monospace,Menlo,monospace">${esc(COMPANY.code)}</span> · ${esc(COMPANY.name || '')}</p>
    <label class="flabel">Nombre del departamento</label>
    <input type="text" id="depName" value="${dep ? esc(dep.name) : ''}" placeholder="ej. Almacén" style="margin-bottom:6px">
    <div class="modal-actions">
      <button class="btn" id="depCancel">Cancelar</button>
      <button class="btn btn-primary" id="depOk">${isNew ? 'Crear departamento' : 'Guardar'}</button>
    </div>`);
  setTimeout(() => { const i = document.getElementById('depName'); if (i) i.focus(); }, 30);
  document.getElementById('depX').addEventListener('click', closeModal);
  document.getElementById('depCancel').addEventListener('click', closeModal);
  document.getElementById('depOk').addEventListener('click', async () => {
    const name = document.getElementById('depName').value.trim();
    if (!name) { alert('Falta el nombre del departamento.'); return; }
    const payload = isNew
      ? { action: 'create', adminId: USER.id, company_code: COMPANY.code, name }
      : { action: 'rename', adminId: USER.id, id: dep.id, name };
    const r = await api(payload);
    if (!r.ok) { alert(r.error); return; }
    closeModal();
    load();
  });
}
