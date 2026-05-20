/**
 * Render data/benchmarks.db as a markdown table to stdout.
 *
 * One section per run group (a full sweep of requests x reps).
 * Rows = (system, request), columns = key metrics.
 */
import { getDistinctRunGroups, getRuns, type RunRecord } from './bench-db.js';

function fmt(n: number | null | undefined, decimals = 0): string {
  if (n == null) return '-';
  if (decimals === 0) return String(Math.round(n));
  return n.toFixed(decimals);
}

function fmtCost(n: number | null | undefined): string {
  if (n == null) return '-';
  return n < 0.001 ? `$${n.toFixed(5)}` : `$${n.toFixed(4)}`;
}

function renderRunGroup(groupId: string, runs: RunRecord[]): void {
  const systemLabel = runs[0]?.system_under_test ?? groupId;
  const startedAt = runs[0]?.started_at ?? '';

  console.log(`\n## Run group: ${groupId}`);
  console.log(`**System:** ${systemLabel}  **Started:** ${startedAt}\n`);

  // Header
  const header = [
    'request_id',
    'rep',
    'pass',
    'in_tok',
    'cache_read',
    'cache_create',
    'out_tok',
    'api_calls',
    'tool_calls',
    'latency_ms',
    'cost_usd',
  ];
  console.log('| ' + header.join(' | ') + ' |');
  console.log('| ' + header.map(() => '---').join(' | ') + ' |');

  // Sort by request_id then repetition
  const sorted = [...runs].sort((a, b) => {
    if (a.request_id < b.request_id) return -1;
    if (a.request_id > b.request_id) return 1;
    return a.repetition - b.repetition;
  });

  let totalPass = 0;
  let totalRuns = 0;

  for (const r of sorted) {
    const passStr = r.programmatic_pass == null ? '-' : r.programmatic_pass ? 'yes' : 'no';
    if (r.programmatic_pass != null) {
      totalRuns++;
      if (r.programmatic_pass) totalPass++;
    }
    const row = [
      r.request_id,
      String(r.repetition),
      passStr,
      fmt(r.total_input_tokens),
      fmt(r.total_cached_tokens),
      fmt(r.total_cache_creation_tokens),
      fmt(r.total_output_tokens),
      fmt(r.num_api_calls),
      fmt(r.num_tool_calls),
      fmt(r.latency_ms),
      fmtCost(r.cost_usd),
    ];
    console.log('| ' + row.join(' | ') + ' |');
  }

  if (totalRuns > 0) {
    console.log(`\n**Programmatic gates:** ${totalPass}/${totalRuns} passed`);
  }
}

function main(): void {
  const groups = getDistinctRunGroups();
  if (groups.length === 0) {
    console.log('No runs found in data/benchmarks.db.\nRun bench.ts first.');
    return;
  }

  console.log('# NanoClaw Agent Benchmark Report');
  console.log(`Generated: ${new Date().toISOString()}\n`);

  for (const groupId of groups) {
    const runs = getRuns(groupId);
    if (runs.length === 0) continue;
    renderRunGroup(groupId, runs);
  }
}

main();
