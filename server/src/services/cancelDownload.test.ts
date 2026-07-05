import { describe, it, expect } from 'vitest';
import { findQueueMatch } from './cancelDownload';

const rec = (id: number, downloadId?: string) => ({ id, downloadId });

describe('findQueueMatch', () => {
  it('finds a Sonarr match by downloadId', () => {
    expect(findQueueMatch([rec(5, 'abc'), rec(6, 'xyz')], [], 'xyz')).toEqual({ arr: 'sonarr', id: 6 });
  });
  it('finds a Radarr match by downloadId', () => {
    expect(findQueueMatch([], [rec(9, 'mov1')], 'mov1')).toEqual({ arr: 'radarr', id: 9 });
  });
  it('returns null when neither queue has it', () => {
    expect(findQueueMatch([rec(1, 'a')], [rec(2, 'b')], 'zzz')).toBeNull();
  });
  it('returns null for empty queues', () => {
    expect(findQueueMatch([], [], 'anything')).toBeNull();
  });
  it('skips records with no downloadId', () => {
    expect(findQueueMatch([rec(1)], [], 'anything')).toBeNull();
  });
  it('prefers Sonarr when both (pathologically) contain the id', () => {
    expect(findQueueMatch([rec(1, 'dup')], [rec(2, 'dup')], 'dup')).toEqual({ arr: 'sonarr', id: 1 });
  });
  it('matches exactly — no trim or case-fold', () => {
    expect(findQueueMatch([rec(1, 'ABC')], [], 'abc')).toBeNull();
    expect(findQueueMatch([rec(1, ' abc ')], [], 'abc')).toBeNull();
  });
});
