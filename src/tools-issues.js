/**
 * Issue-related MCP tools.
 *
 * This server speaks the legacy ("gaprest") YouTrack REST entity model:
 * `summary` instead of `subject`, and State/Priority/Type/Assignee/Subsystem
 * live in `customFields`. Responses are normalized into a compact shape.
 */
import { z } from "zod";

const ISSUE_FIELDS =
  "id,numberInProject,project(shortName,name),summary,description," +
  "reporter(login,name),created,updated,tags(name)," +
  "customFields(name,$type,value(name,localizedName,login))";

function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data ?? null, null, 2) }] };
}

function cfValue(issue, name) {
  const field = (issue?.customFields ?? []).find((f) => f.name === name);
  return field ? field.value ?? null : null;
}

function bundleName(value) {
  if (!value) return undefined;
  return value.name ?? value.localizedName ?? undefined;
}

export function normalizeIssue(i) {
  if (!i) return i;
  const out = {
    id: i.id,
    number:
      i.readableNumber ??
      (i.project?.shortName != null && i.numberInProject != null
        ? `${i.project.shortName}-${i.numberInProject}`
        : undefined),
    subject: i.summary ?? i.subject,
    description: i.description,
    project: i.project?.shortName ?? i.project?.name,
    state: bundleName(cfValue(i, "State")),
    priority: bundleName(cfValue(i, "Priority")),
    type: bundleName(cfValue(i, "Type")),
    subsystem: bundleName(cfValue(i, "Subsystem")),
    assignee: (cfValue(i, "Assignee") ?? []).map((u) => ({
      login: u.login,
      name: u.name,
    })),
    reporter: i.reporter
      ? { login: i.reporter.login, name: i.reporter.name }
      : undefined,
    tags: (i.tags ?? []).map((t) => t.name),
    created: i.created,
    updated: i.updated,
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined ||
        (Array.isArray(out[key]) && out[key].length === 0 && key !== "subject")) {
      delete out[key];
    }
  }
  return out;
}

async function resolveProjectId(client, project) {
  const projects = await client.get("/admin/projects", {
    params: { fields: "id,name,shortName" },
  });
  const needle = project.toLowerCase();
  const found = (projects ?? []).find(
    (p) => p.shortName?.toLowerCase() === needle || p.name?.toLowerCase() === needle
  );
  if (!found) throw new Error(`Project not found: ${project}`);
  return found;
}

export function registerIssueTools(server, getClient) {
  server.registerTool(
    "yt_search_issues",
    {
      title: "Search YouTrack issues",
      description:
        "Search issues with a YouTrack query (YouTrack Search Language).\n\n" +
        "Examples of `query`:\n" +
        "  - 'State: Unresolved project:ABC'\n" +
        "  - 'tag: {GitLab merge request} assignee: me()'",
      inputSchema: {
        query: z.string().describe("YouTrack Search Language query"),
        max_results: z.number().int().default(25).describe("Max number of results"),
        fields: z.string().default(ISSUE_FIELDS).describe("YouTrack field selector"),
      },
    },
    async ({ query, max_results, fields }) => {
      const client = getClient();
      const data = await client.get("/issues", {
        params: { query, $top: max_results, fields },
      });
      return jsonResult((data ?? []).map(normalizeIssue));
    }
  );

  server.registerTool(
    "yt_get_issue",
    {
      title: "Get a YouTrack issue",
      description:
        "Get a single issue by its ID (e.g. 'ABC-123') with the main fields " +
        "(subject, description, state, priority, assignee, tags, links).",
      inputSchema: {
        issue_id: z.string().describe("Issue ID, e.g. 'ABC-123'"),
      },
    },
    async ({ issue_id }) => {
      const client = getClient();
      const data = await client.get(`/issues/${encodeURIComponent(issue_id)}`, {
        params: { fields: ISSUE_FIELDS },
      });
      return jsonResult(normalizeIssue(data));
    }
  );

  server.registerTool(
    "yt_create_issue",
    {
      title: "Create a YouTrack issue",
      description:
        "Create an issue in a project (by name or short name, e.g. 'ABC').\n\n" +
        "`command` is an optional YouTrack command applied right after creation,\n" +
        "e.g. '#State Backlog #Priority Medium'.\n" +
        "Returns the created issue (id + number).",
      inputSchema: {
        project: z.string().describe("Project name or short name, e.g. 'ABC'"),
        subject: z.string().describe("Issue summary"),
        description: z.string().default("").describe("Issue description"),
        command: z.string().default("").describe("Optional command applied after creation"),
      },
    },
    async ({ project, subject, description, command }) => {
      const client = getClient();
      const proj = await resolveProjectId(client, project);
      const body = { project: { id: proj.id }, summary: subject };
      if (description) body.description = description;
      const created = await client.post("/issues", {
        json: body,
        params: { fields: "id" },
      });
      if (command && created?.id) {
        const full = await client.get(`/issues/${created.id}`, {
          params: { fields: "project(shortName),numberInProject" },
        });
        const number = `${full.project?.shortName}-${full.numberInProject}`;
        const cmd = command.trimStart().startsWith("#")
          ? command.trim()
          : "#" + command.trim();
        await client.runCommand(`${cmd} ${number}`);
      }
      const data = await client.get(`/issues/${created.id}`, {
        params: { fields: ISSUE_FIELDS },
      });
      return jsonResult(normalizeIssue(data));
    }
  );

  server.registerTool(
    "yt_apply_command",
    {
      title: "Apply a YouTrack command",
      description:
        "Apply an arbitrary YouTrack command to issues.\n\n" +
        "Command syntax follows the YouTrack Command Reference, e.g.:\n" +
        "  - '#State Fixed ABC-123'                 -> set state\n" +
        "  - 'tag -{Feature Bug} ABC-123 ABC-124'   -> remove tag from issues\n" +
        "  - '#assignee john ABC-123'               -> set assignee\n" +
        "The target issue IDs must be included INSIDE the command string.",
      inputSchema: {
        command: z.string().describe("YouTrack command string"),
      },
    },
    async ({ command }) => {
      const client = getClient();
      const data = await client.runCommand(command);
      return jsonResult(data);
    }
  );

  server.registerTool(
    "yt_update_issue",
    {
      title: "Update issue subject/description",
      description:
        "Update subject/description of an issue directly.\n\n" +
        "For state/priority/tags/assignee use yt_apply_command instead —\n" +
        "YouTrack workflows react to commands, not raw field writes.",
      inputSchema: {
        issue_id: z.string().describe("Issue ID, e.g. 'ABC-123'"),
        subject: z.string().optional().describe("New subject"),
        description: z.string().optional().describe("New description"),
      },
    },
    async ({ issue_id, subject, description }) => {
      const client = getClient();
      const body = {};
      if (subject !== undefined) body.summary = subject;
      if (description !== undefined) body.description = description;
      if (Object.keys(body).length === 0) {
        throw new Error("Nothing to update: pass subject and/or description.");
      }
      await client.post(`/issues/${encodeURIComponent(issue_id)}`, { json: body });
      const data = await client.get(`/issues/${encodeURIComponent(issue_id)}`, {
        params: {
          fields: "id,project(shortName),numberInProject,summary",
        },
      });
      return jsonResult(normalizeIssue(data));
    }
  );

  server.registerTool(
    "yt_get_comments",
    {
      title: "Get issue comments",
      description: "Get the latest comments of an issue.",
      inputSchema: {
        issue_id: z.string().describe("Issue ID, e.g. 'ABC-123'"),
        count: z.number().int().default(20).describe("Number of comments to fetch"),
      },
    },
    async ({ issue_id, count }) => {
      const client = getClient();
      const data = await client.get(
        `/issues/${encodeURIComponent(issue_id)}/comments`,
        {
          params: {
            $top: count,
            fields: "text,author(login,name),created,updated",
          },
        }
      );
      return jsonResult(data ?? []);
    }
  );

  server.registerTool(
    "yt_add_comment",
    {
      title: "Add an issue comment",
      description:
        "Add a comment to an issue. `visible_to` is an optional user/group " +
        "name restricting visibility.",
      inputSchema: {
        issue_id: z.string().describe("Issue ID, e.g. 'ABC-123'"),
        text: z.string().describe("Comment text"),
        visible_to: z.string().default("").describe("Optional user/group visibility restriction"),
      },
    },
    async ({ issue_id, text, visible_to }) => {
      const client = getClient();
      const body = { text };
      if (visible_to) body.permittedGroups = [{ name: visible_to }];
      const data = await client.post(
        `/issues/${encodeURIComponent(issue_id)}/comments`,
        { params: { fields: "id,text" }, json: body }
      );
      return jsonResult(data);
    }
  );

  server.registerTool(
    "yt_get_attachments",
    {
      title: "List issue attachments",
      description: "List attachments of an issue (name, url, content type).",
      inputSchema: {
        issue_id: z.string().describe("Issue ID, e.g. 'ABC-123'"),
      },
    },
    async ({ issue_id }) => {
      const client = getClient();
      const data = await client.get(
        `/issues/${encodeURIComponent(issue_id)}/attachments`,
        {
          params: {
            fields: "id,name,url,contentType,fileSize,author(login,name)",
          },
        }
      );
      return jsonResult(data ?? []);
    }
  );

  server.registerTool(
    "yt_get_vcs_references",
    {
      title: "Get GitLab VCS references",
      description:
        "Get GitLab VCS references (commits/MRs synced from GitLab) linked to " +
        "an issue via the YouTrack GitLab integration.",
      inputSchema: {
        issue_id: z.string().describe("Issue ID, e.g. 'ABC-123'"),
      },
    },
    async ({ issue_id }) => {
      const client = getClient();
      const links = await client.get(
        `/issues/${encodeURIComponent(issue_id)}/links`,
        { params: { fields: "$all" } }
      );
      const result = (links ?? []).filter(
        (link) =>
          link.$type === "vcs-issue-link" ||
          String(link.$type ?? "").toLowerCase().includes("vcs") ||
          String(link.srcId ?? link.name ?? "").toLowerCase().includes("vcs")
      );
      if (links?.length && result.length === 0) {
        return jsonResult({
          note:
            "No VCS-type links found. Note: this server instance may return " +
            "issue links without detail fields (permissions/API version).",
          links,
        });
      }
      return jsonResult(result);
    }
  );
}
