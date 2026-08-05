/* =====================================================================
   functions/api/_axmarcajes.js  —  MODULO COMPARTIDO (no es una ruta)
   Puente entre el vocabulario del PORTAL y el de AX 2012 para los
   marcajes (AIFFingerPrint / insertFingerprintRecord, expuesto por el
   middleware Flask de Sebastian).

   POR QUE UN MODULO Y NO CODIGO REPETIDO:
   la traduccion portal -> AX tiene tres trampas (el alias, la cedula y
   las horas en segundos). Escritas dos veces, tarde o temprano una de
   las dos copia se queda vieja y los marcajes terminan en la tienda
   equivocada o con la hora corrida. Aca vive UNA sola version, y la usan
   tanto /api/ax-marcajes (diagnostico) como /api/reports-history
   (accion publish_ax, la publicacion de verdad).

   CONTRATO DE AX  (confirmado con inserciones reales el 04/08/2026)
     alias           companies.company_code -> 'AE01', 'AN01', 'AL01'...
                     OJO: NO es el data_area. AX resuelve el data_area
                     solo a partir del alias; si le mandamos el data_area
                     el marcaje se escribe en la TIENDA EQUIVOCADA.
     personnelNumber la cedula, SOLO DIGITOS (sin V- ni E-).
     transDate       'AAAA-MM-DD'.
     dayType         'Workday' | 'RestDay'. El portal maneja 'L' | 'D'.
     timeEntry       SEGUNDOS DESDE MEDIANOCHE (08:30 -> 30600). No texto.
     timeExit        idem. En RestDay ambos van en 0.

   El portal guarda 'HH:MM:SS' en mark_report_lines.time_in/time_out, asi
   que la conversion a segundos se hace aca y se aceptan las dos formas.

   Env vars: canaima_apikey (o ax_api_key), ax_marcajes_url (opcional).
   ===================================================================== */

export const AX_MARCAJES_URL_DEFAULT = 'https://api.grupocanaima.com/empleados/marcajes/v1';

/* HRDayType del lado de AX. Un dia de DESCANSO no lleva horas. */
export const AX_DAY_TYPES = new Set(['Workday', 'RestDay']);

/* URL base del middleware (sin barra final). */
export function axBase(env) {
  return String((env && env.ax_marcajes_url) || AX_MARCAJES_URL_DEFAULT).replace(/\/+$/, '');
}

/* La X-API-Key. Se acepta ax_api_key para poder separarla mas adelante,
   pero hoy es el mismo secret canaima_apikey que usan las otras APIs. */
export function axKey(env) {
  return (env && (env.ax_api_key || env.canaima_apikey)) || '';
}

/* Tipo de dia del portal ('L' | 'D') -> HRDayType de AX.
   Tolerante: si ya viene en el vocabulario de AX lo respeta, para que el
   endpoint de diagnostico pueda pasar 'RestDay' tal cual. */
export function dayTypeToAx(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return (s === 'D' || s === 'RESTDAY') ? 'RestDay' : 'Workday';
}

/* 'HH:MM' | 'HH:MM:SS' | numero -> segundos desde medianoche.
   Devuelve null si el texto NO es una hora valida, para poder distinguir
   "no vino" (0) de "vino mal escrita" (null). */
export function hhmmToSeconds(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Math.max(0, parseInt(s, 10));      // ya vino en segundos
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10), se = parseInt(m[3] || '0', 10);
  if (h > 23 || mi > 59 || se > 59) return null;
  return h * 3600 + mi * 60 + se;
}

/* Segundos -> 'HH:MM'. Solo para el eco legible de las respuestas. */
export function secondsToHHMM(n) {
  const s = Math.max(0, Number(n) || 0);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

/* Llamada al middleware. Devuelve { ok, status, data, raw } SIN LANZAR:
   un error del middleware trae detalles_ax y hasta el XML crudo del SOAP
   Fault, y eso es informacion valiosa para el usuario, no una excepcion
   que haya que esconder. */
export async function axCall(url, key, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'X-API-Key': key, Accept: 'application/json', ...(init.headers || {}) },
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* no siempre responde JSON */ }
  return { ok: res.ok, status: res.status, data, raw };
}

/* Ping de vida al middleware. No escribe nada. */
export async function axHealth(env) {
  const key = axKey(env);
  const url = `${axBase(env)}/health`;
  if (!key) {
    return { ok: false, url, http: 0, error: 'Falta el secret canaima_apikey (o ax_api_key) en las variables del proyecto.' };
  }
  const r = await axCall(url, key, { method: 'GET' });
  return { ok: r.ok, url, http: r.status, respuesta: r.data || String(r.raw || '').slice(0, 500) };
}

/* =====================================================================
   axInsertMarcaje(env, rec) — publica UN marcaje en AX. ESCRIBE DE VERDAD.

   rec: { alias, personnelNumber, transDate, dayType, timeEntry, timeExit }
        dayType admite el vocabulario del portal ('L'|'D') o el de AX.
        timeEntry/timeExit admiten 'HH:MM', 'HH:MM:SS' o segundos.

   Devuelve SIEMPRE la misma forma, pase lo que pase (validacion, error de
   red, SOAP Fault o exito). Quien la llama nunca tiene que envolverla en
   try/catch ni adivinar la forma de la respuesta:

     { ok, http, payload, mensaje, error, detalles_ax, xml, legible }

   payload  = lo EXACTO que se le mando a AX (en una integracion nueva, la
              mitad de los problemas son "mande otra cosa de la que creia").
   legible  = '08:00 -> 17:00', para mostrarle al usuario.
   ===================================================================== */
export async function axInsertMarcaje(env, rec = {}) {
  const fail = (error, extra = {}) => ({
    ok: false, http: 0, payload: null, mensaje: null,
    error, detalles_ax: null, xml: null, legible: null, ...extra,
  });

  const alias = String(rec.alias || '').trim();
  // Cedula: solo digitos. El portal a veces arrastra 'V-' del roster.
  const personnelNumber = String(rec.personnelNumber || '').replace(/\D+/g, '');
  const transDate = String(rec.transDate || '').trim().slice(0, 10);
  const dayType = dayTypeToAx(rec.dayType);

  if (!alias) return fail('Falta el alias de la empresa.');
  if (!personnelNumber) return fail('Falta la cédula (número de personal).');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transDate)) return fail('La fecha debe venir como AAAA-MM-DD.');

  /* Descanso sin horas: se fuerzan a 0 aunque vengan cargadas. Es la misma
     regla de la plantilla AX del reporte de marcaje (en Descanso las
     columnas de entrada/salida van vacias) y evita mandarle a AX un
     descanso con horario, que no tiene sentido. */
  let entry = 0, exit = 0;
  if (dayType === 'Workday') {
    entry = hhmmToSeconds(rec.timeEntry);
    exit = hhmmToSeconds(rec.timeExit);
    if (entry === null) return fail('Hora de entrada inválida (usa HH:MM).');
    if (exit === null) return fail('Hora de salida inválida (usa HH:MM).');
    if (entry && exit && exit <= entry) {
      return fail('La hora de salida debe ser posterior a la de entrada.');
    }
  }

  const payload = { alias, personnelNumber, dayType, transDate, timeEntry: entry, timeExit: exit };
  const legible = `${secondsToHHMM(entry)} -> ${secondsToHHMM(exit)}`;

  const key = axKey(env);
  if (!key) {
    return fail('Falta el secret canaima_apikey (o ax_api_key) en las variables del proyecto.', { payload, legible });
  }

  let r;
  try {
    r = await axCall(axBase(env), key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // Caida de red / DNS / timeout: el middleware ni contesto.
    return fail('No se pudo contactar al middleware de AX: ' + String((e && e.message) || e), { payload, legible });
  }

  const d = r.data || {};
  if (!r.ok) {
    return {
      ok: false,
      http: r.status,
      payload,
      mensaje: null,
      error: d.error || `El middleware respondió HTTP ${r.status}.`,
      detalles_ax: d.detalles_ax || null,
      // El XML de un SOAP Fault es larguisimo; se recorta.
      xml: d.xml_crudo ? String(d.xml_crudo).slice(0, 1200) : null,
      legible,
    };
  }

  return {
    ok: true,
    http: r.status,
    payload,
    mensaje: d.mensaje || d.status || String(r.raw || '').slice(0, 300),
    error: null,
    detalles_ax: null,
    xml: null,
    legible,
  };
}
