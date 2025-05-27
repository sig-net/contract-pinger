import * as fs from 'fs';
import * as path from 'path';

export class BlockchainHandlerRegistry {
  private _handlers: Record<string, any> = {};
  private _loadErrors: any[] = [];

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

  getLoadErrors() {
    return this._loadErrors;
  }

  loadHandlersFromDirectory(directory: string) {
    try {
      const files = fs
        .readdirSync(directory)
        .filter(file => file !== 'index.ts' && file.endsWith('.ts'));

      files.forEach(file => {
        const filePath = path.join(directory, file);
        try {
          let handler;
          try {
            handler = require(filePath);
          } catch (requireError) {
            this._loadErrors.push({ file, error: requireError });
            return;
          }
          if (handler) {
            this.register(handler.chainName, handler);
          }
        } catch (error) {
          this._loadErrors.push({ file, error });
        }
      });
    } catch (error) {
      this._loadErrors.push({ directory, error });
    }
  }
}

const registry = new BlockchainHandlerRegistry();
registry.loadHandlersFromDirectory(__dirname);

export default registry;
