# Harrison Family Website

A private family-history site at [https://harrisonfamily.us](https://harrisonfamily.us) (the docs write this host as `<site>`): public pages plus a members-only area built from the family's Gramps database, with member posts and comments, notifications, search, an installable app shell, passkey sign-in and an MCP connector at `https://<site>/mcp`. The site is the committed output of an out-of-repo Eleventy source in `11ty/`, with React islands and the design-system theme layer built from `islands/`. The member API, the auth edge and the Lambda@Edge private data gate ship by hand through CloudFormation.

## Start here

- **People:** [`docs/README.md`](docs/README.md) is the documentation index, organized with [Diátaxis](https://diataxis.fr) into explanation, reference and how-to pages. Good first pages are the [codebase map](docs/reference/codebase-map.md), the [system architecture](docs/reference/architecture.md) and [Deploy a change to the static site](docs/how-to/deploy-a-site-change.md).
- **Agents:** [`AGENTS.md`](AGENTS.md) is the operating contract: Enceladus governance, the task lifecycle, the pipeline facts and the no-PII rule.

The production cutover on 2026-10-12 turned all six feature flags on, `authV2` among them, and then attached the private data gate. While the gate is attached, a rollback that brings back `authV2` as `false` locks every visitor out of the family data, so read [Roll back a site deploy](docs/how-to/roll-back-a-site-deploy.md) before you undo a release.

## Contributing

Work is tracked as Enceladus HFY records. Enable the secret-scan hook with `git config core.hooksPath scripts/git-hooks`. Never commit private family data, secrets or real identifiers; [The privacy model for family data](docs/explanation/family-data-privacy.md) explains where the lines are.

## Provenance

This project was built with AI-assisted development, using the [agentharmony](https://github.com/me-jreese/agentharmony) framework. That tooling evolved into [Enceladus](https://github.com/NX-2021-L/enceladus), which now governs the project.

## License

This project is provided as-is for educational and personal use. The codebase (HTML/CSS/JS/Python) is available for reuse; all family content, photos, and genealogical data remain private property of the Harrison family.

## Acknowledgments

- **Gramps Community**: For maintaining the gold-standard open-source genealogy platform
- **Eleventy Team**: For a flexible, developer-friendly static site generator
- **Bootstrap Contributors**: For robust, accessible UI components
- **Graphviz Maintainers**: For powerful graph visualization tools
