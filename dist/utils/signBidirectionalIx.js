"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSignBidirectionalInstruction = exports.NO_CALLBACK_PROGRAM = void 0;
const web3_js_1 = require("@solana/web3.js");
/**
 * The chain-signatures program echoes this argument into
 * `SignBidirectionalEvent` and does nothing else with it — no CPI, no
 * validation. The node drops it entirely: its own `SignBidirectionalEvent`
 * struct has no such field. The IDL documents it as a post-execution callback
 * target that is "not yet enabled", so the default pubkey is passed to mean
 * "no callback" rather than leaving a stale pointer at some program.
 */
exports.NO_CALLBACK_PROGRAM = web3_js_1.PublicKey.default;
/**
 * Build a `sign_bidirectional` instruction.
 *
 * signet.js exposes `waitForEvent` and `getRequestIdBidirectional` but no
 * builder for this instruction, so it is assembled here against the IDL the
 * library already carries. Anchor resolves `programState` and `eventAuthority`
 * from their constant seeds; `requester` and `feePayer` are supplied.
 */
const buildSignBidirectionalInstruction = async ({ chainSigContract, requester, feePayer, args, }) => {
    const program = chainSigContract.program;
    return (program.methods
        .signBidirectional(args.serializedTransaction, args.caip2Id, args.keyVersion, args.path, args.algo, args.dest, args.params, exports.NO_CALLBACK_PROGRAM, args.outputDeserializationSchema, args.respondSerializationSchema)
        // `instructions` is optional in the program but Anchor still requires it
        // to be named. `sign_bidirectional` only emits an event, so the sysvar is
        // not needed and is omitted explicitly.
        .accounts({
        requester,
        feePayer,
        instructions: null,
    })
        .instruction());
};
exports.buildSignBidirectionalInstruction = buildSignBidirectionalInstruction;
