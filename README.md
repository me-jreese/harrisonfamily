# Harrison Family Website

A private family-history site at [https://harrisonfamily.us](https://harrisonfamily.us), with public pages plus a members-only area built from the family's Gramps database. Release E5 adds member posts, comments, notifications, a new search and an installable app shell, all behind feature flags.

## How it is built and deployed

The Eleventy source lives outside the repository, and its output is committed in `11ty/`. The React islands in `islands/` build into `11ty/js/islands/`. Family data comes from an out-of-repo Gramps ETL and is synced to private bucket prefixes, never to git. A push to `main` runs the kit pipeline that `ci.manifest.yaml` renders: it syncs `11ty/` to S3 without touching the family data or member uploads, deploys the legacy sign-in Lambda, invalidates CloudFront, smoke-checks the site and rolls back if the check fails. The member API (`api/`) and the auth edge (`auth/`) ship by hand through the CloudFormation app stack in `infrastructure/`. See the [architecture reference](docs/reference/architecture.md) and [Deploy a change to the static site](docs/how-to/deploy-a-site-change.md).

## Documentation

[`docs/README.md`](docs/README.md) is the index. It is organized with [Diátaxis](https://diataxis.fr): explanation, reference and how-to pages, with no tutorial track. Three good starting points:

- [Codebase map](docs/reference/codebase-map.md): where each capability lives in the code.
- [The identity model](docs/explanation/identity-model.md): who may sign in, and why it works the way it does.
- [Deploy a change to the static site](docs/how-to/deploy-a-site-change.md): how a change reaches production.

To set the site up for another family, follow [Stand up the static site](docs/how-to/stand-up-the-static-site.md) and the pages it lists after it.

## For agents

Automated agents start at [`AGENTS.md`](AGENTS.md), the operating contract: Enceladus governance, the task lifecycle and the no-PII rule.

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
