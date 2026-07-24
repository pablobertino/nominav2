/* =====================================================================
   functions/api/_ax-template.js
   Generador de la PLANTILLA DE AX (Excel .xlsx) y del CUERPO DE TEXTO
   del ticket, por tipo de reporte. Replica exactamente el formato que
   Capital Humano importa en AX 2012 (mismas columnas, orden y tipos que
   producia el portal anterior).

   CLAVE — tipos de celda (para que AX no deforme los datos):
     - TEXTO  (data_area "0089", cedula, cuenta bancaria, codigo AX,
               TodoTicket, Accion, genero, estado civil): se escribe como
               cadena inline (t="inlineStr"). "0089" se conserva, NO se
               vuelve 89.
     - FECHA  (fechas): numero serial de Excel + formato dd/mm/yyyy. Se ve
               y se filtra como fecha real.
     - HORA   (marcaje entrada/salida): fraccion de dia + formato h:mm.

   El .xlsx se arma A MANO (ZIP STORE + XML SpreadsheetML) sin librerias
   ni build step: el proyecto es estatico y los Workers de Cloudflare no
   tienen bundler. Pesa ~3-5 KB y lo abren Excel, AX y SheetJS.

   Exporta:
     buildReportText(kind, ctx)  -> string (cuerpo del ticket PLA)
     buildAxWorkbookBase64(kind, ctx) -> { base64, filename } | null
   donde kind ∈ 'marcaje'|'ausencia'|'ingreso'|'egreso'|'modificacion'.
   ===================================================================== */

/* ---------------------------------------------------------------------
   ZIP (STORE, sin compresion) — suficiente para XML pequeño.
   Implementacion minima en JS puro (corre en Cloudflare Workers).
   --------------------------------------------------------------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function strBytes(s) { return new TextEncoder().encode(s); }
function u16(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
function u32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }

// files: [{ name, data:Uint8Array }] -> Uint8Array del ZIP
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = strBytes(f.name);
    const data = f.data;
    const crc = crc32(data);
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0),
    ];
    chunks.push(new Uint8Array(local), name, data);
    const cen = [
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ];
    central.push(new Uint8Array(cen), name);
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  let centralLen = 0;
  for (const c of central) centralLen += c.length;
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(centralLen), ...u32(centralStart), ...u16(0),
  ]);
  // concatenar todo
  let total = 0;
  for (const c of chunks) total += c.length;
  for (const c of central) total += c.length;
  total += end.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(end, p);
  return out;
}

function bytesToBase64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  // btoa existe en Workers
  return btoa(bin);
}

/* ---------------------------------------------------------------------
   XLSX a mano. Tipos de celda soportados: 'text' | 'date' | 'time'.
   - text -> <c t="inlineStr"><is><t>VALOR</t></is></c>  (literal)
   - date -> <c s="1"><v>SERIAL</v></c>                  (formato dd/mm/yyyy)
   - time -> <c s="2"><v>FRACCION</v></c>                (formato h:mm AM/PM)
   --------------------------------------------------------------------- */
function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
// 'YYYY-MM-DD' -> serial Excel (epoch 1899-12-30, en UTC para no correr el dia)
function dateSerial(ymd) {
  if (!ymd) return null;
  const m = String(ymd).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const dUTC = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Math.floor((dUTC - Date.UTC(1899, 11, 30)) / 86400000);
}
// 'HH:MM' o 'HH:MM:SS' -> fraccion de dia
function timeFraction(hhmm) {
  if (!hhmm) return null;
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2], s = m[3] ? +m[3] : 0;
  return (h * 3600 + mi * 60 + s) / 86400;
}
// Letra de columna (0->A, 26->AA)
function colLetter(i) {
  let s = '';
  i = i + 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/* Construye una hoja. cols:[{hdr,key,type}], rows:[{key:val}].
   Devuelve el XML del worksheet. */
function sheetXml(cols, rows) {
  const cell = (ref, col, val) => {
    if (col.type === 'date') {
      const s = dateSerial(val);
      if (s === null) {
        // sin fecha valida -> texto (o vacio), tambien con formato Texto
        return `<c r="${ref}" s="3" t="inlineStr"><is><t>${xmlEsc(val || '')}</t></is></c>`;
      }
      return `<c r="${ref}" s="1"><v>${s}</v></c>`;
    }
    if (col.type === 'time') {
      const f = timeFraction(val);
      if (f === null) return `<c r="${ref}" s="3" t="inlineStr"><is><t>${xmlEsc(val || '')}</t></is></c>`;
      return `<c r="${ref}" s="2"><v>${f}</v></c>`;
    }
    // texto literal con formato Texto (@): preserva ceros a la izquierda y
    // Excel muestra "Texto", no "General".
    return `<c r="${ref}" s="3" t="inlineStr"><is><t>${xmlEsc(val == null ? '' : val)}</t></is></c>`;
  };

  let xml = '';
  // fila 1: encabezados (texto)
  xml += `<row r="1">`;
  cols.forEach((c, i) => {
    xml += `<c r="${colLetter(i)}1" s="3" t="inlineStr"><is><t>${xmlEsc(c.hdr)}</t></is></c>`;
  });
  xml += `</row>`;
  // filas de datos
  rows.forEach((row, ri) => {
    const r = ri + 2;
    xml += `<row r="${r}">`;
    cols.forEach((c, ci) => { xml += cell(`${colLetter(ci)}${r}`, c, row[c.key]); });
    xml += `</row>`;
  });

  const lastCol = colLetter(cols.length - 1);
  const dim = `A1:${lastCol}${rows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dim}"/><sheetData>${xml}</sheetData></worksheet>`;
}

// Hoja de texto plano (aoa) — para la hoja "Ayuda" de ausencia.
function aoaSheetXml(aoa) {
  let xml = '';
  aoa.forEach((row, ri) => {
    const r = ri + 1;
    xml += `<row r="${r}">`;
    row.forEach((val, ci) => {
      xml += `<c r="${colLetter(ci)}${r}" s="3" t="inlineStr"><is><t>${xmlEsc(val)}</t></is></c>`;
    });
    xml += `</row>`;
  });
  const dim = `A1:${colLetter((aoa[0] || ['']).length - 1)}${aoa.length}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dim}"/><sheetData>${xml}</sheetData></worksheet>`;
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="3">` +
    `<numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>` +
    `<numFmt numFmtId="165" formatCode="h:mm\\ AM/PM"/>` +
    `<numFmt numFmtId="166" formatCode="@"/>` +
  `</numFmts>` +
  `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
  `<borders count="1"><border/></borders>` +
  `<cellStyleXfs count="1"><xf/></cellStyleXfs>` +
  `<cellXfs count="4">` +
    `<xf/>` +
    `<xf numFmtId="164" applyNumberFormat="1"/>` +   // s="1" fecha
    `<xf numFmtId="165" applyNumberFormat="1"/>` +   // s="2" hora
    `<xf numFmtId="166" applyNumberFormat="1"/>` +   // s="3" texto (@)
  `</cellXfs>` +
  `</styleSheet>`;

/* Empaqueta una o varias hojas en un .xlsx (base64).
   sheets: [{ name, xml }] (en orden). */
function packXlsx(sheets) {
  const sheetOverrides = sheets.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    sheetOverrides + `</Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;
  const sheetTags = sheets.map((s, i) =>
    `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheetTags}</sheets></workbook>`;
  // rels del workbook: cada hoja + styles (rId despues de las hojas)
  const stylesRid = `rId${sheets.length + 1}`;
  const wbRelTags = sheets.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="${stylesRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  const wbRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    wbRelTags + `</Relationships>`;

  const files = [
    { name: '[Content_Types].xml', data: strBytes(contentTypes) },
    { name: '_rels/.rels', data: strBytes(rels) },
    { name: 'xl/workbook.xml', data: strBytes(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: strBytes(wbRels) },
    { name: 'xl/styles.xml', data: strBytes(STYLES_XML) },
  ];
  sheets.forEach((s, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: strBytes(s.xml) });
  });
  return bytesToBase64(zipStore(files));
}

/* =====================================================================
   BUILDERS POR TIPO — columnas EXACTAS de las plantillas reales de AX.
   ctx trae: companyDataArea, companyName, companyAlias, lines[], y mapas
   auxiliares (causaLabels para marcaje). Cada builder devuelve {base64,filename}.
   ===================================================================== */

// MARCAJE: Empresa(data_area) | Trabajador(ced) | Fecha | Hora Entrada |
//          Hora Salida | Tipo de día | Causa
function axMarcaje(ctx) {
  const cols = [
    { hdr: 'Empresa', key: 'empresa', type: 'text' },
    { hdr: 'Trabajador', key: 'trabajador', type: 'text' },
    { hdr: 'Fecha', key: 'fecha', type: 'date' },
    { hdr: 'Hora Entrada', key: 'entrada', type: 'time' },
    { hdr: 'Hora Salida', key: 'salida', type: 'time' },
    { hdr: 'Tipo de día', key: 'tipo', type: 'text' },
    { hdr: 'Causa', key: 'causa', type: 'text' },
  ];
  const rows = ctx.lines.map(l => ({
    empresa: ctx.companyDataArea || '',
    trabajador: String(l.id_number || '').replace(/[^0-9]/g, ''),
    fecha: l.date,                         // 'YYYY-MM-DD'
    entrada: l.tipo === 'D' ? '' : (l.time_in || ''),
    salida: l.tipo === 'D' ? '' : (l.time_out || ''),
    tipo: l.tipo || 'L',
    causa: l.causa_label || '',
  }));
  return { base64: packXlsx([{ name: 'Hoja1', xml: sheetXml(cols, rows) }]),
           filename: 'MARCAJE_MANUAL' };
}

// AUSENCIA: hoja "Datos" (Trabajador|Desde|Hasta|Justificación=codigo AX)
//           + hoja "Ayuda" (18 codigos).
function axAusencia(ctx) {
  const cols = [
    { hdr: 'Trabajador', key: 'trabajador', type: 'text' },
    { hdr: 'Desde fecha', key: 'desde', type: 'date' },
    { hdr: 'Hasta fecha', key: 'hasta', type: 'date' },
    { hdr: 'Justificación', key: 'justif', type: 'text' },
  ];
  const rows = ctx.lines.map(l => ({
    trabajador: String(l.id_number || '').replace(/[^0-9]/g, ''),
    desde: l.date_from,
    hasta: l.date_to,
    justif: l.ax_code || '',
  }));
  const ayuda = [
    ['AUT', 'Autorizado'], ['BAT', 'Bono autorizado'], ['CAP', 'Capacitación'],
    ['DES', 'Día de descanso'], ['DUE', 'Duelo'], ['EME', 'Emergencia'],
    ['FER', 'Feriado / Día festivo'], ['FUE', 'Fuerza mayor'], ['LAC', 'Lactancia'],
    ['MAT', 'Matrimonio'], ['MUD', 'Mudanza'], ['PAT', 'Paternidad'],
    ['POS', 'Postnatal'], ['PRE', 'Prenatal'], ['REP', 'Reposo médico'],
    ['SUS', 'Suspendido'], ['VAC', 'Vacaciones'], ['VIA', 'Viaje de negocios'],
  ];
  return {
    base64: packXlsx([
      { name: 'Datos', xml: sheetXml(cols, rows) },
      { name: 'Ayuda', xml: aoaSheetXml(ayuda) },
    ]),
    filename: 'PERIODO_DE_AUSENCIA',
  };
}

// INGRESO/EGRESO/MODIFICACION: 18 columnas. accion A/B/M.
// La plantilla de AX espera SIEMPRE las 18 columnas (formato fijo), por eso
// no se elimina ninguna: en egreso (Baja) la columna TodoTicket va VACIA en
// vez de 'N' (no aplica dar de alta nada). El control es el flag
// fillTodoTicket: true (ingreso) -> 'N' por defecto; false (egreso) -> vacio.
function axIngEgr(ctx, accion, filename, fillTodoTicket = true) {
  const cols = [
    { hdr: 'Nombre', key: 'nombre', type: 'text' },
    { hdr: 'Segundo Nombre', key: 'nombre2', type: 'text' },
    { hdr: 'Apellidos', key: 'apellidos', type: 'text' },
    { hdr: 'Numero de Personal', key: 'cedula', type: 'text' },
    { hdr: 'Correo Electrónico', key: 'correo', type: 'text' },
    { hdr: 'Data ID ', key: 'dataId', type: 'text' },   // espacio final = original
    { hdr: 'Fecha inicial de Empleo', key: 'fechaIni', type: 'date' },
    { hdr: 'Fecha Final de Empleo', key: 'fechaFin', type: 'date' },
    { hdr: 'Cargo', key: 'cargo', type: 'text' },
    { hdr: 'Direccion', key: 'direccion', type: 'text' },
    { hdr: 'Fecha de Nacimiento', key: 'fechaNac', type: 'date' },
    { hdr: 'Estado Civil', key: 'estCivil', type: 'text' },
    { hdr: 'Telefono', key: 'telefono', type: 'text' },
    { hdr: 'Genero', key: 'genero', type: 'text' },
    { hdr: 'Nro de Cuenta Bancaria', key: 'cuenta', type: 'text' },
    { hdr: 'TodoTicket', key: 'todoTicket', type: 'text' },
    { hdr: 'Accion', key: 'accion', type: 'text' },
    { hdr: 'Clave', key: 'clave', type: 'text' },
  ];
  // accion: si viene fijo (A/B/M) se usa para TODAS las filas; si es null, cada
  // fila lleva su propia l.accion (caso Traslado: B en origen + A en destino).
  // dataId (Data ID = data_area) puede venir por fila (traslado: origen vs destino).
  const rows = ctx.lines.map(l => {
    const acc = accion || l.accion || 'M';
    const tt = accion
      ? (fillTodoTicket ? (l.todoTicket || 'N') : (l.todoTicket || ''))
      : (acc === 'A' ? (l.todoTicket || 'N') : (l.todoTicket || ''));
    return {
      nombre: (l.nombre || '').toUpperCase().trim(),
      nombre2: (l.nombre2 || '').toUpperCase().trim(),
      apellidos: (l.apellidos || '').toUpperCase().trim(),
      cedula: String(l.id_number || '').replace(/[^0-9]/g, ''),
      correo: l.correo || '',
      dataId: (l.dataId != null && l.dataId !== '') ? l.dataId : (ctx.companyDataArea || ''),
      fechaIni: l.fechaIni || '',
      fechaFin: l.fechaFin || '',
      cargo: (l.cargo || '').toUpperCase().trim(),
      direccion: l.direccion || '',
      fechaNac: l.fechaNac || '',
      estCivil: l.estCivil || '',
      telefono: l.telefono || '',
      genero: l.genero || '',
      cuenta: String(l.cuenta || '').replace(/[^0-9]/g, ''),
      todoTicket: tt,
      accion: acc,
      clave: '',
    };
  });
  return { base64: packXlsx([{ name: 'Hoja1', xml: sheetXml(cols, rows) }]), filename };
}

/* Devuelve { base64, filename } para el tipo dado, o null si no aplica.
   El filename empieza por FECHA y NUMERO de reporte para que el orden
   alfabetico del sistema de archivos coincida con el cronologico:
     {YYYYMMDD}_{NNNN}_{alias}_{TIPO}.xlsx
   (ej 20260622_0012_AA01_PERIODO_DE_AUSENCIA.xlsx). r.filename es el TIPO. */
export function buildAxWorkbookBase64(kind, ctx) {
  let r = null;
  if (kind === 'marcaje') r = axMarcaje(ctx);
  else if (kind === 'ausencia') r = axAusencia(ctx);
  else if (kind === 'ingreso') r = axIngEgr(ctx, 'A', 'INGRESOS_ALTA', true);
  else if (kind === 'egreso') r = axIngEgr(ctx, 'B', 'EGRESOS_BAJA', false);   // egreso: TodoTicket vacio
  else if (kind === 'modificacion') r = axIngEgr(ctx, 'M', 'MODIFICACIONES', true);
  else if (kind === 'traslado') r = axIngEgr(ctx, null, 'TRASLADO');   // accion por fila: B (origen) + A (destino)
  if (!r) return null;
  const alias = ctx.companyAlias || 'tienda';
  const today = (ctx.todayYmd || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const code = ctx.reportCode ? `${ctx.reportCode}_` : '';
  return { base64: r.base64, filename: `${today}_${code}${alias}_${r.filename}.xlsx` };
}

/* =====================================================================
   CUERPO DE TEXTO del ticket. Mismo formato para PLA y DOC: marco de
   doble linea + identificacion de PLANTILLA/DOCUMENTO con reporte y
   pieza + TÓPICO + DATOS DE LA TIENDA + REPORTANTE + registros.
   ctx: pieceLabel ('PLANTILLA'|'DOCUMENTO'), reportCode, piece, totalPieces,
        topicLabel, alias, razon, zona, marca, correoTienda, responsable,
        cargo, telefono, correoResp, fecha, hora, registros[] (cada uno es
        un array de pares [label, value]).
   ===================================================================== */
const LINE = '══════════════════════════════════════';
const SUB = '──────────────';

export function buildReportText(ctx) {
  let txt = `${LINE}\n`;
  txt += `REPORTE DE INCIDENCIA DE NÓMINA\n`;
  txt += `Fecha: ${ctx.fecha}  Hora: ${ctx.hora}\n`;
  txt += `${LINE}\n\n`;
  // Identificacion de la pieza (PLANTILLA o DOCUMENTO) + reporte + pieza,
  // justo encima del TÓPICO para que PLA y DOC se distingan de un vistazo.
  if (ctx.pieceLabel) {
    txt += `${ctx.pieceLabel}\n`;
    const pieza = (ctx.piece && ctx.totalPieces) ? `   ·   Pieza ${ctx.piece}/${ctx.totalPieces}` : '';
    txt += `Reporte: ${ctx.reportCode || ''}${pieza}\n`;
  }
  txt += `TÓPICO: ${(ctx.topicLabel || '').toUpperCase()}\n\n`;
  txt += `── DATOS DE LA TIENDA ${SUB}\n`;
  txt += `Alias:           ${ctx.alias || ''}\n`;
  txt += `Razón Social:    ${ctx.razon || ''}\n`;
  txt += `Mall / Zona:     ${ctx.zona || ''}\n`;
  txt += `Marca:           ${ctx.marca || ''}\n`;
  txt += `Correo tienda:   ${ctx.correoTienda || '(no registrado)'}\n\n`;
  txt += `── REPORTANTE ${SUB}──────\n`;
  txt += `Responsable:     ${ctx.responsable || ''}\n`;
  txt += `Cargo:           ${ctx.cargo || ''}\n`;
  txt += `Teléfono:        ${ctx.telefono || '—'}\n`;
  txt += `Correo:          ${ctx.correoResp || ''}\n`;
  (ctx.registros || []).forEach((reg, i) => {
    txt += `\nRegistro #${i + 1}:\n`;
    reg.forEach(([label, value]) => {
      txt += `  ${label}:  ${value == null || value === '' ? '—' : value}\n`;
    });
  });
  txt += `${LINE}\n`;
  txt += `Portal de Reportes · Capital Humano\n`;
  return txt;
}
