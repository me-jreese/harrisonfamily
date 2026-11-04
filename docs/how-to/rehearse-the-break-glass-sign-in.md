# How to rehearse the break-glass sign-in

This page walks io through a dry run of the break-glass role, `hfy-data-breakglass`, with an agent doing the read-only checks before and after. The rehearsal proves that io can reach the role with the MFA device and that nothing is left behind afterwards. It is the P6 step of HFY-TSK-247 (ruling P2-R85). The agent never signs in, never assumes the role and never holds the credentials (ruling P2-R25); io does both steps. [`scripts/infra/rehearse-break-glass.sh`](../../scripts/infra/rehearse-break-glass.sh) is the agent's side: it calls only read-only AWS verbs, mutates nothing and prints no secret.

Values in angle brackets are placeholders, listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders). The role's trust policy, its grants and the write guard it is an exception to are described in [Deploy the app stack](deploy-the-app-stack.md) and [Sync Gramps with the website](sync-gramps-with-the-website.md#cut-over-to-the-cloud-store). The role is used for real in [Operate the sync store](operate-the-sync-store.md#remove-something-from-the-cloud).

## Before you start

- io is present for the whole rehearsal, with the MFA device in hand. An agent cannot do this alone.
- The `hfy-data-breakglass` role exists in `<app-stack>` (`BreakGlassRoleArn` is an output).
- The shell has `aws`, `jq` and `python3`, and io's usual credentials, which can read IAM roles and the bucket policy.
- Write down io's IAM user name (`<io-user>`) for the credential report row.
- Choose a moment when no other break-glass work is running. The rehearsal reads only, and its session writes nothing.

## The steps

1. **Agent: pre-check.** From a shell with io's usual credentials:

   ```bash
   scripts/infra/rehearse-break-glass.sh pre --principal-user <io-user>
   ```

   It checks that the role exists, that its trust policy allows only `sts:AssumeRole` with an `aws:PrincipalArn` condition and `aws:MultiFactorAuthPresent` set to `true`, that `MaxSessionDuration` is 3600 seconds, that the inline policy grants the six data prefixes and nothing on `uploads/`, the table or the sync bucket, whether the data-prefix write guard is applied and exempts the role, and the principal's row in the credential report (MFA active, count of active access keys). It exits `0` when no check failed (a `WARN` line does not fail) and `1` otherwise. Fix any `FAIL` before you go on. Note the active-key count it prints.
2. **Agent: record the baseline.** Put the counts and the UTC time of the pre-check on HFY-TSK-247.
3. **io: assume the role.** This is io's step alone, with the MFA device. Run `aws sts assume-role` for the role named by `BreakGlassRoleArn`, with `--serial-number <mfa-device-arn>`, `--token-code <code>` and a session name such as `rehearsal`, exactly as [Credentials of a record run](operate-the-sync-store.md#remove-something-from-the-cloud) does, putting the result straight into the environment, never into an argument, a file or the chat. Note the UTC time as `<assumed-at>`, for example `2026-11-20T17:05:00Z`.
4. **io: prove the session reaches the data prefixes, and only those.** Run `aws sts get-caller-identity` with the session (it names `assumed-role/hfy-data-breakglass`), and one read of a harmless key under a data prefix. Do not write or delete anything: the rehearsal needs no change to the site. Paste nothing from this step to the agent but yes or no.
5. **io: end the session.** Unset the variables and close the shell:

   ```bash
   unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
     EXPUNGE_SITE_AWS_ACCESS_KEY_ID EXPUNGE_SITE_AWS_SECRET_ACCESS_KEY EXPUNGE_SITE_AWS_SESSION_TOKEN
   ```

   Temporary credentials expire one hour after `<assumed-at>`. Wait for that, or continue once the pre-check's session length has passed.
6. **Agent: post-check.** From a fresh shell with io's usual credentials, after the hour has passed:

   ```bash
   scripts/infra/rehearse-break-glass.sh post --assumed-at <assumed-at> \
     --principal-user <io-user> --expect-active-keys <count-from-step-1>
   ```

   It fails while the session may still be live, when the shell still holds a `hfy-data-breakglass` session or an `EXPUNGE_SITE_AWS_*` variable (names only, never values), or when the principal's active access keys differ from the baseline. It prints the role's last-used time.
7. **Agent: record the evidence** (below) on HFY-TSK-247.

The script never generates the credential report. If it warns that none is available, io may run `aws iam generate-credential-report` and wait for it; then rerun.

## Evidence for HFY-TSK-247

Record counts and timestamps only. Never record a key, a token, a code, an ARN of io's user, an account id or a bucket listing.

- The UTC times of the pre-check, `<assumed-at>` and the post-check.
- The pre-check and post-check summary lines (passed, failed and warnings counts) and the names of any `WARN` lines.
- Whether the write guard was applied at the pre-check.
- The active access key count before and after.
- The role's last-used time, as the post-check prints it.
- A statement that io performed the sign-in with the MFA device, and that the agent did not.

## If the rehearsal goes wrong

- **The assume-role call is refused.** Nothing changed. Check the MFA device clock and the token code; check that the pre-check's trust lines passed and that io's current principal is the one pinned in the `BreakGlassPrincipalArn` parameter of the stack. Do not edit the trust policy by hand: change the parameter in a reviewed change set ([Deploy the app stack](deploy-the-app-stack.md)).
- **A variable or a credential file may have leaked.** Unset the variables, close the shell and delete any file that held the credentials. The session expires on its own within the hour. If a token reached a chat, a log or a commit, treat it as exposed: io can end the session early with the role's Revoke active sessions action in the IAM console (it denies credentials issued before now); otherwise wait out the hour. Say so on HFY-TSK-247.
- **The post-check reports an extra active access key.** Do not delete it from the script (it cannot). Io reviews the key in the console; deleting it is io's decision.
- **Something was written during the session.** Stop. The write guard exempts this role, so check the site against the last deploy and use [Roll back a site deploy](roll-back-a-site-deploy.md) if a rendered file changed. Raise it on HFY-TSK-247.
- **The post-check cannot read IAM.** Run it with io's administrator credentials, not the break-glass session, which cannot read IAM.

## Related

- [Operate the sync store](operate-the-sync-store.md): the real use of the session.
- [Rotate the session signing key](rotate-the-session-signing-key.md): another operation that needs io present.
