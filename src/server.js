const express = require('express');
const path = require('path');
const crypto = require('crypto');

const store = require('./store');
const drive = require('./drive');
const { sendMail } = require('./mailer');
const emails = require('./emails');
const payments = require('./payments');
const fees = require('./fees');
const discounts = require('./discounts');
const delivery = require('./delivery');
const { limit } = require('./ratelimit');
// Validación del email. Vive en public/ porque el MISMO archivo lo carga el
// navegador: así el mensaje que ve el comprador y el que aplica el servidor no
// pueden diferir. Ver el encabezado de public/js/email.js.
const { emailProblem } = require('../public/js/email.js');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const TRAINER_EMAIL = process.env.TRAINER_EMAIL || 'trainer@ejemplo.com';
const BRAND = process.env.BRAND_NAME || 'GG';
// Número de WhatsApp para las consultas, solo dígitos con código de país
// (ej: 5491122334455). Si queda vacío, el botón de WhatsApp no se muestra.
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');

// 32kb es de sobra para un carrito con el formulario completo. Sin tope, el
// límite serían los 100kb que trae Express por defecto, y todo eso terminaría
// guardado en la orden.
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Topes por IP (ver src/ratelimit.js) --------------------------------
// Los números están pensados para no molestar a un comprador real: el carrito
// cotiza en cada cambio, pero nadie compra 15 veces en 10 minutos.
const limitQuote = limit({ name: 'quote', max: 60, windowSec: 60 });
const limitCheckout = limit({
  name: 'checkout',
  max: 15,
  windowSec: 600,
  shared: true, // crea orden + preferencia en MP: el contador tiene que ser exacto
  message: 'Estás iniciando muchas compras seguidas. Esperá unos minutos y reintentá.',
});
const limitConfirm = limit({ name: 'confirm', max: 20, windowSec: 600, shared: true });
const limitWebhook = limit({ name: 'webhook', max: 120, windowSec: 60 });

const money = (n) => '$' + Number(n).toLocaleString('es-AR');
// Formatea con la moneda de la orden (ARS por defecto, o USD).
const fmtMoney = (n, cur) =>
  cur === 'USD' ? 'US$ ' + Number(n).toLocaleString('es-AR') : money(n);
const genId = () => crypto.randomBytes(6).toString('hex');

// ============================================================
//  API PÚBLICA
// ============================================================

// Arma el link de WhatsApp con el mensaje prellenado para un producto.
// Devuelve null si el producto no lo pide o si no hay número configurado,
// así el front simplemente no dibuja el botón.
function whatsappUrl(p) {
  if (!p.whatsapp || !WHATSAPP_NUMBER) return null;
  const text = `Hola! Quiero consultar por el ${p.name}.`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

// % de descuento más alto entre las promos que incluyen a este producto.
// 0 si no entra en ninguna. Lo usa la grilla para avisar "combinable".
function comboMaxOff(id) {
  const priceById = new Map(store.getProducts().map((p) => [p.id, Number(p.price) || 0]));
  return discounts.getRules().reduce((max, r) => {
    const ids = r.allOf || [];
    if (!ids.includes(id)) return max;
    if (r.percentOff) return Math.max(max, r.percentOff);
    // Promos de monto fijo: las pasamos a % sobre el precio lleno del combo,
    // si no el producto se quedaba sin el aviso de "combinable".
    const base = ids.reduce((s, x) => s + (priceById.get(x) || 0), 0);
    if (!r.amountOff || !base) return max;
    return Math.max(max, Math.round((r.amountOff / base) * 100));
  }, 0);
}

// Vista pública de un producto. Lo que sale por la API es SOLO esto: nunca
// viaja al navegador ni un link ni un ID de carpeta de Drive (esos viven en
// variables de entorno, ver src/delivery.js).
function publicProduct(p) {
  const { materialUrl, ...pub } = p; // materialUrl quedó obsoleto: se elimina por las dudas
  return {
    ...pub,
    whatsappUrl: whatsappUrl(p),
    comboMaxOff: comboMaxOff(p.id),
    // true = se entrega solo apenas se aprueba el pago (sirve para mostrar
    // "acceso inmediato" en la web).
    instantAccess: delivery.isAutoDelivered(p.id),
  };
}

// Lista de productos (sin exponer el link del material)
app.get('/api/products', (req, res) => {
  res.json(store.getProducts().map(publicProduct));
});

// Detalle de un producto (sin exponer el link del material)
app.get('/api/products/:id', (req, res) => {
  const product = store.getProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json(publicProduct(product));
});

// Resuelve el carrito contra los precios del servidor (NO confía en el cliente)
// y calcula subtotal, descuento por combo y total. Devuelve { error } si algo falla.
function resolveCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: 'El carrito está vacío.' };
  }
  if (items.length > 50) {
    return { error: 'Demasiados ítems.' };
  }
  const resolved = [];
  let currency = null;
  for (const it of items) {
    const p = store.getProduct(it.id);
    if (!p) return { error: `Producto inválido: ${it.id}` };

    // Los planes personalizados se coordinan por WhatsApp: no se cobran por la
    // web. Esconder el botón no alcanza —el carrito vive en el navegador y se
    // puede editar—, así que el corte tiene que estar acá, que es por donde
    // pasan sí o sí /api/quote y /api/checkout.
    if (p.soloConsulta) {
      return { error: `"${p.name}" se coordina por WhatsApp, no se compra por la web.` };
    }
    const qty = Math.min(100, Math.max(1, parseInt(it.qty, 10) || 1)); // 1..100

    // Los precios se suman entre sí, así que TODO el carrito tiene que estar en
    // la misma moneda. Antes se tomaba la del último producto de la lista: como
    // el orden lo elige el cliente, mezclando un producto en USD con otro en ARS
    // se podía elegir en qué moneda pagar el total (o sea, cuánto pagar de verdad).
    const cur = p.currency || 'ARS';
    if (currency && cur !== currency) {
      return { error: 'No se pueden combinar productos en distintas monedas en la misma compra.' };
    }
    currency = cur;

    resolved.push({ id: p.id, name: p.name, price: p.price, qty });
  }
  currency = currency || 'ARS';

  const subtotal = resolved.reduce((s, it) => s + it.price * it.qty, 0);
  const { discount, applied } = discounts.computeDiscount(resolved);
  const total = Math.max(0, subtotal - discount);

  return { resolved, currency, subtotal, discount, applied, total };
}

// Las respuestas del formulario se guardan en la orden y viajan en el mail de la
// trainer. Antes se guardaba el objeto tal cual venía: cualquiera podía mandar
// miles de campos y quedaban todos escritos en la base. Acá se acota a algo que
// un formulario real nunca supera.
const INTAKE_MAX_CAMPOS = 40;
const INTAKE_MAX_LARGO = 1000;

function cleanIntake(intake) {
  if (!intake || typeof intake !== 'object' || Array.isArray(intake)) return null;
  const out = {};
  for (const [k, v] of Object.entries(intake)) {
    if (Object.keys(out).length >= INTAKE_MAX_CAMPOS) break;
    if (typeof k !== 'string' || !k || k.length > 80) continue;
    if (v && typeof v === 'object') continue; // solo valores planos
    out[k] = String(v == null ? '' : v).slice(0, INTAKE_MAX_LARGO);
  }
  return Object.keys(out).length ? out : null;
}

// Cotización: el carrito la usa para mostrar subtotal, descuento y total
// ANTES de pagar (usa exactamente el mismo cálculo que el checkout).
app.post('/api/quote', limitQuote, (req, res) => {
  const q = resolveCart(req.body?.items);
  if (q.error) return res.status(400).json({ error: q.error });
  res.json({
    currency: q.currency,
    subtotal: q.subtotal,
    discount: q.discount,
    total: q.total,
    applied: q.applied, // [{ id, label, amount }]
  });
});

// Lista de promos por combo (para mostrarlas en la web).
// Los importes los calcula el MISMO motor que el checkout, así lo que se
// muestra en la landing nunca difiere de lo que se termina cobrando.
// Se conservan los campos originales de la regla (allOf, percentOff, label)
// porque el carrito los usa para sugerir "te falta 1 producto".
app.get('/api/discounts', (req, res) => {
  const rules = discounts
    .getRules()
    .map((rule) => {
      const items = (rule.allOf || []).map((id) => store.getProduct(id));
      if (!items.length || items.some((p) => !p)) return null; // regla con un id inexistente
      const cart = items.map((p) => ({ id: p.id, price: p.price, qty: 1 }));
      const subtotal = cart.reduce((s, it) => s + it.price, 0);
      const { discount } = discounts.computeDiscount(cart);
      return {
        ...rule,
        products: items.map((p) => ({ id: p.id, name: p.name, price: p.price })),
        subtotal,
        discount,
        total: subtotal - discount,
      };
    })
    .filter(Boolean);
  res.json(rules);
});

// Crea la orden y devuelve la URL de checkout (Mercado Pago o demo)
app.post('/api/checkout', limitCheckout, async (req, res) => {
  try {
    // Sitio público sin Mercado Pago = el pago no se puede verificar contra
    // nadie. Antes que regalar el material, no se vende (ver src/payments.js).
    if (payments.DEMO_IN_PRODUCTION) {
      console.error('🚨 Checkout bloqueado: falta MP_ACCESS_TOKEN en un sitio público.');
      return res.status(503).json({
        error: 'Los pagos están temporalmente fuera de servicio. Escribinos y lo resolvemos.',
      });
    }

    const { items, customer, intake } = req.body || {};

    // Errores separados: si el mail está mal, el comprador tiene que saber que es
    // ESE el campo a corregir (y por qué importa).
    const nombre = String(customer?.name || '').trim();
    const email = typeof customer?.email === 'string' ? customer.email.trim() : '';
    if (!nombre) {
      return res.status(400).json({ error: 'Escribí tu nombre.', field: 'name' });
    }
    // El mensaje dice QUÉ está mal (falta el @, hay un carácter que no va, etc.)
    // en vez de un "email inválido" que no le sirve a nadie para corregirlo.
    const problemaEmail = emailProblem(email);
    if (problemaEmail) {
      return res.status(400).json({ error: problemaEmail, field: 'email' });
    }

    // Resolvemos precios + descuentos desde el servidor (no confiamos en el cliente)
    const q = resolveCart(items);
    if (q.error) return res.status(400).json({ error: q.error });

    // La cuenta de Mercado Pago cobra en UNA moneda (la de su país). Si el
    // carrito viniera en otra, MP la rechazaría o —peor— la interpretaría como
    // pesos y cobraría de menos. Antes que cobrar mal, no se cobra.
    if (payments.HAS_MP && !payments.supportsCurrency(q.currency)) {
      console.error(
        `🚨 Checkout bloqueado: carrito en ${q.currency} y la cuenta de Mercado Pago cobra en ${payments.CURRENCY}.`
      );
      return res.status(503).json({
        error: 'No podemos cobrar estos productos en este momento. Escribinos y lo resolvemos.',
      });
    }

    const order = {
      id: genId(),
      items: q.resolved,
      subtotal: q.subtotal,
      discount: q.discount,
      discounts: q.applied, // [{ id, label, amount }]
      total: q.total,
      currency: q.currency,
      customer: { name: nombre.slice(0, 120), email },
      intake: cleanIntake(intake), // respuestas del formulario, acotadas
      status: 'pending', // pending | paid | delivered | refunded
      shared: false,
      createdAt: Date.now(),
      paidAt: null,
      // Se completa cuando Mercado Pago informa el pago (ver recordPayment).
      payment: null,
    };
    // La orden se guarda ANTES de crear la preferencia: si Mercado Pago tarda o
    // falla, queda una orden pendiente sin usar (inofensivo). Al revés sería
    // peor: existiría un link de pago sin ninguna orden a la que imputarlo.
    await store.saveOrder(order);

    const { url: checkoutUrl, preferenceId } = await payments.createCheckout(order);

    // Guardamos la preferencia para poder rastrear la venta desde el panel de MP.
    if (preferenceId) {
      order.preferenceId = preferenceId;
      await store.saveOrder(order);
    }

    res.json({ orderId: order.id, checkoutUrl });
  } catch (err) {
    // La base de órdenes caída no es un bug del checkout: es infraestructura, y
    // el comprador puede reintentar. Se separa del 500 genérico porque el
    // mensaje que ve y lo que hay que ir a arreglar son distintos.
    //
    // Reintentar es seguro: la orden se guarda ANTES de crear la preferencia,
    // así que si falló acá no hay nada cobrado ni ningún link de pago suelto.
    if (err?.code === 'STORE_UNAVAILABLE') {
      console.error(`🚨 Checkout caído — ${err.message}`);
      return res.status(503).json({
        error: 'No pudimos registrar tu pedido. Probá de nuevo en unos minutos.',
      });
    }
    console.error('Error en checkout:', err);
    res.status(500).json({ error: 'No se pudo iniciar el pago.' });
  }
});

// Estado de una orden (para las páginas de resultado)
app.get('/api/orders/:id', async (req, res) => {
  const order = await store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Orden no encontrada.' });
  res.json({
    id: order.id,
    status: order.status,
    total: order.total,
    items: order.items,
    customer: { name: order.customer.name },
    // Estado del pago en Mercado Pago, para que la página de resultado pueda
    // decir "en revisión" o "rechazado" en vez de un mensaje genérico.
    // No se expone nada sensible: es el mismo estado que el comprador ve en MP.
    paymentStatus: order.payment?.status || null,
  });
});

// Guarda en la orden lo que Mercado Pago dice del pago. Sirve para conciliar
// una venta con el panel de MP y para que la página de resultado sepa si el pago
// está en revisión, rechazado o devuelto. No decide nada: solo registra.
async function recordPayment(order, info) {
  order.payment = {
    id: info.id,
    status: info.status, // approved | pending | in_process | rejected | refunded | charged_back...
    statusDetail: info.statusDetail,
    method: info.method, // visa, rapipago, account_money...
    type: info.type, // credit_card, ticket, account_money...
    amount: info.transactionAmount,
    refunded: info.refundedAmount,
    currency: info.currency,
    liveMode: info.liveMode,
    updatedAt: Date.now(),
  };
  await store.saveOrder(order);
}

// ---------------------------------------------------------------------------
//  Procesamiento de un pago (camino único)
// ---------------------------------------------------------------------------
//  Toda la lógica de "qué hago con este pago" vive acá. La usan los DOS caminos
//  por los que nos enteramos de un pago —la página de éxito y el webhook de
//  Mercado Pago— justamente para que no puedan divergir: si mañana se agrega un
//  control, entra en los dos lugares a la vez.
//
//  Devuelve { estado, motivo }:
//    estado = 'paid'      -> se cobró y se entregó (o se está entregando)
//           | 'pending'   -> falta que se acredite (efectivo, revisión de MP)
//           | 'rejected'  -> no se cobró
//           | 'reversed'  -> devolución o contracargo: se dio de baja el acceso
//           | 'mismatch'  -> el pago NO se corresponde con la orden (sospechoso)
//           | 'ignored'   -> ya estaba resuelta, o no hay nada que hacer
//
//  Puede tirar excepción si no se pudo consultar a Mercado Pago o guardar la
//  orden: quien la llama decide si reintentar (el webhook) o avisar (la página).
async function processPayment(order, info) {
  // El pago tiene que apuntar a ESTA orden antes de tocar nada de ella.
  if (String(info.externalReference || '') !== String(order.id)) {
    console.error(
      `🚨 Orden ${order.id}: el pago ${info.id} referencia "${info.externalReference}". Se ignora.`
    );
    return { estado: 'mismatch', motivo: 'el pago es de otra orden' };
  }

  // Qué pago quedó registrado como el que pagó esta orden. Se lee ANTES de
  // registrar el nuevo, porque más abajo hace falta para saber si esta
  // notificación habla del pago de verdad o de otro.
  const pagoRegistrado = order.payment?.id || null;
  // ¿Este pago alcanza para cubrir la orden? Un pago por menos del total no es
  // "el pago de esta orden", aunque lleve su referencia.
  const cubreLaOrden = Number(info.transactionAmount) >= Number(order.total) - 0.5;
  const esElPagoDeLaOrden = pagoRegistrado
    ? String(pagoRegistrado) === String(info.id)
    : cubreLaOrden;

  // El registro del pago solo se sobreescribe con algo que sea creíble: el mismo
  // pago, uno que cubra la orden, o el primero que aparezca. Sin esto, una
  // notificación de un pago chico con la referencia de esta orden borraría los
  // datos del pago real y dejaría la venta sin rastro para conciliar.
  if (esElPagoDeLaOrden || !pagoRegistrado || cubreLaOrden) {
    await recordPayment(order, info);
  }

  const kind = payments.classifyPayment(info);

  if (kind === 'reversed') {
    // Una devolución da de baja el acceso, así que hay que estar seguros de que
    // se está devolviendo EL pago de esta orden. Si no, cualquiera que le mande
    // un pago chico a la cuenta con la referencia de una orden ajena y después
    // pida el reembolso le cortaría el material a un comprador legítimo.
    if (!esElPagoDeLaOrden) {
      console.error(
        `🚨 Orden ${order.id}: se ignora la devolución del pago ${info.id} ` +
          `(${info.transactionAmount} ${info.currency}) porque no es el pago de esta orden ` +
          `(registrado: ${pagoRegistrado || 'ninguno'}, total: ${order.total} ${order.currency}).`
      );
      return { estado: 'ignored', motivo: 'la devolución no corresponde al pago de esta orden' };
    }
    await markOrderReversed(order, info);
    return { estado: 'reversed', motivo: info.status };
  }

  if (kind === 'approved') {
    // Ya resuelta: no se entrega de nuevo (claimPaid igual lo garantiza, pero
    // así evitamos el trabajo y el log).
    if (order.status !== 'pending') return { estado: 'ignored', motivo: 'ya estaba procesada' };

    // Monto, moneda y que el pago sea real: el control que separa "cobramos"
    // de "regalamos" (ver payments.checkPaymentMatchesOrder).
    const match = payments.checkPaymentMatchesOrder(info, order);
    if (!match.ok) {
      console.error(`🚨 Orden ${order.id}: pago ${info.id} rechazado — ${match.reason}.`);
      return { estado: 'mismatch', motivo: match.reason };
    }

    await markOrderPaid(order);
    return { estado: 'paid', motivo: 'pago aprobado' };
  }

  if (kind === 'rejected') {
    console.log(`↩️  Orden ${order.id}: pago ${info.id} ${info.status} (${info.statusDetail}).`);
    return { estado: 'rejected', motivo: info.statusDetail || info.status };
  }

  // pending / in_process / estado desconocido => todavía no se entrega nada.
  console.log(
    `⏳ Orden ${order.id}: pago ${info.id} en estado "${info.status}" — se espera la acreditación.`
  );
  return { estado: 'pending', motivo: info.status };
}

// Confirma el pago (lo llama la página de éxito).
// - En demo: aprueba directo.
// - Con MP: verifica el pago real con el payment_id que devuelve Mercado Pago.
//
// Este camino existe para que el comprador vea el resultado al instante, sin
// esperar el webhook. No es una vía alternativa de aprobación: el pago se
// consulta contra la API de Mercado Pago exactamente igual que en el webhook.
app.post('/api/orders/:id/confirm', limitConfirm, async (req, res) => {
  const order = await store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Orden no encontrada.' });

  if (order.status !== 'pending') {
    // Ya estaba resuelta (idempotente): puede haber llegado antes el webhook.
    return res.json({ status: order.status, paymentStatus: order.payment?.status || null });
  }

  const { payment_id } = req.body || {};

  if (payments.HAS_MP) {
    // Producción: SOLO se confirma con un pago REAL, aprobado y de ESTA orden.
    // (el flag "demo" se ignora por completo cuando Mercado Pago está configurado)
    if (!payment_id) return res.json({ status: order.status, paymentStatus: null });

    // Los IDs de pago de MP son numéricos. Filtrarlo acá evita mandarle basura
    // a la API por cada URL que alguien invente.
    if (!/^\d{5,24}$/.test(String(payment_id))) {
      return res.status(400).json({ error: 'El identificador del pago no es válido.' });
    }

    let info;
    try {
      info = await payments.getPaymentStatus(payment_id);
    } catch (e) {
      console.error('Error verificando pago:', e?.message || e);
      return res.status(502).json({ error: 'No se pudo verificar el pago.' });
    }

    // El pago no existe en Mercado Pago: no hay nada que confirmar.
    if (!info) return res.json({ status: order.status, paymentStatus: null });

    let resultado;
    try {
      resultado = await processPayment(order, info);
    } catch (e) {
      console.error(`Error procesando el pago de la orden ${order.id}:`, e?.message || e);
      return res.status(502).json({ error: 'No se pudo verificar el pago.' });
    }

    if (resultado.estado === 'mismatch') {
      return res.status(400).json({ error: 'El pago no corresponde a esta orden.' });
    }
    // order.status quedó actualizado por markOrderPaid / markOrderReversed.
    return res.json({ status: order.status, paymentStatus: info.status });
  }

  if (payments.DEMO_IN_PRODUCTION) {
    // El modo demo aprueba CUALQUIER orden sin cobrar. En un sitio público eso
    // es entregar el material gratis a quien lo pida: acá se corta.
    console.error(`🚨 Confirmación bloqueada (orden ${order.id}): falta MP_ACCESS_TOKEN.`);
    return res.status(503).json({ error: 'No se puede confirmar el pago en este momento.' });
  }

  // Sin Mercado Pago configurado y en local => modo demo (pago simulado).
  await markOrderPaid(order);
  res.json({ status: order.status, paymentStatus: 'demo' });
});

// ---------------------------------------------------------------------------
//  Webhook de Mercado Pago
// ---------------------------------------------------------------------------
//  Es el camino que NO depende del navegador del comprador: funciona igual si
//  cierra la pestaña, si paga en efectivo dos días después, o si le devuelven la
//  plata un mes más tarde.
//
//  Sobre los códigos de respuesta (importa):
//   - 200 => "listo, no me lo mandes más". Se usa para todo lo definitivo,
//     incluida una notificación que descartamos (no le damos pistas a quien
//     pruebe suerte).
//   - 5xx => "no pude, reintentá". Solo para fallas TEMPORALES (la API de MP no
//     responde, Redis caído). Sin esto, una caída de 30 segundos se traduce en
//     un pago cobrado y un material sin entregar.
app.post('/webhooks/mercadopago', limitWebhook, async (req, res) => {
  // Mercado Pago avisa en varios formatos según la configuración de la cuenta;
  // parseNotification los reduce a uno (ver src/payments.js).
  const notif = payments.parseNotification({ body: req.body, query: req.query });

  // Solo seguimos si la notificación viene firmada por Mercado Pago.
  // El HMAC se calcula sobre el data.id de la QUERY STRING, que es lo que MP
  // firma; si no viene, se usa el del cuerpo.
  // (Si MP_WEBHOOK_SECRET no está cargada no se puede validar y se deja pasar:
  // el pago se verifica igual contra la API más abajo.)
  const check = payments.verifyWebhookSignature({
    signature: req.get('x-signature'),
    requestId: req.get('x-request-id'),
    dataId: req.query['data.id'] || notif.id,
  });
  if (!check.ok) {
    console.warn(`⚠️  Webhook de MP descartado: ${check.reason}.`);
    return res.sendStatus(200); // 200 igual: no le damos pistas a quien pruebe
  }

  // Notificaciones que no son de un pago (suscripciones, envíos, tests del panel).
  if (notif.kind === 'other' || !notif.id) {
    return res.sendStatus(200);
  }

  try {
    // Una "merchant order" agrupa los pagos de una preferencia: se resuelven a
    // IDs de pago y se procesan igual que cualquier otro.
    const paymentIds =
      notif.kind === 'merchant_order'
        ? await payments.getMerchantOrderPaymentIds(notif.id)
        : [notif.id];

    for (const paymentId of paymentIds) {
      const info = await payments.getPaymentStatus(paymentId);
      if (!info) {
        console.warn(`⚠️  Webhook: el pago ${paymentId} no existe en Mercado Pago.`);
        continue;
      }
      if (!info.externalReference) {
        console.warn(`⚠️  Webhook: el pago ${paymentId} no tiene external_reference.`);
        continue;
      }
      const order = await store.getOrder(info.externalReference);
      if (!order) {
        console.warn(`⚠️  Webhook: no existe la orden ${info.externalReference} (pago ${paymentId}).`);
        continue;
      }
      await processPayment(order, info);
    }
  } catch (err) {
    if (payments.isTransientError(err)) {
      // Le pedimos a Mercado Pago que reintente: el pago está cobrado y todavía
      // no entregamos nada.
      console.error(`⏳ Webhook de MP: falla temporal, se pide reintento — ${err?.message || err}`);
      return res.sendStatus(503);
    }
    console.error('Error definitivo en webhook MP:', err?.message || err);
  }

  res.sendStatus(200);
});

// Mercado Pago puede probar la URL del webhook con un GET (y los escaneos de
// Internet también). Contestamos 200 sin hacer nada, para no ensuciar los logs
// con 404 ni dar información.
app.get('/webhooks/mercadopago', (req, res) => res.sendStatus(200));

// Marca la orden como pagada, entrega el material, avisa a la trainer y le
// confirma al cliente. Nunca tira excepción: si algo de la entrega falla, el
// pago queda confirmado igual y la trainer recibe el aviso para resolverlo.
async function markOrderPaid(order) {
  // La confirmación puede llegar por dos caminos a la vez (página de éxito +
  // webhook de MP). Solo el primero sigue; el otro corta acá.
  if (!(await store.claimPaid(order.id))) {
    console.log(`↩️  Orden ${order.id} ya estaba siendo procesada — no se duplica.`);
    return;
  }

  order.status = 'paid';
  order.paidAt = Date.now();
  await store.saveOrder(order);

  // --- Entrega automática: acceso de lectura a las carpetas de Drive ---
  // deliverOrder captura sus propios errores, pero envolvemos igual: acá no
  // puede romperse nada, ya cobramos.
  let deliveries;
  try {
    deliveries = await delivery.deliverOrder(order);
  } catch (e) {
    console.error('Error inesperado entregando el material:', e);
    deliveries = order.items.map((it) => ({
      id: it.id,
      name: it.name,
      qty: it.qty,
      access: delivery.folderIdFor(it.id) ? 'pending' : 'manual',
      url: '',
      error: e.message,
    }));
  }

  // Queda registrado en la orden qué se entregó y qué no (sin guardar links).
  order.delivery = deliveries.map((d) => ({ id: d.id, access: d.access, error: d.error || null }));
  order.deliveredAt = Date.now();
  order.status = deliveries.some((d) => d.access === 'granted') ? 'delivered' : 'paid';
  await store.saveOrder(order);

  const cur = order.currency || 'ARS';
  const hasDiscount = Number(order.discount) > 0;
  const detalle = order.items
    .map((it) => `- ${it.name} x${it.qty} (${fmtMoney(it.price * it.qty, cur)})`)
    .join('\n');
  // Líneas de subtotal/descuento para los mails de texto (solo si hubo descuento)
  const promoText = hasDiscount
    ? `\nSubtotal: ${fmtMoney(order.subtotal, cur)}\n` +
      (order.discounts || [])
        .map((d) => `Descuento (${d.label}): -${fmtMoney(d.amount, cur)}`)
        .join('\n') +
      '\n'
    : '';
  // Cada ítem del mail lleva su estado de entrega. `deliveries` respeta el
  // orden de order.items, así que se emparejan por índice.
  const emailItems = order.items.map((it, i) => ({
    name: it.name,
    qty: it.qty,
    lineText: fmtMoney(it.price * it.qty, cur),
    access: deliveries[i]?.access || 'manual', // granted | pending | manual
    url: deliveries[i]?.url || '',
    error: deliveries[i]?.error || null,
  }));

  const grantedItems = emailItems.filter((it) => it.access === 'granted');
  const pendingItems = emailItems.filter((it) => it.access === 'pending');
  const manualItems = emailItems.filter((it) => it.access === 'manual');

  const autoText = grantedItems.length
    ? `📦 Ya tenés acceso a tu material:\n` +
      grantedItems.map((it) => `- ${it.name}: ${it.url}`).join('\n') +
      `\n\nEl acceso es exclusivo para ${order.customer.email}: entrá con esa cuenta de Google.\n` +
      `Guardá este correo para volver cuando quieras.\n\n`
    : '';
  const pendingText = pendingItems.length
    ? `⏳ Estamos preparando tu acceso a ${pendingItems.map((it) => it.name).join(', ')}. ` +
      `Te lo enviamos a este mismo mail dentro de las próximas 24 horas.\n\n`
    : '';
  const manualText = manualItems.length
    ? `💬 Para ${manualItems.map((it) => it.name).join(', ')} te vamos a contactar ` +
      `dentro de las próximas 48 horas para armar tu plan a medida.\n\n`
    : '';
  const links = buildDeliverySummary(emailItems, order.customer.email);

  // Si la orden tiene respuestas de formulario, las emparejamos con sus preguntas.
  let intakePairs = [];
  if (order.intake) {
    for (const it of order.items) {
      const p = store.getProduct(it.id);
      if (p?.form) {
        intakePairs = p.form.map((f) => ({ label: f.label, value: order.intake[f.name] || '-' }));
        break;
      }
    }
  }
  const intakeText = intakePairs.length
    ? '\n\nRespuestas del formulario:\n' + intakePairs.map((q) => `• ${q.label}: ${q.value}`).join('\n')
    : '';

  // 1) Confirmación al CLIENTE: pago aprobado, recibe el producto dentro de 48hs.
  await sendMail({
    to: order.customer.email,
    subject: `✅ ¡Pago aprobado! — ${BRAND}`,
    html: emails.paymentConfirmedEmailHtml({
      brand: BRAND,
      name: order.customer.name,
      items: emailItems,
      subtotalText: hasDiscount ? fmtMoney(order.subtotal, cur) : null,
      discounts: hasDiscount
        ? (order.discounts || []).map((d) => ({ label: d.label, amountText: '-' + fmtMoney(d.amount, cur) }))
        : [],
      totalText: fmtMoney(order.total, cur),
      accountEmail: order.customer.email,
    }),
    text:
      `¡Hola ${order.customer.name}!\n\n` +
      `Tu pago fue aprobado con éxito. 🎉\n\n` +
      autoText +
      pendingText +
      manualText +
      `Detalle de tu compra:\n${detalle}\n${promoText}\nTotal: ${fmtMoney(order.total, cur)}\n\n` +
      `¡Gracias por tu compra!`,
  }).catch((e) => console.error('No se pudo enviar mail al cliente:', e));

  // Estimación de lo que le queda después de la comisión de Mercado Pago.
  // Solo aparece si MP_FEE_PERCENT está configurada con la comisión real de la
  // cuenta: sin eso no se muestra nada, para no darle un número inventado sobre
  // el que después decida precios (ver src/fees.js).
  const feeInfo = fees.estimate(order.total);
  // Redondeado a pesos enteros: es una estimación, los centavos solo ensucian.
  const netText = feeInfo ? fmtMoney(Math.round(feeInfo.neto), cur) : null;
  const netNote = feeInfo
    ? `Estimado: se descuenta la comisión de Mercado Pago (${feeInfo.percent}% + IVA = ` +
      `${feeInfo.effectivePercent.toFixed(2)}%, ${fmtMoney(Math.round(feeInfo.costo), cur)}). ` +
      `No incluye retenciones ni impuestos.`
    : null;

  // 2) Aviso a la PERSONAL TRAINER: datos del comprador (+ formulario si corresponde).
  await sendMail({
    to: TRAINER_EMAIL,
    subject: `💰 Nueva venta: ${order.customer.name} — ${fmtMoney(order.total, cur)}`,
    html: emails.trainerEmailHtml({
      brand: BRAND,
      customerName: order.customer.name,
      customerEmail: order.customer.email,
      items: emailItems,
      subtotalText: hasDiscount ? fmtMoney(order.subtotal, cur) : null,
      discounts: hasDiscount
        ? (order.discounts || []).map((d) => ({ label: d.label, amountText: '-' + fmtMoney(d.amount, cur) }))
        : [],
      totalText: fmtMoney(order.total, cur),
      netText,
      netNote,
      intake: intakePairs,
    }),
    text:
      `¡Tenés una nueva venta! 🎉\n\n` +
      (pendingItems.length
        ? `⚠️ ACCIÓN REQUERIDA: NO se pudo dar el acceso automático a ` +
          `${pendingItems.map((it) => it.name).join(', ')}. ` +
          `Compartí esas carpetas desde Drive con ${order.customer.email}.\n\n`
        : '') +
      (manualItems.length
        ? `⏰ ACCIÓN REQUERIDA: contactá al cliente dentro de las 48hs para ` +
          `${manualItems.map((it) => it.name).join(', ')}.\n\n`
        : '') +
      (!pendingItems.length && !manualItems.length
        ? `✅ El material ya se le entregó solo. No tenés que hacer nada.\n\n`
        : '') +
      `Cliente: ${order.customer.name}\n` +
      `Email: ${order.customer.email}\n\n` +
      `Productos:\n${detalle}\n${promoText}\n` +
      `Total: ${fmtMoney(order.total, cur)}\n` +
      (netText ? `Te quedan aprox.: ${netText}\n  (${netNote})\n` : '') +
      `\nEstado de la entrega:\n${links}` +
      intakeText,
  }).catch((e) => console.error('No se pudo enviar mail a la trainer:', e));

  console.log(
    `✅ Orden ${order.id} PAGADA — ${grantedItems.length} con acceso, ` +
      `${pendingItems.length} pendiente(s), ${manualItems.length} a coordinar.`
  );
}

// ---------------------------------------------------------------------------
//  Devolución o contracargo
// ---------------------------------------------------------------------------
//  Mercado Pago avisa por webhook cuando un pago se devuelve (`refunded`) o
//  cuando el comprador lo desconoce ante su banco (`charged_back`). En los dos
//  casos la plata dejó de estar, así que el acceso al material tiene que caer.
//
//  No se le manda mail al comprador: una devolución se conversa, y el mail
//  automático suele llegar en el peor momento. La trainer sí se entera, con el
//  detalle de qué accesos se dieron de baja y cuáles quedaron a mano.
//
//  Nunca tira excepción: si Drive falla, la baja queda registrada igual y la
//  trainer recibe el aviso para resolverlo.
async function markOrderReversed(order, payment) {
  const esContracargo = payment.status === 'charged_back';
  const tipo = esContracargo ? 'contracargo' : 'devolución';

  // Mercado Pago puede notificar el mismo contracargo varias veces. Sin esta
  // guarda, la trainer recibiría el mismo aviso cinco veces.
  if (!(await store.claimOnce('reversal', order.id))) {
    console.log(`↩️  Orden ${order.id}: la ${tipo} ya estaba procesada — no se repite.`);
    return;
  }

  console.error(
    `🚨 Orden ${order.id}: ${tipo.toUpperCase()} del pago ${payment.id} ` +
      `(${fmtMoney(payment.transactionAmount, payment.currency)}). Se da de baja el acceso.`
  );

  const estabaEntregada = order.status === 'delivered' || order.status === 'paid';
  order.status = 'refunded';
  order.reversal = {
    kind: esContracargo ? 'chargeback' : 'refund',
    paymentId: payment.id,
    at: Date.now(),
  };
  await store.saveOrder(order);

  // Se le saca el acceso a las carpetas de Drive de esta orden.
  let revocaciones = [];
  try {
    revocaciones = await delivery.revokeOrder(order);
  } catch (e) {
    // revokeOrder ya captura sus errores, pero acá no puede romperse nada.
    console.error('Error inesperado dando de baja los accesos:', e);
  }

  order.reversal.revoked = revocaciones.map((r) => ({
    id: r.id,
    revoked: !!r.revoked,
    error: r.error || null,
  }));
  await store.saveOrder(order);

  const dadosDeBaja = revocaciones.filter((r) => r.revoked);
  const conError = revocaciones.filter((r) => r.error);
  const cur = order.currency || 'ARS';

  const detalle = order.items
    .map((it) => `- ${it.name} x${it.qty} (${fmtMoney(it.price * it.qty, cur)})`)
    .join('\n');

  const texto =
    `Mercado Pago informó una ${tipo.toUpperCase()} de una venta.\n\n` +
    `Orden: ${order.id}\n` +
    `Pago en Mercado Pago: ${payment.id}\n` +
    `Cliente: ${order.customer.name} (${order.customer.email})\n` +
    `Monto: ${fmtMoney(payment.transactionAmount, payment.currency)}\n\n` +
    `Productos:\n${detalle}\n\n` +
    (estabaEntregada
      ? `El material YA se le había entregado. Estado de la baja del acceso:\n` +
        (revocaciones.length
          ? revocaciones
              .map((r) =>
                r.revoked
                  ? `- ✅ ${r.name} — acceso dado de baja`
                  : r.error
                    ? `- ⚠️ ${r.name} — NO se pudo dar de baja: quitá el acceso a mano desde Drive (motivo: ${r.error})`
                    : `- ➖ ${r.name} — sin acceso automático (lo habías coordinado vos)`
              )
              .join('\n')
          : '- (la orden no tenía ítems)') +
        '\n\n'
      : `El material todavía no se había entregado: no hay accesos que dar de baja.\n\n`) +
    (conError.length
      ? `⚠️ ACCIÓN REQUERIDA: revisá en Drive que ${order.customer.email} ya no tenga acceso.\n\n`
      : '') +
    (esContracargo
      ? `ℹ️ En un contracargo, Mercado Pago puede pedirte documentación para defender la venta. ` +
        `Revisá tu panel de Mercado Pago.\n`
      : '');

  await sendMail({
    to: TRAINER_EMAIL,
    subject: `⚠️ ${esContracargo ? 'Contracargo' : 'Devolución'}: ${order.customer.name} — ${fmtMoney(payment.transactionAmount, payment.currency)}`,
    text: texto,
    html: `<pre style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;white-space:pre-wrap;">${texto
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')}</pre>`,
  }).catch((e) => console.error('No se pudo enviar el aviso de devolución:', e));

  console.log(
    `🚫 Orden ${order.id}: ${tipo} procesada — ${dadosDeBaja.length} acceso(s) de baja, ` +
      `${conError.length} con error.`
  );
}

// Resume, para el mail de la trainer, qué se entregó solo, qué falló y qué hay
// que coordinar a mano.
function buildDeliverySummary(items, customerEmail) {
  return items
    .map((it) => {
      if (it.access === 'granted') return `- ✅ ${it.name} — acceso dado automáticamente`;
      if (it.access === 'pending')
        return (
          `- ⚠️ ${it.name} — COMPARTILO VOS desde Drive con ${customerEmail}` +
          (it.error ? ` (motivo: ${it.error})` : '')
        );
      return `- ⏰ ${it.name} — lo coordinás vos (servicio a medida)`;
    })
    .join('\n');
}

// ============================================================
//  DIAGNÓSTICO (privado)
// ============================================================
//  Para qué: después de cargar las credenciales de la clienta, poder responder
//  "¿está bien conectado?" sin adivinar ni mirar logs. Dice qué hay configurado
//  y qué falta, en castellano.
//
//  SEGURIDAD: no devuelve NI UN secreto (solo si están cargados y de qué tipo).
//  Requiere ADMIN_TOKEN; si la variable no está seteada, el endpoint no existe.
//  Ante un token equivocado devuelve 404, igual que si la ruta no existiera: no
//  hay forma de saber desde afuera si el endpoint está habilitado.
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const limitAdmin = limit({ name: 'admin', max: 20, windowSec: 600 });

function adminTokenOk(req) {
  if (!ADMIN_TOKEN) return false;
  const enviado = String(req.get('x-admin-token') || req.query.token || '');
  const a = Buffer.from(enviado, 'utf8');
  const b = Buffer.from(ADMIN_TOKEN, 'utf8');
  // Comparación de tiempo constante (no filtra el token carácter por carácter).
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get('/api/admin/estado', limitAdmin, async (req, res) => {
  if (!adminTokenOk(req)) return res.status(404).json({ error: 'No encontrado.' });

  const mp = payments.configReport();
  const carpetas = Object.keys(delivery.FOLDERS).length;

  // Consulta real a la base, no "¿están las variables?". Una base archivada o
  // borrada pasaba el chequeo viejo y rompía recién en la primera compra.
  const base = await store.ping();

  const mails = process.env.RESEND_API_KEY
    ? 'Resend (real)'
    : process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
      ? 'SMTP (real)'
      : 'demo (se muestran en la consola, NO se envían)';

  const problemas = [...mp.problemas];
  const avisos = [...mp.avisos];
  if (mails.startsWith('demo')) {
    problemas.push('Los mails no se envían de verdad: falta RESEND_API_KEY o los datos de SMTP.');
  }
  if (!store.USE_REDIS && mp.sitioPublico) {
    problemas.push(
      'Las órdenes se guardan en un archivo local: en Vercel se pierden entre requests. Falta Upstash Redis.'
    );
  }
  if (!base.ok) {
    problemas.push(
      `La base de órdenes no responde: ${base.error}. Las compras van a fallar hasta que se resuelva.`
    );
  }
  if (!drive.HAS_DRIVE || !carpetas) {
    avisos.push('Sin entrega automática de material: todo lo entrega la trainer a mano.');
  }

  res.json({
    listoParaVender: problemas.length === 0,
    problemas, // hay que resolverlos antes de vender
    avisos, // funciona, pero conviene resolverlos
    mercadopago: mp,
    ordenes: store.USE_REDIS ? 'Upstash Redis (persistente)' : 'archivo local (data/orders.json)',
    ordenesResponde: base.ok, // ping real, no "¿está la variable?"
    mails,
    drive: {
      credenciales: drive.HAS_DRIVE,
      cuentaDeServicio: drive.serviceAccountEmail,
      productosConCarpeta: carpetas,
    },
    trainerEmail: TRAINER_EMAIL,
    whatsapp: !!WHATSAPP_NUMBER,
  });
});

// ============================================================
//  CRON: mantener viva la base
// ============================================================
//  Upstash ARCHIVA las bases del plan free que pasan mucho tiempo sin recibir
//  requests: el host deja de resolver (ENOTFOUND) y la primera compra falla.
//  La tienda no toca Redis salvo que alguien compre, así que antes de lanzar
//  puede pasar semanas en silencio. Este cron le pega una vez por día.
//
//  Configurado en vercel.json → "crons". Cómo se identifica el llamado:
//   - Con CRON_SECRET cargada, Vercel manda `Authorization: Bearer <secreto>`.
//     Es la forma buena y la única que no se puede imitar desde afuera.
//   - Sin CRON_SECRET, lo único que manda es `user-agent: vercel-cron/1.0`.
//     Se acepta igual porque el endpoint no expone ni modifica nada —hace un
//     ping y contesta ok/no—, así que el peor caso de que alguien lo imite es
//     un ping de más. (No se usa `x-vercel-cron`: la plataforma no lo manda.)
function cronOk(req) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (secret) {
    const auth = String(req.get('authorization') || '');
    const a = Buffer.from(auth, 'utf8');
    const b = Buffer.from(`Bearer ${secret}`, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  if (/^vercel-cron\//i.test(String(req.get('user-agent') || ''))) return true;
  return adminTokenOk(req); // para probarlo a mano
}

app.get('/api/cron/keepalive', async (req, res) => {
  if (!cronOk(req)) {
    // Un 404 mudo hizo que la primera versión de esto pareciera "no configurada"
    // cuando en realidad el cron corría y rebotaba en la puerta. El user-agent
    // no es un secreto y es justo el dato que hace falta para entenderlo.
    console.warn(`⚠️  Keepalive rechazado (user-agent: ${req.get('user-agent') || 'ninguno'}).`);
    return res.status(404).json({ error: 'No encontrado.' });
  }

  const base = await store.ping();
  if (!base.ok) {
    // 500 a propósito: así el cron figura como fallido en el panel de Vercel en
    // vez de pasar desapercibido. Es el aviso de que la base se cayó ANTES de
    // que se entere un comprador.
    console.error(`🚨 Keepalive: la base de órdenes no responde — ${base.error}`);
    return res.status(500).json({ ok: false, backend: base.backend, error: base.error });
  }
  console.log(`✅ Keepalive: ${base.backend} responde.`);
  res.json({ ok: true, backend: base.backend });
});

// ============================================================
//  RUTAS DE PÁGINAS (fallbacks)
// ============================================================
const page = (file) => (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', file));

app.get('/success', page('success.html'));
app.get('/pending', page('pending.html'));
app.get('/failure', page('failure.html'));

// ============================================================
//  ERRORES
// ============================================================
// Sin esto, un body demasiado grande o con JSON roto devuelve la página HTML de
// error de Express, y el fetch del carrito explota al hacer res.json().
// Acá siempre sale JSON, que es lo que el front sabe leer.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Los datos enviados son demasiado grandes.' });
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Los datos enviados no son válidos.' });
  }

  console.error('Error no controlado:', err);
  res.status(500).json({ error: 'Ocurrió un error. Probá de nuevo en un momento.' });
});

// Un producto "solo consulta" sin numero de WhatsApp se queda SIN NINGUN boton:
// no se puede comprar (a proposito) y tampoco consultar (por error). Se avisa al
// arrancar, que es cuando todavia se puede corregir la variable de entorno.
(function avisarConsultaSinWhatsapp() {
  if (WHATSAPP_NUMBER) return;
  const huerfanos = store.getProducts().filter((p) => p.soloConsulta);
  if (!huerfanos.length) return;
  const lista = huerfanos.map((p) => `   - ${p.name}`).join('\n');
  console.warn(
    `\n⚠️  Falta WHATSAPP_NUMBER y estos planes solo se venden por WhatsApp:\n${lista}\n` +
      `   Sin el número quedan en la web sin forma de contactar. Cargá WHATSAPP_NUMBER en las variables de entorno.\n`
  );
})();

// En local/Docker levantamos el servidor. En Vercel (serverless) se importa
// la app como handler y NO se llama a listen().
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀 Web de la Personal Trainer corriendo en ${BASE_URL}\n`);
  });
}

module.exports = app;
