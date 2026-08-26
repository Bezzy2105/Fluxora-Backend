import { describe, it, expect, beforeEach } from 'vitest';
import {
  tryAcquireLongPollConnection,
  getActiveLongPollConnectionCount,
  _resetLongPollConnectionLimiter,
  resolveLongPollConnectionLimits,
} from '../src/streams/longPoll.js';
import { longPollActiveConnectionsGauge } from '../src/metrics/businessMetrics.js';

const limits = resolveLongPollConnectionLimits({});

describe('longPoll connection cleanup', () => {
  beforeEach(() => {
    _resetLongPollConnectionLimiter();
  });

  it('should decrement counters and gauge on release', () => {
    const attempt = tryAcquireLongPollConnection('127.0.0.1', limits);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) throw new Error('expected ok');

    expect(getActiveLongPollConnectionCount()).toBe(1);
    expect(longPollActiveConnectionsGauge.get()).toBe(1);

    attempt.connection.release();
    expect(getActiveLongPollConnectionCount()).toBe(0);
    expect(longPollActiveConnectionsGauge.get()).toBe(0);
  });

  it('should release exactly once and ignore duplicate releases', () => {
    const attempt = tryAcquireLongPollConnection('127.0.0.1', limits);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) throw new Error('expected ok');

    const { connection } = attempt;
    connection.release();
    connection.release();

    expect(getActiveLongPollConnectionCount()).toBe(0);
    expect(longPollActiveConnectionsGauge.get()).toBe(0);
  });

  it('should match gauge after repeated acquire/release cycles', () => {
    const connections: Array<{ release(): void }> = [];
    for (let i = 0; i < 3; i++) {
      const attempt = tryAcquireLongPollConnection(`ip-${i}`, limits);
      expect(attempt.ok).toBe(true);
      if (attempt.ok) connections.push(attempt.connection);
    }

    expect(getActiveLongPollConnectionCount()).toBe(3);
    expect(longPollActiveConnectionsGauge.get()).toBe(3);

    connections[0]!.release();
    expect(getActiveLongPollConnectionCount()).toBe(2);
    expect(longPollActiveConnectionsGauge.get()).toBe(2);

    connections[1]!.release();
    connections[2]!.release();
    expect(getActiveLongPollConnectionCount()).toBe(0);
    expect(longPollActiveConnectionsGauge.get()).toBe(0);
  });

  it('should reject when per-IP limit is reached and recover after release', () => {
    const customLimits = { ...limits, maxConnectionsPerIp: 1 };
    const first = tryAcquireLongPollConnection('127.0.0.1', customLimits);
    expect(first.ok).toBe(true);
    const second = tryAcquireLongPollConnection('127.0.0.1', customLimits);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('per_ip_limit');
    }

    if (first.ok) first.connection.release();

    const third = tryAcquireLongPollConnection('127.0.0.1', customLimits);
    expect(third.ok).toBe(true);
  });
});
