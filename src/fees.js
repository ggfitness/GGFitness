// ============================================================================
//  Comisión de Mercado Pago — estimación de lo que queda de cada venta
// ============================================================================
//  Para qué: que la trainer vea en el aviso de venta cuánto le queda neto, y que
//  se pueda calcular a qué precio vender para llevarse un número exacto
//  (ver scripts/precios.js).
//
//  ⚠️ ES UNA ESTIMACIÓN, NO UN DATO CONTABLE.
//
//  La comisión real la fija Mercado Pago según el plazo de acreditación que
//  eligió la cuenta, y cambia con el tiempo. El número tiene que salir del panel
//  de la clienta (Tu negocio > Costos) y cargarse en MP_FEE_PERCENT.
//
//  Si la variable NO está cargada, todo esto queda APAGADO: no se muestra ningún
//  número en ninguna parte. Preferimos no decir nada antes que mostrarle un neto
//  inventado y que tome decisiones de precios con un número falso.
//
//  Lo que esta estimación NO descuenta (y también reduce lo que llega al banco):
//   - Retenciones de IIBB, Ganancias e IVA, según su condición fiscal y provincia.
//   - Impuesto a los débitos y créditos al transferir de MP a la cuenta bancaria.
//  Eso lo tiene que confirmar su contador.
// ============================================================================

// Comisión base, en porcentaje (ej: 6.29 para el 6,29%).
const PERCENT_RAW = (process.env.MP_FEE_PERCENT || '').trim();

// IVA que Mercado Pago cobra SOBRE la comisión (no sobre la venta).
// En Argentina es 21%. Se puede cambiar para otros países.
const IVA_RAW = (process.env.MP_FEE_IVA_PERCENT || '').trim();

// Una comisión de más del 30% no existe: si aparece, es un error de carga
// (típico: escribir 629 en vez de 6.29, o usar coma en vez de punto).
const MAX_PERCENT = 30;

function parsePercent(raw, nombre, porDefecto) {
  if (!raw) return porDefecto;
  // Aceptamos coma decimal: es lo natural al copiar "6,29" del panel.
  const n = Number(raw.replace(',', '.').replace('%', ''));
  if (!Number.isFinite(n) || n < 0 || n > MAX_PERCENT) {
    console.error(
      `⚠️  ${nombre}="${raw}" no parece un porcentaje válido (esperado: algo como 6.29). Se ignora.`
    );
    return porDefecto;
  }
  return n;
}

const PERCENT = parsePercent(PERCENT_RAW, 'MP_FEE_PERCENT', null);
const IVA_PERCENT = parsePercent(IVA_RAW, 'MP_FEE_IVA_PERCENT', 21);

const HAS_FEE = PERCENT !== null && PERCENT > 0;

// Comisión efectiva = comisión + el IVA que se cobra sobre ella.
// Es el número que de verdad se descuenta de la venta.
const effectivePercent = HAS_FEE ? PERCENT * (1 + IVA_PERCENT / 100) : null;

if (HAS_FEE) {
  console.log(
    `🧾 Comisión de Mercado Pago estimada: ${PERCENT}% + IVA ${IVA_PERCENT}% = ` +
      `${effectivePercent.toFixed(3)}% efectivo.`
  );
}

const round2 = (n) => Math.round(n * 100) / 100;

// Desglose de una venta. Devuelve null si la comisión no está configurada
// (quien llama tiene que tratar ese caso como "no mostrar nada").
//   { bruto, comision, iva, costo, neto, percent, ivaPercent, effectivePercent }
function estimate(amount) {
  if (!HAS_FEE) return null;
  const bruto = Number(amount);
  if (!Number.isFinite(bruto) || bruto < 0) return null;

  const comision = bruto * (PERCENT / 100);
  const iva = comision * (IVA_PERCENT / 100);
  const costo = comision + iva;

  return {
    bruto: round2(bruto),
    comision: round2(comision),
    iva: round2(iva),
    costo: round2(costo),
    neto: round2(bruto - costo),
    percent: PERCENT,
    ivaPercent: IVA_PERCENT,
    effectivePercent,
  };
}

// A qué precio hay que vender para que queden `neto` pesos después de la
// comisión. Es la inversa de estimate():
//   precio = neto / (1 - comisión efectiva)
function priceForNet(neto, percent = PERCENT, ivaPercent = IVA_PERCENT) {
  if (percent === null || !Number.isFinite(Number(neto))) return null;
  const efectiva = (percent * (1 + ivaPercent / 100)) / 100;
  if (efectiva >= 1) return null; // comisión del 100%: no hay precio posible
  return round2(Number(neto) / (1 - efectiva));
}

module.exports = {
  HAS_FEE,
  PERCENT,
  IVA_PERCENT,
  effectivePercent,
  estimate,
  priceForNet,
};
