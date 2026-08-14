/* =====================================================================
   functions/api/portal-params.js  →  /api/portal-params
   v6.25: Parámetros editables del portal (tabla nomina_v2.portal_params).
   Solo superadmin (gate real server-side, mismo patrón que config-catalogs).

   Acciones (POST {action, adminId, ...}):
     list               -> todos los parámetros (key, value, label, auditoría)
     save {key, value}  -> actualiza el valor con auditoría (updated_by/at)

   Reglas:
     - Los parámetros se CREAN por migración (INSERT), acá solo se editan:
       save rechaza claves inexistentes.
     - Claves *_dias: valor entero 0..365 (validación server-side).
     - Cualquier valor: máx 500 caracteres.
     - Primer parámetro: gap_continuidad_dias = 30 (antigüedad de Grupo,
       plan PLAN_ANTIGUEDAD_GRUPO_2026-07-18; lo lee get_group_tenure()).

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

/* =====================================================================
   PARAMETROS DE VALORES CERRADOS (v6.224, con etiquetas desde la v6.225).

   Vive UNA sola vez y sirve para dos cosas a la vez: valida el guardado y
   arma el combo de la pantalla. Si estuvieran en dos lados, agregar un
   valor nuevo al combo sin agregarlo a la validacion -o al reves- seria
   cuestion de tiempo.

   POR QUE SON CERRADOS. Un parametro de texto libre acepta cualquier cosa:
   escribir "Grupo" con mayuscula o "gruop" no daria error y la regla
   pasaria a comportarse distinto sin que nadie se entere. Un valor que
   gobierna una regla no puede fallar en silencio por un tipeo.

   La ETIQUETA es lo que se lee en el combo; el value es lo que se guarda.
   Nadie tiene por que acordarse de como se escribe internamente.
   ===================================================================== */
const CERRADOS = {
  constancia_antiguedad_base: [
    { value: 'grupo', label: 'En el grupo — el traslado entre empresas no corta la antigüedad' },
    { value: 'empresa', label: 'En la empresa actual — cuenta solo desde el ingreso a esa empresa' },
  ],
};

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

import { shadowCan } from './_auth.js';

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

// Gate: devuelve el admin (id + username) solo si es superadmin activo.
async function superadminOf(env, adminId) {
  if (!adminId) return null;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&role=eq.superadmin&is_active=eq.true&select=id,username,name`);
  return (r && r[0]) || null;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const { action, adminId } = body;

  try {
    const admin = await superadminOf(env, adminId);
    await shadowCan(env, adminId, 'portal-params', action, 'config.parametros', !!admin);
    if (!admin) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    if (action === 'list') {
      const params = await sb(env, 'portal_params?select=key,value,label,updated_at,updated_by&order=key');
      /* v6.225 — Los parametros de valores cerrados viajan con sus opciones
         para que la pantalla pinte un COMBO y no una caja de texto. Nadie
         tiene por que acordarse de si se escribe "grupo" o "empresa", ni
         arriesgarse a un tipeo en un valor que gobierna una regla.
         Las opciones salen de la MISMA constante que valida el guardado: si
         se agrega un valor nuevo, aparece en el combo solo. */
      return json({
        ok: true,
        params: (params || []).map(p => (CERRADOS[p.key]
          ? { ...p, options: CERRADOS[p.key] }
          : p)),
      });
    }

    if (action === 'save') {
      const key = String(body.key || '').trim();
      const value = String(body.value ?? '').trim();
      if (!key) return json({ ok: false, error: 'Falta la clave.' }, 400);
      if (value.length > 500) return json({ ok: false, error: 'Valor demasiado largo (máx 500).' }, 400);
      // Claves de días: entero 0..365 (gap_continuidad_dias y futuras *_dias).
      if (/_dias$/.test(key)) {
        if (!/^\d{1,3}$/.test(value) || Number(value) > 365) {
          return json({ ok: false, error: 'Debe ser un número entero de días (0 a 365).' }, 400);
        }
      }
      if (CERRADOS[key] && !CERRADOS[key].some(o => o.value === value)) {
        return json({
          ok: false,
          error: `Valor no válido. Los admitidos son: ${CERRADOS[key].map(o => o.value).join(' o ')}.`,
        }, 400);
      }
      const cur = await sb(env, `portal_params?key=eq.${encodeURIComponent(key)}&select=key`);
      if (!cur || !cur.length) return json({ ok: false, error: 'Parámetro inexistente (se crean por migración).' }, 404);
      const upd = await sb(env, `portal_params?key=eq.${encodeURIComponent(key)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          value,
          updated_at: new Date().toISOString(),
          updated_by: admin.name || admin.username || String(admin.id),
        }),
      });
      return json({ ok: true, param: (upd && upd[0]) || null });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
