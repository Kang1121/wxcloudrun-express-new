const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { init: initDB, Counter } = require("./db");

const logger = morgan("tiny");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());
app.use(logger);

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
 * 推送模式：JSON
 * ===============================
 */
app.post("/wxpush", async (req, res) => {
  const body = req.body;

  // 1️⃣ 云托管配置时的 Path 校验请求
  if (body?.action === "CheckContainerPath") {
    console.log("[wxpush] path check ok");
    return res.send("success");
  }

  // 2️⃣ 内容安全异步回调（黄图识别）
  if (body?.Event === "wxa_media_check") {
    const { trace_id, result } = body;

    console.log("[wxpush] media check result:", {
      trace_id,
      suggest: result?.suggest,
      label: result?.label,
      details: result?.detail,
    });

    /**
     * TODO（你下一步要做的事）：
     *
     * 1. 用 trace_id 查你云数据库里的图片 / 帖子
     * 2. 根据 result.suggest 更新状态
     *
     * suggest:
     *  - pass    -> 放行
     *  - review  -> 人工审核
     *  - risky   -> 拒绝 / 下架（label=20002 色情）
     *
     * 这里我先不直接写数据库逻辑，避免和你现有表结构冲突
     */
  }

  // 3️⃣ 所有推送都必须返回 success
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