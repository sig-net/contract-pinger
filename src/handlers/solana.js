const { Transaction } = require("@solana/web3.js");
const { initSolanaNew } = require("../utils/initSolana");
const { signArgs } = require("../utils/evmTransactions");

module.exports = {
  chainName: "Solana",

  contractAddresses: {
    dev: "BtGZEs9ZJX3hAQuY5er8iyWrGsrPRZYupEtVSS129XKo",
    testnet: "",
    mainnet: "",
  },

  async execute({ check_signature, environment }) {
    const contractAddress = this.contractAddresses[environment];

    const { chainSigContract, provider, requesterKeypair } = initSolanaNew({
      contractAddress,
      environment,
    });

    if (check_signature) {
      const signature = await chainSigContract.sign(signArgs[0], {
        ...signArgs[1],
        remainingAccounts: [
          {
            pubkey: requesterKeypair.publicKey,
            isWritable: false,
            isSigner: true,
          },
        ],
        remainingSigners: [requesterKeypair],
      });

      return { signature };
    } else {
      const instruction = await chainSigContract.getSignRequestInstruction(
        signArgs[0],
        {
          ...signArgs[1],
          remainingAccounts: [
            {
              pubkey: requesterKeypair.publicKey,
              isWritable: false,
              isSigner: true,
            },
          ],
        }
      );

      const transaction = new Transaction().add(instruction);
      const hash = await provider.sendAndConfirm(transaction, [
        requesterKeypair,
      ]);

      return { txHash: hash };
    }
  },
};
