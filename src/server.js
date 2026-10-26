/**
 * YouTrack MCP server (YouTrack 2023.3, REST API) for opencode.
 *
 * Environment variables:
 *   YOUTRACK_URL   - base URL, e.g. https://youtrack.example.com
 *   YOUTRACK_TOKEN - permanent token (Profile -> Applications -> Generate token)
 *
 * Run via npx:  npx youtrack-mcp
 * Run locally:  node bin/cli.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { YouTrackClient } from "./client.js";
import { registerIssueTools } from "./tools-issues.js";
import { registerBoardTools } from "./tools-boards.js";
import { registerMetaTools } from "./tools-meta.js";

const INSTRUCTIONS =
  "Tools for JetBrains YouTrack 2023.3: issues (search/read/create/update/" +
  "comments/attachments), commands (Command Reference syntax), Agile boards, " +
  "projects and project field values (yt_get_project_fields), plus a " +
  "read-only raw API escape hatch (yt_rest_get). Issue state/priority/tags/" +
  "assignee changes go through yt_apply_command so that YouTrack workflows " +
  "are triggered correctly; single-word bundle values in commands are " +
  "written without curly braces. Link commands work only in the web-UI " +
  "wording ('#Relates to <TARGET> <SRC>': the id right after the phrase is " +
  "the target); the 'link ...' verb and the '-' removal form do not exist " +
  "on this gateway — links are removed in the YouTrack web UI, tags via " +
  "yt_remove_tag. See docs/youtrack-links.md.";

let client = null;

/** Lazily-created shared YouTrack client (fails fast if env is missing). */
export function getClient() {
  if (client === null) {
    client = new YouTrackClient();
  }
  return client;
}

/** Build the MCP server with all tools registered. */
export function createServer() {
  const server = new McpServer(
    { name: "youtrack", version: "0.2.0" },
    { instructions: INSTRUCTIONS }
  );

  registerIssueTools(server, getClient);
  registerBoardTools(server, getClient);
  registerMetaTools(server, getClient);

  return server;
}

/** Start the server on the stdio transport (what opencode expects). */
export async function runServer() {
  // Fail fast with a clear message if configuration is missing.
  getClient();

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs in stdio-based MCP servers (stdout carries JSON-RPC).
  console.error("youtrack-mcp server running on stdio");

  return server;
}
