const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 3_000;
const TEMP_PREFIX = "comment-api-health-";

let child = null;
let tempRoot = null;
let cleanupPromise = null;

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: HOST,
      port,
      path: "/api/health",
      timeout: 1_000
    }, (response) => {
      let body = "";

      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ statusCode: response.statusCode, body });
      });
    });

    request.once("timeout", () => {
      request.destroy(new Error("Health request timed out."));
    });
    request.once("error", reject);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForExit(processHandle, timeoutMs) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let timeout = null;
    const onExit = () => {
      if (timeout) clearTimeout(timeout);
      processHandle.removeListener("exit", onExit);
      resolve(true);
    };

    processHandle.once("exit", onExit);

    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      onExit();
      return;
    }

    timeout = setTimeout(() => {
      processHandle.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
  });
}

async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  if (await waitForExit(child, STOP_TIMEOUT_MS)) return;

  child.kill("SIGKILL");
  if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
    throw new Error("Health-check server did not exit after SIGKILL.");
  }
}

function removeTempRoot() {
  if (!tempRoot) return;

  const resolvedRoot = path.resolve(tempRoot);
  const resolvedBase = path.resolve(os.tmpdir());
  const isExpectedTempDirectory =
    path.dirname(resolvedRoot) === resolvedBase &&
    path.basename(resolvedRoot).startsWith(TEMP_PREFIX);

  if (!isExpectedTempDirectory) {
    throw new Error(`Refusing to remove unexpected path: ${resolvedRoot}`);
  }

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
    cleanupOnce()
      .catch((error) => {
        console.error(`Health check cleanup failed: ${error.message}`);
      })
      .finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
  });
}

async function waitForHealthy(port, getProcessOutput, getSpawnError) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    if (getSpawnError()) {
      throw new Error(`Server process could not start: ${getSpawnError().message}\n${getProcessOutput()}`);
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited before becoming healthy.\n${getProcessOutput()}`);
    }

    try {
      const response = await requestHealth(port);
      if (response.statusCode !== 200) {
        throw new Error(`Expected HTTP 200, received ${response.statusCode}.`);
      }

      let payload;
      try {
        payload = JSON.parse(response.body);
      } catch (error) {
        throw new Error(`Health response was not valid JSON: ${error.message}`);
      }

      if (payload.ok !== true) {
        throw new Error("Health response did not contain ok=true.");
      }

      return;
    } catch (error) {
      lastError = error;
      await delay(150);
    }
  }

  throw new Error(`Server did not become healthy: ${lastError?.message || "timeout"}\n${getProcessOutput()}`);
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const serverPath = path.join(projectRoot, "server.js");
  const port = await getAvailablePort();

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const dataDirectory = path.join(tempRoot, "data");
  const uploadsDirectory = path.join(tempRoot, "uploads");
  const testEnvFile = path.join(tempRoot, "empty.env");
  fs.writeFileSync(testEnvFile, "", { flag: "wx" });

  let stdout = "";
  let stderr = "";
  let spawnError = null;
  const appendOutput = (current, chunk) => (current + chunk.toString()).slice(-8_000);
  const getProcessOutput = () => [stdout, stderr].filter(Boolean).join("\n").trim();

  child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_TOKEN: "health-check-test-token",
      ADMIN_NAME: "Health Check",
      COMMENT_ENV_FILE: testEnvFile,
      COMMENT_DATA_DIR: dataDirectory,
      COMMENT_DB_PATH: path.join(dataDirectory, "comments.db"),
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
  child.once("error", (error) => {
    spawnError = error;
  });

  await waitForHealthy(port, getProcessOutput, () => spawnError);
  await stopChild();

  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("Health-check server is still running after shutdown.");
  }

  console.log("Health check passed: GET /api/health returned HTTP 200 with ok=true.");
}

main()
  .catch((error) => {
    console.error(`Health check failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanupOnce();
    } catch (error) {
      console.error(`Health check cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  });
