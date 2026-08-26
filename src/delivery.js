// ============================================================================
//  Entrega del material — qué pack va con qué carpeta y quién recibe acceso
// ============================================================================
//  Los IDs de las carpetas NO están en el código (src/products.js se sube a
//  GitHub). Viven en la variable de entorno DRIVE_FOLDERS, con este formato:
//
//    DRIVE_FOLDERS={"pack-mentalidad":"<ID-de-la-carpeta>","pack-recetas-fit":"<link-completo-de-Drive>"}
//
//  Se acepta el ID pelado o el link completo de Drive (se extrae el ID solo),
//  así se puede pegar directo lo que copiás desde el navegador.
//
//  Un producto SIN carpeta configurada = servicio a medida: no hay entrega
//  automática y la trainer recibe el aviso para coordinarlo.
//
//  REGLA DE ORO de este módulo: nunca tira una excepción hacia afuera. Si Drive
//  falla, el pago se confirma igual, el cliente recibe su mail y la trainer se
//  entera de que tiene que entregar a mano. Un problema de Google jamás puede
//  romper el cobro.
// ============================================================================
const drive = require('./drive');

// Extrae el ID de un link de Drive, o devuelve el valor tal cual si ya es un ID.
function toFolderId(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  const m = v.match(/\/(?:folders|d)\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(v) ? v : null;
}

function loadFolders() {
  const raw = (process.env.DRIVE_FOLDERS || '').trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('⚠️  DRIVE_FOLDERS no es un JSON válido — se ignora.');
    return {};
  }
  const out = {};
  for (const [productId, value] of Object.entries(parsed)) {
    const id = toFolderId(value);
    if (id) out[productId] = id;
    else console.error(`⚠️  DRIVE_FOLDERS: la carpeta de "${productId}" no parece un ID/link válido.`);
  }
  return out;
}

const FOLDERS = loadFolders();
const folderCount = Object.keys(FOLDERS).length;
console.log(
  folderCount
    ? `📦 Entrega automática configurada para ${folderCount} producto(s).`
    : '📦 Sin carpetas en DRIVE_FOLDERS — todo se entrega a mano.'
);

const folderIdFor = (productId) => FOLDERS[productId] || null;
const folderUrl = (folderId) => `https://drive.google.com/drive/folders/${folderId}`;

// ¿Este producto se entrega solo? Lo usa la web y los mails para saber si hay
// que prometer acceso inmediato o coordinación en 48hs.
const isAutoDelivered = (productId) => !!folderIdFor(productId);

// ---------------------------------------------------------------------------
//  Entrega de una orden
// ---------------------------------------------------------------------------
// Devuelve un resultado por ítem:
//   { id, name, qty, access, url, error }
//   access = 'granted'  -> ya tiene acceso, se le manda el link
//          | 'pending'  -> falló Drive; la trainer lo entrega a mano
//          | 'manual'   -> servicio a medida; no hay carpeta (es lo esperado)
async function deliverOrder(order) {
  const email = order?.customer?.email;
  const brand = process.env.BRAND_NAME || 'GG';

  // Un mismo carpeta puede aparecer dos veces (ej: recompra): se comparte una sola.
  const seen = new Map();

  const tasks = (order.items || []).map(async (item) => {
    const base = { id: item.id, name: item.name, qty: item.qty };
    const folderId = folderIdFor(item.id);

    if (!folderId) return { ...base, access: 'manual', url: '', error: null };

    if (!drive.HAS_DRIVE) {
      return {
        ...base,
        access: 'pending',
        url: '',
        error: 'Google Drive no está configurado en el servidor.',
      };
    }

    try {
      if (!seen.has(folderId)) {
        seen.set(
          folderId,
          drive.grantReader({
            folderId,
            email,
            message: `¡Gracias por tu compra en ${brand}! Acá tenés tu material.`,
          })
        );
      }
      await seen.get(folderId);
      return { ...base, access: 'granted', url: folderUrl(folderId), error: null };
    } catch (err) {
      // Se loguea el motivo pero NUNCA el ID de carpeta ni el token.
      console.error(`⚠️  No se pudo dar acceso a "${item.id}" (orden ${order.id}):`, err.message);
      return { ...base, access: 'pending', url: '', error: err.message };
    }
  });

  const results = await Promise.all(tasks);

  const granted = results.filter((r) => r.access === 'granted').length;
  const pending = results.filter((r) => r.access === 'pending').length;
  console.log(
    `📦 Orden ${order.id}: ${granted} entregado(s) automáticamente, ${pending} pendiente(s) de entrega manual.`
  );

  return results;
}

// ---------------------------------------------------------------------------
//  Baja de una orden (devolución o contracargo)
// ---------------------------------------------------------------------------
//  Cuando Mercado Pago avisa que un pago se devolvió o que hubo contracargo, la
//  plata dejó de estar: el acceso al material tiene que caer también. Se le
//  saca el permiso de lectura al comprador sobre cada carpeta de la orden.
//
//  Igual que deliverOrder, NUNCA tira una excepción: la baja se registra en la
//  orden y, si algo de Drive falla, la trainer recibe el aviso para hacerlo a
//  mano. Devuelve un resultado por ítem:
//    { id, name, revoked, error }
//    revoked = true  -> se le quitó el acceso
//            | false -> no había nada que quitar (entrega manual, o ya no tenía)
async function revokeOrder(order) {
  const email = order?.customer?.email;

  const tasks = (order?.items || []).map(async (item) => {
    const base = { id: item.id, name: item.name };
    const folderId = folderIdFor(item.id);

    // Sin carpeta o sin Drive no hay acceso automático que sacar: lo coordina
    // la trainer (queda avisada en el mail).
    if (!folderId || !drive.HAS_DRIVE) return { ...base, revoked: false, error: null };

    try {
      const { revoked } = await drive.revokeReader({ folderId, email });
      return { ...base, revoked, error: null };
    } catch (err) {
      console.error(`⚠️  No se pudo quitar el acceso a "${item.id}" (orden ${order.id}):`, err.message);
      return { ...base, revoked: false, error: err.message };
    }
  });

  const results = await Promise.all(tasks);
  const quitados = results.filter((r) => r.revoked).length;
  const fallados = results.filter((r) => r.error).length;
  console.log(
    `🚫 Orden ${order?.id}: ${quitados} acceso(s) dado(s) de baja, ${fallados} con error.`
  );
  return results;
}

module.exports = {
  deliverOrder,
  revokeOrder,
  isAutoDelivered,
  folderIdFor,
  folderUrl,
  toFolderId,
  FOLDERS,
};
