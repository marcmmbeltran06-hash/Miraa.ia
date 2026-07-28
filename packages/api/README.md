# API / CRO LLM

El pipeline CRO no requiere credenciales: `mock` y `rules` funcionan localmente. Para activar un proveedor compatible con la API de chat:

```text
AUTOWP_LLM_PROVIDER=http
AUTOWP_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions
AUTOWP_LLM_MODEL=gpt-4o-mini
AUTOWP_LLM_API_KEY=<solo en el entorno, nunca en git>
AUTOWP_LLM_TIMEOUT_MS=20000
AUTOWP_LLM_MAX_PAGES=20
AUTOWP_LLM_MAX_SUGGESTIONS=8
```

El modo `ai` envía únicamente el contexto estructurado de la página. Se rechazan selectores inexistentes, operaciones fuera de la lista permitida, JavaScript, handlers inline, URLs peligrosas y valores incompatibles. Si el proveedor falla, el job conserva las sugerencias `rules` y no se exponen secretos.

WordPress y Docker no se activan desde este pipeline.
