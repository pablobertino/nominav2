/* =====================================================================
   js/reports/shared/date-window.js
   Ventana de fechas reportable + reloj de Venezuela. Compartido por
   todos los reportes que dependen de la quincena (marcaje, ausencia...).

   Regla (por el recalculo nocturno con margen de dias y hora tope):
     - Limite superior: HOY (hora Venezuela). Nunca futuro. Acotado por
       el dia hito (milestone_date) de la quincena en curso.
     - Limite inferior movil: HOY - margen. PERO el dia mas antiguo
       (HOY - margen) solo se admite hasta la hora tope; pasada esa hora,
       el minimo sube un dia.
     - Nunca posterior al egreso del trabajador (lo aplica quien use esto).

   La validacion que BLOQUEA de verdad la hace el Worker server-side;
   esto es la guia visual en pantalla.
   ===================================================================== */

/* Fecha/hora actual en Venezuela (GMT-4 fijo). Robusto ante la zona del
   equipo: usa Intl con timeZone America/Caracas. */
export function nowVE() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;
  return { ymd: `${p.year}-${p.month}-${p.day}`, hhmm: `${hh}:${p.minute}`, hms: `${hh}:${p.minute}:${p.second}` };
}

export function addDays(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + delta);
  return t.toISOString().slice(0, 10);
}

export function toMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

/* 'YYYY-MM-DD' -> 'DD/MM/AAAA' */
export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

const DOW_LONG = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/* 'HH:MM[:SS]' -> '12:34:56 p. m.' (formato venezolano) */
export function fmtClock(hms) {
  const [h, m, s] = String(hms).split(':');
  let hh = Number(h);
  const ap = hh < 12 ? 'a. m.' : 'p. m.';
  hh = hh % 12; if (hh === 0) hh = 12;
  return s != null
    ? `${hh}:${m}:${s} ${ap}`
    : `${hh}:${m} ${ap}`;
}

/* Texto del dia de la semana + fecha para el reloj de cabecera. */
export function dowFecha(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = DOW_LONG[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dow} ${fmtDate(ymd)}`;
}

/**
 * Calcula la ventana reportable a partir de la config y la quincena.
 * @param {object} opts
 *   - marginDays  : corte_margen_dias (number)
 *   - cutoffTime  : corte_hora_limite 'HH:MM'
 *   - milestone   : dia hito de la quincena en curso 'YYYY-MM-DD' (o null)
 * @returns { today, nowHHMM, pastCutoff, reportMin, reportMax, oldestDay }
 */
export function computeWindow({ marginDays = 2, cutoffTime = '14:00', milestone = null } = {}) {
  const { ymd: today, hhmm: nowHHMM } = nowVE();
  const pastCutoff = toMin(nowHHMM) >= toMin(cutoffTime);
  const reportMin = addDays(today, pastCutoff ? -(marginDays - 1) : -marginDays);
  const oldestDay = addDays(today, -marginDays);
  const reportMax = (milestone && milestone < today) ? milestone : today;
  return { today, nowHHMM, pastCutoff, reportMin, reportMax, oldestDay, marginDays, cutoffTime };
}

/**
 * Valida una fecha contra la ventana y (opcional) la fecha de egreso.
 * Devuelve { ok, level:'ok'|'warn'|'error', msg }.
 *   - 'warn'  : valido pero conviene avisar (ej. dia limite + hora tope hoy)
 *   - 'error' : invalido, bloquea
 */
export function validateDate(date, win, endDate = null) {
  const { reportMin, reportMax, oldestDay, pastCutoff, cutoffTime } = win;
  const maxForWorker = (endDate && endDate < reportMax) ? endDate : reportMax;

  if (!date) return { ok: false, level: 'error', msg: 'Falta la fecha.' };
  if (date > maxForWorker) {
    if (endDate && endDate < reportMax && date > endDate)
      return { ok: false, level: 'error', msg: `No puede ser posterior al egreso (${fmtDate(endDate)}).` };
    return { ok: false, level: 'error', msg: `No puede ser posterior al ${fmtDate(reportMax)} (día tope).` };
  }
  if (date < reportMin) {
    if (pastCutoff && date === oldestDay)
      return { ok: false, level: 'error', msg: `El ${fmtDate(oldestDay)} ya no se puede reportar: pasó la hora tope (${cutoffTime} hora Venezuela).` };
    return { ok: false, level: 'error', msg: `No puede ser anterior al ${fmtDate(reportMin)} (fuera del margen reportable).` };
  }
  // Dia mas antiguo, aun reportable hoy: avisar de la hora tope.
  if (!pastCutoff && date === oldestDay) {
    return { ok: true, level: 'warn', msg: `⚠ Último día para reportar el ${fmtDate(oldestDay)}: solo hasta las ${fmtClock(cutoffTime)} (hora Venezuela) de hoy.` };
  }
  return { ok: true, level: 'ok', msg: '' };
}

/* Texto explicativo de la ventana para mostrar en el paso de marcajes. */
export function windowText(win) {
  const { today, reportMin, reportMax, oldestDay, pastCutoff, cutoffTime } = win;
  let t = `Hoy es <b>${fmtDate(today)}</b>. Puedes reportar del <b>${fmtDate(reportMin)} al ${fmtDate(reportMax)}</b>.`;
  if (!pastCutoff) {
    t += ` El día más antiguo (<b>${fmtDate(oldestDay)}</b>) solo se admite <b>hasta las ${fmtClock(cutoffTime)} (hora Venezuela)</b>; después de esa hora deja de estar disponible.`;
  } else {
    t += ` (Ya pasó la hora tope de hoy, por eso el ${fmtDate(oldestDay)} ya no está disponible.)`;
  }
  t += ` No se admiten fechas futuras ni posteriores al egreso del trabajador.`;
  return t;
}

/**
 * Arranca un reloj VEN vivo en un elemento. Devuelve una funcion stop().
 */
export function startClock(elId) {
  const tick = () => {
    const elNode = document.getElementById(elId);
    if (!elNode) return;
    const { ymd, hms } = nowVE();
    elNode.innerHTML = `🕓 ${dowFecha(ymd)} · ${fmtClock(hms)} <span class="nc-tz">(hora Venezuela)</span>`;
  };
  tick();
  const h = setInterval(tick, 1000);
  return () => clearInterval(h);
}

/* =====================================================================
   Ventana de fechas CONFIGURABLE POR TIPO (usada por Ausencia).
   A diferencia de computeWindow (atada a la quincena del marcaje), aqui
   cada tipo define cuanto se permite hacia atras y hacia el futuro:
     - pastWindowDays  : dias hacia atras. null = sin limite atras.
     - pastUsesCutoff  : si el dia mas antiguo respeta la hora tope.
     - futureWindowDays: dias hacia el futuro. 0/null = sin futuro.
     - cutoffTime      : 'HH:MM' hora tope global (para pastUsesCutoff).
   Devuelve los limites 'YYYY-MM-DD' para acotar los inputs date y
   validar. El egreso lo aplica quien llame (es por trabajador).
   ===================================================================== */
export function typeWindow({ pastWindowDays = null, pastUsesCutoff = false, futureWindowDays = 0, cutoffTime = '14:00' } = {}) {
  const { ymd: today, hhmm: nowHHMM } = nowVE();
  // Limite inferior (min) segun dias hacia atras.
  let minDate = null; // null = sin limite
  let oldestDay = null;
  let pastCutoff = false;
  if (pastWindowDays != null) {
    oldestDay = addDays(today, -pastWindowDays);
    if (pastUsesCutoff) {
      // El dia mas antiguo solo cuenta hasta la hora tope; pasada esa hora sube uno.
      pastCutoff = toMin(nowHHMM) >= toMin(cutoffTime);
      minDate = pastCutoff ? addDays(today, -(pastWindowDays - 1)) : oldestDay;
    } else {
      minDate = oldestDay;
    }
  }
  // Limite superior (max) segun dias hacia el futuro.
  const fwd = futureWindowDays || 0;
  const maxDate = fwd > 0 ? addDays(today, fwd) : today;
  return { today, nowHHMM, minDate, maxDate, oldestDay, pastCutoff, cutoffTime, futureWindowDays: fwd };
}

/* Valida un rango [from,to] de ausencia contra la ventana del tipo y el
   egreso del trabajador. Devuelve un string de error, o null si OK. */
export function typeRangeError(from, to, win, endDate = null) {
  if (!from || !to) return null;
  if (to < from) return 'La fecha Hasta no puede ser anterior a Desde.';
  // Futuro
  if (to > win.maxDate || from > win.maxDate) {
    return win.futureWindowDays > 0
      ? `No puede ser posterior al ${fmtDate(win.maxDate)} (máx. ${win.futureWindowDays} días a futuro para este tipo).`
      : 'Este tipo no admite fechas futuras.';
  }
  // Pasado
  if (win.minDate && from < win.minDate) {
    if (win.pastCutoff && win.oldestDay && from < addDays(win.oldestDay, 1)) {
      return `El ${fmtDate(win.oldestDay)} ya no se puede reportar: pasó la hora tope (${win.cutoffTime} hora Venezuela).`;
    }
    return `No puede ser anterior al ${fmtDate(win.minDate)} (máximo hacia atrás para este tipo).`;
  }
  // Egreso (por trabajador)
  if (endDate && to > endDate) return `No puede ser posterior al egreso (${fmtDate(endDate)}).`;
  return null;
}

/* Validacion de cedula venezolana/extranjera (6-8 digitos). */
export function validateCedula(raw) {
  const ced = String(raw || '').replace(/[^0-9]/g, '');
  if (!ced) return { ok: false, kind: null, msg: '' };
  const n = parseInt(ced, 10);
  const okVE = n >= 1000000 && n <= 39999999;
  const okExt = n >= 80000000 && n <= 89999999;
  if (ced.length >= 6 && ced.length <= 8 && (okVE || okExt)) {
    return { ok: true, kind: okExt ? 'E' : 'V', ced, msg: okExt ? '✓ Cédula de extranjero' : '✓ Cédula venezolana' };
  }
  return { ok: false, kind: null, ced, msg: '✗ Cédula no válida (6 a 8 dígitos)' };
}
