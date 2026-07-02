/* =====================================================================
   functions/api/_auth.js  —  Helper central de autorizacion (Fase 2)
   Sistema de Roles y Permisos tabla-driven para NominaV2.

   Reemplaza los 5 patrones dispersos de autorizacion (isSuperadmin,
   getAdmin+allowedCompanies, resolveUser, resolveScope, resolveAdmin) por
   una sola fuente de verdad basada en las tablas:
     nomina_v2.roles              (code, is_system, readonly_scope, is_active)
     nomina_v2.permissions        (code, kind, is_active)
     nomina_v2.role_permissions   (role_code, permission_code)

   Uso tipico en un endpoint:
     import { resolveActor, can, assertCan, AuthError } from './_auth.js';
     const actor = await resolveActor(env, body.user);
     if (!actor) return json({ ok:false, error:'Sesion no valida.' }, 403);
     ...
     assertCan(actor, 'docs.create');   // lanza AuthError si no puede
     // o bien:
     if (!can(actor, 'docs.edit')) return json({ ok:false, error:'...' }, 403);

   IMPORTANTE:
   - superadmin es is_system => can() devuelve SIEMPRE true (no necesita filas).
   - El alcance de EMPRESA (que empresas ve) NO vive aqui: se sigue resolviendo
     con get_admin_companies como hasta ahora. Este helper solo decide el
     "puede / no puede" global de cada permiso.
   - No confia en el cliente: el rol se revalida SIEMPRE contra admin_users.
   ===================================================================== */

/* fetch a PostgREST bajo el schema nomina_v2 (mismo patron que el resto de
   endpoints). Devuelve JSON o null. Lanza en error HTTP. */
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

/* Error tipado para gates. Un endpoint puede capturarlo y responder con
   e.status / e.message, o dejar que el catch general lo convierta en 500.
   Para 403 limpios, usa el patron try/catch del ejemplo de abajo. */
export class AuthError extends Error {
  constructor(message, status = 403, code = null) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.permission = code;
  }
}

/* Cache de permisos por rol, vivo durante el request (module scope se reusa
   entre invocaciones del mismo isolate; por eso guardamos con marca de
   tiempo corta para no servir permisos viejos si se editan en caliente). */
const PERM_TTL_MS = 15 * 1000;
const _permCache = new Map();   // role_code -> { at, set:Set<string> }

/* Carga el set de permisos concedidos a un rol (solo permisos activos).
   superadmin no llama aqui (se corta antes en can()).
   Usa dos consultas simples (sin embed de PostgREST) para no depender de la
   deteccion de FK: 1) codes del rol, 2) codes actualmente inactivos. Resta. */
async function loadRolePerms(env, roleCode) {
  const cached = _permCache.get(roleCode);
  const now = Date.now();
  if (cached && (now - cached.at) < PERM_TTL_MS) return cached.set;

  const rows = await sb(env,
    `role_permissions?role_code=eq.${encodeURIComponent(roleCode)}&select=permission_code`);
  const set = new Set((rows || []).map(r => r.permission_code));

  // Quitar del set cualquier permiso que este marcado inactivo (raro, pero
  // permite retirar un permiso del sistema sin borrar filas de la matriz).
  if (set.size) {
    const inactive = await sb(env, `permissions?is_active=eq.false&select=code`);
    (inactive || []).forEach(p => set.delete(p.code));
  }

  _permCache.set(roleCode, { at: now, set });
  return set;
}

/* Invalidacion manual del cache (la usara el endpoint de Roles al guardar la
   matriz, para que los cambios se vean sin esperar el TTL). */
export function invalidatePermCache(roleCode) {
  if (roleCode) _permCache.delete(roleCode);
  else _permCache.clear();
}

/* Resuelve el ACTOR de la sesion. Revalida contra BD (no confia en el cliente).
   Devuelve:
     { kind:'admin', actor:<username>, role:<code>, isSystem:bool,
       readonlyScope:bool, permSet:Set<string> }
     { kind:'company', actor:<companyCode>, role:'tienda', isSystem:true,
       readonlyScope:false, permSet:Set<string> }
   o null si la sesion no es valida.

   - admin/superadmin: valida en admin_users por id (is_active). El role se
     toma de la BD, no del cliente.
   - company (tienda): valida el companyCode en companies. role fijo 'tienda'.
*/
export async function resolveActor(env, user) {
  if (!user) return null;

  // ----- Tienda (login de empresa) -----
  if (user.kind === 'company') {
    const cc = String(user.companyCode || '').trim();
    if (!cc) return null;
    const c = await sb(env, `companies?company_code=eq.${encodeURIComponent(cc)}&select=company_code`);
    if (!c || !c.length) return null;
    const roleMeta = await getRoleMeta(env, 'tienda');
    const permSet = await loadRolePerms(env, 'tienda');
    return {
      kind: 'company', actor: cc, role: 'tienda',
      isSystem: roleMeta ? roleMeta.is_system : true,
      readonlyScope: false, permSet,
    };
  }

  // ----- Admin / superadmin / roles administrativos -----
  if (user.kind === 'admin' && user.id) {
    const a = await sb(env,
      `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true`
      + `&select=id,username,name,role`);
    if (!a || !a.length) return null;
    const role = a[0].role;
    const actor = a[0].username || a[0].name || ('admin#' + a[0].id);

    const roleMeta = await getRoleMeta(env, role);
    // superadmin (is_system) no necesita permSet: can() corta antes.
    const isSystem = roleMeta ? !!roleMeta.is_system : (role === 'superadmin');
    const readonlyScope = roleMeta ? !!roleMeta.readonly_scope : false;
    const permSet = isSystem ? null : await loadRolePerms(env, role);

    return { kind: 'admin', actor, role, isSystem, readonlyScope, permSet };
  }

  return null;
}

/* Metadatos de un rol (is_system, readonly_scope). Cacheado corto. */
const _roleMetaCache = new Map();   // role_code -> { at, meta }
async function getRoleMeta(env, roleCode) {
  const cached = _roleMetaCache.get(roleCode);
  const now = Date.now();
  if (cached && (now - cached.at) < PERM_TTL_MS) return cached.meta;
  const r = await sb(env,
    `roles?code=eq.${encodeURIComponent(roleCode)}&is_active=eq.true`
    + `&select=code,is_system,readonly_scope`);
  const meta = (r && r.length) ? r[0] : null;
  _roleMetaCache.set(roleCode, { at: now, meta });
  return meta;
}

/* can(actor, code): true si el actor tiene el permiso.
   - superadmin / is_system con TODOS los permisos => siempre true.
     (Nota: 'tienda' es is_system pero NO debe tener todo; por eso el "todo"
      solo aplica a superadmin. La tienda pasa por su permSet real.) */
export function can(actor, code) {
  if (!actor) return false;
  // superadmin: acceso total. Se identifica por role, no solo por is_system,
  // porque tienda tambien es is_system pero con permisos acotados.
  if (actor.role === 'superadmin') return true;
  if (!actor.permSet) return false;
  return actor.permSet.has(code);
}

/* assertCan(actor, code): lanza AuthError(403) si no puede. Devuelve true. */
export function assertCan(actor, code) {
  if (!can(actor, code)) {
    throw new AuthError('No tienes permiso para esta accion.', 403, code);
  }
  return true;
}

/* Azucar: ¿es superadmin? (para los pocos gates que son intrinsecamente
   de superadmin, como la vista Roles). */
export function isSuperadmin(actor) {
  return !!actor && actor.role === 'superadmin';
}
