const { Transaction } = require('@solana/web3.js');
const { initSolanaNew } = require('../utils/initSolana');
const { getSignArgs } = require('../utils/evmTransactions');
const { constants } = require('signet.js');

module.exports = {
  chainName: 'Solana',

  contractAddresses: {
    dev: constants.CONTRACT_ADDRESSES.SOLANA.TESTNET_DEV,
    testnet: constants.CONTRACT_ADDRESSES.SOLANA.TESTNET,
    mainnet: constants.CONTRACT_ADDRESSES.SOLANA.MAINNET,
  },

  async execute({ check_signature, environment }) {
    const contractAddress = this.contractAddresses[environment];

    const { chainSigContract, provider, requesterKeypair } = initSolanaNew({
      contractAddress,
      environment,
    });

    const signArgs = getSignArgs();

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

      const requestId = chainSigContract.getRequestId(
        signArgs[0],
        signArgs[1].sign
      );

      const transaction = new Transaction().add(instruction);
      const hash = await provider.sendAndConfirm(transaction, [
        requesterKeypair,
      ]);

      return { signatureRequest: { txHash: hash, requestId } };
    }
  },
};
