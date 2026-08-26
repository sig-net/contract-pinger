"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSharedSolana = exports.initSolana = void 0;
const web3_js_1 = require("@solana/web3.js");
const anchor = __importStar(require("@coral-xyz/anchor"));
const signet_js_1 = require("signet.js");
const useEnv_1 = require("./useEnv");
const resolveConfig = (environment) => {
    const { solRpcUrlDevnet, solRpcUrlMainnet, solSk } = (0, useEnv_1.useEnv)();
    const config = {
        dev: { solanaRpcUrl: solRpcUrlDevnet, solanaPrivateKey: solSk },
        testnet: { solanaRpcUrl: solRpcUrlDevnet, solanaPrivateKey: solSk },
        mainnet: { solanaRpcUrl: solRpcUrlMainnet, solanaPrivateKey: solSk },
    }[environment];
    if (!config.solanaRpcUrl) {
        throw new Error(`Solana RPC URL for ${environment} environment is missing. Please set ${environment === 'mainnet'
            ? 'SIG_SOL_RPC_URL_MAINNET'
            : 'SIG_SOL_RPC_URL_DEV'} in your environment.`);
    }
    if (!config.solanaPrivateKey) {
        throw new Error(`Solana secret key is missing. Please set SIG_SOL_SK in your environment.`);
    }
    return config;
};
const buildProvider = (environment) => {
    const config = resolveConfig(environment);
    const connection = new web3_js_1.Connection(config.solanaRpcUrl, 'confirmed');
    const keypairArray = JSON.parse(config.solanaPrivateKey);
    const keypair = web3_js_1.Keypair.fromSecretKey(new Uint8Array(keypairArray));
    const wallet = new anchor.Wallet(keypair);
    const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: 'confirmed',
    });
    return { provider, keypair };
};
/**
 * Narrow the `SIG_SOL_ROOT_PUBLIC_KEY` override to the shape signet.js accepts.
 *
 * The override is arbitrary environment input, and a malformed value would
 * otherwise travel all the way to key normalization and fail there with an
 * error that says nothing about where it came from.
 */
const asRootPublicKey = (value) => {
    if (value.startsWith('secp256k1:') ||
        value.startsWith('04') ||
        value.startsWith('02') ||
        value.startsWith('03')) {
        return value;
    }
    throw new Error(`SIG_SOL_ROOT_PUBLIC_KEY must be a naj key ("secp256k1:...") or a hex ` +
        `public key starting 02, 03 or 04. Got "${value.slice(0, 12)}...". ` +
        `Leave it unset to pair the root key to the program address instead.`);
};
const buildContract = ({ contractAddress, provider, requesterAddress, disableRetryOnRateLimit = false, }) => {
    const { solRootPublicKey } = (0, useEnv_1.useEnv)();
    return new signet_js_1.contracts.solana.ChainSignatureContract({
        provider,
        programId: contractAddress,
        config: {
            // Passed as `undefined` rather than `''` when the override is absent.
            // signet.js falls back to pairing the root key to the program address,
            // and that fallback is an `||`, so an empty string happens to work
            // today — but it would stop working the moment upstream switched to
            // `??`, sending the empty string through to key normalization.
            rootPublicKey: solRootPublicKey
                ? asRootPublicKey(solRootPublicKey)
                : undefined,
            requesterAddress,
            disableRetryOnRateLimit,
        },
    });
};
const initSolana = ({ contractAddress, environment, }) => {
    const { provider } = buildProvider(environment);
    const requesterKeypair = web3_js_1.Keypair.generate();
    const chainSigContract = buildContract({
        contractAddress,
        provider,
        requesterAddress: requesterKeypair.publicKey.toString(),
    });
    return { chainSigContract, provider, requesterKeypair };
};
exports.initSolana = initSolana;
const sharedContexts = new Map();
/**
 * One provider and one `ChainSignatureContract` per environment, reused across
 * requests.
 *
 * The bidirectional flow opens two long-lived event waits per job, and a
 * subscription shared across waiters can only ever be shared if the waiters
 * come from the same contract instance. Constructing a fresh instance per
 * request — as `initSolana` does for the unidirectional path — forecloses
 * that, so this is deliberately memoized.
 */
const getSharedSolana = ({ contractAddress, environment, }) => {
    const key = `${environment}:${contractAddress}`;
    const existing = sharedContexts.get(key);
    if (existing)
        return existing;
    const { provider, keypair } = buildProvider(environment);
    const context = {
        provider,
        keypair,
        chainSigContract: buildContract({
            contractAddress,
            provider,
            requesterAddress: keypair.publicKey.toString(),
            // Only the bidirectional path disables it. web3.js retrying 429s fights
            // the backfill loop in `waitForEvent` and multiplies requests against an
            // endpoint already refusing them, which signet.js documents. The
            // unidirectional `/ping` path runs no backfill, so it keeps the retry
            // that has always carried it through a rate-limited endpoint.
            disableRetryOnRateLimit: true,
        }),
    };
    sharedContexts.set(key, context);
    return context;
};
exports.getSharedSolana = getSharedSolana;
