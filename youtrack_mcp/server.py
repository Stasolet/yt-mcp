"""YouTrack MCP server (YouTrack 2022.3, REST API) for opencode.

Environment variables:
  YOUTRACK_URL   - base URL, e.g. https://youtrack.example.com
  YOUTRACK_TOKEN - permanent token (Profile -> Applications -> Generate token)

Run manually:  python -m youtrack_mcp.server
"""

from __future__ import annotations

import atexit
from contextlib import asynccontextmanager
from typing import Optional

from fastmcp import FastMCP

from .client import YouTrackClient
from . import tools_issues, tools_boards

_client: Optional[YouTrackClient] = None


def get_client() -> YouTrackClient:
    global _client
    if _client is None:
        _client = YouTrackClient()
    return _client


@asynccontextmanager
async def lifespan(_: FastMCP):
    try:
        get_client()  # fail fast with a clear message if env is missing
    except ValueError as e:
        raise RuntimeError(str(e)) from e
    yield
    if _client is not None:
        await _client.close()


mcp = FastMCP(
    name="youtrack",
    instructions=(
        "Tools for JetBrains YouTrack 2022.3: issues (search/read/create/update/"
        "comments/attachments), commands (Command Reference syntax), Agile boards "
        "and projects. Issue state/priority/tags/assignee changes go through "
        "yt_apply_command so that YouTrack workflows are triggered correctly."
    ),
    lifespan=lifespan,
)

tools_issues.register(mcp, get_client)
tools_boards.register(mcp, get_client)

atexit.register(lambda: None)  # cleanup handled by lifespan


if __name__ == "__main__":
    mcp.run()  # stdio transport by default — what opencode expects
