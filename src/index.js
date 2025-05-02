const express = require('express');
const dotenv = require('dotenv');
const { Transaction } = require('@solana/web3.js');
dotenv.config();

const { initEvm } = require('./utils/initEvm');
const { initSolana } = require('./utils/initSolana');
const {
  createSignRequestAndWaitSignature,
  createSignRequest,
  signArgs,
} = require('./utils/evmTransactions');
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
    const { chain, check, environment } = req.body;

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

    if (!environment || !validEnvironments.includes(environment)) {
      return res.status(400).json({
        error: 'Invalid or missing environment parameter',
        validEnvironments,
      });
    }

    const handler = blockchainHandlers.getHandler(chain);
    const result = await handler.execute({
      check_signature: check,
      environment,
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

app.post('/near', async (req, res) => {
  try {
    const { chainSigContract } = await initNear({
      contractAddress: req.body.contractAddress,
    });

    const txHash = await createSignRequestAndWaitSignature({
      chainSigContract,
    });

    res.json({ txHash });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to execute EVM transaction',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/evm', async (req, res) => {
  console.log('evm 2.0');
  try {
    const { chainSigContract, publicClient, walletClient } = initEvm({
      contractAddress: req.body.contractAddress,
    });

    const signature = await createSignRequestAndWaitSignature({
      chainSigContract,
      publicClient,
      walletClient,
    });

    res.json({ signature });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to execute EVM transaction',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/evm_no_check', async (req, res) => {
  console.log('evm_no_check 2.0');
  try {
    const { chainSigContract, publicClient, walletClient } = initEvm({
      contractAddress: req.body.contractAddress,
    });

    const signatureRequest = await createSignRequest({
      chainSigContract,
      publicClient,
      walletClient,
    });

    res.json({ signatureRequest });
  } catch (error) {
    console.log({ error });
    res.status(500).json({
      error: 'Failed to execute EVM transaction',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// TODO: replace with real calls

app.post('/solana', async (req, res) => {
  try {
    const { chainSigContract, requesterKeypair } = initSolana();

    const signature = await chainSigContract.sign(signArgs[0], {
      ...signArgs[1],
      remainingAccounts: [
        {
          pubkey: requesterKeypair.publicKey,
          isWritable: false,
          isSigner: true,
        },
      ],
      remainingSigners: [requesterKeypair],
    });

    res.json({ signature });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to execute Solana transaction',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/solana_no_check', async (req, res) => {
  try {
    const { chainSigContract, provider, requesterKeypair } = initSolana();

    const instruction = await chainSigContract.getSignRequestInstruction(
      signArgs[0],
      {
        ...signArgs[1],
        remainingAccounts: [
          {
            pubkey: requesterKeypair.publicKey,
            isWritable: false,
            isSigner: true,
          },
        ],
      }
    );
    const transaction = new Transaction().add(instruction);
    const hash = await provider.sendAndConfirm(transaction, [requesterKeypair]);

    res.json({ txHash: hash });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to execute Solana transaction',
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
