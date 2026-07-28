import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir } from './fs-utils.js';

export type BuildPhaseId =
  | 'preparation'
  | 'resources'
  | 'snapshot'
  | 'wordpress_generation'
  | 'docker'
  | 'wpcli'
  | 'validation';

export type BuildPhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';

export interface BuildBatchCheckpoint {
  completed: number;
  total: number;
  lastItem?: string;
  updatedAt: string;
}

export interface BuildPhaseCheckpoint {
  status: BuildPhaseStatus;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  batches: Record<string, BuildBatchCheckpoint>;
  error?: string;
}

export interface BuildCheckpoint {
  schemaVersion: 2;
  buildId: string;
  inputPath: string;
  outputPath: string;
  startedAt: string;
  updatedAt: string;
  heartbeatAt: string;
  control: 'running' | 'paused' | 'cancelled';
  phases: Record<BuildPhaseId, BuildPhaseCheckpoint>;
}

const PHASES: BuildPhaseId[] = [
  'preparation',
  'resources',
  'snapshot',
  'wordpress_generation',
  'docker',
  'wpcli',
  'validation',
];

function atomicWriteJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const handle = fs.openSync(temporaryPath, 'w');
  try {
    fs.writeFileSync(handle, data, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch {
    fs.copyFileSync(temporaryPath, filePath);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function emptyPhase(now: string): BuildPhaseCheckpoint {
  return { status: 'pending', updatedAt: now, batches: {} };
}

export class BuildCheckpointStore {
  public readonly filePath: string;
  private state: BuildCheckpoint;

  public constructor(outputPath: string, inputPath: string, buildId: string) {
    this.filePath = path.join(outputPath, '.autowp-build', 'checkpoint.json');
    const loaded = this.read();
    const now = new Date().toISOString();
    this.state = loaded ?? {
      schemaVersion: 2,
      buildId,
      inputPath: path.resolve(inputPath),
      outputPath: path.resolve(outputPath),
      startedAt: now,
      updatedAt: now,
      heartbeatAt: now,
      control: 'running',
      phases: Object.fromEntries(PHASES.map((phase) => [phase, emptyPhase(now)])) as Record<BuildPhaseId, BuildPhaseCheckpoint>,
    };
    if (!loaded) this.migrateLegacyArtifacts(now);
    // A previous process may have exited while a phase was running. The phase
    // remains resumable; it is not incorrectly declared complete or failed.
    this.state.control = 'running';
    this.persist();
  }

  public snapshot(): BuildCheckpoint {
    return JSON.parse(JSON.stringify(this.state)) as BuildCheckpoint;
  }

  public isCompleted(phase: BuildPhaseId): boolean {
    return this.state.phases[phase].status === 'completed';
  }

  public startPhase(phase: BuildPhaseId): void {
    this.assertRunnable();
    const now = new Date().toISOString();
    const current = this.state.phases[phase];
    current.status = 'running';
    current.startedAt ??= now;
    current.updatedAt = now;
    delete current.error;
    this.touch(now);
  }

  public completePhase(phase: BuildPhaseId): void {
    const now = new Date().toISOString();
    const current = this.state.phases[phase];
    current.status = 'completed';
    current.completedAt = now;
    current.updatedAt = now;
    delete current.error;
    this.touch(now);
  }

  public failPhase(phase: BuildPhaseId, error: unknown): void {
    const now = new Date().toISOString();
    const current = this.state.phases[phase];
    current.status = 'failed';
    current.error = error instanceof Error ? error.message : String(error);
    current.updatedAt = now;
    this.touch(now);
  }

  public updateBatch(phase: BuildPhaseId, batchId: string, completed: number, total: number, lastItem?: string): void {
    this.assertRunnable();
    const now = new Date().toISOString();
    this.state.phases[phase].batches[batchId] = {
      completed: Math.max(0, Math.min(completed, total)),
      total: Math.max(0, total),
      ...(lastItem ? { lastItem } : {}),
      updatedAt: now,
    };
    this.state.phases[phase].updatedAt = now;
    this.touch(now);
  }

  public heartbeat(): void {
    this.assertRunnable();
    this.touch(new Date().toISOString());
  }

  public getControl(): BuildCheckpoint['control'] {
    // Read the on-disk value so pause/cancel requests made by the API are
    // observed by an already-running worker.
    const disk = this.read();
    if (disk) this.state.control = disk.control;
    return this.state.control;
  }

  public requestControl(control: BuildCheckpoint['control']): void {
    this.state.control = control;
    this.touch(new Date().toISOString());
  }

  private assertRunnable(): void {
    const control = this.getControl();
    if (control === 'paused') throw new Error('AUTOWP_BUILD_PAUSED');
    if (control === 'cancelled') throw new Error('AUTOWP_BUILD_CANCELLED');
  }

  private touch(now: string): void {
    this.state.updatedAt = now;
    this.state.heartbeatAt = now;
    this.persist();
  }

  private read(): BuildCheckpoint | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<BuildCheckpoint>;
      if (parsed.schemaVersion !== 2 || !parsed.phases) return null;
      return parsed as BuildCheckpoint;
    } catch {
      return null;
    }
  }

  private persist(): void {
    atomicWriteJson(this.filePath, this.state);
  }

  /**
   * Jobs created before checkpoint schema v2 can still contain expensive,
   * valid artifacts. Infer only phases with unambiguous completion evidence;
   * uncertain phases remain pending and are safely repeated.
   */
  private migrateLegacyArtifacts(now: string): void {
    const complete = (phase: BuildPhaseId): void => {
      this.state.phases[phase] = {
        status: 'completed',
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        batches: {},
      };
    };
    const exists = (...parts: string[]): boolean => fs.existsSync(path.join(this.state.outputPath, ...parts));
    if (exists('imports', 'media-map.json')) complete('resources');
    if (exists('snapshot', 'config.json')) complete('snapshot');
    if (
      exists('wp-content', 'themes')
      && exists('docker-compose.yml')
      && exists('validation', 'build-report.json')
    ) complete('wordpress_generation');
    // Docker, WP-CLI and runtime validation require a live proof by the API.
  }
}

export function updateBuildControl(outputPath: string, control: BuildCheckpoint['control']): boolean {
  const filePath = path.join(outputPath, '.autowp-build', 'checkpoint.json');
  try {
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BuildCheckpoint;
    state.control = control;
    state.updatedAt = new Date().toISOString();
    atomicWriteJson(filePath, state);
    return true;
  } catch {
    return false;
  }
}

export function readBuildControl(outputPath: string): BuildCheckpoint['control'] | null {
  const filePath = path.join(outputPath, '.autowp-build', 'checkpoint.json');
  try {
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BuildCheckpoint;
    return state.control;
  } catch {
    return null;
  }
}
