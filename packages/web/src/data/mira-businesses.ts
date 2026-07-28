export type ReportFinding = {
  title: string;
  detail: string;
  evidence: string;
  action: string;
  level: 'high' | 'medium';
};

export type ReportCapture = {
  src: string;
  eyebrow: string;
  title: string;
  text: string;
  improvements: string[];
};

export type PersonalizedAnalysis = {
  summary: string;
  pagesAnalyzed: number;
  seoScore: number;
  croScore: number;
  seo: ReportFinding[];
  cro: ReportFinding[];
  captures: ReportCapture[];
  tryOn?: {
    productName: string;
    productPrice: string;
    personImage: string;
    productImage: string;
    resultImage: string;
  };
  marketing?: {
    customerName: string;
    customerInitials: string;
    scenarios: {
      interest: { signal: string; decision: string; message: string };
      cart: { signal: string; decision: string; message: string };
      return: { signal: string; decision: string; message: string };
    };
  };
};

export type MiraBusiness = {
  slug: string;
  name: string;
  sector: 'sastrerias' | 'tiendas';
  website?: string;
  phone?: string;
  city?: string;
  analysis: PersonalizedAnalysis;
};

// Esta lista puede generarse automaticamente desde un CSV con 1.500 negocios.
// Cada entrada utiliza la misma plantilla HTML.
export const miraBusinesses: MiraBusiness[] = [
  {
    slug: 'atelier-martin',
    name: 'Atelier Martin',
    sector: 'sastrerias',
    city: 'Madrid',
    website: 'https://atelier-martin.example',
    analysis: {
      summary: 'La web transmite oficio y calidad, pero obliga a llamar o escribir para avanzar. La oportunidad principal es transformar esa confianza en una cita confirmada y conservar mejor el conocimiento de cada cliente.',
      pagesAnalyzed: 14,
      seoScore: 58,
      croScore: 46,
      seo: [
        { title: 'Servicios poco diferenciados', detail: 'Cada servicio necesita una página propia para aparecer en búsquedas como arreglos, trajes a medida o primera prueba.', evidence: 'Varios servicios comparten el mismo contenido y no responden a búsquedas específicas.', action: 'Crear páginas por servicio, necesidad y ubicación.', level: 'high' },
        { title: 'Intención local mejorable', detail: 'Falta reforzar ciudad, zona, horarios y señales locales para captar búsquedas cercanas con intención de visita.', evidence: 'La ubicación no aparece de forma consistente en títulos y contenidos principales.', action: 'Optimizar SEO local y enlazar la ficha de Google Business.', level: 'medium' },
        { title: 'Contenido con poca profundidad', detail: 'Podemos explicar proceso, tejidos, tiempos y preguntas frecuentes para ganar relevancia y confianza.', evidence: 'Las páginas responden pocas dudas antes de solicitar una cita.', action: 'Añadir proceso, materiales, plazos y preguntas frecuentes.', level: 'medium' },
      ],
      cro: [
        { title: 'La cita exige demasiado esfuerzo', detail: 'El cliente debe cambiar de canal y esperar respuesta. Cada paso adicional reduce las reservas.', evidence: 'No existe selección directa de servicio, día y hora dentro de la web.', action: 'Instalar una reserva online en tres pasos.', level: 'high' },
        { title: 'No existe un siguiente paso dominante', detail: 'La llamada a reservar debe estar visible desde móvil en todo momento.', evidence: 'Los botones cambian entre páginas y compiten con acciones secundarias.', action: 'Unificar el CTA “Reservar cita” y mantenerlo fijo en móvil.', level: 'high' },
        { title: 'La experiencia no recuerda al cliente', detail: 'Medidas, preferencias e historial pueden convertir una visita aislada en una relación recurrente.', evidence: 'La información del cliente no se muestra conectada con citas y prendas.', action: 'Crear una ficha única de cliente con historial.', level: 'medium' },
      ],
      captures: [
        { src: '/mira-captures/sastreria-reservas.png', eyebrow: 'Mejora 01 · Reserva online', title: 'Una cita confirmada sin llamadas ni esperas.', text: 'Añadimos una reserva breve y clara dentro de la web. El cliente elige servicio, día y hora; el negocio recibe la cita organizada.', improvements: ['Botón fijo de reserva en móvil', 'Servicios y duración visibles', 'Confirmación y recordatorio por WhatsApp'] },
        { src: '/mira-captures/sastreria-clientes.png', eyebrow: 'Mejora 02 · Ficha de cliente', title: 'Cada medida y preferencia, preparada antes de la visita.', text: 'Una nueva pestaña reúne medidas, prendas, observaciones e historial para ofrecer una atención realmente personal.', improvements: ['Medidas fechadas y centralizadas', 'Preferencias de corte y tejido', 'Historial y próxima acción'] },
      ],
    },
  },
  {
    slug: 'boutique-amelia',
    name: 'Boutique Amelia',
    sector: 'tiendas',
    city: 'Barcelona',
    website: 'https://boutique-amelia.example',
    analysis: {
      summary: 'La tienda presenta bien el producto, pero la mayor barrera sigue siendo la duda: “¿cómo me quedará?”. La oportunidad es resolverla dentro de la ficha y devolver al usuario directamente a la compra.',
      pagesAnalyzed: 32,
      seoScore: 64,
      croScore: 51,
      seo: [
        { title: 'Fichas con poco contenido útil', detail: 'Las páginas de producto necesitan descripciones únicas, materiales, ajuste y respuestas sobre talla.', evidence: 'Las fichas repiten textos breves y apenas resuelven dudas de compra.', action: 'Generar contenido único por producto y guía de ajuste.', level: 'high' },
        { title: 'Categorías sin intención clara', detail: 'Podemos orientar títulos y textos a búsquedas reales por prenda, estilo, ocasión y temporada.', evidence: 'Los encabezados actuales describen la colección, pero no la búsqueda del cliente.', action: 'Reescribir categorías según intención y enlazado interno.', level: 'medium' },
        { title: 'Imágenes sin contexto SEO', detail: 'Conviene mejorar nombres, textos alternativos y rendimiento sin perder calidad visual.', evidence: 'Parte de las imágenes carece de una descripción útil para buscadores y accesibilidad.', action: 'Normalizar imágenes, alt text y formatos ligeros.', level: 'medium' },
      ],
      cro: [
        { title: 'La duda de talla frena la compra', detail: 'El usuario necesita verse con la prenda o entender mejor cómo le quedará.', evidence: 'La ficha ofrece talla y fotografía, pero no una ayuda visual personalizada.', action: 'Integrar el probador virtual junto al selector de talla.', level: 'high' },
        { title: 'El producto no recupera la conversación', detail: 'WhatsApp puede entregar el resultado y mantener un acceso directo a la ficha.', evidence: 'Si el visitante abandona, no existe continuidad vinculada a la prenda.', action: 'Entregar la simulación por WhatsApp con enlace al producto.', level: 'high' },
        { title: 'Falta una ayuda visual decisiva', detail: 'Un probador dentro de la ficha convierte curiosidad en participación y compra asistida.', evidence: 'La decisión depende de imaginar el resultado únicamente con fotos de modelo.', action: 'Mostrar una prueba personalizada en tres pasos.', level: 'medium' },
      ],
      captures: [
        { src: '/mira-captures/tienda-probador.png', eyebrow: 'Mejora 01 · Probador virtual', title: 'Del “¿me quedará bien?” a una respuesta visual.', text: 'Integramos el probador en la ficha: el cliente sube una foto, deja su WhatsApp y recibe la simulación sin perder el producto.', improvements: ['Proceso guiado en tres pasos', 'Resultado visual personalizado', 'Vuelta directa a talla y carrito'] },
      ],
      tryOn: {
        productName: 'Vestido Riviera',
        productPrice: '149 € · Talla M',
        personImage: '/tryon-demo/persona.png',
        productImage: '/tryon-demo/prenda.png',
        resultImage: '/tryon-demo/resultado.png',
      },
      marketing: {
        customerName: 'Marta Ruiz',
        customerInitials: 'MR',
        scenarios: {
          interest: {
            signal: 'Marta ha consultado varias veces el Vestido Riviera y ha usado el probador.',
            decision: 'Ofrecer ayuda con la talla mientras su interés sigue activo.',
            message: 'Hola, Marta. El Vestido Riviera sigue en tu selección. ¿Quieres que te ayudemos con la talla?',
          },
          cart: {
            signal: 'Ha añadido el Vestido Riviera al carrito, pero no ha terminado la compra.',
            decision: 'Resolver la última duda sin recurrir directamente a un descuento.',
            message: 'Hola, Marta. Tu Vestido Riviera sigue guardado. Si dudas con la talla o la entrega, te ayudamos por aquí.',
          },
          return: {
            signal: 'Compró hace 45 días y suele consultar vestidos de ocasión.',
            decision: 'Mostrar novedades relacionadas con su estilo, no una campaña genérica.',
            message: 'Hola, Marta. Hemos preparado una pequeña selección de vestidos que encajan con tu estilo. ¿Quieres verla?',
          },
        },
      },
    },
  },
  {
    slug: 'the-good-girl',
    name: 'The Good Girl',
    sector: 'tiendas',
    city: 'España',
    website: 'https://www.thegoodgirl.es',
    analysis: {
      summary: 'La tienda cuenta con un catálogo amplio, señales de confianza, pagos flexibles y buenas valoraciones. La oportunidad es convertir mejor la intención de compra reduciendo la duda sobre talla y ajuste con una prueba virtual real sobre productos del catálogo.',
      pagesAnalyzed: 1,
      seoScore: 71,
      croScore: 62,
      seo: [
        { title: 'Títulos de producto repetidos en la portada', detail: 'Algunos nombres se presentan más de una vez dentro de la misma superficie, lo que añade ruido semántico.', evidence: 'En el preanálisis de portada aparecen encabezados duplicados para varios productos de NEW IN.', action: 'Mantener un único encabezado semántico por tarjeta y ordenar correctamente la jerarquía.', level: 'medium' },
        { title: 'Colecciones con margen para captar búsquedas', detail: 'Las categorías pueden responder mejor a intención por tipo de prenda, ocasión, material y estilo.', evidence: 'La navegación separa bien las familias, pero el contenido visible de categoría es principalmente transaccional.', action: 'Añadir introducciones útiles, preguntas frecuentes y enlazado contextual por colección.', level: 'medium' },
        { title: 'Gran catálogo que exige control de indexación', detail: 'Variantes, filtros y países pueden multiplicar URLs y repartir la autoridad.', evidence: 'La tienda ofrece numerosos países, tallas, productos y superficies de colección.', action: 'Auditar canonicals, parámetros, sitemaps y páginas indexables en el rastreo completo.', level: 'high' },
      ],
      cro: [
        { title: 'La clienta todavía debe imaginar el resultado', detail: 'Las fotografías de modelo ayudan, pero no resuelven cómo quedará la prenda en otra persona.', evidence: 'La ficha y la portada muestran producto, talla y precio, pero no una visualización personalizada.', action: 'Añadir “Pruébatelo” junto a talla y compra usando una foto de la clienta.', level: 'high' },
        { title: 'La ayuda aparece después de la duda', detail: 'La atención al cliente existe, pero el apoyo puede llegar justo cuando la persona evalúa una prenda.', evidence: 'La web ofrece contacto y garantías generales; falta asistencia contextual por producto.', action: 'Entregar el resultado por WhatsApp con acceso directo a la prenda y ayuda de talla.', level: 'high' },
        { title: 'La recuperación puede ser más personal', detail: 'El comportamiento del probador permite distinguir curiosidad, intención alta y carrito abandonado.', evidence: 'La tienda dispone de newsletter y canales sociales, pero el recorrido observado no incorpora esta señal.', action: 'Activar mensajes consentidos según comportamiento, evitando campañas genéricas.', level: 'medium' },
      ],
      captures: [],
      tryOn: {
        productName: 'Chaqueta bomber DAFNE',
        productPrice: '129,99 € · producto real detectado',
        personImage: '/tryon-models/female-neutral.png',
        productImage: '/the-good-girl/chaqueta-bomber-dafne.webp',
        resultImage: '/the-good-girl/resultado-chaqueta-bomber-dafne.png',
      },
      marketing: {
        customerName: 'Lucía Romero',
        customerInitials: 'LR',
        scenarios: {
          interest: {
            signal: 'Lucía ha visto varias veces la Chaqueta bomber DAFNE y ha utilizado el probador.',
            decision: 'Ayudarla con la talla y devolverla a la ficha mientras mantiene interés.',
            message: 'Hola, Lucía ✨ La bomber DAFNE sigue en tu selección. ¿Quieres ver de nuevo cómo te queda o te ayudamos con la talla?',
          },
          cart: {
            signal: 'Ha añadido la Camisa rayas con lazada DIPA al carrito y no ha terminado la compra.',
            decision: 'Recordarle su look y resolver una posible duda de talla o entrega.',
            message: 'Hola, Lucía. Tu Camisa rayas con lazada DIPA sigue guardada. Completa tu look cuando quieras; si dudas con la talla, te ayudamos.',
          },
          return: {
            signal: 'Compró anteriormente y suele interesarse por prendas de NEW IN.',
            decision: 'Preparar una selección breve con productos reales afines a su estilo.',
            message: 'Hola, Lucía ✨ Hemos preparado una selección NEW IN muy de tu estilo: la Blusa estampada DORETTA y el Vaquero crudo DIAMANTINA. ¿Quieres verla?',
          },
        },
      },
    },
  },
];

export function findMiraBusiness(slug?: string) {
  return miraBusinesses.find((business) => business.slug === slug);
}
