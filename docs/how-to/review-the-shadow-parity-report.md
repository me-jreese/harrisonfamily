# Review the shadow parity report

Compare what the render Lambda wrote in shadow mode with a legacy export staged at the same moment, on your own Mac, and read the difference as counts. This is the parity review of the migration ([The first time](sync-gramps-with-the-website.md#the-first-time-the-migration), step 8) and a precondition of the cutover ([Cut over to the cloud store](sync-gramps-with-the-website.md#cut-over-to-the-cloud-store)). The tool is [`gramps/bin/hfy-parity`](../../gramps/bin/hfy-parity) (HFY-TSK-370). It is an operator tool: it is never deployed, and no workflow runs it.

The report holds counts only. It never prints a key, a Gramps ID, a name, a path or a value, on screen or in an error, so what it prints can be sent back as it is. The real family data stays on your Mac.

## Before you start

- **A shadow render exists.** The orchestrator has told you that the seed finished and the shadow render ran. The renderer writes its shadow output under `render-shadow/` in the sync bucket (`<sync-bucket>`; [The render Lambda](../reference/sync-render.md#modes)). If there is nothing there, the report exits `69` and says so.
- **A legacy export was staged at the same moment.** Run steps 1 to 3 of [the legacy procedure](sync-gramps-with-the-website.md#1-export-from-gramps) (export, family trees, search manifests) into the usual local folder, `<project>/workspace-local/harrisonfamily-frontend`, with no edit in Gramps between the seed's Apply and the export, so both sides describe the same tree. **Do not run step 4, the sync**: it publishes, and the legacy publish is not to run during the migration window. The folder is the one that holds `person/`, `event/`, `family/`, `note/`, `place/` and `media/` at its top.
- **Your AWS profile can read the shadow prefix.** Use `AWS_PROFILE=product-lead`. The tool only downloads: it runs `aws s3 sync s3://<sync-bucket>/render-shadow/ <temporary folder>` and nothing else, never `--delete`, never an upload, and it removes the temporary folder when it ends, also after an error or an interrupt. It needs the `aws` command-line tool, and Python 3.9 or later (the macOS `python3` is enough; nothing to install).

## Run the report

```sh
cd ~/harrisonfamily
AWS_PROFILE=product-lead gramps/bin/hfy-parity \
  --legacy <project>/workspace-local/harrisonfamily-frontend \
  --shadow s3://<sync-bucket>/render-shadow/
echo "exit code: $?"
```

`--shadow` also takes a local folder, for a shadow output you have already downloaded. `--json` prints the same counts as JSON. The prefix must end in `render-shadow/`; any other prefix is refused before anything is downloaded.

The first line is the verdict (`identical`, `explained` or `unexplained`). A small table of counts follows, by class and by rule.

## Read the exit code

| Exit code | Meaning | What to do |
| --- | --- | --- |
| `0` | No difference at all. | Nothing to review. |
| `10` | Differences exist and every one is explained by a rule below. | Read the rule table. The exposure rules (`note-newly-visible`, `text-gate-withheld`) are the ones that change what the site shows. |
| `20` | At least one difference is unexplained. | Send the counts back. Do not approve the cutover on this report. |
| `64` | Usage error. | Check the two options. |
| `69` | The shadow output is unreachable or holds none of the renderer's files. | Check the profile, the bucket and the prefix, and that the orchestrator ran the shadow render. |
| `70` | An internal error. The line names the exception class only. | Send the line back. |
| `78` | The legacy folder is missing, or holds none of the files to compare. | Check the path; the folder must hold `person/`, `event/` and the rest at its top. |

## Read the counts

The class table counts files. A file counts once per class and is either explained or unexplained:

- `only_in_legacy`: the legacy export has the file and the shadow output does not.
- `only_in_render`: the shadow output has the file and the legacy export does not.
- `changed`: both have it with different bytes. It is explained only when every difference inside it is explained.

The rule table counts the explained files by rule, with the area they sit in (`person`, `family`, `event`, `note`, `place`, `media` or `index`). A file that needs two rules is counted under both. The rules are the differences the design documents, and nothing else is explained:

| Rule | What it is | Source |
| --- | --- | --- |
| `excluded-place` | A street-level or home-like place has no file in the shadow output, leaves `place/index.json`, and every reference to it points at the nearest kept ancestor. The excluded places are the legacy place files whose type matches the redaction policy. | Q2-02 item 2, sync design 5.3 |
| `media-held-mime` | A Media object of a held type (a PDF) has no `media/<handle>.json` and no index entry. | Q2-02 item 6, sync design 5.5 |
| `birth-date-scrub` | A birth-like event's date text is a bare year or empty where the legacy export had a day or month. | Q2-02 item 1, sync design 5.2 |
| `place-coordinates-rounded` | Latitude and longitude are rounded to two decimals. | BRD2 11.1 (PS-15) |
| `place-code-local` | A postal code below the administrative level is blank. | BRD2 11.1 (PS-15) |
| `note-newly-visible` | A note the legacy export left empty has text. This is the exposure change the design asks you to review. | Sync design 11.3 |
| `text-gate-withheld` | The renderer's text gate withheld free text the legacy export published: note text, an event description, a media title, a place URL or a citation title. | Sync design 5.3 and 5.4 |
| `tree-svg-frozen` | A person's `familyTreeMedia` differs: the family-tree SVGs are legacy and frozen. | Sync design 11.5 |
| `merged-person-stub` | The shadow output holds a `{mergedInto}` stub for a retired person ID. | [The render Lambda](../reference/sync-render.md#merged-person-stubs) |

Two kinds of noise are normalised and are not differences. They have their own line, never change the exit code, and a file that differs only by them is not counted as a difference: `index-generated-at` (the `generatedAt` stamp of an index file) and `index-order` (the order of index entries).

The renderer does not own media binaries, `media/faces/*`, the tree SVGs, `person/graph.json`, `person/search-store.json`, the page shell or `uploads/*`. The report lists the legacy files of those kinds on a `not compared` line and does not compare them.

An unexplained count comes with its area and, for a changed file, the schema field name that differs, never a value. Read them like this:

- `only_in_legacy` in `person`, `family`, `event`, `note` or `media`: an object the redaction projection did not send (a private object, a held object, an object only held objects reference). The report cannot tell which rule held it. Compare the count with the holds that **Check** reported on your Mac; they should match.
- `only_in_render`: the shadow output holds a file the legacy export does not. Nothing in the design explains it, so every one is a finding.
- `changed` with a field such as `displayName` or `date`: the two sides disagree on a value no rule covers. Every one is a finding.
- `bytes_only`: the JSON is equal and the bytes differ (a serialisation difference). `bad_json`: a file on one side does not parse. `unowned_key`: the shadow output holds a key the renderer must never write.

To look at a file behind a count, use your own tools on your Mac (the two folders are there). Do not paste file names, IDs or values anywhere.

## Send it back

Send the report as printed: the whole output of the command (the verdict line, the tables and the counts), together with the exit code. Nothing else. Do not send the legacy folder, the shadow output, file names or screenshots of records.

The report is the evidence for the parity item of the seed task. Whether to approve the cutover is your decision, recorded as the G-prod approval ([Cut over to the cloud store](sync-gramps-with-the-website.md#cut-over-to-the-cloud-store)); `10` with no surprising exposure counts is the expected result, and `20` is a blocking finding to record.

## Related pages

- [Sync Gramps with the website](sync-gramps-with-the-website.md) — the migration and the cutover this review sits in.
- [The render Lambda](../reference/sync-render.md) — what the shadow mode writes and which keys the renderer owns.
- [Operate the sync store](operate-the-sync-store.md) — `render --full`, if the shadow output must be rendered again.
