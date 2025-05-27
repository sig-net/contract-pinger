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
exports.BlockchainHandlerRegistry = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class BlockchainHandlerRegistry {
    constructor() {
        this._handlers = {};
        this._loadErrors = [];
    }
    register(chainName, handler) {
        this._handlers[chainName] = handler;
        return this;
    }
    getHandler(chainName) {
        const handler = this._handlers[chainName];
        if (!handler) {
            throw new Error(`No handler registered for blockchain: ${chainName}`);
        }
        return handler;
    }
    supports(chainName) {
        return Boolean(this._handlers[chainName]);
    }
    getSupportedChains() {
        return Object.keys(this._handlers);
    }
    getLoadErrors() {
        return this._loadErrors;
    }
    loadHandlersFromDirectory(directory) {
        try {
            const files = fs
                .readdirSync(directory)
                .filter((file) => file !== 'index.ts' && file.endsWith('.ts'));
            files.forEach((file) => {
                const filePath = path.join(directory, file);
                try {
                    let handler;
                    try {
                        handler = require(filePath);
                    }
                    catch (requireError) {
                        this._loadErrors.push({ file, error: requireError });
                        return;
                    }
                    if (handler) {
                        this.register(handler.chainName, handler);
                    }
                }
                catch (error) {
                    this._loadErrors.push({ file, error });
                }
            });
        }
        catch (error) {
            this._loadErrors.push({ directory, error });
        }
    }
}
exports.BlockchainHandlerRegistry = BlockchainHandlerRegistry;
const registry = new BlockchainHandlerRegistry();
registry.loadHandlersFromDirectory(__dirname);
exports.default = registry;
