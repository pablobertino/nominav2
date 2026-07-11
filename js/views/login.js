/* =====================================================================
   views/login.js — Vista de login (solo visual por ahora)
   Detecta el tipo de identificador, mostrar/ocultar contraseña, y la
   vista de recuperación. NO valida contra Supabase todavía: esa lógica
   se conecta en el siguiente hito (auth.js).
   ===================================================================== */
import { CONFIG } from '../config.js';
import { $, mount } from '../core/dom.js';
import { setSession } from '../core/session.js';
import { go } from '../core/router.js';

/** Detecta qué tipo de identificador escribió el usuario */
function detectId(value) {
  const v = (value || '').trim();
  if (!v) return { text: '', cls: '' };
  if (v.includes('@')) {
    return { text: 'Detectado: correo electrónico', cls: 'info' };
  }
  if (CONFIG.storeCodeRe.test(v)) {
    return { text: 'Detectado: código de tienda', cls: 'ok' };
  }
  return { text: 'Detectado: usuario del equipo', cls: 'ok' };
}

/* Íconos SVG monocromos (heredan color vía currentColor) */
const ICONS = {
  users: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  user: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  eye: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
};

/** HTML de la vista de login */
function template() {
  return `
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-head">
        <div class="login-logo">${ICONS.users}</div>
        <p class="login-title">${CONFIG.appName}</p>
        <p class="login-sub">${CONFIG.org}</p>
      </div>

      <!-- Vista: formulario de login -->
      <div id="loginView">
        <div id="loginMsg" class="login-msg"></div>

        <div class="field">
          <label for="loginId">Usuario o e-mail</label>
          <div class="field-icon">
            <span class="ico">${ICONS.user}</span>
            <input id="loginId" type="text" autocomplete="username"
                   placeholder="Usuario o e-mail" />
          </div>
        </div>
        <div id="roleHint" class="role-hint"></div>

        <div class="field">
          <label for="loginPwd">Contraseña</label>
          <div class="field-icon">
            <span class="ico">${ICONS.lock}</span>
            <input id="loginPwd" type="password" autocomplete="current-password"
                   class="has-toggle" placeholder="Contraseña" />
            <button id="togglePwd" type="button" class="toggle-pwd"
                    aria-label="Mostrar u ocultar contraseña">${ICONS.eye}</button>
          </div>
        </div>

        <div class="forgot-row">
          <a href="#" id="forgotLink">¿Olvidaste tu contraseña?</a>
        </div>

        <button id="loginBtn" class="btn-primary">Entrar</button>

        <p class="login-foot">El sistema detecta tu rol automáticamente</p>
        <p id="versionTag" class="version-tag">v${CONFIG.version}</p>
      </div>

      <!-- Vista: recuperación de contraseña (paso 1: pedir enlace) -->
      <div id="recoverView" style="display:none">
        <button id="backBtn" type="button" class="recover-back">← Volver</button>
        <p class="recover-title">Recuperar acceso</p>

        <div id="recoverMsg" class="login-msg"></div>

        <!-- Formulario (se oculta tras un envío exitoso) -->
        <div id="recoverForm">
          <p class="login-sub" style="text-align:left;margin:0 0 12px">Escribe tu usuario, código de tienda o correo. Si tienes un correo registrado, te enviaremos un enlace para crear una nueva contraseña.</p>

          <div class="field">
            <label for="recoverId">Usuario, código o e-mail</label>
            <div class="field-icon">
              <span class="ico">${ICONS.user}</span>
              <input id="recoverId" type="text" autocomplete="username"
                     placeholder="Usuario, código o e-mail" />
            </div>
          </div>

          <button id="recoverBtn" class="btn-primary">Enviar enlace</button>

          <div class="notice notice-info" style="margin-top:16px">
            <span class="ico">${ICONS.info}</span>
            <div>¿Sin correo registrado? El restablecimiento lo realiza Capital Humano.
              Escribe a <strong>${CONFIG.supportEmail}</strong> indicando tu
              código de tienda o usuario.</div>
          </div>
        </div>

        <!-- Confirmación tras enviar (evita reenvíos múltiples) -->
        <div id="recoverSent" style="display:none">
          <div class="notice notice-info">
            <span class="ico">${ICONS.info}</span>
            <div>Si el dato corresponde a una cuenta con correo registrado, te
              enviamos un enlace para restablecer la contraseña. <strong>Revisa tu
              bandeja de entrada</strong> (y la carpeta de spam). El enlace vence
              en 60 minutos.</div>
          </div>
          <button id="recoverAgainBtn" type="button" class="btn-primary" style="margin-top:8px">Volver al inicio</button>
        </div>
      </div>

      <!-- Vista: nueva contraseña (paso 2: llega desde el enlace del correo) -->
      <div id="resetView" style="display:none">
        <p class="recover-title">Nueva contraseña</p>

        <div id="resetMsg" class="login-msg"></div>

        <div class="field">
          <label for="resetPwd">Nueva contraseña</label>
          <div class="field-icon">
            <span class="ico">${ICONS.lock}</span>
            <input id="resetPwd" type="password" autocomplete="new-password"
                   class="has-toggle" placeholder="Mínimo 6 caracteres" />
            <button id="toggleResetPwd" type="button" class="toggle-pwd"
                    aria-label="Mostrar u ocultar contraseña">${ICONS.eye}</button>
          </div>
        </div>

        <div class="field">
          <label for="resetPwd2">Repetir contraseña</label>
          <div class="field-icon">
            <span class="ico">${ICONS.lock}</span>
            <input id="resetPwd2" type="password" autocomplete="new-password"
                   placeholder="Repite la contraseña" />
          </div>
        </div>

        <button id="resetBtn" class="btn-primary">Guardar contraseña</button>
      </div>

      <!-- Vista: CAMBIO OBLIGATORIO de clave (v5.08).
           Se interpone despues de un login correcto cuando la cuenta trae
           must_change_password: es el caso de la clave temporal que entrega
           Capital Humano al crear el usuario o al resetearlo. Hasta v5.07 ese
           flag se guardaba, viajaba al front... y nadie lo leia: la clave
           "temporal" servia para siempre. Aca se corta: no se entra al panel
           sin definir una propia. -->
      <div id="mustView" style="display:none">
        <p class="recover-title">Crea tu contraseña</p>

        <div class="notice notice-info" style="margin-bottom:14px">
          <span class="ico">${ICONS.info}</span>
          <div>Entraste con una <strong>contraseña temporal</strong>. Para continuar,
            definí una contraseña tuya: es la que vas a usar de ahora en adelante.</div>
        </div>

        <div id="mustMsg" class="login-msg"></div>

        <div class="field">
          <label for="mustPwd">Nueva contraseña</label>
          <div class="field-icon">
            <span class="ico">${ICONS.lock}</span>
            <input id="mustPwd" type="password" autocomplete="new-password"
                   class="has-toggle" placeholder="Mínimo 6 caracteres" />
            <button id="toggleMustPwd" type="button" class="toggle-pwd"
                    aria-label="Mostrar u ocultar contraseña">${ICONS.eye}</button>
          </div>
        </div>

        <div class="field">
          <label for="mustPwd2">Repetir contraseña</label>
          <div class="field-icon">
            <span class="ico">${ICONS.lock}</span>
            <input id="mustPwd2" type="password" autocomplete="new-password"
                   placeholder="Repite la contraseña" />
          </div>
        </div>

        <button id="mustBtn" class="btn-primary">Guardar y entrar</button>

        <p class="login-foot">No puede ser igual a la contraseña temporal.</p>
      </div>

    </div>
  </div>`;
}

/** Conecta los eventos de la vista una vez montada */
function wire() {
  const idInput   = $('#loginId');
  const pwdInput  = $('#loginPwd');
  const roleHint  = $('#roleHint');
  const toggle    = $('#togglePwd');
  const loginView = $('#loginView');
  const recover   = $('#recoverView');
  const msg       = $('#loginMsg');

  // Detección de rol en vivo
  idInput.addEventListener('input', () => {
    const r = detectId(idInput.value);
    roleHint.textContent = r.text;
    roleHint.className = 'role-hint ' + r.cls;
  });

  // Mostrar / ocultar contraseña
  toggle.addEventListener('click', () => {
    const show = pwdInput.type === 'password';
    pwdInput.type = show ? 'text' : 'password';
    toggle.innerHTML = show ? ICONS.eyeOff : ICONS.eye;
  });

  // Ir a recuperación
  $('#forgotLink').addEventListener('click', (e) => {
    e.preventDefault();
    loginView.style.display = 'none';
    recover.style.display = 'block';
    resetRecoverForm();
  });
  $('#backBtn').addEventListener('click', () => {
    recover.style.display = 'none';
    loginView.style.display = 'block';
    resetRecoverForm();
  });

  // --- Paso 1: pedir enlace de recuperación ---
  const recoverBtn  = $('#recoverBtn');
  const recoverId   = $('#recoverId');
  const recoverMsg  = $('#recoverMsg');
  const recoverForm = $('#recoverForm');
  const recoverSent = $('#recoverSent');

  // Deja la vista de recuperación en su estado inicial (form visible, sin msg).
  function resetRecoverForm() {
    if (recoverForm) recoverForm.style.display = 'block';
    if (recoverSent) recoverSent.style.display = 'none';
    if (recoverMsg) { recoverMsg.textContent = ''; recoverMsg.className = 'login-msg'; }
    if (recoverId) recoverId.value = '';
    if (recoverBtn) { recoverBtn.disabled = false; recoverBtn.textContent = 'Enviar enlace'; }
  }

  async function doRecover() {
    const id = recoverId.value.trim();
    if (!id) {
      recoverMsg.textContent = 'Escribe tu usuario, código o correo.';
      recoverMsg.className = 'login-msg err show';
      return;
    }
    recoverBtn.disabled = true;
    const original = recoverBtn.textContent;
    recoverBtn.textContent = 'Enviando…';
    recoverMsg.className = 'login-msg';
    try {
      const res = await fetch('/api/recover-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: id }),
      });
      const data = await res.json();

      if (data.noEmail) {
        // Cuenta sin correo: NO se envió nada; dejar el form para reintentar.
        recoverMsg.textContent = data.message || 'Esta cuenta no tiene un correo registrado.';
        recoverMsg.className = 'login-msg err show';
        recoverBtn.disabled = false;
        recoverBtn.textContent = original;
        return;
      }

      // Éxito (o respuesta neutra): ocultar el formulario para evitar reenvíos.
      recoverMsg.textContent = '';
      recoverMsg.className = 'login-msg';
      recoverForm.style.display = 'none';
      recoverSent.style.display = 'block';
    } catch (err) {
      recoverMsg.textContent = 'No se pudo conectar. Intenta de nuevo.';
      recoverMsg.className = 'login-msg err show';
      recoverBtn.disabled = false;
      recoverBtn.textContent = original;
    }
  }
  recoverBtn.addEventListener('click', doRecover);
  recoverId.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRecover(); });

  // "Volver al inicio" desde la confirmación: regresa al login limpio.
  const recoverAgainBtn = $('#recoverAgainBtn');
  if (recoverAgainBtn) recoverAgainBtn.addEventListener('click', () => {
    recover.style.display = 'none';
    loginView.style.display = 'block';
    resetRecoverForm();
  });

  // --- Paso 2: nueva contraseña (cuando se llega con ?token=) ---
  const resetView = $('#resetView');
  const resetPwd  = $('#resetPwd');
  const resetPwd2 = $('#resetPwd2');
  const resetBtn  = $('#resetBtn');
  const resetMsg  = $('#resetMsg');
  const toggleReset = $('#toggleResetPwd');

  if (toggleReset) toggleReset.addEventListener('click', () => {
    const show = resetPwd.type === 'password';
    resetPwd.type = show ? 'text' : 'password';
    toggleReset.innerHTML = show ? ICONS.eyeOff : ICONS.eye;
  });

  // ¿Hay token en el hash? (formato #/recuperar?token=XXXX)
  const resetToken = getResetToken();
  if (resetToken) {
    loginView.style.display = 'none';
    recover.style.display = 'none';
    resetView.style.display = 'block';
  }

  async function doReset() {
    const p1 = resetPwd.value, p2 = resetPwd2.value;
    if (p1.length < 6) {
      resetMsg.textContent = 'La contraseña debe tener al menos 6 caracteres.';
      resetMsg.className = 'login-msg err show';
      return;
    }
    if (p1 !== p2) {
      resetMsg.textContent = 'Las contraseñas no coinciden.';
      resetMsg.className = 'login-msg err show';
      return;
    }
    resetBtn.disabled = true;
    const original = resetBtn.textContent;
    resetBtn.textContent = 'Guardando…';
    resetMsg.className = 'login-msg';
    try {
      const res = await fetch('/api/recover-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword: p1 }),
      });
      const data = await res.json();
      if (!data.ok) {
        resetMsg.textContent = data.error || 'No se pudo actualizar la contraseña.';
        resetMsg.className = 'login-msg err show';
        return;
      }
      // Éxito: limpiar el token del hash y volver al login con mensaje.
      resetView.style.display = 'none';
      loginView.style.display = 'block';
      location.hash = '/login';
      msg.textContent = data.message || 'Tu contraseña se actualizó. Ya puedes iniciar sesión.';
      msg.className = 'login-msg ok show';
    } catch (err) {
      resetMsg.textContent = 'No se pudo conectar. Intenta de nuevo.';
      resetMsg.className = 'login-msg err show';
    } finally {
      resetBtn.disabled = false;
      resetBtn.textContent = original;
    }
  }
  resetBtn.addEventListener('click', doReset);
  resetPwd2.addEventListener('keydown', (e) => { if (e.key === 'Enter') doReset(); });

  // Botón Entrar — valida server-side contra /api/login
  const btn = $('#loginBtn');
  async function doLogin() {
    const id = idInput.value.trim();
    const pwd = pwdInput.value;
    if (!id || !pwd) {
      msg.textContent = 'Ingresa tu usuario y contraseña.';
      msg.className = 'login-msg err show';
      return;
    }
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Entrando…';
    msg.className = 'login-msg';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: id, password: pwd }),
      });
      const data = await res.json();
      if (!data.ok) {
        msg.textContent = data.error || 'Credenciales incorrectas.';
        msg.className = 'login-msg err show';
        return;
      }
      /* v5.08: clave temporal -> NO se entra al panel todavia. Primero hay que
         definir una propia. Antes este flag llegaba y se ignoraba, asi que la
         clave temporal nunca dejaba de servir. */
      if (data.user && data.user.mustChangePassword) {
        askNewPassword(data.user, pwd);
        return;
      }
      setSession(data.user);
      go('/panel');
    } catch (err) {
      msg.textContent = 'No se pudo conectar. Intenta de nuevo.';
      msg.className = 'login-msg err show';
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }
  btn.addEventListener('click', doLogin);
  pwdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  /* ---- v5.08: cambio obligatorio de clave ----
     Se llega aca con un login CORRECTO pero con clave temporal. La sesion NO
     se abre hasta que la clave nueva quede guardada: si el usuario cierra la
     pestana a mitad de camino, sigue con su temporal y se le vuelve a pedir
     en el proximo ingreso (el flag sigue en true en la BD). La clave actual
     viaja al endpoint para que el SERVIDOR la re-verifique: no alcanza con
     decir "soy el usuario 13".
     El contexto del login en curso vive en MUST (no en el closure del
     listener), asi los handlers se cablean UNA vez y siempre operan sobre el
     intento vigente. */
  let MUST = null;   // { user, currentPwd }

  function askNewPassword(user, currentPwd) {
    MUST = { user, currentPwd };
    loginView.style.display = 'none';
    recover.style.display = 'none';
    $('#mustView').style.display = '';
    $('#mustPwd').value = '';
    $('#mustPwd2').value = '';
    $('#mustMsg').className = 'login-msg';
    $('#mustPwd').focus();
  }

  async function saveMustPwd() {
    if (!MUST) return;
    const mMsg = $('#mustMsg');
    const mBtn = $('#mustBtn');
    const a = $('#mustPwd').value;
    const b = $('#mustPwd2').value;
    const fail = (t) => { mMsg.textContent = t; mMsg.className = 'login-msg err show'; };

    if (a.length < 6) return fail('La contraseña debe tener al menos 6 caracteres.');
    if (a !== b) return fail('Las contraseñas no coinciden.');
    if (a === MUST.currentPwd) return fail('La contraseña nueva no puede ser igual a la temporal.');

    mBtn.disabled = true;
    const orig = mBtn.textContent;
    mBtn.textContent = 'Guardando…';
    mMsg.className = 'login-msg';
    try {
      const r = await fetch('/api/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: MUST.user.kind, id: MUST.user.id,
          currentPassword: MUST.currentPwd, newPassword: a,
        }),
      });
      const d = await r.json();
      if (!d.ok) return fail(d.error || 'No se pudo guardar la contraseña.');
      // Recien ahora se abre la sesion, ya sin el flag.
      setSession({ ...MUST.user, mustChangePassword: false });
      MUST = null;
      go('/panel');
    } catch (_) {
      fail('No se pudo conectar. Intenta de nuevo.');
    } finally {
      mBtn.disabled = false;
      mBtn.textContent = orig;
    }
  }

  $('#mustBtn').addEventListener('click', saveMustPwd);
  $('#mustPwd2').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveMustPwd(); });
  $('#toggleMustPwd').addEventListener('click', () => {
    const p = $('#mustPwd');
    const show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    $('#toggleMustPwd').innerHTML = show ? ICONS.eyeOff : ICONS.eye;
  });

  // Comparar versión del código con la registrada en la tabla
  checkVersion();
}

/** Compara CONFIG.version (código) con la última de la tabla y avisa si difieren */
async function checkVersion() {
  const tag = $('#versionTag');
  if (!tag) return;
  try {
    const res = await fetch('/api/version');
    const data = await res.json();
    const registered = data.ok && data.latest ? data.latest.version : null;
    if (!registered) { tag.textContent = `v${CONFIG.version}`; return; }
    if (registered === CONFIG.version) {
      tag.textContent = `v${CONFIG.version}`;
      tag.className = 'version-tag ok';
      tag.title = data.latest.summary || '';
    } else {
      tag.innerHTML = `Su versión v${CONFIG.version} no es la última vigente. <a href="#" id="reloadLink">Haga clic para actualizar a la v${registered}</a>`;
      tag.className = 'version-tag warn';
      tag.title = 'Tu navegador tiene una versión en caché. Haz clic en el enlace o presiona Ctrl+F5 (Ctrl+Shift+R) para cargar la más reciente.';
      const link = document.getElementById('reloadLink');
      if (link) link.addEventListener('click', (e) => {
        e.preventDefault();
        // Recarga forzada saltando caché
        location.reload(true);
      });
    }
  } catch {
    tag.textContent = `v${CONFIG.version}`;
  }
}

/** Extrae el token de recuperación del hash: #/recuperar?token=XXXX */
function getResetToken() {
  const h = location.hash || '';
  const i = h.indexOf('?');
  if (i < 0) return null;
  const path = h.slice(0, i).replace(/^#/, '');
  if (path !== '/recuperar') return null;
  const params = new URLSearchParams(h.slice(i + 1));
  const t = params.get('token');
  return t && t.trim() ? t.trim() : null;
}

/** Punto de entrada de la vista */
export function renderLogin() {
  mount(template());
  wire();
}
