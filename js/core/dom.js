/* =====================================================================
   core/dom.js — Helpers mínimos de DOM (sin librerías)
   ===================================================================== */

/** querySelector corto */
export const $ = (sel, root = document) => root.querySelector(sel);

/** querySelectorAll como array */
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Crea un elemento con atributos e hijos.
 * el('div', {class:'x'}, [hijo1, 'texto'])
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined) {
      node.setAttribute(k, v);
    }
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** Monta una vista (string HTML o nodo) dentro de #app */
export function mount(viewHtmlOrNode) {
  const app = $('#app');
  app.innerHTML = '';
  if (typeof viewHtmlOrNode === 'string') app.innerHTML = viewHtmlOrNode;
  else app.appendChild(viewHtmlOrNode);
}
