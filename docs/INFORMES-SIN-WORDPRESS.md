# AutoWP Informes

El modo de informes reutiliza el rastreador, el analizador SEO/CRO y los
exportadores de AutoWP, pero no inicia Docker ni construye WordPress.

## Uso

1. Abre `/informes` en la aplicación web.
2. Escribe un nombre de cliente o campaña.
3. Pega entre 1 y 4.000 direcciones, una por línea.
4. Espera a que cada análisis termine.
5. Abre el informe web o descarga el PDF o el paquete completo.

## Dos niveles de análisis

- **Completo - recomendado:** recorre todas las páginas públicas que consigue
  descubrir, hasta 100 por web. Es el modo predeterminado para informes que se
  entregarán a un cliente.
- **Rápido para miles de webs:** revisa hasta 3 páginas por dominio. Permite
  mantener el objetivo de volumen, pero no debe presentarse como una auditoría
  completa.

El programa explica esta diferencia directamente en el formulario.

## Informe automático explicado

Todos los trabajos generan ahora:

- un informe web visual en español;
- un PDF profesional de ocho secciones;
- inventario de páginas y cobertura real;
- problemas traducidos a lenguaje sencillo;
- explicación de qué ocurre, qué cambiaremos y por qué ayuda;
- plan CRO para propuesta, confianza, contacto y medición;
- combinaciones SEO + CRO;
- embudo e indicadores;
- hoja de ruta de 90 días.

El PDF se guarda como `informe-seo-cro-profesional.pdf` dentro de la carpeta de
cada auditoría y se incluye en el ZIP final.

## API

- `POST /reports/batch` con `{ "urls": ["https://ejemplo.es"] }`.
- `GET /reports/:jobId/html`.
- `GET /reports/:jobId/pdf`.
- `GET /reports/:jobId/json`.
- `GET /reports/:jobId/csv`.
- `GET /reports/:jobId/zip`.

El endpoint histórico `POST /crawl` conserva el constructor WordPress. También
acepta `reportOnly: true` para generar únicamente los informes.

## Operación de 4.000 webs

Se puede abrir el programa con `INICIAR-INFORMES-4K.cmd`. La configuración
incluida ejecuta 32 webs simultáneas, inspecciona hasta 3 páginas por dominio y
limita cada dominio a 2 minutos.

- `REPORT_CONCURRENCY`: análisis simultáneos. Valor inicial: `32`.
- `REPORT_MAX_PAGES`: páginas inspeccionadas por web. Valor inicial: `3`.

Para completar 4.000 webs en 8 horas, el promedio total debe mantenerse por
debajo de 230 segundos por web con 32 trabajos simultáneos. Se recomienda hacer
primero una prueba de 100 webs y ajustar la concurrencia según memoria y CPU.

## Enlaces personales y aperturas

Cuando un informe termina, se puede indicar el destinatario y crear un enlace
personal. El visor:

- muestra un aviso visible sobre el registro de la apertura;
- guarda la fecha de apertura y un identificador técnico minimizado;
- no usa píxeles ocultos ni publicidad;
- actualiza automáticamente el estado en el panel.

Los enlaces y aperturas se conservan en `auditoria/report-shares.json`.
