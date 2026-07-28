import { useQuery } from '@tanstack/react-query';
import { crawlApi } from '../api/crawl.ts';
import type { CrawlJobSummary, JobStatus } from '../api/types.ts';

const ACTIVE_STATUSES: JobStatus[] = ['pending', 'running', 'completed', 'exporting', 'building_wordpress', 'starting_docker', 'waiting_for_wordpress', 'validating'];

export function useCrawlJob(jobId: string | undefined) {
  return useQuery<CrawlJobSummary>({
    queryKey: ['crawl', jobId],
    queryFn: () => crawlApi.getStatus(jobId!),
    enabled: jobId !== undefined,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status !== undefined && ACTIVE_STATUSES.includes(status) ? 2000 : false;
    },
    staleTime: 1000,
  });
}
