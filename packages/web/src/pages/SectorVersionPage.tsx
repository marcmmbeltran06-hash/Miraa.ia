import { useEffect, useRef, useState } from 'react';
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

function sendFormspree(endpoint: string, event: Record<string, unknown>) {
  const payload = JSON.stringify({ ...event, sentAt: new Date().toISOString() });
  if (navigator.sendBeacon) {
    navigator.sendBeacon(endpoint, new Blob([payload], { type: 'application/json' }));
    return;
  }
  void fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true });
}

function EngagementTracker({ business }: { business: MiraBusiness }) {
  const [consent, setConsent] = useState(() => localStorage.getItem('mira-analytics-consent'));
  const startedAt = useRef(Date.now());
  const sessionId = useRef(crypto.randomUUID());
  const leadClicked = useRef(false);

  useEffect(() => {
    if (consent !== 'accepted') return;
    const endpoint = (import.meta.env.VITE_ENGAGEMENT_ENDPOINT as string | undefined) ?? 'https://formspree.io/f/mbdnwrbg';
    const markLead = () => { leadClicked.current = true; };
    window.addEventListener('mira:lead-clicked', markLead);
    const timer = window.setTimeout(() => {
      if (leadClicked.current) return;
      sendFormspree(endpoint, {
        tipo: 'Visita de más de 30 segundos sin solicitar información',
        sessionId: sessionId.current,
        negocio: business.name,
        telefonoNegocio: business.phone ?? 'No disponible',
        webNegocio: business.website ?? 'No disponible',
        informe: location.href,
        durationSeconds: Math.round((Date.now() - startedAt.current) / 1000),
      });
    }, 30_000);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mira:lead-clicked', markLead);
    };
  }, [business.name, business.phone, business.website, consent]);

  if (consent) return null;
  return (
    <aside className="analytics-consent">
      <div><b>Medición transparente</b><p>Con tu permiso mediremos esta visita y el tiempo de lectura para mejorar nuestros informes. No usamos publicidad ni seguimiento oculto.</p></div>
      <div><button onClick={() => { localStorage.setItem('mira-analytics-consent', 'declined'); setConsent('declined'); }}>Solo lo necesario</button><button className="primary" onClick={() => { localStorage.setItem('mira-analytics-consent', 'accepted'); setConsent('accepted'); }}>Aceptar medición</button></div>
    </aside>
  );
}

function LeadCapture({ business }: { business: MiraBusiness }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const endpoint = (import.meta.env.VITE_LEAD_ENDPOINT as string | undefined) ?? 'https://formspree.io/f/maqrvwvd';

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSending(true);
    setError('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          business: business.name,
          businessPhone: business.phone ?? 'No disponible',
          businessSlug: business.slug,
          sourceWebsite: business.website,
          contactName: data.get('contactName'),
          phone: data.get('phone'),
          page: location.href,
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
      {!open && <button onClick={() => setOpen(true)}>Soy de {business.name} y quiero más información</button>}
      {open && !sent && (
        <form onSubmit={submit}>
          <label>Tu nombre<input name="contactName" required autoComplete="name" /></label>
          <label>Teléfono<input name="phone" type="tel" required autoComplete="tel" /></label>
          <label className="lead-consent"><input name="consent" type="checkbox" required /> Acepto que Mira me contacte para explicarme esta propuesta.</label>
          {error && <p className="lead-error" role="alert">{error}</p>}
          <button disabled={sending}>{sending ? 'Enviando…' : 'Quiero que me llaméis'}</button>
        </form>
      )}
      {sent && <div className="lead-success"><span>✓</span><div><b>Solicitud recibida</b><p>Te llamaremos para explicarte las mejoras de {business.name}.</p></div></div>}
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
  return (
    <section className="tryon-demo">
      <div className="tryon-demo-heading">
        <p className="report-kicker">Demostración interactiva · probador virtual</p>
        <h2>Así viviría el cliente la prueba dentro de {businessName}.</h2>
        <p>La prenda se obtiene del catálogo de la tienda. La persona sube una fotografía y recibe una simulación con esa misma pieza de ropa.</p>
      </div>
      <div className="tryon-demo-shell">
        <div className="tryon-demo-progress">
          {[
            ['1', 'Sube su foto'],
            ['2', 'Elige la prenda'],
            ['3', 'Recibe el resultado'],
          ].map(([number, label], index) => (
            <button key={number} className={step === index + 1 ? 'active' : step > index + 1 ? 'done' : ''} onClick={() => setStep((index + 1) as 1 | 2 | 3)}>
              <span>{step > index + 1 ? '✓' : number}</span><b>{label}</b>
            </button>
          ))}
        </div>

        {step === 1 && (
          <div className="tryon-demo-stage">
            <div className="tryon-photo"><img src={demo.personImage} alt="Fotografía genérica de una cliente antes de probarse la prenda" /><span>Foto de la clienta</span></div>
            <div className="tryon-demo-copy"><small>Paso 1 de 3</small><h3>Sube una foto frontal.</h3><p>Sin registros ni aplicaciones. Desde el móvil, la persona selecciona una fotografía donde se vea el cuerpo completo.</p><button onClick={() => setStep(2)}>Simular subida de foto →</button><em>La demostración utiliza una persona genérica. En el uso real se emplearía la fotografía elegida por el cliente.</em></div>
          </div>
        )}

        {step === 2 && (
          <div className="tryon-demo-stage">
            <div className="tryon-photo product"><img src={demo.productImage} alt={`Producto ${demo.productName} del catálogo`} /><span>Producto del catálogo</span></div>
            <div className="tryon-demo-copy"><small>Paso 2 de 3</small><h3>{demo.productName}</h3><p>{demo.productPrice}. El producto seleccionado conserva su nombre, talla, precio y enlace real dentro de la tienda.</p><button onClick={() => setStep(3)}>Probar esta prenda →</button><em>Para cada informe podremos sustituir esta imagen por productos reales encontrados en la web analizada.</em></div>
          </div>
        )}

        {step === 3 && (
          <div className="tryon-demo-stage result">
            <div className="tryon-photo"><img src={demo.resultImage} alt={`Resultado virtual con ${demo.productName}`} /><span>Resultado generado</span></div>
            <div className="tryon-demo-copy"><small>Paso 3 de 3</small><h3>La clienta ya puede verse con la prenda.</h3><p>El resultado llega por WhatsApp junto al nombre del producto, la talla seleccionada y un enlace directo para volver a comprar.</p><div className="whatsapp-result"><span>✓</span><div><small>WhatsApp · resultado listo</small><b>{demo.productName} · Ver en tienda →</b></div></div><button className="secondary" onClick={() => setStep(1)}>Volver a empezar</button></div>
          </div>
        )}
      </div>
    </section>
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

  return (
    <div className="mira-report">
      <EngagementTracker business={business} />
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
        {analysis.tryOn && <TryOnDemo demo={analysis.tryOn} businessName={business.name} />}

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
