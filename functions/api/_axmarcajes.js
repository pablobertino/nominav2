/* =====================================================================
   functions/api/_axmarcajes.js  —  MODULO COMPARTIDO (no es una ruta)
   Puente entre el vocabulario del PORTAL y el de AX 2012 para los
   marcajes (AIFFingerPrint / insertFingerprintRecord, expuesto por el
   middleware Flask de Sebastian).

   POR QUE UN MODULO Y NO CODIGO REPETIDO:
   la traduccion portal -> AX tiene tres trampas (el alias, la cedula y
   las horas en segundos) y la lectura de la respuesta tiene una cuarta,
   que es la peor de todas. Escritas dos veces, tarde o temprano una copia
   se queda vieja. Aca vive UNA sola version, y la usan tanto
   /api/ax-marcajes (diagnostico) como /api/reports-history (publish_ax).

   ---------------------------------------------------------------------
   CONTRATO DE AX  (verificado con pruebas reales el 05/08/2026)
   ---------------------------------------------------------------------
   PETICION: POST al endpoint con un ARRAY de marcajes (v6.168; antes era
   un objeto suelto). Cada elemento:

     alias           companies.company_code -> 'AE01', 'AN01', 'AL01'...
                     OJO: NO es el data_area. AX resuelve el data_area
                     solo a partir del alias; si le mandamos el data_area
                     el marcaje se escribe en la TIENDA EQUIVOCADA.
                     (AL01 tiene data_area 1139: no se parecen en nada.)
     personnelNumber la cedula, SOLO DIGITOS (sin V- ni E-).
     transDate       'AAAA-MM-DD'.
     dayType         'Workday' | 'RestDay'. El portal maneja 'L' | 'D'.
     timeEntry       SEGUNDOS DESDE MEDIANOCHE (08:30 -> 30600). No texto.
     timeExit        idem. En RestDay ambos van en 0.

   RESPUESTA — Y ACA ESTA LA TRAMPA:

     { "status": "Exito",
       "mensaje": "Proceso finalizado. Insertados: 0, Actualizados: 1,
                   Omitidos: 0. Detalles: [Trabajador 00000001 no encontrado]" }

   Ese ejemplo es REAL, y se mandaron DOS marcajes. Uno entro y el otro no
   existe... y aun asi el HTTP es 200 y el status dice "Exito". Si uno se
   guia por el codigo HTTP o por ese "Exito", cierra el reporte para
   siempre con una linea sin publicar.

   LA UNICA SEÑAL CONFIABLE ES LA ARITMETICA:
       Insertados + Actualizados + Omitidos  ==  cuantos mande
   Si da igual, entraron todas. Si falta, falta.

   Y "Detalles" NO sirve para detectar fallas: tambien lista las
   OMISIONES, que son exito ("Marcaje exacto ya existente omitido para
   26993183"). Es texto para leer, no para decidir.

   TRES COSAS MAS QUE QUEDARON CONFIRMADAS:
     - Omitir es EXITO. Un marcaje identico ya cargado se omite y punto:
       reenviar es inofensivo (idempotente).
     - Actualiza en el lugar: misma tienda + cedula + fecha con horas o
       tipo de dia distintos ACTUALIZA la fila existente, no duplica.
       Actualiza tambien el tipo de dia (probado L -> Descanso).
     - Hay COMMIT POR LINEA: un lote puede entrar a medias. Por eso el
       reintento aislado de mas abajo es seguro y necesario.

   Env vars: canaima_apikey (o ax_api_key), ax_marcajes_url (opcional).
   ===================================================================== */

export const AX_MARCAJES_URL_DEFAULT = 'https://api.grupocanaima.com/empleados/marcajes/v1';

/* HRDayType del lado de AX. Un dia de DESCANSO no lleva horas. */
export const AX_DAY_TYPES = new Set(['Workday', 'RestDay']);

/* Tope del reintento aislado. Cada linea aislada es un subrequest de
   Cloudflare, y el plan tiene un limite por invocacion. Si un lote grande
   falla, mejor devolver el diagnostico crudo que morir a mitad de camino
   sin guardar nada. */
export const AX_MAX_AISLADO = 40;

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
   Fault, y eso es informacion valiosa, no una excepcion que esconder. */
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
   parseAxCounters — saca los tres contadores del mensaje de AX.

   "Proceso finalizado. Insertados: 0, Actualizados: 1, Omitidos: 0.
    Detalles: [Trabajador 00000001 no encontrado]"
        -> { insertados:0, actualizados:1, omitidos:0, procesados:1,
             detalles:['Trabajador 00000001 no encontrado'] }

   Devuelve null si NO se pudieron leer los tres. Null significa "no se
   que paso", y quien llama debe tratarlo como sospecha, nunca como exito:
   si el dia de mañana cambia la redaccion del mensaje, el sistema tiene
   que volverse desconfiado, no optimista.
   ===================================================================== */
export function parseAxCounters(mensaje) {
  const s = String(mensaje == null ? '' : mensaje);
  const num = (re) => { const m = s.match(re); return m ? parseInt(m[1], 10) : null; };
  const insertados   = num(/Insertados:\s*(\d+)/i);
  const actualizados = num(/Actualizados:\s*(\d+)/i);
  const omitidos     = num(/Omitidos:\s*(\d+)/i);
  if (insertados === null || actualizados === null || omitidos === null) return null;

  const detalles = [];
  const dm = s.match(/Detalles:\s*([\s\S]+)$/i);
  if (dm) {
    const re = /\[([^\]]*)\]/g;
    let g;
    while ((g = re.exec(dm[1])) !== null) detalles.push(g[1].trim());
    if (!detalles.length && dm[1].trim()) detalles.push(dm[1].trim());
  }
  return {
    insertados, actualizados, omitidos,
    procesados: insertados + actualizados + omitidos,
    detalles,
  };
}

/* =====================================================================
   normalizeMarcaje — valida y traduce UN marcaje del portal al payload de
   AX. No llama a nadie. Devuelve { ok, payload, legible, error }.
   ===================================================================== */
export function normalizeMarcaje(rec = {}) {
  const bad = (error) => ({ ok: false, payload: null, legible: null, error });

  const alias = String(rec.alias || '').trim();
  // Cedula: solo digitos. El portal a veces arrastra 'V-' del roster.
  const personnelNumber = String(rec.personnelNumber || '').replace(/\D+/g, '');
  const transDate = String(rec.transDate || '').trim().slice(0, 10);
  const dayType = dayTypeToAx(rec.dayType);

  if (!alias) return bad('Falta el alias de la empresa.');
  if (!personnelNumber) return bad('Falta la cédula (número de personal).');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transDate)) return bad('La fecha debe venir como AAAA-MM-DD.');

  /* Descanso sin horas: se fuerzan a 0 aunque vengan cargadas. Es la misma
     regla de la plantilla AX del reporte de marcaje (en Descanso las
     columnas de entrada/salida van vacias) y evita mandarle a AX un
     descanso con horario, que no tiene sentido. */
  let entry = 0, exit = 0;
  if (dayType === 'Workday') {
    entry = hhmmToSeconds(rec.timeEntry);
    exit = hhmmToSeconds(rec.timeExit);
    if (entry === null) return bad('Hora de entrada inválida (usa HH:MM).');
    if (exit === null) return bad('Hora de salida inválida (usa HH:MM).');
    if (entry && exit && exit <= entry) {
      return bad('La hora de salida debe ser posterior a la de entrada.');
    }
  }

  return {
    ok: true,
    payload: { alias, personnelNumber, dayType, transDate, timeEntry: entry, timeExit: exit },
    legible: `${secondsToHHMM(entry)} -> ${secondsToHHMM(exit)}`,
    error: null,
  };
}

/* =====================================================================
   axSendLote — manda un ARRAY de payloads ya normalizados. Una sola
   llamada HTTP. Devuelve { ok, http, mensaje, error, detalles_ax, xml,
   counters } sin lanzar nunca.

   ok aca significa "el middleware contesto 200", NO "entraron todas".
   Para eso estan los counters.
   ===================================================================== */
export async function axSendLote(env, payloads) {
  const vacio = { ok: false, http: 0, mensaje: null, error: null, detalles_ax: null, xml: null, counters: null };
  if (!Array.isArray(payloads) || !payloads.length) {
    return { ...vacio, error: 'No hay marcajes que enviar.' };
  }
  const key = axKey(env);
  if (!key) {
    return { ...vacio, error: 'Falta el secret canaima_apikey (o ax_api_key) en las variables del proyecto.' };
  }

  let r;
  try {
    r = await axCall(axBase(env), key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloads),
    });
  } catch (e) {
    return { ...vacio, error: 'No se pudo contactar al middleware de AX: ' + String((e && e.message) || e) };
  }

  const d = r.data || {};
  if (!r.ok) {
    return {
      ok: false,
      http: r.status,
      mensaje: null,
      error: d.error || `El middleware respondió HTTP ${r.status}.`,
      detalles_ax: d.detalles_ax || null,
      // El XML de un SOAP Fault es larguisimo; se recorta.
      xml: d.xml_crudo ? String(d.xml_crudo).slice(0, 1200) : null,
      counters: null,
    };
  }

  const mensaje = d.mensaje || d.status || String(r.raw || '').slice(0, 500);
  return {
    ok: true, http: r.status, mensaje,
    error: null, detalles_ax: null, xml: null,
    counters: parseAxCounters(mensaje),
  };
}

/* =====================================================================
   axPublicarMarcajes(env, recs, opts) — LA FUNCION QUE HAY QUE USAR.

   Publica N marcajes y dice, de cada uno, si quedo o no. Estrategia:

     1) Normaliza todo. Lo que no pasa validacion ni se manda (via
        'validacion'): es un error nuestro, no de AX.
     2) Manda TODO lo valido en UNA sola llamada.
     3) Suma los contadores. Si  I + A + O  ==  lo que mande, entraron
        todas y termina aca. Este es el camino normal: una llamada.
     4) Si falta alguna (o el lote respondio error, o los contadores no se
        pudieron leer), REINTENTA UNA POR UNA. Un lote de uno no tiene
        ambiguedad posible: contadores en 1 = entro, en 0 = fallo, y
        "Detalles" trae su motivo. Reenviar las que ya habian entrado es
        inofensivo, porque AX las omite.
     5) Si hay demasiadas para aislar (AX_MAX_AISLADO), no se arriesga a
        quedarse sin subrequests: marca todas como fallidas y devuelve el
        mensaje crudo de AX para que un humano lo lea.

   opts: { aislar = true, maxAislado = AX_MAX_AISLADO }

   Devuelve:
     { ok, enviadas, publicadas, fallidas, llamadas, aislado,
       lote: { http, mensaje, counters, error, detalles_ax, xml },
       resultados: [ { idx, ok, payload, legible, mensaje, error,
                       detalles_ax, xml, via } ] }
   resultados viene en el MISMO orden que recs.
   ===================================================================== */
export async function axPublicarMarcajes(env, recs, opts = {}) {
  const aislar = opts.aislar !== false;
  const maxAislado = Number(opts.maxAislado) > 0 ? Number(opts.maxAislado) : AX_MAX_AISLADO;

  const lista = Array.isArray(recs) ? recs : [];
  const resultados = lista.map((rec, idx) => {
    const n = normalizeMarcaje(rec);
    return {
      idx,
      ok: false,
      payload: n.payload,
      legible: n.legible,
      mensaje: null,
      error: n.ok ? null : n.error,
      detalles_ax: null,
      xml: null,
      via: n.ok ? null : 'validacion',
    };
  });

  const validos = resultados.filter(r => r.payload);
  const salida = (extra = {}) => {
    const publicadas = resultados.filter(r => r.ok).length;
    return {
      ok: publicadas === resultados.length && resultados.length > 0,
      enviadas: resultados.length,
      publicadas,
      fallidas: resultados.length - publicadas,
      llamadas: 0, aislado: false,
      lote: null,
      resultados,
      ...extra,
    };
  };

  if (!validos.length) return salida();

  // ---- 2) el lote, de una sola vez ----
  const lote = await axSendLote(env, validos.map(r => r.payload));
  const loteInfo = {
    http: lote.http, mensaje: lote.mensaje, counters: lote.counters,
    error: lote.error, detalles_ax: lote.detalles_ax, xml: lote.xml,
  };

  // ---- 3) ¿la cuenta cuadra? ----
  const cuadra = lote.ok && lote.counters && lote.counters.procesados === validos.length;
  if (cuadra) {
    validos.forEach(r => {
      r.ok = true;
      r.mensaje = lote.mensaje;
      r.via = 'lote';
    });
    return salida({ llamadas: 1, lote: loteInfo });
  }

  // ---- 4/5) no cuadra: hay que averiguar cual ----
  // Motivo, en criollo, para que el usuario entienda que paso.
  let motivo;
  if (!lote.ok) {
    motivo = lote.error || 'El lote completo fue rechazado por AX.';
  } else if (!lote.counters) {
    motivo = 'AX respondió en un formato que no se pudo interpretar. '
      + 'Por precaución no se da por publicado nada sin verificar.';
  } else {
    const faltan = validos.length - lote.counters.procesados;
    motivo = `AX procesó ${lote.counters.procesados} de ${validos.length}: `
      + `faltó${faltan === 1 ? '' : 'n'} ${faltan}.`;
  }

  if (!aislar || validos.length > maxAislado) {
    const extra = !aislar
      ? ''
      : ` Son demasiadas líneas (${validos.length}) para verificarlas una por una en un solo intento.`;
    const detalleAx = (lote.counters && lote.counters.detalles.length)
      ? ' AX dijo: ' + lote.counters.detalles.join(' | ')
      : '';
    validos.forEach(r => {
      r.ok = false;
      r.error = motivo + extra + detalleAx;
      r.detalles_ax = lote.detalles_ax;
      r.xml = lote.xml;
      r.via = 'lote';
    });
    return salida({ llamadas: 1, lote: loteInfo });
  }

  // Reintento aislado: una llamada por linea, resultado inequivoco.
  let llamadas = 1;
  for (const r of validos) {
    const uno = await axSendLote(env, [r.payload]);
    llamadas++;
    r.via = 'aislado';
    if (uno.ok && uno.counters && uno.counters.procesados === 1) {
      r.ok = true;
      r.mensaje = uno.mensaje;
      r.error = null;
    } else {
      r.ok = false;
      r.mensaje = uno.mensaje;
      r.error = uno.error
        || (uno.counters && uno.counters.detalles.length ? uno.counters.detalles.join(' | ') : null)
        || uno.mensaje
        || 'AX no confirmó este marcaje.';
      r.detalles_ax = uno.detalles_ax;
      r.xml = uno.xml;
    }
  }

  return salida({ llamadas, aislado: true, lote: loteInfo });
}

/* =====================================================================
   axInsertMarcaje(env, rec) — UN solo marcaje. Azucar sobre
   axPublicarMarcajes para el endpoint de diagnostico, que sigue hablando
   de a uno. Devuelve la forma vieja:
     { ok, http, payload, mensaje, error, detalles_ax, xml, legible }
   ===================================================================== */
export async function axInsertMarcaje(env, rec = {}) {
  const r = await axPublicarMarcajes(env, [rec], { aislar: false });
  const uno = r.resultados[0];
  return {
    ok: uno.ok,
    http: r.lote ? r.lote.http : 0,
    payload: uno.payload,
    mensaje: uno.mensaje,
    error: uno.error,
    detalles_ax: uno.detalles_ax,
    xml: uno.xml,
    legible: uno.legible,
  };
}
