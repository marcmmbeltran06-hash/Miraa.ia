# Asistente de WhatsApp Mira

Este programa prepara una cola de revisión usando el Excel de Mira.

## Qué hace

- Lee `Teléfono`, `Texto junto mensaje` y `Estado informe`.
- Abre WhatsApp Web con el número y el texto ya preparados.
- Permite pausar, reanudar, omitir y marcar como enviado.
- Respeta el horario configurado.
- Espera el intervalo elegido antes de abrir el siguiente contacto.
- Guarda el seguimiento en una copia nueva del Excel.

## Qué no hace

No pulsa el botón **Enviar**, no imita actividad humana y no intenta evitar
los controles de WhatsApp. Cada mensaje debe revisarse y confirmarse manualmente.

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
