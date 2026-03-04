const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const https = require("https");
const { init: initDB, Counter } = require("./db");

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

function getEnvId() {
  return (
    process.env.WX_CLOUD_ENV ||
    process.env.TCB_ENV ||
    process.env.CLOUD_ENV ||
    ""
  );
}

function getAppConfig() {
  const appid = process.env.WX_APPID || process.env.WECHAT_APPID || "";
  const secret = process.env.WX_APPSECRET || process.env.WECHAT_APPSECRET || "";
  return { appid, secret };
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

async function getAccessToken() {
  if (process.env.WX_ACCESS_TOKEN) return process.env.WX_ACCESS_TOKEN;
  if (accessTokenCache.token && accessTokenCache.expiresAt > Date.now()) {
    return accessTokenCache.token;
  }

  const { appid, secret } = getAppConfig();
  if (!appid || !secret) {
    throw new Error("缺少 WX_APPID/WX_APPSECRET，无法获取 access_token");
  }

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;
  const { data } = await requestJson(url, { method: "GET" });
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

async function invokeCloudFunction(name, payload) {
  const envId = getEnvId();
  if (!envId) {
    throw new Error("缺少云环境 ID：请设置 WX_CLOUD_ENV 或 TCB_ENV");
  }
  const accessToken = await getAccessToken();
  const url =
    `https://api.weixin.qq.com/tcb/invokecloudfunction` +
    `?access_token=${accessToken}&env=${envId}&name=${name}`;
  const body = JSON.stringify(payload || {});
  const { data } = await requestJson(
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
      const invokeRes = await invokeCloudFunction("post", {
        action: "review.updateMediaResult",
        data: {
          traceId: trace_id,
          result,
        },
      });
      console.log("[wxpush] invoke post result:", invokeRes?.parsedRespData || invokeRes);
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

bootstrap();
