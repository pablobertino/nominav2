/* =====================================================================
   functions/api/ax-marcajes.js  ->  POST /api/ax-marcajes        (v6.166)
   MARCAJE MANUAL: publicar marcajes en AX 2012 a traves del middleware
   Flask de Sebastian (AIFFingerPrint / insertFingerprintRecord).

   Esta es la PRIMERA pieza: el proxy y su prueba. Todavia NO publica los
   reportes de marcaje del portal; eso viene despues, cuando la prueba
   confirme el contrato real.

   POR QUE UN PROXY Y NO LLAMAR DESDE EL NAVEGADOR:
   el HTML de prueba que circulo trae la X-API-Key escrita en el codigo
   (`const apiKey = '...'`). Servido al navegador, esa clave queda a la vista
   de cualquiera que abra el inspector, y con ella se puede escribir marcajes
   en AX sin pasar por el portal. Aca la clave vive en las env vars de
   Cloudflare (el mismo secret canaima_apikey que ya usan las otras APIs del
   catalogo) y NUNCA viaja al cliente.

   Acciones (POST { action, user, ... }):
     health {}                              gate hcm.sync
        Ping de vida al middleware (GET .../health). No escribe nada:
        es la prueba segura para empezar.
     insert { alias, personnelNumber, transDate, dayType?,
              timeEntry?, timeExit? }        gate hcm.sync
        Inserta UN marcaje. Devuelve la respuesta del middleware y -clave
        para depurar- el payload EXACTO que se envio.
        OJO: ESCRIBE EN AX DE VERDAD. No es un simulador.

   HORAS: el middleware espera SEGUNDOS DESDE MEDIANOCHE (08:30 -> 30600),
   no un texto de hora. El portal maneja 'HH:MM' en todos lados
   (mark_report_lines.time_in / time_out), asi que la conversion se hace
   aca, en un solo lugar, y se acepta cualquiera de las dos formas.

   Env vars: canaima_apikey (o ax_api_key), ax_marcajes_url (opcional).
   ===================================================================== */

import { resolveActor, can, AuthError } from './_auth.js';

const MARCAJES_URL_DEFAULT = 'https://api.grupocanaima.com/empleados/marcajes/v1';

/* HRDayType del lado de AX. Un dia de DESCANSO no lleva horas: el propio
   portal las deja vacias en la plantilla, y mandar 0 es lo que espera el
   middleware (su default). */
const DAY_TYPES = new Set(['Workday', 'RestDay']);

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

/* 'HH:MM' | 'HH:MM:SS' | numero -> segundos desde medianoche.
   Devuelve null si el texto no es una hora valida (para poder distinguir
   "no vino" de "vino mal escrito"). */
function hhmmToSeconds(v) {
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

/* Segundos -> 'HH:MM', solo para devolver el eco legible en la respuesta. */
function secondsToHHMM(n) {
  const s = Math.max(0, Number(n) || 0);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

/* Llamada al middleware. Devuelve { ok, status, data, raw } SIN lanzar: el
   objetivo de esta pieza es DIAGNOSTICAR, y un error del middleware (que
   trae detalles_ax y hasta el XML crudo) es informacion valiosa, no una
   excepcion que haya que esconder. */
async function axCall(url, key, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'X-API-Key': key, Accept: 'application/json', ...(init.headers || {}) },
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* el middleware no siempre responde JSON */ }
  return { ok: res.ok, status: res.status, data, raw };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Cuerpo inv\u00e1lido.' }, 400); }
  const action = body.action || 'health';

  try {
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesi\u00f3n no v\u00e1lida.' }, 403);
    if (!can(actor, 'hcm.sync')) {
      return json({ ok: false, error: 'No tienes permiso para sincronizar con AX (hcm.sync).' }, 403);
    }

    const key = env.ax_api_key || env.canaima_apikey;
    if (!key) {
      return json({ ok: false, error: 'Falta el secret canaima_apikey (o ax_api_key) en las variables del proyecto.' }, 500);
    }
    const baseUrl = env.ax_marcajes_url || MARCAJES_URL_DEFAULT;

    /* ---------------- health: ping sin efectos ---------------- */
    if (action === 'health') {
      const r = await axCall(`${baseUrl}/health`, key, { method: 'GET' });
      return json({
        ok: r.ok, url: `${baseUrl}/health`, http: r.status,
        respuesta: r.data || r.raw.slice(0, 500),
      }, r.ok ? 200 : 502);
    }

    /* ---------------- insert: UN marcaje (ESCRIBE EN AX) ---------------- */
    if (action === 'insert') {
      const alias = String(body.alias || '').trim();
      const personnelNumber = String(body.personnelNumber || '').trim();
      const transDate = String(body.transDate || '').trim().slice(0, 10);
      const dayType = String(body.dayType || 'Workday').trim();

      if (!alias) return json({ ok: false, error: 'Falta el alias de la empresa.' }, 400);
      if (!personnelNumber) return json({ ok: false, error: 'Falta el n\u00famero de personal.' }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(transDate)) {
        return json({ ok: false, error: 'La fecha debe venir como AAAA-MM-DD.' }, 400);
      }
      if (!DAY_TYPES.has(dayType)) {
        return json({ ok: false, error: `Tipo de d\u00eda inv\u00e1lido: ${dayType}. Debe ser Workday o RestDay.` }, 400);
      }

      /* Descanso sin horas: se fuerzan a 0 aunque vengan cargadas. Es la
         misma regla que ya aplica la plantilla AX del reporte de marcaje
         (en Descanso las columnas de entrada/salida van vacias), y evita
         mandar a AX un descanso con horario, que no tiene sentido. */
      let entry = 0, exit = 0;
      if (dayType === 'Workday') {
        entry = hhmmToSeconds(body.timeEntry);
        exit = hhmmToSeconds(body.timeExit);
        if (entry === null) return json({ ok: false, error: 'Hora de entrada inv\u00e1lida (usa HH:MM).' }, 400);
        if (exit === null) return json({ ok: false, error: 'Hora de salida inv\u00e1lida (usa HH:MM).' }, 400);
        if (entry && exit && exit <= entry) {
          return json({ ok: false, error: 'La hora de salida debe ser posterior a la de entrada.' }, 400);
        }
      }

      const payload = {
        alias,
        personnelNumber,
        dayType,
        transDate,
        timeEntry: entry,
        timeExit: exit,
      };

      const r = await axCall(baseUrl, key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      /* El eco del payload es a proposito: en una integracion nueva, la
         mitad de los problemas son "mande otra cosa de la que creia". */
      const eco = { ...payload, _horas_legibles: `${secondsToHHMM(entry)} -> ${secondsToHHMM(exit)}` };

      if (!r.ok) {
        const d = r.data || {};
        return json({
          ok: false,
          http: r.status,
          error: d.error || `El middleware respondi\u00f3 HTTP ${r.status}.`,
          detalles_ax: d.detalles_ax || null,
          // El XML crudo de un SOAP Fault es larguisimo; se recorta.
          xml: d.xml_crudo ? String(d.xml_crudo).slice(0, 1200) : null,
          enviado: eco,
        }, 502);
      }

      return json({
        ok: true, http: r.status,
        mensaje: (r.data && (r.data.mensaje || r.data.status)) || r.raw.slice(0, 300),
        enviado: eco,
      });
    }

    return json({ ok: false, error: 'Acci\u00f3n desconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error del servidor: ' + (e && e.message ? e.message : e) }, 500);
  }
}