/* =====================================================================
   functions/api/_pasaporte.js — Entrar al portal con el Pasaporte Canaima.

   QUE HACE, EN UNA FRASE. Deja que una persona entre con la identidad del
   Pasaporte, sin escribir clave aca, pero SOLO si ya tiene cuenta en el
   portal. El Pasaporte dice quien es; el portal decide si puede pasar.

   ⚠ ESTADO: APAGADO. El boton no se pinta y los endpoints responden
   "apagado" mientras app_settings.pasaporte_enabled sea false.

   ---------------------------------------------------------------------
   EL PASAPORTE NO MANDA LA CEDULA. SOLO MANDA sub.

   Esto es por diseño del emisor, y ordena todo lo demas. El token y el
   userinfo traen unicamente 'sub': un identificador opaco que no dice
   nada de la persona. La cedula se pide APARTE, al servicio de cruce, y
   solo desde el servidor con un secreto.

   De ahi salen los dos caminos, en este orden:

     1) Ya conocemos ese sub -> entra. Una consulta, nada mas.
     2) No lo conocemos    -> se le pregunta al cruce quien es, y si el
                              ancla que devuelve corresponde a alguien que
                              todavia no tiene sub, se ata. Eso es el
                              "vinculo al vuelo".

   ---------------------------------------------------------------------
   EL ANCLA, TAL CUAL LA MANDA EL EMISOR

     persona -> 'V-22650737'   letra + guion + digitos, sin puntos ni
                               ceros a la izquierda
     tienda  -> 'AA01'         el alias en mayusculas

   Se guarda VERBATIM en pasaporte_ancla y se busca por ahi. La letra no
   es decoracion: V-84182018 y E-84182018 son dos personas distintas, y
   normalizarla seria inventar una equivalencia que el emisor no declara.

   ⚠ EL CORREO NO PARTICIPA DE NADA. Ni para buscar, ni para desempatar,
   ni como respaldo. No es una precaucion teorica: la cuenta
   'ana.rodriguez' tiene cargado 'karina.rodriguez@grupocanaima.net', un
   buzon que ni siquiera existe en el directorio.

   ---------------------------------------------------------------------
   LAS TRES REGLAS (las estreno la Extranet, a golpes)

   1) UN SOLO DOMINIO: ch.grupocanaima.com. El portal vive tambien en
      nominav2.pages.dev, y ese es justo el escenario que la rompio: la
      cookie del viaje se guarda en el dominio donde arranco y la vuelta
      cae siempre en el canonico. Por eso la ida SALTA al canonico ANTES
      de escribir la cookie. Ese orden es el arreglo.

   2) REDIRECT_URI ES UN TEXTO FIJO, aca y solo aca, para la ida y para la
      vuelta. Nunca se arma con el host de la peticion. Esa misma linea
      tiene que estar registrada del lado del Pasaporte.

   3) EL PASAPORTE NO CREA CUENTAS. Sin cuenta no entra, y se responde
      igual que a una suspendida: decir "existe pero esta suspendida" le
      confirma a un desconocido que esa persona trabaja aca.

   ---------------------------------------------------------------------
   LO QUE ESTO NO ES

   NO EMITE SESION. El portal no tiene token: la sesion es un objeto plano
   en sessionStorage y cada endpoint revalida leyendo el id que manda el
   cliente. Asi que esto es COMODIDAD DE LOGIN -una clave menos que
   recordar- y no una capa de seguridad. La vuelta entrega exactamente el
   mismo objeto que /api/login.

   Secrets: supabase_url, supabase_service_role, PASAPORTE_CLIENT_ID,
            PASAPORTE_CLIENT_SECRET, PASAPORTE_CRUCE_SECRET
   ===================================================================== */

export const CANONICO = 'ch.grupocanaima.com';

/* ⚠ LITERAL. No se arma con el host. Registrada igual del otro lado. */
export const REDIRECT_URI = 'https://ch.grupocanaima.com/pasaporte/volver';

/* Donde vive el Pasaporte lo dice el propio Pasaporte: el dia que se
   active id.grupocanaima.com, cambia ese archivo y aca no se toca nada. */
export const EMISOR_URL = 'https://pasaporte.grupocanaima.com/boton/emisor.json';

/* El servicio de cruce: sub -> ancla. Solo desde el servidor, con secreto. */
export const CRUCE_URL =
  'https://xvaptvkeyswqdpdkrmqa.supabase.co/functions/v1/cruce-identidades';

export const SETTING_ENABLED = 'pasaporte_enabled';

/* __Host- obliga a Secure, path=/ y sin Domain: la cookie queda atada a
   ESTE host y no se puede plantar desde un subdominio vecino. */
const COOKIE = '__Host-pasaporte_viaje';
const VIAJE_MINUTOS = 10;

/* ---------- Supabase del portal ---------- */
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

export async function activo(env) {
  if (!env.PASAPORTE_CLIENT_ID || !env.PASAPORTE_CLIENT_SECRET) {
    return { ok: false, motivo: 'sin-configurar' };
  }
  try {
    const r = await sb(env, `app_settings?key=eq.${SETTING_ENABLED}&select=value`);
    const v = r && r[0] ? String(r[0].value).toLowerCase() : 'false';
    if (v !== 'true') return { ok: false, motivo: 'apagado' };
  } catch (_) {
    // Ante la duda, apagado: la puerta vieja sigue abierta y nadie queda afuera.
    return { ok: false, motivo: 'apagado' };
  }
  return { ok: true, motivo: null };
}

/* =====================================================================
   canonizar — la Regla 1. Devuelve un 302 al canonico, o null si ya
   estamos bien.
   ⚠ HAY QUE LLAMARLA ANTES DE ESCRIBIR LA COOKIE. Si se escribe primero
   y se salta despues, la cookie queda en el dominio equivocado y la
   vuelta no la encuentra — con el mismo sintoma que no tener el arreglo.
   ===================================================================== */
export function canonizar(request) {
  const u = new URL(request.url);
  if (u.hostname === CANONICO) return null;
  u.hostname = CANONICO; u.protocol = 'https:'; u.port = '';
  return Response.redirect(u.toString(), 302);
}

let _emisor = null, _emisorAt = 0;
const EMISOR_TTL_MS = 5 * 60 * 1000;

export async function emisor() {
  const ahora = Date.now();
  if (_emisor && (ahora - _emisorAt) < EMISOR_TTL_MS) return _emisor;
  const res = await fetch(EMISOR_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`emisor-caido: HTTP ${res.status}`);
  const j = await res.json();
  if (!j || !j.authorization_endpoint || !j.token_endpoint) {
    throw new Error('emisor-caido: faltan authorization_endpoint / token_endpoint');
  }
  _emisor = j; _emisorAt = ahora;
  return j;
}

/* ---------- state / nonce ----------
   state contra CSRF (se compara con la cookie); nonce para atar la
   identidad a ESTA ida y no a otra. */
export function nuevoViaje() {
  const r = () => crypto.randomUUID().replace(/-/g, '');
  return { state: r(), nonce: r(), t: Date.now() };
}

export function cookieDeViaje(v) {
  return `${COOKIE}=${btoa(JSON.stringify(v))}; Path=/; Secure; HttpOnly; `
       + `SameSite=Lax; Max-Age=${VIAJE_MINUTOS * 60}`;
}

/* Lax y no Strict: la vuelta es una navegacion de nivel superior por GET
   desde otro sitio, y Strict no manda la cookie en ese caso. */
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
    if (Date.now() - v.t > VIAJE_MINUTOS * 60 * 1000) return null;
    return v;
  } catch (_) { return null; }
}

/* =====================================================================
   cruceIdentidades(env, subs) — preguntarle al Pasaporte quien es.

   subs = ['...']  -> las identidades de esos subs
   subs = null     -> TODAS las que pueden entrar (siembra inicial)

   Devuelve el array de { ancla, tipo, sub, alias, estado }, o null si no
   se pudo preguntar. null NO es lista vacia: una lista vacia significa
   "ese sub no corresponde a nadie" y termina en rechazo; null significa
   "no pude averiguarlo" y termina en un error distinto. Confundirlos
   haria que una caida del cruce se viera como un rechazo de acceso.
   ===================================================================== */
export async function cruceIdentidades(env, subs) {
  if (!env.PASAPORTE_CRUCE_SECRET) return null;
  try {
    const res = await fetch(CRUCE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cruce-secreto': env.PASAPORTE_CRUCE_SECRET,
        Accept: 'application/json',
      },
      body: JSON.stringify(subs && subs.length ? { subs } : {}),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j && j.identidades) ? j.identidades : null;
  } catch (_) { return null; }
}

/* =====================================================================
   vincular(env, identidades) — atar identidades a cuentas.

   UNA SOLA IMPLEMENTACION PARA LOS TRES CAMINOS: el vinculo al vuelo del
   login, el aviso que manda el Pasaporte al emitir o activar, y la
   siembra diaria. Si la regla viviera en tres lugares, alguno se
   aflojaria distinto — y el que se afloja es el que deja entrar a quien
   no debe.

   Reglas, y ninguna se negocia:
     · sin cuenta con ese ancla          -> sin_usuario
     · la cuenta ya tiene ESE sub        -> ya_estaban   (idempotente)
     · la cuenta tiene OTRO sub          -> conflicto, NO se pisa
     · la cuenta no tiene sub            -> se ata
     · el sub ya esta en otra cuenta     -> conflicto (lo frena el indice)
     · estado distinto de 'activa'       -> omitidas, no se toca nada

   Emparejar mal es peor que no emparejar: un conflicto se resuelve
   mirando la bitacora, un emparejamiento errado le da a alguien la
   cuenta de otro y nadie se entera.

   origen queda guardado en pasaporte_src: 'vuelo' | 'aviso' | 'siembra'.

   tope = cuantas ATAR como maximo en esta corrida. No es un capricho:
   Cloudflare limita las subpeticiones por request, y la primera siembra
   puede traer ~200 sin atar. Lo que no entra se cuenta en 'pendientes' y
   la proxima corrida lo agarra — las ya atadas no gastan subpeticion, asi
   que cada vuelta avanza. Sin el tope, la primera siembra se corta a la
   mitad y nadie sabe por donde iba.
   ===================================================================== */
export async function vincular(env, identidades, origen = 'vuelo', tope = 40) {
  const r = { vinculadas: 0, ya_estaban: 0, sin_usuario: 0, conflicto: [], omitidas: 0, pendientes: 0 };
  const lista = Array.isArray(identidades) ? identidades : [];
  if (!lista.length) return r;

  const ahora = new Date().toISOString();

  /* Se agrupa por tipo y se consulta en dos viajes, no en uno por fila:
     el aviso tiene que contestar en menos de 8 segundos. */
  const porTipo = { persona: [], tienda: [] };
  for (const i of lista) {
    if (!i || !i.ancla || !i.sub) { r.omitidas++; continue; }
    if (i.estado && String(i.estado).toLowerCase() !== 'activa') { r.omitidas++; continue; }
    const tipo = String(i.tipo || '').toLowerCase() === 'tienda' ? 'tienda' : 'persona';
    porTipo[tipo].push({ ancla: String(i.ancla).trim(), sub: String(i.sub).trim() });
  }

  const TABLAS = {
    persona: { tabla: 'admin_users',   sel: 'id,username,pasaporte_ancla,pasaporte_sub' },
    tienda:  { tabla: 'company_users', sel: 'id,company_code,pasaporte_ancla,pasaporte_sub' },
  };

  for (const tipo of ['persona', 'tienda']) {
    const items = porTipo[tipo];
    if (!items.length) continue;
    const { tabla, sel } = TABLAS[tipo];

    const anclas = [...new Set(items.map(x => x.ancla))];
    const enLista = anclas.map(a => `"${a.replace(/"/g, '')}"`).join(',');
    let filas;
    try {
      filas = await sb(env,
        `${tabla}?pasaporte_ancla=in.(${enLista})&pasaporte_login=is.true`
        + `&is_active=eq.true&select=${sel}`) || [];
    } catch (_) { filas = []; }

    const porAncla = new Map(filas.map(f => [f.pasaporte_ancla, f]));

    for (const it of items) {
      const u = porAncla.get(it.ancla);
      if (!u) { r.sin_usuario++; continue; }
      if (u.pasaporte_sub === it.sub) { r.ya_estaban++; continue; }

      if (u.pasaporte_sub) {
        r.conflicto.push({ ancla: it.ancla, tipo, motivo: 'la cuenta ya tiene otra identidad' });
        await anotar(env, 'sub_distinto', it.ancla, u, it.sub);
        continue;
      }

      if (r.vinculadas >= tope) { r.pendientes++; continue; }

      /* Se ata SOLO si sigue en nulo. El filtro va en el WHERE y no en un
         if previo: dos avisos simultaneos del Pasaporte no pueden ambos
         creer que estaba libre. */
      try {
        const patch = await sb(env,
          `${tabla}?id=eq.${u.id}&pasaporte_sub=is.null`, {
            method: 'PATCH', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              pasaporte_sub: it.sub, pasaporte_at: ahora, pasaporte_src: origen,
            }),
          });
        if (patch && patch.length) r.vinculadas++;
        else { r.ya_estaban++; }          // otro lo ato entre medio
      } catch (_) {
        /* El indice unico de pasaporte_sub rechaza si ese sub ya esta en
           otra cuenta. Es un conflicto real, no un fallo tecnico. */
        r.conflicto.push({ ancla: it.ancla, tipo, motivo: 'esa identidad ya esta en otra cuenta' });
        await anotar(env, 'sub_en_otra_cuenta', it.ancla, u, it.sub);
      }
    }
  }
  return r;
}

async function anotar(env, evento, ancla, u, subNuevo) {
  try {
    await sb(env, 'pasaporte_log', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        evento, id_number: ancla, admin_user_id: u ? u.id : null,
        sub_previo: u ? u.pasaporte_sub : null, sub_nuevo: subNuevo,
      }),
    });
  } catch (_) { /* la bitacora no puede tumbar la decision */ }
}

/* =====================================================================
   porSub(env, sub) — el camino rapido: ¿ya conocemos esta identidad?
   Busca en las dos tablas. Devuelve el objeto de sesion o null.
   ===================================================================== */
export async function porSub(env, sub) {
  if (!sub) return null;
  const s = encodeURIComponent(sub);

  const a = await sb(env,
    `admin_users?pasaporte_sub=eq.${s}&is_active=eq.true`
    + `&select=id,username,name,email,role,must_change_password`);
  if (a && a.length) {
    const u = a[0];
    return {
      kind: 'admin', id: u.id, username: u.username, name: u.name,
      role: u.role, email: u.email || null,
      mustChangePassword: u.must_change_password,
    };
  }

  const c = await sb(env,
    `company_users?pasaporte_sub=eq.${s}&is_active=eq.true`
    + `&select=id,company_code,email,must_change_password`);
  if (c && c.length) {
    const u = c[0];
    /* El tipo de empresa decide si su Personal/Reportes trabajan sobre
       tiendas o sobre empresas. Se resuelve igual que en /api/login para
       que la sesion sea identica venga de donde venga. */
    let companyType = null;
    try {
      const cc = await sb(env,
        `companies?company_code=eq.${encodeURIComponent(u.company_code)}&select=company_type`);
      companyType = cc && cc[0] ? cc[0].company_type : null;
    } catch (_) { /* no critico */ }
    return {
      kind: 'company', id: u.id, companyCode: u.company_code, companyType,
      email: u.email || null, mustChangePassword: u.must_change_password,
    };
  }
  return null;
}

/* Vuelta a la pantalla de acceso con el motivo. Nunca un error crudo: la
   puerta vieja siempre queda abierta. Ningun motivo habla de una persona. */
export function alLogin(motivo) {
  return Response.redirect(
    `https://${CANONICO}/?pasaporte=${encodeURIComponent(motivo || 'error')}`, 302);
}
