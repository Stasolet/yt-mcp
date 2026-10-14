/**
 * Project/user MCP tools, plus Agile board tools.
 *
 * NOTE: the YouTrack instance in use (legacy "gaprest" REST) exposes NO
 * /api/agiles — board tools return an explanatory message instead of a raw 404.
 */
import { z } from "zod";
import { normalizeIssue } from "./tools-issues.js";
import { getProjectFields } from "./tools-meta.js";

const SHORT_ISSUE_FIELDS =
  "id,project(shortName),numberInProject,summary," +
  "customFields(name,value(name,localizedName))";

function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data ?? null, null, 2) }] };
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function isNotFound(err) {
  return err?.name === "YouTrackError" && err.statusCode === 404;
}

// This instance exposes GET /api/agiles (id+name only) but no
// /agiles/{id}/columns and /agiles/{id}/issues subresources.

async function boardCall(getClient, fn, notAvailableMessage) {
  try {
    return await fn(getClient());
  } catch (err) {
    if (isNotFound(err)) return textResult(notAvailableMessage);
    throw err;
  }
}

async function resolveBoard(client, board_id) {
  const boards = await client.get("/agiles", { params: { fields: "id,name" } });
  const needle = board_id.toLowerCase();
  const board = (boards ?? []).find(
    (b) => b.id === board_id || b.name?.toLowerCase() === needle
  );
  if (!board) throw new Error(`Board not found: ${board_id}`);
  return board;
}

export function registerBoardTools(server, getClient) {
  server.registerTool(
    "yt_list_boards",
    {
      title: "List Agile boards",
      description: "List all Agile boards the token's user can see.",
      inputSchema: {},
    },
    async () =>
      boardCall(
        getClient,
        async (client) => {
          const data = await client.get("/agiles", {
            params: { fields: "id,name" },
          });
          return jsonResult(data);
        },
        "Agile boards API is not available on this YouTrack server (/api/agiles -> 404)."
      )
  );

  server.registerTool(
    "yt_get_board",
    {
      title: "Get an Agile board",
      description:
        "Get one board by its id or name.\n\n" +
        "Note: this server instance exposes only id and name per board.",
      inputSchema: {
        board_id: z.string().describe("Board id or name"),
      },
    },
    async ({ board_id }) => {
      const client = getClient();
      const board = await resolveBoard(client, board_id);
      return jsonResult(board);
    }
  );

  server.registerTool(
    "yt_get_board_issues",
    {
      title: "List issues on a board",
      description:
        "List issues on a board (optionally filtered by extra query).\n\n" +
        "The native /agiles/{id}/issues endpoint is not implemented on this " +
        "server, so issues are fetched by the board's project (board name is " +
        "matched against project names).",
      inputSchema: {
        board_id: z.string().describe("Board id or name"),
        query: z.string().default("").describe("Extra YouTrack query filter"),
        max_results: z.number().int().default(50).describe("Max number of results"),
      },
    },
    async ({ board_id, query, max_results }) => {
      const client = getClient();
      const board = await resolveBoard(client, board_id);
      const fullQuery = `project:${board.name}` + (query ? ` ${query}` : "");
      const data = await client.get("/issues", {
        params: { query: fullQuery, $top: max_results, fields: SHORT_ISSUE_FIELDS },
      });
      return jsonResult({
        note:
          "Approximation: /agiles/{id}/issues is not implemented on this " +
          "server; fetched by project matching the board name.",
        issues: (data ?? []).map(normalizeIssue),
      });
    }
  );

  server.registerTool(
    "yt_get_board_columns",
    {
      title: "Get board columns",
      description:
        "Get board columns (stages) with their issue counts where available.\n\n" +
        "For Kanban boards columns come from the pivot field values; this " +
        "returns each column's name and query.",
      inputSchema: {
        board_id: z.string().describe("Board id or name"),
      },
    },
    async ({ board_id }) =>
      boardCall(
        getClient,
        async (client) => {
          const data = await client.get(
            `/agiles/${encodeURIComponent(board_id)}/columns`,
            { params: { fields: "name,id,query,color" } }
          );
          return jsonResult(data);
        },
        `Board "${board_id}": column/stage data is not exposed by this YouTrack ` +
          "server (/agiles/{id}/columns -> 404)."
      )
  );

  server.registerTool(
    "yt_list_projects",
    {
      title: "List projects",
      description: "List all projects visible to the token's user.",
      inputSchema: {},
    },
    async () => {
      const client = getClient();
      const data = await client.get("/admin/projects", {
        params: { fields: "id,name,shortName,archived" },
      });
      return jsonResult(data ?? []);
    }
  );

  server.registerTool(
    "yt_get_project_issues",
    {
      title: "List project issues",
      description: "List issues of a project (by name or short name).",
      inputSchema: {
        project: z.string().describe("Project name or short name"),
        query: z.string().default("").describe("Extra YouTrack query filter"),
        max_results: z.number().int().default(50).describe("Max number of results"),
      },
    },
    async ({ project, query, max_results }) => {
      const client = getClient();
      const fullQuery = `project:${project}` + (query ? ` ${query}` : "");
      const data = await client.get("/issues", {
        params: {
          query: fullQuery,
          $top: max_results,
          fields: SHORT_ISSUE_FIELDS,
        },
      });
      return jsonResult((data ?? []).map(normalizeIssue));
    }
  );

  server.registerTool(
    "yt_get_issue_states",
    {
      title: "List issue states",
      description:
        "List available issue states (useful before running '#State ...').\n\n" +
        "If `project` is given, only states used in that project are returned.",
      inputSchema: {
        project: z.string().default("").describe("Optional project name/short name"),
      },
    },
    async ({ project }) => {
      const client = getClient();
      const result = await getProjectFields(client, project, "State");
      if (result.error) return jsonResult({ error: result.error });
      const values = result.fields?.[0]?.values ?? null;
      if (values === null) {
        return jsonResult({
          error:
            "State values are not exposed by this YouTrack instance " +
            "(admin customFields API returns 404 — likely insufficient " +
            "token permissions). Use yt_search_issues to discover states in practice.",
        });
      }
      return jsonResult(values);
    }
  );

  server.registerTool(
    "yt_search_users",
    {
      title: "Search users",
      description:
        "Find users by login/name (e.g. to set an assignee via commands).\n\n" +
        "Note: this instance matches by login/name prefix, not substring.",
      inputSchema: {
        query: z.string().describe("Login/name prefix"),
        max_results: z.number().int().default(10).describe("Max number of results"),
      },
    },
    async ({ query, max_results }) => {
      const client = getClient();
      const data = await client.get("/users", {
        params: {
          query,
          $top: max_results,
          fields: "login,name,email",
        },
      });
      return jsonResult(data ?? []);
    }
  );
}
