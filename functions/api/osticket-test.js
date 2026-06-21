/* =====================================================================
   functions/api/osticket-test.js  ->  /api/osticket-test
   Prueba de conexion con la API de osTicket. Solo superadmin.

   La API de osTicket (1.17.x) SOLO soporta creacion de tickets
   (POST {url}/api/tickets.json) con el header X-API-Key. No existe un
   endpoint de "ping". Por eso la prueba tiene dos modos:

     mode = 'ping'   (por defecto, NO crea ticket):
        Envia un POST con cuerpo minimo/incompleto. Interpretamos la
        respuesta:
          - 401 / "api key not found" / "ip ..."  -> key o IP rechazada.
          - 400 / 422 / mensaje de validacion de campos -> la KEY FUE
            ACEPTADA (el server llego a validar el contenido) = conexion OK.
          - 201 / numero de ticket -> tambien OK (raro con cuerpo minimo).
        Asi sabemos si la URL responde y si la API key es aceptada, sin
        ensuciar el sistema con tickets de prueba.

     mode = 'create'  (crea un ticket REAL de prueba en el demo):
        Manda email/name/subject/message + topicId. Devuelve el numero
        de ticket creado. Usar solo contra el DEMO.

   La API key vive como Secret de Cloudflare (env.osticket_api_key),
   nunca en BD ni en el navegador.
   Secrets: supabase_url, supabase_service_role, osticket_api_key
   ===================================================================== */

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

async function sb(env, path) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2',
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function isSuperadmin(env, adminId) {
  if (!adminId) return false;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&role=eq.superadmin&is_active=eq.true&select=id`);
  return r && r.length > 0;
}

async function getSetting(env, key, def = '') {
  const r = await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  return (r && r[0] && r[0].value != null && r[0].value !== '') ? r[0].value : def;
}

// Normaliza la URL base: sin barra final, y le agrega /api/tickets.json
function ticketsEndpoint(base) {
  const clean = (base || '').trim().replace(/\/+$/, '');
  return `${clean}/api/tickets.json`;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const { adminId, mode = 'ping' } = body;

  try {
    if (!(await isSuperadmin(env, adminId))) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    const apiKey = env.osticket_api_key;
    if (!apiKey) {
      return json({ ok: false, error: 'No hay clave API configurada. Definela como Secret osticket_api_key en Cloudflare y vuelve a desplegar.' }, 400);
    }
    const baseUrl = await getSetting(env, 'osticket_url', '');
    if (!baseUrl) {
      return json({ ok: false, error: 'No hay URL de osTicket configurada. Guardala en la pestana Integraciones.' }, 400);
    }
    const endpoint = ticketsEndpoint(baseUrl);

    /* ---------------- MODO PING (no crea ticket) ---------------- */
    if (mode === 'ping') {
      // Cuerpo intencionalmente incompleto: si la KEY es aceptada, osTicket
      // respondera con un error de validacion de campos (no de auth).
      let res, text;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        text = await res.text();
      } catch (e) {
        return json({ ok: false, reachable: false,
          error: `No se pudo conectar con ${endpoint}. ${e.message}` }, 200);
      }

      const status = res.status;
      const low = (text || '').toLowerCase();

      // Senales de AUTENTICACION rechazada (key o IP).
      const authBad = status === 401 || status === 403
        || low.includes('api key not found')
        || low.includes('invalid api key')
        || low.includes('not authorized')
        || (low.includes('ip') && low.includes('not'));

      // Senales de que la KEY fue aceptada y solo fallo la validacion de campos.
      const validationOnly = status === 400 || status === 422
        || low.includes('email')
        || low.includes('subject')
        || low.includes('message')
        || low.includes('required')
        || low.includes('missing');

      if (authBad) {
        return json({ ok: false, reachable: true, auth: false, status,
          message: 'La URL responde, pero la clave API fue rechazada (clave invalida o IP no autorizada). Revisa que el Secret osticket_api_key sea la clave 0.0.0.0 y que el deploy ya la haya tomado.',
          detail: (text || '').slice(0, 300) }, 200);
      }
      if (status >= 200 && status < 300) {
        return json({ ok: true, reachable: true, auth: true, status,
          message: 'Conexion y clave API correctas. (El servidor incluso acepto el envio minimo.)',
          detail: (text || '').slice(0, 300) }, 200);
      }
      if (validationOnly) {
        return json({ ok: true, reachable: true, auth: true, status,
          message: 'Conexion y clave API correctas. La URL responde y la clave fue aceptada (el servidor solo pidio los campos del ticket, lo cual es lo esperado en esta prueba).',
          detail: (text || '').slice(0, 300) }, 200);
      }
      // Otro estado: informar crudo para diagnostico.
      return json({ ok: false, reachable: true, auth: null, status,
        message: `La URL respondio con un estado inesperado (${status}). Revisa el detalle.`,
        detail: (text || '').slice(0, 300) }, 200);
    }

    /* ---------------- MODO CREATE (crea ticket real en el demo) ---------------- */
    if (mode === 'create') {
      const topicId = await getSetting(env, 'osticket_topic_ausencia', '');
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const payload = {
        email: 'portal-nomina@grupocanaima.com',
        name: 'Prueba Portal Nomina',
        subject: `PRUEBA de conexion ${stamp}`,
        message: 'Ticket de prueba generado desde el Portal de Nomina v2 para verificar la conexion con osTicket. Puede cerrarse/eliminarse.',
        source: 'API',
        alert: false,        // no alertar a los agentes por un ticket de prueba
        autorespond: false,  // no enviar autorespuesta
      };
      if (topicId) payload.topicId = parseInt(topicId, 10);

      let res, text;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        text = await res.text();
      } catch (e) {
        return json({ ok: false, reachable: false,
          error: `No se pudo conectar con ${endpoint}. ${e.message}` }, 200);
      }

      if (res.status >= 200 && res.status < 300) {
        // osTicket devuelve el numero de ticket como texto plano (a veces con comillas).
        const ticket = (text || '').replace(/["\s]/g, '');
        return json({ ok: true, reachable: true, auth: true, status: res.status,
          ticket,
          message: `Ticket de prueba creado en el demo${ticket ? ' (numero ' + ticket + ')' : ''}. Topic Ausencia = ${topicId || 'sin definir'}.` }, 200);
      }
      const low = (text || '').toLowerCase();
      const authBad = res.status === 401 || res.status === 403 || low.includes('api key');
      return json({ ok: false, reachable: true, auth: !authBad, status: res.status,
        message: authBad
          ? 'La clave API fue rechazada (clave invalida o IP no autorizada).'
          : `No se pudo crear el ticket (estado ${res.status}).`,
        detail: (text || '').slice(0, 300) }, 200);
    }

    return json({ ok: false, error: 'Modo desconocido (usa ping o create).' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
