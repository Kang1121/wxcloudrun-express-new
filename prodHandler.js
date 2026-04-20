async function handleProdPush({ body = {}, invokeCloudFunctionImpl, logger = console, runtime = "production" } = {}) {
  if (body?.Event !== "wxa_media_check") return;

  const { trace_id, result } = body;
  logger.log("[wxpush] media check result:", {
    runtime,
    trace_id,
    suggest: result?.suggest,
    label: result?.label,
  });

  const postResult = await invokeCloudFunctionImpl("post", {
    action: "review.updateMediaResult",
    data: {
      traceId: trace_id,
      result,
    },
  });
  logger.log("[wxpush] invoke post result:", postResult?.parsedRespData || postResult);

  const authResult = await invokeCloudFunctionImpl("auth", {
    action: "reviewProfile.updateMediaResult",
    data: {
      traceId: trace_id,
      result,
    },
  });
  logger.log("[wxpush] invoke auth result:", authResult?.parsedRespData || authResult);
}

module.exports = {
  handleProdPush,
};
