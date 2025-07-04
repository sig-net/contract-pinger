export const getSignArgs = (): [any, any] => {
  const payload = new Uint8Array(
    Array(32)
      .fill(0)
      .map(() => Math.floor(Math.random() * 256))
  );
  return [
    { payload, path: '', key_version: 0 },
    { sign: { algo: '', dest: '', params: '' } },
  ];
};

export const getCustomTransactionArgs = async ({
  publicClient,
  walletClient,
}: {
  publicClient: any;
  walletClient: any;
}) => {
  const { maxFeePerGas, maxPriorityFeePerGas } =
    await publicClient.estimateFeesPerGas();
  const nonce = await publicClient.getTransactionCount({
    address: walletClient.account.address,
    blockTag: 'latest',
  });
  return {
    maxFeePerGas: (maxFeePerGas * 12n) / 10n,
    maxPriorityFeePerGas: (maxPriorityFeePerGas * 12n) / 10n,
    nonce,
  };
};

export const createSignRequestAndWaitSignature = async ({
  chainSigContract,
  publicClient,
  walletClient,
}: {
  chainSigContract: any;
  publicClient?: any;
  walletClient?: any;
}) => {
  const transactionArgs = await getCustomTransactionArgs({
    publicClient,
    walletClient,
  });
  const signArgs = getSignArgs();
  const rsvSignature = await chainSigContract.sign(signArgs[0], {
    ...signArgs[1],
    retry: {
      delay: 10000,
      retryCount: 12,
    },
    transaction: transactionArgs,
  });
  console.log({ rsvSignature });
  return rsvSignature;
};

export const createSignRequest = async ({
  chainSigContract,
  publicClient,
  walletClient,
}: {
  chainSigContract: any;
  publicClient?: any;
  walletClient?: any;
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
