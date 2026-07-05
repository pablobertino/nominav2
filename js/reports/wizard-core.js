/* =====================================================================
   js/reports/wizard-core.js
   Armazon compartido del wizard de incidencias. Orquesta los pasos
   comunes y delega el paso especifico (paso 4) al modulo del reporte.

   Un "reportDef" describe el reporte concreto:
     {
       code, title, icon, tag,           // identidad
       step4Label,                        // etiqueta del paso especifico
       renderStep4(ctx),                  // pinta el paso 4 (config por trabajador)
       isComplete(worker),                // ¿el trabajador ya quedo configurado?
       summaryColumns,                    // [{key,label}] columnas extra del resumen
       summaryCell(worker, key),          // valor de una celda del resumen
       submit(ctx),                       // envia el reporte (Promise<{ok,...}>)
     }

   ctx (contexto compartido que se pasa al reportDef):
     { user, companyCode, win, workers, getWorker, rerenderStep4,
       updateStep4Next, fmt }

   Estado interno: roster, meta, responsables, workers, ventana.
   ===================================================================== */

import { $ } from '../core/dom.js';
import { pushBackInterceptor } from '../core/back-nav.js';
import * as DW from './shared/date-window.js';
import * as Roster from './shared/roster.js';
import * as Resp from './shared/responsables.js';
import * as Pick from './shared/workers-picker.js';

const { fmtDate } = DW;

export function launchWizard(user, reportDef, onExit) {
  const companyCode = user.kind === 'company' ? user.companyCode : (user.pickedCompany || null);
  // Cuando reporta un admin/superadmin por una empresa, el responsable es la
  // propia central (el admin), no un gerente de la tienda. En ese caso se
  // omite el paso 2 y el reporte se marca con origen 'admin'.
  const isAdmin = user.kind !== 'company';
  // El roster de las empresas NO-tienda vive en enterprise_workers, no en
  // store_workers. isEnterprise decide el endpoint de carga del roster
  // (paso 1). Aplica tanto al admin que reporta por una empresa como al
  // USUARIO DE COMPANIA cuya propia empresa es no-tienda (ej. 0A01).
  const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea']);
  const companyType = user.kind === 'company' ? (user.companyType || null) : (user.pickedCompanyType || null);
  const isEnterprise = NON_STORE_TYPES.has(companyType);
  const wizAdminId = user.id || null;
  const entidad = isEnterprise ? 'la empresa' : 'la tienda';

  // Algunos reportes (Ingreso) capturan TODO en el paso 4 y no usan el paso
  // 3 (Trabajadores), porque la persona es nueva y no sale del roster. El
  // flag skipWorkerStep del reportDef omite ese paso del recorrido y del
  // stepper, sin afectar a los demas reportes.
  const skipWorkers = !!reportDef.skipWorkerStep;
  // Paso anterior al 4 segun el rol y si se omite el paso 3.
  const stepBefore4 = skipWorkers ? (isAdmin ? 1 : 2) : 3;

  // ---- estado ----
  const S = {
    step: 1,
    companyName: user.pickedCompanyName || null, // nombre de la empresa (admin)
    roster: [],            // [{id_number, full_name, role, end_date, ...}]
    meta: null,            // store_roster_meta
    responsables: [],      // [{id, full_name, role}]
    selResp: null,
    workers: [],           // [{id, ced, name, role, endDate, mark}]
    nextId: 1,
    win: null,             // ventana de fechas (computeWindow)
    rosterSort: { key: 'name', dir: 1 },
    pickSort: { key: 'name', dir: 1 },
    stopClock: null,
  };

  // ---- shell del wizard ----
  // Se renderiza DENTRO de #pnlMain para conservar el sidebar/topbar del
  // panel. Asi "Volver a reportes" solo repinta la vista anterior.
  function render() {
    const steps = isAdmin ? [
      [1, 'Lista de ' + entidad],
      [3, 'Trabajadores'],
      [4, reportDef.step4Label || 'Detalle'],
      [5, 'Resumen'],
    ] : [
      [1, 'Lista de ' + entidad],
      [2, 'Responsable'],
      [3, 'Trabajadores'],
      [4, reportDef.step4Label || 'Detalle'],
      [5, 'Resumen'],
    ];
    // Ingreso (skipWorkers): quitar el paso 3 (Trabajadores) del stepper.
    const visibleSteps = skipWorkers ? steps.filter(([n]) => n !== 3) : steps;
    const host = document.getElementById('pnlMain') || document.getElementById('app');
    host.innerHTML = `
      <div class="wiz">
        <div class="wiz-top">
          <button class="btn wiz-exit" id="wzExit" style="display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:600;padding:10px 18px;border:1.5px solid var(--brand,#2563eb);color:var(--brand,#2563eb);background:#eff6ff;border-radius:10px;box-shadow:0 1px 2px rgba(37,99,235,.12)"><span style="font-size:17px;line-height:1">←</span> Volver a reportes</button>
          <span class="tag">${reportDef.icon || ''} ${reportDef.tag || 'Wizard'}</span>
        </div>
        <h1 class="wiz-h1">${reportDef.title}</h1>
        <p class="wiz-sub">${companyLabel()}</p>
        <div class="now-clock" id="wzClock">🕓 —</div>

        <div class="steps" id="wzSteps">
          ${visibleSteps.map(([n, label], i) => `
            <div class="step" data-s="${n}">
              <span class="dot">${i + 1}</span><span class="slabel">${label}</span>
              ${i < visibleSteps.length - 1 ? '<span class="bar"></span>' : ''}
            </div>`).join('')}
        </div>

        <div class="card" id="wzPanel"></div>
      </div>
    `;
    $('#wzExit').addEventListener('click', () => {
      exitWizard();
    });
    if (S.stopClock) S.stopClock();
    S.stopClock = DW.startClock('wzClock');
    // Registrar el interceptor de Atras una sola vez (el wizard puede repintar
    // varias veces, pero el interceptor debe existir una vez).
    if (!removeBackInterceptor) removeBackInterceptor = pushBackInterceptor(wizardBack);
    paintStep();
  }

  function companyLabel() {
    if (!companyCode) return 'Selecciona una empresa';
    const noun = isAdmin ? 'Empresa' : 'Tienda';
    const c = (S.companyName ? `${companyCode} · ${S.companyName}` : companyCode);
    return `${noun} ${c}`;
  }

  function setStep(n) { S.step = n; paintStep(); }

  // Interceptor del boton Atras del navegador: mientras el wizard este activo,
  // el Atras retrocede UN paso del wizard (respetando los saltos por rol). Si
  // ya estamos en el paso 1, devuelve false para que el guardian saque del
  // wizard a la vista anterior del portal. removeBackInterceptor lo quita al
  // salir (boton "Volver a reportes").
  let removeBackInterceptor = null;
  function wizardBack() {
    // Paso 6 (pantalla "listo"): el back sale del wizard (ya se envio).
    if (S.step === 6) { exitWizard(); return true; }
    // Paso 1: no hay a donde retroceder dentro del wizard -> salir del wizard a
    // la vista anterior (onExit), consumiendo el back.
    if (S.step <= 1) { exitWizard(); return true; }
    let prev;
    if (S.step === 5) prev = 4;
    else if (S.step === 4) prev = stepBefore4;             // 3 normal; 1/2 si se omite el paso 3
    else if (S.step === 3) prev = isAdmin ? 1 : 2;
    else if (S.step === 2) prev = 1;
    else prev = 1;
    setStep(prev);
    return true;
  }
  function exitWizard() {
    if (removeBackInterceptor) { removeBackInterceptor(); removeBackInterceptor = null; }
    if (S.stopClock) S.stopClock();
    onExit && onExit();
  }

  function paintStep() {
    // marcar stepper
    document.querySelectorAll('#wzSteps .step').forEach(s => {
      const sn = +s.dataset.s;
      s.classList.toggle('active', sn === S.step);
      s.classList.toggle('done', sn < S.step);
    });
    const fns = { 1: stepRoster, 2: stepResp, 3: stepWorkers, 4: stepDetail, 5: stepSummary, 6: stepDone };
    (fns[S.step] || stepRoster)();
  }

  /* ---------- PASO 1: lista de la tienda ---------- */
  async function loadRoster() {
    // No-tienda: el roster esta en enterprise_workers. Se lee por el
    // DIRECTORIO (/api/worker-photo), que es type-aware y valida por usuario:
    // sirve para el admin (alcance) Y para el usuario de empresa que reporta
    // por su propia empresa. enterprise-roster es solo-admin, por eso no se
    // usa aqui (rompia el caso del usuario de compania, ej. 0A01).
    if (isEnterprise) {
      const res = await fetch('/api/worker-photo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'directory', company_code: companyCode,
          user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null } }),
      }).then(r => r.json()).catch(() => ({ ok: false }));
      if (res && res.ok) {
        S.roster = res.workers || [];
        // Normalizar meta al shape que usa la vista (total_count/active_count).
        const m = res.meta;
        if (m) {
          const total = (res.workers || []).length;
          const active = (res.workers || []).filter(w => !w.end_date).length;
          S.meta = { ...m, total_count: m.total_count != null ? m.total_count : total, active_count: active };
        } else S.meta = null;
      }
      return res;
    }
    const r = await Roster.rosterGet(companyCode);
    if (r.ok) { S.roster = r.workers || []; S.meta = r.meta || null; }
    return r;
  }

  function stepRoster() {
    const panel = $('#wzPanel');
    panel.innerHTML = `<h2>Lista de trabajadores de ${entidad}</h2>
      <p class="hint">${isEnterprise ? 'El reporte parte de la lista de personal de la empresa (sincronizada desde AX).' : 'El reporte parte de la lista de personal (Reporte 10 del POS). De aquí salen los trabajadores y los responsables (Gerente / Sub-Gerente).'}</p>
      <div class="pnl-loading">Cargando lista…</div>`;
    loadRoster().then(() => renderRosterStep());
  }

  function renderRosterStep() {
    const panel = $('#wzPanel');
    const ageDays = Roster.rosterAgeDays(S.meta);
    const margin = S.win ? S.win.marginDays : 2;
    const showWarn = ageDays != null && ageDays > margin;
    const metaLine = S.meta
      ? `Lista cargada el ${fmtDate(S.meta.uploaded_at)} · ${S.meta.total_count} trabajadores (${S.meta.active_count} vigentes · ${S.meta.total_count - S.meta.active_count} egresados)`
      : `Esta ${isEnterprise ? 'empresa' : 'tienda'} aún no tiene lista cargada.`;

    panel.innerHTML = `
      <h2>Lista de trabajadores de ${entidad}</h2>
      <p class="hint">${isEnterprise ? 'El reporte parte de la lista de personal de la empresa (sincronizada desde AX).' : 'El reporte parte de la lista de personal (Reporte 10 del POS). De aquí salen los trabajadores y los responsables (Gerente / Sub-Gerente).'}</p>

      ${showWarn ? `<div class="warn-banner">⚠ <div>Esta lista se cargó hace <b>${ageDays} días</b> y podría estar desactualizada. Considera subir el <b>Reporte 10</b> más reciente para evitar reportar a alguien que ya egresó.</div></div>` : ''}

      <div class="roster-status">
        <span class="rs-ico">📋</span>
        <div class="rs-main"><div class="rs-title">${S.meta ? `Lista cargada el ${fmtDate(S.meta.uploaded_at)}` : 'Sin lista cargada'}</div>
          <div class="rs-meta">${metaLine}</div></div>
      </div>

      <div class="subtabs" id="rTabs">
        <div class="subtab on" data-tab="view">Ver lista actual</div>
        <div class="subtab" data-tab="upload">Actualizar (subir Reporte 10)</div>
      </div>

      <div data-tp="view">
        <div class="roster-head">
          <div class="search"><input id="rSearch" placeholder="Buscar por nombre o cédula…"></div>
          <span class="roster-info" id="rInfo"></span>
        </div>
        <div class="picktable-wrap"><table class="picktable">
          <thead><tr>
            <th class="sortable" data-sort="name">Trabajador ⇅</th>
            <th class="sortable" data-sort="ced">Cédula ⇅</th>
            <th class="sortable" data-sort="role">Cargo ⇅</th><th>Estado</th>
          </tr></thead><tbody id="rBody"></tbody>
        </table></div>
      </div>

      <div data-tp="upload" style="display:none">
        <div class="dropzone" id="rDrop">📄 Haz clic para seleccionar el <b>Reporte 10</b> (.xlsx)<br>
          <span style="font-size:12px">El archivo se procesa en tu navegador</span></div>
        <input type="file" id="rFile" accept=".xlsx,.xls" hidden>
        <div id="rUpResult"></div>
        ${S.meta ? `<div style="border-top:1px solid var(--border-soft);margin-top:18px;padding-top:16px">
          <div class="rs-title" style="font-size:13px;margin-bottom:4px">Eliminar la lista guardada</div>
          <p class="hint" style="margin:0 0 10px">Borra por completo la lista de esta tienda de la base de datos. Úsalo si quieres empezar de cero. Los reportes ya enviados no se ven afectados.</p>
          <button class="btn" id="rClear" style="color:var(--danger);border-color:#f3c2c2">🗑 Eliminar lista de la tienda</button>
        </div>` : ''}
      </div>

      <div class="wiz-foot"><span></span>
        ${S.roster.length
          ? `<button class="btn btn-primary" id="rNext">Siguiente →</button>`
          : `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
               <span style="font-size:12px;color:var(--muted);max-width:340px;text-align:right">Sin lista no se validan cédulas contra el personal ni fechas de egreso, y deberás escribir los datos a mano.</span>
               <button class="btn" id="rNoList">Continuar sin lista →</button>
             </div>`}
      </div>`;

    // tabs
    panel.querySelectorAll('#rTabs .subtab').forEach(t => t.addEventListener('click', () => {
      panel.querySelectorAll('#rTabs .subtab').forEach(x => x.classList.toggle('on', x === t));
      panel.querySelectorAll('[data-tp]').forEach(p => p.style.display = p.dataset.tp === t.dataset.tab ? 'block' : 'none');
    }));
    // orden + buscador
    panel.querySelectorAll('#rTabs ~ [data-tp="view"] .sortable, [data-tp="view"] .sortable').forEach(th =>
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        S.rosterSort.dir = S.rosterSort.key === k ? -S.rosterSort.dir : 1;
        S.rosterSort.key = k; paintRosterTable();
      }));
    $('#rSearch').addEventListener('input', paintRosterTable);
    // upload
    $('#rDrop').addEventListener('click', () => $('#rFile').click());
    $('#rFile').addEventListener('change', onPickFile);
    if ($('#rClear')) $('#rClear').addEventListener('click', openRosterClear);
    // next: admin salta el paso 2 (Responsable); Ingreso ademas salta el 3.
    // Hay dos botones posibles segun haya lista o no (#rNext / #rNoList);
    // ambos avanzan al mismo paso. "Continuar sin lista" deja S.roster vacio
    // (el paso 3 cae en captura manual y el paso 2 permite cargar el
    // responsable a mano o elegir "Sin gerente asignado").
    const goNext = () => setStep(isAdmin ? (skipWorkers ? 4 : 3) : 2);
    if ($('#rNext')) $('#rNext').addEventListener('click', goNext);
    if ($('#rNoList')) $('#rNoList').addEventListener('click', goNext);

    // No-tienda: el roster se gestiona desde Personal (Reporte AX / Sync), no
    // desde aqui. Se oculta la subtab de subir Reporte 10 (que escribiria en
    // store_workers, tabla equivocada) y se deja solo la vista de la lista.
    if (isEnterprise) {
      const upTab = panel.querySelector('#rTabs .subtab[data-tab="upload"]');
      if (upTab) upTab.remove();
      const upPanel = panel.querySelector('[data-tp="upload"]');
      if (upPanel) upPanel.remove();
    }

    paintRosterTable();
  }

  function paintRosterTable() {
    const q = ($('#rSearch') && $('#rSearch').value) || '';
    let list = Pick.filterRoster(S.roster, q);
    list = Pick.sortRoster(list, S.rosterSort.key, S.rosterSort.dir);
    const vig = S.roster.filter(r => !r.end_date).length;
    if ($('#rInfo')) $('#rInfo').textContent = `${S.roster.length} en total · ${vig} vigentes`;
    $('#rBody').innerHTML = list.map(r => {
      const mr = r.manager_role || null;   // 'Gerente' | 'Sub-Gerente' | null
      // Destacar responsables con fondo suave (gerente mas marcado que sub).
      const rowStyle = mr === 'Gerente'
        ? 'background:#eaf3ff'
        : (mr === 'Sub-Gerente' ? 'background:#f2f7ff' : '');
      const mgrBadge = mr ? ` <span class="pill pill-set" style="margin-left:4px">${mr}</span>` : '';
      // Cargo mostrado: el canonico del catalogo (cargo_label) si se
      // resolvio; si no, el texto crudo del Reporte 10.
      const cargoTxt = r.cargo_label || r.role || 'sin cargo';
      return `
      <tr class="${r.end_date ? 'egresado' : ''} ${mr ? 'mgr-row' : ''}" ${rowStyle ? `style="${rowStyle}"` : ''}>
        <td class="pname">${r.full_name}</td>
        <td class="ced">${r.id_number}</td>
        <td><span class="pill pill-role">${cargoTxt}</span>${mgrBadge}</td>
        <td>${Roster.workerStatusLabel(r)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="4" class="empty">Sin coincidencias.</td></tr>';
  }

  async function onPickFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const box = $('#rUpResult');
    box.innerHTML = '<div class="validation">Procesando archivo…</div>';
    try {
      const parsed = await Roster.parseReport10(file);
      const v = Roster.validateParsed(parsed);
      box.innerHTML = ''; // el resultado se muestra en el modal
      openRosterConfirm(parsed, v);
    } catch (err) {
      box.innerHTML = `<div class="validation"><div class="vrow err">✗ ${err.message || err}</div></div>`;
    } finally {
      e.target.value = '';
    }
  }

  // Modal de confirmacion al subir un Reporte 10: resume lo leido y
  // pregunta explicitamente si se quiere reemplazar la lista actual.
  function openRosterConfirm(parsed, v) {
    const hasPrev = !!S.meta;
    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    ov.innerHTML = `
      <div class="modal">
        <h3>${hasPrev ? '¿Reemplazar la lista de la tienda?' : 'Confirmar carga de la lista'}</h3>
        <p class="who">Archivo: <b>${parsed.fileName}</b></p>
        <div class="validation" style="margin-top:0">
          ${parsed.missing.length
            ? `<div class="vrow err">✗ Faltan columnas esenciales: ${parsed.missing.join(', ')}</div>`
            : `<div class="vrow ok">✓ Columnas esenciales: ${parsed.columnsFound.join(', ')}</div>`}
          <div class="vrow ok">✓ ${v.total} trabajadores leídos (${v.active} vigentes · ${v.terminated} egresados)</div>
          <div class="vrow ok">✓ Responsables detectados (estimado): ${v.gerentes} Gerente(s), ${v.subgerentes} Sub-Gerente(s)</div>
          ${v.warnings.map(w => `<div class="vrow warn">⚠ ${w}</div>`).join('')}
          ${!v.okToUpload ? `<div class="vrow err" style="margin-top:8px">No se puede cargar: revisa el archivo.</div>` : ''}
        </div>
        ${v.okToUpload && hasPrev ? `<div class="warn-banner" style="margin:14px 0 0">⚠ <div>Esto <b>reemplaza por completo</b> la lista actual (${S.meta.total_count} trabajadores cargados el ${fmtDate(S.meta.uploaded_at)}). Los responsables que ya gestionaste se conservan.</div></div>` : ''}
        <div class="wiz-foot" style="margin-top:18px">
          <button class="btn" id="rcCancel">Cancelar</button>
          ${v.okToUpload ? `<button class="btn btn-primary" id="rcOk">${hasPrev ? 'Sí, reemplazar lista' : 'Cargar lista'}</button>` : ''}
        </div>
      </div>`;
    document.body.appendChild(ov);

    ov.querySelector('#rcCancel').addEventListener('click', () => ov.remove());
    const okBtn = ov.querySelector('#rcOk');
    if (okBtn) okBtn.addEventListener('click', async () => {
      okBtn.disabled = true; okBtn.textContent = 'Subiendo…';
      const up = await Roster.rosterReplace(companyCode, v.validRows, {
        uploadedBy: user.kind === 'company' ? user.companyCode : (user.name || user.username),
        sourceFile: parsed.fileName,
      });
      if (!up.ok) {
        alert(up.error || 'Error al subir.');
        okBtn.disabled = false; okBtn.textContent = hasPrev ? 'Sí, reemplazar lista' : 'Cargar lista';
        return;
      }
      ov.remove();
      await loadRoster();
      await loadResponsables();
      renderRosterStep();
      // Confirmacion con el conteo REAL del Worker (reglas configurables),
      // que puede diferir del estimado previo si hay patrones de cargo nuevos.
      const sm = up.summary || {};
      const seeded = sm.contacts_seeded || 0;
      const segReal = `${sm.gerentes || 0} Gerente(s) y ${sm.subgerentes || 0} Sub-Gerente(s)`;
      const seededTxt = seeded
        ? ` Se renovaron ${seeded} responsable(s) desde el Reporte 10.`
        : (sm.managers ? ' Los responsables que ya gestionaste se conservaron.' : '');
      const upBox = $('#rUpResult');
      if (upBox) {
        // Asegurar que la subtab de actualizacion este visible para mostrar el aviso.
        document.querySelectorAll('#rTabs .subtab').forEach(x => x.classList.toggle('on', x.dataset.tab === 'upload'));
        document.querySelectorAll('[data-tp]').forEach(p => p.style.display = p.dataset.tp === 'upload' ? 'block' : 'none');
        upBox.innerHTML = `<div class="validation"><div class="vrow ok">✓ Lista actualizada: ${sm.total || 0} trabajadores (${sm.active || 0} vigentes · ${sm.terminated || 0} egresados).</div>`
          + `<div class="vrow ok">✓ Responsables detectados: ${segReal}.${seededTxt}</div></div>`;
      }
    });
  }

  // Modal para eliminar por completo la lista de la tienda.
  function openRosterClear() {
    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    ov.innerHTML = `
      <div class="modal">
        <h3>Eliminar la lista de la tienda</h3>
        <p class="who">Tienda ${companyCode}${S.meta ? ` · ${S.meta.total_count} trabajadores cargados el ${fmtDate(S.meta.uploaded_at)}` : ''}</p>
        <div class="warn-banner" style="margin:0 0 14px">⚠ <div>Esta acción <b>borra por completo</b> la lista de trabajadores de esta tienda de la base de datos. No se puede deshacer. Los reportes ya enviados conservan su información.</div></div>
        <label class="radio-row" style="font-size:13px"><input type="checkbox" id="rcWipe"> Eliminar también los responsables guardados</label>
        <div class="wiz-foot" style="margin-top:16px">
          <button class="btn" id="rxCancel">Cancelar</button>
          <button class="btn btn-primary" id="rxOk" style="background:var(--danger);border-color:var(--danger)">Sí, eliminar lista</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.querySelector('#rxCancel').addEventListener('click', () => ov.remove());
    ov.querySelector('#rxOk').addEventListener('click', async () => {
      const okBtn = ov.querySelector('#rxOk');
      okBtn.disabled = true; okBtn.textContent = 'Eliminando…';
      const wipe = ov.querySelector('#rcWipe').checked;
      const r = await Roster.rosterClear(companyCode, { wipeContacts: wipe });
      if (!r.ok) {
        alert(r.error || 'No se pudo eliminar.');
        okBtn.disabled = false; okBtn.textContent = 'Sí, eliminar lista';
        return;
      }
      ov.remove();
      S.selResp = null; S.workers = []; S.nextId = 1;
      await loadRoster();
      await loadResponsables();
      renderRosterStep();
    });
  }

  /* ---------- PASO 2: responsable ---------- */
  async function loadResponsables() {
    const r = await Resp.contactsList(companyCode);
    if (r.ok) S.responsables = r.contacts || [];
    // Opcion 2 (red de seguridad): si no hay responsables sembrados pero el
    // roster ya trae gerentes/subgerentes detectados (manager_role), se
    // ofrecen al vuelo para que el paso "Responsable" no quede vacio en
    // tiendas cargadas antes de la siembra automatica. Son "virtuales":
    // no tienen id de store_contacts; al elegir uno, se persiste recien al
    // confirmar (ver materializeVirtualResp).
    if ((!S.responsables || !S.responsables.length) && Array.isArray(S.roster)) {
      const detected = S.roster
        .filter(w => !w.end_date && w.manager_role)
        .slice(0, Resp.RESP_MAX)
        .map((w, i) => ({
          id: 'v' + i,            // id virtual (string con prefijo 'v')
          full_name: w.full_name,
          role: w.manager_role,
          id_number: w.id_number,
          _virtual: true,
        }));
      if (detected.length) S.responsables = detected;
    }
    return r;
  }

  // Si el responsable elegido es "virtual" (detectado del roster, aun no
  // persistido en store_contacts), lo crea ahora y devuelve su fila real.
  // Devuelve null si no habia que materializar nada.
  async function materializeVirtualResp() {
    if (S.selResp == null || S.selResp === NO_MANAGER) return null;
    const sel = S.responsables.find(r => r.id === S.selResp);
    if (!sel || !sel._virtual) return null;
    const res = await Resp.contactsAdd(companyCode, sel.full_name, sel.role, sel.id_number);
    if (res && res.ok && res.contact) {
      // refrescar la lista real y reapuntar la seleccion al id persistido
      await loadResponsables();
      const real = S.responsables.find(r => String(r.id_number || '') === String(sel.id_number || '') && !r._virtual);
      S.selResp = real ? real.id : null;
      return real || null;
    }
    return null;
  }

  function stepResp() {
    const panel = $('#wzPanel');
    panel.innerHTML = `<h2>¿Quién reporta?</h2><div class="pnl-loading">Cargando responsables…</div>`;
    loadResponsables().then(() => renderRespStep());
  }

  function renderRespStep() {
    const panel = $('#wzPanel');
    panel.innerHTML = `
      <h2>¿Quién reporta?</h2>
      <p class="hint">Elige el responsable. Los gerentes y sub-gerentes se detectaron del Reporte 10. Puedes gestionarlos (máximo ${Resp.RESP_MAX}).</p>
      <div id="respList">${respCards()}</div>
      <button class="btn" id="respManageBtn" style="margin-top:6px">⚙ Gestionar responsables</button>
      <div class="wiz-foot">
        <button class="btn" id="respBack">← Atrás</button>
        <button class="btn btn-primary" id="respNext" ${S.selResp ? '' : 'disabled'}>Siguiente →</button>
      </div>`;
    bindRespCards();
    $('#respManageBtn').addEventListener('click', openRespManage);
    $('#respBack').addEventListener('click', () => setStep(1));
    $('#respNext').addEventListener('click', async () => {
      // Si el seleccionado es un responsable detectado al vuelo (virtual),
      // se persiste en store_contacts antes de continuar.
      const btn = $('#respNext');
      if (S.selResp !== NO_MANAGER) {
        const sel = S.responsables.find(r => r.id === S.selResp);
        if (sel && sel._virtual) {
          btn.disabled = true; btn.textContent = 'Guardando\u2026';
          await materializeVirtualResp();
          btn.textContent = 'Siguiente \u2192';
        }
      }
      setStep(skipWorkers ? 4 : 3);
    });
  }

  // Centinela para "Sin gerente asignado". Solo se ofrece cuando la tienda
  // NO tiene ningun responsable detectado/gestionado (para que no abusen de
  // la opcion cuando si hay gerentes). Si la eligen, queda registrado quien
  // reporto sin gerente.
  const NO_MANAGER = 'none';

  function respCards() {
    // Caso sin responsables: ofrecer una unica tarjeta "Sin gerente asignado".
    if (!S.responsables.length) {
      return `
        <div class="warn-banner" style="margin:0 0 12px">⚠ <div>Esta tienda no tiene ningún gerente ni sub-gerente en la lista. Puedes agregar un responsable con “Gestionar responsables”, o continuar <b>sin gerente asignado</b> (quedará registrado).</div></div>
        <div class="resp-card ${S.selResp === NO_MANAGER ? 'sel' : ''}" data-id="${NO_MANAGER}">
          <span class="resp-radio"></span>
          <div class="resp-info"><div class="resp-name">Sin gerente asignado</div><div class="resp-role">La tienda no tiene gerente en la lista</div></div>
        </div>`;
    }
    // Hay responsables: debe elegir uno (no se ofrece "sin gerente").
    return S.responsables.map(r => `
      <div class="resp-card ${S.selResp === r.id ? 'sel' : ''}" data-id="${r.id}">
        <span class="resp-radio"></span>
        <div class="resp-info"><div class="resp-name">${r.full_name}</div><div class="resp-role">${r.role}</div></div>
      </div>`).join('');
  }
  function bindRespCards() {
    $('#respList').querySelectorAll('.resp-card').forEach(c => c.addEventListener('click', () => {
      const raw = c.dataset.id;
      // NO_MANAGER y los ids virtuales ('v0','v1'...) se conservan como string;
      // los responsables reales (store_contacts) son numericos.
      S.selResp = raw === NO_MANAGER ? NO_MANAGER
        : (/^v\d+$/.test(raw) ? raw : parseInt(raw, 10));
      $('#respList').innerHTML = respCards(); bindRespCards();
      $('#respNext').disabled = false;
    }));
  }

  function openRespManage() {
    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    // Empleados vigentes del roster, para el combo "elegir de la lista".
    // Se respeta su cargo real (cargo_label o role); no se les cambia.
    const rosterActive = (S.roster || []).filter(w => !w.end_date);
    const pickOptions = rosterActive.map(w => {
      const cargo = w.cargo_label || w.role || 'Sin cargo';
      // Opcion compacta: nombre + cargo (la cedula no, para no ensanchar el select).
      return `<option value="${w.id_number}">${w.full_name} \u2014 ${cargo}</option>`;
    }).join('');
    ov.innerHTML = `
      <div class="modal">
        <h3>Gestionar responsables</h3>
        <p class="who">Tienda ${companyCode} \u00b7 m\u00e1ximo ${Resp.RESP_MAX}. Tambi\u00e9n accesible por el administrador.</p>
        <div id="rmList"></div>
        ${rosterActive.length ? `
        <div style="border-top:1px solid var(--border-soft);margin-top:12px;padding-top:14px">
          <label class="flabel">Elegir de la lista de la tienda <span class="hint" style="font-weight:normal">(respeta su cargo)</span></label>
          <div style="display:flex;gap:8px;align-items:center;margin:6px 0 0">
            <select id="rmPick" style="flex:1;min-width:0"><option value="">\u2014 Selecciona un trabajador \u2014</option>${pickOptions}</select>
            <button class="btn btn-sm btn-primary" id="rmAddPick" style="flex:0 0 auto;white-space:nowrap">\uFF0B Agregar</button>
          </div>
          <span id="rmPickMsg" style="font-size:12px;color:var(--warn)"></span>
        </div>` : ''}
        <div style="border-top:1px solid var(--border-soft);margin-top:12px;padding-top:14px">
          <label class="flabel" style="display:block;margin-bottom:6px">O agregar manualmente</label>
          <div class="grid2" style="margin-bottom:10px">
            <div><label class="flabel">Nombre</label><input id="rmName" placeholder="Nombre y apellido"></div>
            <div><label class="flabel">Cargo</label><input id="rmRole" placeholder="ej. Gerente"></div>
          </div>
          <button class="btn btn-sm btn-primary" id="rmAdd">\uFF0B Agregar responsable</button>
          <span id="rmLimit" style="font-size:12px;color:var(--warn);margin-left:10px"></span>
        </div>
        <div class="wiz-foot" style="margin-top:16px"><span></span>
          <button class="btn btn-primary" id="rmClose">Listo</button></div>
      </div>`;
    document.body.appendChild(ov);

    const paint = () => {
      ov.querySelector('#rmList').innerHTML = S.responsables.length
        ? S.responsables.map(r => `<div class="resp-manage-row">
            <div class="resp-info"><div class="resp-name">${r.full_name}</div><div class="resp-role">${r.role}</div></div>
            <button class="x-btn" data-del="${r.id}">\u2715</button></div>`).join('')
        : '<div class="empty" style="padding:14px">Sin responsables.</div>';
      const full = S.responsables.length >= Resp.RESP_MAX;
      const addBtn = ov.querySelector('#rmAdd'); if (addBtn) addBtn.disabled = full;
      const pickBtn = ov.querySelector('#rmAddPick'); if (pickBtn) pickBtn.disabled = full;
      ov.querySelector('#rmLimit').textContent = full ? `M\u00e1ximo ${Resp.RESP_MAX} alcanzado` : '';
      // ocultar del combo a quienes ya son responsables (por cedula)
      const pickSel = ov.querySelector('#rmPick');
      if (pickSel) {
        const taken = new Set(S.responsables.map(r => String(r.id_number || '')));
        [...pickSel.options].forEach(o => {
          if (o.value) o.hidden = taken.has(o.value);
        });
      }
      ov.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
        await Resp.contactsRemove(parseInt(b.dataset.del, 10));
        if (S.selResp === parseInt(b.dataset.del, 10)) S.selResp = null;
        await loadResponsables(); paint();
      }));
    };
    paint();

    // Agregar desde el combo del roster (respeta el cargo real del trabajador).
    const addPickBtn = ov.querySelector('#rmAddPick');
    if (addPickBtn) addPickBtn.addEventListener('click', async () => {
      const sel = ov.querySelector('#rmPick');
      const ced = sel.value;
      const msg = ov.querySelector('#rmPickMsg');
      msg.textContent = '';
      if (!ced) { msg.textContent = 'Selecciona un trabajador.'; return; }
      const w = (S.roster || []).find(x => x.id_number === ced);
      if (!w) { msg.textContent = 'No se encontro el trabajador en la lista.'; return; }
      const cargo = w.cargo_label || w.role || 'Responsable';
      const r = await Resp.contactsAdd(companyCode, w.full_name, cargo, w.id_number);
      if (!r.ok) { msg.textContent = r.error || 'No se pudo agregar.'; return; }
      sel.value = '';
      await loadResponsables(); paint();
    });

    ov.querySelector('#rmAdd').addEventListener('click', async () => {
      const name = ov.querySelector('#rmName').value.trim();
      const role = ov.querySelector('#rmRole').value.trim();
      if (!name || !role) { alert('Completa nombre y cargo.'); return; }
      const r = await Resp.contactsAdd(companyCode, name, role);
      if (!r.ok) { alert(r.error || 'No se pudo agregar.'); return; }
      ov.querySelector('#rmName').value = ''; ov.querySelector('#rmRole').value = '';
      await loadResponsables(); paint();
    });
    ov.querySelector('#rmClose').addEventListener('click', () => {
      ov.remove();
      $('#respList').innerHTML = respCards(); bindRespCards();
      $('#respNext').disabled = S.selResp === null;
    });
  }

  /* ---------- PASO 3: trabajadores ---------- */
  // Etiqueta de la pestania "De mi ..." segun el contexto:
  //  - tienda            -> "De mi tienda"
  //  - empresa (no tienda) -> "De mi empresa"
  //  - empresa con roster acotado a un solo departamento (alcance por
  //    departamento, ej. yanmira/Tributos) -> "De <Departamento>"
  // El nombre del departamento se infiere del roster cargado: si todos los
  // trabajadores visibles comparten el mismo department_name, se usa ese.
  function rosterTabLabel() {
    if (!isEnterprise) return 'De mi tienda';
    const names = [...new Set((S.roster || [])
      .map(w => w.department_name).filter(Boolean))];
    if (names.length === 1) return `De ${names[0]}`;
    return 'De mi empresa';
  }

  function stepWorkers() {
    const panel = $('#wzPanel');
    // Si la empresa/tienda no tiene lista cargada, la pestania "De mi ..." no
    // aporta nada: arrancamos directamente en "Agregar manual".
    const noList = S.roster.length === 0;
    const rTabLabel = rosterTabLabel();
    panel.innerHTML = `
      <h2>Trabajadores afectados</h2>
      <p class="hint">${noList
        ? `Esta ${entidad === 'la empresa' ? 'empresa' : 'tienda'} no tiene lista cargada, as\u00ed que agrega a los trabajadores a mano (c\u00e9dula y nombre).${isEnterprise ? '' : ' Si subes el Reporte 10 m\u00e1s adelante, podr\u00e1s elegirlos de la lista.'}`
        : 'Marca a varios y agr\u00e9galos en bloque, o usa \u201cAgregar\u201d individual. Tambi\u00e9n puedes ordenar y buscar. Para quien no est\u00e9 en la lista, usa \u201cAgregar manual\u201d.'}</p>

      <div class="subtabs" id="wTabs">
        <div class="subtab ${noList ? '' : 'on'}" data-tab2="roster">${rTabLabel}</div>
        <div class="subtab ${noList ? 'on' : ''}" data-tab2="manual">Agregar manual</div>
      </div>

      <div data-tp2="roster" ${noList ? 'style="display:none"' : ''}>
        <div class="roster-head">
          <div class="search"><input id="pSearch" placeholder="Buscar por nombre o cédula…"></div>
          <span class="roster-info" id="pInfo"></span>
        </div>
        <div class="selbar hidden" id="pSelbar"><b id="pSelCount">0</b> marcados
          <span class="spacer"></span>
          <button class="btn btn-sm btn-primary" id="pAddSel">＋ Agregar marcados</button>
          <button class="btn btn-sm" id="pClearSel">Limpiar</button>
        </div>
        <div class="picktable-wrap"><table class="picktable">
          <thead><tr>
            <th style="width:30px"><input type="checkbox" class="chk" id="pAll"></th>
            <th class="sortable" data-psort="name">Trabajador ⇅</th>
            <th class="sortable" data-psort="ced">Cédula ⇅</th>
            <th>Cargo</th><th style="width:120px"></th>
          </tr></thead><tbody id="pBody"></tbody>
        </table></div>
      </div>

      <div data-tp2="manual" ${noList ? '' : 'style="display:none"'}>
        <div class="add-row">
          <div class="af-field"><label class="flabel">Cédula</label><input id="mCed" placeholder="V-12345678">
            <div class="ced-hint" id="mCedHint"></div></div>
          <div class="af-field"><label class="flabel">Nombre y apellido</label><input id="mName" placeholder="Nombre del trabajador">
            <div class="ced-hint" aria-hidden="true"></div></div>
          <button class="btn btn-primary af-btn" id="mAdd">＋ Agregar</button>
        </div>
      </div>

      <h2 style="margin-top:24px;font-size:14px">Agregados al reporte (<span id="wSelCount">0</span>)</h2>
      <table id="wTbl" style="display:none"><thead><tr><th>Cédula</th><th>Trabajador</th><th style="width:40px"></th></tr></thead><tbody id="wBody"></tbody></table>
      <div id="wEmpty" class="empty">Aún no has agregado trabajadores.</div>

      <div class="wiz-foot">
        <button class="btn" id="wBack">← Atrás</button>
        <button class="btn btn-primary" id="wNext" ${S.workers.length ? '' : 'disabled'}>Siguiente →</button>
      </div>`;

    // tabs
    $('#wTabs').querySelectorAll('.subtab').forEach(t => t.addEventListener('click', () => {
      $('#wTabs').querySelectorAll('.subtab').forEach(x => x.classList.toggle('on', x === t));
      document.querySelectorAll('[data-tp2]').forEach(p => p.style.display = p.dataset.tp2 === t.dataset.tab2 ? 'block' : 'none');
    }));
    // sort
    document.querySelectorAll('[data-psort]').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.psort;
      S.pickSort.dir = S.pickSort.key === k ? -S.pickSort.dir : 1; S.pickSort.key = k; paintPick();
    }));
    $('#pSearch').addEventListener('input', paintPick);
    $('#pAll').addEventListener('change', e => {
      document.querySelectorAll('.pchk').forEach(c => c.checked = e.target.checked); onPickSel();
    });
    $('#pAddSel').addEventListener('click', addSelected);
    $('#pClearSel').addEventListener('click', () => {
      document.querySelectorAll('.pchk').forEach(c => c.checked = false); $('#pAll').checked = false; onPickSel();
    });
    // manual
    $('#mCed').addEventListener('input', () => {
      const v = DW.validateCedula($('#mCed').value);
      const h = $('#mCedHint');
      h.textContent = v.msg; h.className = 'ced-hint ' + (v.msg ? (v.ok ? 'ok' : 'err') : '');
    });
    $('#mAdd').addEventListener('click', addManual);
    $('#wBack').addEventListener('click', () => setStep(isAdmin ? 1 : 2));
    $('#wNext').addEventListener('click', () => setStep(4));

    paintPick(); paintWorkers();
  }

  function paintPick() {
    const q = ($('#pSearch') && $('#pSearch').value) || '';
    let list = Pick.filterRoster(S.roster, q);
    list = Pick.sortRoster(list, S.pickSort.key, S.pickSort.dir);
    const vig = S.roster.filter(r => !r.end_date).length;
    if ($('#pInfo')) $('#pInfo').textContent = `${S.roster.length} en total · ${vig} vigentes`;
    $('#pBody').innerHTML = list.map(r => {
      const added = Pick.isAdded(S.workers, r.id_number);
      return `<tr class="${r.end_date ? 'egresado' : ''} ${added ? 'added' : ''}">
        <td>${added ? '' : `<input type="checkbox" class="chk pchk" value="${r.id_number}">`}</td>
        <td class="pname">${r.full_name} ${r.end_date ? `<span class="pill pill-out">egresó ${fmtDate(r.end_date)}</span>` : ''}</td>
        <td class="ced">${r.id_number}</td>
        <td><span class="pill pill-role">${r.cargo_label || r.role || 'sin cargo'}</span></td>
        <td>${added ? '<span class="pill pill-set">✓ agregado</span>' : `<button class="btn btn-sm btn-primary" data-add="${r.id_number}">＋ Agregar</button>`}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="empty">Sin coincidencias.</td></tr>';
    if ($('#pAll')) $('#pAll').checked = false;
    $('#pBody').querySelectorAll('.pchk').forEach(c => c.addEventListener('change', onPickSel));
    $('#pBody').querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => addFromRoster(b.dataset.add)));
    onPickSel();
  }
  function onPickSel() {
    const n = document.querySelectorAll('.pchk:checked').length;
    if ($('#pSelbar')) $('#pSelbar').classList.toggle('hidden', n === 0);
    if ($('#pSelCount')) $('#pSelCount').textContent = n;
  }
  function addFromRoster(ced) {
    const r = S.roster.find(x => x.id_number === ced);
    if (!r || Pick.isAdded(S.workers, ced)) return;
    S.workers.push(Pick.workerFromRoster(r, S.nextId++));
    paintPick(); paintWorkers();
  }
  function addSelected() {
    const ceds = [...document.querySelectorAll('.pchk:checked')].map(c => c.value);
    ceds.forEach(ced => {
      const r = S.roster.find(x => x.id_number === ced);
      if (r && !Pick.isAdded(S.workers, ced)) S.workers.push(Pick.workerFromRoster(r, S.nextId++));
    });
    paintPick(); paintWorkers();
  }
  function addManual() {
    const res = Pick.workerManual($('#mCed').value, $('#mName').value, S.nextId, S.workers);
    if (!res.ok) { alert(res.error); return; }
    S.workers.push(res.worker); S.nextId++;
    $('#mCed').value = ''; $('#mName').value = ''; $('#mCedHint').textContent = '';
    paintWorkers(); paintPick();
  }
  function removeWorker(id) {
    // Mutar el array EN SITIO (splice), no reasignar. El paso 4 captura
    // ctx.workers = S.workers (misma referencia) una sola vez; si aqui se
    // hiciera S.workers = S.workers.filter(...), ctx.workers quedaria
    // apuntando al array viejo y el modulo del reporte repintaria la lista
    // sin el cambio. Con splice, ctx.workers ve el cambio al instante.
    const idx = S.workers.findIndex(w => w.id === id);
    if (idx !== -1) S.workers.splice(idx, 1);
    // Solo repintar la tabla del paso 3 si estamos en ese paso (sus
    // elementos #wEmpty/#wTbl existen). Desde el paso 4, el modulo del
    // reporte se encarga de repintar su propia vista.
    if ($('#wTbl')) { paintWorkers(); paintPick(); }
  }
  function paintWorkers() {
    $('#wEmpty').style.display = S.workers.length ? 'none' : 'block';
    $('#wTbl').style.display = S.workers.length ? 'table' : 'none';
    $('#wSelCount').textContent = S.workers.length;
    $('#wBody').innerHTML = S.workers.map(w => `
      <tr><td class="ced">${w.ced}</td><td>${w.name} ${w.endDate ? `<span class="pill pill-out">egresó ${fmtDate(w.endDate)}</span>` : ''}</td>
      <td><button class="x-btn" data-rm="${w.id}">✕</button></td></tr>`).join('');
    $('#wBody').querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => removeWorker(parseInt(b.dataset.rm, 10))));
    if ($('#wNext')) $('#wNext').disabled = S.workers.length === 0;
  }

  /* ---------- PASO 4: detalle especifico (delegado) ---------- */
  function ctx() {
    return {
      user, companyCode, win: S.win, workers: S.workers,
      roster: S.roster,   // lista de la tienda (solo lectura): Ingreso valida que no se de de alta a alguien que ya esta en ella
      getWorker: (id) => S.workers.find(w => w.id === id),
      // Agrega un trabajador creado en el paso 4 (lo usa Ingreso: altas
      // manuales que no salen del roster). Devuelve el worker con su id.
      // El spread va primero para que id/ced/name/forma estandar siempre
      // ganen (datos extra del reporte, como .ingreso, se conservan).
      addWorker: (data) => {
        const w = { ...data, id: S.nextId++, ced: data.ced, name: data.name, role: data.role || null, endDate: data.endDate || null, mark: null };
        S.workers.push(w);
        return w;
      },
      removeWorker, rerenderStep4: stepDetail,
      setStep, fmt: { fmtDate }, DW,
      stepBefore4,   // a donde vuelve el "Atras" del paso 4 (3 normal; 1/2 si se omite el paso 3)
    };
  }
  function stepDetail() {
    // asegurar ventana de fechas (depende de la quincena en curso)
    if (!S.win) { ensureWindow().then(stepDetail); $('#wzPanel').innerHTML = '<div class="pnl-loading">Cargando…</div>'; return; }
    reportDef.renderStep4(ctx());
  }

  async function ensureWindow() {
    // La ventana se calcula server-side (hora VE real) en /api/reports.
    // Una sola fuente de verdad; el front no recalcula nada sensible.
    const res = await fetch('/api/reports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'window' }),
    }).then(r => r.json()).catch(() => null);
    if (res && res.ok && res.window) {
      S.win = res.window;
    } else {
      // fallback: calcular en cliente con defaults (solo guia visual)
      S.win = DW.computeWindow({ marginDays: 2, cutoffTime: '14:00', milestone: null });
    }
  }

  /* ---------- PASO 5: resumen ---------- */
  function stepSummary() {
    const panel = $('#wzPanel');
    const resp = S.responsables.find(r => r.id === S.selResp);
    // Responsable mostrado: admin = la central; tienda = gerente elegido, o
    // "Sin gerente asignado" si la tienda no tiene gerente y eligio esa opcion.
    let respName, respRole;
    if (isAdmin) {
      respName = user.name || user.username; respRole = 'Administrador';
    } else if (S.selResp === NO_MANAGER) {
      respName = 'Sin gerente asignado'; respRole = '';
    } else {
      respName = resp ? resp.full_name : '—'; respRole = resp ? resp.role : '';
    }
    const respLabel = respRole ? `${respName} · ${respRole}` : respName;
    const extraCols = reportDef.summaryColumns || [];
    panel.innerHTML = `
      <h2>Resumen del reporte</h2>
      <p class="hint">Verifica antes de enviar. Se generará un ticket en el sistema de Capital Humano.</p>
      <div class="grid3">
        <div class="sum-box"><div class="sb-lbl">${isAdmin ? 'Empresa' : 'Tienda'}</div><div class="sb-val">${companyLabel().replace(/^(Empresa|Tienda) /, '')}</div></div>
        <div class="sum-box"><div class="sb-lbl">Responsable</div><div class="sb-val">${respLabel}</div></div>
        <div class="sum-box"><div class="sb-lbl">Trabajadores</div><div class="sb-val">${S.workers.length}</div></div>
      </div>
      <table><thead><tr><th>Trabajador</th><th>Cédula</th>${extraCols.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>
        <tbody>${S.workers.map(w => `<tr>
          <td><b>${w.name}</b></td><td class="ced">${w.ced}</td>
          ${extraCols.map(c => `<td>${reportDef.summaryCell(w, c.key)}</td>`).join('')}
        </tr>`).join('')}</tbody></table>
      <div id="sumError" class="sum-error"></div>
      <div class="wiz-foot">
        <button class="btn" id="sumBack">← Atrás</button>
        <button class="btn btn-primary" id="sumSend">✓ Enviar reporte</button>
      </div>`;
    $('#sumBack').addEventListener('click', () => setStep(4));
    $('#sumSend').addEventListener('click', doSend);

    // "Ver detalle" de cada fila: el modulo del reporte pinta el boton con
    // data-detail-ced (no onclick inline, que la CSP bloquea) y expone una
    // funcion global para abrir la ficha. Aqui enganchamos por DELEGACION un
    // unico listener en la tabla del resumen. Cada reporte registra su propia
    // funcion (window.__nv2VerModif / __nv2VerIngreso); probamos las que haya.
    // Se engancha UNA sola vez por nodo #wzPanel (paintStep reescribe su
    // innerHTML pero conserva el nodo, asi que sin la bandera se duplicaria
    // al volver Atras y reentrar al Resumen).
    if (panel && !panel.__detailBound) {
      panel.__detailBound = true;
      panel.addEventListener('click', e => {
        const btn = e.target.closest('[data-detail-ced]');
        if (!btn) return;
        const ced = btn.getAttribute('data-detail-ced');
        const fn = window['__nv2Ver_' + reportDef.code]
          || window.__nv2VerModif || window.__nv2VerIngreso;
        if (typeof fn === 'function') fn(ced);
      });
    }
  }

  async function doSend() {
    const btn = $('#sumSend'); btn.disabled = true; btn.textContent = 'Enviando…';
    $('#sumError').textContent = '';
    const resp = S.responsables.find(r => r.id === S.selResp);
    // Origen y responsable segun rol. Si la tienda no tiene gerente y eligio
    // "Sin gerente asignado", se envia ese texto como responsable (queda
    // registrado en reports_log) con cargo vacio.
    let responsible, position;
    if (isAdmin) {
      responsible = user.name || user.username; position = 'Administrador';
    } else if (S.selResp === NO_MANAGER) {
      responsible = 'Sin gerente asignado'; position = '';
    } else {
      responsible = resp ? resp.full_name : ''; position = resp ? resp.role : '';
    }
    const res = await reportDef.submit({
      companyCode,
      responsible,
      position,
      workers: S.workers,
      source_kind: isAdmin ? 'admin' : 'company',
      source_admin_id: isAdmin ? (user.id || null) : null,
    });
    if (!res.ok) {
      btn.disabled = false; btn.textContent = '✓ Enviar reporte';
      const det = res.details && res.details.length ? '<ul>' + res.details.map(d => `<li>${d}</li>`).join('') + '</ul>' : '';
      $('#sumError').innerHTML = `<div class="vrow err">✗ ${res.error || 'No se pudo enviar.'}</div>${det}`;
      return;
    }
    S.lastReportId = res.report_id;
    S.lastResult = res; // guarda la respuesta completa (incluye osticket:{...})
    setStep(6);
  }

  /* ---------- PASO 6: listo ---------- */
  function stepDone() {
    const panel = $('#wzPanel');
    const rep = S.lastReportId ? ` (<b>Reporte #${S.lastReportId}</b>)` : '';
    const ost = (S.lastResult && S.lastResult.osticket) || null;

    // Tres escenarios:
    //  a) osTicket OK: hay PLA y ningun ticket fallo -> confirmacion plena.
    //  b) osTicket parcial: hay PLA pero algun DOC fallo -> aviso suave.
    //  c) osTicket no salio (sin pla): el reporte SI quedo en BD, pero no
    //     llego a Capital Humano por osTicket -> avisar para reintentar.
    let banner, detail;
    if (!ost) {
      // Reporte sin fase osTicket (p.ej. marcaje aun no conectado): cierre clasico.
      banner = '<div class="ok-banner">✓ Reporte enviado correctamente</div>';
      detail = `Tu reporte quedó registrado${rep} y será atendido por Capital Humano.`;
    } else if (ost.pla && ost.tickets_fail === 0) {
      banner = '<div class="ok-banner">✓ Reporte enviado a Capital Humano</div>';
      // tickets_ok = 1 PLA + N DOC. nDocs = los DOC (uno por persona con documento).
      const nDocs = Math.max(0, (ost.tickets_ok || 1) - 1);
      if (nDocs > 0) {
        const total = nDocs + 1;
        detail = `Tu reporte quedó registrado${rep} y llegó a Capital Humano. Se crearon <b>${total} tickets</b>: 1 PLA (resumen) #${ost.pla} + ${nDocs} DOC (documentos).`;
      } else {
        detail = `Tu reporte quedó registrado${rep} y llegó a Capital Humano como ticket PLA <b>#${ost.pla}</b>.`;
      }
    } else if (ost.pla && ost.tickets_fail > 0) {
      const n = ost.tickets_fail;
      const plural = n === 1 ? 'documento' : 'documentos';
      banner = '<div class="ok-banner warn">⚠ Reporte enviado, con observaciones</div>';
      detail = `Tu reporte quedó registrado${rep} y se creó el PLA <b>#${ost.pla}</b>, pero ${n} DOC no se ${n === 1 ? 'pudo' : 'pudieron'} enviar. Capital Humano ya tiene el reporte; es posible que debas reenviar ${n === 1 ? 'ese ' + plural : 'esos ' + plural}.`;
    } else {
      banner = '<div class="ok-banner warn">⚠ Reporte guardado, pendiente de enviar</div>';
      detail = `Tu reporte quedó registrado${rep}, pero no se pudo crear el ticket en Capital Humano en este momento. El reporte está a salvo; intenta reenviarlo o avisa a Sistemas.`;
    }

    // Detalle tecnico de errores (plegado), util para soporte. Solo si hubo fallos.
    const errs = (ost && ost.errors && ost.errors.length) ? ost.errors : [];
    const errBlock = errs.length
      ? `<details class="done-errors"><summary>Ver detalle técnico (${errs.length})</summary>
           <ul>${errs.map(e => `<li>${String(e).replace(/</g, '&lt;')}</li>`).join('')}</ul></details>`
      : '';

    panel.innerHTML = `
      ${banner}
      <p class="hint" style="text-align:center">${detail}</p>
      ${errBlock}
      <div class="wiz-foot" style="justify-content:center">
        <button class="btn btn-primary" id="doneNew">Nuevo reporte</button>
      </div>`;
    $('#doneNew').addEventListener('click', () => {
      // reset
      S.step = 1; S.workers = []; S.nextId = 1; S.selResp = null;
      S.lastResult = null;
      paintStep();
    });
  }

  // arranque
  render();
}
