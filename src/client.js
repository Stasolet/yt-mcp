/**
 * Thin async HTTP client for the YouTrack REST API.
 *
 * NOTE: youtrack.lab403.inforion.ru implements the "gaprest" transitional REST
 * API, NOT the documented 2022.3 one. Empirically (2026-10):
 *   * partial-response param is `fields` (plain, without `$`); `$fields` is ignored
 *   * pagination param is `$top` (`max`, `$max`, `count` are ignored)
 *   * issue entities use legacy names: `summary`, `numberInProject`,
 *     `customFields` (State/Priority/Type/Assignee/Subsystem live there)
 *   * commands: POST /api/commands with JSON body
 *     { command, query, issues: [{ id }] }  (query text must not contain '#',
 *     `issues` must carry already-resolved internal ids)
 *   * NO /api/agiles, NO /api/graphql, NO /api/me (but /api/users/me works)
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
   * Issue ids must be present in the string; they are resolved to internal
   * ids and passed via the `issues` array. This server instance does NOT
   * parse targets out of the command text.
   */
  async runCommand(command) {
    const ID_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
    const readableIds = [...new Set(command.match(ID_RE) ?? [])];
    if (readableIds.length === 0) {
      throw new Error(
        'No issue ids (e.g. "ABC-123") found in the command string.'
      );
    }
    const text = command.replace(ID_RE, " ").replace(/\s+/g, " ").trim();
    if (!text) {
      throw new Error("The command contains only issue ids, nothing to apply.");
    }
    const issues = await Promise.all(
      readableIds.map(async (rid) => {
        const issue = await this.get(`/issues/${encodeURIComponent(rid)}`, {
          params: { fields: "id" },
        });
        if (!issue?.id) throw new Error(`Cannot resolve issue ${rid}`);
        return { id: issue.id };
      })
    );
    const data = await this.post("/commands", {
      json: { command: text, query: text.replace(/#/g, ""), issues },
    });
    return { output: data?.output ?? "Done", error: data?.error ?? "" };
  }
}
