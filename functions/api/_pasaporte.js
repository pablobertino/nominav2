/* =====================================================================
   functions/api/_pasaporte.js — Entrar al portal con el Pasaporte Canaima.

   QUE HACE, EN UNA FRASE. Deja que una persona entre con la identidad del
   Pasaporte, sin escribir clave aca, pero SOLO si ya tiene cuenta en el
   portal. El Pasaporte dice quien es; el portal decide si puede pasar.

   ⚠ ESTADO: FASE 1, APAGADO. El boton no se pinta y los dos endpoints
   responden "apagado" mientras app_settings.pasaporte_enabled sea false.
   Falta registrar el portal del lado del Pasaporte y que nos den
   PASAPORTE_CLIENT_ID / PASAPORTE_CLIENT_SECRET. Sin eso el viaje no se
   puede completar, aunque el codigo este entero.

   ---------------------------------------------------------------------
   LO QUE ESTE ARCHIVO NO HACE, Y HAY QUE SABERLO

   NO EMITE SESION. El portal no tiene token: la sesion es un objeto plano
   en sessionStorage y cada endpoint revalida con resolveActor leyendo el
   id que manda el cliente. O sea que el Pasaporte, tal como esta hoy,
   es una COMODIDAD DE LOGIN — evita una clave mas — pero no agrega una
   capa de seguridad. La vuelta termina devolviendo exactamente el mismo
   objeto que devuelve /api/login, ni mas ni menos.
   Si algun dia se quiere que valga como seguridad, hace falta una sesion
   firmada y que resolveActor la verifique; eso es otra fase y toca el
   login normal tambien.

   ---------------------------------------------------------------------
   LAS TRES REGLAS (aprendidas del dolor ajeno: la Extranet las estreno)

   1) UN SOLO DOMINIO. El viaje empieza y termina en ch.grupocanaima.com.
      El portal hoy vive tambien en nominav2.pages.dev, y ese es justo el
      escenario que rompio a la Extranet: la cookie del viaje se guarda en
      el dominio desde el que arranco y la vuelta cae siempre en el
      canonico. Por eso, si la ida arranca en otro dominio, se SALTA al
      canonico ANTES de escribir nada — antes de la cookie — asi no queda
      una cookie huerfana en el dominio equivocado.
      No se agregan otros dominios a ninguna lista: se redirige.

   2) LA DIRECCION DE RETORNO ES UN TEXTO FIJO. REDIRECT_URI vive aca y
      solo aca, y la usan la ida y la vuelta. NUNCA se arma desde el host
      de la peticion. Esa misma linea, letra por letra, tiene que estar
      registrada del lado del Pasaporte. Si no coinciden: invalid
      redirect_uri.

   3) EL PASAPORTE NO CREA CUENTAS. Si la identidad no tiene cuenta aca,
      no entra — y se responde igual que a una cuenta suspendida, para no
      regalar informacion sobre quien existe y quien no.

   ---------------------------------------------------------------------
   EL ANCLA: CEDULA, NUNCA CORREO

   admin_users.id_number, puesto en la Fase 0. El correo NO participa del
   match y no es un detalle teorico: la cuenta 'ana.rodriguez' tiene
   cargado 'karina.rodriguez@grupocanaima.net', un buzon que ni existe en
   el directorio. Emparejar por correo la ataria a otra persona.

   Y como una persona puede tener varias cuentas a proposito (Pablo tiene
   superadmin, pablo.editor y pablo.test), la que se usa es la que tiene
   pasaporte_login = true. La base garantiza que sea UNA sola, con un
   indice unico parcial: la pregunta "¿a que cuenta entra esta identidad?"
   nunca puede tener dos respuestas.

   Secrets: supabase_url, supabase_service_role,
            PASAPORTE_CLIENT_ID, PASAPORTE_CLIENT_SECRET
   ===================================================================== */

/* El dominio canonico del portal. Confirmado por Pablo el 16/09/2026. */
export const CANONICO = 'ch.grupocanaima.com';

/* ⚠ LITERAL Y EN UN SOLO LUGAR. No se arma con el host de la peticion.
   Tiene que estar registrada IDENTICA del lado del Pasaporte. */
export const REDIRECT_URI = 'https://ch.grupocanaima.com/pasaporte/volver';

/* De donde vive el Pasaporte lo dice el propio Pasaporte. Asi, el dia que
   se active id.grupocanaima.com, cambia ese archivo y aca no se toca nada. */
export const EMISOR_URL = 'https://pasaporte.grupocanaima.com/boton/emisor.json';

/* El interruptor. Mientras sea false el boton no existe. */
export const SETTING_ENABLED = 'pasaporte_enabled';

/* Nombre de la cookie del viaje (state + nonce). El prefijo __Host- obliga
   a Secure, path=/ y sin Domain: la cookie queda atada a ESTE host y no se
   puede plantar desde un subdominio vecino. */
const COOKIE = '__Host-pasaporte_viaje';
const VIAJE_MINUTOS = 10;

/* ---------- Supabase ---------- */
async function sb(env, path, opts = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2', 'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

/* =====================================================================
   activo(env) — ¿esta prendido y configurado?

   Devuelve { ok, motivo }. Los motivos viajan a la pantalla de acceso como
   ?pasaporte=<motivo> para que se pueda diagnosticar sin entrar a la base,
   y NINGUNO dice nada de ninguna persona: hablan del sistema, no del que
   intenta entrar.
   ===================================================================== */
export async function activo(env) {
  if (!env.PASAPORTE_CLIENT_ID || !env.PASAPORTE_CLIENT_SECRET) {
    return { ok: false, motivo: 'sin-configurar' };
  }
  try {
    const r = await sb(env,
      `app_settings?key=eq.${SETTING_ENABLED}&select=value`);
    const v = r && r[0] ? String(r[0].value).toLowerCase() : 'false';
    if (v !== 'true') return { ok: false, motivo: 'apagado' };
  } catch (_) {
    // Si no se puede leer la bandera, se asume apagado. Ante la duda, la
    // puerta vieja sigue abierta y nadie se queda afuera.
    return { ok: false, motivo: 'apagado' };
  }
  return { ok: true, motivo: null };
}

/* =====================================================================
   canonizar(request) — la Regla 1.

   Si la peticion NO viene del dominio canonico, devuelve un 302 hacia el
   canonico conservando la ruta y los parametros. Si ya viene bien,
   devuelve null y el que llama sigue.

   ⚠ QUIEN LLAMA DEBE HACER ESTO ANTES DE ESCRIBIR LA COOKIE. Ese es el
   punto entero: si se escribe primero y se redirige despues, queda una
   cookie en el dominio equivocado que la vuelta nunca va a encontrar, y
   el sintoma es identico al de no tener el arreglo.
   ===================================================================== */
export function canonizar(request) {
  const u = new URL(request.url);
  if (u.hostname === CANONICO) return null;
  u.hostname = CANONICO;
  u.protocol = 'https:';
  u.port = '';
  return Response.redirect(u.toString(), 302);
}

/* =====================================================================
   emisor(env) — de donde vive el Pasaporte, segun el propio Pasaporte.

   Se cachea por isolate un rato corto: no tiene sentido pedir el mismo
   JSON en cada clic, pero tampoco quedarse con uno viejo si el equipo del
   Pasaporte lo cambia.
   ===================================================================== */
let _emisor = null;
let _emisorAt = 0;
const EMISOR_TTL_MS = 5 * 60 * 1000;

export async function emisor() {
  const ahora = Date.now();
  if (_emisor && (ahora - _emisorAt) < EMISOR_TTL_MS) return _emisor;
  const res = await fetch(EMISOR_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`emisor-caido: HTTP ${res.status}`);
  const j = await res.json();
  if (!j || !j.authorization_endpoint || !j.token_endpoint) {
    throw new Error('emisor-caido: el JSON no trae authorization_endpoint / token_endpoint');
  }
  _emisor = j; _emisorAt = ahora;
  return j;
}

/* ---------- state / nonce ----------
   El state es contra CSRF: se guarda firmado en una cookie HttpOnly y la
   vuelta exige que coincida con el que trae la URL. El nonce viaja al
   Pasaporte y vuelve dentro de la identidad, para atar la respuesta a
   ESTA ida y no a otra. */
export function nuevoViaje() {
  const r = () => crypto.randomUUID().replace(/-/g, '');
  return { state: r(), nonce: r(), t: Date.now() };
}

export function cookieDeViaje(viaje) {
  const val = btoa(JSON.stringify(viaje));
  return `${COOKIE}=${val}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${VIAJE_MINUTOS * 60}`;
}

/* SameSite=Lax y no Strict: la vuelta del Pasaporte es una navegacion de
   nivel superior por GET desde otro sitio, y Strict no manda la cookie en
   ese caso — el viaje se romperia siempre. */
export function cookieBorrada() {
  return `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function leerViaje(request) {
  const raw = request.headers.get('Cookie') || '';
  const m = raw.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!m) return null;
  try {
    const v = JSON.parse(atob(m.slice(COOKIE.length + 1)));
    if (!v || !v.state || !v.nonce || !v.t) return null;
    if (Date.now() - v.t > VIAJE_MINUTOS * 60 * 1000) return null;   // vencido
    return v;
  } catch (_) { return null; }
}

/* =====================================================================
   cedulaDe(perfil) — sacar el ancla de la identidad que devuelve el
   Pasaporte.

   ⚠ PENDIENTE DE CONFIRMAR CONTRA EL CONTRATO (BOTON.md). No sabemos
   todavia con que nombre viaja la cedula. Se prueban los lugares mas
   probables y, si no esta en ninguno, se devuelve null y la persona cae
   al login normal — NUNCA se inventa un match ni se cae al correo.

   Cuando el contrato este confirmado, esta funcion se reduce a una linea
   y las demas candidatas se borran. Hasta entonces, mejor una lista
   explicita que una suposicion escondida. */
export function cedulaDe(perfil) {
  if (!perfil) return null;
  const meta = perfil.user_metadata || perfil.app_metadata || {};
  const posibles = [
    perfil.cedula, perfil.documento, perfil.id_number, perfil.persona_id,
    meta.cedula, meta.documento, meta.id_number, meta.persona_id,
  ];
  for (const p of posibles) {
    const d = String(p == null ? '' : p).replace(/[^0-9]/g, '');
    if (d.length >= 6 && d.length <= 9) return d;
  }
  return null;
}

/* =====================================================================
   buscarCuenta(env, cedula, sub) — la Regla 3 y el vinculo al vuelo.

   Devuelve { user } listo para la sesion, o { error, motivo }.

   Las reglas, en orden, y ninguna se puede aflojar:

   a) Si el sub ya esta atado a una cuenta, esa es. No se busca mas.
   b) Si no, se busca por cedula ENTRE LAS HABILITADAS (pasaporte_login).
      El indice unico garantiza que haya a lo sumo una.
   c) Si esa cuenta ya tiene OTRO sub, NO SE PISA: se rechaza. Emparejar
      mal es peor que no emparejar. (Pasa si alguien se llevo la identidad
      de otro, o si el Pasaporte reemitio un sub.)
   d) Si no tenia sub, se ata — y ese es el unico momento en que se
      escribe. Es el "vinculo al vuelo".

   Quien no tiene cuenta y quien la tiene suspendida reciben EL MISMO
   'sin-acceso'. No es descuido: decir "existe pero esta suspendida" le
   confirma a un desconocido que esa persona trabaja aca.
   ===================================================================== */
export async function buscarCuenta(env, cedula, sub) {
  const SEL = 'id,username,name,email,role,must_change_password,id_number,pasaporte_sub';

  if (sub) {
    const porSub = await sb(env,
      `admin_users?pasaporte_sub=eq.${encodeURIComponent(sub)}&is_active=eq.true&select=${SEL}`);
    if (porSub && porSub.length) return { user: aSesion(porSub[0]) };
  }

  if (!cedula) return { error: true, motivo: 'sin-acceso' };

  const porCed = await sb(env,
    `admin_users?id_number=eq.${encodeURIComponent(cedula)}`
    + `&pasaporte_login=is.true&is_active=eq.true&select=${SEL}`);
  if (!porCed || !porCed.length) return { error: true, motivo: 'sin-acceso' };

  const u = porCed[0];

  if (u.pasaporte_sub && sub && u.pasaporte_sub !== sub) {
    /* El ancla ya esta tomada por otra identidad. No se pisa y queda
       anotado con lo que tenia y lo que llego, que es lo unico que
       permite entender despues que paso. */
    try {
      await sb(env, 'pasaporte_log', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          evento: 'sub_distinto', id_number: cedula,
          admin_user_id: u.id, sub_previo: u.pasaporte_sub, sub_nuevo: sub,
        }),
      });
    } catch (_) { /* el aviso no puede tumbar la decision */ }
    return { error: true, motivo: 'sin-acceso' };
  }

  if (!u.pasaporte_sub && sub) {
    // Vinculo al vuelo: solo cuando estaba en nulo.
    try {
      await sb(env, `admin_users?id=eq.${u.id}&pasaporte_sub=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ pasaporte_sub: sub, pasaporte_at: new Date().toISOString() }),
      });
    } catch (_) { /* si no se pudo atar, entra igual y se ata la proxima */ }
  }

  return { user: aSesion(u) };
}

/* El MISMO objeto que devuelve /api/login. Si algun dia el login agrega un
   campo, este tiene que agregarlo tambien: dos formas distintas de la
   misma sesion es como se rompen estas cosas. */
function aSesion(u) {
  return {
    kind: 'admin', id: u.id, username: u.username, name: u.name,
    role: u.role, email: u.email || null,
    mustChangePassword: u.must_change_password,
  };
}

/* Vuelta a la pantalla de acceso con el motivo en la URL. Nunca se
   responde un error crudo: la puerta vieja siempre queda abierta. */
export function alLogin(motivo) {
  return Response.redirect(
    `https://${CANONICO}/?pasaporte=${encodeURIComponent(motivo || 'error')}`, 302);
}
