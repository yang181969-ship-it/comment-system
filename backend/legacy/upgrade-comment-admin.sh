#!/usr/bin/env bash
set -euo pipefail

echo "WARNING: This is a legacy one-time migration script." >&2
echo "It is not a current production deployment entry point and will overwrite current code." >&2

if [ "${ALLOW_LEGACY_UPGRADE:-}" != "1" ]; then
  echo "Refusing to run legacy upgrade script." >&2
  exit 1
fi

cd /home/ubuntu/comment-system

echo "==> 1. 创建备份目录"
mkdir -p backups

NOW="$(date +%F-%H%M%S)"

echo "==> 2. 备份数据库与后端文件"
cp server.js "backups/server-${NOW}.js"
cp data/comments.db "backups/comments-${NOW}.db"
if [ -f .env ]; then
  cp .env "backups/env-${NOW}.bak"
fi

echo "==> 3. 准备 .env 管理员配置"
touch .env

if grep -q '^ADMIN_TOKEN=' .env; then
  ADMIN_TOKEN_VALUE="$(grep '^ADMIN_TOKEN=' .env | head -n 1 | cut -d '=' -f2-)"
else
  ADMIN_TOKEN_VALUE="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  {
    echo ""
    echo "ADMIN_TOKEN=${ADMIN_TOKEN_VALUE}"
  } >> .env
fi

if ! grep -q '^ADMIN_NAME=' .env; then
  echo "ADMIN_NAME=站长" >> .env
fi

echo "==> 4. 替换 server.js"

cat > server.js <<'SERVER_EOF'
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 3001;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ADMIN_NAME = process.env.ADMIN_NAME || "站长";

// ==============================
// 基础目录与数据库
// ==============================

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "comments.db");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// ==============================
// 数据库初始化与迁移
// ==============================

db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    email_hash TEXT,
    website TEXT,
    content TEXT NOT NULL,
    rating REAL,
    user_agent TEXT,
    ip TEXT,
    status TEXT NOT NULL DEFAULT 'visible',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function getColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
}

function addColumnIfMissing(tableName, columnName, definition) {
  const columns = getColumns(tableName);
  if (!columns.includes(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
  }
}

addColumnIfMissing("comments", "parent_id", "INTEGER");
addColumnIfMissing("comments", "reply_to_id", "INTEGER");
addColumnIfMissing("comments", "reply_to_name", "TEXT");
addColumnIfMissing("comments", "is_admin", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("comments", "role", "TEXT NOT NULL DEFAULT 'guest'");

db.exec(`
  UPDATE comments
  SET status = 'visible'
  WHERE status = 'approved';

  UPDATE comments
  SET role = 'admin'
  WHERE is_admin = 1;

  UPDATE comments
  SET role = 'guest'
  WHERE is_admin = 0 OR is_admin IS NULL;

  CREATE INDEX IF NOT EXISTS idx_comments_status_created
  ON comments(status, created_at);

  CREATE INDEX IF NOT EXISTS idx_comments_parent
  ON comments(parent_id);

  CREATE INDEX IF NOT EXISTS idx_comments_reply_to
  ON comments(reply_to_id);
`);

// ==============================
// 中间件
// ==============================

app.use(helmet());

app.use(cors({
  origin: [
    "https://yang181969.com",
    "https://www.yang181969.com",
    "https://yang181969-ship-it.github.io",
    "https://yang181969-ship-it.github.io/yang283643",
    "http://localhost:3000",
    "http://localhost:5000",
    "http://localhost:5500",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5000",
    "http://127.0.0.1:5500"
  ],
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({
  limit: "40kb"
}));

const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    message: "提交过于频繁，请稍后再试。"
  }
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    message: "管理员操作过于频繁，请稍后再试。"
  }
});

// ==============================
// 工具函数
// ==============================

function normalizeString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function hashEmail(email) {
  const cleanEmail = normalizeString(email).toLowerCase();

  if (!cleanEmail) return null;

  return crypto
    .createHash("sha256")
    .update(cleanEmail)
    .digest("hex");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.remoteAddress || "";
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return "";
  }

  return header.slice("Bearer ".length).trim();
}

function safeEqual(a, b) {
  const valueA = String(a || "");
  const valueB = String(b || "");

  if (!valueA || !valueB) return false;

  const bufferA = Buffer.from(valueA);
  const bufferB = Buffer.from(valueB);

  if (bufferA.length !== bufferB.length) return false;

  return crypto.timingSafeEqual(bufferA, bufferB);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({
      ok: false,
      message: "服务器未配置 ADMIN_TOKEN。"
    });
  }

  const token = getBearerToken(req);

  if (!safeEqual(token, ADMIN_TOKEN)) {
    return res.status(401).json({
      ok: false,
      message: "管理员身份验证失败。"
    });
  }

  next();
}

function validateCommentPayload(body) {
  const nickname = normalizeString(body.nickname) || "访客";
  const email = normalizeString(body.email);
  const website = normalizeString(body.website);
  const content = normalizeString(body.content);
  const rating = body.rating;

  if (nickname.length > 24) {
    return {
      ok: false,
      message: "昵称不能超过 24 个字符。"
    };
  }

  if (website.length > 200) {
    return {
      ok: false,
      message: "网站地址不能超过 200 个字符。"
    };
  }

  if (!content) {
    return {
      ok: false,
      message: "留言内容不能为空。"
    };
  }

  if (content.length > 1000) {
    return {
      ok: false,
      message: "留言内容不能超过 1000 个字符。"
    };
  }

  let finalRating = null;

  if (rating !== undefined && rating !== null && rating !== "") {
    const numberRating = Number(rating);

    if (
      Number.isNaN(numberRating) ||
      numberRating < 0 ||
      numberRating > 5 ||
      numberRating * 2 % 1 !== 0
    ) {
      return {
        ok: false,
        message: "评分必须是 0 到 5 之间的数字，且最小单位为 0.5。"
      };
    }

    finalRating = numberRating;
  }

  return {
    ok: true,
    data: {
      nickname,
      email,
      website,
      content,
      rating: finalRating
    }
  };
}

function validateReplyPayload(body) {
  const content = normalizeString(body.content);

  if (!content) {
    return {
      ok: false,
      message: "回复内容不能为空。"
    };
  }

  if (content.length > 1000) {
    return {
      ok: false,
      message: "回复内容不能超过 1000 个字符。"
    };
  }

  return {
    ok: true,
    data: {
      content
    }
  };
}

function serializeComment(row) {
  return {
    id: row.id,
    parent_id: row.parent_id,
    reply_to_id: row.reply_to_id,
    reply_to_name: row.reply_to_name,
    nickname: row.nickname,
    website: row.website,
    content: row.content,
    rating: row.rating,
    status: row.status,
    is_admin: Boolean(row.is_admin),
    role: row.role || (row.is_admin ? "admin" : "guest"),
    created_at: row.created_at,
    updated_at: row.updated_at,
    replies: []
  };
}

function buildPublicCommentTree(rows) {
  const map = new Map();
  const roots = [];

  rows.forEach((row) => {
    map.set(row.id, serializeComment(row));
  });

  rows.forEach((row) => {
    const item = map.get(row.id);

    if (row.parent_id && map.has(row.parent_id)) {
      const parent = map.get(row.parent_id);
      parent.replies.push(item);
    } else {
      roots.push(item);
    }
  });

  roots.sort((a, b) => {
    if (a.created_at === b.created_at) return b.id - a.id;
    return a.created_at < b.created_at ? 1 : -1;
  });

  roots.forEach((root) => {
    root.replies.sort((a, b) => {
      if (a.created_at === b.created_at) return a.id - b.id;
      return a.created_at > b.created_at ? 1 : -1;
    });
  });

  return roots;
}

function getTopParentId(targetComment) {
  if (!targetComment) return null;

  if (!targetComment.parent_id) {
    return targetComment.id;
  }

  return targetComment.parent_id;
}

// ==============================
// 路由
// ==============================

app.get("/", (req, res) => {
  res.send("Comment system backend is running.");
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "comment api is running",
    time: new Date().toISOString()
  });
});

// 公开留言列表：只返回 visible，并按一级留言 + 一级回复结构输出
app.get("/api/comments", (req, res) => {
  const page = Math.max(parseInt(req.query.page || "1", 10), 1);
  const pageSize = Math.min(
    Math.max(parseInt(req.query.pageSize || "20", 10), 1),
    50
  );

  const offset = (page - 1) * pageSize;

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM comments
    WHERE status = 'visible'
      AND parent_id IS NULL
  `).get();

  const rootRows = db.prepare(`
    SELECT *
    FROM comments
    WHERE status = 'visible'
      AND parent_id IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, offset);

  const rootIds = rootRows.map((row) => row.id);

  let allRows = rootRows;

  if (rootIds.length > 0) {
    const placeholders = rootIds.map(() => "?").join(",");

    const replyRows = db.prepare(`
      SELECT *
      FROM comments
      WHERE status = 'visible'
        AND parent_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `).all(...rootIds);

    allRows = [...rootRows, ...replyRows];
  }

  const comments = buildPublicCommentTree(allRows);

  res.json({
    ok: true,
    data: {
      comments,
      pagination: {
        page,
        pageSize,
        total: totalRow.total,
        totalPages: Math.ceil(totalRow.total / pageSize)
      }
    }
  });
});

// 普通访客提交留言：强制 guest，避免前端伪造管理员身份
app.post("/api/comments", submitLimiter, (req, res) => {
  const result = validateCommentPayload(req.body);

  if (!result.ok) {
    return res.status(400).json({
      ok: false,
      message: result.message
    });
  }

  const { nickname, email, website, content, rating } = result.data;

  const stmt = db.prepare(`
    INSERT INTO comments (
      nickname,
      email_hash,
      website,
      content,
      rating,
      user_agent,
      ip,
      status,
      parent_id,
      reply_to_id,
      reply_to_name,
      is_admin,
      role
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    nickname,
    hashEmail(email),
    website || null,
    content,
    rating,
    req.headers["user-agent"] || "",
    getClientIp(req),
    "visible",
    null,
    null,
    null,
    0,
    "guest"
  );

  const newComment = db.prepare(`
    SELECT *
    FROM comments
    WHERE id = ?
  `).get(info.lastInsertRowid);

  res.status(201).json({
    ok: true,
    message: "留言提交成功。",
    data: {
      comment: serializeComment(newComment)
    }
  });
});

// 管理员登录：只校验 token，不签发长期凭证；前端 sessionStorage 保存 token
app.post("/api/admin/login", adminLimiter, (req, res) => {
  const token =
    normalizeString(req.body.token) ||
    normalizeString(req.body.adminToken) ||
    normalizeString(req.body.password);

  if (!ADMIN_TOKEN) {
    return res.status(500).json({
      ok: false,
      message: "服务器未配置 ADMIN_TOKEN。"
    });
  }

  if (!safeEqual(token, ADMIN_TOKEN)) {
    return res.status(401).json({
      ok: false,
      message: "管理员口令错误。"
    });
  }

  res.json({
    ok: true,
    message: "管理员登录成功。",
    data: {
      admin: {
        name: ADMIN_NAME,
        role: "admin"
      }
    }
  });
});

// 管理员读取全部留言
app.get("/api/admin/comments", adminLimiter, requireAdmin, (req, res) => {
  const page = Math.max(parseInt(req.query.page || "1", 10), 1);
  const pageSize = Math.min(
    Math.max(parseInt(req.query.pageSize || "50", 10), 1),
    100
  );

  const status = normalizeString(req.query.status || "all");
  const offset = (page - 1) * pageSize;

  const allowedStatuses = new Set(["all", "visible", "hidden", "deleted"]);
  const finalStatus = allowedStatuses.has(status) ? status : "all";

  let totalRow;
  let comments;

  if (finalStatus === "all") {
    totalRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM comments
    `).get();

    comments = db.prepare(`
      SELECT *
      FROM comments
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(pageSize, offset);
  } else {
    totalRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM comments
      WHERE status = ?
    `).get(finalStatus);

    comments = db.prepare(`
      SELECT *
      FROM comments
      WHERE status = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(finalStatus, pageSize, offset);
  }

  res.json({
    ok: true,
    data: {
      comments: comments.map(serializeComment),
      pagination: {
        page,
        pageSize,
        total: totalRow.total,
        totalPages: Math.ceil(totalRow.total / pageSize)
      }
    }
  });
});

// 管理员回复留言
app.post("/api/admin/comments/:id/reply", adminLimiter, requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);

  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({
      ok: false,
      message: "无效的留言 id。"
    });
  }

  const target = db.prepare(`
    SELECT *
    FROM comments
    WHERE id = ?
      AND status != 'deleted'
  `).get(targetId);

  if (!target) {
    return res.status(404).json({
      ok: false,
      message: "要回复的留言不存在。"
    });
  }

  const result = validateReplyPayload(req.body);

  if (!result.ok) {
    return res.status(400).json({
      ok: false,
      message: result.message
    });
  }

  const parentId = getTopParentId(target);
  const replyToId = target.id;
  const replyToName = target.nickname || "访客";

  const stmt = db.prepare(`
    INSERT INTO comments (
      nickname,
      email_hash,
      website,
      content,
      rating,
      user_agent,
      ip,
      status,
      parent_id,
      reply_to_id,
      reply_to_name,
      is_admin,
      role
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    ADMIN_NAME,
    null,
    null,
    result.data.content,
    null,
    req.headers["user-agent"] || "",
    getClientIp(req),
    "visible",
    parentId,
    replyToId,
    replyToName,
    1,
    "admin"
  );

  const newReply = db.prepare(`
    SELECT *
    FROM comments
    WHERE id = ?
  `).get(info.lastInsertRowid);

  res.status(201).json({
    ok: true,
    message: "管理员回复成功。",
    data: {
      comment: serializeComment(newReply)
    }
  });
});

// 管理员修改留言状态：visible / hidden / deleted
app.patch("/api/admin/comments/:id/status", adminLimiter, requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const status = normalizeString(req.body.status);

  const allowedStatuses = new Set(["visible", "hidden", "deleted"]);

  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({
      ok: false,
      message: "无效的留言 id。"
    });
  }

  if (!allowedStatuses.has(status)) {
    return res.status(400).json({
      ok: false,
      message: "状态只能是 visible、hidden 或 deleted。"
    });
  }

  const target = db.prepare(`
    SELECT *
    FROM comments
    WHERE id = ?
  `).get(targetId);

  if (!target) {
    return res.status(404).json({
      ok: false,
      message: "留言不存在。"
    });
  }

  db.prepare(`
    UPDATE comments
    SET status = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(status, targetId);

  const updated = db.prepare(`
    SELECT *
    FROM comments
    WHERE id = ?
  `).get(targetId);

  res.json({
    ok: true,
    message: "留言状态已更新。",
    data: {
      comment: serializeComment(updated)
    }
  });
});

// ==============================
// 404 与错误处理
// ==============================

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: "接口不存在。"
  });
});

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    ok: false,
    message: "服务器内部错误。"
  });
});

// ==============================
// 启动
// ==============================

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Comment API running at http://127.0.0.1:${PORT}`);
});
SERVER_EOF

echo "==> 5. 重启 PM2"
pm2 restart comment-api
pm2 save

echo ""
echo "============================================"
echo "升级完成"
echo "管理员 token 未输出；请通过安全方式检查服务器上的 .env。"
echo "============================================"
echo ""
echo "不要把 .env、数据库、上传文件或备份提交到 Git。"
