import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia, mainnet } from 'viem/chains';
import { useEnv } from './useEnv';
import { contracts } from 'signet.js';

export const initEthereum = ({
  contractAddress,
  environment,
}: {
  contractAddress: string;
  environment: 'dev' | 'testnet' | 'mainnet';
}) => {
  const { ethRpcUrlSepolia, ethRpcUrlMainnet, evmSk } = useEnv();
  const config = {
    dev: {
      chain: sepolia,
      evmPrivateKey: evmSk,
      infuraUrl: ethRpcUrlSepolia,
    },
    testnet: {
      chain: sepolia,
      evmPrivateKey: evmSk,
      infuraUrl: ethRpcUrlSepolia,
    },
    mainnet: {
      chain: mainnet,
      evmPrivateKey: evmSk,
      infuraUrl: ethRpcUrlMainnet,
    },
  }[environment];

  if (!config.infuraUrl) {
    throw new Error(
      `Infura URL for ${environment} environment is missing. Please set the ${
        environment === 'mainnet' ? 'ethRpcUrlMainnet' : 'ethRpcUrlSepolia'
      } environment variable.`
    );
  }

  if (!config.evmPrivateKey) {
    throw new Error(
      `EVM private key for ${environment} environment is missing. Please set the ${
        environment === 'mainnet'
          ? 'evmPrivateKeyMainnet'
          : 'evmPrivateKeySepolia'
      } environment variable.`
    );
  }

  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(config.infuraUrl),
  });
  const account = privateKeyToAccount(
    (config.evmPrivateKey.startsWith('0x')
      ? config.evmPrivateKey
      : `0x${config.evmPrivateKey}`) as `0x${string}`
  );
  const walletClient = createWalletClient({
    account,
    chain: config.chain,
    transport: http(config.infuraUrl),
  });
  const chainSigContract = new contracts.evm.ChainSignatureContract({
    publicClient,
    walletClient,
    contractAddress: contractAddress as `0x${string}`,
  });
  return { publicClient, walletClient, chainSigContract };
};
