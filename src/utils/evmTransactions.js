const { waitForTransactionReceipt, getTransactionReceipt } = require("viem/actions");

const createSignRequestAndWaitSignature = async ({
  chainSigContract,
}) => {
  const rsvSignature = await chainSigContract.sign({
    payload: new Uint8Array(Array(32).fill().map(() => Math.floor(Math.random() * 256))),
    path: '',
    key_version: 0,
  }, {
    sign: {
      algo: '',
      dest: '',
      params: '',
    },
    retry: {
      delay: 10000,
      retryCount: 12,
    }
  });

  console.log({ rsvSignature });
  return rsvSignature;
};

const createSignRequest = async ({
  chainSigContract,
  publicClient,
  walletClient,
}) => {
  const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
  const nonce = await publicClient.getTransactionCount({
    address: walletClient.account.address,
    blockTag: 'latest',
  });

  const signatureRequest = await chainSigContract.createSignatureRequest(
    {
      payload: new Uint8Array(Array(32).fill().map(() => Math.floor(Math.random() * 256))),
      path: '',
      key_version: 0,
    },
    {
      sign: {
        algo: '',
        dest: '',
        params: '',
      },
      transaction: {
        maxFeePerGas: maxFeePerGas * 12n / 10n,
        maxPriorityFeePerGas: maxPriorityFeePerGas * 12n / 10n,
        nonce,
      }
    }
  );

  return signatureRequest;
};

module.exports = { createSignRequestAndWaitSignature, createSignRequest }; 