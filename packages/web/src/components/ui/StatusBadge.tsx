import { Badge } from './Badge.tsx';
import type { JobStatus } from '../../api/types.ts';

const STATUS_MAP: Record<string, { label: string; variant: 'success' | 'warning' | 'info' | 'danger' | 'neutral' }> = {
  pending: { label: 'Pendiente', variant: 'neutral' },
  running: { label: 'Rastreando', variant: 'info' },
  completed: { label: 'Rastreo completado', variant: 'success' },
  exporting: { label: 'Preparando WordPress', variant: 'info' },
  building_wordpress: { label: 'Construyendo WordPress', variant: 'info' },
  starting_docker: { label: 'Iniciando Docker', variant: 'info' },
  waiting_for_wordpress: { label: 'Esperando a WordPress', variant: 'warning' },
  validating: { label: 'Validando reconstrucción', variant: 'info' },
  ready: { label: 'WordPress listo', variant: 'success' },
  needs_review: { label: 'Necesita revisión', variant: 'warning' },
  needs_reconstruction: { label: 'Necesita reconstrucción', variant: 'warning' },
  partially_completed: { label: 'Proceso interrumpido', variant: 'warning' },
  source_files_required: { label: 'Faltan archivos de origen', variant: 'warning' },
  finished: { label: 'Sitio detenido', variant: 'neutral' },
  failed: { label: 'Error', variant: 'danger' },
  build_failed_recoverable: { label: 'Error recuperable', variant: 'danger' },
  cancelled: { label: 'Cancelado', variant: 'warning' },
  unknown: { label: 'Desconocido', variant: 'neutral' },
};

interface StatusBadgeProps {
  status: JobStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const { label, variant } = STATUS_MAP[status] ?? STATUS_MAP.unknown;
  return <Badge label={label} variant={variant} />;
}
