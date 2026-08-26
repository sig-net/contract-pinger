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

### Code Formatting

To format all code in the project using Prettier and your `.prettierrc` settings, run:

```sh
pnpm format
```

This will automatically format your codebase according to the project's style rules.

### End-to-end test

The bidirectional round trip is excluded from `pnpm test` because its respond
leg waits for Ethereum finality. Run it on its own:

```sh
pnpm test:e2e
```

It skips itself when `SIG_SOL_RPC_URL_DEV`, `SIG_SOL_SK` or
`SIG_ETH_RPC_URL_SEPOLIA` are unset.

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
| `POST /sign_bidirectional/fund`        | Run a gas top-up sweep now                                           |

## Bidirectional sign/respond

`POST /sign_bidirectional` drives one full round trip: a `sign_bidirectional`
request on Solana, an MPC signature, a broadcast on Sepolia, and the MPC
reading that transaction's result back. It calls the chain-signatures program
directly, so no vault program or deployment is involved.

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

### Funding

Each derivation path owns one Ethereum address with its own nonce space, which
is what lets jobs run concurrently. Every one of those addresses needs gas.
`GET /sign_bidirectional/workers` lists them with balances;
`POST /sign_bidirectional/fund` tops up the short ones from `SIG_EVM_SK_1..5`.
Set `SIG_BIDIRECTIONAL_AUTO_FUND=true` to sweep periodically — off by default,
since a sweep spends real ETH.

An address is released back to the pool once its transaction confirms, not when
the job finishes: the nonce is spent at mining time, long before the MPC
finishes waiting for finality.

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
