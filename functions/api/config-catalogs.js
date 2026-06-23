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

    /* ---------------- CARGOS (catalogo maestro) ----------------
       cargos: code (clave interna estable), label (lo ve la tienda),
       ax_code (lo que va a la plantilla AX; puede diferir del label,
       ej. Cajero->CAJEROS), can_be_responsible + responsible_role
       (quien puede ser responsable en los wizard), selectable_on_ingreso
       (aparece en el combo de Ingreso), sort_order (orden/destacado).
       Los patrones del Reporte 10 (cargo_patterns) se editan aparte. */
    if (action === 'cargo_list') {
      const cargos = await sb(env, 'cargos?select=id,code,label,ax_code,can_be_responsible,responsible_role,selectable_on_ingreso,is_active,sort_order&order=sort_order');
      const pats = await sb(env, 'cargo_patterns?select=id,cargo_id,pattern,sort_order,is_active&order=sort_order');
      const patByCargo = {};
      (pats || []).forEach(p => { (patByCargo[p.cargo_id] = patByCargo[p.cargo_id] || []).push(p); });
      const out = (cargos || []).map(c => ({
        id: c.id, code: c.code, label: c.label, ax_code: c.ax_code,
        can_be_responsible: !!c.can_be_responsible,
        responsible_role: c.responsible_role || null,
        selectable_on_ingreso: c.selectable_on_ingreso !== false,
        is_active: c.is_active, sort_order: c.sort_order,
        patterns: (patByCargo[c.id] || []).map(p => ({ id: p.id, pattern: p.pattern, sort_order: p.sort_order, is_active: p.is_active })),
      }));
      return json({ ok: true, cargos: out });
    }

    if (action === 'cargo_save') {
      const c = body.cargo || {};
      const code = (c.code || '').trim().toUpperCase();
      const label = (c.label || '').trim();
      const axCode = (c.ax_code || '').trim().toUpperCase() || code;
      if (!code || !/^[A-Z0-9_\-]{2,20}$/.test(code)) return json({ ok: false, error: 'Codigo invalido (2 a 20: letras, numeros, guion).' }, 400);
      if (!label) return json({ ok: false, error: 'Falta el nombre del cargo.' }, 400);
      const canResp = !!c.can_be_responsible;
      let respRole = (c.responsible_role || '').trim();
      if (!canResp) respRole = null;
      else if (respRole !== 'Gerente' && respRole !== 'Sub-Gerente') {
        return json({ ok: false, error: 'Rol de responsable invalido (Gerente o Sub-Gerente).' }, 400);
      }
      const row = {
        code, label, ax_code: axCode,
        can_be_responsible: canResp,
        responsible_role: respRole,
        selectable_on_ingreso: c.selectable_on_ingreso !== false,
        is_active: c.is_active !== false,
      };
      const existing = await sb(env, `cargos?code=eq.${encodeURIComponent(code)}&select=id`);
      let cargoId;
      if (existing && existing.length) {
        cargoId = existing[0].id;
        await sb(env, `cargos?code=eq.${encodeURIComponent(code)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row),
        });
      } else {
        const last = await sb(env, 'cargos?select=sort_order&order=sort_order.desc&limit=1');
        row.sort_order = ((last && last[0] && last[0].sort_order) || 0) + 10;
        const ins = await sb(env, 'cargos', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
        cargoId = ins && ins[0] && ins[0].id;
      }

      // Patrones del Reporte 10 (texto libre -> este cargo). El front manda
      // patterns: [string,...] (lista completa). Se reescribe el set: se
      // borran los actuales y se insertan los nuevos. Cada patron se guarda
      // normalizado (mayus, sin acentos, espacios colapsados) como lo compara
      // la lectura del Reporte 10.
      if (cargoId && Array.isArray(c.patterns)) {
        const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
        const clean = [...new Set(c.patterns.map(norm).filter(Boolean))];
        await sb(env, `cargo_patterns?cargo_id=eq.${cargoId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        if (clean.length) {
          const payload = clean.map((pattern, i) => ({ cargo_id: cargoId, pattern, sort_order: (i + 1) * 10, is_active: true }));
          await sb(env, 'cargo_patterns', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(payload) });
        }
      }
      return json({ ok: true, code });
    }

    if (action === 'cargo_toggle') {
      const code = (body.code || '').trim().toUpperCase();
      if (!code) return json({ ok: false, error: 'Falta el codigo.' }, 400);
      await sb(env, `cargos?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ is_active: !!body.active }),
      });
      return json({ ok: true });
    }

    /* ---------------- BANCOS (prefijo 4 digitos -> nombre) ---------------- */
    if (action === 'banco_list') {
      const bancos = await sb(env, 'bancos?select=code,name,is_active,sort_order&order=sort_order');
      return json({ ok: true, bancos: bancos || [] });
    }

    if (action === 'banco_save') {
      const b = body.banco || {};
      const code = (b.code || '').trim();
      const name = (b.name || '').trim();
      if (!/^[0-9]{4}$/.test(code)) return json({ ok: false, error: 'El prefijo debe tener 4 digitos.' }, 400);
      if (!name) return json({ ok: false, error: 'Falta el nombre del banco.' }, 400);
      const row = { code, name, is_active: b.is_active !== false };
      const existing = await sb(env, `bancos?code=eq.${encodeURIComponent(code)}&select=code`);
      if (existing && existing.length) {
        await sb(env, `bancos?code=eq.${encodeURIComponent(code)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row),
        });
      } else {
        const last = await sb(env, 'bancos?select=sort_order&order=sort_order.desc&limit=1');
        row.sort_order = ((last && last[0] && last[0].sort_order) || 0) + 10;
        await sb(env, 'bancos', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      }
      return json({ ok: true, code });
    }

    if (action === 'banco_toggle') {
      const code = (body.code || '').trim();
      if (!code) return json({ ok: false, error: 'Falta el codigo.' }, 400);
      await sb(env, `bancos?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ is_active: !!body.active }),
      });
      return json({ ok: true });
    }

    /* ---------------- OPERADORAS (prefijo 4 digitos -> operadora) ---------------- */
    if (action === 'operadora_list') {
      const ops = await sb(env, 'operadoras?select=code,name,is_active,sort_order&order=sort_order');
      return json({ ok: true, operadoras: ops || [] });
    }

    if (action === 'operadora_save') {
      const o = body.operadora || {};
      const code = (o.code || '').trim();
      const name = (o.name || '').trim();
      if (!/^[0-9]{4}$/.test(code)) return json({ ok: false, error: 'El prefijo debe tener 4 digitos.' }, 400);
      if (!name) return json({ ok: false, error: 'Falta el nombre de la operadora.' }, 400);
      const row = { code, name, is_active: o.is_active !== false };
      const existing = await sb(env, `operadoras?code=eq.${encodeURIComponent(code)}&select=code`);
      if (existing && existing.length) {
        await sb(env, `operadoras?code=eq.${encodeURIComponent(code)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row),
        });
      } else {
        const last = await sb(env, 'operadoras?select=sort_order&order=sort_order.desc&limit=1');
        row.sort_order = ((last && last[0] && last[0].sort_order) || 0) + 10;
        await sb(env, 'operadoras', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      }
      return json({ ok: true, code });
    }

    if (action === 'operadora_toggle') {
      const code = (body.code || '').trim();
      if (!code) return json({ ok: false, error: 'Falta el codigo.' }, 400);
      await sb(env, `operadoras?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ is_active: !!body.active }),
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Accion desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
