/**
 * Sign and execute an EVM transaction
 */
const executeEvmTransaction = async ({
  chainSigContract,
  evm,
  predecessorId,
}) => {
  const path = "eth";

  const { address: from } = await evm.deriveAddressAndPublicKey(
    predecessorId,
    path
  );

  const { balance, decimals } = await evm.getBalance(from);
  console.log({ from, balance, decimals });

  const { transaction, mpcPayloads } = await evm.prepareTransactionForSigning({
    from: from,
    to: "0x4174678c78fEaFd778c1ff319D5D326701449b25",
    value: 1n,
  });

  const rsvSignature = await chainSigContract.sign({
    payload: mpcPayloads[0],
    path,
    key_version: 0,
  });

  if (!rsvSignature) {
    throw new Error("Failed to sign transaction");
  }

  const tx = evm.attachTransactionSignature({
    transaction,
    mpcSignatures: [rsvSignature],
  });

  const txHash = await evm.broadcastTx(tx);

  console.log({ txHash });
  return txHash;
};

module.exports = { executeEvmTransaction }; 