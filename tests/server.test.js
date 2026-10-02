/**
 * Smoke test: MCP handshake over an in-memory pipe + tool calls against a
 * mocked YouTrack client. Mirrors the old tests_server.py.
 *
 * Run: npm test
 */
process.env.YOUTRACK_URL ||= "https://yt.test";
process.env.YOUTRACK_TOKEN ||= "test-token";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import(
  "@modelcontextprotocol/sdk/inMemory.js"
);
const { YouTrackClient } = await import("../src/client.js");
const { createServer } = await import("../src/server.js");

const calls = [];

// Patch the client's request method to mock the YouTrack REST API.
YouTrackClient.prototype.request = async function (method, path, opts = {}) {
  const params = opts.params ?? {};
  calls.push([method, path, params]);
  if (path === "/issues" && method === "GET") {
    return [{ id: "issue-1", number: "ABC-1", subject: "Test issue" }];
  }
  if (path.startsWith("/issues/ABC-1/comments") && method === "POST") {
    return { id: "c1", text: opts.json?.text };
  }
  if (path === "/admin/commands") {
    return { output: "", error: "" };
  }
  if (path === "/agiles") {
    return [{ id: "agile-1", name: "My Board" }];
  }
  return {};
};

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

function parseResult(res) {
  assert(Array.isArray(res.content) && res.content.length > 0, "empty tool result");
  assert(!res.isError, `tool returned error: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

async function main() {
  const server = createServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const { tools } = await client.listTools();
  assert(tools.length === 17, `expected 17 tools, got ${tools.length}`);

  const names = tools.map((t) => t.name);
  assert(names.includes("yt_get_board_issues"), "missing yt_get_board_issues");
  assert(names.includes("yt_get_vcs_references"), "missing yt_get_vcs_references");

  let res = await client.callTool({
    name: "yt_search_issues",
    arguments: { query: "project:ABC" },
  });
  let data = parseResult(res);
  assert(data[0].number === "ABC-1", JSON.stringify(data));

  res = await client.callTool({
    name: "yt_apply_command",
    arguments: { command: "#State Fixed ABC-1" },
  });
  parseResult(res);

  res = await client.callTool({
    name: "yt_add_comment",
    arguments: { issue_id: "ABC-1", text: "hello" },
  });
  data = parseResult(res);
  assert(data.text === "hello", JSON.stringify(data));

  res = await client.callTool({ name: "yt_list_boards", arguments: {} });
  data = parseResult(res);
  assert(data[0].name === "My Board", JSON.stringify(data));

  // Verify the HTTP paths we hit.
  const paths = calls.map(([, p]) => p);
  assert(paths.includes("/issues"), "no /issues call");
  assert(paths.includes("/admin/commands"), "no /admin/commands call");
  assert(paths.includes("/agiles"), "no /agiles call");
  assert(paths.some((p) => p.endsWith("/comments")), "no comments call");

  await client.close();
  await server.close();
  console.log("SMOKE TEST OK. Calls:", paths);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
