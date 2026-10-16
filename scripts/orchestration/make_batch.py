#!/usr/bin/env python3
"""Prepare an HFY-PLN-002 build batch.

usage: make_batch.py <batch-name> <key>[:<worktree-dir>] ...

env:   HFY_ORCH_STATE  orchestration state directory (batch packs are written to $HFY_ORCH_STATE/pln2/)
       HFY_ORCH_REPO   harrisonfamily checkout: worktrees are cut from it, and the task data is read
                       from its docs/design/hfy-pln-002/ (tasks.json, tracker-idmap.json, addenda.json)
       HFY_ORCH_WT     directory that holds the task worktrees

Writes $HFY_ORCH_STATE/pln2/<batch-name>.json (task packs from tasks.json, notes + addenda.json merged),
creates a git worktree per harrisonfamily task at $HFY_ORCH_WT/<dir> on agent/<id>-<key>
from origin/main, clones api/ and islands/ node_modules (APFS clone) from a donor whose lockfile
matches origin/main, and prints the Workflow args JSON for the batch script (pln002-batch.js).
"""
import json, os, subprocess, sys


def env_dir(var, what):
    v = os.environ.get(var)
    if not v:
        sys.exit(f"make_batch: {var} is not set; export {var}=<{what}>")
    if not os.path.isdir(v):
        sys.exit(f"make_batch: {var}={v} is not a directory ({what})")
    return os.path.abspath(v)


def sh(*a, **k):
    return subprocess.run(a, capture_output=True, text=True, **k)


def donor(sub):
    want = sh("git", "-C", REPO, "show", f"origin/main:{sub}/package-lock.json").stdout
    for d in sorted(os.listdir(WT)):
        lock = os.path.join(WT, d, sub, "package-lock.json")
        if os.path.isdir(os.path.join(WT, d, sub, "node_modules")) and os.path.exists(lock) and open(lock).read() == want:
            return os.path.join(WT, d, sub, "node_modules")
    return None


def main():
    global STATE, REPO, WT
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    STATE = env_dir("HFY_ORCH_STATE", "orchestration state directory")
    REPO = env_dir("HFY_ORCH_REPO", "harrisonfamily checkout")
    WT = env_dir("HFY_ORCH_WT", "directory that holds the task worktrees")
    design = os.path.join(REPO, "docs", "design", "hfy-pln-002")
    name, specs = sys.argv[1], sys.argv[2:]
    tasks = {t["key"]: t for t in json.load(open(os.path.join(design, "tasks.json")))}
    idm = json.load(open(os.path.join(design, "tracker-idmap.json")))
    add = json.load(open(os.path.join(design, "addenda.json"))) if os.path.exists(os.path.join(design, "addenda.json")) else {}
    sh("git", "-C", REPO, "fetch", "-q", "origin")
    donors = {s: donor(s) for s in ("api", "islands")}
    packs, args = [], []
    for spec in specs:
        key, _, wtdir = spec.partition(":")
        t = tasks[key]; tid = idm[key]
        notes = t.get("notes", "")
        if key in add:
            notes = (notes + "\n\nORCHESTRATOR ADDENDA:\n" + add[key]).strip()
        packs.append({"id": tid, "key": key, "repo": t["repo"], "effort": t.get("effort"), "model": t.get("model"),
                      "title": t["title"], "acs": str(t["acceptance_criteria"]), "notes": notes,
                      "test_plan": str(t.get("test_plan", "")), "requirements": str(t.get("requirements", "")),
                      "deploy_target": t.get("deploy_target"), "release_group": t.get("release_group"),
                      "depends_on": str(t.get("depends_on"))})
        wt = os.path.join(WT, wtdir or f"hfy-{key}")
        if t["repo"] == "harrisonfamily" and not os.path.exists(wt):
            br = f"agent/{tid.lower()}-{key}"
            r = sh("git", "-C", REPO, "worktree", "add", "-q", wt, "-b", br, "origin/main")
            if r.returncode:
                print("worktree failed", key, r.stderr.strip(), file=sys.stderr)
            for s, src in donors.items():
                if src:
                    sh("cp", "-cR", src, os.path.join(wt, s) + "/")
        args.append({"id": tid, "key": key, "wt": wt, "model": t.get("model") if t.get("model") in ("sonnet", "opus", "haiku") else "sonnet",
                     "effort": t.get("effort") or "medium"})
    os.makedirs(os.path.join(STATE, "pln2"), exist_ok=True)
    out = os.path.join(STATE, "pln2", f"{name}.json")
    json.dump(packs, open(out, "w"), indent=1)
    print(json.dumps({"stateDir": STATE, "repoDir": REPO, "wtRoot": WT, "batchFile": out, "tasks": args}))


if __name__ == "__main__":
    main()
