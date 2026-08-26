// ============================================================================
//  Integración con Mercado Pago (Checkout Pro)
// ============================================================================
//  Este módulo es el ÚNICO que habla con Mercado Pago. El resto del servidor no
//  sabe nada de la API de MP: le pide "creá el checkout de esta orden" o
//  "¿este pago es real y es de esta orden?" y recibe una respuesta ya normalizada.
//
//  Sin MP_ACCESS_TOKEN => MODO DEMO (pago simulado, aprobado al instante). El
//  modo demo SOLO sirve en local: en un sitio público se bloquean las compras
//  (ver DEMO_IN_PRODUCTION más abajo).
//
//  REGLA DE ORO: si algo no se puede verificar, no se entrega. Todas las
//  validaciones de este archivo fallan cerrado.
// ============================================================================
const crypto = require('crypto');

// ---------------------------------------------------------------------------
//  Credenciales
// ---------------------------------------------------------------------------
//  El error más común al conectar una cuenta nueva es pegar la Public Key en
//  vez del Access Token: las dos empiezan con "APP_USR-". La Public Key es un
//  UUID (corta); el Access Token es largo y con varios bloques de dígitos.
//  Detectarlo acá evita que el checkout explote recién en la primera venta.
const RAW_TOKEN = (process.env.MP_ACCESS_TOKEN || '').trim();

function classifyToken(token) {
  if (!token) return 'none';
  if (/^TEST-/.test(token)) return 'test';
  if (/^APP_USR-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(token)) return 'public-key';
  if (/^APP_USR-/.test(token)) return token.length >= 50 ? 'production' : 'public-key';
  return 'invalid';
}

const TOKEN_KIND = classifyToken(RAW_TOKEN);
// Solo un token de verdad (test o producción) habilita los pagos reales.
const HAS_MP = TOKEN_KIND === 'test' || TOKEN_KIND === 'production';
const IS_TEST_TOKEN = TOKEN_KIND === 'test';

// Para los logs: nunca se imprime el token completo.
const maskedToken = RAW_TOKEN
  ? `${RAW_TOKEN.slice(0, 8)}…${RAW_TOKEN.slice(-4)} (${RAW_TOKEN.length} car.)`
  : '(vacío)';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

// ¿El sitio es accesible desde afuera? Cualquier deploy de Vercel lo es,
// tenga o no BASE_URL bien cargada.
const IS_PUBLIC_SITE =
  !!process.env.VERCEL ||
  process.env.VERCEL_ENV === 'production' ||
  !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(BASE_URL);

// Mercado Pago exige HTTPS para avisarnos de un pago (notification_url) y para
// devolver al comprador solo (auto_return). En local eso no existe, así que esos
// campos NO se mandan: la preferencia se crea igual y el pago se confirma con la
// página de éxito. Sin esta distinción, MP rechaza la preferencia en local.
const IS_HTTPS = /^https:\/\//i.test(BASE_URL);

// ⚠️ MODO DEMO EN UN SITIO PÚBLICO = TIENDA GRATIS.
// Sin un Access Token válido el pago no se verifica contra nadie: cualquiera crea
// una orden, la "confirma" y se lleva el material. En local es lo que queremos
// (así se prueba el flujo sin cobrar); en un sitio público es un agujero. Cuando
// pasa, se bloquean el checkout y la confirmación — la web sigue en pie, pero no
// se cobra ni se entrega nada hasta que se cargue el token.
const DEMO_IN_PRODUCTION = IS_PUBLIC_SITE && !HAS_MP;

// ---------------------------------------------------------------------------
//  Moneda
// ---------------------------------------------------------------------------
//  Una cuenta de Mercado Pago cobra en la moneda de SU país: una cuenta
//  argentina no puede cobrar una preferencia en USD. Si el carrito viniera en
//  otra moneda, MP la rechazaría o la interpretaría como pesos — o sea, cobrar
//  mucho menos de lo que corresponde. Acá se declara qué moneda soporta la
//  cuenta y el checkout se niega a crear cualquier otra: falla cerrado, no
//  convierte nada por su cuenta.
const CURRENCY = (process.env.MP_CURRENCY || 'ARS').toUpperCase();
const supportsCurrency = (cur) => String(cur || 'ARS').toUpperCase() === CURRENCY;

// ---------------------------------------------------------------------------
//  Opciones de la preferencia
// ---------------------------------------------------------------------------
// Vencimiento de la preferencia: pasado ese plazo el link de pago ya no sirve.
// Para qué: que nadie pueda pagar la semana que viene un link generado con los
// precios de hoy. 0 = sin vencimiento.
const EXPIRY_HOURS = Math.max(0, Number(process.env.MP_PREFERENCE_EXPIRY_HOURS ?? 24) || 0);

// binary_mode=true => el pago sale aprobado o rechazado, nunca "pendiente".
// Por defecto false: así se puede pagar en efectivo (Rapipago/Pago Fácil), que
// entra como pendiente y se acredita después vía webhook.
const BINARY_MODE = /^(1|true|si|sí)$/i.test(String(process.env.MP_BINARY_MODE || ''));

// Lo que el comprador ve en el resumen de su tarjeta. Que se reconozca la marca
// baja los contracargos por "no sé qué es este cobro". MP solo acepta letras,
// números y espacios, hasta 22 caracteres.
const STATEMENT_DESCRIPTOR = (process.env.MP_STATEMENT_DESCRIPTOR || process.env.BRAND_NAME || '')
  .toUpperCase()
  .replace(/[^A-Z0-9 ]/g, '')
  .trim()
  .slice(0, 22);

// Ninguna llamada a MP puede colgar una función serverless.
const MP_TIMEOUT_MS = Number(process.env.MP_TIMEOUT_MS || 8000);

// ---------------------------------------------------------------------------
//  Cliente
// ---------------------------------------------------------------------------
let mpClient = null;
let PreferenceCls = null;
let PaymentCls = null;
let MerchantOrderCls = null;

// Validador de firma oficial del SDK. Se carga siempre (no depende del token):
// así el camino que corre en producción es el mismo que se puede probar en local
// cargando solo MP_WEBHOOK_SECRET. Si la versión instalada del SDK no lo trae,
// queda en null y se usa la verificación propia de más abajo.
let SdkValidator = null;
try {
  SdkValidator = require('mercadopago').WebhookSignatureValidator || null;
} catch {
  /* el SDK no está instalado: se usa la verificación propia */
}

if (HAS_MP) {
  const sdk = require('mercadopago');
  mpClient = new sdk.MercadoPagoConfig({
    accessToken: RAW_TOKEN,
    options: { timeout: MP_TIMEOUT_MS },
  });
  PreferenceCls = sdk.Preference;
  PaymentCls = sdk.Payment;
  MerchantOrderCls = sdk.MerchantOrder || null;

  console.log(
    `💳 Mercado Pago configurado (${IS_TEST_TOKEN ? 'CREDENCIALES DE PRUEBA' : 'producción'}) ` +
      `— token ${maskedToken}, moneda ${CURRENCY}.`
  );
  if (IS_TEST_TOKEN && IS_PUBLIC_SITE) {
    console.warn(
      '\n⚠️  ATENCIÓN: el sitio es público y usa credenciales de PRUEBA (TEST-).\n' +
        '   Los pagos NO son reales: no entra plata a la cuenta. Sirve para probar el flujo,\n' +
        '   pero antes de vender hay que reemplazar MP_ACCESS_TOKEN por el de producción.\n'
    );
  }
  if (!IS_HTTPS) {
    console.warn(
      '⚠️  BASE_URL no es HTTPS: no se le puede pedir a Mercado Pago que avise los pagos ' +
        '(webhook) ni que devuelva al comprador solo. Es lo normal en local; en producción revisá BASE_URL.'
    );
  }
} else if (TOKEN_KIND === 'public-key') {
  console.error(
    '\n🚨 MP_ACCESS_TOKEN parece ser la PUBLIC KEY, no el Access Token.\n' +
      `   Valor recibido: ${maskedToken}\n` +
      '   El Access Token está en: panel de Mercado Pago > Tus integraciones > tu app >\n' +
      '   Credenciales de producción > "Access Token" (el largo, NO la Public Key).\n' +
      '   Las compras quedan BLOQUEADAS hasta corregirlo.\n'
  );
} else if (TOKEN_KIND === 'invalid') {
  console.error(
    '\n🚨 MP_ACCESS_TOKEN no tiene un formato válido (debería empezar con "APP_USR-" o "TEST-").\n' +
      `   Valor recibido: ${maskedToken}\n` +
      '   Las compras quedan BLOQUEADAS hasta corregirlo.\n'
  );
} else if (DEMO_IN_PRODUCTION) {
  console.error(
    '\n🚨 FALTA MP_ACCESS_TOKEN en un sitio público.\n' +
      '   Las compras quedan BLOQUEADAS para que nadie se lleve el material sin pagar.\n' +
      '   Cargá la variable en el panel de Vercel y volvé a deployar.\n'
  );
} else {
  console.log('💳 Mercado Pago NO configurado: MODO DEMO (pago simulado).');
}

// ---------------------------------------------------------------------------
//  Errores temporales vs. definitivos
// ---------------------------------------------------------------------------
//  Importa para el webhook: ante un error TEMPORAL hay que devolverle un error a
//  Mercado Pago para que reintente la notificación; ante uno definitivo (ej: el
//  pago no existe) hay que devolver 200 y no volver a intentar nunca.
//  El SDK tira el cuerpo del error de la API, que trae `status`. Un problema de
//  red o un timeout no traen status: eso también es temporal.
function isTransientError(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  if (!status) return true; // timeout / DNS / red cortada
  return status === 408 || status === 429 || status >= 500;
}

// ---------------------------------------------------------------------------
//  Creación del checkout
// ---------------------------------------------------------------------------

// Arma los ítems que se le mandan a Mercado Pago.
// - Sin descuento: una línea por producto (se ve el detalle en el checkout de MP).
// - Con descuento: consolidamos en UNA línea con el total ya descontado. MP no
//   admite líneas con precio negativo, así que ésta es la forma exacta de que MP
//   cobre el total con descuento (el detalle igual va completo en los mails).
function buildMpItems(order) {
  const currency = order.currency || CURRENCY;
  // Los importes van redondeados a 2 decimales: un float largo (ej: 8333.3333…)
  // hace que MP rechace la preferencia.
  const round2 = (n) => Math.round(Number(n) * 100) / 100;

  if (Number(order.discount) > 0) {
    const titulo = order.items
      .map((it) => (it.qty > 1 ? `${it.name} x${it.qty}` : it.name))
      .join(' + ');
    return [
      {
        id: order.id,
        title: `${titulo} (con descuento)`.slice(0, 250),
        quantity: 1,
        unit_price: round2(order.total),
        currency_id: currency,
      },
    ];
  }
  return order.items.map((it) => ({
    id: it.id,
    title: it.name,
    quantity: it.qty,
    unit_price: round2(it.price),
    currency_id: currency,
  }));
}

// Mercado Pago pide nombre y apellido separados.
function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { name: '', surname: '' };
  return { name: parts[0], surname: parts.slice(1).join(' ') };
}

// Vencimiento en el formato que espera MP (ISO 8601 con offset).
function expirationDate(hours) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString().replace('Z', '-00:00');
}

// Crea el checkout. Devuelve { url, preferenceId }:
// `url` es la dirección a la que hay que redirigir al comprador.
async function createCheckout(order) {
  if (!HAS_MP) {
    // Modo demo: mandamos a una página local que simula el pago aprobado.
    return { url: `${BASE_URL}/success?order=${order.id}&demo=1`, preferenceId: null };
  }

  const { name, surname } = splitName(order.customer.name);

  const body = {
    items: buildMpItems(order),
    payer: { name, surname, email: order.customer.email },
    // El hilo que ata el pago con nuestra orden. Todo lo que llega de MP se
    // valida contra esto antes de entregar nada.
    external_reference: order.id,
    metadata: { order_id: order.id, brand: process.env.BRAND_NAME || '' },
    back_urls: {
      success: `${BASE_URL}/success?order=${order.id}`,
      pending: `${BASE_URL}/pending?order=${order.id}`,
      failure: `${BASE_URL}/failure?order=${order.id}`,
    },
    binary_mode: BINARY_MODE,
  };

  // Solo con HTTPS: MP valida estas dos URLs y rechaza la preferencia si no lo son.
  if (IS_HTTPS) {
    body.notification_url = `${BASE_URL}/webhooks/mercadopago`;
    body.auto_return = 'approved';
  }
  if (EXPIRY_HOURS > 0) {
    body.expires = true;
    body.expiration_date_to = expirationDate(EXPIRY_HOURS);
  }
  if (STATEMENT_DESCRIPTOR) body.statement_descriptor = STATEMENT_DESCRIPTOR;

  const preference = new PreferenceCls(mpClient);
  const result = await preference.create({
    body,
    // Si la request se reintenta (red inestable, timeout), MP devuelve LA MISMA
    // preferencia en vez de crear otra. Una orden = un link de pago.
    requestOptions: { idempotencyKey: `pref-${order.id}` },
  });

  if (!result?.init_point) {
    throw new Error('Mercado Pago no devolvió el link de pago (init_point).');
  }

  // sandbox_init_point es el checkout de prueba: con credenciales TEST es el
  // único que funciona de verdad.
  const url =
    IS_TEST_TOKEN && result.sandbox_init_point ? result.sandbox_init_point : result.init_point;
  return { url, preferenceId: result.id ? String(result.id) : null };
}

// ---------------------------------------------------------------------------
//  Consulta de pagos
// ---------------------------------------------------------------------------

// Normaliza la respuesta de MP a los campos que usa el servidor. Así el resto
// del código no depende de la forma exacta de la API.
function normalizePayment(info) {
  const amount = Number(info?.transaction_amount ?? 0);
  const refunded = Number(info?.transaction_amount_refunded ?? 0);
  return {
    id: info?.id != null ? String(info.id) : null,
    // approved | pending | in_process | rejected | refunded | charged_back | cancelled
    status: info?.status || 'unknown',
    statusDetail: info?.status_detail || null,
    externalReference: info?.external_reference || null,
    transactionAmount: amount,
    refundedAmount: Number.isFinite(refunded) ? refunded : 0,
    currency: info?.currency_id || CURRENCY,
    method: info?.payment_method_id || null, // visa, rapipago, account_money...
    type: info?.payment_type_id || null, // credit_card, ticket, account_money...
    // false = pago hecho con credenciales de prueba. No es plata real.
    liveMode: info?.live_mode === true,
    approvedAt: info?.date_approved || null,
    payerEmail: info?.payer?.email || null,
  };
}

// Consulta el estado de un pago en Mercado Pago por su ID.
// Devuelve null si el pago no existe (definitivo); tira excepción si no se pudo
// consultar (temporal: hay que reintentar).
async function getPaymentStatus(paymentId) {
  if (!HAS_MP) return null;
  try {
    const payment = new PaymentCls(mpClient);
    const info = await payment.get({ id: String(paymentId) });
    return normalizePayment(info);
  } catch (err) {
    if (Number(err?.status) === 404) return null; // no existe: no hay nada que reintentar
    throw err;
  }
}

// Una "merchant order" agrupa los pagos de una preferencia. Según cómo esté
// configurada la cuenta, MP puede avisar por este camino en vez de por
// "payment". Devolvemos los IDs de pago para procesarlos igual que siempre.
async function getMerchantOrderPaymentIds(merchantOrderId) {
  if (!HAS_MP || !MerchantOrderCls) return [];
  try {
    const client = new MerchantOrderCls(mpClient);
    const mo = await client.get({ merchantOrderId: String(merchantOrderId) });
    return (mo?.payments || []).map((p) => String(p.id)).filter(Boolean);
  } catch (err) {
    if (Number(err?.status) === 404) return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
//  Clasificación del pago
// ---------------------------------------------------------------------------
//  Traduce los estados de MP a las cinco cosas que el negocio necesita saber.
//    'approved'  -> cobrado: se entrega
//    'pending'   -> falta acreditar (efectivo, revisión): no se entrega todavía
//    'rejected'  -> no se cobró: no se entrega
//    'reversed'  -> se devolvió la plata o hubo contracargo: hay que dar de baja
//    'unknown'   -> estado nuevo/desconocido: no se entrega (falla cerrado)
function classifyPayment(p) {
  const st = String(p?.status || '').toLowerCase();

  // Devolución total o contracargo: la plata ya no está.
  if (st === 'refunded' || st === 'charged_back') return 'reversed';
  if (st === 'approved') {
    // Una devolución parcial deja el pago en "approved" con monto devuelto.
    // Si se devolvió todo (o casi), para nosotros es una reversión.
    const refunded = Number(p.refundedAmount || 0);
    if (refunded > 0 && refunded >= Number(p.transactionAmount) - 0.5) return 'reversed';
    return 'approved';
  }
  if (st === 'pending' || st === 'in_process' || st === 'in_mediation' || st === 'authorized') {
    return 'pending';
  }
  if (st === 'rejected' || st === 'cancelled') return 'rejected';
  return 'unknown';
}

// ---------------------------------------------------------------------------
//  ¿Este pago es de esta orden y alcanza para cubrirla?
// ---------------------------------------------------------------------------
//  ESTE es el control que separa "cobramos" de "regalamos". Lo usan los DOS
//  caminos por los que se puede confirmar un pago (la página de éxito y el
//  webhook), a propósito: si estuviera duplicado, un cambio en uno dejaría el
//  otro flojo.
//  Devuelve { ok, reason } — reason es para el log, no para el cliente.
function checkPaymentMatchesOrder(payment, order) {
  if (!payment || !order) return { ok: false, reason: 'faltan datos del pago o de la orden' };

  // 1) El pago tiene que apuntar EXACTAMENTE a esta orden.
  if (String(payment.externalReference || '') !== String(order.id)) {
    return {
      ok: false,
      reason: `el pago referencia la orden "${payment.externalReference}" y no "${order.id}"`,
    };
  }

  // 2) Misma moneda. Sin esto, "5000" pagados en una moneda débil alcanzarían
  //    para una orden de 5000 en otra.
  const payCur = String(payment.currency || CURRENCY).toUpperCase();
  const orderCur = String(order.currency || 'ARS').toUpperCase();
  if (payCur !== orderCur) {
    return { ok: false, reason: `moneda distinta (pagado en ${payCur}, orden en ${orderCur})` };
  }

  // 3) El monto abonado no puede ser menor al total (medio peso de tolerancia
  //    por el redondeo de MP). Si hubo devolución parcial, se descuenta.
  const pagado = Number(payment.transactionAmount) - Number(payment.refundedAmount || 0);
  if (!(pagado >= Number(order.total) - 0.5)) {
    return { ok: false, reason: `monto insuficiente (pagado ${pagado}, esperado ${order.total})` };
  }

  // 4) Un pago de prueba no entrega material en producción. Si la cuenta usa
  //    credenciales de producción, el pago TIENE que ser real.
  if (!IS_TEST_TOKEN && payment.liveMode === false) {
    return {
      ok: false,
      reason: 'el pago no es real (live_mode=false) y la cuenta es de producción',
    };
  }

  return { ok: true, reason: 'el pago coincide con la orden' };
}

// ---------------------------------------------------------------------------
//  Normalización de la notificación (webhook)
// ---------------------------------------------------------------------------
//  Mercado Pago avisa en varios formatos según cómo esté configurada la cuenta:
//    a) Webhooks nuevos:  body { type: 'payment', data: { id } }
//    b) Query string:     ?type=payment&data.id=123
//    c) IPN legacy:       ?topic=payment&id=123   /   ?topic=merchant_order&id=456
//  Los tres significan lo mismo. Acá se reducen a { kind, id }.
function parseNotification({ body, query }) {
  const b = body || {};
  const q = query || {};

  const rawKind = String(
    b.type ||
      b.topic ||
      q.type ||
      q.topic ||
      (b.action ? String(b.action).split('.')[0] : '') ||
      ''
  ).toLowerCase();

  const rawId = b?.data?.id ?? q['data.id'] ?? b.id ?? q.id ?? null;
  const id = rawId != null && String(rawId).trim() ? String(rawId).trim() : null;

  let kind = 'other';
  if (rawKind === 'payment') kind = 'payment';
  else if (rawKind === 'merchant_order') kind = 'merchant_order';

  return { kind, id, rawKind };
}

// ---------------------------------------------------------------------------
//  Firma del webhook
// ---------------------------------------------------------------------------
//  Mercado Pago firma cada notificación con una clave secreta que se saca del
//  panel (Tus integraciones > la app > Webhooks > Clave secreta) y se carga en
//  MP_WEBHOOK_SECRET.
//
//  Manda dos headers:
//    x-signature:  ts=1704908010,v1=<hmac-sha256 en hex>
//    x-request-id: <id de la request>
//  y el HMAC se calcula sobre:  id:<data.id>;request-id:<x-request-id>;ts:<ts>;
//
//  Sin la clave configurada NO se puede validar. En ese caso se deja pasar
//  (avisando una vez): falsificar un cobro igual no sirve, porque el pago se
//  vuelve a consultar contra la API de MP antes de entregar nada. Configurarla
//  agrega la capa que falta: que nadie más pueda ni hacer ruido en el webhook.
const WEBHOOK_SECRET = (process.env.MP_WEBHOOK_SECRET || '').trim();
const HAS_WEBHOOK_SECRET = !!WEBHOOK_SECRET;

//  Antigüedad máxima de la firma, en segundos.
//  ⚠️ OJO con bajar este número: cuando nuestro servidor falla, Mercado Pago
//  REINTENTA la notificación durante horas, y el reintento puede conservar el
//  `ts` original. Con una ventana corta esos reintentos se descartarían y el
//  cliente se quedaría sin su material por un pago que SÍ cobramos.
//  Reprocesar una notificación repetida no hace daño: el pago se re-consulta
//  contra la API y la entrega es idempotente (ver store.claimPaid).
//  0 = no verificar la antigüedad.
const TOLERANCE_SEC = Math.max(0, Number(process.env.MP_WEBHOOK_TOLERANCE_SEC ?? 86400) || 0);

let warnedNoSecret = false;

// Compara sin filtrar información por el tiempo que tarda.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Saca el `ts` del header, sin validar nada más.
function readTimestamp(signature) {
  for (const chunk of String(signature || '').split(',')) {
    const idx = chunk.indexOf('=');
    if (idx === -1) continue;
    if (chunk.slice(0, idx).trim().toLowerCase() === 'ts') return chunk.slice(idx + 1).trim();
  }
  return null;
}

// Control de antigüedad de la firma.
//
// ⚠️ Esto lo hacemos NOSOTROS y no con el `toleranceSeconds` del SDK a propósito:
// el SDK interpreta el `ts` como milisegundos, pero Mercado Pago lo manda en
// SEGUNDOS. Pasándole esa opción, el desvío calculado da ~50 años y rechazaría
// TODAS las notificaciones legítimas. Acá se soportan las dos escalas.
function checkTimestampAge(signature) {
  if (TOLERANCE_SEC <= 0) return { ok: true, reason: 'sin control de antigüedad' };

  const ts = readTimestamp(signature);
  if (!ts) return { ok: false, reason: 'x-signature sin ts' };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) return { ok: false, reason: 'ts inválido' };

  // 13 dígitos o más = milisegundos; menos = segundos (lo que manda MP).
  const tsMs = String(ts).length >= 13 ? tsNum : tsNum * 1000;
  if (Math.abs(Date.now() - tsMs) > TOLERANCE_SEC * 1000) {
    return { ok: false, reason: 'la notificación está vencida (posible reenvío)' };
  }
  return { ok: true, reason: 'antigüedad válida' };
}

// Verificación propia del HMAC. Se usa si el SDK instalado no trae el validador
// oficial (versiones viejas).
function verifyManually({ signature, requestId, dataId }) {
  if (!signature) return { ok: false, reason: 'falta el header x-signature' };
  if (!dataId) return { ok: false, reason: 'falta data.id' };

  // "ts=123,v1=abc" -> { ts: '123', v1: 'abc' }
  const parts = {};
  for (const chunk of String(signature).split(',')) {
    const idx = chunk.indexOf('=');
    if (idx === -1) continue;
    parts[chunk.slice(0, idx).trim().toLowerCase()] = chunk.slice(idx + 1).trim();
  }
  const { ts, v1 } = parts;
  if (!ts || !v1) return { ok: false, reason: 'x-signature mal formado' };

  // El id alfanumérico va en minúsculas. Los campos ausentes se omiten enteros.
  let manifest = `id:${String(dataId).toLowerCase()};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;

  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(manifest).digest('hex');
  if (!safeEqual(expected, v1)) return { ok: false, reason: 'la firma no coincide' };

  return { ok: true, reason: 'firma válida' };
}

// Devuelve { ok, reason }. ok=false => la notificación se descarta.
function verifyWebhookSignature({ signature, requestId, dataId }) {
  if (!HAS_WEBHOOK_SECRET) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.warn(
        '⚠️  MP_WEBHOOK_SECRET no configurada: el webhook de Mercado Pago no se valida. ' +
          'El pago igual se verifica contra la API antes de entregar.'
      );
    }
    return { ok: true, reason: 'sin-clave' };
  }

  // Antigüedad primero (control propio, ver checkTimestampAge).
  const edad = checkTimestampAge(signature);
  if (!edad.ok) return edad;

  // Para el HMAC preferimos el validador oficial del SDK: acompaña las versiones
  // de firma de MP (v1 hoy, v2 cuando salga) sin que tengamos que tocar nada acá.
  if (SdkValidator) {
    try {
      SdkValidator.validate({
        xSignature: signature,
        xRequestId: requestId,
        dataId,
        secret: WEBHOOK_SECRET,
        // toleranceSeconds NO se pasa a propósito (ver checkTimestampAge).
      });
      return { ok: true, reason: 'firma válida' };
    } catch (err) {
      return { ok: false, reason: err?.reason || err?.message || 'firma inválida' };
    }
  }

  return verifyManually({ signature, requestId, dataId });
}

// ---------------------------------------------------------------------------
//  Diagnóstico
// ---------------------------------------------------------------------------
//  Reporte de configuración para el endpoint de estado (ver src/server.js).
//  NUNCA devuelve secretos: solo si están cargados y de qué tipo son.
function configReport() {
  const problemas = [];
  const avisos = [];

  if (!HAS_MP) {
    problemas.push(
      TOKEN_KIND === 'public-key'
        ? 'MP_ACCESS_TOKEN parece ser la Public Key, no el Access Token.'
        : TOKEN_KIND === 'invalid'
          ? 'MP_ACCESS_TOKEN no tiene un formato válido.'
          : 'Falta MP_ACCESS_TOKEN: no se pueden cobrar pagos.'
    );
  }
  if (HAS_MP && IS_TEST_TOKEN && IS_PUBLIC_SITE) {
    problemas.push('El sitio público usa credenciales de PRUEBA: los pagos no son reales.');
  }
  if (IS_PUBLIC_SITE && !IS_HTTPS) {
    problemas.push('BASE_URL no es HTTPS: Mercado Pago no puede avisar los pagos (webhook).');
  }
  if (!HAS_WEBHOOK_SECRET) {
    avisos.push('Falta MP_WEBHOOK_SECRET: las notificaciones no se validan por firma.');
  }

  return {
    tokenCargado: !!RAW_TOKEN,
    tokenTipo: TOKEN_KIND, // none | test | production | public-key | invalid
    pagosReales: HAS_MP && !IS_TEST_TOKEN,
    firmaWebhook: HAS_WEBHOOK_SECRET,
    moneda: CURRENCY,
    baseUrl: BASE_URL,
    baseUrlHttps: IS_HTTPS,
    sitioPublico: IS_PUBLIC_SITE,
    comprasBloqueadas: DEMO_IN_PRODUCTION,
    notificationUrl: IS_HTTPS ? `${BASE_URL}/webhooks/mercadopago` : null,
    vencimientoPreferenciaHs: EXPIRY_HOURS || null,
    binaryMode: BINARY_MODE,
    problemas,
    avisos,
  };
}

module.exports = {
  createCheckout,
  getPaymentStatus,
  getMerchantOrderPaymentIds,
  buildMpItems,
  classifyPayment,
  checkPaymentMatchesOrder,
  parseNotification,
  verifyWebhookSignature,
  isTransientError,
  supportsCurrency,
  configReport,
  CURRENCY,
  HAS_MP,
  IS_TEST_TOKEN,
  TOKEN_KIND,
  HAS_WEBHOOK_SECRET,
  IS_PUBLIC_SITE,
  IS_HTTPS,
  DEMO_IN_PRODUCTION,
};
