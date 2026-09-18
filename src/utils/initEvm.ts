import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia, mainnet } from 'viem/chains';
import { env } from './env';
import { contracts } from '@sig-net/signet.js';

const buildEthereum = ({
  contractAddress,
  environment,
}: {
  contractAddress: string;
  environment: 'dev' | 'testnet' | 'mainnet';
}) => {
  const { ethRpcUrlSepolia, ethRpcUrlMainnet, evmSk } = env;
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

const contexts = new Map<string, ReturnType<typeof buildEthereum>>();
export const initEthereum = (options: Parameters<typeof buildEthereum>[0]) => {
  const key = `${options.environment}:${options.contractAddress}`;
  let context = contexts.get(key);
  if (!context) {
    context = buildEthereum(options);
    contexts.set(key, context);
  }
  return context;
};

// The same account can submit to multiple programs on a chain. Serialize
// nonce lookup and broadcast across those programs, through the RPC response.
const submissions = new Map<string, Promise<unknown>>();
export const withEthereumSubmission = async <T>(
  key: string,
  submit: () => Promise<T>
): Promise<T> => {
  const previous = submissions.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(submit);
  submissions.set(key, current);
  try {
    return await current;
  } finally {
    if (submissions.get(key) === current) submissions.delete(key);
  }
};
