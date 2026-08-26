// Plantillas HTML de los mails (compatibles con Gmail/Outlook: tablas + inline styles).
//
// Los ítems que reciben las plantillas traen el estado de la entrega:
//   access = 'granted' -> el comprador ya tiene acceso a la carpeta (va el link)
//          | 'pending' -> Drive falló; lo entrega la trainer a mano
//          | 'manual'  -> servicio a medida, se coordina por WhatsApp

// Escapa texto que viene del cliente (nombre, email, respuestas del formulario)
// antes de meterlo en el HTML. Sin esto, alguien podría poner etiquetas HTML en
// su nombre y deformar (o inyectar contenido en) el mail que lee la trainer.
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Filas de "Subtotal" + "Descuento(s)" para el resumen de compra.
// Solo genera algo si hubo descuento (subtotalText presente).
// discounts: [{ label, amountText }]
function summaryRows(subtotalText, discounts) {
  if (!subtotalText) return '';
  const disc = (discounts || [])
    .map(
      (d) => `
      <tr>
        <td style="padding:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1a9e5f;">${esc(d.label)}</td>
        <td align="right" style="padding:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#1a9e5f;white-space:nowrap;">${esc(d.amountText)}</td>
      </tr>`
    )
    .join('');
  return `
      <tr>
        <td style="padding:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5b6270;">Subtotal</td>
        <td align="right" style="padding:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5b6270;white-space:nowrap;">${esc(subtotalText)}</td>
      </tr>${disc}`;
}

// Filas "Producto x2 ....... $importe" del detalle de compra.
function productRowsHtml(items) {
  return items
    .map(
      (it) => `
      <tr>
        <td style="padding:11px 0;border-bottom:1px solid #eceef1;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#14161c;">${esc(it.name)} <span style="color:#9aa0aa;">&times;${esc(it.qty)}</span></td>
        <td align="right" style="padding:11px 0;border-bottom:1px solid #eceef1;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#14161c;white-space:nowrap;">${esc(it.lineText)}</td>
      </tr>`
    )
    .join('');
}

// Mail que recibe el CLIENTE: confirmación de pago + accesos.
// items: [{ name, qty, lineText, access, url }] · accountEmail: cuenta con acceso
function paymentConfirmedEmailHtml({
  brand,
  name,
  items,
  totalText,
  subtotalText,
  discounts,
  accountEmail,
}) {
  const granted = items.filter((it) => it.access === 'granted');
  const pending = items.filter((it) => it.access === 'pending');
  const manual = items.filter((it) => it.access === 'manual');

  // 1) Lo que ya está entregado: botones a las carpetas de Drive.
  //    Aclaramos con qué cuenta hay que entrar: la carpeta es privada y si
  //    están logueados con otro Google les va a decir "solicitar acceso".
  const accessBlock = granted.length
    ? `
        <tr><td style="padding:24px 32px 8px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fdf2f5;border:1px solid #f0d5de;border-radius:12px;">
            <tr><td style="padding:20px;">
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#a84765;text-align:center;margin-bottom:4px;">&#128230; Ya ten&eacute;s acceso a tu material</div>
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5b6270;text-align:center;line-height:1.6;">Guard&aacute; este correo para volver a entrar cuando quieras.</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
                ${granted
                  .map(
                    (it) => `
                <tr><td style="padding:7px 0;text-align:center;">
                  <a href="${esc(it.url)}" target="_blank" style="display:inline-block;background:#a84765;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:999px;">${esc(it.name)} &rarr;</a>
                </td></tr>`
                  )
                  .join('')}
              </table>
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9aa0aa;text-align:center;line-height:1.6;margin-top:14px;">&#128274; El acceso es exclusivo para <strong style="color:#5b6270;">${esc(accountEmail)}</strong>.<br>Si Google te pide permiso, entr&aacute; con esa cuenta.</div>
            </td></tr>
          </table>
        </td></tr>`
    : '';

  // 2) Lo que no se pudo entregar solo (mail sin cuenta de Google, error de Drive...).
  //    Nunca dejamos al cliente sin respuesta: la trainer ya fue avisada.
  const pendingBlock = pending.length
    ? `
        <tr><td style="padding:${granted.length ? '12px' : '24px'} 32px 8px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff8e6;border:1px solid #f2e2b8;border-radius:12px;">
            <tr><td style="padding:18px 20px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#5b6270;line-height:1.6;">
              &#9203; Estamos preparando tu acceso a <strong>${pending.map((it) => esc(it.name)).join('</strong>, <strong>')}</strong>.<br>Te lo enviamos a este mismo mail <strong>dentro de las pr&oacute;ximas 24 horas</strong>.
            </td></tr>
          </table>
        </td></tr>`
    : '';

  // 3) Servicios a medida: los coordina la trainer.
  const manualBlock = manual.length
    ? `
        <tr><td style="padding:${granted.length || pending.length ? '12px' : '24px'} 32px 8px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f8fa;border:1px solid #e6e8ec;border-radius:12px;">
            <tr><td style="padding:18px 20px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#5b6270;line-height:1.6;">
              &#128172; Para <strong>${manual.map((it) => esc(it.name)).join('</strong>, <strong>')}</strong> te vamos a contactar <strong>dentro de las pr&oacute;ximas 48 horas</strong> para armar tu plan a medida.
            </td></tr>
          </table>
        </td></tr>`
    : '';

  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
</head>
<body style="margin:0;padding:0;background:#f2f3f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e6e8ec;">

        <!-- Header -->
        <tr><td bgcolor="#111013" style="background:#111013;background:linear-gradient(120deg,#111013,#2a1d24);padding:22px 30px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:.5px;">${esc(brand)}</span>
        </td></tr>

        <!-- Hero -->
        <tr><td style="padding:38px 32px 6px 32px;text-align:center;">
          <div style="font-size:46px;line-height:1;">&#127881;</div>
          <h1 style="margin:14px 0 10px 0;font-family:Arial,Helvetica,sans-serif;font-size:26px;color:#14161c;">&iexcl;Pago aprobado!</h1>
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#5b6270;line-height:1.6;">&iexcl;Hola ${esc(name)}! Gracias por tu compra. &#128170;</p>
        </td></tr>

        <!-- Accesos / pendientes / coordinación -->
        ${accessBlock}
        ${pendingBlock}
        ${manualBlock}

        <!-- Detalle -->
        <tr><td style="padding:20px 32px 6px 32px;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9aa0aa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Detalle de tu compra</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${productRowsHtml(items)}
            ${summaryRows(subtotalText, discounts)}
            <tr>
              <td style="padding:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:800;color:#14161c;">Total</td>
              <td align="right" style="padding:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:800;color:#14161c;">${esc(totalText)}</td>
            </tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:26px 32px 22px 32px;background:#fafafb;border-top:1px solid #eceef1;text-align:center;">
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9aa0aa;line-height:1.6;">&iquest;Dudas? Respond&eacute; este mail y te ayudamos.<br>&copy; ${esc(brand)} &middot; &iexcl;Gracias por tu compra! &#128171;</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Mail que recibe la TRAINER cuando se confirma una venta.
// items: [{ name, qty, lineText, access, url }] · intake: [{ label, value }] (opcional)
function trainerEmailHtml({
  brand,
  customerName,
  customerEmail,
  items,
  totalText,
  subtotalText,
  discounts,
  intake,
  // Estimación de lo que queda después de la comisión de Mercado Pago.
  // Es opcional: si la comisión no está configurada llega vacío y no se muestra
  // nada (ver src/fees.js). Nunca inventamos un número.
  netText,
  netNote,
}) {
  const pending = items.filter((it) => it.access === 'pending');
  const manual = items.filter((it) => it.access === 'manual');
  const necesitaAccion = pending.length > 0 || manual.length > 0;

  // Titular: lo primero que tiene que ver es si tiene que hacer algo o no.
  const headline = pending.length
    ? `&#9888;&#65039; Hay material que NO se pudo entregar solo: compartilo a mano (ver abajo)`
    : manual.length
      ? `&#9200; Ten&eacute;s que contactar al cliente para ${manual.length > 1 ? 'estos servicios' : 'este servicio'} (dentro de 48hs)`
      : '&#10004; El material ya se le entreg&oacute; solo. No ten&eacute;s que hacer nada.';

  const materialRows = items
    .map((it) => {
      if (it.access === 'granted') {
        return `
      <tr><td style="padding:5px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5b6270;line-height:1.5;">&#10004; ${esc(it.name)} &mdash; <span style="color:#1a9e5f;">acceso dado autom&aacute;ticamente</span></td></tr>`;
      }
      if (it.access === 'pending') {
        return `
      <tr><td style="padding:5px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5b6270;line-height:1.5;">&#9888;&#65039; ${esc(it.name)} &mdash; <strong style="color:#c0392b;">compartilo vos desde Drive</strong> con <a href="mailto:${esc(customerEmail)}" style="color:#a84765;text-decoration:none;">${esc(customerEmail)}</a>${
          it.error
            ? `<br><span style="color:#9aa0aa;font-size:12px;">Motivo: ${esc(it.error)}</span>`
            : ''
        }</td></tr>`;
      }
      return `
      <tr><td style="padding:5px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5b6270;line-height:1.5;">&#9200; ${esc(it.name)} &mdash; <strong style="color:#14161c;">lo coordin&aacute;s vos</strong> (servicio a medida)</td></tr>`;
    })
    .join('');

  // Bloque del formulario de admisión (solo si vino con respuestas)
  const intakeBlock =
    intake && intake.length
      ? `
        <tr><td style="padding:22px 32px 4px 32px;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9aa0aa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Formulario del cliente</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${intake
              .map(
                (q) => `
              <tr><td style="padding:9px 0;border-bottom:1px solid #eceef1;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#14161c;">
                <strong style="color:#5b6270;">${esc(q.label)}:</strong><br>${esc(q.value || '-')}
              </td></tr>`
              )
              .join('')}
          </table>
        </td></tr>`
      : '';

  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
</head>
<body style="margin:0;padding:0;background:#f2f3f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e6e8ec;">

        <!-- Header -->
        <tr><td bgcolor="#111013" style="background:#111013;background:linear-gradient(120deg,#111013,#2a1d24);padding:22px 30px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:.5px;">${esc(brand)}</span>
        </td></tr>

        <!-- Hero -->
        <tr><td style="padding:36px 32px 4px 32px;text-align:center;">
          <div style="font-size:44px;line-height:1;">&#128176;</div>
          <h1 style="margin:12px 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:26px;color:#14161c;">&iexcl;Nueva venta!</h1>
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:${necesitaAccion ? '#a84765' : '#1a9e5f'};font-weight:700;">${headline}</p>
        </td></tr>

        <!-- Total -->
        <tr><td style="padding:24px 32px 8px 32px;text-align:center;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9aa0aa;text-transform:uppercase;letter-spacing:1px;">Total</div>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:38px;font-weight:800;color:#a84765;line-height:1.1;">${esc(totalText)}</div>
          ${
            netText
              ? `<div style="margin-top:6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#5b6270;">Te quedan aprox. <strong style="color:#14161c;">${esc(netText)}</strong></div>
          <div style="margin-top:2px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#9aa0aa;line-height:1.4;">${esc(netNote || '')}</div>`
              : ''
          }
        </td></tr>

        <!-- Cliente -->
        <tr><td style="padding:12px 32px 0 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f8fa;border:1px solid #e6e8ec;border-radius:12px;">
            <tr><td style="padding:16px 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#14161c;">
              <strong>Cliente:</strong> ${esc(customerName)}<br>
              <strong>Email:</strong> <a href="mailto:${esc(customerEmail)}" style="color:#a84765;text-decoration:none;">${esc(customerEmail)}</a>
            </td></tr>
          </table>
        </td></tr>

        <!-- Productos -->
        <tr><td style="padding:22px 32px 4px 32px;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9aa0aa;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Productos</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${productRowsHtml(items)}
            ${summaryRows(subtotalText, discounts)}
            <tr>
              <td style="padding:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:800;color:#14161c;">Total</td>
              <td align="right" style="padding:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:800;color:#14161c;">${esc(totalText)}</td>
            </tr>
          </table>
        </td></tr>
        ${intakeBlock}

        <!-- Estado de la entrega -->
        <tr><td style="padding:22px 32px 6px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${pending.length ? '#fff5f5' : '#fdf2f5'};border:1px solid ${pending.length ? '#f3c9c9' : '#f0d5de'};border-radius:12px;">
            <tr><td style="padding:16px 18px;">
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#a84765;margin-bottom:8px;">&#128230; Estado de la entrega</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${materialRows}</table>
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 32px 26px 32px;background:#fafafb;border-top:1px solid #eceef1;text-align:center;">
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5b6270;line-height:1.6;">${
            necesitaAccion
              ? 'Resolvelo dentro de las 48hs para que el cliente no quede esperando. &#128170;'
              : 'El material viaj&oacute; solo en el mail del cliente. &#128170;'
          }<br><span style="color:#9aa0aa;font-size:12px;">&copy; ${esc(brand)}</span></p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

module.exports = { paymentConfirmedEmailHtml, trainerEmailHtml };
