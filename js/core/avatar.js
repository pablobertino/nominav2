/* =====================================================================
   core/avatar.js — Iniciales y color del avatar de un trabajador.  (v6.211)

   POR QUE ES UN MODULO Y NO CODIGO REPETIDO: esto nacio dentro de
   js/views/personnel-search.js, y cuando el Detalle de reportes necesito lo
   mismo la salida facil era copiar las dos paletas y las dos funciones. Dos
   copias de una paleta de colores no se rompen: se DESINCRONIZAN, y el dia
   que alguien agregue un color en un lado, la misma persona sale de un color
   en Buscar personal y de otro en el reporte. Un usuario que ve caras a
   diario nota eso aunque no sepa explicar que le cambio.

   Lo que se comparte es la LOGICA (que iniciales, que color), no el CSS:
   en Buscar personal el avatar es un cuadrado redondeado de 42px y en el
   Detalle es un circulo de 34px. Cada pantalla lo viste como quiere; el
   color y las letras salen de aca.

   El color se deriva de la CEDULA y no del nombre, para que la misma
   persona conserve su color aunque le corrijan como esta escrito.
   ===================================================================== */

/* Fondos y textos en el mismo orden: AVATAR_BG[i] va con AVATAR_FG[i].
   Son 8 pares de contraste comodo sobre fondo claro. */
export const AVATAR_BG = ['#dbeafe', '#fae8ff', '#dcfce7', '#fef9c3', '#fee2e2', '#e0e7ff', '#ccfbf1', '#ffedd5'];
export const AVATAR_FG = ['#1e40af', '#86198f', '#166534', '#854d0e', '#991b1b', '#3730a3', '#0f766e', '#9a3412'];

/* Primera letra del primer nombre + primera del ultimo apellido. Con un solo
   token, sus dos primeras letras. Nunca vacio: '?' antes que un circulo mudo. */
export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* Indice de color estable para una semilla (la cedula). Es un hash simple a
   proposito: no se busca dispersion criptografica sino que la MISMA semilla
   de SIEMPRE el mismo color, en esta pantalla y en la otra, hoy y en un año. */
export function avatarColor(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % AVATAR_BG.length;
}

/* Los dos colores ya resueltos, para no repetir el indexado en cada llamador. */
export function avatarColors(seed) {
  const i = avatarColor(seed);
  return { bg: AVATAR_BG[i], fg: AVATAR_FG[i] };
}
