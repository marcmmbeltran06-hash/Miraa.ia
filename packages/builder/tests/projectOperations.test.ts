import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanProject, inspectProject, resolveProjectPath, validateProject } from '../src/ProjectOperations.js';

const temporaryPaths: string[] = [];

function temporaryProject(): string {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'autowp-operations-'));
  temporaryPaths.push(projectPath);
  fs.mkdirSync(path.join(projectPath, 'validation'), { recursive: true });
  return projectPath;
}

afterEach(() => {
  for (const projectPath of temporaryPaths.splice(0)) {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

describe('ProjectOperations', () => {
  it('resolves and inspects an existing project without changing it', () => {
    const projectPath = temporaryProject();
    const progress = {
      version: 1,
      overallPercent: 54,
      currentStage: 'validation',
      status: 'running',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(
      path.join(projectPath, 'validation', 'builder-progress.json'),
      JSON.stringify(progress),
    );

    expect(resolveProjectPath(projectPath)).toBe(projectPath);
    const inspection = inspectProject(projectPath);

    expect(inspection.projectPath).toBe(projectPath);
    expect(inspection.progress).toEqual(progress);
    expect(inspection.progressHealth.status).toBe('stale');
    expect(fs.existsSync(path.join(projectPath, 'validation', 'acceptance-report.json'))).toBe(false);
  });

  it('validates fail-closed and persists acceptance evidence', () => {
    const projectPath = temporaryProject();
    const report = validateProject(projectPath);

    expect(report.status).toBe('blocked_by_environment');
    expect(report.failedChecks).toContain('quality-gate');
    expect(fs.existsSync(path.join(projectPath, 'validation', 'acceptance-report.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectPath, 'validation', 'quality-gate-report.json'))).toBe(true);
  });

  it('rejects unknown project identifiers', () => {
    expect(() => resolveProjectPath('missing-autowp-project-id')).toThrow(/Project not found/);
  });

  it('cleans safely when a project has no Docker definition', () => {
    const projectPath = temporaryProject();
    const marker = path.join(projectPath, 'captured-page.html');
    fs.writeFileSync(marker, '<main>preserved</main>');

    const result = cleanProject(projectPath);

    expect(result.containersRemoved).toBe(false);
    expect(result.volumesPreserved).toBe(true);
    expect(result.capturedDataPreserved).toBe(true);
    expect(fs.readFileSync(marker, 'utf8')).toBe('<main>preserved</main>');
  });
});
