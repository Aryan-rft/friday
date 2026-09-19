// CJS shim: vitest's bundled Vite doesn't recognize node:sqlite as a builtin
// and fails to externalize it; a .cjs require bypasses that resolver.
module.exports = require("node:sqlite");
