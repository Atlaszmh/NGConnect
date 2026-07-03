import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { createServiceLogger } from './logger';

const log = createServiceLogger('deploy');

export interface DeployStatus {
  sha: string | null;
  subject: string | null;
  lastCheck: string | null;
  result: 'up-to-date' | 'updated' | 'failed' | 'unknown';
  error: string | null;
}

export const DEFAULT_DEPLOY_STATUS: DeployStatus = {
  sha: null,
  subject: null,
  lastCheck: null,
  result: 'unknown',
  error: null,
};

// Repo-root deploy/.deploy-status.json, resolved from this file's location.
// At runtime (server/dist/services) and under vitest/tsx (server/src/services),
// three levels up is the repo root in both cases.
export const DEPLOY_STATUS_PATH = path.resolve(
  __dirname,
  '../../../deploy/.deploy-status.json'
);

const VALID_RESULTS: ReadonlyArray<DeployStatus['result']> = [
  'up-to-date',
  'updated',
  'failed',
  'unknown',
];

/**
 * Read and parse the updater's status file. Never throws: any problem
 * (missing file, unreadable, corrupt JSON, or a partial/garbage file caught
 * mid-write by the updater) yields a safe result. Non-object JSON falls back to
 * DEFAULT_DEPLOY_STATUS; a merged status with an unrecognized `result` is
 * coerced to 'unknown'.
 */
export function readDeployStatus(filePath: string): DeployStatus {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_DEPLOY_STATUS;
    }
    const merged = { ...DEFAULT_DEPLOY_STATUS, ...(parsed as Partial<DeployStatus>) };
    if (!VALID_RESULTS.includes(merged.result)) {
      merged.result = 'unknown';
    }
    return merged;
  } catch {
    return DEFAULT_DEPLOY_STATUS;
  }
}

export interface TriggerResult {
  triggered: boolean;
  reason?: 'updater-not-installed' | 'error';
  detail?: string;
}

const TASK_NAME = 'NGConnect Updater';

/**
 * Classify the outcome of the schtasks invocation. Pure — no side effects.
 * `error` is the execFile error (null on success); `stderr` is its stderr.
 */
export function classifyTriggerResult(
  error: Error | null,
  stderr: string
): TriggerResult {
  if (!error) return { triggered: true };
  const text = (stderr || error.message || '').toLowerCase();
  if (text.includes('cannot find the file') || text.includes('does not exist')) {
    return { triggered: false, reason: 'updater-not-installed' };
  }
  return { triggered: false, reason: 'error', detail: stderr || error.message };
}

/**
 * Fire-and-return: start the "NGConnect Updater" Scheduled Task. Resolves once
 * schtasks returns (which is immediate — it only *starts* the task). Never
 * rejects; failures are reported via the returned TriggerResult.
 */
export function triggerUpdateCheck(): Promise<TriggerResult> {
  return new Promise((resolve) => {
    execFile(
      'schtasks',
      ['/run', '/tn', TASK_NAME],
      { windowsHide: true },
      (error, _stdout, stderr) => {
        const result = classifyTriggerResult(error, stderr ?? '');
        if (!result.triggered) {
          log.error('Failed to trigger updater task', {
            reason: result.reason,
            error: error?.message,
            stderr: stderr ?? '',
          });
        }
        resolve(result);
      }
    );
  });
}
