/* =====================================================================
   functions/api/config-catalogs.js  →  /api/config-catalogs
   CRUD de catalogos editables desde la pantalla de Configuracion.
   Solo superadmin. Dos catalogos:
     - absence_types  (tipos de ausencia) + su documento en required_docs
     - marcaje_causas (causas de marcaje)

   Acciones (POST {action, adminId, ...}):
     absence_list                  -> lista tipos + su doc
     absence_save {type}           -> crea/actualiza un tipo (+ su doc)
     absence_toggle {code, active} -> activa/desactiva
     causa_list                    -> lista causas
     causa_save {causa}            -> crea/actualiza una causa
     causa_toggle {code, active}   -> activa/desactiva

   Reglas de negocio:
     - El limite hacia atras lo manda el corte global cuando
       past_uses_cutoff = true (no se guarda numero propio).
     - future_window_days: 0 = sin futuro; >0 = tope de dias.
     - allows_future se mantiene en sync (= future_window_days > 0).
     - El documento del tipo vive en required_docs (0 o 1 por absence_code):
       name, enforcement (block|warn|optional), is_required.

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

const ENFORCEMENTS = ['block', 'warn', 'optional'];

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const { action, adminId } = body;

  try {
    if (!(await isSuperadmin(env, adminId))) return json({ ok: false, error: 'Requiere superadmin.' }, 403);

    /* ---------------- TIPOS DE AUSENCIA ---------------- */
    if (action === 'absence_list') {
      const types = await sb(env, 'absence_types?select=code,label,ax_code,note,is_active,sort_order,past_window_days,past_uses_cutoff,future_window_days,allows_future&order=sort_order');
      const docs = await sb(env, 'required_docs?absence_code=not.is.null&select=id,absence_code,name,note,enforcement,is_required,is_active&order=sort_order');
      const docByCode = {};
      (docs || []).forEach(d => { if (!docByCode[d.absence_code]) docByCode[d.absence_code] = d; });
      const out = (types || []).map(t => ({
        code: t.code, label: t.label, ax_code: t.ax_code || t.code, note: t.note || '',
        is_active: t.is_active, sort_order: t.sort_order,
        past_uses_cutoff: !!t.past_uses_cutoff,
        past_window_days: t.past_window_days,
        future_window_days: t.future_window_days || 0,
        doc: docByCode[t.code]
          ? { id: docByCode[t.code].id, name: docByCode[t.code].name, note: docByCode[t.code].note || '',
              enforcement: docByCode[t.code].enforcement || 'warn', is_required: docByCode[t.code].is_required !== false,
              is_active: docByCode[t.code].is_active !== false }
          : null,
      }));
      return json({ ok: true, types: out });
    }

    if (action === 'absence_save') {
      const t = body.type || {};
      const code = (t.code || '').trim().toUpperCase();
      const label = (t.label || '').trim();
      const axCode = (t.ax_code || '').trim().toUpperCase() || code;
      if (!code || !/^[A-Z]{2,6}$/.test(code)) return json({ ok: false, error: 'Codigo invalido (2 a 6 letras).' }, 400);
      if (!label) return json({ ok: false, error: 'Falta el nombre del tipo.' }, 400);
      if (axCode && !/^[A-Z]{2,4}$/.test(axCode)) return json({ ok: false, error: 'Codigo AX invalido (2 a 4 letras).' }, 400);

      const pastUsesCutoff = !!t.past_uses_cutoff;
      // Si respeta el corte global, no guardamos numero propio (lo manda el setting).
      // Si no, se admite un numero de dias atras (o null = sin limite).
      let pastWindowDays = null;
      if (!pastUsesCutoff && t.past_window_days != null && t.past_window_days !== '') {
        const n = parseInt(t.past_window_days, 10);
        if (Number.isNaN(n) || n < 0) return json({ ok: false, error: 'Dias atras invalido.' }, 400);
        pastWindowDays = n;
      } else if (pastUsesCutoff) {
        // Marcador: guardamos el margen global actual por referencia (el Worker de envio
        // igual lo recalcula en vivo). Si no existe, 2 por defecto.
        const m = await sb(env, 'app_settings?key=eq.corte_margen_dias&select=value');
        pastWindowDays = (m && m[0] && parseInt(m[0].value, 10)) || 2;
      }
      const futureDays = Math.max(0, parseInt(t.future_window_days, 10) || 0);

      const row = {
        code, label, ax_code: axCode,
        note: (t.note || '').trim() || null,
        is_active: t.is_active !== false,
        past_uses_cutoff: pastUsesCutoff,
        past_window_days: pastWindowDays,
        future_window_days: futureDays,
        allows_future: futureDays > 0,
      };

      // Upsert por code. Si es nuevo, asignar sort_order al final.
      const existing = await sb(env, `absence_types?code=eq.${encodeURIComponent(code)}&select=code,sort_order`);
      if (existing && existing.length) {
        await sb(env, `absence_types?code=eq.${encodeURIComponent(code)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row),
        });
      } else {
        const last = await sb(env, 'absence_types?select=sort_order&order=sort_order.desc&limit=1');
        row.sort_order = ((last && last[0] && last[0].sort_order) || 0) + 10;
        await sb(env, 'absence_types', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      }

      // Documento del tipo (en required_docs). El front manda doc=null (sin doc) o {name,enforcement,...}.
      const doc = body.type.doc;
      const curDoc = await sb(env, `required_docs?absence_code=eq.${encodeURIComponent(code)}&select=id`);
      if (doc && (doc.name || '').trim()) {
        const enforcement = ENFORCEMENTS.includes(doc.enforcement) ? doc.enforcement : 'warn';
        const docRow = {
          absence_code: code,
          name: doc.name.trim(),
          note: (doc.note || '').trim() || null,
          enforcement,
          is_required: doc.is_required !== false,
          is_active: true,
        };
        if (curDoc && curDoc.length) {
          await sb(env, `required_docs?absence_code=eq.${encodeURIComponent(code)}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(docRow),
          });
        } else {
          const lastD = await sb(env, 'required_docs?select=sort_order&order=sort_order.desc&limit=1');
          docRow.sort_order = ((lastD && lastD[0] && lastD[0].sort_order) || 0) + 10;
          await sb(env, 'required_docs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(docRow) });
        }
      } else if (curDoc && curDoc.length) {
        // Quitaron el documento: desactivarlo (no borrar, para no perder historial).
        await sb(env, `required_docs?absence_code=eq.${encodeURIComponent(code)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ is_active: false }),
        });
      }

      return json({ ok: true, code });
    }

    if (action === 'absence_toggle') {
      const code = (body.code || '').trim().toUpperCase();
      if (!code) return json({ ok: false, error: 'Falta el codigo.' }, 400);
      await sb(env, `absence_types?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ is_active: !!body.active }),
      });
      return json({ ok: true });
    }

    /* ---------------- CAUSAS DE MARCAJE ---------------- */
    if (action === 'causa_list') {
      const causas = await sb(env, 'marcaje_causas?select=code,label,is_other,is_active,sort_order&order=sort_order');
      return json({ ok: true, causas: causas || [] });
    }

    if (action === 'causa_save') {
      const c = body.causa || {};
      const code = (c.code || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const label = (c.label || '').trim();
      if (!code) return json({ ok: false, error: 'Falta el codigo de la causa.' }, 400);
      if (!label) return json({ ok: false, error: 'Falta el nombre de la causa.' }, 400);
      const row = {
        code, label, is_other: !!c.is_other, is_active: c.is_active !== false,
      };
      const existing = await sb(env, `marcaje_causas?code=eq.${encodeURIComponent(code)}&select=code`);
      if (existing && existing.length) {
        await sb(env, `marcaje_causas?code=eq.${encodeURIComponent(code)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row),
        });
      } else {
        const last = await sb(env, 'marcaje_causas?select=sort_order&order=sort_order.desc&limit=1');
        row.sort_order = ((last && last[0] && last[0].sort_order) || 0) + 10;
        await sb(env, 'marcaje_causas', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      }
      return json({ ok: true, code });
    }

    if (action === 'causa_toggle') {
      const code = (body.code || '').trim().toLowerCase();
      if (!code) return json({ ok: false, error: 'Falta el codigo.' }, 400);
      await sb(env, `marcaje_causas?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ is_active: !!body.active }),
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
