const { initNearNew } = require('../utils/initNear');
const {
  createSignRequestAndWaitSignature,
} = require('../utils/evmTransactions');
const { constants } = require('signet.js');

module.exports = {
  chainName: 'NEAR',

  contractAddresses: {
    dev: constants.CONTRACT_ADDRESSES.NEAR.TESTNET_DEV,
    testnet: constants.CONTRACT_ADDRESSES.NEAR.TESTNET,
    mainnet: constants.CONTRACT_ADDRESSES.NEAR.MAINNET,
  },

  async execute({ environment }) {
    const contractAddress = this.contractAddresses[environment];

    const { chainSigContract } = await initNearNew({
      contractAddress,
      environment,
    });

    const txHash = await createSignRequestAndWaitSignature({
      chainSigContract,
    });

    return { txHash };
  },
};
