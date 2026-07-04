/* =====================================================================
   functions/api/recover-request.js  →  POST /api/recover-request
   Paso 1 de la recuperación de contraseña (autoservicio por correo).

   Recibe { identifier } (alias/company_code, username o correo, igual que
   el login). Si la cuenta existe Y tiene correo cargado, genera un token
   de un solo uso (1h) en nomina_v2.password_reset_tokens y dispara el envío
   del correo con el enlace vía la Edge Function 'send-mail'.

   Respuestas (deliberadamente cuidadas para no filtrar de más):
     - correo como entrada + no existe  -> NEUTRO (ok:true, sent-ish)
     - existe pero SIN correo cargado    -> aviso claro noEmail:true
     - existe con correo                 -> genera token + envía + NEUTRO
   Nunca revela el hash ni el salt. El hash se maneja server-side.

   Secrets (Cloudflare → Variables):
     - supabase_url, supabase_service_role
     - mail_fn_url         (URL de la Edge Function send-mail)
     - mail_shared_secret  (mismo valor que MAIL_SHARED_SECRET en Supabase)
     - portal_base_url     (ej. https://nominav2.pages.dev) para armar el link
   ===================================================================== */

const TOKEN_TTL_MIN = 60;                 // vigencia del enlace: 60 min

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

/** Token urlsafe aleatorio (32 bytes → base64url). */
function makeToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Busca la cuenta por identificador, en el MISMO orden que el login.
 * Devuelve { kind, id, email, company } o null. email puede ser ''/null.
 * 'company' (solo para kind='company') trae datos para identificar en el correo:
 * { code, name, rif, zona, subzona, concepto }.
 */
async function findAccount(env, identifier) {
  const isEmail = identifier.includes('@');

  // 1) admin_users (username o email)
  const adminFilter = isEmail
    ? `email=eq.${encodeURIComponent(identifier)}`
    : `username=eq.${encodeURIComponent(identifier)}`;
  const admins = await sb(env, `admin_users?${adminFilter}&is_active=eq.true&select=id,email`);
  if (admins && admins.length) return { kind: 'admin', id: admins[0].id, email: admins[0].email || '', company: null };

  // 2) company_users (company_code o email). Trae datos de la empresa por embed
  //    para identificar la cuenta en el correo (alias, razon social, RIF, etc.).
  const compFilter = isEmail
    ? `email=eq.${encodeURIComponent(identifier)}`
    : `company_code=eq.${encodeURIComponent(identifier.toUpperCase())}`;
  const compSelect = 'id,email,company_code,'
    + 'companies!company_users_company_code_fkey('
    + 'business_name,tax_id,'
    + 'zones(name),subzones(name),concepts(name))';
  let comps = null;
  try {
    comps = await sb(env, `company_users?${compFilter}&is_active=eq.true&select=${encodeURIComponent(compSelect)}`);
  } catch {
    // Si el embed falla (nombre de FK distinto), reintenta sin datos de empresa.
    comps = await sb(env, `company_users?${compFilter}&is_active=eq.true&select=id,email,company_code`);
  }
  if (comps && comps.length) {
    const c = comps[0];
    const co = c.companies || {};
    return {
      kind: 'company', id: c.id, email: c.email || '',
      company: {
        code: c.company_code || '',
        name: co.business_name || '',
        rif: co.tax_id || '',
        zona: (co.zones && co.zones.name) || '',
        subzona: (co.subzones && co.subzones.name) || '',
        concepto: (co.concepts && co.concepts.name) || '',
      },
    };
  }

  // 3) enterprise_users (username o email)
  const euFilter = isEmail
    ? `email=eq.${encodeURIComponent(identifier)}`
    : `username=eq.${encodeURIComponent(identifier)}`;
  const eus = await sb(env, `enterprise_users?${euFilter}&is_active=eq.true&select=id,email`);
  if (eus && eus.length) return { kind: 'enterprise', id: eus[0].id, email: eus[0].email || '', company: null };

  return null;
}

/** Escapa texto para HTML (evita romper el markup con datos). */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Fila del bloque de identificacion (label/valor), con borde inferior opcional. */
function idRow(label, value, last) {
  const bb = last ? '' : 'border-bottom:1px solid #eef2f7;';
  return `<tr>`
    + `<td style="padding:9px 14px;color:#64748b;width:38%;${bb}">${esc(label)}</td>`
    + `<td style="padding:9px 14px;font-weight:600;${bb}">${esc(value)}</td>`
    + `</tr>`;
}

/**
 * Correo HTML del enlace de recuperacion (estilo del portal).
 * @param link  URL con el token (va SOLO en el boton, no en texto visible).
 * @param company  datos para identificar la cuenta (o null).
 */
function buildHtml(link, company) {
  // Bloque de identificacion (solo si hay datos de tienda).
  let idBlock = '';
  if (company && (company.code || company.name)) {
    const rows = [
      ['Alias', company.code],
      ['Razón social', company.name],
      ['Concepto', company.concepto],
      ['RIF', company.rif],
      ['Zona', company.zona],
      ['Subzona', company.subzona],
    ].filter(r => r[1]);   // omitir filas vacias
    const html = rows.map((r, i) => idRow(r[0], r[1], i === rows.length - 1)).join('');
    idBlock = `<table style="width:100%;border-collapse:collapse;background:#f8fafc;`
      + `border:1px solid #e2e8f0;border-radius:8px;margin:6px 0 18px;font-size:13px;color:#334155;">`
      + html + `</table>`;
  }
  const intro = idBlock
    ? 'Recibimos una solicitud para restablecer la contraseña del siguiente acceso al Portal de Nómina:'
    : 'Recibimos una solicitud para restablecer la contraseña de tu acceso al Portal de Nómina.';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
    <div style="background:#1e3a8a;padding:22px 28px;">
      <p style="margin:0 0 3px;color:#93c5fd;font-size:11px;text-transform:uppercase;letter-spacing:.08em;">Portal de Nómina · Grupo Canaima</p>
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:700;">Restablecer contraseña</h1>
    </div>
    <div style="padding:26px 28px;">
      <p style="color:#334155;font-size:14px;margin-top:0;">${intro}</p>
      ${idBlock}
      <p style="color:#334155;font-size:14px;">Si esta es tu cuenta, haz clic en el botón para crear una contraseña nueva. El enlace vence en <strong>${TOKEN_TTL_MIN} minutos</strong>.</p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${link}" style="display:inline-block;background:#1e3a8a;color:#fff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Restablecer contraseña</a>
      </div>
      <p style="color:#64748b;font-size:12px;">Si el botón no funciona, vuelve al portal, entra en <strong>¿Olvidaste tu contraseña?</strong> y solicita un enlace nuevo.</p>
      <p style="color:#64748b;font-size:12px;">Si no solicitaste esto, ignora este correo: tu contraseña no cambiará. Por seguridad, no compartas este mensaje con nadie.</p>
    </div>
    <div style="background:#f8fafc;padding:12px 28px;border-top:1px solid #e2e8f0;">
      <p style="margin:0;color:#94a3b8;font-size:11px;">Correo automático · ${new Date().toLocaleString('es-VE')}</p>
    </div>
  </div>
</body></html>`;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }

  const identifier = (body.identifier || '').trim();
  if (!identifier) return json({ ok: false, error: 'Indica tu usuario, alias o correo.' }, 400);

  // Mensaje neutro estándar (no revela si la cuenta/correo existe).
  const NEUTRAL = { ok: true, message: 'Si el dato corresponde a una cuenta con correo registrado, te enviaremos un enlace para restablecer la contraseña.' };

  try {
    const acct = await findAccount(env, identifier);

    // No existe: respuesta neutra (no filtramos la existencia).
    if (!acct) return json(NEUTRAL);

    // Existe pero SIN correo cargado: aviso claro con derivación (decisión de Pablo).
    if (!acct.email || !acct.email.trim()) {
      return json({
        ok: true,
        noEmail: true,
        message: 'Esta cuenta no tiene un correo registrado, por lo que no podemos enviarte el enlace. Contacta a Capital Humano para restablecer tu contraseña.',
      });
    }

    // Existe y tiene correo: generar token y enviar.
    const token = makeToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MIN * 60 * 1000).toISOString();
    const ip = request.headers.get('CF-Connecting-IP') || null;

    await sb(env, 'password_reset_tokens', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        token, user_kind: acct.kind, user_id: acct.id,
        email_sent: acct.email, expires_at: expiresAt, created_ip: ip,
      }),
    });

    const base = (env.portal_base_url || '').replace(/\/+$/, '');
    const link = `${base}/#/recuperar?token=${encodeURIComponent(token)}`;

    // Enviar vía Edge Function send-mail (SMTP app@grupocanaima.com).
    const mailRes = await fetch(env.mail_fn_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: acct.email,
        subject: 'Restablecer tu contraseña — Portal de Nómina',
        html: buildHtml(link, acct.company),
        secret: env.mail_shared_secret,
      }),
    }).then(r => r.json()).catch(() => null);

    // Aunque el envío falle, devolvemos NEUTRO para no filtrar; el error queda
    // en logs. (Si quisieras, podrías diferenciar aquí para debugging.)
    if (!mailRes || !mailRes.ok) {
      // No revelamos el fallo al usuario final; log del lado servidor.
      console.log('send-mail fallo:', mailRes && mailRes.error);
    }

    return json(NEUTRAL);
  } catch (err) {
    // Ante error interno, respuesta neutra igualmente (no filtrar).
    console.log('recover-request error:', err.message);
    return json(NEUTRAL);
  }
}

export async function onRequest({ request }) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Método no permitido.' }, 405);
}
