/* =====================================================================
   functions/api/settings.js  →  /api/settings
   Configuración del portal (tabla app_settings, clave-valor). Solo
   superadmin. Acciones (POST {action}):
     - list: devuelve los settings. Para claves is_secret NUNCA se
             devuelve el value real, solo { configured: true|false }.
     - save: guarda el value de una clave NO secreta.

   Los secretos (API keys) no se gestionan aquí: van como Secret de
   Cloudflare y solo los usan los Workers del lado servidor.

   Secrets: supabase_url, supabase_service_role
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
      'Accept-Profile': 'nomina_v2', 'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
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

// Validación ligera por tipo
function validate(kind, value) {
  const v = (value || '').trim();
  if (v === '') return { ok: true, value: '' }; // vacío permitido (limpia el setting)
  if (kind === 'url') {
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'La URL debe empezar con http:// o https://' };
      // Normaliza quitando barra final
      return { ok: true, value: v.replace(/\/+$/, '') };
    } catch { return { ok: false, error: 'URL inválida.' }; }
  }
  if (kind === 'email') {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return { ok: false, error: 'Correo inválido.' };
    return { ok: true, value: v.toLowerCase() };
  }
  if (kind === 'number') {
    if (!/^\d+$/.test(v)) return { ok: false, error: 'Debe ser un número.' };
    return { ok: true, value: v };
  }
  return { ok: true, value: v };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action, adminId } = body;

  try {
    if (!(await isSuperadmin(env, adminId))) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    if (action === 'list') {
      const rows = await sb(env, 'app_settings?select=key,value,label,description,kind,is_secret,grupo,sort_order,updated_at&order=sort_order');
      // Enmascarar secretos: nunca enviar el value real al navegador
      const safe = (rows || []).map(r => {
        if (r.is_secret) {
          return { key: r.key, label: r.label, description: r.description, kind: r.kind,
                   grupo: r.grupo, sort_order: r.sort_order,
                   is_secret: true, configured: !!(r.value && r.value.length), updated_at: r.updated_at };
        }
        return r;
      });
      return json({ ok: true, settings: safe });
    }

    if (action === 'save') {
      const { key, value } = body;
      if (!key) return json({ ok: false, error: 'Falta la clave.' }, 400);
      // Releer la fila para conocer su tipo y si es secreto
      const cur = await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}&select=key,kind,is_secret`);
      if (!cur || !cur.length) return json({ ok: false, error: 'Configuración desconocida.' }, 404);
      if (cur[0].is_secret) {
        return json({ ok: false, error: 'Este valor es un secreto y no se gestiona desde el portal.' }, 403);
      }
      const v = validate(cur[0].kind, value);
      if (!v.ok) return json({ ok: false, error: v.error }, 400);
      await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ value: v.value, updated_at: new Date().toISOString(), updated_by: adminId }),
      });
      return json({ ok: true, value: v.value });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
