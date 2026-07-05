import path from 'path';
import { config } from '../config';

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
  if (!path.win32.isAbsolute(dir)) {
    throw new Error(`SAB complete_dir is not absolute: ${dir}`);
  }
  return dir;
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
