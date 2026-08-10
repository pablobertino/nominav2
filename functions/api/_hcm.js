/* =====================================================================
   functions/api/_hcm.js — ESCRITURA hacia la API de empleados del sistema
   (compartido por ax-review.js [publish] y worker-photo.js [push_to_ax]).

   CONTEXTO (2026-07-07): la API cambio el idioma de sus enumeraciones de
   espanol a ingles, en LECTURA y en ESCRITURA. La lectura se blindo con
   normalizadores bilingues (v4.11). La escritura usa ESTOS textos:
     genero:      Male / Female
     estadoCivil: Single / Married / Divorced / Widowed / Cohabiting /
                  RegisteredPartnership
   Los textos en espanol (Soltero/a, Masculino, ...) quedan SOLO para
   mostrar en la UI (displayVal de cada endpoint), no para enviar.

   PAYLOAD COMPLETO CON ECO: la API espera todos los campos del payload y
   segun su documentacion un campo vacio u omitido puede ser destructivo
   (nombres/apellidos/cuenta) o resetear el enum (genero/estadoCivil).
   Por eso NUNCA se envia un payload parcial: antes del POST se lee la
   ficha ACTUAL del sistema (GET por alias) y se arma el payload con:
     - campos PENDIENTES  -> valor del PORTAL (traducido a lo que la API
                             espera: ingles en enums, 0XXXXXXXXXX en
                             telefono, YYYY-MM-DD en fecha);
     - el resto           -> ECO del valor actual del sistema (saneado
                             minimo: fecha ISO cortada a 10; "-" -> "").
   Si el GET falla o la ficha no viene (respuesta parcial del sistema),
   esa ficha NO se envia: mejor rechazar que escribir a medias.

   Secrets: canaima_apikey (la usa quien llama, via hcmRosterRaw).
   ===================================================================== */

export const HCM_API = 'https://api2.grupocanaima.com/empleados/datos/v1';

// Codigo interno -> texto que la API espera AHORA (ingles).
export const HCM_GENDER_SEND = { M: 'Male', F: 'Female' };
export const HCM_MARITAL_SEND = {
  S: 'Single', C: 'Married', D: 'Divorced', V: 'Widowed',
  O: 'Cohabiting', R: 'RegisteredPartnership',
};

// Campo interno (workers_master) -> campo del payload de la API.
// 'apellidos' es el campo de ESCRITURA (primer/segundoApellido son solo
// lectura). 'address' NO viaja (la API no lo maneja).
export const HCM_FIELD_MAP = {
  first_name: 'primerNombre',
  second_name: 'segundoNombre',
  last_names: 'apellidos',
  birth_date: 'fechaNacimiento',
  gender: 'genero',
  marital_status: 'estadoCivil',
  account_number: 'cuentaBancaria',
  phone: 'telefono',
  email: 'correo',
};
export const HCM_FIELDS = Object.keys(HCM_FIELD_MAP);

/* Valor del PORTAL (codigo interno) -> texto listo para la API. Devuelve
   null si esta vacio o la traduccion no calza (ese campo cae al eco). */
export function toHcmValue(field, raw) {
  const v = (raw == null) ? '' : String(raw).trim();
  if (v === '') return null;
  if (field === 'gender') return HCM_GENDER_SEND[v] || null;
  if (field === 'marital_status') return HCM_MARITAL_SEND[v] || null;
  // La API espera el numero nacional (04XX...). El master guarda +58...
  if (field === 'phone') return v.startsWith('+58') ? '0' + v.slice(3) : v;
  if (field === 'birth_date') return String(v).slice(0, 10);   // YYYY-MM-DD
  return v;
}

/* ECO de un valor crudo del sistema para re-enviarlo tal cual, con saneo
   minimo: "-" (marca de vacio del sistema) -> "" y fecha ISO con hora
   cortada a YYYY-MM-DD. Todo lo demas viaja intacto. */
function echoValue(axKey, raw) {
  let v = (raw == null) ? '' : String(raw).trim();
  if (v === '-') v = '';
  if (axKey === 'fechaNacimiento') v = v.slice(0, 10);
  return v;
}

/* GET del roster CRUDO del sistema por alias. Devuelve un mapa
   cedula(solo digitos) -> fila cruda, o null si la llamada fallo. */
/* v6.198 — POR QUE FALLO, no solo QUE fallo.

   Antes esto era `if (!res.ok) return null` + `catch { return null }`: se
   tragaba el status, el cuerpo y la excepcion. El usuario veia "No se pudo
   leer la ficha actual del sistema (eco)" y ni el ni nosotros podiamos saber
   si fue un 500, un timeout, un alias que la API no reconoce o un JSON con
   otra forma. Y como el fallo es POR EMPRESA, una tienda caida rechaza todas
   sus fichas con el mismo mensaje mudo.

   Sigue devolviendo null (quien llama ya sabe que null = sin eco = no enviar),
   pero ahora deja el motivo en hcmLastError para que el endpoint lo muestre. */
let _hcmLastError = null;
export function hcmLastError() { return _hcmLastError; }

export async function hcmRosterRaw(env, alias) {
  _hcmLastError = null;
  try {
    const url = `${HCM_API}?alias=${encodeURIComponent(alias)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
    });
    if (!res.ok) {
      let cuerpo = '';
      try { cuerpo = (await res.text()).slice(0, 200); } catch (_) { /* sin cuerpo */ }
      _hcmLastError = `HTTP ${res.status}${cuerpo ? ' — ' + cuerpo : ''}`;
      return null;
    }
    let data = await res.json();
    if (!Array.isArray(data)) data = data.empleados || data.data || data.items || [];
    if (!Array.isArray(data)) {
      _hcmLastError = 'la API respondio 200 pero sin una lista de empleados reconocible';
      return null;
    }
    const map = {};
    for (const raw of data) {
      const ced = String(raw && raw.ficha != null ? raw.ficha : '').replace(/[^0-9]/g, '');
      if (ced) map[ced] = raw;
    }
    if (!Object.keys(map).length) {
      _hcmLastError = `la API respondio 200 pero sin fichas para el alias ${alias}`;
      return null;
    }
    return map;
  } catch (e) {
    _hcmLastError = `no se pudo contactar la API (${(e && e.message) || e})`;
    return null;
  }
}

/* Payload COMPLETO para una ficha (los 9 campos + ficha, SIEMPRE todos):
     - masterRow: fila de workers_master (valores del portal).
     - pendingFields: objeto {campo:true} de ax_pending_fields.
     - erpRaw: fila cruda del sistema para esa cedula (eco).
   Devuelve { payload, changed }: changed=false si ningun pendiente aporto
   un valor valido (no tiene sentido enviar; quien llama lo rechaza). */
export function fullHcmPayload(masterRow, pendingFields, erpRaw) {
  const out = { ficha: String(masterRow.id_number) };
  let changed = false;
  const pend = (pendingFields && typeof pendingFields === 'object') ? pendingFields : {};
  for (const field of HCM_FIELDS) {
    const axKey = HCM_FIELD_MAP[field];
    if (pend[field]) {
      const val = toHcmValue(field, masterRow[field]);
      if (val != null && val !== '') {
        out[axKey] = val;
        changed = true;
        continue;
      }
      // Pendiente vacio o sin traduccion -> cae al eco (no se publica
      // ese campo; jamas se manda vacio un dato que el sistema tiene).
    }
    out[axKey] = echoValue(axKey, erpRaw ? erpRaw[axKey] : '');
  }
  return { payload: out, changed };
}
