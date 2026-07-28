import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { CrawlRepository } from '@autowp/database';
import type { Logger } from '@autowp/logger';
import {
  BuildCheckpointStore,
  evaluateQualityGate,
  readBuildControl,
  updateBuildControl,
  VisualConvergenceEngine,
  writeAcceptanceReport,
} from '@autowp/builder';
import { restoreDeploymentArtifactsFromReconstruction, runAllExports } from './ExportService.js';
import { getBuilderRetryDecision } from './BuilderRetryPolicy.js';
import { retryOperation } from './OperationRetry.js';
import { classifyBuilderActivity, shouldTerminateBuilderForInactivity } from './BuilderLiveness.js';

const execFileAsync = promisify(execFile);
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface DeploymentCredentials {
  version: 1;
  adminPassword: string;
  databasePassword: string;
}

interface StoredDeploymentCredentials {
  credentials: DeploymentCredentials;
  created: boolean;
}

interface BuilderRetryState {
  version: 1;
  attempts: number;
  lastError: string;
  updatedAt: string;
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    // Some Windows package-manager type trees expose a narrowed Server shape.
    // The runtime is still Node's EventEmitter Server, so retain the event API
    // without weakening the rest of this service's types.
    const events = server as unknown as { once(event: string, listener: () => void): void };
    events.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export class WordPressSiteService {
  private readonly active = new Set<string>();
  private readonly activeBuilders = new Map<string, ChildProcess>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly convergence = new VisualConvergenceEngine();
  constructor(private readonly repository: CrawlRepository, private readonly logger: Logger) {}

  isValidJobId(jobId: string): boolean { return JOB_ID.test(jobId); }

  async start(jobId: string): Promise<boolean> {
    return this.queueStart(jobId, false);
  }

  async pauseBuild(jobId: string): Promise<boolean> {
    const record = await this.repository.findById(jobId);
    if (!record?.sitePath || !this.isValidJobId(jobId)) return false;
    const updated = updateBuildControl(record.sitePath, 'paused');
    const child = this.activeBuilders.get(jobId);
    if (child && !child.killed) child.kill();
    if (updated) {
      await this.repository.update(jobId, {
        status: 'build_failed_recoverable',
        builderStatus: 'paused',
        builderError: 'Construcción pausada. El rastreo, las exportaciones y los checkpoints se conservan.',
      });
    }
    return updated;
  }

  async cancelBuild(jobId: string): Promise<boolean> {
    const record = await this.repository.findById(jobId);
    if (!record?.sitePath || !this.isValidJobId(jobId)) return false;
    const updated = updateBuildControl(record.sitePath, 'cancelled');
    const child = this.activeBuilders.get(jobId);
    if (child && !child.killed) child.kill();
    if (updated) {
      await this.repository.update(jobId, {
        status: 'cancelled',
        builderStatus: 'cancelled',
        builderError: 'Construcción cancelada sin eliminar rastreo, exportaciones ni artefactos completados.',
      });
    }
    return updated;
  }

  private async queueStart(jobId: string, automaticRetry: boolean): Promise<boolean> {
    if (!this.isValidJobId(jobId) || this.active.has(jobId)) return false;
    const record = this.repository.findSummaryById ? await this.repository.findSummaryById(jobId) : await this.repository.findById(jobId);
    const exportDirectory = path.resolve('auditoria', jobId);
    if (!record || (!record.exportStatusJson && !fs.existsSync(path.join(exportDirectory, 'reconstruction-manifest.json')))) return false;
    if (!automaticRetry) {
      this.cancelScheduledRetry(jobId);
      this.clearRetryState(jobId);
    }
    this.active.add(jobId);
    setImmediate(() => { void this.run(jobId).finally(() => this.active.delete(jobId)); });
    return true;
  }

  async restart(jobId: string): Promise<boolean> {
    if (!this.isValidJobId(jobId) || this.active.has(jobId)) return false;
    const record = this.repository.findSummaryById ? await this.repository.findSummaryById(jobId) : await this.repository.findById(jobId);
    if (!record?.sitePath) return false;
    this.active.add(jobId);
    setImmediate(() => {
      void this.restartExisting(jobId, record.sitePath!, record.sitePort ?? 8080)
        .catch((error) => this.fail(jobId, error))
        .finally(() => this.active.delete(jobId));
    });
    return true;
  }

  private async restartExisting(jobId: string, sitePath: string, sitePort: number): Promise<void> {
    try {
      await this.docker(['version']);
      await this.composeUp(sitePath, jobId);
      await this.repository.update(jobId, { status: 'waiting_for_wordpress', builderStatus: 'waiting_for_wordpress', builderError: null, dockerStartedAt: Date.now() });
      await this.waitReady(sitePort, sitePath);
      await this.repository.update(jobId, { status: 'validating', builderStatus: 'validating' });
      await this.runVisualValidation(sitePath);
      const quality = this.readQuality(sitePath);
      await this.repository.update(jobId, {
        status: quality.needsReview ? 'needs_reconstruction' : 'ready',
        builderStatus: quality.needsReview ? 'needs_reconstruction' : 'ready',
        builderError: quality.message,
        siteUrl: `http://127.0.0.1:${sitePort}`,
        wordpressReadyAt: quality.needsReview ? null : Date.now(),
      });
    } catch (error) { await this.fail(jobId, error); }
  }

  /**
   * Re-runs the browser and runtime checks against the existing generated site.
   * It deliberately does not crawl, re-import or recreate Docker: this makes a
   * validation retry safe and fast after a local theme/resource correction.
   */
  async rerunValidation(jobId: string): Promise<boolean> {
    if (!this.isValidJobId(jobId) || this.active.has(jobId)) return false;
    const record = this.repository.findSummaryById ? await this.repository.findSummaryById(jobId) : await this.repository.findById(jobId);
    if (!record?.sitePath || !record.sitePort) return false;
    this.active.add(jobId);
    setImmediate(() => {
      void this.validateExisting(jobId, record.sitePath!, record.sitePort!)
        .catch((error) => this.fail(jobId, error))
        .finally(() => this.active.delete(jobId));
    });
    return true;
  }

  async stop(jobId: string): Promise<boolean> {
    this.cancelScheduledRetry(jobId);
    const record = this.repository.findSummaryById ? await this.repository.findSummaryById(jobId) : await this.repository.findById(jobId);
    if (!record?.sitePath || !this.isValidJobId(jobId)) return false;
    try {
      await this.docker(['compose', 'stop'], record.sitePath);
      await this.repository.update(jobId, { builderStatus: 'stopped', status: 'finished' });
      return true;
    } catch (error) { await this.fail(jobId, error); return false; }
  }

  private async run(jobId: string): Promise<void> {
    try {
      // The compact summary deliberately omits seoReportJson. Always load the
      // complete record here so a retry can recreate missing builder artifacts.
      const sourceRecord = await this.repository.findById(jobId);
      const inputPath = path.resolve('auditoria', jobId);
      const requiredArtifacts = [
        path.join(inputPath, 'wordpress', 'index.json'),
        path.join(inputPath, 'products.json'),
        path.join(inputPath, 'woocommerce-products.csv'),
      ];
      if (requiredArtifacts.some((artifact) => !fs.existsSync(artifact))) {
        let restored = false;
        if (sourceRecord?.seoReportJson) {
          try {
            const report = JSON.parse(sourceRecord.seoReportJson) as { pages?: Array<{ pageHtml?: string }> };
            // Only regenerate the whole export when the persisted report still
            // owns every source HTML. Compact legacy records would otherwise
            // replace the good local mirror with empty pages.
            if (report.pages?.length && report.pages.every((page) => typeof page.pageHtml === 'string' && page.pageHtml.length > 0)) {
              await runAllExports(report as Parameters<typeof runAllExports>[0], jobId, undefined, [], false);
              restored = true;
            }
          } catch (error) {
            this.logger.warn('Full deployment exports could not be regenerated', { jobId, error: String(error) });
          }
        }
        if (!restored || requiredArtifacts.some((artifact) => !fs.existsSync(artifact))) {
          restoreDeploymentArtifactsFromReconstruction(jobId);
        }
      }
      const stillMissing = requiredArtifacts.filter((artifact) => !fs.existsSync(artifact));
      if (stillMissing.length > 0) throw new Error(`Deployment package remains incomplete: ${stillMissing.join(', ')}`);
      const port = await this.nextPort();
      const outputPath = path.resolve('generated-sites', jobId);
      const hadGeneratedProject = fs.existsSync(path.join(outputPath, 'docker-compose.yml'));
      const storedCredentials = this.loadOrCreateDeploymentCredentials(jobId, outputPath);
      await this.repository.update(jobId, { status: 'building_wordpress', builderStatus: 'building_wordpress', builderError: null, sitePort: port, sitePath: outputPath, siteUrl: null, wordpressReadyAt: null });
      const { adminPassword, databasePassword } = storedCredentials.credentials;
      // A retry can arrive while the previous Docker project still bind-mounts
      // wp-content/uploads. Stop that project before the builder regenerates
      // its output directory; otherwise Windows reports ENOTEMPTY/EPERM.
      await this.stopExistingDeploymentBeforeRebuild(outputPath, jobId);
      await this.spawnBuilder(inputPath, outputPath, port, jobId, adminPassword, databasePassword);
      const checkpoints = new BuildCheckpointStore(outputPath, inputPath, jobId);
      this.logMemory('after builder spawn', jobId);
      await this.repository.update(jobId, { status: 'starting_docker', builderStatus: 'starting_docker' });
      checkpoints.startPhase('docker');
      try {
        await this.docker(['version']);
        await this.docker(['compose', 'version']);
      // Jobs created before credentials were persisted can have a partial
      // MariaDB volume whose password no longer matches a newly generated
      // compose file. Reset only a never-completed legacy deployment, once.
      // Completed sites and every subsequent retry keep their named volumes.
        if (storedCredentials.created && hadGeneratedProject && !sourceRecord?.wordpressReadyAt) {
          await this.resetUninitializedDeployment(outputPath, jobId);
        }
        await this.composeUp(outputPath, jobId, !sourceRecord?.wordpressReadyAt);
        checkpoints.completePhase('docker');
      } catch (error) {
        checkpoints.failPhase('docker', error);
        throw error;
      }
      await this.repository.update(jobId, { status: 'waiting_for_wordpress', builderStatus: 'waiting_for_wordpress', dockerStartedAt: Date.now() });
      checkpoints.startPhase('wpcli');
      try {
        await this.waitReady(port, outputPath);
        checkpoints.completePhase('wpcli');
      } catch (error) {
        checkpoints.failPhase('wpcli', error);
        throw error;
      }
      await this.repository.update(jobId, { status: 'validating', builderStatus: 'validating' });
      checkpoints.startPhase('validation');
      try {
        await this.runVisualValidation(outputPath);
      } catch (error) {
        checkpoints.failPhase('validation', error);
        throw error;
      }
      const quality = this.readQuality(outputPath);
      if (!quality.needsReview) checkpoints.completePhase('validation');
      else checkpoints.failPhase('validation', quality.message ?? 'Final quality gate did not pass.');
      await this.repository.update(jobId, {
        status: quality.needsReview ? 'needs_reconstruction' : 'ready',
        builderStatus: quality.needsReview ? 'needs_reconstruction' : 'ready',
        siteUrl: `http://127.0.0.1:${port}`,
        wordpressReadyAt: quality.needsReview ? null : Date.now(),
        builderError: quality.message,
      });
      this.clearRetryState(jobId);
    } catch (error) { await this.fail(jobId, error, true); }
  }

  private async validateExisting(jobId: string, sitePath: string, port: number): Promise<void> {
    await this.repository.update(jobId, {
      status: 'validating', builderStatus: 'validating', builderError: null,
    });
    await this.waitReady(port, sitePath);
    await this.runVisualValidation(sitePath);
    const quality = this.readQuality(sitePath);
    await this.repository.update(jobId, {
      status: quality.needsReview ? 'needs_reconstruction' : 'ready',
      builderStatus: quality.needsReview ? 'needs_reconstruction' : 'ready',
      builderError: quality.message,
      siteUrl: `http://127.0.0.1:${port}`,
      wordpressReadyAt: quality.needsReview ? null : Date.now(),
    });
  }

  private async docker(args: string[], cwd?: string): Promise<void> {
    // Child workers must use the same Docker Desktop context as the API. Do
    // not inspect or mutate ~/.docker/config.json; the CLI owns that file.
    const env = { ...process.env, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT || 'desktop-linux' };
    await this.withRetries(`docker ${args.join(' ')}`, async () => {
      await execFileAsync('docker', args, {
        cwd,
        timeout: Number(process.env.AUTOWP_DOCKER_OPERATION_TIMEOUT_MS ?? 180_000),
        windowsHide: true,
        env,
      });
    });
  }
  private async dockerOutput(args: string[], cwd?: string): Promise<string> {
    const env = { ...process.env, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT || 'desktop-linux' };
    return this.withRetries(`docker ${args.join(' ')}`, async () => {
      const result = await execFileAsync('docker', args, {
        cwd,
        timeout: Number(process.env.AUTOWP_DOCKER_OPERATION_TIMEOUT_MS ?? 180_000),
        windowsHide: true,
        env,
      });
      return result.stdout;
    });
  }
  private async withRetries<T>(label: string, action: () => Promise<T>): Promise<T> {
    const attempts = Math.max(1, Number(process.env.AUTOWP_OPERATION_RETRIES ?? 3));
    const baseDelay = Math.max(50, Number(process.env.AUTOWP_OPERATION_RETRY_DELAY_MS ?? 1_000));
    return retryOperation(label, action, {
      attempts,
      baseDelayMs: baseDelay,
      onRetry: ({ attempt, attempts: maximum, delayMs, error }) => {
        this.logger.warn('Retrying blocked build operation', {
          label,
          attempt,
          attempts: maximum,
          delay: delayMs,
          error: String(error),
        });
      },
    });
  }
  private loadOrCreateDeploymentCredentials(jobId: string, outputPath: string): StoredDeploymentCredentials {
    const credentialPath = path.resolve('auditoria', jobId, '.deployment-credentials.json');
    const readCredentials = (candidatePath: string): DeploymentCredentials | null => {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8')) as Partial<DeploymentCredentials>;
        if (typeof parsed.adminPassword !== 'string' || parsed.adminPassword.length < 16) return null;
        if (typeof parsed.databasePassword !== 'string' || parsed.databasePassword.length < 16) return null;
        return { version: 1, adminPassword: parsed.adminPassword, databasePassword: parsed.databasePassword };
      } catch { return null; }
    };

    const persisted = readCredentials(credentialPath);
    if (persisted) return { credentials: persisted, created: false };

    // Migrate the credentials emitted by an older successful/partial builder
    // when available. The audit copy survives output-directory regeneration.
    const legacy = readCredentials(path.join(outputPath, 'generated-site-credentials.json'));
    const credentials: DeploymentCredentials = legacy ?? {
      version: 1,
      adminPassword: randomBytes(24).toString('base64url'),
      databasePassword: randomBytes(24).toString('base64url'),
    };
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
    fs.writeFileSync(credentialPath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { credentials, created: true };
  }
  private async resetUninitializedDeployment(sitePath: string, jobId: string): Promise<void> {
    this.logger.warn('Resetting an incomplete legacy Docker deployment with stale credentials', { jobId, sitePath });
    try {
      await this.docker(['compose', 'down', '-v', '--remove-orphans'], sitePath);
      return;
    } catch (error) {
      this.logger.warn('Initial legacy deployment reset needs container cleanup', { jobId, error: String(error) });
    }
    try { await this.docker(['compose', 'rm', '-f', '-s'], sitePath); }
    catch (error) { this.logger.warn('Legacy compose container cleanup reported an error', { jobId, error: String(error) }); }
    await this.docker(['compose', 'down', '-v', '--remove-orphans'], sitePath);
  }
  private async stopExistingDeploymentBeforeRebuild(sitePath: string, jobId: string): Promise<void> {
    this.logger.info('Stopping existing Docker deployment before rebuilding files', { jobId, sitePath });
    if (fs.existsSync(path.join(sitePath, 'docker-compose.yml'))) {
      try {
        // Keep named database/WordPress volumes so a normal retry is
        // non-destructive. Only containers, the network and bind mounts stop.
        await this.docker(['compose', 'down', '--remove-orphans'], sitePath);
      } catch (error) {
        this.logger.warn('Docker Compose down needs label-based cleanup before rebuild', {
          jobId,
          error: String(error),
        });
      }
    }

    // A failed builder may already have removed docker-compose.yml while its
    // old containers are still alive. Compose cannot run `down` without that
    // file, so remove only containers bearing this exact job's project label.
    // Named volumes are deliberately not removed.
    const project = `autowp-${jobId}`;
    const stdout = await this.dockerOutput([
      'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`,
    ]);
    const containerIds = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (containerIds.length > 0) {
      this.logger.warn('Removing stale Docker containers before rebuilding files', {
        jobId,
        containerCount: containerIds.length,
      });
      await this.docker(['rm', '-f', ...containerIds]);
    }
  }
  private async composeUp(sitePath: string, jobId: string, allowFreshDatabaseRecovery = false): Promise<void> {
    await this.startDatabaseAndWait(sitePath, jobId, allowFreshDatabaseRecovery);
    try {
      await this.docker(['compose', 'up', '-d', '--force-recreate', '--remove-orphans', 'wordpress', 'wpcli'], sitePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const recoverableConflict = /container name|already in use|\bconflict\b|error while stopping container/i.test(message);
      if (!recoverableConflict) throw error;

      // Docker Compose can leave a temporary hash-prefixed container after an
      // interrupted recreate. Clean only this compose project and keep named
      // database/WordPress volumes intact (no -v), then retry exactly once.
      this.logger.warn('Recovering Docker Compose container conflict', { jobId, sitePath });
      try { await this.docker(['compose', 'down', '--remove-orphans'], sitePath); }
      catch (cleanupError) { this.logger.warn('Docker Compose down reported an error during conflict recovery', { jobId, error: String(cleanupError) }); }
      try { await this.docker(['compose', 'rm', '-f', '-s'], sitePath); }
      catch (cleanupError) { this.logger.warn('Docker Compose rm reported an error during conflict recovery', { jobId, error: String(cleanupError) }); }
      await this.startDatabaseAndWait(sitePath, jobId, false);
      await this.docker(['compose', 'up', '-d', '--force-recreate', '--remove-orphans', 'wordpress', 'wpcli'], sitePath);
    }
  }
  private async startDatabaseAndWait(sitePath: string, jobId: string, allowFreshRecovery: boolean): Promise<void> {
    const start = async (): Promise<void> => {
      await this.docker(['compose', 'up', '-d', '--force-recreate', '--remove-orphans', 'db'], sitePath);
      const timeoutMs = Math.max(30_000, Number(process.env.AUTOWP_DATABASE_READY_TIMEOUT_MS ?? 240_000));
      const deadline = Date.now() + timeoutMs;
      let lastState = 'unknown';
      while (Date.now() < deadline) {
        const containerId = (await this.dockerOutput(['compose', 'ps', '-q', 'db'], sitePath)).trim();
        if (!containerId) {
          lastState = 'container_missing';
        } else {
          const state = (await this.dockerOutput([
            'inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', containerId,
          ])).trim();
          lastState = state;
          if (state === 'healthy') return;
          if (state === 'exited' || state === 'dead') break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      const logs = await this.safeComposeLogs(sitePath, 'db');
      throw new Error(`MariaDB did not become healthy (state: ${lastState}). ${logs.slice(-4_000)}`);
    };

    try {
      await start();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      const corruption = /data structure corruption|wrong space id|header page consists of zero bytes|unknown\/unsupported storage engine: innodb|plugin initialization aborted/i.test(details);
      if (!allowFreshRecovery || !corruption || !this.claimFreshDatabaseRecovery(sitePath, jobId, details)) throw error;

      this.logger.warn('Recovering a corrupt database volume from a never-completed deployment', { jobId, sitePath });
      // This destructive recovery is deliberately restricted to a deployment
      // that has never reached wordpressReadyAt, and to one attempt per job.
      await this.docker(['compose', 'down', '-v', '--remove-orphans'], sitePath);
      await start();
    }
  }
  private async safeComposeLogs(sitePath: string, service: string): Promise<string> {
    try {
      return await this.dockerOutput(['compose', 'logs', '--no-color', '--tail', '120', service], sitePath);
    } catch (error) {
      return `Database logs unavailable: ${String(error)}`;
    }
  }
  private claimFreshDatabaseRecovery(sitePath: string, jobId: string, reason: string): boolean {
    const marker = path.join(sitePath, '.autowp-database-recovery.json');
    if (fs.existsSync(marker)) return false;
    fs.writeFileSync(marker, `${JSON.stringify({
      version: 1,
      jobId,
      recoveredAt: new Date().toISOString(),
      reason: reason.slice(-4_000),
    }, null, 2)}\n`, 'utf8');
    return true;
  }
  private async spawnBuilder(inputPath: string, outputPath: string, port: number, jobId: string, adminPassword: string, databasePassword: string): Promise<void> {
    const workerPath = fileURLToPath(new URL('./builder-worker.js', import.meta.url));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, inputPath, outputPath, String(port), jobId, adminPassword, databasePassword], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
      });
      this.activeBuilders.set(jobId, child);
      const events = child as unknown as {
        once(event: 'error', listener: (error: Error) => void): void;
        once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
      };
      let stderr = '';
      let lastOutputAt = Date.now();
      let lastProgress = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        lastOutputAt = Date.now();
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line.startsWith('AUTOWP_PROGRESS ')) lastProgress = line.slice('AUTOWP_PROGRESS '.length);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        lastOutputAt = Date.now();
        stderr = (stderr + chunk.toString()).slice(-16_384);
      });

      // There is intentionally no total-duration timeout. A large site may run
      // for hours. The monitor records liveness separately and only kills a
      // worker if an operator explicitly configures a no-activity timeout.
      const configuredStallTimeout = Number(process.env.AUTOWP_BUILDER_STALL_TIMEOUT_MS ?? 0);
      const heartbeatPath = path.join(outputPath, '.autowp-build', 'process-heartbeat.json');
      const monitor = setInterval(() => {
        const now = Date.now();
        const silentMs = now - lastOutputAt;
        let parsedProgress: unknown = null;
        try { parsedProgress = lastProgress ? JSON.parse(lastProgress) as unknown : null; } catch { parsedProgress = null; }
        const state = {
          schemaVersion: 1,
          jobId,
          pid: child.pid,
          alive: child.exitCode === null && !child.killed,
          silentMs,
          classification: classifyBuilderActivity(silentMs),
          lastProgress: parsedProgress,
          updatedAt: new Date(now).toISOString(),
        };
        try {
          fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
          const temporary = `${heartbeatPath}.tmp`;
          fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
          try { fs.renameSync(temporary, heartbeatPath); }
          catch { fs.copyFileSync(temporary, heartbeatPath); fs.rmSync(temporary, { force: true }); }
        } catch { /* heartbeat must never abort the build */ }
        if (shouldTerminateBuilderForInactivity(configuredStallTimeout, silentMs)) {
          child.kill();
        }
      }, 15_000);
      monitor.unref();

      const cleanup = (): void => {
        clearInterval(monitor);
        this.activeBuilders.delete(jobId);
      };
      events.once('error', (error: Error) => { cleanup(); reject(error); });
      events.once('exit', (code: number | null, signal: string | null) => {
        cleanup();
        if (code === 0) resolve();
        else if (signal) {
          reject(new Error(`WordPress builder stopped (${signal}). Resume will continue from the last checkpoint.`));
        } else {
          reject(new Error(`WordPress builder exited with code ${code ?? 'none'}${signal ? ` (${signal})` : ''}: ${stderr}`.trim()));
        }
      });
    });
  }
  private logMemory(stage: string, jobId: string): void {
    const m = process.memoryUsage();
    this.logger.info(`[Memory] ${stage}`, { jobId, heapUsed: m.heapUsed, heapTotal: m.heapTotal, rss: m.rss, external: m.external });
  }
  private async nextPort(): Promise<number> {
    const records = await this.repository.findAll();
    const used = new Set(records.map(r => r.sitePort).filter((p): p is number => typeof p === 'number'));
    for (let port = 8080; port < 9000; port++) if (!used.has(port) && await portFree(port)) return port;
    throw new Error('No free local port available between 8080 and 8999');
  }
  private async waitReady(port: number, sitePath: string): Promise<void> {
    // Large WooCommerce imports can legitimately take several minutes.
    // Product imports and media-heavy sites can take longer than the original
    // fifteen-minute health window after Docker is available.
    const deadline = Date.now() + Number(process.env.WORDPRESS_HEALTH_TIMEOUT_MS ?? 2_700_000); let last = '';
    while (Date.now() < deadline) {
      try {
        const env = { ...process.env, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT || 'desktop-linux' };
        const logs = await execFileAsync('docker', ['compose', 'logs', '--no-color', 'wpcli'], { cwd: sitePath, timeout: 15_000, windowsHide: true, env });
        const initialized = logs.stdout.includes('AutoWP init complete');
        // On Windows with WSL, localhost may resolve to an unrelated IPv6 relay
        // while Docker is bound on IPv4. Probe the exact Docker loopback route.
        const r = await fetch(`http://127.0.0.1:${port}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const location = r.headers.get('location') ?? '';
        if (initialized && r.status >= 200 && r.status < 400 && !location.includes('/wp-admin/install.php')) return;
        last = initialized ? `HTTP ${r.status} ${location}` : 'WP-CLI initialization is still running';
      }
      catch (e) { last = e instanceof Error ? e.message : String(e); }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`WordPress health check timed out: ${last}`);
  }
  private async runVisualValidation(sitePath: string): Promise<void> {
    const validationDir = path.join(sitePath, 'validation');
    const script = path.join(validationDir, 'run-visual-validation.mjs');
    if (!fs.existsSync(script)) return;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      try {
        await execFileAsync(process.execPath, [script], {
          cwd: sitePath,
          timeout: Number(process.env.WORDPRESS_VISUAL_VALIDATION_TIMEOUT_MS ?? 1_800_000),
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, AUTOWP_WORKSPACE_PACKAGE: path.join(process.cwd(), 'package.json') },
        });
      } catch (error) {
        fs.writeFileSync(path.join(validationDir, 'visual-validation-runtime.json'), JSON.stringify({
          status: 'needs_review', reason: 'Runtime screenshot validation failed.', error: error instanceof Error ? error.message : String(error),
        }, null, 2));
        return;
      }
      if (this.convergence.applySafeCorrections(sitePath).applied.length === 0) return;
    }
  }
  private readQuality(sitePath: string): { needsReview: boolean; message: string | null } {
    const reportPath = path.join(sitePath, 'validation', 'build-report.json');
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { status?: string; quality?: { originalInternalDomainReferences?: number } };
      const runtimePath = path.join(sitePath, 'validation', 'runtime-validation.json');
      const runtime = fs.existsSync(runtimePath) ? JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as { status?: string } : undefined;
      const visualPath = path.join(sitePath, 'validation', 'visual-validation-runtime.json');
      const visual = fs.existsSync(visualPath) ? JSON.parse(fs.readFileSync(visualPath, 'utf8')) as { status?: string } : undefined;
      const gate = evaluateQualityGate(sitePath);
      const acceptance = writeAcceptanceReport(sitePath);
      if (report.status === 'ready' && runtime?.status === 'pass' && visual?.status === 'pass' && gate.status === 'ready' && acceptance.status === 'ready') return { needsReview: false, message: null };
      const refs = report.quality?.originalInternalDomainReferences;
      const suffix = typeof refs === 'number' && refs > 0 ? ` (${refs} original-domain references still found)` : '';
      const runtimeSuffix = runtime?.status === 'pass' ? '' : ' Runtime WordPress/WooCommerce validation has not passed.';
      const visualSuffix = visual?.status === 'pass' ? '' : ' Visual validation has not passed.';
      const gateSuffix = gate.failures.length ? ` Quality gate: ${gate.failures.join(', ')}.` : '';
      const acceptanceSuffix = acceptance.failedChecks.length ? ` Acceptance: ${acceptance.failedChecks.join(', ')}.` : '';
      return { needsReview: true, message: `WordPress is online, but reconstruction validation needs review${suffix}.${runtimeSuffix}${visualSuffix}${gateSuffix}${acceptanceSuffix}` };
    } catch {
      return { needsReview: true, message: 'WordPress is online, but no readable reconstruction validation report was generated.' };
    }
  }
  private retryStatePath(jobId: string): string {
    return path.resolve('auditoria', jobId, '.builder-retry.json');
  }

  private readRetryState(jobId: string): BuilderRetryState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.retryStatePath(jobId), 'utf8')) as Partial<BuilderRetryState>;
      return {
        version: 1,
        attempts: Number.isFinite(parsed.attempts) ? Math.max(0, Math.floor(parsed.attempts!)) : 0,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : '',
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      };
    } catch {
      return { version: 1, attempts: 0, lastError: '', updatedAt: new Date(0).toISOString() };
    }
  }

  private writeRetryState(jobId: string, state: BuilderRetryState): void {
    const target = this.retryStatePath(jobId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
  }

  private clearRetryState(jobId: string): void {
    try { fs.rmSync(this.retryStatePath(jobId), { force: true }); }
    catch (error) { this.logger.warn('Could not clear builder retry state', { jobId, error: String(error) }); }
  }

  private cancelScheduledRetry(jobId: string): void {
    const timer = this.retryTimers.get(jobId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(jobId);
  }

  private scheduleAutomaticRetry(jobId: string, delayMs: number): void {
    this.cancelScheduledRetry(jobId);
    const tryStart = (): void => {
      if (this.active.has(jobId)) {
        this.retryTimers.set(jobId, setTimeout(tryStart, 1_000));
        return;
      }
      this.retryTimers.delete(jobId);
      void this.queueStart(jobId, true).then(async (started) => {
        if (!started) {
          const state = this.readRetryState(jobId);
          await this.repository.update(jobId, {
            status: 'build_failed_recoverable',
            builderStatus: 'build_failed_recoverable',
            builderError: `${state.lastError}\nNo se pudo iniciar el reintento automático; usa “Reintentar construcción”.`,
          });
        }
      });
    };
    this.retryTimers.set(jobId, setTimeout(tryStart, delayMs));
  }

  private async fail(jobId: string, error: unknown, allowAutomaticRetry = false): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error('WordPress site failed', { jobId, error: message });
    const record = await this.repository.findById(jobId);
    const control = record?.sitePath ? readBuildControl(record.sitePath) : null;
    if (control === 'paused' || control === 'cancelled') {
      await this.repository.update(jobId, {
        status: control === 'cancelled' ? 'cancelled' : 'build_failed_recoverable',
        builderStatus: control,
        builderError: control === 'paused'
          ? 'Construcción pausada. Puede reanudarse desde el último checkpoint.'
          : 'Construcción cancelada. Los artefactos y checkpoints se conservan.',
      });
      return;
    }
    const recoverable = /docker|npipe|permission denied|access denied|docker_engine|timed out|ENOTEMPTY|EPERM|EBUSY|container name|already in use/i.test(message);
    const state = this.readRetryState(jobId);
    const maximumAttempts = Number(process.env.WORDPRESS_BUILDER_AUTO_RETRIES ?? 2);
    const baseDelayMs = Number(process.env.WORDPRESS_BUILDER_RETRY_DELAY_MS ?? 5_000);
    const decision = getBuilderRetryDecision(
      recoverable && allowAutomaticRetry,
      state.attempts,
      maximumAttempts,
      baseDelayMs,
    );

    if (decision.shouldRetry) {
      const nextState: BuilderRetryState = {
        version: 1,
        attempts: decision.nextAttempt,
        lastError: message,
        updatedAt: new Date().toISOString(),
      };
      this.writeRetryState(jobId, nextState);
      const seconds = Math.max(1, Math.ceil(decision.delayMs / 1_000));
      this.logger.warn('Scheduling automatic WordPress builder retry', {
        jobId,
        attempt: decision.nextAttempt,
        maximumAttempts,
        delayMs: decision.delayMs,
      });
      await this.repository.update(jobId, {
        status: 'building_wordpress',
        builderStatus: `retry_scheduled_${decision.nextAttempt}_of_${maximumAttempts}`,
        builderError: `${message}\nReintento automático ${decision.nextAttempt}/${maximumAttempts} en ${seconds} segundos.`,
      });
      this.scheduleAutomaticRetry(jobId, decision.delayMs);
      return;
    }

    const exhaustedSuffix = recoverable && allowAutomaticRetry && state.attempts >= maximumAttempts
      ? `\nSe agotaron ${maximumAttempts} reintentos automáticos. Puedes usar “Reintentar construcción” para iniciar una nueva serie.`
      : '';
    await this.repository.update(jobId, {
      status: recoverable ? 'build_failed_recoverable' : 'failed',
      builderStatus: recoverable ? 'build_failed_recoverable' : 'build_failed',
      builderError: `${message}${exhaustedSuffix}`,
    });
  }
}
