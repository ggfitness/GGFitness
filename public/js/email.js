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
//    emailProblem(valor) -> string con el problema concreto, o null si está bien.
//                           Bloquea la compra. Es lo que aplica el servidor.
//    emailHint(valor)    -> string con una sugerencia ("¿quisiste decir...?"),
//                           o null. NO bloquea: es una corazonada, y equivocarse
//                           no puede impedirle comprar a alguien con un dominio
//                           raro pero real.
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

  // Errores de tipeo frecuentes. Solo se usan para SUGERIR, nunca para
  // rechazar: "gmail.co" es un dominio real de Colombia y bloquearlo sería
  // impedirle comprar a alguien por una corazonada nuestra.
  var TYPOS = {
    'gmail.co': 'gmail.com',
    'gmail.con': 'gmail.com',
    'gmail.cm': 'gmail.com',
    'gmail.om': 'gmail.com',
    'gmail.copm': 'gmail.com',
    'gmial.com': 'gmail.com',
    'gmai.com': 'gmail.com',
    'gnail.com': 'gmail.com',
    'gmail.comm': 'gmail.com',
    'hotmail.con': 'hotmail.com',
    'hotmail.co': 'hotmail.com',
    'hotmial.com': 'hotmail.com',
    'hotmai.com': 'hotmail.com',
    'hotmail.comm': 'hotmail.com',
    'homail.com': 'hotmail.com',
    'outlook.con': 'outlook.com',
    'outlok.com': 'outlook.com',
    'outllok.com': 'outlook.com',
    'yahoo.con': 'yahoo.com',
    'yaho.com': 'yahoo.com',
    'yahooo.com': 'yahoo.com',
    'icloud.con': 'icloud.com',
    'iclould.com': 'icloud.com',
    'live.con': 'live.com',
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

  // Sugerencia amable para los errores de tipeo típicos. Solo tiene sentido
  // sobre un email que YA es válido: no bloquea nada.
  function emailHint(valor) {
    var email = String(valor == null ? '' : valor).trim();
    if (!email || emailProblem(email)) return null;

    var partes = email.split('@');
    var local = partes[0];
    var dominio = partes[1].toLowerCase();

    var correcto = TYPOS[dominio];
    if (correcto) return '¿Quisiste decir ' + local + '@' + correcto + '?';
    return null;
  }

  function validEmail(valor) {
    return emailProblem(valor) === null;
  }

  var api = { emailProblem: emailProblem, emailHint: emailHint, validEmail: validEmail };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // servidor (CommonJS)
  } else {
    raiz.emailProblem = emailProblem; // navegador
    raiz.emailHint = emailHint;
    raiz.validEmail = validEmail;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
