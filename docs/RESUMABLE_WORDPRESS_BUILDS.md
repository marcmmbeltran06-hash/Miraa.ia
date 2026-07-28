# Construcciones WordPress reanudables

## Causa raíz corregida

La API vigilaba el proceso completo del constructor con un temporizador único de
45 minutos. Ese límite no representaba un bloqueo real: en sitios grandes el
proceso podía seguir escribiendo recursos y páginas cuando la API lo terminaba.
El siguiente intento comenzaba demasiado trabajo de nuevo porque no existía un
contrato persistente de fases y lotes.

La construcción completa ya no tiene un límite de duración. Solo se conservan
límites para operaciones individuales potencialmente bloqueantes (una orden de
Docker, una petición de salud, una captura o una orden WP-CLI).

## Fases y checkpoints

Cada proyecto mantiene:

`<proyecto>/.autowp-build/checkpoint.json`

El documento usa esquema 2, se escribe primero en un archivo temporal, se
sincroniza a disco y después se renombra. Contiene:

- identificador, entrada y salida de la construcción;
- control `running`, `paused` o `cancelled`;
- actividad (`heartbeatAt`);
- fases `preparation`, `resources`, `snapshot`,
  `wordpress_generation`, `docker`, `wpcli` y `validation`;
- estado, error y fechas de cada fase;
- lotes con completados, total y último elemento.

La generación WordPress tiene checkpoints independientes para componentes,
estilos, navegación, SEO, comercio y tema. Los recursos se guardan por lotes y
el mapa de medios se escribe durante el proceso, por lo que una reanudación
continúa desde el siguiente recurso.

La API combina el checkpoint con `validation/builder-progress.json` y expone
fase, elementos, total, último elemento, velocidad, tiempo transcurrido,
estimación restante y última actividad.

## Idempotencia y recuperación

- Los recursos usan un mapa persistente y no se vuelven a añadir si ya están
  registrados.
- Las fases y subfases completadas se omiten al reanudar.
- La generación de WordPress y WP-CLI usan identificadores estables y
  operaciones de creación/actualización, no inserciones ciegas.
- Una fase Docker, WP-CLI o validación fallida conserva el proyecto y puede
  repetirse aisladamente.
- Un proyecto anterior con evidencia de aceptación se mueve a una copia
  conservada antes de preparar una salida nueva; no se elimina hasta que la
  nueva versión supera la validación.
- Los jobs antiguos sin esquema 2 migran las evidencias inequívocas
  (`media-map.json`, snapshot y artefactos WordPress). Docker, WP-CLI y la
  validación en vivo se vuelven a comprobar porque no se pueden inferir de un
  archivo estático.

## Configuración

| Variable | Valor inicial | Función |
|---|---:|---|
| `AUTOWP_BUILD_BATCH_SIZE` | `50` | Lote de inventario/páginas/productos |
| `AUTOWP_RESOURCE_BATCH_SIZE` | `50` | Lote de recursos |
| `AUTOWP_HTML_CACHE_PAGES` | `8` | Máximo de HTML de páginas en memoria |
| `AUTOWP_DOCKER_CPUS` | sin límite explícito | CPU por servicio Docker |
| `AUTOWP_DOCKER_MEMORY` | sin límite explícito | Memoria por servicio Docker, p. ej. `2g` |
| `AUTOWP_DOCKER_OPERATION_TIMEOUT_MS` | `180000` | Una orden Docker |
| `AUTOWP_OPERATION_RETRIES` | `3` | Intentos de operaciones transitorias |
| `AUTOWP_OPERATION_RETRY_DELAY_MS` | `1000` | Espera progresiva inicial |
| `AUTOWP_BUILDER_STALL_TIMEOUT_MS` | `0` | Inactivo; si se configura, solo actúa sin heartbeat |

El constructor usa un único worker por job. Los lotes, la caché HTML y los
límites de Docker permiten ajustar consumo sin cargar el sitio completo en
memoria.

## Pausar, reanudar y cancelar

Desde la interfaz del job se puede pausar, reanudar o cancelar la construcción.
También están disponibles:

```powershell
Invoke-RestMethod -Method Post "http://127.0.0.1:3000/crawl/JOB_ID/pause-build"
Invoke-RestMethod -Method Post "http://127.0.0.1:3000/crawl/JOB_ID/resume-build"
Invoke-RestMethod -Method Post "http://127.0.0.1:3000/crawl/JOB_ID/cancel-build"
```

Reanudar un job `build_failed_recoverable` usa el mismo endpoint de reanudación
o el botón **Reintentar construcción**. No repite el rastreo ni las
exportaciones: reutiliza `auditoria/JOB_ID` y `generated-sites/JOB_ID`.

## Estado y heartbeat

```powershell
Invoke-RestMethod "http://127.0.0.1:3000/crawl/JOB_ID" |
  Select-Object status,builderStatus,builderProgress,builderError |
  Format-List
```

Mientras el worker está vivo, la API actualiza
`.autowp-build/process-heartbeat.json` cada 15 segundos. Un proceso puede ser
lento y continuar activo; no se cancela por el tiempo total. Solo un umbral de
inactividad configurado explícitamente puede declararlo bloqueado.

## Limitaciones reales

- El tiempo total sigue dependiendo del volumen, disco, red y recursos
  asignados a Docker Desktop.
- Una fuente bloqueada o incompleta no puede convertirse en una réplica válida;
  la validación debe mantener el estado de revisión o reconstrucción.
- Los timeouts por captura, orden Docker, salud de WordPress y validación visual
  siguen siendo deliberadamente finitos para detectar operaciones bloqueadas.
- El checkpoint evita repetir trabajo confirmado, pero una subfase que terminó
  justo antes de escribir su checkpoint se repite de forma idempotente.

