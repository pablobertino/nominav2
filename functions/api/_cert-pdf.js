/* =====================================================================
   functions/api/_cert-pdf.js  (modulo helper, NO es ruta)
   Generacion del PDF de la Constancia de Trabajo a partir del SNAPSHOT de
   una linea (cert_request_lines) ya completada por el admin.

   Usa pdf-lib (bundleada por Cloudflare Pages via package.json). Fuentes
   estandar (Times/Helvetica, WinAnsi) que cubren los acentos y signos del
   espanol (a e i o u con tilde, n, ¿, ¡), asi NO hace falta incrustar una
   fuente TTF externa (bundle liviano).

   Estructura del documento (segun plantillas AA PARAISO / CC MILLENNIUM /
   MANCHESTER analizadas y el diseno v0.3):
     HEADER  : razon social + RIF (centrado)
     TITULO  : "A QUIEN PUEDA INTERESAR" (o destinatario) + "CONSTANCIA DE
               TRABAJO"
     CUERPO  : formula legal (nombre, cedula V-/E-, fecha ingreso, cargo,
               salario en letras + numero, bono cestaticket en letras + numero)
     CIERRE  : "se expide ... en CIUDAD a los DIA del mes MES de ANIO"
     FIRMA   : imagen de firma (si hay) + nombre firmante + cargo firmante
     FOOTER  : direccion fiscal + telefono(s) + correo de la empresa

   Exporta:
     buildConstanciaPdf(env, line, opts) -> Uint8Array (bytes del PDF)
   donde `line` es el snapshot final (row de cert_request_lines fusionado con
   el patch) y opts trae { signatureBytes?, signatureMime? } opcionales.
   ===================================================================== */

/* pdf-lib se importa desde CDN (esm.sh) porque este proyecto de Cloudflare
   Pages NO tiene build command -> Pages NO ejecuta `npm install`, y esbuild
   no puede resolver el paquete npm 'pdf-lib' al bundlear /functions. Las URLs
   http(s) las marca esbuild como EXTERNAS (no rompen el bundle) y el runtime
   de Workers las carga en ejecucion. Solo usamos fuentes estandar (Times/
   WinAnsi), NO fontkit, asi que el import simple es suficiente. */
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1?target=es2022';

/* ---------- numero -> letras (formato VE) ---------- */
const UNIDADES = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE'];
const ESPECIALES = {
  10: 'DIEZ', 11: 'ONCE', 12: 'DOCE', 13: 'TRECE', 14: 'CATORCE', 15: 'QUINCE',
  16: 'DIECISEIS', 17: 'DIECISIETE', 18: 'DIECIOCHO', 19: 'DIECINUEVE',
  20: 'VEINTE', 21: 'VEINTIUNO', 22: 'VEINTIDOS', 23: 'VEINTITRES', 24: 'VEINTICUATRO',
  25: 'VEINTICINCO', 26: 'VEINTISEIS', 27: 'VEINTISIETE', 28: 'VEINTIOCHO', 29: 'VEINTINUEVE',
};
const DECENAS = ['', '', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

function seccion(n) {
  // 0..999 -> letras
  if (n === 0) return '';
  if (n === 100) return 'CIEN';
  let out = '';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  if (c > 0) out += CENTENAS[c];
  if (resto > 0) {
    if (out) out += ' ';
    if (resto < 10) out += UNIDADES[resto];               // 1..9  -> sin "Y"
    else if (ESPECIALES[resto]) out += ESPECIALES[resto]; // 10..29
    else {                                                // 30..99
      const d = Math.floor(resto / 10), u = resto % 10;
      out += DECENAS[d];
      if (u > 0) out += ' Y ' + UNIDADES[u];
    }
  }
  return out;
}

function enteroALetras(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'CERO';
  let out = '';
  const millones = Math.floor(n / 1000000);
  const miles = Math.floor((n % 1000000) / 1000);
  const cientos = n % 1000;
  if (millones > 0) {
    out += (millones === 1) ? 'UN MILLON' : (seccion(millones) + ' MILLONES');
  }
  if (miles > 0) {
    if (out) out += ' ';
    out += (miles === 1) ? 'MIL' : (seccion(miles) + ' MIL');
  }
  if (cientos > 0) {
    if (out) out += ' ';
    out += seccion(cientos);
  }
  return out.trim();
}

/* Monto en Bs -> "TRESCIENTOS BOLIVARES CON 00/100" (formato VE mayusculas). */
export function montoBsALetras(amount) {
  const num = parseFloat(String(amount == null ? 0 : amount).replace(',', '.')) || 0;
  const entero = Math.floor(num);
  const cent = Math.round((num - entero) * 100);
  const letras = enteroALetras(entero);
  const bolivares = entero === 1 ? 'BOLIVAR' : 'BOLIVARES';
  const cc = String(cent).padStart(2, '0');
  return `${letras} ${bolivares} CON ${cc}/100`;
}

/* Numero con separador de miles VE: 1234567.5 -> "1.234.567,50" */
export function fmtBsNum(amount) {
  const num = parseFloat(String(amount == null ? 0 : amount).replace(',', '.')) || 0;
  const [ent, dec] = num.toFixed(2).split('.');
  const entMiles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${entMiles},${dec}`;
}

/* Cedula: solo numero -> "V-31.426.541" (letra V/E; >80M = E salvo override). */
export function fmtCedula(idNumber, letterOverride) {
  const raw = String(idNumber == null ? '' : idNumber).replace(/[^\d]/g, '');
  if (!raw) return '';
  const n = parseInt(raw, 10);
  let letter = letterOverride && /^[VE]$/i.test(letterOverride) ? letterOverride.toUpperCase()
    : (n > 80000000 ? 'E' : 'V');
  const conPuntos = raw.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${letter}-${conPuntos}`;
}

/* Fecha 'YYYY-MM-DD' -> {dia, mes(nombre), anio} para la formula de cierre. */
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function fechaLarga(iso) {
  if (!iso) { const d = new Date(); return { dia: d.getUTCDate(), mes: MESES[d.getUTCMonth()], anio: d.getUTCFullYear() }; }
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return { dia: d, mes: MESES[(m || 1) - 1], anio: y };
}
/* Fecha 'YYYY-MM-DD' -> 'DD/MM/AAAA' */
function fmtFechaVE(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/* Hoy en Caracas como YYYY-MM-DD (para la fecha de expedicion). */
function hoyCaracasYMD() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Caracas' }).format(new Date());
}

/* Sanitiza a WinAnsi: reemplaza caracteres fuera del rango por equivalentes
   (evita que pdf-lib lance por un caracter no soportado por la fuente base). */
function toWinAnsi(s) {
  return String(s == null ? '' : s)
    .replace(/\u2013|\u2014/g, '-')   // guiones largos
    .replace(/\u2018|\u2019/g, "'")   // comillas simples tipograficas
    .replace(/\u201C|\u201D/g, '"')   // comillas dobles tipograficas
    .replace(/\u2026/g, '...')        // elipsis
    .replace(/\u00A0/g, ' ');         // nbsp
}

/* ---------- helper de layout: texto justificado por palabras ---------- */
function wrapLines(text, font, size, maxWidth) {
  const words = toWinAnsi(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && cur) {
      lines.push(cur); cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/* =====================================================================
   buildConstanciaPdf(env, line, opts) -> Uint8Array
   ===================================================================== */
export async function buildConstanciaPdf(env, line, opts = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle('Constancia de Trabajo');
  doc.setProducer('NominaV2 - Grupo Canaima');
  doc.setCreator('NominaV2');

  const page = doc.addPage([595.28, 841.89]); // A4 vertical (pt)
  const { width, height } = page.getSize();
  const MARGIN = 60;
  const contentW = width - MARGIN * 2;

  const fReg = await doc.embedFont(StandardFonts.TimesRoman);
  const fBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const ink = rgb(0.09, 0.11, 0.15);
  const soft = rgb(0.35, 0.38, 0.43);

  let y = height - MARGIN;

  const drawCentered = (text, font, size, color = ink, gapAfter = 0) => {
    const t = toWinAnsi(text);
    const w = font.widthOfTextAtSize(t, size);
    page.drawText(t, { x: (width - w) / 2, y: y - size, size, font, color });
    y -= size + gapAfter;
  };
  const drawParagraph = (text, font, size, color = ink, lineGap = 5, gapAfter = 10) => {
    const lines = wrapLines(text, font, size, contentW);
    for (const ln of lines) {
      page.drawText(ln, { x: MARGIN, y: y - size, size, font, color });
      y -= size + lineGap;
    }
    y -= gapAfter;
  };

  /* ---------- HEADER: razon social + RIF ---------- */
  const razon = line.company_name_snap || '';
  const rif = line.company_rif_snap || '';
  if (razon) drawCentered(razon, fBold, 14, ink, 2);
  if (rif) drawCentered(`RIF: ${rif}`, fReg, 11, soft, 6);
  y -= 10;

  /* ---------- destinatario + titulo ---------- */
  const dest = (line.recipient || 'A quien pueda interesar').toUpperCase();
  drawCentered(dest, fBold, 12, ink, 14);
  drawCentered('CONSTANCIA DE TRABAJO', fBold, 13, ink, 20);

  /* ---------- CUERPO: formula legal ---------- */
  const nombre = (line.worker_full_name || '').toUpperCase();
  const ced = fmtCedula(line.worker_id_number, line.ced_letter);
  const cargo = line.worker_role || '';
  const ingreso = fmtFechaVE(line.start_date);

  const salLetras = montoBsALetras(line.salary_amount);
  const salNum = fmtBsNum(line.salary_amount);

  const tieneBono = line.bonus_amount != null && String(line.bonus_amount) !== '' && parseFloat(line.bonus_amount) > 0;
  const bonoLetras = tieneBono ? montoBsALetras(line.bonus_amount) : '';
  const bonoNum = tieneBono ? fmtBsNum(line.bonus_amount) : '';

  let cuerpo = `Por medio de la presente se hace constar que el(la) ciudadano(a) ${nombre}, `
    + `venezolano(a), mayor de edad, titular de la cedula de identidad No. ${ced}, `
    + `presta sus servicios en esta empresa desde el ${ingreso}, `
    + `desempenando el cargo de ${cargo}, `
    + `devengando un salario mensual de ${salLetras} (Bs. ${salNum})`;
  if (tieneBono) {
    cuerpo += `, y un beneficio de alimentacion (Cestaticket) de ${bonoLetras} (Bs. ${bonoNum})`;
  }
  cuerpo += '.';

  y -= 6;
  drawParagraph(cuerpo, fReg, 11.5, ink, 6, 16);

  /* ---------- cierre: se expide en CIUDAD a los DIA de MES de ANIO ---------- */
  const ciudad = line.city || 'Caracas';
  const f = fechaLarga(hoyCaracasYMD());
  const cierre = `Constancia que se expide a peticion de la parte interesada, en ${ciudad}, `
    + `a los ${f.dia} dias del mes de ${f.mes} de ${f.anio}.`;
  drawParagraph(cierre, fReg, 11.5, ink, 6, 30);

  /* ---------- FIRMA ---------- */
  drawCentered('Atentamente,', fReg, 11.5, ink, 10);

  // Imagen de firma (opcional). Se centra; si no hay, deja una linea.
  const sigBytes = opts.signatureBytes;
  if (sigBytes && sigBytes.length) {
    try {
      let img;
      const mime = String(opts.signatureMime || '').toLowerCase();
      if (mime.includes('jpg') || mime.includes('jpeg')) img = await doc.embedJpg(sigBytes);
      else img = await doc.embedPng(sigBytes);
      const maxW = 160, maxH = 70;
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = img.width * scale, h = img.height * scale;
      page.drawImage(img, { x: (width - w) / 2, y: y - h, width: w, height: h });
      y -= h + 4;
    } catch { /* firma corrupta -> se ignora, va la linea */ }
  } else {
    y -= 44; // espacio para firma manuscrita
  }

  // Linea de firma
  const lineW = 220;
  page.drawLine({
    start: { x: (width - lineW) / 2, y },
    end: { x: (width + lineW) / 2, y },
    thickness: 0.8, color: soft,
  });
  y -= 16;

  const firmante = (line.signer_name_snap || '').toUpperCase();
  const firmanteCargo = (line.signer_title_snap || 'ANALISTA DE CAPITAL HUMANO').toUpperCase();
  if (firmante) drawCentered(firmante, fBold, 11.5, ink, 2);
  drawCentered(firmanteCargo, fReg, 10.5, soft, 0);

  /* ---------- FOOTER: direccion fiscal + telefono + correo ---------- */
  const addr = line.company_addr_snap || '';
  const tel = line.company_phone_snap || '';
  const mail = line.company_email_snap || '';
  const footParts = [];
  if (addr) footParts.push(addr);
  const contact = [tel, mail].filter(Boolean).join('  ·  ');
  if (contact) footParts.push(contact);

  if (footParts.length) {
    let fy = MARGIN + 6;
    page.drawLine({ start: { x: MARGIN, y: fy + 24 }, end: { x: width - MARGIN, y: fy + 24 }, thickness: 0.6, color: rgb(0.8, 0.83, 0.88) });
    // El footer se dibuja de abajo hacia arriba para no solaparse con la firma.
    const footLines = [];
    footParts.forEach(p => { wrapLines(p, fReg, 8.5, contentW).forEach(l => footLines.push(l)); });
    // Dibujar centrado, apilado hacia arriba desde fy.
    let yy = fy + (footLines.length - 1) * 11;
    for (const ln of footLines) {
      const w = fReg.widthOfTextAtSize(ln, 8.5);
      page.drawText(ln, { x: (width - w) / 2, y: yy, size: 8.5, font: fReg, color: soft });
      yy -= 11;
    }
  }

  return await doc.save();
}
