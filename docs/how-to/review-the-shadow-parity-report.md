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

`--shadow` also takes a local folder, for a shadow output you have already downloaded. `--json` prints the same counts as JSON. `--expect-holds <n>` accounts for the objects the add-on held ([Account for the objects the add-on held](#account-for-the-objects-the-add-on-held)), `--expect-stripped <n>` for the media it sent without their location ([Account for media sent without their location](#account-for-media-sent-without-their-location)), and `--expect-baseline-unhydrated <n>` for media whose legacy record was captured while the photo was online-only ([Account for a baseline captured before the files were available](#account-for-a-baseline-captured-before-the-files-were-available)). The prefix must end in `render-shadow/`; any other prefix is refused before anything is downloaded.

The first line is the verdict (`identical`, `explained` or `unexplained`). A small table of counts follows, by class and by rule.

## Read the exit code

| Exit code | Meaning | What to do |
| --- | --- | --- |
| `0` | No difference at all. | Nothing to review. |
| `10` | Differences exist and every one is explained by a rule below. | Read the rule table. The exposure rules (`note-newly-visible`, `text-gate-withheld`) are the ones that change what the site shows. |
| `20` | At least one difference is unexplained. | Send the counts back. Do not approve the cutover on this report. |
| `64` | Usage error. | Check the options. `--expect-holds`, `--expect-stripped` and `--expect-baseline-unhydrated` take a whole number of 0 or more; a negative, non-integer or oversized value is refused and never echoed. |
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
| `birth-date-scrub` | A birth-like event's date text is a bare year or empty where the legacy export had a day or month, or is empty where the legacy export had a bare year or any other text, with the event's `year` unchanged. It is counted on the event file and on the matching entry of a person file. | Q2-02 item 1, sync design 5.2 |
| `media-held-binary` | A Media object whose binary the add-on held, or whose original is missing, reads `missing` true with a null `checksum` and `size` where the legacy export had a checksum. All of these must hold, on the same handle: a legacy checksum, `missing` true and a null checksum and size in the shadow. It is counted on the media file, its `media/index.json` entry and the `primaryPhoto` and `mediaGallery` entries of person files. A media entry whose other fields differ stays unexplained. | Sync design 5.5, BRD2 11.1 |
| `place-coordinates-rounded` | Latitude and longitude are rounded to two decimals. | BRD2 11.1 (PS-15) |
| `place-code-local` | A postal code below the administrative level is blank. | BRD2 11.1 (PS-15) |
| `note-newly-visible` | A note the legacy export left empty has text. This is the exposure change the design asks you to review. | Sync design 11.3 |
| `text-gate-withheld` | The renderer's text gate withheld free text the legacy export published: note text, an event description, a media title, a place URL or a citation title. | Sync design 5.3 and 5.4 |
| `tree-svg-frozen` | A person's `familyTreeMedia` differs: the family-tree SVGs are legacy and frozen. | Sync design 11.5 |
| `merged-person-stub` | The shadow output holds a `{mergedInto}` stub for a retired person ID. | [The render Lambda](../reference/sync-render.md#merged-person-stubs) |
| `media-location-stripped` | A photo was sent as a copy with minimal metadata (no location, and no other metadata but the Orientation and the colour profile), so its `checksum` and, as the copy is shorter, its `size` differ from the legacy export's, which holds the original. All of these must hold, on the same handle: a checksum and a size on both sides, the checksum differing, neither side `missing`. It is counted on the media file, its `media/index.json` entry and the `primaryPhoto` and `mediaGallery` entries of person files. Only with `--expect-stripped <n>`: up to `n` media are explained, and any beyond `n` stay unexplained. Without the option nothing is explained this way. | HFY-TSK-374; [Account for media sent without their location](#account-for-media-sent-without-their-location) |
| `media-baseline-unhydrated` | The legacy export recorded a photo while its file was a Dropbox online-only placeholder, so the legacy record reads the SHA-256 of the empty file with `size` 0 and `missing` false (or a null `checksum` and `size` with `missing` true), where the shadow record, rendered from what the add-on uploaded once the file was available, reads a real `checksum` (64 lowercase hex digits, not the empty file's), a `size` above 0 and `missing` false. All of these must hold, on the same handle, and every other field of the record must be equal. The one exception is the spelling of a JPEG's `s3Key`: `media/<handle>.jpeg` in the legacy export against `media/<handle>.jpg` in the shadow output (same stem, `mime` `image/jpeg`; [why](#account-for-a-baseline-captured-before-the-files-were-available)). It is counted on the media file, its `media/index.json` entry, the `primaryPhoto` and `mediaGallery` entries of person files, which must differ in those fields only, and the `primaryPhoto` text of the same person's `person/index.json` entry. Only with `--expect-baseline-unhydrated <n>`: up to `n` media are explained, and any beyond `n` stay unexplained. Without the option nothing is explained this way. | HFY-TSK-376; [Account for a baseline captured before the files were available](#account-for-a-baseline-captured-before-the-files-were-available) |
| `held-object` | An object the add-on held whole has a legacy file and no shadow file, and its entry left the area's index. Only with `--expect-holds <n>`: up to `n` such files (person, family, event, note, place or media) and their index entries are explained, and any beyond `n` stay unexplained. Without the option nothing is explained this way. | Sync design 5.4 and 5.5; [Account for the objects the add-on held](#account-for-the-objects-the-add-on-held) |

Two kinds of noise are normalised and are not differences. They have their own line, never change the exit code, and a file that differs only by them is not counted as a difference: `index-generated-at` (the `generatedAt` stamp of an index file) and `index-order` (the order of index entries).

The renderer does not own media binaries, `media/faces/*`, the tree SVGs, `person/graph.json`, `person/search-store.json`, the page shell or `uploads/*`. The report lists the legacy files of those kinds on a `not compared` line and does not compare them.

An unexplained count comes with its area and, for a changed file, the schema field name that differs, never a value. Read them like this:

- `only_in_legacy` in `person`, `family`, `event`, `note` or `media`: an object the redaction projection did not send (a private object, a held object, an object only held objects reference). The report cannot tell which rule held it unless you give it the add-on's count with `--expect-holds`; see [Account for the objects the add-on held](#account-for-the-objects-the-add-on-held).
- `only_in_render`: the shadow output holds a file the legacy export does not. Nothing in the design explains it, so every one is a finding.
- `changed` with a field such as `displayName` or `date`: the two sides disagree on a value no rule covers. Every one is a finding.
- `bytes_only`: the JSON is equal and the bytes differ (a serialisation difference). `bad_json`: a file on one side does not parse. `unowned_key`: the shadow output holds a key the renderer must never write.

To look at a file behind a count, use your own tools on your Mac (the two folders are there). Do not paste file names, IDs or values anywhere.

## Account for the objects the add-on held

The add-on keeps some objects off the website whole (an object that holds a phone number, rule `scan.phone`, for example). The legacy export still publishes them, so each shows as an `only_in_legacy` file, with one entry gone from its area's index. The report cannot tell such a file from a private or a stray one by looking at the output. You tell it how many the add-on held, and it explains that many.

**Read the add-on's count.** Run the check on the Mac that holds the tree, with Gramps closed. It writes a preview and changes nothing else ([Install and run the Gramps sync addon](install-the-gramps-sync-addon.md)):

```sh
cd ~/harrisonfamily
gramps/bin/hfy-sync check --json
```

The JSON is the run's `status.json` document. Its `counts.holds` is the number to use. The one-line form without `--json` does not print it, and `status.json` in the tree's sync state folder holds the same `counts`. Use the check of the same moment as the export, with no edit in Gramps between them.

**Give it to the report as `--expect-holds`:**

```sh
cd ~/harrisonfamily
AWS_PROFILE=product-lead gramps/bin/hfy-parity \
  --legacy <project>/workspace-local/harrisonfamily-frontend \
  --shadow s3://<sync-bucket>/render-shadow/ \
  --expect-holds <n>
echo "exit code: $?"
```

Replace `<n>` with the number from the check. The value must be a whole number of 0 or more, or the command exits `64`.

The report then takes up to `<n>` whole files from the `only_in_legacy` absences that no other rule explains (person, family, event, note, place and media files only) and explains them as `held-object`, together with the index entries that left `person/index.json`, `person/search-index.json`, `place/index.json` or `media/index.json` with them. An excluded place and a held-type media file keep their own rules and do not use the allowance. It adds a line, `held objects: allowed <n>, whole-object absences explained <k>`, and a `held-object` row to the rule table; `--json` carries the same two counts under `holds`.

Read it like this:

- **`k` equals `<n>`, exit `10`:** every held object is accounted for.
- **`k` is below `<n>`:** the add-on's count is only an allowance. `counts.holds` also counts a hold that kept a single field back from an object that was still published, so it can be larger than the number of absent files. A smaller `k` is expected in that case; it is not a finding on its own.
- **More absences than `<n>`:** the extra files stay unexplained and the exit code is `20`. Which files count as the first `<n>` is the order of their keys, so only the totals and the areas of the explained rows mean anything; do not read the unexplained area line as naming the held ones.
- **No `--expect-holds`:** nothing changes. Every such absence is unexplained.

## Account for media sent without their location

With the add-on's `strip_location` setting on ([Send photos that have a location without it](sync-gramps-with-the-website.md#send-photos-that-have-a-location-without-it)), a JPEG or PNG with a GPS position reaches the website as a copy without it. The renderer takes a Media's `checksum` and `size` from the stored copy, and the legacy export holds the original, so the checksum differs. You tell the report how many media the add-on sent this way, and it explains that many.

**Read the add-on's count.** `counts.media_location_stripped` is the number of photos whose location-free copy the website holds (an upload counts once the website acknowledged it; `counts.media_location_stripped_pending` is what is still to send, and must be 0 for the review). Take it from a push look or any run's `status.json`, from the same moment as the export:

```sh
cd ~/harrisonfamily
gramps/bin/hfy-sync push --json
```

**Give it to the report as `--expect-stripped`:**

```sh
cd ~/harrisonfamily
AWS_PROFILE=product-lead gramps/bin/hfy-parity \
  --legacy <project>/workspace-local/harrisonfamily-frontend \
  --shadow s3://<sync-bucket>/render-shadow/ \
  --expect-stripped <n>
echo "exit code: $?"
```

Replace `<n>` with the number from the add-on. The value must be a whole number of 0 or more, or the command exits `64` and does not echo it. `--expect-holds` and `--expect-stripped` can be given together.

Add `--stripped-sidecar` to restrict the allowance to the media the add-on recorded as uploaded without their location. It reads the add-on's `state.sqlite` of the tree read-only (`~/Library/Application Support/hfy_sync/<dbid>/state.sqlite`), takes only the handles of its `media_location_stripped` record, and prints none of them:

```sh
AWS_PROFILE=product-lead gramps/bin/hfy-parity \
  --legacy <project>/workspace-local/harrisonfamily-frontend \
  --shadow s3://<sync-bucket>/render-shadow/ \
  --expect-stripped <n> \
  --stripped-sidecar ~/Library/Application\ Support/hfy_sync/<dbid>/state.sqlite
```

Without it the allowance is the first `<n>` media in sorted order whose checksum differs, whatever the reason. With it, a media that differs but was never recorded as sent without its location stays unexplained, and so does every media beyond `<n>`. The option needs `--expect-stripped`, and an unreadable file exits `64`.

The report explains the checksum and size differences of up to `<n>` media (the first `<n>` handles in sorted order; only the totals mean anything) and adds a line, `media sent without their location: allowed <n>, media explained <k>`, a `media-location-stripped` row to the rule table and, with `--json`, the same two counts under `stripped`. A media whose checksum differs from the legacy one beyond `<n>`, or whose size differs while the checksum does not, stays unexplained and the exit code is `20`. A photo the add-on held (`media-held-binary`) keeps its own rule and does not use the allowance.

## Account for a baseline captured before the files were available

The legacy export reads each photo's `checksum` and `size` from the file on your Mac when you export. If the export ran while a photo's file was a Dropbox online-only placeholder, the legacy record holds the checksum of an empty file and a size of 0 (a file the export could not find or read reads a null checksum and size with `missing` true). The add-on does not upload such a file either (`media_blob_placeholder` in [Install and run the Gramps sync addon](install-the-gramps-sync-addon.md)); once the folders are marked Available offline ([The first time](sync-gramps-with-the-website.md#the-first-time-the-migration)) it uploads the file, and the shadow record holds the real checksum and size. The shadow is the current side; the baseline is the stale one. Nothing else differs, and the report cannot tell this from a real change by looking at the output, so you tell it how many media the baseline captured this way.

**Find `<n>`.** No count of the add-on's `status.json` is this number (its `counts` are `pulled`, `pushed`, `conflicts_open`, `holds`, `blocked`, `media_up`, `media_down`, `media_location_stripped` and `media_location_stripped_pending`). It comes from the legacy export, with a read-only check. Run the report as in [Run the report](#run-the-report), with `--expect-holds` and `--expect-stripped` if you use them, and without the new option. The unexplained media are `changed` files in the `media` area, and the `unexplained by field` line shows `checksum` and `size` (and `missing` for a capture that was never read) for them. Read the `media` number of the `unexplained by area` line: it is an upper bound for `<n>`, because a media that differs for another reason is in it too. For a second count from the legacy folder alone, run this in it. It prints one number, and it counts every media record that reads as an empty or unread capture, including one that is the same in the shadow output and needs no allowance:

```sh
cd <project>/workspace-local/harrisonfamily-frontend
python3 -I - <<'PY'
import glob, hashlib, json
empty = hashlib.sha256(b"").hexdigest()
total = 0
for path in glob.glob("media/*.json"):
    if path == "media/index.json":
        continue
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    if (doc.get("checksum") == empty and doc.get("size") == 0) or (
            doc.get("checksum") is None and doc.get("size") is None and doc.get("missing") is True):
        total += 1
print(total)
PY
```

**Give it to the report as `--expect-baseline-unhydrated`:**

```sh
cd ~/harrisonfamily
AWS_PROFILE=product-lead gramps/bin/hfy-parity \
  --legacy <project>/workspace-local/harrisonfamily-frontend \
  --shadow s3://<sync-bucket>/render-shadow/ \
  --expect-baseline-unhydrated <n>
echo "exit code: $?"
```

Replace `<n>` with the number of media. The value must be a whole number of 0 or more, or the command exits `64` and does not echo it. The option can be given with `--expect-holds` and `--expect-stripped`.

The report explains up to `<n>` media (the first `<n>` handles in sorted order; only the totals mean anything): the media file, its `media/index.json` entry, the `primaryPhoto` and `mediaGallery` entries of person files that embed it, and the `primaryPhoto` text of the matching `person/index.json` entry (see below). A media counts once, whatever number of places it appears in. It adds a line, `media whose baseline was captured before the file was available: allowed <n>, media explained <k>`, a `media-baseline-unhydrated` row to the rule table and, with `--json`, the same two counts under `baseline_unhydrated`. Read it like this:

- **`k` equals `<n>`, exit `10`:** every such media is accounted for.
- **`k` is below `<n>`:** fewer media qualified than you allowed. Set `<n>` to `k` and run again, so the allowance is exact.
- **More such media than `<n>`:** the extra media, and the person files that embed them, stay unexplained and the exit code is `20`.
- **A media that differs in any other field, or whose shadow record is itself empty, `missing` or of size 0:** it is not this pattern. It stays unexplained whatever `<n>` is, and its index entry and person entries with it. The same holds for a person entry that differs from the shadow in a field besides `checksum`, `size`, `missing` and the key spelling below, and for a person file with any other unexplained difference.
- **No `--expect-baseline-unhydrated`:** nothing changes. Every such media is unexplained.

A media counts under one rule only. A media that `media-location-stripped` explains keeps that rule and does not use this allowance. An empty capture also fits the stripped rule's pattern (a checksum and a size on both sides, the checksum differing, neither side `missing`), so in a run that gives both options also give `--stripped-sidecar`, as in [Account for media sent without their location](#account-for-media-sent-without-their-location): without it the stripped allowance takes the first matching media in sorted order, an empty capture among them. The photo that was held (`media-held-binary`) keeps its own rule too.

**The JPEG key spelling.** The cloud stores every `image/jpeg` as `media/<handle>.jpg` whatever the file was called (`MEDIA_TYPES` in `api/src/sync/media.js`), while the legacy export keeps the file's own suffix, so a photo called `.jpeg` has the key `media/<handle>.jpeg` there and `media/<handle>.jpg` in the shadow output. A capture whose key differs only in this way is still this pattern: the legacy key is `media/<handle>` plus `.jpeg` (any letter case), the shadow key is `media/<handle>.jpg`, and the record's `mime` is `image/jpeg`. Anything else in the key stays unexplained: another stem or folder, another suffix pair (`.png`, `.jpe`, `.jfif`, the reverse `.jpg` to `.jpeg`), or a `.jpeg` key on a record of another type. A `title` or any other field that differs is not covered by this: the media stays unexplained. The media file, its index entry and the person entries must all spell the key the way the media file does; an entry that spells it otherwise is unexplained.

**`person/index.json`.** A person's entry carries the primary photo as a bare `s3Key` text and no checksum. Its `primaryPhoto` text is explained when it differs by the key spelling above and the primary photo of the same person (the entry's Gramps ID and handle, read from the person file on both sides, which must name the same photo) is a media this rule explains with that very pair of keys. Any other difference of the entry, or of the file, is not read: the file stays unexplained and the `unexplained by field` line names the field. The `media-location-stripped` rule does not explain an `s3Key` or the index text, with or without this rule, and that has not changed.



## Send it back

Send the report as printed: the whole output of the command (the verdict line, the tables and the counts), together with the exit code. Nothing else. Do not send the legacy folder, the shadow output, file names or screenshots of records.

The report is the evidence for the parity item of the seed task. Whether to approve the cutover is your decision, recorded as the G-prod approval ([Cut over to the cloud store](sync-gramps-with-the-website.md#cut-over-to-the-cloud-store)); `10` with no surprising exposure counts is the expected result, and `20` is a blocking finding to record.

## Related pages

- [Sync Gramps with the website](sync-gramps-with-the-website.md) — the migration and the cutover this review sits in.
- [The render Lambda](../reference/sync-render.md) — what the shadow mode writes and which keys the renderer owns.
- [Operate the sync store](operate-the-sync-store.md) — `render --full`, if the shadow output must be rendered again.
