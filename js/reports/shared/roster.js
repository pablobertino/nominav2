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
export function normHeader(h) {
  return String(h || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Mapeo tolerante de encabezados del Reporte 10 a nuestras claves.
   El Reporte 10 NUEVO (SP GC_RP_Employees ampliado) trae TODOS los datos
   personales que necesita la precarga del reporte de Modificacion:
   ademas de cedula/nombre/cargo/fechas/captahuellas/cuenta/todoticket/data_id,
   ahora vienen Fecha de Nacimiento, Direccion, Estado Civil, Telefono, Correo
   y Genero. El header 'cuenta bancaria'/'todoticket' puede aparecer dos veces
   en versiones viejas del archivo: el primer match gana (ver mas abajo).
   El parser es RETROCOMPATIBLE: si el archivo es la version vieja (sin estos
   campos), esas columnas no se encuentran y quedan null, sin romper nada. */
const HEADER_MAP = {
  'cedula': 'id_number',
  'nombre': 'full_name',
  'cargo': 'role',
  'captahuellas': 'biometric_raw',
  'fecha inicio empleo': 'start_raw',
  'fecha fin empleo': 'end_raw',
  'cuenta bancaria': 'account_raw',
  'todoticket': 'todoticket_raw',
  'codigo de pantalla': 'data_id_raw',
  // --- Campos personales nuevos (Reporte 10 ampliado) ---
  'fecha de nacimiento': 'birth_raw',
  'direccion': 'address_raw',
  'estado civil': 'marital_raw',
  'nro telefono': 'phone_raw',
  'correo electronico': 'email_raw',
  'genero': 'gender_raw',
};

/* Convierte un valor de fecha de Excel a 'YYYY-MM-DD' (o null). */
export function excelDateToISO(v) {
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

/* Particulas de apellido/nombre venezolano que se pegan a la palabra
   SIGUIENTE para no romper apellidos compuestos (DEL VALLE, DE LOS ANGELES,
   LA CRUZ). En mayusculas, sin acentos (el nombre ya se normaliza asi). */
const NAME_PARTICLES = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'SAN', 'SANTA', 'Y']);

/* Divide un nombre completo en { first_name, second_name, last_names }.
   Regla acordada (2 apellidos + particulas), pensada para el formato
   venezolano [nombre] [2do nombre] [apellido1] [apellido2]:
     1) Se agrupan las particulas con la palabra siguiente -> tokens.
     2) Segun cuantos tokens queden:
          1 token  -> solo first.
          2 tokens -> first + un apellido.
          3 tokens -> first + dos apellidos (sin segundo nombre).
          4+ tokens-> first = tok[0]; apellidos = los DOS ultimos tokens;
                      second = lo del medio (unido).
   No es perfecto con nombres de 3 palabras (ambiguos) ni compuestos raros;
   por eso first/second/last quedan EDITABLES en BD. Acierta ~80%+ del
   formato real, que es lo esperable sin un diccionario de apellidos. */
export function splitFullName(full) {
  const norm = String(full || '')
    .toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (!norm) return { first_name: '', second_name: '', last_names: '' };
  const raw = norm.split(' ');
  // Agrupar particulas (incluye particulas consecutivas: DE LOS ANGELES).
  const toks = [];
  let i = 0;
  while (i < raw.length) {
    const w = raw[i];
    if (NAME_PARTICLES.has(w) && i + 1 < raw.length) {
      let part = w;
      let j = i + 1;
      while (j + 1 < raw.length && NAME_PARTICLES.has(raw[j])) { part += ' ' + raw[j]; j++; }
      part += ' ' + raw[j];
      toks.push(part);
      i = j + 1;
    } else {
      toks.push(w);
      i++;
    }
  }
  const n = toks.length;
  if (n === 1) return { first_name: toks[0], second_name: '', last_names: '' };
  if (n === 2) return { first_name: toks[0], second_name: '', last_names: toks[1] };
  if (n === 3) return { first_name: toks[0], second_name: '', last_names: `${toks[1]} ${toks[2]}` };
  return {
    first_name: toks[0],
    second_name: toks.slice(1, -2).join(' '),
    last_names: `${toks[n - 2]} ${toks[n - 1]}`,
  };
}

/* Normaliza un valor de cuenta bancaria a string de digitos. CRITICO:
   una cuenta de 20 digitos excede Number.MAX_SAFE_INTEGER (~9e15), asi que
   si Excel la guardo como NUMERO, SheetJS (raw:true) la entrega como float
   en notacion cientifica (ej. 1.340379133791e+18) y String() pierde digitos.
   Por eso: si la celda es un objeto de SheetJS con texto formateado (.w),
   se usa ese; si es number, se intenta el texto formateado y, en ultimo
   caso, BigInt para no perder precision. Devuelve solo los digitos. */
function accountDigits(cell) {
  if (cell == null || cell === '') return '';
  // Celda como objeto {v, w}: w es el texto tal como se ve en Excel.
  if (typeof cell === 'object' && cell.w != null) {
    return String(cell.w).replace(/[^0-9]/g, '');
  }
  if (typeof cell === 'number') {
    // Entero seguro -> BigInt preserva todos los digitos.
    if (Number.isInteger(cell)) {
      try { return BigInt(cell).toString().replace(/[^0-9]/g, ''); } catch { /* sigue */ }
    }
    // Float (notacion cientifica): toFixed(0) recupera el entero sin 'e'.
    const fixed = cell.toFixed(0);
    return fixed.replace(/[^0-9]/g, '');
  }
  // String normal (lo ideal: el POS la exporta como texto).
  return String(cell).replace(/[^0-9]/g, '');
}

/* Normaliza el ESTADO CIVIL a un codigo S/C/D/V, aceptando CUALQUIER forma
   en que el Reporte 10 lo presente, para ser compatible con todas las
   versiones del SP y con datos viejos:
     - Con numero delante:  '1 - Casada', '2 - Soltera', '3 - Viuda',
                            '4 - Divorciada' (mapeo del SP GC_RP_Employees).
     - Sin numero:          'Casado', 'Soltera', 'Viudo', 'Divorciada'...
     - Masculino o femenino: 'Casado/Casada', 'Soltero/Soltera', etc.
     - Ya en codigo:        'S', 'C', 'D', 'V'.
   Devuelve 'S'|'C'|'D'|'V' o null si no se reconoce / viene vacio.
   NOTA: el numero del SP NO se usa como verdad unica (hay versiones del SP
   con el mapeo desordenado); se prioriza el TEXTO, y el numero solo se usa
   como respaldo si no hay texto reconocible. */
function maritalCode(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!s) return null;
  // Quitar prefijo numerico tipo '2 - ' o '2-' o '2 '
  const numMatch = s.match(/^(\d+)\s*[-.)]?\s*/);
  let num = null;
  if (numMatch) { num = parseInt(numMatch[1], 10); s = s.slice(numMatch[0].length).trim(); }
  // Por TEXTO (raiz, sirve para masculino y femenino): SOLTER, CASAD, VIUD,
  // DIVORCIAD. (CONCUBIN/COHABIT/UNION -> sin codigo propio: lo tratamos como
  // soltero a efectos de nomina solo si el SP lo mapeara; aqui devolvemos null
  // para no inventar, salvo que el negocio decida lo contrario.)
  if (/SOLTER/.test(s)) return 'S';
  if (/CASAD/.test(s)) return 'C';
  if (/VIUD/.test(s)) return 'V';
  if (/DIVORCIAD/.test(s)) return 'D';
  // Ya venia como codigo de una letra.
  if (s === 'S' || s === 'C' || s === 'V' || s === 'D') return s;
  // Respaldo por numero del SP actual (1=Casada,2=Soltera,3=Viuda,4=Divorciada).
  if (num != null) {
    if (num === 1) return 'C';
    if (num === 2) return 'S';
    if (num === 3) return 'V';
    if (num === 4) return 'D';
  }
  return null;
}

/* Normaliza el GENERO a 'M'|'F'|null, aceptando 'MASCULINO'/'FEMENINO',
   'M'/'F', o numeros del SP (1=Masculino, 2=Femenino). Vacio -> null. */
function genderCode(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!s) return null;
  if (/^MASC/.test(s) || s === 'M' || s === '1') return 'M';
  if (/^FEM/.test(s) || s === 'F' || s === '2') return 'F';
  return null;
}

/* Normaliza un TELEFONO venezolano a 11 digitos '04XXXXXXXXX' o null.
   Acepta: '04122804802' (11 ya ok), '4120981697' (10 sin 0 inicial -> se
   antepone 0), '+584122804802' / '584122804802' (con codigo pais),
   con espacios/guiones. Si no encaja en un movil 04XX valido, null. */
function phoneLocal(raw) {
  if (raw == null) return null;
  let d = String(raw).replace(/[^0-9]/g, '');
  if (!d) return null;
  if (d.startsWith('58') && d.length === 12) d = '0' + d.slice(2);   // 58 + 10
  else if (d.length === 10 && d[0] === '4') d = '0' + d;             // sin 0 inicial
  if (d.length === 11 && d[0] === '0' && d[1] === '4') return d;
  return null;
}

/* Normaliza un CORREO: trim + minusculas. Si NO parece un correo valido
   (el Reporte 10 a veces trae correos sin @ ni puntos por datos sucios del
   origen, ej. 'leander2525gmailcom'), devuelve null para no precargar basura
   (el usuario lo escribira bien en el modal si hace falta). */
function emailClean(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
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
  // raw:false hace que SheetJS rellene .w (texto formateado) en cada celda,
  // pero para fechas/numeros preferimos el valor crudo. Solucion: pedimos la
  // matriz con raw:true para la logica general, y aparte una matriz de TEXTO
  // (raw:false) SOLO para la cuenta bancaria, que es la unica que sufre por
  // la notacion cientifica de los numeros grandes.
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const matrixTxt = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  if (!matrix.length) return { rows: [], fileName: file.name, columnsFound: [], missing: ['Cédula', 'Nombre'] };

  // Encabezados -> indice de columna. IMPORTANTE: algunos headers del Reporte
  // 10 aparecen DUPLICADOS (p.ej. 'Cuenta Bancaria' y 'Todoticket' salen al
  // inicio CON datos y otra vez al final VACIOS). El PRIMER match debe ganar:
  // por eso se asigna solo si la clave aun no existe (no sobreescribir).
  const headers = matrix[0].map(normHeader);
  const colIdx = {};
  headers.forEach((h, i) => {
    const key = HEADER_MAP[h];
    if (key != null && colIdx[key] == null) colIdx[key] = i;
  });

  // Fallback tolerante para columnas cuyo header puede variar entre versiones
  // del Reporte 10. Si el match exacto no encontro la columna, se busca por
  // CONTENIDO del header normalizado (incluye). El primer hit gana. Esto
  // cubre 'Cuenta Bancaria' vs 'Nro de Cuenta' vs 'Cuenta', 'TodoTicket' vs
  // 'Todo Ticket', 'Codigo de Pantalla' vs 'Cod Pantalla', etc.
  const findByIncludes = (needles) => {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (needles.some(n => h.includes(n))) return i;
    }
    return null;
  };
  if (colIdx.account_raw == null) {
    const idx = findByIncludes(['cuenta']);
    if (idx != null) colIdx.account_raw = idx;
  }
  if (colIdx.todoticket_raw == null) {
    const idx = findByIncludes(['todoticket', 'todo ticket']);
    if (idx != null) colIdx.todoticket_raw = idx;
  }
  if (colIdx.data_id_raw == null) {
    const idx = findByIncludes(['codigo de pantalla', 'cod pantalla', 'data id']);
    if (idx != null) colIdx.data_id_raw = idx;
  }

  const columnsFound = [];
  if (colIdx.id_number != null) columnsFound.push('Cédula');
  if (colIdx.full_name != null) columnsFound.push('Nombre');
  if (colIdx.role != null) columnsFound.push('Cargo');
  if (colIdx.account_raw != null) columnsFound.push('Cuenta Bancaria');
  if (colIdx.todoticket_raw != null) columnsFound.push('TodoTicket');

  const missing = [];
  if (colIdx.id_number == null) missing.push('Cédula');
  if (colIdx.full_name == null) missing.push('Nombre');

  const rows = [];
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    const rowTxt = matrixTxt[r] || [];
    if (!row || row.every(c => c === '' || c == null)) continue;
    const id_number = colIdx.id_number != null ? String(row[colIdx.id_number] ?? '').replace(/[^0-9]/g, '') : '';
    const full_name = colIdx.full_name != null ? String(row[colIdx.full_name] ?? '').trim() : '';
    const role = colIdx.role != null ? String(row[colIdx.role] ?? '').trim() : '';
    const bioRaw = colIdx.biometric_raw != null ? String(row[colIdx.biometric_raw] ?? '').trim() : '';
    const start_date = colIdx.start_raw != null ? excelDateToISO(row[colIdx.start_raw]) : null;
    const end_date = colIdx.end_raw != null ? excelDateToISO(row[colIdx.end_raw]) : null;
    // Datos personales nuevos (pueden venir o no). Se normalizan:
    //  - cuenta: se lee con accountDigits desde la matriz de TEXTO (raw:false)
    //    para no perder digitos por notacion cientifica; se guarda si tiene
    //    20 (si no, null para no guardar basura).
    //  - todoticket: 'SI'/'SI' -> 'S', cualquier otra cosa con valor -> 'N',
    //    vacio -> null (no sabemos).
    //  - data_id (Codigo de Pantalla): texto tal cual (suele venir vacio).
    let accDigits = '';
    if (colIdx.account_raw != null) {
      // Preferir el texto formateado (raw:false); si vacio, caer al crudo.
      accDigits = accountDigits(rowTxt[colIdx.account_raw]);
      if (accDigits.length !== 20) {
        const alt = accountDigits(row[colIdx.account_raw]);
        if (alt.length === 20) accDigits = alt;
      }
    }
    const account_number = accDigits.length === 20 ? accDigits : null;
    let todo_ticket = null;
    if (colIdx.todoticket_raw != null) {
      const t = String(row[colIdx.todoticket_raw] ?? '').trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (t) todo_ticket = (t === 'SI' || t === 'S') ? 'S' : 'N';
    }
    const data_id = colIdx.data_id_raw != null ? (String(row[colIdx.data_id_raw] ?? '').trim() || null) : null;
    // Datos personales del Reporte 10 ampliado. Cada uno se normaliza con su
    // helper y queda null si no viene o no se reconoce (compatibilidad con el
    // archivo viejo que no traia estas columnas).
    const birth_date = colIdx.birth_raw != null ? excelDateToISO(row[colIdx.birth_raw]) : null;
    const address = colIdx.address_raw != null ? (String(row[colIdx.address_raw] ?? '').trim() || null) : null;
    const marital_status = colIdx.marital_raw != null ? maritalCode(row[colIdx.marital_raw]) : null;
    const phone = colIdx.phone_raw != null ? phoneLocal(row[colIdx.phone_raw]) : null;
    const email = colIdx.email_raw != null ? emailClean(row[colIdx.email_raw]) : null;
    const gender = colIdx.gender_raw != null ? genderCode(row[colIdx.gender_raw]) : null;
    // Dividir el nombre completo en partes (lo que AX necesita): primer
    // nombre, segundo nombre y apellidos. Heuristica 2-apellidos + particulas.
    const np = splitFullName(full_name);
    rows.push({
      id_number, full_name, role,
      first_name: np.first_name || null,
      second_name: np.second_name || null,
      last_names: np.last_names || null,
      has_biometric: bioRaw ? /activ/i.test(bioRaw) : true,
      start_date, end_date,
      account_number, todo_ticket, data_id,
      birth_date, address, marital_status, phone, email, gender,
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

/* Alta MANUAL de un colaborador (cedula que aun no esta en el Reporte 10).
   Entra a store_workers + workers_master. Pide lo minimo; el resto de la
   ficha se completa luego desde Personal. */
export async function rosterAddManual(companyCode, data) {
  const res = await fetch('/api/roster', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'add_manual', company_code: companyCode,
      id_number: data.id_number,
      first_name: data.first_name, second_name: data.second_name, last_names: data.last_names,
      role: data.role, egresado: !!data.egresado,
    }),
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
