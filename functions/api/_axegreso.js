/* =====================================================================
   functions/api/_axegreso.js  —  MODULO COMPARTIDO (no es una ruta)
   Puente entre el vocabulario del PORTAL y el de AX 2012 para los EGRESOS
   (AIFWorkerExit / exitWorker).

   Hermano de _axmarcajes.js y _axausencias.js. Igual que con ausencias:
   el contrato se parece y el comportamiento NO.

   ---------------------------------------------------------------------
   CONTRATO
   ---------------------------------------------------------------------
   POST https://api.grupocanaima.com/empleados/finalizar/v1
   Cuerpo: un ARRAY. Cada item:

     personnelNumber   la cedula, SOLO DIGITOS
     fechaEgreso       'AAAA-MM-DD'  (el middleware le agrega T00:00:00)

   Respuesta:
     200  { status:'success', message:'<texto libre que devolvio AX>' }
     !200 { error:'AX Respondio con codigo N', details:'<XML crudo de AX>' }

   ---------------------------------------------------------------------
   POR QUE DE A UNA LINEA, COMO EN AUSENCIAS Y NO COMO EN MARCAJES
   ---------------------------------------------------------------------
   El middleware hace `get_xml_value(root, 'response')`, que devuelve EL
   PRIMER tag que encuentra. Mandes uno o mandes ocho, vuelve UN solo texto
   libre. No hay contadores como los "Insertados/Actualizados/Omitidos" de
   marcajes, que era lo unico que alli permitia verificar por aritmetica.

   Con un lote de ocho y tres fallas, no habria forma de saber cuales. Con
   un registro por llamada el resultado es inequivoco. El costo es una
   llamada HTTP por persona; es barato al lado de cerrarle la relacion
   laboral a quien no correspondia.

   ---------------------------------------------------------------------
   DOS DEFECTOS DE LA API QUE TAPAMOS DE ESTE LADO
   ---------------------------------------------------------------------
   1) DESCARTA EN SILENCIO. El middleware hace `if personnel and fecha:`
      SIN else: un item al que le falte la fecha no se manda y la API
      igual responde 200 "success". Por eso validamos ANTES: una linea
      incompleta no sale de aca, y se reporta como error nuestro en vez de
      desaparecer sin dejar rastro.

   2) NO ESCAPA EL XML. Los valores se interpolan crudos en el sobre SOAP.
      Acá solo viajan cedula y fecha —ambas numericas— asi que el riesgo es
      bajo, pero se escapa igual por si el dia de mañana el contrato suma
      un campo de texto. En ingreso el problema es real (ver _axingreso).
   ===================================================================== */

import { axKey, axCall } from './_axmarcajes.js';

export const AX_EGRESO_URL_DEFAULT = 'https://api.grupocanaima.com/empleados/finalizar/v1';

export function axEgrBase(env) {
  return String((env && env.ax_egreso_url) || AX_EGRESO_URL_DEFAULT).replace(/\/+$/, '');
}

/* Ping de vida. No escribe nada. */
export async function axEgrHealth(env) {
  const key = axKey(env);
  const url = `${axEgrBase(env)}/health`;
  if (!key) return { ok: false, url, http: 0, error: 'Falta el secret canaima_apikey (o ax_api_key).' };
  const r = await axCall(url, key, { method: 'GET' });
  return { ok: r.ok, url, http: r.status, respuesta: r.data || String(r.raw || '').slice(0, 500) };
}

/* El middleware interpola los valores CRUDOS dentro del XML del SOAP. Un
   caracter reservado rompe el sobre entero y AX devuelve un error que no
   se parece en nada a la causa. Se escapa de este lado porque no controlamos
   el de ellos. */
export const escXml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/* =====================================================================
   normalizeEgreso — valida y traduce UNA linea. No llama a nadie.
   Devuelve { ok, payload, legible, error }.

   OJO CON LA FECHA: el portal guarda dos, report_date y real_date, y aca
   va la REPORTADA. real_date puede caer en un periodo de nomina ya
   calculado —los calculos corren 48h o menos hacia atras— mientras que
   report_date ya viene validada contra la ventana reportable del portal.
   Quien llama decide cual manda; este modulo solo exige que sea una fecha.
   ===================================================================== */
export function normalizeEgreso(rec = {}) {
  const bad = (error) => ({ ok: false, payload: null, legible: null, error });

  /* Solo digitos, igual que marcajes y ausencias. El HTML de ejemplo del
     proveedor usa "000150", que parece el numero interno de AX y no una
     cedula; en ingreso el mismo campo valida V/E/J + 6-9 digitos. Si la
     probe confirma que finalizar/v1 espera el numero interno, ESTA LINEA
     es la unica que cambia. */
  const personnelNumber = String(rec.personnelNumber || '').replace(/\D+/g, '');
  const fechaEgreso = String(rec.fechaEgreso || '').trim().slice(0, 10);

  if (!personnelNumber) return bad('Falta la cédula del trabajador.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaEgreso)) {
    return bad('La fecha de egreso debe venir como AAAA-MM-DD.');
  }

  return {
    ok: true,
    payload: { personnelNumber: escXml(personnelNumber), fechaEgreso: escXml(fechaEgreso) },
    legible: fechaEgreso,
    error: null,
  };
}

/* =====================================================================
   axEnviarEgreso — manda UNA linea. Devuelve SIEMPRE la misma forma:
     { ok, http, payload, mensaje, error, legible }

   ok es true SOLO con HTTP 200 y status 'success'. No se interpreta el
   texto del mensaje: con un registro por llamada, el codigo alcanza.
   ===================================================================== */
export async function axEnviarEgreso(env, rec = {}) {
  const n = normalizeEgreso(rec);
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
    r = await axCall(axEgrBase(env), key, {
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
  if (r.status === 200 && String(d.status || '').toLowerCase() === 'success') {
    return {
      ok: true, http: 200, payload: n.payload, legible: n.legible,
      mensaje: d.message || 'Egreso registrado en AX.', error: null,
    };
  }

  /* En el fallo, 'details' trae el XML crudo de AX. Se recorta pero no se
     descarta: es lo unico que explica por que no entro. */
  const detalle = d.details ? String(d.details).replace(/\s+/g, ' ').trim().slice(0, 400) : '';
  return {
    ok: false,
    http: r.status,
    payload: n.payload,
    legible: n.legible,
    mensaje: d.message || null,
    error: [d.error || `El middleware respondió HTTP ${r.status}.`, detalle].filter(Boolean).join(' — '),
  };
}

/* =====================================================================
   axPublicarEgresos(env, recs) — publica N lineas, UNA POR LLAMADA.
   No hay modo lote a proposito (ver el encabezado). Devuelve:
     { ok, enviadas, publicadas, fallidas, llamadas,
       resultados: [ { idx, ok, payload, legible, mensaje, error } ] }
   El orden de `resultados` es EL MISMO que el de `recs`: quien llama los
   aparea por indice para escribir la bitacora.
   ===================================================================== */
export async function axPublicarEgresos(env, recs = []) {
  const lista = Array.isArray(recs) ? recs : [];
  const resultados = [];
  let publicadas = 0, fallidas = 0, llamadas = 0;

  for (let i = 0; i < lista.length; i++) {
    const r = await axEnviarEgreso(env, lista[i]);
    if (r.http > 0) llamadas++;
    if (r.ok) publicadas++; else fallidas++;
    resultados.push({ idx: i, ...r });
  }

  return {
    ok: fallidas === 0,
    enviadas: lista.length,
    publicadas,
    fallidas,
    llamadas,
    resultados,
  };
}
