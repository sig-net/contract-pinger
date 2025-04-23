const express = require('express');
const dotenv = require('dotenv');
const { Transaction } = require('@solana/web3.js');
// Load environment variables
dotenv.config();

// Import utilities
const { initNear } = require('./utils/initNear');
const { initEvm } = require('./utils/initEvm');
const { initSolana } = require('./utils/initSolana');
const {
  createSignRequestAndWaitSignature,
  createSignRequest,
  signArgs,
} = require('./utils/evmTransactions');

// Environment variables with fallback to 3001
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

// Create Express application
const app = express();

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/near', async (req, res) => {
  try {
    const { chainSigContract } = await initNear({
      contractAddress: req.body.contractAddress
    });

    // Execute EVM transaction
    const txHash = await createSignRequestAndWaitSignature({
      chainSigContract,
    });

    res.json({ txHash });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to execute EVM transaction',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/evm', async (req, res) => {
  console.log('evm 1.0');
  try {
    const { chainSigContract, publicClient, walletClient } = initEvm({
      contractAddress: req.body.contractAddress
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
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/evm_no_check', async (req, res) => {
  console.log('evm_no_check 1.0');
  try {
    const { chainSigContract, publicClient, walletClient } = initEvm({
      contractAddress: req.body.contractAddress
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
      details: error instanceof Error ? error.message : String(error)
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Start the server
const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// Handle server shutdown gracefully
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

module.exports = app;