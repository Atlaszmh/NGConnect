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
