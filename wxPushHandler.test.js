const test = require("node:test");
const assert = require("node:assert/strict");
const { handleWxPushRequest } = require("./wxPushHandler");

async function invokeWxPush({ body = {}, env = {} } = {}, options = {}) {
  const req = { body };
  let sentBody = null;
  const res = {
    send(payload) {
      sentBody = payload;
      return this;
    },
  };
  const calls = [];
  const logs = [];
  const logger = {
    log(...args) {
      logs.push({ level: "log", args });
    },
    error(...args) {
      logs.push({ level: "error", args });
    },
  };

  await handleWxPushRequest(req, res, {
    env,
    logger,
    invokeCloudFunctionImpl: async (name, payload) => {
      calls.push({ name, payload });
      return options.invocationResult || { parsedRespData: { code: 0, message: "ok" } };
    },
  });

  return { calls, logs, sentBody };
}

test("wx push path check returns success without invoking cloud functions", async () => {
  const result = await invokeWxPush({
    body: {
      action: "CheckContainerPath",
    },
  });

  assert.equal(result.sentBody, "success");
  assert.equal(result.calls.length, 0);
});

test("wx push production route keeps current media callback behavior", async () => {
  const result = await invokeWxPush({
    env: { NODE_ENV: "production" },
    body: {
      Event: "wxa_media_check",
      trace_id: "trace_prod_001",
      result: {
        suggest: "pass",
        label: 100,
      },
    },
  });

  assert.equal(result.sentBody, "success");
  assert.deepEqual(result.calls, [
    {
      name: "post",
      payload: {
        action: "review.updateMediaResult",
        data: {
          traceId: "trace_prod_001",
          result: {
            suggest: "pass",
            label: 100,
          },
        },
      },
    },
    {
      name: "auth",
      payload: {
        action: "reviewProfile.updateMediaResult",
        data: {
          traceId: "trace_prod_001",
          result: {
            suggest: "pass",
            label: 100,
          },
        },
      },
    },
  ]);
});

test("wx push development route stays compatible with production behavior", async () => {
  const result = await invokeWxPush({
    env: { NODE_ENV: "development" },
    body: {
      Event: "wxa_media_check",
      trace_id: "trace_dev_001",
      result: {
        suggest: "review",
        label: 21000,
      },
    },
  });

  assert.equal(result.sentBody, "success");
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].name, "post");
  assert.equal(result.calls[1].name, "auth");
  assert.ok(
    result.logs.some(
      (entry) =>
        entry.level === "log" &&
        entry.args.some((value) => typeof value === "string" && value.includes("development handler"))
    )
  );
});

test("wx push ignores unrelated events and still returns success", async () => {
  const result = await invokeWxPush({
    env: { NODE_ENV: "production" },
    body: {
      Event: "debug_demo",
    },
  });

  assert.equal(result.sentBody, "success");
  assert.equal(result.calls.length, 0);
});
