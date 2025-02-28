const { createPublicClient, createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { sepolia } = require('viem/chains');
const { useEnv } = require('./useEnv');
const { utils } = require('signet.js');
/**
 * Initialize EVM clients for server-side use
 */
const initEvm = ({
    contractAddress
}) => {
  const { sepoliaInfuraUrl, evmPrivateKey } = useEnv();

  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(sepoliaInfuraUrl),
  });

  const account = privateKeyToAccount(evmPrivateKey);

  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(sepoliaInfuraUrl),
  });

  const chainSigContract = new utils.chains.evm.ChainSignatureContract({
    publicClient,
    walletClient,
    contractAddress,
  });

  return { publicClient, walletClient, chainSigContract };
};

module.exports = { initEvm };
