import { useEffect, useMemo, useState } from 'react';
import { crawlApi } from '../api/crawl.ts';
import type { ReportShareSummary } from '../api/crawl.ts';
import type { CrawlJobSummary } from '../api/types.ts';
import { ErrorMessage } from '../components/ui/ErrorMessage.tsx';
import { ProgressBar } from '../components/ui/ProgressBar.tsx';
import { Spinner } from '../components/ui/Spinner.tsx';

interface BatchJob { url: string; jobId: string; client: string; status?: CrawlJobSummary }
const terminal = new Set(['finished', 'failed', 'cancelled']);

function validUrl(raw: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(raw).protocol); } catch { return false; }
}

function ShareControls({ jobId }: { jobId: string }) {
  const [recipient, setRecipient] = useState('');
  const [share, setShare] = useState<ReportShareSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const shareUrl = share?.url ? crawlApi.absoluteShareUrl(share.url) : '';

  useEffect(() => {
    if (!share || share.firstOpenedAt) return;
    const timer = window.setInterval(() => {
      void crawlApi.getReportShare(jobId, share.token).then((updated) => setShare({ ...updated, url: share.url }));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [jobId, share]);

  async function createShare() {
    setBusy(true);
    try { setShare(await crawlApi.createReportShare(jobId, recipient)); } finally { setBusy(false); }
  }

  if (share) {
    return (
      <div className="mt-4 rounded-xl bg-cyan-50 p-4">
        <p className="text-sm font-semibold text-cyan-950">
          {share.firstOpenedAt
            ? `Abierto ${share.viewCount} vez/veces · primera apertura ${new Date(share.firstOpenedAt).toLocaleString()}`
            : 'Enlace creado · todavía no se ha abierto'}
        </p>
        <div className="mt-2 flex gap-2">
          <input readOnly value={shareUrl} className="min-w-0 flex-1 rounded-lg border border-cyan-200 bg-white px-3 py-2 text-sm" />
          <button type="button" onClick={() => void navigator.clipboard.writeText(shareUrl)} className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white">Copiar</button>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
      <input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="Nombre del destinatario" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      <button type="button" disabled={busy || !recipient.trim()} onClick={() => void createShare()} className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Crear enlace personal</button>
    </div>
  );
}

export function ReportsPage() {
  const [urlsText, setUrlsText] = useState('');
  const [client, setClient] = useState('');
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<'full' | 'quick'>('full');
  const urls = useMemo(() => [...new Set(urlsText.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean))], [urlsText]);
  const invalid = urls.filter((url) => !validUrl(url));
  const active = jobs.some((job) => !job.status || !terminal.has(job.status.status));

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      void crawlApi.getReportBatchStatus(jobs.filter((job) => !job.status || !terminal.has(job.status.status)).map((job) => job.jobId))
        .then(({ jobs: updates }) => {
          const byId = new Map(updates.map((job) => [job.jobId, job]));
          setJobs((current) => current.map((job) => ({ ...job, status: byId.get(job.jobId) ?? job.status })));
        })
        .catch((cause) => setError(cause instanceof Error ? cause : new Error('No se pudo actualizar el lote.')));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [active, jobs]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (urls.length === 0 || urls.length > 4000 || invalid.length > 0) return;
    setSubmitting(true); setError(null);
    try {
      const result = await crawlApi.submitReportBatch(urls, mode);
      setJobs(result.jobs.map((job) => ({ ...job, client: client.trim() })));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('No se pudo iniciar el lote.'));
    } finally { setSubmitting(false); }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-3xl bg-slate-950 px-6 py-10 text-white shadow-xl sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">Operación de alto volumen</p>
        <h1 className="mt-3 max-w-3xl text-3xl font-bold sm:text-5xl">4.000 informes en una cola controlada</h1>
        <p className="mt-4 max-w-2xl text-slate-300">Modo rápido, sin WordPress. Genera un informe por dominio y un enlace personal que registra aperturas de forma transparente.</p>
      </section>
      <form onSubmit={submit} className="grid gap-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:grid-cols-[1fr_2fr]">
        <label><span className="mb-2 block text-sm font-semibold text-slate-700">Cliente o campaña</span><input value={client} onChange={(event) => setClient(event.target.value)} placeholder="Ej. Prospección julio 2026" className="w-full rounded-xl border border-slate-300 px-4 py-3" /></label>
        <label><span className="mb-2 block text-sm font-semibold text-slate-700">Enlaces, uno por línea</span><textarea rows={8} value={urlsText} onChange={(event) => setUrlsText(event.target.value)} placeholder={'https://empresa-uno.es\nhttps://empresa-dos.com'} className="w-full rounded-xl border border-slate-300 px-4 py-3 font-mono text-sm" /><span className={`mt-2 block text-xs ${invalid.length || urls.length > 4000 ? 'text-red-600' : 'text-slate-500'}`}>{invalid.length ? `${invalid.length} enlaces no válidos` : `${urls.length} de 4.000 webs preparadas`}</span></label>
        <fieldset className="lg:col-span-2">
          <legend className="mb-2 text-sm font-semibold text-slate-700">Nivel de análisis</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={`cursor-pointer rounded-xl border p-4 ${mode === 'full' ? 'border-cyan-600 bg-cyan-50' : 'border-slate-200'}`}>
              <input type="radio" className="mr-2" checked={mode === 'full'} onChange={() => setMode('full')} />
              <strong>Completo - recomendado</strong>
              <span className="mt-1 block text-sm text-slate-600">Recorre todas las páginas públicas que puede descubrir. Ideal para entregar un informe detallado a un cliente.</span>
            </label>
            <label className={`cursor-pointer rounded-xl border p-4 ${mode === 'quick' ? 'border-cyan-600 bg-cyan-50' : 'border-slate-200'}`}>
              <input type="radio" className="mr-2" checked={mode === 'quick'} onChange={() => setMode('quick')} />
              <strong>Rápido para miles de webs</strong>
              <span className="mt-1 block text-sm text-slate-600">Analiza una muestra de hasta 3 páginas. Úsalo cuando el plazo sea más importante que la cobertura total.</span>
            </label>
          </div>
        </fieldset>
        <button disabled={submitting || urls.length === 0 || urls.length > 4000 || invalid.length > 0} className="flex w-fit items-center gap-2 rounded-xl bg-cyan-600 px-6 py-3 font-semibold text-white disabled:opacity-50">{submitting && <Spinner size="sm" label="" />}Generar informes</button>
      </form>
      {error && <ErrorMessage title="No se pudo completar la operación" message={error.message} />}
      {jobs.length > 0 && <section><div className="mb-4 flex justify-between"><div><p className="text-sm text-cyan-700">{jobs[0]?.client || 'Lote de análisis'}</p><h2 className="text-2xl font-bold">Resultados por web</h2></div>{active && <span className="flex items-center gap-2 text-sm"><Spinner size="sm" label="" />Analizando</span>}</div>
        <div className="grid gap-4">{jobs.map((job) => {
          const done = job.status?.status === 'finished';
          return <article key={job.jobId} className="rounded-2xl border bg-white p-5 shadow-sm"><div className="flex flex-col gap-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="truncate font-semibold">{job.url}</p><p className="text-sm text-slate-500">{done ? `${job.status?.pagesVisited ?? 0} páginas · puntuación ${job.status?.seoScore ?? '—'}/100` : job.status?.status ?? 'En cola'}</p><div className="mt-3"><ProgressBar value={done ? 100 : job.status?.progress ?? 0} /></div></div>{done && <div className="flex gap-2"><a target="_blank" rel="noreferrer" href={crawlApi.reportUrl(job.jobId, 'html')} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Ver</a><a href={crawlApi.reportUrl(job.jobId, 'pdf')} className="rounded-lg border px-4 py-2 text-sm">PDF</a></div>}</div>{done && <ShareControls jobId={job.jobId} />}</article>;
        })}</div>
      </section>}
    </div>
  );
}
