import { runSourceRefresh } from '@evo-tree/scientific-data';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

interface LatestPointer {
  datasetVersion: string;
  fileName: string;
  generatedAt: string;
}

interface CliOptions {
  mediaOnline: boolean;
  mediaTargetLimit?: number | undefined;
  mediaTimeoutMs?: number | undefined;
  mediaRetries?: number | undefined;
  progress: boolean;
  progressIntervalPercent?: number | undefined;
}

async function refreshData(options: CliOptions) {
  const workspaceRoot = process.env.INIT_CWD ?? process.cwd();
  const candidateDir = resolve(workspaceRoot, 'data/candidate');
  const approvedDir = resolve(workspaceRoot, 'data/approved');

  const refreshOptions = {
    mediaOnline: options.mediaOnline,
    ...(options.mediaTargetLimit !== undefined
      ? { mediaTargetLimit: options.mediaTargetLimit }
      : {}),
    ...(options.mediaTimeoutMs !== undefined ? { mediaTimeoutMs: options.mediaTimeoutMs } : {}),
    ...(options.mediaRetries !== undefined ? { mediaRetries: options.mediaRetries } : {}),
    progress: options.progress,
    ...(options.progressIntervalPercent !== undefined
      ? { progressIntervalPercent: options.progressIntervalPercent }
      : {}),
    mediaUserAgent: 'evo-tree-data-refresh/0.1'
  };

  const result = await runSourceRefresh(
    {
      sourceSpeciesListPath: resolve(workspaceRoot, 'data/source/species-list.txt'),
      cacheDir: resolve(workspaceRoot, 'data/cache'),
      candidateDir,
      approvedDir
    },
    refreshOptions
  );

  const webPublicDataRoot = resolve(workspaceRoot, 'apps/web/public/data');
  await mirrorLatestDataset(candidateDir, join(webPublicDataRoot, 'candidate'));
  await mirrorLatestDataset(approvedDir, join(webPublicDataRoot, 'approved'));

  return result.summary;
}

async function mirrorLatestDataset(sourceDir: string, targetDir: string): Promise<void> {
  const latestPath = join(sourceDir, 'latest.json');

  let pointerRaw: string;
  try {
    pointerRaw = await readFile(latestPath, 'utf8');
  } catch {
    return;
  }

  const pointer = JSON.parse(pointerRaw) as LatestPointer;
  const sourceDatasetPath = join(sourceDir, pointer.fileName);

  await mkdir(targetDir, { recursive: true });
  await copyFile(latestPath, join(targetDir, 'latest.json'));
  await copyFile(sourceDatasetPath, join(targetDir, pointer.fileName));
}

function parseOptionalNumberFlag(name: string): number | undefined {
  const prefix = `${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) {
    const npmConfigKey = `npm_config_${name.replace(/^--/, '').replace(/-/g, '_')}`;
    const fromEnv = process.env[npmConfigKey];
    if (!fromEnv) {
      return undefined;
    }

    const envValue = Number(fromEnv);
    return Number.isFinite(envValue) ? envValue : undefined;
  }

  const value = Number(arg.slice(prefix.length));
  return Number.isFinite(value) ? value : undefined;
}

function hasBooleanFlag(name: string): boolean {
  if (process.argv.includes(name)) {
    return true;
  }

  const npmConfigKey = `npm_config_${name.replace(/^--/, '').replace(/-/g, '_')}`;
  const fromEnv = process.env[npmConfigKey];
  return fromEnv === 'true' || fromEnv === '1';
}

const options: CliOptions = {
  mediaOnline: true,
  mediaTargetLimit: parseOptionalNumberFlag('--media-target-limit'),
  mediaTimeoutMs: parseOptionalNumberFlag('--media-timeout-ms'),
  mediaRetries: parseOptionalNumberFlag('--media-retries'),
  progress: hasBooleanFlag('--progress'),
  progressIntervalPercent: parseOptionalNumberFlag('--progress-interval-percent')
};

refreshData(options)
  .then((summary) => {
    console.log('data:refresh source-compiler summary');
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
