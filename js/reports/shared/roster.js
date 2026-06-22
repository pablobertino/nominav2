/* =====================================================================
   js/reports/shared/roster.js
   Lista de personal de la tienda (snapshot del Reporte 10 del POS).
   - Lee el .xlsx en el navegador con SheetJS (CDN) y manda las filas
     ya extraidas al Worker /api/roster (action 'replace').
   - Provee helpers para obtener el snapshot (get) y para parsear/validar
     el Reporte 10 antes de subirlo.

   El estado del roster (lista + meta) lo mantiene quien lo use; este
   modulo solo ofrece funciones puras + acceso a la API.
   ===================================================================== */

import { fmtDate } from './date-window.js';

const XLSX_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
let _xlsxPromise = null;

/* Carga SheetJS una sola vez (lazy). */
export function ensureXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_xlsxPromise) return _xlsxPromise;
  _xlsxPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = XLSX_CDN;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('No se pudo cargar el lector de Excel.'));
    document.head.appendChild(s);
  });
  return _xlsxPromise;
}

/* Normaliza un encabezado: minusculas, sin acentos, sin espacios extra. */
function normHeader(h) {
  return String(h || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Mapeo tolerante de encabezados del Reporte 10 a nuestras claves. */
const HEADER_MAP = {
  'cedula': 'id_number',
  'nombre': 'full_name',
  'cargo': 'role',
  'captahuellas': 'biometric_raw',
  'fecha inicio empleo': 'start_raw',
  'fecha fin empleo': 'end_raw',
};

/* Convierte un valor de fecha de Excel a 'YYYY-MM-DD' (o null). */
function excelDateToISO(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // numero serial de Excel
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^vigente$/i.test(s)) return null;
  // dd/mm/yyyy o dd-mm-yyyy
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // yyyy-mm-dd
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/**
 * Parsea un File del Reporte 10. Devuelve { rows, fileName, columnsFound,
 * missing } donde rows son objetos {id_number, full_name, role,
 * has_biometric, start_date, end_date}. NO sube nada todavia.
 */
export async function parseReport10(file) {
  const XLSX = await ensureXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  // hoja "Datos" si existe, si no la primera
  const sheetName = wb.SheetNames.includes('Datos') ? 'Datos' : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  if (!matrix.length) return { rows: [], fileName: file.name, columnsFound: [], missing: ['Cédula', 'Nombre'] };

  // Encabezados -> indice de columna
  const headers = matrix[0].map(normHeader);
  const colIdx = {};
  headers.forEach((h, i) => { if (HEADER_MAP[h] != null) colIdx[HEADER_MAP[h]] = i; });

  const columnsFound = [];
  if (colIdx.id_number != null) columnsFound.push('Cédula');
  if (colIdx.full_name != null) columnsFound.push('Nombre');
  if (colIdx.role != null) columnsFound.push('Cargo');

  const missing = [];
  if (colIdx.id_number == null) missing.push('Cédula');
  if (colIdx.full_name == null) missing.push('Nombre');

  const rows = [];
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row || row.every(c => c === '' || c == null)) continue;
    const id_number = colIdx.id_number != null ? String(row[colIdx.id_number] ?? '').replace(/[^0-9]/g, '') : '';
    const full_name = colIdx.full_name != null ? String(row[colIdx.full_name] ?? '').trim() : '';
    const role = colIdx.role != null ? String(row[colIdx.role] ?? '').trim() : '';
    const bioRaw = colIdx.biometric_raw != null ? String(row[colIdx.biometric_raw] ?? '').trim() : '';
    const start_date = colIdx.start_raw != null ? excelDateToISO(row[colIdx.start_raw]) : null;
    const end_date = colIdx.end_raw != null ? excelDateToISO(row[colIdx.end_raw]) : null;
    rows.push({
      id_number, full_name, role,
      has_biometric: bioRaw ? /activ/i.test(bioRaw) : true,
      start_date, end_date,
    });
  }
  return { rows, fileName: file.name, columnsFound, missing };
}

/* Resumen de validacion local (antes de subir), para mostrar en pantalla. */
export function validateParsed(parsed) {
  const seen = new Set();
  const valid = [];
  let noCargo = 0;
  for (const r of parsed.rows) {
    if (!r.id_number || r.id_number.length < 6 || r.id_number.length > 8) continue;
    if (!r.full_name) continue;
    if (seen.has(r.id_number)) continue;
    seen.add(r.id_number);
    if (!r.role) noCargo++;
    valid.push(r);
  }
  const active = valid.filter(r => !r.end_date);
  const terminated = valid.filter(r => r.end_date);
  // ESTIMACION visual de responsables (solo para la previsualizacion del
  // modal). El conteo DEFINITIVO lo hace el Worker con las reglas
  // configurables de manager_role_rules; aqui se usa la heuristica clasica
  // (GERENTE / SUB) porque el front no tiene las reglas a mano. Si en BD se
  // agregan patrones nuevos (ej. ENCARGADO), el numero real puede ser mayor;
  // por eso el modal lo presenta como estimado y el Worker confirma al subir.
  const managers = active.filter(r => /GERENTE/i.test(r.role || ''));
  const gerentes = managers.filter(r => !/SUB/i.test(r.role)).length;
  const subgerentes = managers.filter(r => /SUB/i.test(r.role)).length;
  const warnings = [];
  if (noCargo) warnings.push(`Columna "Cargo" vacía en ${noCargo} fila(s) (se cargan igual).`);
  return {
    okToUpload: valid.length > 0 && parsed.missing.length === 0,
    total: valid.length, active: active.length, terminated: terminated.length,
    gerentes, subgerentes, warnings, validRows: valid,
  };
}

/* --- API --- */

export async function rosterGet(companyCode) {
  const res = await fetch('/api/roster', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get', company_code: companyCode }),
  });
  return res.json();
}

export async function rosterReplace(companyCode, rows, { uploadedBy, sourceFile } = {}) {
  const res = await fetch('/api/roster', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'replace', company_code: companyCode, rows, uploaded_by: uploadedBy, source_file: sourceFile }),
  });
  return res.json();
}

/* Borra COMPLETAMENTE la lista de la tienda (y opcionalmente responsables). */
export async function rosterClear(companyCode, { wipeContacts = false } = {}) {
  const res = await fetch('/api/roster', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'clear', company_code: companyCode, wipe_contacts: wipeContacts }),
  });
  return res.json();
}

/* Antiguedad del snapshot en dias (para la advertencia de lista antigua). */
export function rosterAgeDays(meta) {
  if (!meta || !meta.uploaded_at) return null;
  const up = new Date(meta.uploaded_at);
  if (isNaN(up)) return null;
  return Math.floor((Date.now() - up.getTime()) / 86400000);
}

/* Etiqueta de estado de un trabajador del roster. */
export function workerStatusLabel(w) {
  return w.end_date
    ? `<span class="pill pill-out">egresó ${fmtDate(w.end_date)}</span>`
    : '<span class="pill pill-set">vigente</span>';
}
