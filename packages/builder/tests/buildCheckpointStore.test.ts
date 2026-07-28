import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BuildCheckpointStore,
  readBuildControl,
  updateBuildControl,
} from '../src/BuildCheckpointStore.js';

function temporaryBuild(prefix: string): { input: string; output: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  return { input, output };
}

describe('BuildCheckpointStore', () => {
  it('persists batches for 500 pages and thousands of resources without losing progress', () => {
    const { input, output } = temporaryBuild('autowp-checkpoint-large-');
    const store = new BuildCheckpointStore(output, input, 'large-fixture');
    store.startPhase('preparation');
    for (let completed = 50; completed <= 500; completed += 50) {
      store.updateBatch('preparation', 'pages', completed, 500, `/page-${completed}`);
    }
    for (let completed = 250; completed <= 5_000; completed += 250) {
      store.updateBatch('preparation', 'resources', completed, 5_000, `asset-${completed}.jpg`);
    }
    store.completePhase('preparation');

    const resumed = new BuildCheckpointStore(output, input, 'large-fixture').snapshot();
    expect(resumed.phases.preparation.status).toBe('completed');
    expect(resumed.phases.preparation.batches.pages).toMatchObject({
      completed: 500,
      total: 500,
      lastItem: '/page-500',
    });
    expect(resumed.phases.preparation.batches.resources).toMatchObject({
      completed: 5_000,
      total: 5_000,
      lastItem: 'asset-5000.jpg',
    });
  });

  it('resumes every phase idempotently and preserves completed phases', () => {
    const { input, output } = temporaryBuild('autowp-checkpoint-phases-');
    const phases = ['preparation', 'resources', 'snapshot', 'wordpress_generation', 'docker', 'wpcli', 'validation'] as const;
    let store = new BuildCheckpointStore(output, input, 'phase-fixture');
    for (const phase of phases) {
      store.startPhase(phase);
      store.updateBatch(phase, 'items', 1, 2, `${phase}-1`);
      // Simulate a process/API restart in every phase.
      store = new BuildCheckpointStore(output, input, 'phase-fixture');
      expect(store.snapshot().phases[phase].batches.items.completed).toBe(1);
      store.startPhase(phase);
      store.updateBatch(phase, 'items', 2, 2, `${phase}-2`);
      store.completePhase(phase);
      // Repeating a completed phase never creates a duplicate batch.
      store = new BuildCheckpointStore(output, input, 'phase-fixture');
      expect(Object.keys(store.snapshot().phases[phase].batches)).toEqual(['items']);
      expect(store.isCompleted(phase)).toBe(true);
    }
  });

  it('supports pause, cancel and explicit resume using atomic state files', () => {
    const { input, output } = temporaryBuild('autowp-checkpoint-control-');
    const store = new BuildCheckpointStore(output, input, 'control-fixture');
    store.startPhase('resources');
    store.updateBatch('resources', 'media', 10, 100, 'image-10.jpg');
    expect(updateBuildControl(output, 'paused')).toBe(true);
    expect(readBuildControl(output)).toBe('paused');
    expect(() => store.heartbeat()).toThrow('AUTOWP_BUILD_PAUSED');

    expect(updateBuildControl(output, 'running')).toBe(true);
    const resumed = new BuildCheckpointStore(output, input, 'control-fixture');
    expect(resumed.snapshot().phases.resources.batches.media.completed).toBe(10);
    expect(updateBuildControl(output, 'cancelled')).toBe(true);
    expect(readBuildControl(output)).toBe('cancelled');
  });

  it('migrates legacy recoverable jobs without claiming live phases completed', () => {
    const { input, output } = temporaryBuild('autowp-checkpoint-legacy-');
    fs.mkdirSync(path.join(output, 'imports'), { recursive: true });
    fs.mkdirSync(path.join(output, 'snapshot'), { recursive: true });
    fs.mkdirSync(path.join(output, 'wp-content', 'themes', 'autowp'), { recursive: true });
    fs.mkdirSync(path.join(output, 'validation'), { recursive: true });
    fs.writeFileSync(path.join(output, 'imports', 'media-map.json'), '{}');
    fs.writeFileSync(path.join(output, 'snapshot', 'config.json'), '{}');
    fs.writeFileSync(path.join(output, 'docker-compose.yml'), 'services: {}');
    fs.writeFileSync(path.join(output, 'validation', 'build-report.json'), '{}');

    const state = new BuildCheckpointStore(output, input, 'legacy-fixture').snapshot();
    expect(state.phases.resources.status).toBe('completed');
    expect(state.phases.snapshot.status).toBe('completed');
    expect(state.phases.wordpress_generation.status).toBe('completed');
    expect(state.phases.docker.status).toBe('pending');
    expect(state.phases.wpcli.status).toBe('pending');
    expect(state.phases.validation.status).toBe('pending');
  });
});
