import type { SourceProject } from '../types.js';

export interface SnapshotResult {
  mirrorPath: string;
  pageCount: number;
  localizedAssets: number;
  missingAssets: string[];
  engine: 'snapshot' | 'exact' | 'legacy';
}

export interface CaptureToolStatus {
  browsertrix: { available: boolean; version?: string; command: string };
  singleFile: { available: boolean; version?: string; command: string };
  playwright: { available: boolean; version?: string };
}

export interface SnapshotSource {
  source: SourceProject;
  rootPath: string;
}
