/* =====================================================================
   functions/api/admin-users.js  →  /api/admin-users
   Gestion del Equipo. superadmin: todo (crear, cambiar rol, ver todos los
   roles, sync masivo). admin no-super: VE y gestiona (reset/toggle/osTicket)
   SOLO los gestor_empresa entrelazados con su alcance (gestores_in_admin_scope).
   Acciones (POST {action}): list, create, reset, toggle, update_role,
   sync_client, sync_clients_all.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { resolveActor, can } from './_auth.js';
/* v5.10: envio de credenciales por WhatsApp desde Equipo. El motor de
   plantillas y el enmascarado viven en wa-templates.js (la misma pieza que
   usa la vista WhatsApp > Mensajes y su preview: si hubiera dos motores,
   el preview podria mostrar algo distinto de lo que se envia). */
import { renderTemplate, maskSecrets, buildCtx } from './wa-templates.js';
import { gaClient, toChatId } from './_greenapi.js';

const SALT = 'nm_salt_2025';

// Mapa accion -> code de permiso (para el shadow). Todas las acciones de este
// endpoint estan bajo el gate superadmin legacy; el code fino permite que en
// la pasada final un rol no-super pueda tener solo parte (ej. team.role).
const TEAM_CODE_BY_ACTION = {
  list: 'view.equipo',
  create: 'team.create',
  reset: 'team.reset',
  toggle: 'team.toggle',
  update_role: 'team.role',
  update_contact: 'team.create',   // v5.07: editar contacto = mismo gate que alta
  cred_preview: 'view.equipo',     // v5.10: datos del modal de credenciales
  cred_whatsapp: 'wa.send',        // v5.10: mandarle las credenciales por WhatsApp
  sync_client: 'team.osticket',
  sync_clients_all: 'team.osticket',
};

/* v5.07: el telefono se guarda tal como se escribe (solo se limpian espacios
   y se descarta si queda vacio). La normalizacion a formato de linea la hace
   el envio de WhatsApp, igual que con los telefonos de companies. */
function cleanPhone(p) {
  const s = String(p == null ? '' : p).trim();
  return s || null;
}

/* Traduce un error interno a un mensaje para la persona. Nunca deja pasar el
   texto crudo de la base: filtraria el esquema y datos de terceros.
   Los choques de UNIQUE (23505) son los unicos "esperables" aca: dos miembros
   no pueden compartir usuario ni correo. */
function humanError(err) {
  const raw = String((err && err.message) || err || '');

  if (raw.includes('23505')) {
    // Que columna choco. El detalle viene como: Key (email)=(x@y.com)
    const m = /Key \(([a-z_]+)\)/i.exec(raw);
    const col = m ? m[1] : '';
    if (col === 'email' || raw.includes('admin_users_email_key')) {
      return 'Ese correo ya lo tiene otro miembro del equipo. Cada correo puede estar en una sola cuenta.';
    }
    if (col === 'username' || raw.includes('admin_users_username_key')) {
      return 'Ese usuario ya existe. Elige otro nombre de usuario.';
    }
    return 'Ese dato ya esta registrado en otra cuenta.';
  }

  // Sin traduccion conocida: mensaje generico. El detalle queda en los logs
  // de Cloudflare, que es donde tiene que estar, no en la cara del usuario.
  console.error('admin-users:', raw);
  return 'No se pudo completar la accion. Intenta de nuevo.';
}

/* v5.11: el correo es UNICO entre los miembros. Se comprueba ANTES de tocar la
   base: si no, PostgREST devuelve un 23505 con el nombre del constraint y el
   correo del OTRO usuario adentro, y eso terminaba impreso en pantalla.
   Devuelve el mensaje de error, o null si el correo esta libre.
   excludeId: al editar, el propio miembro no cuenta como duplicado. */
async function emailTakenError(env, email, excludeId) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const rows = await sb(env,
    `admin_users?email=eq.${encodeURIComponent(e)}&select=id,username,is_active`);
  const clash = (rows || []).find(r => String(r.id) !== String(excludeId ?? ''));
  if (!clash) return null;
  // Se nombra al usuario (dato interno del equipo, visible en la misma vista),
  // pero NO se repite el correo ni se filtra nada del esquema.
  return `Ese correo ya esta en uso por el miembro "${clash.username}"`
    + `${clash.is_active ? '' : ' (inactivo)'}. Cada correo puede estar en una sola cuenta.`;
}

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }); }

async function hashPassword(pwd) {
  const data = new TextEncoder().encode(pwd + SALT);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function genTempPassword() {
  const part = () => Math.random().toString(36).slice(2, 6);
  return `Tmp-${part()}-${part()}`;
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

async function getActiveAdmin(env, adminId) {
  if (!adminId) return null;
  const r = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id,role`);
  return r && r.length ? r[0] : null;
}

// Set de ids de gestor_empresa entrelazados con el alcance de un admin (via
// RPC gestores_in_admin_scope). Para superadmin devuelve null (sin limite).
async function gestorScopeSet(env, admin) {
  if (admin.role === 'superadmin') return null;
  const r = await sb(env, 'rpc/gestores_in_admin_scope', {
    method: 'POST', body: JSON.stringify({ p_admin_id: admin.id }),
  });
  return new Set((r || []).map(x => Number(x)));
}

/* ---- osTicket (lado CLIENTE/user) ----
   El gestor_empresa se crea como usuario CLIENTE de osTicket (abre/consulta
   tickets), identificado por email via la API gc-user.json (la misma que usan
   las tiendas en osticket-users.js). NO es agente: no toca osticket_staff_id.
   Secret: osticket_api_key. Setting: osticket_url. */
async function getSetting(env, key, fallback) {
  const r = await sb(env, `app_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  return (r && r[0] && r[0].value != null) ? r[0].value : fallback;
}
async function osticketBase(env) {
  const url = await getSetting(env, 'osticket_url', '');
  return String(url || '').replace(/\/+$/, '');
}
// Crea/actualiza un usuario cliente en osTicket por email. Idempotente.
// Devuelve { ok, user_id, created } o lanza error.
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
  return js;
}

// Llama gc-agent.json (agentes). Devuelve el JSON o lanza con detalle.
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

// Sincroniza UN admin (debe ser gestor_empresa con correo) como cliente
// osTicket. Guarda osticket_user_id + fecha. Devuelve el resultado por fila.
// Si se pasa username/password, crea/actualiza tambien la cuenta de acceso
// del cliente (login local con clave fija) via gc-user.json.
async function syncClientOne(env, base, u, opts = {}) {
  const email = (u.email || '').trim();
  if (!email) return { id: u.id, username: u.username, ok: false, error: 'Sin correo.' };
  const name = (u.name || u.username || email).trim();
  const payload = { email, name };
  if (opts.username) payload.username = String(opts.username).trim();
  if (opts.password) payload.password = String(opts.password);
  const r = await gcUser(env, base, payload);
  await sb(env, `admin_users?id=eq.${encodeURIComponent(u.id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ osticket_user_id: r.user_id, osticket_user_synced_at: new Date().toISOString() }),
  });
  return { id: u.id, username: u.username, ok: true, user_id: r.user_id, created: r.created,
    account_created: r.account_created, account_updated: r.account_updated };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action, adminId } = body;

  try {
    const me = await getActiveAdmin(env, adminId);
    if (!me) return json({ ok: false, error: 'No autorizado.' }, 401);
    const isSuper = me.role === 'superadmin';

    // v4.73: CORTE del shadow (Lote 3). Cada accion EXIGE su permiso de la
    // matriz (can): list->view.equipo; create->team.create; reset->team.reset;
    // toggle->team.toggle; update_role->team.role; sync_client y
    // sync_clients_all->team.osticket. Reglas de negocio intactas: el admin
    // no-super sigue limitado a los gestores de su alcance (canTouchTarget),
    // y la sincronizacion MASIVA de osTicket conserva su gate adicional de
    // superadmin (team.osticket gobierna la individual).
    const actor = await resolveActor(env, { kind: 'admin', id: adminId });
    const needed = TEAM_CODE_BY_ACTION[action] || 'team.role';
    if (!can(actor, needed)) return json({ ok: false, error: 'No tienes permiso para esta accion.' }, 403);
    if (action === 'sync_clients_all' && !isSuper) {
      return json({ ok: false, error: 'La sincronizacion masiva requiere superadmin.' }, 403);
    }

    // Para un admin no-super, set de gestores que puede ver/gestionar (los
    // entrelazados con su alcance). superadmin -> null (todos).
    const gestorSet = await gestorScopeSet(env, me);
    // Valida que un target (por id) sea un gestor dentro del alcance del admin.
    // superadmin siempre pasa.
    const canTouchTarget = async (targetId) => {
      if (isSuper) return true;
      if (!gestorSet || !gestorSet.has(Number(targetId))) return false;
      return true;
    };

    if (action === 'list') {
      let rows = await sb(env, 'admin_users?select=id,username,name,email,phone,role,is_active,osticket_staff_id,osticket_user_id,osticket_user_synced_at,last_login_at&order=role.desc,username');
      // admin no-super: solo los gestores entrelazados con su alcance.
      if (!isSuper) {
        rows = (rows || []).filter(a => a.role === 'gestor_empresa' && gestorSet.has(Number(a.id)));
      }
      // Resumen de alcance por admin. Se cuenta el alcance REALMENTE resuelto
      // (include - exclude), separado en tiendas vs empresas no-tienda, via la
      // RPC admin_scope_counts (una sola llamada). Esto corrige el conteo
      // anterior por "reglas", que ignoraba las empresas que entran por
      // zona/subzona/departamento (mostraba menos empresas de las reales).
      // Ademas se conservan las reglas include/exclude por tipo para el detalle
      // por zona/subzona/depto que muestra la celda (scopeSummaryHtml).
      const [inc, exc, counts] = await Promise.all([
        sb(env, 'admin_scope_include?select=admin_id,scope_type'),
        sb(env, 'admin_scope_exclude?select=admin_id,scope_type'),
        sb(env, 'rpc/admin_scope_counts', { method: 'POST', body: '{}' }),
      ]);
      const incA = inc || [], excA = exc || [];
      const scopeMap = {};   // admin_id -> { inc:{type:n}, exc:{type:n} }
      const bump = (bucket, r) => {
        const k = r.admin_id;
        if (!scopeMap[k]) scopeMap[k] = { inc: {}, exc: {} };
        scopeMap[k][bucket][r.scope_type] = (scopeMap[k][bucket][r.scope_type] || 0) + 1;
      };
      incA.forEach(r => bump('inc', r));
      excA.forEach(r => bump('exc', r));
      // Mapa de conteos reales por admin (tiendas / empresas no-tienda).
      const countMap = {};
      (counts || []).forEach(c => { countMap[c.admin_id] = { tiendas: c.tiendas || 0, empresas: c.empresas || 0 }; });
      (rows || []).forEach(a => {
        a.scope = scopeMap[a.id] || { inc: {}, exc: {} };
        a.scope_counts = countMap[a.id] || { tiendas: 0, empresas: 0 };
      });
      return json({ ok: true, rows });
    }

    if (action === 'create') {
      const { username, name, email, role, password, useTemp } = body;
      if (!username) return json({ ok: false, error: 'Falta el usuario.' }, 400);
      // v5.06: roles validos DESDE LA TABLA (mismo patron que update_role en
      // v5.00). Antes habia una lista HARDCODEADA ['admin','superadmin',
      // 'editor_personal','gestor_empresa'] con una linea venenosa:
      //    const r = ALLOWED_ROLES.includes(role) ? role : 'admin';
      // que NO rechazaba el rol desconocido: lo convertia en 'admin' EN
      // SILENCIO. Crear un miembro con un rol nuevo (Supervisor Tiendas,
      // Gerente Zona...) lo guardaba como ADMINISTRADOR sin avisar a nadie.
      // Ahora: catalogo vivo + error explicito. superadmin no se asigna desde
      // aqui (se nace superadmin, no se crea desde el modal) y tienda es el
      // login de empresa, no un rol del equipo.
      const catalog = await sb(env, 'roles?is_active=eq.true&select=code');
      const allowed = (catalog || []).map(x => x.code)
        .filter(c => c !== 'superadmin' && c !== 'tienda');
      if (!role || !allowed.includes(role)) {
        return json({ ok: false, error: 'Rol no válido. Roles asignables: ' + allowed.join(', ') + '.' }, 400);
      }
      const r = role;
      const pwd = useTemp ? genTempPassword() : password;
      if (!pwd || pwd.length < 6) return json({ ok: false, error: 'Contraseña inválida (mín. 6).' }, 400);

      // v5.11: duplicados atajados ACA (usuario y correo son unicos). Antes se
      // dejaba explotar a la base y el 23505 crudo salia a pantalla.
      const dupU = await sb(env, `admin_users?username=eq.${encodeURIComponent(username)}&select=id`);
      if (dupU && dupU.length) {
        return json({ ok: false, error: `El usuario "${username}" ya existe. Elige otro.` }, 400);
      }
      const dupE = await emailTakenError(env, email, null);
      if (dupE) return json({ ok: false, error: dupE }, 400);

      const hash = await hashPassword(pwd);
      const created = await sb(env, 'admin_users', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          username, name: name || null, email: email ? email.trim().toLowerCase() : null,
          phone: cleanPhone(body.phone),   // v5.07
          password_hash: hash,
          role: r, must_change_password: !!useTemp, is_active: true,
        }),
      });
      // v5.10: el id se devuelve para que el modal de credenciales pueda pedir
      // el preview del mensaje sin tener que recargar toda la vista Equipo.
      const newId = created && created[0] && created[0].id;
      return json({ ok: true, id: newId, tempPassword: useTemp ? pwd : null });
    }

    /* v5.07: editar los datos de CONTACTO de un miembro (nombre, correo,
       telefono). Antes no habia forma de cargarle el telefono a los miembros
       que ya existian: solo se podia crear. No toca rol ni clave (para eso
       estan update_role y reset). */
    if (action === 'update_contact') {
      const { id, name, email, phone } = body;
      if (!id) return json({ ok: false, error: 'Falta el usuario.' }, 400);
      if (!(await canTouchTarget(id))) return json({ ok: false, error: 'Ese usuario esta fuera de tu alcance.' }, 403);
      // v5.11: mismo chequeo que en create, excluyendo al propio miembro (si no,
      // guardar sin tocar el correo chocaria consigo mismo).
      const dupE = await emailTakenError(env, email, id);
      if (dupE) return json({ ok: false, error: dupE }, 400);
      await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          name: (name || '').trim() || null,
          email: email ? String(email).trim().toLowerCase() : null,
          phone: cleanPhone(phone),
        }),
      });
      return json({ ok: true });
    }

    /* ================== v5.10: CREDENCIALES ==================
       Dos acciones que alimentan el modal de credenciales de Equipo (mockup
       _PRUEBAS/equipo_credenciales_mockup.html v0-mock1), el que reemplaza
       los alert() con los que hasta ahora se mostraba la clave.

       La clave NO se guarda en ningun lado: viaja del alta/reset al modal, y
       de ahi al mensaje. En wa_batches queda el texto ENMASCARADO.

       'kind' distingue las dos plantillas, que corresponden a dos momentos
       distintos: 'portal' (crear miembro / resetear clave) y 'osticket'
       (crear o resetear su acceso al sistema de tickets). */

    if (action === 'cred_preview' || action === 'cred_whatsapp') {
      const { id, kind, password, useTemp, osticketUser } = body;
      const isOst = kind === 'osticket';
      if (!id) return json({ ok: false, error: 'Falta el usuario.' }, 400);
      if (!(await canTouchTarget(id))) return json({ ok: false, error: 'Ese usuario esta fuera de tu alcance.' }, 403);

      const rows = await sb(env,
        `admin_users?id=eq.${encodeURIComponent(id)}&select=id,username,name,email,phone,role`);
      if (!rows || !rows.length) return json({ ok: false, error: 'Usuario no encontrado.' }, 404);
      const u = rows[0];

      const tplCode = isOst ? 'cred_osticket' : 'cred_portal';
      const tpl = await sb(env,
        `message_templates?code=eq.${encodeURIComponent(tplCode)}&select=code,label,body,allows_secret,is_active`);
      if (!tpl || !tpl.length) return json({ ok: false, error: 'Falta el mensaje predeterminado (WhatsApp > Mensajes).' }, 500);
      const t = tpl[0];

      const ctx = await buildCtx(env, u, isOst
        ? { osticket_clave: password, osticket_usuario: osticketUser || u.username }
        : { clave: password });

      const text = renderTemplate(t.body, ctx, !!t.allows_secret);

      if (action === 'cred_preview') {
        return json({
          ok: true,
          member: {
            id: u.id, username: u.username, name: u.name || u.username,
            phone: u.phone || null, rol: ctx.rol,
            osticket_usuario: ctx.osticket_usuario,
          },
          kind: isOst ? 'osticket' : 'portal',
          link: isOst ? ctx.link_osticket : ctx.link_portal,
          // Aviso de la clave: la del portal caduca (v5.08); la de osTicket NO.
          // Son situaciones distintas y el modal las muestra distinto.
          temp: isOst ? false : !!useTemp,
          can_send: !!u.phone && t.is_active,
          message: text,
        });
      }

      /* ---- envio ---- */
      if (!u.phone) {
        return json({ ok: false, error: 'Ese miembro no tiene telefono cargado. Agregalo con el boton Editar de su fila.' }, 400);
      }
      if (!t.is_active) {
        return json({ ok: false, error: 'El mensaje esta desactivado en WhatsApp > Mensajes.' }, 400);
      }
      if (!password) {
        return json({ ok: false, error: 'No hay clave para enviar.' }, 400);
      }
      /* REGLA DURA (v5.08 + v5.09): la clave del PORTAL solo se manda si es
         TEMPORAL. Una clave fija enviada por WhatsApp queda viva en el chat
         para siempre. Con la temporal, la exposicion dura hasta el primer
         ingreso: el portal obliga a cambiarla. La de osTicket no tiene esta
         proteccion (osTicket no fuerza el cambio), y por eso el modal avisa
         explicitamente antes de mandarla. */
      if (!isOst && !useTemp) {
        return json({ ok: false, error:
          'Esa clave no caduca, asi que no se envia por WhatsApp: quedaria viva en el chat. '
          + 'Reseteala con la opcion "Generar temporal" y volve a intentar.' }, 400);
      }

      const chatId = toChatId(u.phone);
      const ga = gaClient(env);
      let idMessage = null;
      let err = null;
      try {
        const r = await ga.sendMessage(chatId, text);
        idMessage = (r && (r.idMessage || r.id)) || null;
      } catch (e) {
        err = (e && e.message) || String(e);
      }

      /* Auditoria: queda registrado QUE se le mando y a quien, con el texto
         ENMASCARADO. Si alguien lee wa_batches manana, no encuentra claves. */
      const batch = await sb(env, 'wa_batches', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          // v5.11 FIX: 'actorName' no existia (crasheaba el envio con
          // "actorName is not defined"). El actor ya esta resuelto arriba.
          created_by: actor.username || actor.name || String(actor.id || ''),
          message: maskSecrets(text, ctx),
          filters: { target: 'credenciales', kind: isOst ? 'osticket' : 'portal',
            template: tplCode, member: u.username },
          total: 1,
          with_phone: 1,
        }),
      });
      const batchId = batch && batch[0] && batch[0].id;
      if (batchId) {
        await sb(env, 'wa_outbox', {
          method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            batch_id: batchId,
            id_number: String(u.id),
            full_name: u.name || u.username,
            company_code: '',
            phone_raw: u.phone,
            chat_id: chatId,
            status: err ? 'error' : 'sent',
            id_message: idMessage,
            error_text: err,
            sent_at: err ? null : new Date().toISOString(),
          }),
        });
      }

      if (err) return json({ ok: false, error: 'No se pudo enviar: ' + err }, 502);
      return json({ ok: true, phone: u.phone });
    }

    if (action === 'reset') {
      const { id, password, useTemp } = body;
      if (!id) return json({ ok: false, error: 'Falta el usuario.' }, 400);
      // admin no-super: solo puede resetear gestores de su alcance.
      if (!(await canTouchTarget(id))) return json({ ok: false, error: 'Ese usuario esta fuera de tu alcance.' }, 403);
      const pwd = useTemp ? genTempPassword() : password;
      if (!pwd || pwd.length < 6) return json({ ok: false, error: 'Contraseña inválida (mín. 6).' }, 400);
      const hash = await hashPassword(pwd);
      await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ password_hash: hash, must_change_password: !!useTemp }),
      });
      return json({ ok: true, tempPassword: useTemp ? pwd : null });
    }

    if (action === 'toggle') {
      const { id, isActive } = body;
      if (!id) return json({ ok: false, error: 'Falta el usuario.' }, 400);
      // admin no-super: solo puede activar/desactivar gestores de su alcance.
      if (!(await canTouchTarget(id))) return json({ ok: false, error: 'Ese usuario esta fuera de tu alcance.' }, 403);
      // No permitir auto-desactivarse.
      if (!isActive && String(id) === String(adminId)) {
        return json({ ok: false, error: 'No puedes desactivar tu propio usuario.' }, 400);
      }
      // No dejar el sistema sin ningun superadmin activo.
      if (!isActive) {
        const target = await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}&select=role`);
        if (target && target.length && target[0].role === 'superadmin') {
          const supers = await sb(env, 'admin_users?role=eq.superadmin&is_active=eq.true&select=id');
          if ((supers || []).length <= 1) {
            return json({ ok: false, error: 'No puedes desactivar el ultimo superadmin del sistema.' }, 400);
          }
        }
      }
      await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: !!isActive }),
      });
      return json({ ok: true });
    }

    if (action === 'update_role') {
      const { id, role } = body;
      if (!id) return json({ ok: false, error: 'Falta el usuario.' }, 400);
      // v5.00: roles validos DESDE LA TABLA (antes lista hardcodeada, que
      // rechazaba roles creados en la vista Roles como supervidor_tiendas).
      // superadmin no se asigna desde aqui (regla del modal) y tienda es el
      // login de empresa, no un rol del equipo.
      const catalog = await sb(env,
        'roles?is_active=eq.true&select=code,osticket_kind');
      const kindBy = {};
      (catalog || []).forEach(r => { kindBy[r.code] = r.osticket_kind || 'none'; });
      const allowed = (catalog || []).map(r => r.code)
        .filter(c => c !== 'superadmin' && c !== 'tienda');
      if (!allowed.includes(role)) {
        return json({ ok: false, error: 'Rol no válido. Roles asignables: ' + allowed.join(', ') + '.' }, 400);
      }
      if (String(id) === String(adminId)) return json({ ok: false, error: 'No puedes cambiar tu propio rol.' }, 400);
      const target = await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}&select=id,username,name,email,role,is_active,osticket_staff_id,osticket_user_id`);
      if (!target || !target.length) return json({ ok: false, error: 'Usuario no encontrado.' }, 404);
      const u = target[0];
      const prevRole = u.role;
      if (prevRole === 'superadmin' && role !== 'superadmin') {
        const supers = await sb(env, 'admin_users?role=eq.superadmin&is_active=eq.true&select=id');
        if (supers && supers.length <= 1) return json({ ok: false, error: 'No puedes quitar el ultimo superadmin del sistema.' }, 400);
      }
      if (role === prevRole) return json({ ok: true, note: 'Sin cambios de rol.' });

      // 1) Cambiar el rol en el portal (la verdad).
      await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ role }),
      });

      // 2) Reflejar en osTicket segun la transicion. No debe romper el cambio
      //    de rol (ya hecho): si osTicket falla, se informa como aviso.
      //    v5.00: la transicion se decide por el osticket_kind del ROL
      //    (tabla roles: agent/client/none), no por codes hardcodeados.
      const wasAgent = (kindBy[prevRole] || 'none') === 'agent';
      const isAgent = (kindBy[role] || 'none') === 'agent';
      const isClient = (kindBy[role] || 'none') === 'client';
      const osticket = { steps: [], warnings: [] };
      const base = await osticketBase(env);
      const canOst = base && env.osticket_api_key;

      try {
        // 2a) Deja de ser agente (admin -> gestor/editor): desactivar agente.
        if (wasAgent && !isAgent && u.osticket_staff_id) {
          if (canOst) {
            try {
              const r = await gcAgent(env, base, { action: 'set_agent_active', staff_id: u.osticket_staff_id, active: 0 });
              osticket.steps.push(`Agente #${u.osticket_staff_id} desactivado en osTicket${r.scope_cleared ? ` (bandeja limpiada: ${r.scope_cleared})` : ''}.`);
            } catch (e) { osticket.warnings.push('No se pudo desactivar el agente en osTicket: ' + (e.message || e)); }
          } else {
            osticket.warnings.push('osTicket no esta configurado: desactiva el agente manualmente.');
          }
          // El puente de agente deja de aplicar (ya no es agente). Lo
          // conservamos NO: lo limpiamos para reflejar que no es agente.
          await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ osticket_staff_id: null }),
          });
        }

        // 2b) Pasa a un rol CLIENTE (ej. gestor de empresa): crear/activar su
        //     cliente osTicket (si tiene correo).
        if (isClient) {
          if (canOst && u.email) {
            try {
              const r = await syncClientOne(env, base, u);
              if (r.ok) osticket.steps.push(`Cliente osTicket ${r.created ? 'creado' : 'actualizado'} (#${r.user_id}).`);
              else osticket.warnings.push('No se pudo crear el cliente osTicket: ' + r.error);
            } catch (e) { osticket.warnings.push('No se pudo crear el cliente osTicket: ' + (e.message || e)); }
          } else if (!u.email) {
            osticket.warnings.push('El gestor no tiene correo: no se creo su cliente osTicket. Agrega el correo y sincroniza desde su fila.');
          }
        }

        // 2c) Pasa a un rol AGENTE (ej. administrador): no se crea agente
        //     aqui (requiere clave). Se avisa: crear al guardar su alcance o
        //     desde el boton osTicket de su fila.
        if (!wasAgent && isAgent) {
          osticket.steps.push('El nuevo rol atiende como agente: crea su agente osTicket al guardar su alcance de tiendas, o con el boton osTicket de su fila.');
        }
      } catch (e) {
        osticket.warnings.push('osTicket: ' + (e.message || e));
      }

      return json({ ok: true, prev_role: prevRole, role, osticket });
    }

    // Crea/actualiza UN gestor_empresa como cliente de osTicket.
    // Opcional: si viene password, crea/actualiza la cuenta de acceso
    // (login local) con username (por defecto el username del portal) y esa
    // clave FIJA (osTicket no fuerza el cambio).
    if (action === 'sync_client') {
      const { id, username, password } = body;
      if (!id) return json({ ok: false, error: 'Falta el usuario.' }, 400);
      // admin no-super: solo gestores de su alcance.
      if (!(await canTouchTarget(id))) return json({ ok: false, error: 'Ese usuario esta fuera de tu alcance.' }, 403);
      const base = await osticketBase(env);
      if (!base || !env.osticket_api_key) return json({ ok: false, error: 'osTicket no esta configurado (URL o clave API).' }, 400);
      const rows = await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}&select=id,username,name,email,role`);
      if (!rows || !rows.length) return json({ ok: false, error: 'Usuario no encontrado.' }, 404);
      const u = rows[0];
      // v5.00: cliente osTicket para cualquier rol con osticket_kind='client'
      // (antes solo gestor_empresa hardcodeado).
      const kr = await sb(env, `roles?code=eq.${encodeURIComponent(u.role)}&select=osticket_kind`);
      if (!kr || !kr.length || (kr[0].osticket_kind || 'none') !== 'client') {
        return json({ ok: false, error: 'Solo los roles de tipo cliente osTicket se crean como cliente.' }, 400);
      }
      if (password != null && String(password).length && String(password).length < 6) {
        return json({ ok: false, error: 'La clave debe tener al menos 6 caracteres.' }, 400);
      }
      const opts = {};
      if (password != null && String(password).length) {
        opts.password = String(password);
        opts.username = (username && String(username).trim()) || u.username;
      }
      try {
        const r = await syncClientOne(env, base, u, opts);
        if (!r.ok) return json({ ok: false, error: r.error }, 400);
        return json({ ok: true, user_id: r.user_id, created: r.created,
          account_created: r.account_created, account_updated: r.account_updated,
          username: opts.username || null });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    // Crea/actualiza TODOS los gestor_empresa activos con correo como clientes.
    if (action === 'sync_clients_all') {
      const base = await osticketBase(env);
      if (!base || !env.osticket_api_key) return json({ ok: false, error: 'osTicket no esta configurado (URL o clave API).' }, 400);
      const gestores = await sb(env, 'admin_users?role=eq.gestor_empresa&is_active=eq.true&select=id,username,name,email&order=username');
      const results = [];
      let okCount = 0, failCount = 0;
      for (const u of (gestores || [])) {
        try {
          const r = await syncClientOne(env, base, u);
          results.push(r);
          if (r.ok) okCount++; else failCount++;
        } catch (e) {
          results.push({ id: u.id, username: u.username, ok: false, error: String(e.message || e) });
          failCount++;
        }
      }
      return json({ ok: true, processed: (gestores || []).length, ok_count: okCount, fail_count: failCount, results });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    /* v5.11 SEGURIDAD: no devolver el error interno tal cual.
       Antes esto escupia a la pantalla el texto crudo de la base:
         Supabase 409: {"code":"23505", ... "Key (email)=(x@y.com) already
         exists" ... "admin_users_email_key"}
       Eso filtra el esquema (tabla y constraint) y, peor, el DATO DE OTRO
       USUARIO (el correo con el que choca, que puede no ser de quien esta
       mirando). Ahora se traduce a algo humano y se calla el resto. */
    return json({ ok: false, error: humanError(err) }, 500);
  }
}
