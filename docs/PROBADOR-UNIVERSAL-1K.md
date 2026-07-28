# Probador universal para campañas de hasta 1.000 webs

## Flujo implementado

Por cada web analizada:

1. El rastreador identifica productos y sus imágenes.
2. Se descartan accesorios incompatibles: zapatos, bolsos, sombreros, gafas y joyería.
3. Se selecciona una prenda compatible con mayor calidad de datos.
4. Se clasifica como `tops`, `bottoms` o `one-pieces`.
5. Se elige un modelo femenino o masculino según las señales del catálogo.
6. Se descarga la fotografía del producto.
7. Se envían persona y prenda al motor FASHN VTON.
8. Se guarda `tryon-sample.json` y, cuando el motor está disponible, `tryon-result.jpg`.
9. El informe puede mostrar producto, modelo y resultado sin utilizar una captura genérica.

## Configuración

El servicio de informes utiliza:

- `MIRA_TRYON_ENGINE_URL`
- `MIRA_TRYON_ENGINE_TOKEN`
- `MIRA_FEMALE_MODEL_IMAGE`
- `MIRA_MALE_MODEL_IMAGE`
- `MIRA_TRYON_TIMEOUT_MS`

Hay un ejemplo en `packages/api/.env.example`.

## Requisitos del motor entregado

El ZIP suministrado ejecuta FASHN VTON v1.5 mediante CUDA. Necesita:

- Linux o WSL2 preparado para Docker.
- GPU NVIDIA compatible.
- NVIDIA Container Toolkit.
- Pesos del modelo descargados.
- Espacio suficiente para los pesos y resultados.

El motor serializa las inferencias para evitar agotar la VRAM. Por ese motivo, una campaña de 1.000 webs debe ejecutarse como cola y no mediante 1.000 peticiones simultáneas.

## Funcionamiento sin GPU

Si el motor no está configurado, el informe no inventa un resultado. Genera `tryon-sample.json` con estado `planned`, producto seleccionado, categoría, género del modelo e imagen de la prenda. La inferencia puede ejecutarse más tarde en un equipo o servidor NVIDIA.

## Ejecución en un PC NVIDIA

El motor entregado está incluido en `tools/mira-fashn-engine`. En Windows con Docker Desktop, WSL2 y los controladores NVIDIA instalados, ejecuta `scripts/setup_mira_nvidia.ps1`. El asistente verifica la GPU, construye el contenedor, descarga los pesos, genera un token local e inicia el servicio.

La GPU se usa para las pruebas virtuales. El rastreo funciona en paralelo mediante `REPORT_CONCURRENCY`; las inferencias se procesan en cola para no agotar la memoria gráfica.

## Objetivo de 1.000 informes en 8 horas

Ocho horas equivalen a un máximo medio de 28,8 segundos por informe completo. El modo rápido limita el rastreo a tres páginas representativas y ejecuta 32 tiendas a la vez. La parte decisiva es la inferencia:

- 10 segundos por prueba: unas 2 h 47 min de GPU.
- 20 segundos por prueba: unas 5 h 34 min de GPU.
- 30 segundos por prueba: unas 8 h 20 min de GPU.

Por tanto, 1.000 en ocho horas es viable únicamente si la GPU concreta mantiene menos de 28 segundos por prueba de media y el rastreo se ejecuta simultáneamente. Antes de una campaña real debe hacerse un lote piloto de 20 tiendas y utilizar el tiempo medido.

## Excel y publicación

`scripts/run_mira_campaign.py` acepta hojas con columnas `Nombre`, `Página Web`, `Teléfono` y `Dirección`, elimina URLs duplicadas, inicia el lote y genera un archivo pequeño por negocio en `packages/web/public/campaign`.

Las direcciones finales usan `/mira/nombre-del-negocio`. Se publica una sola aplicación y hasta 1.000 archivos de datos; no se crean 1.000 aplicaciones independientes.

## Cobertura

- Camisetas, camisas, blusas, jerseys, chaquetas y blazers.
- Pantalones, vaqueros, faldas y shorts.
- Vestidos y monos.

No se presentan como compatibles zapatos, bolsos, sombreros, gafas o joyería.
