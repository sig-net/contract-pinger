import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia, mainnet } from 'viem/chains';
import { useEnv } from './useEnv';
import { contracts } from 'signet.js';

export const initEvm = ({ contractAddress }: { contractAddress: string }) => {
  const { sepoliaInfuraUrl, evmPrivateKey } = useEnv();
  const publicClient = createPublicClient({ chain: sepolia, transport: http(sepoliaInfuraUrl) });
  const account = privateKeyToAccount((evmPrivateKey.startsWith('0x') ? evmPrivateKey : `0x${evmPrivateKey}`) as `0x${string}`);
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(sepoliaInfuraUrl) });
  const chainSigContract = new contracts.evm.ChainSignatureContract({ publicClient, walletClient, contractAddress: contractAddress as `0x${string}` });
  return { publicClient, walletClient, chainSigContract };
};

export const initEthereum = ({ contractAddress, environment }: { contractAddress: string, environment: 'dev' | 'testnet' | 'mainnet' }) => {
  const { sepoliaInfuraUrl, mainnetInfuraUrl, evmPrivateKeySepolia, evmPrivateKeyMainnet } = useEnv();
  const config = {
    dev: { chain: sepolia, evmPrivateKey: evmPrivateKeySepolia, infuraUrl: sepoliaInfuraUrl },
    testnet: { chain: sepolia, evmPrivateKey: evmPrivateKeySepolia, infuraUrl: sepoliaInfuraUrl },
    mainnet: { chain: mainnet, evmPrivateKey: evmPrivateKeyMainnet, infuraUrl: mainnetInfuraUrl },
  }[environment];
  const publicClient = createPublicClient({ chain: config.chain, transport: http(config.infuraUrl) });
  const account = privateKeyToAccount((config.evmPrivateKey.startsWith('0x') ? config.evmPrivateKey : `0x${config.evmPrivateKey}`) as `0x${string}`);
  const walletClient = createWalletClient({ account, chain: config.chain, transport: http(config.infuraUrl) });
  const chainSigContract = new contracts.evm.ChainSignatureContract({ publicClient, walletClient, contractAddress: contractAddress as `0x${string}` });
  return { publicClient, walletClient, chainSigContract };
};
