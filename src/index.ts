import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
dotenv.config();

import blockchainHandlers from './handlers';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const API_SECRET = process.env.API_SECRET || 'default-secret-key';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const validateSecret = (req: Request, res: Response, next: NextFunction) => {
  const requestSecret = req.headers['x-api-secret'] || req.body.secret;

  if (!requestSecret || requestSecret !== API_SECRET) {
    return res.status(401).json({
      error: 'Unauthorized',
      details: 'Invalid or missing API secret',
    });
  }

  next();
};

app.use(validateSecret as express.RequestHandler);

app.get('/', (res: express.Response) => {
  return res.status(200).json({status: "OK"});
});

app.post(
  '/ping',
  async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const { chain, check, env } = req.body;

      console.log('Received ping request:', { chain, check, env });

      const validEnvironments = ['dev', 'testnet', 'mainnet'];

      if (!chain) {
        res.status(400).json({ error: 'Missing chain parameter' });
        return;
      }

      if (!blockchainHandlers.supports(chain)) {
        res.status(400).json({
          error: `Unsupported chain: ${chain}`,
          supportedChains: blockchainHandlers.getSupportedChains(),
        });
        return;
      }

      if (check === undefined) {
        res.status(400).json({ error: 'Missing check parameter' });
        return;
      }

      if (typeof check !== 'boolean') {
        res
          .status(400)
          .json({ error: 'Invalid check parameter: must be boolean' });
        return;
      }

      if (!env || !validEnvironments.includes(env)) {
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
      res.json(result);
    } catch (error: any) {
      console.error('Ping endpoint error:', error);
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

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(
    `Supported blockchains: ${blockchainHandlers.getSupportedChains().join(', ')}`
  );

  const loadErrors = blockchainHandlers.getLoadErrors?.() || [];
  if (loadErrors.length > 0) {
    console.warn(
      `WARNING: ${loadErrors.length} errors occurred while loading blockchain handlers`
    );
  }
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

export { app, server };
