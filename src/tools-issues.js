/**
 * Issue-related MCP tools.
 *
 * This server speaks the legacy ("gaprest") YouTrack REST entity model:
 * `summary` instead of `subject`, and State/Priority/Type/Assignee/Subsystem
 * live in `customFields`. Responses are normalized into a compact shape.
 */
import { z } from "zod";
import { YouTrackError } from "./client.js";

const ISSUE_FIELDS =
  "id,numberInProject,project(shortName,name),summary,description," +
  "reporter(login,name),created,updated,tags(name)," +
  "customFields(name,$type,value(name,localizedName,login))";

const BASE_FIELDS =
  "id,numberInProject,project(shortName,name),summary," +
  "customFields(name,$type,value(name,localizedName,login))";

// Names the normalized output uses; on the wire they live in customFields,
// so asking for them in `fields` must not suppress the rest of the entity.
const FLAT_CF_NAMES = new Set([
  "state", "priority", "type", "subsystem", "assignee",
]);

// Both id forms appear in tool output and both are accepted by the API, so a
// caller that concatenates them ("ABC-" + internal id) is the common mistake.
const ISSUE_ID_DESC =
  "Issue ID: internal ('2-7310', field `id`) or readable ('ABC-123', field " +
  "`number`), copied verbatim from another tool's output";

export function buildFieldsParam(fields) {
  if (!fields || fields === ISSUE_FIELDS) return ISSUE_FIELDS;
  const extras = fields
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !FLAT_CF_NAMES.has(s.toLowerCase().replace(/\(.*$/, "")));
  const merged = new Set([...BASE_FIELDS.split(","), ...extras]);
  return [...merged].join(",");
}

const dateHint = () =>
  "Relative and comparison dates (`-2w`, `before: -3d`, `<2026-10-20`) are " +
  "rejected here; an absolute date (`created: 2026-10-20`) works. Re-run the " +
  "smallest query (`project:ABC sort by: updated desc`) and add one criterion " +
  "at a time.";

/**
 * The gaprest search parser reports a rejection without naming a way out, and
 * the ways it rejects are specific to this instance (checked live 2026-10).
 * Returns a hint for the known shapes, or "" so an unrelated error keeps its
 * own text.
 */
export function searchErrorHint(message) {
  if (/Cannot parse fields query/i.test(message)) {
    return (
      "The `fields` selector is sent verbatim. One (…) group per name parses " +
      "(`value(name,localizedName)`); a second group on the same name " +
      "(`typeOf(t)(name)`) is what this error means. Omitting `fields` is " +
      "usually enough — the baseline needed for normalization is merged in."
    );
  }
  if (/Can't recognize\s*[()]/i.test(message)) {
    return (
      "This parser does not support function syntax: `assignee: me()` fails, " +
      "write a login (`assignee: john.doe`). yt_search_users lists them."
    );
  }
  const badValue = message.match(/isn't used for the (.+?) field/i);
  if (badValue) {
    const field = badValue[1].trim();
    // Date fields report a rejected period with this same wording, and naming
    // a bundle lookup for them would send the caller to the wrong tool.
    if (/creat|updat|resolv|date|period/i.test(field)) {
      return dateHint();
    }
    const lookup =
      field.toLowerCase() === "state"
        ? "yt_get_issue_states, or yt_get_project_fields with field: 'State'"
        : `yt_get_project_fields with field: '${field}'`;
    return (
      `Accepted values of '${field}': ${lookup}. Multi-word bundle values ` +
      `("In Progress", "To be discussed") are rejected here in every quoting ` +
      `form — filter on a single-word value or the pseudo-value 'Unresolved' ` +
      `and select the rest from the result.`
    );
  }
  if (/Can't parse search query/i.test(message)) {
    return dateHint();
  }
  return "";
}

function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data ?? null, null, 2) }] };
}

// A command response carrying a non-empty `error` is a failure, even though
// the HTTP request itself succeeded (gaprest returns {output, error} with 200).
function commandResult(data) {
  const res = jsonResult(data);
  if (data?.error) res.isError = true;
  return res;
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

export async function resolveProjectId(client, project) {
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
        "Queries verified on this instance:\n" +
        "  - 'project:ABC state: Unresolved sort by: updated desc'\n" +
        "  - 'project:ABC state: -Fixed -Frozen'\n" +
        "  - 'project:ABC subsystem: Backend type: Task'\n" +
        "  - 'project:ABC assignee: john.doe'\n" +
        "  - 'project:ABC created: 2026-10-20'\n" +
        "  - '#ABC-123'  (plain text such as 'ABC-123' also matches other " +
        "issues by words)\n\n" +
        "This parser rejects: multi-word bundle values in every quoting form " +
        "('state: \"In Progress\"', 'state: In Progress', " +
        "'state: {\"To be discussed\"}') — use 'state: Unresolved' or a " +
        "single-word value and select the rest from the result; relative and " +
        "comparison dates ('-2w', 'before: -3d', '<2026-10-20'); 'me()' (write " +
        "a login); 'id: 2-7310'. Accepted bundle values come from " +
        "yt_get_project_fields.\n\n" +
        "`fields` is sent verbatim: one (…) group per name parses, a second " +
        "group on the same name fails. The baseline needed for normalization " +
        "(id, numberInProject, project, summary, customFields) is always " +
        "merged in; flat names like `subsystem` are accepted and ignored as " +
        "extras.",
      inputSchema: {
        query: z.string().describe("YouTrack Search Language query"),
        max_results: z.number().int().default(25).describe("Max number of results"),
        fields: z
          .string()
          .default(ISSUE_FIELDS)
          .describe(
            "YouTrack field selector. The baseline needed for normalization " +
            "(id, numberInProject, project, summary, customFields) is always " +
            "merged in; flat names like `subsystem` are accepted and ignored " +
            "as extras."
          ),
      },
    },
    async ({ query, max_results, fields }) => {
      const client = getClient();
      let data;
      try {
        data = await client.get("/issues", {
          params: { query, $top: max_results, fields: buildFieldsParam(fields) },
        });
      } catch (err) {
        const hint = searchErrorHint(err?.message ?? "");
        if (err instanceof YouTrackError && hint) {
          throw new YouTrackError(err.statusCode, `${err.message}\n\n${hint}`);
        }
        throw err;
      }
      return jsonResult((data ?? []).map(normalizeIssue));
    }
  );

  server.registerTool(
    "yt_get_issue",
    {
      title: "Get a YouTrack issue",
      description:
        "Get a single issue with the main fields (subject, description, state, " +
        "priority, assignee, tags, links).",
      inputSchema: {
        issue_id: z.string().describe(ISSUE_ID_DESC),
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
        "e.g. '#State Backlog #Priority Medium'. If the command fails, the\n" +
        "issue is still created and returned with a `command_error` field.\n" +
        "Fields the command does not set keep the project defaults, which are\n" +
        "often wrong for a new task ('Subsystem: Research' in MDPO), so pass a\n" +
        "command setting Type/Priority/Subsystem explicitly.\n" +
        "Returns the created issue (id + number).",
      inputSchema: {
        project: z.string().describe("Project name or short name, e.g. 'ABC'"),
        subject: z.string().describe("Issue summary"),
        description: z.string().default("").describe("Issue description (Markdown)"),
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
      let commandError = "";
      if (command && created?.id) {
        const full = await client.get(`/issues/${created.id}`, {
          params: { fields: "project(shortName),numberInProject" },
        });
        const number = `${full.project?.shortName}-${full.numberInProject}`;
        const cmd = command.trimStart().startsWith("#")
          ? command.trim()
          : "#" + command.trim();
        try {
          const res = await client.runCommand(`${cmd} ${number}`);
          if (res.error) commandError = res.error;
        } catch (err) {
          // The issue exists regardless — losing its id here is worse than
          // reporting a partial success.
          commandError = err.message;
        }
      }
      const data = await client.get(`/issues/${created.id}`, {
        params: { fields: ISSUE_FIELDS },
      });
      const issue = normalizeIssue(data);
      if (commandError) issue.command_error = commandError;
      return jsonResult(issue);
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
        "The target issue IDs must be included INSIDE the command string.\n\n" +
        "On this instance single-word bundle values are written WITHOUT curly " +
        "braces ('#Subsystem Backend', not '#Subsystem {Backend}'); commands " +
        "with braces are retried automatically once. Use yt_get_project_fields " +
        "to see the exact accepted values.",
      inputSchema: {
        command: z.string().describe("YouTrack command string"),
      },
    },
    async ({ command }) => {
      const client = getClient();
      const data = await client.runCommand(command);
      return commandResult(data);
    }
  );

  server.registerTool(
    "yt_update_issue",
    {
      title: "Update issue subject/description",
      description:
        "Update subject/description of an issue directly.\n\n" +
        "For state/priority/tags/assignee use yt_apply_command instead —\n" +
        "YouTrack workflows react to commands, not raw field writes.\n\n" +
        "`expected_updated` (the `updated` timestamp last read via " +
        "yt_get_issue) guards against overwriting concurrent edits: if the " +
        "issue changed in the meantime the update is rejected.",
      inputSchema: {
        issue_id: z.string().describe(ISSUE_ID_DESC),
        subject: z.string().optional().describe("New subject"),
        description: z.string().optional().describe("New description (Markdown)"),
        expected_updated: z
          .number()
          .int()
          .optional()
          .describe("Issue `updated` timestamp from the last read; abort on mismatch"),
      },
    },
    async ({ issue_id, subject, description, expected_updated }) => {
      const client = getClient();
      const body = {};
      if (subject !== undefined) body.summary = subject;
      if (description !== undefined) body.description = description;
      if (Object.keys(body).length === 0) {
        throw new Error("Nothing to update: pass subject and/or description.");
      }
      if (expected_updated !== undefined) {
        const current = await client.get(`/issues/${encodeURIComponent(issue_id)}`, {
          params: { fields: "updated" },
        });
        if (current?.updated !== undefined && current.updated !== expected_updated) {
          throw new Error(
            `Conflict: issue ${issue_id} was modified since the read ` +
            `(updated=${current.updated}, expected_updated=${expected_updated}). ` +
            "Re-read the issue and re-apply the change."
          );
        }
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
      description:
        "Get comments of an issue, newest first. Each comment carries `id` " +
        "(needed by yt_update_comment/yt_delete_comment), author, created.",
      inputSchema: {
        issue_id: z.string().describe(ISSUE_ID_DESC),
        count: z
          .number()
          .int()
          .default(20)
          .describe("Max number of comments to return, applied after sorting"),
        skip: z
          .number()
          .int()
          .default(0)
          .describe("Number of newest comments to skip (pagination)"),
      },
    },
    async ({ issue_id, count, skip }) => {
      const client = getClient();
      // This gaprest instance ignores `sortBy` on comments, and `$top` is
      // applied server-side before any sorting we could do — so fetch the
      // whole list (comments per issue are few) and order it here.
      const data = await client.get(
        `/issues/${encodeURIComponent(issue_id)}/comments`,
        {
          params: {
            fields: "id,text,author(login,name),created",
          },
        }
      );
      // Deleting a comment in the web UI keeps the entity with empty text;
      // tombstones are not worth returning.
      const sorted = (data ?? [])
        .filter((c) => c.text)
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
      return jsonResult(sorted.slice(skip, skip + count));
    }
  );

  server.registerTool(
    "yt_add_comment",
    {
      title: "Add an issue comment",
      description:
        "Add a comment to an issue. `visible_to` is an optional user/group " +
        "name restricting visibility.\n\n" +
        "YouTrack (>= 2019.1) renders comment text as Markdown VERBATIM: " +
        "backticks are inline code, headings are '#', '##', ... — do NOT " +
        "pre-escape backticks with backslashes. Legacy wiki markup " +
        "('h3.', '{{code}}', '{color}') does NOT render and shows as plain " +
        "text. Mistakes are fixable via yt_update_comment.\n\n" +
        "A long report can hide its detail in a collapsible block: " +
        "'<details><summary><b>Heading</b></summary>', an empty line, " +
        "the body in Markdown, an empty line, '</details>'. Without that " +
        "empty line the body still belongs to the HTML block and its " +
        "markup prints literally; with it, Markdown renders inside the " +
        "block — lists, `code`, links and attachment images " +
        "('![caption](file.png){width=70%}'). Write the heading bold " +
        "with <b>: Markdown on the <summary> line is not parsed, and a " +
        "plain heading reads like the text around it.",
      inputSchema: {
        issue_id: z.string().describe(ISSUE_ID_DESC),
        text: z.string().describe("Comment text in Markdown"),
        visible_to: z.string().default("").describe("Optional user/group visibility restriction"),
      },
    },
    async ({ issue_id, text, visible_to }) => {
      const client = getClient();
      const body = { text };
      if (visible_to) body.permittedGroups = [{ name: visible_to }];
      const data = await client.post(
        `/issues/${encodeURIComponent(issue_id)}/comments`,
        { params: { fields: "id,text,created,author(login)" }, json: body }
      );
      return jsonResult(data);
    }
  );

  server.registerTool(
    "yt_update_comment",
    {
      title: "Edit an issue comment",
      description:
        "Replace the text of an existing comment (text is Markdown, stored " +
        "verbatim, with the same formatting rules as yt_add_comment). Find " +
        "`comment_id` via yt_get_comments.",
      inputSchema: {
        issue_id: z.string().describe(ISSUE_ID_DESC),
        comment_id: z.string().describe("Comment ID, e.g. '4-10729'"),
        text: z.string().describe("New comment text"),
      },
    },
    async ({ issue_id, comment_id, text }) => {
      const client = getClient();
      // gaprest updates a nested resource by POSTing to its own path;
      // PUT on the same path returns 403 for permanent tokens.
      const data = await client.post(
        `/issues/${encodeURIComponent(issue_id)}/comments/${encodeURIComponent(comment_id)}`,
        { params: { fields: "id,text" }, json: { text } }
      );
      return jsonResult(data);
    }
  );

  server.registerTool(
    "yt_delete_comment",
    {
      title: "Delete an issue comment",
      description:
        "Delete a comment. Requires the token to hold the delete right — " +
        "if YouTrack answers 403, regenerate the permanent token with the " +
        "granted permission (the web UI deletes own comments regardless).",
      inputSchema: {
        issue_id: z.string().describe(ISSUE_ID_DESC),
        comment_id: z.string().describe("Comment ID, e.g. '4-10729'"),
      },
    },
    async ({ issue_id, comment_id }) => {
      const client = getClient();
      const path =
        `/issues/${encodeURIComponent(issue_id)}/comments/${encodeURIComponent(comment_id)}`;
      try {
        await client.delete(path);
      } catch (err) {
        if (err instanceof YouTrackError && err.statusCode === 403) {
          throw new YouTrackError(
            err.statusCode,
            err.message +
              " — the permanent token lacks permission to delete comments; " +
              "grant it (or delete the comment in the YouTrack web UI)."
          );
        }
        throw err;
      }
      return jsonResult({ deleted: true, issue_id, comment_id });
    }
  );

  server.registerTool(
    "yt_get_attachments",
    {
      title: "List issue attachments",
      description: "List attachments of an issue (name, url, content type).",
      inputSchema: {
        issue_id: z.string().describe(ISSUE_ID_DESC),
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
        issue_id: z.string().describe(ISSUE_ID_DESC),
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
