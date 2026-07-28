# Mira · instalación y uso en el segundo PC

Esta guía deja el segundo ordenador preparado para:

- analizar una web individual o el Excel completo;
- generar la demostración del probador virtual con una GPU NVIDIA;
- publicar cada informe como `https://www.miraia.space/nombre-negocio`;
- comprobar que el enlace existe antes de marcarlo como publicado;
- descargar una copia actualizada del Excel sin modificar el original.

## 1. Requisitos

- Windows 11 de 64 bits.
- Una gráfica NVIDIA Gigabyte o de otra marca compatible con CUDA.
- Al menos 16 GB de RAM; 32 GB recomendados.
- Espacio libre suficiente para Docker, modelos y resultados.
- Acceso de escritura al repositorio `marcmmbeltran06-hash/Miraa.ia`.

Docker Desktop es obligatorio para generar el probador virtual con la GPU. No es necesario para abrir únicamente la interfaz, pero sin Docker no se generarán las pruebas de ropa.

## 2. Primera instalación

### Paso A · Instalar WSL 2

Abre **PowerShell como administrador** y ejecuta:

```powershell
wsl --install
wsl --set-default-version 2
```

Reinicia Windows cuando termine. Después comprueba:

```powershell
wsl --status
wsl -l -v
```

La distribución instalada debe mostrar la versión `2`.

### Paso B · Instalar los programas necesarios

Abre otra vez **PowerShell como administrador**:

```powershell
winget install --exact --id Git.Git
winget install --exact --id GitHub.cli
winget install --exact --id Python.Python.3.11
winget install --exact --id Docker.DockerDesktop
winget install --exact --id CoreyButler.NVMforWindows
```

Reinicia Windows o cierra y abre PowerShell. Instala y activa Node.js 22:

```powershell
nvm install 22
nvm use 22
```

Comprueba las versiones:

```powershell
node --version
python --version
git --version
gh --version
docker --version
nvidia-smi
```

`node --version` debe comenzar por `v22`. `nvidia-smi` debe mostrar la gráfica NVIDIA.

Si `nvidia-smi` falla, actualiza primero el controlador desde NVIDIA y reinicia.

### Paso C · Configurar Docker Desktop

1. Abre Docker Desktop.
2. Acepta las condiciones de uso.
3. En **Settings → General**, activa **Use the WSL 2 based engine**.
4. En **Settings → Resources → WSL Integration**, activa la distribución instalada.
5. Pulsa **Apply & restart**.
6. Espera hasta que Docker indique que el motor está funcionando.

Comprueba Docker desde PowerShell:

```powershell
docker info
docker run --rm hello-world
```

No continúes si `docker info` devuelve un error.

## 3. Preparar el programa

Descomprime `Mira-campanas-otro-PC.zip` en una carpeta corta, por ejemplo:

```text
C:\Mira
```

Abre PowerShell dentro de esa carpeta. Puedes hacerlo desde el Explorador con clic derecho sobre la carpeta y **Abrir en Terminal**.

Permite ejecutar los archivos de preparación solo en esta ventana:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

Inicia sesión en GitHub:

```powershell
gh auth login
```

Elige:

1. `GitHub.com`
2. `HTTPS`
3. autenticación mediante navegador

Después ejecuta:

```powershell
.\CONECTAR-GITHUB.ps1
.\PREPARAR-OTRO-PC.ps1
.\scripts\setup_mira_nvidia.ps1
```

La preparación de NVIDIA construye el contenedor y descarga los modelos. La primera ejecución puede tardar y necesita conexión a Internet.

Comprueba el motor:

```powershell
docker compose -f .\tools\mira-fashn-engine\docker-compose.yml ps
Invoke-RestMethod http://127.0.0.1:8000/health
```

## 4. Abrir Mira cada día

Primero abre Docker Desktop y espera a que esté listo. Después, dentro de `C:\Mira`:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\INICIAR-MIRA.ps1
```

Se abrirá:

```text
http://127.0.0.1:5173
```

No cierres Docker Desktop ni apagues el PC mientras una campaña esté funcionando.

## 5. Hacer una prueba con una sola web

1. Abre la pestaña **Probar una web**.
2. Introduce la URL, el nombre del negocio y su teléfono.
3. Deja activado **Publicar en GitHub**.
4. Pulsa **Analizar y generar prueba**.
5. Comprueba el tiempo que tarda antes de iniciar las 1.830 webs.

## 6. Crear la campaña desde el Excel

1. Entra en **Crear desde Excel**.
2. Selecciona `Llamadas_desde_fila_78_movil_web_sin_ropa_infantil.xlsx`.
3. Indica el máximo de informes.
4. Deja activado **Publicar los resultados en GitHub**.
5. Pulsa **Iniciar campaña en paralelo**.

El archivo contiene 2.006 filas y 1.830 webs únicas válidas. Las webs repetidas reciben el mismo enlace.

Cuando termine:

- cada informe se envía a la rama `main`;
- Vercel actualiza `www.miraia.space`;
- el programa comprueba el JSON público;
- solo entonces rellena **Web creada**;
- **Texto junto mensaje** recibe el mensaje personalizado;
- aparece el botón **Descargar Excel actualizado**.

Ejemplo:

```text
https://www.miraia.space/casa-herrera
```

El Excel original permanece intacto y nunca se sube a GitHub porque contiene teléfonos.

## 7. Actualizar el programa en el futuro

Detén cualquier campaña antes de actualizar. Abre PowerShell en `C:\Mira`:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
git checkout main
git pull --ff-only origin main
.\PREPARAR-OTRO-PC.ps1
docker compose -f .\tools\mira-fashn-engine\docker-compose.yml build
docker compose -f .\tools\mira-fashn-engine\docker-compose.yml up -d
```

Después inicia normalmente:

```powershell
.\INICIAR-MIRA.ps1
```

Para actualizar WSL y los programas instalados:

```powershell
wsl --update
winget upgrade --all
```

Tras una actualización de Docker, Node, Python o del controlador NVIDIA, reinicia Windows.

## 8. Comandos de comprobación y solución de problemas

### Comprobar GitHub

```powershell
gh auth status
git remote -v
git branch --show-current
git status
```

La rama debe ser `main`.

### Comprobar Docker y NVIDIA

```powershell
docker info
nvidia-smi
docker compose -f .\tools\mira-fashn-engine\docker-compose.yml ps
docker compose -f .\tools\mira-fashn-engine\docker-compose.yml logs --tail 100
```

### Reiniciar el motor del probador

```powershell
docker compose -f .\tools\mira-fashn-engine\docker-compose.yml down
docker compose -f .\tools\mira-fashn-engine\docker-compose.yml up -d
```

### Revisar por qué no abre la interfaz

```powershell
Get-Content .\logs\api-error.log -Tail 100
Get-Content .\logs\web-error.log -Tail 100
```

### Comprobar los servicios

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
Invoke-RestMethod http://127.0.0.1:8000/health
```

### Si GitHub publica pero el dominio no cambia

```powershell
git status
git log -1
git push origin main
```

Comprueba también en Vercel que:

- el proyecto está conectado a `marcmmbeltran06-hash/Miraa.ia`;
- la rama de producción es `main`;
- el dominio `www.miraia.space` pertenece a ese proyecto;
- el último despliegue ha terminado correctamente.

El programa no marcará una URL en el Excel hasta que el dominio confirme que el informe está disponible.

## 9. Avisos comerciales configurados

- Solicitudes de información: `https://formspree.io/f/maqrvwvd`.
- Visitas consentidas de más de 30 segundos sin solicitud: `https://formspree.io/f/mbdnwrbg`.

Los avisos incluyen el nombre del negocio, teléfono asociado, web original y enlace del informe.
