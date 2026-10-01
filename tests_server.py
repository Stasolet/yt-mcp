"""Smoke test: MCP handshake over stdio + tool call against a mocked YouTrack."""
import asyncio, json, os, sys

sys.path.insert(0, "/workspace")
os.environ.setdefault("YOUTRACK_URL", "https://yt.test")
os.environ.setdefault("YOUTRACK_TOKEN", "test-token")

from youtrack_mcp import client as client_mod


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status
        self.content = json.dumps(payload).encode()

    def json(self):
        return self._payload


async def fake_request(self, method, path, *, params=None, json=None):
    calls.append((method, path, params or {}))
    if path == "/issues" and method == "GET":
        return [{"id": "issue-1", "number": "ABC-1", "subject": "Test issue"}]
    if path.startswith("/issues/ABC-1/comments") and method == "POST":
        return {"id": "c1", "text": json.get("text")}
    if path == "/admin/commands":
        return {"output": "", "error": ""}
    if path == "/agiles":
        return [{"id": "agile-1", "name": "My Board"}]
    return {}


calls = []
client_mod.YouTrackClient.request = fake_request

from fastmcp.client import Client
from youtrack_mcp.server import mcp


async def main():
    async with Client(mcp) as c:
        tools = await c.list_tools()
        assert len(tools) == 17, f"expected 17 tools, got {len(tools)}"

        r = await c.call_tool("yt_search_issues", {"query": "project:ABC"})
        data = json.loads(r.content[0].text) if hasattr(r.content[0], "text") else r.data
        assert data[0]["number"] == "ABC-1", data

        r = await c.call_tool("yt_apply_command", {"command": "#State Fixed ABC-1"})
        r = await c.call_tool("yt_add_comment", {"issue_id": "ABC-1", "text": "hello"})

        r = await c.call_tool("yt_list_boards", {})

        names = [t.name for t in tools]
        assert "yt_get_board_issues" in names and "yt_get_vcs_references" in names

    # verify the HTTP paths we hit
    paths = [p for _, p, _ in calls]
    assert "/issues" in paths
    assert "/admin/commands" in paths
    assert "/agiles" in paths
    assert any(p.endswith("/comments") for p in paths)
    print("SMOKE TEST OK. Calls:", paths)


asyncio.run(main())
