const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const https = require("https");
const { init: initDB, Counter } = require("./db");
const { handleBridgeRequest } = require("./bridge");

const logger = morgan("tiny");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());
app.use(logger);

let accessTokenCache = {
  token: "",
  expiresAt: 0,
};

function normalizeEnvId(value) {
  return String(value || "").trim();
}

function getDefaultEnvId() {
  return normalizeEnvId(
    process.env.WX_CLOUD_ENV ||
    process.env.TCB_ENV ||
    process.env.CLOUD_ENV ||
    ""
  );
}

function getWxpushTargetEnvIds() {
  const rawList = [
    ...String(process.env.WX_CLOUD_ENV_TARGETS || "")
      .split(",")
      .map((item) => normalizeEnvId(item)),
    normalizeEnvId(process.env.WX_CLOUD_ENV_DEV),
    normalizeEnvId(process.env.WX_CLOUD_ENV_PROD),
    normalizeEnvId(process.env.WX_CLOUD_ENV_CLOUD),
    getDefaultEnvId(),
  ].filter(Boolean);

  return Array.from(new Set(rawList));
}

function shouldInvokeLegacyPostMediaCallback() {
  const raw = String(process.env.WXPUSH_LEGACY_POST_MEDIA_CALLBACK || "true")
    .trim()
    .toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

function getAppConfig() {
  const appid = process.env.WX_APPID || process.env.WECHAT_APPID || "";
  const secret = process.env.WX_APPSECRET || process.env.WECHAT_APPSECRET || "";
  return { appid, secret };
}

function shouldUseStableAccessToken() {
  const raw = String(process.env.WX_USE_STABLE_ACCESS_TOKEN || "true")
    .trim()
    .toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

function isInvalidCredentialResponse(data) {
  const errcode = Number(data?.errcode || data?.errCode || 0);
  const errmsg = String(data?.errmsg || data?.errMsg || "").toLowerCase();
  return errcode === 40001
    || errcode === 40014
    || errcode === 42001
    || errmsg.includes("invalid credential")
    || errmsg.includes("access_token is invalid")
    || errmsg.includes("not latest");
}

function requestJson(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          const data = raw ? JSON.parse(raw) : {};
          resolve({ statusCode: res.statusCode, data });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchLegacyAccessToken(appid, secret) {
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;
  const { data } = await requestJson(url, { method: "GET" });
  return data || {};
}

async function fetchStableAccessToken(appid, secret, forceRefresh) {
  const body = JSON.stringify({
    grant_type: "client_credential",
    appid,
    secret,
    force_refresh: !!forceRefresh,
  });
  const { data } = await requestJson(
    "https://api.weixin.qq.com/cgi-bin/stable_token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );
  return data || {};
}

async function getAccessToken(options = {}) {
  if (process.env.WX_ACCESS_TOKEN && !options.forceRefresh) return process.env.WX_ACCESS_TOKEN;
  if (!options.forceRefresh && accessTokenCache.token && accessTokenCache.expiresAt > Date.now()) {
    return accessTokenCache.token;
  }

  const { appid, secret } = getAppConfig();
  if (!appid || !secret) {
    throw new Error("缺少 WX_APPID/WX_APPSECRET，无法获取 access_token");
  }

  const data = shouldUseStableAccessToken()
    ? await fetchStableAccessToken(appid, secret, !!options.forceRefresh)
    : await fetchLegacyAccessToken(appid, secret);
  if (!data || !data.access_token) {
    throw new Error(`获取 access_token 失败: ${data?.errmsg || "unknown"}`);
  }

  const expiresIn = Number(data.expires_in || 7200);
  accessTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
  };
  return accessTokenCache.token;
}

async function invokeCloudFunctionWithAccessToken(name, payload, envId, accessToken) {
  const url =
    `https://api.weixin.qq.com/tcb/invokecloudfunction` +
    `?access_token=${accessToken}&env=${envId}&name=${name}`;
  const body = JSON.stringify(payload || {});
  return requestJson(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );
}

async function invokeCloudFunction(name, payload, targetEnvId) {
  const envId = normalizeEnvId(targetEnvId) || getDefaultEnvId();
  if (!envId) {
    throw new Error("缺少云环境 ID：请设置 WX_CLOUD_ENV 或 TCB_ENV");
  }
  const accessToken = await getAccessToken();
  let { data } = await invokeCloudFunctionWithAccessToken(name, payload, envId, accessToken);
  if (isInvalidCredentialResponse(data) && !process.env.WX_ACCESS_TOKEN) {
    console.warn("[wxpush] access_token invalid, refresh and retry invokecloudfunction:", {
      envId,
      functionName: name,
      errcode: data?.errcode,
      errmsg: data?.errmsg,
    });
    accessTokenCache = { token: "", expiresAt: 0 };
    const refreshedToken = await getAccessToken({ forceRefresh: true });
    const retryResult = await invokeCloudFunctionWithAccessToken(name, payload, envId, refreshedToken);
    data = retryResult.data;
  }
  if (data?.errcode && data.errcode !== 0) {
    throw new Error(`调用云函数失败: ${data.errmsg || data.errcode}`);
  }
  let parsedRespData = null;
  if (typeof data?.resp_data === "string" && data.resp_data.trim()) {
    try {
      parsedRespData = JSON.parse(data.resp_data);
    } catch (err) {
      parsedRespData = { _parseError: err?.message || "PARSE_ERROR", raw: data.resp_data };
    }
  }
  return {
    ...data,
    parsedRespData,
  };
}

async function invokeWxpushCloudFunctions(payload) {
  const envIds = getWxpushTargetEnvIds();
  if (envIds.length === 0) {
    throw new Error("缺少消息推送目标环境 ID：请设置 WX_CLOUD_ENV_TARGETS 或 WX_CLOUD_ENV_DEV/WX_CLOUD_ENV_PROD");
  }

  const taskSpecs = envIds.flatMap((envId) => {
    const specs = [
      {
        envId,
        functionName: "sec-callback",
        payload: {
          body: JSON.stringify({
            Event: "wxa_media_check",
            trace_id: payload.traceId || payload.trace_id || "",
            traceId: payload.traceId || payload.trace_id || "",
            result: payload.result || {},
            isRisky: payload.isRisky,
          }),
          isBase64Encoded: false,
          queryStringParameters: {},
        },
      },
      {
        envId,
        functionName: "auth",
        payload: {
          action: "reviewProfile.updateMediaResult",
          data: payload,
        },
      },
    ];

    if (shouldInvokeLegacyPostMediaCallback()) {
      specs.push({
        envId,
        functionName: "post",
        payload: {
          action: "review.updateMediaResult",
          data: payload,
        },
      });
    }

    return specs;
  });

  const settled = await Promise.allSettled(taskSpecs.map((spec) => (
    invokeCloudFunction(spec.functionName, spec.payload, spec.envId)
  )));

  const results = settled.map((item, index) => {
    const spec = taskSpecs[index];
    if (item.status === "fulfilled") {
      return {
        ok: true,
        envId: spec.envId,
        functionName: spec.functionName,
        result: item.value?.parsedRespData || item.value,
      };
    }
    return {
      ok: false,
      envId: spec.envId,
      functionName: spec.functionName,
      error: item.reason?.message || String(item.reason || "UNKNOWN_ERROR"),
    };
  });

  return {
    envIds,
    results,
    hasFailure: results.some((item) => !item.ok),
  };
}

/**
 * ===============================
 * 首页
 * ===============================
 */
app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/**
 * ===============================
 * iOS BFF 上游 Bridge
 * ===============================
 */
app.post("/functions/:functionName", async (req, res) => {
  await handleBridgeRequest(req, res, {
    invokeCloudFunctionImpl: invokeCloudFunction,
    env: process.env,
  });
});

/**
 * ===============================
 * 示例业务接口（原有）
 * ===============================
 */

// 更新计数
app.post("/api/count", async (req, res) => {
  const { action } = req.body;
  if (action === "inc") {
    await Counter.create();
  } else if (action === "clear") {
    await Counter.destroy({ truncate: true });
  }
  res.send({
    code: 0,
    data: await Counter.count(),
  });
});

// 获取计数
app.get("/api/count", async (req, res) => {
  const result = await Counter.count();
  res.send({
    code: 0,
    data: result,
  });
});

// 小程序调用，获取微信 OpenID
app.get("/api/wx_openid", async (req, res) => {
  if (req.headers["x-wx-source"]) {
    res.send(req.headers["x-wx-openid"]);
  }
});

/**
 * ===============================
 * ✅ 微信云托管消息推送接收
 * Path: /wxpush
 * ===============================
 */
app.post("/wxpush", async (req, res) => {
  const body = req.body;

  // 1️⃣ 云托管配置时的 Path 校验请求
  if (body?.action === "CheckContainerPath") {
    console.log("[wxpush] path check ok");
    return res.send("success");
  }

  // 2️⃣ 内容安全异步回调（图片审核）
  if (body?.Event === "wxa_media_check") {
    const { trace_id, result } = body;

    console.log("[wxpush] media check result:", {
      trace_id,
      suggest: result?.suggest,
      label: result?.label,
    });

    try {
      const fanout = await invokeWxpushCloudFunctions({
        traceId: trace_id,
        result,
        isRisky: body?.isRisky,
      });
      console.log("[wxpush] invoke results:", fanout.results);
      if (fanout.hasFailure) {
        console.warn("[wxpush] partial failure:", fanout.results.filter((item) => !item.ok));
      }
    } catch (err) {
      console.error("[wxpush] handle error:", err);
    }

    return res.send("success");
  }

  // 3️⃣ 兜底返回
  res.send("success");
});

const port = process.env.PORT || 80;

async function bootstrap() {
  await initDB();
  app.listen(port, () => {
    console.log("启动成功", port);
  });
}

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error("启动失败", error);
    process.exit(1);
  });
}

module.exports = {
  app,
  bootstrap,
  getAccessToken,
  invokeCloudFunction,
  invokeWxpushCloudFunctions,
  requestJson,
};
