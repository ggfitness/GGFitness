#!/usr/bin/env node
// ============================================================================
//  Diagnóstico de la entrega automática por Google Drive
// ============================================================================
//  Uso:
//    npm run check:drive                      -> verifica credenciales y carpetas
//    npm run check:drive -- tumail@gmail.com  -> además hace una entrega de prueba
//
//  Comprueba, en orden:
//   1. Que las credenciales de la cuenta de servicio sean válidas.
//   2. Que cada producto tenga (o no) carpeta configurada.
//   3. Que la cuenta de servicio VEA cada carpeta y PUEDA compartirla.
//   4. Que las carpetas NO estén públicas ("cualquiera con el link").
//   5. Opcional: que dar acceso a un mail real funcione de punta a punta.
//
//  No modifica nada salvo que le pases un email (y en ese caso solo agrega un
//  permiso de lectura, que podés borrar desde Drive).
// ============================================================================
const drive = require('../src/drive');
const delivery = require('../src/delivery');
const products = require('../src/products');

const ok = (m) => console.log('  \x1b[32m✔\x1b[0m ' + m);
const bad = (m) => console.log('  \x1b[31m✘\x1b[0m ' + m);
const warn = (m) => console.log('  \x1b[33m!\x1b[0m ' + m);
const title = (m) => console.log('\n\x1b[1m' + m + '\x1b[0m');

let errores = 0;
let avisos = 0;

async function main() {
  const testEmail = process.argv[2];

  // --- 1. Credenciales ---------------------------------------------------
  title('1) Credenciales de la cuenta de servicio');
  if (!drive.HAS_DRIVE) {
    bad('Falta GOOGLE_SERVICE_ACCOUNT_JSON (o está mal formada). Mirá los avisos de arriba.');
    errores++;
    return resumen();
  }
  ok(`Cuenta de servicio: ${drive.serviceAccountEmail}`);

  try {
    await drive.getAccessToken();
    ok('Google aceptó las credenciales (access token obtenido).');
  } catch (err) {
    bad(`Google rechazó las credenciales: ${err.message}`);
    warn('Revisá que la Google Drive API esté habilitada en el proyecto de Google Cloud.');
    errores++;
    return resumen();
  }

  // --- 2. Mapa de productos ---------------------------------------------
  title('2) Productos y carpetas configuradas');
  const conCarpeta = [];
  for (const p of products) {
    const folderId = delivery.folderIdFor(p.id);
    if (folderId) {
      ok(`${p.name} → entrega automática`);
      conCarpeta.push({ product: p, folderId });
    } else {
      console.log(`  · ${p.name} → sin carpeta (servicio a medida, lo coordina la trainer)`);
    }
  }
  const sobrantes = Object.keys(delivery.FOLDERS).filter((id) => !products.some((p) => p.id === id));
  for (const id of sobrantes) {
    warn(`DRIVE_FOLDERS tiene "${id}", que no existe en el catálogo. ¿Typo en el id del producto?`);
    avisos++;
  }
  if (!conCarpeta.length) {
    warn('Ningún producto tiene carpeta: no hay entrega automática todavía.');
    avisos++;
    return resumen();
  }

  // --- 3 y 4. Acceso y privacidad de cada carpeta ------------------------
  title('3) Acceso de la cuenta de servicio a cada carpeta');
  for (const { product, folderId } of conCarpeta) {
    let info;
    try {
      info = await drive.getFolder(folderId);
    } catch (err) {
      bad(`${product.name}: la cuenta de servicio NO ve la carpeta (${err.message})`);
      warn(`  Compartí la carpeta con ${drive.serviceAccountEmail} como "Editor".`);
      errores++;
      continue;
    }

    if (info.mimeType !== 'application/vnd.google-apps.folder') {
      warn(`${product.name}: el ID apunta a un archivo, no a una carpeta ("${info.name}").`);
      avisos++;
    }

    if (info.capabilities && info.capabilities.canShare === false) {
      bad(`${product.name}: la ve ("${info.name}") pero NO puede compartirla.`);
      warn('  En Drive: carpeta → Compartir → engranaje → tildar "Los editores pueden cambiar permisos y compartir".');
      errores++;
    } else {
      ok(`${product.name}: "${info.name}" — la ve y puede compartirla.`);
    }

    // ¿Quedó pública de antes?
    try {
      const token = await drive.getAccessToken();
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${folderId}/permissions` +
          '?fields=permissions(id,type,role)&supportsAllDrives=true',
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
      );
      const data = await res.json();
      const publica = (data.permissions || []).some((perm) => perm.type === 'anyone');
      if (publica) {
        bad(`${product.name}: la carpeta está PÚBLICA ("cualquiera con el link").`);
        warn('  En Drive: Compartir → Acceso general → "Restringido". Si no, cualquiera entra gratis.');
        errores++;
      } else {
        ok(`${product.name}: privada (solo entra quien compró). 🔒`);
      }
    } catch {
      warn(`${product.name}: no se pudieron listar los permisos (no es bloqueante).`);
      avisos++;
    }
  }

  // --- 5. Entrega de prueba ---------------------------------------------
  if (testEmail) {
    title(`4) Entrega de prueba a ${testEmail}`);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(testEmail)) {
      bad('Ese no parece un email válido.');
      errores++;
    } else {
      for (const { product, folderId } of conCarpeta) {
        try {
          const { notified } = await drive.grantReader({
            folderId,
            email: testEmail,
            message: 'Prueba de entrega automática.',
          });
          ok(
            `${product.name}: acceso otorgado` +
              (notified ? ' (Google le mandó su propia invitación: no es cuenta de Google).' : '.')
          );
        } catch (err) {
          bad(`${product.name}: falló la entrega (${err.message})`);
          errores++;
        }
      }
      console.log(
        `\n  Acordate de quitar el acceso de prueba de ${testEmail} desde Drive cuando termines.`
      );
    }
  } else {
    title('4) Entrega de prueba');
    console.log('  (omitida) Para probarla: npm run check:drive -- tumail@gmail.com');
  }

  resumen();
}

function resumen() {
  console.log('\n' + '─'.repeat(60));
  if (errores) {
    console.log(`\x1b[31m${errores} problema(s) que hay que resolver\x1b[0m antes de vender.`);
    process.exitCode = 1;
  } else {
    console.log('\x1b[32mTodo listo: la entrega automática está bien configurada.\x1b[0m');
  }
  if (avisos) console.log(`${avisos} aviso(s) para revisar.`);
  console.log('─'.repeat(60) + '\n');
}

main().catch((err) => {
  console.error('\nError inesperado en el diagnóstico:', err.message);
  process.exitCode = 1;
});
