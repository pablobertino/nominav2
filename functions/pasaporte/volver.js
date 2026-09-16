/* =====================================================================
   functions/pasaporte/volver.js  →  GET /pasaporte/volver
   LA VUELTA: el Pasaporte devuelve a la persona con una prueba de quien es.

   ⚠ ESTA RUTA ES LA QUE SE REGISTRA DEL LADO DEL PASAPORTE, literal:
        https://ch.grupocanaima.com/pasaporte/volver
      Si se mueve el archivo, cambia la URL y hay que avisar del otro lado.
      Vive fuera de /api a proposito: es una pantalla para una persona, no
      un endpoint para una pantalla.

   QUE SE REVISA, EN ORDEN, Y POR QUE:

     1. el dominio       (Regla 1; si no, la cookie no esta)
     2. ¿prendido?
     3. ¿hubo error del Pasaporte?  -> a la pantalla de acceso, sin drama
     4. la cookie del viaje         -> si falta, el viaje no salio de aca
     5. el state coincide           -> CSRF: alguien pudo empujar esta URL
     6. se canjea el codigo         -> recien aca hablamos con el Pasaporte
     7. el nonce coincide           -> ata la identidad a ESTA ida
     8. se busca la cuenta          -> por cedula, NUNCA por correo

   Solo si los ocho pasan, entra. Cualquier tropiezo termina en la
   pantalla de acceso con un motivo, y la clave de siempre sigue andando:
   el boton nuevo nunca cierra la puerta vieja.

   COMO TERMINA. El portal no tiene token que emitir (ver _pasaporte.js),
   asi que la vuelta entrega el MISMO objeto de sesion que /api/login y
   deja que el front lo guarde. Se hace con una pagina minima que escribe
   sessionStorage y entra — no con un JSON, porque acá llega una persona
   navegando, no un fetch.
   ===================================================================== */

import {
  REDIRECT_URI, CANONICO, activo, canonizar, emisor,
  leerViaje, cookieBorrada, cedulaDe, buscarCuenta, alLogin,
} from '../api/_pasaporte.js';

export async function onRequestGet({ request, env }) {
  // 1 · Regla 1. La cookie del viaje vive en el canonico; si llegamos por
  //     otro lado, saltamos antes de buscarla (no estaria).
  const salto = canonizar(request);
  if (salto) return salto;

  const on = await activo(env);
  if (!on.ok) return alLogin(on.motivo);

  const url = new URL(request.url);

  // 3 · El Pasaporte puede devolver un error en vez de un codigo.
  const errPasaporte = url.searchParams.get('error');
  if (errPasaporte) {
    return conCookieBorrada(alLogin('rechazado'));
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return conCookieBorrada(alLogin('sin-codigo'));

  // 4 y 5 · La cookie del viaje y el state.
  const viaje = leerViaje(request);
  if (!viaje) return conCookieBorrada(alLogin('viaje-vencido'));
  if (viaje.state !== state) return conCookieBorrada(alLogin('state-no-coincide'));

  // 6 · Canje del codigo. Recien aca hablamos con el Pasaporte, y solo
  //     despues de haber verificado que el viaje salio de esta pantalla.
  let perfil;
  try {
    const em = await emisor();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,          // la MISMA que en la ida
      client_id: env.PASAPORTE_CLIENT_ID,
      client_secret: env.PASAPORTE_CLIENT_SECRET,
    });
    const tok = await fetch(em.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (!tok.ok) return conCookieBorrada(alLogin('canje-fallido'));
    const datos = await tok.json();

    /* El perfil sale del userinfo si el emisor lo ofrece; si no, del
       id_token. No se descifra el JWT a mano: se pide al emisor, que es
       quien puede responder por el. */
    if (em.userinfo_endpoint && datos.access_token) {
      const ui = await fetch(em.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${datos.access_token}`, Accept: 'application/json' },
      });
      if (!ui.ok) return conCookieBorrada(alLogin('sin-perfil'));
      perfil = await ui.json();
    } else {
      return conCookieBorrada(alLogin('sin-perfil'));
    }

    // 7 · El nonce ata esta identidad a ESTA ida.
    if (perfil && perfil.nonce && perfil.nonce !== viaje.nonce) {
      return conCookieBorrada(alLogin('nonce-no-coincide'));
    }
  } catch (_) {
    return conCookieBorrada(alLogin('emisor-caido'));
  }

  // 8 · La cuenta. Por cedula, nunca por correo.
  const sub = perfil && (perfil.sub || perfil.id) ? String(perfil.sub || perfil.id) : null;
  const cedula = cedulaDe(perfil);

  let r;
  try { r = await buscarCuenta(env, cedula, sub); }
  catch (_) { return conCookieBorrada(alLogin('error')); }

  if (r.error) return conCookieBorrada(alLogin(r.motivo));

  return conCookieBorrada(entrar(r.user));
}

function conCookieBorrada(res) {
  /* El viaje se usa una sola vez, salga bien o mal. Una cookie de viaje
     que sobrevive es un viaje reutilizable. */
  const h = new Headers(res.headers);
  h.append('Set-Cookie', cookieBorrada());
  return new Response(res.body, { status: res.status, headers: h });
}

/* Pagina minima que deja la sesion igual que el login normal y entra.
   Sin frameworks ni imports: es lo unico que corre antes de que exista
   una sesion, y tiene que funcionar aunque todo lo demas falle. */
function entrar(user) {
  /* El objeto se embebe como LITERAL y se vuelve a serializar en el
     navegador, en vez de meter el string entre comillas. Un apellido con
     apostrofo -y los hay- rompia la comilla y dejaba la pagina muda: la
     persona veia "Entrando…" para siempre. JSON valido es JS valido, asi
     que el literal no necesita escapes.
     El \\u003c es aparte: evita que un "</script>" dentro de un dato
     cierre el bloque antes de tiempo. */
  const json = JSON.stringify(user).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Entrando…</title><meta name="robots" content="noindex"></head>
<body style="font-family:system-ui;padding:2rem;color:#334155">Entrando…
<script>
try { sessionStorage.setItem('nmv2_session', JSON.stringify(${json})); } catch (e) {}
location.replace('https://${CANONICO}/#/panel');
</script>
<noscript>Habilita JavaScript para continuar, o entra con tu usuario y clave.</noscript>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequest({ request }) {
  if (request.method === 'GET') return;
  return new Response('Method Not Allowed', { status: 405 });
}
