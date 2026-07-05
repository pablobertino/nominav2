/* =====================================================================
   functions/api/logistic-geo.js  →  GET /api/logistic-geo
   Catalogo geografico de Venezuela para poblar los combos dependientes
   Estado -> Ciudad del modal de Empresas. Es catalogo de referencia
   (no expone datos sensibles), asi que no requiere sesion.

   Tablas (schema nomina_v2, cargadas desde los Excel del user):
     logistic_state         (state_id, name)
     logistic_city          (state_id, county_id, name)  -> ciudad por estado
     logistic_municipality  (state_id, county_id, name)  -> nombre del municipio

   Respuesta:
     { ok:true,
       states: [ { id:'ZUL', name:'ZULIA' }, ... ]  (ordenado por name)
       cities: [ { state:'ZUL', name:'MARACAIBO', municipality:'MARACAIBO' }, ... ]
     }
   La ciudad trae su municipio ya resuelto (deducido por state_id+county_id),
   de modo que el cliente puede guardar companies.municipality sin otra vuelta.
   Se cachea 6h en el edge (el catalogo cambia rara vez).

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
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
  return t ? JSON.parse(t) : [];
}

export async function onRequestGet({ env }) {
  try {
    // PostgREST corta en 1000 filas por defecto; los catalogos son <=333, ok.
    const [states, cities, munis] = await Promise.all([
      sb(env, 'logistic_state?select=state_id,name&order=name'),
      sb(env, 'logistic_city?select=state_id,county_id,name&order=name'),
      sb(env, 'logistic_municipality?select=state_id,county_id,name'),
    ]);

    // Indice (state_id, county_id) -> nombre del municipio, para deducir el
    // municipio de cada ciudad. La clave es COMPUESTA porque county_id se
    // repite entre estados.
    const muniName = {};
    (munis || []).forEach(m => { muniName[m.state_id + '|' + m.county_id] = m.name; });

    const outStates = (states || []).map(s => ({ id: s.state_id, name: s.name }));
    const outCities = (cities || []).map(c => ({
      state: c.state_id,
      name: c.name,
      municipality: muniName[c.state_id + '|' + c.county_id] || null,
    }));

    return json(
      { ok: true, states: outStates, cities: outCities },
      200,
      { 'Cache-Control': 'public, max-age=21600' }, // 6h
    );
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
