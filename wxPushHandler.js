const { resolvePushHandler, resolvePushRuntime } = require("./envRouter");

async function handleWxPushRequest(req, res, { invokeCloudFunctionImpl, env = process.env, logger = console } = {}) {
  const body = req?.body && typeof req.body === "object" ? req.body : {};

  if (body?.action === "CheckContainerPath") {
    logger.log("[wxpush] path check ok");
    return res.send("success");
  }

  const runtime = resolvePushRuntime(env);
  const pushHandler = resolvePushHandler(runtime);

  try {
    await pushHandler({
      body,
      env,
      invokeCloudFunctionImpl,
      logger,
      runtime,
    });
  } catch (error) {
    logger.error("[wxpush] handle error:", error);
  }

  return res.send("success");
}

module.exports = {
  handleWxPushRequest,
};
