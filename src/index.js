const express = require('express');
const dotenv = require('dotenv');
dotenv.config();

const blockchainHandlers = require('./handlers');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const API_SECRET = process.env.API_SECRET || 'default-secret-key';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const validateSecret = (req, res, next) => {
  const requestSecret = req.headers['x-api-secret'] || req.body.secret;

  if (!requestSecret || requestSecret !== API_SECRET) {
    return res.status(401).json({
      error: 'Unauthorized',
      details: 'Invalid or missing API secret',
    });
  }

  next();
};

app.use(validateSecret);

app.post('/ping', async (req, res) => {
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

    if (!env || !validEnvironments.includes(env)) {
      return res.status(400).json({
        error: 'Invalid or missing environment parameter',
        validEnvironments,
      });
    }

    const handler = blockchainHandlers.getHandler(chain);
    const result = await handler.execute({
      check_signature: check,
      environment: env,
    });

    return res.json(result);
  } catch (error) {
    console.error('Ping endpoint error:', error);
    return res.status(500).json({
      error: `Failed to process ping request`,
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(
    `Supported blockchains: ${blockchainHandlers
      .getSupportedChains()
      .join(', ')}`
  );

  const loadErrors = blockchainHandlers.getLoadErrors();
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

module.exports = app;
