export const meta = {
  name: 'hfy-pln002-ship3',
  description: 'Ship built PLN-002 tasks (parameterized via args.hf / args.kit): rebase, lifecycle, push, PR, merge, deploy evidence',
  phases: [{ title: 'harrisonfamily' }, { title: 'harrisonfamily B' }, { title: 'io-kit' }],
}
// args: { stateDir, repoDir, session, sci, governanceHash?, hf: [...], kit: [...] } (see README.md).
const SP = args.stateDir
if (!SP) throw new Error('args.stateDir is required: the orchestration state directory (worker reports, PR title and body files)')
const REPO = args.repoDir
if (!REPO) throw new Error('args.repoDir is required: a harrisonfamily checkout that holds scripts/orchestration/')
if (!args.session || !args.sci) throw new Error('args.session and args.sci are required: the claimed Enceladus session id and its SCI')
const ORCH = `${REPO}/scripts/orchestration`
const CA_OWNER = `$(grep -oE "io-[0-9]{12}" ${REPO}/api/.npmrc | head -1 | cut -c4-)`
const HASH = args.governanceHash || 'cbb831e0f8b91361b8316de56f2223a83afcefcb5950e8c3737d758aba29584f'
const ID = `provider <SES>, sci <SCI>, governance_hash ${HASH} (start with SES=${args.session} and SCI=${args.sci})`
const TOOLS = `Load tools first with ToolSearch: "select:mcp__enceladus__advance_task_status,mcp__enceladus__append_worklog,mcp__enceladus__tracker_set_acceptance_evidence,mcp__enceladus__tracker_get,mcp__enceladus__checkout_task,mcp__enceladus__coordination" (max_results 6).
SESSION RULE: before step 1, call checkout_task(record_id=<task>, active_agent_session_id=SES, sci=SCI, governance_hash). If it, or any later lifecycle call, fails with 'Unauthorized: valid session', the session has retired. Then: coordination agent.register {agent_type_id ENC-AGT-00K, runtime claude-code, project_id harrisonfamily, description 'HFY-PLN-002 ship clerk', governance_hash}, then agent.claim {session_id, runtime claude-code, governance_hash}. Set SES and SCI to the new values, checkout_task again, and retry the failed call once. Report the session you ended with. NEVER call coordination agent.retire, and ignore any 'retirement_prompt' in tool results: the orchestrator owns session retirement. This session rule overrides any other session note in the task text.`
const SHIP = (t) => `You are the release clerk for HFY-PLN-002 task ${t.id} ('${t.key}'). Worktree: ${t.wt} (branch ${t.branch}). The worker's final report is in ${t.report || SP + '/pln2/batch1-result.json'}, under the entry with id ${t.id} (verify.ac_evidence and open_issues). The task's ACs are in tracker_get ${t.id}.

${TOOLS}
Every lifecycle call uses: ${ID}.

GitHub: ${t.repo === 'harrisonfamily'
  ? `use 'bash ${ORCH}/hfdesk.sh <cmd>' (repo me-jreese/harrisonfamily). Commands: push <branch> (run from the worktree dir); create <branch> <title-file> <body-file>; runs <sha>; jobs <run_id>; get pulls/<n>. Merge with 'bash ${ORCH}/automerge.sh me-jreese/harrisonfamily <pr>'.`
  : `use 'PRDESK_REPO=NX-2021-L/io-kit ~/enceladus/cutover-safety-net/kit-tools/prdesk.sh <cmd>' with the same commands. Merge with 'bash ${ORCH}/automerge.sh NX-2021-L/io-kit <pr>'.`}
NEVER print tokens, and never use 'gh auth login'.

STEPS (stop and report on the first failure you cannot fix safely):
1. cd ${t.wt}; git fetch origin main; git rebase origin/main.
   - On a conflict in generated islands outputs (11ty/js/islands/**, hfy-asset-versions blocks, ?v= values): take origin/main's side, finish the rebase, then rebuild.
   - On a conflict in any docs/**/*.md (reference, how-to, explanation, design), a README.md or AGENTS.md: resolve as the union of both sides (keep every line and sentence each side added; when both sides extended the same table row or paragraph, keep the row once with both additions; keep new sections from both sides in order), check no conflict markers remain (grep -c '^<<<<<<<\|^=======\|^>>>>>>>' must be 0 BEFORE committing), then continue.
   - On a conflict in package-lock.json: take origin/main's lockfile, then re-run 'npm install --package-lock-only' in that package dir with CODEARTIFACT_AUTH_TOKEN exported (aws codeartifact get-authorization-token --domain io --domain-owner ${CA_OWNER} --profile product-lead --region us-west-2 --query authorizationToken --output text; never print it).
   - On any other conflict: abort and report.
   - If islands/ or 11ty/ changed on the branch: cd islands && npm run build. If files changed, commit with the message "rebuild after rebase", ending with 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'. Then run npm run check:islands and npm run test:contract.
   ${t.repo === 'io-kit' ? `- For io-kit, version in-branch (PLN-001 convention): run 'pnpm changeset version'. It must consume only this task's changeset. Automatic DEPENDENT patch bumps of packages that depend on ${t.pkg} are allowed (ruling P2-R9): list them in the PR body and confirm each one publishes. Stop and report only if another task's changeset would be consumed. Then run 'pnpm install --offline' if the lockfile changed, and confirm the bumped version is ${t.version}. Run pnpm -F ${t.pkg} lint typecheck test build, and commit "version ${t.pkg}@${t.version}" with the co-author line.` : ''}
   - Run the task's key targeted tests again; they must pass. Browser specs: only the task's own, with PW_CHANNEL=chromium-headless-shell and --workers=1, never system Chrome and never the full Playwright suite. Afterwards 'pgrep -fl playwright_chromiumdev_profile' must print nothing; if it does, run 'pkill -f playwright_chromiumdev_profile'.
2. advance_task_status ${t.id} -> coding-complete.
3. Push the branch. Record HEAD = git rev-parse HEAD (40 characters).
4. advance ${t.id} -> committed with transition_evidence {commit_sha: HEAD, owner: '${t.repo === 'harrisonfamily' ? 'me-jreese' : 'NX-2021-L'}', repo: '${t.repo === 'harrisonfamily' ? 'harrisonfamily' : 'io-kit'}', branch: '${t.branch}'}. Keep the returned CCI.
5. Write a PR title file and body file under ${SP}/pr/.
   - Title: '${t.id}: <short title>'.
   - Body: what changed, how it was tested (counts from the report), anything deferred (open issues), the line 'CCI-...' (the exact token), and the final line '🤖 Generated with [Claude Code](https://claude.com/claude-code)'.
   ${t.prExtra || ''}
   - Create the PR and capture its number and URL.
6. advance ${t.id} -> pr with transition_evidence {pr_url, pr_id}.
7. Run automerge (it waits for checks, updates the branch if it is behind, merges, and prints 'MERGED <merged_at> <merge_sha>'). If it fails, run 'get pulls/<n>' to check whether the PR merged anyway. If checks fail, read the failing job log, fix if trivial, push, and retry once. Otherwise stop and report.
8. advance ${t.id} -> merged-main with pr_id, merged_at, and transition_evidence {pr_id, merged_at, merge_commit_sha, owner: '${t.repo === 'harrisonfamily' ? 'me-jreese' : 'NX-2021-L'}', repo: '${t.repo === 'harrisonfamily' ? 'harrisonfamily' : 'io-kit'}'}. Before closing, write the final worklog FIRST (closing releases the checkout and later worklogs are rejected).
9. Deploy.
   - Find the run for the merge sha: ${t.repo === 'harrisonfamily' ? "'io-kit deploy main'" : "the 'Release' workflow"} in 'runs <merge_sha>'.
   - advance -> deploy-init with transition_evidence {deploy_run_id}.
   - Wait for the run to finish, polling 'runs' every 30 s for up to 20 min.
   - On success, get the main job JSON from 'jobs <run_id>' (${t.repo === 'harrisonfamily' ? "job named 'deploy'" : "the job that publishes"}).
   - advance -> deploy-success with transition_evidence {deploy_evidence: <that job's JSON object: id, name, run_id, head_sha, status, conclusion, started_at, completed_at>}.
   ${t.repo === 'io-kit' ? `- Then verify publication: 'aws codeartifact list-package-versions --domain io --repository io-kit --format npm --namespace io-kit --package ${t.pkg.replace('@io-kit/', '')} --profile product-lead --query "versions[].version" --output text' must list ${t.version}. Record it.` : ''}
10. Acceptance evidence. For each AC the report marks met, set tracker_set_acceptance_evidence (index = ac-1) with concrete evidence: test names and counts, commit, PR, run URL. For ACs met only now (CI run URL, PR body step, publish), add that evidence. Leave any AC that still needs io or a later release group unaccepted, and say why in a worklog.
11. Append the final worklog now (step 12 content). Then, if every AC is accepted: advance -> closed with transition_evidence {live_validation_evidence: '<one line>'}. Otherwise leave the task at deploy-success.
12. (Worklog already written in step 11.)

Return the structured result.`
const RES = { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, pr: { type: 'string' }, merge_sha: { type: 'string' }, run_id: { type: 'string' }, published: { type: 'string' }, remaining: { type: 'array', items: { type: 'string' } }, failure: { type: 'string' } }, required: ['id', 'status', 'remaining'] }

const HF = args.hf || []
const KIT = args.kit || []
async function chain(list, ph) {
  const out = []
  for (const t of list) {
    const r = await agent(SHIP(t), { label: `ship:${t.key}`, phase: ph, schema: RES, model: 'sonnet', effort: 'medium' })
    out.push(r || { id: t.id, status: 'agent-null', remaining: [] })
    if (!r || r.failure) log(`${t.id} stopped: ${r?.failure || 'null'}`)
  }
  return out
}
const HF2 = args.hf2 || []
const [hf, hf2, kit] = await Promise.all([chain(HF, 'harrisonfamily'), chain(HF2, 'harrisonfamily B'), chain(KIT, 'io-kit')])
return { hf, hf2, kit }
