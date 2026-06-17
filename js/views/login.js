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

      <!-- Vista: recuperación de contraseña -->
      <div id="recoverView" style="display:none">
        <button id="backBtn" type="button" class="recover-back">← Volver</button>
        <p class="recover-title">Recuperar acceso</p>

        <div class="notice notice-info">
          <span class="ico">${ICONS.info}</span>
          <div>Por ahora el restablecimiento lo realiza Capital Humano.
            Escribe a <strong>${CONFIG.supportEmail}</strong> indicando tu
            código de tienda o usuario, y te asignarán una clave temporal.</div>
        </div>

        <div class="notice notice-soon">
          <span class="ico">${ICONS.clock}</span>
          <div>Próximamente: autoservicio por correo electrónico.</div>
        </div>
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
  });
  $('#backBtn').addEventListener('click', () => {
    recover.style.display = 'none';
    loginView.style.display = 'block';
  });

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
      tag.textContent = `código v${CONFIG.version} ≠ registrada v${registered}`;
      tag.className = 'version-tag warn';
      tag.title = 'El código desplegado no coincide con la última versión registrada. Puede ser caché o un deploy pendiente.';
    }
  } catch {
    tag.textContent = `v${CONFIG.version}`;
  }
}

/** Punto de entrada de la vista */
export function renderLogin() {
  mount(template());
  wire();
}
