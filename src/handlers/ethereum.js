const { initEthereum } = require('../utils/initEvm');
const {
  createSignRequestAndWaitSignature,
  createSignRequest,
} = require('../utils/evmTransactions');
const { constants } = require('signet.js');

module.exports = {
  chainName: 'Ethereum',

  contractAddresses: {
    dev: constants.CONTRACT_ADDRESSES.ETHEREUM.TESTNET_DEV,
    testnet: constants.CONTRACT_ADDRESSES.ETHEREUM.TESTNET,
    mainnet: constants.CONTRACT_ADDRESSES.ETHEREUM.MAINNET,
  },

  async execute({ check_signature, environment }) {
    const contractAddress = this.contractAddresses[environment];

    const { chainSigContract, publicClient, walletClient } = initEthereum({
      contractAddress,
      environment,
    });

    if (check_signature) {
      const signature = await createSignRequestAndWaitSignature({
        chainSigContract,
        publicClient,
        walletClient,
      });

      return { signature };
    } else {
      const signatureRequest = await createSignRequest({
        chainSigContract,
        publicClient,
        walletClient,
      });

      return { signatureRequest };
    }
  },
};
