---
name: pmt-frontend-bridge-report-text
description: Read the text inside the user's own Project files when the file is a PDF, a scan, or a photo (PDF text layer + OCR), then answer questions about it, tabulate several reports, or save the result into Analysis Results. Use for "这份报告里写了什么", "这几个 PDF 帮我汇总一下", "这是扫描件，你能读吗", or extracting patient details / lab values from reports.
---

# Reading report text (PDF, scans, photos)

**Scope: reading files and their text.** This skill covers finding things in the patient tree,
reading a document's text, and saving a result into Analysis Results. It does **not** cover acting on the
UI (expanding the tree, opening a viewer, selecting an instance), reading the Analysis Results list,
labels, Data Packaging or ROI — those live in a separate skill that is *not* loaded in this conversation.
If a request needs one of them, say plainly that you cannot do it here (and that the user can do it in the
UI, or enable the full bridge skill) instead of guessing at endpoint names.

**Do not go looking for this skill's files on disk, and do not announce what you are about to do.** There is
nothing to fetch: the commands below are the whole answer. Never end a turn with a statement of intent ("let
me read the reports", "I'll use the report-text skill"): if you say you are going to do something, do it in
the same turn by calling the tool.

**The user will not say any of this.** They will not mention an endpoint, a `ref`, "OCR", a "text
layer", a dpi or a category — they will say 「这份报告里写了什么？」「这几个 PDF 帮我汇总一下」「扫描件你能读
吗？」. Find the files, resolve them and extract them yourself, then just report the content. Never ask
the user for any of those.

## The whole job, in five commands

```sh
# 1. find the report files — narrow it, never fetch the whole tree
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/tree?slots=patient,timepoint,pmt-timepoint-file,pmt-patient-level-file,file"

# 2. ref -> absolute path
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" -H 'Content-Type: application/json' -X POST \
  -d '{"refs":["asset:…","asset:…"]}' "$FRONTEND_BRIDGE_URL/api/frontend/file/resolve"

# 3. the text of each document (add --max-time 900: OCR is slow)
curl -s --max-time 900 -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" -H 'Content-Type: application/json' -X POST \
  -d '{"refs":["asset:…","asset:…"]}' "$FRONTEND_BRIDGE_URL/api/frontend/extract"

# 4. build the CSV yourself (heredoc, no script), then import it
cat > /tmp/summary.csv <<'EOF'
姓名,CA19-9
DOE^JANE,1284.00
EOF
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" -H 'Content-Type: application/json' -X POST \
  -d '{"command":"addAnalysisResults","payload":{"category":"pmt-patient-blood-tests","paths":["/tmp/summary.csv"]}}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/ui/dispatch"

# 5. show it in the panel
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" -H 'Content-Type: application/json' -X POST \
  -d '{"command":"openAnalysisResults","payload":{"category":"pmt-patient-blood-tests","name":"summary.csv"}}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/ui/dispatch"
```

That is the entire procedure. The sections below explain the options, the traps and how to report
results — read them, but do not go looking for another way to do any of the five steps.

## Environment — read this before anything else

- **The bash tool needs a `description` argument** (3–5 words summarising the command). If a call comes back
  `"description": Required`, add it and send the *same* command again — that is a schema requirement, not a
  signal that the approach is wrong.

- **`$FRONTEND_BRIDGE_URL` and `$FRONTEND_BRIDGE_TOKEN` are already set in your shell.** Use them as-is in
  every command below; there is nothing to look up.
- **Never search the repository, config files or `.env` for a token, a URL or a port.** Nothing useful is
  there, the token is generated fresh for each app session, and a search that cannot succeed will consume
  the entire turn. If you notice yourself planning to look for it, stop and run the curl instead.
- If a call returns **401**, or `FRONTEND_BRIDGE_URL` is empty, the bridge is unavailable: **say so plainly
  and stop.** Do not fall back to reading the application's source code.
- Use `curl` (and `jq` when shaping output). **Do not use `node`/`npx`/`tsx`** — a packaged build has no
  node on `PATH` — and do not write scripts to post-process what curl returns.
- **Run the commands below verbatim**, changing only the query values. This skill already encodes the
  procedure that works; do not redesign it. If a command fails, report that error instead of starting a
  different investigation.

## The bridge is the only source of truth for the user's project

- **Do not `grep`, `glob` or `view` files in the working directory** to answer a question about the user's
  patients, reports or values. Those files are the *implementation* of the application: they describe how
  the viewer works, never what is in the user's project. In a packaged build there is no application source
  there at all, so such a search is not merely unhelpful — it is guaranteed to burn the turn and produce
  nothing.
- **Do not go looking for this skill's own files on disk** (a skill directory, a `SKILL.md`, a config
  file). Everything this skill has to say is already in your context; searching for it is the same dead
  end as searching for the token.
- **Do not guess** patient names, keys, counts, dates or file contents. Fetch them from the bridge.
- The **only** files worth opening are ones the bridge hands you: a `textPath` from `/extract`, or a path
  from `/file/resolve`. Those hold the user's data; everything else is the app's own code.
- If `FRONTEND_BRIDGE_URL` is unset or a call answers **401**, say the bridge is unavailable and stop. Do
  not fall back to reading code "to find out anyway".

## You are inside the app — act through the bridge, never by automation

You are the assistant **embedded in this desktop application**. Its panels, tabs and rows are not something
you launch, click or drive from the outside, and its behaviour is not something you discover by reading its
source. Every UI action available to you is a **bridge command** that the app itself executes and reacts to
— that is exactly what `POST /api/frontend/ui/dispatch` is for.

So when the user says 「存进 Analysis Results」「导入」「打开面板」「定位到它」, the answer is a dispatch
command, never an investigation:

- **Never read the application's source code** to find out how a panel works or how importing works. The
  command you need is written out in step 4 and step 5 below.
- **Never try to launch, focus or automate the app's UI** (no AppleScript, no clicking, no opening a file
  manager). The app is already running — it is the thing you are talking to.
A tab label the user says out loud ("Blood Tests" in English, or a Chinese equivalent) is a **`category` argument**, not a place you navigate to.
  For the files in this walkthrough it is the same `dataType` you read in step 1
  (`pmt-patient-blood-tests`).

Translate what they say into a command — do not go looking for how to do it:

| the user says | you do |
|---|---|
| 「汇总成一张表」「生成 CSV」 | write the CSV yourself (step 4) — no script |
| 「存进 / 导入 / 保存到 <标签>」 | `addAnalysisResults` (or `createAnalysisResultSpreadsheet`) — step 4 |
| 「打开面板」「定位到它」「给我看看」 | `openAnalysisResults` — step 5 |

## The five steps

### 1. Find the file → `GET /api/frontend/tree`

The tree is a flat `nodes` array in display order; report files are leaves. Take the node's **`ref`**.

**Narrow the call — the unfiltered tree is enormous.** On a project with DICOM every instance is a
node, so the whole tree is megabytes: measured on a 3-patient project (2 studies x 3 series x 150
instances) it was **1.34 MB ≈ 370,000 tokens**, versus **1.9 KB ≈ 530 tokens** for the narrowed call
below. An unfiltered call does not just cost time, it destroys your own context: the tool result pushes
the conversation out of the window and you start contradicting what you already read.

```sh
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/tree?slots=patient,timepoint,pmt-timepoint-file,pmt-patient-level-file,file"
```

`slots=` returns only the row types you name **plus the patient/timepoint chain that gives them meaning**.
Add `&patientKey=<patientKey>` when the question is about one patient, and `&files=false` when you only
need structure.

`meta.totalNodeCount` is the size before your filter and `meta.nodeCount` is what you got back, so:
**`nodeCount` in the thousands — or `nodeCount` close to `totalNodeCount` — means the filter did almost
nothing** and you should add `patientKey` or `files=false`. A small `nodeCount` against a large
`totalNodeCount` is the filter working; that is the normal, good case.

**This one endpoint also answers the orientation questions**, so do not send the user hunting for a
different tool — "which patients are there?", "which timepoints does patient X have?", "what is under that
timepoint?" are all tree questions:

| `slot` | what it is | `keys` |
|---|---|---|
| `patient` | one patient | `[patientKey]` |
| `study` / `series` / `instance` | DICOM under that patient | `[patientKey, …]` |
| `timepoint` | one date on the patient's timeline | `[patientKey, "tp\|<YYYY-MM-DD>"]` |
| `pmt-timepoint-file` | a report under a timepoint — the nine timeline data types (blood tests, pathology, clinical notes…) | `[patientKey, timepointKey, ref]` |
| `pmt-patient-level-file` | the one header-branch type (`pmt-patient-demographic-data`) | `[patientKey, dataTypeKey, ref]` |
| `other-files` / `file-type` / `file` | files not attached to any patient | `['other-files', …]` |

- The `patient` node carries `PatientName` / `PatientID`, which is how you match a name the user said
  out loud, and its `keys[0]` **is** the `patientKey`.
- **`patientKey` is not `dicomEntityId`.** Labels are keyed on `dicomEntityId`; the tree filter wants
  `patientKey`. Passing the wrong one is answered with HTTP 400/404 whose message names the ids that
  would have worked — read it and retry. Never read an error (or an empty `nodes` list) as "this patient
  has no data".
- Do not fetch the tree twice in one turn, and never paste the node list back to the user.
- If the user means "the one I'm looking at", use `GET /api/frontend/current` and read
  `lookingAt.file` (`name`, `ref`, `absolutePath`, `patientName`). That `ref` goes straight into step 2 —
  no tree search needed.
- You do **not** need `/api/frontend/parsed/*` for any of this: the tree already carries `ref`,
  `dataType` and the names.

### 2. Ref → real path → `POST /api/frontend/file/resolve`

```sh
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" -H 'Content-Type: application/json' -X POST \
  -d '{"ref":"asset:<assetId>"}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/file/resolve"
# -> {"file":{"ref":"…","path":"/abs/path/report.pdf","name":"report.pdf",
#             "exists":true,"kind":"file","byteSize":12345,"refType":"asset","error":null}}
```

- A `ref` is `evidence:<sourceRootId>:<relativePath>` (a file under a Source Root) or
  `asset:<assetId>` (a managed copy inside the Project). Never build a path yourself.
- `exists:false` means the file is gone: say so. Never claim to have read it.
- If `path` does not end in `.pdf`/`.png`/`.jpg`/`.jpeg`, this skill cannot read it — extraction
  supports PDFs and images only.

### 3. Extract the text → `POST /api/frontend/extract`

```sh
curl -s --max-time 900 -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" -H 'Content-Type: application/json' -X POST \
  -d '{"ref":"asset:<assetId>"}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/extract"
```

For two or three files, one call with `{"refs":["…","…","…"]}` (max 20, run one after another). For more
than that, or if a request might be cut off, queue it instead and poll:

```sh
-d '{"refs":["…","…"],"background":true}'    # -> {"jobs":[{"ref":"…","jobId":"extract-…"},…]}
# then: GET /api/frontend/extract/jobs/<jobId>  -> {"job":{"state":"queued|running|completed|failed",
#                                                       "percent":40,"error":null,"result":{…}}}
```
`state:"queued"` is normal — the runner is sequential. Keep polling until nothing is queued/running, and
tell the user how many are done rather than going silent.

The result, per file:

| field | meaning |
|---|---|
| `text` | the extracted text |
| `textPath` | the same text cached inside the Project — **read this file with your own tools** (grep/sed/head) instead of extracting again; repeating the call returns `cached:true` in milliseconds |
| `pages[].source` | `text` (exact text layer) · `ocr` (recognised) · `mixed` (both on that page) · `empty` |
| `ocrRan` | `false` means the text came from the PDF's own text layer and is **not** a recognition result |
| `ocrBoxCount`, `avgConfidence`, `lowConfidenceBoxes` | OCR scale and quality, when OCR ran |
| `sourceKind` | `pdf` or `image`; `imageRender.scale < 1` means a large photo was shrunk before OCR |
| `unmappedCompatChars` | non-empty means the extractor produced CJK compatibility characters it could not repair (`⻔` for `门`): usable, but exact matching may fail |

Options: `{"dpi":300}` is **not** a general accuracy win (measured: identical accuracy, ~30% slower on a
~205 dpi scan), so leave the default. `{"force":true}` ignores the cache.

If extraction fails, `GET /api/frontend/extract/status` reports whether the OCR runtime is installed and
which text-layer provider is in use; pass that reason on to the user instead of retrying blindly.

### 4. Build the table and save it

**Assemble the CSV yourself — do NOT write a script to parse the reports.** You already read the text;
you *are* the parser. A Python/awk/regex detour adds quoting and escaping failure modes, and a turn spent
debugging a regex produces nothing the user can see. (Reach for code only if the user asks for something
across many files, far more than a handful.)

The mechanically safest way to produce the file — a quoted heredoc needs no JSON escaping, so Chinese,
commas and quotes go in as-is:

```sh
cat > /tmp/report-summary.csv <<'EOF'
患者姓名,病历号,性别,年龄,采集时间,CA19-9
DAVIDSON^DOUGLAS,00M4396318,男,58岁,2026-08-20 09:15,1284.00
EOF
```

Then import it. Use the file's own `dataType` from step 1 as `category` (that is the tab the result
belongs in, e.g. `pmt-patient-blood-tests`):

```sh
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" -H 'Content-Type: application/json' -X POST \
  -d '{"command":"addAnalysisResults","payload":{"category":"pmt-patient-blood-tests","paths":["/tmp/report-summary.csv"]}}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/ui/dispatch"
```

The row name becomes the file's **basename** (`report-summary.csv`), which is what you pass to
`openAnalysisResults`. Alternatives: `createAnalysisResultSpreadsheet` with `{category, name, csvText,
type}` builds the file from a string for you — but then the CSV's newlines must be `\n` **inside the
JSON**, which is exactly the escaping that breaks; prefer the heredoc. A field containing a comma must be
quoted either way.

### 5. Show it

```sh
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" -H 'Content-Type: application/json' -X POST \
  -d '{"command":"openAnalysisResults","payload":{"category":"pmt-patient-blood-tests","name":"report-summary.csv"}}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/ui/dispatch"
```

`openAnalysisResults` opens the panel, selects the tab and flashes that row; it matches by `assetId` or by
exact `name`.

**Report the outcome in the user's words, not the command names.** Name what they can now see and where it landed —
which panel, which tab — in their own language. Naming the endpoint you called is not a report.
Say what they can now see and where. One caveat: the panel opens on whichever tab it was last showing, so if
you opened it for a specific category and it did not switch, send the same `openAnalysisResults` command a
second time — the second call does move the tab. `createAnalysisResultSpreadsheet` returns **no** `assetId`, so locate by the category + name
you used. Verify with `GET /api/frontend/ui/state` → `ui.analysisResults` (`open`, `category`, `filter`)
before telling the user they can see it.

## Reporting rules

- **Say how each file was read.** `source:"text"` is exact; `source:"ocr"` is recognition output. A
  user who is told "read" for an OCR result will trust digits that may be wrong. Quote `avgConfidence`
  when it is low, and name the files that were OCR'd.
- **OCR error concentrates in symbols, not in the data.** Measured on a scanned report: the differing
  characters were misread arrows (`↑`/`↓` read as `1`, or dropped) plus footer boilerplate — everything
  in the names, IDs, dates, values and units survived. So prefer the primary values over
  derived/symbol columns.
- **Recompute a derived column rather than copying it.** A lab flag (`↑` high / `↓` low) is a function of
  the value and its reference range, so derive it and say that you did — but only when you have both
  (if the *range* is what is unreadable, leave the flag unknown rather than inventing one). Never present
  a computed cell as if it were read off the page.
- **Quote the source file** for every value you report, so the user can check it.
- Do not dump an entire extracted report into the chat when the user asked a question about it: answer
  the question, quoting only what supports the answer.

**Quote any field that contains an ASCII comma.** A patient name like `ZHOU, ZIQIN` is the common case,
and leaving it unquoted shifts every later column in that row by one — the file still opens, so the damage
is silent. Chinese punctuation (`、` `，`) needs no quoting.

**Make the derived columns agree with the values.** If a row shows `0.17↓`, the abnormal-items column must
mention it; a value inside its reference range must never be listed as abnormal. A clinician reads those
two columns side by side, so a contradiction between them is worse than an omission.
