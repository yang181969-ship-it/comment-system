const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const Database = require("better-sqlite3");

if (process.env.COMMENT_ENV_FILE) {
  require("dotenv").config({ path: process.env.COMMENT_ENV_FILE });
} else {
  require("dotenv").config();
}

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3001;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ADMIN_NAME = process.env.ADMIN_NAME || "站长";

// ==============================
// 基础目录与数据库
// ==============================

const DATA_DIR = path.resolve(process.env.COMMENT_DATA_DIR || path.join(__dirname, "data"));
const DB_PATH = path.resolve(process.env.COMMENT_DB_PATH || path.join(DATA_DIR, "comments.db"));
const UPLOADS_DIR = path.resolve(process.env.COMMENT_UPLOADS_DIR || path.join(__dirname, "uploads"));

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
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
addColumnIfMissing("comments", "images", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("comments", "likes_count", "INTEGER NOT NULL DEFAULT 0");

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

  CREATE TABLE IF NOT EXISTS comment_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    voter_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(comment_id, voter_id),
    FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_comment_likes_comment
  ON comment_likes(comment_id);

  CREATE INDEX IF NOT EXISTS idx_comment_likes_voter
  ON comment_likes(voter_id);

  UPDATE comments
  SET likes_count = COALESCE((
    SELECT COUNT(*)
    FROM comment_likes
    WHERE comment_likes.comment_id = comments.id
  ), 0);
`);

// ==============================
// 中间件
// ==============================

app.use(helmet());

// 让浏览器能跨源加载 /uploads 下的图片（helmet 默认 CORP=same-origin 会拦截）
app.use("/uploads", (req, res, next) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
}, express.static(UPLOADS_DIR, {
  fallthrough: true,
  index: false,
  maxAge: "7d",
  setHeaders: (res) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }
}));

const ALLOWED_ORIGINS = [
  "https://yang181969.com",
  "https://www.yang181969.com",
  "https://admin.yang181969.com",
  "https://yang181969-ship-it.github.io",
  "http://localhost:3000",
  "http://localhost:5000",
  "http://localhost:5500",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:5500"
];

const corsOptions = {
  origin(origin, callback) {
    // 允许无 Origin 的请求（curl/Postman/同源/服务器到服务器）
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
// 依赖全局 cors 中间件自动处理 OPTIONS 预检（含 /api/upload）。
// 不再使用 app.options("*", ...)：当前 Express/path-to-regexp 版本不接受裸 "*"。

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

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "上传过于频繁，请稍后再试。"
  }
});

const likeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    message: "点赞过于频繁，请稍后再试。"
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

function normalizeVoterId(value) {
  const voterId = normalizeString(value);

  // 前端生成 UUID 风格字符串，后端只做长度和字符白名单约束
  if (!voterId) return "";
  if (voterId.length < 12 || voterId.length > 80) return "";
  if (!/^[a-zA-Z0-9_-]+$/.test(voterId)) return "";

  return voterId;
}

function getVoterIdFromRequest(req) {
  return normalizeVoterId(
    req.body?.voter_id ||
    req.body?.voterId ||
    req.query?.voter_id ||
    req.query?.voterId ||
    req.headers["x-voter-id"]
  );
}

function getPublicStats() {
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM comments
    WHERE status = 'visible'
      AND parent_id IS NULL
  `).get();

  const repliesRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM comments
    WHERE status = 'visible'
      AND parent_id IS NOT NULL
  `).get();

  const likesRow = db.prepare(`
    SELECT COALESCE(SUM(likes_count), 0) AS total
    FROM comments
    WHERE status = 'visible'
  `).get();

  const todayRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM comments
    WHERE status = 'visible'
      AND parent_id IS NULL
      AND date(created_at) = date('now')
  `).get();

  return {
    total: totalRow.total || 0,
    replies: repliesRow.total || 0,
    likes: likesRow.total || 0,
    today: todayRow.total || 0
  };
}

function isLikedByVoter(commentId, voterId) {
  if (!voterId) return false;

  const row = db.prepare(`
    SELECT 1 AS liked
    FROM comment_likes
    WHERE comment_id = ?
      AND voter_id = ?
    LIMIT 1
  `).get(commentId, voterId);

  return Boolean(row);
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

function serializeComment(row, options = {}) {
  const voterId = options.voterId || "";

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
    images: parseStoredImages(row.images),
    likes: Number(row.likes_count || 0),
    liked: isLikedByVoter(row.id, voterId),
    created_at: row.created_at,
    updated_at: row.updated_at,
    replies: []
  };
}

function serializeAdminComment(row) {
  const { liked, ...comment } = serializeComment(row);
  return comment;
}

function buildPublicCommentTree(rows, options = {}) {
  const map = new Map();
  const roots = [];

  rows.forEach((row) => {
    map.set(row.id, serializeComment(row, options));
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

function buildAdminCommentTree(rootRows, replyRows) {
  const roots = rootRows.map((row) => serializeAdminComment(row));
  const rootsById = new Map(roots.map((root) => [root.id, root]));

  replyRows.forEach((row) => {
    const root = rootsById.get(row.parent_id);
    if (root) {
      root.replies.push(serializeAdminComment(row));
    }
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
// 图片相关
// ==============================

const IMAGE_MIME_BY_EXT = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"]
]);

const ALLOWED_IMAGE_EXT = new Set(IMAGE_MIME_BY_EXT.keys());

const MAX_UPLOAD_SIZE = 3 * 1024 * 1024; // 3MB
const MAX_IMAGES_PER_COMMENT = 3;

function generateUploadFilename(originalName) {
  const baseName = path.basename(String(originalName || ""));
  const ext = (path.extname(baseName) || "").toLowerCase();
  const safeExt = ALLOWED_IMAGE_EXT.has(ext) ? ext : "";
  const uniq =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");
  return `${Date.now()}-${uniq}${safeExt}`;
}

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, generateUploadFilename(file.originalname));
  }
});

function uploadFileFilter(req, file, cb) {
  const baseName = path.basename(String(file.originalname || ""));
  const ext = (path.extname(baseName) || "").toLowerCase();
  const expectedMime = IMAGE_MIME_BY_EXT.get(ext);

  if (!expectedMime || file.mimetype !== expectedMime) {
    const err = new Error("只允许上传 jpg、jpeg、png、webp、gif 图片。");
    err.code = "UPLOAD_INVALID_TYPE";
    return cb(err);
  }

  cb(null, true);
}

const uploader = multer({
  storage: uploadStorage,
  limits: {
    fileSize: MAX_UPLOAD_SIZE,
    files: 1
  },
  fileFilter: uploadFileFilter
});

function startsWithBytes(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((value, index) => buffer[index] === value);
}

function isPathInsideUploads(filePath) {
  const resolvedPath = path.resolve(filePath || "");
  const relativePath = path.relative(UPLOADS_DIR, resolvedPath);
  return Boolean(relativePath)
    && !relativePath.startsWith("..")
    && !path.isAbsolute(relativePath);
}

function hasValidImageSignature(file) {
  if (!file?.path || !isPathInsideUploads(file.path)) return false;

  const ext = (path.extname(file.filename || "") || "").toLowerCase();
  const expectedMime = IMAGE_MIME_BY_EXT.get(ext);
  if (!expectedMime || file.mimetype !== expectedMime) return false;

  let fileHandle;
  try {
    fileHandle = fs.openSync(file.path, "r");
    const signature = Buffer.alloc(12);
    const bytesRead = fs.readSync(fileHandle, signature, 0, signature.length, 0);
    const header = signature.subarray(0, bytesRead);

    if (ext === ".jpg" || ext === ".jpeg") {
      return startsWithBytes(header, [0xff, 0xd8, 0xff]);
    }
    if (ext === ".png") {
      return startsWithBytes(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
    if (ext === ".gif") {
      return header.subarray(0, 6).toString("ascii") === "GIF87a"
        || header.subarray(0, 6).toString("ascii") === "GIF89a";
    }
    if (ext === ".webp") {
      return header.subarray(0, 4).toString("ascii") === "RIFF"
        && header.subarray(8, 12).toString("ascii") === "WEBP";
    }
  } catch (error) {
    return false;
  } finally {
    if (fileHandle !== undefined) fs.closeSync(fileHandle);
  }

  return false;
}

function removeUploadedFile(file) {
  if (!file?.path || !isPathInsideUploads(file.path)) return;
  try {
    fs.unlinkSync(file.path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function parseStoredImages(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === "string");
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((v) => typeof v === "string");
    }
  } catch (err) {
    // 旧数据或脏数据，按空数组处理
  }

  return [];
}

function validateImagesInput(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, data: [] };
  }

  if (!Array.isArray(input)) {
    return { ok: false, message: "images 必须是数组。" };
  }

  if (input.length > MAX_IMAGES_PER_COMMENT) {
    return {
      ok: false,
      message: `每条留言最多附带 ${MAX_IMAGES_PER_COMMENT} 张图片。`
    };
  }

  const cleaned = [];

  for (const item of input) {
    if (typeof item !== "string") {
      return { ok: false, message: "images 中的每一项必须是字符串。" };
    }

    const trimmed = item.trim();

    if (!trimmed) {
      return { ok: false, message: "images 中存在空字符串。" };
    }

    if (!trimmed.startsWith("/uploads/")) {
      return { ok: false, message: "images 路径必须以 /uploads/ 开头。" };
    }

    if (trimmed.includes("..") || trimmed.includes("\\")) {
      return { ok: false, message: "images 路径不合法。" };
    }

    if (trimmed.length > 300) {
      return { ok: false, message: "images 路径过长。" };
    }

    cleaned.push(trimmed);
  }

  return { ok: true, data: cleaned };
}

function resolveReplyTarget(rawReplyToId) {
  if (
    rawReplyToId === undefined ||
    rawReplyToId === null ||
    rawReplyToId === ""
  ) {
    return {
      ok: true,
      data: {
        parent_id: null,
        reply_to_id: null,
        reply_to_name: null
      }
    };
  }

  const numericId = Number(rawReplyToId);

  if (!Number.isInteger(numericId) || numericId <= 0) {
    return { ok: false, message: "无效的 reply_to_id。" };
  }

  const target = db
    .prepare(`SELECT * FROM comments WHERE id = ?`)
    .get(numericId);

  if (!target || target.status !== "visible") {
    return {
      ok: false,
      message: "要回复的留言不存在或已被隐藏/删除。"
    };
  }

  return {
    ok: true,
    data: {
      parent_id: getTopParentId(target),
      reply_to_id: target.id,
      reply_to_name: target.nickname || "访客"
    }
  };
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

// 图片上传：multipart/form-data，字段名 image，单文件，<=3MB
app.post("/api/upload", uploadLimiter, (req, res) => {
  uploader.single("image")(req, res, (err) => {
    if (err) {
      let message = "上传失败。";

      if (err.code === "LIMIT_FILE_SIZE") {
        message = "图片不能超过 3MB。";
      } else if (err.code === "UPLOAD_INVALID_TYPE") {
        message = err.message;
      } else if (err.code === "LIMIT_UNEXPECTED_FILE") {
        message = "上传字段名错误，请使用 image。";
      } else if (err.code === "LIMIT_FILE_COUNT") {
        message = "一次只能上传一张图片。";
      } else if (err instanceof multer.MulterError) {
        message = "上传请求不符合限制。";
      } else {
        message = "上传请求格式不正确。";
      }

      return res.status(400).json({
        success: false,
        message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "请选择要上传的图片。"
      });
    }

    if (!hasValidImageSignature(req.file)) {
      try {
        removeUploadedFile(req.file);
      } catch (error) {
        return res.status(500).json({
          success: false,
          message: "上传文件清理失败。"
        });
      }

      return res.status(400).json({
        success: false,
        message: "图片内容与扩展名或 MIME 类型不匹配。"
      });
    }

    return res.status(201).json({
      success: true,
      url: `/uploads/${req.file.filename}`,
      filename: req.file.filename
    });
  });
});

// 公开留言列表：只返回 visible，并按一级留言 + 一级回复结构输出
app.get("/api/comments", (req, res) => {
  const voterId = getVoterIdFromRequest(req);
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

  const comments = buildPublicCommentTree(allRows, { voterId });
  const stats = getPublicStats();

  res.json({
    ok: true,
    data: {
      comments,
      pagination: {
        page,
        pageSize,
        total: totalRow.total,
        totalPages: Math.ceil(totalRow.total / pageSize)
      },
      stats
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

  // 后端自行根据 reply_to_id 计算 parent_id 与 reply_to_name，不信任前端传来的 parent_id
  const replyResolution = resolveReplyTarget(req.body.reply_to_id);

  if (!replyResolution.ok) {
    return res.status(400).json({
      ok: false,
      message: replyResolution.message
    });
  }

  const imagesResult = validateImagesInput(req.body.images);

  if (!imagesResult.ok) {
    return res.status(400).json({
      ok: false,
      message: imagesResult.message
    });
  }

  const { nickname, email, website, content, rating } = result.data;
  const { parent_id, reply_to_id, reply_to_name } = replyResolution.data;
  const imagesJson = JSON.stringify(imagesResult.data);

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
      role,
      images
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    parent_id,
    reply_to_id,
    reply_to_name,
    0,
    "guest",
    imagesJson
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

// 点赞 / 取消点赞：按 voter_id 去重，刷新后状态可恢复
app.post("/api/comments/:id/like", likeLimiter, (req, res) => {
  const targetId = Number(req.params.id);
  const voterId = getVoterIdFromRequest(req);
  const shouldLike = Boolean(req.body?.liked);

  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({
      ok: false,
      message: "无效的留言 id。"
    });
  }

  if (!voterId) {
    return res.status(400).json({
      ok: false,
      message: "缺少有效的 voter_id。"
    });
  }

  const target = db.prepare(`
    SELECT *
    FROM comments
    WHERE id = ?
      AND status = 'visible'
  `).get(targetId);

  if (!target) {
    return res.status(404).json({
      ok: false,
      message: "留言不存在或不可点赞。"
    });
  }

  const tx = db.transaction(() => {
    if (shouldLike) {
      db.prepare(`
        INSERT OR IGNORE INTO comment_likes (comment_id, voter_id)
        VALUES (?, ?)
      `).run(targetId, voterId);
    } else {
      db.prepare(`
        DELETE FROM comment_likes
        WHERE comment_id = ?
          AND voter_id = ?
      `).run(targetId, voterId);
    }

    const countRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM comment_likes
      WHERE comment_id = ?
    `).get(targetId);

    const likes = countRow.total || 0;

    db.prepare(`
      UPDATE comments
      SET likes_count = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(likes, targetId);

    return likes;
  });

  const likes = tx();
  const liked = isLikedByVoter(targetId, voterId);

  res.json({
    ok: true,
    message: liked ? "已点赞。" : "已取消点赞。",
    data: {
      comment_id: targetId,
      likes,
      liked,
      stats: getPublicStats()
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

// 管理员按顶级留言线程读取全部留言
app.get("/api/admin/comments", adminLimiter, requireAdmin, (req, res) => {
  const requestedPage = parseInt(req.query.page || "1", 10);
  const requestedPageSize = parseInt(req.query.pageSize || "50", 10);
  const page = Number.isInteger(requestedPage) ? Math.max(requestedPage, 1) : 1;
  const pageSize = Math.min(
    Number.isInteger(requestedPageSize) ? Math.max(requestedPageSize, 1) : 50,
    100
  );

  const status = normalizeString(req.query.status || "all");
  const offset = (page - 1) * pageSize;

  const allowedStatuses = new Set(["all", "visible", "hidden", "deleted"]);
  const finalStatus = allowedStatuses.has(status) ? status : "all";

  let totalRow;
  let rootRows;

  if (finalStatus === "all") {
    totalRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM comments
      WHERE parent_id IS NULL
    `).get();

    rootRows = db.prepare(`
      SELECT *
      FROM comments
      WHERE parent_id IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(pageSize, offset);
  } else {
    totalRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM comments AS root
      WHERE root.parent_id IS NULL
        AND (
          root.status = ?
          OR EXISTS (
            SELECT 1
            FROM comments AS reply
            WHERE reply.parent_id = root.id
              AND reply.status = ?
          )
        )
    `).get(finalStatus, finalStatus);

    rootRows = db.prepare(`
      SELECT root.*
      FROM comments AS root
      WHERE root.parent_id IS NULL
        AND (
          root.status = ?
          OR EXISTS (
            SELECT 1
            FROM comments AS reply
            WHERE reply.parent_id = root.id
              AND reply.status = ?
          )
        )
      ORDER BY root.created_at DESC, root.id DESC
      LIMIT ? OFFSET ?
    `).all(finalStatus, finalStatus, pageSize, offset);
  }

  const rootIds = rootRows.map((row) => row.id);
  let replyRows = [];

  if (rootIds.length > 0) {
    const placeholders = rootIds.map(() => "?").join(",");
    replyRows = db.prepare(`
      SELECT *
      FROM comments
      WHERE parent_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `).all(...rootIds);
  }

  const comments = buildAdminCommentTree(rootRows, replyRows);

  res.json({
    ok: true,
    data: {
      comments,
      pagination: {
        page,
        pageSize,
        total: totalRow.total,
        totalPages: Math.ceil(totalRow.total / pageSize),
        unit: "threads"
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

  const imagesResult = validateImagesInput(req.body.images);

  if (!imagesResult.ok) {
    return res.status(400).json({
      ok: false,
      message: imagesResult.message
    });
  }

  const parentId = getTopParentId(target);
  const replyToId = target.id;
  const replyToName = target.nickname || "访客";
  const imagesJson = JSON.stringify(imagesResult.data);

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
      role,
      images
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    "admin",
    imagesJson
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
      comment: serializeAdminComment(newReply)
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
      comment: serializeAdminComment(updated)
    }
  });
});

// ==============================
// 404 与错误处理
// ==============================

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: '接口不存在'
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
