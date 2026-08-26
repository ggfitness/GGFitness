// Capa de datos.
// - Productos: definidos en código (src/products.js).
// - Órdenes: se guardan en Upstash Redis (producción/Vercel) o en un archivo
//   JSON (local/Docker). Se elige automáticamente según las variables de entorno.
const fs = require('fs');
const path = require('path');
const products = require('./products');

// Soportamos tanto los nombres de Vercel KV como los de Upstash.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);

let redis = null;
if (USE_REDIS) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  console.log('🗄️  Órdenes: Upstash Redis (persistente).');
} else {
  console.log('🗄️  Órdenes: archivo JSON local (data/orders.json).');
}

// ---- Productos (fuente única en código) ----
function getProducts() {
  return products;
}
function getProduct(id) {
  return products.find((p) => p.id === id) || null;
}

// ---- Órdenes: backend archivo JSON (local/Docker) ----
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'orders.json');

function fileReadAll() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function fileWriteAll(obj) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---- Diagnóstico de la conexión ----
//  Traduce el error crudo de la librería a algo accionable. `fetch failed` a
//  secas no dice nada: el motivo real viene en `err.cause`, y es la diferencia
//  entre "la URL está mal" y "el token está mal".
function motivoDeFalla(err) {
  const causa = err?.cause;
  if (causa?.code === 'ENOTFOUND') {
    return `no existe el host ${causa.hostname}: la base fue borrada, o Upstash la archivó por inactividad, o la URL está mal cargada`;
  }
  if (causa?.code === 'ECONNREFUSED' || causa?.code === 'ETIMEDOUT') {
    return `no responde (${causa.code}): la base puede estar caída o bloqueada por red`;
  }
  const msg = err?.message || String(err);
  if (/unauthorized|401/i.test(msg)) return 'el token es incorrecto o venció';
  return msg;
}

// Error de infraestructura, no del comprador. Se distingue por `code` para que
// quien llama pueda responder "reintentá" en vez de un 500 opaco.
class StoreUnavailableError extends Error {
  constructor(err) {
    super(`La base de órdenes no responde: ${motivoDeFalla(err)}`);
    this.name = 'StoreUnavailableError';
    this.code = 'STORE_UNAVAILABLE';
    this.cause = err;
  }
}

// Comprueba que la base RESPONDA, no solo que las variables existan.
//  Por qué: mirar las variables no detecta una base borrada o archivada. El
//  síntoma aparecía recién cuando alguien intentaba comprar (ENOTFOUND en el
//  checkout) mientras el health check seguía diciendo que estaba todo bien.
async function ping() {
  if (!USE_REDIS) return { ok: true, backend: 'archivo local' };
  try {
    await redis.ping();
    return { ok: true, backend: 'Upstash Redis' };
  } catch (err) {
    return { ok: false, backend: 'Upstash Redis', error: motivoDeFalla(err) };
  }
}

// ---- Órdenes: API unificada (async) ----
async function getOrder(id) {
  if (USE_REDIS) return (await redis.get('order:' + id)) || null;
  // hasOwnProperty y no all[id]: el id puede venir de afuera (el
  // external_reference que informa Mercado Pago), y nombres como "__proto__" o
  // "constructor" devolverían un objeto heredado en vez de null.
  const all = fileReadAll();
  return Object.prototype.hasOwnProperty.call(all, id) ? all[id] : null;
}

async function saveOrder(order) {
  if (USE_REDIS) {
    // Sigue tirando el error (una orden que no se guardó NO se puede dar por
    // buena), pero envuelto: quien llama puede distinguir "se cayó la base" de
    // un bug, y el mensaje ya viene explicado.
    try {
      await redis.set('order:' + order.id, order);
    } catch (err) {
      throw new StoreUnavailableError(err);
    }
    return order;
  }
  const all = fileReadAll();
  all[order.id] = order;
  fileWriteAll(all);
  return order;
}

// Marca "esta orden ya se está procesando como pagada" de forma atómica.
// Devuelve true una sola vez por orden.
//
// Por qué: el pago se puede confirmar por DOS caminos casi al mismo tiempo
// (la página de éxito y el webhook de Mercado Pago). Sin esta guarda, el
// cliente podría recibir el mail dos veces. Con Redis usamos SET NX, que es
// atómico; en local hay un solo proceso, así que alcanza con releer el estado.
async function claimPaid(orderId) {
  if (USE_REDIS) {
    try {
      const ok = await redis.set('paidlock:' + orderId, 1, { nx: true, ex: 86400 });
      return ok === 'OK' || ok === true;
    } catch (err) {
      // Si Redis falla justo acá preferimos entregar de más que dejar al
      // cliente sin su material.
      console.error('No se pudo tomar el lock de la orden:', err.message);
      return true;
    }
  }
  const current = fileReadAll()[orderId];
  return !current || current.status === 'pending';
}

// Igual que claimPaid pero para cualquier acción que tenga que pasar UNA sola
// vez por orden (hoy: la baja por devolución/contracargo).
//
// Por qué hace falta: Mercado Pago puede notificar el mismo contracargo varias
// veces, y cada notificación dispara la baja del acceso y un mail a la trainer.
// Sin esta guarda, la trainer recibiría el mismo aviso cinco veces.
//
// Devuelve true una sola vez por (accion, orderId).
const memoryClaims = new Set(); // solo local: en Vercel se usa Redis

async function claimOnce(accion, orderId, ttlSec = 86400 * 30) {
  const key = `claim:${accion}:${orderId}`;
  if (USE_REDIS) {
    try {
      const ok = await redis.set(key, 1, { nx: true, ex: ttlSec });
      return ok === 'OK' || ok === true;
    } catch (err) {
      // Si Redis falla, dejamos pasar: preferimos un mail repetido a no dar de
      // baja un acceso que ya se devolvió.
      console.error('No se pudo tomar el lock de la orden:', err.message);
      return true;
    }
  }
  if (memoryClaims.has(key)) return false;
  memoryClaims.add(key);
  return true;
}

module.exports = {
  getProducts,
  getProduct,
  getOrder,
  saveOrder,
  claimPaid,
  claimOnce,
  ping,
  StoreUnavailableError,
  // El limitador de requests (src/ratelimit.js) reusa esta misma conexión:
  // en Vercel cada request puede caer en una instancia distinta, así que los
  // contadores tienen que ser compartidos. Es null cuando corre en local.
  redis,
  USE_REDIS,
};
