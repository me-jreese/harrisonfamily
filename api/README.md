# api/

`hfy-api`, the members-only JSON API served at `/api/*`: a Node.js 22 Lambda behind CloudFront, storing its records in one DynamoDB table.

- Routes, permissions, data, configuration and packaging: [Family API reference](../docs/reference/api.md)
- Why the rules are what they are: [How member content stays accountable](../docs/explanation/member-content-design.md)
- Tests (`npm test`): [Run the test suites](../docs/how-to/run-the-tests.md)
- Deploying it (through the `hfy-app` stack; no workflow ships it): [Deploy the app stack](../docs/how-to/deploy-the-app-stack.md)
