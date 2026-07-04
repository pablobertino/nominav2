/* =====================================================================
   config.js — Constantes públicas del portal (SIN secretos)
   Nada de claves ni service_role aquí: esto se sirve al navegador.
   ===================================================================== */
export const CONFIG = {
  appName: 'Portal de Nómina',
  org: 'Grupo Canaima · Capital Humano',

  // Versión del CÓDIGO desplegado. Subir en cada push y registrar la
  // misma versión en la tabla nomina_v2.app_versions. El login compara
  // ambas y avisa si no coinciden (señal de deploy/caché desactualizado).
  version: '3.39',

  // Salt del hash de contraseña (debe coincidir con el portal anterior
  // para no invalidar las claves migradas). Regla de negocio 1.1.
  pwdSalt: 'nm_salt_2025',

  // Correo de contacto para recuperación (fase actual: reseteo por admin).
  supportEmail: 'nomina@grupocanaima.com',

  // Detección de tipo de identificador en el login.
  // store_code tipo "AA01"/"BA03": 2 letras + 2+ dígitos.
  storeCodeRe: /^[A-Za-z]{2}\d{2,}$/,
};
