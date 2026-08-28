/* =====================================================================
   bank-ref-ficha.js — Referencia bancaria (PDF) en la ficha del trabajador.
   F1 (v6.66). Se inyecta SOLO en la seccion Datos Bancarios de la ficha
   (worker-photos.js); no toca la cuenta manual ni el resto de la ficha.

   Flujo: el usuario sube el PDF de la referencia -> se extrae en el NAVEGADOR
   con pdfjs (banco + cedula + cuenta) -> semaforos -> se guarda SIEMPRE en
   /api/bank-ref (estado pendiente). Las discrepancias son ADVERTENCIAS que
   persisten; la adopcion del numero se decide al Publicar (Sincronizar).

   Exporta: initBankRefCard(host, w, STATE)
   ===================================================================== */

// pdfjs AUTO-ALOJADO en el propio dominio: la CSP del portal es
// script-src 'self' cdnjs, pero el Web Worker cae bajo default-src 'self',
// asi que cdnjs lo bloquearia. Servido desde /vendor/pdfjs/ todo es 'self'.
const PDFJS_ESM = '/vendor/pdfjs/pdf.min.mjs';
const PDFJS_WORKER = '/vendor/pdfjs/pdf.worker.min.mjs';

// prefijo de 4 digitos por plantilla + deteccion por texto
const BANK_PREFIX = { bdv: '0102', banesco: '0134', mercantil: '0105', bancamiga: '0172', bnc: '0191' };

let _pdfjs = null;
async function ensurePdfjs() {
  if (_pdfjs) return _pdfjs;
  const lib = await import(/* @vite-ignore */ PDFJS_ESM);
  try { lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; } catch (_) { /* noop */ }
  _pdfjs = lib;
  return lib;
}

/* ---------- API ---------- */
async function refApi(payload) {
  const res = await fetch('/api/bank-ref', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}
function sessUser(u) { return { kind: u.kind, id: u.id || null, companyCode: u.companyCode || null }; }

/* ---------- utilidades de texto ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const digits = s => String(s || '').replace(/\D/g, '');
function normCed(s) { return digits(s).replace(/^0+/, ''); }        // quita ceros a la izquierda
function collapse(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function fmtAcct(a) { const d = digits(a); return d.length === 20 ? d.replace(/(\d{4})(\d{4})(\d{2})(\d{10})/, '$1-$2-$3-$4') : d; }
function fmtCed(c) { const d = digits(c); return 'V-' + d.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

// nombre: normaliza (mayus, sin acentos/no-letras, tokens ordenados) para comparar
function nameKey(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}
/* v6.231 — Se EXPORTAN las tres piezas puras (leer el PDF, extraer los
   campos, evaluarlos) para que el wizard de Ingreso valide la referencia
   con EXACTAMENTE la misma logica que la ficha, sin montar toda la
   tarjeta -que ademas lista, firma y anula, cosas que en un alta no
   existen todavia-. Duplicar el parser habria sido garantizar que en seis
   meses la ficha y el ingreso juzguen distinto el mismo PDF. */
function nameSim(a, b) {
  const ka = nameKey(a), kb = nameKey(b);
  if (!ka || !kb) return false;
  const A = new Set(ka.split(' ')), B = new Set(kb.split(' '));
  let inter = 0; A.forEach(t => { if (B.has(t)) inter++; });
  const ratio = inter / Math.max(A.size, B.size);
  return ratio >= 0.5;   // toleran mutilacion / segundo nombre faltante
}

// numeros en letras (dias 1..31 y anios "dos mil ...") para fechas BDV
const UNITS = { cero: 0, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30 };
const MONTHS = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
function wordDay(w) {
  w = String(w || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (UNITS[w] != null) return UNITS[w];
  const m = w.match(/^(veinti|treinta y )?(uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)?$/);
  if (w.startsWith('treinta y ')) { const u = UNITS[w.slice(10).trim()]; return u != null ? 30 + u : null; }
  return null;
}
function wordYear(txt) {
  // "dos mil veintiseis" / "dos mil veinticinco"
  const t = String(txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const m = t.match(/dos mil\s+([a-z]+)/);
  if (m && UNITS[m[1]] != null) return 2000 + UNITS[m[1]];
  if (/dos mil/.test(t)) return 2000;
  return null;
}
function pad2(n) { return String(n).padStart(2, '0'); }

/* ---------- deteccion de banco ---------- */
// El nombre del banco suele venir SOLO en el logo (imagen), no en el texto
// (ej. Banesco). Por eso se detecta tambien por RIF/direccion del banco y,
// como ultimo recurso, por el PREFIJO de la cuenta (lo mas confiable).
const BANK_BY_PREFIX = { '0102': 'bdv', '0134': 'banesco', '0105': 'mercantil', '0172': 'bancamiga' };
function detectBank(text, acctPrefix) {
  const t = text || '';
  if (/Mercantil/i.test(t) || /REFERENCIA BANCARIA DE CUENTAS/i.test(t)) return 'mercantil';
  if (/Banesco/i.test(t) || /J-?\s*0?7013380/i.test(t) || /Bello Monte/i.test(t)) return 'banesco';
  if (/Bancamiga/i.test(t) || /J-?\s*0?31628759/i.test(t)) return 'bancamiga';
  if (/Banco de Venezuela|REFERENCIA BANCARIA CONSOLIDADA|\bBDV\b|G-?\s*20000110/i.test(t)) return 'bdv';
  /* v6.262 — BNC. Sus documentos no dicen "referencia bancaria" en ningun
     lado: la gente imprime la pantalla "Mis Cuentas" de BNCNET, que trae el
     numero de cuenta y el titular pero NO la cedula. */
  if (/Banco Nacional de Cr[eé]dito|BNCNET|bncenlinea/i.test(t)) return 'bnc';
  if (acctPrefix && BANK_BY_PREFIX[acctPrefix]) return BANK_BY_PREFIX[acctPrefix];
  return 'otro';
}

/* Elige el numero de cuenta entre TODOS los candidatos del texto.  (v6.262)

   Antes se tomaba el PRIMER bloque de 20 o mas caracteres de digitos, guiones
   y espacios, sin mirar si era una cuenta. Dos formas de fallar, las dos
   vistas en documentos reales:

   1. El banco separa la cuenta con PUNTOS (0191.0151.74.2100199299). El punto
      no estaba en el conjunto, el bloque quedaba corto y la cuenta se perdia
      entera: sin cuenta no hay prefijo, sin prefijo no hay banco, y la
      pantalla decia "banco no reconocido" sobre un PDF perfectamente legible.
   2. Otro numero largo aparecia antes en el documento y se lo llevaba puesto.

   Ahora se juntan todos los candidatos y gana el que empieza con un codigo de
   banco DEL CATALOGO -las 26 entidades de la tabla bancos, no las 4 que
   conocia esta funcion-. Recien si ninguno lo tiene, se usa el primero. */
function elegirCuenta(text, bankMap) {
  const cands = [];
  const re = /\d[\d\-.\s]{18,34}\d/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const d = m[0].replace(/\D/g, '');
    if (d.length < 20) continue;
    /* Ventanas de 20 digitos dentro del bloque: cubre el caso de un digito
       suelto pegado adelante. Se corta en 6 para no inventar combinaciones. */
    for (let i = 0; i + 20 <= d.length && i <= 6; i++) cands.push(d.slice(i, i + 20));
  }
  if (!cands.length) return null;
  const conBanco = cands.find(c => bankMap && bankMap[c.slice(0, 4)]);
  return conBanco || cands[0];
}

/* ---------- parser de campos ---------- */
/* Valor de un campo de formulario, si el PDF traia. */
function campoF(text, nombre) {
  const m = String(text || '').match(new RegExp('\\[F:' + nombre + '=([^\\]]*)\\]', 'i'));
  return m ? collapse(m[1]) : null;
}

export function parseFields(rawText, bankMap) {
  const text = collapse(rawText);
  const out = { plantilla: 'otro', banco_code: null, banco_nombre: null, cuenta: null, cuenta_last4: null,
    tipo_cuenta: null, cedula_pdf: null, nombre_pdf: null, nro_operacion: null, fecha_emision: null };

  // cedula
  let mCed = text.match(/C[eé]dula de Identidad\s*(?:Nro)?:?\.?\s*V?\s*[-\s]?\s*([0-9.\s]{6,14})/i)
    || text.match(/C\.?\s*I\.?\s*:?\s*V?\s*[-\s]?\s*([0-9.\s]{6,14})/i)
    /* v6.262 — El "V-" suelto tambien con puntos: "V-27.476.899". Antes este
       patron exigia los digitos pegados, asi que en los documentos que
       separan la cedula con puntos y no escriben "Cedula de Identidad" ni
       "C.I." delante, no se leia ninguna. normCed limpia los puntos despues. */
    || text.match(/\bV\s*[-\s]?\s*0?([0-9][0-9.\s]{5,12}[0-9])\b/);
  if (mCed) {
    const c = normCed(mCed[1]);
    /* Una cedula venezolana tiene entre 6 y 9 digitos. Si el patron agarro de
       mas -por ejemplo una fecha o un monto pegado- se descarta en vez de
       guardar un numero cualquiera como si fuera la cedula. */
    if (c.length >= 6 && c.length <= 9) out.cedula_pdf = c;
  }

  // nombre (best-effort por plantilla; la cedula es la llave real)
  let mNom = text.match(/Sr\(a\):?\s*([A-ZÁÉÍÓÚÑ\s]+?),?\s*portador/i)
    || text.match(/presente,?\s*que\s*(?:el\(la\)\s*)?(?:Se[nñ]or\(a\):?\s*)?([A-ZÁÉÍÓÚÑ\s]+?)[,\s]*(?:portador|titular|con)/i)
    || text.match(/constar que,?\s*([A-ZÁÉÍÓÚÑ\s]+?)\s*\*/i)
    || text.match(/Se[nñ]or\(a\):?\s*([A-ZÁÉÍÓÚÑ\s]{6,})/i);
  if (mNom) out.nombre_pdf = collapse(mNom[1]);

  // cuenta completa (funciona para todos los bancos no-enmascarados)
  const cuentaFull = elegirCuenta(text, bankMap);

  // plantilla: por texto (RIF/nombre/direccion) y, si falla, por el prefijo
  out.plantilla = detectBank(text, cuentaFull ? cuentaFull.slice(0, 4) : null);

  if (out.plantilla === 'mercantil') {
    /* Los campos del formulario mandan sobre el texto de la pagina, que aca
       es la plantilla de muestra. Si el PDF no los trae -por ejemplo si
       alguien lo reimprimio- se cae al texto, que es lo que habia antes. */
    const num = campoF(text, 'productnumber');
    const dnum = num ? num.replace(/\D/g, '') : '';
    if (dnum.length >= 4) out.cuenta_last4 = dnum.slice(-4);
    else { const mk = text.match(/\*{3,}\s*(\d{4})\b/); if (mk) out.cuenta_last4 = mk[1]; }
    const nom = [campoF(text, 'clientname1'), campoF(text, 'clientname2')]
      .filter(Boolean).join(' ').replace(/[*]+/g, ' ').trim();
    if (nom) out.nombre_pdf = collapse(nom);
    const cedF = campoF(text, 'rif');
    if (cedF) { const d = cedF.replace(/\D/g, ''); if (d.length >= 6) out.cedula_pdf = normCed(d); }
    const tipo = campoF(text, 'productdesc');
    if (tipo) out.tipo_cuenta = tipo;
    const ref = campoF(text, 'refcode');
    if (ref) out.nro_operacion = ref.replace(/\D/g, '') || null;
    out.banco_code = '0105';
  } else if (cuentaFull) {
    out.cuenta = cuentaFull; out.banco_code = cuentaFull.slice(0, 4); out.cuenta_last4 = cuentaFull.slice(-4);
  } else if (BANK_PREFIX[out.plantilla]) {
    out.banco_code = BANK_PREFIX[out.plantilla];
  }
  out.banco_nombre = out.banco_code ? ((bankMap && bankMap[out.banco_code]) || null) : null;

  // nro operacion / referencia / confirmacion
  const mOp = text.match(/(?:Operaci[oó]n|Referencia|Confirmaci[oó]n)\s*:?\s*(\d{6,15})/i);
  /* v6.247 — Solo si no vino del formulario: en Mercantil la plantilla de
     fondo trae 'Confirmacion: 12345678', que es del ejemplo. */
  if (mOp && !out.nro_operacion) out.nro_operacion = mOp[1];

  // tipo de cuenta
  const mTipo = text.match(/(CUENTAS?\s+CORRIENTES?|CUENTA\s+DE\s+AHORROS?|CUENTA\s+ELEC\.?[^,\n]*|Cuenta\s+Corriente\s+Amiga)/i);
  if (mTipo && !out.tipo_cuenta) out.tipo_cuenta = collapse(mTipo[1]);

  // fecha de emision — numerica o en letras (BDV)
  let f = text.match(/a los\s+(\d{1,2})\s+d[ií]as del mes de\s+([a-záéíóú]+)\s+de[l]?\s+(\d{4})/i);
  if (f) {
    const mo = MONTHS[f[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')];
    if (mo) out.fecha_emision = `${f[3]}-${pad2(mo)}-${pad2(parseInt(f[1], 10))}`;
  } else {
    const fl = text.match(/a los\s+([a-záéíóú]+)\s+d[ií]as del mes de\s+([a-záéíóú]+)\s+de[l]?\s+(dos mil[a-záéíóú\s]+?)(?:[.,]|$)/i);
    if (fl) {
      const d = wordDay(fl[1]); const mo = MONTHS[fl[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')]; const y = wordYear(fl[3]);
      if (d && mo && y) out.fecha_emision = `${y}-${pad2(mo)}-${pad2(d)}`;
    }
  }
  return out;
}

/* ---------- semaforos vs la ficha ---------- */
export function evaluate(fields, w, mercAcct, bankMap) {
  const fichaCed = digits(w.id_number);
  const cedOk = !!fields.cedula_pdf && digits(fields.cedula_pdf) === fichaCed;
  const nameOk = !!fields.nombre_pdf && nameSim(fields.nombre_pdf, w.full_name);
  const known = p => !!p && (!!(bankMap && bankMap[p]) || Object.values(BANK_PREFIX).indexOf(p) >= 0);

  let cuenta = fields.cuenta, acctOk, prefKnown, incoherent = false;
  if (fields.plantilla === 'mercantil') {
    const raw = digits(mercAcct);
    acctOk = raw.length === 20 && !!fields.cuenta_last4 && raw.slice(-4) === fields.cuenta_last4 && raw.slice(0, 4) === '0105';
    prefKnown = true;
    if (acctOk) cuenta = raw;
  } else {
    acctOk = !!cuenta && digits(cuenta).length === 20;
    const pref = cuenta ? digits(cuenta).slice(0, 4) : (fields.banco_code || null);
    prefKnown = known(pref);
    const detPref = BANK_PREFIX[fields.plantilla];
    incoherent = !!(detPref && pref && detPref !== pref);
  }
  const bankOk = !!prefKnown && !incoherent;

  /* --- Titularidad (v6.231). Reescrito tras medir los 532 documentos ya
     cargados: la regla anterior acusaba 'es de otra persona' 9 veces y solo 2
     lo eran. Las otras 7 tenian la cedula ILEGIBLE -el parser no la saca, casi
     siempre BNC- y en 6 la cuenta del PDF coincidia digito por digito con la
     del trabajador. Acusar por un dato que no se pudo leer no es una
     validacion estricta: es una acusacion sin evidencia, y en el wizard de
     Ingreso ademas habria trabado altas legitimas.

     Dos reglas, las mismas que usa doc_estado_personal en la base para que la
     ficha y el ingreso nunca juzguen distinto el mismo PDF:
       1. LA CUENTA MANDA. Si la cuenta del PDF es la del trabajador, el
          documento es suyo. Es prueba mas fuerte que el nombre (que lo
          escribe el banco y a veces deforma) y que la cedula.
       2. NO SE ACUSA CON DATOS ILEGIBLES. Sin cedula legible se pide revisar,
          no se afirma que sea de un tercero.
     Con esto los 9 quedan en 2, y esos 2 son reales: el mismo PDF de MANUEL
     MENDOZA subido como referencia de dos trabajadores distintos de CB02. --- */
  const l4Pdf = fields.cuenta_last4 || (cuenta ? digits(cuenta).slice(-4) : '');
  const l4Ref = digits(mercAcct || '').slice(-4);
  const cuentaEsSuya = !!l4Pdf && l4Pdf.length === 4 && l4Pdf === l4Ref;

  const warnings = [];
  if (cuentaEsSuya || cedOk) {
    /* Confirmado. Sin advertencia de titularidad. */
  } else if (!fields.cedula_pdf) {
    warnings.push({ level: 'warn', code: 'ilegible', text: 'No se pudo leer la cédula del PDF y la cuenta no coincide con la cargada. Verifica que el documento sea del trabajador.' });
  } else if (nameOk) {
    warnings.push({ level: 'warn', code: 'cedula_mismatch', text: `La cédula del PDF (${fmtCed(fields.cedula_pdf)}) no coincide con la de la ficha (${fmtCed(fichaCed)}), aunque el nombre sí. Posible dígito mal escrito.` });
  } else {
    warnings.push({ level: 'err', code: 'other_person', text: `El PDF es de otra persona (${fields.nombre_pdf || '—'}, ${fmtCed(fields.cedula_pdf)}) y la cuenta tampoco es la del trabajador. Solo se aceptan cuentas del titular.` });
  }
  // Nombre: cuando la cédula coincide NO se advierte por el nombre (los bancos
  // lo deforman — ej. Banesco). El nombre es solo informativo; manda la cédula.
  if (incoherent) warnings.push({ level: 'warn', code: 'bank_incoherent', text: 'La carta parece de un banco distinto al del número de cuenta. Revísalo.' });

  const validaciones = { cedula_ok: cedOk, banco_ok: bankOk, formato_ok: !!acctOk, nombre_ok: nameOk,
    cuenta_es_suya: cuentaEsSuya,
    ficha_cedula: fichaCed, ficha_nombre: w.full_name || '', warnings };
  return { cedOk, nameOk, acctOk: !!acctOk, prefKnown: !!prefKnown, bankOk, incoherent, cuenta,
    cuentaEsSuya, warnings, validaciones };
}

/* ---------- estilos (una sola vez) ---------- */
function ensureStyles() {
  if (document.getElementById('brf-styles')) return;
  const st = document.createElement('style');
  st.id = 'brf-styles';
  st.textContent = `
  #bankRefSlot{display:block;width:100%}
  .brf-card{border:1px solid #e5e7eb;border-radius:12px;background:#fbfcfe;padding:13px 15px;margin-top:8px;width:100%}
  .brf-top{display:flex;align-items:center;gap:13px;flex-wrap:wrap}
  .brf-top .sp{flex:1}
  .brf-ic{width:40px;height:40px;border-radius:10px;background:#eff6ff;color:#2563eb;display:flex;align-items:center;justify-content:center;flex:none}
  .brf-ic svg{width:20px;height:20px}
  .brf-body{flex:1;min-width:0}
  .brf-title{font-size:14px;font-weight:700;color:#111827;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
  .brf-sub{color:#6b7280;font-size:12.5px;margin-top:2px;line-height:1.45}
  .brf-chip{display:inline-flex;align-items:center;gap:7px;background:#f5f3ff;border:1px solid #ddd6fe;color:#6d28d9;font-size:11.5px;font-weight:600;border-radius:999px;padding:4px 11px}
  .brf-badge{font-size:10px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;border-radius:999px;padding:2px 8px}
  .brf-badge.pend{background:#fffbeb;border:1px solid #fde68a;color:#92400e}
  .brf-badge.load{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af}
  .brf-badge.pub{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534}
  .brf-badge.none{background:#f3f4f6;border:1px solid #e5e7eb;color:#6b7280}
  .brf-help{margin-top:10px;padding-top:10px;border-top:1px dashed #e5e7eb;font-size:12px;color:#64748b;line-height:1.5}
  .brf-help b{color:#374151}
  .brf-lnk{color:#7c3aed;cursor:pointer;font-weight:650;text-decoration:none}
  .brf-lnk:hover{text-decoration:underline}
  .brf-del{color:#dc2626;font-weight:650;cursor:pointer;font-size:12.5px;margin-right:8px}
  .brf-del:hover{text-decoration:underline}
  .brf-btn{border:1px solid #7c3aed;background:#fff;color:#7c3aed;border-radius:9px;padding:7px 13px;font-size:12.5px;font-weight:700;cursor:pointer;display:inline-flex;gap:7px;align-items:center}
  .brf-btn:hover{background:#f5f3ff}
  .brf-btn svg{width:14px;height:14px}
  .brf-none{font-size:12.5px;color:#64748b}
  /* overlay modal */
  .brf-ov{position:fixed;inset:0;background:rgba(15,23,42,.42);display:flex;align-items:center;justify-content:center;padding:22px;z-index:9000}
  .brf-modal{background:#fff;border-radius:16px;width:560px;max-width:100%;max-height:92vh;overflow:auto;box-shadow:0 24px 70px rgba(15,23,42,.32);font-size:14px;color:#111827}
  .brf-mh{display:flex;align-items:center;gap:11px;padding:17px 20px;border-bottom:1px solid #eceff3}
  .brf-mh .ic{width:34px;height:34px;border-radius:9px;background:#f5f3ff;color:#7c3aed;display:flex;align-items:center;justify-content:center;flex:none}
  .brf-mh b{font-size:15px}
  .brf-mh small{display:block;color:#64748b;font-size:12px}
  .brf-mh .x{margin-left:auto;border:0;background:transparent;color:#64748b;cursor:pointer;padding:4px;border-radius:7px;font-size:20px;line-height:1}
  .brf-mb{padding:18px 20px}
  .brf-drop{border:2px dashed #e5e7eb;border-radius:13px;padding:26px;text-align:center;cursor:pointer}
  .brf-drop:hover{border-color:#7c3aed;background:#f5f3ff}
  .brf-drop b{font-size:14.5px}
  .brf-drop p{color:#64748b;font-size:12.5px;margin-top:5px;line-height:1.5}
  .brf-titular{display:flex;gap:9px;align-items:flex-start;background:#fffbeb;border:1px solid #fde68a;border-radius:11px;padding:11px 13px;margin-top:14px;font-size:12.5px;color:#92400e;line-height:1.5}
  .brf-rows{display:flex;flex-direction:column;gap:7px;margin-top:4px}
  .brf-row{display:grid;grid-template-columns:78px 1fr auto;gap:10px;align-items:center;padding:9px 12px;border-radius:10px;border:1px solid #eceff3;background:#fff}
  .brf-row.ok{background:#f0fdf4;border-color:#bbf7d0}
  .brf-row.warn{background:#fffbeb;border-color:#fde68a}
  .brf-row.err{background:#fef2f2;border-color:#fecaca}
  .brf-row .l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#64748b}
  .brf-row .v{font-size:13.5px;font-weight:600}
  .brf-row .v .mono{font-family:ui-monospace,Consolas,monospace}
  .brf-sem{font-size:11.5px;font-weight:700;white-space:nowrap}
  .brf-sem.ok{color:#16a34a}.brf-sem.warn{color:#d97706}.brf-sem.err{color:#dc2626}.brf-sem.info{color:#64748b}
  .brf-merc{margin-top:8px;padding:12px 13px;border:1px solid #fde68a;background:#fffbeb;border-radius:11px}
  .brf-merc label{font-size:11.5px;font-weight:700;color:#92400e;display:block;margin-bottom:7px}
  /* v6.248 — La cuenta se muestra partida: el prefijo del banco y el final
     que dice la referencia van FIJOS y no se pueden tocar; solo se escriben
     los 12 del medio. Ademas de ahorrar tipeo, vuelve imposible equivocarse
     en las partes que ya estaban bien. */
  .brf-acct{display:flex;align-items:stretch;gap:0;border:1.5px solid #fde68a;border-radius:9px;overflow:hidden;background:#fff}
  .brf-fijo{display:flex;align-items:center;padding:9px 11px;background:#fef3c7;color:#92400e;
    font-family:ui-monospace,Consolas,monospace;font-size:15px;font-weight:700;letter-spacing:.05em;
    white-space:nowrap;user-select:none;flex:none}
  .brf-merc input{flex:1;min-width:0;width:auto;font-family:ui-monospace,Consolas,monospace;font-size:15px;
    letter-spacing:.08em;text-align:center;padding:9px 8px;border:0;border-left:1px dashed #fde68a;
    border-right:1px dashed #fde68a;border-radius:0;outline:0;background:#fff}
  .brf-merc input:focus{background:#fffdf5;box-shadow:inset 0 0 0 2px rgba(217,119,6,.18)}
  .brf-acct-h{font-size:11px;color:#92400e;margin-top:6px;font-weight:600}
  .brf-verdict{display:flex;gap:9px;align-items:flex-start;margin-top:15px;padding:11px 13px;border-radius:11px;font-size:12.5px;font-weight:600;line-height:1.45}
  .brf-verdict.ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534}
  .brf-verdict.warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e}
  .brf-verdict.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}
  .brf-verdict.info{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af}
  .brf-mf{display:flex;gap:9px;align-items:center;padding:15px 20px;border-top:1px solid #eceff3;background:#fbfcfe}
  .brf-mf .note{font-size:11px;color:#64748b;margin-right:auto;max-width:260px;line-height:1.4}
  .brf-mf .go{border:1px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:9px;padding:9px 15px;font-weight:700;cursor:pointer}
  .brf-mf .go:disabled{background:#cbd5e1;border-color:#cbd5e1;cursor:not-allowed}
  .brf-mf .cancel{border:1px solid #e5e7eb;background:#fff;color:#374151;border-radius:9px;padding:9px 14px;font-weight:600;cursor:pointer}
  .brf-spin{display:inline-block;width:16px;height:16px;border:2px solid #ddd6fe;border-top-color:#7c3aed;border-radius:50%;animation:brfspin .7s linear infinite;vertical-align:-3px}
  @keyframes brfspin{to{transform:rotate(360deg)}}
  `;
  document.head.appendChild(st);
}

const UP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';

/* ===================== TARJETA EN LA FICHA ===================== */
export async function initBankRefCard(host, w, STATE, onRender) {
  const slot = host.querySelector('#bankRefSlot');
  if (!slot) return;
  ensureStyles();
  const canUpload = !!(STATE.can && STATE.can.bankref);
  const fire = () => { try { if (typeof onRender === 'function') onRender(); } catch (_) { /* noop */ } };

  const render = (refs) => {
    const latest = (refs || []).find(r => r.estado !== 'anulada') || null;
    if (!canUpload && !latest) { slot.innerHTML = ''; fire(); return; }

    let badge, sub;
    if (latest) {
      const fecha = latest.fecha_emision || (latest.created_at ? String(latest.created_at).slice(0, 10) : '');
      badge = latest.estado === 'publicada'
        ? '<span class="brf-badge pub">publicada</span>'
        : '<span class="brf-badge load">cargada</span>';
      const nWarn = (latest.validaciones && latest.validaciones.warnings || []).length;
      const warnTxt = nWarn ? ` · <span style="color:#d97706;font-weight:700">⚠ ${nWarn} advertencia${nWarn === 1 ? '' : 's'}</span>` : '';
      sub = `Cargada el ${esc(fecha)} · <span class="brf-lnk" data-brf="view" data-path="${esc(latest.storage_path || '')}">Ver PDF</span>${warnTxt}`;
    } else {
      badge = '<span class="brf-badge none">sin cargar</span>';
      sub = 'Aún no hay una referencia bancaria cargada.';
    }

    const btn = canUpload
      ? `<button class="brf-btn" data-brf="upload">${UP_SVG} ${latest ? 'Cargar / reemplazar' : 'Cargar referencia (PDF)'}</button>`
      : '';
    const canRemove = !!(STATE.can && STATE.can.docsRemove);
    const delLink = (latest && canRemove) ? `<a class="brf-del" data-brf="del" data-id="${latest.id}">Quitar</a>` : '';

    slot.innerHTML = `
      <div class="brf-card">
        <div class="brf-top">
          <div class="brf-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V10M9 21V10M15 21V10M19 21V10"/><path d="M4 10l8-5 8 5"/></svg></div>
          <div class="brf-body">
            <div class="brf-title">Referencia bancaria ${badge}</div>
            <div class="brf-sub">${sub}</div>
          </div>
          <span class="sp"></span>${delLink}${btn}
        </div>
        <div class="brf-help"><a class="brf-lnk" href="/guias/referencia-bancaria.html" target="_blank" rel="noopener">¿Cómo obtener la referencia en tu banco? ↗</a></div>
      </div>`;

    const up = slot.querySelector('[data-brf="upload"]');
    if (up) up.addEventListener('click', () => openUploadModal(w, STATE, () => refresh()));
    const vp = slot.querySelector('[data-brf="view"]');
    if (vp) vp.addEventListener('click', () => viewPdf(STATE, vp.dataset.path));
    const del = slot.querySelector('[data-brf="del"]');
    if (del) del.addEventListener('click', () => removeRef(STATE, del.dataset.id, () => refresh()));
    fire();
  };

  const refresh = async () => {
    try {
      const r = await refApi({ action: 'list', id_number: w.id_number, user: sessUser(STATE.user) });
      render(r && r.ok ? r.references : []);
    } catch (_) { render([]); }
  };

  render(null);           // pinta el marco de una (sin chip) para no parpadear
  refresh();
}

async function viewPdf(STATE, path) {
  if (!path) return;
  try {
    const r = await refApi({ action: 'sign', storage_path: path, user: sessUser(STATE.user) });
    if (r && r.ok && r.signed_url) window.open(r.signed_url, '_blank', 'noopener');
    else alert('No se pudo abrir el PDF. Intenta de nuevo.');
  } catch (_) { alert('No se pudo abrir el PDF. Intenta de nuevo.'); }
}
async function removeRef(STATE, id, done) {
  const n = parseInt(id, 10);
  if (!n) return;
  if (!confirm('¿Quitar esta referencia de la ficha? Puedes volver a cargar otra cuando quieras.')) return;
  try {
    const r = await refApi({ action: 'annul', id: n, user: sessUser(STATE.user) });
    if (r && r.ok) { if (done) done(); }
    else alert('No se pudo quitar: ' + ((r && r.error) || 'error'));
  } catch (e) { alert('No se pudo quitar. Intenta de nuevo.'); }
}

/* ===================== MODAL DE CARGA ===================== */
function openUploadModal(w, STATE, onSaved) {
  ensureStyles();
  const ov = document.createElement('div');
  ov.className = 'brf-ov';
  ov.innerHTML = `
    <div class="brf-modal">
      <div class="brf-mh">
        <div class="ic">${UP_SVG}</div>
        <div><b>Cargar referencia bancaria</b><small>${esc(w.full_name || '')} · ${fmtCed(w.id_number)}</small></div>
        <button class="x" data-brf="close">×</button>
      </div>
      <div class="brf-mb" id="brfBody">
        <div class="brf-drop" id="brfDrop">
          <b>Cargar referencia (PDF)</b>
          <p>Haz clic o arrastra el PDF emitido por el banco.<br>Detectamos el banco, la cuenta y la cédula automáticamente.</p>
          <input type="file" accept="application/pdf,.pdf" id="brfFile" style="display:none">
        </div>
        <div class="brf-titular">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
          <span><b>Solo cuentas del titular.</b> La referencia debe ser de la cuenta del propio trabajador — no se aceptan cuentas de terceros.</span>
        </div>
      </div>
      <div class="brf-mf" id="brfFoot" style="display:none">
        <span class="note" id="brfNote"></span>
        <button class="cancel" data-brf="close">Cancelar</button>
        <button class="go" id="brfSave" disabled>Guardar referencia</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelectorAll('[data-brf="close"]').forEach(b => b.addEventListener('click', close));

  const drop = ov.querySelector('#brfDrop');
  const fileInput = ov.querySelector('#brfFile');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = '#7c3aed'; });
  drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
  drop.addEventListener('drop', e => { e.preventDefault(); drop.style.borderColor = ''; if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

  const body = ov.querySelector('#brfBody');
  const foot = ov.querySelector('#brfFoot');

  async function handleFile(file) {
    if (!file || (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name))) {
      body.innerHTML = `<div class="brf-verdict err">Ese archivo no es un PDF. Sube el PDF original emitido por el banco.</div>`;
      return;
    }
    if (file.size > 10 * 1024 * 1024) { body.innerHTML = `<div class="brf-verdict err">El PDF supera 10 MB.</div>`; return; }
    body.innerHTML = `<div style="text-align:center;padding:26px;color:#64748b"><span class="brf-spin"></span> Leyendo el PDF…</div>`;

    let buf;
    try { buf = await file.arrayBuffer(); } catch { body.innerHTML = `<div class="brf-verdict err">No se pudo leer el archivo.</div>`; return; }
    const pdfB64 = await bytesToB64(new Uint8Array(buf));

    let text = '';
    try { text = await extractText(buf.slice(0)); }
    catch (e) {
      body.innerHTML = `<div class="brf-verdict err">No se pudo procesar el PDF (¿es un escaneo/foto sin texto?). Sube el <b>PDF original</b> emitido por el banco.<br><small>${esc(String(e && e.message || e))}</small></div>`;
      return;
    }
    if (collapse(text).length < 30) {
      body.innerHTML = `<div class="brf-verdict info">Este PDF no tiene texto seleccionable (parece foto o escaneo). Sube el <b>PDF original</b> emitido por el banco.</div>`;
      return;
    }

    const fields = parseFields(text, STATE.bankMap || {});
    renderConfirm(fields, pdfB64);
  }

  function renderConfirm(fields, pdfB64) {
    const isMerc = fields.plantilla === 'mercantil';
    const rowsHtml = () => {
      const ev = evaluate(fields, w, isMerc ? (ov.querySelector('#brfMerc') ? ov.querySelector('#brfMerc').value : '') : null, STATE.bankMap || {});
      const rows = [];
      const cedSem = ev.cedOk ? sem('ok', 'es la del trabajador') : (ev.nameOk ? sem('warn', 'revisar cédula') : sem('err', 'otra persona'));
      rows.push(row('Persona', esc(fields.nombre_pdf || '—'), ev.cedOk ? sem('ok', ev.nameOk ? 'coincide' : 'validado por cédula') : (ev.nameOk ? sem('warn', 'revisar') : sem('err', 'otra persona'))));
      rows.push(row('Cédula', `<span class="mono">${fields.cedula_pdf ? fmtCed(fields.cedula_pdf) : '—'}</span>`, cedSem));
      if (isMerc) {
        rows.push(row('Banco', '<span class="mono">0105</span> · Mercantil', sem('ok', 'coherente')));
        rows.push(row('Cuenta', `<span class="mono">••••••••••••${esc(fields.cuenta_last4 || '????')}</span>`, sem('info', 'completar abajo')));
      } else {
        const pref = fields.banco_code || '';
        rows.push(row('Banco', `<span class="mono">${esc(pref || '—')}</span>${fields.banco_nombre ? ' · ' + esc(fields.banco_nombre) : ''}`, ev.bankOk ? sem('ok', 'coherente') : sem('warn', 'revisar')));
        rows.push(row('Cuenta', `<span class="mono">${fields.cuenta ? fmtAcct(fields.cuenta) : '—'}</span>`, ev.acctOk ? sem('ok', '20 dígitos') : sem('warn', 'revisar')));
      }
      if (fields.fecha_emision) rows.push(row('Emitida', esc(fields.fecha_emision) + (fields.nro_operacion ? ` · <span class="mono">Op. ${esc(fields.nro_operacion)}</span>` : ''), sem('info', 'sin caducidad')));
      return rows.join('');
    };

    body.innerHTML = `
      <div style="font-size:12px;color:#64748b;margin-bottom:8px">Banco detectado: <b>${esc(fields.banco_nombre || (fields.plantilla === 'otro' ? 'no reconocido' : fields.plantilla.toUpperCase()))}</b></div>
      <div class="brf-rows" id="brfRows">${rowsHtml()}</div>
      ${isMerc ? `<div class="brf-merc"><label>Mercantil tapa el medio de la cuenta. Escribe solo los <b>12 dígitos</b> que faltan:</label><div class="brf-acct"><span class="brf-fijo" title="Prefijo de Mercantil">0105</span><input id="brfMerc" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="000000 000000" aria-label="12 dígitos del medio de la cuenta"><span class="brf-fijo" title="Final que dice la referencia">${esc(fields.cuenta_last4 || '????')}</span></div><div class="brf-acct-h" id="brfMercH"></div></div>` : ''}
      <div class="brf-verdict" id="brfVerdict"></div>`;
    foot.style.display = 'flex';

    const saveBtn = ov.querySelector('#brfSave');
    const note = ov.querySelector('#brfNote');
    const verdict = ov.querySelector('#brfVerdict');
    const mercInput = ov.querySelector('#brfMerc');

    /* v6.248 — El prefijo y el final NO se escriben: los sabemos. El prefijo
       porque Mercantil es 0105, y el final porque la referencia lo muestra.
       Quedan 12 digitos, y de paso es imposible equivocarse en las partes que
       ya estaban bien. Se arma la cuenta completa para evaluate(). */
    const cuentaMerc = () => {
      const medio = mercInput ? String(mercInput.value || '').replace(/\D/g, '').slice(0, 12) : '';
      return '0105' + medio + String(fields.cuenta_last4 || '');
    };

    function refreshVerdict() {
      ov.querySelector('#brfRows').innerHTML = rowsHtml();
      const ev = evaluate(fields, w, mercInput ? cuentaMerc() : null, STATE.bankMap || {});
      if (mercInput) {
        const n = String(mercInput.value || '').replace(/\D/g, '').length;
        const h = ov.querySelector('#brfMercH');
        if (h) h.textContent = n >= 12 ? '✓ 20 dígitos completos'
          : `faltan ${12 - n} ${12 - n === 1 ? 'dígito' : 'dígitos'} del medio`;
      }
      // completo? (cuenta legible con prefijo de banco conocido)
      if (!(ev.acctOk && ev.prefKnown)) {
        verdict.className = 'brf-verdict info';
        verdict.innerHTML = isMerc
          ? `Escribe los 12 dígitos del medio para guardar. El <b>0105</b> y el <b>${esc(fields.cuenta_last4 || '')}</b> ya están puestos.`
          : 'No se pudo leer bien la cuenta del PDF; revísalo.';
        saveBtn.disabled = true; note.textContent = ''; return { ev };
      }
      const err = ev.warnings.find(x => x.level === 'err');
      const warn = ev.warnings.find(x => x.level === 'warn');
      if (err) { verdict.className = 'brf-verdict err'; verdict.innerHTML = `<b>Advertencia fuerte:</b> ${esc(err.text)}`; }
      else if (warn) { verdict.className = 'brf-verdict warn'; verdict.innerHTML = `<b>Advertencia:</b> ${esc(warn.text)} <b>Persiste hasta corregir la cédula o cambiar el PDF.</b>`; }
      else { verdict.className = 'brf-verdict ok'; verdict.innerHTML = '<b>Todo validado.</b> Cuenta del titular, banco coherente y formato correcto.'; }
      saveBtn.disabled = false;
      saveBtn.textContent = (err || warn) ? 'Guardar con advertencia' : 'Guardar referencia';
      note.innerHTML = 'El número no se aplica ahora: se adopta al <b>Publicar</b> (Sincronizar).';
      return { ev };
    }

    if (mercInput) mercInput.addEventListener('input', function () {
      const d = String(this.value || '').replace(/\D/g, '').slice(0, 12);
      this.value = d.length > 6 ? d.slice(0, 6) + ' ' + d.slice(6) : d;
      refreshVerdict();
    });
    refreshVerdict();

    saveBtn.addEventListener('click', async () => {
      const { ev } = refreshVerdict();
      saveBtn.disabled = true; saveBtn.innerHTML = '<span class="brf-spin"></span> Guardando…';
      const payload = {
        action: 'save', user: sessUser(STATE.user), id_number: w.id_number,
        plantilla: fields.plantilla, banco_code: (isMerc ? '0105' : fields.banco_code),
        banco_nombre: fields.banco_nombre, cuenta: ev.cuenta || null, cuenta_last4: fields.cuenta_last4,
        tipo_cuenta: fields.tipo_cuenta, cedula_pdf: fields.cedula_pdf, nombre_pdf: fields.nombre_pdf,
        nro_operacion: fields.nro_operacion, fecha_emision: fields.fecha_emision,
        validaciones: ev.validaciones, pdf_base64: pdfB64,
      };
      try {
        const r = await refApi(payload);
        if (r && r.ok) {
          verdict.className = 'brf-verdict ok';
          verdict.innerHTML = '<b>Referencia guardada.</b> Queda <b>cargada</b> como respaldo. El número se adopta al Publicar (Sincronizar).';
          foot.style.display = 'none';
          if (onSaved) onSaved();
          setTimeout(close, 1400);
        } else {
          verdict.className = 'brf-verdict err';
          verdict.innerHTML = 'No se pudo guardar: ' + esc((r && r.error) || 'error');
          saveBtn.disabled = false; saveBtn.textContent = 'Reintentar';
        }
      } catch (e) {
        verdict.className = 'brf-verdict err';
        verdict.innerHTML = 'No se pudo guardar: ' + esc(String(e && e.message || e));
        saveBtn.disabled = false; saveBtn.textContent = 'Reintentar';
      }
    });
  }
}

function row(label, val, semHtml) {
  const cls = semHtml.indexOf('brf-sem err') >= 0 ? 'err' : semHtml.indexOf('brf-sem warn') >= 0 ? 'warn' : semHtml.indexOf('brf-sem ok') >= 0 ? 'ok' : '';
  return `<div class="brf-row ${cls}"><div class="l">${label}</div><div class="v">${val}</div><div>${semHtml}</div></div>`;
}
function sem(kind, txt) {
  const g = { ok: '✓', warn: '!', err: '✕', info: 'i' }[kind];
  return `<span class="brf-sem ${kind}">${g} ${esc(txt)}</span>`;
}

/* ---------- pdfjs: extraer texto plano ---------- */
/* v6.247 — Ademas del texto de la pagina se devuelven los CAMPOS DE
   FORMULARIO. El PDF de Mercantil es un AcroForm: el fondo es una plantilla
   con datos de muestra iguales en todos los documentos, y lo del trabajador
   vive en campos que getTextContent() no toca. Leyendo solo la pagina, las 5
   referencias de Mercantil daban la misma cuenta (7634, la del ejemplo) y el
   mismo titular (un banco). Se anexan como [F:nombre=valor] al final para no
   cambiarle la firma a esta funcion, que la usan cuatro lugares. */
export async function extractText(arrayBuffer) {
  const pdfjs = await ensurePdfjs();
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  let out = '';
  const n = Math.min(doc.numPages, 4);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out += ' ' + tc.items.map(it => it.str).join(' ');
  }
  try {
    const campos = await doc.getFieldObjects();
    if (campos) {
      for (const [nombre, arr] of Object.entries(campos)) {
        const v = (Array.isArray(arr) ? arr : [arr])
          .map(x => (x && x.value != null) ? String(x.value) : '')
          .find(x => x.trim());
        if (v) out += ` [F:${nombre}=${v.replace(/[\[\]]/g, ' ')}]`;
      }
    }
  } catch (_) { /* el PDF no tiene formulario: es el caso normal */ }
  try { doc.destroy(); } catch (_) { /* noop */ }
  return out;
}

/* ---------- bytes -> base64 (chunked, sin desbordar el stack) ---------- */
function bytesToB64(bytes) {
  return new Promise(resolve => {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    resolve(btoa(bin));
  });
}
