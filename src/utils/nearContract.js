const signet = require('signet.js');
const { initNear } = require('./initNear');
const { useEnv } = require('./useEnv');

/**
 * Initialize NEAR contract for server-side use
 */
const initNearContract = async () => {
  const { nearAccount, nearNetworkId, nearChainSignatureContract } = useEnv();
  const { keyPair } = await initNear();

  const chainSigContract = new signet.utils.chains.near.ChainSignatureContract({
    networkId: nearNetworkId,
    contractId: nearChainSignatureContract,
    accountId: nearAccount,
    keypair: keyPair,
  });

  return { chainSigContract };
};

module.exports = { initNearContract }; 