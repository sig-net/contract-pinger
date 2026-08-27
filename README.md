# Contract Pinger

Simple server that can request a signature from any supported network. Used in load and synthetic tests.

## Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- pnpm

### Install dependencies

```sh
pnpm install
```

### Development

Run the server in development mode (auto-reloads on changes):

```sh
pnpm dev
```

### Build

Transpile TypeScript to JavaScript:

```sh
pnpm build
```

### Run (Production)

```sh
pnpm start
```

### Run (Development)

```sh
pnpm dev
```

### Test

Run all integration and unit tests:

```sh
pnpm test
```

### End-to-end test

The bidirectional round trip is excluded from `pnpm test` because its respond
leg waits for Ethereum finality. Run it on its own:

```sh
pnpm test:e2e
```

`SIG_BIDIRECTIONAL_E2E_ENV` selects the network, and the credentials it needs
follow from that — `SIG_SOL_RPC_URL_DEV` and `SIG_ETH_RPC_URL_SEPOLIA` for
`dev` and `testnet`, their `_MAINNET` counterparts for `mainnet`. It skips
itself when any are unset.

### Code Formatting

To format all code in the project using Prettier and your `.prettierrc` settings, run:

```sh
pnpm format
```

This will automatically format your codebase according to the project's style rules.

## Endpoints

| Endpoint                               | Purpose                                                              |
| -------------------------------------- | -------------------------------------------------------------------- |
| `GET /`                                | Health check. The only route that does not need `x-api-secret`.      |
| `POST /ping`                           | One-shot signature request. `{ chain, check, env }`                  |
| `POST /eth_balance`                    | Ethereum balance lookup. `{ address, env }`                          |
| `POST /sign_bidirectional`             | Start a bidirectional round trip. `{ env, mode? }` → `202 { jobId }` |
| `GET /sign_bidirectional/:jobId`       | Job state, timings and transaction hashes                            |
| `GET /sign_bidirectional/workers?env=` | Derived addresses, gas balances, busy/idle                           |
| `GET /sign_bidirectional/stats?env=`   | Latency and failure aggregates, by mode                              |

## Bidirectional sign/respond

`POST /sign_bidirectional` drives one full round trip: a `sign_bidirectional`
request on Solana, an MPC signature, a broadcast on Sepolia, and the MPC
reading that transaction's result back. It calls the chain-signatures program
directly, so no vault program or deployment is involved.

`dev` and `testnet` both settle on Sepolia. `mainnet` settles on Ethereum
mainnet and therefore spends real ETH on every job, so the service holds it to
**one derived address and one job a minute**, fixed in code rather than read
from configuration — it exists to answer whether mainnet signing and responding
still work, and a setting meant for a testnet load run must not be able to point
volume at it. The `Bidirectional Mainnet Canary` workflow runs one round trip a
day.

It is asynchronous because the respond leg waits for Ethereum finality — up to
thirty-five minutes — which no proxy will hold a connection open for. `POST`
returns a `jobId` immediately; poll `GET /sign_bidirectional/:jobId`.

```sh
curl -X POST localhost:3001/sign_bidirectional \
  -H "x-api-secret: $API_SECRET" -H 'content-type: application/json' \
  -d '{"env":"dev","mode":"eth_self_transfer"}'
```

Two modes, both needing Sepolia ETH only and no ERC20 balance:

- `eth_self_transfer` — zero-value self-send, 21k gas, depends on no contract.
- `erc20_zero_transfer` — `transfer(self, 0)`, 38k gas. The only mode that
  exercises the node's `debug_traceTransaction` extraction path, so it is worth
  running on a slower cadence even when the ETH mode is the default.

### Load testing

Raise `SIG_BIDIRECTIONAL_PATHS` to the concurrency you want, fund each derived
address, start the server, and drive it:

```sh
pnpm dev                                    # or pnpm start
pnpm loadtest --jobs 50
pnpm loadtest --jobs 20 --mode erc20_zero_transfer --env testnet
```

The driver submits at whatever rate the server allows — a 429 carries a
`retryAfterMs`, which it waits out rather than treating as an error — then
polls every job to completion and reports success counts, failure reasons, and
latency percentiles per stage.

Sizing it: a job holds its address for roughly the time to sign plus two
confirmations, and stays alive for as long as the MPC takes to see finality. So
`PATHS` sets sustainable throughput while `MAX_JOBS` bounds how many respond
waits pile up.

A job waits up to `SIG_BIDIRECTIONAL_LEASE_WAIT_MS` for a free address rather
than failing when none is idle. A lease runs about as long as signing plus two
confirmations, so bursts arriving mid-lease would otherwise fail outright —
pool pressure as a cliff instead of a queue. Rising `lease wait` in the load
driver's output is the signal to add addresses.

`MAX_JOBS` is the one to watch. Each live job runs its own event subscription
and backfill loop against the Solana endpoint, because signet.js has no shared
dispatcher, so concurrency is paid in RPC requests. At 10 jobs/minute with a
35-minute respond leg an unbounded run would sit near 350 concurrent and
rate-limit the endpoint it depends on — which surfaces as jobs timing out and
looks like an MPC fault. The default is deliberately lower; over it, requests
are rejected with `429` and a `Retry-After` rather than accepted and starved.

### Funding

Each derivation path owns one Ethereum address with its own nonce space, which
is what lets jobs run concurrently. Every one of those addresses needs gas.

The service never spends. `GET /sign_bidirectional/workers` reports each
address and its balance, and a job is refused rather than started when its
address is short — but topping up lives outside the request path:

```sh
pnpm fund --env dev,testnet --dry-run   # show what would be sent
pnpm fund --env dev,testnet
```

Every network is funded by one invocation rather than one per network: the
spend caps govern a run, so a separate process per network would enforce each
cap against its own total.

Five values have to agree between the service and the sweep — `PATHS`,
`PATH_PREFIX`, `SIG_SOL_ROOT_PUBLIC_KEY`, the requester key, and
`MIN_BALANCE_WEI` — and drift between them is otherwise silent, sending ETH to
addresses no job uses while the real pool starves. Pass `--url` (or set
`SIG_BIDIRECTIONAL_SERVICE_URL`) and the sweep compares its derived addresses
against what the service reports, refusing to spend when they disagree. An
unreachable service is skipped rather than treated as a disagreement.

The same script runs on a schedule as the `Fund Bidirectional Workers`
workflow. It derives the addresses itself from public inputs rather than asking
the service for them, so it neither trusts the service to name its own payees
nor needs it to be running. It reads `SIG_BIDIRECTIONAL_FUNDING_SK` from the
environment — never an argument, which would put a key in `ps` output — waits
for each top-up receipt before reporting success, and refuses to send beyond
its per-address and per-run caps or below the funding wallet's reserve.

The addresses follow from `(requester, path)`, where the requester is the
**public** key of `SIG_SOL_SK`. Rotating that keypair moves every address, so
the workflow's `SIG_BIDIRECTIONAL_REQUESTER_PUBKEY` must match the deployed
service. Each environment derives a different set, since its program address
pairs to a different root key.

Sizing the band: an address needs enough headroom to survive until the next
sweep, including a late one.

```
runs of headroom = (topup - min) / gas per run
```

At a measured 0.0000234 ETH per `eth_self_transfer` round trip and 10 jobs/min
spread over 10 addresses, the 0.002 → 0.0035 default gives about 64 minutes —
four missed fifteen-minute sweeps. Re-measure when the mode or Sepolia gas
moves.

An address is released back to the pool once its transaction confirms, not when
the job finishes: the nonce is spent at mining time, long before the MPC
finishes waiting for finality.

If a broadcast transaction is never seen confirmed, the address is withheld
instead — `latest` still reports the old nonce while a transaction is pending,
so reusing it would sign that nonce twice. `GET /sign_bidirectional/workers`
shows it as `pendingNonce`, and the address returns to service automatically
once the chain moves past that nonce.

### Running a single instance

The address pool is in-process state guarding addresses that are global, so the
service must not be scaled horizontally. A second instance starts its own pool,
leases an address the first one already holds, reads the same nonce, and one of
the two transactions is rejected as underpriced. The same applies to `/ping` on
Ethereum, which spreads nonces across `SIG_EVM_SK_1..5` the same way. Solana is
unaffected, having no sequential nonce.

Job state is in memory too, so a restart drops whatever is in flight. Finished
jobs are retained up to `SIG_BIDIRECTIONAL_RETAINED_JOBS` and then dropped
oldest-first, which bounds memory and means `/stats` covers a recent window
rather than all time.

## Environment Variables

Copy `.env.example` to `.env` and fill in the required values for your environment.

Only `API_SECRET` is required to start. Everything else is needed per endpoint,
so a partial configuration runs fine as long as you avoid the paths it does not
cover.

`SIG_SOL_ROOT_PUBLIC_KEY` is an optional override. Left unset, signet.js pairs
the MPC root key to the chain-signatures program address, which is what you
want: supplying one network's key alongside another network's program produces
signatures that recover to an unexpected address.

Note that `SIG_EVM_SK_1` through `SIG_EVM_SK_5` are rotated unconditionally, so
all five must be set. They may all be the same key.
