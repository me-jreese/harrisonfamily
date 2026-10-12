# api/

`hfy-api`: the members-only JSON API at `/api/*` and the MCP server at `/mcp`, one Node.js 22 Lambda that no workflow deploys.

- Reference: [Family API](../docs/reference/api.md), [MCP server](../docs/reference/mcp-server.md), and the table keys that [`src/keys.js`](src/keys.js) builds, in [System architecture: Item layout](../docs/reference/architecture.md#item-layout)
- Why the rules are what they are: [How member content stays accountable](../docs/explanation/member-content-design.md)
- Testing (`npm test`) and shipping: [Run the test suites](../docs/how-to/run-the-tests.md), [Deploy the app stack](../docs/how-to/deploy-the-app-stack.md)
