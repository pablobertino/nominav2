/* =====================================================================
   functions/api/admin-scope.js  →  /api/admin-scope
   Editor de alcance de un admin. Solo superadmin. Acciones (POST {action}):
     - get:  devuelve include/exclude actuales del admin + catálogos
             (zones, subzones, companies) para poblar el buscador.
     - save: reemplaza por completo el include/exclude del admin.

   scope_type ∈ {zone, subzone, company}
   scope_value = zone.id | subzone.id | company.company_code

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }); }

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

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action, adminId, targetId } = body;

  try {
    if (!(await isSuperadmin(env, adminId))) return json({ ok: false, error: 'Requiere superadmin.' }, 403);
    if (!targetId) return json({ ok: false, error: 'Falta el admin objetivo.' }, 400);

    if (action === 'get') {
      const [inc, exc, zones, subzones, companies] = await Promise.all([
        sb(env, `admin_scope_include?admin_id=eq.${targetId}&select=scope_type,scope_value`),
        sb(env, `admin_scope_exclude?admin_id=eq.${targetId}&select=scope_type,scope_value`),
        sb(env, 'zones?select=id,name&order=name'),
        sb(env, 'subzones?select=id,name,zone_id&order=name'),
        sb(env, 'companies?select=company_code,business_name,zone_id,subzone_id&company_type=eq.Tienda&order=company_code'),
      ]);
      return json({ ok: true, include: inc || [], exclude: exc || [], zones, subzones, companies });
    }

    if (action === 'save') {
      const { include, exclude } = body; // arrays de {scope_type, scope_value}
      // Validación básica de tipos
      const valid = (arr) => Array.isArray(arr) && arr.every(x =>
        ['zone', 'subzone', 'company'].includes(x.scope_type) && x.scope_value);
      if (!valid(include) || !valid(exclude)) return json({ ok: false, error: 'Datos de alcance inválidos.' }, 400);

      // Reemplazo total: borrar lo existente y reinsertar
      await sb(env, `admin_scope_include?admin_id=eq.${targetId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      await sb(env, `admin_scope_exclude?admin_id=eq.${targetId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });

      if (include.length) {
        await sb(env, 'admin_scope_include', {
          method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(include.map(x => ({ admin_id: targetId, scope_type: x.scope_type, scope_value: String(x.scope_value) }))),
        });
      }
      if (exclude.length) {
        await sb(env, 'admin_scope_exclude', {
          method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(exclude.map(x => ({ admin_id: targetId, scope_type: x.scope_type, scope_value: String(x.scope_value) }))),
        });
      }
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
