# Asistente de WhatsApp Mira

Este programa prepara una cola de revisión usando el Excel de Mira.

## Qué hace

- Lee `Teléfono`, `Texto junto mensaje` y `Estado informe`.
- Abre WhatsApp Web con el número y el texto ya preparados.
- Permite pausar, reanudar, omitir y marcar como enviado.
- Respeta la hora de inicio y de finalización configuradas.
- Permite elegir un máximo de 1 a 60 aperturas por hora y distribuye la cola
  durante esa hora.
- Guarda el seguimiento en una copia nueva del Excel.

## Qué no hace

No pulsa el botón **Enviar**, no imita actividad humana y no intenta evitar
los controles de WhatsApp. Cada mensaje debe revisarse y confirmarse manualmente.

El número configurado es un máximo de conversaciones abiertas por hora, no una
garantía frente a bloqueos. Conviene empezar de forma prudente (por ejemplo,
10–20 por hora), escribir solo a contactos pertinentes y detenerse si aparecen
avisos o solicitudes de baja. **60 por minuto no es un límite seguro de
WhatsApp Web.**

## Inicio

1. Instala Python 3.11 o superior.
2. Instala la dependencia:

   `py -m pip install -r requirements-whatsapp.txt`

3. Abre WhatsApp Web e inicia sesión.
4. Ejecuta:

   `powershell -ExecutionPolicy Bypass -File .\INICIAR-ASISTENTE-WHATSAPP.ps1`

5. Si el Excel no se carga automáticamente, pulsa **Seleccionar Excel**.

El seguimiento se guardará como una copia terminada en
`_seguimiento_whatsapp.xlsx`; el Excel original no se sobrescribe.

Utiliza la herramienta únicamente para contactos empresariales pertinentes,
respeta las solicitudes de baja y detén la cola si una persona no desea recibir
más comunicaciones.
