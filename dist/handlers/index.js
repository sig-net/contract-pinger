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
const ethereum = __importStar(require("./ethereum"));
const solana = __importStar(require("./solana"));
class BlockchainHandlerRegistry {
    _handlers = {};
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
}
exports.BlockchainHandlerRegistry = BlockchainHandlerRegistry;
const registry = new BlockchainHandlerRegistry();
registry.register(ethereum.chainName, ethereum);
registry.register(solana.chainName, solana);
exports.default = registry;
