/* =====================================================================
   js/views/reset-data.js  →  vista "Reiniciar datos" (grupo Administracion,
   SOLO superadmin). v2 (v4.17), mockup aprobado: reset_mockup.html v0-mock2.

   DOS MODOS:
     - SELECTIVO (por empresas): tildar empresas; borra SOLO Reportes y
       Constancias (con sus PDFs) de esas empresas. Numeracion intacta.
       Palabra: REINICIAR.
     - TOTAL (hard reset): todo lo transaccional + numeracion a cero (el
       proximo reporte sera el N 1, la proxima solicitud la 1).
       Palabra: REINICIAR TODO.

   Flujo de triple seguridad (por modo): resumen -> palabra -> progreso.
   Modales propios que cierran SOLO con sus botones.

   Datos por /api/reset-transactional (counts / companies / run).
   Export: renderResetData(user)
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);

let USER = null;
let COUNTS = null;     // conteos globales (modo total)
let STATS = [];        // por empresa: {company_code, business_name, reportes, rep_lineas, solicitudes, cons_filas, pdfs}
let MODE = 'sel';      // 'sel' | 'all'
const SEL = new Set(); // company_codes marcados
let FQ = '';           // filtro de busqueda del picker

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
  if (document.getElementById('rstStyles2')) return;
  const old = document.getElementById('rstStyles'); if (old) old.remove();
  const st = document.createElement('style');
  st.id = 'rstStyles2';
  st.textContent = `
  .rst-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .rst-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .rst-danger{display:flex;gap:10px;align-items:flex-start;margin:18px 0;padding:13px 15px;border:1px solid var(--danger-bd,#fecaca);background:var(--danger-bg,#fef2f2);border-radius:11px;font-size:12.5px;color:#991b1b;line-height:1.5}
  .rst-danger b{color:#7f1d1d}
  .rst-modes{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px}
  @media(max-width:680px){.rst-modes{grid-template-columns:1fr}}
  .rst-mode{background:var(--surface);border:2px solid var(--border);border-radius:13px;padding:15px 17px;cursor:pointer;position:relative}
  .rst-mode:hover{border-color:#cbd5e1}
  .rst-mode.on{border-color:var(--danger,#dc2626)}
  .rst-mode .radio{position:absolute;top:14px;right:14px;width:18px;height:18px;border-radius:999px;border:2px solid var(--border);display:flex;align-items:center;justify-content:center}
  .rst-mode.on .radio{border-color:var(--danger,#dc2626)}
  .rst-mode.on .radio::after{content:"";width:9px;height:9px;border-radius:999px;background:var(--danger,#dc2626)}
  .rst-mode h3{margin:0 0 4px;font-size:14.5px;padding-right:26px;color:var(--ink)}
  .rst-mode p{margin:0;font-size:12px;color:var(--muted);line-height:1.55}
  .rst-mode .tagz{margin-top:9px;display:flex;gap:6px;flex-wrap:wrap}
  .rst-tg{font-size:10.5px;font-weight:700;border-radius:999px;padding:2px 9px}
  .rst-tg-in{background:var(--danger-bg,#fef2f2);color:var(--danger,#dc2626);border:1px solid var(--danger-bd,#fecaca)}
  .rst-tg-out{background:var(--bg-soft,#f1f5f9);color:var(--muted);border:1px solid var(--border)}
  .rst-tg-zero{background:#fdf4ff;color:#a21caf;border:1px solid #f5d0fe}
  .rst-picker{background:var(--surface);border:1px solid var(--border);border-radius:13px;margin-top:14px;overflow:hidden}
  .rst-picker .ph{display:flex;gap:10px;align-items:center;padding:12px 15px;border-bottom:1px solid var(--border);flex-wrap:wrap}
  .rst-picker .ph b{font-size:13.5px;color:var(--ink)}
  .rst-picker input[type=text]{flex:1;min-width:180px;font:inherit;font-size:13px;padding:8px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink)}
  .rst-pickn{font-size:12px;font-weight:700;color:var(--danger,#dc2626);background:var(--danger-bg,#fef2f2);border:1px solid var(--danger-bd,#fecaca);border-radius:999px;padding:2px 10px;white-space:nowrap}
  .rst-plist{max-height:250px;overflow:auto}
  .rst-prow{display:flex;align-items:center;gap:11px;padding:9px 15px;border-bottom:1px solid var(--border-soft,#eef1f5);cursor:pointer;font-size:13px;color:var(--ink)}
  .rst-prow:last-child{border-bottom:0}
  .rst-prow:hover{background:var(--bg-soft,#f8fafc)}
  .rst-prow input{width:16px;height:16px;accent-color:var(--danger,#dc2626);flex:none}
  .rst-prow .cc{font-family:ui-monospace,Menlo,monospace;font-weight:700;color:var(--brand,#2563eb);width:46px;flex:none}
  .rst-prow .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rst-prow .meta{font-size:11px;color:var(--faint,#94a3b8);white-space:nowrap}
  .rst-plink{border:0;background:none;font:inherit;font-size:12px;color:var(--brand,#2563eb);cursor:pointer;padding:0}
  .rst-pempty{padding:22px;text-align:center;color:var(--muted);font-size:12.5px}
  .rst-cards{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}
  @media(max-width:680px){.rst-cards{grid-template-columns:1fr}}
  .rst-card{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:16px 18px;transition:opacity .15s}
  .rst-card.off{opacity:.45}
  .rst-card.off .n{background:var(--bg-soft,#f1f5f9);color:var(--muted);border-color:var(--border)}
  .rst-card h3{margin:0;font-size:14.5px;display:flex;align-items:center;gap:9px;color:var(--ink)}
  .rst-card .n{margin-left:auto;font-size:12px;font-weight:700;background:var(--danger-bg,#fef2f2);color:var(--danger,#dc2626);border:1px solid var(--danger-bd,#fecaca);border-radius:999px;padding:2px 10px;white-space:nowrap}
  .rst-card ul{margin:10px 0 0;padding:0 0 0 2px;list-style:none;font-size:12px;color:var(--ink-soft,#334155);line-height:1.7}
  .rst-card ul li::before{content:"\\2013  ";color:var(--faint,#94a3b8)}
  .rst-card .offnote{margin-top:9px;font-size:11px;color:var(--muted);font-style:italic}
  .rst-ic{width:30px;height:30px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-size:15px;flex:none}
  .rst-ic-rep{background:#dbeafe}.rst-ic-avi{background:#fef3c7}.rst-ic-sin{background:#f3e8ff}.rst-ic-con{background:#dcfce7}
  .rst-zero{display:flex;gap:10px;align-items:flex-start;margin-top:14px;padding:12px 15px;border:1px solid #f5d0fe;background:#fdf4ff;border-radius:11px;font-size:12.5px;color:#86198f;line-height:1.5}
  .rst-keeps{background:var(--surface);border:1px dashed var(--border);border-radius:13px;padding:14px 18px;margin-top:14px;font-size:12.5px;color:var(--muted);line-height:1.6}
  .rst-keeps b{color:var(--ink)}
  .rst-footer{display:flex;align-items:center;gap:12px;margin-top:20px;flex-wrap:wrap}
  .rst-btn{font:inherit;font-size:13.5px;font-weight:600;padding:10px 16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--ink);cursor:pointer}
  .rst-btn-danger{background:var(--danger,#dc2626);border-color:var(--danger,#dc2626);color:#fff}
  .rst-btn-danger:hover:not(:disabled){background:#b91c1c}
  .rst-btn:disabled{opacity:.5;cursor:default}
  .rst-note{font-size:11.5px;color:var(--faint,#94a3b8)}
  .rst-loading{padding:40px;text-align:center;color:var(--muted)}
  .rst-ov{position:fixed;inset:0;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:18px}
  .rst-modal{background:var(--surface);border-radius:15px;max-width:520px;width:100%;padding:22px 24px;box-shadow:0 22px 60px rgba(15,23,42,.32);max-height:88vh;overflow:auto}
  .rst-modal h3{margin:0 0 6px;font-size:17px;color:var(--ink)}
  .rst-modal p{margin:0 0 10px;color:var(--muted);font-size:13px;line-height:1.55}
  .rst-box{border-radius:10px;padding:11px 13px;font-size:12.5px;line-height:1.55;margin:10px 0}
  .rst-box-danger{background:var(--danger-bg,#fef2f2);border:1px solid var(--danger-bd,#fecaca);color:#991b1b}
  .rst-box-zero{background:#fdf4ff;border:1px solid #f5d0fe;color:#86198f}
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

/* ---------- numeros derivados ---------- */
function derivedTotal() {
  const c = COUNTS || {};
  const rep = c.reportes || {}, av = c.avisos || {}, si = c.sincronizaciones || {}, co = c.constancias || {};
  const repLineas = (rep.lineas || 0) + (rep.docs || 0);
  const siTotal = (si.ax_change_set || 0) + (si.roster_run || 0) + (si.roster_change || 0) + (si.sync_runs || 0);
  const coTablas = (co.cert_requests || 0) + (co.cert_request_lines || 0) + (co.cert_line_audit || 0) + (co.cert_bell_seen || 0);
  return {
    repN: rep.reports_log || 0, repLineas,
    avN: av.announcements || 0, avMarcas: av.marcas || 0,
    siTotal,
    coSolic: co.cert_requests || 0, coTablas, coPdfs: co.pdfs || 0,
  };
}
function derivedSel() {
  let repN = 0, repLineas = 0, coSolic = 0, coTablas = 0, coPdfs = 0;
  for (const s of STATS) {
    if (!SEL.has(s.company_code)) continue;
    repN += s.reportes || 0; repLineas += s.rep_lineas || 0;
    coSolic += s.solicitudes || 0; coTablas += s.cons_filas || 0; coPdfs += s.pdfs || 0;
  }
  return { repN, repLineas, coSolic, coTablas, coPdfs };
}
function hasWork() {
  if (MODE === 'sel') {
    const d = derivedSel();
    return SEL.size > 0 && (d.repN + d.repLineas + d.coTablas + d.coPdfs) > 0;
  }
  const d = derivedTotal();
  return (d.repN + d.repLineas + d.avN + d.avMarcas + d.siTotal + d.coTablas + d.coPdfs) > 0;
}

export async function renderResetData(user) {
  USER = user;
  ensureStyles();
  $('#pnlMain').innerHTML = `
    <div class="rst-head"><div><h1>Reiniciar datos de prueba</h1>
      <p>Borra definitivamente lo generado durante el per\u00edodo de prueba. Solo superadministrador.</p></div></div>
    <div class="rst-loading">Cargando conteos\u2026</div>`;

  const [rc, rs] = await Promise.all([api({ action: 'counts' }), api({ action: 'companies' })]);
  if (!rc || !rc.ok || !rs || !rs.ok) {
    const err = (rc && rc.error) || (rs && rs.error) || '';
    $('#pnlMain').innerHTML += `<div class="rst-box rst-box-err">No se pudieron cargar los datos${err ? ': ' + esc(err) : ''}.</div>`;
    return;
  }
  COUNTS = rc.counts || {};
  STATS = Array.isArray(rs.companies) ? rs.companies : [];
  SEL.clear(); FQ = '';
  paint();
}

/* ---------- render principal ---------- */
function paint() {
  $('#pnlMain').innerHTML = `
    <div class="rst-head"><div><h1>Reiniciar datos de prueba</h1>
      <p>Borra definitivamente lo generado durante el per\u00edodo de prueba. Solo superadministrador.</p></div></div>

    <div class="rst-danger"><span style="font-size:16px">\u26A0\uFE0F</span>
      <div><b>Esta acci\u00f3n es permanente e irreversible.</b> Los datos se eliminan f\u00edsicamente; no hay papelera ni deshacer. El personal, las empresas, los usuarios y toda la configuraci\u00f3n <b>no se tocan</b> en ning\u00fan modo.</div>
    </div>

    <div class="rst-modes">
      <div class="rst-mode" id="rstMSel">
        <span class="radio"></span>
        <h3>\u{1F3AF} Por empresas (selectivo)</h3>
        <p>Borra <b>solo Reportes y Constancias</b> de las empresas que marques. Controlado: el resto del portal no se toca y la numeraci\u00f3n sigue igual.</p>
        <div class="tagz">
          <span class="rst-tg rst-tg-in">Reportes</span><span class="rst-tg rst-tg-in">Constancias + PDFs</span>
          <span class="rst-tg rst-tg-out">Avisos no</span><span class="rst-tg rst-tg-out">Sincronizaciones no</span>
        </div>
      </div>
      <div class="rst-mode" id="rstMAll">
        <span class="radio"></span>
        <h3>\u{1F4A5} Total (hard reset)</h3>
        <p>Borra <b>todo lo transaccional</b> de todas las empresas y <b>reinicia la numeraci\u00f3n a cero</b>: el pr\u00f3ximo reporte ser\u00e1 el <b>N\u00b0 1</b> y la pr\u00f3xima solicitud la <b>#1</b>.</p>
        <div class="tagz">
          <span class="rst-tg rst-tg-in">Reportes</span><span class="rst-tg rst-tg-in">Avisos</span>
          <span class="rst-tg rst-tg-in">Sincronizaciones</span><span class="rst-tg rst-tg-in">Constancias + PDFs</span>
          <span class="rst-tg rst-tg-zero">Numeraci\u00f3n \u2192 0</span>
        </div>
      </div>
    </div>

    <div class="rst-picker" id="rstPicker">
      <div class="ph">
        <b>Empresas a limpiar</b>
        <input type="text" id="rstQ" placeholder="Buscar por c\u00f3digo o nombre\u2026" value="${esc(FQ)}">
        <button class="rst-plink" id="rstAllVis">Todas las visibles</button>
        <button class="rst-plink" id="rstNone">Ninguna</button>
        <span class="rst-pickn" id="rstPickN">0 seleccionadas</span>
      </div>
      <div class="rst-plist" id="rstPlist"></div>
    </div>

    <div class="rst-cards">
      <div class="rst-card" id="rstCRep">
        <h3><span class="rst-ic rst-ic-rep">\u{1F4CB}</span> Reportes <span class="n" id="rstNRep">\u2014</span></h3>
        <ul>
          <li>Reportes enviados (los 5 tipos) y su detalle</li>
          <li>Checklists de documentos (ausencias e ingresos)</li>
        </ul>
      </div>
      <div class="rst-card" id="rstCCon">
        <h3><span class="rst-ic rst-ic-con">\u{1F4C4}</span> Constancias <span class="n" id="rstNCon">\u2014</span></h3>
        <ul>
          <li>Solicitudes, l\u00edneas y su auditor\u00eda</li>
          <li>Sus PDFs generados (almacenamiento)</li>
        </ul>
      </div>
      <div class="rst-card" id="rstCAvi">
        <h3><span class="rst-ic rst-ic-avi">\u{1F514}</span> Avisos <span class="n" id="rstNAvi">\u2014</span></h3>
        <ul><li>Comunicados manuales y marcas de visto</li></ul>
        <div class="offnote" id="rstOAvi">Solo en el reinicio total (los avisos no son por empresa).</div>
      </div>
      <div class="rst-card" id="rstCSin">
        <h3><span class="rst-ic rst-ic-sin">\u{1F504}</span> Sincronizaciones <span class="n" id="rstNSin">\u2014</span></h3>
        <ul><li>Bit\u00e1coras de fichas, personal y empresas</li></ul>
        <div class="offnote" id="rstOSin">Solo en el reinicio total.</div>
      </div>
    </div>

    <div class="rst-zero" id="rstZero" style="display:none">
      <span style="font-size:15px">\u{1F501}</span>
      <div><b>Numeraci\u00f3n a cero:</b> al terminar, los contadores de reportes, constancias y bit\u00e1coras se reinician. El pr\u00f3ximo reporte enviado ser\u00e1 el <b>N\u00b0 1</b> y la pr\u00f3xima solicitud de constancia la <b>#1</b>.</div>
    </div>

    <div class="rst-keeps">
      <b>Se conserva siempre:</b> personal y fotos, empresas y estructura, usuarios y permisos,
      cat\u00e1logos y configuraci\u00f3n, per\u00edodos de n\u00f3mina, estado de pago, novedades de empresas,
      documentos de la pantalla Documentos, firmantes y el historial de versiones.
    </div>

    <div class="rst-footer">
      <button class="rst-btn rst-btn-danger" id="rstGo">\u2026</button>
      <span class="rst-note">Quedar\u00e1 registro de qui\u00e9n, cu\u00e1ndo, qu\u00e9 modo y qu\u00e9 empresas.</span>
    </div>`;

  $('#rstMSel').addEventListener('click', () => setMode('sel'));
  $('#rstMAll').addEventListener('click', () => setMode('all'));
  $('#rstQ').addEventListener('input', e => { FQ = e.target.value; paintList(); });
  $('#rstAllVis').addEventListener('click', () => { visibleStats().forEach(s => SEL.add(s.company_code)); paintList(); syncUI(); });
  $('#rstNone').addEventListener('click', () => { SEL.clear(); paintList(); syncUI(); });
  $('#rstGo').addEventListener('click', openSummary);

  paintList();
  setMode(MODE);
}

function visibleStats() {
  const q = FQ.trim().toUpperCase();
  if (!q) return STATS;
  return STATS.filter(s =>
    String(s.company_code || '').toUpperCase().includes(q)
    || String(s.business_name || '').toUpperCase().includes(q));
}

/* Lista del picker (repinta solo la lista; los checks viven en SEL). */
function paintList() {
  const host = $('#rstPlist');
  if (!host) return;
  const rows = visibleStats();
  if (!rows.length) {
    host.innerHTML = `<div class="rst-pempty">Ninguna empresa coincide con la b\u00fasqueda.</div>`;
    return;
  }
  host.innerHTML = rows.map(s => `
    <label class="rst-prow">
      <input type="checkbox" data-cc="${esc(s.company_code)}" ${SEL.has(s.company_code) ? 'checked' : ''}>
      <span class="cc">${esc(s.company_code)}</span>
      <span class="nm">${esc(s.business_name || '')}</span>
      <span class="meta">${fmtN(s.reportes)} reporte${s.reportes === 1 ? '' : 's'} \u00b7 ${fmtN(s.solicitudes)} constancia${s.solicitudes === 1 ? '' : 's'}</span>
    </label>`).join('');
  host.querySelectorAll('input[data-cc]').forEach(c =>
    c.addEventListener('change', () => {
      if (c.checked) SEL.add(c.dataset.cc); else SEL.delete(c.dataset.cc);
      syncUI();
    }));
}

function setMode(m) {
  MODE = m;
  const sel = m === 'sel';
  $('#rstMSel').classList.toggle('on', sel);
  $('#rstMAll').classList.toggle('on', !sel);
  $('#rstPicker').style.display = sel ? '' : 'none';
  $('#rstCAvi').classList.toggle('off', sel);
  $('#rstCSin').classList.toggle('off', sel);
  $('#rstOAvi').style.display = sel ? '' : 'none';
  $('#rstOSin').style.display = sel ? '' : 'none';
  $('#rstZero').style.display = sel ? 'none' : '';
  syncUI();
}

/* Refresca contadores/boton segun modo + seleccion (sin repintar la lista). */
function syncUI() {
  const t = derivedTotal();
  const nAvi = $('#rstNAvi'); if (nAvi) nAvi.textContent = `${fmtN(t.avN)} comunicados \u00b7 ${fmtN(t.avMarcas)} marcas`;
  const nSin = $('#rstNSin'); if (nSin) nSin.textContent = `${fmtN(t.siTotal)} registros`;
  const d = MODE === 'sel' ? derivedSel() : t;
  const nRep = $('#rstNRep'); if (nRep) nRep.textContent = `${fmtN(d.repN)} reportes \u00b7 ${fmtN(d.repLineas)} l\u00edneas`;
  const nCon = $('#rstNCon'); if (nCon) nCon.textContent = `${fmtN(d.coSolic)} solicitudes \u00b7 ${fmtN(d.coPdfs)} PDF`;
  const pn = $('#rstPickN'); if (pn) pn.textContent = `${SEL.size} seleccionada${SEL.size === 1 ? '' : 's'}`;
  const go = $('#rstGo');
  if (go) {
    if (MODE === 'sel') {
      go.innerHTML = `\u{1F3AF} Limpiar ${SEL.size} empresa${SEL.size === 1 ? '' : 's'}\u2026`;
    } else {
      go.innerHTML = `\u{1F4A5} Reiniciar TODO (hard reset)\u2026`;
    }
    go.disabled = !hasWork();
  }
}

/* ---------- Modal 1: resumen (por modo) ---------- */
function openSummary() {
  const isSel = MODE === 'sel';
  const wrap = document.createElement('div');
  wrap.className = 'rst-ov';
  let inner;
  if (isSel) {
    const d = derivedSel();
    const codes = [...SEL].sort();
    const shown = codes.slice(0, 12).join(', ') + (codes.length > 12 ? ` \u2026 (+${codes.length - 12})` : '');
    inner = `
      <h3>Limpiar ${codes.length} empresa${codes.length === 1 ? '' : 's'}</h3>
      <p>Se eliminar\u00e1 <b>definitivamente</b> lo siguiente de <b>${esc(shown)}</b>:</p>
      <div class="rst-sum">
        <div class="r"><span>Reportes (con l\u00edneas y checklists)</span><b>${fmtN(d.repN)} + ${fmtN(d.repLineas)}</b></div>
        <div class="r"><span>Constancias (solicitudes, auditor\u00eda y PDFs)</span><b>${fmtN(d.coTablas)} + ${fmtN(d.coPdfs)} PDF</b></div>
      </div>
      <div class="rst-box rst-box-danger">No se puede deshacer. Las dem\u00e1s empresas, los avisos, las sincronizaciones y la numeraci\u00f3n quedan intactos.</div>`;
  } else {
    const d = derivedTotal();
    inner = `
      <h3>Reinicio TOTAL (hard reset)</h3>
      <p>Se eliminar\u00e1 <b>definitivamente TODO</b> lo transaccional:</p>
      <div class="rst-sum">
        <div class="r"><span>Reportes (todos, con l\u00edneas y checklists)</span><b>${fmtN(d.repN)} + ${fmtN(d.repLineas)}</b></div>
        <div class="r"><span>Avisos manuales y marcas de visto</span><b>${fmtN(d.avN + d.avMarcas)}</b></div>
        <div class="r"><span>Bit\u00e1coras de sincronizaci\u00f3n</span><b>${fmtN(d.siTotal)}</b></div>
        <div class="r"><span>Constancias (solicitudes, auditor\u00eda y PDFs)</span><b>${fmtN(d.coTablas)} + ${fmtN(d.coPdfs)} PDF</b></div>
      </div>
      <div class="rst-box rst-box-zero">\u{1F501} La numeraci\u00f3n se reinicia: el pr\u00f3ximo reporte ser\u00e1 el N\u00b0 1 y la pr\u00f3xima solicitud la #1.</div>
      <div class="rst-box rst-box-danger">No se puede deshacer. El personal, empresas, usuarios, cat\u00e1logos y configuraci\u00f3n quedan intactos.</div>`;
  }
  wrap.innerHTML = `<div class="rst-modal">${inner}
      <div class="rst-mfoot">
        <button class="rst-btn" id="rstCxl1">Cancelar</button>
        <button class="rst-btn rst-btn-danger" id="rstNext">Continuar</button>
      </div></div>`;
  document.body.appendChild(wrap);
  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('#rstCxl1').addEventListener('click', close);
  wrap.querySelector('#rstNext').addEventListener('click', () => { close(); openConfirm(); });
}

/* ---------- Modal 2: palabra por modo ---------- */
function openConfirm() {
  const isSel = MODE === 'sel';
  const word = isSel ? 'REINICIAR' : 'REINICIAR TODO';
  const wrap = document.createElement('div');
  wrap.className = 'rst-ov';
  wrap.innerHTML = `
    <div class="rst-modal">
      <h3>Confirmaci\u00f3n final</h3>
      <p>${isSel
        ? `Para limpiar las empresas seleccionadas, escribe <b style="color:var(--danger,#dc2626)">REINICIAR</b>:`
        : `Para el reinicio TOTAL con numeraci\u00f3n a cero, escribe <b style="color:var(--danger,#dc2626)">REINICIAR TODO</b>:`}</p>
      <input class="rst-word" id="rstWord" placeholder="Escribe la palabra\u2026" autocomplete="off">
      <div class="rst-mfoot">
        <button class="rst-btn" id="rstCxl2">Cancelar</button>
        <button class="rst-btn rst-btn-danger" id="rstFire" disabled>Ejecutar</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const w = wrap.querySelector('#rstWord');
  const fire = wrap.querySelector('#rstFire');
  w.addEventListener('input', () => {
    fire.disabled = w.value.trim().toUpperCase().replace(/\s+/g, ' ') !== word;
  });
  wrap.querySelector('#rstCxl2').addEventListener('click', close);
  fire.addEventListener('click', () => { close(); runReset(); });
  w.focus();
}

/* ---------- Modal 3: progreso + resultado ---------- */
const STEPS_TOTAL = [
  { key: 'reportes',          label: 'Reportes\u2026' },
  { key: 'avisos',            label: 'Avisos\u2026' },
  { key: 'sincronizaciones',  label: 'Sincronizaciones\u2026' },
  { key: 'constancias',       label: 'Constancias (tablas)\u2026' },
  { key: 'constancias_pdfs',  label: 'Constancias (PDFs)\u2026' },
  { key: 'numeracion',        label: 'Numeraci\u00f3n a cero\u2026' },
];
// OJO orden: los PDFs selectivos ANTES de borrar las lineas (la lista de
// archivos sale de cert_request_lines de esas empresas).
const STEPS_SEL = [
  { key: 'sel_reportes',         label: 'Reportes\u2026' },
  { key: 'sel_constancias_pdfs', label: 'Constancias (PDFs)\u2026' },
  { key: 'sel_constancias',      label: 'Constancias (tablas)\u2026' },
];

async function runReset() {
  const isSel = MODE === 'sel';
  const steps = isSel ? STEPS_SEL : STEPS_TOTAL;
  const confirmWord = isSel ? 'REINICIAR' : 'REINICIAR TODO';
  const codes = isSel ? [...SEL] : null;

  const wrap = document.createElement('div');
  wrap.className = 'rst-ov';
  wrap.innerHTML = `
    <div class="rst-modal">
      <h3 id="rstPTitle">${isSel ? 'Limpiando empresas\u2026' : 'Reiniciando todo\u2026'}</h3>
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
  // Se cierra SOLO con su boton (aparece al terminar).

  let filas = 0, archivos = 0, numeracion = false, quien = '', cuando = '';
  const errores = [];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    lbl.textContent = 'Eliminando ' + s.label;
    const payload = { action: 'run', category: s.key, confirm: confirmWord };
    if (isSel) payload.company_codes = codes;
    const r = await api(payload);
    if (!r || !r.ok) {
      errores.push(`${s.label} ${((r && r.error) || 'fallo').slice(0, 160)}`);
    } else {
      const det = r.detail || {};
      if (s.key.endsWith('constancias_pdfs')) archivos += (det.archivos || 0);
      else if (s.key === 'numeracion') numeracion = true;
      else filas += Object.entries(det).reduce((a, [k, n]) => k === 'companies' ? a : a + (Number(n) || 0), 0);
      quien = r.executed_by || quien;
      cuando = r.executed_at || cuando;
    }
    bar.style.width = Math.round(((i + 1) / steps.length) * 100) + '%';
  }

  lbl.style.display = 'none';
  const fecha = cuando
    ? new Date(cuando).toLocaleString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  const empTxt = isSel ? ` de ${codes.length} empresa${codes.length === 1 ? '' : 's'}` : '';
  if (errores.length) {
    wrap.querySelector('#rstPTitle').textContent = isSel ? 'Limpieza con errores' : 'Reinicio con errores';
    errB.style.display = 'block';
    errB.innerHTML = `\u26A0 ${fmtN(filas)} registros y ${fmtN(archivos)} archivos s\u00ed se eliminaron${esc(empTxt)}, pero fall\u00f3:<br>${errores.map(esc).join('<br>')}<br>Puedes volver a ejecutar: lo ya borrado no reaparece.`;
  } else {
    wrap.querySelector('#rstPTitle').textContent = isSel ? 'Limpieza completada' : 'Reinicio completado';
    doneB.style.display = 'block';
    doneB.innerHTML = `\u2713 <b>${fmtN(filas)}</b> registros y <b>${fmtN(archivos)}</b> archivos eliminados${esc(empTxt)}.`
      + (numeracion ? `<br>\u{1F501} Numeraci\u00f3n reiniciada: el pr\u00f3ximo reporte ser\u00e1 el <b>N\u00b0 1</b>.` : '')
      + (quien ? `<br>Registrado: <b>${esc(quien)}</b>${fecha ? ' \u00b7 ' + esc(fecha) : ''}` : '');
  }
  closeB.style.display = 'inline-block';
  closeB.addEventListener('click', () => { wrap.remove(); renderResetData(USER); });
}
