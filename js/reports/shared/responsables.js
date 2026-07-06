/* =====================================================================
   js/reports/shared/responsables.js
   Gestion de responsables de la tienda (quien reporta). Max 4.
   Usa el Worker /api/store-contacts. Provee acceso a la API; el render
   del modal de gestion lo hace el wizard-core (para reusar estilos).
   ===================================================================== */

export const RESP_MAX = 4;

async function api(payload) {
  const res = await fetch('/api/store-contacts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function contactsList(companyCode, user) {
  return api({ action: 'list', company_code: companyCode, user });
}

export async function contactsAdd(companyCode, fullName, role, idNumber, user) {
  return api({ action: 'add', company_code: companyCode, full_name: fullName, role, id_number: idNumber, user });
}

export async function contactsUpdate(id, fields, user) {
  return api({ action: 'update', id, ...fields, user });
}

export async function contactsRemove(id, user) {
  return api({ action: 'remove', id, user });
}
