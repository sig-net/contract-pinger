const getSignArgs = () => {
  const payload = new Uint8Array(
    Array(32)
      .fill()
      .map(() => Math.floor(Math.random() * 256))
  );

  return [
    {
      payload,
      path: '',
      key_version: 0,
    },
    {
      sign: {
        algo: '',
        dest: '',
        params: '',
      },
    },
  ];
};

const getCustomTransactionArgs = async ({ publicClient, walletClient }) => {
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

const createSignRequestAndWaitSignature = async ({
  chainSigContract,
  publicClient,
  walletClient,
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

const createSignRequest = async ({
  chainSigContract,
  publicClient,
  walletClient,
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

module.exports = {
  createSignRequestAndWaitSignature,
  createSignRequest,
  getSignArgs,
};
