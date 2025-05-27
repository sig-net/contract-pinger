import { initNearNew } from '../utils/initNear';
import { createSignRequestAndWaitSignature } from '../utils/evmTransactions';
import { constants } from 'signet.js';

export const chainName = 'NEAR';

export const contractAddresses = {
  dev: constants.CONTRACT_ADDRESSES.NEAR.TESTNET_DEV,
  testnet: constants.CONTRACT_ADDRESSES.NEAR.TESTNET,
  mainnet: constants.CONTRACT_ADDRESSES.NEAR.MAINNET,
};

export async function execute({ environment }: { environment: keyof typeof contractAddresses }) {
  const contractAddress = contractAddresses[environment];
  const { chainSigContract } = await initNearNew({ contractAddress, environment });
  const txHash = await createSignRequestAndWaitSignature({ chainSigContract });
  return { txHash };
}
