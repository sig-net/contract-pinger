/**
 * Load driver for POST /sign_bidirectional.
 *
 * Submits N jobs against a running pinger, respecting the server's own rate
 * limit, then polls every job to completion and reports what happened.
 *
 *   pnpm loadtest --jobs 50
 *   pnpm loadtest --jobs 20 --mode erc20_zero_transfer --env testnet
 *
 * Reads API_SECRET from the environment; it is never taken as an argument.
 *
 * Submission and completion are deliberately separate phases in the output:
 * jobs are accepted in seconds but settle over tens of minutes, so a summary
 * that only appeared at the end would look like a hang.
 */
import 'dotenv/config';

interface Options {
  jobs: number;
  env: string;
  mode: string;
  url: string;
  secret: string;
  pollMs: number;
}

const parseArgs = (argv: string[]): Options => {
  const get = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    jobs: Number(get('jobs', '10')),
    env: get('env', process.env.SIG_BIDIRECTIONAL_E2E_ENV || 'testnet'),
    mode: get(
      'mode',
      process.env.SIG_BIDIRECTIONAL_TX_MODE || 'eth_self_transfer'
    ),
    url: get('url', `http://localhost:${process.env.PORT || '3001'}`),
    // Environment only. A secret passed as an argument is visible in `ps`
    // output and lands in shell history.
    secret: process.env.API_SECRET || '',
    pollMs: Number(get('poll', '15000')),
  };
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const clock = (start: number) => {
  const seconds = Math.round((Date.now() - start) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(
    seconds % 60
  ).padStart(2, '0')}`;
};

const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
};

const fmt = (ms: number | null) =>
  ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`;

const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.secret) {
    console.error('Set API_SECRET in the environment');
    process.exit(1);
  }

  const headers = {
    'content-type': 'application/json',
    'x-api-secret': opts.secret,
  };
  const started = Date.now();

  console.log(
    `Driving ${opts.jobs} × ${opts.mode} against ${opts.url} (${opts.env})\n`
  );

  // --- Submit -------------------------------------------------------------
  // A 429 from the rate limiter is expected, not an error: the server caps
  // arrivals per minute and tells us exactly how long to wait.
  const jobIds: string[] = [];
  let rateLimited = 0;

  while (jobIds.length < opts.jobs) {
    const res = await fetch(`${opts.url}/sign_bidirectional`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ env: opts.env, mode: opts.mode }),
    });

    if (res.status === 429) {
      const body = await res.json();
      const waitMs = body.retryAfterMs ?? 5_000;
      rateLimited += 1;
      process.stdout.write(
        `\r[${clock(started)}] submitted ${jobIds.length}/${opts.jobs} — ` +
          `rate limited, waiting ${Math.ceil(waitMs / 1000)}s   `
      );
      await sleep(waitMs + 250);
      continue;
    }

    if (res.status !== 202) {
      console.error(`\nSubmit failed (${res.status}):`, await res.text());
      process.exit(1);
    }

    jobIds.push((await res.json()).jobId);
    process.stdout.write(
      `\r[${clock(started)}] submitted ${jobIds.length}/${opts.jobs}            `
    );
  }

  console.log(
    `\n\nAll ${jobIds.length} submitted in ${clock(started)}` +
      (rateLimited > 0 ? ` (${rateLimited} rate-limit waits)` : '') +
      '\nPolling to completion — the respond leg waits for Ethereum finality.\n'
  );

  // --- Poll ---------------------------------------------------------------
  const finished = new Map<string, any>();
  // A job the server no longer knows about — the store is in memory, so a
  // restart or a prune loses it — would otherwise be polled forever, since
  // completion is the only exit condition.
  const missing = new Map<string, number>();
  const MAX_MISSES = 5;

  while (finished.size < jobIds.length) {
    await sleep(opts.pollMs);

    const states: Record<string, number> = {};
    for (const id of jobIds) {
      if (finished.has(id)) {
        states[finished.get(id).state] =
          (states[finished.get(id).state] ?? 0) + 1;
        continue;
      }
      const res = await fetch(`${opts.url}/sign_bidirectional/${id}`, {
        headers,
      });
      if (!res.ok) {
        const misses = (missing.get(id) ?? 0) + 1;
        missing.set(id, misses);
        if (misses >= MAX_MISSES) {
          finished.set(id, {
            state: 'failed',
            failureReason: 'lost_by_server',
            error: `Job not found after ${MAX_MISSES} polls (server restarted, or the record was pruned)`,
          });
        }
        continue;
      }
      missing.delete(id);
      const job = await res.json();
      states[job.state] = (states[job.state] ?? 0) + 1;
      if (job.state === 'responded' || job.state === 'failed') {
        finished.set(id, job);
      }
    }

    const summary = Object.entries(states)
      .sort()
      .map(([state, count]) => `${state}=${count}`)
      .join('  ');
    console.log(`[${clock(started)}] ${summary}`);
  }

  // --- Report -------------------------------------------------------------
  const jobs = [...finished.values()];
  const ok = jobs.filter(j => j.state === 'responded');
  const bad = jobs.filter(j => j.state === 'failed');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Completed in ${clock(started)}`);
  console.log(`  succeeded  ${ok.length}/${jobs.length}`);
  console.log(`  failed     ${bad.length}/${jobs.length}`);

  if (bad.length > 0) {
    const reasons: Record<string, number> = {};
    for (const job of bad) {
      reasons[job.failureReason ?? 'unknown'] =
        (reasons[job.failureReason ?? 'unknown'] ?? 0) + 1;
    }
    console.log('\nFailures:');
    for (const [reason, count] of Object.entries(reasons).sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`  ${String(count).padStart(4)}  ${reason}`);
      const example = bad.find(j => j.failureReason === reason);
      if (example?.error) console.log(`        e.g. ${example.error}`);
    }
  }

  // Reported separately because they measure different things: waiting for a
  // free address, the MPC signing, Ethereum mining, and the MPC reading the
  // result back after finality.
  const metrics: [string, string][] = [
    ['lease wait', 'leaseWaitMs'],
    ['signature', 'signatureMs'],
    ['confirmation', 'confirmationMs'],
    ['respond', 'respondMs'],
    ['total', 'totalMs'],
  ];

  console.log('\nLatency (succeeded jobs):');
  console.log('  stage             min       p50       p95       max');
  for (const [label, key] of metrics) {
    const values = ok
      .map(j => j.durations?.[key])
      .filter((v): v is number => typeof v === 'number');
    console.log(
      `  ${label.padEnd(14)} ${fmt(values.length ? Math.min(...values) : null).padStart(8)}  ` +
        `${fmt(percentile(values, 50)).padStart(8)}  ` +
        `${fmt(percentile(values, 95)).padStart(8)}  ` +
        `${fmt(values.length ? Math.max(...values) : null).padStart(8)}`
    );
  }

  const stats = await fetch(
    `${opts.url}/sign_bidirectional/stats?env=${opts.env}`,
    { headers }
  );
  if (stats.ok) {
    const body = await stats.json();
    console.log(
      `\nPool: ${body.pool.busy}/${body.pool.size} busy, ` +
        `${body.pool.underfunded} underfunded`
    );
  }

  process.exit(bad.length > 0 ? 1 : 0);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
