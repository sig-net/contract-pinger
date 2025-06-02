import { initEthereum } from '../utils/initEvm';
import {
  createSignRequestAndWaitSignature,
  createSignRequest,
} from '../utils/evmTransactions';
import { constants } from 'signet.js';

export const chainName = 'Ethereum';

export const contractAddresses = {
  dev: constants.CONTRACT_ADDRESSES.ETHEREUM.TESTNET_DEV,
  testnet: constants.CONTRACT_ADDRESSES.ETHEREUM.TESTNET,
  mainnet: constants.CONTRACT_ADDRESSES.ETHEREUM.MAINNET,
};

export async function execute({
  check_signature,
  environment,
}: {
  check_signature: boolean;
  environment: keyof typeof contractAddresses;
}) {
  const contractAddress = contractAddresses[environment];
  const { chainSigContract, publicClient, walletClient } = initEthereum({
    contractAddress,
    environment,
  });
  if (check_signature) {
    // TODO: add ability to call with check=true on Ethereum
    throw new Error(
      `Ethereum can not be called with check=true due to long finalization time`
    );
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
}
