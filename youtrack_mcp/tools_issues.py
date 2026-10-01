"""Issue-related MCP tools: search, read, create, update, comments, commands."""

# NOTE: no `from __future__ import annotations` here on purpose — pydantic
# resolves tool signatures at runtime and needs real typing objects in scope.
from typing import Any, Optional

from fastmcp import FastMCP

from .client import YouTrackClient

# Compact field selection to keep responses small.
ISSUE_FIELDS = (
    "number,id,subject,description,reporter(login,name),assignee(login,name),"
    "state(name,presentation),priority(presentation),"
    "type(presentation),project(name,shortName),tags(name),"
    "links($all,$type(name,direction,presentation)),"
    "attachments(id,name,url,contentType,displayInBundle),comments(count),"
    "created,updated"
)


def register(mcp: FastMCP, get_client) -> None:
    @mcp.tool()
    async def yt_search_issues(
        query: str,
        max_results: int = 25,
        fields: str = ISSUE_FIELDS,
    ) -> list[dict]:
        """Search issues with a YouTrack query (YouTrack Search Language).

        Examples of `query`:
          - 'State: Unresolved project:ABC'
          - 'tag: {GitLab merge request} assignee: me()'
        """
        client: YouTrackClient = get_client()
        return await client.get(
            "/issues",
            params={"query": query, "$top": max_results, "fields": fields},
        ) or []

    @mcp.tool()
    async def yt_get_issue(issue_id: str) -> dict:
        """Get a single issue by its ID (e.g. 'ABC-123') with the main fields
        (subject, description, state, priority, assignee, tags, links)."""
        client: YouTrackClient = get_client()
        return await client.get(f"/issues/{issue_id}", params={"fields": ISSUE_FIELDS})

    @mcp.tool()
    async def yt_create_issue(
        project: str,
        subject: str,
        description: str = "",
        command: str = "",
    ) -> dict:
        """Create an issue in a project (by name or short name, e.g. 'ABC').

        `command` is an optional YouTrack command applied right after creation,
        e.g. '#State Backlog #Priority Medium'.
        Returns the created issue (id + number).
        """
        client: YouTrackClient = get_client()
        body: dict[str, Any] = {"project": {"name": project}, "subject": subject}
        if description:
            body["description"] = description
        created = await client.post("/issues?fields=number,id,subject", json=body)
        if command:
            cmd = command if command.lstrip().startswith("#") else "#" + command.strip()
            await client.run_command(f"{cmd} {created['number']}")
        return await client.get(
            f"/issues/{created['id']}",
            params={"fields": "number,id,subject,state(name,presentation)"},
        )

    @mcp.tool()
    async def yt_apply_command(command: str) -> dict:
        """Apply an arbitrary YouTrack command to issues.

        Command syntax follows the YouTrack Command Reference, e.g.:
          - '#State Fixed ABC-123'                 -> set state
          - 'tag -{Feature Bug} ABC-123 ABC-124'   -> remove tag from issues
          - '#assignee john ABC-123'               -> set assignee
        The target issue IDs must be included INSIDE the command string.
        """
        client: YouTrackClient = get_client()
        return await client.run_command(command)

    @mcp.tool()
    async def yt_update_issue(
        issue_id: str,
        subject: Optional[str] = None,
        description: Optional[str] = None,
    ) -> dict:
        """Update subject/description of an issue directly.

        For state/priority/tags/assignee use yt_apply_command instead —
        YouTrack workflows react to commands, not raw field writes.
        """
        client: YouTrackClient = get_client()
        body: dict[str, Any] = {}
        if subject is not None:
            body["subject"] = subject
        if description is not None:
            body["description"] = description
        if not body:
            raise ValueError("Nothing to update: pass subject and/or description.")
        await client.post(f"/issues/{issue_id}", json=body)
        return await client.get(
            f"/issues/{issue_id}", params={"fields": "number,id,subject"}
        )

    @mcp.tool()
    async def yt_get_comments(issue_id: str, count: int = 20) -> list[dict]:
        """Get the latest comments of an issue."""
        client: YouTrackClient = get_client()
        data = await client.get(
            f"/issues/{issue_id}/comments",
            params={
                "$top": count,
                "fields": "comment(text,author(login,name),created,updated,pinned)",
            },
        )
        return [c.get("comment", c) for c in (data or [])]

    @mcp.tool()
    async def yt_add_comment(issue_id: str, text: str, visible_to: str = "") -> dict:
        """Add a comment to an issue. `visible_to` is an optional user/group
        name restricting visibility."""
        client: YouTrackClient = get_client()
        body: dict[str, Any] = {"text": text}
        if visible_to:
            body["permittedGroups"] = [{"name": visible_to}]
        return await client.post(
            f"/issues/{issue_id}/comments", params={"fields": "id,text"}, json=body
        )

    @mcp.tool()
    async def yt_get_attachments(issue_id: str) -> list[dict]:
        """List attachments of an issue (name, url, content type)."""
        client: YouTrackClient = get_client()
        return await client.get(
            f"/issues/{issue_id}/attachments",
            params={"fields": "id,name,url,contentType,fileSize,author(login,name)"},
        ) or []

    @mcp.tool()
    async def yt_get_vcs_references(issue_id: str) -> list[dict]:
        """Get GitLab VCS references (commits/MRs synced from GitLab) linked to
        an issue via the YouTrack GitLab integration."""
        client: YouTrackClient = get_client()
        links = await client.get(
            f"/issues/{issue_id}/links",
            params={"fields": "$all,srcLink($all),dstLink($all)"},
        )
        result = []
        for link in links or []:
            if link.get("$type") == "vcs-issue-link" or "vcs" in str(link.get("srcId", "")).lower():
                result.append(link)
        return result
