const { waitForTransactionReceipt } = require("viem/actions");

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
}) => {
  const signatureRequest = await chainSigContract.createSignatureRequest({
    payload: new Uint8Array(Array(32).fill().map(() => Math.floor(Math.random() * 256))),
    path: '',
    key_version: 0,
  }, {
    sign: {
      algo: '',
      dest: '',
      params: '',
    },
  });

  const txReceipt = await waitForTransactionReceipt({
    client: publicClient,
    hash: signatureRequest.txHash,
  });

  console.log({ signatureRequest });
  return signatureRequest;
};

module.exports = { createSignRequestAndWaitSignature, createSignRequest }; 