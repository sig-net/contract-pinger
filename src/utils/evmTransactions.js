const executeEvmTransaction = async ({
  chainSigContract,
}) => {
  const rsvSignature = await chainSigContract.sign({
    payload: new Uint8Array(32).fill(0).map(() => Math.floor(Math.random() * 256)),
    path: "eth",
    key_version: 0,
  }, {
    sign: {
      algo: '',
      dest: '',
      params: '',
    },
    retry: {
      delay: 60000,
      retryCount: 1,
    }
  });

  if (!rsvSignature) {
    throw new Error("Failed to sign transaction");
  }

  console.log({ rsvSignature });
  return rsvSignature;
};

module.exports = { executeEvmTransaction }; 