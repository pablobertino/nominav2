/* =====================================================================
   functions/api/admin-scope.js  →  /api/admin-scope
   Editor de alcance de un admin. Solo superadmin. Acciones (POST {action}):
     - get:  devuelve include/exclude actuales del admin + catálogos
             (zones, subzones, companies) para poblar el buscador.
     - save: reemplaza por completo el include/exclude del admin.

   scope_type ∈ {zone, subzone, company, department}
   scope_value = zone.id | subzone.id | company.company_code | department.id
   (department: solo para empresas no-tienda; concede acceso a la empresa
    dueña del departamento y restringe el personal a ese departamento)

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

// --- Helpers osTicket (la clave API NO viaja al navegador; la usa el Worker) ---
async function getSetting(env, key, fallback) {
  const r = await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  return (r && r[0] && r[0].value != null) ? r[0].value : fallback;
}
async function osticketBase(env) {
  const url = await getSetting(env, 'osticket_url', '');
  return String(url || '').replace(/\/+$/, '');
}
// Llama a gc-agent.json con un body {action, ...}. Devuelve el JSON o lanza.
async function gcAgent(env, base, data) {
  const res = await fetch(`${base}/api/gc-agent.json`, {
    method: 'POST',
    headers: { 'X-API-Key': env.osticket_api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const text = await res.text();
  let js = null;
  try { js = text ? JSON.parse(text) : null; } catch { /* no-json */ }
  if (!res.ok || !js || !js.ok) {
    const detail = (js && (js.error || (js.details && js.details.join('; ')))) || text || 'sin detalle';
    throw new Error(`gc-agent ${res.status}: ${detail}`);
  }
  return js;
}
// Genera una clave temporal robusta (para el primer alta del agente).
function tempPassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const low = 'abcdefghijkmnpqrstuvwxyz';
  const num = '23456789';
  const sym = '#$%&*+=?';
  const all = abc + low + num + sym;
  const pick = (s) => s[Math.floor(Math.random() * s.length)];
  let p = pick(abc) + pick(low) + pick(num) + pick(sym);
  for (let i = 0; i < 10; i++) p += pick(all);
  // mezclar
  return p.split('').sort(() => Math.random() - 0.5).join('');
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action, adminId, targetId } = body;

  try {
    if (!(await isSuperadmin(env, adminId))) return json({ ok: false, error: 'Requiere superadmin.' }, 403);
    if (!targetId) return json({ ok: false, error: 'Falta el admin objetivo.' }, 400);

    if (action === 'get') {
      const [inc, exc, zones, subzones, companies, departments] = await Promise.all([
        sb(env, `admin_scope_include?admin_id=eq.${targetId}&select=scope_type,scope_value`),
        sb(env, `admin_scope_exclude?admin_id=eq.${targetId}&select=scope_type,scope_value`),
        sb(env, 'zones?select=id,name&order=name'),
        sb(env, 'subzones?select=id,name,zone_id&order=name'),
        sb(env, 'companies?select=company_code,business_name,zone_id,subzone_id,company_type,is_active&order=company_code'),
        sb(env, 'departments?select=id,company_code,name&is_active=eq.true&order=company_code,name'),
      ]);
      return json({ ok: true, include: inc || [], exclude: exc || [], zones, subzones, companies, departments: departments || [] });
    }

    if (action === 'resolve') {
      // Resuelve el alcance (include - exclude) a la lista plana de tiendas
      // gestionables, con su user de osTicket. Fuente unica de verdad: la
      // funcion SQL resolve_admin_scope. Devuelve resumen para la pantalla
      // y el sync hacia osTicket (Fase 4).
      const rows = await sb(env, `rpc/resolve_admin_scope`, {
        method: 'POST',
        body: JSON.stringify({ p_admin_id: Number(targetId) }),
      });
      const list = rows || [];
      const withUser = list.filter(r => Number(r.osticket_user_id) > 0);
      return json({
        ok: true,
        companies: list,
        summary: {
          total: list.length,
          with_osticket_user: withUser.length,
          pending_osticket_user: list.length - withUser.length,
          osticket_user_ids: withUser.map(r => r.osticket_user_id),
        },
      });
    }

    if (action === 'push_to_osticket') {
      // Empuja el alcance del admin objetivo a osTicket. Tres pasos:
      //  1) Asegurar el agente (upsert_agent) -> staff_id; guardarlo en
      //     admin_users.osticket_staff_id.
      //  2) Resolver el alcance a user_ids (resolve_admin_scope).
      //  3) sync_scope con esos user_ids.
      const base = await osticketBase(env);
      if (!base || !env.osticket_api_key) {
        return json({ ok: false, error: 'osTicket no esta configurado (URL o clave API).' }, 400);
      }
      // Datos del admin objetivo (para crear/actualizar el agente).
      const arr = await sb(env,
        `admin_users?id=eq.${encodeURIComponent(targetId)}&select=id,username,name,email,osticket_staff_id`);
      const target = arr && arr[0];
      if (!target) return json({ ok: false, error: 'Admin objetivo no encontrado.' }, 404);
      if (!target.email) return json({ ok: false, error: 'El admin no tiene correo; es obligatorio para crear el agente en osTicket.' }, 400);

      // Nombre: partir 'name' en primero/resto. Si no hay name, usar username.
      const fullName = (target.name || target.username || '').trim();
      const parts = fullName.split(/\s+/);
      const firstname = parts.shift() || target.username || 'Agente';
      const lastname = parts.join(' ') || '.';

      // 1) upsert_agent. Si el admin aun no tiene staff vinculado, generamos
      //    una clave temporal (se devuelve UNA vez al superadmin).
      let tempPwd = null;
      const agentBody = {
        action: 'upsert_agent',
        username: target.username,
        firstname, lastname,
        email: target.email,
        change_passwd: true,
      };
      if (!target.osticket_staff_id) {
        tempPwd = tempPassword();
        agentBody.password = tempPwd;
      }
      const up = await gcAgent(env, base, agentBody);
      const staffId = up.staff_id;

      // Guardar el puente de identidad si cambio o estaba vacio.
      if (staffId && staffId !== target.osticket_staff_id) {
        await sb(env, `admin_users?id=eq.${encodeURIComponent(targetId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_staff_id: staffId }),
        });
      }

      // 2) Resolver alcance a user_ids (solo tiendas con user en osTicket).
      const rows = await sb(env, `rpc/resolve_admin_scope`, {
        method: 'POST',
        body: JSON.stringify({ p_admin_id: Number(targetId) }),
      });
      const list = rows || [];
      const withUser = list.filter(r => Number(r.osticket_user_id) > 0);
      const userIds = withUser.map(r => r.osticket_user_id);
      const codes = withUser.map(r => r.company_code);

      // 3) sync_scope.
      const sc = await gcAgent(env, base, {
        action: 'sync_scope',
        staff_id: staffId,
        user_ids: userIds,
        company_codes: codes,
      });

      // Marcar la fecha de sincronizacion del alcance.
      await sb(env, `admin_users?id=eq.${encodeURIComponent(targetId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ osticket_scope_synced_at: new Date().toISOString() }),
      });

      return json({
        ok: true,
        staff_id: staffId,
        agent_created: up.created,
        scope_count: sc.count,
        scope_total: list.length,
        scope_pending_user: list.length - withUser.length,
        // La clave temporal SOLO se devuelve cuando se creo el agente ahora.
        temp_password: tempPwd,
      });
    }

    if (action === 'save') {
      const { include, exclude } = body; // arrays de {scope_type, scope_value}
      // Validación básica de tipos
      const valid = (arr) => Array.isArray(arr) && arr.every(x =>
        ['zone', 'subzone', 'company', 'department'].includes(x.scope_type) && x.scope_value);
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
