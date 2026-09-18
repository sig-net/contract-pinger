# Contract Pinger

Simple server that can request a signature from any supported network. Used in load and synthetic tests.

## Getting Started

### Prerequisites

- Node.js 22.14 or newer
- pnpm
- Compact compiler 0.33.0-rc.2 for the Midnight caller

### Install dependencies

```sh
pnpm install
```

Generate the caller bindings before building or testing. With the Compact
launcher installed:

```sh
pnpm compile:midnight
```

On Linux x64, the pinned standalone compiler can instead be installed with
`node scripts/install-compact.mjs .midnight/compact`; set
`COMPACTC="$PWD/.midnight/compact/compactc"` when invoking compilation. Use
`pnpm compile:midnight:zk` before real Midnight calls; the default compilation
skips proving keys. Docker builds generate the complete proving assets.

### Development

Run the server from TypeScript sources:

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

The `Solana Bidirectional (ad hoc)` workflow runs a load test entirely inside
the job on request, defaulting to 50 jobs: it starts a pinger, drives it, and
throws it away, touching nothing deployed. The addresses it exercises follow
from that environment's `SIG_SOL_SK`, so they are the job's own pool and have
to be funded first — the run prints each balance and stops if none has gas.

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

| Endpoint                               | Purpose                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /`                                | Health check. The only route that does not need `x-api-secret`.                    |
| `POST /ping`                           | One-shot signature request. `{ chain, check, env }`                                |
| `POST /eth_balance`                    | Ethereum balance lookup. `{ address, env }`                                        |
| `POST /sign_bidirectional`             | Start a bidirectional round trip. `{ env, mode?, sourceChain? }` → `202 { jobId }` |
| `GET /sign_bidirectional/:jobId`       | Job state, timings and transaction hashes                                          |
| `GET /sign_bidirectional/workers?env=` | Derived addresses, gas balances, busy/idle                                         |
| `GET /sign_bidirectional/stats?env=`   | Latency and failure aggregates, by mode                                            |

## Bidirectional sign/respond

`POST /sign_bidirectional` drives one full round trip: a `sign_bidirectional`
request on the selected source chain, an MPC signature, an Ethereum broadcast,
and the MPC reading that transaction's result back. `sourceChain` defaults to
`solana`, which calls the chain-signatures program directly. `midnight` uses
the dedicated caller below and supports only `env=stagenet`, targeting Sepolia.

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

Two modes, both needing Ethereum gas and no ERC20 balance:

- `eth_self_transfer` — zero-value self-send, 21k gas, depends on no contract.
- `erc20_zero_transfer` — `transfer(self, 0)`, 38k gas. The only mode that
  exercises the node's `debug_traceTransaction` extraction path, so it is worth
  running on a slower cadence even when the ETH mode is the default.

### Midnight caller

Set the `MPC_MIDNIGHT_*` endpoints in `.env.example`. Run the service and
commands where the proof-server URL is reachable. The service uses a dedicated
pinger wallet; the treasury seed belongs only in the funding command's environment.

```sh
pnpm compile:midnight:zk
pnpm fund:midnight --help
pnpm deploy:midnight
# Resume initialisation after a deployment was submitted:
pnpm deploy:midnight --initialise
pnpm fund --source-chain midnight --env stagenet --dry-run
pnpm fund --source-chain midnight --env stagenet
pnpm loadtest --source-chain midnight --env stagenet --jobs 1
```

Before deployment, fund the dedicated wallet using `fund:midnight` with explicit
NIGHT target, transfer cap, treasury reserve and minimum DUST. Its default is a
read-only funding preview; `--execute` transfers and saves the child seed in
`.midnight/pinger.env`. Deployment records the caller in `.midnight/deployment.json`.
Stop the pinger while running wallet funding or deployment commands.
Persist that directory for the service, or configure `MPC_MIDNIGHT_PINGER_SEED`
and the initialised `MPC_MIDNIGHT_CALLER_ADDRESS` explicitly.

Midnight holds one worker through the full round trip, including verification
and on-chain consumption of the successful return attestation. Once a source transaction is attempted, failed or interrupted jobs retain public
recovery identifiers in `.midnight/pending-request.json`. New Midnight jobs are
blocked until that request is reconciled; a restart preserves the block. The
receipt also records any settlement transaction attempt. Do not remove it merely
because a job timed out. Automatic recovery of failed requests is not implemented. Use `sourceChain=midnight&env=stagenet` on workers/stats queries.

The MPC repository's k6 workflow supports a serial Midnight run. Its schedule is
opt-in through `LT_MIDNIGHT_ENABLED=true`. Set the same variable in this repository
to include Midnight in the Ethereum funding sweep, plus the public caller address
and any MPC root override. `pnpm fund --env dev,testnet --include-midnight` shares
one spend cap across all three pools. Run only one service instance per Midnight
wallet; the wallet queue and worker lease are local to the process.

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

Capacity is two ceilings rather than one, because a job's cost changes at
confirmation. Before it, a job holds one of the derived addresses and a stream
of chain calls for about a minute. After it, the address is released and the job
holds only an event subscription, for up to thirty-five minutes. At 10
jobs/minute that is roughly a dozen of the first kind against 350 of the second,
so a single cap would let the cheap jobs crowd out the expensive ones — and its
real sustainable rate would be the cap divided by the respond budget.

`MAX_ACTIVE_JOBS` is bounded by the address pool and chain throughput.
`MAX_JOBS` is bounded by what the Solana endpoint tolerates, since signet.js
runs a subscription and a backfill loop per wait. A `429` names which ceiling
it hit: the first says add addresses or slow arrivals, the second says the
subscription ceiling is the limit, which is the point at which a shared event
dispatcher becomes worth building.

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
**public** key of `SIG_SOL_SK` — so the sweep derives it from that key rather
than being told it separately, and rotating the keypair moves the addresses on
both sides at once. `SIG_BIDIRECTIONAL_REQUESTER_PUBKEY` exists only as an
optional cross-check for the case where the sweep runs against a service
holding a different key; a mismatch fails the run. Each environment derives a
different set, since its program address pairs to a different root key.

Sizing the band: an address needs enough headroom to survive until the next
sweep, including a late one.

```
minutes of headroom = (topup - min) x paths / (rate x gas per run)
```

The defaults, and the arithmetic that sizes them, live beside each other in
[`src/utils/env.ts`](./src/utils/env.ts) — the only place any of these numbers
is written down. Everything else, both workflows included, passes the variable
through unset and takes what the schema resolved. Re-measure the gas figure
when the transaction mode or Sepolia gas moves, and the band follows from it.

`pnpm fund` fills every address below the top-up target to it, so each
sweep that lands leaves the pool holding the full band — a day of the
scheduled one-a-minute load by default — however far it had drained. At that
rate one address spends at a time, so an hourly sweep usually sends a single
transfer. Passing `--topup <eth>` changes the target for that run. The ad hoc
load test uses this to size funding to the run it is about to drive, from
`jobs`, `paths` and
the measured gas per round trip, floored at the band so a small run cannot
leave the pool thinner than the schedule keeps it. The per-address and per-run
caps are unchanged, so a job count too large to fund fails before anything is
sent rather than partway through.

Those caps are sized for the band, so a manual fill outgrows them quickly:
`--topup 0.02` across twenty addresses is over 0.3 ETH against a 0.2 cap.
Dispatching the `Fund Bidirectional Workers` workflow by hand takes
`max_per_run` and `max_per_address` alongside `topup`, raising either cap for
that run only. The schedule carries no inputs, so the hourly sweep always runs
under the defaults.

The floor of the band is `SIG_BIDIRECTIONAL_MIN_BALANCE_WEI`, the balance the
service refuses to lease below. The sweep refills at the target, above it, and
a scheduled sweep counts as funded once every address is back over the floor
— not at the target, since the live service may spend from an address between
its transfer and that check. There is deliberately no separate funding
minimum: one below the service's floor would strand any address that lands
between the two, unusable and never refilled, with nothing reporting a fault.

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
