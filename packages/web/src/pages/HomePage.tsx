import { useEffect, useState } from 'react';
import { ErrorMessage } from '../components/ui/ErrorMessage.tsx';
import { Spinner } from '../components/ui/Spinner.tsx';
import { crawlApi, type CampaignStatus } from '../api/crawl.ts';

type Mode = 'single' | 'excel';

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function CampaignProgress({ status }: { status: CampaignStatus }) {
  const completed = status.completed?.length ?? 0;
  const failed = status.failed?.length ?? 0;
  const total = status.total ?? completed + failed + (status.remaining ?? 0);
  const percentage = total > 0 ? Math.round(((completed + failed) / total) * 100) : 0;
  return (
    <section className="mt-6 rounded-2xl border border-violet-100 bg-violet-50 p-6" aria-live="polite">
      <div className="flex items-center justify-between gap-4">
        <div><p className="text-xs font-semibold uppercase tracking-widest text-violet-600">Campaña en marcha</p><h2 className="mt-1 text-xl font-bold text-gray-900">{completed} de {total || '…'} informes procesados</h2></div>
        <strong className="text-2xl text-violet-700">{percentage}%</strong>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white"><div className="h-full rounded-full bg-violet-600 transition-all" style={{ width: `${percentage}%` }} /></div>
      <div className="mt-4 grid grid-cols-3 gap-3 text-center text-sm">
        <div className="rounded-xl bg-white p-3"><b className="block text-lg">{completed}</b>Terminados</div>
        <div className="rounded-xl bg-white p-3"><b className="block text-lg">{status.remaining ?? 0}</b>Pendientes</div>
        <div className="rounded-xl bg-white p-3"><b className="block text-lg">{failed}</b>Fallidos</div>
      </div>
      {status.elapsedSeconds !== undefined && <p className="mt-4 text-xs text-gray-500">Tiempo transcurrido: {Math.floor(status.elapsedSeconds / 3600)} h {Math.floor((status.elapsedSeconds % 3600) / 60)} min.</p>}
      {status.status?.startsWith('completed') && <p className="mt-4 font-semibold text-green-700">Campaña terminada. Los enlaces publicados usan miraia.space/nombre-del-negocio.</p>}
      {status.updatedExcelReady && (
        <a
          className="mt-4 inline-flex rounded-lg bg-green-700 px-4 py-3 font-semibold text-white"
          href={crawlApi.campaignExcelUrl(status.campaignId)}
          download
        >
          Descargar Excel actualizado
        </a>
      )}
      {status.publishError && <p className="mt-3 text-sm text-red-700">Los informes se generaron, pero GitHub no pudo publicarlos: {status.publishError}</p>}
    </section>
  );
}

export function HomePage() {
  const [mode, setMode] = useState<Mode>('single');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [limit, setLimit] = useState(2000);
  const [publish, setPublish] = useState(true);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [status, setStatus] = useState<CampaignStatus | null>(null);

  useEffect(() => {
    if (!campaignId) return;
    let active = true;
    const update = async () => {
      try {
        const next = await crawlApi.getCampaignStatus(campaignId);
        if (active) setStatus(next);
      } catch {
        // A temporary status failure must not stop the campaign.
      }
    };
    void update();
    const timer = window.setInterval(() => void update(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [campaignId]);

  async function handleSingle(event: React.FormEvent) {
    event.preventDefault();
    if (!isValidHttpUrl(url.trim())) {
      setValidationError('Introduce una URL HTTP o HTTPS válida.');
      return;
    }
    setValidationError(null);
    setError(null);
    setIsPending(true);
    try {
      const result = await crawlApi.startSingleCampaign({ url: url.trim(), name: name.trim(), phone: phone.trim(), publish });
      setCampaignId(result.campaignId);
      setStatus({ campaignId: result.campaignId, status: 'starting', total: 1, remaining: 1, completed: [], failed: [] });
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('No se pudo iniciar la prueba.'));
    } finally {
      setIsPending(false);
    }
  }

  async function handleExcel(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setValidationError('Selecciona el Excel de la campaña.');
      return;
    }
    setValidationError(null);
    setError(null);
    setIsPending(true);
    try {
      const result = await crawlApi.startExcelCampaign(file, limit, publish);
      setCampaignId(result.campaignId);
      setStatus({ campaignId: result.campaignId, status: 'starting', total: result.totalRequested, remaining: result.totalRequested, completed: [], failed: [] });
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('No se pudo iniciar la campaña.'));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl py-10">
      <div className="mb-8 text-center">
        <span className="inline-grid h-14 w-14 place-items-center rounded-full bg-violet-600 text-3xl text-white" aria-hidden="true">✦</span>
        <h1 className="mt-5 text-4xl font-bold tracking-tight text-gray-950">Generador de informes Mira</h1>
        <p className="mx-auto mt-3 max-w-2xl text-gray-500">Prueba una tienda o carga el Excel completo. El programa analiza webs en paralelo, genera el probador y prepara cada enlace personalizado.</p>
      </div>

      <div className="mb-5 grid grid-cols-2 rounded-xl bg-gray-100 p-1">
        <button onClick={() => { setMode('single'); setValidationError(null); }} className={`rounded-lg px-4 py-3 font-semibold ${mode === 'single' ? 'bg-white text-violet-700 shadow-sm' : 'text-gray-500'}`}>Probar una web</button>
        <button onClick={() => { setMode('excel'); setValidationError(null); }} className={`rounded-lg px-4 py-3 font-semibold ${mode === 'excel' ? 'bg-white text-violet-700 shadow-sm' : 'text-gray-500'}`}>Crear desde Excel</button>
      </div>

      {mode === 'single' ? (
        <form onSubmit={handleSingle} className="rounded-2xl border border-gray-100 bg-white p-8 shadow-md">
          <h2 className="text-xl font-bold">Prueba completa con una tienda</h2>
          <p className="mt-1 text-sm text-gray-500">Utilízala primero para medir la velocidad real de la GPU.</p>
          <label htmlFor="url-input" className="mt-6 block text-sm font-medium text-gray-700">URL de la web</label>
          <input id="url-input" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://tienda.com" className="mt-2 w-full rounded-lg border border-gray-300 px-4 py-3" required />
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-gray-700">Nombre del negocio<input value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-4 py-3" placeholder="Opcional" /></label>
            <label className="text-sm font-medium text-gray-700">Teléfono asociado<input value={phone} onChange={(event) => setPhone(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-4 py-3" placeholder="+34…" /></label>
          </div>
          <label className="mt-5 flex items-center gap-2 text-sm text-gray-600"><input type="checkbox" checked={publish} onChange={(event) => setPublish(event.target.checked)} /> Publicar en GitHub cuando termine</label>
          {validationError && <p className="mt-3 text-sm text-red-600">{validationError}</p>}
          <button disabled={isPending || !url.trim()} className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-6 py-3 font-semibold text-white disabled:opacity-50">{isPending ? <><Spinner size="sm" label="" />Iniciando…</> : 'Analizar y generar prueba'}</button>
        </form>
      ) : (
        <form onSubmit={handleExcel} className="rounded-2xl border border-gray-100 bg-white p-8 shadow-md">
          <h2 className="text-xl font-bold">Campaña masiva desde Excel</h2>
          <p className="mt-1 text-sm text-gray-500">Formato reconocido: Nombre, Teléfono, Página Web y Dirección.</p>
          <label className="mt-6 block rounded-xl border-2 border-dashed border-violet-200 bg-violet-50 p-6 text-center">
            <span className="block font-semibold text-violet-800">{file?.name ?? 'Seleccionar Excel .xlsx'}</span>
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="mt-3 text-sm" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <label className="mt-5 block text-sm font-medium text-gray-700">Máximo de informes<input type="number" min={1} max={4000} value={limit} onChange={(event) => setLimit(Number(event.target.value))} className="mt-2 w-full rounded-lg border border-gray-300 px-4 py-3" /></label>
          <label className="mt-5 flex items-center gap-2 text-sm text-gray-600"><input type="checkbox" checked={publish} onChange={(event) => setPublish(event.target.checked)} /> Publicar los resultados en GitHub al terminar</label>
          {validationError && <p className="mt-3 text-sm text-red-600">{validationError}</p>}
          <button disabled={isPending || !file} className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-6 py-3 font-semibold text-white disabled:opacity-50">{isPending ? <><Spinner size="sm" label="" />Subiendo…</> : 'Iniciar campaña en paralelo'}</button>
        </form>
      )}

      {error && <div className="mt-5"><ErrorMessage title="No se pudo iniciar" message={error.message} /></div>}
      {status && <CampaignProgress status={status} />}
    </div>
  );
}
