import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  subscribeToSseStream,
  subscribeToSseStreamWithBackpressure,
  SSE_STREAM_UPDATE_EVENT,
  SSE_CLOSE_REASONS,
  sseEventBus,
  drainSseEventBus,
  registerSseShutdownCallback,
  _resetSseSubscriptionsForTest,
} from '../src/streams/sseEmitter.js';
import { sseLiveSubscribersGauge } from '../src/metrics/businessMetrics.js';

function emitStreamEvent(streamId: string, eventId: string): void {
  sseEventBus.emit(SSE_STREAM_UPDATE_EVENT, { streamId, eventId, payload: {} });
}

describe('SSE subscriber observability and cleanup', () => {
  beforeEach(() => {
    _resetSseSubscriptionsForTest();
  });

  afterEach(() => {
    _resetSseSubscriptionsForTest();
    vi.useRealTimers();
  });

  it('should clean up a subscriber on unsubscribe and update gauge', () => {
    const unsubscribe = subscribeToSseStream('stream-1', () => {});
    expect(sseLiveSubscribersGauge.get()).toBe(1);
    expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(1);

    unsubscribe();
    expect(sseLiveSubscribersGauge.get()).toBe(0);
    expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(0);
  });

  it('should keep metrics correct after repeated connect/disconnect cycles', () => {
    const unsubscribers: Array<() => void> = [];
    for (let i = 0; i < 3; i++) {
      unsubscribers.push(subscribeToSseStream(`stream-${i}`, () => {}));
    }
    expect(sseLiveSubscribersGauge.get()).toBe(3);

    unsubscribers[0]!();
    expect(sseLiveSubscribersGauge.get()).toBe(2);

    const replacement = subscribeToSseStream('stream-0', () => {});
    expect(sseLiveSubscribersGauge.get()).toBe(3);

    unsubscribers[1]!();
    unsubscribers[2]!();
    replacement();
    expect(sseLiveSubscribersGauge.get()).toBe(0);
    expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(0);
  });

  it('should not deliver events after unsubscribe', () => {
    const received: string[] = [];
    const unsubscribe = subscribeToSseStream('stream-1', (e) => received.push(e.eventId));

    emitStreamEvent('stream-1', '1');
    unsubscribe();
    emitStreamEvent('stream-1', '2');

    expect(received).toEqual(['1']);
  });

  it('should clean up when a timeout triggers connection close', () => {
    vi.useFakeTimers();
    const unsubscribe = subscribeToSseStream('stream-1', () => {});

    setTimeout(unsubscribe, 1000);
    vi.advanceTimersByTime(1001);

    expect(sseLiveSubscribersGauge.get()).toBe(0);
    expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(0);
  });

  it('should auto-unsubscribe when backpressure drops the connection', () => {
    const onDrop = vi.fn();
    const received: string[] = [];

    const unsubscribe = subscribeToSseStreamWithBackpressure(
      'stream-1',
      (e) => received.push(e.eventId),
      {
        maxBufferedEvents: 0,
        onBackpressureDrop: (reason) => onDrop(reason),
      },
    );

    emitStreamEvent('stream-1', '1');

    expect(onDrop).toHaveBeenCalledWith(SSE_CLOSE_REASONS.BACKPRESSURE);
    expect(sseLiveSubscribersGauge.get()).toBe(0);
    expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(0);
    expect(received).toEqual([]);

    emitStreamEvent('stream-1', '2');
    expect(received).toEqual([]);

    unsubscribe();
  });

  it('should clean up all subscribers and shutdown callbacks on drain', async () => {
    const subscriberA = vi.fn();
    const subscriberB = vi.fn();
    subscribeToSseStream('stream-1', subscriberA);
    subscribeToSseStream('stream-2', subscriberB);

    registerSseShutdownCallback(() => {});

    await drainSseEventBus(1000);

    expect(sseLiveSubscribersGauge.get()).toBe(0);
    expect(sseEventBus.listenerCount(SSE_STREAM_UPDATE_EVENT)).toBe(0);

    emitStreamEvent('stream-1', 'post-drain');
    emitStreamEvent('stream-2', 'post-drain');
    expect(subscriberA).not.toHaveBeenCalled();
    expect(subscriberB).not.toHaveBeenCalled();
  });

  it('should force-close subscriptions that exceed the drain timeout', async () => {
    vi.useFakeTimers();
    const forceClose = vi.fn();
    registerSseShutdownCallback(
      () => new Promise<void>(() => {}),
      forceClose,
    );

    const drainPromise = drainSseEventBus(1000);
    vi.advanceTimersByTime(1001);
    await drainPromise;

    expect(forceClose).toHaveBeenCalled();
  });
});
