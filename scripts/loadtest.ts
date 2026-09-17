/** Submit jobs, then poll and report. API_SECRET is read only from the environment. */
import 'dotenv/config';

import { env } from '../src/utils/env';
import type { JobView } from '../src/jobs/store';
import type { buildStats } from '../src/jobs/stats';

type ReportJob = Pick<JobView, 'state' | 'error'> & {
  durations?: JobView['durations'];
  failureReason?: JobView['failureReason'] | 'lost_by_server';
};

const parseArgs = (argv: string[]) => {
  const get = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const sourceChain = get('source-chain', 'solana');
  return {
    jobs: Number(get('jobs', '10')),
    sourceChain,
    env: get(
      'env',
      sourceChain === 'midnight' ? 'stagenet' : env.bidirectional.e2eEnv
    ),
    mode: get('mode', env.bidirectional.txMode),
    url: get('url', `http://localhost:${env.port}`),
    secret: env.apiSecret ?? '',
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
    `Driving ${opts.jobs} × ${opts.mode} against ${opts.url} (${opts.sourceChain}/${opts.env})\n`
  );

  const jobIds: string[] = [];
  let rateLimited = 0;
  let submissionFailed = false;

  try {
    while (jobIds.length < opts.jobs) {
      const res = await fetch(`${opts.url}/sign_bidirectional`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          env: opts.env,
          mode: opts.mode,
          sourceChain: opts.sourceChain,
        }),
      });

      if (res.status === 429) {
        const body: { retryAfterMs?: number } = await res.json();
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
        submissionFailed = true;
        break;
      }

      const { jobId }: { jobId: string } = await res.json();
      jobIds.push(jobId);
      console.log(
        `[${clock(started)}] accepted ${jobId} (${jobIds.length}/${opts.jobs})`
      );
    }
  } catch (error) {
    // A lost POST response may hide an accepted job; never submit it again.
    console.error('\nSubmit failed:', error);
    submissionFailed = true;
  }
  if (submissionFailed && jobIds.length === 0) process.exit(1);

  console.log(
    `\n\n${submissionFailed ? `Stopped after ${jobIds.length}/${opts.jobs} submissions` : `All ${jobIds.length} submitted`} in ${clock(started)}` +
      (rateLimited > 0 ? ` (${rateLimited} rate-limit waits)` : '') +
      '\nPolling to completion — the respond leg waits for Ethereum finality.\n'
  );

  const finished = new Map<string, ReportJob>();
  // Bound consecutive unsuccessful polls when the in-memory server loses a job.
  const missing = new Map<string, number>();
  const MAX_MISSES = 5;

  while (finished.size < jobIds.length) {
    await sleep(opts.pollMs);

    const states: Record<string, number> = {};
    for (const id of jobIds) {
      let job = finished.get(id);
      if (!job) {
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
        job = (await res.json()) as JobView;
        if (job.state === 'responded' || job.state === 'failed')
          finished.set(id, job);
      }
      states[job.state] = (states[job.state] ?? 0) + 1;
    }

    const summary = Object.entries(states)
      .sort()
      .map(([state, count]) => `${state}=${count}`)
      .join('  ');
    console.log(`[${clock(started)}] ${summary}`);
  }

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
      const reason = job.failureReason ?? 'unknown';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
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
    const columns = [
      values.length ? Math.min(...values) : null,
      percentile(values, 50),
      percentile(values, 95),
      values.length ? Math.max(...values) : null,
    ]
      .map(value => fmt(value).padStart(8))
      .join('  ');
    console.log(`  ${label.padEnd(14)} ${columns}`);
  }

  const stats = await fetch(
    `${opts.url}/sign_bidirectional/stats?env=${encodeURIComponent(opts.env)}&sourceChain=${encodeURIComponent(opts.sourceChain)}`,
    { headers }
  );
  if (stats.ok) {
    const body: ReturnType<typeof buildStats> = await stats.json();
    console.log(
      `\nPool: ${body.pool.busy}/${body.pool.size} busy, ` +
        `${body.pool.underfunded} underfunded`
    );
  }

  process.exit(submissionFailed || bad.length > 0 ? 1 : 0);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
