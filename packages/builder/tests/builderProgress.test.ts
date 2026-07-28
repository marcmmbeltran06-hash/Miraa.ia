import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BuilderProgressReporter, type BuilderProgressState } from '../src/BuilderProgress.js';

function readProgress(directory: string): BuilderProgressState {
  return JSON.parse(fs.readFileSync(path.join(directory, 'builder-progress.json'), 'utf8')) as BuilderProgressState;
}

describe('BuilderProgressReporter', () => {
  it('persists monotonic, structured progress and completes at 100 percent', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autowp-progress-'));
    const reporter = new BuilderProgressReporter(directory);
    const initial = readProgress(directory);

    reporter.start('media');
    reporter.complete('media');
    const afterMedia = readProgress(directory);
    reporter.start('capture', '/');
    reporter.complete('capture');
    reporter.completeBuild();
    const completed = readProgress(directory);

    expect(afterMedia.percent).toBeGreaterThanOrEqual(initial.percent);
    expect(completed.status).toBe('completed');
    expect(completed.percent).toBe(100);
    expect(completed.stages.every((stage) => stage.status === 'completed' || stage.status === 'skipped')).toBe(true);
    expect(completed.stages.find((stage) => stage.id === 'runtime')?.status).toBe('skipped');
  });

  it('records the active stage and failure without exposing a false completion', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autowp-progress-failure-'));
    const reporter = new BuilderProgressReporter(directory);
    reporter.start('commerce');
    reporter.fail(new Error('Import failed'));
    const failed = readProgress(directory);

    expect(failed.status).toBe('failed');
    expect(failed.phase).toBe('commerce');
    expect(failed.error).toBe('Import failed');
    expect(failed.percent).toBeLessThan(100);
    expect(failed.stages.find((stage) => stage.id === 'commerce')?.status).toBe('failed');
  });
});
