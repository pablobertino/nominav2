/* =====================================================================
   functions/api/_axcargo.js  —  MODULO COMPARTIDO (no es una ruta)
   Puente entre el vocabulario del PORTAL y el de AX 2012 para los CAMBIOS
   DE CARGO y TRASLADOS (AIFChangeWorkerPosition / updateWorkerPositions).

   Hermano de _axingreso.js, _axegreso.js, _axmarcajes.js y _axausencias.js.

   ---------------------------------------------------------------------
   CONTRATO
   ---------------------------------------------------------------------
   POST https://api.grupocanaima.com/empleados/cambioCargo/v1
   Cuerpo: un ARRAY. Cada item:

     personnelNumber  cedula, solo digitos          OBLIGATORIO
     position         el JobId de AX (ax_code)      OBLIGATORIO
     validFrom        'AAAA-MM-DD' o 'DD/MM/AAAA'   OBLIGATORIO
     companyAlias     alias de la empresa destino   solo en traslado
     dataAreaId       entidad legal destino         alternativa al alias
     validTo          ultimo dia en la empresa origen   solo en traslado

   UN SOLO METODO PARA LAS DOS COSAS. Sin empresa destino = solo cambia el
   cargo. Con empresa destino = baja en origen + alta en destino. Y si
   ademas viene un cargo distinto, las dos cosas pasan EN LA MISMA LLAMADA.
   Eso es lo que se gano al unificar: antes eran dos operaciones SOAP
   distintas y habia que decidir cual mandar.

   ---------------------------------------------------------------------
   LA REGLA DE LAS FECHAS, QUE ES LO UNICO REALMENTE SUTIL
   ---------------------------------------------------------------------
   El portal guarda DOS juegos de fechas segun el tipo, y traducirlos mal
   es cambiarle a alguien el cargo el dia equivocado:

     ascenso / descenso / lateral   ->  fecha_efectiva            = validFrom
     traslado                       ->  fecha_alta                = validFrom
                                        fecha_baja                = validTo

   ⚠ validTo NO ES UNA FECHA DE EGRESO, aunque el middleware acepte los
   alias 'fechaSalida' y 'exitDate' para el mismo campo. Significa "ultimo
   dia del cargo en la empresa ORIGEN de un traslado". Terminar la relacion
   laboral es otro servicio (AIFWorkerExit, ver _axegreso.js) con otro
   contrato de dos campos. Mandar un egreso por aca no da error: la linea
   cae en 'ignorados' y la respuesta sigue siendo 200 success. Por eso el
   egreso se rechaza ACA, antes de salir.

   ⚠ validTo tiene que ser ANTERIOR a validFrom, no igual. Es la misma
   regla que ya valida el wizard (fechaA > fechaB), asi que los dos lados
   coinciden. Y ninguno de los dos exige que sean dias consecutivos: puede
   haber dias sin empresa entre un traslado y otro, y eso es valido.

   ---------------------------------------------------------------------
   TRES COSAS QUE NO SE VEN Y HAY QUE SABER
   ---------------------------------------------------------------------
   1) EL XML NO SE ESCAPA DEL OTRO LADO. El middleware interpola los
      valores crudos en el sobre SOAP (`<b:{tag}>{value}</b:{tag}>`). Un
      "&" rompe el XML entero y AX contesta un error que no se parece a la
      causa. Se escapa de este lado, igual que en ingresos.

   2) EL MIDDLEWARE NO VALIDA CASI NADA. La cedula, los duplicados del
      lote y el formato del alias se validan en el HTML de ejemplo, en el
      navegador — no en la API. Como nosotros llamamos desde el servidor,
      esa red no nos cubre y hay que tenderla aca.

   3) LAS LINEAS DESCARTADAS VIAJAN EN 'ignorados' CON HTTP 200. Quien no
      lea ese array cree que entraron todas. Es el mismo patron que ya nos
      mordio en otros lados: una falla que se ve saludable.

   ---------------------------------------------------------------------
   LO QUE ESTE MODULO TODAVIA NO SABE
   ---------------------------------------------------------------------
   Como INTERPRETAR la respuesta. En egresos se descubrio que el .py que
   circula NO es lo que esta desplegado (el desplegado tiene logica por
   trabajador y devuelve contadores), y que estas APIs contestan 200 y
   "success" aunque la linea no haya entrado. Hasta que la probe
   (ax-cargo.js) diga como contesta ESTA, aca se traduce y se manda; leer
   el veredicto es responsabilidad de quien llama.
   ===================================================================== */

import { axKey, axCall } from './_axmarcajes.js';
import { escXml } from './_axegreso.js';

export const AX_CARGO_URL_DEFAULT = 'https://api.grupocanaima.com/empleados/cambioCargo/v1';

/* Los tipos del portal que SI se publican por esta via. 'egreso' no esta
   y no es un olvido: ver la advertencia de arriba. */
export const TIPOS_CARGO = new Set(['ascenso', 'descenso', 'lateral', 'traslado']);

export function axCargoBase(env) {
  return String((env && env.ax_cambiocargo_url) || AX_CARGO_URL_DEFAULT).replace(/\/+$/, '');
}

/* Ping de vida. No escribe nada. */
export async function axCargoHealth(env) {
  const key = axKey(env);
  const url = `${axCargoBase(env)}/health`;
  if (!key) return { ok: false, url, http: 0, error: 'Falta el secret canaima_apikey (o ax_api_key).' };
  const r = await axCall(url, key, { method: 'GET' });
  return { ok: r.ok, url, http: r.status, respuesta: r.data || String(r.raw || '').slice(0, 500) };
}

const fecha10 = (v) => {
  const s = String(v == null ? '' : v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
};

/* Las 211 empresas del portal tienen company_code de 4 caracteres y todas
   cumplen este patron (verificado). Una que no lo cumpla es un dato malo,
   no una empresa rara: mejor frenarla aca que que AX la rechace con un
   mensaje que no se entiende. */
const RE_ALIAS = /^[A-Z0-9]{4}$/;

/* =====================================================================
   normalizeCargo — valida y traduce UN movimiento del portal al payload.
   No llama a nadie. Devuelve { ok, payload, legible, error, avisos }.

   `position` tiene que llegar YA RESUELTO al ax_code (CAJERO -> CAJEROS).
   Ese mapeo vive en nomina_v2.cargos y lo hace quien llama, que es el que
   tiene la base a mano — mismo criterio que dataAreaId en _axingreso.js.
   Aca se exige que venga: un ax_code faltante NO se reemplaza por el code
   del portal, porque mandar 'CAJERO' donde AX espera 'CAJEROS' es pedirle
   a AX que adivine.
   ===================================================================== */
export function normalizeCargo(rec = {}) {
  const bad = (error) => ({ ok: false, payload: null, legible: null, error, avisos: [] });
  const avisos = [];

  const tipo = String(rec.tipo || '').trim().toLowerCase();
  if (!tipo) return bad('Falta el tipo de movimiento.');
  if (tipo === 'egreso') {
    return bad('Un egreso no se publica por esta vía: va por AIFWorkerExit (/empleados/finalizar/v1).');
  }
  if (!TIPOS_CARGO.has(tipo)) return bad(`Tipo de movimiento desconocido: "${tipo}".`);

  const personnelNumber = String(rec.personnelNumber || rec.id_number || '').replace(/\D+/g, '');
  if (!personnelNumber) return bad('Falta la cédula del trabajador.');
  if (personnelNumber.length < 6 || personnelNumber.length > 9) {
    return bad(`La cédula "${personnelNumber}" no tiene entre 6 y 9 dígitos.`);
  }

  const position = String(rec.position || '').trim();
  if (!position) {
    return bad('Falta el cargo de AX (ax_code). Ese cargo del portal no tiene equivalente cargado en AX.');
  }

  const esTraslado = tipo === 'traslado';
  const p = { personnelNumber, position: escXml(position) };

  if (esTraslado) {
    /* El alias manda. dataAreaId se acepta si quien llama lo trae resuelto,
       pero no se inventa: el middleware acepta cualquiera de los dos y AX
       valida que coincidan si van los dos. */
    const alias = String(rec.companyAlias || rec.empresa_destino || '').trim().toUpperCase();
    if (!alias) return bad('Un traslado necesita la empresa destino.');
    if (!RE_ALIAS.test(alias)) return bad(`La empresa destino "${alias}" no tiene la forma esperada (4 caracteres).`);
    p.companyAlias = escXml(alias);

    const dataAreaId = String(rec.dataAreaId || '').trim();
    if (dataAreaId) p.dataAreaId = escXml(dataAreaId);

    const alta = fecha10(rec.validFrom || rec.fecha_alta);
    const baja = fecha10(rec.validTo || rec.fecha_baja);
    if (!alta) return bad('Falta la fecha de alta en la empresa destino (AAAA-MM-DD).');
    if (!baja) return bad('Falta la fecha de baja en la empresa origen (AAAA-MM-DD).');
    if (baja >= alta) {
      return bad(`La baja (${baja}) tiene que ser anterior al alta (${alta}).`);
    }
    p.validFrom = alta;
    p.validTo = baja;

    /* No es un error, pero conviene contarlo: un traslado que ademas cambia
       el cargo hace dos cosas en una sola llamada, y si algo sale raro
       despues, saber que fue combinado ahorra media hora de mirar AX. */
    if (rec.cargoCambia) avisos.push('Este traslado además cambia el cargo: AX hace las dos cosas en una sola operación.');
  } else {
    /* Ascenso, descenso o lateral: misma empresa, una sola fecha, y NADA de
       validTo. Si se colara, el middleware descartaria la linea entera con
       "validTo solo aplica a transferencia" y devolveria 200 igual. */
    const efectiva = fecha10(rec.validFrom || rec.fecha_efectiva);
    if (!efectiva) return bad('Falta la fecha efectiva del cambio (AAAA-MM-DD).');
    p.validFrom = efectiva;

    if (rec.validTo || rec.fecha_baja) {
      avisos.push('Un cambio de cargo en la misma empresa no lleva fecha de salida: se omitió.');
    }
    if (rec.companyAlias || rec.empresa_destino) {
      /* Esto no se avisa, se frena: con empresa destino el middleware lo
         trataria como TRASLADO y movería a la persona de empresa. Un
         ascenso convertido en traslado por un campo de mas no es un aviso,
         es un accidente. */
      return bad('Un ascenso/descenso no puede llevar empresa destino: sería un traslado.');
    }
  }

  const legible = esTraslado
    ? `${personnelNumber} · ${position} · ${p.companyAlias} · baja ${p.validTo} → alta ${p.validFrom}`
    : `${personnelNumber} · ${position} · desde ${p.validFrom}`;

  return { ok: true, payload: p, legible, error: null, avisos };
}

/* =====================================================================
   axEnviarCargo — manda UNA linea. Devuelve SIEMPRE la misma forma:
     { ok, http, payload, mensaje, error, legible, avisos, crudo }

   DE A UNA, igual que ingresos y ausencias. El middleware hace
   get_xml_value(root,'response'), que toma el PRIMER tag: con ocho lineas
   y tres fallas no habria forma de saber cuales. Y aca pesa doble porque
   la operacion NO es idempotente: reintentar un lote para recuperar tres
   lineas vuelve a aplicar las cinco que si entraron.

   `crudo` se devuelve siempre: mientras no sepamos como contesta esta API
   en particular, el texto tal cual es la mejor pista que hay.
   ===================================================================== */
export async function axEnviarCargo(env, rec = {}) {
  const n = normalizeCargo(rec);
  if (!n.ok) {
    return { ok: false, http: 0, payload: null, mensaje: null, error: n.error, legible: null, avisos: [], crudo: null };
  }
  const key = axKey(env);
  if (!key) {
    return {
      ok: false, http: 0, payload: n.payload, mensaje: null, legible: n.legible, avisos: n.avisos, crudo: null,
      error: 'Falta el secret canaima_apikey (o ax_api_key) en las variables del proyecto.',
    };
  }

  let r;
  try {
    r = await axCall(axCargoBase(env), key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([n.payload]),
    });
  } catch (e) {
    return {
      ok: false, http: 0, payload: n.payload, mensaje: null, legible: n.legible, avisos: n.avisos, crudo: null,
      error: 'No se pudo contactar al middleware de AX: ' + String((e && e.message) || e),
    };
  }

  const d = r.data || {};
  const crudo = String(r.raw || '').slice(0, 2000);

  /* Mandando de a una, un 'ignorados' con algo adentro significa que ESTA
     linea se descarto. Es un fallo, no un exito parcial — y viene con
     HTTP 200 y status "success", que es justamente la trampa. */
  const ignorados = Array.isArray(d.ignorados) ? d.ignorados : [];
  if (ignorados.length) {
    return {
      ok: false, http: r.status, payload: n.payload, legible: n.legible, avisos: n.avisos, crudo,
      mensaje: d.message || null,
      error: 'El middleware descartó el movimiento: ' + ignorados.join(' | ').slice(0, 400),
    };
  }

  if (r.status === 200 && String(d.status || '').toLowerCase() === 'success') {
    return {
      ok: true, http: 200, payload: n.payload, legible: n.legible, avisos: n.avisos, crudo,
      mensaje: d.message || 'Movimiento registrado en AX.', error: null,
    };
  }

  const detalle = d.details ? String(d.details).replace(/\s+/g, ' ').trim().slice(0, 400) : '';
  return {
    ok: false,
    http: r.status,
    payload: n.payload,
    legible: n.legible,
    avisos: n.avisos,
    crudo,
    mensaje: d.message || null,
    error: [d.error || `El middleware respondió HTTP ${r.status}.`, detalle].filter(Boolean).join(' — '),
  };
}
