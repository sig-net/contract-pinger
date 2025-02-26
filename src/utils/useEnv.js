/**
 * Utility to access environment variables
 */
const useEnv = () => {
  return {
    // Server configuration
    port: process.env.PORT || '3001',
    nodeEnv: process.env.NODE_ENV || 'development',
    
    // NEAR configuration
    nearNetworkId: process.env.NEAR_NETWORK_ID || 'testnet',
    nearAccount: process.env.NEAR_ACCOUNT || '',
    nearPrivateKey: process.env.NEAR_PRIVATE_KEY || '',
    nearChainSignatureContract: process.env.NEAR_CHAIN_SIGNATURE_CONTRACT || '',
    
    // Infura URL for Sepolia testnet
    sepoliaInfuraUrl: process.env.SEPOLIA_INFURA_URL || '',
  };
};

module.exports = { useEnv }; 