const { initEthereum } = require("../utils/initEvm");
const {
  createSignRequestAndWaitSignature,
  createSignRequest,
} = require("../utils/evmTransactions");

module.exports = {
  chainName: "Ethereum",

  contractAddresses: {
    dev: "0x69C6b28Fdc74618817fa380De29a653060e14009",
    testnet: "0x83458E8Bf8206131Fe5c05127007FA164c0948A2",
    mainnet: "0xf8bdC0612361a1E49a8E01423d4C0cFc5dF4791A",
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
