# Plantilla de informe personalizado Mira

## Qué hace la aplicación

La aplicación transforma el rastreo SEO y CRO de una web en un informe comercial personalizado y fácil de entender.

1. Rastrea las páginas públicas del negocio.
2. Resume el contexto del negocio y las páginas analizadas.
3. Separa los hallazgos SEO de los hallazgos CRO.
4. Asigna prioridad alta o media.
5. Explica la evidencia encontrada.
6. Propone una acción concreta.
7. Añade capturas o simulaciones de las mejoras de mayor impacto.
8. Publica el resultado en `/mira/nombre-del-negocio`.

## Datos obligatorios por negocio

- `slug`: nombre utilizado en el enlace.
- `name`: nombre comercial.
- `sector`: plantilla sectorial que corresponde.
- `website`: dominio analizado.
- `city`: ciudad o mercado principal.
- `analysis.summary`: resumen ejecutivo específico.
- `analysis.pagesAnalyzed`: cobertura real del rastreo.
- `analysis.seoScore`: puntuación SEO.
- `analysis.croScore`: puntuación CRO.
- `analysis.seo`: hallazgos SEO.
- `analysis.cro`: hallazgos CRO.
- `analysis.captures`: mejoras visualizadas.

## Estructura de cada hallazgo

- `title`: problema explicado en una frase.
- `detail`: por qué perjudica al negocio.
- `evidence`: qué encontró el programa en la web.
- `action`: qué proponemos hacer.
- `level`: prioridad alta o media.

## Estructura de cada captura

- `src`: imagen o captura.
- `eyebrow`: nombre de la mejora.
- `title`: beneficio principal.
- `text`: explicación sencilla.
- `improvements`: lista de cambios incluidos.

La plantilla visual no se duplica. Los datos de cada negocio alimentan siempre la misma estructura responsive.
