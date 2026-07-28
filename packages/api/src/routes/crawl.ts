import type { FastifyPluginAsync } from 'fastify';
import type { CrawlJobService } from '../types.js';
import { createReadStream, existsSync } from 'node:fs';
import type { ReportShareStore } from '../ReportShareStore.js';

interface PostCrawlBody { url: string; reportOnly?: boolean; reportMode?: 'full' | 'quick' }
interface PostBatchReportsBody { urls: string[]; mode?: 'full' | 'quick' }
interface JobParams { jobId: string }
interface ReportParams extends JobParams { format: 'html' | 'pdf' | 'json' | 'csv' | 'zip' | 'mira' | 'tryon-result' }
interface CrawlPluginOptions { service: CrawlJobService; shareStore: ReportShareStore }
interface ShareBody { recipient?: string }
interface ShareParams extends JobParams { token: string }
interface BatchStatusBody { jobIds: string[] }

function isValidHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const validJobId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

export const crawlRoutes: FastifyPluginAsync<CrawlPluginOptions> = async (app, { service, shareStore }) => {
  app.post<{ Body: PostCrawlBody }>('/crawl', async (request, reply) => {
    if (!isValidHttpUrl(request.body.url)) return reply.status(400).send({ error: 'La URL debe usar HTTP o HTTPS.' });
    try {
      const jobId = await service.submit(request.body.url, {
        reportOnly: request.body.reportOnly === true,
        reportMode: request.body.reportMode === 'quick' ? 'quick' : 'full',
      });
      return reply.status(202).send({ jobId });
    } catch (error) {
      return reply.status(500).send({ error: 'No se pudo iniciar el constructor.', detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Body: PostBatchReportsBody }>('/reports/batch', async (request, reply) => {
    const urls = Array.isArray(request.body.urls)
      ? [...new Set(request.body.urls.map((url) => url.trim()).filter(isValidHttpUrl))]
      : [];
    if (urls.length === 0) return reply.status(400).send({ error: 'Añade al menos una URL HTTP o HTTPS válida.' });
    if (urls.length > 4000) return reply.status(400).send({ error: 'Puedes analizar un máximo de 4.000 webs por lote.' });
    try {
      const reportMode = request.body.mode === 'quick' ? 'quick' : 'full';
      const jobs = await Promise.all(urls.map(async (url) => ({ url, jobId: await service.submit(url, { reportOnly: true, reportMode }) })));
      return reply.status(202).send({ jobs });
    } catch (error) {
      return reply.status(500).send({ error: 'No se pudo iniciar el lote de informes.', detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Body: BatchStatusBody }>('/reports/status', async (request, reply) => {
    const jobIds = Array.isArray(request.body.jobIds)
      ? request.body.jobIds.filter(validJobId).slice(0, 4000)
      : [];
    const jobs = await Promise.all(jobIds.map((jobId) => service.getStatus(jobId)));
    return reply.send({ jobs: jobs.filter(Boolean) });
  });

  app.get<{ Params: ReportParams }>('/reports/:jobId/:format', async (request, reply) => {
    if (!validJobId(request.params.jobId) || !['html', 'pdf', 'json', 'csv', 'zip', 'mira', 'tryon-result'].includes(request.params.format)) {
      return reply.status(400).send({ error: 'Formato de informe no válido.' });
    }
    if (request.params.format === 'tryon-result') {
      const resultPath = `auditoria/${request.params.jobId}/tryon-result.jpg`;
      if (!existsSync(resultPath)) return reply.status(404).send({ error: 'La prueba virtual todavía no está disponible.' });
      return reply.type('image/jpeg').send(createReadStream(resultPath));
    }
    const artifact = await service.getReportArtifact?.(request.params.jobId, request.params.format);
    if (!artifact) return reply.status(404).send({ error: 'El informe todavía no está disponible.' });
    reply.header('Content-Type', artifact.contentType);
    reply.header('Content-Disposition', `${request.params.format === 'html' ? 'inline' : 'attachment'}; filename="${artifact.filename}"`);
    if (artifact.filePath) return reply.send(createReadStream(artifact.filePath));
    return reply.send(artifact.body);
  });

  app.post<{ Params: JobParams; Body: ShareBody }>('/reports/:jobId/share', async (request, reply) => {
    if (!validJobId(request.params.jobId)) return reply.status(400).send({ error: 'Informe no válido.' });
    const artifact = await service.getReportArtifact?.(request.params.jobId, 'html');
    if (!artifact) return reply.status(409).send({ error: 'El informe todavía no está disponible.' });
    const share = shareStore.create(request.params.jobId, request.body.recipient ?? '');
    return reply.status(201).send({
      token: share.token,
      recipient: share.recipient,
      url: `/r/${share.token}`,
      createdAt: share.createdAt,
      firstOpenedAt: null,
      viewCount: 0,
    });
  });

  app.get<{ Params: ShareParams }>('/reports/:jobId/share/:token', async (request, reply) => {
    const share = shareStore.get(request.params.token);
    if (!share || share.jobId !== request.params.jobId) return reply.status(404).send({ error: 'Enlace personal no encontrado.' });
    return reply.send({
      token: share.token,
      recipient: share.recipient,
      createdAt: share.createdAt,
      firstOpenedAt: share.views[0]?.openedAt ?? null,
      lastOpenedAt: share.views.at(-1)?.openedAt ?? null,
      viewCount: share.views.length,
    });
  });

  app.get<{ Params: { token: string } }>('/r/:token', async (request, reply) => {
    const share = shareStore.get(request.params.token);
    if (!share) return reply.status(404).type('text/html').send('<h1>Informe no encontrado</h1>');
    const artifact = await service.getReportArtifact?.(share.jobId, 'html');
    if (!artifact?.body || typeof artifact.body !== 'string') return reply.status(409).type('text/html').send('<h1>Informe todavía no disponible</h1>');
    shareStore.recordView(
      share.token,
      request.ip,
      String(request.headers['user-agent'] ?? 'desconocido'),
    );
    const safeRecipient = share.recipient.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
    const notice = `<aside style="position:sticky;top:0;z-index:9999;padding:14px 20px;background:#083344;color:white;font:14px/1.5 system-ui;border-bottom:3px solid #22d3ee"><strong>Informe personal para ${safeRecipient}.</strong> Por seguridad y seguimiento de entrega, registramos la fecha de apertura y datos técnicos minimizados. No usamos un píxel oculto ni publicidad. Al continuar leyendo aceptas esta visualización.</aside>`;
    const html = artifact.body.includes('<body')
      ? artifact.body.replace(/(<body[^>]*>)/i, `$1${notice}`)
      : `<!doctype html><html><body>${notice}${artifact.body}</body></html>`;
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get<{ Params: JobParams }>('/crawl/:jobId', async (request, reply) => {
    try {
      const job = await service.getStatus(request.params.jobId);
      return job ? reply.send(job) : reply.status(404).send({ error: 'Trabajo no encontrado.' });
    } catch (error) {
      return reply.status(500).send({ error: 'No se pudo consultar el constructor.', detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: JobParams }>('/crawl/:jobId/cancel', async (request, reply) => {
    const cancelled = await service.cancel(request.params.jobId);
    return cancelled ? reply.send({ ok: true }) : reply.status(404).send({ error: 'El trabajo no está activo.' });
  });

  app.post<{ Params: JobParams }>('/crawl/:jobId/build-wordpress', async (request, reply) => {
    const ok = validJobId(request.params.jobId) && await service.buildWordPress(request.params.jobId);
    return ok ? reply.status(202).send({ ok: true }) : reply.status(409).send({ error: 'No se pudo iniciar la construcción.' });
  });

  app.post<{ Params: JobParams }>('/crawl/:jobId/pause-build', async (request, reply) => {
    const ok = validJobId(request.params.jobId) && await service.pauseWordPressBuild(request.params.jobId);
    return ok ? reply.send({ ok: true }) : reply.status(409).send({ error: 'No se pudo pausar la construcción.' });
  });

  app.post<{ Params: JobParams }>('/crawl/:jobId/resume-build', async (request, reply) => {
    const ok = validJobId(request.params.jobId) && await service.resumeWordPressBuild(request.params.jobId);
    return ok ? reply.status(202).send({ ok: true }) : reply.status(409).send({ error: 'No se pudo reanudar la construcción.' });
  });

  app.post<{ Params: JobParams }>('/crawl/:jobId/cancel-build', async (request, reply) => {
    const ok = validJobId(request.params.jobId) && await service.cancelWordPressBuild(request.params.jobId);
    return ok ? reply.send({ ok: true }) : reply.status(409).send({ error: 'No se pudo cancelar la construcción.' });
  });

  app.post<{ Params: JobParams }>('/crawl/:jobId/retry-failed-exports', async (request, reply) => {
    const ok = validJobId(request.params.jobId) && await service.retryFailedExports(request.params.jobId);
    return ok
      ? reply.status(202).send({ ok: true })
      : reply.status(409).send({ error: 'No se pudieron reintentar las exportaciones fallidas.' });
  });

  app.post<{ Params: JobParams }>('/crawl/:jobId/restart-site', async (request, reply) => {
    const ok = validJobId(request.params.jobId) && await service.restartSite(request.params.jobId);
    return ok ? reply.status(202).send({ ok: true }) : reply.status(409).send({ error: 'El sitio ya tiene una operaciÃ³n en curso o no se pudo reiniciar.' });
  });

  app.post<{ Params: JobParams }>('/crawl/:jobId/rerun-validation', async (request, reply) => {
    const ok = validJobId(request.params.jobId) && await service.rerunValidation(request.params.jobId);
    return ok ? reply.status(202).send({ ok: true }) : reply.status(409).send({ error: 'No se pudo iniciar la validación.' });
  });

  app.post<{ Params: JobParams }>('/crawl/:jobId/stop-site', async (request, reply) => {
    const ok = validJobId(request.params.jobId) && await service.stopSite(request.params.jobId);
    return ok ? reply.send({ ok: true }) : reply.status(409).send({ error: 'No se pudo detener el sitio.' });
  });
};
