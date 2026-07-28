#!/usr/bin/env node
import { AutoWPBuilder } from './AutoWPBuilder.js';
import { cleanProject, doctor, inspectProject, resumeProject, validateProject } from './ProjectOperations.js';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const command = process.argv[2];
const operationalCommands = new Set(['doctor', 'inspect', 'validate', 'resume', 'clean']);
if (command === 'doctor') {
  const report = doctor();
  print(report);
  process.exitCode = report.status === 'ready' ? 0 : 1;
} else if (command && operationalCommands.has(command)) {
  const project = readArg('--project');
  if (!project) {
    console.error(`Usage: autowp-builder ${command} --project <id|project-directory>`);
    process.exitCode = 1;
  } else if (command === 'inspect') {
    print(inspectProject(project));
  } else if (command === 'validate') {
    const report = validateProject(project);
    print(report);
    process.exitCode = report.status === 'ready' ? 0 : 2;
  } else if (command === 'resume') {
    const result = resumeProject(project);
    print(result);
    process.exitCode = result.acceptance.status === 'ready' ? 0 : 2;
  } else if (command === 'clean') {
    print(cleanProject(project));
  }
} else {
const inputPath = readArg('--input') ?? command;
const outputPath = readArg('--output') ?? process.argv[3] ?? 'autowp-wordpress-build';
const startDocker = process.argv.includes('--start-docker');
const openBrowser = process.argv.includes('--open-browser');
const sitePort = Number(readArg('--port') ?? 8080);
const dockerProject = readArg('--docker-project');
const reconstructionEngine = (readArg('--engine') ?? process.env.RECONSTRUCTION_ENGINE ?? 'exact') as 'snapshot' | 'exact' | 'legacy';

if (!inputPath) {
  console.error('Usage: autowp-builder <phase1-export.zip|directory> [output-dir] [--start-docker] [--open-browser]');
  process.exit(1);
}

const builder = new AutoWPBuilder();
if (!Number.isInteger(sitePort) || sitePort < 1 || sitePort > 65535) {
  console.error('The --port value must be an integer between 1 and 65535.');
  process.exit(1);
}

const result = await builder.build({ inputPath, outputPath, startDocker, openBrowser, sitePort, dockerProject, reconstructionEngine });
console.log(JSON.stringify(result, null, 2));
}
