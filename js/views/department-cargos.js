/* =====================================================================
   js/views/department-cargos.js  →  pestana "Cargos de departamento"
   (dentro de Configuracion, grupo "Empresas").

   Catalogo editable de cargos que se asignan a los Usuarios de Empresa
   (la persona que reporta por un departamento). Son DISTINTOS de los
   cargos de tienda. Solo el superadmin los gestiona; cualquier admin los
   lista (para poblar el combo al asignar cargo a una persona).

   Orden ALFABETICO por etiqueta. Sin eliminar: se activan/desactivan.

   Exporta renderDepartmentCargos(user, host) que pinta dentro de `host`
   (el contenedor de la pestana de Configuracion). Reusa las clases CSS
   globales del portal (cfg-*, modal-*, btn, pill).
   ===================================================================== */

import { $ } from '../core/dom.js';

const PLUS = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
const PENCIL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

let HOST = null;     // contenedor de la pestana
let USER = null;
let ROWS = null;     // cache de cargos

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function api(payload) {
  const res = await fetch('/api/department-cargos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

/* ---- modal (clases globales del portal) ---- */
function openModal(html) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'modal-ov'; ov.id = 'dcModalOv';
  ov.innerHTML = `<div class="modal-box">${html}</div>`;
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
  document.body.appendChild(ov);
}
function closeModal() {
  const ex = document.getElementById('dcModalOv');
  if (ex) ex.remove();
}

export async function renderDepartmentCargos(user, host) {
  USER = user; HOST = host;
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';

  host.innerHTML = `<div class="pnl-loading">Cargando…</div>`;
  const d = await api({ action: 'list', adminId: user.id });
  if (!d.ok) { host.innerHTML = `<div class="pnl-loading">Error: ${esc(d.error)}</div>`; return; }
  ROWS = d.cargos || [];

  const rows = ROWS.map(c => {
    const estado = c.is_active ? '<span class="pill pill-open">activo</span>' : '<span class="pill pill-closed">inactivo</span>';
    const actions = isSuper
      ? `<button class="btn btn-mini" data-edit="${c.id}">${PENCIL} Renombrar</button>
         <button class="btn btn-mini" data-toggle="${c.id}" data-active="${c.is_active}">${c.is_active ? 'Desactivar' : 'Activar'}</button>`
      : '<span class="muted" style="font-size:12px">—</span>';
    return `<tr>
      <td><b>${esc(c.label)}</b><br><span class="muted" style="font-size:11px;font-family:ui-monospace,Menlo,monospace">${esc(c.code)}</span></td>
      <td><span class="muted">${c.people_count || 0}</span></td>
      <td>${estado}</td>
      <td style="text-align:right;white-space:nowrap">${actions}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="empty">Sin cargos.</td></tr>';

  host.innerHTML = `
    <div class="card">
      <div class="cfg-card-head">
        <h3>Cargos de departamento</h3>
        ${isSuper ? `<button class="btn btn-primary btn-mini" id="dcNew">${PLUS} Nuevo cargo</button>` : ''}
      </div>
      <p class="cfg-desc" style="margin:0 0 14px">
        Cargo que se asigna a cada <b>Usuario de Empresa</b> (la persona que reporta por un departamento).
        Son independientes de los cargos de tienda. Se ordenan alfabéticamente.
        ${isSuper ? '' : '<br>Solo el superadmin puede crear o modificar cargos.'}
      </p>
      <table class="cfg-cat-table"><thead><tr>
        <th>Cargo</th><th>Personas con este cargo</th><th>Estado</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>
    <p class="muted" style="font-size:12px;margin:14px 2px 0;line-height:1.6">
      Desactivar un cargo no afecta a las personas que ya lo tienen; solo deja de ofrecerse al asignar cargo a nuevas
      personas. La columna “Personas con este cargo” ayuda a decidir antes de desactivar.
    </p>`;

  if (isSuper) {
    const nb = $('#dcNew', host);
    if (nb) nb.addEventListener('click', () => openCargoModal(null));
    host.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => openCargoModal(ROWS.find(c => String(c.id) === b.dataset.edit))));
    host.querySelectorAll('[data-toggle]').forEach(b =>
      b.addEventListener('click', async () => {
        const r = await api({ action: 'toggle', adminId: USER.id, id: b.dataset.toggle, is_active: !(b.dataset.active === 'true') });
        if (!r.ok) { alert(r.error); return; }
        renderDepartmentCargos(USER, HOST);
      }));
  }
}

function openCargoModal(c) {
  const isNew = !c;
  openModal(`
    <div class="modal-head"><span>${isNew ? 'Nuevo cargo de departamento' : 'Renombrar cargo'}</span><button class="modal-x" id="dcX">✕</button></div>
    ${!isNew ? `<p class="muted" style="font-size:12.5px;margin:0 0 14px">Código interno: <span style="font-family:ui-monospace,Menlo,monospace">${esc(c.code)}</span> (no cambia)</p>` : ''}
    <label class="flabel">Nombre del cargo</label>
    <input type="text" id="dcLabel" value="${c ? esc(c.label) : ''}" placeholder="ej. Supervisor" style="margin-bottom:6px">
    <div class="modal-actions">
      <button class="btn" id="dcCancel">Cancelar</button>
      <button class="btn btn-primary" id="dcOk">${isNew ? 'Crear cargo' : 'Guardar'}</button>
    </div>`);
  // foco
  setTimeout(() => { const i = document.getElementById('dcLabel'); if (i) i.focus(); }, 30);
  document.getElementById('dcX').addEventListener('click', closeModal);
  document.getElementById('dcCancel').addEventListener('click', closeModal);
  document.getElementById('dcOk').addEventListener('click', async () => {
    const label = document.getElementById('dcLabel').value.trim();
    if (!label) { alert('Falta el nombre del cargo.'); return; }
    const payload = isNew
      ? { action: 'create', adminId: USER.id, label }
      : { action: 'rename', adminId: USER.id, id: c.id, label };
    const r = await api(payload);
    if (!r.ok) { alert(r.error); return; }
    closeModal();
    renderDepartmentCargos(USER, HOST);
  });
}
