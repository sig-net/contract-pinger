const express = require('express');
const { Server } = require('http');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Import utilities
const { useEnv } = require('./utils/useEnv');
const { initNear } = require('./utils/initNear');
const { initEvm } = require('./utils/initEvm');
const { initChains } = require('./utils/chains');
const { executeEvmTransaction } = require('./utils/evmTransactions');

// Environment variables with fallback to 3001
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

// Create Express application
const app = express();

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/near', async (req, res) => {
  try {
    const { chainSigContract } = await initNear({
      contractAddress: req.body.contractAddress
    });
    const chains = initChains(chainSigContract);

    // Execute EVM transaction
    const txHash = await executeEvmTransaction({
      chainSigContract,
      evm: chains.evm,
      predecessorId: useEnv().nearAccount,
    });

    res.json({ txHash });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to execute EVM transaction',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get('/evm', async (req, res) => {
  try {
    const { chainSigContract, walletClient } = initEvm({
      contractAddress: req.body.contractAddress
    });
    const chains = initChains(chainSigContract);

    const txHash = await executeEvmTransaction({
      chainSigContract,
      evm: chains.evm,
      predecessorId: walletClient.account.address,
    });

    res.json({ txHash });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to execute EVM transaction',
      details: error instanceof Error ? error.message : String(error)
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