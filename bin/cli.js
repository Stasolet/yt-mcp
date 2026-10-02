#!/usr/bin/env node
/**
 * Entry point for `npx youtrack-mcp`.
 * Starts the YouTrack MCP server over stdio (what opencode expects).
 */
import { runServer } from "../src/server.js";

runServer().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
