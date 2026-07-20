/* =====================================================================
   functions/api/admin-scope.js  →  /api/admin-scope
   Editor de alcance de un admin. Autorizacion tabla-driven (v6.48): exige el
   permiso team.scope (get/save/resolve) o team.osticket (push/reset) segun la
   accion; superadmin pasa siempre y coordinador si tiene el permiso. Acciones:
     - get:  devuelve include/exclude actuales del admin + catálogos
             (zones, subzones, companies) para poblar el buscador.
     - save: reemplaza por completo el include/exclude del admin.

   scope_type ∈ {zone, subzone, company, department}
   scope_value = zone.id | subzone.id | company.company_code | department.id
   (department: solo para empresas no-tienda; concede acceso a la empresa
    dueña del departamento y restringe el personal a ese departamento)

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { shadowCan, resolveActor, can } from './_auth.js';

// Mapa accion -> code. save/get/resolve son gestion de alcance (team.scope);
// las acciones de agente osTicket usan team.osticket.
const SCOPE_CODE_BY_ACTION = {
  get: 'team.scope',
  save: 'team.scope',
  resolve: 'team.scope',
  push_to_osticket: 'team.osticket',
  reset_agent: 'team.osticket',
};

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
    // v6.48: autorizacion tabla-driven (Fase 3). El actor se resuelve contra BD
    // y se exige el permiso del mapa (team.scope / team.osticket segun accion).
    // superadmin pasa siempre (can() le da true); coordinador pasa si tiene el
    // permiso en role_permissions. Se conserva shadowCan invertido para SEGUIR
    // auditando: registra si el gate viejo (solo-superadmin) habria diferido.
    const code = SCOPE_CODE_BY_ACTION[action] || 'team.scope';
    const actor = await resolveActor(env, { kind: 'admin', id: adminId });
    const allowed = can(actor, code);
    const legacyOk = await isSuperadmin(env, adminId);
    await shadowCan(env, adminId, 'admin-scope', action || '?', code, legacyOk);
    if (!allowed) return json({ ok: false, error: 'No tienes permiso para esta accion.' }, 403);
    if (!targetId) return json({ ok: false, error: 'Falta el admin objetivo.' }, 400);

    // v6.48: chequeo de JERARQUIA (defensa en profundidad, ademas del frontend).
    // Quien NO es superadmin no puede tocar el alcance de un superadmin ni de
    // otro coordinador. superadmin conserva acceso total.
    if (actor && actor.role !== 'superadmin') {
      const tRows = await sb(env, `admin_users?id=eq.${encodeURIComponent(targetId)}&select=role`);
      const tRole = tRows && tRows[0] && tRows[0].role;
      if (tRole === 'superadmin' || tRole === 'coordinador') {
        return json({ ok: false, error: 'No puedes gestionar el alcance de este usuario.' }, 403);
      }
    }

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
      // Empuja el alcance COMPLETO del admin objetivo a osTicket (tiendas +
      // empresas no-tienda + departamentos): el agente ve en su bandeja los
      // usuarios (remitentes) de TODO su alcance. Pasos:
      //  1) Asegurar el agente (upsert_agent) -> staff_id.
      //     - Si NO existe agente y NO viene credencial (username/password),
      //       NO se crea a ciegas: se devuelve needs_agent:true para que el
      //       front lance el modal de creacion (clave temporal o definida).
      //  2) Resolver alcance completo a user_ids (resolve_admin_scope_full).
      //  3) sync_scope con esos user_ids.
      // Parametros opcionales del body:
      //   username        -> usuario del agente (por defecto admin.username)
      //   password        -> clave a fijar (si se crea o se resetea)
      //   reset_password   -> true: forzar reset de clave aunque ya exista
      const base = await osticketBase(env);
      if (!base || !env.osticket_api_key) {
        return json({ ok: false, error: 'osTicket no esta configurado (URL o clave API).' }, 400);
      }
      const { username, password, reset_password } = body;
      // Datos del admin objetivo (para crear/actualizar el agente).
      const arr = await sb(env,
        `admin_users?id=eq.${encodeURIComponent(targetId)}&select=id,username,name,email,role,osticket_staff_id`);
      const target = arr && arr[0];
      if (!target) return json({ ok: false, error: 'Admin objetivo no encontrado.' }, 404);

      // Solo admin/superadmin son AGENTES de osTicket. Los gestores son
      // CLIENTES (se sincronizan con action 'sync_client' en admin-users) y
      // los editores no tienen osTicket. Si el target no es agente NO se crea
      // agente: se informa skipped para que el front solo guarde el alcance en
      // el portal y vuelva sin pedir credenciales.
      if (target.role !== 'admin' && target.role !== 'superadmin') {
        return json({ ok: true, skipped: true, reason: target.role,
          message: target.role === 'gestor_empresa'
            ? 'Los gestores son clientes de osTicket, no agentes: el alcance se guardo; sincroniza su usuario cliente desde el boton osTicket de su fila.'
            : 'Este rol no tiene agente en osTicket; el alcance se guardo en el portal.' });
      }
      if (!target.email) return json({ ok: false, error: 'El admin no tiene correo; es obligatorio para crear el agente en osTicket.' }, 400);

      const hasAgent = !!target.osticket_staff_id;
      const gotPwd = password != null && String(password).length > 0;
      // Si aun no hay agente y no vino clave, el front debe pedir la creacion.
      if (!hasAgent && !gotPwd) {
        return json({ ok: true, needs_agent: true, username: target.username, name: target.name || target.username });
      }
      if (gotPwd && String(password).length < 6) {
        return json({ ok: false, error: 'La clave debe tener al menos 6 caracteres.' }, 400);
      }

      // Nombre: partir 'name' en primero/resto. Si no hay name, usar username.
      const fullName = (target.name || target.username || '').trim();
      const parts = fullName.split(/\s+/);
      const firstname = parts.shift() || target.username || 'Agente';
      const lastname = parts.join(' ') || '.';

      // 1) upsert_agent. Fija clave si: se esta creando (gotPwd), o se pidio
      //    reset explicito. change_passwd:true = osTicket exige cambio al
      //    entrar. Si el usuario definio una clave manual, respetamos la que
      //    mando; si no vino, generamos una temporal (solo en creacion/reset).
      let usedPwd = null;
      const agentBody = {
        action: 'upsert_agent',
        username: (username && String(username).trim()) || target.username,
        firstname, lastname,
        email: target.email,
        change_passwd: true,
      };
      if (gotPwd || reset_password) {
        usedPwd = gotPwd ? String(password) : tempPassword();
        agentBody.password = usedPwd;
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

      // 2) Resolver alcance COMPLETO a user_ids (tiendas + empresas con user).
      const rows = await sb(env, `rpc/resolve_admin_scope_full`, {
        method: 'POST',
        body: JSON.stringify({ p_admin_id: Number(targetId) }),
      });
      const list = rows || [];
      const withUser = list.filter(r => Number(r.osticket_user_id) > 0);
      // Mapa user_id -> company_code (para la traza que acompana a sync_scope).
      const userToCode = new Map();
      for (const r of withUser) {
        const uid = Number(r.osticket_user_id);
        if (!userToCode.has(uid)) userToCode.set(uid, r.company_code);
      }

      // 2b) GESTORES ENTRELAZADOS. Las empresas NO-tienda no generan tickets a
      //     nombre de la empresa: el portal los crea a nombre del GESTOR
      //     (gestor_empresa) que la maneja. Por eso el alcance de osTicket
      //     debe incluir tambien el osticket_user_id de los gestores
      //     entrelazados con el alcance de este admin. Asi el agente ve en su
      //     bandeja los tickets que esos gestores generan (que son los de sus
      //     empresas no-tienda). La empresa concreta solo consta en el cuerpo
      //     del ticket, no en el remitente; por diseno el agente ve TODO lo de
      //     sus gestores (aceptado: un admin que toma a un gestor ve todas las
      //     empresas de ese gestor).
      const gestorRows = await sb(env, `rpc/gestores_in_admin_scope`, {
        method: 'POST',
        body: JSON.stringify({ p_admin_id: Number(targetId) }),
      });
      const gestorIds = (gestorRows || [])
        .map(g => Number(g.gestores_in_admin_scope ?? g))
        .filter(n => Number.isInteger(n) && n > 0);
      let gestorUserCount = 0;
      if (gestorIds.length) {
        const gestores = await sb(env,
          `admin_users?id=in.(${gestorIds.join(',')})&select=id,username,osticket_user_id`);
        for (const g of (gestores || [])) {
          const uid = Number(g.osticket_user_id);
          if (uid > 0 && !userToCode.has(uid)) {
            // company_code de traza: marcamos con el username del gestor para
            // distinguirlo (no es una empresa; gc_agent_scope lo acepta como texto).
            userToCode.set(uid, `gestor:${g.username}`);
            gestorUserCount++;
          }
        }
      }

      // Lista final de user_ids (empresas del alcance + gestores entrelazados),
      // deduplicada por el Map.
      const userIds = [...userToCode.keys()];
      const codes = userIds.map(uid => userToCode.get(uid));

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
        gestor_user_count: gestorUserCount,   // gestores entrelazados sumados al alcance osTicket
        // La clave se devuelve cuando se creo o se reseteo el agente ahora.
        temp_password: usedPwd,
        agent_username: agentBody.username,
      });
    }

    if (action === 'reset_agent') {
      // Resetea (o crea) la clave del agente de un admin, sin tocar el alcance.
      // Reusa la logica de upsert_agent. Body: username?, password? (si no
      // viene password, genera temporal). Devuelve credenciales para entregar.
      const base = await osticketBase(env);
      if (!base || !env.osticket_api_key) {
        return json({ ok: false, error: 'osTicket no esta configurado (URL o clave API).' }, 400);
      }
      const { username, password } = body;
      const arr = await sb(env,
        `admin_users?id=eq.${encodeURIComponent(targetId)}&select=id,username,name,email,role,osticket_staff_id`);
      const target = arr && arr[0];
      if (!target) return json({ ok: false, error: 'Admin objetivo no encontrado.' }, 404);
      if (!target.email) return json({ ok: false, error: 'El admin no tiene correo; es obligatorio para el agente en osTicket.' }, 400);
      if (password != null && String(password).length && String(password).length < 6) {
        return json({ ok: false, error: 'La clave debe tener al menos 6 caracteres.' }, 400);
      }
      const fullName = (target.name || target.username || '').trim();
      const parts = fullName.split(/\s+/);
      const firstname = parts.shift() || target.username || 'Agente';
      const lastname = parts.join(' ') || '.';
      const usedPwd = (password != null && String(password).length) ? String(password) : tempPassword();
      const up = await gcAgent(env, base, {
        action: 'upsert_agent',
        username: (username && String(username).trim()) || target.username,
        firstname, lastname,
        email: target.email,
        change_passwd: true,
        password: usedPwd,
      });
      const staffId = up.staff_id;
      if (staffId && staffId !== target.osticket_staff_id) {
        await sb(env, `admin_users?id=eq.${encodeURIComponent(targetId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ osticket_staff_id: staffId }),
        });
      }
      return json({
        ok: true, staff_id: staffId, agent_created: up.created,
        temp_password: usedPwd,
        agent_username: (username && String(username).trim()) || target.username,
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
