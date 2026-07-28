import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir } from './fs-utils.js';

export type BuilderStageStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

export interface BuilderProgressStage {
  id: string;
  label: string;
  status: BuilderStageStatus;
  percent: number;
}

export interface BuilderProgressState {
  schemaVersion: 2;
  phase: string;
  label: string;
  status: 'running' | 'completed' | 'failed';
  completed: number;
  total: number;
  percent: number;
  currentItem?: string;
  lastItem?: string;
  processedItems?: number;
  totalItems?: number;
  itemsPerSecond?: number;
  elapsedMs: number;
  estimatedRemainingMs?: number;
  heartbeatAt: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
  stages: BuilderProgressStage[];
}

const STAGES: Array<{ id: string; label: string }> = [
  { id: 'media', label: 'Localizando recursos' },
  { id: 'capture', label: 'Preparando captura fiel' },
  { id: 'components', label: 'Reconstruyendo componentes editables' },
  { id: 'styles', label: 'Reconstruyendo estilos y responsive' },
  { id: 'navigation', label: 'Reconstruyendo navegación' },
  { id: 'seo', label: 'Preparando SEO' },
  { id: 'commerce', label: 'Preparando productos y WooCommerce' },
  { id: 'theme', label: 'Generando el tema WordPress' },
  { id: 'docker', label: 'Preparando Docker y WP-CLI' },
  { id: 'validation', label: 'Preparando validación funcional y visual' },
  { id: 'reports', label: 'Generando informes verificables' },
  { id: 'runtime', label: 'Iniciando y verificando WordPress' },
];

export class BuilderProgressReporter {
  private readonly filePath: string;
  private readonly startedAt: string;
  private readonly stages: BuilderProgressStage[] = STAGES.map((stage) => ({
    ...stage,
    status: 'pending',
    percent: 0,
  }));

  public constructor(validationPath: string) {
    ensureDir(validationPath);
    this.filePath = path.join(validationPath, 'builder-progress.json');
    const previous = this.readPrevious();
    this.startedAt = previous?.startedAt ?? new Date().toISOString();
    if (previous) {
      for (const stage of this.stages) {
        const old = previous.stages.find((candidate) => candidate.id === stage.id);
        if (old?.status === 'completed' || old?.status === 'skipped') Object.assign(stage, old);
      }
    }
    this.persist('media', STAGES[0]?.label ?? 'Iniciando constructor', 'running');
  }

  public start(stageId: string, currentItem?: string): void {
    const stage = this.requireStage(stageId);
    stage.status = 'running';
    stage.percent = 0;
    this.persist(stage.id, stage.label, 'running', currentItem);
  }

  public complete(stageId: string): void {
    const stage = this.requireStage(stageId);
    stage.status = 'completed';
    stage.percent = 100;
    this.persist(stage.id, stage.label, 'running');
  }

  public batch(stageId: string, completed: number, total: number, lastItem?: string): void {
    const stage = this.requireStage(stageId);
    stage.status = 'running';
    stage.percent = total > 0 ? Math.min(99, Math.round((completed / total) * 100)) : 0;
    const elapsedMs = Math.max(1, Date.now() - Date.parse(this.startedAt));
    const itemsPerSecond = completed > 0 ? completed / (elapsedMs / 1000) : 0;
    const estimatedRemainingMs = itemsPerSecond > 0 ? Math.round(((total - completed) / itemsPerSecond) * 1000) : undefined;
    this.persist(stage.id, stage.label, 'running', lastItem, undefined, {
      lastItem,
      processedItems: completed,
      totalItems: total,
      itemsPerSecond,
      estimatedRemainingMs,
    });
  }

  public heartbeat(stageId: string, currentItem?: string): void {
    const stage = this.requireStage(stageId);
    this.persist(stage.id, stage.label, 'running', currentItem);
  }

  public skip(stageId: string): void {
    const stage = this.requireStage(stageId);
    stage.status = 'skipped';
    stage.percent = 100;
    this.persist(stage.id, `${stage.label} (omitida)`, 'running');
  }

  public completeBuild(): void {
    for (const stage of this.stages) {
      if (stage.status === 'pending') {
        stage.status = 'skipped';
        stage.percent = 100;
      }
    }
    this.persist('completed', 'Construcción terminada', 'completed');
  }

  public fail(error: unknown): void {
    const running = this.stages.find((stage) => stage.status === 'running');
    if (running) running.status = 'failed';
    this.persist(
      running?.id ?? 'failed',
      running?.label ?? 'Construcción fallida',
      'failed',
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }

  private requireStage(stageId: string): BuilderProgressStage {
    const stage = this.stages.find((candidate) => candidate.id === stageId);
    if (!stage) throw new Error(`Unknown builder progress stage: ${stageId}`);
    return stage;
  }

  private persist(
    phase: string,
    label: string,
    status: BuilderProgressState['status'],
    currentItem?: string,
    error?: string,
    metrics?: Pick<BuilderProgressState, 'lastItem' | 'processedItems' | 'totalItems' | 'itemsPerSecond' | 'estimatedRemainingMs'>,
  ): void {
    const completed = this.stages.filter((stage) => stage.status === 'completed' || stage.status === 'skipped').length;
    const runningFraction = this.stages.some((stage) => stage.status === 'running') ? 0.25 : 0;
    const percent = status === 'completed'
      ? 100
      : Math.min(99, Math.round(((completed + runningFraction) / this.stages.length) * 100));
    const now = new Date().toISOString();
    const state: BuilderProgressState = {
      schemaVersion: 2,
      phase,
      label,
      status,
      completed,
      total: this.stages.length,
      percent,
      ...(currentItem ? { currentItem } : {}),
      ...metrics,
      elapsedMs: Math.max(0, Date.now() - Date.parse(this.startedAt)),
      heartbeatAt: now,
      startedAt: this.startedAt,
      updatedAt: now,
      ...(error ? { error } : {}),
      stages: this.stages.map((stage) => ({ ...stage })),
    };
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch {
      fs.copyFileSync(temporaryPath, this.filePath);
      fs.rmSync(temporaryPath, { force: true });
    }
    process.stdout.write(`AUTOWP_PROGRESS ${JSON.stringify(state)}\n`);
  }

  private readPrevious(): BuilderProgressState | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as BuilderProgressState;
      return Array.isArray(parsed.stages) ? parsed : null;
    } catch {
      return null;
    }
  }
}
