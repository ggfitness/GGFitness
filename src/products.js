// Catálogo de productos, definido en código (fuente única de verdad).
// Para cambiar precios o textos: editás acá y volvés a deployar.
//
// ⚠️ ACÁ NO VAN LINKS DE DRIVE. Este archivo se sube a GitHub, así que un link
// de material acá sería material regalado. Las carpetas de los packs se
// configuran en la variable de entorno DRIVE_FOLDERS (ver .env.example y
// src/delivery.js): al aprobarse el pago, el servidor le da acceso de lectura
// a la cuenta del comprador. Un producto sin carpeta = servicio a medida.
//
// ⚠️ PRECIOS: los valores de abajo son de referencia. Revisalos/ajustalos según
// lo que quieras cobrar por cada pack antes de publicar.
module.exports = [
  {
    id: 'pack-mentalidad',
    name: 'Pack Mentalidad',
    description: '10 claves para transformar tu mentalidad y sostener el cambio en el tiempo.',
    tagline: 'Cambiá tu mentalidad para sostener cualquier transformación.',
    details:
      'El trabajo empieza en la cabeza. Este pack te da las herramientas para construir una nueva ' +
      'identidad, tomar responsabilidad y crear los hábitos que te sostienen aunque no siempre estés motivado.',
    includes: [
      'Tu nueva identidad',
      'Responsabilidad absoluta',
      'De espectador a creador',
      'No siempre estarás motivado',
      'Tu entorno te define',
      'No abandones antes del milagro',
      'Cambia tu diálogo interno',
      'Eleva tus estándares',
      'Actuar en coherencia',
      'Creer para ver',
    ],
    forWho: [
      'Querés dejar de empezar y abandonar',
      'Buscás constancia y disciplina real',
      'Necesitás cambiar tu diálogo interno',
      'Estás listo/a para tomar responsabilidad',
    ],
    price: 12000,
    image: '🧠',
    // Foto del plan (opcional). Poné un archivo en public/img/ y la ruta acá,
    // ej: '/img/mentalidad.jpg'. Si la dejás vacía, se muestra el emoji de arriba.
    photo: '',
  },
  {
    id: 'pack-recetas-fit',
    name: 'Pack Recetas FIT',
    description: 'Recetas saludables, simples y ricas para comer bien todos los días.',
    tagline: 'Comé rico y saludable con recetas fáciles para el día a día.',
    details:
      'Un recetario completo para que comer sano deje de ser aburrido. Desde ensaladas y sándwiches ' +
      'saludables hasta postres con frutas, panes low carb y aderezos, todo simple y realista.',
    includes: [
      'Ensaladas',
      'Tarteletas',
      'Sándwiches saludables',
      'Ensaladas de frutas y postres con frutas',
      'Licuados energéticos y detox',
      'Omelettes',
      'Tortillas dulces y saladas FIT',
      'Pan low carb',
      'Wraps',
      'Aderezos saludables',
      'Pizzas FIT',
    ],
    forWho: [
      'Querés comer sano sin aburrirte',
      'No sabés qué cocinar cada día',
      'Buscás recetas simples y rápidas',
      'Preferís comida real y rica',
    ],
    price: 12000,
    image: '🥗',
    photo: '/img/nutricion.jpg',
  },
  {
    id: 'pack-rutinas-tren-inferior',
    name: 'Pack Rutinas Tren Inferior',
    description: 'Rutinas de piernas y glúteos en 3 niveles: principiante, intermedio y avanzado.',
    tagline: 'Piernas y glúteos: rutinas para principiante, intermedio y avanzado.',
    details:
      'Un pack completo de tren inferior con progresiones para cada nivel. Trabajás cuádriceps, ' +
      'femorales, glúteos y gemelos para ganar fuerza y tonificar de forma progresiva.',
    includes: [
      'Niveles: principiante, intermedio y avanzado',
      'Cuádriceps',
      'Femorales',
      'Glúteos',
      'Gemelos',
      'Beneficios de hacer movilidad antes del ejercicio',
      'Ejemplos de activación',
    ],
    forWho: [
      'Querés enfocarte en piernas y glúteos',
      'Buscás progresar según tu nivel',
      'Entrenás en casa o en el gimnasio',
      'Cualquier nivel: hay progresiones',
    ],
    price: 12000,
    image: '🦵',
    photo: '/img/full-body.jpg',
  },
  {
    id: 'pack-rutinas-tren-superior',
    name: 'Pack Rutinas Tren Superior',
    description: 'Rutinas de espalda, pecho, hombros y brazos en 3 niveles.',
    tagline: 'Tren superior: rutinas para principiante, intermedio y avanzado.',
    details:
      'Un pack completo de tren superior con progresiones para cada nivel. Trabajás espalda, pecho, ' +
      'hombros, bíceps y tríceps para ganar fuerza y tonificar de forma progresiva.',
    includes: [
      'Niveles: principiante, intermedio y avanzado',
      'Espalda',
      'Pecho',
      'Hombros',
      'Bíceps y Tríceps',
      'Beneficios de ejercicios hipopresivos',
    ],
    forWho: [
      'Querés enfocarte en el tren superior',
      'Buscás progresar según tu nivel',
      'Entrenás en casa o en el gimnasio',
      'Cualquier nivel: hay progresiones',
    ],
    price: 12000,
    image: '💪',
    photo: '',
  },
  {
    id: 'entrenamiento-personalizado-online',
    name: 'Entrenamiento Personalizado Online',
    description: 'Plan personalizado + nutrición + seguimiento en la app, 100% online.',
    tagline: 'Tu plan de entrenamiento y nutrición a medida, con seguimiento en la app.',
    details:
      'Un plan totalmente personalizado según tus objetivos, tu disponibilidad y tu estado físico. ' +
      'Escribime por WhatsApp y armamos tu rutina y tu alimentación a medida. Después seguimos todo ' +
      'desde la app: ahí tenés tus rutinas, cargás cada serie y vemos tu progreso los dos.',
    includes: [
      'Plan personalizado',
      'Nutrición',
      'Seguimiento en la app',
      'Rutinas en el celular: marcás series, reps y peso',
      'Ves tu progreso entrenamiento a entrenamiento',
    ],
    forWho: [
      'Querés algo 100% personalizado',
      'Buscás resultados con acompañamiento',
      'Preferís entrenar desde donde estés',
      'Querés seguimiento cercano, con todo registrado',
    ],
    price: 100000,
    currency: 'ARS', // 'USD' o 'ARS'
    period: 'mes', // etiqueta de precio (ej: /mes). Dejá null si es pago único.
    image: '🏆',
    photo: '/img/personalizado.jpg',
    // El único camino de compra: se consulta por WhatsApp.
    // El link lo arma el servidor con WHATSAPP_NUMBER (ver .env.example).
    whatsapp: true,
    // No se vende por la web: primero se habla por WhatsApp y el pago se
    // coordina por fuera. El servidor lo rechaza si igual se intenta
    // (ver resolveCart en src/server.js).
    soloConsulta: true,
  },
  {
    id: 'entrenamiento-personalizado-presencial',
    name: 'Entrenamiento Personalizado Presencial',
    description: 'Plan personalizado + nutrición + seguimiento + sesiones presenciales.',
    tagline: 'Todo el acompañamiento del online, más sesiones presenciales conmigo.',
    details:
      'La experiencia más completa: un plan totalmente personalizado con nutrición, seguimiento en ' +
      'la app y sesiones de entrenamiento presencial (en la zona). ' +
      'Escribime por WhatsApp y coordinamos todo a tu medida.',
    includes: [
      'Plan personalizado',
      'Nutrición',
      'Seguimiento en la app',
      'Rutinas en el celular: marcás series, reps y peso',
      'Ves tu progreso entrenamiento a entrenamiento',
      'Sesiones presenciales (en la zona)',
    ],
    forWho: [
      'Querés el máximo acompañamiento',
      'Buscás entrenar presencial en la zona',
      'Preferís que te corrijan la técnica en persona',
      'Estás decidido/a a comprometerte al 100%',
    ],
    price: 260000,
    currency: 'ARS', // 'USD' o 'ARS'
    period: 'mes', // etiqueta de precio (ej: /mes). Dejá null si es pago único.
    image: '🤝',
    photo: '/img/personalizado.jpg',
    // El único camino de compra: se consulta por WhatsApp.
    whatsapp: true,
    // No se vende por la web: primero se habla por WhatsApp y el pago se
    // coordina por fuera. El servidor lo rechaza si igual se intenta
    // (ver resolveCart en src/server.js).
    soloConsulta: true,
  },
  {
    id: 'plan-3-meses',
    name: 'Plan x 3 Meses',
    description: 'Acompañamiento personalizado durante 3 meses, con seguimiento continuo.',
    tagline: 'Tres meses de acompañamiento para consolidar el cambio.',
    details:
      'Un plan de 3 meses para que el cambio se sostenga: entrenamiento y nutrición personalizados, ' +
      'con ajustes mes a mes según cómo vas progresando.',
    includes: [
      'Plan de entrenamiento personalizado',
      'Plan de nutrición personalizado',
      'Seguimiento en la app',
      'Rutinas en el celular: marcás series, reps y peso',
      'Ves tu progreso entrenamiento a entrenamiento',
      'Ajustes del plan cada mes',
      'Duración: 3 meses',
    ],
    forWho: [
      'Querés un compromiso de mediano plazo',
      'Buscás ajustes según tu progreso',
      'Preferís pagar el período completo',
      'Necesitás acompañamiento sostenido',
    ],
    price: 280000,
    currency: 'ARS',
    period: null, // pago único por el período completo
    // El único camino de compra: se consulta por WhatsApp.
    whatsapp: true,
    // No se vende por la web: primero se habla por WhatsApp y el pago se
    // coordina por fuera. El servidor lo rechaza si igual se intenta
    // (ver resolveCart en src/server.js).
    soloConsulta: true,
    image: '📅',
    photo: '/img/personalizado.jpg',
  },
  {
    id: 'plan-6-meses',
    name: 'Plan x 6 Meses',
    description: 'Acompañamiento personalizado durante 6 meses, con seguimiento continuo.',
    tagline: 'Seis meses de acompañamiento para una transformación completa.',
    details:
      'El plan más largo y el de mejor valor por mes: 6 meses de entrenamiento y nutrición ' +
      'personalizados, con ajustes continuos.',
    includes: [
      'Plan de entrenamiento personalizado',
      'Plan de nutrición personalizado',
      'Seguimiento en la app',
      'Rutinas en el celular: marcás series, reps y peso',
      'Ves tu progreso entrenamiento a entrenamiento',
      'Ajustes del plan cada mes',
      'Duración: 6 meses',
    ],
    forWho: [
      'Buscás una transformación real y duradera',
      'Querés el mejor precio por mes',
      'Estás decidido/a a comprometerte',
      'Preferís no renovar mes a mes',
    ],
    price: 550000,
    currency: 'ARS',
    period: null, // pago único por el período completo
    // El único camino de compra: se consulta por WhatsApp.
    whatsapp: true,
    // No se vende por la web: primero se habla por WhatsApp y el pago se
    // coordina por fuera. El servidor lo rechaza si igual se intenta
    // (ver resolveCart en src/server.js).
    soloConsulta: true,
    image: '🏅',
    photo: '/img/personalizado.jpg',
  },
];
