import { getBytes, keccak256, toUtf8Bytes } from 'ethers';
import type { TransactionSerializableEIP1559 } from 'viem';
import type { CallerTransaction } from './caller.mjs';

/** Stable opaque paths are identical for funding, signing and request verification. */
export function midnightPath(path: string): Uint8Array {
  return getBytes(keccak256(toUtf8Bytes(path)));
}

/** Convert the actual unsigned Ethereum producer without changing its signing bytes. */
export function toCallerTransaction(
  tx: TransactionSerializableEIP1559
): CallerTransaction {
  const data = getBytes(tx.data ?? '0x');
  if (data.length !== 0 && data.length !== 68)
    throw new Error(
      'Pinger calldata must be empty or transfer(address,uint256)'
    );
  if (
    !tx.to ||
    tx.nonce === undefined ||
    tx.gas === undefined ||
    tx.maxFeePerGas === undefined ||
    tx.maxPriorityFeePerGas === undefined
  ) {
    throw new Error(
      'Unsigned pinger transaction is missing required EIP-1559 fields'
    );
  }
  if (tx.accessList?.length)
    throw new Error('Pinger transactions cannot contain an access list');
  return {
    chainId: BigInt(tx.chainId),
    nonce: BigInt(tx.nonce),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    maxFeePerGas: tx.maxFeePerGas,
    gasLimit: tx.gas,
    to: getBytes(tx.to),
    value: tx.value ?? 0n,
    calldata: {
      is_some: data.length !== 0,
      value: {
        selector: data.length ? data.slice(0, 4) : new Uint8Array(4),
        noWords: data.length ? 2n : 0n,
        words: data.length
          ? [data.slice(4, 36), data.slice(36, 68)]
          : [new Uint8Array(32), new Uint8Array(32)],
      },
    },
    accessListEntryCount: 0n,
    accessList: [],
  };
}
