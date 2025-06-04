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
      evmSk,
      ethRpcUrlSepolia,
    },
    testnet: {
      chain: sepolia,
      evmSk,
      ethRpcUrlSepolia,
    },
    mainnet: {
      chain: mainnet,
      evmSk,
      ethRpcUrlMainnet,
    },
  }[environment];

  if (!config.ethRpcUrlSepolia) {
    throw new Error(
      `Ethereum RPC URL for ${environment} environment is missing. Please set the ${
        environment === 'mainnet' ? 'ethRpcUrlMainnet' : 'ethRpcUrlSepolia'
      } environment variable.`
    );
  }

  if (!config.evmSk) {
    throw new Error(
      `EVM secret key for ${environment} environment is missing. Please set the evmSk environment variable.`
    );
  }

  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(config.ethRpcUrlMainnet),
  });
  const account = privateKeyToAccount(
    (config.evmSk.startsWith('0x')
      ? config.evmSk
      : `0x${config.evmSk}`) as `0x${string}`
  );
  const walletClient = createWalletClient({
    account,
    chain: config.chain,
    transport: http(config.ethRpcUrlMainnet),
  });
  const chainSigContract = new contracts.evm.ChainSignatureContract({
    publicClient,
    walletClient,
    contractAddress: contractAddress as `0x${string}`,
  });
  return { publicClient, walletClient, chainSigContract };
};
