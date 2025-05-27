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

// Use generics for Express v5 compatibility
app.use(validateSecret as express.RequestHandler);

app.post('/ping', (async (req: express.Request, res: express.Response) => {
  try {
    const { chain, check, env } = req.body;

    const validEnvironments = ['dev', 'testnet', 'mainnet'];

    if (!chain) {
      return res.status(400).json({ error: 'Missing chain parameter' });
    }

    if (!blockchainHandlers.supports(chain)) {
      return res.status(400).json({
        error: `Unsupported chain: ${chain}`,
        supportedChains: blockchainHandlers.getSupportedChains(),
      });
    }

    if (check === undefined) {
      return res.status(400).json({ error: 'Missing check parameter' });
    }

    // ...existing code...
  } catch (error) {
    res.status(500).json({ error: 'Internal server error', details: error });
  }
}) as express.RequestHandler);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
