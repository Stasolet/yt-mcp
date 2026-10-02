/**
 * Board (Agile) & project MCP tools for YouTrack 2022.3.
 */
import { z } from "zod";

const BOARD_FIELDS =
  "id,name,projectRefs(project(name,shortName)),pivots(field(name)),author(login,name)";

const SHORT_ISSUE_FIELDS =
  "number,subject,state(name,presentation),assignee(login,name),priority(presentation)";

function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data ?? null, null, 2) }] };
}

export function registerBoardTools(server, getClient) {
  server.registerTool(
    "yt_list_boards",
    {
      title: "List Agile boards",
      description: "List all Agile boards the token's user can see.",
      inputSchema: {},
    },
    async () => {
      const client = getClient();
      const data = await client.get("/agiles", { params: { fields: BOARD_FIELDS } });
      return jsonResult(data ?? []);
    }
  );

  server.registerTool(
    "yt_get_board",
    {
      title: "Get an Agile board",
      description:
        "Get one board by its id or name.\n\n" +
        "YouTrack accepts both the internal id and the human-readable name " +
        "in the URL path (/api/agiles/{id}/), so pass either.",
      inputSchema: {
        board_id: z.string().describe("Board id or name"),
      },
    },
    async ({ board_id }) => {
      const client = getClient();
      const data = await client.get(`/agiles/${board_id}`, {
        params: { fields: `${BOARD_FIELDS},description` },
      });
      return jsonResult(data);
    }
  );

  server.registerTool(
    "yt_get_board_issues",
    {
      title: "List issues on a board",
      description:
        "List issues on a board (optionally filtered by extra query).\n\n" +
        "Uses GET /agiles/{id}/issues — works for Kanban and Scrum boards.",
      inputSchema: {
        board_id: z.string().describe("Board id or name"),
        query: z.string().default("").describe("Extra YouTrack query filter"),
        max_results: z.number().int().default(50).describe("Max number of results"),
      },
    },
    async ({ board_id, query, max_results }) => {
      const client = getClient();
      const params = { $top: max_results, fields: SHORT_ISSUE_FIELDS };
      if (query) params.query = query;
      const data = await client.get(`/agiles/${board_id}/issues`, { params });
      return jsonResult(data ?? []);
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
    async ({ board_id }) => {
      const client = getClient();
      const data = await client.get(`/agiles/${board_id}/columns`, {
        params: { fields: "name,id,query,color" },
      });
      return jsonResult(data ?? []);
    }
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
      const data = await client.get("/projects", {
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
      return jsonResult(data ?? []);
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
      if (project) {
        const data = await client.get(
          `/admin/projects/${project}/customFields/state/values`,
          { params: { fields: "$all,name,presentation" } }
        );
        return jsonResult((data ?? []).map((v) => v.element ?? v));
      }
      let data = await client.get("/admin/customFields/field64/options", {
        params: { fields: "name,presentation,localizedName,isDefault" },
      });
      if (!data || (Array.isArray(data) && data.length === 0)) {
        data = await client.get("/admin/customFields", {
          params: { fields: "$all" },
        });
      }
      return jsonResult(data ?? []);
    }
  );

  server.registerTool(
    "yt_search_users",
    {
      title: "Search users",
      description:
        "Find users by login/name (e.g. to set an assignee via commands).",
      inputSchema: {
        query: z.string().describe("Login/name substring"),
        max_results: z.number().int().default(10).describe("Max number of results"),
      },
    },
    async ({ query, max_results }) => {
      const client = getClient();
      const data = await client.get("/users", {
        params: {
          query,
          $top: max_results,
          fields: "login,name,email,avatar(url)",
        },
      });
      return jsonResult(data ?? []);
    }
  );
}
