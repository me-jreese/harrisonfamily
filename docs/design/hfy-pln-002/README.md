# HFY-PLN-002 design sources and the cloud-worker protocol

This folder is the read-only design for HFY-PLN-002, the family platform program. It covers the Gramps ↔ cloud source of truth, proposals and editing, the social layer, page features, `@io-kit/chat` and the visualization.

The live dispatch catalog is the docstore document DOC-981BF41F2443. io's verbatim intent is DOC-2CFAE07B546C. **The Enceladus tracker is authoritative** for task status.

| File | What it is |
|---|---|
| `BRD2.md` | Architecture, locked decisions D2-xx, io decisions, data model, privacy model, waves W0-W6. Section 11 overrides the domain files. |
| `sync.md`, `editing.md`, `social.md`, `surfaces.md`, `chat.md`, `viz.md` | Domain designs. Grep for your task key. |
| `tasks.json` | Every task: key, wave, repo, depends_on, acceptance criteria, test_plan. Follow-up tasks filed after the import have no wave. |
| `tracker-idmap.json` | Plan key → tracker id (HFY-TSK-nnn). |
| `addenda.json` | Plan key → the orchestrator's notes for that task, which `make_batch.py` appends to the task pack. |
| `requirements.md` | Requirement trace R-01..R-42, D-01..D-03. |
| `viz-adr.md`, `chat-adr.md` | Research-intake decisions. The viz approach is approved; chat runs on Cloudflare Durable Objects. |

Gramps ids of real people are redacted as `<gramps-id>`.

The orchestrator's tools, which read `tasks.json`, `tracker-idmap.json` and `addenda.json`, are in [`scripts/orchestration/`](../../../scripts/orchestration/README.md).

## Protocol for cloud worker sessions

A cloud session writes code. The orchestrator (a Claude Code session on io's Mac) owns everything that needs credentials: tracker lifecycle and CCI, merging, AWS, CodeArtifact, Cloudflare, io's Mac, Gramps and production checks.

1. **Never call Enceladus tracker or lifecycle tools.** Never deploy or merge. Never touch AWS, Cloudflare or production.
2. **One task per branch:** `agent/hfy-tsk-<nnn>-<key>`, cut from `main` of the task's repo. io-kit tasks go in `NX-2021-L/io-kit`; harrisonfamily tasks go here.
3. Implement until every acceptance criterion you can meet is met. Then review your own diff twice:
   - once for design and intent fidelity against BRD2 and the domain file;
   - once for bugs, security and tests.

   Fix what you find. Run the task's test_plan suites that can run in your environment.
4. **Repo rules:**
   - **harrisonfamily:** follow `AGENTS.md`. Islands changes need `cd islands && npm run build` with every output committed. Theme-lint means no literal CSS values. New surfaces ship behind default-off flags.
   - **io-kit:** one package per PR, plus a changeset. Then run `pnpm changeset version` in the branch: dependent patch bumps are allowed, but list them in the PR body.
5. **Privacy:** never write real family names, dates or contact details into code, fixtures, tests or PR text. Use fictional values (555-01xx phones, example.org mail).
6. **Commit, push your branch, and open a DRAFT pull request** titled `HFY-TSK-<nnn>: <title>`. The body must contain:
   - `## Worker report`: one line per acceptance criterion, marked met, partial, deferred or not met, with evidence (test names and counts);
   - the commands you ran and their results;
   - `## Needs the orchestrator`: anything that requires credentials, production, io's Mac or a later task.

   Do not add a CCI line. The orchestrator adds it, marks the PR ready and merges.
7. Finish with a short summary message listing your PR URLs, then stop and wait for the next instruction.

### harrisonfamily without CodeArtifact

`api/` and `islands/` install `@io-kit/*` from a private CodeArtifact registry that cloud sessions cannot reach. Two options:

- **Pure modules** (`shared/`, `graph/`, `gramps/` Python, `api/src/**` modules tested with `node --test`): run their own tests directly.
- **Code that imports `@io-kit/*`:** if `NX-2021-L/io-kit` is accessible to you, clone it, run `pnpm install && pnpm -r build`, then `pnpm -r pack --pack-destination /tmp/iokit-packs`. Install the matching tarballs with `npm install --no-save /tmp/iokit-packs/<file>.tgz ...` after a plain `npm install --ignore-scripts --no-package-lock` with the `@io-kit/*` entries temporarily removed. **Never commit** the package.json or lockfile changes this bootstrap makes (`git checkout -- package.json package-lock.json` before you commit).

If neither works, say so in the worker report. The orchestrator re-runs the real suites before merge in either case.
