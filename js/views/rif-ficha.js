/* =====================================================================
   rif-ficha.js — RIF personal (SENIAT, PDF) en la ficha del trabajador.
   Va en la seccion DOCUMENTOS de la ficha (worker-photos.js), junto a la
   Referencia Bancaria. Mismo patron que bank-ref-ficha.js.

   Flujo: el usuario sube el comprobante RIF (PDF del SENIAT) -> se extrae en
   el NAVEGADOR con pdfjs (RIF + cedula + vencimiento) -> semaforos -> se
   guarda SIEMPRE en /api/personal-doc (doc_type='rif', estado pendiente).
   Las discrepancias son ADVERTENCIAS que persisten; NUNCA reemplaza la
   cedula ni ningun dato de la ficha (solo respalda).

   Validaciones (semaforos):
     1. Cedula (la fuerte): cedula del RIF == cedula de la ficha.
     2. Digito verificador: calcRIF(cedula) == RIF del PDF.
     3. Vencimiento: si esta vencido -> advertencia (no bloquea).

   Exporta: initRifCard(host, w, STATE, onRender)
   ===================================================================== */

// pdfjs AUTO-ALOJADO (misma razon que bank-ref-ficha: la CSP bloquea el
// worker de cdnjs; servido desde /vendor/pdfjs/ todo es 'self').
const PDFJS_ESM = '/vendor/pdfjs/pdf.min.mjs';
const PDFJS_WORKER = '/vendor/pdfjs/pdf.worker.min.mjs';

let _pdfjs = null;
async function ensurePdfjs() {
  if (_pdfjs) return _pdfjs;
  const lib = await import(/* @vite-ignore */ PDFJS_ESM);
  try { lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; } catch (_) { /* noop */ }
  _pdfjs = lib;
  return lib;
}

/* ---------- digito verificador RIF (algoritmo SENIAT, verificado) ---------- */
function calcRIF(cedula) {
  const c8 = String(cedula).replace(/\D/g, '').padStart(8, '0').slice(-8);
  const num = parseInt(c8, 10);
  const letra = num >= 80000000 ? 'E' : 'V';
  const lv = letra === 'V' ? 4 : letra === 'E' ? 8 : 0;
  const fac = [3, 2, 7, 6, 5, 4, 3, 2];
  let s = lv; for (let i = 0; i < 8; i++) s += parseInt(c8[i], 10) * fac[i];
  let d = 11 - (s % 11); if (d >= 10) d = 0;
  return letra + c8 + d;
}

/* ---------- API ---------- */
async function docApi(payload) {
  const res = await fetch('/api/personal-doc', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}
function sessUser(u) { return { kind: u.kind, id: u.id || null, companyCode: u.companyCode || null }; }

/* ---------- utilidades ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const digits = s => String(s || '').replace(/\D/g, '');
function normCed(s) { return digits(s).replace(/^0+/, ''); }
function collapse(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function fmtCed(c) { const d = digits(c); return 'V-' + d.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

function nameKey(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}
function nameSim(a, b) {
  const ka = nameKey(a), kb = nameKey(b);
  if (!ka || !kb) return false;
  const A = new Set(ka.split(' ')), B = new Set(kb.split(' '));
  let inter = 0; A.forEach(t => { if (B.has(t)) inter++; });
  return inter / Math.max(A.size, B.size) >= 0.5;
}

// fecha DD/MM/YYYY -> Date (local, medianoche). Comparacion contra "hoy".
function parseDMY(s) { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || ''); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; }
function todayLocal() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function isVencido(dmy) { const d = parseDMY(dmy); return !!d && d < todayLocal(); }

/* ---------- parser del comprobante SENIAT ---------- */
function looksLikeRif(text) {
  return /REGISTRO\s+[ÚU]NICO\s+DE\s+INFORMACI[ÓO]N\s+FISCAL|seniat\.gob\.ve|N[°º]\s*COMPROBANTE/i.test(text || '');
}
function parseRif(rawText) {
  const text = collapse(rawText);
  const out = { es_rif: looksLikeRif(text), rif: null, cedula_rif: null, nombre_pdf: null,
    nro_comprobante: null, fecha_inscripcion: null, fecha_actualizacion: null, fecha_vencimiento: null };

  // RIF (letra + 9 digitos) + nombre, anclado a "FECHA DE INSCRIPCI..."
  let m = text.match(/\b([VEJPG])\s?-?\s?(\d{9})\b\s+([A-ZÁÉÍÓÚÑ&. ]+?)\s+FECHA DE INSCRIPCI/i);
  if (m) {
    out.rif = (m[1].toUpperCase() + m[2]);
    out.cedula_rif = normCed(m[2].slice(0, 8));
    out.nombre_pdf = collapse(m[3]);
  } else {
    // fallback: RIF suelto (sin nombre pegado)
    const mr = text.match(/\b([VEJPG])\s?-?\s?(\d{9})\b/);
    if (mr) { out.rif = mr[1].toUpperCase() + mr[2]; out.cedula_rif = normCed(mr[2].slice(0, 8)); }
  }

  const mc = text.match(/N[°º]\s*COMPROBANTE:\s*([A-Z0-9]+)/i);
  if (mc) out.nro_comprobante = mc[1];

  const mi = text.match(/FECHA DE INSCRIPCI[ÓO]N:\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (mi) out.fecha_inscripcion = mi[1];

  const ma = text.match(/[ÚU]LTIMA ACTUALIZACI[ÓO]N:\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (ma) out.fecha_actualizacion = ma[1];

  const mv = text.match(/FECHA DE VENCIMIENTO:\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (mv) out.fecha_vencimiento = mv[1];

  return out;
}

/* ---------- semaforos vs la ficha ---------- */
function evaluate(fields, w) {
  const fichaCed = digits(w.id_number);
  const cedOk = !!fields.cedula_rif && digits(fields.cedula_rif) === fichaCed;
  const nameOk = !!fields.nombre_pdf && nameSim(fields.nombre_pdf, w.full_name);
  const digitOk = !!fields.rif && !!fields.cedula_rif && calcRIF(fields.cedula_rif) === fields.rif;
  const vencido = isVencido(fields.fecha_vencimiento);
  const parsed = !!(fields.es_rif && fields.rif && fields.cedula_rif);

  const warnings = [];
  if (!cedOk) {
    if (nameOk) warnings.push({ level: 'warn', code: 'cedula_mismatch', text: `La cédula del RIF (${fields.cedula_rif ? fmtCed(fields.cedula_rif) : '—'}) no coincide con la de la ficha (${fmtCed(fichaCed)}), aunque el nombre sí. Posible dígito mal leído.` });
    else warnings.push({ level: 'err', code: 'other_person', text: `El RIF parece de otra persona (${fields.nombre_pdf || '—'}, ${fields.cedula_rif ? fmtCed(fields.cedula_rif) : '—'}), no del trabajador. Solo se acepta el RIF del titular.` });
  }
  // Digito verificador: solo advierte cuando la cédula SÍ coincide (si no
  // coincide, ya avisa la cédula; el dígito seria ruido).
  if (cedOk && !digitOk) warnings.push({ level: 'warn', code: 'digit_invalid', text: 'El dígito verificador del RIF no calza con la cédula. Revisa que sea el PDF correcto del SENIAT.' });
  if (vencido) warnings.push({ level: 'warn', code: 'rif_vencido', text: `El RIF está vencido${fields.fecha_vencimiento ? ' (venció el ' + fields.fecha_vencimiento + ')' : ''}. Se guarda igual, pero conviene renovarlo en el SENIAT.` });

  const validaciones = { cedula_ok: cedOk, digito_ok: digitOk, vencido, nombre_ok: nameOk,
    ficha_cedula: fichaCed, ficha_nombre: w.full_name || '', warnings };
  return { cedOk, nameOk, digitOk, vencido, parsed, warnings, validaciones };
}

/* ---------- estilos (una sola vez) ---------- */
function ensureStyles() {
  if (document.getElementById('rifd-styles')) return;
  const st = document.createElement('style');
  st.id = 'rifd-styles';
  st.textContent = `
  #rifSlot{display:block;width:100%}
  .rifd-card{border:1px solid #e5e7eb;border-radius:12px;background:#fbfcfe;padding:13px 15px;margin-top:8px;max-width:620px}
  .rifd-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .rifd-top .sp{flex:1}
  .rifd-chip{display:inline-flex;align-items:center;gap:7px;background:#f5f3ff;border:1px solid #ddd6fe;color:#6d28d9;font-size:11.5px;font-weight:600;border-radius:999px;padding:4px 11px}
  .rifd-badge{font-size:10px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;border-radius:999px;padding:2px 8px}
  .rifd-badge.pend{background:#fffbeb;border:1px solid #fde68a;color:#92400e}
  .rifd-badge.pub{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534}
  .rifd-badge.venc{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}
  .rifd-help{margin-top:10px;padding-top:10px;border-top:1px dashed #e5e7eb;font-size:12px}
  .rifd-lnk{color:#7c3aed;cursor:pointer;font-weight:650;text-decoration:none}
  .rifd-lnk:hover{text-decoration:underline}
  .rifd-btn{border:1px solid #7c3aed;background:#fff;color:#7c3aed;border-radius:9px;padding:7px 13px;font-size:12.5px;font-weight:700;cursor:pointer;display:inline-flex;gap:7px;align-items:center}
  .rifd-btn:hover{background:#f5f3ff}
  .rifd-btn svg{width:14px;height:14px}
  .rifd-none{font-size:12.5px;color:#64748b}
  .rifd-ov{position:fixed;inset:0;background:rgba(15,23,42,.42);display:flex;align-items:center;justify-content:center;padding:22px;z-index:9000}
  .rifd-modal{background:#fff;border-radius:16px;width:560px;max-width:100%;max-height:92vh;overflow:auto;box-shadow:0 24px 70px rgba(15,23,42,.32);font-size:14px;color:#111827}
  .rifd-mh{display:flex;align-items:center;gap:11px;padding:17px 20px;border-bottom:1px solid #eceff3}
  .rifd-mh .ic{width:34px;height:34px;border-radius:9px;background:#f5f3ff;color:#7c3aed;display:flex;align-items:center;justify-content:center;flex:none}
  .rifd-mh b{font-size:15px}
  .rifd-mh small{display:block;color:#64748b;font-size:12px}
  .rifd-mh .x{margin-left:auto;border:0;background:transparent;color:#64748b;cursor:pointer;padding:4px;border-radius:7px;font-size:20px;line-height:1}
  .rifd-mb{padding:18px 20px}
  .rifd-drop{border:2px dashed #e5e7eb;border-radius:13px;padding:26px;text-align:center;cursor:pointer}
  .rifd-drop:hover{border-color:#7c3aed;background:#f5f3ff}
  .rifd-drop b{font-size:14.5px}
  .rifd-drop p{color:#64748b;font-size:12.5px;margin-top:5px;line-height:1.5}
  .rifd-titular{display:flex;gap:9px;align-items:flex-start;background:#fffbeb;border:1px solid #fde68a;border-radius:11px;padding:11px 13px;margin-top:14px;font-size:12.5px;color:#92400e;line-height:1.5}
  .rifd-rows{display:flex;flex-direction:column;gap:7px;margin-top:4px}
  .rifd-row{display:grid;grid-template-columns:96px 1fr auto;gap:10px;align-items:center;padding:9px 12px;border-radius:10px;border:1px solid #eceff3;background:#fff}
  .rifd-row.ok{background:#f0fdf4;border-color:#bbf7d0}
  .rifd-row.warn{background:#fffbeb;border-color:#fde68a}
  .rifd-row.err{background:#fef2f2;border-color:#fecaca}
  .rifd-row .l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#64748b}
  .rifd-row .v{font-size:13.5px;font-weight:600}
  .rifd-row .v .mono{font-family:ui-monospace,Consolas,monospace}
  .rifd-sem{font-size:11.5px;font-weight:700;white-space:nowrap}
  .rifd-sem.ok{color:#16a34a}.rifd-sem.warn{color:#d97706}.rifd-sem.err{color:#dc2626}.rifd-sem.info{color:#64748b}
  .rifd-verdict{display:flex;gap:9px;align-items:flex-start;margin-top:15px;padding:11px 13px;border-radius:11px;font-size:12.5px;font-weight:600;line-height:1.45}
  .rifd-verdict.ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534}
  .rifd-verdict.warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e}
  .rifd-verdict.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}
  .rifd-verdict.info{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af}
  .rifd-mf{display:flex;gap:9px;align-items:center;padding:15px 20px;border-top:1px solid #eceff3;background:#fbfcfe}
  .rifd-mf .note{font-size:11px;color:#64748b;margin-right:auto;max-width:260px;line-height:1.4}
  .rifd-mf .go{border:1px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:9px;padding:9px 15px;font-weight:700;cursor:pointer}
  .rifd-mf .go:disabled{background:#cbd5e1;border-color:#cbd5e1;cursor:not-allowed}
  .rifd-mf .cancel{border:1px solid #e5e7eb;background:#fff;color:#374151;border-radius:9px;padding:9px 14px;font-weight:600;cursor:pointer}
  .rifd-spin{display:inline-block;width:16px;height:16px;border:2px solid #ddd6fe;border-top-color:#7c3aed;border-radius:50%;animation:rifdspin .7s linear infinite;vertical-align:-3px}
  @keyframes rifdspin{to{transform:rotate(360deg)}}
  `;
  document.head.appendChild(st);
}

const UP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const RIF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg>';

/* ===================== TARJETA EN LA FICHA ===================== */
export async function initRifCard(host, w, STATE, onRender) {
  const slot = host.querySelector('#rifSlot');
  if (!slot) return;
  ensureStyles();
  const canUpload = !!(STATE.can && STATE.can.rif);
  const fire = () => { try { if (typeof onRender === 'function') onRender(); } catch (_) { /* noop */ } };

  const render = (docs) => {
    const latest = (docs || []).find(d => d.estado !== 'anulada') || null;
    if (!canUpload && !latest) { slot.innerHTML = ''; fire(); return; }

    let chip = '';
    if (latest) {
      const dat = latest.datos || {};
      const venc = dat.fecha_vencimiento || '';
      const vencido = isVencido(venc);
      const badge = vencido
        ? '<span class="rifd-badge venc">vencido</span>'
        : (latest.estado === 'publicada' ? '<span class="rifd-badge pub">validado</span>' : '<span class="rifd-badge pend">pendiente</span>');
      const nWarn = (latest.validaciones && latest.validaciones.warnings || []).length;
      const warnTxt = nWarn ? ` · <span style="color:#d97706;font-weight:700">⚠ ${nWarn} advertencia${nWarn === 1 ? '' : 's'}</span>` : '';
      const vencTxt = venc ? ` · vence ${esc(venc)}` : '';
      chip = `<span class="rifd-chip">${RIF_SVG} RIF ${esc(dat.rif || '')}${vencTxt} · <span class="rifd-lnk" data-rif="view" data-path="${esc(latest.storage_path || '')}">Ver PDF</span></span> ${badge}${warnTxt}`;
    } else {
      chip = '<span class="rifd-none">Aún no hay un RIF cargado. Validamos cédula, dígito verificador y vencimiento.</span>';
    }

    const btn = canUpload
      ? `<button class="rifd-btn" data-rif="upload">${UP_SVG} ${latest ? 'Cargar / reemplazar' : 'Cargar RIF (PDF)'}</button>`
      : '';

    slot.innerHTML = `
      <div class="rifd-card">
        <div class="rifd-top">${chip}<span class="sp"></span>${btn}</div>
        <div class="rifd-help"><a class="rifd-lnk" href="/guias/rif-seniat.html" target="_blank" rel="noopener">¿Cómo descargar el RIF en el portal del SENIAT? ↗</a></div>
      </div>`;

    const up = slot.querySelector('[data-rif="upload"]');
    if (up) up.addEventListener('click', () => openUploadModal(w, STATE, () => refresh()));
    const vp = slot.querySelector('[data-rif="view"]');
    if (vp) vp.addEventListener('click', () => viewPdf(STATE, vp.dataset.path));
    fire();
  };

  const refresh = async () => {
    try {
      const r = await docApi({ action: 'list', id_number: w.id_number, doc_type: 'rif', user: sessUser(STATE.user) });
      render(r && r.ok ? r.documents : []);
    } catch (_) { render([]); }
  };

  render(null);
  refresh();
}

async function viewPdf(STATE, path) {
  if (!path) return;
  try {
    const r = await docApi({ action: 'sign', storage_path: path, user: sessUser(STATE.user) });
    if (r && r.ok && r.signed_url) window.open(r.signed_url, '_blank', 'noopener');
    else alert('No se pudo abrir el PDF. Intenta de nuevo.');
  } catch (_) { alert('No se pudo abrir el PDF. Intenta de nuevo.'); }
}

/* ===================== MODAL DE CARGA ===================== */
function openUploadModal(w, STATE, onSaved) {
  ensureStyles();
  const ov = document.createElement('div');
  ov.className = 'rifd-ov';
  ov.innerHTML = `
    <div class="rifd-modal">
      <div class="rifd-mh">
        <div class="ic">${RIF_SVG}</div>
        <div><b>Cargar RIF (SENIAT)</b><small>${esc(w.full_name || '')} · ${fmtCed(w.id_number)}</small></div>
        <button class="x" data-rif="close">×</button>
      </div>
      <div class="rifd-mb" id="rifdBody">
        <div class="rifd-drop" id="rifdDrop">
          <b>Cargar RIF (PDF)</b>
          <p>Haz clic o arrastra el comprobante emitido por el SENIAT.<br>Extraemos el RIF, la cédula y el vencimiento automáticamente.</p>
          <input type="file" accept="application/pdf,.pdf" id="rifdFile" style="display:none">
        </div>
        <div class="rifd-titular">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
          <span><b>Solo el RIF del titular.</b> Validamos que la cédula del RIF coincida con la del trabajador.</span>
        </div>
      </div>
      <div class="rifd-mf" id="rifdFoot" style="display:none">
        <span class="note" id="rifdNote"></span>
        <button class="cancel" data-rif="close">Cancelar</button>
        <button class="go" id="rifdSave" disabled>Guardar RIF</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelectorAll('[data-rif="close"]').forEach(b => b.addEventListener('click', close));

  const drop = ov.querySelector('#rifdDrop');
  const fileInput = ov.querySelector('#rifdFile');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = '#7c3aed'; });
  drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
  drop.addEventListener('drop', e => { e.preventDefault(); drop.style.borderColor = ''; if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

  const body = ov.querySelector('#rifdBody');
  const foot = ov.querySelector('#rifdFoot');

  async function handleFile(file) {
    if (!file || (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name))) {
      body.innerHTML = `<div class="rifd-verdict err">Ese archivo no es un PDF. Sube el PDF original del comprobante RIF (SENIAT).</div>`;
      return;
    }
    if (file.size > 10 * 1024 * 1024) { body.innerHTML = `<div class="rifd-verdict err">El PDF supera 10 MB.</div>`; return; }
    body.innerHTML = `<div style="text-align:center;padding:26px;color:#64748b"><span class="rifd-spin"></span> Leyendo el PDF…</div>`;

    let buf;
    try { buf = await file.arrayBuffer(); } catch { body.innerHTML = `<div class="rifd-verdict err">No se pudo leer el archivo.</div>`; return; }
    const pdfB64 = await bytesToB64(new Uint8Array(buf));

    let text = '';
    try { text = await extractText(buf.slice(0)); }
    catch (e) {
      body.innerHTML = `<div class="rifd-verdict err">No se pudo procesar el PDF (¿es un escaneo/foto sin texto?). Sube el <b>PDF original</b> del SENIAT.<br><small>${esc(String(e && e.message || e))}</small></div>`;
      return;
    }
    if (collapse(text).length < 30) {
      body.innerHTML = `<div class="rifd-verdict info">Este PDF no tiene texto seleccionable (parece foto o escaneo). Sube el <b>PDF original</b> del SENIAT.</div>`;
      return;
    }

    const fields = parseRif(text);
    renderConfirm(fields, pdfB64);
  }

  function renderConfirm(fields, pdfB64) {
    const ev = evaluate(fields, w);
    const rows = [];
    rows.push(row('Persona', esc(fields.nombre_pdf || '—'),
      ev.cedOk ? sem('ok', ev.nameOk ? 'coincide' : 'validado por cédula') : (ev.nameOk ? sem('warn', 'revisar') : sem('err', 'otra persona'))));
    rows.push(row('Cédula', `<span class="mono">${fields.cedula_rif ? fmtCed(fields.cedula_rif) : '—'}</span>`,
      ev.cedOk ? sem('ok', 'es la del trabajador') : sem('err', 'no coincide')));
    rows.push(row('RIF', `<span class="mono">${esc(fields.rif || '—')}</span>`,
      !fields.rif ? sem('info', '—') : (ev.digitOk ? sem('ok', 'dígito válido') : sem('warn', 'dígito inválido'))));
    rows.push(row('Vence', esc(fields.fecha_vencimiento || '—'),
      !fields.fecha_vencimiento ? sem('info', 'sin fecha') : (ev.vencido ? sem('warn', 'RIF vencido') : sem('ok', 'vigente'))));

    body.innerHTML = `
      <div style="font-size:12px;color:#64748b;margin-bottom:8px">Documento detectado: <b>${fields.es_rif ? 'Comprobante RIF (SENIAT)' : 'no parece un RIF del SENIAT'}</b></div>
      <div class="rifd-rows">${rows.join('')}</div>
      <div class="rifd-verdict" id="rifdVerdict"></div>`;
    foot.style.display = 'flex';

    const saveBtn = ov.querySelector('#rifdSave');
    const note = ov.querySelector('#rifdNote');
    const verdict = ov.querySelector('#rifdVerdict');

    if (!ev.parsed) {
      verdict.className = 'rifd-verdict info';
      verdict.innerHTML = 'No se pudo leer el RIF y la cédula del PDF. Asegúrate de subir el <b>comprobante original</b> del SENIAT (con texto seleccionable).';
      saveBtn.disabled = true; note.textContent = '';
    } else {
      const err = ev.warnings.find(x => x.level === 'err');
      const warn = ev.warnings.find(x => x.level === 'warn');
      if (err) { verdict.className = 'rifd-verdict err'; verdict.innerHTML = `<b>Advertencia fuerte:</b> ${esc(err.text)}`; }
      else if (warn) { verdict.className = 'rifd-verdict warn'; verdict.innerHTML = `<b>Advertencia:</b> ${esc(warn.text)} <b>Persiste hasta corregir o cambiar el PDF.</b>`; }
      else { verdict.className = 'rifd-verdict ok'; verdict.innerHTML = '<b>Todo validado.</b> Cédula del titular, dígito verificador correcto y RIF vigente.'; }
      saveBtn.disabled = false;
      saveBtn.textContent = (err || warn) ? 'Guardar con advertencia' : 'Guardar RIF';
      note.innerHTML = 'El RIF queda como respaldo en la ficha. La cédula <b>no se toca</b>.';
    }

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true; saveBtn.innerHTML = '<span class="rifd-spin"></span> Guardando…';
      const payload = {
        action: 'save', user: sessUser(STATE.user), id_number: w.id_number, doc_type: 'rif',
        datos: {
          rif: fields.rif, cedula_rif: fields.cedula_rif, nombre_pdf: fields.nombre_pdf,
          nro_comprobante: fields.nro_comprobante, fecha_inscripcion: fields.fecha_inscripcion,
          fecha_actualizacion: fields.fecha_actualizacion, fecha_vencimiento: fields.fecha_vencimiento,
        },
        validaciones: ev.validaciones, pdf_base64: pdfB64,
      };
      try {
        const r = await docApi(payload);
        if (r && r.ok) {
          verdict.className = 'rifd-verdict ok';
          verdict.innerHTML = '<b>RIF guardado.</b> Queda como respaldo en la ficha, pendiente de publicar.';
          foot.style.display = 'none';
          if (onSaved) onSaved();
          setTimeout(close, 1400);
        } else {
          verdict.className = 'rifd-verdict err';
          verdict.innerHTML = 'No se pudo guardar: ' + esc((r && r.error) || 'error');
          saveBtn.disabled = false; saveBtn.textContent = 'Reintentar';
        }
      } catch (e) {
        verdict.className = 'rifd-verdict err';
        verdict.innerHTML = 'No se pudo guardar: ' + esc(String(e && e.message || e));
        saveBtn.disabled = false; saveBtn.textContent = 'Reintentar';
      }
    });
  }
}

function row(label, val, semHtml) {
  const cls = semHtml.indexOf('rifd-sem err') >= 0 ? 'err' : semHtml.indexOf('rifd-sem warn') >= 0 ? 'warn' : semHtml.indexOf('rifd-sem ok') >= 0 ? 'ok' : '';
  return `<div class="rifd-row ${cls}"><div class="l">${label}</div><div class="v">${val}</div><div>${semHtml}</div></div>`;
}
function sem(kind, txt) {
  const g = { ok: '✓', warn: '!', err: '✕', info: 'i' }[kind];
  return `<span class="rifd-sem ${kind}">${g} ${esc(txt)}</span>`;
}

/* ---------- pdfjs: extraer texto plano ---------- */
async function extractText(arrayBuffer) {
  const pdfjs = await ensurePdfjs();
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  let out = '';
  const n = Math.min(doc.numPages, 3);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out += ' ' + tc.items.map(it => it.str).join(' ');
  }
  try { doc.destroy(); } catch (_) { /* noop */ }
  return out;
}

/* ---------- bytes -> base64 (chunked) ---------- */
function bytesToB64(bytes) {
  return new Promise(resolve => {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    resolve(btoa(bin));
  });
}
