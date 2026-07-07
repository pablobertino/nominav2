/* =====================================================================
   js/views/reset-data.js  →  vista "Reiniciar datos" (grupo Administracion,
   SOLO superadmin). Mockup aprobado: _PRUEBAS\reset_mockup.html (v0-mock1).

   Borra definitivamente lo transaccional del periodo de prueba: Reportes,
   Avisos (manuales), Sincronizaciones y Constancias (tablas + PDFs). No
   toca personal, empresas, usuarios, catalogos ni configuracion.

   Flujo de triple seguridad:
     1. Modal de resumen con los conteos reales.
     2. Modal de confirmacion: escribir REINICIAR habilita el boton.
     3. Modal de progreso: una llamada por categoria; resultado + registro.
   Todo con modales propios que cierran SOLO con sus botones.

   Datos por /api/reset-transactional (counts / run).
   Export: renderResetData(user)
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);

let USER = null;
let COUNTS = null;   // respuesta de 'counts'

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtN(n) { return Number(n || 0).toLocaleString('es-VE'); }

async function api(payload) {
  return fetch('/api/reset-transactional', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: { kind: USER.kind, id: USER.id }, ...payload }),
  }).then(x => x.json()).catch(e => ({ ok: false, error: String(e && e.message || e) }));
}

function ensureStyles() {
  if (document.getElementById('rstStyles')) return;
  const st = document.createElement('style');
  st.id = 'rstStyles';
  st.textContent = `
  .rst-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .rst-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .rst-danger{display:flex;gap:10px;align-items:flex-start;margin:18px 0;padding:13px 15px;border:1px solid var(--danger-bd,#fecaca);background:var(--danger-bg,#fef2f2);border-radius:11px;font-size:12.5px;color:#991b1b;line-height:1.5}
  .rst-danger b{color:#7f1d1d}
  .rst-cards{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px}
  @media(max-width:680px){.rst-cards{grid-template-columns:1fr}}
  .rst-card{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:16px 18px}
  .rst-card h3{margin:0;font-size:14.5px;display:flex;align-items:center;gap:9px;color:var(--ink)}
  .rst-card .n{margin-left:auto;font-size:12px;font-weight:700;background:var(--danger-bg,#fef2f2);color:var(--danger,#dc2626);border:1px solid var(--danger-bd,#fecaca);border-radius:999px;padding:2px 10px;white-space:nowrap}
  .rst-card ul{margin:10px 0 0;padding:0 0 0 2px;list-style:none;font-size:12px;color:var(--ink-soft,#334155);line-height:1.7}
  .rst-card ul li::before{content:"\\2013  ";color:var(--faint,#94a3b8)}
  .rst-ic{width:30px;height:30px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-size:15px;flex:none}
  .rst-ic-rep{background:#dbeafe}.rst-ic-avi{background:#fef3c7}.rst-ic-sin{background:#f3e8ff}.rst-ic-con{background:#dcfce7}
  .rst-keeps{background:var(--surface);border:1px dashed var(--border);border-radius:13px;padding:14px 18px;margin-top:14px;font-size:12.5px;color:var(--muted);line-height:1.6}
  .rst-keeps b{color:var(--ink)}
  .rst-footer{display:flex;align-items:center;gap:12px;margin-top:20px;flex-wrap:wrap}
  .rst-btn{font:inherit;font-size:13.5px;font-weight:600;padding:10px 16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--ink);cursor:pointer}
  .rst-btn-danger{background:var(--danger,#dc2626);border-color:var(--danger,#dc2626);color:#fff}
  .rst-btn-danger:hover:not(:disabled){background:#b91c1c}
  .rst-btn:disabled{opacity:.5;cursor:default}
  .rst-note{font-size:11.5px;color:var(--faint,#94a3b8)}
  .rst-loading{padding:40px;text-align:center;color:var(--muted)}
  /* modales (cierran SOLO con sus botones) */
  .rst-ov{position:fixed;inset:0;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:18px}
  .rst-modal{background:var(--surface);border-radius:15px;max-width:520px;width:100%;padding:22px 24px;box-shadow:0 22px 60px rgba(15,23,42,.32);max-height:88vh;overflow:auto}
  .rst-modal h3{margin:0 0 6px;font-size:17px;color:var(--ink)}
  .rst-modal p{margin:0 0 10px;color:var(--muted);font-size:13px;line-height:1.55}
  .rst-box{border-radius:10px;padding:11px 13px;font-size:12.5px;line-height:1.55;margin:10px 0}
  .rst-box-danger{background:var(--danger-bg,#fef2f2);border:1px solid var(--danger-bd,#fecaca);color:#991b1b}
  .rst-box-ok{background:var(--success-bg,#f0fdf4);border:1px solid #bbf7d0;color:#166534}
  .rst-box-err{background:var(--danger-bg,#fef2f2);border:1px solid var(--danger-bd,#fecaca);color:#b91c1c}
  .rst-sum .r{display:flex;justify-content:space-between;gap:12px;padding:6px 2px;border-bottom:1px solid var(--border-soft,#eef1f5);font-size:12.5px}
  .rst-sum .r b{color:var(--danger,#dc2626);white-space:nowrap}
  .rst-word{width:100%;font:inherit;font-size:14px;letter-spacing:.08em;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;margin-top:6px;text-transform:uppercase;box-sizing:border-box;background:var(--surface);color:var(--ink)}
  .rst-word:focus{outline:none;border-color:var(--danger,#dc2626)}
  .rst-mfoot{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
  .rst-prog{height:8px;border-radius:999px;background:var(--border-soft,#eef1f5);overflow:hidden;margin:14px 0 6px}
  .rst-prog>div{height:100%;width:0;background:var(--danger,#dc2626);transition:width .3s}
  .rst-prog-lbl{font-size:12px;color:var(--muted);text-align:center}
  `;
  document.head.appendChild(st);
}

/* Numeros derivados para tarjetas y resumen. */
function derived() {
  const c = COUNTS || {};
  const rep = c.reportes || {}, av = c.avisos || {}, si = c.sincronizaciones || {}, co = c.constancias || {};
  const repLineas = (rep.lineas || 0) + (rep.docs || 0);
  const avMarcas = av.marcas || 0;
  const siTotal = (si.ax_change_set || 0) + (si.roster_run || 0) + (si.roster_change || 0) + (si.sync_runs || 0);
  const coTablas = (co.cert_requests || 0) + (co.cert_request_lines || 0) + (co.cert_line_audit || 0) + (co.cert_bell_seen || 0);
  return {
    repN: rep.reports_log || 0, repLineas,
    avN: av.announcements || 0, avMarcas,
    siTotal,
    coSolic: co.cert_requests || 0, coTablas, coPdfs: co.pdfs || 0,
    totalFilas: (rep.reports_log || 0) + repLineas + (av.announcements || 0) + avMarcas + siTotal + coTablas,
  };
}

export async function renderResetData(user) {
  USER = user;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="rst-head"><div><h1>Reiniciar datos de prueba</h1>
      <p>Borra definitivamente lo generado durante el per\u00edodo de prueba para comenzar de cero. Solo superadministrador.</p></div></div>
    <div class="rst-loading">Cargando conteos\u2026</div>`;

  const r = await api({ action: 'counts' });
  if (!r || !r.ok) {
    $('#pnlMain').innerHTML += `<div class="rst-box rst-box-err">No se pudieron cargar los conteos${r && r.error ? ': ' + esc(r.error) : ''}.</div>`;
    return;
  }
  COUNTS = r.counts || {};
  paint();
}

function paint() {
  const d = derived();
  $('#pnlMain').innerHTML = `
    <div class="rst-head"><div><h1>Reiniciar datos de prueba</h1>
      <p>Borra definitivamente lo generado durante el per\u00edodo de prueba para comenzar de cero. Solo superadministrador.</p></div></div>

    <div class="rst-danger"><span style="font-size:16px">\u26A0\uFE0F</span>
      <div><b>Esta acci\u00f3n es permanente e irreversible.</b> Los datos se eliminan f\u00edsicamente de la base de datos y del almacenamiento; no hay papelera ni deshacer. El personal, las empresas, los usuarios y toda la configuraci\u00f3n <b>no se tocan</b>.</div>
    </div>

    <div class="rst-cards">
      <div class="rst-card">
        <h3><span class="rst-ic rst-ic-rep">\u{1F4CB}</span> Reportes <span class="n">${fmtN(d.repN)} reportes \u00b7 ${fmtN(d.repLineas)} l\u00edneas</span></h3>
        <ul>
          <li>Reportes enviados (los 5 tipos) y su detalle</li>
          <li>Checklists de documentos (ausencias e ingresos)</li>
          <li>Estados de atenci\u00f3n y v\u00ednculo con osTicket</li>
        </ul>
      </div>
      <div class="rst-card">
        <h3><span class="rst-ic rst-ic-avi">\u{1F514}</span> Avisos <span class="n">${fmtN(d.avN)} comunicados \u00b7 ${fmtN(d.avMarcas)} marcas</span></h3>
        <ul>
          <li>Comunicados manuales creados</li>
          <li>Marcas de visto y estado de la campanita</li>
          <li>NO se tocan: plantillas del per\u00edodo ni novedades de empresas</li>
        </ul>
      </div>
      <div class="rst-card">
        <h3><span class="rst-ic rst-ic-sin">\u{1F504}</span> Sincronizaciones <span class="n">${fmtN(d.siTotal)} registros</span></h3>
        <ul>
          <li>Bit\u00e1cora de cambios de fichas (publicados/anulados)</li>
          <li>Corridas y cambios de Carga de personal</li>
          <li>Corridas de sincronizaci\u00f3n de empresas</li>
          <li>NO se toca: estado de pago (cach\u00e9 y su cron)</li>
        </ul>
      </div>
      <div class="rst-card">
        <h3><span class="rst-ic rst-ic-con">\u{1F4C4}</span> Constancias <span class="n">${fmtN(d.coSolic)} solicitudes \u00b7 ${fmtN(d.coPdfs)} PDF</span></h3>
        <ul>
          <li>Solicitudes, l\u00edneas y su auditor\u00eda</li>
          <li>PDFs generados (almacenamiento)</li>
          <li>NO se tocan: firmantes ni sus firmas</li>
        </ul>
      </div>
    </div>

    <div class="rst-keeps">
      <b>Se conserva todo lo dem\u00e1s:</b> personal y fotos, empresas y estructura, usuarios y permisos,
      cat\u00e1logos y configuraci\u00f3n, per\u00edodos de n\u00f3mina, estado de pago, documentos de la pantalla Documentos,
      firmantes de constancias y el historial de versiones del portal.
    </div>

    <div class="rst-footer">
      <button class="rst-btn rst-btn-danger" id="rstGo" ${d.totalFilas + d.coPdfs === 0 ? 'disabled' : ''}>\u{1F5D1}\uFE0F Reiniciar datos de prueba\u2026</button>
      <span class="rst-note">${d.totalFilas + d.coPdfs === 0 ? 'No hay datos transaccionales que borrar.' : 'Quedar\u00e1 registro de qui\u00e9n y cu\u00e1ndo ejecut\u00f3 el reinicio.'}</span>
    </div>`;

  const go = $('#rstGo');
  if (go) go.addEventListener('click', openSummary);
}

/* ---------- Modal 1: resumen ---------- */
function openSummary() {
  const d = derived();
  const wrap = document.createElement('div');
  wrap.className = 'rst-ov';
  wrap.innerHTML = `
    <div class="rst-modal">
      <h3>Reiniciar datos de prueba</h3>
      <p>Se eliminar\u00e1 <b>definitivamente</b> lo siguiente:</p>
      <div class="rst-sum">
        <div class="r"><span>Reportes (todos los tipos, con l\u00edneas y checklists)</span><b>${fmtN(d.repN)} + ${fmtN(d.repLineas)}</b></div>
        <div class="r"><span>Avisos manuales y marcas de visto</span><b>${fmtN(d.avN + d.avMarcas)}</b></div>
        <div class="r"><span>Bit\u00e1coras de sincronizaci\u00f3n (fichas, personal, empresas)</span><b>${fmtN(d.siTotal)}</b></div>
        <div class="r"><span>Constancias (solicitudes, auditor\u00eda y PDFs)</span><b>${fmtN(d.coTablas)} + ${fmtN(d.coPdfs)} PDF</b></div>
      </div>
      <div class="rst-box rst-box-danger">No se puede deshacer. El personal, empresas, usuarios, cat\u00e1logos y configuraci\u00f3n quedan intactos.</div>
      <div class="rst-mfoot">
        <button class="rst-btn" id="rstCxl1">Cancelar</button>
        <button class="rst-btn rst-btn-danger" id="rstNext">Continuar</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('#rstCxl1').addEventListener('click', close);
  wrap.querySelector('#rstNext').addEventListener('click', () => { close(); openConfirm(); });
}

/* ---------- Modal 2: confirmacion fuerte ---------- */
function openConfirm() {
  const wrap = document.createElement('div');
  wrap.className = 'rst-ov';
  wrap.innerHTML = `
    <div class="rst-modal">
      <h3>Confirmaci\u00f3n final</h3>
      <p>Para ejecutar el reinicio, escribe <b style="color:var(--danger,#dc2626)">REINICIAR</b> en el campo:</p>
      <input class="rst-word" id="rstWord" placeholder="Escribe la palabra\u2026" autocomplete="off">
      <div class="rst-mfoot">
        <button class="rst-btn" id="rstCxl2">Cancelar</button>
        <button class="rst-btn rst-btn-danger" id="rstFire" disabled>Reiniciar ahora</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const w = wrap.querySelector('#rstWord');
  const fire = wrap.querySelector('#rstFire');
  w.addEventListener('input', () => { fire.disabled = w.value.trim().toUpperCase() !== 'REINICIAR'; });
  wrap.querySelector('#rstCxl2').addEventListener('click', close);
  fire.addEventListener('click', () => { close(); runReset(); });
  w.focus();
}

/* ---------- Modal 3: progreso + resultado ---------- */
const STEPS = [
  { key: 'reportes',          label: 'Reportes\u2026' },
  { key: 'avisos',            label: 'Avisos\u2026' },
  { key: 'sincronizaciones',  label: 'Sincronizaciones\u2026' },
  { key: 'constancias',       label: 'Constancias (tablas)\u2026' },
  { key: 'constancias_pdfs',  label: 'Constancias (PDFs)\u2026' },
];

async function runReset() {
  const wrap = document.createElement('div');
  wrap.className = 'rst-ov';
  wrap.innerHTML = `
    <div class="rst-modal">
      <h3 id="rstPTitle">Reiniciando\u2026</h3>
      <div class="rst-prog"><div id="rstPBar"></div></div>
      <div class="rst-prog-lbl" id="rstPLbl">Preparando\u2026</div>
      <div class="rst-box rst-box-ok" id="rstPDone" style="display:none"></div>
      <div class="rst-box rst-box-err" id="rstPErr" style="display:none"></div>
      <div class="rst-mfoot"><button class="rst-btn" id="rstPClose" style="display:none">Cerrar</button></div>
    </div>`;
  document.body.appendChild(wrap);
  const bar = wrap.querySelector('#rstPBar');
  const lbl = wrap.querySelector('#rstPLbl');
  const errB = wrap.querySelector('#rstPErr');
  const doneB = wrap.querySelector('#rstPDone');
  const closeB = wrap.querySelector('#rstPClose');
  // Se cierra SOLO con su boton (aparece al terminar); Escape no aplica aqui
  // porque el proceso no debe quedar a medias sin ver el resultado.

  let filas = 0, archivos = 0, quien = '', cuando = '';
  const errores = [];

  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i];
    lbl.textContent = 'Eliminando ' + s.label;
    const r = await api({ action: 'run', category: s.key, confirm: 'REINICIAR' });
    if (!r || !r.ok) {
      errores.push(`${s.label} ${((r && r.error) || 'fallo').slice(0, 160)}`);
    } else {
      const det = r.detail || {};
      if (s.key === 'constancias_pdfs') archivos += (det.archivos || 0);
      else filas += Object.values(det).reduce((a, n) => a + (Number(n) || 0), 0);
      quien = r.executed_by || quien;
      cuando = r.executed_at || cuando;
    }
    bar.style.width = Math.round(((i + 1) / STEPS.length) * 100) + '%';
  }

  lbl.style.display = 'none';
  const fecha = cuando
    ? new Date(cuando).toLocaleString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  if (errores.length) {
    wrap.querySelector('#rstPTitle').textContent = 'Reinicio con errores';
    errB.style.display = 'block';
    errB.innerHTML = `\u26A0 ${fmtN(filas)} registros y ${fmtN(archivos)} archivos s\u00ed se eliminaron, pero fall\u00f3:<br>${errores.map(esc).join('<br>')}<br>Puedes volver a ejecutar el reinicio: lo ya borrado no reaparece.`;
  } else {
    wrap.querySelector('#rstPTitle').textContent = 'Reinicio completado';
    doneB.style.display = 'block';
    doneB.innerHTML = `\u2713 <b>${fmtN(filas)}</b> registros y <b>${fmtN(archivos)}</b> archivos eliminados.`
      + (quien ? `<br>Registrado: <b>${esc(quien)}</b>${fecha ? ' \u00b7 ' + esc(fecha) : ''}` : '');
  }
  closeB.style.display = 'inline-block';
  closeB.addEventListener('click', () => { wrap.remove(); renderResetData(USER); });
}
