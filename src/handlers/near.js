const { initNearNew } = require("../utils/initNear");
const {
  createSignRequestAndWaitSignature,
} = require("../utils/evmTransactions");

module.exports = {
  chainName: "NEAR",

  contractAddresses: {
    dev: "dev.sig-net.testnet",
    testnet: "v1.sig-net.testnet",
    mainnet: "v1.sig-net.near",
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
