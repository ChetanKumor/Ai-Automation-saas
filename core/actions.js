const registry = new Map();

function register(name, handler) {
  registry.set(name, handler);
}

async function execute(name, params, ctx) {
  const handler = registry.get(name);
  if (!handler) {
    console.warn(`[Actions] Unknown action "${name}" — skipped`);
    return { skipped: true };
  }
  return handler(params, ctx);
}

module.exports = { register, execute };
