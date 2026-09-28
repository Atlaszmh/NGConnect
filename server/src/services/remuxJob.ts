import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { config } from '../config';
import { commandStatus, fetchSabCompleteDir, isTerminal } from './importScan';
import { createServiceLogger } from './logger';
import {
  findDvdMainTitle,
  isDiscImage,
  parseBlurayDuration,
  parseOutTimeUs,
  progressPercent,
  releaseName,
  remuxArgs,
  remuxQualityName,
  summarizeProbe,
  verifyRemux,
} from './discRemux';
import type { DiscKind, ProbeSummary, TitleProbe } from './discRemux';

const log = createServiceLogger('remux');

export type RemuxStage = 'probing' | 'remuxing' | 'verifying' | 'importing' | 'done' | 'failed';

export interface RemuxJob {
  movieId: number;
  title: string;
  stage: RemuxStage;
  percent: number | null;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface FfmpegStatus {
  ok: boolean;
  dvd: boolean;
  bluray: boolean;
  hint: string | null;
}

export interface DiscProbe {
  kind: DiscKind;
  title: number | null;
  sourceSeconds: number;
  height: number | null;
}

// Carries the HTTP status the route should answer with.
export class RemuxError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

interface MovieFile {
  id: number;
  path?: string;
  relativePath?: string;
  size?: number;
  releaseGroup?: string;
  languages?: unknown[];
}

interface Movie {
  id: number;
  title: string;
  year: number;
  runtime?: number;
  movieFile?: MovieFile;
}

const FFMPEG_HINT =
  'ffmpeg (full build) is needed on the server PC: run "winget install Gyan.FFmpeg", then restart ' +
  'NGConnect. If it is still not found, set FFMPEG_PATH in .env to the full path of ffmpeg.exe.';
const STALL_MS = 5 * 60 * 1000;
const IMPORT_TIMEOUT_MS = 60 * 60 * 1000;

// ponytail: one job, held in memory. A server restart (e.g. an auto-deploy)
// mid-job loses it and leaves a .partial in staging; re-running overwrites it.
let job: RemuxJob | null = null;
let busy = false; // claimed before the first await so two POSTs can't both start
let ffmpegVerified = false;

const ffmpegBin = () => process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobeBin = () =>
  process.env.FFMPEG_PATH ? path.join(path.dirname(process.env.FFMPEG_PATH), 'ffprobe.exe') : 'ffprobe';

interface RunResult {
  code: number | null; // null = killed by the timeout
  stdout: string;
  stderr: string;
}

// Resolves with the exit code instead of rejecting, because callers classify
// ffprobe failures from stderr. Rejects only when the binary can't start.
function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      if (typeof err.code === 'string') return reject(err);
      resolve({ code: typeof err.code === 'number' ? err.code : null, stdout, stderr });
    });
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function radarr<T>(apiPath: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.radarr.url}/api/v3${apiPath}`, {
    ...init,
    headers: { 'X-Api-Key': config.radarr.apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Radarr ${init.method ?? 'GET'} ${apiPath} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function checkFfmpeg(): Promise<FfmpegStatus> {
  if (ffmpegVerified) return { ok: true, dvd: true, bluray: true, hint: null };
  try {
    const [demuxers, protocols, ffprobe] = await Promise.all([
      run(ffmpegBin(), ['-hide_banner', '-demuxers'], 15000),
      run(ffmpegBin(), ['-hide_banner', '-protocols'], 15000),
      run(ffprobeBin(), ['-version'], 15000), // rejects (ENOENT) if ffprobe isn't there
    ]);
    const dvd = /\bdvdvideo\b/.test(demuxers.stdout);
    const bluray = /\bbluray\b/.test(protocols.stdout);
    ffmpegVerified = dvd && bluray && ffprobe.code === 0;
    return { ok: ffmpegVerified, dvd, bluray, hint: ffmpegVerified ? null : FFMPEG_HINT };
  } catch {
    return { ok: false, dvd: false, bluray: false, hint: FFMPEG_HINT };
  }
}

async function probeDvdTitle(iso: string, title: number): Promise<TitleProbe> {
  const r = await run(
    ffprobeBin(),
    ['-v', 'error', '-f', 'dvdvideo', '-title', String(title), '-show_entries', 'format=duration', '-of', 'json', '-i', iso],
    30000,
  );
  const seconds = r.code === 0 ? summarizeProbe(safeJson(r.stdout)).seconds : 0;
  return seconds > 0 ? { ok: true, seconds } : { ok: false, stderr: r.stderr };
}

// DVD first (cheap per-title probes); anything that isn't a DVD is tried as a
// Blu-ray. null = neither opened.
export async function probeDisc(iso: string): Promise<DiscProbe | null> {
  const dvd = await findDvdMainTitle((n) => probeDvdTitle(iso, n));
  if (dvd) return { kind: 'dvd', title: dvd.title, sourceSeconds: dvd.seconds, height: null };
  const r = await run(
    ffprobeBin(),
    ['-hide_banner', '-v', 'info', '-show_entries', 'stream=codec_type,height', '-of', 'json', '-i', `bluray:${iso}`],
    120000,
  );
  const seconds = r.code === 0 ? parseBlurayDuration(r.stderr) : null;
  if (!seconds) return null;
  return { kind: 'bluray', title: null, sourceSeconds: seconds, height: summarizeProbe(safeJson(r.stdout)).height };
}

// Run the ffmpeg remux, reporting percent. A watchdog kills ffmpeg if its
// written time stops advancing for STALL_MS.
export function runRemux(args: string[], sourceSeconds: number, onPercent: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let lastStderr = '';
    let lastOutUs = -1;
    let lastAdvance = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastAdvance > STALL_MS) {
        stalled = true;
        child.kill();
      }
    }, 15000);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const us = parseOutTimeUs(line);
      if (us === null) return;
      if (us > lastOutUs) {
        lastOutUs = us;
        lastAdvance = Date.now();
      }
      onPercent(progressPercent(us, sourceSeconds));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length) lastStderr = lines[lines.length - 1];
    });
    child.on('error', (err) => {
      clearInterval(watchdog);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(watchdog);
      if (code === 0) resolve();
      else if (stalled) reject(new Error('ffmpeg stopped making progress for 5 minutes'));
      else reject(new Error(`ffmpeg failed (exit ${code})${lastStderr ? `: ${lastStderr}` : ''}`));
    });
  });
}

export async function probeOutput(file: string): Promise<ProbeSummary> {
  const r = await run(
    ffprobeBin(),
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,height', '-of', 'json', file],
    120000,
  );
  return summarizeProbe(r.code === 0 ? safeJson(r.stdout) : null);
}

// ManualImport builds its ImportDecision with no rejection checks, so a DVD MKV
// can replace a (higher-ranked) DVD-R ISO; Radarr removes the ISO inside this
// same import (UpgradeMovieFile) and notifies Plex.
async function importIntoRadarr(movieId: number, mkv: string, release: string, disc: DiscProbe, file: MovieFile) {
  const qualityName = remuxQualityName(disc.kind, disc.height);
  const defs = await radarr<Array<{ quality?: { name?: string } }>>('/qualitydefinition');
  const def = defs.find((d) => d.quality?.name === qualityName);
  if (!def?.quality) throw new Error(`Radarr has no "${qualityName}" quality.`);
  const cmd = await radarr<{ id: number }>('/command', {
    method: 'POST',
    body: JSON.stringify({
      name: 'ManualImport',
      importMode: 'Move',
      files: [
        {
          path: mkv,
          movieId,
          folderName: release,
          quality: { quality: def.quality, revision: { version: 1, real: 0, isRepack: false } },
          languages: file.languages ?? [],
          releaseGroup: file.releaseGroup ?? '',
        },
      ],
    }),
  });
  const deadline = Date.now() + IMPORT_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    let status: string | null = null;
    try {
      status = commandStatus(await radarr<unknown>(`/command/${cmd.id}`));
    } catch {
      /* one slow/failed poll must not fail the job while Radarr keeps importing */
    }
    if (status !== null && isTerminal(status)) {
      if (status !== 'completed') throw new Error(`Radarr import ${status}.`);
      return;
    }
    if (Date.now() > deadline) throw new Error('Radarr import still running after 60 min — check Radarr > Activity.');
  }
}

async function runJob(current: RemuxJob, movie: Movie, file: MovieFile & { path: string }, stagingRoot: string) {
  const set = (patch: Partial<RemuxJob>) => Object.assign(current, patch);
  let partial: string | null = null; // deleted on failure; null once it is a verified MKV
  let verifiedMkv: string | null = null; // kept on failure; every later error says where it is
  try {
    const disc = await probeDisc(file.path);
    if (!disc) throw new Error('Not a readable DVD or Blu-ray image');
    const release = releaseName(movie.title, movie.year, disc.kind, disc.height);
    const dir = path.join(stagingRoot, release);
    await fs.promises.mkdir(dir, { recursive: true });
    const mkv = path.join(dir, `${release}.mkv`);
    partial = `${mkv}.partial`;

    set({ stage: 'remuxing', percent: 0 });
    await runRemux(remuxArgs(disc.kind, file.path, disc.title, partial), disc.sourceSeconds, (percent) => set({ percent }));

    set({ stage: 'verifying', percent: null });
    const problem = verifyRemux(await probeOutput(partial), disc.sourceSeconds, movie.runtime);
    if (problem) throw new Error(`Check failed: ${problem}. The disc image was not touched.`);
    await fs.promises.rename(partial, mkv);
    partial = null;
    verifiedMkv = mkv;

    set({ stage: 'importing' });
    const before = await radarr<Movie>(`/movie/${movie.id}`);
    if (before.movieFile?.id !== file.id) {
      throw new Error("The movie's file changed during the conversion, so nothing was replaced.");
    }
    await importIntoRadarr(movie.id, mkv, release, disc, file);
    const after = await radarr<Movie>(`/movie/${movie.id}`);
    const imported = after.movieFile?.relativePath;
    if (!imported?.toLowerCase().endsWith('.mkv')) throw new Error('Radarr did not import the MKV.');

    // Best-effort, non-recursive: never removes a file, never fails the job.
    await fs.promises.rmdir(dir).catch(() => {});
    await fs.promises.rmdir(stagingRoot).catch(() => {});
    set({ stage: 'done', percent: 100, message: `Imported as ${imported}`, finishedAt: new Date().toISOString() });
    log.info(`Converted ${movie.title} (${movie.year}) → ${imported}`);
  } catch (err) {
    if (partial) await fs.promises.rm(partial, { force: true }).catch(() => {});
    let message = err instanceof Error ? err.message : String(err);
    if (verifiedMkv) message += ` The MKV is at ${verifiedMkv}`;
    set({ stage: 'failed', percent: null, message, finishedAt: new Date().toISOString() });
    log.error(`Conversion of ${movie.title} (${movie.year}) failed: ${message}`);
  }
}

// Validates synchronously-ish (steps 1–3 of the spec), then runs the job in the
// background. Throws RemuxError for answers the route should pass through.
export async function startRemux(movieId: number): Promise<RemuxJob> {
  if (busy) throw new RemuxError(409, 'A conversion is already running');
  busy = true;
  try {
    const movie = await radarr<Movie>(`/movie/${movieId}`);
    const file = movie.movieFile;
    if (!file?.path || !isDiscImage(file.relativePath)) {
      throw new RemuxError(400, `${movie.title} is not a disc image`);
    }
    const ffmpeg = await checkFfmpeg();
    if (!ffmpeg.ok) throw new RemuxError(503, ffmpeg.hint ?? FFMPEG_HINT);
    const stagingRoot = path.join(await fetchSabCompleteDir(), 'ngconnect-remux');
    await fs.promises.mkdir(stagingRoot, { recursive: true });
    const { bavail, bsize } = await fs.promises.statfs(stagingRoot);
    const needed = (file.size ?? 0) + 1e9;
    if (bavail * bsize < needed) {
      throw new RemuxError(507, `Not enough free space in ${stagingRoot}: need ${(needed / 1e9).toFixed(1)} GB`);
    }
    const current: RemuxJob = {
      movieId,
      title: movie.title,
      stage: 'probing',
      percent: null,
      message: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    job = current;
    void runJob(current, movie, { ...file, path: file.path }, stagingRoot).finally(() => {
      busy = false;
    });
    return { ...current };
  } catch (err) {
    busy = false;
    throw err;
  }
}

export async function getRemuxStatus(): Promise<{ ffmpeg: FfmpegStatus; job: RemuxJob | null }> {
  return { ffmpeg: await checkFfmpeg(), job: job && { ...job } };
}
