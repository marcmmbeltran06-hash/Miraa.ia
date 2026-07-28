import { AutoWPBuilder } from '@autowp/builder';

const [inputPath, outputPath, portRaw, jobId, adminPassword, databasePassword] = process.argv.slice(2);
if (!inputPath || !outputPath || !portRaw || !jobId || !adminPassword || !databasePassword) {
  throw new Error('Builder worker requires inputPath, outputPath, port, jobId and per-job credentials');
}
const port = Number(portRaw);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid site port');

await new AutoWPBuilder().build({
  inputPath,
  outputPath,
  projectName: `AutoWP ${jobId}`,
  dockerProject: `autowp-${jobId}`,
  adminUser: 'admin',
  adminPassword,
  databasePassword,
  sitePort: port,
  startDocker: false,
  openBrowser: false,
});
