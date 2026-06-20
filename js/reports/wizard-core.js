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

import { $, mount } from '../core/dom.js';
import * as DW from './shared/date-window.js';
import * as Roster from './shared/roster.js';
import * as Resp from './shared/responsables.js';
import * as Pick from './shared/workers-picker.js';

const { fmtDate } = DW;

export function launchWizard(user, reportDef, onExit) {
  const companyCode = user.kind === 'company' ? user.companyCode : (user.pickedCompany || null);

  // ---- estado ----
  const S = {
    step: 1,
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
  function render() {
    const steps = [
      [1, 'Lista de la tienda'],
      [2, 'Responsable'],
      [3, 'Trabajadores'],
      [4, reportDef.step4Label || 'Detalle'],
      [5, 'Resumen'],
    ];
    mount(`
      <div class="wiz">
        <div class="wiz-top">
          <button class="btn btn-ghost wiz-exit" id="wzExit">← Volver a reportes</button>
          <span class="tag">${reportDef.icon || ''} ${reportDef.tag || 'Wizard'}</span>
        </div>
        <h1 class="wiz-h1">${reportDef.title}</h1>
        <p class="wiz-sub">${companyLabel()}</p>
        <div class="now-clock" id="wzClock">🕓 —</div>

        <div class="steps" id="wzSteps">
          ${steps.map(([n, label]) => `
            <div class="step" data-s="${n}">
              <span class="dot">${n}</span><span class="slabel">${label}</span>
              ${n < 5 ? '<span class="bar"></span>' : ''}
            </div>`).join('')}
        </div>

        <div class="card" id="wzPanel"></div>
      </div>
    `);
    $('#wzExit').addEventListener('click', () => {
      if (S.stopClock) S.stopClock();
      onExit && onExit();
    });
    if (S.stopClock) S.stopClock();
    S.stopClock = DW.startClock('wzClock');
    paintStep();
  }

  function companyLabel() {
    if (!companyCode) return 'Selecciona una tienda';
    const c = (S.companyName ? `${companyCode} · ${S.companyName}` : companyCode);
    return `Tienda ${c}`;
  }

  function setStep(n) { S.step = n; paintStep(); }

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
    const r = await Roster.rosterGet(companyCode);
    if (r.ok) { S.roster = r.workers || []; S.meta = r.meta || null; }
    return r;
  }

  function stepRoster() {
    const panel = $('#wzPanel');
    panel.innerHTML = `<h2>Lista de trabajadores de la tienda</h2>
      <p class="hint">El reporte parte de la lista de personal (Reporte 10 del POS). De aquí salen los trabajadores y los responsables (Gerente / Sub-Gerente).</p>
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
      : 'Esta tienda aún no tiene lista cargada. Sube el Reporte 10 para empezar.';

    panel.innerHTML = `
      <h2>Lista de trabajadores de la tienda</h2>
      <p class="hint">El reporte parte de la lista de personal (Reporte 10 del POS). De aquí salen los trabajadores y los responsables (Gerente / Sub-Gerente).</p>

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
            <th>Cargo</th><th>Estado</th>
          </tr></thead><tbody id="rBody"></tbody>
        </table></div>
      </div>

      <div data-tp="upload" style="display:none">
        <div class="dropzone" id="rDrop">📄 Haz clic para seleccionar el <b>Reporte 10</b> (.xlsx)<br>
          <span style="font-size:12px">El archivo se procesa en tu navegador</span></div>
        <input type="file" id="rFile" accept=".xlsx,.xls" hidden>
        <div id="rUpResult"></div>
      </div>

      <div class="wiz-foot"><span></span>
        <button class="btn btn-primary" id="rNext" ${S.roster.length ? '' : 'disabled'}>Siguiente →</button>
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
    // next
    $('#rNext').addEventListener('click', () => setStep(2));

    paintRosterTable();
  }

  function paintRosterTable() {
    const q = ($('#rSearch') && $('#rSearch').value) || '';
    let list = Pick.filterRoster(S.roster, q);
    list = Pick.sortRoster(list, S.rosterSort.key, S.rosterSort.dir);
    const vig = S.roster.filter(r => !r.end_date).length;
    if ($('#rInfo')) $('#rInfo').textContent = `${S.roster.length} en total · ${vig} vigentes`;
    $('#rBody').innerHTML = list.map(r => `
      <tr class="${r.end_date ? 'egresado' : ''}">
        <td class="pname">${r.full_name}</td>
        <td class="ced">${r.id_number}</td>
        <td><span class="pill pill-role">${r.role || 'sin cargo'}</span></td>
        <td>${Roster.workerStatusLabel(r)}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="empty">Sin coincidencias.</td></tr>';
  }

  async function onPickFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const box = $('#rUpResult');
    box.innerHTML = '<div class="validation">Procesando archivo…</div>';
    try {
      const parsed = await Roster.parseReport10(file);
      const v = Roster.validateParsed(parsed);
      box.innerHTML = `
        <div class="validation">
          ${parsed.missing.length
            ? `<div class="vrow err">✗ Faltan columnas esenciales: ${parsed.missing.join(', ')}</div>`
            : `<div class="vrow ok">✓ Columnas esenciales: ${parsed.columnsFound.join(', ')}</div>`}
          <div class="vrow ok">✓ ${v.total} trabajadores leídos (${v.active} vigentes · ${v.terminated} egresados)</div>
          <div class="vrow ok">✓ Responsables detectados: ${v.gerentes} Gerente(s), ${v.subgerentes} Sub-Gerente(s)</div>
          ${v.warnings.map(w => `<div class="vrow warn">⚠ ${w}</div>`).join('')}
          ${v.okToUpload ? `<div style="margin-top:12px"><button class="btn btn-primary btn-sm" id="rConfirm">Reemplazar lista de la tienda</button></div>`
                         : `<div class="vrow err" style="margin-top:8px">No se puede cargar: revisa el archivo.</div>`}
        </div>`;
      if (v.okToUpload) {
        $('#rConfirm').addEventListener('click', async () => {
          $('#rConfirm').disabled = true; $('#rConfirm').textContent = 'Subiendo…';
          const up = await Roster.rosterReplace(companyCode, v.validRows, {
            uploadedBy: user.kind === 'company' ? user.companyCode : (user.name || user.username),
            sourceFile: parsed.fileName,
          });
          if (!up.ok) { alert(up.error || 'Error al subir.'); $('#rConfirm').disabled = false; $('#rConfirm').textContent = 'Reemplazar lista de la tienda'; return; }
          await loadRoster();
          await loadResponsables();
          renderRosterStep();
        });
      }
    } catch (err) {
      box.innerHTML = `<div class="validation"><div class="vrow err">✗ ${err.message || err}</div></div>`;
    } finally {
      e.target.value = '';
    }
  }

  /* ---------- PASO 2: responsable ---------- */
  async function loadResponsables() {
    const r = await Resp.contactsList(companyCode);
    if (r.ok) S.responsables = r.contacts || [];
    return r;
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
    $('#respNext').addEventListener('click', () => setStep(3));
  }

  function respCards() {
    if (!S.responsables.length) return '<div class="empty">No hay responsables. Agrega al menos uno con “Gestionar responsables”.</div>';
    return S.responsables.map(r => `
      <div class="resp-card ${S.selResp === r.id ? 'sel' : ''}" data-id="${r.id}">
        <span class="resp-radio"></span>
        <div class="resp-info"><div class="resp-name">${r.full_name}</div><div class="resp-role">${r.role}</div></div>
      </div>`).join('');
  }
  function bindRespCards() {
    $('#respList').querySelectorAll('.resp-card').forEach(c => c.addEventListener('click', () => {
      S.selResp = parseInt(c.dataset.id, 10);
      $('#respList').innerHTML = respCards(); bindRespCards();
      $('#respNext').disabled = false;
    }));
  }

  function openRespManage() {
    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    ov.innerHTML = `
      <div class="modal">
        <h3>Gestionar responsables</h3>
        <p class="who">Tienda ${companyCode} · máximo ${Resp.RESP_MAX}. También accesible por el administrador.</p>
        <div id="rmList"></div>
        <div style="border-top:1px solid var(--border-soft);margin-top:12px;padding-top:14px">
          <div class="grid2" style="margin-bottom:10px">
            <div><label class="flabel">Nombre</label><input id="rmName" placeholder="Nombre y apellido"></div>
            <div><label class="flabel">Cargo</label><input id="rmRole" placeholder="ej. Gerente"></div>
          </div>
          <button class="btn btn-sm btn-primary" id="rmAdd">＋ Agregar responsable</button>
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
            <button class="x-btn" data-del="${r.id}">✕</button></div>`).join('')
        : '<div class="empty" style="padding:14px">Sin responsables.</div>';
      const full = S.responsables.length >= Resp.RESP_MAX;
      ov.querySelector('#rmAdd').disabled = full;
      ov.querySelector('#rmLimit').textContent = full ? `Máximo ${Resp.RESP_MAX} alcanzado` : '';
      ov.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
        await Resp.contactsRemove(parseInt(b.dataset.del, 10));
        if (S.selResp === parseInt(b.dataset.del, 10)) S.selResp = null;
        await loadResponsables(); paint();
      }));
    };
    paint();

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
  function stepWorkers() {
    const panel = $('#wzPanel');
    panel.innerHTML = `
      <h2>Trabajadores afectados</h2>
      <p class="hint">Marca a varios y agrégalos en bloque, o usa “Agregar” individual. También puedes ordenar y buscar. Para quien no esté en la lista, usa “Agregar manual”.</p>

      <div class="subtabs" id="wTabs">
        <div class="subtab on" data-tab2="roster">De mi tienda</div>
        <div class="subtab" data-tab2="manual">Agregar manual</div>
      </div>

      <div data-tp2="roster">
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

      <div data-tp2="manual" style="display:none">
        <div class="add-row">
          <div><label class="flabel">Cédula</label><input id="mCed" placeholder="V-12345678">
            <div class="ced-hint" id="mCedHint"></div></div>
          <div><label class="flabel">Nombre y apellido</label><input id="mName" placeholder="Nombre del trabajador"></div>
          <button class="btn btn-primary" id="mAdd" style="margin-bottom:21px">＋ Agregar</button>
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
    $('#wBack').addEventListener('click', () => setStep(2));
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
        <td><span class="pill pill-role">${r.role || 'sin cargo'}</span></td>
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
    S.workers = S.workers.filter(w => w.id !== id);
    paintWorkers(); paintPick();
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
      getWorker: (id) => S.workers.find(w => w.id === id),
      removeWorker, rerenderStep4: stepDetail,
      setStep, fmt: { fmtDate }, DW,
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
    const extraCols = reportDef.summaryColumns || [];
    panel.innerHTML = `
      <h2>Resumen del reporte</h2>
      <p class="hint">Verifica antes de enviar. Se generará un ticket en el sistema de Capital Humano.</p>
      <div class="grid3">
        <div class="sum-box"><div class="sb-lbl">Tienda</div><div class="sb-val">${companyLabel().replace('Tienda ', '')}</div></div>
        <div class="sum-box"><div class="sb-lbl">Responsable</div><div class="sb-val">${resp ? `${resp.full_name} · ${resp.role}` : '—'}</div></div>
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
  }

  async function doSend() {
    const btn = $('#sumSend'); btn.disabled = true; btn.textContent = 'Enviando…';
    $('#sumError').textContent = '';
    const resp = S.responsables.find(r => r.id === S.selResp);
    const res = await reportDef.submit({
      companyCode,
      responsible: resp ? resp.full_name : '',
      position: resp ? resp.role : '',
      workers: S.workers,
    });
    if (!res.ok) {
      btn.disabled = false; btn.textContent = '✓ Enviar reporte';
      const det = res.details && res.details.length ? '<ul>' + res.details.map(d => `<li>${d}</li>`).join('') + '</ul>' : '';
      $('#sumError').innerHTML = `<div class="vrow err">✗ ${res.error || 'No se pudo enviar.'}</div>${det}`;
      return;
    }
    S.lastReportId = res.report_id;
    setStep(6);
  }

  /* ---------- PASO 6: listo ---------- */
  function stepDone() {
    const panel = $('#wzPanel');
    panel.innerHTML = `
      <div class="ok-banner">✓ Reporte enviado correctamente</div>
      <p class="hint" style="text-align:center">Tu reporte quedó registrado${S.lastReportId ? ` (folio #${S.lastReportId})` : ''} y será atendido por Capital Humano.</p>
      <div class="wiz-foot" style="justify-content:center">
        <button class="btn btn-primary" id="doneNew">Nuevo reporte</button>
      </div>`;
    $('#doneNew').addEventListener('click', () => {
      // reset
      S.step = 1; S.workers = []; S.nextId = 1; S.selResp = null;
      paintStep();
    });
  }

  // arranque
  render();
}
