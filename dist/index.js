"use strict";
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
