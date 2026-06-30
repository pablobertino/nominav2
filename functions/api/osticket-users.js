/* =====================================================================
   functions/api/osticket-users.js  →  /api/osticket-users
   Sincronizacion de los usuarios-tienda con osTicket (el "From" de los
   tickets). Permite ver que tiendas estan creadas en osTicket y cuales
   no, y crearlas/actualizarlas (idempotente, via gc-user.json).

   Acciones (POST {action, adminId, ...}):
     - list: lista tiendas (tipo Tienda) con su estado de sincronizacion
             osTicket (osticket_user_id, osticket_synced_at) y su correo.
     - sync: sincroniza una o varias tiendas. Body:
             { codes: ['AA01', ...] }  -> esas
             { all: true }             -> todas las que tengan correo
        Por cada tienda con correo: llama gc-user.json (crea/actualiza el
        usuario-tienda con name="CC - Razon Social", email, phone) y guarda
        el user_id devuelto + la fecha en companies.

   Autorizacion: { adminId } de un superadmin activo (se revalida).
   La clave API de osTicket NO viaja al navegador: la usa este Worker
   (Secret osticket_api_key). La URL sale de app_settings.osticket_url.

   Secrets: supabase_url, supabase_service_role, osticket_api_key
   Settings: osticket_url
   ===================================================================== */

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

async function sb(env, path, opts = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2',
      'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

// Lee un setting de app_settings por key.
async function getSetting(env, key, fallback) {
  const r = await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  return (r && r[0] && r[0].value != null) ? r[0].value : fallback;
}

// Base URL del osTicket (sin barra final).
async function osticketBase(env) {
  const url = await getSetting(env, 'osticket_url', '');
  return String(url || '').replace(/\/+$/, '');
}

// Llama a gc-user.json. Devuelve { ok, user_id, created } o lanza/da error.
async function gcUser(env, base, data) {
  const res = await fetch(`${base}/api/gc-user.json`, {
    method: 'POST',
    headers: { 'X-API-Key': env.osticket_api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const text = await res.text();
  let js = null;
  try { js = text ? JSON.parse(text) : null; } catch { /* no-json */ }
  if (!res.ok || !js || !js.user_id) {
    throw new Error(`gc-user ${res.status}: ${text || 'sin detalle'}`);
  }
  return js; // { ok, user_id, created }
}

// Valida que el llamador sea superadmin activo.
async function requireSuper(env, adminId) {
  if (!adminId) return false;
  const rows = await sb(env,
    `admin_users?id=eq.${encodeURIComponent(adminId)}&role=eq.superadmin&is_active=eq.true&select=id`);
  return !!(rows && rows.length);
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const { action, adminId } = body;

  try {
    if (!(await requireSuper(env, adminId))) {
      return json({ ok: false, error: 'Requiere superadmin.' }, 403);
    }

    if (action === 'list') return await listTiendas(env);
    if (action === 'sync') return await syncTiendas(env, body);
    return json({ ok: false, error: 'Accion no reconocida.' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}

/* Lista las tiendas (company_type Tienda) con su estado osTicket. */
async function listTiendas(env) {
  const rows = await sb(env,
    `companies?company_type=eq.Tienda&select=company_code,business_name,email,phone,osticket_user_id,osticket_synced_at&order=company_code`);
  const tiendas = (rows || []).map(c => ({
    code: c.company_code,
    name: c.business_name || '',
    email: c.email || '',
    phone: c.phone || '',
    osticket_user_id: c.osticket_user_id || null,
    synced_at: c.osticket_synced_at || null,
    // estado derivado: synced (tiene user_id) | pending (tiene correo, sin user_id) | no_email
    state: c.osticket_user_id ? 'synced' : (c.email ? 'pending' : 'no_email'),
  }));
  const summary = {
    total: tiendas.length,
    synced: tiendas.filter(t => t.state === 'synced').length,
    pending: tiendas.filter(t => t.state === 'pending').length,
    no_email: tiendas.filter(t => t.state === 'no_email').length,
  };
  return json({ ok: true, tiendas, summary });
}

/* Sincroniza una o varias tiendas con osTicket (crea/actualiza usuario).
   Por limite de subrequests de Cloudflare (~50 fetch salientes por
   invocacion) NO se procesan todas de un golpe cuando se pide all:true:
   se procesa una TANDA (limit, default 12, cada tienda usa 2 fetch ->
   ~24 subrequests) y se devuelve remaining/done para que el cliente
   vuelva a llamar en bucle. Con codes:[...] se procesan las indicadas
   (el cliente ya las acota). */
async function syncTiendas(env, body) {
  const base = await osticketBase(env);
  if (!base || !env.osticket_api_key) {
    return json({ ok: false, error: 'osTicket no esta configurado (URL o clave API).' }, 400);
  }

  // Resolver el conjunto de tiendas a sincronizar.
  let filter, isAll = false, limit = 0;
  if (body.all === true) {
    isAll = true;
    // Tope de tienda(s) por tanda. Cada tienda hace 2 fetch (gc-user + PATCH);
    // 12 -> ~24 subrequests, bajo el limite de Cloudflare. Maximo 20.
    limit = Math.min(Math.max(parseInt(body.limit, 10) || 12, 1), 20);
    // Solo PENDIENTES con correo: las que aun no tienen osticket_user_id.
    // Asi cada tanda avanza sobre las que faltan (idempotente y sin repetir).
    filter = `company_type=eq.Tienda&email=not.is.null&osticket_user_id=is.null&order=company_code&limit=${limit}`;
  } else if (Array.isArray(body.codes) && body.codes.length) {
    const list = body.codes.map(c => encodeURIComponent(String(c))).join(',');
    filter = `company_code=in.(${list})`;
  } else {
    return json({ ok: false, error: 'Indica codes:[...] o all:true.' }, 400);
  }

  const tiendas = await sb(env,
    `companies?${filter}&select=company_code,business_name,email,phone`);
  if (!tiendas || !tiendas.length) {
    return json({ ok: true, processed: 0, ok_count: 0, fail_count: 0, results: [], remaining: 0, done: true, note: 'No hay tiendas que sincronizar.' });
  }

  const results = [];
  let okCount = 0, failCount = 0;
  const nowIso = new Date().toISOString();

  for (const t of tiendas) {
    const cc = t.company_code;
    const email = (t.email || '').trim();
    if (!email) {
      results.push({ code: cc, ok: false, error: 'Sin correo.' });
      failCount++;
      continue;
    }
    const name = `${cc} - ${t.business_name || cc}`;
    try {
      const r = await gcUser(env, base, { email, name, phone: (t.phone || '').trim() });
      // Guardar el user_id y la fecha en Supabase.
      await sb(env, `companies?company_code=eq.${encodeURIComponent(cc)}`, {
        method: 'PATCH',
        body: JSON.stringify({ osticket_user_id: r.user_id, osticket_synced_at: nowIso }),
      });
      results.push({ code: cc, ok: true, user_id: r.user_id, created: r.created });
      okCount++;
    } catch (e) {
      results.push({ code: cc, ok: false, error: String(e.message || e) });
      failCount++;
    }
  }

  // Cuando es all:true, calcular cuantas pendientes quedan (con correo y sin
  // user_id) para que el cliente sepa si debe seguir iterando. Si en la tanda
  // hubo fallos, esas siguen contando como pendientes (no se marcaron) y el
  // cliente las reintentara; para evitar bucle infinito, el cliente corta si
  // remaining no baja entre llamadas.
  let remaining = 0, done = true;
  if (isAll) {
    const pend = await sb(env,
      `companies?company_type=eq.Tienda&email=not.is.null&osticket_user_id=is.null&select=company_code`);
    remaining = (pend || []).length;
    done = remaining === 0;
  }

  return json({
    ok: true,
    processed: tiendas.length,
    ok_count: okCount,
    fail_count: failCount,
    results,
    remaining,
    done,
  });
}
