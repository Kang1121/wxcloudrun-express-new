const test = require("node:test");
const assert = require("node:assert/strict");
const { handleBridgeRequest } = require("./bridge");

async function invokeBridge({ functionName, headers = {}, body = {} }, options = {}) {
  const req = {
    params: { functionName },
    headers,
    body,
  };
  let statusCode = 200;
  let responseBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      responseBody = payload;
      return this;
    },
  };

  await handleBridgeRequest(req, res, options);
  return {
    statusCode,
    json: responseBody,
  };
}

test("bridge forwards action payload and unwraps cloud function envelope", async () => {
  let captured = null;
  const payload = await invokeBridge(
    {
      functionName: "auth",
      body: {
        action: "auth.login",
        data: { userId: "user_001", password: "secret" },
      },
    },
    {
      env: {},
      invokeCloudFunctionImpl: async (name, requestBody) => {
        captured = { name, requestBody };
        return {
          parsedRespData: {
            code: 0,
            message: "登录成功",
            data: { userId: "user_001" },
          },
        };
      },
    }
  );

  assert.equal(payload.statusCode, 200);
  assert.equal(payload.json.code, 0);
  assert.deepEqual(captured, {
    name: "auth",
    requestBody: {
      action: "auth.login",
      data: { userId: "user_001", password: "secret" },
    },
  });
});

test("bridge passes standalone cloud function body without action wrapper", async () => {
  let captured = null;
  const payload = await invokeBridge(
    {
      functionName: "sendCode",
      body: {
        nationcode: "82",
        mobile: "1012345678",
      },
    },
    {
      env: {},
      invokeCloudFunctionImpl: async (name, requestBody) => {
        captured = { name, requestBody };
        return {
          parsedRespData: {
            code: 0,
            message: "验证码已发送",
            data: { cooldown: 60 },
          },
        };
      },
    }
  );

  assert.equal(payload.statusCode, 200);
  assert.equal(payload.json.data.cooldown, 60);
  assert.deepEqual(captured, {
    name: "sendCode",
    requestBody: {
      nationcode: "82",
      mobile: "1012345678",
    },
  });
});

test("bridge enforces bearer token when WECHAT_GATEWAY_TOKEN is configured", async () => {
  const payload = await invokeBridge(
    {
      functionName: "post",
      headers: { authorization: "Bearer wrong-token" },
      body: {
        action: "post.detail",
        data: { postId: "post_001" },
      },
    },
    {
      env: { WECHAT_GATEWAY_TOKEN: "expected-token" },
      invokeCloudFunctionImpl: async () => ({ parsedRespData: { code: 0, message: "ok", data: {} } }),
    }
  );

  assert.equal(payload.statusCode, 401);
  assert.equal(payload.json.error, "UNAUTHORIZED");
});

test("bridge rejects action-based requests with missing action", async () => {
  const payload = await invokeBridge(
    {
      functionName: "post",
      body: { data: { postId: "post_001" } },
    },
    {
      env: {},
      invokeCloudFunctionImpl: async () => ({ parsedRespData: { code: 0, message: "ok", data: {} } }),
    }
  );

  assert.equal(payload.statusCode, 400);
  assert.equal(payload.json.error, "INVALID_BRIDGE_REQUEST");
});

test("bridge maps invalid upstream JSON into BFF-safe envelope", async () => {
  const payload = await invokeBridge(
    {
      functionName: "comment",
      body: {
        action: "comment.create",
        data: { postId: "post_001", content: "我也来" },
      },
    },
    {
      env: {},
      invokeCloudFunctionImpl: async () => ({
        parsedRespData: {
          _parseError: "PARSE_ERROR",
          raw: "not-json",
        },
      }),
    }
  );

  assert.equal(payload.statusCode, 200);
  assert.equal(payload.json.code, 502);
  assert.equal(payload.json.error, "INVALID_UPSTREAM_JSON");
});
