// ============================================================
//  DESCUENTOS POR COMBO (fuente única de verdad, en código)
// ============================================================
// Reglas de descuento que se aplican AUTOMÁTICAMENTE cuando el carrito
// contiene ciertas combinaciones de productos.
//
// Para crear/editar promos: tocás el array de abajo y volvés a deployar.
//
// Cada regla tiene:
//   id        -> identificador interno (único, sin espacios)
//   label     -> texto que ve el cliente (ej: "Combo full body")
//   allOf     -> lista de IDs de productos que DEBEN estar todos en el carrito
//                (los IDs son los de src/products.js)
//   percentOff-> % de descuento  (usá ESTE o amountOff, no los dos)
//   amountOff -> descuento fijo en pesos
//
// El descuento se calcula sobre el precio de UNA unidad de cada producto
// de la promo (no sobre cantidades repetidas ni sobre otros productos del carrito).
//
// ⚠️ Los valores de abajo son EJEMPLOS. Ajustá los % / montos a gusto.
const RULES = [
  {
    id: 'full-digital',
    label: 'Pack completo: Mentalidad + Recetas + Tren Inferior + Superior',
    allOf: [
      'pack-mentalidad',
      'pack-recetas-fit',
      'pack-rutinas-tren-inferior',
      'pack-rutinas-tren-superior',
    ],
    // Monto fijo (no %) para que el combo cierre en $39.999 y no en $40.000.
    // Ojo: si cambian los precios de los packs, hay que recalcular este numero.
    amountOff: 8001, // 48.000 - 8.001 = 39.999
  },
  {
    id: 'mente-recetas-inferior',
    label: 'Combo Mentalidad + Recetas FIT + Tren Inferior',
    allOf: ['pack-mentalidad', 'pack-recetas-fit', 'pack-rutinas-tren-inferior'],
    amountOff: 6001, // 36.000 - 6.001 = 29.999
  },
  {
    id: 'mente-recetas-superior',
    label: 'Combo Mentalidad + Recetas FIT + Tren Superior',
    allOf: ['pack-mentalidad', 'pack-recetas-fit', 'pack-rutinas-tren-superior'],
    amountOff: 6001, // 36.000 - 6.001 = 29.999
  },
];

// Devuelve la lista de promos (para mostrarlas como sugerencia en la web).
function getRules() {
  return RULES;
}

// Calcula el descuento total para un carrito ya resuelto en el servidor.
//   items: [{ id, price, qty }]  (precios que vienen del servidor, NO del cliente)
// Devuelve: { discount, applied: [{ id, label, amount }] }
//
// Lógica anti-abuso / anti-confusión:
//  - Solo cuentan las promas cuyos productos estén TODOS en el carrito.
//  - Si dos promos se pisan (comparten productos), se aplica la de MAYOR ahorro
//    y esos productos quedan "usados": no se descuentan dos veces.
function computeDiscount(items) {
  const priceById = new Map(items.map((it) => [it.id, Number(it.price) || 0]));
  const inCart = new Set(items.filter((it) => it.qty > 0).map((it) => it.id));

  // 1) Buscamos las reglas que aplican y cuánto ahorra cada una.
  const candidates = [];
  for (const rule of RULES) {
    const ids = rule.allOf || [];
    if (!ids.length) continue;
    if (!ids.every((id) => inCart.has(id))) continue; // faltan productos

    const base = ids.reduce((s, id) => s + (priceById.get(id) || 0), 0);
    let amount = 0;
    if (rule.percentOff) amount = (base * rule.percentOff) / 100;
    else if (rule.amountOff) amount = rule.amountOff;
    amount = Math.round(Math.min(amount, base)); // nunca más que la base, redondeado
    if (amount > 0) candidates.push({ id: rule.id, label: rule.label, ids, amount });
  }

  // 2) Aplicamos primero las de mayor ahorro; cada producto se usa una sola vez.
  candidates.sort((a, b) => b.amount - a.amount);
  const used = new Set();
  const applied = [];
  let discount = 0;
  for (const c of candidates) {
    if (c.ids.some((id) => used.has(id))) continue; // se pisa con otra ya aplicada
    c.ids.forEach((id) => used.add(id));
    applied.push({ id: c.id, label: c.label, amount: c.amount });
    discount += c.amount;
  }

  return { discount, applied };
}

module.exports = { getRules, computeDiscount };
