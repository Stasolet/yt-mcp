"""Thin async HTTP client for the YouTrack REST API (2022.3).

YouTrack 2022..x exposes:
  * REST /api — primary API used here (issues, projects, boards/agiles, commands)
  * GraphQL /api/graphql — not used in this server yet

Authentication: permanent token sent via the "Bearer" Authorization header.
Tokens are issued per-user in YouTrack: Profile -> Applications -> Generate Token.
The GitLab integration (16.8) does NOT provide an API token; it only syncs
vcs-references. We always talk to YouTrack directly.
"""

from __future__ import annotations

import os
from typing import Any, Optional

import httpx


class YouTrackError(RuntimeError):
    def __init__(self, status_code: int, message: str):
        super().__init__(f"YouTrack API error {status_code}: {message}")
        self.status_code = status_code
        self.message = message


class YouTrackClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        timeout: float = 30.0,
    ):
        self.base_url = (base_url or os.environ.get("YOUTRACK_URL", "")).rstrip("/")
        self.token = token or os.environ.get("YOUTRACK_TOKEN", "")
        if not self.base_url:
            raise ValueError(
                "YOUTRACK_URL is not set. Example: https://youtrack.example.com"
            )
        if not self.token:
            raise ValueError(
                "YOUTRACK_TOKEN is not set. Generate a permanent token in YouTrack: "
                "Profile -> Applications -> Generate token."
            )
        self._client = httpx.AsyncClient(
            base_url=self.base_url + "/api",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/json",
            },
            timeout=timeout,
            follow_redirects=True,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict[str, Any]] = None,
        json: Optional[Any] = None,
    ) -> Any:
        # YouTrack uses $params/$fields query params; httpx encodes "$" fine.
        resp = await self._client.request(method, path, params=params, json=json)
        if resp.status_code >= 400:
            try:
                detail = resp.json()
            except Exception:
                detail = resp.text
            raise YouTrackError(resp.status_code, str(detail))
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    # ---------- convenience wrappers ----------

    async def get(self, path: str, **kw) -> Any:
        return await self.request("GET", path, **kw)

    async def post(self, path: str, **kw) -> Any:
        return await self.request("POST", path, **kw)

    async def put(self, path: str, **kw) -> Any:
        return await self.request("PUT", path, **kw)

    async def delete(self, path: str, **kw) -> Any:
        return await self.request("DELETE", path, **kw)

    # ---------- commands ----------

    async def run_command(self, command: str) -> dict:
        """Execute a YouTrack command string (POST /admin/commands?command=...).

        This mirrors the CLI from the Command Reference docs but goes through
        the REST API, which is available in 2022.3.
        Returns {"output": str, "error": str}.
        """
        data = await self.post(
            "/admin/commands",
            params={"command": command},
        )
        return data or {"output": "", "error": ""}
