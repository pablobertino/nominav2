/* =====================================================================
   js/reports/shared/roster-ax.js
   Parser del "Reporte AX" (Excel de AX) para cargar el personal de
   EMPRESAS NO-TIENDA en enterprise_workers.

   Formato ACTUAL (hasta 18 columnas en espanol):
     Numero de personal | Nombre | Empresa | Empresa2 | Empresa3 |
     Tipo de compania | Fecha de nacimiento | Edad | Genero |
     Estado civil | Numero de dependientes | Persona con discapacidades |
     [Numero de cuenta bancaria] | [TodoTicket] |
     Fecha inicial del empleo | Fecha final del empleo |
     Id. de diseno de pantalla | Id. del registro

   La version nueva del reporte SI trae cuenta bancaria y TodoTicket; la
   version vieja (16 cols) no las trae y esas columnas quedan null (el
   parser es retrocompatible: detecta por NOMBRE de cabecera). No trae
   telefono/correo/direccion (esos se conservan en el merge del backend).
   No trae cargo (role queda null); el cargo vendra luego por la API.
   end_date con anio >= 2100 (p.ej. 2154) => vigente => null.

   Reusa helpers ya exportados por roster.js (ensureXLSX, normHeader,
   excelDateToISO, splitFullName). genderCode/maritalCode/accountDigits se
   definen aqui (cortos y autocontenidos) para no acoplar mas a roster.js.

   La carga la hace el backend /api/enterprise-roster; este modulo solo
   parsea/valida + expone la API.
   ===================================================================== */

import { ensureXLSX, normHeader, excelDateToISO, splitFullName } from './roster.js';

/* Genero AX -> 'M'|'F'|null. */
function genderCode(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!s) return null;
  if (/^MASC/.test(s) || s === 'M' || s === '1') return 'M';
  if (/^FEM/.test(s) || s === 'F' || s === '2') return 'F';
  return null;
}

/* Estado civil AX -> 'S'|'C'|'D'|'V'|null. "Ninguno" => null. */
function maritalCode(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!s) return null;
  if (/SOLTER/.test(s)) return 'S';
  if (/CASAD/.test(s)) return 'C';
  if (/VIUD/.test(s)) return 'V';
  if (/DIVORCIAD/.test(s)) return 'D';
  if (s === 'S' || s === 'C' || s === 'V' || s === 'D') return s;
  // "NINGUNO", "NO DEFINIDO", "OTROS"... -> sin codigo.
  return null;
}

/* Cuenta bancaria -> string de 20 digitos o ''. Maneja el caso de que
   Excel la guarde como numero (notacion cientifica perderia digitos): si
   la celda es objeto SheetJS con .w (texto formateado), usa ese; si es
   number entero usa BigInt; si es float usa toFixed(0). Lo normal en el
   Reporte AX es que venga como TEXTO (lo ideal). */
function accountDigits(cell) {
  if (cell == null || cell === '') return '';
  if (typeof cell === 'object' && cell.w != null) return String(cell.w).replace(/[^0-9]/g, '');
  if (typeof cell === 'number') {
    if (Number.isInteger(cell)) { try { return BigInt(cell).toString().replace(/[^0-9]/g, ''); } catch { /* sigue */ } }
    return cell.toFixed(0).replace(/[^0-9]/g, '');
  }
  return String(cell).replace(/[^0-9]/g, '');
}

/* TodoTicket AX -> 'S'|'N'|null. "Si"/"Sí" -> S; "No" -> N; vacio -> null. */
function todoTicketCode(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!s) return null;
  if (s === 'SI' || s === 'S') return 'S';
  if (s === 'NO' || s === 'N') return 'N';
  return null;
}

/* end_date: si el anio es >= 2100 (AX usa 2154-12-31 para "sin egreso"),
   se considera vigente y devolvemos null. Si no, la fecha real. */
function endDateOrNull(v) {
  const iso = excelDateToISO(v);
  if (!iso) return null;
  const year = parseInt(iso.slice(0, 4), 10);
  if (year >= 2100) return null;
  return iso;
}

/* Mapeo de cabeceras (normalizadas) del Reporte AX a nuestras claves.
   Deteccion por nombre, robusta a reordenamientos de columnas. */
const HEADER_MAP_AX = {
  'numero de personal': 'id_number',
  'nombre': 'full_name',
  'empresa': 'company_code',
  'tipo de compania': 'company_type',
  'fecha de nacimiento': 'birth_raw',
  'genero': 'gender_raw',
  'estado civil': 'marital_raw',
  'numero de cuenta bancaria': 'account_raw',
  'todoticket': 'todoticket_raw',
  'fecha inicial del empleo': 'start_raw',
  'fecha final del empleo': 'end_raw',
  'id. del registro': 'data_id_raw',
};

/**
 * Parsea un File del Reporte AX. Devuelve { rows, fileName, columnsFound,
 * missing, companyCodes }. NO sube nada.
 *   rows: { id_number, full_name, first_name, second_name, last_names,
 *           company_code, company_type, birth_date, gender, marital_status,
 *           start_date, end_date, data_id, role:null }
 *   companyCodes: set de codigos de empresa hallados (para validar contra la
 *                 empresa donde se carga).
 */
export async function parseReporteAX(file) {
  const XLSX = await ensureXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  // Matriz de TEXTO (raw:false) solo para la cuenta bancaria, que sufre por
  // la notacion cientifica si Excel la guardo como numero grande.
  const matrixTxt = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  if (!matrix.length) {
    return { rows: [], fileName: file.name, columnsFound: [], missing: ['Número de personal', 'Nombre'], companyCodes: [] };
  }

  const headers = matrix[0].map(normHeader);
  const colIdx = {};
  headers.forEach((h, i) => {
    const key = HEADER_MAP_AX[h];
    if (key != null && colIdx[key] == null) colIdx[key] = i;
  });

  const columnsFound = [];
  if (colIdx.id_number != null) columnsFound.push('Número de personal');
  if (colIdx.full_name != null) columnsFound.push('Nombre');
  if (colIdx.company_code != null) columnsFound.push('Empresa');
  if (colIdx.birth_raw != null) columnsFound.push('Fecha de nacimiento');
  if (colIdx.gender_raw != null) columnsFound.push('Género');
  if (colIdx.marital_raw != null) columnsFound.push('Estado civil');
  if (colIdx.start_raw != null) columnsFound.push('Fecha inicial del empleo');
  if (colIdx.end_raw != null) columnsFound.push('Fecha final del empleo');
  if (colIdx.account_raw != null) columnsFound.push('Cuenta bancaria');
  if (colIdx.todoticket_raw != null) columnsFound.push('TodoTicket');

  const missing = [];
  if (colIdx.id_number == null) missing.push('Número de personal');
  if (colIdx.full_name == null) missing.push('Nombre');
  if (colIdx.company_code == null) missing.push('Empresa');

  const rows = [];
  const codes = new Set();
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    const rowTxt = matrixTxt[r] || [];
    if (!row || row.every(c => c === '' || c == null)) continue;
    const id_number = colIdx.id_number != null ? String(row[colIdx.id_number] ?? '').replace(/[^0-9]/g, '') : '';
    const full_name = colIdx.full_name != null ? String(row[colIdx.full_name] ?? '').trim() : '';
    const company_code = colIdx.company_code != null ? String(row[colIdx.company_code] ?? '').trim() : '';
    const company_type = colIdx.company_type != null ? String(row[colIdx.company_type] ?? '').trim() : '';
    const birth_date = colIdx.birth_raw != null ? excelDateToISO(row[colIdx.birth_raw]) : null;
    const gender = colIdx.gender_raw != null ? genderCode(row[colIdx.gender_raw]) : null;
    const marital_status = colIdx.marital_raw != null ? maritalCode(row[colIdx.marital_raw]) : null;
    const start_date = colIdx.start_raw != null ? excelDateToISO(row[colIdx.start_raw]) : null;
    const end_date = colIdx.end_raw != null ? endDateOrNull(row[colIdx.end_raw]) : null;
    const data_id = colIdx.data_id_raw != null ? (String(row[colIdx.data_id_raw] ?? '').trim() || null) : null;
    // Cuenta: preferir el texto formateado (raw:false); si no llega a 20, caer
    // al crudo. Si no tiene 20 digitos, null (no guardar basura).
    let account_number = null;
    if (colIdx.account_raw != null) {
      let acc = accountDigits(rowTxt[colIdx.account_raw]);
      if (acc.length !== 20) {
        const alt = accountDigits(row[colIdx.account_raw]);
        if (alt.length === 20) acc = alt;
      }
      account_number = acc.length === 20 ? acc : null;
    }
    const todo_ticket = colIdx.todoticket_raw != null ? todoTicketCode(row[colIdx.todoticket_raw]) : null;
    const np = splitFullName(full_name);
    if (company_code) codes.add(company_code);
    rows.push({
      id_number, full_name,
      first_name: np.first_name || null,
      second_name: np.second_name || null,
      last_names: np.last_names || null,
      company_code, company_type,
      birth_date, gender, marital_status,
      account_number, todo_ticket,
      start_date, end_date, data_id,
      role: null,   // el Reporte AX (este formato) no trae cargo
    });
  }
  return { rows, fileName: file.name, columnsFound, missing, companyCodes: [...codes] };
}

/* Validacion local previa a la carga. Verifica cedulas, duplicados y que
   el codigo de empresa del Excel coincida con la empresa destino.
   - expectedCompany: company_code de la empresa donde se esta cargando.
*/
export function validateReporteAX(parsed, expectedCompany) {
  const seen = new Set();
  const valid = [];
  let badCed = 0, dups = 0, otherCompany = 0;
  for (const r of parsed.rows) {
    if (!r.id_number || r.id_number.length < 6 || r.id_number.length > 8) { badCed++; continue; }
    if (!r.full_name) continue;
    if (seen.has(r.id_number)) { dups++; continue; }
    // Si el Excel trae codigo de empresa distinto al destino, lo contamos.
    if (expectedCompany && r.company_code && r.company_code.toUpperCase() !== String(expectedCompany).toUpperCase()) {
      otherCompany++;
      continue; // no se carga personal de otra empresa
    }
    seen.add(r.id_number);
    valid.push(r);
  }
  const active = valid.filter(r => !r.end_date);
  const terminated = valid.filter(r => r.end_date);

  // Empresas distintas a la destino presentes en el archivo (para avisar).
  const foreignCompanies = (parsed.companyCodes || [])
    .filter(c => expectedCompany && c.toUpperCase() !== String(expectedCompany).toUpperCase());

  const warnings = [];
  if (badCed) warnings.push(`${badCed} fila(s) con cédula inválida (omitidas).`);
  if (dups) warnings.push(`${dups} cédula(s) duplicada(s) (se conserva la primera).`);
  if (otherCompany) warnings.push(`${otherCompany} fila(s) de otra empresa (${foreignCompanies.join(', ')}) — no se cargan aquí.`);

  return {
    okToUpload: valid.length > 0 && parsed.missing.length === 0,
    total: valid.length,
    active: active.length,
    terminated: terminated.length,
    withBirth: valid.filter(r => r.birth_date).length,
    withGender: valid.filter(r => r.gender).length,
    withAccount: valid.filter(r => r.account_number).length,
    hasAccountCol: (parsed.columnsFound || []).includes('Cuenta bancaria'),
    foreignCompanies,
    warnings,
    validRows: valid,
  };
}

/* --- API de carga (reemplazo total por empresa) sobre enterprise_workers --- */

export async function enterpriseRosterGet(companyCode, adminId) {
  const res = await fetch('/api/enterprise-roster', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get', company_code: companyCode, adminId }),
  });
  return res.json();
}

export async function enterpriseRosterReplace(companyCode, rows, { uploadedBy, sourceFile, adminId } = {}) {
  const res = await fetch('/api/enterprise-roster', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'replace', company_code: companyCode, rows,
      uploaded_by: uploadedBy, source_file: sourceFile, adminId,
    }),
  });
  return res.json();
}

export async function enterpriseRosterClear(companyCode, adminId) {
  const res = await fetch('/api/enterprise-roster', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'clear', company_code: companyCode, adminId }),
  });
  return res.json();
}

/* --- Carga de Reporte AX en una TIENDA (escribe en store_workers) ---
   Solo admin/superadmin. Usa /api/roster con accion 'replace_ax'. Regla
   "el ultimo reporte manda": el AX define el roster y pisa los campos que
   trae; el cargo (que el AX no trae) se conserva del registro previo. */
export async function storeRosterReplaceAX(companyCode, rows, { uploadedBy, sourceFile, adminId } = {}) {
  const res = await fetch('/api/roster', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'replace_ax', company_code: companyCode, rows,
      uploaded_by: uploadedBy, source_file: sourceFile, adminId,
    }),
  });
  return res.json();
}
