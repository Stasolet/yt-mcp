/**
 * Smoke test: MCP handshake over an in-memory pipe + tool calls against a
 * mocked YouTrack client (legacy "gaprest"-style responses).
 *
 * Run: npm test
 */
process.env.YOUTRACK_URL ||= "https://yt.test";
process.env.YOUTRACK_TOKEN ||= "test-token";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import(
  "@modelcontextprotocol/sdk/inMemory.js"
);
const { YouTrackClient, YouTrackError } = await import("../src/client.js");
const { createServer } = await import("../src/server.js");

const calls = [];

// Patch the client's request method to mock the YouTrack REST API.
YouTrackClient.prototype.request = async function (method, path, opts = {}) {
  calls.push([method, path, opts.params ?? {}, opts.json]);

  if (path === "/issues" && method === "GET") {
    return [
      {
        id: "2-1",
        project: { shortName: "ABC" },
        numberInProject: 1,
        summary: "Test issue",
        customFields: [{ name: "State", value: { name: "Fixed" } }],
      },
    ];
  }
  if (path === "/issues" && method === "POST") {
    return { id: "2-9" };
  }
  if (path === "/issues/2-9" && method === "GET") {
    return {
      id: "2-9",
      project: { shortName: "ABC" },
      numberInProject: 9,
      summary: "New issue",
      customFields: [],
      updated: 300,
    };
  }
  if (path === "/issues/ABC-1" && method === "GET") {
    return {
      id: "2-1",
      project: { shortName: "ABC" },
      numberInProject: 1,
      summary: "Test issue",
      customFields: [{ name: "State", value: { name: "Fixed" } }],
      updated: 111,
    };
  }
  if (path === "/issues/ABC-9" && method === "GET") {
    return { id: "2-9" };
  }
  if (path.startsWith("/issues/ABC-1/comments") && method === "POST") {
    return { id: "c1", text: opts.json?.text };
  }
  if (path === "/commands" && method === "POST") {
    const cmd = opts.json?.command ?? "";
    if (cmd.includes("{Backend}")) {
      throw new YouTrackError(
        400,
        '{"error":"Bad Request","error_description":"Subsystem expected: {Backend}"}'
      );
    }
    if (cmd.includes("NoSuchField")) {
      throw new YouTrackError(
        400,
        '{"error":"Bad Request","error_description":"NoSuchField expected"}'
      );
    }
    if (cmd.includes("CmdErr")) {
      return { output: "", error: "no such command" };
    }
    return {};
  }
  if (path === "/agiles") {
    return [{ id: "122-1", name: "My Board", $type: "Agile" }];
  }
  if (path.startsWith("/agiles/") && path.endsWith("/columns")) {
    throw new YouTrackError(404, '{"error":"No subresource for path columns"}');
  }
  if (path === "/admin/projects" && method === "GET") {
    return [{ id: "0-1", name: "Alpha", shortName: "ABC" }];
  }
  if (path === "/admin/projects/ABC/customFields" && method === "GET") {
    return [
      { id: "1-1", name: "State", $type: "SingleBundleCustomField" },
      { id: "1-2", name: "Subsystem", $type: "SingleBundleCustomField" },
    ];
  }
  if (path === "/admin/projects/EMPTY/customFields" && method === "GET") {
    return [];
  }
  if (path === "/admin/customFields/1-1/values" && method === "GET") {
    return [{ name: "Fixed", presentation: "Fixed", isDefault: false }];
  }
  if (path === "/admin/customFields/1-2/values" && method === "GET") {
    return [
      { name: "Backend", presentation: "Backend", isDefault: true },
      { name: "Frontend", presentation: "Frontend", isDefault: false },
    ];
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
  assert(tools.length === 19, `expected 19 tools, got ${tools.length}`);

  const names = tools.map((t) => t.name);
  assert(names.includes("yt_get_board_issues"), "missing yt_get_board_issues");
  assert(names.includes("yt_get_vcs_references"), "missing yt_get_vcs_references");
  assert(names.includes("yt_get_project_fields"), "missing yt_get_project_fields");
  assert(names.includes("yt_rest_get"), "missing yt_rest_get");

  let res = await client.callTool({
    name: "yt_search_issues",
    arguments: { query: "project:ABC" },
  });
  let data = parseResult(res);
  assert(data[0].number === "ABC-1", JSON.stringify(data));
  assert(data[0].subject === "Test issue", JSON.stringify(data));
  assert(data[0].state === "Fixed", JSON.stringify(data));

  // "flat" fields must not strip the baseline needed for normalization.
  res = await client.callTool({
    name: "yt_search_issues",
    arguments: { query: "project:ABC", fields: "id,subsystem(name)" },
  });
  data = parseResult(res);
  assert(data[0].number === "ABC-1", `baseline lost: ${JSON.stringify(data)}`);
  const searchFields = calls
    .filter(([m, p]) => m === "GET" && p === "/issues")
    .map(([, , params]) => params.fields ?? "");
  const lastSearch = searchFields[searchFields.length - 1];
  assert(lastSearch.includes("numberInProject"), `baseline not merged: ${lastSearch}`);
  assert(lastSearch.includes("customFields"), `customFields not merged: ${lastSearch}`);
  assert(!lastSearch.includes("subsystem(name)"), `flat name not dropped: ${lastSearch}`);

  res = await client.callTool({
    name: "yt_apply_command",
    arguments: { command: "#State Fixed ABC-1" },
  });
  parseResult(res);

  // Curly-braced single-word value: first attempt 400, retry without braces.
  res = await client.callTool({
    name: "yt_apply_command",
    arguments: { command: "#Subsystem {Backend} ABC-1" },
  });
  parseResult(res);
  const cmdBodies = calls
    .filter(([m, p]) => m === "POST" && p === "/commands")
    .map(([, , , body]) => body.command);
  assert(cmdBodies.some((c) => c.includes("{Backend}")), "no braced attempt");
  assert(
    cmdBodies.some((c) => c.includes("#Subsystem Backend")),
    "no un-braced retry"
  );

  // A {error} body from /commands is a failure, not a silent success.
  res = await client.callTool({
    name: "yt_apply_command",
    arguments: { command: "#CmdErr ABC-1" },
  });
  assert(res.isError, "non-empty command error should set isError");

  // create_issue keeps the created issue even when the command fails.
  res = await client.callTool({
    name: "yt_create_issue",
    arguments: { project: "ABC", subject: "New issue", command: "#NoSuchField Nope" },
  });
  data = parseResult(res);
  assert(data.number === "ABC-9", JSON.stringify(data));
  assert(data.command_error, "expected command_error");

  // yt_get_project_fields returns allowed values for a bundle field.
  res = await client.callTool({
    name: "yt_get_project_fields",
    arguments: { project: "ABC", field: "Subsystem" },
  });
  data = parseResult(res);
  assert(data.fields?.[0]?.values?.[0]?.name === "Backend", JSON.stringify(data));

  // Admin API hidden (200 + []) -> values aggregated from issues.
  res = await client.callTool({
    name: "yt_get_project_fields",
    arguments: { project: "EMPTY" },
  });
  data = parseResult(res);
  assert(data.note, "expected aggregation note");
  assert(data.fields?.[0]?.source === "observed", JSON.stringify(data));
  assert(data.fields?.[0]?.values?.[0]?.name === "Fixed", JSON.stringify(data));

  // yt_get_issue_states still works as the State-specific wrapper.
  res = await client.callTool({
    name: "yt_get_issue_states",
    arguments: { project: "ABC" },
  });
  data = parseResult(res);
  assert(data[0]?.name === "Fixed", JSON.stringify(data));

  // Stale expected_updated rejects the write without POSTing it.
  const postsBefore = calls.filter(
    ([m, p]) => m === "POST" && p === "/issues/ABC-1"
  ).length;
  res = await client.callTool({
    name: "yt_update_issue",
    arguments: { issue_id: "ABC-1", subject: "s", expected_updated: 222 },
  });
  assert(res.isError, "stale expected_updated should fail");
  const postsAfter = calls.filter(
    ([m, p]) => m === "POST" && p === "/issues/ABC-1"
  ).length;
  assert(postsAfter === postsBefore, "conflicting update must not POST");

  // yt_rest_get path guard.
  res = await client.callTool({
    name: "yt_rest_get",
    arguments: { path: "/../etc/passwd" },
  });
  assert(res.isError, "path guard should reject '..'");
  res = await client.callTool({
    name: "yt_rest_get",
    arguments: { path: "/agiles", params: { fields: "id,name" } },
  });
  data = parseResult(res);
  assert(data[0]?.name === "My Board", JSON.stringify(data));

  res = await client.callTool({
    name: "yt_add_comment",
    arguments: { issue_id: "ABC-1", text: "hello" },
  });
  data = parseResult(res);
  assert(data.text === "hello", JSON.stringify(data));

  res = await client.callTool({ name: "yt_list_boards", arguments: {} });
  data = parseResult(res);
  assert(data[0].name === "My Board", JSON.stringify(data));

  res = await client.callTool({
    name: "yt_get_board_issues",
    arguments: { board_id: "My Board" },
  });
  data = parseResult(res);
  assert(data.issues?.[0]?.number === "ABC-1", JSON.stringify(data));
  assert(data.note, "expected approximation note");

  res = await client.callTool({
    name: "yt_get_board_columns",
    arguments: { board_id: "122-1" },
  });
  assert(!res.isError, "columns should degrade gracefully");
  assert(
    res.content[0].text.includes("not exposed"),
    `expected unsupported message, got: ${res.content[0].text}`
  );

  // Verify the HTTP paths we hit.
  const paths = calls.map(([, p]) => p);
  assert(paths.includes("/issues"), "no /issues call");
  assert(paths.includes("/issues/ABC-1"), "issue id was not resolved");
  assert(paths.includes("/commands"), "no /commands call");
  assert(paths.some((p) => p.endsWith("/comments")), "no comments call");
  assert(
    calls.some(
      ([m, p, , body]) =>
        m === "POST" && p === "/commands" && body?.issues?.[0]?.id === "2-1"
    ),
    "commands call missing resolved issue id"
  );

  await client.close();
  await server.close();
  console.log("SMOKE TEST OK. Calls:", paths.length);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
