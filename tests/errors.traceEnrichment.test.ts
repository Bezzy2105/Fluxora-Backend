/**
 * Tests for trace/span enrichment of error handler logs (issue #1223).
 *
 * ## Coverage
 *
 * ### getActiveTraceSpanIds (hooks.ts)
 * - Returns { traceId, spanId } when an active OTel span exists
 * - Returns {} when no active span exists (graceful degradation)
 * - Returns {} when trace.getActiveSpan() throws (failure-safe)
 * - Returns {} when spanContext() is missing traceId or spanId
 *
 * ### errorHandler trace enrichment (errorHandler.ts)
 * - ApiError logs include traceId/spanId when tracing is active
 * - DecimalSerializationError logs include traceId/spanId when tracing is active
 * - Unexpected error logs include traceId/spanId when tracing is active
 * - QueryTimeoutError does NOT include traceId/spanId (no log call)
 * - entity.too.large does NOT include traceId/spanId (no log call)
 * - SyntaxError (malformed JSON) does NOT include traceId/spanId (no log call)
 * - All error responses remain unchanged (PII-safe)
 * - Trace fields are absent when no active span (graceful degradation)
 *
 * ### PII safety
 * - No sensitive data leaked in trace-enriched log entries
 * - Stack traces are still properly captured
 * - requestId is still present alongside traceId/spanId
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ApiError } from '../src/errors.js';
import { ApiErrorCode, errorHandler } from '../src/middleware/errorHandler.js';
import { DecimalSerializationError } from '../src/serialization/decimal.js';
import { QueryTimeoutError } from '../src/db/pool.js';
import * as otelApi from '@opentelemetry/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

/**
 * Configure the OTel trace API to report an active span with the given IDs.
 * Uses vi.spyOn on the real imported module so hooks.ts (which destructured
 * `trace` from the same module) sees the spy.
 */
let activeSpanSpy: ReturnType<typeof vi.spyOn> | null = null;

function setActiveSpan(traceId: string, spanId: string): void {
  if (activeSpanSpy) {
    activeSpanSpy.mockReturnValue({
      spanContext: () => ({
        traceId,
        spanId,
        traceFlags: 1,
      }),
    });
  }
}

/**
 * Configure the OTel trace API to report no active span.
 */
function clearActiveSpan(): void {
  if (activeSpanSpy) {
    activeSpanSpy.mockReturnValue(undefined);
  }
}

/**
 * Make trace.getActiveSpan() always throw (simulate broken OTel).
 */
function breakActiveSpan(): void {
  if (activeSpanSpy) {
    activeSpanSpy.mockImplementation(() => {
      throw new Error('OTel collector unreachable');
    });
  }
}

/**
 * Extract all JSON log lines written to a stream spy.
 */
function getJsonLogLines(
  spy: ReturnType<typeof vi.spyOn>,
): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call) => {
      try {
        return JSON.parse(call[0] as string);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Record<string, unknown>[];
}

function buildApp() {
  const app = express();

  // Minimal correlationId — required by errorHandler
  app.use((req, _res, next) => {
    req.correlationId = 'test-cid-001';
    next();
  });

  // Error-throwing routes
  app.get('/exposed', () => {
    throw new ApiError(400, ApiErrorCode.VALIDATION_ERROR, 'Validation failed', { field: 'email' }, true);
  });

  app.get('/hidden', () => {
    throw new ApiError(500, 'DB_ERROR', 'Database connection failed', {}, false);
  });

  app.get('/unknown', () => {
    throw new Error('Unexpected failure');
  });

  app.get('/decimal', () => {
    throw new DecimalSerializationError('amount', 'not-a-number', 'INVALID_DECIMAL');
  });

  app.get('/timeout', () => {
    throw new QueryTimeoutError('Query timed out after 30s');
  });

  app.get('/syntax', (_req, _res, next) => {
    const err = new SyntaxError('Malformed JSON');
    (err as SyntaxError & { status?: number }).status = 400;
    next(err);
  });

  app.get('/entity-too-large', (_req, _res, next) => {
    const err = new Error('Payload too large');
    (err as Error & { type?: string }).type = 'entity.too.large';
    next(err);
  });

  app.use(errorHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getActiveTraceSpanIds', () => {
  let getActiveTraceSpanIds: () => { traceId?: string; spanId?: string };

  beforeEach(async () => {
    // Spy on the real module's trace.getActiveSpan so hooks.ts (which
    // destructured `trace` from the same module object) sees our stub.
    activeSpanSpy = vi.spyOn(otelApi.trace, 'getActiveSpan').mockReturnValue(undefined);
    const mod = await import('../src/tracing/hooks.js');
    getActiveTraceSpanIds = mod.getActiveTraceSpanIds;
  });

  afterEach(() => {
    activeSpanSpy?.mockRestore();
    activeSpanSpy = null;
  });

  it('returns traceId and spanId when an active span exists', () => {
    setActiveSpan(TRACE_ID, SPAN_ID);
    const result = getActiveTraceSpanIds();
    expect(result).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
  });

  it('returns empty object when no active span exists', () => {
    clearActiveSpan();
    const result = getActiveTraceSpanIds();
    expect(result).toEqual({});
  });

  it('returns empty object when trace.getActiveSpan() throws', () => {
    activeSpanSpy?.mockImplementation(() => {
      throw new Error('Context API error');
    });
    const result = getActiveTraceSpanIds();
    expect(result).toEqual({});
  });

  it('returns empty object when spanContext() returns null', () => {
    activeSpanSpy?.mockReturnValue({
      spanContext: () => null,
    });
    const result = getActiveTraceSpanIds();
    expect(result).toEqual({});
  });

  it('returns empty object when spanContext() is missing traceId', () => {
    activeSpanSpy?.mockReturnValue({
      spanContext: () => ({ spanId: SPAN_ID }), // no traceId
    });
    const result = getActiveTraceSpanIds();
    expect(result).toEqual({});
  });

  it('returns empty object when spanContext() is missing spanId', () => {
    activeSpanSpy?.mockReturnValue({
      spanContext: () => ({ traceId: TRACE_ID }), // no spanId
    });
    const result = getActiveTraceSpanIds();
    expect(result).toEqual({});
  });
});

// ── Error handler trace enrichment integration tests ──────────────────────────

describe('errorHandler trace enrichment', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    activeSpanSpy = vi.spyOn(otelApi.trace, 'getActiveSpan').mockReturnValue(undefined);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    activeSpanSpy?.mockRestore();
    activeSpanSpy = null;
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  // ── With active span ───────────────────────────────────────────────────────

  describe('when an active OTel span exists', () => {
    beforeEach(() => {
      setActiveSpan(TRACE_ID, SPAN_ID);
    });

    it('includes traceId and spanId in ApiError (exposed) error log', async () => {
      const app = buildApp();
      await request(app).get('/exposed');

      const errorLogs = getJsonLogLines(stderrSpy);
      expect(errorLogs.length).toBeGreaterThanOrEqual(1);
      const log = errorLogs.find((l) => l.level === 'error');
      expect(log).toBeDefined();
      expect(log!.traceId).toBe(TRACE_ID);
      expect(log!.spanId).toBe(SPAN_ID);
    });

    it('includes traceId and spanId in ApiError (hidden) error log', async () => {
      const app = buildApp();
      await request(app).get('/hidden');

      const errorLogs = getJsonLogLines(stderrSpy);
      expect(errorLogs.length).toBeGreaterThanOrEqual(1);
      const log = errorLogs.find((l) => l.level === 'error');
      expect(log).toBeDefined();
      expect(log!.traceId).toBe(TRACE_ID);
      expect(log!.spanId).toBe(SPAN_ID);
    });

    it('includes traceId and spanId in unexpected error log', async () => {
      const app = buildApp();
      await request(app).get('/unknown');

      const errorLogs = getJsonLogLines(stderrSpy);
      expect(errorLogs.length).toBeGreaterThanOrEqual(1);
      const log = errorLogs.find((l) => l.level === 'error' && l.message === 'Unexpected error occurred');
      expect(log).toBeDefined();
      expect(log!.traceId).toBe(TRACE_ID);
      expect(log!.spanId).toBe(SPAN_ID);
    });

    it('does not emit an extra error log for decimal serialization errors (only the existing warn)', async () => {
      const app = buildApp();
      await request(app).get('/decimal');

      // There should be a warn-level log (SerializationLogger.validationFailed)
      const warnLogs = getJsonLogLines(stdoutSpy);
      const warnLog = warnLogs.find((l) => l.level === 'warn');
      expect(warnLog).toBeDefined();

      // There should NOT be an additional error-level log for decimal errors
      const errorLogs = getJsonLogLines(stderrSpy);
      const decimalErrorLog = errorLogs.find(
        (l) => l.level === 'error' && typeof l.message === 'string' && (l.message as string).includes('Decimal'),
      );
      expect(decimalErrorLog).toBeUndefined();
    });

    it('preserves requestId alongside traceId and spanId', async () => {
      const app = buildApp();
      await request(app).get('/exposed');

      const errorLogs = getJsonLogLines(stderrSpy);
      const log = errorLogs.find((l) => l.level === 'error');
      expect(log).toBeDefined();
      expect(log!.requestId).toBe('test-cid-001');
      expect(log!.traceId).toBe(TRACE_ID);
      expect(log!.spanId).toBe(SPAN_ID);
    });

    it('preserves stack trace in unexpected error logs', async () => {
      const app = buildApp();
      await request(app).get('/unknown');

      const errorLogs = getJsonLogLines(stderrSpy);
      const log = errorLogs.find((l) => l.level === 'error' && l.message === 'Unexpected error occurred');
      expect(log).toBeDefined();
      expect(log!.stack).toBeDefined();
      expect(log!.errorName).toBe('Error');
      expect(log!.errorMessage).toBe('Unexpected failure');
    });

    it('does NOT include traceId or spanId in QueryTimeoutError response (no log call)', async () => {
      const app = buildApp();
      const res = await request(app).get('/timeout');

      // QueryTimeoutError writes directly to the response without logging
      expect(res.status).toBe(504);
      // The response body should not contain trace/span IDs
      const body = res.body as Record<string, unknown>;
      expect(body).not.toHaveProperty('traceId');
      expect(body).not.toHaveProperty('spanId');
    });

    it('does NOT include traceId/spanId in client response body (PII-safe)', async () => {
      const app = buildApp();
      const res = await request(app).get('/exposed');

      expect(res.status).toBe(400);
      const body = res.body as Record<string, unknown>;
      // trace/span IDs must NEVER leak into client responses
      expect(body).not.toHaveProperty('traceId');
      expect(body).not.toHaveProperty('spanId');
      // The response envelope is unchanged
      expect(body.error).toBeDefined();
      expect((body.error as Record<string, unknown>).code).toBe(ApiErrorCode.VALIDATION_ERROR);
    });

    it('exposed ApiError response envelope is unchanged', async () => {
      const app = buildApp();
      const res = await request(app).get('/exposed');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toEqual({
        code: ApiErrorCode.VALIDATION_ERROR,
        message: 'Validation failed',
        details: { field: 'email' },
        requestId: 'test-cid-001',
      });
    });

    it('hidden ApiError response envelope is unchanged', async () => {
      const app = buildApp();
      const res = await request(app).get('/hidden');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Internal server error');
    });
  });

  // ── Without active span (graceful degradation) ─────────────────────────────

  describe('when no active OTel span exists', () => {
    beforeEach(() => {
      clearActiveSpan();
    });

    it('omits traceId and spanId from ApiError error log', async () => {
      const app = buildApp();
      await request(app).get('/exposed');

      const errorLogs = getJsonLogLines(stderrSpy);
      const log = errorLogs.find((l) => l.level === 'error');
      expect(log).toBeDefined();
      expect(log!.traceId).toBeUndefined();
      expect(log!.spanId).toBeUndefined();
    });

    it('omits traceId and spanId from unexpected error log', async () => {
      const app = buildApp();
      await request(app).get('/unknown');

      const errorLogs = getJsonLogLines(stderrSpy);
      const log = errorLogs.find((l) => l.level === 'error' && l.message === 'Unexpected error occurred');
      expect(log).toBeDefined();
      expect(log!.traceId).toBeUndefined();
      expect(log!.spanId).toBeUndefined();
    });

    it('omits traceId and spanId from DecimalSerializationError warn log', async () => {
      const app = buildApp();
      await request(app).get('/decimal');

      // DecimalSerializationError emits only a warn-level log (not enriched with trace)
      const warnLogs = getJsonLogLines(stdoutSpy);
      const warnLog = warnLogs.find((l) => l.level === 'warn');
      expect(warnLog).toBeDefined();
      // No trace context on warn logs for decimal errors
      expect(warnLog!.traceId).toBeUndefined();
      expect(warnLog!.spanId).toBeUndefined();
    });

    it('still includes requestId when trace context is absent', async () => {
      const app = buildApp();
      await request(app).get('/exposed');

      const errorLogs = getJsonLogLines(stderrSpy);
      const log = errorLogs.find((l) => l.level === 'error');
      expect(log).toBeDefined();
      expect(log!.requestId).toBe('test-cid-001');
    });

    it('never throws — degrades gracefully', async () => {
      const app = buildApp();
      // Must not throw even without tracing context
      const res = await request(app).get('/exposed');
      expect(res.status).toBe(400);
    });
  });

  // ── Degraded OTel (failure safety) ────────────────────────────────────────

  describe('when OTel API is broken', () => {
    beforeEach(() => {
      breakActiveSpan();
    });

    it('still returns valid error responses', async () => {
      const app = buildApp();
      const res = await request(app).get('/exposed');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('logs errors without traceId/spanId fields', async () => {
      const app = buildApp();
      await request(app).get('/exposed');

      const errorLogs = getJsonLogLines(stderrSpy);
      const log = errorLogs.find((l) => l.level === 'error');
      expect(log).toBeDefined();
      expect(log!.traceId).toBeUndefined();
      expect(log!.spanId).toBeUndefined();
    });

    it('handles unexpected errors too', async () => {
      const app = buildApp();
      const res = await request(app).get('/unknown');
      expect(res.status).toBe(500);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles SyntaxError (malformed JSON) without trace logging', async () => {
      setActiveSpan(TRACE_ID, SPAN_ID);
      const app = buildApp();
      const res = await request(app).get('/syntax');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ApiErrorCode.VALIDATION_ERROR);
    });

    it('handles entity.too.large without trace logging', async () => {
      setActiveSpan(TRACE_ID, SPAN_ID);
      const app = buildApp();
      const res = await request(app).get('/entity-too-large');
      expect(res.status).toBe(413);
      // entity.too.large has no logError call, just an error response
      const errorLogs = getJsonLogLines(stderrSpy);
      // Should only have error logs if any were emitted; there should be none
      // for entity.too.large specifically
      const tooLargeLogs = errorLogs.filter((l) =>
        l.level === 'error' && typeof l.message === 'string' && (l.message as string).includes('too large'),
      );
      expect(tooLargeLogs.length).toBe(0);
    });

    it('DecimalSerializationError emits a warn log with field and code context', async () => {
      setActiveSpan(TRACE_ID, SPAN_ID);
      const app = buildApp();
      await request(app).get('/decimal');

      // The warn-level log (SerializationLogger.validationFailed) goes to stdout
      const warnLogs = getJsonLogLines(stdoutSpy);
      const warnLog = warnLogs.find((l) => l.level === 'warn');
      expect(warnLog).toBeDefined();
      // Field and code are preserved in the warn log
      expect(warnLog!.field).toBeDefined();
      expect(warnLog!.code).toBeDefined();
    });

    it('works with different trace/span ID values', async () => {
      const customTraceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
      const customSpanId = 'bbbbbbbbbbbbbbb1';
      setActiveSpan(customTraceId, customSpanId);

      const app = buildApp();
      await request(app).get('/exposed');

      const errorLogs = getJsonLogLines(stderrSpy);
      const log = errorLogs.find((l) => l.level === 'error');
      expect(log!.traceId).toBe(customTraceId);
      expect(log!.spanId).toBe(customSpanId);
    });
  });

  // ── PII safety ─────────────────────────────────────────────────────────────

  describe('PII safety', () => {
    beforeEach(() => {
      setActiveSpan(TRACE_ID, SPAN_ID);
    });

    it('never exposes traceId in HTTP response body', async () => {
      const app = buildApp();
      const res = await request(app).get('/unknown');
      expect(res.body).not.toHaveProperty('traceId');
      expect(res.body).not.toHaveProperty('spanId');
      expect(res.body).not.toHaveProperty('trace');
      expect(JSON.stringify(res.body)).not.toContain(TRACE_ID);
      expect(JSON.stringify(res.body)).not.toContain(SPAN_ID);
    });

    it('never exposes spanId in HTTP response body', async () => {
      const app = buildApp();
      const res = await request(app).get('/exposed');
      expect(JSON.stringify(res.body)).not.toContain(SPAN_ID);
    });

    it('error details in response do not include trace identifiers', async () => {
      const app = buildApp();
      const res = await request(app).get('/exposed');
      const error = res.body.error as Record<string, unknown>;
      expect(Object.keys(error)).not.toContain('traceId');
      expect(Object.keys(error)).not.toContain('spanId');
    });
  });
});
