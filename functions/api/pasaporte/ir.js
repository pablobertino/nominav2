/* =====================================================================
   functions/api/pasaporte/ir.js  →  GET /api/pasaporte/ir
   LA IDA: prepara el viaje y manda la persona al Pasaporte.

   Es una navegacion, no una llamada de API: la persona TOCA el boton y el
   navegador la lleva. Por eso responde con redirecciones y no con JSON.

   ⚠ EL ORDEN DE ESTE ARCHIVO ES LO QUE IMPORTA, Y NO ES CASUAL:

     1. canonizar  — si venimos de otro dominio, saltar PRIMERO
     2. activo     — ¿esta prendido y configurado?
     3. emisor     — ¿donde vive el Pasaporte hoy?
     4. cookie     — recien aca se escribe el viaje
     5. redirigir  — al Pasaporte

   El paso 1 va antes que el 4 a proposito. Si se escribiera la cookie y
   despues se saltara al canonico, la cookie quedaria en el dominio
   equivocado y la vuelta -que siempre cae en el canonico- no la
   encontraria. El sintoma seria identico al de no tener el arreglo, y es
   exactamente lo que le paso a la Extranet en celulares.

   Nada de lo que falle aca deja a nadie afuera: todo termina en la
   pantalla de acceso con un motivo, y la clave de siempre sigue andando.
   ===================================================================== */

import {
  REDIRECT_URI, activo, canonizar, emisor,
  nuevoViaje, cookieDeViaje, alLogin,
} from '../_pasaporte.js';

export async function onRequestGet({ request, env }) {
  // 1 · La Regla 1, antes de tocar nada.
  const salto = canonizar(request);
  if (salto) return salto;

  // 2 · ¿Prendido?
  const on = await activo(env);
  if (!on.ok) return alLogin(on.motivo);

  // 3 · ¿Donde vive el Pasaporte?
  let em;
  try { em = await emisor(); }
  catch (_) { return alLogin('emisor-caido'); }

  // 4 · El viaje. Recien ahora se escribe la cookie, y ya estamos en el
  //     dominio canonico, asi que la vuelta la va a encontrar.
  const viaje = nuevoViaje();

  const u = new URL(em.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', env.PASAPORTE_CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);   // literal, nunca armado
  u.searchParams.set('scope', em.scope || 'openid profile email');
  u.searchParams.set('state', viaje.state);
  u.searchParams.set('nonce', viaje.nonce);

  return new Response(null, {
    status: 302,
    headers: { Location: u.toString(), 'Set-Cookie': cookieDeViaje(viaje) },
  });
}

/* Solo GET: la ida es una navegacion del navegador. */
export async function onRequest({ request }) {
  if (request.method === 'GET') return;   // lo maneja onRequestGet
  return new Response('Method Not Allowed', { status: 405 });
}
