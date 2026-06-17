/* =====================================================================
   views/login.js — Vista de login (solo visual por ahora)
   Detecta el tipo de identificador, mostrar/ocultar contraseña, y la
   vista de recuperación. NO valida contra Supabase todavía: esa lógica
   se conecta en el siguiente hito (auth.js).
   ===================================================================== */
import { CONFIG } from '../config.js';
import { $, el, mount } from '../core/dom.js';

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

/** HTML de la vista de login */
function template() {
  return `
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-head">
        <div class="login-logo">👥</div>
        <p class="login-title">${CONFIG.appName}</p>
        <p class="login-sub">${CONFIG.org}</p>
      </div>

      <!-- Vista: formulario de login -->
      <div id="loginView">
        <div id="loginMsg" class="login-msg"></div>

        <div class="field">
          <label for="loginId">Usuario, código de tienda o correo</label>
          <div class="field-icon">
            <span class="ico">👤</span>
            <input id="loginId" type="text" autocomplete="username"
                   placeholder="AA01 · superadmin · correo@…" />
          </div>
        </div>
        <div id="roleHint" class="role-hint"></div>

        <div class="field">
          <label for="loginPwd">Contraseña</label>
          <div class="field-icon">
            <span class="ico">🔒</span>
            <input id="loginPwd" type="password" autocomplete="current-password"
                   class="has-toggle" placeholder="••••••••" />
            <button id="togglePwd" type="button" class="toggle-pwd"
                    aria-label="Mostrar u ocultar contraseña">👁</button>
          </div>
        </div>

        <div class="forgot-row">
          <a href="#" id="forgotLink">¿Olvidaste tu contraseña?</a>
        </div>

        <button id="loginBtn" class="btn-primary">Entrar</button>

        <p class="login-foot">El sistema detecta tu rol automáticamente</p>
      </div>

      <!-- Vista: recuperación de contraseña -->
      <div id="recoverView" style="display:none">
        <button id="backBtn" type="button" class="recover-back">← Volver</button>
        <p class="recover-title">Recuperar acceso</p>

        <div class="notice notice-info">
          <span class="ico">ℹ️</span>
          <div>Por ahora el restablecimiento lo realiza Capital Humano.
            Escribe a <strong>${CONFIG.supportEmail}</strong> indicando tu
            código de tienda o usuario, y te asignarán una clave temporal.</div>
        </div>

        <div class="notice notice-soon">
          <span class="ico">🕒</span>
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
    toggle.textContent = show ? '🙈' : '👁';
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

  // Botón Entrar — POR AHORA solo visual (sin validación real)
  $('#loginBtn').addEventListener('click', () => {
    const id = idInput.value.trim();
    if (!id || !pwdInput.value) {
      msg.textContent = 'Ingresa tu usuario y contraseña.';
      msg.className = 'login-msg err show';
      return;
    }
    msg.textContent = 'Demo visual: la validación se conectará en el siguiente paso.';
    msg.className = 'login-msg ok show';
  });
}

/** Punto de entrada de la vista */
export function renderLogin() {
  mount(template());
  wire();
}
