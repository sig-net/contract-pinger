const useEnv = () => {
  const getRotatingKey = () => {
    const currentTime = new Date().getTime();
    const keyIndex = (currentTime % 5) + 1
    
    return process.env[`EMV_PRIVATE_KEY_${keyIndex}`];
  };
  
  return {
    port: process.env.PORT || '3001',
    nodeEnv: process.env.NODE_ENV || 'development',
    
    nearNetworkId: process.env.NEAR_NETWORK_ID || 'testnet',
    nearAccount: process.env.NEAR_ACCOUNT || '',
    nearPrivateKey: process.env.NEAR_PRIVATE_KEY || '',
    
    sepoliaInfuraUrl: process.env.SEPOLIA_INFURA_URL || '',
    evmPrivateKey: getRotatingKey(),
  };
};

module.exports = { useEnv }; 