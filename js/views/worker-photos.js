/* =====================================================================
   js/views/worker-photos.js  →  vista "Personal"
   Directorio de personal de UNA empresa: grid de tarjetas con foto +
   ficha completa por colaborador (ver / editar) para llenar workers_master.

   Foto: se comprime EN EL NAVEGADOR a dos versiones cuadradas (recorte
   centrado) desde el original:
     - miniatura 300x300  -> grid y cabecera de la ficha (liviana).
     - grande   800x800   -> visor ampliado y export a AX (nitida).
   Ambas viajan en base64 a /api/worker-photo (accion 'save'); el endpoint
   las sube al Storage privado 'worker-photos' y guarda rutas+metadatos en
   workers_master (tabla maestra por cedula, sin empresa).

   Datos de la persona (nacimiento, genero, banco, contacto...) se editan
   en la ficha y se guardan con la accion 'save_profile' (PATCH a
   workers_master). El Data ID es de la empresa (solo lectura).

   Acceso:
     - tienda: ve su propio roster (companyCode de la sesion).
     - admin/superadmin: eligen empresa primero; el acceso se revalida
       server-side.

   Exporta renderWorkerPhotos(user, companyCode, onExit?), que pinta la
   vista dentro de #pnlMain.
   ===================================================================== */

import { $ } from '../core/dom.js';
import { parseReport10, validateParsed, rosterReplace, rosterClear, rosterAddManual, rosterAgeDays, splitFullName } from '../reports/shared/roster.js';
import { parseReporteAX, validateReporteAX, enterpriseRosterReplace, enterpriseRosterClear, storeRosterReplaceAX, axRosterPull, rosterCooldownMessage } from '../reports/shared/roster-ax.js';

const THUMB = 300;           // miniatura cuadrada (grid)
const FULL = 800;            // version grande cuadrada (visor / AX)
const THUMB_QUALITY = 0.72;
const FULL_QUALITY = 0.82;

/* ---------- API ---------- */
async function api(payload) {
  const res = await fetch('/api/worker-photo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}
/* Departamentos (ABM) van a su propio endpoint /api/departments. Se usa para
   crear un departamento desde la barra de acciones de Personal (modo empresa). */
async function deptApi(payload) {
  const res = await fetch('/api/departments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}
function sessionUserPayload(user) {
  return { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null };
}

/* ---------- Compresion en el navegador ---------- */
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const fr = new FileReader();
    fr.onload = () => { img.onload = () => resolve(img); img.onerror = reject; img.src = fr.result; };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}
/* ---------- Recorte cuadrado desde un viewport (arrastrar + zoom) ----------
   Dado el <img> original, una escala y un offset (x,y) en pixeles relativos a
   un stage cuadrado de lado STAGE, genera la version cuadrada de lado `side`.
   Es la misma matematica del recortador: que porcion de la imagen original
   cae dentro del stage segun la escala y el desplazamiento elegidos. */
function cropFromViewport(img, view, side, quality) {
  const cv = document.createElement('canvas');
  cv.width = side; cv.height = side;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, side, side);
  // porcion de la imagen original visible en el stage
  const sx = -view.x / view.scale;
  const sy = -view.y / view.scale;
  const sw = view.stage / view.scale;
  const sh = view.stage / view.scale;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(img, sx, sy, sw, sh, 0, 0, side, side);
  return cv.toDataURL('image/jpeg', quality);
}

// Recorte cuadrado centrado a sidexside (mantiene la cara del centro).
function squareCrop(img, side, quality) {
  const s = Math.min(img.width, img.height);
  const sx = (img.width - s) / 2, sy = (img.height - s) / 2;
  const cv = document.createElement('canvas');
  cv.width = side; cv.height = side;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, side, side);
  cx.drawImage(img, sx, sy, s, s, 0, 0, side, side);
  return cv.toDataURL('image/jpeg', quality);
}
function b64Bytes(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  return Math.round(b64.length * 0.75);
}
function stripPrefix(dataUrl) { return String(dataUrl).split(',')[1] || ''; }

/* ---------- Circulo guia (SVG superpuesto) ---------- */
function guideSvg() {
  return `<svg class="wp-guide" viewBox="0 0 100 100" preserveAspectRatio="none"><defs><mask id="wpmc"><rect width="100" height="100" fill="white"/><circle cx="50" cy="50" r="32" fill="black"/></mask></defs><rect width="100" height="100" fill="rgba(15,23,42,0.34)" mask="url(#wpmc)"/><circle cx="50" cy="50" r="32" fill="none" stroke="#fff" stroke-width="0.8" stroke-dasharray="3 2"/></svg>`;
}

/* ---------- helpers ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* Icono "ver" (ojo) con el trazo del portal, para el boton "Ver foto". */
function eyeIco() {
  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = String(iso).slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : iso;
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return iso;
  const c = new Date(d.getTime() - 4 * 3600 * 1000);
  const z = n => String(n).padStart(2, '0');
  return `${z(c.getUTCDate())}/${z(c.getUTCMonth() + 1)}/${c.getUTCFullYear()} ${z(c.getUTCHours())}:${z(c.getUTCMinutes())}`;
}
function ageFrom(ymd) {
  if (!ymd) return null;
  if (String(ymd).slice(0, 10) <= '1900-01-01') return null; // 1900-01-01 = sin edad (AX dateNull)
  const t = new Date(), b = new Date(ymd);
  let a = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
  return a;
}
/* ¿hoy es el cumpleanos? Compara dia-mes de nacimiento con hoy en hora de
   Caracas (no depende de la zona del navegador). */
function caracasMD() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const mo = (p.find(x => x.type === 'month') || {}).value || '01';
  const da = (p.find(x => x.type === 'day') || {}).value || '01';
  return `${mo}-${da}`;
}
function isBirthday(ymd) {
  if (!ymd) return false;
  if (String(ymd).slice(0, 10) <= '1900-01-01') return false;
  return String(ymd).slice(5, 10) === caracasMD();
}
/* Antiguedad desde la fecha de ingreso: "Xa Ym" / "Ym" / dias. Devuelve ''
   si falta el dato o la fecha es futura.
   v5.92: con menos de 1 mes cumplido ya no dice 'nuevo': muestra los DIAS
   corridos desde el ingreso ('hoy', '3 d', '28 d'), que informan de verdad. */
function tenureLabel(ymd) {
  if (!ymd) return '';
  const s = new Date(String(ymd).slice(0, 10) + 'T00:00:00');
  if (isNaN(s)) return '';
  const t = new Date();
  let y = t.getFullYear() - s.getFullYear();
  let m = t.getMonth() - s.getMonth();
  if (t.getDate() < s.getDate()) m--;
  if (m < 0) { y--; m += 12; }
  if (y < 0) return '';
  if (y === 0 && m === 0) {
    const days = Math.max(0, Math.floor((t - s) / 86400000));
    return days === 0 ? 'hoy' : `${days} d`;
  }
  if (y === 0) return `${m} m`;
  return m > 0 ? `${y}a ${m}m` : `${y}a`;
}
/* v6.26: días corridos desde una fecha (hora Caracas). null si falta o es
   futura — base de las celdas ANT y GRUPO del mockup v3. */
function daysFrom(ymd) {
  if (!ymd) return null;
  const sd = String(ymd).slice(0, 10);
  const hoy = caracasYMD(new Date());
  if (sd > hoy) return null;
  const d = Math.floor((Date.parse(hoy) - Date.parse(sd)) / 86400000);
  return isNaN(d) ? null : d;
}
/* v6.26: antigüedad COMPACTA de UNA sola unidad (regla anti-deformación del
   mockup v3 aprobado): días (<1 mes: "3 d"), meses hasta los 2 años
   ("15 m", nunca "1a 3m"), años redondos de ahí en más ("6 a"). El valor
   exacto vive en el tooltip (tenureLong) y en la ficha. */
function tenureShort(days) {
  if (days == null || isNaN(days) || days < 0) return '—';
  if (days === 0) return 'hoy';
  if (days < 30) return `${Math.floor(days)} d`;
  if (days < 730) return `${Math.floor(days / 30.44)} m`;
  return `${Math.floor(days / 365.25)} a`;
}
/* v6.26: antigüedad LARGA para tooltips y ficha ("2 años y 1 mes"). */
function tenureLong(days) {
  if (days == null || isNaN(days) || days < 0) return '';
  if (days === 0) return 'hoy';
  if (days < 30) return `${Math.floor(days)} día${Math.floor(days) === 1 ? '' : 's'}`;
  const m = Math.floor(days / 30.44);
  if (m < 24) return `${m} mes${m === 1 ? '' : 'es'}`;
  const y = Math.floor(days / 365.25);
  const rm = Math.floor((days - y * 365.25) / 30.44);
  return rm > 0 ? `${y} año${y === 1 ? '' : 's'} y ${rm} mes${rm === 1 ? '' : 'es'}` : `${y} año${y === 1 ? '' : 's'}`;
}
/* v5.92: ¿la fecha cae en la QUINCENA CALENDARIO en curso? (1-15 / 16-fin
   del mes actual, hora Caracas — misma regla que la nomina). La marca se
   apaga sola al cambiar de quincena. */
function isCurrentFortnight(ymd) {
  if (!ymd) return false;
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const gv = t => ((p.find(x => x.type === t) || {}).value || '');
  const ty = gv('year'), tm = gv('month'), td = Number(gv('day'));
  const s = String(ymd).slice(0, 10).split('-');
  if (s.length !== 3) return false;
  if (s[0] !== ty || s[1] !== tm) return false;
  const sd = Number(s[2]);
  return (td <= 15) === (sd <= 15);
}
/* v6.29: Mini-fila de CUATRO chips — [S] [E] [ANT/NUEVO] [GRUPO], en toda
   la grilla sin excepción (mockup intermitencia_historia aprobado):
   - S y E separados, cada uno con su letra arriba; dato ausente = "—";
     las celdas nunca desaparecen ni cambian de alto. Cumpleaños: 🎂.
   - ANT/NUEVO: antigüedad EN LA TIENDA, formato compacto de una unidad.
   - GRUPO: tramo continuo EN EL GRUPO (get_group_tenure). ÍNDIGO cuando
     alcanza el umbral grupo_resalte_dias (365 = 1 año, Configuración >
     Parámetros, bandera grp_hl del endpoint); intermitente = mini-barra
     MONO (los cortes son los espacios); sin dato "—". El teal y el
     puntito ámbar mueren en esta versión. */
function miniRowHtml(w) {
  // Celdas 1 y 2 — SEXO y EDAD separadas (v6.29).
  const g = (w.gender === 'M' || w.gender === 'F') ? w.gender : null;
  const age = ageFrom(w.birth_date);
  const okAge = age != null && age >= 0 && age <= 120;
  const bday = okAge && isBirthday(w.birth_date);
  const sTitle = g === 'M' ? 'Masculino' : g === 'F' ? 'Femenino' : 'Sexo sin dato';
  const eTitle = `${okAge ? age + ' años' : 'Sin fecha de nacimiento'}${bday ? ' · ¡cumple hoy!' : ''}`;
  const sVal = g ? `<span class="${g === 'M' ? 'm' : 'f'}">${g}</span>` : '—';
  const eVal = okAge ? `${age}${bday ? ' \uD83C\uDF82' : ''}` : '—';
  // Celda 2 — ANT/NUEVO de la tienda.
  const dTienda = daysFrom(w.start_date);
  const antVal = dTienda == null ? '—' : tenureShort(dTienda);
  const isNew = dTienda != null && isVigente(w) && isNuevoIngreso(w);
  const antTitle = w.start_date
    ? `Ingresó el ${fmtDate(w.start_date)} (${tenureLong(dTienda) || 'hoy'})${isNew ? ' · hace menos de un mes' : ''}`
    : 'Sin fecha de ingreso';
  // Celda 4 — GRUPO (tramo continuo vigente). v6.29: ÍNDIGO por umbral
  // parametrizado (grp_hl = cont_days >= grupo_resalte_dias, del endpoint).
  const dGrupo = (typeof w.cont_days === 'number') ? w.cont_days : null;
  const grpHl = !!w.grp_hl;
  const grpVal = dGrupo == null ? '—' : tenureShort(dGrupo);
  let grpTitle = 'Antigüedad en el Grupo: sin datos';
  if (dGrupo != null) {
    grpTitle = `En el Grupo: ${tenureLong(dGrupo)}`
      + (w.cont_since ? ` · tramo continuo desde el ${fmtDate(w.cont_since)}` : '')
      + (w.grp_int
        ? ` · INTERMITENTE (${w.grp_periods || 2} períodos${w.grp_since ? ', nos conoce desde el ' + fmtDate(w.grp_since) : ''}${typeof w.grp_days === 'number' ? ', ' + tenureLong(w.grp_days) + ' efectivos' : ''})`
        : ` · continuo${(w.grp_periods || 1) > 1 ? ` (${w.grp_periods} períodos)` : ''}`);
  }
  // v6.29: mini-barra MONO solo en intermitentes — piezas del mismo gris,
  // los CORTES (espacios) comunican; la pieza final ∝ tramo continuo actual.
  let ibar = '';
  if (w.grp_int && dGrupo != null) {
    const per = Math.max(2, Math.min(4, Number(w.grp_periods) || 2));
    const prevDays = Math.max(1, (Number(w.grp_days) || dGrupo) - dGrupo);
    const wCur = Math.max(16, Math.min(84, Math.round(dGrupo / (prevDays + dGrupo) * 100)));
    const piece = Math.max(6, Math.floor((100 - wCur) / (per - 1)) - 3);
    let segs = '';
    for (let i = 0; i < per - 1; i++) segs += `<i style="width:${piece}%"></i>`;
    ibar = `<div class="wp-ibar">${segs}<i style="width:${wCur}%"></i></div>`;
  }
  return `<div class="wp-mini" style="grid-template-columns:repeat(4,1fr)">`
    + `<div class="wp-mini-c" title="${esc(sTitle)}"><div class="wp-mini-l">S</div><div class="wp-mini-v">${sVal}</div></div>`
    + `<div class="wp-mini-c" title="${esc(eTitle)}"><div class="wp-mini-l">E</div><div class="wp-mini-v">${eVal}</div></div>`
    + (isNew
      ? `<div class="wp-mini-c wp-ant-new" title="${esc(antTitle)}"><div class="wp-mini-l">Nuevo</div><div class="wp-mini-v">${antVal}</div></div>`
      : `<div class="wp-mini-c" title="${esc(antTitle)}"><div class="wp-mini-l">Ant</div><div class="wp-mini-v">${antVal}</div></div>`)
    + `<div class="wp-mini-c${grpHl ? ' wp-grp-hl' : ''}" title="${esc(grpTitle)}"><div class="wp-mini-l">Grupo</div><div class="wp-mini-v">${grpVal}</div>${ibar}</div>`
    + `</div>`;
}
/* ===================== v4.21: franja "Actualizó" (semáforo) =====================
   Pie de TODAS las tarjetas de la grilla (espejo de la barra de departamento):
   punto verde (≤7 dias) / ambar (≤30) / gris (>30) + quien edito la ficha de
   ultimo (nombre corto + rol) + fecha ('hoy' o dd/mm/aa Caracas). Sin
   ediciones: punto hueco + 'Sin ediciones' + '—' (la franja PERMANECE para
   que todas las tarjetas midan igual). Tooltip con el texto completo. */
function ensureFootStyles() {
  if (document.getElementById('wpFootStyles')) return;
  const st = document.createElement('style');
  st.id = 'wpFootStyles';
  st.textContent = `
  .wp-footbar{display:flex;align-items:center;gap:6px;padding:6px 10px;font-size:10.5px;color:var(--ink-soft,#475569);background:var(--bg-soft,#f1f5f9);border-top:1px solid var(--border-soft,#eef1f5);margin-top:auto;min-height:16px}
  .wp-footbar .who{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}
  .wp-footbar .dt{color:var(--faint,#94a3b8);flex:none;font-variant-numeric:tabular-nums}
  .wp-footbar.none{color:var(--faint,#94a3b8)}
  .wp-footbar.none .who{font-weight:500;font-style:italic}
  .wp-footdot{width:7px;height:7px;border-radius:50%;flex:none}
  .wp-footdot.ok{background:#22c55e}
  .wp-footdot.mid{background:#f59e0b}
  .wp-footdot.old{background:#cbd5e1}
  .wp-footdot.none{width:6px;height:6px;background:transparent;border:1.5px solid #d3dae4}
  /* v6.16: combo desplegable de estado (checkboxes ADENTRO, pedido de
     Pablo: un solo control del tamaño de un select, multi-selección) */
  .wp-stdd{position:relative;flex:none}
  .wp-stdd-btn{display:flex;align-items:center;gap:6px;padding:8px 11px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:var(--surface,#fff);font-size:13px;color:var(--ink,#0f172a);cursor:pointer;white-space:nowrap}
  .wp-stdd-btn:hover{background:var(--bg-soft,#f8fafc)}
  .wp-stdd-btn svg{color:var(--muted,#64748b);flex:none}
  .wp-stdd-pop{position:absolute;top:calc(100% + 6px);left:0;z-index:40;min-width:185px;background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-radius:10px;box-shadow:0 10px 26px rgba(15,23,42,.14);padding:6px}
  .wp-stdd-pop label{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:var(--ink-soft,#475569);user-select:none}
  .wp-stdd-pop label:hover{background:var(--bg-soft,#f1f5f9)}
  .wp-stdd-pop input{accent-color:var(--brand,#2563eb);width:14px;height:14px;cursor:pointer;margin:0}
  /* v5.92: celda ANT de ingreso en la quincena en curso (mockup A3) */
  .wp-mini-c.wp-ant-new{background:#e9f7f1}
  .wp-mini-c.wp-ant-new .wp-mini-l{color:#0e9f6e}
  .wp-mini-c.wp-ant-new .wp-mini-v{color:#0e9f6e}
  /* v6.26: TARJETA DE ALTO FIJO (mockup v3 aprobado) — reservas fijas por
     bloque para que NINGUNA tarjeta quede más alta que otra: nombre SIEMPRE
     2 líneas (clamp con …), cargo 1 línea con ellipsis (reservada aunque
     vacía), franja de chips SIEMPRE presente (1 línea, los chips se
     comprimen con … antes que crecer), mini-fila de altura fija con las 3
     celdas centradas. El detalle completo vive en los tooltips. */
  .wp-card .wp-name{height:34px;line-height:17px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .wp-card .wp-ced{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wp-card .wp-role{height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wp-chips{height:26px;display:flex;align-items:center;gap:4px;overflow:hidden}
  .wp-chips .pill{margin-top:0!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto}
  .wp-mini{height:46px}
  .wp-mini .wp-mini-c{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;position:relative;min-width:0}
  .wp-mini .wp-mini-v{white-space:nowrap}
  /* v6.29: 4 chips — sexo coloreado en su celda propia; GRUPO ÍNDIGO al
     alcanzar grupo_resalte_dias; mini-barra MONO solo en intermitentes
     (piezas del mismo gris, los cortes/espacios comunican). */
  .wp-mini .m{color:#2563eb}
  .wp-mini .f{color:#ec4899}
  .wp-grp-hl{background:#eef2ff}
  .wp-grp-hl .wp-mini-l{color:#6366f1}
  .wp-grp-hl .wp-mini-v{color:#4f46e5}
  .wp-ibar{display:flex;gap:2px;height:3.5px;margin-top:2px;width:calc(100% - 12px);justify-content:center}
  .wp-ibar i{background:#94a3b8;border-radius:2px}
  /* v6.30: trayectoria en la cabecera de la ficha + desplegable */
  .ff-trj{font-size:12.5px;color:var(--ink-soft,#475569);margin-top:7px;line-height:1.5}
  .ff-trj-det{margin-top:4px}
  .ff-trj-det summary{cursor:pointer;font-size:12.5px;color:#4f46e5;font-weight:700;list-style:none;user-select:none;width:max-content}
  .ff-trj-det summary::-webkit-details-marker{display:none}
  .ff-trj-det summary::before{content:'▸ '}
  .ff-trj-det[open] summary::before{content:'▾ '}
  .ff-hist{border:1px solid var(--border,#e5e7eb);border-radius:10px;overflow:hidden}
  .ff-hrow{display:flex;gap:9px;padding:7px 11px;border-top:1px solid var(--border-soft,#eef1f5);font-size:12px;align-items:center;flex-wrap:wrap}
  .ff-hrow:first-child{border-top:0}
  .ff-hrow.now{background:#eef2ff}
  .ff-hrow .hd{color:var(--ink,#334155);font-weight:700;white-space:nowrap}
  .ff-hrow .ha{font-weight:800;color:#4f46e5;background:#eef2ff;border:1px solid #c7d2fe;border-radius:6px;padding:0 6px}
  .ff-hrow.now .ha{background:#fff}
  .ff-hrow .hr{color:var(--muted,#64748b);flex:0 1 auto;min-width:0}
  .ff-hrow .hz{color:var(--faint,#94a3b8);font-size:11px;white-space:nowrap;flex:1 1 auto}
  .ff-hrow .hc{color:var(--ink-soft,#475569);font-size:11px;background:var(--bg-soft,#f1f5f9);border-radius:6px;padding:0 6px;white-space:nowrap}
  .ff-hrow .hdur{margin-left:auto;color:var(--ink,#334155);white-space:nowrap}
  .ff-hpause{background:#fffbeb;color:#92400e;font-size:11px;padding:5px 11px;border-top:1px dashed #fcd34d}
  /* v6.34: desplegable al tope de ff-body — hereda la sangría de las
     secciones; solo aire abajo para separarlo de Identidad */
  .ff-trj-wide{margin:0 0 14px}
  .ff-trj-wide #ffTrjBody{max-width:100%}
  @media (max-width:768px){ .wp-footbar{padding:5px 8px;font-size:9.5px;gap:5px} }
  `;
  document.head.appendChild(st);
}
/* Fecha (Date) -> 'YYYY-MM-DD' en hora Caracas, para comparar 'hoy'. */
function caracasYMD(d) {
  const c = new Date(d.getTime() - 4 * 3600 * 1000);
  const z = n => String(n).padStart(2, '0');
  return `${c.getUTCFullYear()}-${z(c.getUTCMonth() + 1)}-${z(c.getUTCDate())}`;
}
/* v6.15: "activo" = VIGENTE A LA FECHA (hora Caracas): sin fecha de fin,
   o con fin FUTURO aún no cumplido (contrato con fin conocido que sigue
   corriendo, badge v6.05). El fin cumplido es egreso — o traslado si la
   persona está activa en otra empresa del grupo (now_at). */
function isVigente(w) {
  if (!w || !w.end_date) return true;
  return String(w.end_date).slice(0, 10) >= caracasYMD(new Date());
}
/* v6.20: "INGRESADO/NUEVO" = antigüedad menor a 30 días (mientras la
   antigüedad todavía se cuenta en días, la persona es nueva). Reemplaza a
   la regla de quincena calendario (v5.92) en PERSONAL: con aquella, el
   gerente que ingresó el 15/07 perdía la etiqueta NUEVO el día 16 con solo
   1 día de antigüedad (caso real de Pablo en AA03). La barrita de Empresas
   conserva su regla de quincena: allá se mide el flujo del ciclo de nómina;
   acá se describe a la persona. */
function isNuevoIngreso(w) {
  if (!w || !w.start_date) return false;
  const sd = String(w.start_date).slice(0, 10);
  const hoy = caracasYMD(new Date());
  if (sd > hoy) return false;
  const dias = Math.floor((Date.parse(hoy) - Date.parse(sd)) / 86400000);
  return dias < 30;
}
function updFootbarHtml(w) {
  // v4.77: el pie refleja el ESTADO DE PUBLICACION de la ficha (mockup
  // aprobado, sin badge sobre la foto):
  //  - NARANJA "● N cambios · fecha": hay cambios sin publicar (bandeja de
  //    Sincronizar). N = campos pendientes (ax_pending_fields).
  //  - VERDE "✓ quien · fecha": la ultima edicion ya se publico al sistema
  //    (sin pendientes y con ax_synced_at).
  //  - Editada pero sin dato de publicacion: pie clasico (semaforo por
  //    antiguedad + quien + fecha). Sin ediciones: gris, como siempre.
  const shortDt = (iso) => {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '—';
    if (caracasYMD(d) === caracasYMD(new Date())) return 'hoy';
    const c = new Date(d.getTime() - 4 * 3600 * 1000);
    const z = n => String(n).padStart(2, '0');
    return `${z(c.getUTCDate())}/${z(c.getUTCMonth() + 1)}/${String(c.getUTCFullYear()).slice(2)}`;
  };
  const shortWho = (by) => {
    let who = String(by || '');
    const m = who.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (m) {
      const parts = m[1].trim().split(/\s+/).filter(Boolean);
      const nm = parts.length >= 2 ? `${parts[0]} ${parts[1].charAt(0).toUpperCase()}.` : (parts[0] || m[1]);
      who = `${nm} (${m[2]})`;
    }
    return who;
  };
  if (w.ax_pending) {
    const n = (w.ax_pending_fields && typeof w.ax_pending_fields === 'object')
      ? Math.max(1, Object.keys(w.ax_pending_fields).length) : 1;
    const tip = `${n} cambio${n === 1 ? '' : 's'} sin publicar`
      + (w.profile_updated_by ? ` · editado por ${w.profile_updated_by}` : '')
      + (w.profile_updated_at ? ` · ${fmtDateTime(w.profile_updated_at)}` : '');
    return `<div class="wp-footbar" title="${esc(tip)}" style="color:#b45309;background:#fdf3e7;border-top-color:#f3ddc0">`
      + `<span class="who" style="font-weight:700">● ${n} cambio${n === 1 ? '' : 's'}</span>`
      + `<span class="dt" style="color:#b45309">${shortDt(w.profile_updated_at)}</span></div>`;
  }
  if (w.profile_updated_by && w.ax_synced_at) {
    const tip = `Publicado al sistema · editado por ${w.profile_updated_by}`
      + (w.profile_updated_at ? ` · ${fmtDateTime(w.profile_updated_at)}` : '')
      + ` · publicado ${fmtDateTime(w.ax_synced_at)}`;
    return `<div class="wp-footbar" title="${esc(tip)}" style="color:#0e9f6e;background:#e9f7f1;border-top-color:#c4e8d9">`
      + `<span class="who" style="font-weight:700">✓ ${esc(shortWho(w.profile_updated_by))}</span>`
      + `<span class="dt" style="color:#0e9f6e">${shortDt(w.ax_synced_at)}</span></div>`;
  }
  if (!w.profile_updated_by) {
    return `<div class="wp-footbar none" title="Esta ficha aún no tiene ediciones registradas"><span class="wp-footdot none"></span><span class="who">Sin ediciones</span><span class="dt">—</span></div>`;
  }
  const by = String(w.profile_updated_by);
  const who = shortWho(by);
  let dotCls = 'old', dt = '—';
  const d = w.profile_updated_at ? new Date(w.profile_updated_at) : null;
  if (d && !isNaN(d)) {
    const days = (Date.now() - d.getTime()) / 86400000;
    dotCls = days <= 7 ? 'ok' : (days <= 30 ? 'mid' : 'old');
    dt = shortDt(w.profile_updated_at);
  }
  const tip = `Ficha actualizada por ${by}${w.profile_updated_at ? ' · ' + fmtDateTime(w.profile_updated_at) : ''}`;
  return `<div class="wp-footbar" title="${esc(tip)}"><span class="wp-footdot ${dotCls}"></span><span class="who">${esc(who)}</span><span class="dt">${dt}</span></div>`;
}

/* Confeti para el detalle de cumpleanos sobre la foto. */
function confettiHtml() {
  const D = [['8%', '16%', '#ec4899'], ['24%', '54%', '#f59e0b'], ['44%', '10%', '#2563eb'], ['60%', '60%', '#10b981'], ['80%', '20%', '#db2777'], ['90%', '52%', '#6366f1'], ['16%', '78%', '#10b981'], ['70%', '82%', '#ec4899']];
  return `<div class="wp-confetti">${D.map(d => `<i style="left:${d[0]};top:${d[1]};background:${d[2]}"></i>`).join('')}</div>`;
}

function phoneNat(e164) { if (!e164) return ''; let s = String(e164).replace(/[^\d+]/g, ''); if (s.startsWith('+58')) s = '0' + s.slice(3); return s; }
function phoneDisplay(e164) { const s = phoneNat(e164); return /^\d{11}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4) : (e164 || ''); }
const GEN = { M: 'Masculino', F: 'Femenino' };
const CIV = { S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a', O: 'Conviviente', R: 'Unión Registrada' };

/* Iniciales para el avatar "sin foto": primera letra del primer nombre y
   primera del primer apellido. Si solo hay una palabra, usa sus dos primeras
   letras. Sirve para dar identidad visual aunque falte la foto. */
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
/* Color de fondo suave estable por cedula (mismo color siempre para la misma
   persona). Paleta clara y discreta, en armonia con los tokens del portal. */
const AVATAR_BG = ['#dbeafe', '#fae8ff', '#dcfce7', '#fef9c3', '#fee2e2', '#e0e7ff', '#ccfbf1', '#ffedd5'];
const AVATAR_FG = ['#1e40af', '#86198f', '#166534', '#854d0e', '#991b1b', '#3730a3', '#0f766e', '#9a3412'];
function avatarColor(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % AVATAR_BG.length;
}

/* ===================== v4.76: JERARQUIA DE CARGOS (solo tiendas) =====================
   Colores por jerarquia (mismo mapa que Configuracion > Cargos): 1 Gerente
   ambar, 2 Sub-Gerente morado, 3 Cajero azul, 4 Vendedor verde,
   5 Depositario gris; sin match -> neutro y al final. El rank de cada
   trabajador se resuelve matcheando su cargo (texto del R10/AX) contra los
   patrones del catalogo que trae el directory (cargo_ranks): primero
   igualdad exacta, luego el patron MAS LARGO contenido en el texto
   (especificidad: SUB GERENTE gana sobre GERENTE). Sin numeros en la UI
   (decision de Pablo): solo el color en el borde y el texto del cargo. */
const CARGO_RANK_COLORS = { 1: '#b45309', 2: '#7e22ce', 3: '#2b6cff', 4: '#0e9f6e', 5: '#64748b' };
const RANK_NONE = 999;
function rankColor(rank) { return CARGO_RANK_COLORS[rank] || '#94a3b8'; }
let RANK_CACHE = new Map();
function normRole(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ' '); }
function workerRank(w) {
  const role = normRole(w.role);
  if (!role || !(STATE.cargoRanks || []).length) return RANK_NONE;
  if (RANK_CACHE.has(role)) return RANK_CACHE.get(role);
  let best = RANK_NONE, bestLen = -1;
  for (const cr of (STATE.cargoRanks || [])) {
    for (const p of (cr.patterns || [])) {
      if (!p) continue;
      if (role === p) { best = cr.rank; bestLen = Infinity; break; }
      if (p.length > bestLen && role.includes(p)) { best = cr.rank; bestLen = p.length; }
    }
    if (bestLen === Infinity) break;
  }
  RANK_CACHE.set(role, best);
  return best;
}

/* Barra de contexto de empresa (codigo + razon social + RIF/zona/subzona/
   concepto + estado). Compartida por la LISTA y la FICHA para que en ambas
   se vea siempre a que empresa pertenece el personal. */
function companyBarHtml(c) {
  c = c || {};
  const statusPill = /abier/i.test(c.status || '')
    ? '<span class="pill pill-open">Abierta</span>'
    : (c.status ? `<span class="pill pill-gray">${esc(c.status)}</span>` : '');
  return `<div class="ff-emp">
      <div class="ff-emp-main">
        <span class="ff-emp-code">${esc(c.code || '')}</span>
        <span class="ff-emp-name">${esc(c.business_name || '')}</span>
      </div>
      ${c.tax_id ? `<span class="ff-emp-item"><span class="k">RIF</span>${esc(c.tax_id)}</span>` : ''}
      ${c.zone ? `<span class="ff-emp-item"><span class="k">Zona</span>${esc(c.zone)}</span>` : ''}
      ${c.subzone ? `<span class="ff-emp-item"><span class="k">Subzona</span>${esc(c.subzone)}</span>` : ''}
      ${c.concept ? `<span class="ff-emp-item"><span class="k">Concepto</span>${esc(c.concept)}</span>` : ''}
      ${statusPill}
    </div>`;
}

/* ===================== ESTADO ===================== */
let STATE = null;   // { user, cc, onExit, workers, q, company, banks, bankMap, mode, adminId }

/* ===================== ENTRADA ===================== */
/* opts.mode: 'store' (tienda, Reporte 10) | 'enterprise' (empresa no-tienda,
   Reporte AX). En modo enterprise la carga de lista usa /api/enterprise-roster
   (solo admin/superadmin) y se manda el adminId. La foto y la ficha van igual
   a /api/worker-photo (workers_master por cedula), que ya es tabla-aware. */
export async function renderWorkerPhotos(user, companyCode, onExit, opts) {
  const mode = (opts && opts.mode) === 'enterprise' ? 'enterprise' : 'store';
  const adminId = user && user.kind === 'admin' ? (user.id || null) : null;
  const isAdmin = !!(user && user.kind === 'admin');
  // isSuper: solo el superadmin real. El gestor_empresa entra con
  // kind==='admin' (por eso isAdmin es true para el), pero NO debe poder
  // crear departamentos: eso queda reservado al superadmin.
  const isSuper = !!(user && user.kind === 'admin' && user.role === 'superadmin');
  // v4.18: el DEPARTAMENTO solo se edita en empresas NO-tienda y nunca por un
  // gestor_empresa. En tiendas es fijo (Retail): la ficha lo muestra bloqueado
  // y solo queda el atajo "Asignar Retail" para quien no lo tiene.
  const isGestor = !!(user && user.kind === 'admin' && user.role === 'gestor_empresa');
  const canEditDept = mode === 'enterprise' && !isGestor;

  // v5.01: permisos FINOS de la propia sesion (matriz de Roles) para gatear
  // la UI. El server ya rechaza con gates reales (photo.manage / ficha.edit /
  // hcm.publish / dept.assign); esto evita mostrar botones que darian 403
  // (ej. rol Supervisor Tiendas con solo view.*). La tienda (rol 'tienda')
  // tiene photo.manage + ficha.edit en la matriz: su flujo no cambia. Si la
  // consulta falla, se queda el comportamiento historico y decide el server.
  let CANP = { photo: true, ficha: true, publish: isAdmin, dept: isAdmin };
  try {
    const pr = await fetch('/api/my-perms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null },
        codes: ['photo.manage', 'ficha.edit', 'hcm.publish', 'dept.assign'],
      }),
    }).then(r => r.json());
    if (pr && pr.ok) {
      const p = pr.perms || {};
      CANP = pr.super
        ? { photo: true, ficha: true, publish: true, dept: true }
        : { photo: !!p['photo.manage'], ficha: !!p['ficha.edit'], publish: !!p['hcm.publish'], dept: !!p['dept.assign'] };
    }
  } catch (_) { /* sin red: UI historica, el server protege */ }

  STATE = { user, cc: companyCode, onExit: onExit || null, workers: [], q: '', company: null, bankMap: {}, mode, adminId, isAdmin, isSuper, isGestor, canEditDept, can: CANP, departments: [], cargoRanks: [], selMode: false, selected: new Set(),
    sortKey: mode === 'enterprise' ? 'name_az' : 'rank', fPhoto: 'all', fGender: 'all', fCargo: 'ALL', fDept: 'ALL', fStatus: new Set(['active', 'new']) };  // v6.20: nace mostrando Activos + Ingresados (= todos los vigentes)

  const back = onExit
    ? `<button class="btn" id="wpBack" style="margin-bottom:14px">← Volver</button>`
    : '';

  $('#pnlMain').innerHTML = `
    <div id="wpGridView">
      ${back}
      <div id="wpEmpBar"></div>
      <div class="pnl-head">
        <div><h1>Personal</h1><p id="wpInfo">Cargando personal de ${esc(companyCode)}…</p></div>
        <div class="head-actions">
          <a class="btn wp-guia-link" id="wpGuiaFoto" href="/guias/foto-carnet.html" target="_blank" rel="noopener" title="Guia: como tomar la foto del carnet"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg> ¿Como tomar la foto?</a>
          <button class="btn" id="wpReload" title="Recargar la lista"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Recargar</button>
          <button class="btn" id="wpExport" title="Exportar lo que se ve en la lista (respeta los filtros)"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg> Exportar</button>
          ${(isAdmin && CANP.publish) ? `<button class="btn btn-primary" id="wpAxApi" title="Actualizar: trae lo ultimo de AX (pisa cambios locales)" aria-label="Actualizar desde AX"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg> Actualizar</button>` : ''}
          ${(isAdmin && CANP.publish) ? `<button class="btn" id="wpPublish" title="Publicar: envia a AX los cambios hechos aqui" aria-label="Publicar cambios en AX" disabled><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg> Publicar <span id="wpPublishN" class="wp-pubcount">0</span></button>` : ''}
          ${(isAdmin && mode === 'enterprise' && CANP.dept) ? `<button class="btn" id="wpAssignDept" title="Seleccionar varias personas y asignarles departamento"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg> Asignar depto.</button>` : ''}
          ${(isSuper && mode === 'enterprise') ? `<button class="btn" id="wpNewDept" title="Nuevo departamento" aria-label="Nuevo departamento"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg> Nuevo departamento</button>` : ''}
          ${isSuper ? `<button class="btn wp-btn-danger" id="wpClear" title="Limpiar lista de personal (mantenimiento, solo superadministrador)" aria-label="Limpiar lista de personal"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Limpiar lista</button>` : ''}
        </div>
      </div>
      <div id="wpRosterBar" class="wp-rosterbar" style="display:none"></div>
      <div id="wpDemo"></div>
      <div class="pnl-filters">
        <div class="search"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><input id="wpSearch" placeholder="Buscar por nombre, cédula o cargo (separa con coma)…"></div>
        <select id="wpfPhoto">
          <option value="all">Foto: todas</option>
          <option value="without">Sin foto</option>
          <option value="with">Con foto</option>
        </select>
        <select id="wpfGender">
          <option value="all">Sexo: todos</option>
          <option value="M">Masculino</option>
          <option value="F">Femenino</option>
        </select>
        <select id="wpfCargo"><option value="ALL">Todos los cargos</option></select>
        <select id="wpfDept" style="display:none"><option value="ALL">Todos los deptos.</option></select>
        <div id="wpfStatus" class="wp-stdd">
          <button type="button" class="wp-stdd-btn" id="wpfStatusBtn" title="Estados a mostrar — podés combinar varios">
            <span id="wpfStatusLbl">Activos + Ingresados</span>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="wp-stdd-pop" id="wpfStatusPop" hidden>
            <label><input type="checkbox" value="active" checked> Activos</label>
            <label><input type="checkbox" value="new" checked> Ingresados</label>
            <label><input type="checkbox" value="transfer"> Traslados</label>
            <label><input type="checkbox" value="inactive"> Egresados</label>
          </div>
        </div>
        <select id="wpSort">
          ${mode !== 'enterprise' ? '<option value="rank">Orden: Jerarquía de cargo</option>' : ''}
          <option value="name_az">Orden: Nombre (A→Z)</option>
          <option value="name_za">Orden: Nombre (Z→A)</option>
          <option value="photo_pending">Orden: Sin foto primero</option>
          <option value="photo_loaded">Orden: Con foto primero</option>
          <option value="photo_recent">Orden: Última foto primero</option>
          <option value="edit_recent">Orden: Última edición primero</option>
          <option value="cargo_az">Orden: Cargo (A→Z)</option>
          <option value="tenure_old">Orden: Más antiguo</option>
          <option value="tenure_new">Orden: Más reciente</option>
          <option value="age_desc">Orden: Mayor edad</option>
          <option value="age_asc">Orden: Menor edad</option>
          <option value="sex">Orden: Sexo (M→F)</option>
          <option value="ced_asc">Orden: Cédula</option>
        </select>
      </div>
      <div class="muted" id="wpShown" style="font-size:12px;margin:-2px 2px 10px;display:none"></div>
      <div id="wpSelBar" class="wp-rosterbar" style="display:none;align-items:center;gap:10px;flex-wrap:wrap"></div>
      <div id="wpGrid" class="wp-grid"><div class="pnl-loading">Cargando…</div></div>
    </div>
    <div id="wpFichaHost"></div>
    <div id="wpModalHost"></div>`;

  if (onExit) $('#wpBack').addEventListener('click', onExit);
  // v4.49: exportar lo visible (xlsx/csv/txt), todos los roles.
  const expBtn = $('#wpExport');
  if (expBtn) expBtn.addEventListener('click', () => wpOpenExportMenu(expBtn));
  // v4.50: asignacion masiva de departamento (empresas no-tienda, admin+super).
  const adBtn = $('#wpAssignDept');
  if (adBtn) adBtn.addEventListener('click', toggleSelMode);
  const reloadBtn = $('#wpReload');
  if (reloadBtn) reloadBtn.addEventListener('click', async () => {
    reloadBtn.disabled = true;
    const info = $('#wpInfo'); if (info) info.textContent = 'Recargando…';
    await load();
    reloadBtn.disabled = false;
  });
  $('#wpSearch').addEventListener('input', e => { STATE.q = e.target.value; paintGrid(); });
  const onFilterChange = () => {
    STATE.fPhoto = $('#wpfPhoto').value;
    STATE.fGender = $('#wpfGender').value;
    STATE.fCargo = $('#wpfCargo').value;
    const ds = $('#wpfDept'); STATE.fDept = ds ? ds.value : 'ALL';
    // v6.15: estados por checkbox (multi-selección; el change burbujea
    // desde los inputs al div, mismo listener).
    STATE.fStatus = new Set([...document.querySelectorAll('#wpfStatus input[type="checkbox"]:checked')].map(i => i.value));
    paintGrid();
  };
  ['#wpfPhoto', '#wpfGender', '#wpfCargo', '#wpfDept', '#wpfStatus'].forEach(id => {
    const el = $(id); if (el) el.addEventListener('change', onFilterChange);
  });
  // v6.16: mecánica del combo de estado (checkboxes adentro). El change de
  // los checkboxes burbujea a #wpfStatus (listener de arriba); acá solo va
  // abrir/cerrar el popover y el resumen del botón. El popover queda
  // abierto al marcar (para combinar varios); cierra con clic afuera o Esc.
  {
    const stBtn = $('#wpfStatusBtn'), stPop = $('#wpfStatusPop');
    const stNames = { active: 'Activos', new: 'Ingresados', transfer: 'Traslados', inactive: 'Egresados' };
    const stLabel = () => {
      const el = $('#wpfStatusLbl');
      if (!el) return;
      const on = [...document.querySelectorAll('#wpfStatusPop input:checked')].map(i => stNames[i.value]);
      el.textContent = on.length === 4 ? 'Estado: todos' : on.length === 0 ? 'Estado: ninguno' : on.length === 3 ? '3 estados' : on.join(' + ');
    };
    if (stBtn && stPop) {
      stBtn.addEventListener('click', (ev) => { ev.stopPropagation(); stPop.hidden = !stPop.hidden; });
      stPop.addEventListener('click', (ev) => ev.stopPropagation());
      document.addEventListener('click', () => { if (stPop.isConnected && !stPop.hidden) stPop.hidden = true; });
      document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && stPop.isConnected && !stPop.hidden) stPop.hidden = true; });
      stPop.addEventListener('change', stLabel);
      stLabel();
    }
  }
  $('#wpSort').addEventListener('change', e => { STATE.sortKey = e.target.value; paintGrid(); });
  const reporteBtn = $('#wpReporte');
  if (reporteBtn) reporteBtn.addEventListener('click', STATE.mode === 'enterprise' ? openReporteAXModal : openReporteModal);
  const axApiBtn = $('#wpAxApi');
  if (axApiBtn) axApiBtn.addEventListener('click', () => {
    // Si hay cambios sin publicar, avisar que Actualizar los descartara.
    const n = pendingWorkers().length;
    if (n > 0) openDiscardConfirmModal(n);
    else openAxApiModal();
  });
  const publishBtn = $('#wpPublish');
  if (publishBtn) publishBtn.addEventListener('click', () => openPublishModal(null));
  const clearBtn = $('#wpClear');
  if (clearBtn) clearBtn.addEventListener('click', openClearModal);
  const newDeptBtn = $('#wpNewDept');
  if (newDeptBtn) newDeptBtn.addEventListener('click', openNewDeptModal);

  await load();

  // Apertura directa de una ficha (ej. desde "Buscar personal"): tras cargar
  // la lista, abre la tarjeta del trabajador indicado por cedula.
  if (opts && opts.openCed) {
    const target = STATE.workers.find(x => String(x.id_number) === String(opts.openCed));
    if (target) { STATE.fichaDirect = true; openFicha(String(opts.openCed)); }
  }
}

/* Carga (o recarga) el directorio de la empresa y repinta grid + barra.
   Se llama al entrar y despues de cada accion de gestion (actualizar lista,
   agregar manual, limpiar). */
async function load() {
  // Reiniciar el estado del lazy-loader de fotos: el directory no firma, asi
  // que todas las fotos vuelven a pedirse por viewport.
  PHOTO_QUEUE = new Set();
  if (PHOTO_TIMER) { clearTimeout(PHOTO_TIMER); PHOTO_TIMER = null; }
  if (PHOTO_OBS) { PHOTO_OBS.disconnect(); PHOTO_OBS = null; }
  const d = await api({ action: 'directory', company_code: STATE.cc, user: sessionUserPayload(STATE.user) });
  if (!d.ok) {
    $('#wpGrid').innerHTML = `<div class="card"><p class="muted" style="margin:0">No se pudo cargar: ${esc(d.error || 'error')}</p></div>`;
    $('#wpInfo').textContent = 'Error al cargar';
    return;
  }
  STATE.workers = d.workers || [];
  STATE.company = d.company || { code: STATE.cc };
  STATE.bankMap = d.bank_map || {};
  STATE.departments = d.departments || [];
  // v4.76: catalogo de jerarquia de cargos (solo tiendas). Reset del cache
  // de resolucion cargo->rank por si el catalogo cambio entre recargas.
  STATE.cargoRanks = d.cargo_ranks || [];
  RANK_CACHE = new Map();
  STATE.meta = d.meta || null;
  STATE.manualCount = d.manual_count || 0;
  STATE.reportCount = d.report_count != null ? d.report_count : (STATE.workers.length - STATE.manualCount);
  const empBar = $('#wpEmpBar');
  if (empBar) empBar.innerHTML = companyBarHtml(STATE.company);
  updateInfo(d);
  paintRosterBar();
  paintDemo();
  fillFilterOptions();
  refreshPublishBtn();
  paintGrid();
}

/* Cuenta los trabajadores con cambios sin publicar (ax_pending) en la lista
   actual y actualiza el boton "Publicar (N)" de la barra: se muestra solo si
   hay pendientes. Solo aplica a admin (el boton solo existe para admin). */
function pendingWorkers() {
  return (STATE.workers || []).filter(w => w.ax_pending);
}
function refreshPublishBtn() {
  const btn = $('#wpPublish');
  if (!btn) return;
  const n = pendingWorkers().length;
  const nEl = $('#wpPublishN');
  if (nEl) nEl.textContent = n;
  // El boton queda SIEMPRE visible: grisado (disabled) cuando no hay
  // pendientes, activo cuando hay al menos uno. Asi el usuario ve que la
  // accion existe aunque ahora no haya nada que publicar.
  btn.disabled = n === 0;
}

/* Barra de estado del roster (v6.12): la fuente de verdad es el roster
   VIVO — la corrida automatica de egresos lo mantiene a diario y refresca
   store_roster_meta (active_count + auto_refreshed_at). La barra dice
   cuantos ACTIVOS hay AHORA, de donde vino la ultima carga (API AX /
   Reporte 10) y si el sistema la esta manteniendo. El "conviene
   actualizar" solo aparece cuando NI la carga NI el refresco automatico
   son recientes: el Reporte 10 es el mecanismo de emergencia, no la
   rutina (pedido de Pablo 18/07). */
function paintRosterBar() {
  const bar = $('#wpRosterBar');
  if (!bar) return;
  const meta = STATE.meta;
  const manual = STATE.manualCount || 0;
  if (!meta && !STATE.workers.length) {
    bar.style.display = 'none';
    return;
  }
  const total = (STATE.workers || []).length;
  const activos = (STATE.workers || []).filter(w => isVigente(w)).length;  // v6.15: vigentes a la fecha
  const traslados = (STATE.workers || []).filter(w => !isVigente(w) && w.now_at).length;

  let when = 'sin registro de carga';
  if (meta && meta.uploaded_at) {
    const d = new Date(meta.uploaded_at);
    if (!isNaN(d)) {
      const c = new Date(d.getTime() - 4 * 3600 * 1000);
      const z = n => String(n).padStart(2, '0');
      when = `${z(c.getUTCDate())}/${z(c.getUTCMonth() + 1)}/${c.getUTCFullYear()}`;
    }
  }
  // v6.14: sin nombres técnicos en la leyenda (pedido de Pablo): la carga
  // que hizo el sistema se dice "automática", no "API AX".
  const srcName = (meta && meta.source === 'ax_api') ? 'automática'
    : (STATE.mode === 'enterprise' ? 'Reporte AX' : 'Reporte 10');

  // Frescura: refresco automatico reciente (<=2 dias) => el sistema esta
  // manteniendo la lista y no se invita a cargar nada. Sin refresco
  // reciente (o modo empresa, sin corrida) => criterio historico por edad.
  let freshTxt = '';
  const ref = meta && meta.auto_refreshed_at ? new Date(meta.auto_refreshed_at) : null;
  const refOk = ref && !isNaN(ref) && (Date.now() - ref.getTime()) <= 2 * 86400000;
  if (refOk) {
    freshTxt = `<span class="rb-ok">🔄 al día por la corrida automática (${fmtDateTime(meta.auto_refreshed_at)})</span>`;
  } else {
    const age = rosterAgeDays(meta);
    if (age != null) {
      if (age <= 7) freshTxt = `<span class="rb-ok">carga de hace ${age} día${age === 1 ? '' : 's'}</span>`;
      else freshTxt = `<span class="rb-old">⚠ carga de hace ${age} días — conviene actualizar</span>`;
    }
  }

  bar.style.display = 'flex';
  bar.innerHTML = `
    <span class="rb-ic">📋</span>
    <span><b>${total}</b> en la lista · <b>${activos}</b> activo${activos === 1 ? '' : 's'}${traslados ? ` · ${traslados} traslado${traslados === 1 ? '' : 's'}` : ''}${manual ? ` · ${manual} manual${manual === 1 ? '' : 'es'}` : ''} · última carga: <b>${srcName}</b> el <b>${when}</b></span>
    ${freshTxt ? `<span class="rb-sep"></span>${freshTxt}` : ''}`;
}

/* v6.32: el resumen del encabezado cuenta LO QUE SE VE (respeta filtros y
   búsqueda, igual que Exportar): con filtros activos dice "X mostrados
   (de Y)"; sin filtros, el total simple. Fotos y pendientes también se
   cuentan sobre lo visible. Se recalcula en cada paintGrid, y la línea
   "Mostrando X de Y" quedó absorbida. La barra de inventario (wpRosterBar)
   sigue contando la lista completa: ese es su trabajo. El parámetro d de
   los llamadores viejos se ignora. */
function updateInfo() {
  const el = $('#wpInfo');
  if (!el) return;
  const total = STATE.workers.length;
  const list = currentFiltered();
  const withPhoto = list.filter(w => w.has_photo).length;
  const base = list.length === total
    ? `${total} colaboradores`
    : `${list.length} mostrados <span style="color:var(--faint,#94a3b8);font-weight:400">(de ${total})</span>`;
  el.innerHTML = `${base} · <b style="color:var(--success)">${withPhoto} con foto</b> · ${list.length - withPhoto} pendientes`;
}

function bankName(acc) {
  if (!acc) return null;
  return STATE.bankMap[String(acc).slice(0, 4)] || null;
}

/* ===================== DEMOGRAFIA (cards del detalle) =====================
   Sexo / Edades / Estado civil / Cargos del roster cargado. Se ocultan si no
   hay personal. En empresas NO-tienda no se muestra Cargos (muy diversos).
   Todo se calcula del roster que ya devuelve /api/worker-photo (directory). */
function demoBars(arr, color) {
  const max = Math.max(1, ...arr.map(x => x[1]));
  return arr.map(([l, v]) =>
    `<div class="wpd-bar"><span class="wpd-bl">${l}</span>`
    + `<div class="wpd-bt"><i style="width:${Math.round(v / max * 100)}%;background:${color}"></i></div>`
    + `<span class="wpd-bn">${v}</span></div>`).join('');
}
function demoStatsHtml(workers, mode) {
  if (!workers || !workers.length) return '';
  // Sexo (solo M/F con dato). Hombre azul ♂, mujer rosado ♀.
  const m = workers.filter(w => w.gender === 'M').length;
  const f = workers.filter(w => w.gender === 'F').length;
  const sexTot = m + f;
  const mp = sexTot ? Math.round(m / sexTot * 100) : 0;
  const fp = sexTot ? 100 - mp : 0;
  const sexBody = sexTot
    ? `<div class="wpd-sexbar"><i style="width:${mp}%;background:#2563eb"></i><i style="width:${fp}%;background:#ec4899"></i></div>`
      + `<div class="wpd-sexleg">`
      + `<span class="side"><span class="lab m">M</span><b class="pct">${mp}%</b><span class="cnt">${m}</span></span>`
      + `<span class="side"><span class="lab f">F</span><b class="pct">${fp}%</b><span class="cnt">${f}</span></span>`
      + `</div>`
    : '<div class="wpd-empty">Sin datos de sexo</div>';
  // Edades (guarda 15-75; fechas imposibles cuentan como sin dato).
  const ages = workers.map(w => ageFrom(w.birth_date)).filter(a => a != null && a >= 15 && a <= 75);
  const ageBuckets = [
    ['< 20', ages.filter(a => a < 20).length],
    ['20–24', ages.filter(a => a >= 20 && a <= 24).length],
    ['25–29', ages.filter(a => a >= 25 && a <= 29).length],
    ['30–34', ages.filter(a => a >= 30 && a <= 34).length],
    ['35–44', ages.filter(a => a >= 35 && a <= 44).length],
    ['45+', ages.filter(a => a >= 45).length],
  ];
  const ageBody = ages.length
    ? `<div class="wpd-bars">${demoBars(ageBuckets, '#4f46e5')}</div>`
    : '<div class="wpd-empty">Sin fechas de nacimiento</div>';
  // Estado civil
  const civDefs = [['Soltero', 'S'], ['Casado', 'C'], ['Divorc.', 'D'], ['Viudo', 'V'], ['Conviv.', 'O'], ['Un. reg.', 'R']];
  const civBuckets = civDefs.map(([lbl, code]) => [lbl, workers.filter(w => w.marital_status === code).length]);
  const civWith = civBuckets.reduce((a, x) => a + x[1], 0);
  const civBody = civWith
    ? `<div class="wpd-bars">${demoBars(civBuckets, '#0d9488')}</div>`
    : '<div class="wpd-empty">Sin estado civil</div>';
  // Cargos: solo tiendas (en no-tienda los cargos son muy diversos).
  let cargoCard = '';
  if (mode !== 'enterprise') {
    const rc = {};
    workers.forEach(w => { if (w.role) rc[w.role] = (rc[w.role] || 0) + 1; });
    const cargos = Object.entries(rc).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const cargoBody = cargos.length
      ? `<div class="wpd-bars">${demoBars(cargos, '#d97706')}</div>`
      : '<div class="wpd-empty">Sin cargos</div>';
    cargoCard = `<div class="wpd-card"><div class="wpd-head"><span class="t">Cargos</span>`
      + `<span class="n">${cargos.length} tipo${cargos.length === 1 ? '' : 's'}</span></div>${cargoBody}</div>`;
  }
  const cols3 = mode === 'enterprise' ? ' cols3' : '';
  return `
    <div class="wpd-stats${cols3}">
      <div class="wpd-card"><div class="wpd-head"><span class="t">Sexo</span><span class="n">${sexTot} con dato</span></div>${sexBody}</div>
      <div class="wpd-card"><div class="wpd-head"><span class="t">Edades</span><span class="n">${ages.length} con fecha</span></div>${ageBody}</div>
      <div class="wpd-card"><div class="wpd-head"><span class="t">Estado civil</span><span class="n">${civWith} con dato</span></div>${civBody}</div>
      ${cargoCard}
    </div>`;
}
function paintDemo() {
  const host = $('#wpDemo');
  if (!host) return;
  host.innerHTML = demoStatsHtml(STATE.workers, STATE.mode);
}

/* ===================== FILTRO + ORDEN =====================
   Toda la grilla pasa por currentFiltered() (busqueda + filtros) y luego por
   sortWorkers() (orden elegido). Los datos faltantes van al final y el
   desempate siempre es por nombre, para que el orden sea estable. */
function cmpName(a, b) {
  return String(a.full_name || '').localeCompare(String(b.full_name || ''), 'es', { sensitivity: 'base' });
}
/* Normaliza texto para buscar: minusculas, sin acentos y con la enie mapeada
   a n (mismo criterio que la busqueda global en SQL con unaccent), para que
   "nunez" encuentre "NUNEZ". */
function normSearch(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00f1/g, 'n');   // enie -> n (unaccent en SQL hace lo mismo)
}
/* Interpreta el texto del buscador como grupos separados por COMA (OR entre
   grupos) y, dentro de cada grupo, palabras separadas por espacio (AND). Un
   trabajador coincide si ALGUN grupo tiene TODOS sus tokens en su blob
   (cedula + nombre + cargo). Devuelve [] si no hay texto (sin filtro). */
function parseSearchGroups(q) {
  return normSearch(q)
    .split(',')
    .map(g => g.split(/\s+/).filter(Boolean))   // tokens del grupo
    .filter(g => g.length);                      // descarta grupos vacios
}
function matchesSearch(w, groups) {
  if (!groups.length) return true;
  const blob = normSearch(
    `${w.id_number || ''} ${w.full_name || ''} ${w.role || ''}`
  );
  // OR entre grupos: basta que UN grupo tenga TODOS sus tokens en el blob.
  return groups.some(tokens => tokens.every(t => blob.includes(t)));
}
/* Lista filtrada por busqueda + filtros activos (sin ordenar). La usan el grid
   y "Marcar todos" para que ambos vean exactamente lo mismo. */
function currentFiltered() {
  const groups = parseSearchGroups(STATE.q || '');
  // Resolver el nombre del depto elegido una sola vez (los trabajadores traen
  // department_name, no el id, asi que filtramos por nombre).
  let fDepName = null;
  if (STATE.fDept !== 'ALL' && STATE.fDept !== '__none') {
    const dep = (STATE.departments || []).find(d => String(d.id) === String(STATE.fDept));
    fDepName = dep ? dep.name : null;
  }
  return STATE.workers.filter(w => {
    // Busqueda: grupos separados por coma (OR), palabras por espacio (AND),
    // sin acentos. Ver matchesSearch/parseSearchGroups.
    if (!matchesSearch(w, groups)) return false;
    if (STATE.fPhoto === 'with' && !w.has_photo) return false;
    if (STATE.fPhoto === 'without' && w.has_photo) return false;
    if (STATE.fGender !== 'all' && w.gender !== STATE.fGender) return false;
    if (STATE.fCargo !== 'ALL') {
      if (STATE.fCargo === '__none') { if (w.role) return false; }
      else if (w.role !== STATE.fCargo) return false;
    }
    if (STATE.fDept !== 'ALL') {
      if (STATE.fDept === '__none') { if (w.department_name) return false; }
      else if (w.department_name !== fDepName) return false;
    }
    // v6.15/v6.20 (checkboxes multi): cada persona tiene UN estado y se
    // muestra si su checkbox está marcado. new = vigente con menos de 30
    // días de antigüedad (Ingresado, celda verde NUEVO); active = vigente
    // estable; transfer = fin cumplido + activa en otra empresa del grupo
    // (now_at); inactive = fin cumplido sin traslado (egreso real). Sin
    // ningún checkbox marcado no se muestra nadie (decisión del usuario).
    {
      const kind = isVigente(w)
        ? (isNuevoIngreso(w) ? 'new' : 'active')
        : (w.now_at ? 'transfer' : 'inactive');
      if (!(STATE.fStatus instanceof Set) || !STATE.fStatus.has(kind)) return false;
    }
    return true;
  });
}
/* Ordena EN SITIO segun STATE.sortKey. */
function sortWorkers(list) {
  const k = STATE.sortKey || 'name_az';
  list.sort((a, b) => {
    switch (k) {
      case 'rank': return (workerRank(a) - workerRank(b)) || cmpName(a, b);
      case 'name_za': return -cmpName(a, b);
      case 'photo_pending': return ((a.has_photo ? 1 : 0) - (b.has_photo ? 1 : 0)) || cmpName(a, b);
      case 'photo_loaded': return ((b.has_photo ? 1 : 0) - (a.has_photo ? 1 : 0)) || cmpName(a, b);
      case 'cargo_az': {
        const ra = a.role || '', rb = b.role || '';
        if (!ra && rb) return 1; if (ra && !rb) return -1;
        return ra.localeCompare(rb, 'es', { sensitivity: 'base' }) || cmpName(a, b);
      }
      case 'tenure_old': case 'tenure_new': {
        const da = a.start_date || '', db = b.start_date || '';
        if (!da && db) return 1; if (da && !db) return -1; if (da === db) return cmpName(a, b);
        return k === 'tenure_old' ? (da < db ? -1 : 1) : (da > db ? -1 : 1);
      }
      // v5.88: mas reciente primero por fecha de FOTO o de EDICION de ficha.
      // Comparacion directa de ISO strings (ordenan igual que la fecha);
      // sin dato al final y desempate estable por nombre.
      case 'photo_recent': case 'edit_recent': {
        const key = k === 'photo_recent' ? 'photo_uploaded_at' : 'profile_updated_at';
        const da = a[key] || '', db = b[key] || '';
        if (!da && !db) return cmpName(a, b);
        if (!da) return 1; if (!db) return -1;
        return da === db ? cmpName(a, b) : (da > db ? -1 : 1);
      }
      case 'age_desc': case 'age_asc': {
        const aa = ageFrom(a.birth_date), ab = ageFrom(b.birth_date);
        if (aa == null && ab == null) return cmpName(a, b);
        if (aa == null) return 1; if (ab == null) return -1;
        return (k === 'age_desc' ? ab - aa : aa - ab) || cmpName(a, b);
      }
      case 'sex': {
        const ord = g => (g === 'M' ? 0 : g === 'F' ? 1 : 2);
        return (ord(a.gender) - ord(b.gender)) || cmpName(a, b);
      }
      case 'ced_asc': {
        const na = parseInt(String(a.id_number).replace(/\D/g, ''), 10) || 0;
        const nb = parseInt(String(b.id_number).replace(/\D/g, ''), 10) || 0;
        return (na - nb) || cmpName(a, b);
      }
      default: return cmpName(a, b);
    }
  });
  return list;
}
/* Rellena los combos que dependen del roster: Cargo (cargos presentes) y
   Departamento (solo si la empresa tiene). Conserva la seleccion si sigue
   siendo valida tras recargar la lista. */
function fillFilterOptions() {
  const cargoSel = $('#wpfCargo');
  if (cargoSel) {
    const roles = [...new Set(STATE.workers.map(w => w.role).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    const hasNone = STATE.workers.some(w => !w.role);
    const cur = STATE.fCargo;
    cargoSel.innerHTML = '<option value="ALL">Todos los cargos</option>'
      + roles.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('')
      + (hasNone ? '<option value="__none">— Sin cargo —</option>' : '');
    if ([...cargoSel.options].some(o => o.value === cur)) cargoSel.value = cur;
    else STATE.fCargo = 'ALL';
  }
  const deptSel = $('#wpfDept');
  if (deptSel) {
    if (STATE.departments && STATE.departments.length) {
      deptSel.style.display = '';
      const cur = STATE.fDept;
      deptSel.innerHTML = '<option value="ALL">Todos los deptos.</option>'
        + STATE.departments.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')
        + '<option value="__none">— Sin departamento —</option>';
      if ([...deptSel.options].some(o => o.value === cur)) deptSel.value = cur;
      else STATE.fDept = 'ALL';
    } else {
      deptSel.style.display = 'none';
      STATE.fDept = 'ALL';
    }
  }
}

/* ===================== GRID ===================== */
function paintGrid() {
  const grid = $('#wpGrid');
  if (!grid) return;
  ensureFootStyles();
  const list = sortWorkers(currentFiltered());
  // v6.32: el resumen del encabezado (wpInfo) cuenta lo visible y se
  // recalcula en cada repintado; "Mostrando X de Y" quedó absorbida ahí.
  updateInfo();
  const shown = $('#wpShown');
  if (shown) shown.style.display = 'none';
  const sel = STATE.selMode;

  grid.innerHTML = list.map(w => {
    const ci = avatarColor(w.id_number);
    // v4.76: color del cargo por jerarquia (solo tiendas). Sin match ->
    // neutro. Pinta el borde superior de la tarjeta y el texto del cargo.
    const rk = STATE.mode === 'enterprise' ? RANK_NONE : workerRank(w);
    const rkColor = STATE.mode === 'enterprise' ? null : rankColor(rk);
    // Tres estados de la foto en la tarjeta:
    //  - thumb_url presente (esquema nuevo: URL publica directa) -> <img> ya.
    //  - needs_sign (foto vieja sin firmar) -> spinner; el lazy-loader la
    //    pide con 'sign' al entrar en pantalla.
    //  - sin foto -> avatar de iniciales + "Sin foto".
    const photo = w.thumb_url
      ? `<img src="${w.thumb_url}" alt="${esc(w.full_name)}" loading="lazy">`
      : w.needs_sign
        ? `<div class="wp-photoload"><div class="wp-spin"></div></div>`
        : `<div class="wp-empty">`
          + `<div class="wp-initials" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(w.full_name))}</div>`
          + `<span class="wp-nophoto"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>Sin foto</span>`
          + `</div>`;
    // v6.13/v6.15: el chip cuenta la historia de cada uno. Fin FUTURO
    // (vigente) = ámbar "fin dd/mm" (contrato con fin conocido que sigue
    // corriendo); fin cumplido = azul traslado o rojo egreso real.
    const egr = !w.end_date ? ''
      : isVigente(w)
        ? `<span class="pill" style="margin-top:4px;display:inline-block;background:#fdf3e7;color:#b45309" title="Contrato con fin ${fmtDate(w.end_date)} — sigue vigente a la fecha">fin ${fmtDate(w.end_date)}</span>`
        : w.now_at
          ? `<span class="pill" style="margin-top:4px;display:inline-block;background:#e8effc;color:#1d4ed8" title="Egresó de ${esc(STATE.cc)} el ${fmtDate(w.end_date)} · activo en ${esc(w.now_at)}${w.now_since ? ' desde el ' + fmtDate(w.now_since) : ''}">traslado ${fmtDate(w.end_date)} → ahora en ${esc(w.now_at)}</span>`
          : `<span class="pill pill-out" style="margin-top:4px;display:inline-block">egresó ${fmtDate(w.end_date)}</span>`;
    // v6.23: la otra mitad del espejo — TRASLADO RECIBIDO. Si un ingresado
    // reciente venía de otra empresa del grupo (fila cerrada allá con el fin
    // pegado a este ingreso), el chip índigo dice de dónde vino y qué cargo
    // tenía allá — el actual ya lo muestra la tarjeta. (Caso Herrera:
    // uniforme de AA01 en la lista de AA08.)
    const origen = (isVigente(w) && w.from_at)
      ? `<span class="pill" style="margin-top:4px;display:inline-block;background:#eef2ff;color:#4f46e5" title="Ingreso por traslado: venía de ${esc(w.from_at)}${w.from_role ? ' como ' + esc(w.from_role) : ''}${w.from_end ? ' · egresó de allá el ' + fmtDate(w.from_end) : ''}${w.start_date ? ' · ingresó acá el ' + fmtDate(w.start_date) : ''}">vino de ${esc(w.from_at)}${w.from_role ? ' · ' + esc(w.from_role) : ''}</span>`
      : '';
    const manualTag = w.source === 'manual' ? '<span class="pill wp-pill-manual" style="margin-top:4px;display:inline-block">manual</span>' : '';
    // Barra de departamento ARRIBA de la tarjeta.
    //  - Con departamento: etiqueta gris discreta (solo lectura).
    //  - Sin departamento + admin: accion azul clickeable para asignarlo.
    //      * empresa (enterprise): abre modal para elegir de sus departamentos.
    //      * tienda (store): asigna "Retail" directo (unico departamento valido).
    //  - Sin departamento + no admin: no se muestra nada.
    let deptBar = '';
    if (w.department_name) {
      deptBar = `<div class="wp-deptbar"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg><span>${esc(w.department_name)}</span></div>`;
    } else if (STATE.isAdmin && !STATE.isGestor && STATE.can.photo) {
      const label = STATE.mode === 'enterprise' ? 'Asignar departamento' : 'Asignar Retail';
      deptBar = `<div class="wp-deptbar assign" data-assigndept="${w.id_number}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg><span>${label}</span></div>`;
    } else {
      // v6.26 (alto fijo): la barra existe SIEMPRE — invisible pero con su
      // alto — para que la tarjeta sin departamento no quede más baja.
      deptBar = `<div class="wp-deptbar" style="visibility:hidden"><span>·</span></div>`;
    }
    const checked = STATE.selected.has(String(w.id_number));
    const chk = sel
      ? `<span class="wp-selchk" style="position:absolute;top:8px;left:8px;width:22px;height:22px;border-radius:6px;border:2px solid #fff;box-shadow:0 0 0 1px rgba(15,23,42,.18);background:${checked ? 'var(--brand)' : 'rgba(255,255,255,.9)'};display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;z-index:3">${checked ? '✓' : ''}</span>`
      : '';
    const bday = isBirthday(w.birth_date);
    const bflag = (bday && !sel) ? '<span class="wp-bflag">\uD83C\uDF82 \u00a1Cumple hoy!</span>' : '';
    const conf = bday ? confettiHtml() : '';
    // Overlay de la tarjeta. En modo normal ofrece DOS acciones: "Ver ficha"
    // (clic en la tarjeta) y, si hay foto, "Ver foto" (abre el visor grande
    // sin entrar al detalle). En modo seleccion, la etiqueta de marcar/quitar.
    const hasPhoto = !!(w.thumb_url || w.has_photo);
    const ov = sel
      ? `<div class="wp-ov"><span>${checked ? 'Quitar' : 'Seleccionar'}</span></div>`
      : `<div class="wp-ov"><span>Ver ficha</span>${hasPhoto ? '<button type="button" class="wp-ov-photo" data-viewphoto="' + w.id_number + '">' + eyeIco() + ' Ver foto</button>' : ''}</div>`;
    const cardStyles = [];
    if (rkColor) cardStyles.push(`border-top:4px solid ${rkColor}`);
    if (sel && checked) cardStyles.push('outline:2px solid var(--brand)', 'outline-offset:2px', 'border-radius:14px');
    return `<div class="wp-card" data-ced="${w.id_number}"${cardStyles.length ? ` style="${cardStyles.join(';')}"` : ''}>
      ${deptBar}
      <div class="wp-photo${bday ? ' wp-bday' : ''}">${chk}${conf}${photo}${bflag}${ov}</div>
      <div class="wp-body">
        <p class="wp-name">${esc(w.full_name)}</p>
        <span class="wp-ced">${w.ced_kind || ''}-${w.id_number}<button type="button" data-copyced="${w.id_number}" title="Copiar datos" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-left:5px;padding:0;border:1px solid var(--border);border-radius:6px;background:var(--surface,#fff);color:var(--ink-soft,#475569);cursor:pointer;vertical-align:middle"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></span>
        ${`<div class="wp-role"${(w.role && rkColor && rk !== RANK_NONE) ? ` style="color:${rkColor};font-weight:700"` : ''} title="${esc(w.role || '')}">${w.role ? esc(w.role) : '&nbsp;'}</div>`}
        <div class="wp-chips">${egr}${origen}${manualTag}</div>
        <div class="wp-spacer"></div>
        ${miniRowHtml(w)}
      </div>
      ${updFootbarHtml(w)}
    </div>`;
  }).join('') || '<div class="card"><p class="muted" style="margin:0">Sin coincidencias.</p></div>';

  grid.querySelectorAll('.wp-card').forEach(el =>
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-copyced]')) return;
      const ced = String(el.dataset.ced);
      if (STATE.selMode) {
        if (STATE.selected.has(ced)) STATE.selected.delete(ced); else STATE.selected.add(ced);
        paintGrid(); paintSelBar();
      } else openFicha(ced);
    }));

  // v4.48: copiar los datos de la persona desde la tarjeta (todos los roles).
  grid.querySelectorAll('[data-copyced]').forEach(btn =>
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const w = STATE.workers.find(x => String(x.id_number) === String(btn.dataset.copyced));
      if (w) copyWorkerData(w, btn);
    }));

  // Boton "Ver foto" del overlay: abre el visor grande sin entrar a la ficha.
  // stopPropagation para que el clic no dispare el openFicha de la tarjeta.
  grid.querySelectorAll('[data-viewphoto]').forEach(btn =>
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ced = String(btn.dataset.viewphoto);
      const w = STATE.workers.find(x => String(x.id_number) === ced);
      if (!w) return;
      // Pedir la version grande (firma on-demand); si no se logra, usar la
      // miniatura publica (que a tamano carnet se ve bien).
      if (!w.full_url && w.has_photo) await ensureFull(ced);
      const src = w.full_url || w.thumb_url;
      if (!src) return;
      openLightbox(src, `${w.full_name} \u00b7 ${w.ced_kind || ''}-${w.id_number}`, `${w.ced_kind || ''}-${w.id_number}.jpg`);
    }));

  // Barra "Asignar": en empresa abre el modal (elegir departamento); en tienda
  // asigna "Retail" directo (unico departamento valido). stopPropagation para
  // no disparar el openFicha de la tarjeta.
  grid.querySelectorAll('[data-assigndept]').forEach(el =>
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const ced = String(el.dataset.assigndept);
      if (STATE.mode === 'enterprise') { openAssignDeptModal(ced); return; }
      assignRetail(ced, el);
    }));

  observePhotos();
}

/* ===================== LAZY-LOAD DE FOTOS (solo esquema viejo) =====================
   Las fotos NUEVAS (photo_key) ya vienen con su URL publica directa en
   thumb_url, asi que la grilla las pinta de una. Solo las fotos VIEJAS
   (needs_sign) necesitan firma: muestran spinner y, al entrar en pantalla, se
   piden en lotes con 'sign'. Esto queda como fallback hasta migrar todo. El
   observer se rearma en cada paintGrid (filtros/orden/busqueda repintan). */
let PHOTO_OBS = null;
let PHOTO_QUEUE = new Set();
let PHOTO_TIMER = null;
const PHOTO_BATCH = 12;

function observePhotos() {
  const grid = $('#wpGrid');
  if (!grid) return;
  if (PHOTO_OBS) { PHOTO_OBS.disconnect(); PHOTO_OBS = null; }
  if (!('IntersectionObserver' in window)) {
    // Sin IntersectionObserver: pedir todas las viejas pendientes de una.
    STATE.workers.forEach(w => { if (w.needs_sign && !w.thumb_url) PHOTO_QUEUE.add(String(w.id_number)); });
    flushPhotoQueue();
    return;
  }
  PHOTO_OBS = new IntersectionObserver((entries) => {
    let any = false;
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      const ced = String(en.target.dataset.ced || '');
      const w = STATE.workers.find(x => String(x.id_number) === ced);
      if (w && w.needs_sign && !w.thumb_url) { PHOTO_QUEUE.add(ced); any = true; }
      PHOTO_OBS.unobserve(en.target);
    });
    if (any) schedulePhotoFlush();
  }, { root: null, rootMargin: '200px 0px', threshold: 0.01 });
  // Observar solo las tarjetas con spinner (foto vieja pendiente de firmar).
  grid.querySelectorAll('.wp-card').forEach(el => {
    const ced = String(el.dataset.ced || '');
    const w = STATE.workers.find(x => String(x.id_number) === ced);
    if (w && w.needs_sign && !w.thumb_url) PHOTO_OBS.observe(el);
  });
}

function schedulePhotoFlush() {
  if (PHOTO_TIMER) clearTimeout(PHOTO_TIMER);
  PHOTO_TIMER = setTimeout(flushPhotoQueue, 80);
}

async function flushPhotoQueue() {
  if (PHOTO_TIMER) { clearTimeout(PHOTO_TIMER); PHOTO_TIMER = null; }
  if (!PHOTO_QUEUE.size) return;
  // Tomar un lote de la cola.
  const ids = [...PHOTO_QUEUE].slice(0, PHOTO_BATCH);
  ids.forEach(id => PHOTO_QUEUE.delete(id));
  const r = await api({ action: 'sign', company_code: STATE.cc, user: sessionUserPayload(STATE.user), id_numbers: ids });
  if (r && r.ok && r.photos) {
    Object.entries(r.photos).forEach(([ced, p]) => {
      const w = STATE.workers.find(x => String(x.id_number) === String(ced));
      if (!w) return;
      w.thumb_url = p.thumb_url || null;
      w.full_url = p.full_url || null;
      w.has_photo = !!p.has_photo;
      w.needs_sign = false;   // ya firmada (o intentada)
      applyPhotoToCard(String(ced), w);
    });
  }
  // Si quedaron mas en la cola, seguir.
  if (PHOTO_QUEUE.size) schedulePhotoFlush();
}

/* Reemplaza el spinner de UNA tarjeta por su imagen (o por avatar si la firma
   fallo), sin repintar toda la grilla. */
function applyPhotoToCard(ced, w) {
  const grid = $('#wpGrid');
  if (!grid) return;
  const card = grid.querySelector(`.wp-card[data-ced="${ced}"]`);
  if (!card) return;
  const ph = card.querySelector('.wp-photo');
  if (!ph) return;
  const load = ph.querySelector('.wp-photoload');
  if (w.thumb_url) {
    if (load) load.remove();
    // Insertar la imagen al principio del .wp-photo (antes del badge/overlay).
    const img = document.createElement('img');
    img.src = w.thumb_url;
    img.alt = w.full_name || '';
    img.loading = 'lazy';
    img.className = 'wp-fadein';
    ph.insertBefore(img, ph.firstChild);
  } else if (load) {
    // La firma no se pudo: dejar avatar de iniciales en vez de spinner eterno.
    const ci = avatarColor(w.id_number);
    const empty = document.createElement('div');
    empty.className = 'wp-empty';
    empty.innerHTML = `<div class="wp-initials" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(w.full_name))}</div>`
      + `<span class="wp-nophoto"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>Sin foto</span>`;
    load.replaceWith(empty);
  }
}

/* Asegura que UNA persona tenga su foto firmada (para ficha/lightbox). Si ya
   la tiene, no hace nada. Devuelve el worker actualizado. */
async function ensurePhoto(ced) {
  const w = STATE.workers.find(x => String(x.id_number) === String(ced));
  if (!w || !w.has_photo || w.thumb_url) return w;
  const r = await api({ action: 'sign', company_code: STATE.cc, user: sessionUserPayload(STATE.user), id_numbers: [String(ced)] });
  if (r && r.ok && r.photos && r.photos[ced]) {
    const p = r.photos[ced];
    w.thumb_url = p.thumb_url || null;
    w.full_url = p.full_url || null;
    w.has_photo = !!p.has_photo;
    w.needs_sign = false;
  }
  return w;
}

/* Asegura que UNA persona tenga su URL grande (full) firmada, para abrir el
   visor a 800px. En el esquema nuevo la thumb es publica pero la full se firma
   on-demand; esto la pide. Reusa 'sign' (que devuelve thumb + full). */
async function ensureFull(ced) {
  const w = STATE.workers.find(x => String(x.id_number) === String(ced));
  if (!w || !w.has_photo || w.full_url) return w;
  const r = await api({ action: 'sign', company_code: STATE.cc, user: sessionUserPayload(STATE.user), id_numbers: [String(ced)] });
  if (r && r.ok && r.photos && r.photos[ced]) {
    const p = r.photos[ced];
    if (p.thumb_url) w.thumb_url = p.thumb_url;
    w.full_url = p.full_url || null;
  }
  return w;
}

/* ===================== ASIGNACION DE DEPARTAMENTO (masiva) =====================
   Modo seleccion: con "Asignar depto." las tarjetas muestran un check y al
   tocarlas se marcan (en vez de abrir la ficha). La barra permite elegir un
   departamento de la empresa (o "Quitar") y aplicarlo a todos los marcados de
   una sola vez via /api/worker-photo accion set_department. */
function toggleSelMode() {
  STATE.selMode = !STATE.selMode;
  STATE.selected = new Set();
  const btn = $('#wpAssignDept');
  if (btn) btn.classList.toggle('btn-primary', STATE.selMode);
  paintSelBar();
  paintGrid();
}

function paintSelBar() {
  const bar = $('#wpSelBar');
  if (!bar) return;
  if (!STATE.selMode) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';
  const n = STATE.selected.size;
  const opts = (STATE.departments || []).map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  bar.innerHTML = `
    <span class="rb-ic">🏷</span>
    <span><b>${n}</b> seleccionado${n === 1 ? '' : 's'}</span>
    <span class="rb-sep"></span>
    <select id="wpSelDept" style="min-width:170px;padding:6px 8px">
      <option value="">— Departamento —</option>
      ${opts}
      <option value="__none">— Quitar departamento —</option>
    </select>
    <button class="btn btn-sm btn-primary" id="wpSelApply"${n ? '' : ' disabled'}>Asignar a ${n}</button>
    <span style="flex:1"></span>
    <button class="btn btn-sm" id="wpSelAll">Marcar todos</button>
    <button class="btn btn-sm" id="wpSelCancel">Cancelar</button>`;
  $('#wpSelApply').addEventListener('click', applyBulkDept);
  $('#wpSelCancel').addEventListener('click', toggleSelMode);
  $('#wpSelAll').addEventListener('click', () => {
    currentFiltered().forEach(w => STATE.selected.add(String(w.id_number)));
    paintGrid(); paintSelBar();
  });
}

async function applyBulkDept() {
  const selEl = $('#wpSelDept');
  const raw = selEl ? selEl.value : '';
  if (!raw) { alert('Elegí un departamento (o “Quitar departamento”).'); return; }
  const ids = [...STATE.selected];
  if (!ids.length) { alert('No hay trabajadores seleccionados.'); return; }
  const department_id = raw === '__none' ? null : parseInt(raw, 10);
  const btn = $('#wpSelApply'); if (btn) { btn.disabled = true; btn.textContent = 'Asignando…'; }
  const r = await api({
    action: 'set_department', company_code: STATE.cc, user: sessionUserPayload(STATE.user),
    id_numbers: ids, department_id,
  });
  if (!r.ok) { if (btn) { btn.disabled = false; btn.textContent = `Asignar a ${ids.length}`; } wpExportNotice(esc(r.error || 'No se pudo asignar.')); return; }
  const depName = department_id == null ? null : ((STATE.departments.find(d => d.id === department_id) || {}).name || null);
  STATE.workers.forEach(w => { if (STATE.selected.has(String(w.id_number))) { w.department_id = department_id; w.department_name = depName; } });
  STATE.selMode = false; STATE.selected = new Set();
  const ab = $('#wpAssignDept'); if (ab) ab.classList.remove('btn-primary');
  paintSelBar(); paintGrid();
}

/* ---- Asignacion DIRECTA de "Retail" en tiendas ----
   En tiendas el unico departamento valido es "Retail". En vez de un modal con
   un solo item, la barra lo asigna directo. Busca el registro "Retail" de esta
   tienda en STATE.departments (cada tienda tiene el suyo con su propio id) y
   llama set_department. Feedback breve en la barra mientras guarda. */
async function assignRetail(ced, barEl) {
  const w = STATE.workers.find(x => String(x.id_number) === String(ced));
  if (!w) return;
  const retail = (STATE.departments || []).find(d => /^retail$/i.test(String(d.name || '')));
  if (!retail) { alert('Esta tienda no tiene el departamento Retail creado. Avisá a Sistemas.'); return; }
  if (barEl) { barEl.style.pointerEvents = 'none'; const sp = barEl.querySelector('span'); if (sp) sp.textContent = 'Asignando…'; }
  const r = await api({
    action: 'set_department', company_code: STATE.cc, user: sessionUserPayload(STATE.user),
    id_numbers: [String(ced)], department_id: retail.id,
  });
  if (!r.ok) {
    if (barEl) { barEl.style.pointerEvents = ''; const sp = barEl.querySelector('span'); if (sp) sp.textContent = 'Asignar Retail'; }
    alert(r.error || 'No se pudo asignar Retail.');
    return;
  }
  w.department_id = retail.id; w.department_name = retail.name;
  paintGrid();
  if (CUR && String(CUR.id_number) === String(ced)) openFicha(String(ced));
}

/* ---- Asignacion PUNTUAL de departamento (desde la barra azul de la tarjeta) ----
   Abre un modal chico con el select de departamentos de la empresa para una
   sola persona. Reusa la accion set_department con un unico id. Sin nativos
   (modal propio, la CSP bloquea alert/confirm/prompt inline). Si la empresa no
   tiene departamentos creados, lo avisa en vez de mostrar un select vacio. */
function openAssignDeptModal(ced) {
  const w = STATE.workers.find(x => String(x.id_number) === String(ced));
  if (!w) return;
  const host = wpModalHost();
  const deps = STATE.departments || [];
  const opts = deps.map(d => `<option value="${d.id}"${String(w.department_id) === String(d.id) ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
  const hasDeps = deps.length > 0;

  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="adX" title="Cerrar">✕</button>
        <h3>Asignar departamento</h3>
        <p class="wp-who"><b>${esc(w.full_name)}</b> · <span class="wp-ced">${w.ced_kind || ''}-${w.id_number}</span></p>
        ${hasDeps ? `
          <label class="flabel">Departamento</label>
          <select id="adDept">
            <option value="">— Sin departamento —</option>
            ${opts}
          </select>
          <p class="wp-help">El departamento pertenece a esta empresa. Podés crear más desde <b>Asignar depto.</b> (selección múltiple) o dejarlo sin asignar.</p>
        ` : `
          <div class="wp-prev warn" style="display:block">Esta empresa aún no tiene departamentos creados. Creá al menos uno desde <b>Asignar depto.</b> para poder asignarlo.</div>
        `}
        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="adCancel">Cancelar</button>
          ${hasDeps ? '<button class="btn btn-primary" id="adSave">Guardar</button>' : ''}
        </div>
      </div>
    </div>`;

  const q = s => host.querySelector(s);
  const close = () => { document.removeEventListener('keydown', onKey); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#adX').addEventListener('click', close);
  q('#adCancel').addEventListener('click', close);
  const saveB = q('#adSave');
  if (saveB) saveB.addEventListener('click', async () => {
    const raw = q('#adDept').value;
    const department_id = raw === '' ? null : parseInt(raw, 10);
    saveB.disabled = true; saveB.textContent = 'Guardando…';
    const r = await api({
      action: 'set_department', company_code: STATE.cc, user: sessionUserPayload(STATE.user),
      id_numbers: [String(ced)], department_id,
    });
    if (!r.ok) { saveB.disabled = false; saveB.textContent = 'Guardar'; alert(r.error || 'No se pudo asignar.'); return; }
    const depName = department_id == null ? null : ((deps.find(d => d.id === department_id) || {}).name || null);
    w.department_id = department_id; w.department_name = depName;
    close();
    paintGrid();
    if (CUR && String(CUR.id_number) === String(ced)) openFicha(String(ced));
  });
}

/* ---- Crear un departamento nuevo para esta empresa (desde la barra de
   acciones de Personal, modo empresa) ----
   Abre un modal propio (sin nativos; la CSP bloquea alert/confirm/prompt) con
   un input de nombre. Crea via /api/departments accion 'create' con el adminId
   y el company_code de la empresa actual. Al terminar recarga load() para que
   el nuevo departamento aparezca en el filtro y en "Asignar depto.". Solo se
   monta el boton en modo empresa + admin, asi que aqui asumimos ese contexto. */
function openNewDeptModal() {
  const host = wpModalHost();
  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="ndX" title="Cerrar">✕</button>
        <h3>Nuevo departamento</h3>
        <p class="wp-who"><span class="wp-ced">${esc(STATE.cc)}</span> · ${esc((STATE.company && STATE.company.business_name) || '')}</p>
        <label class="flabel">Nombre del departamento</label>
        <input id="ndName" type="text" placeholder="ej. Almacén" autocomplete="off" maxlength="60">
        <div id="ndMsg" class="wp-prev" style="display:none"></div>
        <p class="wp-help">El departamento pertenece a esta empresa. Luego podés asignarle personal desde <b>Asignar depto.</b> o desde la tarjeta de cada colaborador.</p>
        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="ndCancel">Cancelar</button>
          <button class="btn btn-primary" id="ndSave" disabled>Crear departamento</button>
        </div>
      </div>
    </div>`;

  const q = s => host.querySelector(s);
  const close = () => { document.removeEventListener('keydown', onKey); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#ndX').addEventListener('click', close);
  q('#ndCancel').addEventListener('click', close);

  const nameEl = q('#ndName');
  const saveB = q('#ndSave');
  const refresh = () => { saveB.disabled = !nameEl.value.trim(); };
  nameEl.addEventListener('input', refresh);
  setTimeout(() => nameEl.focus(), 30);
  // Enter en el input crea (si hay nombre).
  nameEl.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !saveB.disabled) saveB.click(); });

  saveB.addEventListener('click', async () => {
    const name = nameEl.value.trim();
    if (!name) return;
    saveB.disabled = true; saveB.textContent = 'Creando…';
    let r;
    try {
      r = await deptApi({ action: 'create', adminId: STATE.adminId, company_code: STATE.cc, name });
    } catch (err) {
      r = { ok: false, error: String((err && err.message) || err) };
    }
    const msg = q('#ndMsg');
    if (!r.ok) {
      saveB.disabled = false; saveB.textContent = 'Crear departamento';
      msg.style.display = 'block'; msg.className = 'wp-prev warn';
      msg.textContent = r.error || 'No se pudo crear el departamento.';
      return;
    }
    // Exito: recargar el directorio (trae departments actualizado) y cerrar.
    close();
    await load();
  });
}

/* ===================== FICHA (página) ===================== */
let CUR = null;

/* v4.77: pill del CARGO coloreado por jerarquia en la cabecera de la ficha
   (solo tiendas, sin numero — decision de Pablo) + chip largo del ESTADO DE
   PUBLICACION junto al nombre (version completa del pie corto de la
   tarjeta): naranja "N cambio(s) sin publicar · editado por quien · fecha"
   o verde "✓ Publicado al sistema · editado por quien · fecha". El bloque
   REGISTRO de abajo queda igual; esto es el vistazo rapido. */
function fichaRolePill(w) {
  const rk = STATE.mode === 'enterprise' ? RANK_NONE : workerRank(w);
  if (STATE.mode === 'enterprise' || rk === RANK_NONE || !w.role) {
    return `<span class="pill">${esc(w.role || 'Sin cargo')}</span>`;
  }
  const col = rankColor(rk);
  return `<span class="pill" style="background:${col}1a;color:${col};border:1px solid ${col}55;font-weight:800">${esc(w.role)}</span>`;
}
function fichaStatusChip(w) {
  if (w.ax_pending) {
    const n = (w.ax_pending_fields && typeof w.ax_pending_fields === 'object')
      ? Math.max(1, Object.keys(w.ax_pending_fields).length) : 1;
    const who = w.profile_updated_by ? ` · editado por ${esc(w.profile_updated_by)}` : '';
    const when = w.profile_updated_at ? ` · ${fmtDateTime(w.profile_updated_at)}` : '';
    return `<span class="pill wp-pill-pending ff-chip-status" id="ffPendBadge" title="Hay cambios en esta ficha que aun no se publican en el sistema"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${n} cambio${n === 1 ? '' : 's'} sin publicar${who}${when}</span>`;
  }
  if (w.profile_updated_by && w.ax_synced_at) {
    return `<span class="pill ff-chip-status" style="background:#e9f7f1;color:#0e9f6e;border:1px solid #c4e8d9;font-weight:700" title="La ultima edicion de esta ficha ya se publico al sistema">✓ Publicado al sistema · editado por ${esc(w.profile_updated_by)} · ${fmtDateTime(w.ax_synced_at)}</span>`;
  }
  return '';
}

function setVal(host, key, text) {
  const el = host.querySelector(`[data-v="${key}"]`);
  if (!el) return;
  const empty = (text == null || text === '');
  el.textContent = empty ? 'Sin dato' : text;
  el.classList.toggle('empty', empty);
}

function openFicha(ced) {
  const w = STATE.workers.find(x => String(x.id_number) === String(ced));
  if (!w) return;
  CUR = w;
  const c = STATE.company || {};

  const host = $('#wpFichaHost');
  host.innerHTML = fichaHtml(w, c);
  $('#wpGridView').style.display = 'none';

  // Cabecera: foto + clic para ver grande
  const ph = host.querySelector('#ffPh');
  // Abre el visor con la version grande. Si la full aun no esta firmada
  // (esquema nuevo: el directory no la firma), la pide on-demand antes de abrir
  // para mostrar 800px y no la miniatura.
  const openBig = async () => {
    if (host.querySelector('#wpFicha').classList.contains('editing')) return;
    if (!w.full_url) await ensureFull(w.id_number);
    openLightbox(w.full_url || w.thumb_url, `${w.full_name} · ${w.ced_kind}-${w.id_number}`, `${w.ced_kind}-${w.id_number}.jpg`);
  };
  if (w.thumb_url) {
    const img = document.createElement('img'); img.src = w.thumb_url;
    ph.insertBefore(img, ph.firstChild);
    ph.classList.add('has');
    ph.addEventListener('click', openBig);
  } else if (w.has_photo) {
    // Foto vieja aun no firmada (lazy): mostrar spinner y pedirla on-demand.
    const sp = document.createElement('div'); sp.className = 'wp-photoload'; sp.innerHTML = '<div class="wp-spin"></div>';
    ph.insertBefore(sp, ph.firstChild);
    ensurePhoto(w.id_number).then(() => {
      // Si seguimos en la misma ficha, repintar la cabecera con la foto.
      if (CUR && String(CUR.id_number) === String(w.id_number)) {
        sp.remove();
        if (w.thumb_url) {
          const img = document.createElement('img'); img.src = w.thumb_url;
          ph.insertBefore(img, ph.firstChild);
          ph.classList.add('has');
          ph.addEventListener('click', openBig);
          // El boton "Quitar foto" en modo edicion depende de w.thumb_url
          // (v5.01: y del permiso photo.manage).
          const del = host.querySelector('#ffDel');
          if (del && STATE.can.photo && host.querySelector('#wpFicha').classList.contains('editing')) del.style.display = '';
        } else {
          const d = document.createElement('div'); d.className = 'noimg'; d.textContent = 'Sin foto';
          ph.insertBefore(d, ph.firstChild);
        }
      }
    });
  } else {
    const d = document.createElement('div'); d.className = 'noimg'; d.textContent = 'Sin foto';
    ph.insertBefore(d, ph.firstChild);
  }

  paintFichaValues(host, w);
  wireFicha(host, w);
  window.scrollTo(0, 0);
}

function fichaHtml(w, c) {
  const back = STATE.onExit ? 'Volver' : 'Volver a Personal';
  return `
  <div class="wp-ficha" id="wpFicha">
    <button class="ff-back" id="ffBack">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      ${back}
    </button>

    ${companyBarHtml(c)}

    <div class="ff-card">
      <div class="ff-top">
        <div class="ff-ph" id="ffPh">${STATE.can.photo ? '<div class="ff-ph-edit" id="ffPhEdit">Cambiar foto</div>' : ''}</div>
        <div class="ff-id">
          <h2>${esc(w.full_name || '—')}</h2>
          <div class="ced">${w.ced_kind || ''}-${w.id_number}</div>
          <div class="meta">${fichaRolePill(w)}${fichaStatusChip(w)}</div>
          <div class="ff-trj" data-v="trj_line"></div>
        </div>
        <div class="ff-actions">
          <button class="btn btn-ghost-danger" id="ffDel" style="display:none">Quitar foto</button>
          ${(STATE.can.publish && w.ax_pending) ? `<button class="btn wp-btn-publish" id="ffPublish" title="Publicar en el sistema los cambios de esta ficha"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg> Publicar</button>` : ''}
          <button class="btn" id="ffCopy" title="Copiar datos de la ficha"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copiar</button>
          ${(STATE.can.ficha || STATE.can.photo) ? '<button class="btn" id="ffEdit">Editar</button>' : ''}
          <button class="btn" id="ffCancel" style="display:none">Cancelar</button>
          <button class="btn btn-primary" id="ffSave" style="display:none">Guardar cambios</button>
          <a class="pm-guia" href="/guias/foto-carnet.html" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg> Ver la guía: cómo tomar la foto <span class="pm-guia-arrow">→</span></a>
        </div>
      </div>

      <div class="ff-note" id="ffNote" style="display:none">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span id="ffNoteTxt"></span>
      </div>

      <div class="ff-body">

        <!-- v6.34: el desplegable vive al tope de ff-body: hereda la MISMA
             sangría que las secciones (nada de full-bleed) y al abrirse no
             toca la foto ni el bloque del nombre. -->
        <details class="ff-trj-det ff-trj-wide" id="ffTrjDet" style="display:none">
          <summary>Ver trayectoria completa</summary>
          <div id="ffTrjBody"></div>
        </details>

        <div class="ff-sec">Identidad</div>
        <div class="ff-grid">
          <div class="ff-row full"><span class="ff-lbl">Nombre completo <span class="src excel"><span class="dot"></span></span></span><span class="ff-val" data-v="full_name"></span></div>
          <div class="ff-field full"><label>Primer nombre</label><input id="e_first" type="text"></div>
          <div class="ff-field"><label>Segundo nombre <span class="opt">(opcional)</span></label><input id="e_second" type="text"></div>
          <div class="ff-field full"><label>Apellidos</label><input id="e_last" type="text"></div>

          <div class="ff-row"><span class="ff-lbl">Fecha de nacimiento <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="birth_date"></span></div>
          <div class="ff-row"><span class="ff-lbl">Edad</span><span class="ff-val" data-v="age"></span></div>
          <div class="ff-field"><label>Fecha de nacimiento</label><input id="e_birth" type="date"><div class="ff-hint" id="h_birth"></div></div>
          <div class="ff-field"><label>Edad <span class="opt">(calculada)</span></label><input id="e_age" type="text" readonly></div>

          <div class="ff-row"><span class="ff-lbl">Género <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="gender"></span></div>
          <div class="ff-row"><span class="ff-lbl">Estado civil <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="marital_status"></span></div>
          <div class="ff-field"><label>Género</label><select id="e_gender"><option value="">— Seleccionar —</option><option value="M">M – Masculino</option><option value="F">F – Femenino</option></select></div>
          <div class="ff-field"><label>Estado civil</label><select id="e_marital"><option value="">— Seleccionar —</option><option value="S">S – Soltero/a</option><option value="C">C – Casado/a</option><option value="D">D – Divorciado/a</option><option value="V">V – Viudo/a</option><option value="O">O – Conviviente</option><option value="R">R – Unión Registrada</option></select></div>
        </div>

        <div class="ff-sec">Cargo y departamento</div>
        <div class="ff-grid">
          <div class="ff-row"><span class="ff-lbl">Cargo <span class="src excel"><span class="dot"></span></span></span><span class="ff-val" data-v="role"></span></div>
          <div class="ff-row"><span class="ff-lbl">Departamento <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="department"></span></div>
          <div class="ff-field ff-role-locked"><label>Cargo</label><div class="ff-locked" data-v="role_locked" style="padding:9px 11px;border:1px dashed var(--border);border-radius:8px;background:var(--bg-soft,#f8fafc);color:var(--text);min-height:20px"></div><div class="ff-hint">El cargo se actualiza solo por la sincronización de personal desde AX.</div></div>
          ${STATE.canEditDept
            ? `<div class="ff-field"><label>Departamento</label><select id="e_department"><option value="">— Sin departamento —</option>${(STATE.departments || []).map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>`
            : `<div class="ff-field"><label>Departamento</label><div class="ff-locked" data-v="department_locked" style="padding:9px 11px;border:1px dashed var(--border);border-radius:8px;background:var(--bg-soft,#f8fafc);color:var(--text);min-height:20px"></div><div class="ff-hint">${STATE.mode === 'enterprise' ? 'El departamento lo gestiona un administrador.' : 'En las tiendas el departamento es fijo y no se edita desde la ficha.'}</div></div>`}
        </div>

        <div class="ff-sec">Datos bancarios</div>
        <div class="ff-grid">
          <div class="ff-row full"><span class="ff-lbl">Cuenta bancaria <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="account_number"></span></div>
          <div class="ff-field full"><label>Número de cuenta <span class="opt">(20 dígitos)</span></label><input id="e_account" type="text" inputmode="numeric" placeholder="01340000000000000000"><div class="ff-hint" id="h_account"></div></div>
        </div>

        <div class="ff-sec">Contacto</div>
        <div class="ff-grid">
          <div class="ff-row"><span class="ff-lbl">Teléfono <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="phone"></span></div>
          <div class="ff-row"><span class="ff-lbl">Correo <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="email"></span></div>
          <div class="ff-field"><label>Teléfono móvil <span class="opt">(04XX-XXXXXXX)</span></label><input id="e_phone" type="text" inputmode="numeric" placeholder="0414-1234567"><div class="ff-hint" id="h_phone"></div></div>
          <div class="ff-field"><label>Correo <span class="opt">(opcional)</span></label><input id="e_email" type="text" placeholder="nombre@correo.com"><div class="ff-hint" id="h_email"></div></div>
          <div class="ff-row full"><span class="ff-lbl">Dirección <span class="src manual"><span class="dot"></span></span></span><span class="ff-val" data-v="address"></span></div>
          <div class="ff-field full"><label>Dirección <span class="opt">(opcional)</span></label><input id="e_address" type="text" placeholder="Calle, sector, ciudad"></div>
        </div>

        <div class="ff-sec">Registro</div>
        <div class="ff-grid">
          <div class="ff-row"><span class="ff-lbl">Ingreso</span><span class="ff-val" data-v="start_date"></span></div>
          <div class="ff-row"><span class="ff-lbl">Ficha actualizada por</span><span class="ff-val" data-v="profile_updated_by"></span></div>
          <div class="ff-row"><span class="ff-lbl">Foto cargada por</span><span class="ff-val" data-v="photo_uploaded_by"></span></div>
          <div class="ff-row"><span class="ff-lbl">Última actualización</span><span class="ff-val" data-v="updated_at"></span></div>
        </div>
      </div>
    </div>

    <p class="ff-legend">La cédula identifica a la persona de forma permanente y no se edita. El nombre completo se arma con el primer/segundo nombre y apellidos. <span class="src excel"><span class="dot"></span> Excel</span> viene del reporte de personal · <span class="src manual"><span class="dot"></span> Manual</span> se captura aquí.</p>
  </div>`;
}

function paintFichaValues(host, w) {
  const age = ageFrom(w.birth_date);
  setVal(host, 'full_name', w.full_name);
  setVal(host, 'birth_date', w.birth_date ? fmtDate(w.birth_date) : '');
  setVal(host, 'age', age != null ? `${age} años` : '');
  setVal(host, 'gender', w.gender ? (GEN[w.gender] || w.gender) : '');
  setVal(host, 'marital_status', w.marital_status ? (CIV[w.marital_status] || w.marital_status) : '');
  setVal(host, 'role', w.role);
  setVal(host, 'department', w.department_name);
  setVal(host, 'account_number', w.account_number ? `${w.account_number}${bankName(w.account_number) ? ' · ' + bankName(w.account_number) : ''}` : '');
  setVal(host, 'phone', w.phone ? phoneDisplay(w.phone) : '');
  setVal(host, 'email', w.email);
  setVal(host, 'address', w.address);
  setVal(host, 'photo_uploaded_by', w.photo_uploaded_by
    ? `${w.photo_uploaded_by}${w.photo_uploaded_at ? ' · ' + fmtDateTime(w.photo_uploaded_at) : ''}`
    : '');
  setVal(host, 'updated_at', fmtDateTime(w.updated_at));
  // v5.92/v6.27: fila Ingreso en Registro: fecha + antiguedad; la marca de
  // ingreso reciente usa la regla v6.20 (menos de 30 dias, no quincena).
  const ingFecha = w.start_date ? fmtDate(w.start_date) : '';
  const ingTen = tenureLabel(w.start_date);
  const ingNew = (isVigente(w) && isNuevoIngreso(w)) ? ' · Ingreso reciente (menos de un mes)' : '';
  setVal(host, 'start_date', ingFecha ? `${ingFecha}${ingTen ? ' · ' + ingTen : ''}${ingNew}` : '');
  // v6.30: la TRAYECTORIA EN EL GRUPO vive en la CABECERA (línea fija bajo
  // el cargo + desplegable "Ver trayectoria completa" con barra y lista
  // "Dónde trabajó" vía acción group_history, lazy: 1 request al abrir).
  // Las filas de Registro v6.27 murieron: Registro conserva solo el Ingreso.
  paintTrayectoria(host, w);
  // v4.20: quien edito la ficha de ultimo (tienda/admin/gestor) y cuando.
  setVal(host, 'profile_updated_by', w.profile_updated_by
    ? `${w.profile_updated_by}${w.profile_updated_at ? ' · ' + fmtDateTime(w.profile_updated_at) : ''}`
    : '');

  const missing = [];
  if (!w.birth_date) missing.push('nacimiento');
  if (!w.gender) missing.push('género');
  if (!w.marital_status) missing.push('estado civil');
  if (!w.account_number) missing.push('cuenta');
  if (!w.phone) missing.push('teléfono');
  const note = host.querySelector('#ffNote');
  if (missing.length) {
    note.style.display = 'flex';
    host.querySelector('#ffNoteTxt').textContent = `Faltan datos por completar: ${missing.join(', ')}. Tocá Editar para cargarlos.`;
  } else note.style.display = 'none';

  // Lapiz naranja en los campos con cambios sin publicar (ax_pending_fields).
  // Los campos de nombre (first/second/last) marcan la fila "Nombre completo".
  markPendingFields(host, w);
}

/* v6.30: línea de trayectoria FIJA en la cabecera + desplegable con la
   historia detallada. La línea siempre está; el detalle (barra + "Dónde
   trabajó") no se ve hasta desplegar y se carga lazy (acción group_history,
   1 request la primera vez). Sin historia previa ni cortes, el desplegable
   ni aparece. */
function paintTrayectoria(host, w) {
  const line = host.querySelector('[data-v="trj_line"]');
  const det = host.querySelector('#ffTrjDet');
  if (!line || !det) return;
  if (typeof w.cont_days !== 'number') {
    line.innerHTML = '<span style="color:var(--faint,#94a3b8)">Antigüedad en el Grupo: sin dato</span>';
    det.style.display = 'none';
    return;
  }
  const parts = [`<b>En el Grupo: ${esc(tenureLong(w.cont_days))}</b>`];
  if (w.cont_since) parts.push(`tramo continuo desde el ${esc(fmtDate(w.cont_since))}`);
  parts.push(w.grp_int ? '⏸ intermitente' : '✓ continuo');
  if (w.grp_int) {
    if (w.grp_since) parts.push(`nos conoce desde el ${esc(fmtDate(w.grp_since))}`);
    if (typeof w.grp_days === 'number') parts.push(`${esc(tenureLong(w.grp_days))} efectivos`);
    if (w.grp_periods) parts.push(`${w.grp_periods} períodos`);
  }
  line.innerHTML = parts.join(' · ');
  // ¿Hay algo que desplegar? MÁS DE UN EMPLEO (v6.31: cubre traslados
  // empalmados tipo Marval AA08→AA03, que son 1 solo período continuo),
  // varios períodos o historia previa al tramo continuo.
  const spanDays = w.grp_since ? daysFrom(w.grp_since) : null;
  const hay = ((Number(w.grp_jobs) || 1) > 1)
    || ((w.grp_periods || 1) > 1)
    || (spanDays != null && spanDays > w.cont_days + 3);
  det.style.display = hay ? '' : 'none';
  det.open = false;
  det.dataset.loaded = '';
  det.dataset.ced = w.id_number || '';
  const body = det.querySelector('#ffTrjBody');
  if (body) body.innerHTML = '';
  if (!det.dataset.bound) {
    det.dataset.bound = '1';
    det.addEventListener('toggle', () => {
      if (det.open && !det.dataset.loaded) loadTrayectoria(det);
    });
  }
}

/* v6.30: carga lazy de la historia (acción group_history del endpoint). */
async function loadTrayectoria(det) {
  const body = det.querySelector('#ffTrjBody');
  if (!body) return;
  det.dataset.loaded = '1';
  body.innerHTML = '<div style="font-size:12px;color:var(--faint,#94a3b8);padding:6px 0">Cargando trayectoria…</div>';
  let items = [];
  try {
    const r = await api({ action: 'group_history', company_code: STATE.cc, user: sessionUserPayload(STATE.user), id_number: det.dataset.ced });
    if (r && r.ok) items = r.items || [];
    else throw new Error((r && r.error) || 'sin respuesta');
  } catch (e) {
    det.dataset.loaded = '';   // permite reintentar al volver a desplegar
    body.innerHTML = `<div style="font-size:12px;color:#b91c1c;padding:6px 0">No se pudo cargar la trayectoria: ${esc(String(e && e.message || e))}</div>`;
    return;
  }
  body.innerHTML = trayectoriaHtml(items);
}

/* v6.30: barra de línea de tiempo (empleos rayados / pausas lisas / vigente
   índigo-teal) + lista "Dónde trabajó": fechas, Alias, razón social del
   momento (ax_egresos.empresa_nombre para cerrados; companies para el
   vigente), cargo si existe, duración y pausas intercaladas. */
function trayectoriaHtml(items) {
  if (!items || !items.length) return '<div style="font-size:12px;color:var(--faint,#94a3b8);padding:6px 0">Sin historia registrada en el Grupo.</div>';
  const hoy = caracasYMD(new Date());
  const toD = s => Date.parse(String(s).slice(0, 10));
  const span = Math.max(1, (Date.parse(hoy) - toD(items[0].ini)) / 86400000 + 1);
  let segs = '', rows = '';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const finD = it.fin ? toD(it.fin) : Date.parse(hoy);
    const wPct = Math.max(2, Math.round(((finD - toD(it.ini)) / 86400000 + 1) / span * 100));
    const vig = !!it.vigente;
    segs += `<div style="width:${wPct}%;height:100%;background:${vig ? '#0f766e' : 'repeating-linear-gradient(45deg,#94a3b8 0 6px,#cbd5e1 6px 12px)'}" title="${esc(it.alias || '')} · ${esc(fmtDate(it.ini))} → ${it.fin ? esc(fmtDate(it.fin)) : 'hoy'}"></div>`;
    rows += `<div class="ff-hrow${vig ? ' now' : ''}"><span class="hd">${esc(fmtDate(it.ini))} → ${it.fin ? esc(fmtDate(it.fin)) : 'hoy'}</span><span class="ha">${esc(it.alias || '—')}</span><span class="hr">${esc(it.empresa || '')}</span>${(it.zona || it.subzona) ? `<span class="hz">${esc([it.zona, it.subzona].filter(Boolean).join(' · '))}</span>` : ''}${it.cargo ? `<span class="hc">${esc(it.cargo)}</span>` : ''}<span class="hdur">${vig ? '<b>' : ''}${esc(tenureShort(it.dias != null ? it.dias : 0))}${vig ? ' · vigente</b>' : ''}</span></div>`;
    const nx = items[i + 1];
    if (nx) {
      const gap = Math.round((toD(nx.ini) - finD) / 86400000) - 1;
      if (gap > 0) {
        segs += `<div style="width:${Math.max(1, Math.round(gap / span * 100))}%;height:100%;background:#e2e8f0" title="Pausa · ${gap} día${gap === 1 ? '' : 's'}"></div>`;
        rows += `<div class="ff-hpause">⏸ pausa de ${gap} día${gap === 1 ? '' : 's'} (${esc(fmtDate(new Date(finD + 86400000).toISOString()))} → ${esc(fmtDate(new Date(toD(nx.ini) - 86400000).toISOString()))})</div>`;
      }
    }
  }
  return `<div style="display:flex;align-items:center;height:10px;border-radius:99px;overflow:hidden;background:#e2e8f0;margin-top:8px" title="Desde el ${esc(fmtDate(items[0].ini))} hasta hoy">${segs}</div>`
    + `<div style="display:flex;justify-content:space-between;font-size:10.5px;color:#94a3b8;margin:3px 0 7px"><span>${esc(fmtDate(items[0].ini))}</span><span>hoy</span></div>`
    + `<div class="ff-hist">${rows}</div>`
    + `<div style="font-size:11px;color:var(--faint,#94a3b8);margin-top:5px">Razón social del momento según el sistema · el empleo vigente muestra la razón social actual.</div>`;
}

/* Pinta un lapiz junto a los valores (modo lectura) de los campos que tienen
   cambios sin publicar en AX. Lee w.ax_pending_fields (nombres internos) y los
   mapea a las filas [data-v] de la ficha. Se limpia primero para no duplicar
   al reabrir. No aplica en tiendas sin cambios (ax_pending_fields vacio). */
function markPendingFields(host, w) {
  // Limpiar marcas previas.
  host.querySelectorAll('.ff-pend-ico').forEach(el => el.remove());
  const pf = (w.ax_pending && w.ax_pending_fields && typeof w.ax_pending_fields === 'object')
    ? w.ax_pending_fields : null;
  if (!pf) return;
  const keys = Object.keys(pf);
  if (!keys.length) return;
  // Mapa campo interno -> data-v de la fila de valor a marcar.
  const nameKeys = ['first_name', 'second_name', 'last_names'];
  const toRow = {
    birth_date: 'birth_date', gender: 'gender', marital_status: 'marital_status',
    account_number: 'account_number', phone: 'phone', email: 'email',
  };
  const rows = new Set();
  keys.forEach(k => {
    if (nameKeys.includes(k)) rows.add('full_name');
    else if (toRow[k]) rows.add(toRow[k]);
  });
  const icoHtml = ' <span class="ff-pend-ico" title="Cambio sin publicar en AX"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></span>';
  rows.forEach(dv => {
    const el = host.querySelector(`[data-v="${dv}"]`);
    if (el) el.insertAdjacentHTML('beforeend', icoHtml);
  });
}

function wireFicha(host, w) {
  const ficha = host.querySelector('#wpFicha');
  const toView = () => {
    ficha.classList.remove('editing');
    // v5.01: ffEdit puede no existir (rol sin ficha.edit/photo.manage).
    const eb = host.querySelector('#ffEdit');
    if (eb) eb.style.display = '';
    host.querySelector('#ffCancel').style.display = 'none';
    host.querySelector('#ffSave').style.display = 'none';
    host.querySelector('#ffDel').style.display = 'none';
  };
  const q = s => host.querySelector(s);

  function runValidations() {
    const acc = q('#e_account').value.replace(/\D/g, ''), hA = q('#h_account');
    if (!acc) { hA.textContent = ''; hA.className = 'ff-hint'; }
    else if (acc.length !== 20) { hA.textContent = `Van ${acc.length} de 20 dígitos.`; hA.className = 'ff-hint warn'; }
    else if (!STATE.bankMap[acc.slice(0, 4)]) { hA.textContent = `Prefijo ${acc.slice(0, 4)} no reconocido.`; hA.className = 'ff-hint warn'; }
    else { hA.textContent = `🏦 ${STATE.bankMap[acc.slice(0, 4)]}`; hA.className = 'ff-hint ok'; }

    const ph = q('#e_phone').value.replace(/\D/g, ''), hP = q('#h_phone');
    if (!ph) { hP.textContent = ''; hP.className = 'ff-hint'; }
    else if (ph.length !== 11 || ph[0] !== '0') { hP.textContent = 'Debe tener 11 dígitos (04XX-XXXXXXX).'; hP.className = 'ff-hint warn'; }
    else { hP.textContent = `📱 Se guardará como +58${ph.slice(1)}`; hP.className = 'ff-hint ok'; }

    const b = q('#e_birth').value, hB = q('#h_birth');
    if (!b) { hB.textContent = ''; hB.className = 'ff-hint'; q('#e_age').value = ''; }
    else { const a = ageFrom(b); q('#e_age').value = `${a} años`; hB.textContent = a < 18 ? 'Menor de 18 años' : ''; hB.className = a < 18 ? 'ff-hint warn' : 'ff-hint'; }

    const em = q('#e_email').value.trim(), hE = q('#h_email');
    if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { hE.textContent = 'Formato de correo inválido.'; hE.className = 'ff-hint warn'; }
    else { hE.textContent = ''; hE.className = 'ff-hint'; }
  }

  function toEdit() {
    ficha.classList.add('editing');
    const eb = host.querySelector('#ffEdit');
    if (eb) eb.style.display = 'none';
    host.querySelector('#ffCancel').style.display = '';
    host.querySelector('#ffSave').style.display = '';
    // v5.01: quitar la foto exige photo.manage ademas de que exista foto.
    host.querySelector('#ffDel').style.display = (w.thumb_url && STATE.can.photo) ? '' : 'none';
    q('#e_first').value = w.first_name || ''; q('#e_second').value = w.second_name || ''; q('#e_last').value = w.last_names || '';
    q('#e_birth').value = w.birth_date || ''; q('#e_gender').value = w.gender || ''; q('#e_marital').value = w.marital_status || '';
    q('#e_account').value = w.account_number || ''; q('#e_phone').value = phoneNat(w.phone);
    // Cargo: SIEMPRE solo-lectura (nadie lo edita desde la ficha; solo cambia
    // por la sincronizacion de personal desde AX). Se muestra el valor actual.
    const roleLocked = host.querySelector('[data-v="role_locked"]');
    if (roleLocked) {
      const empty = !w.role;
      roleLocked.textContent = empty ? 'Sin cargo' : w.role;
      roleLocked.classList.toggle('empty', empty);
    }
    if (q('#e_department')) q('#e_department').value = w.department_id || '';
    // Departamento bloqueado (tiendas / gestor): mostrar el valor actual.
    const depLocked = host.querySelector('[data-v="department_locked"]');
    if (depLocked) {
      const emptyDep = !w.department_name;
      depLocked.textContent = emptyDep ? 'Sin departamento' : w.department_name;
      depLocked.classList.toggle('empty', emptyDep);
    }
    q('#e_email').value = w.email || ''; q('#e_address').value = w.address || '';
    // v4.43: capturar los valores ORIGINALES protegidos al entrar a editar.
    // Regla: un campo que TENIA dato no puede quedar vacio (si estaba vacio,
    // puede seguir vacio o llenarse). Segundo nombre SI se puede vaciar.
    ORIG_PROT = {
      first_name: w.first_name, last_names: w.last_names, birth_date: w.birth_date,
      gender: w.gender, marital_status: w.marital_status, account_number: w.account_number,
      phone: w.phone, email: w.email, address: w.address,
    };
    runValidations();
    window.scrollTo(0, 0);
  }

  let ORIG_PROT = null;   // v4.43: valores al entrar a editar (bloqueo de vaciado)
  ['#e_account', '#e_phone', '#e_birth', '#e_email'].forEach(sel => q(sel).addEventListener('input', runValidations));
  // Correo SIEMPRE en minusculas (v4.38): se transforma al salir del campo
  // (el usuario lo ve normalizarse) y el save() lo baja de nuevo por si acaso.
  q('#e_email').addEventListener('blur', () => {
    const el = q('#e_email');
    const low = el.value.trim().toLowerCase();
    if (el.value !== low) el.value = low;
    runValidations();
  });

  async function save() {
    const phRaw = q('#e_phone').value.replace(/\D/g, '');
    const accRaw = q('#e_account').value.replace(/\D/g, '');
    // Validaciones duras antes de enviar.
    if (accRaw && (accRaw.length !== 20 || !STATE.bankMap[accRaw.slice(0, 4)])) { alert('La cuenta bancaria no es válida (20 dígitos y prefijo de banco conocido).'); return; }
    if (phRaw && (phRaw.length !== 11 || phRaw[0] !== '0')) { alert('El teléfono no es válido (04XX-XXXXXXX).'); return; }
    const birth = q('#e_birth').value;
    if (birth && ageFrom(birth) < 18) { if (!confirm('La persona es menor de 18 años. ¿Guardar de todos modos?')) return; }

    const first = q('#e_first').value.trim().toUpperCase();
    const second = q('#e_second').value.trim().toUpperCase();
    const last = q('#e_last').value.trim().toUpperCase();
    const profile = {
      first_name: first || null,
      second_name: second || null,
      last_names: last || null,
      full_name: [first, second, last].filter(Boolean).join(' ') || null,
      birth_date: birth || null,
      gender: q('#e_gender').value || null,
      marital_status: q('#e_marital').value || null,
      account_number: accRaw || null,
      bank_code: accRaw ? accRaw.slice(0, 4) : null,
      phone: phRaw ? '+58' + phRaw.slice(1) : null,
      email: q('#e_email').value.trim().toLowerCase() || null,
      address: q('#e_address').value.trim() || null,
    };
    // v4.43: BLOQUEO DE VACIADO. Un campo protegido que tenia valor no puede
    // guardarse vacio (evita perdidas como el Nacimiento borrado detectado en
    // Sincronizar). Mensaje inline (sin alert, regla del portal).
    const PROT_LBL = {
      first_name: 'Primer nombre', last_names: 'Apellidos', birth_date: 'Nacimiento',
      gender: 'Género', marital_status: 'Estado civil', account_number: 'Cuenta bancaria',
      phone: 'Teléfono', email: 'Correo', address: 'Dirección',
    };
    const vaciados = ORIG_PROT
      ? Object.keys(PROT_LBL).filter(k =>
          ORIG_PROT[k] != null && String(ORIG_PROT[k]).trim() !== '' && !profile[k])
      : [];
    if (vaciados.length) {
      showFieldGuardModal(vaciados.map(k => PROT_LBL[k]));
      return;
    }
    // El CARGO (role) NUNCA se envia desde la ficha: es dato maestro que solo
    // cambia por la sincronizacion de personal desde AX (afecta el salario).
    // El backend ademas ignora 'role' aunque llegara.

    // Departamento: SOLO viaja cuando esta ficha puede editarlo (empresa
    // no-tienda y no-gestor). Si no, NO se incluye en el payload y el backend
    // no lo toca (regla v4.18: tiendas fijas + gestores sin permiso).
    const payload = {
      action: 'save_profile', company_code: STATE.cc, user: sessionUserPayload(STATE.user),
      id_number: w.id_number, profile,
    };
    let department_id = w.department_id != null ? w.department_id : null;
    if (STATE.canEditDept) {
      const deptVal = q('#e_department') ? (q('#e_department').value || '') : '';
      department_id = deptVal === '' ? null : parseInt(deptVal, 10);
      payload.department_id = department_id;
    }

    const saveB = host.querySelector('#ffSave');
    saveB.disabled = true; saveB.textContent = 'Guardando…';
    const r = await api(payload);
    saveB.disabled = false; saveB.textContent = 'Guardar cambios';
    if (!r.ok) { alert(r.error || 'No se pudo guardar.'); return; }

    // Aplicar en memoria y refrescar. Se copia tambien el estado de pendiente
    // que devuelve el backend (ax_pending / ax_pending_fields): asi el badge de
    // la ficha, el lapiz por campo y el boton Publicar (N) de la barra
    // aparecen de inmediato sin tener que recargar la lista.
    const depName = department_id == null ? null
      : (((STATE.departments || []).find(d => d.id === department_id) || {}).name || w.department_name || null);
    // v4.20: etiqueta local de quien guardo (el backend guarda la oficial).
    const u = STATE.user || {};
    const ROLE_ES = { superadmin: 'superadmin', admin: 'admin', gestor_empresa: 'gestor de empresa', editor_personal: 'editor de personal' };
    const meLabel = u.kind === 'company'
      ? `${STATE.cc} (tienda)`
      : `${(u.name || u.username || 'admin')} (${ROLE_ES[u.role] || u.role || 'admin'})`;
    Object.assign(w, profile, {
      department_id, department_name: depName, updated_at: new Date().toISOString(),
      profile_updated_by: meLabel,
      profile_updated_at: new Date().toISOString(),
      ax_pending: !!r.ax_pending,
      ax_pending_fields: (r.ax_pending_fields && typeof r.ax_pending_fields === 'object') ? r.ax_pending_fields : {},
    });
    openFicha(w.id_number);   // reabre en modo ver con datos frescos
    refreshPublishBtn();      // muestra/actualiza el boton Publicar (N) de la barra
    paintGrid();
  }

  q('#ffBack').addEventListener('click', fichaBack);
  const cpBtn = q('#ffCopy');
  if (cpBtn) cpBtn.addEventListener('click', () => copyWorkerData(w, cpBtn));
  // v5.01: botones condicionados por permisos; pueden no existir en el DOM.
  const edBtn = q('#ffEdit');
  if (edBtn) edBtn.addEventListener('click', toEdit);
  q('#ffCancel').addEventListener('click', () => openFicha(w.id_number));
  q('#ffSave').addEventListener('click', save);
  const phEditBtn = q('#ffPhEdit');
  if (phEditBtn) phEditBtn.addEventListener('click', () => openPhotoModal(w.id_number));
  q('#ffDel').addEventListener('click', () => openPhotoModal(w.id_number));
  const pubBtn = q('#ffPublish');
  if (pubBtn) pubBtn.addEventListener('click', () => openPublishModal(String(w.id_number)));
}

/* v4.47: aviso de campos protegidos en MODAL del portal (la barra inline
   deformaba la fila de botones de la ficha). Cierra solo con su boton o
   Escape (regla del portal: nunca al clic fuera). */
function showFieldGuardModal(labels) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:1200;padding:20px';
  wrap.innerHTML = `
    <div style="background:var(--card,#fff);border-radius:16px;max-width:440px;width:100%;padding:22px 24px;box-shadow:0 20px 60px rgba(15,23,42,.3)">
      <h3 style="margin:0 0 10px;font-size:17px;color:var(--ink)">No se puede guardar</h3>
      <div style="border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.55;background:#fef2f2;border:1px solid #f3c2c2;color:#b91c1c">
        <b>${labels.map(l => String(l).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))).join(', ')}</b> ya tenía${labels.length === 1 ? '' : 'n'} un valor y no puede${labels.length === 1 ? '' : 'n'} quedar vacío${labels.length === 1 ? '' : 's'}.
        <br><br>Si el dato está mal, escribe el valor correcto. Si el vigente es otro, usa <b>Actualizar</b> en Personal para traerlo.
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:16px">
        <button id="fgOk" style="font:inherit;font-size:13.5px;font-weight:600;padding:9px 16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--ink);cursor:pointer">Entendido</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('#fgOk').addEventListener('click', close);
}

/* v4.48: copiar datos de la persona al portapapeles (todos los roles).
   Mismo formato que Buscar/Datos incompletos/Sincronizar, con una LINEA
   FINAL extra: la cedula SIN la letra (asi se busca directo en el sistema,
   que la maneja sin el prefijo V/E). */
function workerCopyText(w) {
  const MAR = { S: 'Soltero(a)', C: 'Casado(a)', D: 'Divorciado(a)', V: 'Viudo(a)', O: 'Conviviente', R: 'Union registrada' };
  const L = [];
  L.push(w.full_name || '(sin nombre)');
  L.push(`C.I.: ${(w.ced_kind || 'V')}-${w.id_number}`);
  const emp = [STATE && STATE.cc, STATE && (STATE.companyName || STATE.company_name || (STATE.company && STATE.company.business_name))].filter(Boolean).join(' · ');
  if (emp) L.push(`Empresa: ${emp}`);
  if (w.department_name) L.push(`Departamento: ${w.department_name}`);
  if (w.role) L.push(`Cargo: ${w.role}`);
  if (w.gender) L.push(`Sexo: ${w.gender === 'M' ? 'Masculino' : w.gender === 'F' ? 'Femenino' : w.gender}`);
  if (w.birth_date) L.push(`Nacimiento: ${String(w.birth_date).slice(0, 10)}${w.age != null ? ` (${w.age} años)` : ''}`);
  else if (w.age != null) L.push(`Edad: ${w.age} años`);
  if (w.marital_status) L.push(`Estado civil: ${MAR[w.marital_status] || w.marital_status}`);
  if (w.phone) L.push(`Teléfono: ${String(w.phone).startsWith('+58') ? '0' + String(w.phone).slice(3) : w.phone}`);
  if (w.email) L.push(`Correo: ${w.email}`);
  if (w.account_number) L.push(`Cuenta: ${w.account_number}`);
  if (w.address) L.push(`Dirección: ${w.address}`);
  L.push(`Ficha: ${String(w.id_number).replace(/[^0-9]/g, '')}`);
  return L.join('\n');
}
async function copyWorkerData(w, btn) {
  if (!w) return;
  const text = workerCopyText(w);
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      ok = document.execCommand('copy'); ta.remove();
    } catch (__) { ok = false; }
  }
  if (btn && ok) {
    const prev = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#16a34a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    setTimeout(() => { btn.innerHTML = prev; }, 1200);
  }
}

/* v4.49: EXPORTAR lo visible del grid de Personal (xlsx / csv / txt, mismo
   patron que Empresas y Buscar personal). Exporta EXACTAMENTE lo que se ve
   (respeta filtros y orden actuales): se leen las tarjetas pintadas por su
   data-ced y se mapean contra STATE.workers. Todos los roles. */
const WP_MARITAL_LBL = { S: 'Soltero(a)', C: 'Casado(a)', D: 'Divorciado(a)', V: 'Viudo(a)', O: 'Conviviente', R: 'Union registrada' };
function wpExportRows() {
  const grid = $('#wpGrid');
  const ceds = grid ? [...grid.querySelectorAll('.wp-card')].map(el => String(el.dataset.ced)) : [];
  const byCed = {};
  (STATE.workers || []).forEach(w => { byCed[String(w.id_number)] = w; });
  return ceds.map(c => byCed[c]).filter(Boolean).map(w => ({
    'Cédula': w.id_number || '',
    'Nombre': w.full_name || '',
    'Cargo': w.role || '',
    'Departamento': w.department_name || '',
    'Sexo': w.gender || '',
    'Edad': w.age != null ? w.age : '',
    'Estado civil': WP_MARITAL_LBL[w.marital_status] || w.marital_status || '',
    'Nacimiento': w.birth_date ? String(w.birth_date).slice(0, 10) : '',
    'Teléfono': w.phone || '',
    'Correo': w.email || '',
    'Cuenta banco': w.account_number || '',
    'Dirección': w.address || '',
    'Estado': (w.end_date || w.is_active === false) ? 'Egresado' : 'Activo',
    'Foto': w.thumb_url ? 'Sí' : 'No',
  }));
}
function wpDownloadBlob(content, filename, mime) {
  const blob = (content instanceof Blob) ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function wpTstamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
/* Mini aviso modal (sin alert, regla del portal). */
function wpExportNotice(msg) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:1200;padding:20px';
  wrap.innerHTML = `<div style="background:var(--card,#fff);border-radius:14px;max-width:380px;width:100%;padding:20px 22px;box-shadow:0 20px 60px rgba(15,23,42,.3)">
    <div style="font-size:13.5px;color:var(--ink);line-height:1.5">${msg}</div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px">
      <button id="enOk" style="font:inherit;font-size:13px;font-weight:600;padding:8px 15px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--ink);cursor:pointer">Entendido</button>
    </div></div>`;
  document.body.appendChild(wrap);
  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('#enOk').addEventListener('click', close);
}
async function wpDoExport(fmt) {
  const data = wpExportRows();
  if (!data.length) { wpExportNotice('No hay personal visible para exportar (revisa los filtros).'); return; }
  const headers = Object.keys(data[0]);
  const fname = `personal_${(STATE && STATE.cc) || 'empresa'}_${wpTstamp()}`;

  if (fmt === 'csv') {
    const escv = (v) => {
      const s = String(v ?? '');
      return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.join(';')].concat(data.map(r => headers.map(h => escv(r[h])).join(';')));
    wpDownloadBlob('\uFEFF' + lines.join('\r\n'), `${fname}.csv`, 'text/csv;charset=utf-8');
    return;
  }
  if (fmt === 'txt') {
    const widths = headers.map(h => Math.max(h.length, ...data.map(r => String(r[h] ?? '').length)));
    const fmtRow = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
    const lines = [fmtRow(headers), widths.map(w => '-'.repeat(w)).join('  ')]
      .concat(data.map(r => fmtRow(headers.map(h => r[h]))));
    wpDownloadBlob(lines.join('\r\n'), `${fname}.txt`, 'text/plain;charset=utf-8');
    return;
  }
  if (fmt === 'xlsx') {
    try {
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar la librería de Excel.'));
          document.head.appendChild(s);
        });
      }
      const ws = window.XLSX.utils.json_to_sheet(data, { header: headers });
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Personal');
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (e) {
      wpExportNotice(String(e.message || e) + ' Revisa tu conexión e inténtalo de nuevo.');
    }
    return;
  }
}
/* Menu flotante de formatos, anclado al boton Exportar. */
function wpOpenExportMenu(btn) {
  const old = document.getElementById('wpExpMenu');
  if (old) { old.remove(); return; }
  const r = btn.getBoundingClientRect();
  const m = document.createElement('div');
  m.id = 'wpExpMenu';
  m.style.cssText = `position:fixed;top:${r.bottom + 6}px;left:${Math.max(8, r.right - 170)}px;z-index:1100;background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;box-shadow:0 10px 32px rgba(15,23,42,.18);padding:6px;min-width:170px;display:flex;flex-direction:column;gap:2px`;
  const item = (lbl, fmt) => {
    const b = document.createElement('button');
    b.textContent = lbl;
    b.style.cssText = 'font:inherit;font-size:13px;text-align:left;padding:8px 12px;border:0;border-radius:8px;background:transparent;color:var(--ink);cursor:pointer';
    b.addEventListener('mouseenter', () => { b.style.background = 'var(--bg-soft,#f1f5f9)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', () => { m.remove(); wpDoExport(fmt); });
    return b;
  };
  m.appendChild(item('Excel (.xlsx)', 'xlsx'));
  m.appendChild(item('CSV (.csv)', 'csv'));
  m.appendChild(item('Texto (.txt)', 'txt'));
  document.body.appendChild(m);
  setTimeout(() => {
    const away = (ev) => { if (!m.contains(ev.target) && ev.target !== btn) { m.remove(); document.removeEventListener('click', away); } };
    document.addEventListener('click', away);
  }, 0);
}

function backToGrid() {
  $('#wpFichaHost').innerHTML = '';
  $('#wpGridView').style.display = '';
  CUR = null;
  window.scrollTo(0, 0);
}

/* "Volver" de la ficha: si se entro DIRECTO a la ficha (ej. desde Buscar
   personal), regresa al origen (onExit, la misma busqueda). Si se entro por el
   grid de la empresa, vuelve a ese grid. */
function fichaBack() {
  if (STATE && STATE.fichaDirect && STATE.onExit) { STATE.onExit(); return; }
  backToGrid();
}

/* ===================== LIGHTBOX (foto grande + descargar) ===================== */
let lbCurrent = null;
function ensureLightbox() {
  if (document.getElementById('wpLb')) return;
  const el = document.createElement('div');
  el.id = 'wpLb'; el.className = 'wp-lb';
  el.innerHTML = `
    <div class="wp-lb-tools">
      <button class="wp-lb-btn" id="wpLbDl"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Descargar</button>
      <button class="wp-lb-btn icon" id="wpLbX">✕</button>
    </div>
    <img id="wpLbImg" src="" alt=""><div class="wp-lb-cap" id="wpLbCap"></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el) closeLightbox(); });
  document.getElementById('wpLbX').addEventListener('click', closeLightbox);
  document.getElementById('wpLbDl').addEventListener('click', async e => {
    e.stopPropagation();
    if (!lbCurrent) return;
    try {
      const resp = await fetch(lbCurrent.src);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = lbCurrent.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { alert('No se pudo descargar la foto.'); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.classList.contains('show')) closeLightbox();
  });
}
function openLightbox(src, cap, filename) {
  if (!src) return;
  ensureLightbox();
  lbCurrent = { src, filename: filename || 'foto.jpg' };
  document.getElementById('wpLbImg').src = src;
  document.getElementById('wpLbCap').textContent = cap || '';
  document.getElementById('wpLb').classList.add('show');
}
function closeLightbox() {
  const el = document.getElementById('wpLb');
  if (el) { el.classList.remove('show'); document.getElementById('wpLbImg').src = ''; }
  lbCurrent = null;
}

/* Lightbox PUBLICO reutilizable desde otras vistas (Buscar personal, Datos
   incompletos): abre la foto grande de un trabajador en el mismo visor de
   Personal (imagen + Descargar + X + Escape + clic-fuera). Recibe la URL de
   la imagen (normalmente la miniatura publica, que a ~300px se ve nitida como
   foto carnet), un texto de pie y el nombre de archivo para la descarga.
   No depende del STATE interno de Personal: es autonoma. */
export function openWorkerLightbox(src, cap, filename) {
  openLightbox(src, cap, filename);
}

/* ===================== MODAL DE FOTO (recortador arrastrar + zoom) ===================== */
function openPhotoModal(ced) {
  const w = STATE.workers.find(x => String(x.id_number) === String(ced));
  if (!w) return;
  let staged = null;          // resultado listo para guardar
  let srcImg = null;          // Image() original cargada
  const STAGE = 300;          // lado del area de recorte en pantalla
  const view = { scale: 1, baseScale: 1, x: 0, y: 0, stage: STAGE, dragging: false, sx: 0, sy: 0 };
  const host = $('#wpModalHost');

  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="pmX" title="Cerrar">✕</button>
        <h3>Foto del colaborador</h3>
        <p class="wp-who"><b>${esc(w.full_name)}</b> · <span class="wp-ced">${w.ced_kind || ''}-${w.id_number}</span></p>

        <div class="pm-crop-wrap" id="pmCropWrap" style="display:none">
          <div class="pm-stage" id="pmStage" style="position:relative;width:${STAGE}px;height:${STAGE}px;max-width:100%;margin:0 auto;border-radius:14px;overflow:hidden;background:#0f172a;touch-action:none;user-select:none;cursor:grab">
            <img id="pmImg" alt="" style="position:absolute;transform-origin:0 0;will-change:transform;pointer-events:none;max-width:none">
            <div style="position:absolute;inset:0;pointer-events:none;background:rgba(15,23,42,.5);-webkit-mask:radial-gradient(circle at center, transparent 0 47%, #000 47.5%);mask:radial-gradient(circle at center, transparent 0 47%, #000 47.5%)"></div>
            <div style="position:absolute;left:50%;top:50%;width:94%;height:94%;transform:translate(-50%,-50%);border:2px dashed rgba(255,255,255,.85);border-radius:50%;pointer-events:none"></div>
          </div>
          <div style="margin-top:12px;display:flex;align-items:center;gap:10px">
            <span style="font-size:16px">🔍</span>
            <input type="range" id="pmZoom" min="100" max="300" value="100" style="flex:1;accent-color:var(--brand)">
          </div>
          <p class="wp-meta" id="pmMeta" style="margin:8px 0 0"></p>
        </div>

        <div class="pm-two" id="pmInitial">
          <div class="pm-col"><div class="pm-col-lbl">Foto actual</div><div class="pm-prev" id="pmCur"><div class="empty">Sin foto aún</div></div></div>
          <div class="pm-arrow">→</div>
          <div class="pm-col"><div class="pm-col-lbl">Nueva foto</div><div class="pm-prev" id="pmNew"><div class="empty">Elegí una foto para previsualizar</div></div></div>
        </div>

        <div class="pm-help"><b>Foto tipo carnet:</b> de frente, hombros visibles, fondo claro y liso, buena luz sin sombras. Sin lentes, gorras ni gestos. Al elegir la foto podés <b>arrastrarla</b> y usar el <b>zoom</b> para centrar la cara en el círculo.
          <a class="pm-guia" href="/guias/foto-carnet.html" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg> Ver la guía: cómo tomar la foto <span class="pm-guia-arrow">→</span></a>
        </div>

        <input type="file" id="pmFile" accept="image/*" hidden>
        <div class="wp-foot">
          ${w.thumb_url ? '<button class="btn" id="pmDel" style="color:var(--danger);border-color:#f3c2c2">Quitar foto</button>' : ''}
          <span style="flex:1"></span>
          <button class="btn" id="pmCancel">Cancelar</button>
          <button class="btn" id="pmPick">Elegir foto</button>
          <button class="btn btn-primary" id="pmSave" disabled>Guardar</button>
        </div>
      </div>
    </div>`;

  const q = s => host.querySelector(s);
  const closeModal = () => { document.removeEventListener('keydown', onKey); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', onKey);
  q('#pmX').addEventListener('click', closeModal);
  q('#pmCancel').addEventListener('click', closeModal);

  // Columna izquierda: foto actual + circulo guia (mientras no se elige nueva).
  const cur = q('#pmCur');
  if (w.thumb_url) {
    cur.innerHTML = `<img src="${w.thumb_url}" alt="actual">` + guideSvg();
    cur.querySelector('img').addEventListener('click', () => openLightbox(w.full_url || w.thumb_url, 'Foto actual', `${w.ced_kind}-${w.id_number}.jpg`));
  } else if (w.has_photo) {
    // Foto aun no firmada (lazy): pedirla on-demand para mostrarla aqui.
    cur.innerHTML = '<div class="wp-photoload"><div class="wp-spin"></div></div>';
    ensurePhoto(w.id_number).then(() => {
      if (w.thumb_url) {
        cur.innerHTML = `<img src="${w.thumb_url}" alt="actual">` + guideSvg();
        cur.querySelector('img').addEventListener('click', () => openLightbox(w.full_url || w.thumb_url, 'Foto actual', `${w.ced_kind}-${w.id_number}.jpg`));
      } else {
        cur.innerHTML = '<div class="empty">Sin foto aun</div>';
      }
    });
  }

  q('#pmPick').addEventListener('click', () => q('#pmFile').click());

  /* --- aplicar transform y refrescar preview --- */
  function clampView() {
    const wpx = srcImg.width * view.scale, hpx = srcImg.height * view.scale;
    view.x = Math.min(0, Math.max(STAGE - wpx, view.x));
    view.y = Math.min(0, Math.max(STAGE - hpx, view.y));
  }
  function applyView() {
    if (!srcImg) return;
    clampView();
    const im = q('#pmImg');
    im.style.width = (srcImg.width * view.scale) + 'px';
    im.style.height = (srcImg.height * view.scale) + 'px';
    im.style.transform = `translate(${view.x}px,${view.y}px)`;
  }

  /* --- arrastre (mouse + touch) --- */
  const onMove = e => {
    if (!view.dragging) return;
    view.x = e.clientX - view.sx; view.y = e.clientY - view.sy; applyView();
  };
  const onUp = () => { view.dragging = false; const st = q('#pmStage'); if (st) st.style.cursor = 'grab'; };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  function wireStage() {
    const st = q('#pmStage');
    st.addEventListener('mousedown', e => { view.dragging = true; view.sx = e.clientX - view.x; view.sy = e.clientY - view.y; st.style.cursor = 'grabbing'; });
    st.addEventListener('touchstart', e => { const t = e.touches[0]; view.dragging = true; view.sx = t.clientX - view.x; view.sy = t.clientY - view.y; }, { passive: true });
    st.addEventListener('touchmove', e => { if (!view.dragging) return; const t = e.touches[0]; view.x = t.clientX - view.sx; view.y = t.clientY - view.sy; applyView(); }, { passive: true });
    st.addEventListener('touchend', () => { view.dragging = false; });
    q('#pmZoom').addEventListener('input', () => {
      const prevScale = view.scale;
      view.scale = view.baseScale * (parseInt(q('#pmZoom').value, 10) / 100);
      // zoom hacia el centro del stage
      const cx = STAGE / 2, cy = STAGE / 2;
      view.x = cx - (cx - view.x) * (view.scale / prevScale);
      view.y = cy - (cy - view.y) * (view.scale / prevScale);
      applyView();
    });
  }

  q('#pmFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const origKB = Math.round(f.size / 1024);
    try {
      srcImg = await fileToImage(f);
      // mostrar recortador, ocultar el bloque inicial de dos columnas
      q('#pmInitial').style.display = 'none';
      q('#pmCropWrap').style.display = 'block';
      const im = q('#pmImg'); im.src = srcImg.src;
      // baseScale: la imagen CUBRE el stage (cover)
      view.baseScale = Math.max(STAGE / srcImg.width, STAGE / srcImg.height);
      view.scale = view.baseScale;
      view.x = (STAGE - srcImg.width * view.scale) / 2;
      view.y = (STAGE - srcImg.height * view.scale) / 2;
      q('#pmZoom').value = 100;
      wireStage();
      applyView();
      q('#pmMeta').innerHTML = `Original ${origKB} KB · arrastrá y ajustá el zoom, luego Guardar`;
      q('#pmSave').disabled = false;
    } catch { q('#pmMeta').textContent = 'No se pudo leer la imagen. Probá con otra.'; }
  });

  q('#pmSave').addEventListener('click', async () => {
    if (!srcImg) return;
    // Generar las dos versiones desde el encuadre elegido.
    const thumbUrl = cropFromViewport(srcImg, view, THUMB, THUMB_QUALITY);
    const fullUrl = cropFromViewport(srcImg, view, FULL, FULL_QUALITY);
    staged = {
      thumb: stripPrefix(thumbUrl), full: stripPrefix(fullUrl),
      bytes: b64Bytes(fullUrl) + b64Bytes(thumbUrl), fullBytes: b64Bytes(fullUrl),
    };
    const saveB = q('#pmSave'); saveB.disabled = true; saveB.textContent = 'Guardando…';
    const uploadedBy = STATE.user.kind === 'company' ? STATE.user.companyCode : (STATE.user.name || STATE.user.username || 'admin');
    const r = await api({
      action: 'save', company_code: STATE.cc, user: sessionUserPayload(STATE.user),
      id_number: w.id_number, full_b64: staged.full, thumb_b64: staged.thumb, mime: 'image/jpeg',
      width: FULL, height: FULL, bytes: staged.fullBytes, uploaded_by: uploadedBy,
    });
    if (!r.ok) { saveB.disabled = false; saveB.textContent = 'Guardar'; alert(r.error || 'No se pudo guardar la foto.'); return; }
    w.has_photo = true;
    w.needs_sign = false;
    w.thumb_url = r.thumb_url || w.thumb_url;
    w.full_url = r.full_url || w.full_url;
    w.photo_uploaded_by = uploadedBy;
    w.photo_uploaded_at = new Date().toISOString();   // v5.88: fecha de foto en memoria
    w.updated_at = new Date().toISOString();
    closeModal();
    paintGrid();
    if (CUR && CUR.id_number === w.id_number) openFicha(w.id_number);
  });

  const delB = q('#pmDel');
  if (delB) delB.addEventListener('click', async () => {
    if (!confirm(`¿Quitar la foto de ${w.full_name}?`)) return;
    const r = await api({ action: 'remove', company_code: STATE.cc, user: sessionUserPayload(STATE.user), id_number: w.id_number });
    if (!r.ok) { alert(r.error || 'No se pudo quitar.'); return; }
    w.has_photo = false; w.needs_sign = false; w.thumb_url = null; w.full_url = null;
    w.photo_uploaded_by = null; w.photo_uploaded_at = null;   // v5.88: limpiar registro de foto
    closeModal();
    paintGrid();
    if (CUR && CUR.id_number === w.id_number) openFicha(w.id_number);
  });
}

/* ===================== GESTION DE LA LISTA ===================== */
function wpModalHost() { return $('#wpModalHost'); }
function wpCloseModal() { wpModalHost().innerHTML = ''; }

/* ---- Actualizar lista (cargar Reporte 10) ---- */
function openReporteModal() {
  const host = wpModalHost();
  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="rmX" title="Cerrar">✕</button>
        <h3>Actualizar lista de personal</h3>
        <p class="wp-who">${esc(STATE.cc)} · Carga el <b>Reporte 10</b> del POS para refrescar el personal.</p>

        <div class="wp-drop" id="rmDrop">
          <svg class="wp-di" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <b id="rmDropName">Elegir el archivo .xlsx</b>
          <small id="rmDropHint">Hoja "Datos" · se lee en tu navegador, no se sube el archivo</small>
        </div>
        <input type="file" id="rmFile" accept=".xlsx,.xls" hidden>

        <div id="rmPreview" class="wp-prev" style="display:none"></div>

        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="rmCancel">Cancelar</button>
          <button class="btn" id="rmPick">Elegir archivo</button>
          <button class="btn btn-primary" id="rmSave" disabled>Actualizar lista</button>
        </div>
      </div>
    </div>`;

  let parsed = null, valid = null;
  const q = s => host.querySelector(s);
  const close = () => { document.removeEventListener('keydown', onKey); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#rmX').addEventListener('click', close);
  q('#rmCancel').addEventListener('click', close);
  q('#rmDrop').addEventListener('click', () => q('#rmFile').click());
  q('#rmPick').addEventListener('click', () => q('#rmFile').click());

  q('#rmFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    q('#rmDropName').textContent = f.name;
    q('#rmDropHint').textContent = 'Leyendo…';
    try {
      parsed = await parseReport10(f);
      valid = validateParsed(parsed);
      const prev = q('#rmPreview');
      prev.style.display = 'block';
      if (parsed.missing.length) {
        prev.className = 'wp-prev warn';
        prev.innerHTML = `⚠ Falta(n) la(s) columna(s): <b>${parsed.missing.join(', ')}</b>. Revisa que sea el Reporte 10 correcto (hoja "Datos").`;
        q('#rmSave').disabled = true;
        q('#rmDropHint').textContent = 'Archivo con columnas faltantes';
        return;
      }
      prev.className = 'wp-prev ok';
      const manual = STATE.manualCount || 0;
      prev.innerHTML = `✓ <b>${valid.total} trabajadores</b> (${valid.active} vigentes · ${valid.terminated} egresados)`
        + ` · ${valid.gerentes} gerente(s), ${valid.subgerentes} sub-gerente(s)`
        + (parsed.columnsFound.includes('Cuenta Bancaria') ? ' · cuentas incluidas' : '')
        + (manual ? `<div style="margin-top:6px;font-size:11.5px">Los <b>${manual}</b> colaborador(es) manual(es) que no estén en el reporte se conservan.</div>` : '')
        + (valid.warnings.length ? `<div style="margin-top:6px;font-size:11.5px;color:var(--warn)">${valid.warnings.join(' ')}</div>` : '');
      q('#rmDropHint').textContent = `${valid.total} filas válidas`;
      q('#rmSave').disabled = !valid.okToUpload;
    } catch (err) {
      const prev = q('#rmPreview');
      prev.style.display = 'block'; prev.className = 'wp-prev warn';
      prev.innerHTML = `No se pudo leer el archivo: ${esc(String(err.message || err))}`;
      q('#rmSave').disabled = true;
    }
  });

  q('#rmSave').addEventListener('click', async () => {
    if (!valid || !valid.okToUpload) return;
    const saveB = q('#rmSave'); saveB.disabled = true; saveB.textContent = 'Actualizando…';
    const uploadedBy = STATE.user.kind === 'company' ? STATE.user.companyCode : (STATE.user.name || STATE.user.username || 'admin');
    const r = await rosterReplace(STATE.cc, valid.validRows, { uploadedBy, sourceFile: parsed.fileName, user: sessionUserPayload(STATE.user) });
    if (!r.ok) { saveB.disabled = false; saveB.textContent = 'Actualizar lista'; alert(r.error || 'No se pudo actualizar.'); return; }
    close();
    await load();
  });
}

/* ---- Actualizar lista (cargar Reporte AX) — modo empresa ---- */
function openReporteAXModal() {
  const host = wpModalHost();
  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="axX" title="Cerrar">✕</button>
        <h3>Actualizar lista de personal</h3>
        <p class="wp-who">${esc(STATE.cc)} · Carga el <b>Reporte AX</b> (Excel de AX) para refrescar el personal de la empresa.</p>

        <div class="wp-drop" id="axDrop">
          <svg class="wp-di" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <b id="axDropName">Elegir el archivo .xlsx</b>
          <small id="axDropHint">Se lee en tu navegador, no se sube el archivo</small>
        </div>
        <input type="file" id="axFile" accept=".xlsx,.xls" hidden>

        <div id="axPreview" class="wp-prev" style="display:none"></div>

        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="axCancel">Cancelar</button>
          <button class="btn" id="axPick">Elegir archivo</button>
          <button class="btn btn-primary" id="axSave" disabled>Actualizar lista</button>
        </div>
      </div>
    </div>`;

  let parsed = null, valid = null;
  const q = s => host.querySelector(s);
  const close = () => { document.removeEventListener('keydown', onKey); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#axX').addEventListener('click', close);
  q('#axCancel').addEventListener('click', close);
  q('#axDrop').addEventListener('click', () => q('#axFile').click());
  q('#axPick').addEventListener('click', () => q('#axFile').click());

  q('#axFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    q('#axDropName').textContent = f.name;
    q('#axDropHint').textContent = 'Leyendo…';
    try {
      parsed = await parseReporteAX(f);
      valid = validateReporteAX(parsed, STATE.cc);
      const prev = q('#axPreview');
      prev.style.display = 'block';
      if (parsed.missing.length) {
        prev.className = 'wp-prev warn';
        prev.innerHTML = `⚠ Falta(n) la(s) columna(s): <b>${parsed.missing.join(', ')}</b>. Revisa que sea el Reporte AX correcto.`;
        q('#axSave').disabled = true;
        q('#axDropHint').textContent = 'Archivo con columnas faltantes';
        return;
      }
      if (!valid.total) {
        prev.className = 'wp-prev warn';
        prev.innerHTML = `⚠ El archivo no trae personal para <b>${esc(STATE.cc)}</b>.`
          + (valid.foreignCompanies.length ? ` Trae datos de: <b>${valid.foreignCompanies.join(', ')}</b>.` : '')
          + ` Verifica que sea el Reporte AX de esta empresa.`;
        q('#axSave').disabled = true;
        q('#axDropHint').textContent = 'Sin filas para esta empresa';
        return;
      }
      prev.className = 'wp-prev ok';
      prev.innerHTML = `✓ <b>${valid.total} trabajadores</b> (${valid.active} vigentes · ${valid.terminated} egresados)`
        + (valid.hasAccountCol ? ` · ${valid.withAccount} con cuenta` : '')
        + `<div style="margin-top:6px;font-size:11.5px">El AX actualiza identidad, nacimiento, género, estado civil${valid.hasAccountCol ? ', cuenta y TodoTicket' : ''}. Se conservan cargo, teléfono, correo y dirección capturados aquí.</div>`
        + (valid.warnings.length ? `<div style="margin-top:6px;font-size:11.5px;color:var(--warn)">${valid.warnings.join(' ')}</div>` : '');
      q('#axDropHint').textContent = `${valid.total} filas válidas`;
      q('#axSave').disabled = !valid.okToUpload;
    } catch (err) {
      const prev = q('#axPreview');
      prev.style.display = 'block'; prev.className = 'wp-prev warn';
      prev.innerHTML = `No se pudo leer el archivo: ${esc(String(err.message || err))}`;
      q('#axSave').disabled = true;
    }
  });

  q('#axSave').addEventListener('click', async () => {
    if (!valid || !valid.okToUpload) return;
    const saveB = q('#axSave'); saveB.disabled = true; saveB.textContent = 'Actualizando…';
    const uploadedBy = STATE.user.name || STATE.user.username || 'admin';
    const r = await enterpriseRosterReplace(STATE.cc, valid.validRows, {
      uploadedBy, sourceFile: parsed.fileName, adminId: STATE.adminId,
    });
    if (!r.ok) { saveB.disabled = false; saveB.textContent = 'Actualizar lista'; alert(r.error || 'No se pudo actualizar.'); return; }
    close();
    await load();
  });
}

/* ---- ACTUALIZAR: traer personal desde AX (API) ----
   Llama a /api/ax-roster con el alias. No pide archivo. Escribe en la tabla
   que corresponda segun el tipo de empresa (lo decide el backend). La API
   trae el cargo, asi que es la via mas completa. Solo admin/superadmin.
   "Actualizar" = traer lo ultimo de AX (pisa cambios locales). Si habia
   cambios sin publicar, el descarte ya se confirmo antes de llegar aqui. */
function openAxApiModal() {
  const host = wpModalHost();
  const entidad = STATE.mode === 'enterprise' ? 'la empresa' : 'la tienda';
  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="apX" title="Cerrar">✕</button>
        <h3>Actualizar personal desde AX</h3>
        <p class="wp-who">${esc(STATE.cc)} · Trae el personal vigente directo de AX, sin Excel.</p>

        <div class="wp-okbox">
          ✓ Esta es la vía más completa: AX devuelve también el <b>cargo</b> de cada persona, además de identidad, nacimiento, género, estado civil, cuenta bancaria, TodoTicket y fechas.
        </div>
        <div class="pm-help" style="margin-top:12px"><b>El último reporte manda:</b> la lista que devuelve AX reemplaza el personal de ${entidad}. Quien ya no esté en AX sale del roster. Las fotos y datos de contacto (teléfono/correo/dirección) capturados aquí se conservan.</div>

        <div id="apResult" class="wp-prev" style="display:none"></div>

        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="apCancel">Cancelar</button>
          <button class="btn btn-primary" id="apGo">Actualizar</button>
        </div>
      </div>
    </div>`;

  const q = s => host.querySelector(s);
  // done=true cuando la actualizacion termino OK: al cerrar, recargamos.
  // El modal NUNCA se cierra solo; solo a peticion (X / Cerrar / fondo / Esc).
  let done = false;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    host.innerHTML = '';
    if (done) load();   // refresca la lista recien al cerrar
  };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#apX').addEventListener('click', close);
  q('#apCancel').addEventListener('click', close);

  q('#apGo').addEventListener('click', async () => {
    const goB = q('#apGo'); goB.disabled = true; goB.textContent = 'Actualizando…';
    const res = q('#apResult'); res.style.display = 'block'; res.className = 'wp-prev'; res.textContent = 'Conectando con AX y trayendo el personal…';
    const uploadedBy = STATE.user.name || STATE.user.username || 'admin';
    let r;
    try {
      r = await axRosterPull(STATE.cc, { uploadedBy, adminId: STATE.adminId });
    } catch (err) {
      res.className = 'wp-prev warn';
      res.innerHTML = `⚠ Error de conexion: ${esc(String(err && err.message || err))}`;
      goB.disabled = false; goB.textContent = 'Reintentar';
      return;
    }
    if (!r || !r.ok) {
      res.className = 'wp-prev warn';
      const msg = (r && r.error === 'cooldown')
        ? rosterCooldownMessage(r)
        : ((r && r.error) || 'No se pudo actualizar desde AX.');
      res.innerHTML = `⚠ ${esc(msg)}`;
      goB.disabled = false; goB.textContent = 'Reintentar';
      return;
    }
    const s = r.summary || {};
    res.className = 'wp-prev ok';
    res.innerHTML = `✓ <b>${s.total} trabajadores</b> actualizados (${s.active} vigentes · ${s.terminated} egresados)`
      + ` · ${s.with_role} con cargo · ${s.with_account} con cuenta`
      + (s.warnings && s.warnings.length ? `<div style="margin-top:6px;font-size:11.5px;color:var(--warn)">${s.warnings.join(' ')}</div>` : '');
    // Termino bien: marcamos done y dejamos el modal abierto. El boton pasa a
    // "Cerrar" (que recarga la lista al salir). NO se cierra solo.
    done = true;
    goB.disabled = false;
    goB.textContent = 'Cerrar';
    goB.onclick = close;
  });
}

/* ---- Confirmar descarte al ACTUALIZAR con cambios sin publicar ----
   Si hay pendientes, Actualizar los descartara (trae lo de AX y pisa lo
   local). Este modal avisa y, si el usuario acepta, sigue a openAxApiModal.
   Modal propio (sin nativos; cierra solo con sus botones). */
function openDiscardConfirmModal(n) {
  const host = wpModalHost();
  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="dcX" title="Cerrar">✕</button>
        <h3>Tienes ${n} cambio${n === 1 ? '' : 's'} sin publicar</h3>
        <p class="wp-who">${esc(STATE.cc)}</p>
        <div class="wp-dangerbox">
          Al <b>Actualizar</b> traes lo último de AX y se <b>descartan</b> ${n === 1 ? 'ese cambio que hiciste' : `esos ${n} cambios que hiciste`} aquí y no publicaste. Esta acción no se puede deshacer.
        </div>
        <p class="wp-help">Si quieres conservarlos, <b>Cancela</b> y usa <b>Publicar</b> primero para enviarlos a AX.</p>
        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="dcCancel">Cancelar</button>
          <button class="btn wp-btn-danger" id="dcOk">Sí, actualizar</button>
        </div>
      </div>
    </div>`;
  const q = s => host.querySelector(s);
  const close = () => { document.removeEventListener('keydown', onKey); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#dcX').addEventListener('click', close);
  q('#dcCancel').addEventListener('click', close);
  q('#dcOk').addEventListener('click', () => {
    // Cerrar este y abrir el de Actualizar (no recarga; solo cambia de modal).
    document.removeEventListener('keydown', onKey);
    host.innerHTML = '';
    openAxApiModal();
  });
}

/* ---- PUBLICAR: enviar a AX los cambios hechos en el portal ----
   ced=null  -> masivo: publica TODOS los pendientes de la empresa/alcance.
   ced=cedula-> individual: publica solo esa ficha.
   Llama a /api/worker-photo accion push_to_ax. Al exito, limpia el pendiente
   en memoria de los enviados, refresca el boton y repinta. Modal propio
   (cierra solo con sus botones). Solo superadmin (el backend lo re-valida). */
function openPublishModal(ced) {
  const host = wpModalHost();
  const pend = ced
    ? STATE.workers.filter(w => String(w.id_number) === String(ced) && w.ax_pending)
    : pendingWorkers();
  const n = pend.length;

  // Nombre de campo -> etiqueta corta para el resumen de que se publicara.
  const FIELD_LABEL = {
    first_name: 'Primer nombre', second_name: 'Segundo nombre', last_names: 'Apellidos',
    birth_date: 'Nacimiento', gender: 'Género', marital_status: 'Estado civil',
    account_number: 'Cuenta', phone: 'Teléfono', email: 'Correo',
  };
  const fieldsList = (w) => {
    const f = (w.ax_pending_fields && typeof w.ax_pending_fields === 'object') ? Object.keys(w.ax_pending_fields) : [];
    return f.map(k => FIELD_LABEL[k] || k).join(', ');
  };

  let body;
  if (!n) {
    body = `<div class="wp-prev" style="display:block">No hay cambios sin publicar.</div>`;
  } else if (ced) {
    const w = pend[0];
    body = `
      <div class="wp-okbox">
        Se publicará en AX la ficha de <b>${esc(w.full_name)}</b> (${w.ced_kind || ''}-${w.id_number}).
      </div>
      <p class="wp-help">Campos a publicar: <b>${esc(fieldsList(w) || '—')}</b>. Solo se envía lo que cambiaste aquí; los demás datos en AX quedan intactos.</p>`;
  } else {
    // Masivo: lista breve (hasta 8) + conteo.
    const rows = pend.slice(0, 8).map(w =>
      `<div style="display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:3px 0;border-bottom:1px solid var(--border)"><span>${esc(w.full_name)} <span class="wp-ced">${w.ced_kind || ''}-${w.id_number}</span></span><span class="muted" style="text-align:right">${esc(fieldsList(w) || '—')}</span></div>`
    ).join('');
    const more = n > 8 ? `<div class="muted" style="font-size:12px;margin-top:6px">… y ${n - 8} más</div>` : '';
    body = `
      <div class="wp-okbox">
        Se publicarán en AX <b>${n} ficha${n === 1 ? '' : 's'}</b> con cambios hechos aquí.
      </div>
      <div style="margin-top:10px">${rows}${more}</div>
      <p class="wp-help">Solo se envía lo que cambiaste en cada ficha; los demás datos en AX quedan intactos.</p>`;
  }

  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="pubX" title="Cerrar">✕</button>
        <h3>Publicar cambios en AX</h3>
        <p class="wp-who">${esc(STATE.cc)}</p>
        ${body}
        <div id="pubResult" class="wp-prev" style="display:none"></div>
        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="pubCancel">Cancelar</button>
          ${n ? '<button class="btn btn-primary" id="pubGo">Publicar</button>' : ''}
        </div>
      </div>
    </div>`;

  const q = s => host.querySelector(s);
  // done=true cuando publico OK: al cerrar, recargamos para traer ax_synced_at.
  let done = false;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    host.innerHTML = '';
    if (done) load();
  };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#pubX').addEventListener('click', close);
  q('#pubCancel').addEventListener('click', close);

  const goB = q('#pubGo');
  if (goB) goB.addEventListener('click', async () => {
    goB.disabled = true; goB.textContent = 'Publicando…';
    const res = q('#pubResult'); res.style.display = 'block'; res.className = 'wp-prev'; res.textContent = 'Enviando los cambios a AX…';
    const payload = {
      action: 'push_to_ax', company_code: STATE.cc, user: sessionUserPayload(STATE.user),
    };
    // Individual: pasa la cedula. Masivo: sin id_numbers (todos los pendientes).
    if (ced) payload.id_numbers = [String(ced)];
    let r;
    try {
      r = await api(payload);
    } catch (err) {
      res.className = 'wp-prev warn';
      res.innerHTML = `⚠ Error de conexion: ${esc(String(err && err.message || err))}`;
      goB.disabled = false; goB.textContent = 'Reintentar';
      return;
    }
    if (!r || !r.ok) {
      res.className = 'wp-prev warn';
      res.innerHTML = `⚠ ${esc((r && r.error) || 'No se pudo publicar en AX.')}`;
      goB.disabled = false; goB.textContent = 'Reintentar';
      return;
    }
    // Exito: limpiar el pendiente en memoria de los enviados.
    const sent = new Set((r.synced || []).map(String));
    STATE.workers.forEach(w => {
      if (sent.has(String(w.id_number))) {
        w.ax_pending = false;
        w.ax_pending_fields = {};
        w.ax_synced_at = new Date().toISOString();
      }
    });
    const rej = r.rejected_count || 0;
    res.className = 'wp-prev ok';
    res.innerHTML = `✓ <b>${r.sent} ficha${r.sent === 1 ? '' : 's'}</b> publicada${r.sent === 1 ? '' : 's'} en AX`
      + (rej ? `<div style="margin-top:6px;font-size:11.5px;color:var(--warn)">${rej} no se pudo enviar (sin campos válidos).</div>` : '');
    refreshPublishBtn();
    paintGrid();
    // Si estamos viendo la ficha de alguien que se publico, refrescarla.
    if (CUR && sent.has(String(CUR.id_number))) openFicha(String(CUR.id_number));
    done = true;
    goB.disabled = false;
    goB.textContent = 'Cerrar';
    goB.onclick = close;
  });
}

/* ---- Carga de Reporte AX en una TIENDA (solo admin) ----
   Escribe en store_workers via /api/roster (accion replace_ax). Regla
   "el ultimo reporte manda": el AX define el roster y pisa lo que trae;
   el cargo (que el AX no trae) se conserva del registro previo. */
function openReporteAXModalStore() {
  const host = wpModalHost();
  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="axsX" title="Cerrar">✕</button>
        <h3>Actualizar lista por Reporte AX</h3>
        <p class="wp-who">${esc(STATE.cc)} · Carga el <b>Reporte AX</b> (Excel de AX) para refrescar el personal de la tienda.</p>

        <div class="wp-drop" id="axsDrop">
          <svg class="wp-di" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <b id="axsDropName">Elegir el archivo .xlsx</b>
          <small id="axsDropHint">Se lee en tu navegador, no se sube el archivo</small>
        </div>
        <input type="file" id="axsFile" accept=".xlsx,.xls" hidden>

        <div id="axsPreview" class="wp-prev" style="display:none"></div>

        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="axsCancel">Cancelar</button>
          <button class="btn" id="axsPick">Elegir archivo</button>
          <button class="btn btn-primary" id="axsSave" disabled>Actualizar lista</button>
        </div>
      </div>
    </div>`;

  let parsed = null, valid = null;
  const q = s => host.querySelector(s);
  const close = () => { document.removeEventListener('keydown', onKey); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#axsX').addEventListener('click', close);
  q('#axsCancel').addEventListener('click', close);
  q('#axsDrop').addEventListener('click', () => q('#axsFile').click());
  q('#axsPick').addEventListener('click', () => q('#axsFile').click());

  q('#axsFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    q('#axsDropName').textContent = f.name;
    q('#axsDropHint').textContent = 'Leyendo…';
    try {
      parsed = await parseReporteAX(f);
      // En tienda el codigo de empresa del AX (ALIAS tipo AA01) debe coincidir
      // con el de la tienda. Validamos contra STATE.cc igual que en empresa.
      valid = validateReporteAX(parsed, STATE.cc);
      const prev = q('#axsPreview');
      prev.style.display = 'block';
      if (parsed.missing.length) {
        prev.className = 'wp-prev warn';
        prev.innerHTML = `⚠ Falta(n) la(s) columna(s): <b>${parsed.missing.join(', ')}</b>. Revisa que sea el Reporte AX correcto.`;
        q('#axsSave').disabled = true;
        q('#axsDropHint').textContent = 'Archivo con columnas faltantes';
        return;
      }
      if (!valid.total) {
        prev.className = 'wp-prev warn';
        prev.innerHTML = `⚠ El archivo no trae personal para <b>${esc(STATE.cc)}</b>.`
          + (valid.foreignCompanies.length ? ` Trae datos de: <b>${valid.foreignCompanies.join(', ')}</b>.` : '')
          + ` Verifica que sea el Reporte AX de esta tienda.`;
        q('#axsSave').disabled = true;
        q('#axsDropHint').textContent = 'Sin filas para esta tienda';
        return;
      }
      prev.className = 'wp-prev ok';
      prev.innerHTML = `✓ <b>${valid.total} trabajadores</b> (${valid.active} vigentes · ${valid.terminated} egresados)`
        + (valid.hasAccountCol ? ` · ${valid.withAccount} con cuenta` : '')
        + `<div style="margin-top:6px;font-size:11.5px"><b>El ultimo reporte manda:</b> el Reporte AX redefine la lista y actualiza identidad, nacimiento, genero, estado civil${valid.hasAccountCol ? ', cuenta y TodoTicket' : ''}. El cargo (que el AX no trae) se conserva.</div>`
        + (valid.warnings.length ? `<div style="margin-top:6px;font-size:11.5px;color:var(--warn)">${valid.warnings.join(' ')}</div>` : '');
      q('#axsDropHint').textContent = `${valid.total} filas validas`;
      q('#axsSave').disabled = !valid.okToUpload;
    } catch (err) {
      const prev = q('#axsPreview');
      prev.style.display = 'block'; prev.className = 'wp-prev warn';
      prev.innerHTML = `No se pudo leer el archivo: ${esc(String(err.message || err))}`;
      q('#axsSave').disabled = true;
    }
  });

  q('#axsSave').addEventListener('click', async () => {
    if (!valid || !valid.okToUpload) return;
    const saveB = q('#axsSave'); saveB.disabled = true; saveB.textContent = 'Actualizando…';
    const uploadedBy = STATE.user.name || STATE.user.username || 'admin';
    const r = await storeRosterReplaceAX(STATE.cc, valid.validRows, {
      uploadedBy, sourceFile: parsed.fileName, adminId: STATE.adminId,
    });
    if (!r.ok) { saveB.disabled = false; saveB.textContent = 'Actualizar lista'; alert(r.error || 'No se pudo actualizar.'); return; }
    close();
    await load();
  });
}

/* ---- Agregar colaborador manual ---- */
function openAddManualModal() {
  const host = wpModalHost();
  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="amX" title="Cerrar">✕</button>
        <h3>Agregar colaborador</h3>
        <p class="wp-who">${esc(STATE.cc)} · Alta manual de una persona que aún no está en el Reporte 10.</p>

        <div class="wp-ced-anchor">
          <span class="l">🪪 Cédula</span>
          <input id="amCed" inputmode="numeric" placeholder="12345678" maxlength="8">
          <span class="hint-side">identifica · no se podrá cambiar luego</span>
        </div>

        <label class="flabel">Nombre y apellidos</label>
        <input id="amFull" type="text" placeholder="Escribe el nombre completo…">
        <div class="wp-namesplit" id="amSplit" style="display:none"></div>

        <div class="wp-grid2">
          <div><label class="flabel">Cargo</label>
            <input id="amRole" type="text" placeholder="ej. VENDEDOR"></div>
          <div><label class="flabel">Estado</label>
            <select id="amStatus"><option value="vigente">Vigente</option><option value="egresado">Egresado</option></select></div>
        </div>

        <p class="wp-help">Se pide lo mínimo para crearlo en la lista. El resto de la ficha (nacimiento, género, cuenta, contacto, foto) se completa luego abriendo su tarjeta. Entra a la lista de la tienda marcado como <b>manual</b>.</p>

        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="amCancel">Cancelar</button>
          <button class="btn btn-primary" id="amSave" disabled>Crear colaborador</button>
        </div>
      </div>
    </div>`;

  const q = s => host.querySelector(s);
  const close = () => { document.removeEventListener('keydown', onKey); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#amX').addEventListener('click', close);
  q('#amCancel').addEventListener('click', close);

  let split = { first_name: '', second_name: '', last_names: '' };
  function refresh() {
    const ced = q('#amCed').value.replace(/\D/g, '');
    const full = q('#amFull').value.trim();
    if (full) {
      split = splitFullName(full);
      q('#amSplit').style.display = 'block';
      q('#amSplit').innerHTML = `Se guardará dividido — <b>Nombre:</b> ${esc(split.first_name)}`
        + (split.second_name ? ` · <b>2do:</b> ${esc(split.second_name)}` : '')
        + ` · <b>Apellidos:</b> ${esc(split.last_names || '—')}`;
    } else {
      q('#amSplit').style.display = 'none';
    }
    const ok = ced.length >= 6 && ced.length <= 8 && split.first_name && split.last_names;
    q('#amSave').disabled = !ok;
  }
  q('#amCed').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, ''); refresh(); });
  q('#amFull').addEventListener('input', refresh);

  q('#amSave').addEventListener('click', async () => {
    const ced = q('#amCed').value.replace(/\D/g, '');
    if (!split.last_names) { alert('Escribe nombre y apellidos.'); return; }
    const saveB = q('#amSave'); saveB.disabled = true; saveB.textContent = 'Creando…';
    const r = await rosterAddManual(STATE.cc, {
      id_number: ced,
      first_name: split.first_name, second_name: split.second_name, last_names: split.last_names,
      role: q('#amRole').value.trim(),
      egresado: q('#amStatus').value === 'egresado',
    }, sessionUserPayload(STATE.user));
    if (!r.ok) { saveB.disabled = false; saveB.textContent = 'Crear colaborador'; alert(r.error || 'No se pudo crear.'); return; }
    close();
    await load();
    // Abrir su ficha para completar el resto de datos.
    if (r.id_number) openFicha(r.id_number);
  });
}

/* ---- Limpiar lista (destructivo) ---- */
function openClearModal() {
  const host = wpModalHost();
  const total = STATE.workers.length;
  const isEnt = STATE.mode === 'enterprise';
  const entidad = isEnt ? 'la empresa' : 'la tienda';
  const repName = isEnt ? 'Reporte AX' : 'Reporte 10';
  host.innerHTML = `
    <div class="wp-modal-vp">
      <div class="wp-modal">
        <button class="wp-x" id="clX" title="Cerrar">✕</button>
        <h3 style="color:var(--danger)">Limpiar lista de personal</h3>
        <p class="wp-who">${esc(STATE.cc)} · Esta acción vacía <b>toda</b> la lista de ${entidad}.</p>

        <div class="wp-dangerbox">
          <b>Se quitarán los ${total} colaboradores</b> de la lista de ${entidad}${isEnt ? '' : ' (los del Reporte 10 <u>y</u> los manuales)'}.
        </div>
        <div class="wp-okbox">
          ✓ <b>Las fotos y fichas NO se borran.</b> Quedan guardadas en el directorio por cédula. Si la persona vuelve a la lista —por ${repName}${isEnt ? '' : ' o manual'}— su foto y datos reaparecen automáticamente.
        </div>

        <label class="flabel">Para confirmar, escribe el código de ${entidad}: <b>${esc(STATE.cc)}</b></label>
        <input id="clConfirm" autocomplete="off" placeholder="${esc(STATE.cc)}">

        <div class="wp-foot">
          <span style="flex:1"></span>
          <button class="btn" id="clCancel">Cancelar</button>
          <button class="btn wp-btn-danger" id="clOk" disabled>Sí, vaciar la lista</button>
        </div>
      </div>
    </div>`;

  const q = s => host.querySelector(s);
  const close = () => { document.removeEventListener('keydown', onKey); host.innerHTML = ''; };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  q('#clX').addEventListener('click', close);
  q('#clCancel').addEventListener('click', close);
  q('#clConfirm').addEventListener('input', e => {
    q('#clOk').disabled = e.target.value.trim().toUpperCase() !== String(STATE.cc).toUpperCase();
  });
  q('#clOk').addEventListener('click', async () => {
    const okB = q('#clOk'); okB.disabled = true; okB.textContent = 'Vaciando…';
    const r = isEnt
      ? await enterpriseRosterClear(STATE.cc, STATE.adminId)
      : await rosterClear(STATE.cc, { user: sessionUserPayload(STATE.user) });
    if (!r.ok) { okB.disabled = false; okB.textContent = 'Sí, vaciar la lista'; alert(r.error || 'No se pudo limpiar.'); return; }
    close();
    await load();
  });
}
