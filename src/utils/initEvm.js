const { createPublicClient, createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { sepolia, mainnet } = require('viem/chains');
const { useEnv } = require('./useEnv');
const { contracts } = require('signet.js');

/**
 * Initialize EVM clients for server-side use
 */
const initEvm = ({ contractAddress }) => {
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

  const chainSigContract = new contracts.evm.ChainSignatureContract({
    publicClient,
    walletClient,
    contractAddress,
  });

  return { publicClient, walletClient, chainSigContract };
};

const initEthereum = ({ contractAddress, environment }) => {
  const {
    sepoliaInfuraUrl,
    mainnetInfuraUrl,
    evmPrivateKeySepolia,
    evmPrivateKeyMainnet,
  } = useEnv();

  const { chain, evmPrivateKey, infuraUrl } = {
    dev: {
      chain: sepolia,
      evmPrivateKey: evmPrivateKeySepolia,
      infuraUrl: sepoliaInfuraUrl,
    },
    testnet: {
      chain: sepolia,
      evmPrivateKey: evmPrivateKeySepolia,
      infuraUrl: sepoliaInfuraUrl,
    },
    mainnet: {
      chain: mainnet,
      evmPrivateKey: evmPrivateKeyMainnet,
      infuraUrl: mainnetInfuraUrl,
    },
  }[environment];

  if (!infuraUrl) {
    throw new Error(
      `Infura URL for ${environment} environment is missing. Please set the ${
        environment === 'mainnet' ? 'mainnetInfuraUrl' : 'sepoliaInfuraUrl'
      } environment variable.`
    );
  }

  if (!evmPrivateKey) {
    throw new Error(
      `EVM private key for ${environment} environment is missing. Please set the ${
        environment === 'mainnet'
          ? 'evmPrivateKeyMainnet'
          : 'evmPrivateKeySepolia'
      } environment variable.`
    );
  }

  const publicClient = createPublicClient({
    chain,
    transport: http(infuraUrl),
  });

  const account = privateKeyToAccount(evmPrivateKey);

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(infuraUrl),
  });

  const chainSigContract = new contracts.evm.ChainSignatureContract({
    publicClient,
    walletClient,
    contractAddress,
  });

  return { publicClient, walletClient, chainSigContract };
};

module.exports = { initEvm, initEthereum };
