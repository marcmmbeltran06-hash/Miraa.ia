# Motor local Mira — FASHN VTON v1.5

Este servicio recibe las dos imágenes desde WordPress y ejecuta FASHN VTON en
un servidor privado. No envía las fotografías a Make ni a otra API de generación.

## Cobertura real

- `tops`: camisetas, camisas, blusas y chaquetas.
- `bottoms`: pantalones, faldas y pantalones cortos.
- `one-pieces`: vestidos y monos.

Calzado, sombreros, gafas, bolsos y joyería se rechazan expresamente. No se
transforman artificialmente en prendas porque produciría resultados engañosos.

## Instalación en Ubuntu con GPU NVIDIA

1. Instala Docker, Docker Compose y NVIDIA Container Toolkit.
2. Copia la carpeta `local-engine` al servidor.
3. Copia `.env.example` como `.env` y cambia el token.
4. Descarga los pesos:

   `docker compose run --rm mira-fashn python3.11 /app/fashn-vton/scripts/download_weights.py --weights-dir /app/weights`

5. Inicia el servicio:

   `docker compose up -d --build`

6. Comprueba desde el propio servidor:

   `curl -H "Authorization: Bearer TU_TOKEN" http://127.0.0.1:8000/health`

En WordPress configura `http://127.0.0.1:8000/v1/tryon` si ambos servicios
están en el mismo servidor. Si están separados, publica el servicio únicamente
detrás de HTTPS, firewall y autenticación.

## Calidad

El valor predeterminado usa 30 pasos, que es el equilibrio recomendado por el
proyecto. Para una prueba final de mayor calidad puede cambiarse
`MIRA_TIMESTEPS` a `50`; consumirá más tiempo y GPU.
