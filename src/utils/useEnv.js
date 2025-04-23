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

    solanaPrivateKey: "[106,158,228,116,175,238,163,246,248,224,127,188,15,136,45,63,23,24,185,49,226,84,49,189,129,119,232,1,249,111,142,132,190,139,73,255,119,114,72,86,158,155,153,193,220,105,255,205,87,51,254,4,251,145,209,41,134,24,180,22,227,92,189,65]",
    solanaRpcUrl: "https://api.devnet.solana.com",
    chainSigAddressSolana: "BtGZEs9ZJX3hAQuY5er8iyWrGsrPRZYupEtVSS129XKo",
    chainSigRootPublicKeySolana: "secp256k1:2aXyFojLFqE4jtWTVwyGRrJoik8UfBCx2AU7VALhDPAnNjnGYEtwHgiaHxu8S5tvbLnzSoojQAGeJcxz9YHa32cs",
  };
};

module.exports = { useEnv }; 
