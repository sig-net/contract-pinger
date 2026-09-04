import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

import blockchainHandlers from './handlers';
import {
  abortActiveJobs,
  getService as getBidirectionalService,
  listServices as listBidirectionalServices,
} from './handlers/signBidirectional';
import { buildStats } from './jobs/stats';
import {
  ETHEREUM_TARGETS,
  isTxMode,
  TX_MODES,
  type BidirectionalEnvironment,
} from './utils/bidirectionalTx';
import { env } from './utils/env';

// Asserted here rather than in the schema: this is the server's requirement,
// and the scripts share that config without serving anything.
if (!env.apiSecret) {
  console.error('FATAL: API_SECRET is not set. Exiting.');
  process.exit(1);
}

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const validateSecret = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  if (req.method === 'GET' && req.path === '/') {
    return next();
  }

  const requestSecret = req.headers['x-api-secret'] || req.body?.secret;

  if (!requestSecret || requestSecret !== env.apiSecret) {
    return res.status(401).json({
      error: 'Unauthorized',
      details: 'Invalid or missing API secret',
    });
  }

  next();
};

app.use(validateSecret as express.RequestHandler);

app.get('/', (req: express.Request, res: express.Response): void => {
  console.log('GET / - Health check accessed');
  res.json({
    status: 'OK',
    supportedChains: blockchainHandlers.getSupportedChains(),
  });
});

app.post(
  '/ping',
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const { chain, check, env } = req.body;

      console.log('Received ping request:', { chain, check, env });

      const validEnvironments = ['dev', 'testnet', 'mainnet'];

      if (!chain) {
        console.log('ping error: Missing chain parameter');
        res.status(400).json({ error: 'Missing chain parameter' });
        return;
      }

      if (!blockchainHandlers.supports(chain)) {
        console.log('ping error: Unsupported chain:', chain);
        res.status(400).json({
          error: `Unsupported chain: ${chain}`,
          supportedChains: blockchainHandlers.getSupportedChains(),
        });
        return;
      }

      if (check === undefined) {
        console.log('ping error: Missing check parameter');
        res.status(400).json({ error: 'Missing check parameter' });
        return;
      }

      if (typeof check !== 'boolean') {
        console.log(
          'ping error: Invalid check parameter (not boolean):',
          check
        );
        res
          .status(400)
          .json({ error: 'Invalid check parameter: must be boolean' });
        return;
      }

      if (!env || !validEnvironments.includes(env)) {
        console.log('ping error: Invalid environment parameter:', env);
        res.status(400).json({
          error: 'Invalid or missing environment parameter',
          validEnvironments,
        });
        return;
      }

      const handler = blockchainHandlers.getHandler(chain);
      const result = await handler.execute({
        check_signature: check,
        environment: env,
      });
      console.log(
        'ping success: Request completed for chain:',
        chain,
        'Result summary:',
        {
          success: result?.success,
          message: result?.message,
        }
      );
      res.json(result);
    } catch (error: any) {
      console.error('ping endpoint error:', error);
      if (error && error.statusCode) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        res.status(500).json({
          error: `Failed to process ping request`,
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
);

const bidirectionalEnvironments = ['dev', 'testnet', 'mainnet'] as const;

const resolveBidirectionalService = (network: unknown) => {
  if (
    typeof network !== 'string' ||
    !(bidirectionalEnvironments as readonly string[]).includes(network)
  ) {
    return { error: 'Invalid or missing environment parameter' as const };
  }
  // Each network settles on its own Ethereum, so the RPC follows the target
  // rather than being fixed to Sepolia.
  const rpcUrl = ETHEREUM_TARGETS[network as BidirectionalEnvironment].rpcUrl();
  if (!rpcUrl) {
    return {
      error: 'Missing Ethereum RPC URL for selected environment' as const,
    };
  }
  return {
    service: getBidirectionalService(
      network as 'dev' | 'testnet' | 'mainnet',
      rpcUrl
    ),
  };
};

app.post(
  '/sign_bidirectional',
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const { env: network, mode } = req.body ?? {};

      // Mode is validated before the service is resolved so a bad mode always
      // reports itself, rather than being masked by a missing RPC URL.
      const txMode = mode ?? env.bidirectional.txMode;
      if (!isTxMode(txMode)) {
        res
          .status(400)
          .json({ error: `Invalid mode: ${txMode}`, validModes: TX_MODES });
        return;
      }

      const resolved = resolveBidirectionalService(network);
      if ('error' in resolved) {
        res.status(400).json({
          error: resolved.error,
          validEnvironments: bidirectionalEnvironments,
        });
        return;
      }

      const { service } = resolved;

      // Capacity is checked before the rate limiter so a rejected request does
      // not consume an arrival slot. Once the job store is full it drains over
      // tens of minutes, and charging every rejection against the per-minute
      // budget would keep the limiter saturated with requests that were never
      // accepted.
      const full = service.jobs.atCapacity();
      if (full) {
        // Named rather than merged: an active rejection means the address pool
        // or chain throughput is the limit, and a respond rejection means the
        // subscription ceiling is. They call for different remedies.
        const { bidirectional } = env;
        const retryAfterMs = full === 'active' ? 15_000 : 60_000;
        res
          .status(429)
          .set('Retry-After', String(Math.ceil(retryAfterMs / 1000)))
          .json({
            error:
              full === 'active'
                ? 'Too many jobs holding an address'
                : 'Too many jobs awaiting the MPC respond',
            limit: full,
            activeJobs: service.jobs.activeCount,
            maxActiveJobs: bidirectional.maxActiveJobs,
            awaitingRespond: service.jobs.awaitingRespondCount,
            maxAwaitingRespond: bidirectional.maxJobs,
            retryAfterMs,
          });
        return;
      }

      // Arrival rate is capped separately from concurrency: a job holds its
      // address for about a minute but stays alive for up to thirty-five, so
      // an unbounded rate piles up respond waits long after the address pool
      // has stopped being the bottleneck.
      if (!service.limiter.tryAcquire()) {
        const retryAfterMs = service.limiter.retryAfterMs();
        res
          .status(429)
          .set('Retry-After', String(Math.ceil(retryAfterMs / 1000)))
          .json({
            error: 'Rate limit exceeded',
            limitPerMinute: env.bidirectional.maxRequestsPerMinute,
            retryAfterMs,
          });
        return;
      }

      const job = service.start(txMode);
      console.log('sign_bidirectional accepted:', {
        jobId: job.id,
        env: network,
        mode: txMode,
      });
      res.status(202).json({ jobId: job.id, state: job.state, mode: txMode });
    } catch (error) {
      console.error('sign_bidirectional endpoint error:', error);
      res.status(500).json({
        error: 'Failed to start bidirectional job',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

app.get(
  '/sign_bidirectional/workers',
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const resolved = resolveBidirectionalService(
        (req.query.env as string) || 'dev'
      );
      if ('error' in resolved) {
        res.status(400).json({ error: resolved.error });
        return;
      }
      const { service } = resolved;
      await service.ensureAddresses();
      await service.refreshBalances();
      res.json({
        workers: service.pool.all().map(w => ({
          path: w.path,
          address: w.address,
          balanceWei: w.balanceWei.toString(),
          busy: w.busy,
          underfunded: w.underfunded,
          // Set when a broadcast transaction was never seen confirmed; the
          // address is withheld until the chain moves past that nonce.
          pendingNonce: w.pendingNonce,
          leases: w.leases,
        })),
      });
    } catch (error) {
      console.error('sign_bidirectional/workers error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

app.get(
  '/sign_bidirectional/stats',
  (req: express.Request, res: express.Response): void => {
    const resolved = resolveBidirectionalService(
      (req.query.env as string) || 'dev'
    );
    if ('error' in resolved) {
      res.status(400).json({ error: resolved.error });
      return;
    }
    res.json(buildStats(resolved.service));
  }
);

app.get(
  '/sign_bidirectional/:jobId',
  (req: express.Request<{ jobId: string }>, res: express.Response): void => {
    for (const service of listBidirectionalServices()) {
      const view = service.jobs.view(req.params.jobId);
      if (view) {
        res.json(view);
        return;
      }
    }
    res.status(404).json({ error: 'Unknown jobId' });
  }
);

app.post(
  '/eth_balance',
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const address = req.body.address as string;
      const network = (req.body.env as string)?.toLowerCase();

      console.log('Received eth_balance request:', { address, env: network });

      if (!address) {
        console.log('eth_balance error: Missing address parameter');
        res.status(400).json({ error: 'Missing address parameter' });
        return;
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        console.log(
          'eth_balance error: Invalid Ethereum address provided:',
          address
        );
        res.status(400).json({ error: 'Invalid Ethereum address format' });
        return;
      }
      const { createPublicClient, http } = await import('viem');
      const { sepolia, mainnet } = await import('viem/chains');
      let ethRpcUrl = '';
      let chain;
      if (network === 'mainnet') {
        ethRpcUrl = env.ethRpcUrlMainnet;
        chain = mainnet;
      } else {
        ethRpcUrl = env.ethRpcUrlSepolia;
        chain = sepolia;
      }
      if (!ethRpcUrl) {
        console.log(
          'eth_balance error: Missing Ethereum RPC URL for environment:',
          network
        );
        res
          .status(500)
          .json({ error: 'Missing Ethereum RPC URL for selected environment' });
        return;
      }
      const publicClient = createPublicClient({
        chain,
        transport: http(ethRpcUrl),
      });
      const balance = await publicClient.getBalance({
        address: address as `0x${string}`,
      });
      console.log(
        'eth_balance success: Balance retrieved for address:',
        address,
        'Balance:',
        balance.toString()
      );
      res.json({ balance: balance.toString() });
    } catch (error: any) {
      console.error('eth_balance endpoint error:', error);
      res.status(500).json({ error: error.message || String(error) });
    }
  }
);

// Global error handler
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
  }
);

let server: ReturnType<typeof app.listen> | undefined;

if (require.main === module) {
  server = app.listen(env.port, () => {
    console.log(`Server running at http://localhost:${env.port}`);
    console.log(
      `Supported blockchains: ${blockchainHandlers.getSupportedChains().join(', ')}`
    );
  });

  process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    // Bidirectional jobs outlive the request that started them and hold event
    // subscriptions and timers for as long as their budgets allow. Without
    // this the listener closes but the process does not exit.
    const abandoned = abortActiveJobs();
    if (abandoned > 0) {
      console.log(`Abandoned ${abandoned} in-flight bidirectional job(s)`);
    }
    server?.close(() => {
      console.log('HTTP server closed');
    });
  });
}

export { app, server };
