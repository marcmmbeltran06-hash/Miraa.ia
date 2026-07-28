import type { FastifyPluginAsync } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface CampaignQuery {
  limit?: string;
  publish?: string;
}

interface SingleCampaignBody {
  url: string;
  name?: string;
  phone?: string;
  publish?: boolean;
}

const processes = new Map<string, ChildProcess>();
const root = path.resolve('.');
const runsDir = path.join(root, 'campaign-runs');
const inputsDir = path.join(root, 'campaign-input');
const publicBaseUrl = process.env.MIRA_PUBLIC_BASE_URL ?? 'https://www.miraia.space';

function pythonExecutable(): string {
  return process.env.AUTOWP_PYTHON
    ?? (process.platform === 'win32' ? 'python' : 'python3');
}

function startCampaign(campaignId: string, args: string[]): void {
  fs.mkdirSync(runsDir, { recursive: true });
  const log = fs.openSync(path.join(runsDir, `${campaignId}.log`), 'a');
  const child = spawn(
    pythonExecutable(),
    [path.join(root, 'scripts', 'run_mira_campaign.py'), ...args],
    { cwd: root, windowsHide: true, detached: false, stdio: ['ignore', log, log] },
  );
  processes.set(campaignId, child);
  child.once('exit', () => {
    processes.delete(campaignId);
    fs.closeSync(log);
  });
}

function statusPath(campaignId: string): string {
  return path.join(runsDir, `${campaignId}.json`);
}

export const campaignRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Querystring: CampaignQuery; Body: Buffer }>('/campaign/excel', async (request, reply) => {
    const file = request.body;
    if (!Buffer.isBuffer(file) || file.length < 4 || file[0] !== 0x50 || file[1] !== 0x4b) {
      return reply.status(400).send({ error: 'Selecciona un archivo Excel .xlsx válido.' });
    }
    if (file.length > 30 * 1024 * 1024) return reply.status(413).send({ error: 'El Excel supera el límite de 30 MB.' });
    const campaignId = crypto.randomUUID();
    fs.mkdirSync(inputsDir, { recursive: true });
    const input = path.join(inputsDir, `${campaignId}.xlsx`);
    const status = statusPath(campaignId);
    const updatedExcel = path.join(runsDir, `${campaignId}-actualizado.xlsx`);
    fs.writeFileSync(input, file);
    const limit = Math.min(4000, Math.max(1, Number(request.query.limit ?? 2000)));
    const args = [
      input,
      '--limit', String(limit),
      '--status-file', status,
      '--updated-excel', updatedExcel,
      '--public-base-url', publicBaseUrl,
    ];
    if (request.query.publish === 'true') args.push('--publish');
    startCampaign(campaignId, args);
    return reply.status(202).send({ campaignId, totalRequested: limit });
  });

  app.post<{ Body: SingleCampaignBody }>('/campaign/single', async (request, reply) => {
    try {
      const target = new URL(request.body.url);
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('invalid');
    } catch {
      return reply.status(400).send({ error: 'Introduce una URL HTTP o HTTPS válida.' });
    }
    const campaignId = crypto.randomUUID();
    const args = [
      '--url', request.body.url,
      '--name', request.body.name?.trim() || new URL(request.body.url).hostname,
      '--phone', request.body.phone?.trim() || '',
      '--limit', '1',
      '--status-file', statusPath(campaignId),
      '--public-base-url', publicBaseUrl,
    ];
    if (request.body.publish === true) args.push('--publish');
    startCampaign(campaignId, args);
    return reply.status(202).send({ campaignId, totalRequested: 1 });
  });

  app.get<{ Params: { campaignId: string } }>('/campaign/:campaignId', async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(request.params.campaignId)) return reply.status(400).send({ error: 'Campaña no válida.' });
    const file = statusPath(request.params.campaignId);
    if (!fs.existsSync(file)) {
      return reply.send({ campaignId: request.params.campaignId, status: processes.has(request.params.campaignId) ? 'starting' : 'not_found' });
    }
    try {
      return reply.send({ campaignId: request.params.campaignId, ...JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> });
    } catch {
      return reply.send({ campaignId: request.params.campaignId, status: 'starting' });
    }
  });

  app.get<{ Params: { campaignId: string } }>('/campaign/:campaignId/excel', async (request, reply) => {
    const { campaignId } = request.params;
    if (!/^[0-9a-f-]{36}$/i.test(campaignId)) return reply.status(400).send({ error: 'Campaña no válida.' });
    const workbook = path.join(runsDir, `${campaignId}-actualizado.xlsx`);
    if (!fs.existsSync(workbook)) return reply.status(404).send({ error: 'El Excel actualizado todavía no está disponible.' });
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="campana-mira-${campaignId}-actualizada.xlsx"`);
    return reply.send(fs.createReadStream(workbook));
  });
};
