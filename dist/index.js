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
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const API_SECRET = process.env.API_SECRET || 'default-secret-key';
const app = (0, express_1.default)();
exports.app = app;
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
const validateSecret = (req, res, next) => {
    const requestSecret = req.headers['x-api-secret'] || req.body.secret;
    if (req.method === 'GET' && req.path === '/') {
        return next();
    }
    if (!requestSecret || requestSecret !== API_SECRET) {
        return res.status(401).json({
            error: 'Unauthorized',
            details: 'Invalid or missing API secret',
        });
    }
    next();
};
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        supportedChains: handlers_1.default.getSupportedChains(),
    });
});
app.use(validateSecret);
app.post('/ping', async (req, res) => {
    try {
        const { chain, check, env } = req.body;
        console.log('Received ping request:', { chain, check, env });
        const validEnvironments = ['dev', 'testnet', 'mainnet'];
        if (!chain) {
            res.status(400).json({ error: 'Missing chain parameter' });
            return;
        }
        if (!handlers_1.default.supports(chain)) {
            res.status(400).json({
                error: `Unsupported chain: ${chain}`,
                supportedChains: handlers_1.default.getSupportedChains(),
            });
            return;
        }
        if (check === undefined) {
            res.status(400).json({ error: 'Missing check parameter' });
            return;
        }
        if (typeof check !== 'boolean') {
            res
                .status(400)
                .json({ error: 'Invalid check parameter: must be boolean' });
            return;
        }
        if (!env || !validEnvironments.includes(env)) {
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
        res.json(result);
    }
    catch (error) {
        console.error('Ping endpoint error:', error);
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
app.post('/eth_balance', async (req, res) => {
    try {
        const address = req.body.address;
        const env = req.body.env?.toLowerCase();
        if (!address) {
            res.status(400).json({ error: 'Missing address parameter' });
            return;
        }
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
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
        res.json({ balance: balance.toString() });
    }
    catch (error) {
        res.status(500).json({ error: error.message || String(error) });
    }
});
// Global error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});
const server = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Supported blockchains: ${handlers_1.default.getSupportedChains().join(', ')}`);
    const loadErrors = handlers_1.default.getLoadErrors?.() || [];
    if (loadErrors.length > 0) {
        console.warn(`WARNING: ${loadErrors.length} errors occurred while loading blockchain handlers`);
    }
});
exports.server = server;
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});
