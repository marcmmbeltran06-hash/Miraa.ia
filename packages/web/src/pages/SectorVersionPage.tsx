import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  findMiraBusiness,
  miraBusinesses,
  type MiraBusiness,
  type PersonalizedAnalysis,
  type ReportFinding,
} from '../data/mira-businesses.ts';
import './mira-report.css';

function BrandMark() {
  return <span className="report-orb" aria-hidden="true" />;
}

function EngagementTracker({ business }: { business: MiraBusiness }) {
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const leadEndpoint = (import.meta.env.VITE_LEAD_ENDPOINT as string | undefined) ?? 'https://formspree.io/f/maqrvwvd';
  const engagementEndpoint = (import.meta.env.VITE_ENGAGEMENT_ENDPOINT as string | undefined) ?? 'https://formspree.io/f/mbdnwrbg';

  useEffect(() => {
    let leadRequested = false;
    const markLead = () => { leadRequested = true; };
    window.addEventListener('mira:lead-clicked', markLead);
    const timer = window.setTimeout(() => {
      if (leadRequested) return;
      void fetch(engagementEndpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          tipo: 'Visita de más de 30 segundos sin solicitar información',
          business: business.name,
          businessPhone: business.phone ?? 'No disponible',
          businessSlug: business.slug,
          sourceWebsite: business.website ?? 'No disponible',
          page: location.href,
          seconds: 30,
          occurredAt: new Date().toISOString(),
          privacy: 'Medición sin cookies; aviso visible en la página',
        }),
        keepalive: true,
      }).catch(() => undefined);
    }, 30_000);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mira:lead-clicked', markLead);
    };
  }, [business, engagementEndpoint]);

  async function requestInformation() {
    if (sending || sent) return;
    setSending(true);
    setError('');
    try {
      const response = await fetch(leadEndpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          tipo: 'Solicitud de información con un clic',
          business: business.name,
          businessPhone: business.phone ?? 'No disponible',
          businessSlug: business.slug,
          sourceWebsite: business.website ?? 'No disponible',
          page: location.href,
          occurredAt: new Date().toISOString(),
          message: `${business.name} con teléfono ${business.phone ?? 'no disponible'} ha pulsado “Quiero más información”.`,
        }),
      });
      if (!response.ok) throw new Error('Lead endpoint rejected the request');
      setSent(true);
      window.dispatchEvent(new Event('mira:lead-clicked'));
    } catch {
      setError('No hemos podido enviar la solicitud. Inténtalo de nuevo.');
    } finally {
      setSending(false);
    }
  }

  return (
    <aside className="analytics-consent quick-lead">
      {!sent && <>
        <div><b>¿Quieres vender más con estas mejoras?</b><p>Te explicamos la propuesta preparada para {business.name}.</p></div>
        <div><button className="primary" type="button" disabled={sending} onClick={() => void requestInformation()}>{sending ? 'Enviando…' : 'Quiero más información'}</button></div>
      </>}
      {error && <p className="lead-error" role="alert">{error}</p>}
      {sent && <div className="quick-lead-success"><span>✓</span><div><b>Solicitud recibida</b><p>Te llamaremos en unos minutos.</p></div></div>}
    </aside>
  );
}

function LeadCapture({ business }: { business: MiraBusiness }) {
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const endpoint = (import.meta.env.VITE_LEAD_ENDPOINT as string | undefined) ?? 'https://formspree.io/f/maqrvwvd';

  async function requestInformation() {
    if (sending || sent) return;
    setSending(true);
    setError('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          tipo: 'Solicitud de información con un clic',
          business: business.name,
          businessPhone: business.phone ?? 'No disponible',
          businessSlug: business.slug,
          sourceWebsite: business.website ?? 'No disponible',
          page: location.href,
          occurredAt: new Date().toISOString(),
          message: `${business.name} con teléfono ${business.phone ?? 'no disponible'} ha pulsado “Quiero más información”.`,
        }),
      });
      if (!response.ok) throw new Error('Lead endpoint rejected the request');
      setSent(true);
      window.dispatchEvent(new Event('mira:lead-clicked'));
    } catch {
      setError('No hemos podido enviar la solicitud. Inténtalo de nuevo en unos segundos.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="lead-section" id="contacto">
      <p className="report-kicker">¿Quieres aplicar estas mejoras?</p>
      <h2>Convierte este análisis en un plan de ventas para {business.name}.</h2>
      {!sent && <button type="button" disabled={sending} onClick={() => void requestInformation()}>{sending ? 'Enviando…' : `Soy de ${business.name} y quiero más información`}</button>}
      {error && <p className="lead-error" role="alert">{error}</p>}
      {sent && <div className="lead-success"><span>✓</span><div><b>Solicitud recibida</b><p>Te llamaremos en unos minutos.</p></div></div>}
      <p className="measurement-note">Medición técnica sin cookies: registramos si esta propuesta permanece abierta más de 30 segundos para mejorar el seguimiento comercial.</p>
    </section>
  );
}

function FindingCard({ kind, item }: { kind: 'findability' | 'sales'; item: ReportFinding }) {
  return (
    <article className="finding-card">
      <div><span>{kind === 'findability' ? 'PARA QUE TE ENCUENTREN' : 'PARA QUE TE COMPREN'}</span><i className={item.level}>{item.level === 'high' ? 'Prioridad alta' : 'Prioridad media'}</i></div>
      <h3>{item.title}</h3>
      <p>{item.detail}</p>
      <details>
        <summary>Ver por qué lo decimos</summary>
        <div className="finding-proof"><span>Evidencia detectada</span><p>{item.evidence}</p></div>
        <div className="finding-action"><span>Qué haremos</span><p>{item.action}</p></div>
      </details>
    </article>
  );
}

function ApplicationDefinition() {
  return (
    <section className="application-definition">
      <div className="definition-heading">
        <p className="report-kicker">Qué es este informe</p>
        <h2>Un análisis que explica, sin tecnicismos, dónde se pierden ventas y cómo recuperarlas.</h2>
      </div>
      <div className="definition-steps">
        <article><span>01</span><h3>Analizamos</h3><p>El programa rastrea las páginas públicas, productos, estructura, contenidos, llamadas a la acción y recorrido móvil.</p></article>
        <article><span>02</span><h3>Interpretamos</h3><p>Separamos lo que impide que nuevos clientes te encuentren de lo que les impide reservar, contactar o comprar.</p></article>
        <article><span>03</span><h3>Visualizamos</h3><p>Convertimos cada hallazgo prioritario en una mejora explicada y una captura que muestra cómo podría quedar.</p></article>
      </div>
      <div className="definition-note"><b>No es un informe genérico.</b> El nombre, las puntuaciones, evidencias, prioridades, recomendaciones y capturas pertenecen al negocio mostrado en este enlace.</div>
    </section>
  );
}

function SalesApplications() {
  const applications = [
    ['01', 'Atraer a más personas', 'Mejoramos las páginas para que aparezcan cuando alguien busca exactamente los productos o servicios que vendes.'],
    ['02', 'Resolver dudas antes', 'Explicamos mejor talla, ajuste, materiales, entrega y devoluciones para evitar que la visita abandone.'],
    ['03', 'Probar antes de comprar', 'La clienta puede verse con una prenda real del catálogo y volver directamente a su ficha.'],
    ['04', 'Recuperar compras', 'Si una persona deja una prenda en el carrito, recibe ayuda útil y personalizada con su permiso.'],
    ['05', 'Vender por WhatsApp', 'La asesora continúa la conversación con el producto, la talla y el contexto correctos.'],
    ['06', 'Conseguir que vuelvan', 'Usamos compras e intereses previos para recomendar novedades que sí encajan con cada clienta.'],
  ];
  return (
    <section className="sales-applications">
      <div className="section-heading">
        <p className="report-kicker">Cómo se convierte en más ventas</p>
        <h2>Mejoras que acompañan a la clienta desde que busca hasta que vuelve a comprar.</h2>
        <p>No necesitas saber qué significan SEO o CRO. Cada mejora responde a una pregunta sencilla: ¿ayuda a que te descubran, confíen y compren?</p>
      </div>
      <div className="sales-app-grid">
        {applications.map(([number, title, text]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{text}</p></article>)}
      </div>
    </section>
  );
}

function TryOnDemo({ demo, businessName }: { demo: NonNullable<PersonalizedAnalysis['tryOn']>; businessName: string }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const productSpecificResult = demo.resultKind === 'generated_product_specific' || (!demo.resultKind && Boolean(demo.resultImage));
  const catalogProductDetected = demo.resultKind === 'catalog_product_detected';
  const genericResult = demo.resultKind === 'generic_female' || demo.resultKind === 'generic_male';
  const versionLabel = demo.resultKind === 'generic_male'
    ? 'Versión genérica masculina'
    : demo.resultKind === 'generic_female'
      ? 'Versión genérica femenina'
      : catalogProductDetected
        ? 'Producto real detectado en el catálogo'
        : 'Demostración personalizada';

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setStep((current) => (current === 3 ? 1 : current + 1) as 1 | 2 | 3);
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [step]);

  return (
    <section className="tryon-demo">
      <div className="tryon-demo-heading">
        <p className="report-kicker">Demostración interactiva · probador virtual</p>
        <h2>Así viviría el cliente la prueba dentro de {businessName}.</h2>
        <p>No se envía a la clienta a otra aplicación. El probador se integra dentro de la ficha de producto de la propia tienda, conserva su diseño y devuelve a la compra cuando termina la prueba.</p>
        <span className="tryon-version-badge">{versionLabel} · secuencia automática</span>
      </div>
      <div className="tryon-embed-explainer">
        <article><span>Dentro de la ficha</span><b>La clienta pulsa «Pruébatelo» junto a talla y compra.</b></article>
        <i>→</i>
        <article><span>Sin salir de la web</span><b>Se abre un panel adaptado al móvil con foto, prenda y resultado.</b></article>
        <i>→</i>
        <article><span>Vuelta a la venta</span><b>Puede elegir talla, añadir al carrito o pedir ayuda por WhatsApp.</b></article>
      </div>
      <div className="tryon-demo-shell">
        <div className="tryon-demo-progress">
          {[
            ['1', 'Sube su foto a la web'],
            ['2', 'Elige el producto'],
            ['3', 'Lo recibe por WhatsApp'],
          ].map(([number, label], index) => (
            <div key={number} className={step === index + 1 ? 'active' : step > index + 1 ? 'done' : ''}>
              <span>{step > index + 1 ? '✓' : number}</span><b>{label}</b>
            </div>
          ))}
        </div>

        {step === 1 && (
          <div className="tryon-demo-stage">
            <div className="tryon-upload-card">
              <div className="tryon-window-bar"><i /><i /><i /><b>Probador dentro de la tienda</b></div>
              <div className="tryon-upload-zone">
                <div className="tryon-photo"><img src={demo.personImage} alt="Fotografía genérica de una cliente antes de probarse la prenda" /><span>Vista previa</span></div>
                <div className="tryon-file-info"><strong>foto-prueba.jpg</strong><small>Imagen preparada · cuerpo completo</small><div><span /></div><em>100% subida</em></div>
              </div>
              <p><span>✓</span> La clienta acepta generar esta prueba antes de continuar.</p>
            </div>
            <div className="tryon-demo-copy"><small>Paso 1 de 3 · dentro de la ficha de producto</small><h3>La clienta toca «Pruébatelo» y sube su foto.</h3><p>Se abre una ventana integrada en la tienda, sin registros ni descargas. En móvil puede usar la cámara o seleccionar una fotografía frontal de cuerpo completo.</p><div className="tryon-auto-note"><span />La demostración avanza sola</div><em>La imagen se utiliza para crear la prueba solicitada. La versión definitiva deberá informar del tratamiento y del tiempo de conservación antes de aceptar la fotografía.</em></div>
          </div>
        )}

        {step === 2 && (
          <div className="tryon-demo-stage">
            <div className="tryon-product-panel">
              <div className="tryon-window-bar"><i /><i /><i /><b>Producto conectado al catálogo</b></div>
              <div className="tryon-photo product"><img src={demo.productImage} alt={`Producto ${demo.productName} del catálogo`} /><span>{genericResult ? 'Ejemplo identificado' : 'Producto real detectado'}</span></div>
              <div className="tryon-product-controls"><strong>{demo.productName}</strong><div><span>XS</span><span className="selected">S</span><span>M</span><span>L</span></div><p><i /> Aplicando producto y variante a la fotografía…</p></div>
            </div>
            <div className="tryon-demo-copy"><small>Paso 2 de 3 · selección conectada al catálogo</small><h3>{demo.productName}</h3><p>{demo.productPrice}. {genericResult ? 'Esta prenda pertenece exclusivamente a la demostración y no se presenta como producto real de la tienda.' : 'El sistema recibe desde la ficha el producto real, su variante, talla, precio y enlace; la clienta no tiene que buscarlo de nuevo.'}</p><div className="tryon-auto-note"><span />Aplicando la prenda a la fotografía</div><em>Cuando existe una fotografía de producto compatible se utiliza esa prenda. Si no puede verificarse, el informe lo identifica claramente como ejemplo genérico.</em></div>
          </div>
        )}

        {step === 3 && (
          <div className="tryon-demo-stage result">
            <div className="tryon-result-panel">
              <div className="tryon-window-bar"><i /><i /><i /><b>Resultado dentro de la ficha</b></div>
              <div className={`tryon-photo ${catalogProductDetected ? 'catalog-processing' : ''}`}>
                <img src={demo.resultImage ?? (catalogProductDetected ? demo.personImage : demo.productImage)} alt={productSpecificResult ? `Simulación virtual generada con ${demo.productName}` : catalogProductDetected ? `Producto real preparado para el probador de ${businessName}` : `Demostración genérica del probador para ${businessName}`} />
                {catalogProductDetected && <img className="tryon-garment-chip" src={demo.productImage} alt={`Prenda real ${demo.productName}`} />}
                <span>{productSpecificResult ? 'Simulación visual generada' : catalogProductDetected ? 'Producto real · generación preparada' : genericResult ? 'Ejemplo genérico' : 'Demostración propuesta'}</span>
              </div>
              <div className="tryon-whatsapp-phone">
                <div className="tryon-wa-header"><span>{businessName.slice(0, 1)}</span><div><b>{businessName}</b><small>Asistente de la tienda · en línea</small></div><i>•••</i></div>
                <div className="tryon-wa-chat">
                  <p>Hola, tu prueba virtual ya está lista. Así puedes ver cómo quedaría la prenda que has elegido.</p>
                  <div className="tryon-wa-result"><img src={demo.resultImage ?? demo.productImage} alt={`Resultado enviado por WhatsApp para ${demo.productName}`} /><strong>{demo.productName}</strong><small>Resultado de muestra · talla S</small><button>Volver a la ficha del producto</button></div>
                  <em>Entregado ✓✓</em>
                </div>
                <div className="tryon-wa-compose"><span>＋</span><p>Escribe un mensaje</p><b>➤</b></div>
              </div>
              <div className="tryon-result-actions"><button>Elegir otra talla</button><button className="primary">Añadir al carrito</button><button>Hablar con una asesora</button></div>
            </div>
            <div className="tryon-demo-copy"><small>Paso 3 de 3 · entrega por WhatsApp</small><h3>La clienta recibe su resultado y vuelve directamente a comprar.</h3><p>Cuando la prueba termina, el asistente envía un mensaje de WhatsApp al número autorizado por la clienta. El mensaje incluye la imagen, el nombre del producto y un enlace directo a su ficha para elegir talla, comprar o pedir ayuda.</p><div className="whatsapp-result"><span>✓</span><div><small>Resultado entregado con contexto de compra</small><b>{demo.productName} · talla · ficha · ayuda</b></div></div><div className="tryon-auto-note"><span />La secuencia volverá a comenzar</div><em>WhatsApp solo se utiliza cuando la persona facilita su número y acepta recibir el resultado por este canal.</em></div>
          </div>
        )}
      </div>
    </section>
  );
}

function FloatingTryOnPreview({ demo, businessName }: { demo: NonNullable<PersonalizedAnalysis['tryOn']>; businessName: string }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const isMale = demo.resultKind === 'generic_male';
  const customer = isMale ? 'el cliente' : 'la clienta';
  const category = isMale ? 'Moda masculina' : 'Moda femenina';
  const productNames = isMale
    ? ['Camisa de colección', 'Chaqueta de temporada', 'Pantalón de vestir', 'Look casual']
    : ['Vestido de colección', 'Chaqueta de temporada', 'Look para eventos', 'Nueva incorporación'];
  const [selectedProduct, setSelectedProduct] = useState(productNames[0]);

  function close() {
    setOpen(false);
    setStep(1);
  }

  return (
    <>
      <button className="floating-tryon-launcher" onClick={() => setOpen(true)}>
        <span>✦</span><div><b>Conoce el probador virtual</b><small>{category} · demostración</small></div>
      </button>
      <div className={`floating-tryon-shade ${open ? 'open' : ''}`} onClick={close} />
      <aside className={`floating-tryon-drawer ${open ? 'open' : ''}`} aria-hidden={!open}>
        <header className="floating-tryon-header">
          <div><span>PROBADOR VIRTUAL</span><b>{businessName} · experiencia integrada</b></div>
          <button onClick={close} aria-label="Cerrar probador">×</button>
        </header>
        <ol className="floating-tryon-progress">
          {[
            ['1', 'Sube su foto'],
            ['2', 'Elige y prueba'],
            ['3', 'WhatsApp'],
          ].map(([number, label], index) => {
            const itemStep = (index + 1) as 1 | 2 | 3;
            return <li key={number} className={step === itemStep ? 'active' : step > itemStep ? 'done' : ''}><span>{step > itemStep ? '✓' : number}</span><b>{label}</b></li>;
          })}
        </ol>
        <div className="floating-tryon-guide">
          <span>PASO {step} DE 3 · {category.toUpperCase()}</span>
          <h2>{step === 1 ? `${customer} sube su fotografía.` : step === 2 ? 'Elige una prenda y pulsa «Probar».' : 'El resultado llega por WhatsApp.'}</h2>
          <p>{step === 1
            ? 'La ficha se abre sobre la web real, sin abandonar el momento de compra.'
            : step === 2
              ? `Mostraremos únicamente productos de ${category.toLowerCase()} cuando el informe corresponda a esta categoría.`
              : 'La prueba, el producto y el enlace de compra llegan juntos para facilitar la vuelta al carrito.'}</p>
        </div>

        {step === 1 && <section className="floating-tryon-panel">
          <div className="floating-tryon-reason"><span>↗</span><div><b>Por qué convierte más</b><small>La acción es breve y ocurre cuando ya existe intención de compra.</small></div></div>
          <div className="floating-upload-preview"><img src={demo.personImage} alt={`Modelo de demostración para ${category.toLowerCase()}`} /><span>FOTO PREPARADA</span></div>
          <div className="floating-file-row"><i>✓</i><div><b>foto-modelo.jpg</b><small>Imagen lista para utilizar</small></div></div>
          <button className="floating-primary" onClick={() => setStep(2)}>Siguiente: elegir producto →</button>
        </section>}

        {step === 2 && <section className="floating-tryon-panel">
          <div className="floating-tryon-reason"><span>↗</span><div><b>Por qué convierte más</b><small>{customer} compara prendas sin abandonar la tienda ni perder el contexto.</small></div></div>
          <div className="floating-product-grid">
            {productNames.map((name, index) => <article key={name} className={selectedProduct === name ? 'selected' : ''}>
              <div><img src={demo.productImage} alt={`${name} · ${category}`} />{index === 0 && <span>RECOMENDADO</span>}</div>
              <b>{name}</b><small>{category} · tallas disponibles</small>
              <button onClick={() => { setSelectedProduct(name); setStep(3); }}>PROBAR ESTA PRENDA</button>
            </article>)}
          </div>
          <button className="floating-secondary" onClick={() => setStep(1)}>← Volver a la fotografía</button>
        </section>}

        {step === 3 && <section className="floating-tryon-panel">
          <div className="floating-tryon-reason"><span>↗</span><div><b>Por qué convierte más</b><small>WhatsApp recupera la conversación cuando la duda principal ya está resuelta.</small></div></div>
          <div className="floating-result-summary"><img src={demo.resultImage ?? demo.personImage} alt={`Resultado de ${selectedProduct}`} /><div><span>PRUEBA COMPLETADA</span><b>{selectedProduct}</b><small>{category} · talla y enlace de compra incluidos</small></div></div>
          <div className="floating-whatsapp">
            <header><i>‹</i><span>{businessName.slice(0, 1)}</span><div><b>{businessName}</b><small>Asistente de la tienda · en línea</small></div><strong>⌕ · ⋮</strong></header>
            <main><div><p>¡Hola! Ya está lista tu prueba con <b>{selectedProduct}</b> ✨</p><img src={demo.resultImage ?? demo.personImage} alt="" /><button>VER PRODUCTO Y ELEGIR TALLA</button><small>12:42 · <span>✓✓</span></small></div></main>
            <footer><i>＋</i><span>Mensaje</span><b>➤</b></footer>
          </div>
          <button className="floating-primary">Volver a la tienda y comprar →</button>
          <button className="floating-secondary" onClick={() => setStep(2)}>← Probar otro producto</button>
        </section>}
      </aside>
    </>
  );
}

function MarketingAutomation({ business }: { business: MiraBusiness }) {
  const [scenario, setScenario] = useState<'interest' | 'cart' | 'return'>('interest');
  const fallbackScenarios = {
    interest: {
      signal: 'Ha visto el Vestido Riviera 4 veces y ha utilizado el probador.',
      decision: 'Enviar ayuda de talla y recuperar la conversación mientras el interés está activo.',
      message: 'Hola, Ana. Hemos visto que te gustó el Vestido Riviera. ¿Quieres que te ayudemos con la talla? Aquí tienes de nuevo tu prueba.',
    },
    cart: {
      signal: 'Ha añadido la prenda al carrito, pero no ha terminado la compra.',
      decision: 'Recordar la prenda y resolver la última duda sin aplicar descuentos innecesarios.',
      message: 'Tu Vestido Riviera sigue guardado. Si tienes alguna duda sobre talla o entrega, te ayudamos por aquí.',
    },
    return: {
      signal: 'Compró hace 45 días y suele interesarse por vestidos de ocasión.',
      decision: 'Recomendar novedades relevantes, evitando campañas masivas y repetitivas.',
      message: 'Hola, Ana. Han llegado dos vestidos que encajan con el estilo de tu última compra. ¿Quieres verlos?',
    },
  };
  const marketing = business.analysis.marketing ?? {
    customerName: 'Laura García',
    customerInitials: 'LG',
    scenarios: fallbackScenarios,
  };
  const scenarios = marketing.scenarios;
  const active = scenarios[scenario];
  return (
    <section className="automation-section">
      <div className="automation-copy">
        <p className="report-kicker">Mejora 02 · Asistente comercial inteligente</p>
        <h2>Una asesora digital que reconoce el interés y ayuda a cerrar la venta.</h2>
        <p>El sistema interpreta el comportamiento consentido del cliente —productos vistos, uso del probador, carrito y compras— y propone una acción comercial personalizada.</p>
        <ul><li><span>✓</span>Detecta intención real de compra</li><li><span>✓</span>Evita mensajes genéricos</li><li><span>✓</span>Activa marketing por WhatsApp con consentimiento</li></ul>
      </div>
      <div className="automation-console">
        <div className="automation-bar"><i /><i /><i /><b>Asistente comercial · {business.name}</b><span>Activo</span></div>
        <div className="automation-person">
          <div className="automation-avatar">{marketing.customerInitials}</div><div><small>Clienta detectada</small><b>{marketing.customerName}</b><span>Interés alto · WhatsApp autorizado</span></div>
        </div>
        <div className="scenario-tabs">
          <button className={scenario === 'interest' ? 'active' : ''} onClick={() => setScenario('interest')}>Interés</button>
          <button className={scenario === 'cart' ? 'active' : ''} onClick={() => setScenario('cart')}>Carrito</button>
          <button className={scenario === 'return' ? 'active' : ''} onClick={() => setScenario('return')}>Fidelización</button>
        </div>
        <div className="behavior-block"><small>Comportamiento observado</small><p>{active.signal}</p></div>
        <div className="decision-block"><small>Decisión recomendada por Mira</small><p>{active.decision}</p></div>
        <div className="wa-preview"><span>WA</span><div><small>Mensaje personalizado</small><p>{active.message}</p></div></div>
        <div className="automation-consent">Solo se envía si el cliente ha aceptado comunicaciones por WhatsApp.</div>
      </div>
    </section>
  );
}

function ReportPage() {
  const { businessSlug } = useParams<{ sector?: string; businessSlug?: string }>();
  const requestedBusiness = findMiraBusiness(businessSlug);
  const [campaignBusiness, setCampaignBusiness] = useState<MiraBusiness | null>(null);
  const [campaignMissing, setCampaignMissing] = useState(false);
  useEffect(() => {
    if (!businessSlug || requestedBusiness) return;
    let active = true;
    fetch(`/campaign/${encodeURIComponent(businessSlug)}.json`)
      .then((response) => {
        if (!response.ok) throw new Error('not found');
        return response.json() as Promise<MiraBusiness>;
      })
      .then((value) => { if (active) setCampaignBusiness(value); })
      .catch(() => { if (active) setCampaignMissing(true); });
    return () => { active = false; };
  }, [businessSlug, requestedBusiness]);
  const business = (requestedBusiness?.sector === 'tiendas' ? requestedBusiness : campaignBusiness) as MiraBusiness | null;
  if (!business && !campaignMissing) return <div className="campaign-loading">Preparando el informe personalizado…</div>;
  if (!business) return <div className="campaign-loading">No hemos encontrado este informe.</div>;
  const analysis: PersonalizedAnalysis = business.analysis;
  const floatingTryOnEnabled = Boolean(analysis.tryOn);

  return (
    <div className="mira-report">
      <EngagementTracker business={business} />
      {floatingTryOnEnabled && analysis.tryOn && <FloatingTryOnPreview demo={analysis.tryOn} businessName={business.name} />}
      <header className="report-nav">
        <Link to="/versiones" className="report-brand"><BrandMark /><span>mira</span></Link>
        <span className="report-nav-label">Informe personalizado · diseñado para vender más</span>
        <a href="#propuesta">Ver propuesta</a>
      </header>

      <main>
        <section className="business-hero">
          <p className="report-kicker">Hemos preparado este informe para mejorar la web de</p>
          <h1>{business.name}</h1>
          <p className="business-introduction">Hemos realizado un análisis exhaustivo de tu web para conseguir que <b>más personas te encuentren, entiendan tu propuesta y terminen comprando.</b> A continuación te mostramos qué frena hoy las ventas y cómo lo solucionaremos.</p>
          <p className="business-summary">{analysis.summary}</p>
          <div className="business-context">
            {business.website && <span>{business.website.replace('https://', '')}</span>}
            {business.city && <span>{business.city}</span>}
            <span>{business.sector === 'tiendas' ? 'Tienda de moda' : 'Sastrería'}</span>
          </div>
          <div className="hero-meta score-meta">
            <span className="pages-score"><b>{analysis.pagesAnalyzed}</b> páginas analizadas</span>
            <span className="score-now"><small>Ahora · te encuentran</small><b>{analysis.seoScore}/100</b> visibilidad</span>
            <span className="score-target"><small>Con Mira · objetivo</small><b>100/100</b> te encuentran</span>
            <span className="score-now"><small>Ahora · te compran</small><b>{analysis.croScore}/100</b> capacidad de venta</span>
            <span className="score-target"><small>Con Mira · objetivo</small><b>100/100</b> conviertes</span>
          </div>
          <p className="score-disclaimer">100/100 representa el objetivo de optimización de la propuesta; el resultado final se valida después de implementar y medir las mejoras.</p>
          <div className="scroll-note">Desliza para entender el análisis <span>↓</span></div>
        </section>

        <ApplicationDefinition />
        {analysis.tryOn && !floatingTryOnEnabled && <TryOnDemo demo={analysis.tryOn} businessName={business.name} />}

        <SalesApplications />

        <section className="diagnosis-section">
          <div className="section-heading">
            <p className="report-kicker">Diagnóstico del negocio</p>
            <h2>Qué hemos detectado<br />y por qué importa.</h2>
            <p>Cada observación incluye la evidencia encontrada y la acción concreta que proponemos.</p>
          </div>
          <div className="diagnosis-grid">
            <div className="diagnosis-column">
              <div className="diagnosis-title"><span>01</span><div><b>Que te encuentren</b><small>Atraer a personas que ya buscan lo que vendes</small></div></div>
              {analysis.seo.map((item) => <FindingCard key={item.title} kind="findability" item={item} />)}
            </div>
            <div className="diagnosis-column">
              <div className="diagnosis-title"><span>02</span><div><b>Que te compren</b><small>Convertir más visitas en pedidos reales</small></div></div>
              {analysis.cro.map((item) => <FindingCard key={item.title} kind="sales" item={item} />)}
            </div>
          </div>
        </section>

        <section className="proposal-intro" id="propuesta">
          <p className="report-kicker">Propuesta personalizada</p>
          <h2>No te decimos solamente qué falla.<br /><em>Te enseñamos cómo lo mejoraríamos.</em></h2>
        </section>

        <section className="impact-section">
          <p className="report-kicker">Qué conseguiremos</p>
          <h2>Más visibilidad, menos dudas<br />y más oportunidades de venta.</h2>
          <div className="impact-grid">
            <article><strong>TE ENCUENTRAN</strong><h3>Atraer mejor</h3><p>Más páginas relevantes para búsquedas reales, mejor estructura y contenido más útil.</p></article>
            <article><strong>TE ELIGEN</strong><h3>Convencer mejor</h3><p>Mensajes, pruebas visuales y acciones claras en los puntos donde hoy aparece la duda.</p></article>
            <article><strong>VENDES MÁS</strong><h3>Mejorar con datos</h3><p>Medimos pruebas, contactos y compras para saber qué acciones generan ventas de verdad.</p></article>
          </div>
          <div className="report-disclaimer">Esta propuesta utiliza datos del análisis de {business.name}. Las capturas son simulaciones transparentes de mejoras todavía no publicadas.</div>
        </section>

        {analysis.tryOn && <MarketingAutomation business={business} />}
        <LeadCapture business={business} />
      </main>
    </div>
  );
}

export function SectorVersionPage() {
  return <ReportPage />;
}

export function VersionsIndexPage() {
  return (
    <div className="mira-report versions-page">
      <header className="report-nav"><span className="report-brand"><BrandMark /><span>mira</span></span><span className="report-nav-label">Plantillas de informes personalizados</span></header>
      <main className="versions-main">
        <p className="report-kicker">Una aplicación · un informe diferente para cada negocio</p>
        <h1>Informes sencillos para<br /><em>vender más.</em></h1>
        <p className="versions-description">La aplicación rastrea una web, identifica qué limita su visibilidad y conversión, prioriza los problemas y genera una propuesta personalizada con evidencias, acciones y capturas.</p>
        <div className="version-links">
          {miraBusinesses.filter((business) => business.sector === 'tiendas').map((business, index) => (
            <Link to={`/mira/${business.slug}`} key={business.slug}>
              <span>0{index + 1}</span><small>{business.sector === 'tiendas' ? 'Tienda de moda' : 'Sastrería'}</small>
              <h2>{business.name}</h2><p>{business.analysis.pagesAnalyzed} páginas · Visibilidad {business.analysis.seoScore}/100 · Capacidad de venta {business.analysis.croScore}/100</p><b>→</b>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
