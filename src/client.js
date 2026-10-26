/**
 * Thin async HTTP client for the YouTrack REST API.
 *
 * NOTE: youtrack.lab403.inforion.ru implements the "gaprest" transitional REST
 * API, NOT the documented 2023.3 one. Empirically (2026-10):
 *   * partial-response param is `fields` (plain, without `$`); `$fields` is ignored
 *   * pagination param is `$top` (`max`, `$max`, `count` are ignored)
 *   * issue entities use legacy names: `summary`, `numberInProject`,
 *     `customFields` (State/Priority/Type/Assignee/Subsystem live there)
 *   * commands: POST /api/commands with JSON body
 *     { command, query, issues: [{ id }] }  (query text must not contain '#',
 *     `issues` must carry already-resolved internal ids)
 *   * NO /api/agiles, NO /api/graphql, NO /api/me (but /api/users/me works)
 *   * issue links: creatable only via web-UI command form "#Relates to
 *     TARGET SOURCE" (target id stays in the query text); the "link ..."
 *     verb and the "-" removal form do not exist here, the /links
 *     endpoint is stubbed (GET placeholders, other methods 405) — links
 *     are readable via search ("relates to: ID") only, removable in the
 *     web UI only; see docs/youtrack-links.md
 *   * "tag <text>" auto-creates a tag named <text>; "tag -X" creates a
 *     literal tag "-X" — tag removal is REST only:
 *     DELETE /issues/{id}/tags/{tagId} (yt_remove_tag)
 *
 * Authentication: permanent token via the "Bearer" Authorization header.
 * Uses the built-in fetch (Node >= 18) — no external HTTP dependency.
 */

export class YouTrackError extends Error {
  constructor(statusCode, message) {
    super(`YouTrack API error ${statusCode}: ${message}`);
    this.name = "YouTrackError";
    this.statusCode = statusCode;
    this.message = message;
  }
}

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v ?? ""));
}

export class YouTrackClient {
  constructor(baseUrl, token, timeoutMs = 30_000) {
    this.baseUrl = (baseUrl || process.env.YOUTRACK_URL || "").replace(/\/+$/, "");
    this.token = token || process.env.YOUTRACK_TOKEN || "";
    if (!this.baseUrl) {
      throw new Error(
        "YOUTRACK_URL is not set. Example: https://youtrack.example.com"
      );
    }
    if (!this.token) {
      throw new Error(
        "YOUTRACK_TOKEN is not set. Generate a permanent token in YouTrack: " +
          "Profile -> Applications -> Generate token."
      );
    }
    if (truthy(process.env.YOUTRACK_TLS_INSECURE)) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      console.error(
        "youtrack-mcp: TLS certificate verification is DISABLED " +
          "(YOUTRACK_TLS_INSECURE) — intended for internal self-signed instances."
      );
    }
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, { params = undefined, json = undefined } = {}) {
    const url = new URL(`/api${path}`, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let resp;
    try {
      resp = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: json !== undefined ? JSON.stringify(json) : undefined,
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (err) {
      const cause = err?.cause?.code || err?.cause?.message || "";
      let hint = "";
      if (/certificate/i.test(cause)) {
        hint =
          " — the server uses a self-signed/internal CA certificate. Set " +
          "YOUTRACK_TLS_INSECURE=1 (or NODE_EXTRA_CA_CERTS=/path/to/ca.pem) " +
          "in the MCP server environment.";
      }
      throw new Error(`${method} ${url}: ${err.message}${cause ? ` (${cause})` : ""}${hint}`);
    } finally {
      clearTimeout(timer);
    }

    if (resp.status >= 400) {
      let detail;
      const text = await resp.text().catch(() => "");
      try {
        detail = JSON.stringify(JSON.parse(text));
      } catch {
        detail = text;
      }
      throw new YouTrackError(resp.status, detail);
    }
    if (resp.status === 204) return null;
    const text = await resp.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  // ---------- convenience wrappers ----------

  get(path, opts = {}) {
    return this.request("GET", path, opts);
  }

  post(path, opts = {}) {
    return this.request("POST", path, opts);
  }

  put(path, opts = {}) {
    return this.request("PUT", path, opts);
  }

  delete(path, opts = {}) {
    return this.request("DELETE", path, opts);
  }

  // ---------- commands ----------

  /**
   * Execute a YouTrack command string, e.g. "#State Fixed ABC-123".
   *
   * Plain commands: every issue id is stripped from the query text and
   * passed via the resolved `issues` array — the gateway parser swallows
   * ids left in the query into the field value ("State Won't Fix ABC-1"
   * is validated as value "Won't Fix ABC-1").
   *
   * Link commands ("#Relates to TARGET SRC...", "#Subtask Of PARENT
   * CHILD..."): this gateway resolves the link target out of the query
   * text, so the FIRST id stays in the query and the remaining ids are
   * applied as sources (verified live 2026-10, docs/youtrack-links.md).
   *
   * The documented "link <type> ..." form is not a command here ("link"
   * is unknown to the gateway) — fail fast so agents do not brute-force
   * syntax variants against the API.
   *
   * Removal commands ("tag -Foo", "#-Relates to ...") are NOT
   * implemented by this gateway: a token starting with "-" becomes part
   * of a literal value/tag ("tag -Foo" CREATES tag "-Foo"), so such
   * commands are rejected client-side.
   *
   * Empirically this instance rejects single-word bundle values wrapped
   * in curly braces ("#Subsystem {Backend}" -> 400 "Subsystem expected:
   * {Backend}"), so on such a rejection the command is retried once
   * with braces removed from brace groups that contain no spaces.
   */
  async runCommand(command) {
    const ID_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
    const allIds = command.match(ID_RE) ?? [];
    const readableIds = [...new Set(allIds)];
    if (readableIds.length === 0) {
      throw new Error(
        'No issue ids (e.g. "ABC-123") found in the command string.'
      );
    }
    const text = command.replace(ID_RE, " ").replace(/\s+/g, " ").trim();
    if (!text) {
      throw new Error("The command contains only issue ids, nothing to apply.");
    }
    if (/^#?\s*links?\b/i.test(text)) {
      throw new Error(
        `"link ..." is not a command on this YouTrack gateway. Use the web-UI ` +
        `command form instead: "#Relates to <TARGET-ID> <SOURCE-ID ...>" ` +
        `(target first, then the issues to apply it to). Links can be created ` +
        `this way but NOT removed — link removal works in the YouTrack web UI ` +
        `only. Details: docs/youtrack-links.md.`
      );
    }
    // Verified garbage/unknown outcomes of the "-" removal form on this
    // gateway: "tag -Foo" CREATES a literal tag "-Foo", and "#-Relates to"
    // fails as "Unknown command: -". Other "-value" commands are rare and
    // harmless (bundle validation), so only these two shapes are blocked.
    const firstToken = text.replace(/^#\s*/, "").split(/\s+/)[0] ?? "";
    if (firstToken.startsWith("-")) {
      throw new Error(
        `This gateway does not implement the "-" removal form of commands ` +
        `("${text}"). Remove tags with yt_remove_tag; remove links in the ` +
        `YouTrack web UI. Details: docs/youtrack-links.md.`
      );
    }
    if (/^#?\s*tag\b/i.test(text) && /(^|\s)-\S/.test(text)) {
      throw new Error(
        `"tag -Foo" does not remove a tag on this gateway — it CREATES a tag ` +
        `literally named "-Foo". Remove tags with yt_remove_tag instead.`
      );
    }

    // UI command wordings the gateway actually recognizes (live-probed
    // 2026-10: each reaches issue resolution). "link <type>", "Parent",
    // "Child", "Has subtask", "Blocked by", bare "Depend"/"Duplicate" are
    // NOT commands here.
    // A non-anchored phrase: link wordings after leading ids
    // ("ABC-1 #Relates to ABC-9") must also enter this branch, otherwise
    // the silent direction inversion goes undetected.
    const LINK_SHAPE_ANY =
      /(?:^|\s)#?\s*(?:relates?\s+to|subtask\s+of|duplicates\b|duplicated\s+by|depends\s+on|is\s+required\s+for)\b/i;
    let execText = text;
    let sourceIds = readableIds;
    const shape = command.match(LINK_SHAPE_ANY);
    if (shape) {
      // The link target must be the first id AFTER the command phrase; the
      // target keeps its place in the query text, the remaining ids are
      // the sources. Split on the original command — in `text` the ids are
      // already stripped, so their order is invisible there.
      const afterPhrase = command.slice(shape.index + shape[0].length);
      const firstInCommand = (command.match(ID_RE) ?? [])[0];
      const target = (afterPhrase.match(ID_RE) ?? [])[0];
      if (target && firstInCommand !== target) {
        throw new Error(
          `The link command "${command.trim()}" has an id before the command ` +
          `phrase, which silently inverts the link direction (removal is ` +
          `web-UI only). Put the target id right after the command phrase: ` +
          `"<PHRASE> <TARGET-ID> <SOURCE-ID ...>"` +
          ` — the target stays in the text, the other issues are applied.`
        );
      }
      if (!target) {
        throw new Error(
          `A link command needs a target and at least one source issue: ` +
          `"<PHRASE> <TARGET-ID> <SOURCE-ID ...>" — the id right after the ` +
          `command phrase is the link target, the rest are the issues the ` +
          `link is created on.`
        );
      }
      sourceIds = readableIds.filter((id) => id !== target);
      if (sourceIds.length === 0) {
        throw new Error(
          `A link command needs a target and at least one source issue: ` +
          `"<PHRASE> ${target} <SOURCE-ID ...>" — the id right after the ` +
          `command phrase is the link target, the rest are the issues the ` +
          `link is created on.`
        );
      }
      let q = command.trim().replace(/\{([A-Z][A-Z0-9]+-\d+)\}/g, "$1");
      for (const id of sourceIds) {
        q = q.replace(new RegExp(`\\b${id}\\b`, "g"), " ");
      }
      execText = q.replace(/\s+/g, " ").trim();
    }

    const issues = await Promise.all(
      sourceIds.map(async (rid) => {
        const issue = await this.get(`/issues/${encodeURIComponent(rid)}`, {
          params: { fields: "id" },
        });
        if (!issue?.id) throw new Error(`Cannot resolve issue ${rid}`);
        return { id: issue.id };
      })
    );
    const exec = (cmd) =>
      this.post("/commands", {
        json: { command: cmd, query: cmd.replace(/#/g, ""), issues },
      });

    let data;
    let firstErr = null;
    try {
      data = await exec(execText);
    } catch (err) {
      firstErr = err;
      const stripped = execText.replace(/\{([^{}\s]+)\}/g, "$1");
      const retryable =
        err?.statusCode === 400 && /expected/i.test(err.message ?? "") &&
        stripped !== execText;
      if (retryable) {
        try {
          data = await exec(stripped);
        } catch (err2) {
          throw new Error(
            `${err2.message} — retry without curly braces ("${stripped}") ` +
            `also failed; original error: ${err.message}`
          );
        }
      }
    }
    if (data === undefined) {
      if (/\{[^{}\s]+\}/.test(text)) {
        firstErr.message +=
          " — hint: this instance may reject single-word bundle values in " +
          'curly braces; write them plain, e.g. "#Subsystem Backend".';
      }
      throw firstErr;
    }
    return { output: data?.output ?? "Done", error: data?.error ?? "" };
  }
}
