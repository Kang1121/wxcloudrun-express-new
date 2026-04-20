const { handleDevPush } = require("./devHandler");
const { handleProdPush } = require("./prodHandler");

function resolvePushRuntime(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || "production").trim().toLowerCase();
  return nodeEnv === "development" ? "development" : "production";
}

function resolvePushHandler(runtime) {
  return runtime === "development" ? handleDevPush : handleProdPush;
}

module.exports = {
  resolvePushHandler,
  resolvePushRuntime,
};
