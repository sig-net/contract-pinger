import { initSolanaNew } from '../utils/initSolana';
import { getSignArgs } from '../utils/evmTransactions';
import { constants } from 'signet.js';

export const chainName = 'Solana';

export const contractAddresses = {
  dev: constants.CONTRACT_ADDRESSES.SOLANA.TESTNET_DEV,
  testnet: constants.CONTRACT_ADDRESSES.SOLANA.TESTNET,
  mainnet: constants.CONTRACT_ADDRESSES.SOLANA.MAINNET,
};

export async function execute({
  check_signature,
  environment,
}: {
  check_signature: boolean;
  environment: keyof typeof contractAddresses;
}) {
  const contractAddress = contractAddresses[environment];
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
      retry: { delay: 5000, retryCount: 6 },
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
    return { instruction };
  }
}
