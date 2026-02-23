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
    const suggest = result?.suggest;
    const label = result?.label;

    console.log("[wxpush] media check result:", {
      trace_id,
      suggest,
      label,
    });

    try {
      const db = require("wx-server-sdk").database();

      // ① 找到对应 review（一张图只会命中一个）
      const reviewRes = await db
        .collection("reviews_content")
        .where({
          mediaTraceIds: trace_id,
          status: "pending",
        })
        .limit(1)
        .get();

      if (!reviewRes.data.length) {
        console.warn("[wxpush] review not found for trace_id:", trace_id);
        return res.send("success");
      }

      const review = reviewRes.data[0];

      // ② 记录单张图片的审核结果（按 trace_id 存）
      const mediaResults = review.mediaResults || {};
      mediaResults[trace_id] = {
        suggest,
        label,
        raw: result,
      };

      // ③ 是否存在不通过的图片
      const hasReject = Object.values(mediaResults).some(
        (r) => r.suggest !== "pass"
      );

      // ④ 是否所有图片都已回调
      const allReturned =
        Object.keys(mediaResults).length === review.mediaTraceIds.length;

      let nextStatus = "pending";

      if (hasReject) {
        nextStatus = "reject";
      } else if (allReturned) {
        nextStatus = "pass";
      }

      // ⑤ 更新 review 状态
      await db.collection("reviews_content").doc(review._id).update({
        data: {
          status: nextStatus,
          mediaResults,
          updatedAt: new Date(),
        },
      });

      console.log("[wxpush] review updated:", {
        reviewId: review._id,
        status: nextStatus,
        returned: Object.keys(mediaResults).length,
        total: review.mediaTraceIds.length,
      });

      // ⑥ 所有图片通过 → 正式发布
      if (nextStatus === "pass") {
        await publishPostFromReview(db, review);
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

bootstrap();