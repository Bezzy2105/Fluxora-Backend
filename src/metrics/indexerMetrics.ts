import { Counter, Gauge, Histogram } from 'prom-client';
import { registry } from '../metrics.js';

function counter<T extends string>(name: string, help: string, label: T): Counter<T> {
  return (registry.getSingleMetric(name) as Counter<T>) || new Counter({ name, help, labelNames: [label] as T[], registers: [registry] });
}

function gauge<T extends string>(name: string, help: string, label: T): Gauge<T> {
  return (registry.getSingleMetric(name) as Gauge<T>) || new Gauge({ name, help, labelNames: [label] as T[], registers: [registry] });
}

function histogram<T extends string>(name: string, help: string, label: T, buckets: number[]): Histogram<T> {
  return (registry.getSingleMetric(name) as Histogram<T>) || new Histogram({ name, help, labelNames: [label] as T[], buckets, registers: [registry] });
}

export const indexerReplayBatchesCommittedTotal = counter('indexer_replay_batches_committed_total', 'Total number of batch transactions committed during indexer replay operations', 'contract_id');
export const indexerReplayRowsCommittedTotal = counter('indexer_replay_rows_committed_total', 'Total number of rows inserted or skipped during indexer replays', 'contract_id');
export const indexerMtlsValidationFailuresTotal = counter('indexer_mt|s_validation_failures_total', 'mTLS validation failures', 'reason');
export const indexerReplayRowsPerSecond = gauge('indexer_replay_rows_per_second', 'Rolling rows/sec', 'contract_id');
export const indexerReplayDurationSeconds = histogram('indexer_replay_duration_seconds', 'Duration seconds', 'contract_id', [1,5,15,30,60,120,300,600,1800,3600]);
export const indexerReplayIntegrityGapsTotal = counter('indexer_replay_integrity_gaps_total', 'Ledger gaps detected', 'contract_id');
export const indexerReplayIntegrityDuplicatesTotal = counter('indexer_replay_integrity_duplicates_total', 'Duplicate event entries detected', 'contract_id');
export const indexerReplayActiveWorkers = gauge('indexer_replay_active_workers', 'Current number of concurrent backfill workers actively replaying a contract', 'contract_id');
export const indexerReplayBatchesFailedTotal = counter('indexer_replay_batches_failed_total', 'Total number of batch transactions that failed during indexer replay', 'contract_id');
export const indexerReplayRetriesTotal = counter('indexer_replay_retries_total', 'Total number of batch retry attempts during indexer replay', 'contract_id');

export function deRegisterIndexerMetrics(): void {
  ['indexer_replay_batches_committed_total','indexer_replay_rows_committed_total','indexer_replay_rows_per_second','indexer_replay_duration_seconds','indexer_mtls_validation_failures_total','indexer_replay_integrity_gaps_total','indexer_replay_integrity_duplicates_total','indexer_replay_active_workers','indexer_replay_batches_failed_total','indexer_replay_retries_total'].forEach((name) => registry.removeSingleMetric(name));
}