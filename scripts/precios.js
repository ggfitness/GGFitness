#!/usr/bin/env node
// ============================================================================
//  Precios, comisión de Mercado Pago y neto por venta
// ============================================================================
//  Uso:
//    npm run precios                     -> usa MP_FEE_PERCENT del .env
//    npm run precios -- 6.29             -> con esa comisión
//    npm run precios -- 6.29 5.29 3.49   -> compara varios plazos
//    npm run precios -- 6.29 --neto 8000 10000
//                                        -> además, a qué precio vender para
//                                           llevarse esos netos exactos
//
//  Qué muestra:
//   1. La comisión efectiva (comisión + el IVA que MP cobra sobre la comisión).
//   2. Lo que queda neto de cada producto a los precios actuales.
//   3. Lo que queda neto de cada combo, separando cuánto cuesta el descuento y
//      cuánto la comisión (spoiler: el descuento suele costar mucho más).
//   4. El precio a cobrar para llevarse un neto exacto.
//
//  ⚠️ LA COMISIÓN REAL SALE DEL PANEL DE LA CLIENTA: Tu negocio > Costos.
//  Cambia según el plazo de acreditación que eligió y con el tiempo. Los valores
//  de ejemplo de este script son de referencia, NO una fuente de verdad.
//
//  ⚠️ El neto que se muestra es DESPUÉS de la comisión de Mercado Pago y ANTES
//  de retenciones (IIBB, Ganancias) y del impuesto a los débitos y créditos.
//  Eso depende de su condición fiscal y su provincia: lo confirma su contador.
//
//  No modifica nada: solo calcula e imprime.
// ============================================================================
const products = require('../src/products');
const discounts = require('../src/discounts');
const fees = require('../src/fees');

const bold = (m) => '\x1b[1m' + m + '\x1b[0m';
const dim = (m) => '\x1b[2m' + m + '\x1b[0m';
const title = (m) => console.log('\n' + bold(m));
const warn = (m) => console.log('\x1b[33m!\x1b[0m ' + m);

const IVA = fees.IVA_PERCENT;
const efectiva = (percent) => percent * (1 + IVA / 100);

// Plazos de acreditación de Checkout Pro en Argentina, de referencia. Sirven
// para comparar cuánto cambia el neto según el plazo, no como tarifa oficial.
const REFERENCIA = [
  { nombre: 'al instante', percent: 6.29 },
  { nombre: 'en 10 días', percent: 5.29 },
  { nombre: 'en 18 días', percent: 4.39 },
  { nombre: 'en 30 días', percent: 3.49 },
];

// ---------------------------------------------------------------------------
//  Argumentos
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const idxNeto = args.indexOf('--neto');
const percentArgs = (idxNeto === -1 ? args : args.slice(0, idxNeto))
  .map((a) => Number(String(a).replace(',', '.').replace('%', '')))
  .filter((n) => Number.isFinite(n) && n > 0 && n <= 30);
const netosPedidos = (idxNeto === -1 ? [] : args.slice(idxNeto + 1))
  .map((a) => Number(String(a).replace(/[.$]/g, '').replace(',', '.')))
  .filter((n) => Number.isFinite(n) && n > 0);

// De dónde sale la comisión, en orden: argumentos > .env > valores de referencia.
let escenarios;
let fuente;
if (percentArgs.length) {
  escenarios = percentArgs.map((percent) => ({ nombre: `${percent}%`, percent }));
  fuente = 'los valores que pasaste por línea de comandos';
} else if (fees.HAS_FEE) {
  escenarios = [{ nombre: 'tu comisión', percent: fees.PERCENT }];
  fuente = 'MP_FEE_PERCENT del entorno';
} else {
  escenarios = REFERENCIA;
  fuente = null;
}

const money = (n) => '$' + Math.round(n).toLocaleString('es-AR');
const pad = (s, n) => String(s).padStart(n);
const padR = (s, n) => String(s).padEnd(n);

// ---------------------------------------------------------------------------
//  1) Comisión
// ---------------------------------------------------------------------------
console.log(bold('\n═══ Comisión de Mercado Pago ═══'));
if (!fuente) {
  warn('No hay comisión configurada: se usan valores DE REFERENCIA para Argentina.');
  warn('El número real está en el panel de la clienta: Tu negocio > Costos.');
  warn('Cargalo en MP_FEE_PERCENT (ej: MP_FEE_PERCENT=6.29) o pasalo: npm run precios -- 6.29');
} else {
  console.log(dim(`Fuente: ${fuente}.`));
}
console.log();
console.log(dim('  El IVA se cobra SOBRE la comisión, no sobre la venta.'));
for (const e of escenarios) {
  console.log(
    `  ${padR(e.nombre, 14)} ${pad(e.percent.toFixed(2) + '%', 7)} + IVA ${IVA}%  =  ` +
      bold(efectiva(e.percent).toFixed(3) + '% efectivo')
  );
}

// ---------------------------------------------------------------------------
//  2) Neto por producto
// ---------------------------------------------------------------------------
title('═══ Lo que queda de cada producto (precios actuales) ═══');
console.log(
  '  ' +
    padR('producto', 40) +
    pad('precio', 11) +
    escenarios.map((e) => pad('neto ' + e.nombre, 17)).join('')
);
for (const p of products) {
  let fila = '  ' + padR(p.name.slice(0, 38), 40) + pad(money(p.price), 11);
  for (const e of escenarios) {
    fila += pad(money(p.price * (1 - efectiva(e.percent) / 100)), 17);
  }
  console.log(fila);
}

// ---------------------------------------------------------------------------
//  3) Combos
// ---------------------------------------------------------------------------
title('═══ Combos: qué cuesta el descuento y qué cuesta la comisión ═══');
console.log(dim('  El descuento sale del bolsillo de la trainer; MP cobra sobre el total ya descontado.'));

const reglas = discounts.getRules();
if (!reglas.length) {
  console.log('  (no hay promos configuradas en src/discounts.js)');
}
for (const regla of reglas) {
  const items = (regla.allOf || []).map((id) => products.find((p) => p.id === id));
  if (items.some((p) => !p)) {
    warn(`La promo "${regla.id}" apunta a un producto que no existe: se saltea.`);
    continue;
  }
  const cart = items.map((p) => ({ id: p.id, price: p.price, qty: 1 }));
  const subtotal = cart.reduce((s, it) => s + it.price, 0);
  const { discount } = discounts.computeDiscount(cart);
  const total = subtotal - discount;

  // El padding se calcula SIEMPRE sobre el texto pelado: los códigos de color
  // cuentan como caracteres y desalinean la columna.
  const fila = (etiqueta, valor, extra = '', resaltar = false) => {
    const izq = padR(etiqueta, 32);
    const der = pad(valor, 12);
    console.log('    ' + (resaltar ? bold(izq) + bold(der) : izq + der) + extra);
  };

  console.log('\n  ' + bold(regla.label));
  fila('packs sueltos a precio lleno', money(subtotal));
  fila(
    'descuento de la promo',
    '-' + money(discount),
    dim(`   (${((discount / subtotal) * 100).toFixed(1)}% del precio lleno)`)
  );
  fila('paga el comprador', money(total), '', true);
  for (const e of escenarios) {
    const costo = total * (efectiva(e.percent) / 100);
    const neto = total - costo;
    fila(
      `comisión MP ${e.nombre}`,
      '-' + money(costo),
      dim(`   → neto ${money(neto)}  (${money(neto / items.length)} por pack)`)
    );
  }
}

// ---------------------------------------------------------------------------
//  4) Precio para un neto exacto
// ---------------------------------------------------------------------------
title('═══ A qué precio vender para llevarse un neto exacto ═══');
console.log(dim('  fórmula:  precio = neto deseado ÷ (1 − comisión efectiva)'));
console.log();

// Si no pidieron netos puntuales, mostramos los netos de los precios de hoy
// redondeados, que es lo que se suele querer ("que me queden 8000 limpios").
const netos = netosPedidos.length
  ? netosPedidos
  : [...new Set(products.map((p) => p.price))].sort((a, b) => a - b);

console.log(
  '  ' + padR('neto deseado', 15) + escenarios.map((e) => pad('cobrar ' + e.nombre, 19)).join('')
);
for (const neto of netos) {
  let fila = '  ' + padR(money(neto), 15);
  for (const e of escenarios) {
    fila += pad(money(fees.priceForNet(neto, e.percent, IVA)), 19);
  }
  console.log(fila);
}

console.log(
  dim(
    '\n  Recordá: el neto es DESPUÉS de la comisión de Mercado Pago y ANTES de\n' +
      '  retenciones (IIBB, Ganancias) y del impuesto a los débitos y créditos.\n'
  )
);
