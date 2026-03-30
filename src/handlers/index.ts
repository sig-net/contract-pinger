import * as ethereum from './ethereum';
import * as solana from './solana';

export class BlockchainHandlerRegistry {
  private _handlers: Record<string, any> = {};

  register(chainName: string, handler: any) {
    this._handlers[chainName] = handler;
    return this;
  }

  getHandler(chainName: string) {
    const handler = this._handlers[chainName];
    if (!handler) {
      throw new Error(`No handler registered for blockchain: ${chainName}`);
    }
    return handler;
  }

  supports(chainName: string) {
    return Boolean(this._handlers[chainName]);
  }

  getSupportedChains() {
    return Object.keys(this._handlers);
  }
}

const registry = new BlockchainHandlerRegistry();
registry.register(ethereum.chainName, ethereum);
registry.register(solana.chainName, solana);

export default registry;
