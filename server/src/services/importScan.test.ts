import { describe, it, expect } from 'vitest';
import { extractCompleteDir, commandStatus, isTerminal } from './importScan';

describe('extractCompleteDir', () => {
  it('returns the absolute complete_dir from a SAB get_config response', () => {
    const sab = { config: { misc: { complete_dir: 'R:\\Torrents\\complete' } } };
    expect(extractCompleteDir(sab)).toBe('R:\\Torrents\\complete');
  });

  it('throws when complete_dir is missing', () => {
    expect(() => extractCompleteDir({ config: { misc: {} } })).toThrow(/complete_dir/);
  });

  it('throws when complete_dir is empty', () => {
    const sab = { config: { misc: { complete_dir: '' } } };
    expect(() => extractCompleteDir(sab)).toThrow(/complete_dir/);
  });

  it('throws when complete_dir is relative (SAB can store paths relative to its base folder)', () => {
    const sab = { config: { misc: { complete_dir: 'Downloads\\complete' } } };
    expect(() => extractCompleteDir(sab)).toThrow(/absolute/);
  });

  it('throws on a malformed response (no config object)', () => {
    expect(() => extractCompleteDir({})).toThrow(/complete_dir/);
    expect(() => extractCompleteDir(null)).toThrow(/complete_dir/);
    expect(() => extractCompleteDir('nonsense')).toThrow(/complete_dir/);
  });

  it('trims surrounding whitespace from complete_dir', () => {
    const sab = { config: { misc: { complete_dir: 'R:\\Torrents\\complete  ' } } };
    expect(extractCompleteDir(sab)).toBe('R:\\Torrents\\complete');
  });
});

describe('commandStatus', () => {
  it('extracts the status string from an arr command response', () => {
    expect(commandStatus({ id: 42, status: 'started' })).toBe('started');
  });

  it('returns "unknown" when status is missing or not a string', () => {
    expect(commandStatus({ id: 42 })).toBe('unknown');
    expect(commandStatus({ status: 7 })).toBe('unknown');
    expect(commandStatus(null)).toBe('unknown');
  });
});

describe('isTerminal', () => {
  it('treats completed/failed/aborted/cancelled as terminal', () => {
    for (const s of ['completed', 'failed', 'aborted', 'cancelled']) {
      expect(isTerminal(s)).toBe(true);
    }
  });

  it('treats queued/started as non-terminal', () => {
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('started')).toBe(false);
  });

  it('treats unknown as terminal so the client never polls forever on garbage', () => {
    expect(isTerminal('unknown')).toBe(true);
  });
});
