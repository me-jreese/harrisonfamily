# api/

`hfy-api`: the members-only JSON API at `/api/*` and the MCP server at `/mcp`, one Node.js 22 Lambda in `<app-stack>` that no workflow deploys.

- Reference: [Family API](../docs/reference/api.md) (routes, permissions, audit records, notifications, uploads), [MCP server](../docs/reference/mcp-server.md), and the table keys that [`src/keys.js`](src/keys.js) builds, in [System architecture: Item layout](../docs/reference/architecture.md#item-layout). Rationale: [How member content stays accountable](../docs/explanation/member-content-design.md).
- Test with `npm test` ([Run the test suites](../docs/how-to/run-the-tests.md)); ship with [Deploy the app stack](../docs/how-to/deploy-the-app-stack.md).
