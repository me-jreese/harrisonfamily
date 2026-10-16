export const meta = {
  name: 'hfy-merge-ship',
  description: 'Serially hand-merge origin/main into built PLN-002 branches that hit source conflicts, adversarially review each merge, then ship it',
  phases: [{ title: 'Merge' }, { title: 'Review' }, { title: 'Ship' }],
}
// args: { stateDir, repoDir, session, sci, governanceHash?, gitName?, gitEmail?, items: [{ id, key, wt, branch, report, notes, shipNotes }] };
// processed one at a time so each merge sees the previous one's merge. session and sci are handed to ship3.js (see README.md).
const SP = args.stateDir
if (!SP) throw new Error('args.stateDir is required: the orchestration state directory')
const REPO = args.repoDir
if (!REPO) throw new Error('args.repoDir is required: a harrisonfamily checkout that holds scripts/orchestration/')
if (!args.session || !args.sci) throw new Error('args.session and args.sci are required: the claimed Enceladus session id and its SCI, passed to ship3.js')
const ORCH = `${REPO}/scripts/orchestration`
const CA_OWNER = `$(grep -oE "io-[0-9]{12}" ${REPO}/api/.npmrc | head -1 | cut -c4-)`
const GIT = args.gitName && args.gitEmail ? `git -c user.name="${args.gitName}" -c user.email=${args.gitEmail}` : "git (the worktree's configured user.name and user.email)"
const RULES = `Rules:
- Never call Enceladus or tracker tools. Never push. No AWS writes.
- Never print secrets. Fictional data only.
- Follow AGENTS.md: islands merge train; theme-lint.
- CODEARTIFACT_AUTH_TOKEN: export it from 'aws codeartifact get-authorization-token --domain io --domain-owner ${CA_OWNER} --profile product-lead --region us-west-2 --query authorizationToken --output text' when npm ci or mcp-conformance needs it. Never echo it.
- Commit with ${GIT}, ending with 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'.
- Playwright, on io's shared daily machine: always prefix runs with PW_CHANNEL=chromium-headless-shell, never system Chrome. Use --workers=1, or 2 at most. Run ONLY the specs you add or change (npx playwright test tests/<spec>.spec.mjs). Never run the full Playwright suite (that includes islands 'npm test', which ends in 'playwright test'). No --ui, no watch mode and no relaunch loops; CI runs the full suite. Use a free PW_PORT between 18100 and 18999 (8089 is usually taken). After every run, 'pgrep -fl playwright_chromiumdev_profile' must print nothing. If it does, run 'pkill -f playwright_chromiumdev_profile'. Stop any http-server or dev server you started.
- Before committing a resolution, grep -rn '^<<<<<<<\\|^=======$\\|^>>>>>>>' on the touched files must find nothing.`
const results = []
for (const it of args.items) {
  const merged = await agent(`${RULES}

Worktree ${it.wt}, branch ${it.branch} (task ${it.id} '${it.key}'). A ship clerk's rebase onto origin/main stopped on source-file conflicts. Run git fetch origin, then git merge origin/main. Do not rebase; a merge is fine.

Resolve every conflict SEMANTICALLY, keeping both sides:
- Main's features: the 238 feature gate (requireFeature/featureOn, every PLN-002 route declares a feature or switch, GET /api/me is the only exemption); the 240 R-18 guard (guard.js on posts, comments and MCP; upload binding; errors[] on HttpError); the 298 me.js reader; and any later merges.
- This branch's own feature, which you understand from its commits (git log origin/main..HEAD).
- Where both sides edit the same function (for example errorResponse emitting both 'errors' and 'details'), produce code that does both.
- Generated outputs (11ty/js/islands/**, the 11ty html asset-version blocks, feature-flags.js ?v=) take origin/main's side and are rebuilt with cd islands && npm run build.
- Docs are a union of both sides.
${it.notes || ''}

Then run:
- api npm test;
- auth tests if auth/ was touched;
- islands: npm run build, check:islands and test:contract, plus only the Playwright specs the branch changed (git diff --name-only origin/main...HEAD -- islands/tests), run as described under Playwright;
- bash scripts/infra/test/run.sh;
- scripts/ci/check-no-family-data.sh;
- scripts/ci/mcp-conformance.sh blocking.
Fix any breakage the merge caused, then commit.

Return: each conflict file with what was kept from each side, test counts, and HEAD SHA.`, { label: `merge:${it.id}`, phase: 'Merge' })
  const review = await agent(`${RULES}

ADVERSARIAL review of the merge on ${it.wt} (branch ${it.branch}, task ${it.id}). Do not modify files. The merger's report:
${merged}
Verify:
(1) git diff origin/main...HEAD contains this task's whole feature, and loses nothing from main: no route without its feature gate, no write path without the R-18 guard, no dropped test.
(2) Re-run the api tests and any affected suites.
Return CONFIRMED findings only, then a verdict: approve | fix-first.`, { label: `review:${it.id}`, phase: 'Review' })
  let fix = 'no fixes needed'
  if (/fix-first/i.test(review || '')) fix = await agent(`${RULES}\n\nApply these confirmed findings on ${it.wt} (branch ${it.branch}), re-run the suites and commit:\n${review}\nReturn: fixes, test counts, HEAD SHA.`, { label: `fix:${it.id}`, phase: 'Review' })
  const shipped = await workflow({ scriptPath: `${ORCH}/ship3.js` }, { stateDir: SP, repoDir: REPO, session: args.session, sci: args.sci, governanceHash: args.governanceHash, hf: [{ id: it.id, key: it.key, wt: it.wt, branch: it.branch, repo: 'harrisonfamily', report: it.report,
    prExtra: `- The worker report is in ${it.report} (entry ${it.id}). This merge record supersedes its branch-state notes:
MERGE: ${String(merged || '').slice(0, 2200)}
REVIEW: ${String(review || '').slice(0, 1200)}
FIX: ${String(fix || '').slice(0, 1200)}
- The branch is already merged with origin/main. If main moved again, MERGE again (never rebase a branch with merge commits) and re-run the tests. Source conflicts on a re-merge: resolve them semantically, keeping both sides, as above.
${it.shipNotes || ''}` }], hf2: [], kit: [] })
  results.push({ id: it.id, review: String(review || '').slice(0, 600), shipped })
}
return results
