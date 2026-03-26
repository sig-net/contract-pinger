// Set API_SECRET before any test modules are imported.
// This runs as a Vitest setup file, before test files are loaded.
if (!process.env.API_SECRET) {
  process.env.API_SECRET = 'test-secret-key';
}
