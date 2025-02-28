const useEnv = () => {
  return {
    port: process.env.PORT || '3001',
    nodeEnv: process.env.NODE_ENV || 'development',
    
    nearNetworkId: process.env.NEAR_NETWORK_ID || 'testnet',
    nearAccount: process.env.NEAR_ACCOUNT || '',
    nearPrivateKey: process.env.NEAR_PRIVATE_KEY || '',
    
    sepoliaInfuraUrl: process.env.SEPOLIA_INFURA_URL || '',
    evmPrivateKey: process.env.EVM_PRIVATE_KEY || '',
  };
};

module.exports = { useEnv }; 