export const useEnv = () => {
  const getRotatingKey = () => {
    const currentTime = new Date().getTime();
    const keyIndex = (currentTime % 5) + 1;
    return process.env[
      `EVM_PRIVATE_KEY_${keyIndex}` as keyof NodeJS.ProcessEnv
    ] as string;
  };
  const getRotatingKeyMainnet = () => {
    const currentTime = new Date().getTime();
    const keyIndex = (currentTime % 5) + 1;
    return process.env[
      `EVM_PRIVATE_KEY_MAINNET_${keyIndex}` as keyof NodeJS.ProcessEnv
    ] as string;
  };
  return {
    port: process.env.PORT || '3001',
    nodeEnv: process.env.NODE_ENV || 'development',
    nearNetworkId: process.env.NEAR_NETWORK_ID || 'testnet',
    nearAccount: process.env.NEAR_ACCOUNT || '',
    nearPrivateKey: process.env.NEAR_PRIVATE_KEY || '',
    sepoliaInfuraUrl: process.env.SEPOLIA_INFURA_URL || '',
    mainnetInfuraUrl: process.env.MAINNET_INFURA_URL || '',
    evmPrivateKey: getRotatingKey(),
    evmPrivateKeySepolia: getRotatingKey(),
    evmPrivateKeyMainnet: getRotatingKeyMainnet(),
    solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY || '',
    solanaRpcUrl: process.env.SOLANA_RPC_URL || '',
    chainSigAddressSolana: process.env.CHAIN_SIGNATURES_ADDRESS_SOLANA || '',
    chainSigRootPublicKeySolana:
      process.env.CHAIN_SIGNATURES_ROOT_PUBLIC_KEY_SOLANA || '',
    solanaRpcUrlDevnet: process.env.SOLANA_RPC_URL_DEVNET || '',
    solanaRpcUrlMainnet: process.env.SOLANA_RPC_URL_MAINNET || '',
    solanaPrivateKeyDevnet: process.env.SOLANA_PRIVATE_KEY_DEVNET || '',
    solanaPrivateKeyMainnet: process.env.SOLANA_PRIVATE_KEY_MAINNET || '',
    nearAccountIdTestnet: process.env.NEAR_ACCOUNT_ID_TESTNET || '',
    nearAccountIdMainnet: process.env.NEAR_ACCOUNT_ID_MAINNET || '',
    nearPrivateKeyTestnet: process.env.NEAR_PRIVATE_KEY_TESTNET || '',
    nearPrivateKeyMainnet: process.env.NEAR_PRIVATE_KEY_MAINNET || '',
  };
};
