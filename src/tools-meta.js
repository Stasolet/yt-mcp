/**
 * Project metadata & raw read-only access tools.
 *
 * yt_get_project_fields answers "which values are accepted at all" — without
 * it the only way to discover bundle values was to aggregate them from other
 * issues. Uses the admin customFields API; on instances/tokens where it is
 * hidden (404) the tools degrade with an explanatory message.
 */
import { z } from "zod";
import { resolveProjectId } from "./tools-issues.js";

const FIELD_LIST_FIELDS = "id,name,$type";
const VALUE_FIELDS = "name,presentation,localizedName,isDefault";

function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data ?? null, null, 2) }] };
}

function isNotFound(err) {
  return err?.name === "YouTrackError" && err.statusCode === 404;
}

function hasBundle(f) {
  return String(f.$type ?? "").toLowerCase().includes("bundle");
}

// Non-admin tokens see no customFields metadata on this instance (the admin
// API answers 200 with an empty list). The next best thing: collect the
// values actually used by recent issues of the project.
async function aggregateFieldValues(client, projectRef, limit = 100) {
  const rows = await client.get("/issues", {
    params: {
      query: `project:${projectRef}`,
      $top: limit,
      fields: "customFields(name,value(name))",
    },
  });
  const map = new Map();
  for (const row of rows ?? []) {
    for (const cf of row.customFields ?? []) {
      if (!cf.name) continue;
      const vals = Array.isArray(cf.value)
        ? cf.value
        : cf.value?.name
          ? [cf.value]
          : [];
      if (!vals.length) continue;
      if (!map.has(cf.name)) map.set(cf.name, new Map());
      for (const v of vals) {
        if (!map.get(cf.name).has(v.name)) map.get(cf.name).set(v.name, 0);
        map.get(cf.name).set(v.name, map.get(cf.name).get(v.name) + 1);
      }
    }
  }
  return map;
}

/**
 * Returns { fields: [...] } or { error: "..." }. Each field is
 * { name, type, values?: [{name, presentation, isDefault}] }.
 */
export async function getProjectFields(client, project, field = "") {
  let projectRef = project;
  if (!projectRef) {
    const projects = await client.get("/admin/projects", {
      params: { fields: "shortName" },
    });
    projectRef = projects?.[0]?.shortName;
    if (!projectRef) {
      return { error: "No project given and none visible to this token." };
    }
  }
  try {
    const needle = field ? field.toLowerCase() : "";
    const fields = await client.get(
      `/admin/projects/${encodeURIComponent(projectRef)}/customFields`,
      { params: { fields: FIELD_LIST_FIELDS } }
    );
    if ((fields ?? []).length === 0) {
      const observed = await aggregateFieldValues(client, projectRef);
      if (observed.size === 0) {
        return {
          error:
            `Custom fields of project ${projectRef} are not exposed by this ` +
            "YouTrack instance (admin API returns an empty list and no issue " +
            "carries field values).",
        };
      }
      const fallback = [...observed.entries()]
        .filter(([name]) => !needle || name.toLowerCase() === needle)
        .map(([name, counts]) => ({
          name,
          type: null,
          source: "observed",
          values: [...counts.entries()].map(([v, count]) => ({
            name: v,
            presentation: v,
            isDefault: false,
            seen: count,
          })),
        }));
      return {
        project: projectRef,
        note:
          "Admin customFields API is not visible to this token; values are " +
          "aggregated from recent issues and may be incomplete.",
        fields: fallback,
      };
    }
    const selected = needle
      ? (fields ?? []).filter((f) => f.name?.toLowerCase() === needle)
      : (fields ?? []);
    if (needle && selected.length === 0) {
      return {
        error: `Field "${field}" not found on project ${projectRef}.`,
        available: (fields ?? []).map((f) => f.name),
      };
    }
    const withValues = await Promise.all(
      selected.map(async (f) => {
        if (!hasBundle(f)) return { name: f.name, type: f.$type };
        const values = await client
          .get(`/admin/customFields/${f.id}/values`, {
            params: { fields: VALUE_FIELDS },
          })
          .catch((err) => (isNotFound(err) ? null : Promise.reject(err)));
        return {
          name: f.name,
          type: f.$type,
          values:
            values?.map((v) => ({
              name: v.name,
              presentation: v.presentation ?? v.localizedName ?? v.name,
              isDefault: v.isDefault ?? false,
            })) ?? null,
        };
      })
    );
    if (withValues.some((f) => f.values === null)) {
      const observed = await aggregateFieldValues(client, projectRef);
      for (const f of withValues) {
        if (f.values === null && observed.has(f.name)) {
          f.source = "observed";
          f.values = [...observed.get(f.name).keys()].map((v) => ({
            name: v,
            presentation: v,
            isDefault: false,
          }));
        }
      }
    }
    return { project: projectRef, fields: withValues };
  } catch (err) {
    if (isNotFound(err)) {
      return {
        error:
          `Custom fields of project ${projectRef} are not exposed by this ` +
          "YouTrack instance (admin customFields API returns 404 — likely " +
          "insufficient token permissions).",
      };
    }
    throw err;
  }
}

export function registerMetaTools(server, getClient) {
  server.registerTool(
    "yt_get_project_fields",
    {
      title: "List project custom fields and allowed values",
      description:
        "List the custom fields of a project with their types and, for bundle " +
        "fields (State, Priority, Type, Subsystem, ...), the accepted values.\n\n" +
        "Check values here before building commands like '#Subsystem <value>'.\n" +
        "`field` narrows the output to one field (case-insensitive name).",
      inputSchema: {
        project: z.string().default("").describe("Project name or short name; defaults to the first visible project"),
        field: z.string().default("").describe("Optional single field name, e.g. 'Subsystem'"),
      },
    },
    async ({ project, field }) => {
      const client = getClient();
      const data = await getProjectFields(client, project, field);
      return jsonResult(data);
    }
  );

  server.registerTool(
    "yt_rest_get",
    {
      title: "Raw GET to the YouTrack REST API",
      description:
        "Read-only escape hatch: GET /api{path} with arbitrary query params, " +
        "returning the raw JSON response (no normalization).\n\n" +
        "Use for endpoints without a dedicated tool. Write operations are NOT " +
        "available here — field changes must go through commands so that " +
        'workflows run. `params` is an object of query parameters, e.g. ' +
        '{"fields": "login,name", "$top": "5"}.',
      inputSchema: {
        path: z
          .string()
          .describe("API path starting with '/', e.g. '/users' or '/issues/ABC-1/attachments'"),
        params: z
          .record(z.union([z.string(), z.number()]))
          .default({})
          .describe("Query parameters"),
      },
    },
    async ({ path, params }) => {
      if (!path.startsWith("/") || path.includes("..")) {
        throw new Error("path must start with '/' and must not contain '..'");
      }
      const client = getClient();
      const data = await client.get(path, {
        params: Object.fromEntries(
          Object.entries(params ?? {}).map(([k, v]) => [k, String(v)])
        ),
      });
      return jsonResult(data);
    }
  );
}
