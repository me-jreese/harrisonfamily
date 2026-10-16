export const meta = {
  name: 'hfy-pln002-batch',
  description: 'Build a batch of HFY-PLN-002 tasks: implement -> 2-lens review -> fix -> verify, one pipeline per task (no push, no lifecycle)',
  phases: [
    { title: 'Implement' }, { title: 'Review' }, { title: 'Fix' }, { title: 'Verify' },
  ],
}
// args: { stateDir, repoDir, wtRoot?, batchFile, tasks: [...] }; make_batch.py prints them (see README.md).
const SP = args.stateDir
if (!SP) throw new Error('args.stateDir is required: the orchestration state directory (batch packs, pln002-intent.md)')
const REPO = args.repoDir
if (!REPO) throw new Error('args.repoDir is required: a harrisonfamily checkout whose docs/design/hfy-pln-002/ holds the design')
const D = `${REPO}/docs/design/hfy-pln-002`
const WT_ROOT = args.wtRoot ? String(args.wtRoot).replace(/\/+$/, '') + '/' : null
const inWorktree = (t) => WT_ROOT ? t.wt.startsWith(WT_ROOT) : t.wt.includes('/e0/wt/')
const CA_OWNER = `$(grep -oE "io-[0-9]{12}" ${REPO}/api/.npmrc | head -1 | cut -c4-)`
const BATCH = args.batchFile
const COMMON = (t) => `You are a worker on HFY-PLN-002 task ${t.id} (plan key '${t.key}') for harrisonfamily.us.

TASK PACK: read your entry from ${BATCH} (match key '${t.key}'): title, acceptance criteria (ACs), notes, test_plan, requirements.
DESIGN SOURCES (authoritative):
- ${D}/BRD2.md. Grep it for '${t.key}'. Its section 11 amendments override the domain files. Read the sections your task cites.
- The domain design files ${D}/{sync,editing,social,surfaces,chat,viz}.md. Grep for your key and topic.
- io's verbatim intent: ${SP}/pln002-intent.md.
WORK LOCATION: ${t.wt}${inWorktree(t) ? ` (a git worktree on its own agent/ branch; node_modules are pre-cloned. In io-kit worktrees, run 'pnpm install --offline' first if a dependency is missing)` : ' (out-of-repo directory: keep a timestamped backup of every file you change beside it, and never touch the live Gramps DB; use copies only)'}.
RULES:
- Follow the repo's AGENTS.md and README conventions.
- harrisonfamily islands rules:
  - theme-lint means no literal CSS values;
  - run 'cd islands && npm run build' and commit all 11ty outputs;
  - register repo-owned pages;
  - new surfaces ship behind default-off flags.
- io-kit rules: one package per PR, include a changeset with the exact bump the AC names, and keep 'pnpm lint typecheck test build' green for the package.
- Run targeted tests while iterating. At verify, run the full NON-browser suites named in test_plan (node --test, vitest, pytest, infra run.sh); for browser specs, run only the ones you changed (see Playwright).
- Commit locally on the worktree branch with clear messages ending 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'. NEVER push. NEVER call Enceladus tracker or lifecycle tools.
- PRIVACY: never write real family names, dates or contact details into code, tests, fixtures or reports. Use synthetic fixtures.
- CODEARTIFACT (@io-kit/* installs, lockfile regeneration, mcp-conformance): export CODEARTIFACT_AUTH_TOKEN=$(aws codeartifact get-authorization-token --domain io --domain-owner ${CA_OWNER} --profile product-lead --region us-west-2 --query authorizationToken --output text). ALWAYS pass --profile product-lead (the default AWS identity cannot mint it). Never echo the token.
- Playwright, on io's shared daily machine: always prefix runs with PW_CHANNEL=chromium-headless-shell, never system Chrome. Use --workers=1, or 2 at most. Run ONLY the specs you add or change (npx playwright test tests/<spec>.spec.mjs). Never run the full Playwright suite (that includes islands 'npm test', which ends in 'playwright test'). No --ui, no watch mode and no relaunch loops; CI runs the full suite. Use a free PW_PORT between 18100 and 18999 (8089 is usually taken). After every run, 'pgrep -fl playwright_chromiumdev_profile' must print nothing. If it does, run 'pkill -f playwright_chromiumdev_profile'. Stop any http-server or dev server you started.
- DISK IS NEARLY FULL (about 2.5 GB free). Do not create large files; clean any temp dirs you create.
- EARLIER PASS: if your worktree branch already has commits for this task (git log origin/main..HEAD), including a 'WIP: partial pass' commit, an earlier run of this pipeline was stopped part-way. Build on that work: check it against the ACs, finish what is missing and fix what is wrong. Don't start over, and don't treat it as a foreign edit.
- If an AC can't be met without something outside your task (an io decision, a production deploy, a later task), do everything else and list it under open_issues. Never fake it.`
const REPORT = { type: 'object', properties: { summary: { type: 'string' }, branch: { type: 'string' }, head_sha: { type: 'string' }, commits: { type: 'array', items: { type: 'string' } }, tests_run: { type: 'array', items: { type: 'object', properties: { cmd: { type: 'string' }, result: { type: 'string' } }, required: ['cmd', 'result'] } }, ac_evidence: { type: 'array', items: { type: 'object', properties: { ac: { type: 'number' }, status: { type: 'string', enum: ['met', 'partial', 'deferred', 'not_met'] }, evidence: { type: 'string' } }, required: ['ac', 'status', 'evidence'] } }, open_issues: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'head_sha', 'commits', 'tests_run', 'ac_evidence', 'open_issues'] }
const ISSUES = { type: 'object', properties: { issues: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, where: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'where', 'issue', 'fix'] } } }, required: ['issues'] }
const diffCmd = (t) => inWorktree(t) ? `git -C ${t.wt} diff origin/main...HEAD` : `the changed files in ${t.wt} vs their timestamped backups`

const results = await pipeline(args.tasks,
  (t) => agent(`${COMMON(t)}\n\nIMPLEMENT the task so that every AC is met. Return the report.`, { label: `impl:${t.key}`, phase: 'Implement', schema: REPORT, model: t.model || 'sonnet', effort: t.effort || 'medium' }).then(r => ({ t, impl: r })),
  async (s) => {
    if (!s.impl) return { ...s, issues: [] }
    const lenses = [
      `DESIGN and INTENT fidelity: compare ${diffCmd(s.t)} against the task's ACs, the BRD2 and domain design for '${s.t.key}', and io's verbatim intent. Flag missing or weakened ACs, scope creep, and privacy-rule violations (no DOB, no contact info).`,
      `CODE and TESTS: review ${diffCmd(s.t)} for bugs, edge cases, security issues (authz, injection, XSS, secrets), concurrency problems, and tests that don't really assert the ACs. RUN the task's targeted tests yourself.`,
    ]
    const rs = await parallel(lenses.map((l, i) => () => agent(`${COMMON(s.t)}\n\nREVIEW ONLY (do not edit files). ${l}\nThe implementer's report: ${JSON.stringify(s.impl).slice(0, 6000)}`, { label: `review${i + 1}:${s.t.key}`, phase: 'Review', schema: ISSUES, model: 'sonnet', effort: 'medium' })))
    return { ...s, issues: rs.filter(Boolean).flatMap(r => r.issues) }
  },
  async (s) => {
    if (!s.impl) return s
    const real = s.issues.filter(i => i.severity !== 'minor' || true)
    if (!real.length) return { ...s, fix: null }
    const fix = await agent(`${COMMON(s.t)}\n\nFIX these review issues: all critical and major ones, and minor ones where cheap. Decline any you judge wrong, with the reason in open_issues.\n${JSON.stringify(real).slice(0, 20000)}\nRe-run the targeted tests, commit, and return the report.`, { label: `fix:${s.t.key}`, phase: 'Fix', schema: REPORT, model: s.t.model || 'sonnet', effort: s.t.effort || 'medium' })
    return { ...s, fix }
  },
  async (s) => {
    if (!s.impl) return s
    const v = await agent(`${COMMON(s.t)}\n\nFINAL VERIFY. Run every suite in the task's test_plan that runs worker-local, plus the repo's standard checks for what you touched. If a failure exists, check whether it already fails at origin/main by running the same test in a temporary detached worktree, then remove that worktree. Make only a minimal fix if this branch causes a failure. Report per-AC status with exact evidence (test names and pass counts), the branch head SHA, and 'git status --short', which must be clean.`, { label: `verify:${s.t.key}`, phase: 'Verify', schema: REPORT, model: 'sonnet', effort: 'medium' })
    return { id: s.t.id, key: s.t.key, wt: s.t.wt, issues: s.issues.length, verify: v, fix_open: s.fix?.open_issues || [], impl_open: s.impl.open_issues }
  },
)
return results
