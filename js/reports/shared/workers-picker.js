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

/* Prioridad de responsable para el orden: Gerente (0) arriba, Sub-Gerente
   (1) luego, resto (2). Usa el campo manager_role que marca el Worker. */
function managerRank(r) {
  const m = r.manager_role || null;
  if (m === 'Gerente') return 0;
  if (m === 'Sub-Gerente') return 1;
  return 2;
}

/* Ordena por 'name' | 'ced' | 'role'. En TODOS los casos, gerentes y
   sub-gerentes salen primero (en otro color en el render). La direccion
   (dir 1/-1) aplica al criterio elegido DENTRO de cada grupo. */
export function sortRoster(list, key, dir) {
  const field = key === 'ced' ? 'id_number' : (key === 'role' ? 'role' : 'full_name');
  return list.slice().sort((a, b) => {
    // 1) responsables siempre arriba
    const ra = managerRank(a), rb = managerRank(b);
    if (ra !== rb) return ra - rb;
    // 2) dentro del grupo, por el criterio elegido
    const av = (a[field] || '').toString().toLowerCase();
    const bv = (b[field] || '').toString().toLowerCase();
    if (av !== bv) return (av > bv ? 1 : -1) * dir;
    // 3) desempate estable por nombre
    const an = (a.full_name || '').toLowerCase(), bn = (b.full_name || '').toLowerCase();
    return an > bn ? 1 : an < bn ? -1 : 0;
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
