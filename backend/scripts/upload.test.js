const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const HOST = "127.0.0.1";
const MAX_UPLOAD_SIZE = 3 * 1024 * 1024;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 3_000;
const TEMP_PREFIX = "comment-api-upload-test-";

let child = null;
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
    const body = options.body;
    const headers = { ...(options.headers || {}) };
    if (body) headers["Content-Length"] = String(body.length);

    const req = http.request({
      hostname: HOST,
      port,
      path: requestPath,
      method,
      headers,
      timeout: 5_000
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks);
        let payload = null;
        if (options.parseJson !== false) {
          try {
            payload = responseBody.length > 0
              ? JSON.parse(responseBody.toString("utf8"))
              : null;
          } catch (error) {
            return reject(new Error(`Invalid JSON from ${method} ${requestPath}: ${error.message}`));
          }
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseBody,
          payload
        });
      });
    });

    req.once("timeout", () => req.destroy(new Error(`${method} ${requestPath} timed out.`)));
    req.once("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function expectJsonStatus(port, method, requestPath, expectedStatus, options = {}) {
  const response = await request(port, method, requestPath, options);
  assert.equal(
    response.statusCode,
    expectedStatus,
    `${method} ${requestPath} returned ${response.statusCode}: ${JSON.stringify(response.payload)}`
  );
  assert.equal(typeof response.payload, "object");
  return response;
}

function createMultipart(filename, mimetype, content, fieldName = "image") {
  const boundary = `----comment-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n`
      + `Content-Type: ${mimetype}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    boundary,
    body: Buffer.concat([head, content, tail]),
    head
  };
}

function createEmptyMultipart() {
  const boundary = `----comment-upload-empty-${Date.now()}`;
  return {
    boundary,
    body: Buffer.from(`--${boundary}--\r\n`)
  };
}

function uploadOptions(multipart) {
  return {
    body: multipart.body,
    headers: { "Content-Type": `multipart/form-data; boundary=${multipart.boundary}` }
  };
}

function listUploadedFiles(uploadsDirectory) {
  return fs.readdirSync(uploadsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

async function assertFailedUploadLeavesNoFile(
  port,
  uploadsDirectory,
  requestOptions,
  expectedStatus = 400
) {
  const before = listUploadedFiles(uploadsDirectory);
  const response = await expectJsonStatus(port, "POST", "/api/upload", expectedStatus, requestOptions);
  assert.equal(response.payload.success, false);
  assert.equal(JSON.stringify(response.payload).includes(tempRoot), false);
  assert.deepEqual(listUploadedFiles(uploadsDirectory), before);
  return response;
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
    throw new Error("Upload-test server did not exit after SIGKILL.");
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

function abortMultipartRequest(port, multipart) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const declaredLength = multipart.body.length + 512 * 1024;
    const req = http.request({
      hostname: HOST,
      port,
      path: "/api/upload",
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
        "Content-Length": String(declaredLength)
      }
    });
    req.once("error", finish);
    req.write(multipart.head);
    req.write(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64 * 1024)]));
    setTimeout(() => {
      req.destroy();
      finish();
    }, 25);
  });
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const serverPath = path.join(projectRoot, "server.js");
  const port = await getAvailablePort();

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const expectedTempRoot = tempRoot;
  const dataDirectory = path.join(tempRoot, "data");
  const uploadsDirectory = path.join(tempRoot, "uploads");
  const testEnvFile = path.join(tempRoot, "empty.env");
  fs.writeFileSync(testEnvFile, "", { flag: "wx" });

  let stdout = "";
  let stderr = "";
  const appendOutput = (current, chunk) => (current + chunk.toString()).slice(-8_000);
  const getOutput = () => [stdout, stderr].filter(Boolean).join("\n").trim();
  const childEnv = {
    ...process.env,
    PORT: String(port),
    ADMIN_TOKEN: "upload-test-only-invalid-token",
    ADMIN_NAME: "Upload Test",
    COMMENT_ENV_FILE: testEnvFile,
    COMMENT_DATA_DIR: dataDirectory,
    COMMENT_DB_PATH: path.join(dataDirectory, "comments.db"),
    COMMENT_UPLOADS_DIR: uploadsDirectory
  };
  delete childEnv.NODE_TLS_REJECT_UNAUTHORIZED;

  child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendOutput(stderr, chunk);
  });

  await waitForHealthy(port, getOutput);

  const firstGif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32, 0x11)]);
  const firstUpload = await expectJsonStatus(
    port,
    "POST",
    "/api/upload",
    201,
    uploadOptions(createMultipart("same-name.gif", "image/gif", firstGif))
  );
  assert.deepEqual(Object.keys(firstUpload.payload).sort(), ["filename", "success", "url"]);
  assert.equal(firstUpload.payload.success, true);
  assert.equal(firstUpload.payload.url, `/uploads/${firstUpload.payload.filename}`);
  assert.match(firstUpload.payload.filename, /^[0-9]+-[0-9a-f-]+\.gif$/i);

  const staticFile = await request(port, "GET", firstUpload.payload.url, { parseJson: false });
  assert.equal(staticFile.statusCode, 200);
  assert.deepEqual(staticFile.body, firstGif);
  assert.equal(staticFile.headers["cross-origin-resource-policy"], "cross-origin");

  const emptyMultipart = createEmptyMultipart();
  await assertFailedUploadLeavesNoFile(
    port,
    uploadsDirectory,
    uploadOptions(emptyMultipart)
  );

  await assertFailedUploadLeavesNoFile(
    port,
    uploadsDirectory,
    uploadOptions(createMultipart("not-image.txt", "text/plain", Buffer.from("not an image")))
  );

  await assertFailedUploadLeavesNoFile(
    port,
    uploadsDirectory,
    uploadOptions(createMultipart("spoofed.gif", "image/gif", Buffer.from("not a gif")))
  );

  const oversizedGif = Buffer.concat([
    Buffer.from("GIF89a"),
    Buffer.alloc(MAX_UPLOAD_SIZE)
  ]);
  await assertFailedUploadLeavesNoFile(
    port,
    uploadsDirectory,
    uploadOptions(createMultipart("oversized.gif", "image/gif", oversizedGif))
  );

  const traversalUpload = await expectJsonStatus(
    port,
    "POST",
    "/api/upload",
    201,
    uploadOptions(createMultipart("../../../../escape.gif", "image/gif", firstGif))
  );
  assert.equal(traversalUpload.payload.filename.includes(".."), false);
  assert.equal(/[\\/]/.test(traversalUpload.payload.filename), false);
  const traversalPath = path.resolve(uploadsDirectory, traversalUpload.payload.filename);
  assert.equal(path.dirname(traversalPath), path.resolve(uploadsDirectory));

  const secondGif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32, 0x22)]);
  const secondUpload = await expectJsonStatus(
    port,
    "POST",
    "/api/upload",
    201,
    uploadOptions(createMultipart("same-name.gif", "image/gif", secondGif))
  );
  assert.notEqual(secondUpload.payload.filename, firstUpload.payload.filename);
  assert.deepEqual(fs.readFileSync(path.join(uploadsDirectory, firstUpload.payload.filename)), firstGif);
  assert.deepEqual(fs.readFileSync(path.join(uploadsDirectory, secondUpload.payload.filename)), secondGif);

  await assertFailedUploadLeavesNoFile(port, uploadsDirectory, {
    body: Buffer.from("this is not multipart data"),
    headers: { "Content-Type": "multipart/form-data; boundary=broken-boundary" }
  });

  const beforeAbort = listUploadedFiles(uploadsDirectory);
  const abortedMultipart = createMultipart("aborted.gif", "image/gif", firstGif);
  await abortMultipartRequest(port, abortedMultipart);
  await delay(300);
  assert.deepEqual(listUploadedFiles(uploadsDirectory), beforeAbort);

  const healthAfterFailures = await expectJsonStatus(port, "GET", "/api/health", 200);
  assert.equal(healthAfterFailures.payload.ok, true);
  assert.equal(listUploadedFiles(uploadsDirectory).length, 3);

  await cleanupOnce();
  assert.equal(fs.existsSync(expectedTempRoot), false);

  console.log("Upload test passed: Multer 2 compatibility, signatures, limits, static access, unique filenames, malformed/aborted requests, and cleanup.");
}

main()
  .catch((error) => {
    console.error(`Upload test failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanupOnce();
    } catch (error) {
      console.error(`Upload test cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  });
