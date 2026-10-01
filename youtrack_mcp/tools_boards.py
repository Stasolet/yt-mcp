"""Board (Agile) & project MCP tools for YouTrack 2022.3."""

from __future__ import annotations

from typing import Any

from fastmcp import FastMCP

from .client import YouTrackClient

BOARD_FIELDS = (
    "id,name,projectRefs(project(name,shortName)),pivots(field(name)),author(login,name)"
)


def register(mcp: FastMCP, get_client) -> None:
    @mcp.tool()
    async def yt_list_boards() -> list[dict]:
        """List all Agile boards the token's user can see."""
        client: YouTrackClient = get_client()
        return await client.get("/agiles", params={"fields": BOARD_FIELDS}) or []

    @mcp.tool()
    async def yt_get_board(board_id: str) -> dict:
        """Get one board by its id or name.

        YouTrack accepts both the internal id and the human-readable name
        in the URL path (/api/agiles/{id}/), so pass either.
        """
        client: YouTrackClient = get_client()
        return await client.get(f"/agiles/{board_id}", params={"fields": BOARD_FIELDS + ",description"})

    @mcp.tool()
    async def yt_get_board_issues(
        board_id: str,
        query: str = "",
        max_results: int = 50,
    ) -> list[dict]:
        """List issues on a board (optionally filtered by extra query).

        Uses GET /agiles/{id}/issues — works for Kanban and Scrum boards.
        """
        client: YouTrackClient = get_client()
        params: dict[str, Any] = {"$top": max_results}
        if query:
            params["query"] = query
        return await client.get(
            f"/agiles/{board_id}/issues",
            params={**params, "fields": "number,subject,state(name,presentation),assignee(login,name),priority(presentation)"},
        ) or []

    @mcp.tool()
    async def yt_get_board_columns(board_id: str) -> list[dict]:
        """Get board columns (stages) with their issue counts where available.

        For Kanban boards columns come from the pivot field values; this
        returns each column's name and query.
        """
        client: YouTrackClient = get_client()
        cols = await client.get(
            f"/agiles/{board_id}/columns",
            params={"fields": "name,id,query,color"},
        )
        return cols or []

    @mcp.tool()
    async def yt_list_projects() -> list[dict]:
        """List all projects visible to the token's user."""
        client: YouTrackClient = get_client()
        return await client.get(
            "/projects", params={"fields": "id,name,shortName,archived"}
        ) or []

    @mcp.tool()
    async def yt_get_project_issues(
        project: str,
        query: str = "",
        max_results: int = 50,
    ) -> list[dict]:
        """List issues of a project (by name or short name)."""
        client: YouTrackClient = get_client()
        full_query = f"project:{project}" + (f" {query}" if query else "")
        return await client.get(
            "/issues",
            params={
                "query": full_query,
                "$top": max_results,
                "fields": "number,subject,state(name,presentation),assignee(login,name),priority(presentation)",
            },
        ) or []

    @mcp.tool()
    async def yt_get_issue_states(project: str = "") -> list[dict]:
        """List available issue states (useful before running '#State ...').

        If `project` is given, only states used in that project are returned.
        """
        client: YouTrackClient = get_client()
        params = {"fields": "name,presentation,localizedName,isDefault"}
        if project:
            data = await client.get(
                f"/admin/projects/{project}/customFields/state/values",
                params={"fields": "$all,name,presentation"},
            )
            return [v.get("element", v) for v in (data or [])]
        return await client.get(
            "/admin/customFields/field64/options", params=params
        ) or await client.get(
            "/admin/customFields", params={"fields": "$all"}
        )

    @mcp.tool()
    async def yt_search_users(query: str, max_results: int = 10) -> list[dict]:
        """Find users by login/name (e.g. to set an assignee via commands)."""
        client: YouTrackClient = get_client()
        return await client.get(
            "/users",
            params={
                "query": query,
                "$top": max_results,
                "fields": "login,name,email,avatar(url)",
            },
        ) or []
