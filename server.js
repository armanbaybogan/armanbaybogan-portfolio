const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, execFile } = require("node:child_process");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const MIME_TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("İstek çok büyük.")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

class AppServerClient {
  constructor() {
    this.process = null;
    this.pending = new Map();
    this.eventClients = new Set();
    this.nextId = 1;
    this.threadId = null;
    this.ready = false;
    this.lastError = null;
  }

  async connect() {
    if (this.process && this.ready) return;
    if (this.process) this.process.kill();
    this.process = spawn(CODEX_BIN, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.process.once("error", (error) => {
      this.lastError = error.code === "ENOENT" ? "Codex CLI bulunamadı. Önce Codex uygulamasını kurun." : error.message;
      this.ready = false;
      this.broadcast("app/error", { message: this.lastError });
    });
    this.process.once("exit", () => {
      this.ready = false;
      this.process = null;
      for (const { reject } of this.pending.values()) reject(new Error("App Server bağlantısı kapandı."));
      this.pending.clear();
      this.broadcast("app/status", { connected: false });
    });
    readline.createInterface({ input: this.process.stdout }).on("line", (line) => this.handleLine(line));
    readline.createInterface({ input: this.process.stderr }).on("line", (line) => {
      if (process.env.DEBUG) console.error(`[app-server] ${line}`);
    });
    await new Promise((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (error) => {
        cleanup();
        reject(new Error(error.code === "ENOENT" ? "Codex CLI bulunamadı. Önce Codex'i kurup giriş yapın." : error.message));
      };
      const cleanup = () => { this.process?.off("spawn", onSpawn); this.process?.off("error", onError); };
      this.process.once("spawn", onSpawn);
      this.process.once("error", onError);
    });
    await this.request("initialize", { clientInfo: { name: "notely", title: "Notely", version: "2.0.0" } });
    this.notify("initialized", {});
    this.ready = true;
    this.lastError = null;
    this.broadcast("app/status", { connected: true });
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || "App Server hatası"));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method) this.broadcast(message.method, message.params || {});
  }

  request(method, params = {}) {
    if (!this.process?.stdin?.writable) return Promise.reject(new Error("App Server çalışmıyor."));
    const id = this.nextId++;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} zaman aşımına uğradı.`)); }, 15000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
    });
  }

  notify(method, params = {}) {
    if (this.process?.stdin?.writable) this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  broadcast(method, params) {
    const payload = `event: ${method}\ndata: ${JSON.stringify(params)}\n\n`;
    for (const client of this.eventClients) client.write(payload);
  }

  async startRealtime() {
    await this.connect();
    if (!this.threadId) {
      const result = await this.request("thread/start", { cwd: process.cwd(), approvalPolicy: "never", sandbox: "read-only" });
      this.threadId = result.thread?.id || result.threadId || result.id;
      if (!this.threadId) throw new Error("App Server bir thread kimliği döndürmedi.");
    }
    await this.request("thread/realtime/start", { threadId: this.threadId });
    return this.threadId;
  }

  appendAudio(buffer, sampleRate, channels) {
    this.notify("thread/realtime/audio", {
      threadId: this.threadId,
      audio: { data: buffer.toString("base64"), sampleRate, numChannels: channels },
    });
  }

  async stopRealtime() {
    if (!this.threadId) return;
    await this.request("thread/realtime/stop", { threadId: this.threadId });
  }
}

const appServer = new AppServerClient();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      if (!appServer.ready && !appServer.lastError) appServer.connect().catch(() => {});
      return json(res, 200, { configured: appServer.ready, provider: "Codex App Server", error: appServer.lastError });
    }
    if (req.method === "GET" && url.pathname === "/api/realtime/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: app/status\ndata: ${JSON.stringify({ connected: appServer.ready })}\n\n`);
      appServer.eventClients.add(res);
      req.on("close", () => appServer.eventClients.delete(res));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/realtime/start") {
      const threadId = await appServer.startRealtime();
      return json(res, 200, { threadId });
    }
    if (req.method === "POST" && url.pathname === "/api/realtime/audio") {
      if (!appServer.ready || !appServer.threadId) return json(res, 409, { error: "Canlı oturum başlatılmadı." });
      const audio = await readBody(req, 512 * 1024);
      appServer.appendAudio(audio, Number(req.headers["x-sample-rate"]) || 24000, Number(req.headers["x-channels"]) || 1);
      return json(res, 202, { accepted: true });
    }
    if (req.method === "POST" && url.pathname === "/api/realtime/stop") {
      await appServer.stopRealtime();
      return json(res, 200, { stopped: true });
    }
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "Bulunamadı." });
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });

    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = path.resolve(PUBLIC_DIR, requested);
    if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, "index.html")) return json(res, 403, { error: "Forbidden" });
    fs.readFile(filePath, (error, data) => {
      if (error) return json(res, 404, { error: "Not found" });
      res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
      res.end(data);
    });
  } catch (error) {
    json(res, 500, { error: error.message || "Beklenmeyen bir hata oluştu." });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Notely hazır: ${url}`);
  appServer.connect().catch(() => {});
  if (process.env.NO_OPEN !== "1") {
    const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    execFile(command, args, () => {});
  }
});

function shutdown() { appServer.process?.kill(); server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
