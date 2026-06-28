/* =====================================================================
   functions/api/announcements.js  →  POST /api/announcements
   Sistema de Avisos. Automaticos del periodo (RPC announcements_feed) +
   manuales (tabla announcements).

   AUDIENCIAS (announcements.audience):
     all | stores | enterprises | admins | editors
       all          -> todos los company (tiendas + empresas)
       stores       -> company tipo Tienda
       enterprises  -> company NO tienda
       admins       -> admin con rol admin/superadmin
       editors      -> admin con rol editor_personal

   PERMISOS de gestion:
     superadmin -> edita plantillas + ve/edita TODOS los manuales
     admin      -> NO edita plantillas; ve/edita SOLO sus propios manuales
     editor     -> sin acceso a la seccion (no llega aqui)

   Acciones (POST {action, user, ...}):
   Lectura (company o admin/superadmin/editor):
     - feed : { auto[], manual[], seen_at, unread }
     - seen : marca visto.
   Gestion:
     - tpl_get  (admin+super; pero solo super puede guardar)
     - tpl_save (SOLO superadmin)
     - list_manual (admin: solo suyos; super: todos)
     - save_manual / toggle_manual / delete_manual (admin: solo suyos; super: cualquiera)

   user company = { kind:'company', companyCode }
   user admin   = { kind:'admin', id }
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

const NON_STORE_TYPES = ['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en línea'];

// Resuelve el usuario y su subtipo para audiencias.
// company  -> { kind:'company', key, subtype:'store'|'enterprise', isAdmin:false }
// admin    -> { kind:'admin', key(id), subtype:rol, isAdmin:true, isSuper, role }
async function resolveUser(env, user) {
  if (!user) return null;
  if (user.kind === 'company') {
    if (!user.companyCode) return null;
    const u = await sb(env, `company_users?company_code=eq.${encodeURIComponent(user.companyCode)}&is_active=eq.true&select=company_code`);
    if (!u || !u.length) return null;
    const c = await sb(env, `companies?code=eq.${encodeURIComponent(user.companyCode)}&select=company_type`);
    const ctype = (c && c[0] && c[0].company_type) || '';
    const subtype = (ctype === 'Tienda') ? 'store' : 'enterprise';
    return { kind: 'company', key: user.companyCode, subtype, isAdmin: false, isSuper: false, role: 'company' };
  }
  if (user.kind === 'admin' && user.id) {
    const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role`);
    if (!a || !a.length) return null;
    const role = a[0].role;
    return { kind: 'admin', key: String(a[0].id), subtype: role, isAdmin: true, isSuper: role === 'superadmin', role };
  }
  return null;
}

const clean = v => { const s = String(v == null ? '' : v).trim(); return s ? s : null; };
const ymd = v => { const s = String(v || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };

function countUnread(feed, seenAt) {
  const seen = seenAt ? new Date(seenAt) : null;
  let n = 0;
  for (const a of (feed.auto || [])) {
    if (a.today) { if (!seen || isBeforeToday(seen, feed.today)) n++; }
  }
  for (const m of (feed.manual || [])) {
    if (!seen || (m.created_at && new Date(m.created_at) > seen)) n++;
  }
  return n;
}
function isBeforeToday(seenDate, todayStr) {
  const t = new Date(todayStr + 'T00:00:00-04:00');
  return seenDate < t;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido' }, 400); }

  try {
    const u = await resolveUser(env, body.user || null);
    if (!u) return json({ ok: false, error: 'Sesion no valida.' }, 403);

    // ---------- LECTURA (company o admin) ----------
    if (body.action === 'feed') {
      const feed = await sb(env, 'rpc/announcements_feed', {
        method: 'POST', body: JSON.stringify({ p_kind: u.kind, p_subtype: u.subtype }),
      });
      const st = await sb(env, `announcement_seen?user_kind=eq.${u.kind}&user_key=eq.${encodeURIComponent(u.key)}&select=seen_at`);
      const seenAt = (st && st[0] && st[0].seen_at) || null;
      const unread = countUnread(feed || {}, seenAt);
      return json({ ok: true, ...(feed || {}), seen_at: seenAt, unread });
    }

    if (body.action === 'seen') {
      await sb(env, 'announcement_seen', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_kind: u.kind, user_key: u.key, seen_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    // ---------- GESTION (solo admin/superadmin; editor NO) ----------
    if (!u.isAdmin || u.role === 'editor_personal') {
      return json({ ok: false, error: 'No autorizado.' }, 403);
    }

    if (body.action === 'tpl_get') {
      const rows = await sb(env, "app_settings?key=in.(aviso_tpl_calc,aviso_tpl_cut,aviso_tpl_pay,corte_hora_limite_general,corte_hora_limite,aviso_dias_previos)&select=key,value");
      const map = {}; (rows || []).forEach(r => { map[r.key] = r.value; });
      const parse = k => { try { return JSON.parse(map[k] || '{}'); } catch { return {}; } };
      let vars = {};
      try { vars = await sb(env, 'rpc/current_period_vars', { method: 'POST', body: '{}' }) || {}; } catch { vars = {}; }
      return json({
        ok: true,
        can_edit_templates: u.isSuper,           // admin ve pero no edita; super si
        templates: { calc: parse('aviso_tpl_calc'), cut: parse('aviso_tpl_cut'), pay: parse('aviso_tpl_pay') },
        hora1: map['corte_hora_limite_general'] || '18:00',
        hora2: map['corte_hora_limite'] || '14:00',
        dias_previos: map['aviso_dias_previos'] || '0',
      });
    }

    if (body.action === 'tpl_save') {
      // Solo superadmin puede editar plantillas.
      if (!u.isSuper) return json({ ok: false, error: 'Solo el superadministrador puede editar las plantillas.' }, 403);
      const type = clean(body.type);
      if (!['calc', 'cut', 'pay'].includes(type)) return json({ ok: false, error: 'Tipo invalido.' }, 400);
      const tpl = {
        title: String(body.title || ''),
        short: String(body.short || ''),
        text: String(body.text || ''),
      };
      const key = `aviso_tpl_${type}`;
      await sb(env, `app_settings?key=eq.${key}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ value: JSON.stringify(tpl), updated_at: new Date().toISOString() }),
      });
      if (body.hora1 != null) {
        await sb(env, `app_settings?key=eq.corte_hora_limite_general`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ value: String(body.hora1), updated_at: new Date().toISOString() }),
        });
      }
      if (body.hora2 != null) {
        await sb(env, `app_settings?key=eq.corte_hora_limite`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ value: String(body.hora2), updated_at: new Date().toISOString() }),
        });
      }
      return json({ ok: true });
    }

    if (body.action === 'list_manual') {
      // admin: solo los suyos; superadmin: todos.
      const filter = u.isSuper ? '' : `&created_by=eq.${encodeURIComponent(u.key)}`;
      const rows = await sb(env, `announcements?select=*${filter}&order=created_at.desc`) || [];
      return json({ ok: true, rows, is_super: u.isSuper });
    }

    if (body.action === 'save_manual') {
      const title = clean(body.title);
      if (!title) return json({ ok: false, error: 'El titulo es obligatorio.' }, 400);
      const aud = ['all', 'stores', 'enterprises', 'admins', 'editors'].includes(body.audience) ? body.audience : 'all';
      const row = {
        title,
        body: String(body.body || ''),
        audience: aud,
        starts_on: ymd(body.starts_on),
        ends_on: ymd(body.ends_on),
        updated_at: new Date().toISOString(),
      };
      if (body.id) {
        // admin solo puede editar los suyos; super cualquiera.
        const own = await sb(env, `announcements?id=eq.${encodeURIComponent(body.id)}&select=created_by`);
        if (!own || !own.length) return json({ ok: false, error: 'No encontrado.' }, 404);
        if (!u.isSuper && String(own[0].created_by) !== String(u.key)) {
          return json({ ok: false, error: 'Solo puedes editar tus propios avisos.' }, 403);
        }
        await sb(env, `announcements?id=eq.${encodeURIComponent(body.id)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row),
        });
      } else {
        row.created_by = Number(u.key) || null;
        await sb(env, 'announcements', {
          method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row),
        });
      }
      return json({ ok: true });
    }

    if (body.action === 'toggle_manual') {
      const id = clean(body.id);
      if (!id) return json({ ok: false, error: 'Falta id.' }, 400);
      const cur = await sb(env, `announcements?id=eq.${encodeURIComponent(id)}&select=is_active,created_by`);
      if (!cur || !cur.length) return json({ ok: false, error: 'No encontrado.' }, 404);
      if (!u.isSuper && String(cur[0].created_by) !== String(u.key)) {
        return json({ ok: false, error: 'Solo puedes cambiar tus propios avisos.' }, 403);
      }
      await sb(env, `announcements?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: !cur[0].is_active, updated_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    if (body.action === 'delete_manual') {
      const id = clean(body.id);
      if (!id) return json({ ok: false, error: 'Falta id.' }, 400);
      const cur = await sb(env, `announcements?id=eq.${encodeURIComponent(id)}&select=created_by`);
      if (!cur || !cur.length) return json({ ok: false, error: 'No encontrado.' }, 404);
      if (!u.isSuper && String(cur[0].created_by) !== String(u.key)) {
        return json({ ok: false, error: 'Solo puedes eliminar tus propios avisos.' }, 403);
      }
      await sb(env, `announcements?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' },
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
