// ============================================================================
//  Límite de requests por IP
// ============================================================================
//  Para qué: /api/checkout crea una orden y una preferencia en Mercado Pago en
//  cada llamada. Sin tope, cualquiera puede dispararlo miles de veces y llenarte
//  la base (que se paga) sin comprar nada. Esto no protege plata — los precios
//  ya se calculan en el servidor — protege recursos y costo.
//
//  Dónde se guardan los contadores:
//   - Con Redis (producción): compartidos entre todas las instancias. En Vercel
//     cada request puede caer en una lambda distinta, así que un contador en
//     memoria contaría de a poquito en cada una y no limitaría nada.
//   - Sin Redis (local): en memoria, que alcanza porque hay un solo proceso.
//
//  Cada endpoint elige dónde contar. Los caros (checkout, confirm) van a Redis
//  porque tienen que ser exactos; los baratos y muy llamados (quote) se quedan
//  en memoria para no pagar un request de Upstash por tecla que toque el cliente.
//
//  REGLA: si el contador falla, se deja pasar. Preferimos vender de más a que un
//  problema de Redis te deje la tienda sin funcionar.
const store = require('./store');

// ---------------------------------------------------------------------------
//  Quién es el cliente
// ---------------------------------------------------------------------------
// x-real-ip / x-forwarded-for los escribe el edge de Vercel. Lo que mande el
// cliente por su cuenta queda detrás del valor real, nunca en la primera
// posición, así que no se puede falsificar la identidad para saltear el límite.
function clientIp(req) {
  const real = req.get('x-real-ip');
  if (real) return real.trim();
  const fwd = req.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'desconocida';
}

// ---------------------------------------------------------------------------
//  Contadores
// ---------------------------------------------------------------------------
const memory = new Map(); // key -> { count, resetAt }

function hitMemory(key, windowSec) {
  const now = Date.now();
  const found = memory.get(key);
  if (!found || now > found.resetAt) {
    memory.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return 1;
  }
  found.count += 1;
  return found.count;
}

// Limpieza perezosa: sin esto el Map crece para siempre en un server de larga
// vida. Se hace de a poco, sin recorrer todo en cada request.
let lastSweep = Date.now();
function sweepMemory() {
  const now = Date.now();
  if (now - lastSweep < 60000) return;
  lastSweep = now;
  for (const [k, v] of memory) {
    if (now > v.resetAt) memory.delete(k);
  }
}

async function hitRedis(key, windowSec) {
  const n = await store.redis.incr(key);
  // Solo el primero de la ventana pone el vencimiento.
  if (n === 1) await store.redis.expire(key, windowSec);
  return n;
}

// ---------------------------------------------------------------------------
//  Middleware
// ---------------------------------------------------------------------------
//  limit({ name, max, windowSec, shared, message })
//    name      -> etiqueta del contador (un cupo separado por endpoint)
//    max       -> cuántas requests se permiten por ventana
//    windowSec -> largo de la ventana, en segundos
//    shared    -> true para contar en Redis (exacto entre instancias)
function limit({ name, max, windowSec, shared = false, message }) {
  const texto = message || 'Demasiadas solicitudes seguidas. Esperá un momento y reintentá.';

  return async function rateLimit(req, res, next) {
    let count;
    try {
      const ip = clientIp(req);
      // Ventana fija: todos los que caen en el mismo tramo comparten contador,
      // y la clave vence sola sin necesidad de limpiar nada.
      const bucket = Math.floor(Date.now() / (windowSec * 1000));
      const key = `rl:${name}:${ip}:${bucket}`;

      if (shared && store.redis) {
        count = await hitRedis(key, windowSec);
      } else {
        sweepMemory();
        count = hitMemory(key, windowSec);
      }
    } catch (err) {
      // Fail-open a propósito (ver arriba).
      console.error(`No se pudo aplicar el límite "${name}":`, err.message);
      return next();
    }

    if (count > max) {
      // Se avisa solo al cruzar el límite, para no llenar los logs si insisten.
      if (count === max + 1) {
        console.warn(`⚠️  Límite "${name}" alcanzado por ${clientIp(req)} (${count}/${max}).`);
      }
      res.set('Retry-After', String(windowSec));
      return res.status(429).json({ error: texto });
    }

    next();
  };
}

module.exports = { limit, clientIp };
