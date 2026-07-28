import argparse
import json
import os
from collections import Counter
from urllib.parse import unquote, urlparse

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether, HRFlowable, Image
)

NAVY = colors.HexColor("#091D2E")
INK = colors.HexColor("#17212B")
TEAL = colors.HexColor("#087F8C")
CYAN = colors.HexColor("#3DD6D0")
GOLD = colors.HexColor("#D5A94E")
RED = colors.HexColor("#D9534F")
AMBER = colors.HexColor("#F2A93B")
GREEN = colors.HexColor("#2A9D6F")
PALE = colors.HexColor("#F3F7F8")
MID = colors.HexColor("#D7E2E5")
WHITE = colors.white


def register_fonts():
    regular = r"C:\Windows\Fonts\arial.ttf"
    bold = r"C:\Windows\Fonts\arialbd.ttf"
    if os.path.exists(regular) and os.path.exists(bold):
        pdfmetrics.registerFont(TTFont("AutoWP", regular))
        pdfmetrics.registerFont(TTFont("AutoWP-Bold", bold))
        return "AutoWP", "AutoWP-Bold"
    return "Helvetica", "Helvetica-Bold"


FONT, FONT_BOLD = register_fonts()


def esc(value):
    return str(value or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def short_url(url):
    parsed = urlparse(url)
    path = unquote(parsed.path).strip("/")
    return "Inicio" if not path else path.replace("-", " ").title()


def page_header_footer(canvas, doc):
    canvas.saveState()
    if doc.page > 1:
        canvas.setFillColor(NAVY)
        canvas.rect(0, A4[1] - 13 * mm, A4[0], 13 * mm, fill=1, stroke=0)
        canvas.setFillColor(WHITE)
        canvas.setFont(FONT_BOLD, 8)
        canvas.drawString(16 * mm, A4[1] - 8.5 * mm, "AUTOWP · INFORME SEO + CRO")
        canvas.setFillColor(colors.HexColor("#697B84"))
        canvas.setFont(FONT, 8)
        canvas.drawString(16 * mm, 9 * mm, f"{doc.site_name} · Diagnóstico y plan de crecimiento")
        canvas.drawRightString(A4[0] - 16 * mm, 9 * mm, f"{doc.page}")
    canvas.restoreState()


class ReportDoc(BaseDocTemplate):
    def __init__(self, filename, site_name):
        super().__init__(
            filename, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm,
            topMargin=21 * mm, bottomMargin=16 * mm, title=f"Informe SEO y CRO - {site_name}",
            author="AutoWP Informes"
        )
        self.site_name = site_name
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="main")
        self.addPageTemplates(PageTemplate(id="all", frames=[frame], onPage=page_header_footer))


styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", fontName=FONT_BOLD, fontSize=24, leading=28, textColor=NAVY, spaceAfter=10)
H2 = ParagraphStyle("H2", fontName=FONT_BOLD, fontSize=16, leading=20, textColor=NAVY, spaceBefore=7, spaceAfter=8)
H3 = ParagraphStyle("H3", fontName=FONT_BOLD, fontSize=11, leading=14, textColor=TEAL, spaceBefore=5, spaceAfter=4)
BODY = ParagraphStyle("Body", fontName=FONT, fontSize=9.4, leading=14, textColor=INK, spaceAfter=6)
SMALL = ParagraphStyle("Small", fontName=FONT, fontSize=7.7, leading=10.5, textColor=INK)
WHITE_SMALL = ParagraphStyle("WhiteSmall", parent=SMALL, textColor=WHITE)
WHITE_BODY = ParagraphStyle("WhiteBody", parent=BODY, textColor=WHITE)
COVER_TITLE = ParagraphStyle("CoverTitle", fontName=FONT_BOLD, fontSize=34, leading=39, textColor=WHITE, spaceAfter=12)
COVER_KICKER = ParagraphStyle("CoverKicker", fontName=FONT_BOLD, fontSize=10, leading=13, textColor=CYAN, spaceAfter=8)
NUMBER = ParagraphStyle("Number", fontName=FONT_BOLD, fontSize=23, leading=25, textColor=NAVY, alignment=TA_CENTER)
LABEL = ParagraphStyle("Label", fontName=FONT, fontSize=7.5, leading=10, textColor=colors.HexColor("#53656E"), alignment=TA_CENTER)


def P(text, style=BODY):
    return Paragraph(esc(text), style)


def rich(text, style=BODY):
    return Paragraph(text, style)


def section_title(number, title, subtitle=None):
    out = [rich(f'<font color="#087F8C">{number}</font>  {esc(title)}', H1)]
    if subtitle:
        out.append(P(subtitle, BODY))
    out.append(HRFlowable(width="100%", thickness=1, color=MID, spaceAfter=9))
    return out


def metric(value, label, accent=TEAL):
    return Table(
        [[Paragraph(str(value), NUMBER)], [Paragraph(label, LABEL)]],
        colWidths=[41 * mm], rowHeights=[13 * mm, 11 * mm],
        style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), PALE),
            ("BOX", (0, 0), (-1, -1), 0.8, accent),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ])
    )


def callout(title, body, color=TEAL):
    return Table(
        [[rich(f"<b>{esc(title)}</b><br/>{esc(body)}", BODY)]],
        colWidths=[174 * mm],
        style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#EAF6F6")),
            ("LINEBEFORE", (0, 0), (0, -1), 4, color),
            ("BOX", (0, 0), (-1, -1), 0.5, MID),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 9),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
        ])
    )


def priority_card(priority, title, problem, action, impact, color):
    text = (
        f'<font color="{color.hexval()}"><b>{esc(priority)}</b></font> · <b>{esc(title)}</b><br/>'
        f'<b>Qué ocurre:</b> {esc(problem)}<br/>'
        f'<b>Qué haremos:</b> {esc(action)}<br/>'
        f'<b>Impacto esperado:</b> {esc(impact)}'
    )
    return Table([[rich(text, BODY)]], colWidths=[174 * mm], style=TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), WHITE),
        ("BOX", (0, 0), (-1, -1), 0.8, MID),
        ("LINEBEFORE", (0, 0), (0, -1), 5, color),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))


def build(report, output, hero_image=None):
    pages = report.get("pages", [])
    valid = [p for p in pages if 200 <= int(p.get("statusCode", 0)) < 400]
    broken = [p for p in pages if int(p.get("statusCode", 0)) >= 400]
    critical = report.get("criticalErrors", [])
    warnings = report.get("warnings", [])
    issue_counts = Counter(i.get("code", "OTRO") for p in pages for i in p.get("issues", []))
    duplicate_titles = report.get("summary", {}).get("duplicateTitles", [])
    duplicate_descriptions = report.get("summary", {}).get("duplicateDescriptions", [])
    entry_url = pages[0].get("url", "Web analizada") if pages else "Web analizada"
    hostname = urlparse(entry_url).hostname or "web"
    site_name = hostname.removeprefix("www.").split(".")[0].replace("-", " ").title()
    story = []

    cover = Table([[
        [
            Paragraph("AUDITORÍA INTEGRAL · 2026", COVER_KICKER),
            Paragraph(f"{esc(site_name)}<br/>SEO + CRO", COVER_TITLE),
            Paragraph("Diagnóstico completo de las URLs públicas descubiertas y plan combinado para atraer búsquedas con intención y convertirlas en consultas, citas y ventas.", WHITE_BODY),
            Spacer(1, 12 * mm),
            Paragraph("ANÁLISIS · PRIORIZACIÓN · PLAN 90 DÍAS · MEDICIÓN", COVER_KICKER),
        ]
    ]], colWidths=[178 * mm], rowHeights=[245 * mm], style=TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), NAVY),
        ("LEFTPADDING", (0, 0), (-1, -1), 18 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 18 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 32 * mm),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story += [cover, PageBreak()]

    story += section_title("01", "Resumen ejecutivo", "Qué hemos encontrado, por qué importa y dónde está la oportunidad principal.")
    story.append(Table([[
        metric(len(pages), "URLs públicas analizadas"),
        metric(len(valid), "Páginas válidas", GREEN),
        metric(len(broken), "URLs rotas", RED),
        metric(len(critical) + len(warnings), "Incidencias detectadas", AMBER),
    ]], colWidths=[44.5 * mm] * 4, style=TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")])))
    story += [Spacer(1, 6 * mm)]
    story.append(callout(
        "Conclusión clara",
        f"{site_name} tiene activos y contenidos aprovechables, pero el buscador recibe algunas señales repetidas o incompletas y el usuario no siempre encuentra un recorrido comercial suficientemente guiado. La prioridad no es “hacer más páginas”, sino conseguir que cada página responda a una necesidad y conduzca a un siguiente paso claro."
    ))
    story += [Spacer(1, 5 * mm)]
    story.append(priority_card("P0", "Reparar confianza y rastreo", "Las páginas legales enlazadas devuelven 404 y existen enlaces internos rotos.", "Corregir destinos, restaurar las páginas legales y validar todos los enlaces del menú y pie.", "Evitar pérdida de confianza, errores de rastreo y fricción antes del contacto.", RED))
    story.append(Spacer(1, 3 * mm))
    story.append(priority_card("P1", "Diferenciar cada intención", "Varias páginas comparten títulos y descripciones; seis páginas no presentan un H1 claro.", "Crear un título, una descripción, un H1 y una propuesta de valor propios para cada servicio.", "Mejor comprensión temática, snippets más relevantes y mayor coincidencia con la búsqueda.", AMBER))
    story.append(Spacer(1, 3 * mm))
    story.append(priority_card("P1", "Diseñar la conversión", "El sitio informa, pero no estructura de forma consistente el siguiente paso.", "CTA principal, prueba social, proceso, garantías y contacto rápido adaptados a cada servicio.", "Más usuarios avanzando desde inspiración a consulta o cita.", TEAL))
    story.append(PageBreak())

    story += section_title("02", "Cobertura real del rastreo", "Inventario completo de los documentos públicos encontrados siguiendo navegación y enlaces internos.")
    coverage = [[P("Estado", WHITE_SMALL), P("Página", WHITE_SMALL), P("Señales principales", WHITE_SMALL)]]
    issue_labels = {
        "TITLE_LENGTH": "Título mejorable", "H1_MISSING": "Falta H1",
        "OPEN_GRAPH_INCOMPLETE": "Vista social incompleta",
        "TWITTER_CARD_INCOMPLETE": "Tarjeta social incompleta",
        "DESCRIPTION_MISSING": "Falta descripción",
        "CANONICAL_MISSING": "Falta canonical", "HTTP_4XX": "Página rota",
        "BROKEN_LINKS": "Enlaces rotos", "IMAGES_WITHOUT_ALT": "Imágenes sin texto alternativo",
    }
    for page in pages:
        codes = Counter(i.get("code", "") for i in page.get("issues", []))
        signals = ", ".join(f"{issue_labels.get(code, code.replace('_', ' ').title())} ({count})" for code, count in codes.most_common(3)) or "Sin incidencias"
        coverage.append([
            P(str(page.get("statusCode", "")), SMALL),
            rich(f"<b>{esc(short_url(page.get('url')))}</b><br/><font color='#63747C'>{esc(page.get('url'))}</font>", SMALL),
            P(signals, SMALL),
        ])
    table = Table(coverage, colWidths=[17 * mm, 65 * mm, 96 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.5, MID), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PALE]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(table)
    story += [Spacer(1, 5 * mm), callout(
        "Qué significa “100%” en esta auditoría",
        f"Se analizaron las {len(pages)} URLs públicas que el rastreador pudo descubrir hasta agotar la cola interna: {len(valid)} respondieron correctamente y {len(broken)} devolvieron error. Una página completamente huérfana, sin enlaces ni sitemap, no puede descubrirse desde fuera; por eso recomendamos publicar y mantener un sitemap XML como control de inventario.",
        GOLD
    ), PageBreak()]

    story += section_title("03", "Diagnóstico SEO explicado", "No contamos errores sin contexto: relacionamos cada señal con una acción y un resultado esperado.")
    seo_actions = [
        ("CRÍTICO", "Enlaces y páginas 404", f"{issue_counts['HTTP_4XX']} respuestas 404 y {issue_counts['BROKEN_LINKS']} grupos de enlaces rotos.", "Restaurar privacidad y cookies; unificar HTTP→HTTPS; revisar menú, pie y enlaces de contacto.", "Rastreo limpio y confianza."),
        ("ALTO", "Arquitectura de títulos", f"{issue_counts['TITLE_LENGTH']} alertas de longitud y {len(duplicate_titles)} grupos duplicados.", "Mapa keyword-intención: alianzas, compromiso, joyas personalizadas, galería y contacto.", "Resultados de búsqueda diferenciados."),
        ("ALTO", "H1 y propuesta de página", f"{issue_counts['H1_MISSING']} páginas sin H1 claro.", "Un H1 por página que nombre el servicio y prometa un beneficio real.", "Claridad para Google y usuario."),
        ("ALTO", "Descripciones únicas", f"{issue_counts['DESCRIPTION_MISSING']} ausencias y {len(duplicate_descriptions)} grupo duplicado.", "Redactar snippets específicos con producto, ubicación/servicio y llamada a la acción.", "Más relevancia y potencial de clic."),
        ("MEDIO", "Imágenes y contexto", f"{issue_counts['IMAGES_WITHOUT_ALT']} páginas contienen imágenes sin alt.", "Alt descriptivo, compresión moderna, dimensiones y nombres de archivo útiles.", "Accesibilidad, contexto visual y velocidad."),
        ("MEDIO", "Open Graph y compartición", f"{issue_counts['OPEN_GRAPH_INCOMPLETE']} páginas incompletas.", "Título, descripción e imagen social propios por servicio.", "Mejor presentación en WhatsApp y redes."),
    ]
    rows = [[P("Prioridad", WHITE_SMALL), P("Área", WHITE_SMALL), P("Evidencia", WHITE_SMALL), P("Mejora", WHITE_SMALL), P("Objetivo", WHITE_SMALL)]]
    for item in seo_actions:
        rows.append([P(item[0], SMALL), P(item[1], SMALL), P(item[2], SMALL), P(item[3], SMALL), P(item[4], SMALL)])
    t = Table(rows, colWidths=[20 * mm, 32 * mm, 37 * mm, 57 * mm, 32 * mm], repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.45, MID), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PALE]),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(t)
    story += [Spacer(1, 5 * mm), callout("La puntuación no es el objetivo", "El 0/100 anterior era una resta mecánica de incidencias acumuladas y resultaba engañoso. El nuevo enfoque prioriza cobertura, gravedad e impacto comercial. Mediremos la mejora con errores resueltos, visibilidad por intención, clics orgánicos y conversiones.", GOLD), PageBreak()]

    story += section_title("04", "Plan CRO: convertir interés en acción", "Antes de comprar o contactar, una persona necesita entender la oferta, confiar y saber cuál es el siguiente paso. El recorrido debe eliminar dudas y facilitar esa decisión.")
    cro = [
        ("1 · Propuesta inmediata", "En la primera pantalla: qué ofrece la empresa, para quién es y por qué elegirla. Un botón principal con una acción concreta y un segundo camino para quien todavía necesita información."),
        ("2 · Prueba visual", "Ejemplos reales organizados por necesidad o servicio. Cada imagen debe explicar qué muestra y cómo se relaciona con la decisión del cliente."),
        ("3 · Confianza", "Proceso de trabajo, experiencia, equipo, materiales o método, garantías, opiniones verificables y respuestas a las dudas más frecuentes."),
        ("4 · Captación sin fricción", "Formulario corto, contacto rápido contextual y, cuando tenga sentido, reserva de cita. Mantener teléfono y datos esenciales visibles en móvil."),
        ("5 · Seguimiento", "Eventos para CTA, WhatsApp, teléfono, formulario iniciado/enviado y cita. Sin medición no puede saberse qué mejora convierte."),
    ]
    for title, body in cro:
        story.append(priority_card("CRO", title, body, "Crear el bloque, conectarlo con el CTA y medir su uso.", "Hipótesis validable mediante tasa de clic, inicio de formulario y contacto completado.", TEAL))
        story.append(Spacer(1, 2.5 * mm))
    story.append(PageBreak())

    story += section_title("05", "Combinaciones SEO + CRO", "La conversión crece cuando la promesa del resultado de búsqueda continúa sin ruptura dentro de la página.")
    combos = []
    for page in valid[:5]:
        name = short_url(page.get("url"))
        intent = f"Búsquedas relacionadas con {name.lower()} y la necesidad que resuelve"
        experience = "Titular claro, explicación sencilla, ejemplos, proceso, prueba de confianza, preguntas frecuentes y un botón de acción específico."
        conversion = "Consulta, contacto o compra"
        combos.append((name, intent, experience, conversion))
    combo_rows = [[P("Entrada", WHITE_SMALL), P("Intención", WHITE_SMALL), P("Experiencia que construiremos", WHITE_SMALL), P("Conversión", WHITE_SMALL)]]
    combo_rows += [[P(c, SMALL) for c in row] for row in combos]
    ct = Table(combo_rows, colWidths=[31 * mm, 42 * mm, 73 * mm, 32 * mm], repeatRows=1)
    ct.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.5, MID), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PALE]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story.append(ct)
    story += [Spacer(1, 5 * mm), callout("Principio de continuidad", "Keyword → snippet → titular → prueba → CTA. Cuando estos cinco elementos hablan de la misma necesidad, disminuye la fricción y aumenta la probabilidad de contacto.", CYAN), PageBreak()]

    story += section_title("06", "Embudo y medición", "Qué mediremos para saber si las mejoras generan negocio y no solo una web más bonita.")
    funnel = [
        ("VISIBILIDAD", "Impresiones por intención, cobertura indexada, consultas de marca/no marca"),
        ("INTERÉS", "CTR orgánico, entradas por landing, interacción con galería y proceso"),
        ("CONSIDERACIÓN", "Clic en CTA, WhatsApp, teléfono, formulario iniciado"),
        ("CONVERSIÓN", "Formulario enviado, cita reservada, llamada cualificada"),
        ("VALOR", "Presupuesto, venta y valor por categoría de servicio"),
    ]
    for idx, (stage, metrics) in enumerate(funnel):
        width = 174 - idx * 13
        story.append(Table([[rich(f"<b>{stage}</b><br/>{esc(metrics)}", WHITE_BODY)]], colWidths=[width * mm], hAlign="CENTER", style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), [NAVY, colors.HexColor("#0E4350"), TEAL, colors.HexColor("#1C9B91"), GREEN][idx]),
            ("TEXTCOLOR", (0, 0), (-1, -1), WHITE), ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ])))
        story.append(Spacer(1, 2 * mm))
    story += [Spacer(1, 4 * mm), callout("Evento principal recomendado", "Cita o consulta cualificada por servicio. Los clics ayudan a diagnosticar, pero la decisión debe basarse en contactos útiles y ventas atribuibles.", GOLD), PageBreak()]

    story += section_title("07", "Hoja de ruta de 90 días", "Ordenada por dependencia: primero saneamos, después construimos la propuesta y finalmente optimizamos con datos.")
    roadmap = [
        ("Días 1-15 · Base", "404 y enlaces; sitemap; títulos/H1/descripciones; canonical; analítica y eventos; velocidad básica.", "Rastreo limpio y medición fiable."),
        ("Días 16-35 · Páginas principales", "Reescritura de servicios o categorías prioritarias; CTA; proceso; preguntas frecuentes; prueba social.", "Coincidencia intención-página."),
        ("Días 36-60 · Confianza", "Ejemplos categorizados, casos reales, método, garantías, reseñas y contacto móvil.", "Menos incertidumbre comercial."),
        ("Días 61-90 · Optimización", "Comparar CTA, orden de bloques, formato de formularios y mensajes; reforzar páginas con tracción.", "Mejora basada en evidencia."),
    ]
    for title, actions, outcome in roadmap:
        story.append(priority_card("PLAN", title, actions, "Ejecutar, verificar y medir antes de pasar al siguiente bloque.", outcome, TEAL))
        story.append(Spacer(1, 3 * mm))
    story += [Spacer(1, 4 * mm), callout("Resultado esperado", "Un sistema continuo: las páginas atraen búsquedas concretas, demuestran especialización, conducen a una acción clara y permiten atribuir contactos y ventas. Los resultados comerciales son hipótesis a validar, no garantías.", GOLD)]

    os.makedirs(os.path.dirname(output), exist_ok=True)
    ReportDoc(output, site_name).build(story)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("report_json")
    parser.add_argument("output_pdf")
    parser.add_argument("--hero-image")
    args = parser.parse_args()
    with open(args.report_json, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    build(payload, args.output_pdf, args.hero_image)
