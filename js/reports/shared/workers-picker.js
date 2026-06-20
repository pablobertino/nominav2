/* =====================================================================
   js/reports/shared/workers-picker.js
   Logica de seleccion de trabajadores para un reporte: filtrar por
   texto, ordenar por nombre/cedula, y construir la lista del reporte
   desde el roster o manualmente. Funciones puras sobre arreglos; el
   render lo hace el wizard-core.
   ===================================================================== */

import { validateCedula } from './date-window.js';

/* Filtra el roster por texto (nombre o cedula). */
export function filterRoster(roster, q) {
  const s = (q || '').toLowerCase();
  if (!s) return roster.slice();
  return roster.filter(r => `${r.full_name} ${r.id_number}`.toLowerCase().includes(s));
}

/* Ordena por 'name' o 'ced', direccion 1/-1. */
export function sortRoster(list, key, dir) {
  const field = key === 'ced' ? 'id_number' : 'full_name';
  return list.slice().sort((a, b) => {
    const av = a[field] || '', bv = b[field] || '';
    return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
  });
}

/* ¿esta ya agregado al reporte? (por cedula) */
export function isAdded(workers, idNumber) {
  return workers.some(w => w.ced === idNumber);
}

/* Construye un item de trabajador para el reporte desde una fila de roster. */
export function workerFromRoster(r, nextId) {
  return {
    id: nextId,
    ced: r.id_number,
    name: r.full_name,
    role: r.role || null,
    endDate: r.end_date || null,
    mark: null,
  };
}

/* Valida y construye un trabajador manual. Devuelve {ok, worker|error}. */
export function workerManual(cedRaw, nameRaw, nextId, workers) {
  const v = validateCedula(cedRaw);
  const name = (nameRaw || '').trim();
  if (!v.ok) return { ok: false, error: 'Cédula no válida (6 a 8 dígitos).' };
  if (!name) return { ok: false, error: 'Falta el nombre.' };
  if (isAdded(workers, v.ced)) return { ok: false, error: 'Ese trabajador ya fue agregado.' };
  return { ok: true, worker: { id: nextId, ced: v.ced, name, role: null, endDate: null, mark: null } };
}
