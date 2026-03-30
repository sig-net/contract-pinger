// In-memory rotation index for Ethereum key (module-private)
let evmKeyIndex = 0;

const getNextEvmSk = (): string => {
  evmKeyIndex = (evmKeyIndex % 5) + 1;
  return process.env[
    `SIG_EVM_SK_${evmKeyIndex}` as keyof NodeJS.ProcessEnv
  ] as string;
};

export const useEnv = () => {
  return {
    // Server configuration
    port: process.env.PORT || '3001',
    nodeEnv: process.env.NODE_ENV || 'development',

    // Ethereum (lazy getter — only rotates key when accessed)
    get evmSk() {
      return getNextEvmSk();
    },
    ethRpcUrlSepolia: process.env.SIG_ETH_RPC_URL_SEPOLIA || '',
    ethRpcUrlMainnet: process.env.SIG_ETH_RPC_URL_MAINNET || '',

    // Solana
    solRpcUrlDevnet: process.env.SIG_SOL_RPC_URL_DEV || '',
    solRpcUrlMainnet: process.env.SIG_SOL_RPC_URL_MAINNET || '',
    solSk: process.env.SIG_SOL_SK || '',
    solRootPublicKey: process.env.SIG_SOL_ROOT_PUBLIC_KEY || '',
  };
};
