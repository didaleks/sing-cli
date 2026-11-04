"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);

async function main() {
  let task, ignoreNotifies = false;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const data = text ? JSON.parse(text) : {};
    requests.push({ method: req.method, data });
    res.setHeader("Content-Type", "application/json");
    if ("notify" in data || "id" in data) {
      res.writeHead(400).end(JSON.stringify({ message: "property should not exist" }));
      return;
    }
    if (req.method === "POST") task = { id: "T-reminder", deadline: "2026-12-01T21:00:00.000Z", ...data };
    if (req.method === "PATCH") {
      if (ignoreNotifies) delete data.notifies;
      Object.assign(task, data);
    }
    res.end(JSON.stringify(task));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env, SINGULARITY_BASE_URL: `http://127.0.0.1:${server.address().port}`, SINGULARITY_ACCESS_TOKEN: "test-token" };
  const cli = (...args) => run(process.execPath, [require.resolve("./sing.js"), ...args], { env });
  try {
    const created = await cli("create", "--title", "Сделать сброс в Codex", "--date", "2026-11-06", "--time", "20:00", "--notify", "0");
    assert.match(created.stdout, /T-reminder/);
    assert.deepEqual(requests.map((r) => r.method), ["POST", "GET"]);
    assert.equal(task.start, "2026-11-06T17:00:00.000Z");
    assert.equal(task.useTime, true);
    assert.deepEqual(task.notifies, [0]);

    await cli("start", "T-reminder", "--date", "2026-11-07", "--time", "00:10", "--notify", "0,60");
    assert.equal(task.start, "2026-11-06T21:10:00.000Z");
    assert.deepEqual(task.notifies, [60, 0]);
    const deadline = task.deadline;
    await cli("start", "T-reminder", "--date", "2026-11-08");
    assert.deepEqual(task.notifies, [60, 0]);
    assert.equal(task.deadline, deadline);

    const count = requests.length;
    await assert.rejects(cli("create", "--title", "Invalid", "--date", "2026-02-30"), { code: 1 });
    assert.equal(requests.length, count, "invalid input must not reach API");
    ignoreNotifies = true;
    await assert.rejects(cli("start", "T-reminder", "--date", "2026-11-06", "--time", "20:00", "--notify", "15"),
      (e) => e.code === 1 && e.stderr.includes("API не сохранил notifies"));
    console.log("Reminder CLI integration checks passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
