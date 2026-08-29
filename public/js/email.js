// ============================================================================
//  Validación del email — UNA sola fuente de verdad
// ============================================================================
//  Este archivo corre en los DOS lados:
//    - En el navegador:  <script src="/js/email.js"></script>
//    - En el servidor:   require('../public/js/email.js')
//
//  Por qué está acá y no en src/: el navegador no puede importar un módulo de
//  CommonJS. Antes había una copia en cada lado con el comentario "si cambiás
//  una, cambiá la otra", que es exactamente la clase de acuerdo que se rompe
//  solo. Con un archivo compartido, el mensaje que ve el comprador y el que
//  aplica el servidor no pueden diferir nunca.
//  (Vercel incluye public/** en el bundle, ver vercel.json.)
//
//  Qué expone:
//    emailProblem(valor) -> string con el problema concreto de FORMATO, o null
//                           si está bien escrito. No mira de qué proveedor es.
//    gmailProblem(valor) -> string si el email está bien escrito pero no es de
//                           Gmail, o null. La entrega necesita una cuenta de
//                           Google, así que esto también frena la compra.
//    deliveryEmailProblem(valor)
//                        -> los dos controles juntos: es LO QUE SE EXIGE para
//                           poder comprar, y es lo que aplica el servidor.
//    validEmail(valor)   -> true/false (atajo de emailProblem === null).
//
//  El email es la dirección de ENTREGA del material, no un dato de contacto
//  más: si está mal, se cobra algo que no se puede entregar y encima no hay
//  forma de avisarle al comprador. De ahí que se valide antes de cobrar y que
//  los mensajes digan qué corregir en vez de un "email inválido".
// ============================================================================
(function (raiz) {
  'use strict';

  // Estructura completa de un email entregable:
  //  - antes de la arroba: los símbolos que permite el estándar, con puntos que
  //    no van al principio, al final, ni repetidos;
  //  - dominio: al menos dos etiquetas, de letras/números/guiones, sin empezar
  //    ni terminar con guión;
  //  - terminación: dos letras o más ("a@b.c" no existe).
  var EMAIL_RE =
    /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

  // Caracteres válidos en cada mitad. Ojo: la barra "/" SÍ vale antes de la
  // arroba y NO vale en el dominio, así que hay que mirarlos por separado.
  // (Por eso "loquito@s/.com" es inválido: la barra está en el dominio.)
  var CHAR_LOCAL = /[A-Za-z0-9!#$%&'*+\/=?^_`{|}~.-]/;
  var CHAR_DOMINIO = /[A-Za-z0-9.-]/;

  // Errores de tipeo que apuntan a Gmail. Solo se usan para CORREGIR el
  // mensaje ("¿quisiste decir...?"): quién entra y quién no lo decide
  // DOMINIOS_GOOGLE, unas líneas más abajo.
  var TYPOS_GMAIL = {
    'gmail.co': 'gmail.com',
    'gmail.con': 'gmail.com',
    'gmail.cm': 'gmail.com',
    'gmail.om': 'gmail.com',
    'gmail.copm': 'gmail.com',
    'gmail.comm': 'gmail.com',
    'gmial.com': 'gmail.com',
    'gmai.com': 'gmail.com',
    'gnail.com': 'gmail.com',
    'gmail.cl': 'gmail.com',
    'gmaill.com': 'gmail.com',
  };

  function primerCaracterInvalido(texto, permitidos) {
    for (var i = 0; i < texto.length; i++) {
      if (!permitidos.test(texto[i])) return texto[i];
    }
    return null;
  }

  // Devuelve el problema concreto del email, o null si está bien.
  // El orden de los controles importa: primero lo más probable y lo más
  // específico, para que el mensaje sea el útil y no uno genérico.
  function emailProblem(valor) {
    if (valor == null || typeof valor.toString !== 'function') return 'Escribí tu email.';
    var email = String(valor).trim();

    if (!email) return 'Escribí tu email.';
    if (email.length > 254) return 'Ese email es demasiado largo.';
    if (/\s/.test(email)) return 'Tu email no puede tener espacios.';

    var arrobas = email.split('@').length - 1;
    if (arrobas === 0) return 'Falta el @. Se escribe así: tunombre@gmail.com';
    if (arrobas > 1) return 'Tu email tiene ' + arrobas + ' arrobas y va una sola.';

    var partes = email.split('@');
    var local = partes[0];
    var dominio = partes[1];

    if (!local) return 'Falta lo que va antes del @ (por ejemplo: tunombre@gmail.com).';
    if (!dominio) return 'Falta el dominio después del @ (por ejemplo: tunombre@gmail.com).';
    if (local.length > 64) return 'La parte de antes del @ es demasiado larga.';

    // Un carácter que no existe en un email: le mostramos EXACTAMENTE cuál.
    var maloLocal = primerCaracterInvalido(local, CHAR_LOCAL);
    if (maloLocal) return 'Tu email no puede llevar «' + maloLocal + '» antes del @.';
    var maloDominio = primerCaracterInvalido(dominio, CHAR_DOMINIO);
    if (maloDominio) return 'El dominio no puede llevar «' + maloDominio + '».';

    if (local.charAt(0) === '.') return 'Tu email no puede empezar con un punto.';
    if (local.charAt(local.length - 1) === '.') return 'No puede haber un punto justo antes del @.';
    if (local.indexOf('..') !== -1) return 'Tu email tiene dos puntos seguidos.';

    if (dominio.charAt(0) === '.') return 'Falta el dominio entre el @ y el punto.';
    if (dominio.charAt(dominio.length - 1) === '.') return 'Tu email no puede terminar con un punto.';
    if (dominio.indexOf('..') !== -1) return 'El dominio tiene dos puntos seguidos.';
    if (dominio.indexOf('.') === -1) {
      return 'Al dominio le falta la terminación (por ejemplo: ' + dominio + '.com).';
    }

    var etiquetas = dominio.split('.');
    for (var i = 0; i < etiquetas.length; i++) {
      var et = etiquetas[i];
      if (et.charAt(0) === '-' || et.charAt(et.length - 1) === '-') {
        return 'El dominio no puede empezar ni terminar con guión.';
      }
      if (et.length > 63) return 'Ese dominio es demasiado largo.';
    }

    var terminacion = etiquetas[etiquetas.length - 1];
    if (terminacion.length < 2) {
      return 'La terminación del email es muy corta (por ejemplo: .com, .ar).';
    }
    if (!/^[A-Za-z]+$/.test(terminacion)) {
      return 'La terminación del email solo puede tener letras (por ejemplo: .com).';
    }

    // Red de seguridad: si algo se nos escapó de los controles de arriba, no
    // pasa igual. El mensaje es genérico porque acá ya no sabemos qué es.
    if (!EMAIL_RE.test(email)) return 'Ese email no parece válido. Revisalo.';

    return null;
  }

  // Solo Gmail: el material se entrega dándole permiso de lectura sobre la
  // carpeta de Drive, y ese permiso se le da a una CUENTA DE GOOGLE. Con un
  // mail de Hotmail/Outlook/Yahoo el cobro saldría bien y el comprador no
  // podría abrir nada: cobrar algo que no se puede entregar es la peor forma
  // de fallar, así que se frena antes de pagar y no después.
  var DOMINIOS_GOOGLE = { 'gmail.com': 1, 'googlemail.com': 1 };

  // Devuelve por qué ese email no sirve para la entrega, o null si sirve.
  // Asume un email bien escrito: del formato se ocupa emailProblem().
  function gmailProblem(valor) {
    var email = String(valor == null ? '' : valor).trim();
    if (!email || emailProblem(email)) return null;

    var partes = email.split('@');
    var local = partes[0];
    var dominio = partes[1].toLowerCase();
    if (DOMINIOS_GOOGLE[dominio]) return null;

    // Si parece un Gmail mal tipeado, lo útil no es explicarle la regla sino
    // mostrarle el mail ya corregido.
    if (TYPOS_GMAIL[dominio]) {
      return '¿Quisiste decir ' + local + '@' + TYPOS_GMAIL[dominio] + '?';
    }
    return 'Tiene que ser un Gmail: el material se entrega por Google Drive y con '
      + dominio + ' no vas a poder abrirlo.';
  }

  // Todo lo que se exige para poder comprar, en un solo lugar: que el email
  // esté bien escrito Y que sea de Gmail.
  function deliveryEmailProblem(valor) {
    return emailProblem(valor) || gmailProblem(valor);
  }

  function validEmail(valor) {
    return emailProblem(valor) === null;
  }

  var api = {
    emailProblem: emailProblem,
    gmailProblem: gmailProblem,
    deliveryEmailProblem: deliveryEmailProblem,
    validEmail: validEmail,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // servidor (CommonJS)
  } else {
    raiz.emailProblem = emailProblem; // navegador
    raiz.gmailProblem = gmailProblem;
    raiz.deliveryEmailProblem = deliveryEmailProblem;
    raiz.validEmail = validEmail;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
