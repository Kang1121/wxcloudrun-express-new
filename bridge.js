const STANDALONE_FUNCTIONS = new Set(["sendCode", "verifyCode"]);

function envelope(code, message, data, error) {
  const payload = { code, message };
  if (data !== undefined) payload.data = data;
  if (error !== undefined) payload.error = error;
  return payload;
}

function extractBearerToken(headers = {}) {
  return String(headers.authorization || headers.Authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function requireBridgeAuthorization(headers, env = process.env) {
  const expected = String(env.WECHAT_GATEWAY_TOKEN || "").trim();
  if (!expected) return null;
  const actual = extractBearerToken(headers);
  if (actual === expected) return null;
  return envelope(401, "Bridge token invalid", undefined, "UNAUTHORIZED");
}

function isStandaloneFunction(functionName) {
  return STANDALONE_FUNCTIONS.has(String(functionName || "").trim());
}

function createBridgeError(statusCode, message, errorCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

function buildBridgePayload(functionName, body = {}) {
  const payload = body && typeof body === "object" ? body : {};
  if (isStandaloneFunction(functionName)) {
    return payload;
  }
  const action = String(payload.action || "").trim();
  if (!action) {
    throw createBridgeError(400, "Missing action for action-based cloud function", "INVALID_BRIDGE_REQUEST");
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  return { action, data };
}

function unwrapInvocationResult(invocation) {
  const candidates = [];
  if (invocation && typeof invocation === "object") {
    if (invocation.parsedRespData) candidates.push(invocation.parsedRespData);
    if (invocation.result) candidates.push(invocation.result);
    candidates.push(invocation);
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate._parseError) {
      return envelope(502, "Cloud function returned invalid JSON", undefined, "INVALID_UPSTREAM_JSON");
    }
    if (typeof candidate.code === "number") {
      return candidate;
    }
    if (candidate.result && typeof candidate.result.code === "number") {
      return candidate.result;
    }
  }

  return envelope(502, "Cloud function returned unknown payload", undefined, "UNKNOWN_UPSTREAM_PAYLOAD");
}

async function handleBridgeRequest(req, res, { invokeCloudFunctionImpl, env = process.env } = {}) {
  const authError = requireBridgeAuthorization(req.headers, env);
  if (authError) {
    return res.status(401).json(authError);
  }

  const functionName = String(req.params?.functionName || "").trim();
  if (!functionName) {
    return res.status(400).json(envelope(400, "Missing function name", undefined, "PARAM_ERROR"));
  }

  let payload;
  try {
    payload = buildBridgePayload(functionName, req.body || {});
  } catch (error) {
    return res.status(error.statusCode || 400).json(
      envelope(error.statusCode || 400, error.message || "Invalid bridge payload", undefined, error.errorCode || "INVALID_BRIDGE_REQUEST")
    );
  }

  try {
    const invocation = await invokeCloudFunctionImpl(functionName, payload);
    const response = unwrapInvocationResult(invocation);
    return res.status(200).json(response);
  } catch (error) {
    return res.status(502).json(
      envelope(502, error?.message || "Invoke cloud function failed", undefined, "UPSTREAM_INVOCATION_FAILED")
    );
  }
}

module.exports = {
  buildBridgePayload,
  envelope,
  extractBearerToken,
  handleBridgeRequest,
  isStandaloneFunction,
  requireBridgeAuthorization,
  unwrapInvocationResult,
};
