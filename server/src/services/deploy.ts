import fs from 'fs';
import path from 'path';

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

/**
 * Read and parse the updater's status file. Never throws: any problem
 * (missing file, unreadable, corrupt JSON) yields DEFAULT_DEPLOY_STATUS.
 */
export function readDeployStatus(filePath: string): DeployStatus {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DeployStatus>;
    return { ...DEFAULT_DEPLOY_STATUS, ...parsed };
  } catch {
    return DEFAULT_DEPLOY_STATUS;
  }
}

import { execFile } from 'child_process';

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
        resolve(classifyTriggerResult(error, stderr ?? ''));
      }
    );
  });
}
