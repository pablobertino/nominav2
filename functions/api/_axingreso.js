/* =====================================================================
   functions/api/_axingreso.js  —  MODULO COMPARTIDO (no es una ruta)
   Puente entre el vocabulario del PORTAL y el de AX 2012 para los INGRESOS
   (AIFHireWorker / insertWorkers).

   Hermano de _axmarcajes.js, _axausencias.js y _axegreso.js.

   ---------------------------------------------------------------------
   CONTRATO
   ---------------------------------------------------------------------
   POST https://api.grupocanaima.com/empleados/ingreso/v1
   Cuerpo: un ARRAY. Cada item (obligatorios en MAYUSCULA):

     PERSONNELNUMBER  cedula, solo digitos
     FIRSTNAME        primer nombre
     LASTNAME         apellidos
     VALIDFROM        fecha de ingreso ('AAAA-MM-DD' o 'DD/MM/AAAA')
     middleName, validTo, position, dataAreaId, email, phone,
     bankAccount, birthDate, address
     todoTicket  S|N        -> el middleware traduce a Yes/No
     gender      M|F        -> Male/Female
     maritalStatus S|C|D|V  -> Single/Married/Divorced/Widowed

   Respuesta:
     200  { status:'success', message:'<texto libre de AX>', ignorados?:[...] }
     !200 { error:'AX Respondio con codigo N', details:'<XML crudo>' }

   ---------------------------------------------------------------------
   DE A UNA LINEA, IGUAL QUE AUSENCIAS Y EGRESO
   ---------------------------------------------------------------------
   El middleware devuelve UN solo texto libre para todo el lote (hace
   get_xml_value(root,'response'), que toma el primer tag). No hay
   contadores como en marcajes. Con ocho ingresos y tres fallas no habria
   forma de saber cuales. De a uno, el resultado es inequivoco — y aca
   importa mas que en ningun otro lado, porque una linea que entra CREA UNA
   PERSONA en AX: si se manda dos veces, queda duplicada.

   ---------------------------------------------------------------------
   TRES COSAS QUE NO SE VEN Y HAY QUE SABER
   ---------------------------------------------------------------------
   1) EL XML NO SE ESCAPA DEL OTRO LADO. El middleware interpola los
      valores crudos en el sobre SOAP. Aca viajan nombre, apellido y
      DIRECCION, que es texto libre que carga la tienda: un "&" o un "<"
      rompe el XML entero y AX contesta un error que no se parece a la
      causa. Se escapa de este lado. No es un lujo: es cuestion de tiempo.

   2) LOS CAMPOS VACIOS NO VIAJAN. El middleware arma cada tag con
      `if value`, asi que lo que va vacio simplemente no se envia y AX pone
      su valor por defecto. Para un ingreso esta bien -la ficha nace- pero
      significa que por esta via NO se puede limpiar un dato.

   3) EL PORTAL TIENE MAS ESTADOS CIVILES QUE AX. El portal maneja
      S/C/D/V/O/R y el mapa del middleware solo S/C/D/V. Una ficha con "O"
      u "R" entra a AX SIN estado civil, en silencio. Se avisa en el
      resultado para que no sea una sorpresa despues.
   ===================================================================== */

import { axKey, axCall } from './_axmarcajes.js';
import { cleanPhone, cleanEmail } from './_contacto.js';
import { escXml } from './_axegreso.js';

export const AX_INGRESO_URL_DEFAULT = 'https://api.grupocanaima.com/empleados/ingreso/v1';

/* Los que el middleware SI sabe traducir. Un valor fuera de estas listas
   no se manda (mejor sin dato que con un dato inventado). */
export const AX_GENDER = new Set(['M', 'F']);
export const AX_MARITAL = new Set(['S', 'C', 'D', 'V']);
export const AX_TODO = new Set(['S', 'N']);

export function axIngBase(env) {
  return String((env && env.ax_ingreso_url) || AX_INGRESO_URL_DEFAULT).replace(/\/+$/, '');
}

/* Ping de vida. No escribe nada. */
export async function axIngHealth(env) {
  const key = axKey(env);
  const url = `${axIngBase(env)}/health`;
  if (!key) return { ok: false, url, http: 0, error: 'Falta el secret canaima_apikey (o ax_api_key).' };
  const r = await axCall(url, key, { method: 'GET' });
  return { ok: r.ok, url, http: r.status, respuesta: r.data || String(r.raw || '').slice(0, 500) };
}

const fecha10 = (v) => {
  const s = String(v == null ? '' : v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
};
const texto = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s ? escXml(s) : '';
};

/* =====================================================================
   normalizeIngreso — valida y traduce UNA linea del portal al payload de
   AX. No llama a nadie. Devuelve { ok, payload, legible, error, avisos }.

   `avisos` son cosas que NO impiden publicar pero que conviene contar:
   un estado civil que AX no conoce, un telefono que no es un movil VE.
   ===================================================================== */
export function normalizeIngreso(rec = {}) {
  const bad = (error) => ({ ok: false, payload: null, legible: null, error, avisos: [] });
  const avisos = [];

  const personnelNumber = String(rec.personnelNumber || '').replace(/\D+/g, '');
  const firstName = texto(rec.firstName);
  const lastName = texto(rec.lastName);
  const validFrom = fecha10(rec.validFrom);

  if (!personnelNumber) return bad('Falta la cédula del trabajador.');
  if (!firstName) return bad('Falta el primer nombre.');
  if (!lastName) return bad('Faltan los apellidos.');
  if (!validFrom) return bad('La fecha de ingreso debe venir como AAAA-MM-DD.');

  /* Se arma solo con lo que tiene valor: un campo vacio no viaja (el
     middleware lo omitiria igual, pero asi el payload que guardamos en la
     bitacora es exactamente lo que salio). */
  const p = { personnelNumber, firstName, lastName, validFrom };

  const middleName = texto(rec.middleName);
  if (middleName) p.middleName = middleName;

  const position = texto(rec.position);
  if (position) p.position = position;

  /* dataAreaId: la empresa de AX. OJO — en marcajes el campo equivalente se
     llamaba `alias` y esperaba el company_code (AL01), NO el data_area; aca
     el nombre coincide con el concepto de AX (DataAreaId = la entidad legal)
     y los ejemplos del proveedor usan '0010'/'9999', que tienen forma de
     data_area. Quien llama decide y pasa el valor ya resuelto; si la probe
     dice lo contrario, se cambia en el que llama y no aca. */
  const dataAreaId = texto(rec.dataAreaId);
  if (dataAreaId) p.dataAreaId = dataAreaId;

  const birthDate = fecha10(rec.birthDate);
  if (birthDate) p.birthDate = birthDate;

  const validTo = fecha10(rec.validTo);
  if (validTo) p.validTo = validTo;

  const address = texto(rec.address);
  if (address) p.address = address;

  /* Telefono y correo pasan por los mismos validadores que usa el sync.
     Un dato con mala forma no se manda: la ficha nace sin el, que es mejor
     que nacer con basura que despues nadie corrige. */
  const tel = cleanPhone(rec.phone);
  if (tel) p.phone = tel;
  else if (rec.phone) avisos.push('El teléfono no es un móvil venezolano válido: la ficha entra sin teléfono.');

  const mail = cleanEmail(rec.email);
  if (mail) p.email = escXml(mail);
  else if (rec.email) avisos.push('El correo no tiene forma válida: la ficha entra sin correo.');

  const cuenta = String(rec.bankAccount || '').replace(/\D+/g, '');
  if (cuenta.length === 20) p.bankAccount = cuenta;
  else if (cuenta) avisos.push('La cuenta bancaria no tiene 20 dígitos: la ficha entra sin cuenta.');

  const gender = String(rec.gender || '').trim().toUpperCase();
  if (AX_GENDER.has(gender)) p.gender = gender;
  else if (gender) avisos.push(`El género "${gender}" no tiene equivalente en AX: la ficha entra sin género.`);

  const marital = String(rec.maritalStatus || '').trim().toUpperCase();
  if (AX_MARITAL.has(marital)) p.maritalStatus = marital;
  else if (marital) {
    // El portal maneja S/C/D/V/O/R y AX solo los cuatro primeros.
    avisos.push(`El estado civil "${marital}" no existe en AX: la ficha entra sin estado civil.`);
  }

  const todo = String(rec.todoTicket || '').trim().toUpperCase();
  if (AX_TODO.has(todo)) p.todoTicket = todo;

  return {
    ok: true,
    payload: p,
    legible: `${firstName} ${lastName} · desde ${validFrom}`,
    error: null,
    avisos,
  };
}

/* =====================================================================
   axEnviarIngreso — manda UNA linea. Devuelve SIEMPRE la misma forma:
     { ok, http, payload, mensaje, error, legible, avisos }
   ===================================================================== */
export async function axEnviarIngreso(env, rec = {}) {
  const n = normalizeIngreso(rec);
  if (!n.ok) {
    return { ok: false, http: 0, payload: null, mensaje: null, error: n.error, legible: null, avisos: [] };
  }
  const key = axKey(env);
  if (!key) {
    return {
      ok: false, http: 0, payload: n.payload, mensaje: null, legible: n.legible, avisos: n.avisos,
      error: 'Falta el secret canaima_apikey (o ax_api_key) en las variables del proyecto.',
    };
  }

  let r;
  try {
    r = await axCall(axIngBase(env), key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([n.payload]),
    });
  } catch (e) {
    return {
      ok: false, http: 0, payload: n.payload, mensaje: null, legible: n.legible, avisos: n.avisos,
      error: 'No se pudo contactar al middleware de AX: ' + String((e && e.message) || e),
    };
  }

  const d = r.data || {};

  /* 'ignorados' son las lineas que el middleware descarto por validacion
     propia. Mandando de a una, si viene con algo es que ESTA linea se
     descarto: es un fallo, no un exito parcial. */
  const ignorados = Array.isArray(d.ignorados) ? d.ignorados : [];
  if (r.status === 200 && String(d.status || '').toLowerCase() === 'success' && !ignorados.length) {
    return {
      ok: true, http: 200, payload: n.payload, legible: n.legible, avisos: n.avisos,
      mensaje: d.message || 'Ingreso registrado en AX.', error: null,
    };
  }
  if (ignorados.length) {
    return {
      ok: false, http: r.status, payload: n.payload, legible: n.legible, avisos: n.avisos,
      mensaje: d.message || null,
      error: 'El middleware descartó la ficha: ' + ignorados.join(' | ').slice(0, 400),
    };
  }

  const detalle = d.details ? String(d.details).replace(/\s+/g, ' ').trim().slice(0, 400) : '';
  return {
    ok: false,
    http: r.status,
    payload: n.payload,
    legible: n.legible,
    avisos: n.avisos,
    mensaje: d.message || null,
    error: [d.error || `El middleware respondió HTTP ${r.status}.`, detalle].filter(Boolean).join(' — '),
  };
}

/* =====================================================================
   axPublicarIngresos(env, recs) — publica N lineas, UNA POR LLAMADA.
   El orden de `resultados` es EL MISMO que el de `recs`.
   ===================================================================== */
export async function axPublicarIngresos(env, recs = []) {
  const lista = Array.isArray(recs) ? recs : [];
  const resultados = [];
  let publicadas = 0, fallidas = 0, llamadas = 0;

  for (let i = 0; i < lista.length; i++) {
    const r = await axEnviarIngreso(env, lista[i]);
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
