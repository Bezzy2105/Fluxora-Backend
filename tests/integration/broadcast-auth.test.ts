import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { _resetAuditLog, getAuditEntries } from '../../src/lib/auditLog.js';
import { recordAuditEvent } from '../../src/lib/auditLog.js';
import { verifyWsToken } from '../../src/middleware/tokenAuth.js';
import { wsAuthFailureTotal } from '../../src/metrics/businessMetrics.js';

vi.mock('../../src/lib/logger.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/logger.js')>();
  return {
    ...original,
    logger: {
      ...original.logger,
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

describe('Broadcast auth coverage (#1092)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetAuditLog();
    wsAuthFailureTotal.reset();
  });

  describe('STREAM_BROADCAST audit entries', () => {
    it('records a well-formed broadcast audit entry for stream.created', () => {
      recordAuditEvent(
        'STREAM_BROADCAST',
        'stream',
        'stream-123',
        'corr-001',
        { event: 'stream.created', eventId: 'evt-456', contractId: 'CXYZ' },
      );

      const entries = getAuditEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('STREAM_BROADCAST');
      expect(entries[0].resourceType).toBe('stream');
      expect(entries[0].resourceId).toBe('stream-123');
      expect(entries[0].correlationId).toBe('corr-001');
      expect(entries[0].meta).toEqual({ event: 'stream.created', eventId: 'evt-456', contractId: 'CXYZ' });
    });

    it('records broadcast audit entries for stream.updated and stream.cancelled', () => {
      recordAuditEvent(
        'STREAM_BROADCAST',
        'stream',
        'stream-789',
        'corr-002',
        { event: 'stream.updated', eventId: 'evt-101' },
      );
      recordAuditEvent(
        'STREAM_BROADCAST',
        'stream',
        'stream-202',
        'corr-003',
        { event: 'stream.cancelled', eventId: 'evt-303' },
      );

      const entries = getAuditEntries();
      const broadcasts = entries.filter((entry) => entry.action === 'STREAM_BROADCAST');
      expect(broadcasts).toHaveLength(2);
      expect(broadcasts[0].meta?.event).toBe('stream.updated');
      expect(broadcasts[1].meta?.event).toBe('stream.cancelled');
    });

    it('does not throw when broadcast audit metadata is omitted', () => {
      expect(() => {
        recordAuditEvent('STREAM_BROADCAST', 'stream', 'stream-no-meta');
      }).not.toThrow();

      const entries = getAuditEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].correlationId).toBeUndefined();
      expect(entries[0].meta).toBeUndefined();
    });
  });

  describe('WS auth surface for broadcast access', () => {
    function makeReq(overrides: Partial<{ headers?: Record<string, string>; url?: string }> = {}) {
      return {
        headers: overrides.headers ?? {},
        url: overrides.url ?? '/ws/streams',
        socket: { remoteAddress: '127.0.0.1' },
      } as any;
    }

    it('rejects missing tokens without generating broadcast audit entries', () => {
      const result = verifyWsToken(makeReq(), 'secret');

      expect(result).toEqual({ ok: false, code: 'MISSING_TOKEN' });
      expect(getAuditEntries()).toHaveLength(0);
    });

    it('records invalid token failures as WS_AUTH_FAILURE without creating broadcast audit entries', () => {
      const result = verifyWsToken(makeReq({ headers: { authorization: 'Bearer bad' } }), 'secret');

      expect(result).toEqual({ ok: false, code: 'INVALID_TOKEN' });

      const authFailures = getAuditEntries().filter((entry) => entry.action === 'WS_AUTH_FAILURE');
      expect(authFailures).toHaveLength(1);
      expect(authFailures[0].meta?.reason).toBe('INVALID_TOKEN');
      expect(getAuditEntries().some((entry) => entry.action === 'STREAM_BROADCAST')).toBe(false);
    });

    it('accepts a valid bearer token and does not emit auth failures', () => {
      const token = jwt.sign({ sub: 'user-42', role: 'operator' }, 'secret');
      const result = verifyWsToken(makeReq({ headers: { authorization: `Bearer ${token}` } }), 'secret');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.sub).toBe('user-42');
      }
      expect(getAuditEntries()).toHaveLength(0);
    });

    it('increments the auth failure counter for invalid tokens', async () => {
      verifyWsToken(makeReq({ headers: { authorization: 'Bearer bad' } }), 'secret');

      const value = await wsAuthFailureTotal.get();
      const series = value.values.find((entry) => (entry.labels as { reason?: string }).reason === 'INVALID_TOKEN');
      expect(series?.value).toBe(1);
    });
  });
});
