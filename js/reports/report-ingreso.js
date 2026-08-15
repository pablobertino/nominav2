/* =====================================================================
   js/reports/report-ingreso.js
   Definicion del reporte de Ingreso (Alta). Aporta el paso 4 y el envio.
   Se enchufa al wizard-core compartido.

   A diferencia de marcaje/ausencia/egreso, un Ingreso es una persona
   NUEVA: no sale del roster. El paso 4 captura el alta completa con un
   modal por persona (la grilla vive en ctx.workers, igual que los demas,
   para que el Resumen y el envio del core funcionen sin cambios).

   Cada worker agregado tiene la forma estandar { id, ced, name } MAS un
   objeto .ingreso con todos los datos del alta:
     { firstName, secondName, lastNames, cedKind, cargoCode,
       birthDate, gender, marital, account, bankCode, bankName,
       email, phone (nacional 04XX), phoneIntl (+58), address, startDate }

   Reglas (validadas tambien server-side en submit_ingreso):
     - cedula 6-8 digitos; letra V/E derivada (>=80.000.000 -> E).
     - edad >= 18 (desde fecha de nacimiento).
     - cuenta 20 digitos; prefijo (4) debe existir en el catalogo de bancos.
     - telefono opcional 04XX+7; prefijo en operadoras; se guarda +58.
     - cargo del catalogo (selectable_on_ingreso).
     - fecha de ingreso dentro de la ventana (margen atras + futuro config).
   TodoTicket NO se captura (siempre 'N' al exportar). El Data ID lo
   aporta la empresa en el servidor.
   ===================================================================== */

import { $ } from '../core/dom.js';
import { getSession } from '../core/session.js';
import * as DW from './shared/date-window.js';
import { wireWizardClose, algunoConValor } from './shared/wizard-close.js';

// Catalogos del wizard (cargos + bancos + operadoras + ventana). Una vez.
let CAT = null;

// Lista de ingresos del reporte en curso. La guardamos a nivel de modulo
// para que el boton "Ver detalle" del Resumen (que pinta wizard-core, sin
// hook a nuestras celdas) pueda localizar a la persona por su cedula y
// abrir su ficha en modo solo-lectura. Se refresca en cada render del paso 4.
let LAST_WORKERS = [];

/* ===== v5.77: AVISO TEMPRANO DE NO REEMPLEABLE (en el modal del alta) =====
   Hasta v5.76 el bloqueo solo saltaba al FINAL: la tienda llenaba la ficha
   entera, adjuntaba recaudos, llegaba al Resumen, tocaba Enviar... y recien
   ahi el servidor rechazaba. El control era correcto pero la experiencia no.

   Ahora, apenas la cedula es valida (6-8 digitos), se consulta
   /api/no-rehire (action 'check') y si la persona esta en la lista:
   - la linea de la cedula lo dice en rojo (sin motivo ni observaciones:
     decision de Pablo 14/07, ese detalle no es de nivel tienda), y
   - el boton "Agregar al reporte" queda deshabilitado.

   Esto es CORTESIA, no el control: si la red falla o alguien salta el
   front, el gate del servidor (submitIngreso, v5.74) rechaza igual.
   Por eso un error aca solo se anota en consola y no bloquea nada.
   Cache por cedula para no repetir consultas mientras escriben. */
const NR_CACHE = new Map();   // ced -> { blocked, full_name } (respuesta del check)
let NR_TIMER = null;
function nrLookup(ced, refresh) {
  if (!ced || NR_CACHE.has(ced)) return;   // ya se sabe: check() lo lee sincrono
  clearTimeout(NR_TIMER);
  NR_TIMER = setTimeout(async () => {
    try {
      const user = getSession();
      if (!user) return;
      const r = await fetch('/api/no-rehire', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'check', id_number: ced,
          user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null },
        }),
      }).then(x => x.json());
      if (r && r.ok) { NR_CACHE.set(ced, { blocked: !!r.blocked, full_name: r.full_name || null }); refresh(); }
    } catch (e) {
      // Cortesia fallida: el servidor bloquea igual en el envio.
      console.warn('Chequeo de no reempleable fallo (el servidor valida igual):', e);
    }
  }, 350);
}
const nrIsBlocked = ced => { const e = NR_CACHE.get(ced); return !!(e && e.blocked); };

/* ===== v5.78: ENCABEZADO FIJO + CARTEL DE NO REEMPLEABLE (mockup B) =====
   Mockup aprobado: _PRUEBAS\norehire_banner_mockup.html (variante B).
   El modal del alta pasa a tener el encabezado ("Nuevo ingreso (Alta)" +
   Accion/Data ID) SIEMPRE fijo arriba; el formulario scrollea por debajo.
   Cuando la cedula esta en la lista de no reempleables, el cartel rojo se
   inyecta DENTRO de ese bloque fijo (nombre oficial de la lista + cedula +
   mensaje) y el resto del formulario se atenua y bloquea, salvo la cedula,
   que sigue editable para corregirla. Si la corrigen, todo revive.
   OJO: sin escapes octales en este CSS (leccion de v5.13). */
let IG_STYLED = false;
function ensureIngresoCss() {
  if (IG_STYLED) return;
  IG_STYLED = true;
  const css = document.createElement('style');
  css.textContent = `
  .ig-modal{display:flex;flex-direction:column;padding:0 !important;overflow:hidden !important;max-height:88vh}
  .ig-mhead{flex:none;background:#fff;position:relative;z-index:5;box-shadow:0 4px 12px rgba(15,23,42,.07)}
  .ig-mhead h3{margin:0;padding:20px 26px 2px;padding-right:56px}
  /* v6.223 — la X la inyecta shared/wizard-close.js sobre .ig-mhead y su
     estilo (.wz-x) vive en panel.css, compartido con los otros wizards. */
  .ig-mhead .who{margin:0;padding:0 26px 12px}
  .ig-mbody{flex:1;min-height:0;overflow:auto;padding:16px 26px 24px}
  .ig-nrbanner{background:#fef2f2;border-top:1px solid #fecaca;border-bottom:2px solid #fca5a5;
    padding:12px 26px;display:flex;gap:13px;align-items:center}
  .ig-nrbanner .ico{flex:none;width:42px;height:42px;border-radius:50%;background:#fee2e2;
    border:1.5px solid #fca5a5;display:flex;align-items:center;justify-content:center;font-size:20px}
  .ig-nrbanner .tt{font-size:13px;font-weight:800;color:#991b1b;letter-spacing:.01em}
  .ig-nrbanner .nm{font-size:15px;font-weight:800;color:#7f1d1d;margin-top:1px}
  .ig-nrbanner .nm .ced{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:13px;
    background:#fee2e2;border:1px solid #fecaca;border-radius:7px;padding:1px 8px;margin-left:8px;
    color:#991b1b;vertical-align:1px}
  .ig-nrbanner .ms{font-size:12px;color:#b91c1c;margin-top:3px;line-height:1.5}
  .ig-dimmed{opacity:.45;pointer-events:none;user-select:none}`;
  document.head.appendChild(css);
}

async function loadCatalogs() {
  if (CAT) return CAT;
  const res = await fetch('/api/catalog', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'ingreso_catalogs' }),
  }).then(r => r.json()).catch(() => null);
  CAT = (res && res.ok) ? {
    cargos: res.cargos || [],
    bancos: res.bancos || [],
    operadoras: res.operadoras || [],
    docs: res.docs || [],
    docLimits: res.doc_limits || { max_file_mb: 2, max_total_mb: 20, allowed_ext: ['jpg','jpeg','png','pdf','doc','docx'] },
    win: res.window_config || { cutoff_time: '14:00', margin_days: 2, future_days: 7 },
    // v6.220 — dias de cierre de quincena donde no se admite fecha de
    // ingreso. Sin dato = apagado, que es como nace el parametro.
    ingresoBloqueo: res.ingreso_bloqueo || { dias: 0, rangos: [] },
    bankMap: Object.fromEntries((res.bancos || []).map(b => [b.code, b.name])),
    opMap: Object.fromEntries((res.operadoras || []).map(o => [o.code, o.name])),
  } : { cargos: [], bancos: [], operadoras: [], docs: [], docLimits: { max_file_mb: 2, max_total_mb: 20, allowed_ext: ['jpg','jpeg','png','pdf','doc','docx'] }, win: { cutoff_time: '14:00', margin_days: 2, future_days: 7 }, ingresoBloqueo: { dias: 0, rangos: [] }, bankMap: {}, opMap: {} };
  return CAT;
}

function cargoLabel(code) {
  const c = (CAT && CAT.cargos || []).find(x => x.code === code);
  return c ? c.label : code;
}

/* Ventana propia de Ingreso: margen hacia atras (con hora tope) + futuro.
   No usa ctx.win (atada a la quincena, sin futuro). */
function ingresoWindow() {
  const wc = (CAT && CAT.win) || { cutoff_time: '14:00', margin_days: 2, future_days: 7 };
  return DW.typeWindow({
    pastWindowDays: wc.margin_days,
    pastUsesCutoff: true,
    futureWindowDays: wc.future_days,
    cutoffTime: wc.cutoff_time,
  });
}

/* Error de la fecha de ingreso contra la ventana de Ingreso. */
function startDateError(date, win) {
  if (!date) return 'Falta la fecha de ingreso.';
  if (date > win.maxDate) return `No puede ser posterior al ${DW.fmtDate(win.maxDate)} (máx. ${win.futureWindowDays} días a futuro).`;
  if (win.minDate && date < win.minDate) {
    if (win.pastCutoff && win.oldestDay && date < DW.addDays(win.oldestDay, 1)) {
      return `El ${DW.fmtDate(win.oldestDay)} ya no se puede reportar: pasó la hora tope (${win.cutoffTime} hora Venezuela).`;
    }
    return `No puede ser anterior al ${DW.fmtDate(win.minDate)} (fuera del margen reportable).`;
  }
  /* v6.220 — CIERRE DE QUINCENA. Se avisa acá para que el gerente lo vea al
     escribir la fecha y no después de cargar ocho personas. El bloqueo real
     está en el servidor (submit_ingreso): esto es cortesía, no la reja.
     Los rangos vienen calculados del backend; el front no sabe -ni tiene por
     qué- dónde termina cada quincena. */
  const bl = bloqueoDe(date);
  if (bl) return bl;
  return null;
}

/* =====================================================================
   LIMITES DEL SELECTOR DE FECHA (v6.221).

   Un <input type="date"> nativo NO sabe deshabilitar dias sueltos: solo
   entiende min y max. No hay forma de agujerear el calendario entre el 13 y
   el 15 dejando el 16 habilitado — para eso habria que reemplazar el
   control por un calendario propio, que es mucho mas de lo que el problema
   pide.

   Lo que SI se puede, y es el caso mas frecuente, es cuando el rango
   bloqueado toca el BORDE de la ventana: si se admite hasta el 29 y el 29
   ya esta bloqueado, el tope baja al 28 y el dia directamente no aparece en
   el control. Igual del lado de abajo.

   Cuando el bloqueo queda en el MEDIO de la ventana, el calendario lo
   ofrece igual y ahi actua la segunda red: al elegirlo, la fecha se borra
   sola y queda el aviso. Es menos elegante que un dia gris, pero no deja
   pasar el dato.
   ===================================================================== */
function limMax(maxDate) {
  if (!maxDate) return '';
  const r = rangoDe(maxDate);
  return r ? DW.addDays(r.desde, -1) : maxDate;
}
function limMin(minDate) {
  if (!minDate) return '';
  const r = rangoDe(minDate);
  return r ? DW.addDays(r.hasta, 1) : minDate;
}
function rangoDe(date) {
  const cfg = CAT.ingresoBloqueo;
  if (!cfg || !cfg.dias || !Array.isArray(cfg.rangos)) return null;
  return cfg.rangos.find(x => date >= x.desde && date <= x.hasta) || null;
}

/* Si queda un cierre de quincena DENTRO de la ventana, se avisa antes de que
   la persona lo elija. El calendario nativo no lo puede tachar, asi que al
   menos que no sea una sorpresa al hacer clic. */
function avisoCierre(win) {
  const cfg = CAT.ingresoBloqueo;
  if (!cfg || !cfg.dias || !Array.isArray(cfg.rangos)) return '';
  const a = limMin(win.minDate), b = limMax(win.maxDate);
  const dentro = cfg.rangos.filter(r => r.hasta >= a && r.desde <= b);
  if (!dentro.length) return '';
  return ' <b>No se admite</b> ' + dentro
    .map(r => (r.desde === r.hasta
      ? `el ${DW.fmtDate(r.desde)}`
      : `del ${DW.fmtDate(r.desde)} al ${DW.fmtDate(r.hasta)}`))
    .join(' ni ') + ' (cierre de quincena).';
}

/* Devuelve el aviso si la fecha cae en un cierre de quincena, o null. */
function bloqueoDe(date) {
  const cfg = CAT.ingresoBloqueo;
  if (!cfg || !cfg.dias || !Array.isArray(cfg.rangos)) return null;
  const r = cfg.rangos.find(x => date >= x.desde && date <= x.hasta);
  if (!r) return null;
  return `Del ${DW.fmtDate(r.desde)} al ${DW.fmtDate(r.hasta)} no se admiten ingresos `
    + `(cierre de quincena). La primera fecha disponible es el ${DW.fmtDate(DW.addDays(r.hasta, 1))}.`;
}


/* Valida la cuenta: 20 digitos, prefijo en catalogo de bancos. */
function validAccount(raw) {
  const c = String(raw || '').replace(/[^0-9]/g, '');
  if (!c) return { ok: false, empty: true };
  if (c.length !== 20) return { ok: false, msg: `La cuenta debe tener 20 dígitos (van ${c.length}).` };
  const pre = c.slice(0, 4);
  if (!CAT.bankMap[pre]) return { ok: false, msg: `El prefijo ${pre} no corresponde a un banco válido.` };
  return { ok: true, account: c, bankCode: pre, bankName: CAT.bankMap[pre] };
}

/* Valida el telefono opcional: 11 digitos 04XX+7, prefijo en operadoras. */
function validPhone(raw) {
  const c = String(raw || '').replace(/[^0-9]/g, '');
  if (!c) return { ok: true, empty: true, intl: null };
  if (c.length !== 11 || c[0] !== '0') return { ok: false, msg: 'El teléfono debe tener 11 dígitos (04XX-XXXXXXX).' };
  const pre = c.slice(0, 4);
  if (!CAT.opMap[pre]) return { ok: false, msg: `Prefijo ${pre} inválido. Use ${Object.keys(CAT.opMap).join(', ')}.` };
  return { ok: true, op: CAT.opMap[pre], national: c, intl: '+58' + c.slice(1) };
}

function ageFrom(ymd) {
  if (!ymd) return null;
  const { ymd: today } = DW.nowVE();
  const t = today.split('-').map(Number), b = ymd.split('-').map(Number);
  let a = t[0] - b[0];
  if (t[1] < b[1] || (t[1] === b[1] && t[2] < b[2])) a--;
  return a;
}

/* ¿el alta quedo completa? (todos los obligatorios validos) */
function ingresoComplete(w) {
  const g = w.ingreso;
  if (!g) return false;
  if (!g.firstName || !g.lastNames || !g.cargoCode || !g.gender || !g.marital) return false;
  if (!g.birthDate || ageFrom(g.birthDate) < 18) return false;
  if (!validAccount(g.account).ok) return false;
  if (g.phone && !validPhone(g.phone).ok) return false;
  if (!g.startDate || startDateError(g.startDate, ingresoWindow())) return false;
  return true;
}

export const ingresoReport = {
  code: 'ingreso',
  title: 'Reportar Ingreso',
  icon: '➕',
  tag: 'Ingreso · wizard',
  step4Label: 'Ingresos',
  // Ingreso captura TODO en el paso 4 (la persona es nueva, no sale del
  // roster), asi que el wizard omite el paso 3 (Trabajadores).
  skipWorkerStep: true,

  summaryColumns: [
    { key: 'cargo', label: 'Cargo' },
    { key: 'edad', label: 'Edad' },
    { key: 'start', label: 'Fecha de ingreso' },
    { key: 'docs', label: 'Recaudos' },
    { key: 'kind', label: 'Acción' },
    { key: 'detalle', label: '' },
  ],
  summaryCell(w, key) {
    const g = w.ingreso || {};
    if (key === 'cargo') return g.cargoCode ? `<span class="pill pill-role">${cargoLabel(g.cargoCode)}</span>` : '—';
    if (key === 'edad') {
      const a = ageFrom(g.birthDate);
      return a == null ? '—' : `${a} años`;
    }
    if (key === 'start') return g.startDate ? DW.fmtDate(g.startDate) : '—';
    if (key === 'docs') {
      const total = (CAT && CAT.docs) ? CAT.docs.length : 0;
      if (!total) return '<span style="color:var(--muted)">—</span>';
      const n = (g.docs || []).filter(d => d.file_b64).length;
      if (n === 0) return `<span class="pill pill-pend">0/${total}</span>`;
      if (n === total) return `<span class="pill pill-set">📎 ${n}/${total}</span>`;
      return `<span class="pill pill-warn2">${n}/${total}</span>`;
    }
    if (key === 'kind') return '<span class="pill pill-set">A · Alta</span>';
    if (key === 'detalle') {
      // Boton que abre la ficha completa en solo-lectura. wizard-core
      // engancha el listener por delegacion (data-detail-ced), sin onclick
      // inline (la CSP del sitio bloquea los handlers inline).
      return `<button type="button" class="btn btn-sm" data-detail-ced="${w.ced}">👁 Ver detalle</button>`;
    }
    return '';
  },

  isComplete(w) { return ingresoComplete(w); },

  renderStep4(ctx) {
    $('#wzPanel').innerHTML = '<div class="pnl-loading">Cargando…</div>';
    loadCatalogs().then(() => paintStep4(ctx));
  },

  async submit({ companyCode, responsible, position, workers, source_kind, source_admin_id }) {
    const lines = workers.map(w => {
      const g = w.ingreso || {};
      return {
        id_number: w.ced,
        first_name: g.firstName,
        second_name: g.secondName || '',
        last_names: g.lastNames,
        cargo_code: g.cargoCode,
        birth_date: g.birthDate,
        gender: g.gender,
        marital_status: g.marital,
        account_number: g.account,
        email: g.email || '',
        // Se envia en NACIONAL (04XX-XXXXXXX). El server valida con su regla
        // nacional (11 digitos, empieza en 0) y normaliza a +58 al guardar.
        // Enviar phoneIntl (+58) rompia la cuenta de digitos del server.
        phone: g.phone || '',
        address: g.address || '',
        start_date: g.startDate,
        // Recaudos adjuntos de esta persona. Cada uno: required_doc_id +
        // archivo (nombre/base64/tipo). Los que el server no reciba con
        // archivo quedan 'pendiente'. El archivo NO se persiste: viaja a
        // osTicket como ticket DOC.
        docs: (g.docs || []).map(d => ({
          required_doc_id: d.required_doc_id,
          file_name: d.file_name || null,
          file_b64: d.file_b64 || null,
          file_type: d.file_type || null,
        })),
      };
    });
    const res = await fetch('/api/reports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'submit_ingreso',
        company_code: companyCode,
        responsible, position,
        lines,
        source_kind, source_admin_id,
      }),
    });
    const out = await res.json();

    // v6.108/#2: los recaudos que el servidor dejo 'pending' (para no pasar el
    // limite de subrequests de Cloudflare) se envian por TANDAS, cada una en su
    // propia invocacion. El archivo lo tenemos localmente en `lines`.
    if (out && out.ok && Array.isArray(out.pending_docs) && out.pending_docs.length) {
      const kced = v => String(v || '').replace(/\D/g, '');   // el server guarda la cédula solo con dígitos
      const fileMap = {};
      lines.forEach(w => (w.docs || []).forEach(d => {
        if (d.file_b64) fileMap[`${kced(w.id_number)}|${d.required_doc_id}`] = d;
      }));
      out.osticket = out.osticket || { tickets_ok: 0, tickets_fail: 0, errors: [] };
      const BATCH = 12;
      const pend = out.pending_docs;
      for (let i = 0; i < pend.length; i += BATCH) {
        const chunk = pend.slice(i, i + BATCH).map(pd => {
          const f = fileMap[`${kced(pd.worker_id)}|${pd.required_doc_id}`] || {};
          return {
            piece: pd.piece, worker_id: pd.worker_id, ced_kind: pd.ced_kind, worker_name: pd.worker_name,
            doc_name: pd.doc_name, file_b64: f.file_b64 || null, file_name: f.file_name || null, file_type: f.file_type || null,
          };
        });
        let r2 = null;
        try {
          r2 = await fetch('/api/reports', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'send_ingreso_docs',
              company_code: companyCode,
              report_id: out.report_id,
              total_pieces: out.total_pieces,
              docs: chunk,
              source_kind, source_admin_id,
            }),
          }).then(x => x.json());
        } catch (_) { r2 = null; }
        if (r2 && r2.ok) {
          out.osticket.tickets_ok += r2.tickets_ok || 0;
          out.osticket.tickets_fail += r2.tickets_fail || 0;
          if (Array.isArray(r2.errors)) out.osticket.errors.push(...r2.errors);
        } else {
          out.osticket.tickets_fail += chunk.length;
          out.osticket.errors.push(`No se pudo enviar una tanda de ${chunk.length} documento(s).`);
        }
      }
    }
    return out;
  },
};

/* ===================== PASO 4 ===================== */

function paintStep4(ctx) {
  const win = ingresoWindow();
  const panel = $('#wzPanel');
  panel.innerHTML = `
    <h2>Trabajadores que ingresan</h2>
    <p class="hint">Un ingreso es una persona <b>nueva</b>. Agrégala con el botón y completa sus datos. La acción es siempre <b>Alta (A)</b>, el <b>Data ID</b> lo toma la empresa y no se permiten menores de 18 años.</p>
    <div class="window-info"><span class="wi-ico">⏱</span><div>${windowTextIngreso(win)}</div></div>

    <div class="progress-line">
      <span id="igProg">0 de 0 listos para enviar</span>
      <div class="progress-bar"><div id="igProgBar" style="width:0%"></div></div>
    </div>

    <!-- v6.238 — La eleccion vive ACA y no dentro del modal. Antes se
         preguntaba al abrir y se recordaba toda la sesion: quien elegia "a
         mano" no volvia a ver la pregunta nunca y no habia forma de cambiar
         de idea. Siendo dos botones, la decision es parte de la accion: esta
         siempre a la vista, se elige distinto en cada persona y no hay un
         paso extra dentro del formulario. -->
    <div class="ig-add">${(CAT && CAT.docs && CAT.docs.length) ? `
      <button class="btn btn-primary" id="igAdd">＋ Agregar con documentos</button>
      <button class="btn" id="igAddManual">＋ Agregar a mano</button>
      <span class="ig-add-h">Con el RIF y la referencia bancaria se completan la cédula, la dirección y la cuenta.</span>`
      : `<button class="btn btn-primary" id="igAddManual">＋ Agregar ingreso</button>`}
      <span style="flex:1"></span>
      <span style="font-size:12px;color:var(--muted)" id="igCount">0 ingresos</span>
    </div>

    <table id="igTbl" style="display:none"><thead><tr>
      <th>Trabajador</th><th>Cédula</th><th>Cargo</th><th>Edad</th><th>Fecha ingreso</th><th>Recaudos</th><th>Acción</th><th style="width:120px"></th>
    </tr></thead><tbody id="igBody"></tbody></table>
    <div class="empty" id="igEmpty">${(CAT && CAT.docs && CAT.docs.length)
      ? 'Aún no has agregado ningún ingreso. Empezá con “＋ Agregar con documentos” si el trabajador ya trajo sus papeles.'
      : 'Aún no has agregado ningún ingreso. Usa “＋ Agregar ingreso”.'}</div>

    <div class="wiz-foot">
      <button class="btn" id="igBack">← Atrás</button>
      <button class="btn btn-primary" id="igNext" disabled>Revisar y enviar →</button>
    </div>`;

  { const b = $('#igAdd'); if (b) b.addEventListener('click', () => openIngresoModal(ctx, null, 'papeles')); }
  $('#igAddManual').addEventListener('click', () => openIngresoModal(ctx, null, 'manual'));
  $('#igBack').addEventListener('click', () => ctx.setStep(ctx.stepBefore4 || 2));
  $('#igNext').addEventListener('click', () => ctx.setStep(5));

  renderRows(ctx);
}

/* Texto de ventana propio (incluye futuro). */
function windowTextIngreso(win) {
  let t = `Hoy es <b>${DW.fmtDate(win.today)}</b>. La fecha de ingreso admite del <b>${DW.fmtDate(win.minDate)} al ${DW.fmtDate(win.maxDate)}</b>`;
  if (win.futureWindowDays > 0) t += ` (${win.futureWindowDays} días a futuro)`;
  t += '.';
  if (!win.pastCutoff && win.oldestDay) {
    t += ` El día más antiguo (<b>${DW.fmtDate(win.oldestDay)}</b>) solo se admite <b>hasta las ${DW.fmtClock(win.cutoffTime)} (hora Venezuela)</b>.`;
  } else if (win.pastCutoff && win.oldestDay) {
    t += ` (Ya pasó la hora tope de hoy, por eso el ${DW.fmtDate(win.oldestDay)} ya no está disponible.)`;
  }
  return t;
}

function updateNext(ctx) {
  const total = ctx.workers.length;
  const done = ctx.workers.filter(ingresoComplete).length;
  const btn = $('#igNext');
  if (btn) btn.disabled = !(total > 0 && done === total);
  const prog = $('#igProg');
  if (prog) prog.textContent = `${done} de ${total} listos para enviar`;
  const bar = $('#igProgBar');
  if (bar) bar.style.width = total ? (done / total * 100) + '%' : '0%';
  const cnt = $('#igCount');
  if (cnt) cnt.textContent = total + (total === 1 ? ' ingreso' : ' ingresos');
}

function renderRows(ctx) {
  // Mantener la lista del reporte accesible para el boton "Ver detalle" del
  // Resumen (que pinta wizard-core en otra fase).
  LAST_WORKERS = ctx.workers || [];
  const tb = $('#igBody');
  if (!tb) return;
  $('#igEmpty').style.display = ctx.workers.length ? 'none' : 'block';
  $('#igTbl').style.display = ctx.workers.length ? 'table' : 'none';

  tb.innerHTML = ctx.workers.map(w => {
    const g = w.ingreso || {};
    const ok = ingresoComplete(w);
    const age = ageFrom(g.birthDate);
    const cedTxt = w.ced ? `${g.cedKind || 'V'}-${w.ced}` : '—';
    const ageCell = age == null ? '<span class="pill pill-pend">falta</span>'
      : (age < 18 ? `<span class="pill pill-pend">${age} (menor)</span>` : `<span style="color:#15803d;font-weight:600">${age} años</span>`);
    const startCell = g.startDate
      ? (startDateError(g.startDate, ingresoWindow()) ? '<span class="pill pill-pend">revisar</span>' : `<span class="date-badge">${DW.fmtDate(g.startDate)}</span>`)
      : '<span class="pill pill-pend">pendiente</span>';
    const totalDocs = (CAT && CAT.docs) ? CAT.docs.length : 0;
    const nDocs = (g.docs || []).filter(d => d.file_b64).length;
    const docsCell = !totalDocs ? '<span style="color:var(--muted)">—</span>'
      : (nDocs === 0 ? `<span class="pill pill-pend">0/${totalDocs}</span>`
        : (nDocs === totalDocs ? `<span class="pill pill-set">📎 ${nDocs}/${totalDocs}</span>`
          : `<span class="pill pill-warn2">${nDocs}/${totalDocs}</span>`));
    return `<tr class="${ok ? 'done-row' : ''}">
      <td><b>${w.name || '—'}</b></td>
      <td class="ced">${cedTxt}</td>
      <td>${g.cargoCode ? `<span class="pill pill-role">${cargoLabel(g.cargoCode)}</span>` : '—'}</td>
      <td>${ageCell}</td>
      <td>${startCell}</td>
      <td>${docsCell}</td>
      <td><span class="pill pill-set">A · Alta</span></td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm" data-cfg="${w.id}">${ok ? '✏️ Editar' : '＋ Completar'}</button>
        <button class="x-btn" data-rm="${w.id}" title="Quitar">✕</button>
      </td>
    </tr>`;
  }).join('');

  tb.querySelectorAll('[data-cfg]').forEach(b => b.addEventListener('click', () => openIngresoModal(ctx, +b.dataset.cfg)));
  tb.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
    const w = ctx.getWorker(+b.dataset.rm);
    if (w && !confirm(`¿Quitar a ${w.name || 'este ingreso'} del reporte?`)) return;
    ctx.removeWorker(+b.dataset.rm);
    renderRows(ctx); updateNext(ctx);
  }));

  updateNext(ctx);
}

/* ---------- MODAL: alta / edicion de un ingreso ---------- */
function openIngresoModal(ctx, id, modo) {
  ensureIngresoCss();   // v5.78: encabezado fijo + cartel de no reempleable
  const win = ingresoWindow();
  const existing = id ? ctx.getWorker(id) : null;
  // Si el worker llego del paso 3 (cedula + nombre) y aun no tiene datos de
  // ingreso, precargamos los nombres dividiendo el nombre escrito alli:
  // ultima palabra = apellidos, el resto = primer/segundo nombre.
  let g = (existing && existing.ingreso) ? existing.ingreso : {};
  if (existing && !existing.ingreso && existing.name) {
    const parts = String(existing.name).trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 3) g = { firstName: parts[0], secondName: parts[1], lastNames: parts.slice(2).join(' ') };
    else if (parts.length === 2) g = { firstName: parts[0], secondName: '', lastNames: parts[1] };
    else if (parts.length === 1) g = { firstName: parts[0], secondName: '', lastNames: '' };
  }
  const companyLabel = ctx.companyCode || '';

  const GEN = [['M', 'M – Masculino'], ['F', 'F – Femenino']];
  const CIV = [['S', 'S – Soltero/a'], ['C', 'C – Casado/a'], ['D', 'D – Divorciado/a'], ['V', 'V – Viudo/a']];
  const opt = (arr, cur) => `<option value="" ${!cur ? 'selected' : ''} disabled>— Seleccionar —</option>` +
    arr.map(o => `<option value="${o[0]}" ${cur === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('');
  const cargoOpts = `<option value="" ${!g.cargoCode ? 'selected' : ''} disabled>— Seleccionar —</option>` +
    (CAT.cargos || []).map(c => `<option value="${c.code}" ${g.cargoCode === c.code ? 'selected' : ''}>${c.label}</option>`).join('');
  const { ymd: today } = DW.nowVE();

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal modal-wide ig-modal">
      <div class="ig-mhead">
        <h3>${id ? 'Editar ingreso' : 'Nuevo ingreso (Alta)'}</h3>
        <p class="who">Acción <span class="pill pill-set">A · Alta</span> · Data ID <b>${companyLabel}</b> (automático, de la empresa)</p>
        <div id="ig_nrslot"></div>
      </div>
      <div class="ig-mbody">

      <div class="ig-band" data-nrdim>
        <div class="ig-band-t">📅 Fecha inicial de empleo <span style="color:var(--danger)">*</span></div>
        <input type="date" id="ig_start" min="${limMin(win.minDate)}" max="${limMax(win.maxDate)}" value="${g.startDate || ''}">
        <div class="date-err" id="e_start" style="color:var(--danger);font-size:12px;min-height:15px;margin-top:5px"></div>
        <div class="hint" style="margin-top:4px">Dato principal del reporte. Admite del ${DW.fmtDate(limMin(win.minDate))} al ${DW.fmtDate(limMax(win.maxDate))}.${avisoCierre(win)}</div>
      </div>

      <div class="ig-sec" data-nrdim>Identidad</div>
      <div class="grid2" data-nrdim>
        <div><label class="flabel">Primer nombre <span style="color:var(--danger)">*</span></label><input id="ig_first" value="${esc(g.firstName)}" placeholder="JUAN"><div class="ferr" id="e_first"></div></div>
        <div><label class="flabel">Segundo nombre <span class="opt">(opcional)</span></label><input id="ig_second" value="${esc(g.secondName)}" placeholder="CARLOS"><div class="ferr"></div></div>
      </div>
      <div data-nrdim style="margin-top:12px"><label class="flabel">Apellidos <span style="color:var(--danger)">*</span></label><input id="ig_last" value="${esc(g.lastNames)}" placeholder="PÉREZ GARCÍA"><div class="ferr" id="e_last"></div></div>
      <div class="grid2" style="margin-top:12px">
        <div><label class="flabel">Cédula (Nro Personal) <span style="color:var(--danger)">*</span></label><input id="ig_ced" value="${existing ? existing.ced : ''}" placeholder="12345678" inputmode="numeric"><div class="ig-line" id="e_ced"></div></div>
        <div data-nrdim><label class="flabel">Cargo <span style="color:var(--danger)">*</span></label><select id="ig_cargo">${cargoOpts}</select><div class="ferr" id="e_cargo"></div></div>
      </div>
      <div class="grid2" data-nrdim style="margin-top:12px">
        <div><label class="flabel">Fecha de nacimiento <span style="color:var(--danger)">*</span></label><input type="date" id="ig_birth" max="${today}" value="${g.birthDate || ''}"><div class="ferr" id="e_birth"></div></div>
        <div><label class="flabel">Edad <span class="opt">(calculada)</span></label><div class="ig-readonly" id="ig_age">—</div></div>
      </div>

      <div class="ig-sec" data-nrdim>Datos personales y bancarios</div>
      <div class="grid2" data-nrdim>
        <div><label class="flabel">Género <span style="color:var(--danger)">*</span></label><select id="ig_gender">${opt(GEN, g.gender)}</select><div class="ferr" id="e_gender"></div></div>
        <div><label class="flabel">Estado civil <span style="color:var(--danger)">*</span></label><select id="ig_marital">${opt(CIV, g.marital)}</select><div class="ferr" id="e_marital"></div></div>
      </div>
      <div data-nrdim style="margin-top:12px"><label class="flabel">Nro cuenta bancaria <span style="color:var(--danger)">*</span> <span class="opt">(20 dígitos)</span></label>
        <input id="ig_account" value="${esc(g.account)}" placeholder="0134 0123 45 0001234567" inputmode="numeric"><div class="ig-line" id="ig_bankline"></div><div class="ferr" id="e_account"></div></div>

      <div class="ig-sec" data-nrdim>Contacto</div>
      <div class="grid2" data-nrdim>
        <div><label class="flabel">Correo <span class="opt">(opcional)</span></label><input id="ig_email" value="${esc(g.email)}" placeholder="nombre@correo.com"><div class="ferr" id="e_email"></div></div>
        <div><label class="flabel">Teléfono móvil <span class="opt">(opcional)</span></label><input id="ig_phone" value="${esc(g.phone)}" placeholder="0414-1234567" inputmode="numeric"><div class="ig-line" id="ig_phoneline"></div><div class="ferr" id="e_phone"></div></div>
      </div>
      <div data-nrdim style="margin-top:12px"><label class="flabel">Dirección <span class="opt">(opcional)</span></label><input id="ig_address" value="${esc(g.address)}" placeholder="Calle, sector, ciudad"><div class="ferr"></div></div>

      ${(CAT.docs && CAT.docs.length) ? `
      <div id="ig_docblock">
      <div class="ig-sec">Recaudos del trabajador <span class="opt">(opcionales)</span></div>
      <div id="ig_docnote"></div>
      <p class="hint" style="margin:-4px 0 8px">Adjunta lo que tengas; los que falten quedan como <b>pendientes</b> en el ticket. Máx. ${CAT.docLimits.max_file_mb} MB por archivo (${CAT.docLimits.allowed_ext.join(', ')}).</p>
      <div id="ig_docs"></div>
      </div>` : ''}

      <div class="wiz-foot" style="margin-top:18px">
        <button class="btn" id="ig_cancel">Cancelar</button>
        <button class="btn btn-primary" id="ig_save" disabled>${id ? 'Guardar cambios' : 'Agregar al reporte'}</button>
      </div>
      </div>
      <input type="file" id="ig_file" hidden accept=".jpg,.jpeg,.png,.pdf,.doc,.docx,image/*">
    </div>`;
  document.body.appendChild(ov);

  const q = s => ov.querySelector(s);
  const saveB = q('#ig_save');

  /* ---- Recaudos (adjuntos por trabajador) ----
     Estado local: docState[required_doc_id] = { file_name, file_b64, file_type }.
     Se precarga de g.docs al editar. El archivo se lee a base64 en el momento
     de elegirlo (no se sube a Storage): viaja en el submit hacia osTicket. */
  const CATDOCS = CAT.docs || [];
  const LIM = CAT.docLimits || { max_file_mb: 2, allowed_ext: ['jpg','jpeg','png','pdf','doc','docx'] };
  const docState = {};
  (g.docs || []).forEach(d => {
    if (d && d.required_doc_id) docState[d.required_doc_id] = {
      file_name: d.file_name || null, file_b64: d.file_b64 || null, file_type: d.file_type || null,
      brf: d.brf || null,
    };
  });

  /* ---- Referencia bancaria validada en el alta (v6.231) --------------
     Hasta ahora el PDF del banco viajaba como adjunto del ticket y no
     quedaba en el portal: cuando la persona entraba al maestro, su ficha
     nacia sin referencia y alguien tenia que volver a pedirsela. Ademas el
     ingreso solo miraba peso y extension, asi que un PDF de otra persona
     entraba sin que nadie lo notara -y esa es exactamente la via por la que
     el mismo documento de un tercero termino cargado para dos trabajadores
     de CB02-.

     Se reusan las piezas de bank-ref-ficha.js (extractText/parseFields/
     evaluate) en vez de reimplementarlas. Duplicar el parser habria sido
     garantizar que en unos meses la ficha y el ingreso opinen distinto sobre
     el mismo archivo, que es el problema que esta fase vino a cerrar.

     Se compara contra lo que la tienda ACABA de escribir en el formulario
     (cedula y cuenta), no contra el maestro: la persona todavia no existe.
     Import dinamico para no cargar pdfjs en cada ingreso, solo cuando de
     verdad adjuntan una referencia. */
  const NLX = String.fromCharCode(10);
  const BRF_KIND = 'bank_reference';
  const esRefBancaria = (d) => d && d.doc_kind === BRF_KIND;

  /* El PDF se parsea UNA vez; la evaluacion se repite cada vez que cambia la
     cedula o la cuenta del formulario. En la v6.231 se evaluaba solo al
     adjuntar, y con el formulario todavia vacio el resultado quedaba
     congelado: mostraba 'Coincide con los datos cargados' sin que hubiera
     nada cargado con que coincidir. */
  let BRFMOD = null, RIFMOD = null;

  async function validarRef(docId, file) {
    const st = docState[docId];
    if (!st) return;
    st.brf = { estado: 'leyendo' };
    renderDocs();
    try {
      BRFMOD = BRFMOD || await import('../views/bank-ref-ficha.js');
      const texto = await BRFMOD.extractText(await file.arrayBuffer());
      st.brf = { estado: 'pend', campos: BRFMOD.parseFields(texto, CAT.bankMap || {}) };
      evaluarRef(docId);
    } catch (e) {
      /* Un PDF escaneado, protegido o sin texto no puede frenar un alta: el
         recaudo se adjunta igual y queda para revisar desde la ficha. */
      st.brf = { estado: 'nolegible', mensaje: 'No se pudo leer el PDF para verificarlo. Se adjunta igual y queda para revisar.' };
      renderDocs();
    }
  }

  function evaluarRef(docId) {
    const st = docState[docId];
    if (!st || !st.brf || !st.brf.campos || !BRFMOD) return;
    const c = st.brf.campos;
    const cedV = DW.validateCedula(q('#ig_ced').value);
    const accV = validAccount(q('#ig_account').value);

    /* Sin cedula escrita no hay contra que verificar. Decirlo es mejor que
       mostrar un tilde verde que no significa nada: apenas la escriban, esto
       se re-evalua solo. */
    /* Se exige la cedula COMPLETA y valida, no cualquier digito suelto: si se
       comparara mientras la tipean, una cedula del PDF mas corta coincidiria
       a mitad de camino y el campo se bloquearia antes de que terminen. */
    if (!cedV.ok) {
      st.brf.estado = 'pend';
      st.brf.mensaje = 'Escribí la cédula del trabajador para poder verificar que la referencia sea suya.';
      bloquearCampos(false);
      renderDocs(); return;
    }

    const nombre = [q('#ig_first').value, q('#ig_second').value, q('#ig_last').value]
      .map(x => x.trim()).filter(Boolean).join(' ').toUpperCase();
    const ev = BRFMOD.evaluate(c, { id_number: cedV.ced, full_name: nombre },
      accV.account || '', CAT.bankMap || {});
    const err = ev.warnings.find(w => w.level === 'err');
    const warn = ev.warnings.find(w => w.level === 'warn');

    /* AUTOCOMPLETADO — y por que NO se autocompleta la cedula.
       Copiar la cuenta del PDF al formulario ahorra tipear 20 digitos, que es
       justo donde se cometen los errores. Pero cualquier dato que copiemos
       deja de servir como verificacion: si llenaramos la cedula desde el PDF,
       la comparacion seria el PDF contra si mismo y daria verde SIEMPRE. El
       caso de CB02 -el PDF de MANUEL MENDOZA cargado para dos personas- se
       habria dado por bueno, y ademas habria dado de alta a esos dos
       trabajadores con la cedula de Mendoza.
       Por eso: la cedula la escribe la persona y es la evidencia; la cuenta se
       copia SOLO despues de que esa evidencia dio positivo. */
    if (ev.cedOk && !st.brf.autollenado) {
      const full = c.cuenta ? String(c.cuenta).replace(/\D/g, '') : '';
      if (full.length === 20) {
        q('#ig_account').value = full;
        st.brf.autollenado = true;
        showBank(); check();
      }
      // Mercantil enmascara la cuenta (solo ***1234): no hay 20 digitos que
      // copiar y el campo queda como estaba, para que lo completen a mano.
    }
    bloquearCampos(ev.cedOk);

    const accV2 = validAccount(q('#ig_account').value);
    const ev2 = (st.brf.autollenado || accV2.account !== (accV.account || ''))
      ? BRFMOD.evaluate(c, { id_number: cedV.ced, full_name: nombre }, accV2.account || '', CAT.bankMap || {})
      : ev;

    st.brf.estado = err ? 'err' : (warn ? 'warn' : 'ok');
    st.brf.validaciones = ev2.validaciones;
    st.brf.mensaje = (err || warn) ? (err || warn).text : mensajeOk(ev2, st.brf.autollenado);
    renderDocs();
  }

  /* La referencia se vuelve a juzgar cada vez que cambia la cedula o la
     cuenta. Sin esto el orden en que llenan el formulario decide el
     resultado, que es la peor forma de que una validacion sea inestable. */
  function revalidarRef() {
    CATDOCS.filter(esRefBancaria).forEach(d => {
      const st = docState[d.id];
      if (st && st.brf && st.brf.campos) evaluarRef(d.id);
    });
  }

  /* El mensaje dice QUE coincidio, no un generico. En la v6.231 decia
     'Coincide con los datos cargados en el formulario' aunque el unico dato
     cargado fuera la cedula y la cuenta estuviera vacia. */
  function mensajeOk(ev, autollenado) {
    if (autollenado) return 'La cédula coincide con el PDF. La cuenta se completó desde la referencia.';
    if (ev.cedOk && ev.cuentaEsSuya) return 'La cédula y la cuenta coinciden con el PDF.';
    if (ev.cedOk) return 'La cédula coincide con el PDF.';
    return 'La cuenta del PDF es la del trabajador.';
  }

  /* Verificado el documento, cedula y cuenta quedan de solo lectura. No es
     cosmetico: sin esto alguien puede validar con la cedula correcta y
     cambiarla despues, y el reporte sale con el tilde verde y otra cedula.
     Se usa readOnly y no disabled para que el valor siga viajando en el envio. */
  function bloquearCampo(sel, on, motivo) {
    const el = q(sel);
    if (!el) return;
    el.readOnly = !!on;
    el.classList.toggle('ig-locked', !!on);
    el.title = on ? `${motivo} Quitá el documento para editarlo.` : '';
  }
  /* La cedula la fija el RIF y la cuenta la referencia: son documentos
     distintos y se quitan por separado, asi que no pueden compartir un solo
     interruptor. */
  function bloquearCampos(on) {
    bloquearCampo('#ig_account', on, 'Verificado con la referencia bancaria.');
    if (!docRif()) bloquearCampo('#ig_ced', on, 'Verificado con la referencia bancaria.');
  }

  /* Al quitar el PDF se devuelve el control: ambos campos se reabren y la
     cuenta se vacia, porque su unica fuente era el documento que se quito.
     La cedula se respeta: la escribio la persona, no la dedujimos nosotros. */
  function soltarRef(docId) {
    const st = docState[docId];
    if (st && st.brf && st.brf.autollenado) { q('#ig_account').value = ''; showBank(); }
    bloquearCampos(false);
    check();
  }

  function brfHtml(d, st) {
    if (!esRefBancaria(d) || !st || !st.brf) return '';
    const b = st.brf;
    if (b.estado === 'leyendo') return `<div class="igbrf">Leyendo el PDF…</div>`;
    const cls = { ok: 'ok', warn: 'wrn', err: 'err', nolegible: '', pend: '' }[b.estado] || '';
    const ic  = { ok: '✓', warn: '⚠', err: '✕', nolegible: 'ℹ', pend: 'ℹ' }[b.estado] || 'ℹ';
    const c = b.campos || {};
    const datos = (b.estado === 'ok' || b.estado === 'warn' || b.estado === 'pend') ? `<div class="igbrf-x">
      ${c.banco_nombre ? `<span>Banco <b>${esc(c.banco_nombre)}</b></span>` : ''}
      ${c.cuenta_last4 ? `<span>Cuenta <b>···${esc(c.cuenta_last4)}</b></span>` : ''}
      ${c.nombre_pdf ? `<span>A nombre de <b>${esc(c.nombre_pdf)}</b></span>` : ''}
      ${c.cedula_pdf ? `<span>C.I. <b>${esc(c.cedula_pdf)}</b></span>` : ''}
    </div>` : '';
    return `<div class="igbrf ${cls}"><b>${ic}</b> ${esc(b.mensaje)}${datos}</div>`;
  }

  /* ================= RIF / planilla del SENIAT en el alta (v6.236) =======
     El RIF de persona natural CONTIENE la cedula (V-27800995-1) y se lee en
     585 de 585 documentos. Eso da vuelta el orden del formulario: hasta ahora
     habia que escribir la cedula antes de adjuntar la referencia bancaria
     -es el dato contra el que se verifica-; empezando por el RIF ya no.

     QUE SE COMPLETA Y QUE NO. Se llenan solo los campos VACIOS: lo que la
     persona ya escribio no se pisa nunca. La cedula ademas se bloquea.

     EL NOMBRE ES EL CASO DELICADO. El certificado comun lo trae en una sola
     linea y el SENIAT a veces pone los apellidos adelante: partirlo por
     posicion acierta 65% (medido sobre 475 personas). Un nombre mal partido
     no es un ahorro, es una correccion mas dos campos que revisar, y encima
     erosiona la confianza en todo lo demas que si esta bien. Asi que del
     certificado el nombre se MUESTRA para copiar y no se rellena.
     La planilla es otra historia: trae Apellidos y Nombres etiquetados por
     separado, sin ambiguedad, y ahi si se completan. */
  const RIF_KIND = 'rif';
  const esRif = (d) => d && d.doc_kind === RIF_KIND;
  const docRif = () => CATDOCS.filter(esRif).map(d => docState[d.id])
    .find(st => st && st.rif && st.rif.campos) || null;

  const ISO = (dmy) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dmy || ''));
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  };
  const CIVIL = { SOLTERO: 'S', SOLTERA: 'S', CASADO: 'C', CASADA: 'C',
    DIVORCIADO: 'D', DIVORCIADA: 'D', VIUDO: 'V', VIUDA: 'V' };

  async function validarRif(docId, file) {
    const st = docState[docId];
    if (!st) return;
    st.rif = { estado: 'leyendo' };
    renderDocs();
    try {
      RIFMOD = RIFMOD || await import('../views/rif-ficha.js');
      const campos = RIFMOD.parseRif(await RIFMOD.extractText(await file.arrayBuffer()));
      if (!campos || !campos.es_rif) {
        st.rif = { estado: 'nolegible', mensaje: 'No parece un RIF ni una planilla del SENIAT. Se adjunta igual.' };
        renderDocs(); return;
      }
      const puestos = aplicarRif(campos);
      st.rif = { estado: campos.provisional ? 'warn' : 'ok', campos, puestos,
        mensaje: campos.provisional
          ? 'Es la planilla de actualización, no el RIF definitivo. Sirve para el alta, pero hay 30 días para traer el RIF.'
          : (puestos.length ? `Completamos ${puestos.length} ${puestos.length === 1 ? 'campo' : 'campos'}.` : 'Leído. Los datos ya estaban cargados.') };
    } catch (e) {
      st.rif = { estado: 'nolegible', mensaje: 'No se pudo leer el PDF. Se adjunta igual y queda para revisar.' };
    }
    renderDocs();
    revalidarRef();   // la referencia se re-juzga contra la cedula que trajo el RIF
  }

  /* Llena SOLO lo vacio y devuelve que lleno, para poder decirlo. */
  function aplicarRif(c) {
    const hechos = [];
    const poner = (sel, val, etiqueta) => {
      const el = q(sel);
      if (!el || !val) return;
      if (String(el.value || '').trim()) return;   // ya habia algo: no se pisa
      el.value = val; hechos.push(etiqueta);
    };

    if (c.cedula_rif && !String(q('#ig_ced').value || '').trim()) {
      q('#ig_ced').value = c.cedula_rif;
      hechos.push('cédula');
      showCed(); applyNrState();
      const v = DW.validateCedula(c.cedula_rif);
      if (v.ok) nrLookup(v.ced, () => { if (ov.isConnected) { showCed(); check(); applyNrState(); } });
    }
    if (c.cedula_rif) bloquearCampo('#ig_ced', true, 'Tomada del RIF.');

    // Solo la planilla trae apellidos y nombres separados.
    if (c.apellidos_pdf) poner('#ig_last', c.apellidos_pdf, 'apellidos');
    if (c.nombres_pdf) {
      const n = String(c.nombres_pdf).split(/\s+/);
      poner('#ig_first', n[0], 'primer nombre');
      if (n[1]) poner('#ig_second', n.slice(1).join(' '), 'segundo nombre');
    }
    poner('#ig_address', c.domicilio_fiscal, 'dirección');
    poner('#ig_email', c.correo, 'correo');
    poner('#ig_phone', c.telefono, 'teléfono');
    if (c.fecha_nacimiento) poner('#ig_birth', ISO(c.fecha_nacimiento), 'fecha de nacimiento');

    const selPoner = (sel, val, etiqueta) => {
      const el = q(sel);
      if (!el || !val || el.value) return;
      if ([...el.options].some(o => o.value === val)) { el.value = val; hechos.push(etiqueta); }
    };
    selPoner('#ig_gender', c.sexo, 'género');
    selPoner('#ig_marital', CIVIL[String(c.estado_civil || '').toUpperCase()], 'estado civil');

    showPhone(); showAge(); check();
    return hechos;
  }

  /* Al quitar el RIF se libera la cedula. Lo demas se deja: si alguien lo
     reviso o corrigio, borrarselo seria peor que dejar un dato de mas. */
  function soltarRif() {
    bloquearCampo('#ig_ced', false, '');
    check();
  }

  function rifHtml(d, st) {
    if (!esRif(d) || !st || !st.rif) return '';
    const b = st.rif;
    if (b.estado === 'leyendo') return `<div class="igbrf">Leyendo el PDF…</div>`;
    const cls = { ok: 'ok', warn: 'wrn', nolegible: '' }[b.estado] || '';
    const ic  = { ok: '✓', warn: '⚠', nolegible: 'ℹ' }[b.estado] || 'ℹ';
    const c = b.campos || {};
    let extra = '';
    if (c.cedula_rif) {
      extra += `<div class="igbrf-x">
        <span>C.I. <b>${esc(c.cedula_rif)}</b></span>
        ${c.rif ? `<span>RIF <b>${esc(c.rif)}</b></span>` : ''}
        ${c.fecha_vencimiento ? `<span>Vence <b>${esc(c.fecha_vencimiento)}</b></span>` : ''}
      </div>`;
    }
    /* Del certificado el nombre se muestra para copiar, no se rellena: ver
       el comentario de arriba sobre el 65%. */
    if (c.nombre_pdf && !c.apellidos_pdf) {
      extra += `<div class="igbrf-nom">El RIF dice <b>${esc(c.nombre_pdf)}</b>.
        No lo separamos en nombres y apellidos porque el SENIAT a veces los
        invierte y preferimos que lo hagas vos.</div>`;
    }
    return `<div class="igbrf ${cls}"><b>${ic}</b> ${esc(b.mensaje)}${extra}</div>`;
  }

  function renderDocs() {
    const box = q('#ig_docs');
    if (!box) return;
    box.innerHTML = CATDOCS.map(d => {
      const st = docState[d.id];
      const has = st && st.file_b64;
      const right = has
        ? `<span class="file-pill">📎 ${esc(st.file_name)} <span class="x" data-clr="${d.id}" title="Quitar">✕</span></span>
           <button type="button" class="btn btn-sm" data-pick="${d.id}">Cambiar</button>`
        : `<button type="button" class="btn btn-sm btn-primary" data-pick="${d.id}">📎 Adjuntar</button>`;
      return `<div class="docrow">
        <span class="docrow-name">📄 ${esc(d.name)}</span>
        <span class="docrow-act">${right}</span>
      </div>${brfHtml(d, st)}${rifHtml(d, st)}`;
    }).join('') +
      `<div class="docrow-foot" id="ig_docs_foot"></div>`;
    updateDocsFoot();
    box.querySelectorAll('[data-pick]').forEach(b =>
      b.addEventListener('click', () => pickFor(+b.dataset.pick)));
    box.querySelectorAll('[data-clr]').forEach(b =>
      b.addEventListener('click', () => {
        const id = +b.dataset.clr;
        const cat = CATDOCS.find(x => x.id === id);
        if (esRefBancaria(cat)) soltarRef(id);
        if (esRif(cat)) soltarRif();
        delete docState[id];
        renderDocs();
      }));
  }
  function updateDocsFoot() {
    const foot = q('#ig_docs_foot');
    if (!foot) return;
    const n = CATDOCS.filter(d => docState[d.id] && docState[d.id].file_b64).length;
    foot.innerHTML = `<span style="font-size:12px;color:var(--muted)">ℹ ${n} de ${CATDOCS.length} recaudos adjuntos.</span>`;
  }
  function pickFor(docId) {
    const inp = q('#ig_file');
    inp.value = '';
    inp.dataset.docId = String(docId);
    inp.click();
  }

  if (CATDOCS.length) {
    q('#ig_file').addEventListener('change', function () {
      const f = this.files && this.files[0];
      const docId = parseInt(this.dataset.docId, 10);
      if (!f || !docId) return;
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (LIM.allowed_ext.length && !LIM.allowed_ext.includes(ext)) {
        alert(`Tipo no permitido (.${ext}). Use: ${LIM.allowed_ext.join(', ')}.`); return;
      }
      const maxBytes = (LIM.max_file_mb || 2) * 1024 * 1024;
      if (f.size > maxBytes) {
        alert(`El archivo pesa ${(f.size/1048576).toFixed(1)} MB y el máximo es ${LIM.max_file_mb} MB.`); return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        docState[docId] = {
          file_name: f.name,
          file_b64: String(reader.result).split(',')[1] || null,
          file_type: f.type || 'application/octet-stream',
          brf: null,
        };
        renderDocs();
        // Solo la referencia bancaria y solo en PDF: el parser lee texto, y
        // una foto de la carta no tiene texto que leer.
        const cat = CATDOCS.find(x => x.id === docId);
        if (esRefBancaria(cat) && ext === 'pdf') validarRef(docId, f);
        if (esRif(cat) && ext === 'pdf') validarRif(docId, f);
      };
      reader.readAsDataURL(f);
    });
    renderDocs();
  }

  /* ---- Orden de carga (v6.238) -----------------------------------------
     `modo` llega del boton que abrio el modal: no se pregunta acá ni se
     recuerda nada. En 'papeles' el bloque de recaudos se MUEVE arriba, que
     es lo unico que hace falta para que los PDF completen el formulario;
     partirlo en pasos obligaria a reescribir check() y por aca pasan siete
     altas por dia. Mover un nodo conserva sus listeners.
     Editando no aplica: los datos ya estan. */
  function ordenarSegunModo(m) {
    const bloque = q('#ig_docblock'), nota = q('#ig_docnote');
    if (!bloque || !nota) return;
    if (m === 'papeles' && !id) {
      const banda = ov.querySelector('.ig-mbody > .ig-band');
      if (banda) banda.parentNode.insertBefore(bloque, banda.nextSibling);
      nota.innerHTML = `<div class="ig-forknote">Empezá por el <b>RIF</b>: trae la cédula, y con ella
        se verifica la referencia bancaria. Lo que se pueda leer se completa abajo.</div>`;
    } else if (!id) {
      nota.innerHTML = `<div class="ig-forknote soft">Si el trabajador ya trajo el <b>RIF</b> y la
        <b>referencia bancaria</b>, adjuntándolos acá se completan la cédula, la dirección y la cuenta.</div>`;
    }
  }
  ordenarSegunModo(modo);



  q('#ig_ced').addEventListener('input', function () {
    this.value = this.value.replace(/[^0-9]/g, '');
    showCed(); check(); applyNrState();
    // v5.77: apenas la cedula es valida, se consulta si es no reempleable.
    const v = DW.validateCedula(this.value);
    if (v.ok) nrLookup(v.ced, () => { if (ov.isConnected) { showCed(); check(); applyNrState(); } });
    revalidarRef();
  });
  q('#ig_account').addEventListener('input', function () { this.value = this.value.replace(/[^0-9 \-]/g, ''); showBank(); check(); revalidarRef(); });
  q('#ig_phone').addEventListener('input', function () { this.value = this.value.replace(/[^0-9 \-]/g, ''); showPhone(); check(); });
  q('#ig_birth').addEventListener('change', () => { showAge(); check(); });
  q('#ig_birth').addEventListener('input', () => { showAge(); check(); });
  ['#ig_start', '#ig_first', '#ig_second', '#ig_last', '#ig_cargo', '#ig_gender', '#ig_marital', '#ig_email', '#ig_address']
    .forEach(sel => { const el = q(sel); el.addEventListener('input', check); el.addEventListener('change', check); });

  /* v6.221 — Segunda red para el cierre de quincena. Cuando el rango
     bloqueado queda en el MEDIO de la ventana, el calendario nativo lo
     ofrece igual (min/max no pueden agujerear el medio). Si se elige uno de
     esos dias, la fecha se borra y queda el aviso: es preferible dejar el
     campo vacio -que se ve- a dejar puesto un dato que el servidor va a
     rechazar recien al enviar todo el reporte.
     Va en 'change' y no en 'input': mientras se tipea a mano, un 2 puede
     ser el principio de un 20, y borrarle el campo a alguien que esta
     escribiendo es peor que el problema. */
  q('#ig_start').addEventListener('change', function () {
    if (this.value && bloqueoDe(this.value)) { this.value = ''; check(); }
  });

  function showAge() {
    const v = q('#ig_birth').value, b = q('#ig_age');
    if (!v) { b.textContent = '—'; b.style.color = ''; return; }
    const a = ageFrom(v);
    if (a < 18) { b.textContent = `⚠ ${a} años (menor)`; b.style.color = 'var(--danger)'; }
    else { b.textContent = `✓ ${a} años`; b.style.color = '#15803d'; }
  }
  function showCed() {
    const el = q('#ig_ced'), line = q('#e_ced');
    const v = DW.validateCedula(el.value);
    if (!el.value) { line.textContent = ''; line.className = 'ig-line'; return; }
    if (!v.ok) { line.className = 'ig-line warn'; line.textContent = 'Cédula no válida (6 a 8 dígitos).'; return; }
    // v5.77: la persona esta en la lista de no reempleables -> se dice ACA,
    // antes de que llenen la ficha. Sin motivo: solo Capital Humano lo maneja.
    if (nrIsBlocked(v.ced)) {
      line.className = 'ig-line warn';
      // v5.78: el mensaje completo vive en el cartel del encabezado; aca
      // queda el recordatorio y la salida (corregir el numero).
      line.textContent = '🚫 En la lista de no reempleables. Corrígela si te equivocaste de número.';
      return;
    }
    line.className = 'ig-line ok'; line.textContent = `✓ ${v.kind === 'E' ? 'Extranjero' : 'Venezolano'} — ${v.kind}-${v.ced}`;
  }
  function showBank() {
    const el = q('#ig_account'), line = q('#ig_bankline');
    const v = validAccount(el.value);
    if (v.empty) { line.textContent = ''; line.className = 'ig-line'; return; }
    if (v.ok) { line.className = 'ig-line ok'; line.textContent = `🏦 ${v.bankName} (${v.bankCode})`; }
    else { line.className = 'ig-line warn'; line.textContent = v.msg || ''; }
  }
  function showPhone() {
    const el = q('#ig_phone'), line = q('#ig_phoneline');
    const v = validPhone(el.value);
    if (v.empty) { line.textContent = ''; line.className = 'ig-line'; return; }
    if (v.ok) { line.className = 'ig-line ok'; line.textContent = `📱 ${v.op} → se guarda ${v.intl}`; }
    else { line.className = 'ig-line warn'; line.textContent = v.msg || ''; }
  }

  function check() {
    const e = {};
    const first = q('#ig_first').value.trim();
    const last = q('#ig_last').value.trim();
    const cedV = DW.validateCedula(q('#ig_ced').value);
    const cargo = q('#ig_cargo').value;
    const gender = q('#ig_gender').value;
    const marital = q('#ig_marital').value;
    const accV = validAccount(q('#ig_account').value);
    const birth = q('#ig_birth').value;
    const start = q('#ig_start').value;
    const email = q('#ig_email').value.trim();
    const phoneV = validPhone(q('#ig_phone').value);

    if (!first) e.first = 'Requerido.';
    if (!last) e.last = 'Requerido.';
    if (!cedV.ok) e.ced = q('#ig_ced').value ? 'Cédula no válida.' : 'Requerido.';
    else {
      // cedula repetida en el reporte (excluyendo el que edito)
      const dup = ctx.workers.some(w => w.ced === cedV.ced && w.id !== (existing ? existing.id : -1));
      if (dup) e.ced = 'Ya agregaste esa cédula.';
      // cedula que YA esta en la lista de la tienda: no es un ingreso
      // (esa persona ya trabaja ahi). Se bloquea para evitar altas duplicadas.
      else if ((ctx.roster || []).some(r => r.id_number === cedV.ced)) {
        e.ced = 'Esa cédula ya está en la lista de la tienda (no es un ingreso nuevo).';
      }
      // v5.77: no reempleable -> no se puede agregar al reporte. El texto
      // visible lo pinta showCed() en la linea de la cedula; aca solo se
      // deshabilita el boton.
      else if (nrIsBlocked(cedV.ced)) {
        e.ced = 'No reempleable: no se puede ingresar.';
      }
    }
    if (!cargo) e.cargo = 'Selecciona un cargo.';
    if (!gender) e.gender = 'Requerido.';
    if (!marital) e.marital = 'Requerido.';
    if (!accV.ok) e.account = accV.empty ? 'Requerido.' : (accV.msg || 'Cuenta no válida.');
    if (!birth) e.birth = 'Requerido.';
    else if (ageFrom(birth) < 18) e.birth = 'No se permiten menores de 18 años.';
    const se = startDateError(start, win);
    if (se) e.start = se;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = 'Formato inválido.';
    if (!phoneV.ok) e.phone = phoneV.msg || 'Teléfono no válido.';

    // pintar errores (los campos con linea propia -ced/account/phone- no duplican)
    const map = { first: 'e_first', last: 'e_last', cargo: 'e_cargo', gender: 'e_gender', marital: 'e_marital', birth: 'e_birth', start: 'e_start', email: 'e_email' };
    Object.keys(map).forEach(k => { const el = q('#' + map[k]); if (el) el.textContent = e[k] || ''; });
    // start usa color danger ya en su div
    const startErr = q('#e_start'); if (startErr) startErr.textContent = e.start || '';

    /* v6.238 — La cedula tiene linea propia (showCed), que solo sabe de
       formato y de no reempleables. Los otros dos motivos -ya la agregaste
       en este reporte, o ya esta en la lista de la tienda- se calculaban y no
       se pintaban en ningun lado: el boton quedaba gris y la linea seguia en
       verde diciendo '✓ Venezolano'. Se pinta solo cuando showCed no tiene
       nada mejor que decir, para no pisarle su propio mensaje. */
    const cedLine = q('#e_ced');
    const cedNow = DW.validateCedula(q('#ig_ced').value);
    if (cedLine && e.ced && cedNow.ok && !nrIsBlocked(cedNow.ced)) {
      cedLine.className = 'ig-line warn';
      cedLine.textContent = e.ced;
    }

    saveB.disabled = Object.keys(e).length > 0;
    return e;
  }

  /* v5.78: cartel + formulario atenuado (mockup B). Se inyecta o se quita
     del slot del encabezado fijo segun el resultado del check; todo lo
     marcado con data-nrdim se atenua y bloquea (la cedula NO lo lleva:
     sigue editable para corregirla, y Cancelar tampoco). El nombre sale de
     la LISTA del sistema, no de lo que tipeo la tienda: es la identidad
     real de esa cedula. */
  const escT = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function applyNrState() {
    const slot = q('#ig_nrslot');
    if (!slot) return;
    const v = DW.validateCedula(q('#ig_ced').value);
    const info = v.ok ? NR_CACHE.get(v.ced) : null;
    const blocked = !!(info && info.blocked);
    slot.innerHTML = !blocked ? '' : `
      <div class="ig-nrbanner">
        <div class="ico">🚫</div>
        <div>
          <div class="tt">NO REEMPLEABLE — NO SE PUEDE INGRESAR</div>
          <div class="nm">${escT(info.full_name || 'Persona en la lista del sistema')} <span class="ced">${v.kind}-${v.ced}</span></div>
          <div class="ms">Esta persona no es reempleable en el grupo. Para más información, contacta a Capital Humano.</div>
        </div>
      </div>`;
    ov.querySelectorAll('[data-nrdim]').forEach(el => el.classList.toggle('ig-dimmed', blocked));
  }

  /* =====================================================================
     CERRAR EL FORMULARIO (v6.222).

     La X vive en el encabezado, que no scrollea: antes, para salir de un
     alta cargada a medias habia que bajar hasta el final a buscar Cancelar.

     PERO UNA X ARRIBA A LA DERECHA SE APRIETA SIN QUERER, y este formulario
     tiene veinte campos: perder todo por un clic al pasar seria peor que el
     scroll que viene a evitar. Por eso, si hay algo escrito, pregunta; si
     esta vacio, cierra directo y sin molestar.

     Cancelar hace lo MISMO: hoy cerraba de una y perdia lo cargado igual,
     solo que nadie se quejaba porque estaba lejos. El riesgo era el mismo.
     ===================================================================== */
  /* v6.223 — Pasa al helper compartido. En la v6.222 esto vivia aca con su
     propia X y su propio Escape; al llevarlo a los otros cuatro wizards
     habrian quedado cinco copias, que es exactamente lo que se desincroniza.
     La X de este formulario se inyecta sobre .ig-mhead, que es su encabezado
     fijo, y no sobre .modal como en los demas. */
  wireWizardClose({
    ov, caja: ov.querySelector('.ig-mhead'), cancelar: '#ig_cancel',
    titulo: 'Descartar el ingreso',
    mensaje: 'Ya cargaste datos de esta persona. Si cerrás ahora se pierden.',
    /* v6.237 — Los ADJUNTOS tambien son trabajo hecho. Antes solo se miraban
       los inputs, y no se notaba porque los recaudos estaban al final: para
       cuando alguien adjuntaba ya tenia medio formulario escrito. Con la
       bifurcacion el orden se invierte y le pedimos que adjunte PRIMERO, asi
       que si el PDF no se puede leer los campos quedan vacios y cerrar
       borraba los archivos sin preguntar nada. */
    hayDatos: () => algunoConValor(ov, ['#ig_start', '#ig_first', '#ig_second', '#ig_last',
      '#ig_ced', '#ig_birth', '#ig_cargo', '#ig_account', '#ig_phone', '#ig_email', '#ig_address',
      '#ig_gender', '#ig_marital'])()
      || Object.values(docState).some(d => d && d.file_b64),
  });
  saveB.addEventListener('click', () => {
    if (Object.keys(check()).length) return;
    /* v6.231 — Unico bloqueo nuevo, y solo para el caso que la evidencia
       sostiene: cedula del PDF LEGIBLE, distinta, y ademas la cuenta no es la
       del trabajador. Medido sobre las 532 referencias ya cargadas eso ocurre
       2 veces, y las 2 son el mismo PDF de un tercero. Todo lo demas -PDF
       ilegible, cedula con un digito mal, banco raro- avisa y deja pasar: una
       validacion que traba altas legitimas termina siendo desactivada. */
    const malo = CATDOCS.filter(d => esRefBancaria(d))
      .map(d => docState[d.id]).find(st => st && st.brf && st.brf.estado === 'err');
    if (malo) {
      alert(`No se puede guardar con esa referencia bancaria.${NLX}${NLX}${malo.brf.mensaje}${NLX}${NLX}`
        + 'Adjuntá la referencia del trabajador, o quitá el archivo y cargala después desde su ficha.');
      return;
    }
    const cedV = DW.validateCedula(q('#ig_ced').value);
    const accV = validAccount(q('#ig_account').value);
    const phoneV = validPhone(q('#ig_phone').value);
    const first = q('#ig_first').value.trim().toUpperCase();
    const second = q('#ig_second').value.trim().toUpperCase();
    const last = q('#ig_last').value.trim().toUpperCase();
    const fullName = [first, second, last].filter(Boolean).join(' ');

    const ingreso = {
      firstName: first, secondName: second || '', lastNames: last,
      cedKind: cedV.kind,
      cargoCode: q('#ig_cargo').value,
      birthDate: q('#ig_birth').value,
      gender: q('#ig_gender').value,
      marital: q('#ig_marital').value,
      account: accV.account, bankCode: accV.bankCode, bankName: accV.bankName,
      email: q('#ig_email').value.trim(),
      phone: q('#ig_phone').value.replace(/[^0-9]/g, ''),   // nacional, para mostrar/editar
      phoneIntl: phoneV.intl || '',                          // +58, para enviar
      address: q('#ig_address').value.trim(),
      startDate: q('#ig_start').value,
      // Recaudos adjuntos: array {required_doc_id, file_name, file_b64, file_type}.
      // Solo los que tienen archivo cargado. Viajan en el submit a osTicket.
      docs: (CAT.docs || [])
        .filter(d => docState[d.id] && docState[d.id].file_b64)
        .map(d => ({
          required_doc_id: d.id,
          file_name: docState[d.id].file_name,
          file_b64: docState[d.id].file_b64,
          file_type: docState[d.id].file_type,
          // Lo que el parser leyo del PDF. El backend lo guarda en
          // bank_references al aprobar, sin volver a parsear nada.
          brf: docState[d.id].brf || null,
        })),
    };

    if (existing) {
      existing.ced = cedV.ced;
      existing.name = fullName;
      existing.ingreso = ingreso;
    } else {
      // crear un worker nuevo en ctx.workers (forma estandar + .ingreso)
      ctx.addWorker({ ced: cedV.ced, name: fullName, ingreso });
    }
    ov.remove();
    renderRows(ctx);
  });

  showAge(); showCed(); showBank(); showPhone(); check(); applyNrState();
  // v5.77: si el modal abre con cedula precargada (editar / venia del paso 3),
  // consultarla de una vez.
  {
    const v0 = DW.validateCedula(q('#ig_ced').value);
    if (v0.ok) nrLookup(v0.ced, () => { if (ov.isConnected) { showCed(); check(); applyNrState(); } });
  }
  setTimeout(() => { const f = q('#ig_start'); if (f) f.focus(); }, 40);
}

function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

/* =====================================================================
   FICHA SOLO-LECTURA (Resumen -> "Ver detalle")
   Muestra TODOS los datos capturados del ingreso sin permitir editarlos.
   Se invoca desde el boton del Resumen via la funcion global de abajo,
   porque wizard-core pinta el Resumen y no engancha listeners a nuestras
   celdas. Busca a la persona por cedula en LAST_WORKERS (la lista del
   reporte en curso, refrescada en cada render del paso 4).
   ===================================================================== */
window.__nv2VerIngreso = function (ced) {
  const w = (LAST_WORKERS || []).find(x => String(x.ced) === String(ced));
  if (!w || !w.ingreso) { alert('No se encontraron los datos de este ingreso.'); return; }
  openIngresoView(w);
};

function openIngresoView(w) {
  const g = w.ingreso || {};
  const GEN = { M: 'Masculino', F: 'Femenino' };
  const CIV = { S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a' };
  const age = ageFrom(g.birthDate);
  const phoneNat = g.phone ? g.phone : '—';
  const docsList = (CAT && CAT.docs) ? CAT.docs : [];
  const docState = {};
  (g.docs || []).forEach(d => { if (d && d.required_doc_id) docState[d.required_doc_id] = d; });

  // Fila de dato (etiqueta + valor). Para valores vacios muestra una raya.
  const row = (label, value) =>
    `<div class="vr-row"><span class="vr-lbl">${label}</span><span class="vr-val">${value == null || value === '' ? '—' : esc(value)}</span></div>`;

  const docsHtml = docsList.length
    ? docsList.map(d => {
        const st = docState[d.id];
        const has = st && st.file_b64;
        const pill = has
          ? `<span class="pill pill-set">📎 ${esc(st.file_name || 'adjunto')}</span>`
          : `<span class="pill pill-pend">pendiente</span>`;
        return `<div class="vr-row"><span class="vr-lbl">${esc(d.name)}</span><span class="vr-val">${pill}</span></div>`;
      }).join('')
    : `<div class="vr-row"><span class="vr-val" style="color:var(--muted)">Esta tienda no tiene recaudos configurados.</span></div>`;

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `
    <div class="modal modal-wide">
      <h3>Detalle del ingreso</h3>
      <p class="who">${esc(w.name || '')} · <span class="pill pill-set">A · Alta</span> · solo lectura</p>

      <div class="ig-sec" style="margin-top:6px">Identidad</div>
      ${row('Primer nombre', g.firstName)}
      ${row('Segundo nombre', g.secondName)}
      ${row('Apellidos', g.lastNames)}
      ${row('Cédula', `${g.cedKind || 'V'}-${w.ced}`)}
      ${row('Cargo', g.cargoCode ? cargoLabel(g.cargoCode) : '—')}
      ${row('Fecha de nacimiento', g.birthDate ? DW.fmtDate(g.birthDate) : '—')}
      ${row('Edad', age == null ? '—' : `${age} años`)}

      <div class="ig-sec">Datos personales y bancarios</div>
      ${row('Género', GEN[g.gender] || g.gender)}
      ${row('Estado civil', CIV[g.marital] || g.marital)}
      ${row('Cuenta bancaria', g.account ? `${g.account}${g.bankName ? ' · ' + g.bankName : ''}` : '—')}

      <div class="ig-sec">Contacto</div>
      ${row('Correo', g.email)}
      ${row('Teléfono', phoneNat)}
      ${row('Dirección', g.address)}

      <div class="ig-sec">Fecha de ingreso</div>
      ${row('Fecha inicial de empleo', g.startDate ? DW.fmtDate(g.startDate) : '—')}

      <div class="ig-sec">Recaudos</div>
      ${docsHtml}

      <div class="wiz-foot" style="margin-top:18px">
        <span></span>
        <button class="btn btn-primary" id="ivClose">Cerrar</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#ivClose').addEventListener('click', close);
  // Se cierra SOLO con su boton (Cerrar); no al hacer clic fuera.
}
