/**
 * Thin async HTTP client for the YouTrack REST API (2022.3).
 *
 * YouTrack 2022..x exposes:
 *   * REST /api — primary API used here (issues, projects, boards/agiles, commands)
 *   * GraphQL /api/graphql — not used in this server yet
 *
 * Authentication: permanent token sent via the "Bearer" Authorization header.
 * Tokens are issued per-user in YouTrack: Profile -> Applications -> Generate Token.
 * The GitLab integration (16.8) does NOT provide an API token; it only syncs
 * vcs-references. We always talk to YouTrack directly.
 *
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
    this.timeoutMs = timeoutMs;
  }

  /**
   * YouTrack uses $params/$fields query params; URLSearchParams encodes "$" fine.
   */
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
   * Execute a YouTrack command string (POST /admin/commands?command=...).
   *
   * This mirrors the CLI from the Command Reference docs but goes through
   * the REST API, which is available in 2022.3.
   * Returns { output: string, error: string }.
   */
  async runCommand(command) {
    const data = await this.post("/admin/commands", { params: { command } });
    return data ?? { output: "", error: "" };
  }
}
