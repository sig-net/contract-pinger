import type { PublicClient, WalletClient } from 'viem';
import type { contracts } from 'signet.js';

type ChainSigContract = InstanceType<
  typeof contracts.evm.ChainSignatureContract
>;

export const getSignArgs = (): [any, any] => {
  const payload = new Uint8Array(
    Array(32)
      .fill(0)
      .map(() => Math.floor(Math.random() * 256))
  );
  return [
    { payload, path: '', key_version: 1 },
    { sign: { algo: '', dest: '', params: '' } },
  ];
};

export const getCustomTransactionArgs = async ({
  publicClient,
  walletClient,
}: {
  publicClient: PublicClient;
  walletClient: WalletClient;
}) => {
  const { maxFeePerGas, maxPriorityFeePerGas } =
    await publicClient.estimateFeesPerGas();
  // `pending`, not `latest`: `latest` counts only mined transactions, so
  // concurrent requests on one key all read the same nonce and every
  // transaction after the first is rejected as an underpriced replacement.
  // Five keys are rotated, but nothing stops five concurrent requests landing
  // on one — and the deployed pinger signs from these same accounts, so its
  // in-flight transactions occupy nonces this would otherwise reuse.
  const nonce = await publicClient.getTransactionCount({
    address: walletClient.account!.address,
    blockTag: 'pending',
  });
  return {
    maxFeePerGas: (maxFeePerGas * 12n) / 10n,
    maxPriorityFeePerGas: (maxPriorityFeePerGas * 12n) / 10n,
    nonce,
  };
};

export const createSignRequest = async ({
  chainSigContract,
  publicClient,
  walletClient,
}: {
  chainSigContract: ChainSigContract;
  publicClient: PublicClient;
  walletClient: WalletClient;
}) => {
  const transactionArgs = await getCustomTransactionArgs({
    publicClient,
    walletClient,
  });
  const signArgs = getSignArgs();
  const signatureRequest = await chainSigContract.createSignatureRequest(
    signArgs[0],
    {
      ...signArgs[1],
      transaction: transactionArgs,
    }
  );
  console.log({ signatureRequest });
  return signatureRequest;
};
