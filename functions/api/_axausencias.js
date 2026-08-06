/* =====================================================================
   functions/api/_axausencias.js  —  MODULO COMPARTIDO (no es una ruta)
   Puente entre el vocabulario del PORTAL y el de AX 2012 para los
   PERIODOS DE AUSENCIA (AIFJustifiedAbsent / insertAbsentRecord).

   Hermano de _axmarcajes.js, pero OJO: el contrato se parece y el
   comportamiento NO. Lo que sirve para marcajes aca rompe cosas.

   ---------------------------------------------------------------------
   CONTRATO  (verificado con inserciones reales el 05/08/2026)
   ---------------------------------------------------------------------
   POST https://api.grupocanaima.com/empleados/ausencias/v1
   Cuerpo: un ARRAY de registros. Cada uno:

     personnelNumber  la cedula, SOLO DIGITOS.
                      NO lleva alias ni empresa: a diferencia de los
                      marcajes, AX ubica al trabajador por su cedula.
     fromDate         'AAAA-MM-DD'   (el middleware le agrega T00:00:00)
     toDate           'AAAA-MM-DD'
     state            HRAbsenceState NUMERICO (ver AX_STATE_BY_CODE)
     approvedState    0 Review · 1 Approved · 2 Rejected

   RESPUESTA — y aca esta la buena noticia:

     201  { status:'success', message:'Éxito: Se insertaron 1 registros correctamente.' }
     207  { status:'partial',  message:'Parcial: ...' }
     400  { status:'error',    message:'Error: 1 fallidos. Detalles:
                                        Fallo (28772674): Los rangos de fechas
                                        se superponen con otro registro para
                                        el mismo empleado.  | ' }

   Esta API SI dice la verdad en el codigo HTTP, al reves que la de
   marcajes (que contestaba 200 y "Exito" aunque una linea no entrara).

   ---------------------------------------------------------------------
   LA REGLA QUE MANDA: DE A UNA LINEA, NUNCA EN LOTE
   ---------------------------------------------------------------------
   AX RECHAZA un periodo que se superpone con otro del mismo empleado. No
   actualiza ni omite: rechaza. Y el mensaje de error es EXACTAMENTE EL
   MISMO tanto si la linea ya la mandamos nosotros como si choca con una
   ausencia distinta cargada por otra via.

   De ahi salen dos consecuencias, y las dos estan en el codigo:

   1) NO SE REINTENTA A CIEGAS. Reenviar una linea que ya entro devuelve
      ese error, y la marcariamos como fallida cuando esta bien cargada.
      Por eso ax_ausencias_log es fuente de verdad, no bitacora: lo que
      figura 'ok' no se manda nunca mas.

   2) SE MANDA DE A UNA. Con un solo registro por llamada el resultado es
      inequivoco -201 entro, cualquier otra cosa no entro- y no hay que
      interpretar el texto de "Detalles:". Eso importa porque el detalle
      identifica al trabajador por CEDULA: si un reporte trae dos periodos
      del mismo empleado, "Fallo (28772674)" no dice cual de los dos fallo.
      En lote eso es ambiguo; de a una, el problema no existe.

   El costo es una llamada HTTP por linea. Con ausencias no hay apuro ni
   riesgo de baneo, y los reportes son chicos: es barato al lado de cargar
   mal una ausencia en el sistema que paga la nomina.
   ===================================================================== */

import { axKey, axCall } from './_axmarcajes.js';

export const AX_AUSENCIAS_URL_DEFAULT = 'https://api.grupocanaima.com/empleados/ausencias/v1';

/* HRAbsenceState de AX. Los 10 tipos del portal (absence_types.ax_code)
   entran los 10, sin huerfanos. Los numeros que faltan existen en AX pero
   el portal no los reporta (RestDay, PublicHoliday, BusinessTrip,
   training, Bereavement, Authorized, Suspended, Location, AuthorizedBonus). */
export const AX_STATE_BY_CODE = {
  VAC: 2,    // Vacation
  REP: 4,    // MedicalRest — "Reposo"
  PRE: 5,    // PreNatal
  POS: 6,    // PostNatal
  PAT: 7,    // Paternity
  MAT: 11,   // Marriage
  EME: 12,   // Emergency
  MUD: 13,   // Moving
  FUE: 14,   // ForceMajeure
  LAC: 18,   // Lactation
};

/* Estado de aprobacion con el que entran las ausencias del portal.
   0 = Review (decision del 05/08/2026): publicar desde el portal NO
   aprueba nada, deja el registro cargado para que alguien lo apruebe
   dentro de AX. */
export const AX_APPROVED_STATE = 0;

export function axAusBase(env) {
  return String((env && env.ax_ausencias_url) || AX_AUSENCIAS_URL_DEFAULT).replace(/\/+$/, '');
}

/* Ping de vida. No escribe nada. */
export async function axAusHealth(env) {
  const key = axKey(env);
  const url = `${axAusBase(env)}/health`;
  if (!key) return { ok: false, url, http: 0, error: 'Falta el secret canaima_apikey (o ax_api_key).' };
  const r = await axCall(url, key, { method: 'GET' });
  return { ok: r.ok, url, http: r.status, respuesta: r.data || String(r.raw || '').slice(0, 500) };
}

/* =====================================================================
   normalizeAusencia — valida y traduce UNA linea del portal al payload
   de AX. No llama a nadie. Devuelve { ok, payload, legible, error }.
   ===================================================================== */
export function normalizeAusencia(rec = {}) {
  const bad = (error) => ({ ok: false, payload: null, legible: null, error });

  const personnelNumber = String(rec.personnelNumber || '').replace(/\D+/g, '');
  const fromDate = String(rec.dateFrom || '').trim().slice(0, 10);
  const toDate = String(rec.dateTo || '').trim().slice(0, 10);
  const code = String(rec.absenceCode || '').trim().toUpperCase();

  if (!personnelNumber) return bad('Falta la cédula del trabajador.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return bad('La fecha desde debe venir como AAAA-MM-DD.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return bad('La fecha hasta debe venir como AAAA-MM-DD.');
  if (toDate < fromDate) return bad('La fecha hasta no puede ser anterior a la fecha desde.');

  const state = AX_STATE_BY_CODE[code];
  if (state === undefined) {
    return bad(`El tipo de ausencia "${code || '(vacío)'}" no tiene equivalente en AX.`);
  }

  const approvedState = Number.isInteger(rec.approvedState) ? rec.approvedState : AX_APPROVED_STATE;

  return {
    ok: true,
    payload: { personnelNumber, fromDate, toDate, state, approvedState },
    legible: fromDate === toDate ? fromDate : `${fromDate} → ${toDate}`,
    error: null,
  };
}

/* Saca de la respuesta de error el motivo limpio, sin el andamiaje.
   De:  "Error: 1 fallidos. Detalles: Fallo (28772674): Los rangos de fechas
         se superponen con otro registro para el mismo empleado.  | "
   Sale: "Los rangos de fechas se superponen con otro registro para el mismo empleado."
   Si no reconoce la forma devuelve el mensaje entero: mejor un texto feo
   que perder el motivo. */
export function motivoDeAX(mensaje) {
  const s = String(mensaje == null ? '' : mensaje).trim();
  if (!s) return null;
  const m = s.match(/Fallo\s*\([^)]*\)\s*:\s*([\s\S]+?)\s*(?:\|\s*)*$/i);
  if (m && m[1]) return m[1].trim();
  const d = s.match(/Detalles:\s*([\s\S]+?)\s*(?:\|\s*)*$/i);
  if (d && d[1]) return d[1].trim();
  return s;
}

/* =====================================================================
   axEnviarAusencia — manda UNA linea. Devuelve SIEMPRE la misma forma:
     { ok, http, payload, mensaje, error, legible }

   ok es true SOLO con HTTP 201. Cualquier otra cosa es "no entro": no se
   interpreta el texto, no se adivina. Con un registro por llamada eso
   alcanza y sobra.
   ===================================================================== */
export async function axEnviarAusencia(env, rec = {}) {
  const n = normalizeAusencia(rec);
  if (!n.ok) {
    return { ok: false, http: 0, payload: null, mensaje: null, error: n.error, legible: null };
  }
  const key = axKey(env);
  if (!key) {
    return {
      ok: false, http: 0, payload: n.payload, mensaje: null, legible: n.legible,
      error: 'Falta el secret canaima_apikey (o ax_api_key) en las variables del proyecto.',
    };
  }

  let r;
  try {
    // El middleware exige una LISTA aunque venga un solo registro.
    r = await axCall(axAusBase(env), key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([n.payload]),
    });
  } catch (e) {
    return {
      ok: false, http: 0, payload: n.payload, mensaje: null, legible: n.legible,
      error: 'No se pudo contactar al middleware de AX: ' + String((e && e.message) || e),
    };
  }

  const d = r.data || {};
  if (r.status === 201) {
    return {
      ok: true, http: 201, payload: n.payload, legible: n.legible,
      mensaje: d.message || 'Registrada en AX.', error: null,
    };
  }

  return {
    ok: false,
    http: r.status,
    payload: n.payload,
    legible: n.legible,
    mensaje: d.message || null,
    error: motivoDeAX(d.message) || d.error || `El middleware respondió HTTP ${r.status}.`,
  };
}

/* =====================================================================
   axPublicarAusencias(env, recs) — publica N lineas, UNA POR LLAMADA.

   No hay modo lote a proposito (ver el encabezado). Devuelve:
     { ok, enviadas, publicadas, fallidas, llamadas,
       resultados: [ { idx, ok, payload, legible, mensaje, error } ] }
   resultados viene en el MISMO orden que recs.
   ===================================================================== */
export async function axPublicarAusencias(env, recs) {
  const lista = Array.isArray(recs) ? recs : [];
  const resultados = [];
  let llamadas = 0;

  for (let i = 0; i < lista.length; i++) {
    const r = await axEnviarAusencia(env, lista[i]);
    if (r.http) llamadas++;
    resultados.push({ idx: i, ...r });
  }

  const publicadas = resultados.filter(r => r.ok).length;
  return {
    ok: publicadas === resultados.length && resultados.length > 0,
    enviadas: resultados.length,
    publicadas,
    fallidas: resultados.length - publicadas,
    llamadas,
    resultados,
  };
}
