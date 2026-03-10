import { describe, it, expect } from 'vitest';
import { parseVpnStatus } from './vpnMonitor';

describe('parseVpnStatus — log rotation scenario', () => {
  it('returns null when current log has only port forwarding spam (triggers fallback)', () => {
    // After log rotation, the current file has no status lines at all
    const currentLog = Array(100)
      .fill('2026-03-09T05:40:03.079Z | INFO | PROCESS.COMM | Received PortForwarding Status SleepingUntilRefresh')
      .join('\n');
    // parseVpnStatus returns null, which signals checkProtonLog to try the rotated file
    expect(parseVpnStatus(currentLog)).toBeNull();
  });

  it('finds Connected in rotated log content', () => {
    // The rotated (.1.txt) log still has the status line
    const rotatedLog = [
      '2026-03-09T05:36:43.430Z | INFO | Status updated to Connecting.',
      '2026-03-09T05:36:57.884Z | INFO | Status updated to Connected.',
      // followed by port forwarding spam that caused rotation
      ...Array(100).fill('2026-03-09T05:40:03.079Z | INFO | PROCESS.COMM | Received PortForwarding Status'),
    ].join('\n');
    expect(parseVpnStatus(rotatedLog)).toBe(true);
  });
});

describe('parseVpnStatus', () => {
  it('returns true when last status is Connected', () => {
    const log = [
      '2026-03-09T05:36:43.430Z | INFO | Status updated to Connecting.',
      '2026-03-09T05:36:48.077Z | INFO | Status updated to Connecting.',
      '2026-03-09T05:36:57.884Z | INFO | Status updated to Connected. Connected to server CH#402',
    ].join('\n');
    expect(parseVpnStatus(log)).toBe(true);
  });

  it('returns false when last status is Disconnected', () => {
    const log = [
      '2026-03-09T05:36:57.884Z | INFO | Status updated to Connected.',
      '2026-03-09T06:00:00.000Z | INFO | Status updated to Disconnected.',
    ].join('\n');
    expect(parseVpnStatus(log)).toBe(false);
  });

  it('returns false when last status is Connecting (not yet connected)', () => {
    const log = [
      '2026-03-09T05:36:43.430Z | INFO | Status updated to Connecting.',
      '2026-03-09T05:36:48.077Z | INFO | Status updated to Connecting.',
    ].join('\n');
    expect(parseVpnStatus(log)).toBe(false);
  });

  it('returns null when no status lines are present', () => {
    const log = [
      '2026-03-09T05:40:02.706Z | INFO | APP | Port forwarding status changed from SleepingUntilRefresh to PortMappingCommunication.',
      '2026-03-09T05:40:03.079Z | INFO | PROCESS.COMM | Received PortForwarding Status SleepingUntilRefresh',
      '2026-03-09T05:40:07.898Z | INFO | PROCESS.COMM | Received PortForwarding Status SleepingUntilRefresh',
    ].join('\n');
    expect(parseVpnStatus(log)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseVpnStatus('')).toBeNull();
  });

  it('returns true when Connected follows Disconnected', () => {
    const log = [
      'Status updated to Connected.',
      'Status updated to Disconnected.',
      'Status updated to Connecting.',
      'Status updated to Connected.',
    ].join('\n');
    expect(parseVpnStatus(log)).toBe(true);
  });

  it('returns false when Disconnected follows Connected', () => {
    const log = [
      'Status updated to Connected.',
      'Status updated to Disconnected.',
    ].join('\n');
    expect(parseVpnStatus(log)).toBe(false);
  });

  it('handles Connected buried under port forwarding spam', () => {
    // Simulates the real-world scenario: Connected line followed by
    // thousands of port forwarding lines with no further status changes
    const statusLine = '2026-03-09T05:36:57.884Z | INFO | Status updated to Connected. Connected to server CH#402\n';
    const spamLine = '2026-03-09T05:40:03.079Z | INFO | PROCESS.COMM | Received PortForwarding Status SleepingUntilRefresh\n';
    const log = statusLine + spamLine.repeat(1000);
    expect(parseVpnStatus(log)).toBe(true);
  });

  it('ignores partial matches like "Status updated to ConnectedButNot"', () => {
    const log = 'Some text Status updated to ConnectedButNot. Other text';
    // The regex requires exactly Connected|Disconnected|Connecting followed by a dot
    expect(parseVpnStatus(log)).toBeNull();
  });

  it('handles the real ProtonVPN log format with caller metadata', () => {
    const log = '2026-03-09T05:36:57.884Z | INFO  | CONN.CONNECT:TRIGGER | [CONNECTION_PROCESS] Status updated to Connected. Connected to server CH#402 | {"Caller":"ConnectionManager.SetConnectionStatus:362"}';
    expect(parseVpnStatus(log)).toBe(true);
  });
});
