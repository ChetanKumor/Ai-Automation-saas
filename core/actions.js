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
  try {
    return await handler(params, ctx);
  } catch (err) {
    console.error(`[Actions] Action "${name}" threw:`, err.message);
    return { error: err.message };
  }
}

module.exports = { register, execute };
