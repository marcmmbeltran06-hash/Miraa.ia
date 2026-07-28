import { apiClient } from './client.ts';
import type { CrawlJobSummary } from './types.ts';

export interface ReportShareSummary {
  token: string;
  recipient: string;
  url?: string;
  createdAt: string;
  firstOpenedAt: string | null;
  lastOpenedAt?: string | null;
  viewCount: number;
}

export interface CampaignStatus {
  campaignId: string;
  status?: 'starting' | 'completed' | 'completed_with_errors' | 'not_found';
  total?: number;
  remaining?: number;
  elapsedSeconds?: number;
  completed?: Array<{ name: string; website: string; phone?: string; slug: string; durationMs?: number }>;
  failed?: Array<{ name: string; website: string; errors?: string[] }>;
  published?: boolean;
  publishError?: string;
  updatedExcel?: string;
  updatedExcelReady?: boolean;
}

export const crawlApi = {
  submit(url: string): Promise<{ jobId: string }> {
    return apiClient.post<{ jobId: string }>('/crawl', { url });
  },
  getStatus(jobId: string): Promise<CrawlJobSummary> {
    return apiClient.get<CrawlJobSummary>(`/crawl/${jobId}`);
  },
  cancel(jobId: string): Promise<{ ok: true }> {
    return apiClient.post<{ ok: true }>(`/crawl/${jobId}/cancel`, {});
  },
  buildWordPress(jobId: string): Promise<{ ok: true }> {
    return apiClient.post<{ ok: true }>(`/crawl/${jobId}/build-wordpress`, {});
  },
  pauseWordPressBuild(jobId: string): Promise<{ ok: true }> {
    return apiClient.post<{ ok: true }>(`/crawl/${jobId}/pause-build`, {});
  },
  resumeWordPressBuild(jobId: string): Promise<{ ok: true }> {
    return apiClient.post<{ ok: true }>(`/crawl/${jobId}/resume-build`, {});
  },
  cancelWordPressBuild(jobId: string): Promise<{ ok: true }> {
    return apiClient.post<{ ok: true }>(`/crawl/${jobId}/cancel-build`, {});
  },
  restartSite(jobId: string): Promise<{ ok: true }> {
    return apiClient.post<{ ok: true }>(`/crawl/${jobId}/restart-site`, {});
  },
  rerunValidation(jobId: string): Promise<{ ok: true }> {
    return apiClient.post<{ ok: true }>(`/crawl/${jobId}/rerun-validation`, {});
  },
  stopSite(jobId: string): Promise<{ ok: true }> {
    return apiClient.post<{ ok: true }>(`/crawl/${jobId}/stop-site`, {});
  },
  health(): Promise<{ status: string }> {
    return apiClient.get<{ status: string }>('/health');
  },
  submitReportBatch(urls: string[], mode: 'full' | 'quick'): Promise<{ jobs: Array<{ url: string; jobId: string }> }> {
    return apiClient.post<{ jobs: Array<{ url: string; jobId: string }> }>('/reports/batch', { urls, mode });
  },
  getReportBatchStatus(jobIds: string[]): Promise<{ jobs: CrawlJobSummary[] }> {
    return apiClient.post<{ jobs: CrawlJobSummary[] }>('/reports/status', { jobIds });
  },
  reportUrl(jobId: string, format: 'html' | 'pdf' | 'json' | 'csv' | 'zip'): string {
    const base = import.meta.env.VITE_API_URL ?? '/api';
    return `${base}/reports/${jobId}/${format}`;
  },
  createReportShare(jobId: string, recipient: string): Promise<ReportShareSummary> {
    return apiClient.post<ReportShareSummary>(`/reports/${jobId}/share`, { recipient });
  },
  getReportShare(jobId: string, token: string): Promise<ReportShareSummary> {
    return apiClient.get<ReportShareSummary>(`/reports/${jobId}/share/${token}`);
  },
  absoluteShareUrl(relativeUrl: string): string {
    const base = import.meta.env.VITE_API_URL ?? '/api';
    return new URL(`${base}${relativeUrl}`, window.location.origin).toString();
  },
  startExcelCampaign(file: File, limit: number, publish: boolean): Promise<{ campaignId: string; totalRequested: number }> {
    return apiClient.upload(`/campaign/excel?limit=${limit}&publish=${publish}`, file);
  },
  startSingleCampaign(input: { url: string; name?: string; phone?: string; publish?: boolean }): Promise<{ campaignId: string; totalRequested: number }> {
    return apiClient.post('/campaign/single', input);
  },
  getCampaignStatus(campaignId: string): Promise<CampaignStatus> {
    return apiClient.get(`/campaign/${campaignId}`);
  },
  campaignExcelUrl(campaignId: string): string {
    const base = import.meta.env.VITE_API_URL ?? '/api';
    return `${base}/campaign/${campaignId}/excel`;
  },
};
