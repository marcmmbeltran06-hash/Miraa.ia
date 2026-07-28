# @autowp/pipeline

`@autowp/pipeline` es la capa de orquestación del sistema. Define los contratos del crawler, los eventos del pipeline y ofrece una implementación de pipeline completa y desacoplada.

## Qué contiene

- Interfaces de `Crawler` y `CrawlSnapshot`
- `Pipeline` como caso de uso central
- Eventos de pipeline (`PipelineStarted`, `PipelineCompleted`, `PipelineFailed`)
- `SimpleCrawler` como adaptador de crawling básico usando `fetch`
- Errores tipados para fallos de pipeline

## Uso

```ts
import { Pipeline, SimpleCrawler } from '@autowp/pipeline';
import { InMemoryEventBus } from '@autowp/event-bus';
import { UuidV7Generator, ConsoleLogger } from '@autowp/shared';

const pipeline = new Pipeline({
  crawler: new SimpleCrawler(),
  eventBus: new InMemoryEventBus(),
  idGenerator: new UuidV7Generator(),
  logger: new ConsoleLogger(),
});

await pipeline.run({ entryUrl: 'https://example.com', maxPages: 10 });
```

## Notas

`SimpleCrawler` no realiza renderizado JS y funciona sobre HTML estático. Se utiliza como adaptador de prueba y de desarrollo rápido.
