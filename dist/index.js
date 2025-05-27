"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const handlers_1 = __importDefault(require("./handlers"));
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const API_SECRET = process.env.API_SECRET || 'default-secret-key';
const app = (0, express_1.default)();
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
// Use generics for Express v5 compatibility
app.use(validateSecret);
app.post('/ping', (async (req, res) => {
    try {
        const { chain, check, env } = req.body;
        const validEnvironments = ['dev', 'testnet', 'mainnet'];
        if (!chain) {
            return res.status(400).json({ error: 'Missing chain parameter' });
        }
        if (!handlers_1.default.supports(chain)) {
            return res.status(400).json({
                error: `Unsupported chain: ${chain}`,
                supportedChains: handlers_1.default.getSupportedChains(),
            });
        }
        if (check === undefined) {
            return res.status(400).json({ error: 'Missing check parameter' });
        }
        // ...existing code...
    }
    catch (error) {
        res.status(500).json({ error: 'Internal server error', details: error });
    }
}));
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
