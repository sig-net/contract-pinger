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
      rpcUrl: ethRpcUrlSepolia,
    },
    testnet: {
      chain: sepolia,
      rpcUrl: ethRpcUrlSepolia,
    },
    mainnet: {
      chain: mainnet,
      rpcUrl: ethRpcUrlMainnet,
    },
  }[environment];

  if (!config.rpcUrl) {
    throw new Error(
      `Ethereum RPC URL for ${environment} environment is missing. Please set ${
        environment === 'mainnet'
          ? 'SIG_ETH_RPC_URL_MAINNET'
          : 'SIG_ETH_RPC_URL_SEPOLIA'
      } in your environment.`
    );
  }

  if (!evmSk) {
    throw new Error(
      `EVM secret key for ${environment} environment is missing. Please set the evmSk environment variable.`
    );
  }

  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl),
  });
  const account = privateKeyToAccount(
    (evmSk.startsWith('0x') ? evmSk : `0x${evmSk}`) as `0x${string}`
  );
  const walletClient = createWalletClient({
    account,
    chain: config.chain,
    transport: http(config.rpcUrl),
  });
  const chainSigContract = new contracts.evm.ChainSignatureContract({
    publicClient,
    walletClient,
    contractAddress: contractAddress as `0x${string}`,
  });
  return { publicClient, walletClient, chainSigContract };
};
