import path from 'path';
import { config } from '../config';
import type { ArrBase } from './arrAdd';

// SAB's get_config response nests settings under config.misc. complete_dir can
// be relative (to SAB's base folder) depending on how SAB was set up; the arrs
// need an absolute path, so reject relative ones rather than guessing the base.
// path.win32 explicitly: SAB runs on Windows, and this keeps the tests
// deterministic if they ever run on another platform.
export function extractCompleteDir(sabConfig: unknown): string {
  const dir = (sabConfig as { config?: { misc?: { complete_dir?: unknown } } })
    ?.config?.misc?.complete_dir;
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new Error('SAB config has no complete_dir');
  }
  const trimmed = dir.trim();
  if (!path.win32.isAbsolute(trimmed)) {
    throw new Error(`SAB complete_dir is not absolute: ${trimmed}`);
  }
  return trimmed;
}

export function commandStatus(commandJson: unknown): string {
  const status = (commandJson as { status?: unknown })?.status;
  return typeof status === 'string' ? status : 'unknown';
}

// Terminal = the client should stop polling. 'unknown' is terminal on purpose:
// a garbage response must not leave the client polling forever.
export function isTerminal(status: string): boolean {
  return status !== 'queued' && status !== 'started';
}

async function fetchSabCompleteDir(): Promise<string> {
  const url = new URL(`${config.sabnzbd.url}/api`);
  url.searchParams.set('mode', 'get_config');
  url.searchParams.set('section', 'misc');
  url.searchParams.set('apikey', config.sabnzbd.apiKey);
  url.searchParams.set('output', 'json');
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`SAB get_config failed: HTTP ${res.status}`);
  return extractCompleteDir(await res.json());
}

async function postArrCommand(
  base: ArrBase,
  arrName: string,
  commandName: string,
  completeDir: string,
): Promise<number> {
  const res = await fetch(`${base.url}/api/v3/command`, {
    method: 'POST',
    headers: { 'X-Api-Key': base.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: commandName, path: completeDir, importMode: 'Move' }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${arrName} rejected ${commandName}: HTTP ${res.status}`);
  const data = (await res.json()) as { id?: unknown };
  if (typeof data.id !== 'number') throw new Error(`${arrName} returned no command id`);
  return data.id;
}

// Start a scan of SAB's completed folder in both arrs. Commands are fired
// sequentially (Sonarr first) to avoid both arrs Move-scanning the same tree
// at the same instant. If Radarr fails after Sonarr accepted, the Sonarr scan
// proceeds anyway (harmless — scans are idempotent) but we still throw so the
// user sees the error.
export async function startImportScan(): Promise<{
  sonarrCommandId: number;
  radarrCommandId: number;
}> {
  const completeDir = await fetchSabCompleteDir();
  const sonarrCommandId = await postArrCommand(
    config.sonarr, 'Sonarr', 'DownloadedEpisodesScan', completeDir,
  );
  const radarrCommandId = await postArrCommand(
    config.radarr, 'Radarr', 'DownloadedMoviesScan', completeDir,
  );
  return { sonarrCommandId, radarrCommandId };
}

async function fetchCommandStatus(base: ArrBase, id: number): Promise<string> {
  const res = await fetch(`${base.url}/api/v3/command/${id}`, {
    headers: { 'X-Api-Key': base.apiKey },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`command ${id} lookup failed: HTTP ${res.status}`);
  return commandStatus(await res.json());
}

export async function getImportScanStatus(
  sonarrId: number,
  radarrId: number,
): Promise<{ sonarr: { status: string }; radarr: { status: string } }> {
  const [sonarr, radarr] = await Promise.all([
    fetchCommandStatus(config.sonarr, sonarrId),
    fetchCommandStatus(config.radarr, radarrId),
  ]);
  return { sonarr: { status: sonarr }, radarr: { status: radarr } };
}
