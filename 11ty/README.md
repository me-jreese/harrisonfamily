# 11ty/

Deployable output of the site, synced to S3 on every deploy. It is not only Eleventy output: it also holds repo-authored E5 files (the flags, the new sign-in script, the PWA shell, the posts and notification pages) that the out-of-repo Eleventy source does not produce. `js/islands/` is the committed build output of `islands/` (HFY-R58): rebuild it with every `islands/` change and never edit it by hand.

Never `rsync --delete` into this directory; it deletes the E5 files. Refresh it only with [Refresh the Eleventy output](../docs/how-to/refresh-the-eleventy-output.md). What each file is: [Front end](../docs/reference/front-end.md). Why the directory has two sources of truth: [Why React islands on a generated Eleventy site](../docs/explanation/islands-on-eleventy.md).
