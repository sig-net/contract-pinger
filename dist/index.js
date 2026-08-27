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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.server = exports.app = void 0;
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const handlers_1 = __importDefault(require("./handlers"));
const signBidirectional_1 = require("./handlers/signBidirectional");
const stats_1 = require("./jobs/stats");
const bidirectionalTx_1 = require("./utils/bidirectionalTx");
const useEnv_1 = require("./utils/useEnv");
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const API_SECRET = process.env.API_SECRET;
if (!API_SECRET) {
    console.error('FATAL: API_SECRET environment variable is not set. Exiting.');
    process.exit(1);
}
const app = (0, express_1.default)();
exports.app = app;
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
const validateSecret = (req, res, next) => {
    if (req.method === 'GET' && req.path === '/') {
        return next();
    }
    const requestSecret = req.headers['x-api-secret'] || req.body?.secret;
    if (!requestSecret || requestSecret !== API_SECRET) {
        return res.status(401).json({
            error: 'Unauthorized',
            details: 'Invalid or missing API secret',
        });
    }
    next();
};
app.use(validateSecret);
app.get('/', (req, res) => {
    console.log('GET / - Health check accessed');
    res.json({
        status: 'OK',
        supportedChains: handlers_1.default.getSupportedChains(),
    });
});
app.post('/ping', async (req, res) => {
    try {
        const { chain, check, env } = req.body;
        console.log('Received ping request:', { chain, check, env });
        const validEnvironments = ['dev', 'testnet', 'mainnet'];
        if (!chain) {
            console.log('ping error: Missing chain parameter');
            res.status(400).json({ error: 'Missing chain parameter' });
            return;
        }
        if (!handlers_1.default.supports(chain)) {
            console.log('ping error: Unsupported chain:', chain);
            res.status(400).json({
                error: `Unsupported chain: ${chain}`,
                supportedChains: handlers_1.default.getSupportedChains(),
            });
            return;
        }
        if (check === undefined) {
            console.log('ping error: Missing check parameter');
            res.status(400).json({ error: 'Missing check parameter' });
            return;
        }
        if (typeof check !== 'boolean') {
            console.log('ping error: Invalid check parameter (not boolean):', check);
            res
                .status(400)
                .json({ error: 'Invalid check parameter: must be boolean' });
            return;
        }
        if (!env || !validEnvironments.includes(env)) {
            console.log('ping error: Invalid environment parameter:', env);
            res.status(400).json({
                error: 'Invalid or missing environment parameter',
                validEnvironments,
            });
            return;
        }
        const handler = handlers_1.default.getHandler(chain);
        const result = await handler.execute({
            check_signature: check,
            environment: env,
        });
        console.log('ping success: Request completed for chain:', chain, 'Result summary:', {
            success: result?.success,
            message: result?.message,
        });
        res.json(result);
    }
    catch (error) {
        console.error('ping endpoint error:', error);
        if (error && error.statusCode) {
            res.status(error.statusCode).json({ error: error.message });
        }
        else {
            res.status(500).json({
                error: `Failed to process ping request`,
                details: error instanceof Error ? error.message : String(error),
            });
        }
    }
});
// The Ethereum leg is Sepolia-only: the transaction builder pins that chain id
// and client, so a mainnet request would sign a Sepolia transaction against the
// mainnet chain-signatures program. Rejected here rather than accepted and
// failed further in.
const bidirectionalEnvironments = ['dev', 'testnet'];
const resolveBidirectionalService = (env) => {
    if (typeof env !== 'string' ||
        !bidirectionalEnvironments.includes(env)) {
        return { error: 'Invalid or missing environment parameter' };
    }
    const rpcUrl = process.env.SIG_ETH_RPC_URL_SEPOLIA;
    if (!rpcUrl) {
        return {
            error: 'Missing Ethereum RPC URL for selected environment',
        };
    }
    return {
        service: (0, signBidirectional_1.getService)(env, rpcUrl),
    };
};
app.post('/sign_bidirectional', async (req, res) => {
    try {
        const { env, mode } = req.body ?? {};
        // Mode is validated before the service is resolved so a bad mode always
        // reports itself, rather than being masked by a missing RPC URL.
        const txMode = mode ?? (0, useEnv_1.useEnv)().bidirectional.txMode;
        if (!(0, bidirectionalTx_1.isTxMode)(txMode)) {
            res
                .status(400)
                .json({ error: `Invalid mode: ${txMode}`, validModes: bidirectionalTx_1.TX_MODES });
            return;
        }
        const resolved = resolveBidirectionalService(env);
        if ('error' in resolved) {
            res.status(400).json({
                error: resolved.error,
                validEnvironments: bidirectionalEnvironments,
            });
            return;
        }
        const { service } = resolved;
        // Capacity is checked before the rate limiter so a rejected request does
        // not consume an arrival slot. Once the job store is full it drains over
        // tens of minutes, and charging every rejection against the per-minute
        // budget would keep the limiter saturated with requests that were never
        // accepted.
        if (service.jobs.atCapacity()) {
            // Jobs drain as their respond legs settle, so a fixed hint is the best
            // available: the alternative is the caller guessing.
            const retryAfterMs = 60_000;
            res
                .status(429)
                .set('Retry-After', String(Math.ceil(retryAfterMs / 1000)))
                .json({
                error: 'Too many jobs in flight',
                activeJobs: service.jobs.activeCount,
                maxJobs: (0, useEnv_1.useEnv)().bidirectional.maxJobs,
                retryAfterMs,
            });
            return;
        }
        // Arrival rate is capped separately from concurrency: a job holds its
        // address for about a minute but stays alive for up to thirty-five, so
        // an unbounded rate piles up respond waits long after the address pool
        // has stopped being the bottleneck.
        if (!service.limiter.tryAcquire()) {
            const retryAfterMs = service.limiter.retryAfterMs();
            res
                .status(429)
                .set('Retry-After', String(Math.ceil(retryAfterMs / 1000)))
                .json({
                error: 'Rate limit exceeded',
                limitPerMinute: (0, useEnv_1.useEnv)().bidirectional.maxRequestsPerMinute,
                retryAfterMs,
            });
            return;
        }
        const job = service.start(txMode);
        console.log('sign_bidirectional accepted:', {
            jobId: job.id,
            env,
            mode: txMode,
        });
        res.status(202).json({ jobId: job.id, state: job.state, mode: txMode });
    }
    catch (error) {
        console.error('sign_bidirectional endpoint error:', error);
        res.status(500).json({
            error: 'Failed to start bidirectional job',
            details: error instanceof Error ? error.message : String(error),
        });
    }
});
app.get('/sign_bidirectional/workers', async (req, res) => {
    try {
        const resolved = resolveBidirectionalService(req.query.env || 'dev');
        if ('error' in resolved) {
            res.status(400).json({ error: resolved.error });
            return;
        }
        const { service } = resolved;
        await service.ensureAddresses();
        await service.refreshBalances();
        res.json({
            workers: service.pool.all().map(w => ({
                path: w.path,
                address: w.address,
                balanceWei: w.balanceWei.toString(),
                busy: w.busy,
                underfunded: w.underfunded,
                // Set when a broadcast transaction was never seen confirmed; the
                // address is withheld until the chain moves past that nonce.
                pendingNonce: w.pendingNonce,
                leases: w.leases,
            })),
        });
    }
    catch (error) {
        console.error('sign_bidirectional/workers error:', error);
        res.status(500).json({ error: error.message || String(error) });
    }
});
app.get('/sign_bidirectional/stats', (req, res) => {
    const resolved = resolveBidirectionalService(req.query.env || 'dev');
    if ('error' in resolved) {
        res.status(400).json({ error: resolved.error });
        return;
    }
    res.json((0, stats_1.buildStats)(resolved.service));
});
app.post('/sign_bidirectional/fund', async (req, res) => {
    try {
        const resolved = resolveBidirectionalService(req.body?.env ?? 'dev');
        if ('error' in resolved) {
            res.status(400).json({ error: resolved.error });
            return;
        }
        const result = await resolved.service.sweep();
        res.json({
            checked: result.checked,
            toppedUp: result.toppedUp.map(t => ({
                path: t.path,
                address: t.address,
                amountWei: t.amountWei.toString(),
                txHash: t.txHash,
            })),
            stillUnderfunded: result.stillUnderfunded,
            errors: result.errors,
        });
    }
    catch (error) {
        console.error('sign_bidirectional/fund error:', error);
        res.status(500).json({ error: error.message || String(error) });
    }
});
app.get('/sign_bidirectional/:jobId', (req, res) => {
    for (const service of (0, signBidirectional_1.listServices)()) {
        const view = service.jobs.view(req.params.jobId);
        if (view) {
            res.json(view);
            return;
        }
    }
    res.status(404).json({ error: 'Unknown jobId' });
});
app.post('/eth_balance', async (req, res) => {
    try {
        const address = req.body.address;
        const env = req.body.env?.toLowerCase();
        console.log('Received eth_balance request:', { address, env });
        if (!address) {
            console.log('eth_balance error: Missing address parameter');
            res.status(400).json({ error: 'Missing address parameter' });
            return;
        }
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
            console.log('eth_balance error: Invalid Ethereum address provided:', address);
            res.status(400).json({ error: 'Invalid Ethereum address format' });
            return;
        }
        const { createPublicClient, http } = await Promise.resolve().then(() => __importStar(require('viem')));
        const { sepolia, mainnet } = await Promise.resolve().then(() => __importStar(require('viem/chains')));
        let ethRpcUrl = '';
        let chain;
        if (env === 'mainnet') {
            ethRpcUrl = process.env.SIG_ETH_RPC_URL_MAINNET || '';
            chain = mainnet;
        }
        else {
            ethRpcUrl = process.env.SIG_ETH_RPC_URL_SEPOLIA || '';
            chain = sepolia;
        }
        if (!ethRpcUrl) {
            console.log('eth_balance error: Missing Ethereum RPC URL for environment:', env);
            res
                .status(500)
                .json({ error: 'Missing Ethereum RPC URL for selected environment' });
            return;
        }
        const publicClient = createPublicClient({
            chain,
            transport: http(ethRpcUrl),
        });
        const balance = await publicClient.getBalance({
            address: address,
        });
        console.log('eth_balance success: Balance retrieved for address:', address, 'Balance:', balance.toString());
        res.json({ balance: balance.toString() });
    }
    catch (error) {
        console.error('eth_balance endpoint error:', error);
        res.status(500).json({ error: error.message || String(error) });
    }
});
// Global error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});
let server;
if (require.main === module) {
    exports.server = server = app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
        console.log(`Supported blockchains: ${handlers_1.default.getSupportedChains().join(', ')}`);
        // Opt-in, because a sweep spends real ETH. Without it the derived
        // addresses are funded by hand or by POST /sign_bidirectional/fund;
        // GET /sign_bidirectional/workers lists what needs topping up.
        if (process.env.SIG_BIDIRECTIONAL_AUTO_FUND === 'true') {
            const rpcUrl = process.env.SIG_ETH_RPC_URL_SEPOLIA;
            if (rpcUrl) {
                const service = (0, signBidirectional_1.getService)('dev', rpcUrl);
                service.startFundingSweeps();
                console.log('Bidirectional funding sweeps enabled');
            }
            else {
                console.warn('SIG_BIDIRECTIONAL_AUTO_FUND is set but SIG_ETH_RPC_URL_SEPOLIA is not; sweeps disabled');
            }
        }
    });
    process.on('SIGTERM', () => {
        console.log('SIGTERM signal received: closing HTTP server');
        server?.close(() => {
            console.log('HTTP server closed');
        });
    });
}
