import { useParams } from 'react-router-dom';
import { useCrawlJob } from '../hooks/useCrawlJob.ts';
import { ProgressBar } from '../components/ui/ProgressBar.tsx';
import { StatusBadge } from '../components/ui/StatusBadge.tsx';
import { Card } from '../components/ui/Card.tsx';
import { Spinner } from '../components/ui/Spinner.tsx';
import { ErrorMessage } from '../components/ui/ErrorMessage.tsx';
import { crawlApi } from '../api/crawl.ts';

const ACTIVE = new Set([
  'pending',
  'running',
  'completed',
  'exporting',
  'building_wordpress',
  'starting_docker',
  'waiting_for_wordpress',
  'validating',
]);

function durationLabel(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return 'Calculando';
  const seconds = Math.max(0, Math.round(value / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : minutes > 0 ? `${minutes} min ${remainder} s` : `${remainder} s`;
}

export function DashboardPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { data: job, isLoading, error, refetch } = useCrawlJob(jobId);

  if (isLoading) {
    return <div className="flex items-center justify-center py-24"><Spinner size="lg" label="Cargando constructor…" /></div>;
  }
  if (error || !job) {
    return <ErrorMessage title="No se pudo cargar el trabajo" message={error instanceof Error ? error.message : 'Trabajo no encontrado'} onRetry={() => refetch()} />;
  }

  const active = ACTIVE.has(job.status);
  const canOpen = Boolean(job.siteUrl) && ['ready', 'needs_review', 'needs_reconstruction'].includes(job.status);
  const automaticRetryScheduled = job.builderStatus?.startsWith('retry_scheduled_') ?? false;
  const progressValue = job.builderProgress?.percent ?? job.progress;
  const progressLabel = job.builderProgress?.label ?? 'Rastreo y preparación';

  async function siteAction(action: 'build' | 'pause' | 'resume' | 'cancelBuild' | 'restart' | 'validate' | 'stop') {
    if (!jobId) return;
    if (action === 'build') await crawlApi.buildWordPress(jobId);
    if (action === 'pause') await crawlApi.pauseWordPressBuild(jobId);
    if (action === 'resume') await crawlApi.resumeWordPressBuild(jobId);
    if (action === 'cancelBuild') await crawlApi.cancelWordPressBuild(jobId);
    if (action === 'restart') await crawlApi.restartSite(jobId);
    if (action === 'validate') await crawlApi.rerunValidation(jobId);
    if (action === 'stop') await crawlApi.stopSite(jobId);
    await refetch();
  }

  async function cancel() {
    if (!jobId) return;
    await crawlApi.cancel(jobId);
    await refetch();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <StatusBadge status={job.status} />
            {active && <Spinner size="sm" label="" />}
          </div>
          <h1 className="mt-2 truncate text-xl font-semibold text-gray-900" title={job.url}>{job.url}</h1>
          <p className="text-sm text-gray-500">Job ID: {job.jobId}</p>
        </div>
        {active && <button type="button" onClick={() => void cancel()} className="rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50">Cancelar</button>}
      </div>

      <Card title="Progreso del constructor">
        <ProgressBar value={progressValue} label={progressLabel} />
        <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
          <div><dt className="text-gray-500">Páginas capturadas</dt><dd className="text-2xl font-semibold text-gray-900">{job.pagesVisited}</dd></div>
          <div><dt className="text-gray-500">Pendientes</dt><dd className="text-2xl font-semibold text-gray-900">{job.pagesPending}</dd></div>
          <div><dt className="text-gray-500">Fase actual</dt><dd className="font-medium text-gray-900">{job.builderProgress?.label ?? job.builderStatus ?? job.status}</dd></div>
        </dl>
        {job.builderProgress && (
          <dl className="mt-5 grid gap-3 rounded border border-gray-200 p-3 text-sm sm:grid-cols-3">
            <div><dt className="text-gray-500">Elementos</dt><dd>{job.builderProgress.processedItems ?? job.builderProgress.completed} de {job.builderProgress.totalItems ?? job.builderProgress.total}</dd></div>
            <div><dt className="text-gray-500">Velocidad</dt><dd>{job.builderProgress.itemsPerSecond ? `${job.builderProgress.itemsPerSecond.toFixed(2)}/s` : 'Calculando'}</dd></div>
            <div><dt className="text-gray-500">Tiempo restante</dt><dd>{durationLabel(job.builderProgress.estimatedRemainingMs)}</dd></div>
            <div><dt className="text-gray-500">Tiempo transcurrido</dt><dd>{durationLabel(job.builderProgress.elapsedMs)}</dd></div>
            <div><dt className="text-gray-500">Último elemento</dt><dd className="break-all">{job.builderProgress.lastItem ?? job.builderProgress.currentItem ?? 'Pendiente'}</dd></div>
            <div><dt className="text-gray-500">Última actividad</dt><dd>{job.builderProgress.heartbeatAt ? new Date(job.builderProgress.heartbeatAt).toLocaleTimeString() : 'Pendiente'}</dd></div>
          </dl>
        )}
        {job.builderProgress && (
          <ol className="mt-5 grid gap-2 text-sm sm:grid-cols-2">
            {job.builderProgress.stages.map((stage) => (
              <li key={stage.id} className="flex items-center gap-2 rounded border border-gray-200 px-3 py-2">
                <span aria-hidden="true">{stage.status === 'completed' ? '✓' : stage.status === 'running' ? '●' : stage.status === 'skipped' ? '–' : stage.status === 'failed' ? '!' : '○'}</span>
                <span className={stage.status === 'running' ? 'font-semibold text-blue-700' : stage.status === 'failed' ? 'font-semibold text-red-700' : 'text-gray-700'}>{stage.label}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title="WordPress generado">
        <div className="space-y-4">
          {canOpen && <a href={job.siteUrl} target="_blank" rel="noreferrer" className="inline-block rounded-md bg-blue-600 px-5 py-3 text-base font-semibold text-white hover:bg-blue-700">Abrir WordPress</a>}
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-gray-500">Carpeta del proyecto</dt><dd className="break-all font-mono">{job.sitePath ?? 'Pendiente'}</dd></div>
            <div><dt className="text-gray-500">Puerto local</dt><dd>{job.sitePort ?? 'Pendiente'}</dd></div>
          </dl>
          {job.builderError && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{job.builderError}</p>}
          {automaticRetryScheduled && <p className="rounded bg-amber-50 p-3 text-sm text-amber-800">Recuperación automática activa. No necesitas pulsar ningún botón.</p>}
          {job.status === 'needs_reconstruction' && <p className="rounded bg-amber-50 p-3 text-sm text-amber-800">WordPress está funcionando, pero la validación visual necesita revisión.</p>}
          <div className="flex flex-wrap gap-2">
            {active && job.builderStatus !== 'paused' && <button onClick={() => void siteAction('pause')} className="rounded border border-amber-300 px-3 py-2 text-amber-800">Pausar construcción</button>}
            {job.builderStatus === 'paused' && <button onClick={() => void siteAction('resume')} className="rounded border border-blue-300 px-3 py-2 text-blue-700">Reanudar construcción</button>}
            {active && <button onClick={() => void siteAction('cancelBuild')} className="rounded border border-red-300 px-3 py-2 text-red-700">Cancelar construcción</button>}
            {['failed', 'build_failed_recoverable'].includes(job.status) && <button onClick={() => void siteAction('build')} className="rounded border border-blue-300 px-3 py-2 text-blue-700">Reintentar construcción</button>}
            {job.sitePath && !active && <button onClick={() => void siteAction('restart')} className="rounded border border-gray-300 px-3 py-2">Reiniciar sitio</button>}
            {job.sitePath && !active && <button onClick={() => void siteAction('validate')} className="rounded border border-amber-300 px-3 py-2 text-amber-800">Validar de nuevo</button>}
            {job.sitePath && !active && <button onClick={() => void siteAction('stop')} className="rounded border border-red-300 px-3 py-2 text-red-700">Detener sitio</button>}
          </div>
        </div>
      </Card>
    </div>
  );
}
