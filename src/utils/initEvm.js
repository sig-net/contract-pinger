const { createPublicClient, createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { sepolia } = require('viem/chains');
const { useEnv } = require('./useEnv');
const { contracts } = require('signet.js');
/**
 * Initialize EVM clients for server-side use
 */
const initEvm = ({
    contractAddress
}) => {
  const { sepoliaInfuraUrl, evmPrivateKey } = useEnv();

  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(sepoliaInfuraUrl, {
      retryCount: 0
    }),
  });

  const account = privateKeyToAccount(evmPrivateKey);

  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(sepoliaInfuraUrl, {
      retryCount: 0
    }),
  });

  const chainSigContract = new contracts.evm.ChainSignatureContract({
    publicClient,
    walletClient,
    contractAddress,
  });

  return { publicClient, chainSigContract };
};

module.exports = { initEvm };
