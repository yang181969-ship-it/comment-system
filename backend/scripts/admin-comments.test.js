const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const Database = require("better-sqlite3");

const HOST = "127.0.0.1";
const TEST_TOKEN = "admin-comments-test-token";
const TEMP_PREFIX = "comment-api-admin-test-";
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 3_000;

let child = null;
let fixtureDb = null;
let tempRoot = null;
let cleanupPromise = null;

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function request(port, method, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    let body = options.body;
    const headers = { ...(options.headers || {}) };

    if (body !== undefined && !Buffer.isBuffer(body)) {
      body = Buffer.from(JSON.stringify(body));
      headers["Content-Type"] = "application/json";
    }
    if (body) headers["Content-Length"] = String(body.length);
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    const req = http.request({
      hostname: HOST,
      port,
      path: requestPath,
      method,
      headers,
      timeout: 2_000
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        responseBody += chunk;
      });
      res.on("end", () => {
        let payload = null;
        try {
          payload = responseBody ? JSON.parse(responseBody) : null;
        } catch (error) {
          return reject(new Error(`Invalid JSON from ${method} ${requestPath}: ${error.message}`));
        }
        resolve({ statusCode: res.statusCode, payload });
      });
    });

    req.once("timeout", () => req.destroy(new Error(`${method} ${requestPath} timed out.`)));
    req.once("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function expectStatus(port, method, requestPath, expectedStatus, options = {}) {
  const response = await request(port, method, requestPath, options);
  assert.equal(
    response.statusCode,
    expectedStatus,
    `${method} ${requestPath} returned ${response.statusCode}: ${JSON.stringify(response.payload)}`
  );
  return response.payload;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealthy(port, getOutput) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited before becoming healthy.\n${getOutput()}`);
    }
    try {
      const response = await request(port, "GET", "/api/health");
      if (response.statusCode === 200 && response.payload?.ok === true) return;
      lastError = new Error(`Unexpected health response: ${response.statusCode}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  throw new Error(`Server did not become healthy: ${lastError?.message || "timeout"}\n${getOutput()}`);
}

function waitForExit(processHandle, timeoutMs) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      processHandle.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    processHandle.once("exit", onExit);
  });
}

async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, STOP_TIMEOUT_MS)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
    throw new Error("Test server did not exit after SIGKILL.");
  }
}

function removeTempRoot() {
  if (!tempRoot) return;
  const resolvedRoot = path.resolve(tempRoot);
  const resolvedBase = path.resolve(os.tmpdir());
  const safe = path.dirname(resolvedRoot) === resolvedBase
    && path.basename(resolvedRoot).startsWith(TEMP_PREFIX);
  if (!safe) throw new Error(`Refusing to remove unexpected path: ${resolvedRoot}`);
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
  tempRoot = null;
}

async function cleanup() {
  if (fixtureDb) {
    fixtureDb.close();
    fixtureDb = null;
  }
  await stopChild();
  removeTempRoot();
}

function cleanupOnce() {
  if (!cleanupPromise) cleanupPromise = cleanup();
  return cleanupPromise;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanupOnce().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

function insertFixture(values) {
  const defaults = {
    nickname: "测试访客",
    website: null,
    content: "测试内容",
    rating: null,
    status: "visible",
    parent_id: null,
    reply_to_id: null,
    reply_to_name: null,
    is_admin: 0,
    role: "guest",
    images: "[]",
    likes_count: 0,
    created_at: "2000-01-01 00:00:00",
    updated_at: "2000-01-01 00:00:00"
  };
  const row = { ...defaults, ...values };
  const info = fixtureDb.prepare(`
    INSERT INTO comments (
      nickname, email_hash, website, content, rating, user_agent, ip, status,
      parent_id, reply_to_id, reply_to_name, is_admin, role, images, likes_count,
      created_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.nickname,
    row.website,
    row.content,
    row.rating,
    row.status,
    row.parent_id,
    row.reply_to_id,
    row.reply_to_name,
    row.is_admin,
    row.role,
    row.images,
    row.likes_count,
    row.created_at,
    row.updated_at
  );
  return Number(info.lastInsertRowid);
}

function seedFixtures() {
  const rootA = insertFixture({
    nickname: "访客 A",
    content: "顶级 A",
    images: JSON.stringify(["/uploads/fixture.gif"]),
    created_at: "2000-01-01 12:00:00",
    updated_at: "2000-01-01 12:00:00"
  });
  const rootB = insertFixture({
    nickname: "访客 B",
    content: "顶级 B",
    created_at: "2000-01-01 12:00:00",
    updated_at: "2000-01-01 12:00:00"
  });
  const rootC = insertFixture({
    nickname: "访客 C",
    content: "顶级 C",
    created_at: "2000-01-01 12:02:00",
    updated_at: "2000-01-01 12:02:00"
  });
  const rootD = insertFixture({
    nickname: "访客 D",
    content: "顶级 D",
    created_at: "2000-01-01 12:03:00",
    updated_at: "2000-01-01 12:03:00"
  });
  const guestReplyA = insertFixture({
    nickname: "回复者 A",
    content: "回复 A",
    parent_id: rootA,
    reply_to_id: rootA,
    reply_to_name: "访客 A",
    created_at: "2000-01-01 12:05:00",
    updated_at: "2000-01-01 12:05:00"
  });
  const guestReplyToGuest = insertFixture({
    nickname: "回复者 B",
    content: "回复另一条回复",
    parent_id: rootA,
    reply_to_id: guestReplyA,
    reply_to_name: "回复者 A",
    created_at: "2000-01-01 12:05:00",
    updated_at: "2000-01-01 12:05:00"
  });
  const hiddenReply = insertFixture({
    nickname: "回复者 C",
    content: "待隐藏回复",
    parent_id: rootB,
    reply_to_id: rootB,
    reply_to_name: "访客 B",
    created_at: "2000-01-01 12:06:00",
    updated_at: "2000-01-01 12:06:00"
  });
  const deletedReply = insertFixture({
    nickname: "回复者 D",
    content: "待删除回复",
    parent_id: rootC,
    reply_to_id: rootC,
    reply_to_name: "访客 C",
    created_at: "2000-01-01 12:07:00",
    updated_at: "2000-01-01 12:07:00"
  });

  return {
    rootA,
    rootB,
    rootC,
    rootD,
    guestReplyA,
    guestReplyToGuest,
    hiddenReply,
    deletedReply
  };
}

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      keys.add(key);
      collectKeys(item, keys);
    });
  }
  return keys;
}

function assertNoPrivateKeys(responses) {
  const forbidden = new Set([
    "email_hash",
    "ip",
    "user_agent",
    "voter_id",
    "admin_token",
    "ADMIN_TOKEN"
  ]);
  responses.forEach((response) => {
    const keys = collectKeys(response);
    forbidden.forEach((key) => assert.equal(keys.has(key), false, `Response exposed ${key}`));
  });
}

function rootOrder(a, b) {
  if (a.created_at === b.created_at) return b.id - a.id;
  return a.created_at < b.created_at ? 1 : -1;
}

function replyOrder(a, b) {
  if (a.created_at === b.created_at) return a.id - b.id;
  return a.created_at > b.created_at ? 1 : -1;
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const serverPath = path.join(projectRoot, "server.js");
  const port = await getAvailablePort();

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const dataDirectory = path.join(tempRoot, "data");
  const uploadsDirectory = path.join(tempRoot, "uploads");
  const databasePath = path.join(dataDirectory, "comments.db");
  const testEnvFile = path.join(tempRoot, "empty.env");
  fs.writeFileSync(testEnvFile, "", { flag: "wx" });

  let stdout = "";
  let stderr = "";
  const appendOutput = (current, chunk) => (current + chunk.toString()).slice(-8_000);
  const getOutput = () => [stdout, stderr].filter(Boolean).join("\n").trim();

  child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_TOKEN: TEST_TOKEN,
      ADMIN_NAME: "测试站长",
      COMMENT_ENV_FILE: testEnvFile,
      COMMENT_DATA_DIR: dataDirectory,
      COMMENT_DB_PATH: databasePath,
      COMMENT_UPLOADS_DIR: uploadsDirectory
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendOutput(stderr, chunk);
  });

  await waitForHealthy(port, getOutput);
  fixtureDb = new Database(databasePath);
  const ids = seedFixtures();
  const adminResponses = [];

  const health = await expectStatus(port, "GET", "/api/health", 200);
  assert.equal(health.ok, true);

  const boundary = "----comment-admin-test-boundary";
  const uploadBody = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="fixture.gif"\r\n`
      + "Content-Type: image/gif\r\n\r\nGIF89a\r\n"
      + `--${boundary}--\r\n`
  );
  const upload = await expectStatus(port, "POST", "/api/upload", 201, {
    body: uploadBody,
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }
  });
  assert.equal(upload.success, true);
  assert.match(upload.url, /^\/uploads\//);

  const publicRoot = await expectStatus(port, "POST", "/api/comments", 201, {
    body: { nickname: "接口访客", content: "公开接口兼容留言" }
  });
  const publicRootId = publicRoot.data.comment.id;

  const like = await expectStatus(port, "POST", `/api/comments/${ids.rootA}/like`, 200, {
    body: { voter_id: "admin-comments-test-voter", liked: true }
  });
  assert.equal(like.data.likes, 1);

  await expectStatus(port, "GET", "/api/admin/comments", 401);
  await expectStatus(port, "GET", "/api/admin/comments", 401, { token: "wrong-test-token" });
  const login = await expectStatus(port, "POST", "/api/admin/login", 200, {
    body: { token: TEST_TOKEN }
  });
  adminResponses.push(login);

  const adminReplyA = await expectStatus(
    port,
    "POST",
    `/api/admin/comments/${ids.rootA}/reply`,
    201,
    { token: TEST_TOKEN, body: { content: "管理员回复顶级留言" } }
  );
  adminResponses.push(adminReplyA);
  const adminReplyToGuest = await expectStatus(
    port,
    "POST",
    `/api/admin/comments/${ids.guestReplyA}/reply`,
    201,
    { token: TEST_TOKEN, body: { content: "管理员回复访客回复" } }
  );
  adminResponses.push(adminReplyToGuest);
  assert.equal(adminReplyToGuest.data.comment.parent_id, ids.rootA);
  assert.equal(adminReplyToGuest.data.comment.reply_to_id, ids.guestReplyA);
  assert.equal(adminReplyToGuest.data.comment.reply_to_name, "回复者 A");

  for (const [id, status] of [
    [ids.rootD, "hidden"],
    [ids.hiddenReply, "hidden"],
    [ids.deletedReply, "deleted"]
  ]) {
    const updated = await expectStatus(
      port,
      "PATCH",
      `/api/admin/comments/${id}/status`,
      200,
      { token: TEST_TOKEN, body: { status } }
    );
    adminResponses.push(updated);
    assert.equal(updated.data.comment.status, status);
  }

  const all = await expectStatus(
    port,
    "GET",
    "/api/admin/comments?status=all&page=1&pageSize=100",
    200,
    { token: TEST_TOKEN }
  );
  adminResponses.push(all);
  assert.equal(all.data.pagination.total, 5);
  assert.equal(all.data.pagination.totalPages, 1);
  assert.equal(all.data.pagination.unit, "threads");
  assert.equal(all.data.comments.every((comment) => comment.parent_id === null), true);
  assert.deepEqual(all.data.comments, [...all.data.comments].sort(rootOrder));

  const rootA = all.data.comments.find((comment) => comment.id === ids.rootA);
  assert(rootA, "Top-level A must be returned.");
  assert.deepEqual(rootA.images, ["/uploads/fixture.gif"]);
  assert.equal(rootA.likes, 1);
  assert.deepEqual(rootA.replies, [...rootA.replies].sort(replyOrder));
  assert.deepEqual(
    new Set(rootA.replies.map((reply) => reply.id)),
    new Set([
      ids.guestReplyA,
      ids.guestReplyToGuest,
      adminReplyA.data.comment.id,
      adminReplyToGuest.data.comment.id
    ])
  );
  assert.equal(rootA.replies.every((reply) => Array.isArray(reply.replies) && reply.replies.length === 0), true);
  const nestedTarget = rootA.replies.find((reply) => reply.id === ids.guestReplyToGuest);
  assert.equal(nestedTarget.parent_id, ids.rootA);
  assert.equal(nestedTarget.reply_to_id, ids.guestReplyA);
  assert.equal(nestedTarget.reply_to_name, "回复者 A");

  const page1 = await expectStatus(
    port,
    "GET",
    "/api/admin/comments?status=all&page=1&pageSize=2",
    200,
    { token: TEST_TOKEN }
  );
  const page2 = await expectStatus(
    port,
    "GET",
    "/api/admin/comments?status=all&page=2&pageSize=2",
    200,
    { token: TEST_TOKEN }
  );
  const beyond = await expectStatus(
    port,
    "GET",
    "/api/admin/comments?status=all&page=99&pageSize=2",
    200,
    { token: TEST_TOKEN }
  );
  adminResponses.push(page1, page2, beyond);
  assert.equal(page1.data.pagination.total, 5);
  assert.equal(page1.data.pagination.totalPages, 3);
  assert.deepEqual(
    page2.data.comments.map((comment) => comment.id),
    all.data.comments.slice(2, 4).map((comment) => comment.id)
  );
  assert.deepEqual(beyond.data.comments, []);
  assert.equal(beyond.data.pagination.totalPages, 3);

  const filtered = {};
  for (const status of ["visible", "hidden", "deleted"]) {
    filtered[status] = await expectStatus(
      port,
      "GET",
      `/api/admin/comments?status=${status}&pageSize=100`,
      200,
      { token: TEST_TOKEN }
    );
    adminResponses.push(filtered[status]);
  }
  assert.equal(filtered.visible.data.pagination.total, 4);
  assert.deepEqual(
    new Set(filtered.hidden.data.comments.map((comment) => comment.id)),
    new Set([ids.rootB, ids.rootD])
  );
  const hiddenReplyThread = filtered.hidden.data.comments.find((comment) => comment.id === ids.rootB);
  assert.equal(hiddenReplyThread.status, "visible");
  assert.equal(hiddenReplyThread.replies.length, 1);
  assert.equal(hiddenReplyThread.replies[0].status, "hidden");
  assert.deepEqual(filtered.deleted.data.comments.map((comment) => comment.id), [ids.rootC]);
  assert.equal(filtered.deleted.data.comments[0].status, "visible");
  assert.equal(filtered.deleted.data.comments[0].replies[0].status, "deleted");

  const restored = await expectStatus(
    port,
    "PATCH",
    `/api/admin/comments/${ids.deletedReply}/status`,
    200,
    { token: TEST_TOKEN, body: { status: "visible" } }
  );
  adminResponses.push(restored);
  assert.equal(restored.data.comment.status, "visible");
  const deletedAfterRestore = await expectStatus(
    port,
    "GET",
    "/api/admin/comments?status=deleted&pageSize=100",
    200,
    { token: TEST_TOKEN }
  );
  adminResponses.push(deletedAfterRestore);
  assert.equal(deletedAfterRestore.data.pagination.total, 0);

  const publicComments = await expectStatus(port, "GET", "/api/comments?pageSize=50", 200);
  assert.equal(publicComments.data.comments.some((comment) => comment.id === publicRootId), true);
  assert.equal(publicComments.data.comments.some((comment) => comment.id === ids.rootD), false);
  assert.equal(
    publicComments.data.comments.find((comment) => comment.id === ids.rootB).replies.length,
    0
  );

  assertNoPrivateKeys(adminResponses);
  await stopChild();
  assert.equal(
    child.exitCode !== null || child.signalCode !== null,
    true,
    "Test server must be stopped."
  );

  console.log("Admin comments test passed: auth, thread structure, ordering, pagination, filters, actions, privacy, upload, and public API compatibility.");
}

main()
  .catch((error) => {
    console.error(`Admin comments test failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanupOnce();
    } catch (error) {
      console.error(`Admin comments cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  });
