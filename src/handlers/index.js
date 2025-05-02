const fs = require("fs");
const path = require("path");

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
        .filter((file) => file !== "index.js" && file.endsWith(".js"));

      files.forEach((file) => {
        const filePath = path.join(directory, file);
        try {
          let handler;

          try {
            handler = require(filePath);
          } catch (requireError) {
            this._loadErrors.push({
              file,
              error: `Failed to load handler file: ${requireError.message}`,
              stack: requireError.stack,
            });
            return;
          }

          if (!handler || typeof handler !== "object") {
            this._loadErrors.push({
              file,
              error: "Handler file does not export an object",
            });
            return;
          }

          if (!handler.chainName) {
            this._loadErrors.push({
              file,
              error: "Handler is missing chainName property",
            });
            return;
          }

          if (!handler.execute || typeof handler.execute !== "function") {
            this._loadErrors.push({
              file,
              error: "Handler is missing execute method",
            });
            return;
          }

          this.register(handler.chainName, handler);
        } catch (e) {
          this._loadErrors.push({
            file,
            error: `Unexpected error processing handler: ${e.message}`,
            stack: e.stack,
          });
        }
      });
    } catch (dirError) {
      this._loadErrors.push({
        error: `Failed to read handlers directory: ${dirError.message}`,
        stack: dirError.stack,
      });
    }
  }
}

const registry = new BlockchainHandlerRegistry();
registry.loadHandlersFromDirectory(__dirname);

module.exports = registry;
