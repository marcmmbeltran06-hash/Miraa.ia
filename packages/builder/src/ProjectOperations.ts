import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAcceptanceReport, type AcceptanceReport } from './acceptance/AcceptanceEvaluator.js';
import { evaluateQualityGate } from './validation/QualityGate.js';

export interface DoctorCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

export interface DoctorReport {
  version: 1;
  generatedAt: string;
  status: 'ready' | 'needs_attention';
  checks: DoctorCheck[];
}

export interface ProjectInspection {
  version: 1;
  generatedAt: string;
  projectPath: string;
  progressHealth: {
    status: 'not_available' | 'active' | 'stale' | 'completed' | 'failed';
    ageSeconds?: number;
    message: string;
  };
  progress?: unknown;
  build?: unknown;
  quality?: unknown;
  acceptance?: unknown;
  runtime?: unknown;
  visual?: unknown;
  commerce?: unknown;
}

export interface ResumeResult {
  projectPath: string;
  dockerStarted: boolean;
  validationExecuted: boolean;
  acceptance: AcceptanceReport;
}

export interface CleanResult {
  projectPath: string;
  containersRemoved: boolean;
  volumesPreserved: true;
  capturedDataPreserved: true;
  message: string;
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function findWorkspaceRoot(startPath = process.cwd()): string {
  let current = path.resolve(startPath);
  while (path.dirname(current) !== current) {
    if (fs.existsSync(path.join(current, 'packages', 'builder', 'package.json'))) return current;
    current = path.dirname(current);
  }
  if (fs.existsSync(path.join(current, 'packages', 'builder', 'package.json'))) return current;
  return path.resolve(startPath);
}

export function resolveProjectPath(project: string, workspaceRoot = findWorkspaceRoot()): string {
  const direct = path.resolve(project);
  const generated = path.join(workspaceRoot, 'generated-sites', project);
  const resolved = fs.existsSync(direct) ? direct : generated;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Project not found: ${project}`);
  }
  return resolved;
}

function run(
  command: string,
  args: string[],
  options: Omit<childProcess.SpawnSyncOptionsWithStringEncoding, 'encoding'> = {},
): childProcess.SpawnSyncReturns<string> {
  return childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    ...options,
  });
}

function commandMessage(result: childProcess.SpawnSyncReturns<string>): string {
  return (result.stderr || result.stdout || result.error?.message || '').trim();
}

function occupiedDevelopmentPorts(): number[] {
  const result = run('netstat', ['-ano', '-p', 'tcp']);
  if (result.status !== 0) return [];
  const ports = new Set<number>();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue;
    const match = line.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/);
    if (!match) continue;
    const port = Number(match[1]);
    if (port === 3000 || port === 5173 || (port >= 8080 && port < 9000)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

export function doctor(workspaceRoot = findWorkspaceRoot()): DoctorReport {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    id: 'node',
    status: nodeMajor >= 20 ? 'pass' : 'fail',
    message: `Node.js ${process.versions.node}${nodeMajor >= 20 ? ' is supported.' : ' is too old; Node.js 20 or newer is required.'}`,
  });

  const workspaceWritable = path.join(workspaceRoot, '.autowp-doctor-write-check');
  try {
    fs.writeFileSync(workspaceWritable, 'ok');
    fs.unlinkSync(workspaceWritable);
    checks.push({ id: 'workspace-write', status: 'pass', message: `Workspace is writable: ${workspaceRoot}` });
  } catch (error) {
    checks.push({ id: 'workspace-write', status: 'fail', message: `Workspace is not writable: ${error instanceof Error ? error.message : String(error)}` });
  }

  try {
    const disk = fs.statfsSync(workspaceRoot);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    const freeGiB = freeBytes / (1024 ** 3);
    checks.push({
      id: 'disk',
      status: freeGiB >= 10 ? 'pass' : freeGiB >= 3 ? 'warn' : 'fail',
      message: `${freeGiB.toFixed(1)} GiB free on the workspace volume.`,
    });
  } catch (error) {
    checks.push({ id: 'disk', status: 'warn', message: `Free disk space could not be measured: ${error instanceof Error ? error.message : String(error)}` });
  }

  const docker = run('docker', ['version', '--format', '{{.Server.Version}}']);
  checks.push({
    id: 'docker',
    status: docker.status === 0 && docker.stdout.trim() ? 'pass' : 'fail',
    message: docker.status === 0 && docker.stdout.trim()
      ? `Docker Engine ${docker.stdout.trim()} is available.`
      : `Docker Engine is unavailable. ${commandMessage(docker)}`.trim(),
  });

  if (docker.status === 0) {
    const compose = run('docker', ['compose', 'version', '--short']);
    checks.push({
      id: 'docker-compose',
      status: compose.status === 0 ? 'pass' : 'fail',
      message: compose.status === 0 ? `Docker Compose ${compose.stdout.trim()} is available.` : `Docker Compose is unavailable. ${commandMessage(compose)}`.trim(),
    });
    const wpCli = run('docker', ['image', 'inspect', 'wordpress:cli-php8.3', '--format', '{{.Id}}']);
    checks.push({
      id: 'wp-cli-image',
      status: wpCli.status === 0 ? 'pass' : 'warn',
      message: wpCli.status === 0
        ? 'The WordPress CLI image is available locally.'
        : 'The WordPress CLI image is not cached; Docker will download it on the next build.',
    });
  }

  const ports = occupiedDevelopmentPorts();
  checks.push({
    id: 'ports',
    status: ports.length ? 'warn' : 'pass',
    message: ports.length
      ? `Active AutoWP/development ports: ${ports.join(', ')}. Existing services may already be running.`
      : 'No common AutoWP/development ports are currently occupied.',
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    status: checks.some((item) => item.status === 'fail') ? 'needs_attention' : 'ready',
    checks,
  };
}

export function inspectProject(project: string, workspaceRoot = findWorkspaceRoot()): ProjectInspection {
  const projectPath = resolveProjectPath(project, workspaceRoot);
  const validation = path.join(projectPath, 'validation');
  const progress = readJson(path.join(validation, 'builder-progress.json')) as Record<string, unknown> | undefined;
  const updatedAt = typeof progress?.updatedAt === 'string' ? Date.parse(progress.updatedAt) : Number.NaN;
  const ageSeconds = Number.isFinite(updatedAt) ? Math.max(0, Math.round((Date.now() - updatedAt) / 1000)) : undefined;
  const progressStatus = progress?.status;
  const progressHealth: ProjectInspection['progressHealth'] = !progress
    ? { status: 'not_available', message: 'No builder progress report exists.' }
    : progressStatus === 'completed'
      ? { status: 'completed', ageSeconds, message: 'The builder reported completion.' }
      : progressStatus === 'failed'
        ? { status: 'failed', ageSeconds, message: String(progress.error ?? 'The builder reported a failure.') }
        : ageSeconds !== undefined && ageSeconds > 300
          ? { status: 'stale', ageSeconds, message: `No builder progress update has been written for ${ageSeconds} seconds.` }
          : { status: 'active', ageSeconds, message: 'Builder progress was updated recently.' };
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    projectPath,
    progressHealth,
    progress,
    build: readJson(path.join(validation, 'build-report.json')),
    quality: readJson(path.join(validation, 'quality-gate-report.json')) ?? evaluateQualityGate(projectPath),
    acceptance: readJson(path.join(validation, 'acceptance-report.json')),
    runtime: readJson(path.join(validation, 'runtime-validation.json')),
    visual: readJson(path.join(validation, 'visual-validation-runtime.json')),
    commerce: readJson(path.join(validation, 'commerce-runtime-report.json')),
  };
}

export function validateProject(project: string, workspaceRoot = findWorkspaceRoot()): AcceptanceReport {
  const projectPath = resolveProjectPath(project, workspaceRoot);
  const validationPath = path.join(projectPath, 'validation');
  fs.mkdirSync(validationPath, { recursive: true });
  fs.writeFileSync(
    path.join(validationPath, 'quality-gate-report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), ...evaluateQualityGate(projectPath) }, null, 2),
  );
  return writeAcceptanceReport(projectPath);
}

/**
 * Removes only the generated project's containers and orphaned network.
 * Named volumes, captures, uploads and reports are deliberately preserved.
 */
export function cleanProject(project: string, workspaceRoot = findWorkspaceRoot()): CleanResult {
  const projectPath = resolveProjectPath(project, workspaceRoot);
  const composePath = path.join(projectPath, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) {
    return {
      projectPath,
      containersRemoved: false,
      volumesPreserved: true,
      capturedDataPreserved: true,
      message: 'No docker-compose.yml exists; there were no project containers to remove.',
    };
  }

  const docker = run('docker', ['compose', 'down', '--remove-orphans'], {
    cwd: projectPath,
    timeout: 120_000,
    env: { ...process.env, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT || 'desktop-linux' },
  });
  if (docker.status !== 0) {
    throw new Error(`Docker cleanup failed: ${commandMessage(docker) || `exit code ${docker.status}`}`);
  }
  return {
    projectPath,
    containersRemoved: true,
    volumesPreserved: true,
    capturedDataPreserved: true,
    message: 'Project containers and orphaned network were removed. Volumes and generated files were preserved.',
  };
}

/**
 * Resumes only the durable Docker/runtime-validation portion of a completed
 * generated project. It never deletes volumes, captured pages, imports, or
 * media. Earlier incomplete build phases must still be retried by the builder
 * because replaying them safely needs their original export input.
 */
export function resumeProject(project: string, workspaceRoot = findWorkspaceRoot()): ResumeResult {
  const projectPath = resolveProjectPath(project, workspaceRoot);
  const composePath = path.join(projectPath, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) {
    throw new Error('This project has no docker-compose.yml. Retry the builder with its original export instead of resuming Docker.');
  }

  const docker = run('docker', ['compose', 'up', '-d', '--wait'], {
    cwd: projectPath,
    timeout: Number(process.env.WORDPRESS_HEALTH_TIMEOUT_MS ?? 2_700_000),
    env: { ...process.env, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT || 'desktop-linux' },
  });
  if (docker.status !== 0) {
    throw new Error(`Docker resume failed: ${commandMessage(docker) || `exit code ${docker.status}`}`);
  }

  const validationScript = path.join(projectPath, 'validation', 'run-visual-validation.mjs');
  let validationExecuted = false;
  if (fs.existsSync(validationScript)) {
    const validation = run(process.execPath, [validationScript], {
      cwd: projectPath,
      timeout: Number(process.env.WORDPRESS_VISUAL_VALIDATION_TIMEOUT_MS ?? 2_700_000),
      env: { ...process.env, AUTOWP_WORKSPACE_PACKAGE: path.join(workspaceRoot, 'package.json') },
    });
    validationExecuted = true;
    if (validation.status !== 0) {
      throw new Error(`Runtime validation failed: ${commandMessage(validation) || `exit code ${validation.status}`}`);
    }
  }

  return {
    projectPath,
    dockerStarted: true,
    validationExecuted,
    acceptance: writeAcceptanceReport(projectPath),
  };
}
