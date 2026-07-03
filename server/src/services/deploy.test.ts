import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readDeployStatus, classifyTriggerResult, DEFAULT_DEPLOY_STATUS } from './deploy';

const tmpFiles: string[] = [];
function tmpFile(contents: string): string {
  const p = path.join(os.tmpdir(), `deploy-status-${tmpFiles.length}-${process.pid}.json`);
  fs.writeFileSync(p, contents, 'utf-8');
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  while (tmpFiles.length) {
    const p = tmpFiles.pop()!;
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
});

describe('readDeployStatus', () => {
  it('returns the default (result "unknown") when the file is missing', () => {
    const missing = path.join(os.tmpdir(), `does-not-exist-${process.pid}.json`);
    expect(readDeployStatus(missing)).toEqual(DEFAULT_DEPLOY_STATUS);
  });

  it('returns the default when the file is corrupt JSON', () => {
    const p = tmpFile('{ not valid json ');
    expect(readDeployStatus(p)).toEqual(DEFAULT_DEPLOY_STATUS);
  });

  it('parses a valid status file', () => {
    const status = {
      sha: '49c5c42',
      subject: 'Update VPN monitor and add vitest for testing',
      lastCheck: '2026-07-02T14:05:00Z',
      result: 'up-to-date',
      error: null,
    };
    const p = tmpFile(JSON.stringify(status));
    expect(readDeployStatus(p)).toEqual(status);
  });

  it('fills missing fields from the default (partial file)', () => {
    const p = tmpFile(JSON.stringify({ result: 'updated', sha: 'abc1234' }));
    expect(readDeployStatus(p)).toEqual({
      ...DEFAULT_DEPLOY_STATUS,
      result: 'updated',
      sha: 'abc1234',
    });
  });

  it('returns the default when the JSON is a top-level array', () => {
    const p = tmpFile('[1,2,3]');
    expect(readDeployStatus(p)).toEqual(DEFAULT_DEPLOY_STATUS);
  });

  it('coerces an invalid result to "unknown"', () => {
    const p = tmpFile(JSON.stringify({ result: 'bogus', sha: 'abc1234' }));
    expect(readDeployStatus(p)).toEqual({
      ...DEFAULT_DEPLOY_STATUS,
      result: 'unknown',
      sha: 'abc1234',
    });
  });
});

describe('classifyTriggerResult', () => {
  it('reports triggered when there is no error', () => {
    expect(classifyTriggerResult(null, '')).toEqual({ triggered: true });
  });

  it('reports updater-not-installed when schtasks cannot find the task', () => {
    const stderr = 'ERROR: The system cannot find the file specified.';
    const err = new Error('Command failed');
    expect(classifyTriggerResult(err, stderr)).toEqual({
      triggered: false,
      reason: 'updater-not-installed',
    });
  });

  it('reports updater-not-installed on the "does not exist" phrasing', () => {
    const stderr = 'ERROR: The specified task name "NGConnect Updater" does not exist in the system.';
    const err = new Error('Command failed');
    expect(classifyTriggerResult(err, stderr)).toEqual({
      triggered: false,
      reason: 'updater-not-installed',
    });
  });

  it('reports a generic error for any other failure', () => {
    const stderr = 'ERROR: Access is denied.';
    const err = new Error('Command failed');
    const result = classifyTriggerResult(err, stderr);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('error');
  });
});
