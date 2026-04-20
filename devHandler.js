const { handleProdPush } = require("./prodHandler");

async function handleDevPush(context = {}) {
  const logger = context.logger || console;
  logger.log("[wxpush] route to development handler");
  return handleProdPush({
    ...context,
    runtime: "development",
  });
}

module.exports = {
  handleDevPush,
};
