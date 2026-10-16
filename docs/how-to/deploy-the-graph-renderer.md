# How to deploy the graph renderer

Use this page to ship `hfy-graph-render`, the Node 22 Lambda that regenerates `person/graph.json` and `media/faces/` from the cloud store after each live render pass (HFY-TSK-274, release group RG-6). Without it the graph freezes after the cutover, because the interim publisher is denied the data prefixes. What the function does is in the [graph README](../../graph/README.md#the-cloud-source-hfy-graph-render); how the renderer starts it is in [The render Lambda](../reference/sync-render.md#graph-trigger).

The function, its role, the `GraphRenderCodeKey` parameter and the invoke configuration are part of [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml). The package is a commit-named zip that ships through the same reviewed change set as the other functions ([Deploy the app stack](deploy-the-app-stack.md)). Every step needs io's go-ahead, and the change set is created on `<app-stack>`, never on the template default `hfy-app`.

## Build and upload

1. From the merged `origin/main` commit, in a checkout with Node 22, `zip` and network access to the public npm registry (no CodeArtifact token: nothing in this package is an `@io-kit` package):

   ```sh
   bash scripts/ci/package-graph-render.sh
   ```

   It installs for `--os=linux --cpu=arm64 --libc=glibc`, because `sharp` ships native libvips binaries per platform, keeps only the `linux-arm64` ones, checks that the staged package imports, and prints `GraphRenderCodeKey=lambda/hfy-graph-render-<sha12>.zip`.
2. Upload it to the key it printed, in the code bucket in `us-west-2`: `aws s3 cp dist/hfy-graph-render.zip s3://<code-bucket>/<GraphRenderCodeKey> --region us-west-2`. Never re-upload to a key a deployed change set already used.

## Change set (RG-6)

Set `GraphRenderCodeKey` in the same change set that ships the `hfy-api` and `hfy-auth-edge` zips and the cutover parameters (the graph renderer must exist before `RenderMode=live`, so that the first live pass can start it). With a parameter-only flip, use `--use-previous-template` and `UsePreviousValue` for every other parameter. Post the `describe-change-set` summary (no `Remove` action) for io, execute it after the go-ahead, and confirm the `FunctionUrl` and `AuthFunctionUrl` outputs are unchanged. The role `hfy-graph-render-role` is one of the exceptions of the data-prefix write guard (`apply-data-write-guard.sh`), so apply the guard after the role exists.

## Smoke and verify

1. `bash scripts/ci/smoke-graph-render.sh --profile <profile>` invokes the deployed function with `{"smoke":true}`. It must print `ok`: the packaged `sharp` cropped a synthetic 160 by 160 WebP. It reads no family data and calls no AWS service.
2. After the first live pass, check `SYNC#GRAPH` (`built_seq` equal to the pass's `seq`, no `last_error`), then fetch `person/graph.json` signed in and check that `source.kind` is `cloud`.
3. A failed pass emits `RenderError`, so the renderer's own alarm fires; the previous graph stays. Read the code in `SYNC#GRAPH.last_error` (`GraphRenderError:<code>`; the codes are the builder's exit-code names such as `PRIVACY_VIOLATION` and `SIZE_BUDGET`, or an AWS error name). To rebuild after a fix: `aws lambda invoke --function-name hfy-graph-render --payload '{"force":true}' ...`.
4. To roll back, set `GraphRenderCodeKey` to the previous key (or the placeholder `lambda/hfy-graph-render-placeholder.zip`, which does nothing and leaves the last graph in place).

## Staleness window

The graph converges within one 15-minute schedule tick of the sync renderer after any change: the tick re-invokes the graph function, which skips when `SYNC#GRAPH` already matches the head seq and the hidden-item digest. This covers a moderation hide or unhide that does not move the store seq, a pass skipped because a push session was young, and a failed invoke. An operator can force a rebuild with `{"force": true}`. A face pruned right after `graph.json` is replaced can 404 for a cached older page until it refreshes; this matches the sync renderer.
