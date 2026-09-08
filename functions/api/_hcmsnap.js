/* =====================================================================
   functions/api/_hcmsnap.js — CORTE QUINCENAL del roster (una foto del
   personal a una FECHA), la materia prima de la vista Rotacion.

   POR QUE EXISTE (2026-09-08). Rotacion no lee la nomina en vivo: deriva
   ingresos, egresos, traslados y cambios de cargo comparando CORTES
   consecutivos en nomina_v2.hcm_snapshot. Los 13 cortes de 2026 se
   cargaron a mano una sola noche (16/07) con API-AX\hcm_snapshot_loader_v02.py,
   el plan decia "futuras quincenas: re-correr el loader (o automatizar
   luego)", y ese "luego" nunca llego: el ultimo corte quedo en el 01/07 y
   la pantalla estuvo dos meses mostrando ceros que parecian datos.

   POR QUE NO SE REUSA hcmRosterRaw (_hcm.js). Esa funcion tiene un
   contrato claro y distinto: "dame la ficha de HOY para hacer eco antes
   de escribir". Meterle una fecha opcional la convierte en dos funciones
   con un solo nombre, y de ahi al dia en que alguien arregla el eco y le
   rompe el corte hay un paso. La API es la misma; el proposito no.

   LA FECHA ES REAL, NO UN FILTRO. Verificado el 08/09/2026 contra el
   corte del 01/07 guardado en la base: pidiendo AA01 con fecha 2026-07-16
   la API quita al que egreso el 15/07 y suma a los dos que ingresaron el
   06 y el 09. No devuelve el roster de hoy recortado — devuelve quien
   estaba ese dia. Por eso los cortes que faltan se pueden reconstruir.

   OJO — LO QUE NO VIAJA EN EL TIEMPO: los NOMBRES vienen como estan hoy.
   En el corte del 01/07 hay un "BLADE QUINTERO SIVERIO" que la API ahora
   devuelve "BLADE NOMAR QUINTERO SIVERIO" (el 08/07 cargaron los segundos
   nombres en AX). No afecta: personnel_movements_refresh detecta por
   alias, job_id, start_date y end_date; el nombre solo se muestra.

   Secrets: canaima_apikey (la usa quien llama).
   ===================================================================== */

import { HCM_API } from './_hcm.js';

/* Marca de "sin fin de contrato" de AX. En la base se guarda NULL, que es
   como quedaron los 13 cortes historicos; personnel_movements_refresh
   acepta las dos, pero una sola forma es una menos que explicar. */
export const AX_SIN_FIN = '2154-12-31';

/* 'YYYY-MM-DD' o null. Corta la hora si viene ('1997-02-12T12:00:00') y
   descarta los centinelas de la API ('-', 'None', vacio). */
export function fechaAx(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s === '-' || s === 'None') return null;
  const d = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/* Texto de la API a texto guardable: los centinelas quedan en null. */
function txt(v) {
  const s = String(v == null ? '' : v).trim();
  return (!s || s === '-' || s === 'None') ? null : s;
}

/* Una ficha cruda de la API -> una fila de hcm_snapshot.
   Devuelve null si le falta lo unico que no se puede inventar: la cedula.
   El alias se pasa aparte porque es el que SE PIDIO: si la API respondiera
   con otro, el corte se guardaria bajo un alias que nadie consulto. */
export function filaDeFicha(raw, alias, cut) {
  const ced = String(raw && raw.ficha != null ? raw.ficha : '').replace(/[^0-9]/g, '');
  if (!ced) return null;
  const fin = fechaAx(raw.finContrato);
  return {
    cut_date: cut,
    id_number: ced,
    full_name: txt(raw.nombreCompleto),
    alias,
    data_area: txt(raw.dataArea),
    company_type: txt(raw.empresaTipo),
    job_id: txt(raw.idCargo),
    position_id: txt(raw.idPosicion),
    start_date: fechaAx(raw.inicioContrato),
    end_date: (fin === AX_SIN_FIN) ? null : fin,
  };
}

/* =====================================================================
   snapRoster(env, alias, cut) — el corte de UN alias a UNA fecha.

   Devuelve { ok, rows, error }. Nunca lanza: quien llama procesa 40
   aliases seguidos y uno caido no puede tumbar la tanda; el motivo del
   fallo se guarda por alias en hcm_snapshot_runs (leccion v5.38: el
   motivo del fallo jamas se pierde).

   ok:true con rows:[] es un caso legitimo (empresa cerrada o todavia sin
   personal a esa fecha) y NO es lo mismo que un error: quien llama lo
   marca 'empty' y no lo reintenta, mientras que un error si se reintenta.
   ===================================================================== */
export async function snapRoster(env, alias, cut) {
  const a = String(alias || '').trim();
  const f = fechaAx(cut);
  if (!a) return { ok: false, rows: [], error: 'alias vacio' };
  if (!f) return { ok: false, rows: [], error: `fecha de corte invalida (${cut})` };

  const url = `${HCM_API}?alias=${encodeURIComponent(a)}&fecha=${encodeURIComponent(f)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
    });
    if (!res.ok) {
      let cuerpo = '';
      try { cuerpo = (await res.text()).slice(0, 200); } catch (_) { /* sin cuerpo */ }
      return { ok: false, rows: [], error: `HTTP ${res.status}${cuerpo ? ' — ' + cuerpo : ''}` };
    }
    let data = await res.json();
    if (!Array.isArray(data)) data = data.empleados || data.data || data.items || [];
    if (!Array.isArray(data)) {
      return { ok: false, rows: [], error: 'respondio 200 pero sin una lista de empleados reconocible' };
    }
    const rows = [];
    for (const raw of data) {
      const fila = filaDeFicha(raw, a, f);
      if (fila) rows.push(fila);
    }
    return { ok: true, rows, error: null };
  } catch (e) {
    return { ok: false, rows: [], error: `no se pudo contactar la API (${(e && e.message) || e})` };
  }
}
