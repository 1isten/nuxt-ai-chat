---
name: pmt-frontend-bridge
description: Read live state from the host application's frontend (parsed patients/studies/series/instances, manual patients, per-patient data types, Analysis Results, Other Files, source roots, VolView state) and dispatch whitelisted UI commands back to it via the PMT Frontend Bridge.
---

# PMT Frontend Bridge

This skill lets you interact with the host application's frontend while it is running. Use it when the user asks about:

- Statistics or summaries of what they have parsed/loaded (patient/study/series/instance counts, modality breakdown, etc.)
- Listing patients, studies, or series currently visible in the viewer
- Listing **manual (non-DICOM) patients**, the **10 per-patient data types** (see the list in "Project model & data keys" below — do not guess them), the patient-independent **Analysis Results** panel, and **Other Files**
- Building a **Data Package** (Target → Package → Item) out of tree items and Analysis Results files, and exporting it as a manifest
- Reading the embedded VolView viewer's parent-mirrored state (mounted status, active view/data IDs, latest slicing event, current image/slice metadata)
- Answering "what am I looking at right now" — including non-DICOM files open in a module tab that covers the image viewer
- Reading the **contents** of their own files when they ask about them — "这份报告写了什么？", "把这几份 PDF 汇总一下", "这是扫描件，你能读吗？" — including **scanned/image PDFs with no text layer** and **photos or screenshots (PNG/JPEG)**, which both need OCR. They will not mention an endpoint, a ref, or an OCR engine; derive all of that yourself. See "PDF / scanned documents → text" below.
- Performing UI actions on their behalf (open something in the embedded viewer, expand/collapse the tree, reveal a file in the OS file manager, create/merge manual patients, add files to Analysis Results or a package)

## Terminology

When the user says "viewer", "image viewer", "DICOM viewer", "current image", "current slice", "active pane", or "main viewer pane", treat that as the embedded VolView context unless they clearly mean a separate standalone window or the patient tree.

**But "what am I looking at?" is a different question, and VolView does not answer it.** Non-DICOM files (PDF, xlsx, csv, …) open in third-party module UIs hosted in `<webview>`s that are laid *over* the viewer area (`position:absolute; inset:0; z-index:100`). VolView stays mounted underneath and keeps reporting its last DICOM slice, so a VolView read will confidently name the wrong file. Always use **`GET /api/frontend/current`** for "which file am I viewing / looking at / currently open". See "What the user is looking at" below.

## Authoritative source — do not read project files

**For any question about the user's loaded / parsed data (patients, studies, series, instances, modalities, file paths in the viewer, what is currently selected, what is expanded, etc.), the Frontend Bridge HTTP API is the ONLY source of truth.**

Concretely:

- **Do not** `view`, `grep`, or `glob` source files in the working directory to answer such questions. Files like `app/stores/parsing.ts`, `app/components/TreePatients.vue`, `server/index.ts`, `server/frontend-bridge.ts`, etc. describe the *implementation* of the viewer, not the user's live data. Reading them will not tell you how many patients are loaded.
- **Do not** guess patient/study/series keys, file paths, or counts. Always fetch them from the bridge first.
- If `FRONTEND_BRIDGE_URL` is unset (e.g. the viewer is not running), say so plainly instead of falling back to source-code inspection.
- **Never search the working directory, config files or `.env` for a token, a URL or a port.** Nothing useful
  is there, the token is minted fresh for each app session, and a search that cannot succeed will consume the
  entire turn.

The only legitimate reason to read project source files in the same conversation is if the user explicitly asks a code/development question unrelated to their loaded data.

**You are running inside this application.** Its panels and tabs are not something you launch, click or
automate from outside: every UI action available to you is a bridge command the app itself executes
A tab label the user says out loud ("Blood Tests" in English, or a Chinese equivalent) is a `category` argument, not a place you navigate to.
argument, not a place you navigate to.

## How it works

A small loopback HTTP server runs inside the host application on `127.0.0.1`. Both its base URL and a per-session bearer token are injected into your environment:

- `FRONTEND_BRIDGE_URL` — e.g. `http://127.0.0.1:18040`
- `FRONTEND_BRIDGE_TOKEN` — random hex string, valid only for this app session

Every request **must** include the `Authorization: Bearer $FRONTEND_BRIDGE_TOKEN` header. Unauthenticated requests return 401.

If `FRONTEND_BRIDGE_URL` is unset, the bridge is unavailable in this environment — fall back to whatever else you can do without it.

## Tooling — use `curl`, not `node`

The bridge is a plain HTTP+JSON service. Hit it with **`curl`** in a shell command. `curl` is universally available on macOS, Linux, and Windows 10+, and is the canonical tool for this.

**Do not invoke `node` to call the bridge.** When the host application is a packaged Electron build, there is no standalone `node` binary on `PATH` and any `node script.js` or `node <<EOF` invocation will fail with `bash: node: command not found` (exit 127). The same applies to `npx`, `ts-node`, `tsx`, etc. — assume none of them exist.

If you absolutely cannot use `curl` for some reason, fall back to **`python3`** (also generally available) with `urllib.request`. Never assume Node or any npm-installed CLI is available.

Pipe `curl` output through `jq` for filtering/shaping when needed. If `jq` is missing, parse the raw JSON in your own reasoning rather than reaching for a JS runtime.

## Project model & data keys (important — read this first)

The app moved to a **Project** model (v6 Phase 0). The bridge now exposes the full, live parsed state — no PHI is stripped. But the shape of that state changed from the old per-root `cache.db` era:

- **Entity keys are opaque `dicomEntityId` UUIDs**, not human-readable strings. Every patient/study/series/instance response carries a `key` (== `dicomEntityId`) plus its display fields (`PatientName`, `StudyDescription`, `SeriesDescription`, `fileName`, …). Treat `key`/`dicomEntityId` as the only stable handle for navigation; map it back to the display name when talking to the user.
- **File paths are `evidence:` refs** (`evidence:<sourceRootId>:<relativePath>`), not raw filesystem paths. Instances and Other Files expose both the `evidence:` ref (`filePath`) and its `sourceRootId` + `relativePath`. The bridge resolves these for `openInVolView` / `showInFolder` / `addAnalysisResults` automatically.
- **The open Project** has a display name and an on-disk `.pmtaro-project` package path. Read both from `GET /api/frontend/project` (the package path never reaches the app renderer, so this is the only way to learn it). `project` is `null` when no Project is open — in that case the app shows the welcome screen and there is no tree to read.
- **Source roots** (`GET /api/frontend/project/source-roots`) map each `sourceRootId` → `canonicalPath` (the real folder on disk). A patient's `root` field is a `sourceRootId`, **not** a path.
- **Manual patients** are non-DICOM patients with no studies: `isManual: true`, `root: "pmtaro:manual-patients"`, empty `studies`. They are listed in `/parsed/patients` alongside DICOM patients and via `GET /api/frontend/parsed/manual-patients`.
- **A manual patient carries the patient fields a DICOM header would have given you.** Because it has no DICOM data, the user (or you) records them on the patient itself: `PatientName`, `PatientID`, `PatientBirthDate` (DICOM `DA`, `YYYYMMDD`), `PatientSex` (`M`/`F`/`O`) and free-form `customFields`. `GET /api/frontend/parsed/manual-patients` returns each entry as `{ key, dicomEntityId, PatientName, PatientID, PatientBirthDate, PatientSex, customFields, allFields, root }`:
  - `customFields` is the raw `{ "<name>": "<value>" }` map the user typed.
  - `allFields` is the same information flattened into one `field -> value` map for text matching, with custom fields namespaced **`custom:<name>`** (e.g. `"custom:Patient Address"`). The prefix means a user-defined field called `PatientID` can never shadow the real one.
  - These are the values a de-identification/export flow should search for in the patient's attached documents. `PatientBirthDate` is the DICOM `DA` form (`19570523`) — the same form a DICOM-derived patient's naturalized tag carries — so a module can treat both patient kinds with one code path. A document will rarely spell a date that way, so expand to the renderings a human writes (`1957-05-23`, `23/05/1957`, …) when matching text.
- **Per-patient data types** (10 fixed keys) classify non-DICOM files (notes, spreadsheets, reports, photos). Their files live in the labeling layer, not in the DICOM `studies` tree — read them via `GET /api/frontend/parsed/categories`. The 10 keys are:
  - `pmt-patient-demographic-data` — Demographic Data
  - `pmt-patient-clinical-notes-and-summary` — Clinical Notes / Summary
  - `pmt-patient-photos-and-images` — Photos and Images
  - `pmt-patient-diagnosis` — Diagnosis
  - `pmt-patient-blood-tests` — Blood Tests
  - `pmt-patient-pathology-reports` — Pathology Reports
  - `pmt-patient-procedures` — Procedures
  - `pmt-patient-immunization` — Immunization
  - `pmt-patient-medication` — Medication
  - `pmt-patient-other-modality` — Other
- **Analysis Results** is a patient-independent store for analysis outputs (e.g. a summary spreadsheet the assistant builds from many patients). It is NOT part of the parsed tree — it lives in a toolbar panel opened by the `openAnalysisResults` command (or the chart icon in the drawer toolbar), with one vertical tab per data type. Read it via `GET /api/frontend/parsed/analysis-results`; it is a `{ categoryKey: [ {assetId, name, extension, mimeType, byteSize}, … ] }` map keyed by the same 10 data-type keys. The full write set is `addAnalysisResults` (create from existing files), `createAnalysisResultNote` / `createAnalysisResultSpreadsheet` (create new), `replaceAnalysisResult` (update content/name — **the `assetId` changes**), `removeAnalysisResult` (delete); then call `openAnalysisResults` / `closeAnalysisResults` / `setAnalysisResultsFilter` for the panel. **To read a file's content, turn its `assetId` into an `asset:<assetId>` ref and resolve it** (see "Reading the actual files" below).
- **Other Files** (non-DICOM, not attached to any patient) is exposed via `GET /api/frontend/parsed/other-files` as `{ "<extension>": [ {name, path, sourceRootId, relativePath}, … ] }`.
- **Data Packaging** is the delivery model: a **Target** (a recipient/destination) contains **Packages**, each containing **Items**. An item is a *reference* to something that already exists (a tree entity, a timepoint, an Analysis Results file) — never a copy — so it is resolved live and an item whose target no longer resolves is reported `stale: true` rather than dropped. Read the whole tree with `GET /api/frontend/packaging`; build it with the `createDataPackage*` / `addDataPackageItem` commands; produce the delivery manifest with `exportDataPackage`. See "Data Packaging" below.

### Quick reference: what each `key` means per level

| Level | `key` (== `dicomEntityId`) maps to | useful display fields on the node |
|---|---|---|
| patient | deterministic entity UUID | `PatientName`, `PatientID`, `root`, `isManual` |
| study | entity UUID | `StudyDescription`, `StudyDate`, `StudyID`, `AccessionNumber` |
| series | entity UUID | `SeriesDescription`, `Modality`, `SeriesNumber` |
| instance | entity UUID | `fileName`, `filePath` (`evidence:`), `InstanceNumber`, `SOPInstanceUID`, `sourceRootId`, `relativePath` |

## 🎬 Demo Scenarios — Progressive Showcase

When demonstrating this software's AI capabilities to a new user, prefer these high-impact scenarios in order. Each builds on the previous one. Be proactive — after each scenario, briefly explain what just happened in one sentence, then offer the next step.

### Scenario 1: "What do I have here?" — Data Awareness & Charting
**Goal**: Show that AI sees the user's loaded data and can provide rich statistics.

1. `GET /api/frontend/parsed/stats` — get everything in one call (recommended for demos; use `/summary` only for quick counts)
2. Use a `bar_chart` to visualize modality distribution
3. If there's study timeline data, use `chart` (line) to show studies per year
4. Use a `donut_chart` for modality share if ≤7 modalities
5. Mention top patients: "Patient X has the most studies (N)"
6. Say: "You have N patients with M studies across X modalities, spanning from YYYY to YYYY."

**Demo prompt**: "Show me what's loaded and visualize the modalities."

### Scenario 2: "Show me the interesting series" — Navigation & Windowing
**Goal**: Navigate to a specific series and apply clinical windowing.

1. `GET /api/frontend/parsed/patients/{key}/studies` — pick a study
2. `GET /api/frontend/parsed/patients/.../series` — find the series with most instances
3. `selectInstance` to navigate to it
4. `GET /api/frontend/volview/current` — read current state
5. Apply a preset window: `volviewSetWindowLevel` (e.g., lung: width 1500, level -600 for CT)
6. Say: "I've loaded the largest series and applied a lung window."

**Demo prompt**: "Find the series with the most slices, show it to me, and apply the best window setting for lungs."

### Scenario 3: "Measure this region" — ROI Analysis
**Goal**: Draw a measurement ROI and visualize the pixel statistics.

1. Ensure a 2D slice is visible (from Scenario 2)
2. `GET /api/frontend/volview/snapshot?includeImage=false&bins=64` — get slice dimensions and histogram
3. `POST /api/frontend/volview/roi` — sample a region with `includePixels:true`
4. `POST /api/frontend/volview/annotation` `action:"create"` — draw the measurement overlay
5. Use a `histogram` tool to visualize the ROI pixel distribution
6. Say: "I've measured this region — mean intensity is X, area is Y mm²."

**Demo prompt**: "Measure the pixel intensities in the center region of this image and show me the histogram."

### Scenario 4: "Segment the bright areas" — AI Segmentation
**Goal**: Create a smart segmentation and visualize the result.

1. Ensure a 2D slice is visible
2. `POST /api/frontend/volview/segmentation` `action:"applyMask"` with `roi`, `threshold` (e.g., `mode:"above", value:"mean"`), and `segment.name`
3. `POST /api/frontend/volview/roi` on the segmented region — get stats
4. `GET /api/frontend/volview/snapshot` — get a preview image showing the segmentation
5. Use a `findings` tool to present segmentation statistics as structured findings
6. Say: "I segmented X pixels above the mean intensity and created an overlay."

**Demo prompt**: "Segment everything above the mean intensity in this view, measure it, and show me what you found."

### Scenario 5: "Play it like a movie & analyze the volume" — Cine + Volume Scan
**Goal**: Show dynamic playback AND whole-volume intelligence.

1. `volviewPlayCine { fps: 15, direction: "forward" }` — start cine playback
2. Let it play for a moment, then `volviewStopCine`
3. `POST /api/frontend/volview/volume` `action:"scan"` — scan the whole volume with `includeSlices:true`
4. Use a `chart` (line chart) to plot per-slice mean intensity — reveal the "story" across slices
5. Use `findings` to present volume statistics
6. Say: "I scanned the entire volume — the brightest slices are around slice N, and here's the intensity profile across all slices."

**Demo prompt**: "Play this series as a video, then scan the whole volume and tell me which slices are most interesting."

### Scenario 6 (bonus): "Full radiologist workflow"
**Goal**: Combine everything into a single impressive workflow.

**Demo prompt**: "Act like a radiologist reviewing this study. Navigate to the most informative series, apply appropriate windowing, measure key regions, segment any abnormalities, and give me a structured findings report."

The AI should:
1. Read parsed data → pick the best series
2. Navigate + window → show the image properly
3. ROI sample a central region → histogram
4. Segment bright/dark regions → overlay
5. Present a `findings` card with structured observations
6. Optionally play cine to show the full context

### Scenario 7: "Tag & report" — Labeling + Structured Findings
**Goal**: Show that AI can create labels, tag items, and build a labeled report.

1. `GET /api/frontend/labeling/definitions` — see existing labels
2. If no labels exist: `labelCreate { name: "Abnormal", color: "#ff4444" }` and `labelCreate { name: "Reviewed", color: "#4488ff" }`
3. Navigate to a series and review it (scenarios 2-4)
4. `labelAssign { keys, label: "Reviewed" }` — mark as reviewed (colored dot appears in tree!)
5. If anything noteworthy found: `labelAssign { keys, label: "Abnormal" }` + `labelSetDetails { keys, label: "Abnormal", description: "..." }`
6. `POST /labeling/query { root }` — get all labels for statistics
7. Use `bar_chart` to visualize label distribution
8. Use `findings` to present labeled items as a structured report

**Demo prompt**: "Create labels for 'Abnormal' (red), 'Reviewed' (blue), and 'Follow-up' (yellow). Then review the largest series, mark it as Reviewed, and flag anything suspicious."

### Scenario 8: "Project organization" — Manual Patients, Categories & Analysis Results
**Goal**: Show that AI understands and drives the Project model (manual patients, per-patient categories, Analysis Results).

1. `GET /api/frontend/parsed/manual-patients` — list manual (non-DICOM) patients
2. `GET /api/frontend/parsed/categories` — see which patients have category files (notes/reports/photos)
3. `GET /api/frontend/parsed/analysis-results` — see patient-independent analysis outputs
4. `GET /api/frontend/project/source-roots` — show which folders are loaded
5. If the user wants a new manual patient: `createManualPatient { patientName, patientId, patientBirthDate, patientSex, customFields }`. Use `updateManualPatient { dicomEntityId, ... }` to change one. Read the current values back from `/parsed/manual-patients` instead of guessing — `updateManualPatient` **replaces** the whole field set, so an omitted field is cleared.
6. To attach a review note to a patient: `labelSetDetails { keys: [patientKey], label: "pmt-patient-clinical-notes-and-summary", ... }` — or point the user to the in-app "New Note" on that branch (the bridge exposes reads + manual-patient/analysis-results writes, but per-patient note/spreadsheet *creation* is done in-app)
7. Say: "You have N DICOM patients, M manual patients, and K folders loaded. Patient X has a Clinical Note and two Pathology Reports."

**Demo prompt**: "Summarize my project — how many DICOM vs manual patients, what category files exist, what's in Analysis Results, and which folders are loaded."

---

## Read endpoints (GET)

All return JSON.

| Endpoint | Description |
|---|---|
| `/api/frontend/health` | Liveness probe. |
| `/api/frontend/volview/summary` | Embedded VolView parent-mirrored state: `{ mounted, activeViewID, activeViewDataID, activeViewDataIDByView, lastSlicing, lastSlicingAt, loadingUIDs }`. Use this before answering questions about the current active VolView pane/slice. |
| `/api/frontend/packaging` | **Data Packaging**: `{ targets: [ { id, name, position, packageCount, itemCount, packages: [ { id, targetId, name, position, itemCount, staleCount, fileCount, items: [ { itemId, kind, ref, name, parentPath, stale, kindLabel, typeLabel, dataType, fileCount } ] } ] } ], itemKinds, meta }`. Every item is resolved **live** against the tree / Analysis Results, so `name` is the real display name and `stale: true` means its target no longer exists (the item is still stored — say so, do not drop it silently). `itemKinds` documents the ref shape each `kind` needs. Narrow with `?targetId=` / `?packageId=`. |
| `/api/frontend/current` | **What the user is looking at right now** — the answer to "which file am I viewing?". `{ lookingAt: { kind: 'module-tab' \| 'module-window' \| 'volview', confidence, basis, file, module }, focusedWindow, moduleWindows, moduleOverlay, volview }`. See "What the user is looking at" below. |
| `/api/frontend/volview/current` | Detailed **VolView context** — what the viewer *holds*, which is NOT necessarily what the user sees: it keeps reporting the last DICOM slice while a module tab covers the viewer. Includes the summary fields plus `state`, where `state.activeView`, `state.views`, `state.layout`, `state.currentImage.metadata`, `state.currentSlice.config`, `state.currentSlice.metadata`, `state.currentSlice.dicomTags`, and `state.windowLevel` describe the current viewer pane/image/slice. Use this when the user asks about the VolView pane itself (image dimensions/spacing/orientation, DICOM tags of the current slice, window/level, layout/active pane) — and pair it with `/current` whenever the question is "what am I looking at". `dicomTags` is `null` for non-DICOM data. |
| `/api/frontend/volview/snapshot` | On-demand active VolView pane snapshot. Returns the active pane context plus `image` as a cropped PNG data URL, `currentSlicePixels` as compact scalar statistics/histogram for 2D views, and optionally `currentSlicePixelGrid` as downsampled scalar rows. Query options: `includeImage=false`, `includeHistogram=false`, `includePixels=true`, `maxWidth=768`, `maxHeight=768`, `bins=64`, `pixelWidth=64`, `pixelHeight=64`. Pixel grids are clamped to 128x128. Use this for visual/screenshot-style prompts, histogram/pixel-summary prompts, or bounded raw-scalar inspection. Do not print the full `image.dataURL` in chat unless explicitly needed; summarize it or omit it with `jq 'del(.image.dataURL)'`. |
| `POST /api/frontend/volview/roi` | On-demand scalar sampling for a rectangle, polygon, or circle/ellipse on the active 2D VolView slice. Body can be `{ "roi": { "type": "rectangle", "x": 120, "y": 80, "width": 64, "height": 48 } }`, `{ "roi": { "type": "polygon", "points": [[120,80],[180,90],[160,140]] } }`, or `{ "roi": { "type": "circle", "cx": 160, "cy": 110, "radius": 32 } }`. Coordinates are zero-based current-slice image-plane indices, not screen pixels. The response includes `currentSliceRoi.roi` in index-pixel units, `currentSliceRoi.measurements` in VolView physical/world units, `measurementUnits`, `valueRange`, source image dimensions, plane axes, ROI bounds, histogram, and sampling metadata. Optional body/query fields: `includePixels=true`, `pixelWidth=32`, `pixelHeight=32`, `bins=64`, `maxSamples=262144`, `component=0`. ROI pixel grids are clamped to 128x128 and use `null` outside polygon or ellipse masks. |
| `POST /api/frontend/volview/annotation` | Manage VolView-native overlays on the active 2D pane. Body: `{ "action": "create|update|delete|list", ... }`. Supports `type`: `ruler`, `rectangle`, `circle`, `polygon`. `create` / `update` accept `annotation` geometry in zero-based current-slice image-plane index coordinates, not screen pixels and not millimeters. `delete` uses `annotationId`. `list` returns current-image annotations. Responses include annotation `id`, `imagePlane.geometry` in index-pixel units, `measurements` in VolView physical/world units, and `measurementUnits`. Do not describe `measurements.width` / `measurements.height` as image-plane units; for a DICOM image with spacing, a rectangle created with `width:64,height:48` index pixels may display as smaller/larger physical mm dimensions in VolView. |
| `POST /api/frontend/volview/segmentation` | Manage VolView-native segment groups and apply a bounded mask to the active 2D slice. Use this only for current-slice masks, not whole-volume masks. `action:"list"` returns segment groups for the current image. `action:"applyMask"` accepts either `{ "roi": { ... }, "threshold": { "min": 100, "max": 300 } }`, `{ "roi": { ... }, "threshold": { "mode": "above", "value": "mean" } }`, `{ "mask": { "x": 120, "y": 80, "rows": [[1,0,1], ...] } }`, or `{ "mask": { "x": 120, "y": 80, "width": 16, "height": 16, "values": [1,0,...] } }`. Coordinates are zero-based current-slice image-plane indices. Threshold values can be numbers or ROI/mask statistics: `mean`, `median`, `min`, `max`, `p25`, `p75`, or `pNN`. Threshold modes: `above`, `below`, `between` (default), and `outside`; optional `delta` shifts the statistic. Optional `seed:{x,y}` with `connectivity:4|8` keeps only the connected component containing the seed after thresholding. Optional fields: `segmentGroupId`, `segmentGroupName`/`groupName`, `newSegmentGroup`, `reuseSegmentGroup`, `segmentValue` 1-255, `segment:{name,color,visible,locked}`, `mode:"add|replace|erase"`, `overwriteExisting`, `maxPixels=262144`, `component=0`. If `segmentGroupId` is omitted for a new add/replace/create/update request, the bridge creates a fresh segment group by default so overlapping AI-generated masks can be toggled independently; that fresh group uses `segment.name` as its display name unless `groupName`/`segmentGroupName` is provided. To add another segment to an existing group, pass `segmentGroupId` or `reuseSegmentGroup:true`. If `segmentValue` is omitted inside a target group, the bridge allocates the next unused segment value. Existing non-background labels are preserved unless `overwriteExisting:true` is sent. The bridge rejects masks over `maxPixels` rather than downsampling. Responses include `segmentationSemantics.version`, `createdSegmentGroup`, segment group metadata, segment metadata, current-slice mask bounds, threshold stats, connected-component counts, skip counts, and plane axes. |
| `POST /api/frontend/volview/volume` | Bounded whole-volume scalar access. This endpoint is metadata/chunk oriented and never returns an unbounded volume by default. `action:"info"` returns dimensions, spacing, origin, direction, scalar type, component count, raw byte estimate, and chunk limits. `action:"chunk"` returns an explicit IJK source window only: `{ "origin": [i,j,k], "size": [width,height,depth], "stride": [si,sj,sk] }`. `size` is the source-window size before stride, not the number of returned samples. The response includes `chunk.sourceRange`, `chunk.sampledRange`, `chunk.sampleSize`, and `chunk.sampleVoxels`; use those response fields when reporting ranges. Values are flattened `x-fastest-then-y-then-z`. Optional fields: `component=0`, `bins=64`, `includeValues=false` for stats-only, `maxVoxels=262144` (max 1048576), `maxBytes=4194304` (max 16777216). `action:"scan"` performs stats-only analysis over a bounded source window or the whole volume by iterating internally bounded chunks; it returns `valueRange`, `histogram`, optional `thresholdCounts`, and optional `sliceSummaries`, never raw scalar values. Scan options: `origin`, `size`, `stride`, `bins=64`, `threshold:{min,max}`, `thresholds:[{name,min,max}]`, strict operators `gt`/`lt`, inclusive operators `gte`/`lte`, `includeSlices`, `maxSliceSummaries=512`, `maxScanVoxels=50000000`, `maxChunkVoxels=262144`, `maxChunkBytes=4194304`. The bridge rejects chunks/scans over caps; increase stride or narrow the source window instead of asking for unbounded raw values. |
| `/api/frontend/parsed/summary` | `{ patientCount, studyCount, seriesCount, instanceCount, modalityCounts, isParsing }`. **Start here** for "how many / what kinds" questions. |
| `/api/frontend/parsed/stats` | **Enhanced statistics — preferred over `/summary` for demos.** Returns everything in `/summary` plus: `timeline` (earliest/latest StudyDate, study counts by year), `topPatientsByStudies` / `topPatientsByInstances` (top 10), `topSeries` (top 20 by instance count), `modalityStats` (per-modality series/total/avg/max/min instances, patient count), `patientsByModality` (how many patients have each modality), `fileCounts` (non-DICOM file counts by extension). All computed in a single pass — use this for time-based trends, rankings, and cross-tabulation questions. |
| `/api/frontend/parsed/patients` | List of patients with `key` (== `dicomEntityId`), `dicomEntityId`, `PatientName`, `PatientID`, `root` (a `sourceRootId`, or `"pmtaro:manual-patients"` for manual patients), `isManual`, `studyCount`. Manual patients have `studyCount: 0` and no studies. |
| `/api/frontend/parsed/patients/{patientKey}/studies` | Studies under a patient. Each study has `key`/`dicomEntityId`, `StudyInstanceUID`, `StudyDescription`, `StudyID`, `StudyDate`, `StudyTime`, `AccessionNumber`, `seriesCount`. |
| `/api/frontend/parsed/patients/{patientKey}/studies/{studyKey}/series` | Series under a study. Each series has `key`/`dicomEntityId`, `SeriesInstanceUID`, `SeriesDescription`, `Modality`, `SeriesNumber`, `instanceCount`. |
| `/api/frontend/parsed/patients/{patientKey}/studies/{studyKey}/series/{seriesKey}/instances` | **Instances under a series, pre-sorted by `InstanceNumber`.** Returns `{ count, instances, first, last }`. Each instance has `key`/`dicomEntityId`, `SOPInstanceUID`, `InstanceNumber`, `fileName`, `filePath` (`evidence:` ref), `sourceRootId`, `relativePath`, `isVolume`, `cacheKey`. **Use this for any "first / last / Nth instance" question** — do not try to derive ordering from `/state` object keys. |
| `/api/frontend/parsed/manual-patients` | List of manual (non-DICOM) patients: `{ manualPatients: [{ key, dicomEntityId, PatientName, PatientID, PatientBirthDate, PatientSex, customFields, allFields, root }] }`. `PatientBirthDate` is the DICOM `DA` form `YYYYMMDD` (empty when unset); `allFields` is the flattened match-ready map with custom fields namespaced `custom:<name>`. |
| `/api/frontend/parsed/analysis-results` | Patient-independent Analysis Results as `{ analysisResults: { "<categoryKey>": [{ assetId, name, extension, mimeType, byteSize }] } }`. Category keys are the same 10 keys as the per-patient data types. |
| `/api/frontend/parsed/other-files` | Non-DICOM "Other Files" as `{ files: { "<extension>": [{ name, path, sourceRootId, relativePath }] } }`. `path` is an `evidence:` ref. |
| `/api/frontend/parsed/categories` | Per-patient category files as `{ categories: { "<patientKey>": { "<categoryKey>": { "<evidenceRef>": { name, type } } } } }`. Only patients that actually have category files appear. |
| `/api/frontend/parsed/timeline` | Per-patient timeline as `{ timeline: { "<patientKey>": PatientTimelineSnapshot } }`, keyed by the **same `dicomEntityId` as `/parsed/patients`**. Each snapshot holds `enrollmentDate`, `labels` (`"YYYY-MM-DD" -> "Baseline"`), `annotations` (`[{ ref, date, datePrecision, position }]` — the date assigned to one non-DICOM file; `ref` is the same `evidence:`/`asset:` key used as the file key under `labeling.labelDetails`), `labeledTimepoints`, `anchors`, `outcomes`, `visitRecords`, and `followUp`. Read-only. Use it to answer "when was this file taken", "what is this patient's baseline", or to order a patient's non-DICOM files on the time axis. |
| `/api/frontend/project/source-roots` | `{ sourceRoots: [{ sourceRootId, canonicalPath, displayName, kind, status, addedAt, lastScannedAt }] }`. Use to map a patient's `root` (`sourceRootId`) to its real folder path. |
| `/api/frontend/project` | The **current Project** plus its source roots: `{ project: { projectId, name, packagePath, state, projectSessionId, projectEpoch } \| null, sourceRoots: [...] }`. `packagePath` is the absolute path of the `.pmtaro-project` package on disk (it is deliberately never sent to the renderer, so this endpoint is the only way to learn it). `project` is `null` when no Project is open. |
| `/api/frontend/tree` | **The patient tree in the order the user sees it.** One ordered, multimodal tree: per patient, DICOM studies and non-DICOM timepoint bundles interleaved on the date axis, plus patient-level branches (e.g. Demographic Data) and the "Other Files" section. Every node carries the exact `keys` tuple the dispatch commands take. Query: `patientKey=<key>` (one patient), `files=false` (structure only — no file leaves, branches keep an honest `hasChildren`), `visible=true` (only what is currently expanded, i.e. what the user can see right now). Response `{ nodes, rootIds, patientKeys, meta }`. **Start here for anything tree-shaped.** See "The patient tree" below. |
| `POST /api/frontend/file/resolve` | Turn data-file refs into **real filesystem paths**. Body `{ "ref": "evidence:<sourceRootId>:<relativePath>" }` or `{ "ref": "asset:<assetId>" }` → `{ file: { ref, path, name, exists, kind, byteSize, refType, error } }`. Batch form: `{ "refs": [ ... ] }` (max 200) → `{ files: [ ... ] }`. `path` is absolute and already realpath-resolved; `exists:false` means the file is missing/moved (for `evidence:` refs a best-effort intended path is still returned so you can say *where* it should be). Non-refs (`/abs/path`) are rejected. |
| `/api/frontend/ui/state` | Frontend panel state: `{ ui: { analysisResults: { open, category, filter, highlight }, dataPackaging: { open, selectedPackageId, filter, highlight } } }`. Use this to confirm a panel actually opened/selected what you asked for, instead of assuming. `category` is the **data-type tab actually on screen** (it follows the user's tab clicks, not just your last command); `filter` is the panel's file-name filter. Also present under `/state` as `ui`. || `/api/frontend/labeling/definitions` | Global label definitions: `{ labels: { "LabelName": "#hexcolor", ... }, systemLabels: [ ... ] }`. `systemLabels` are the 10 reserved per-patient category labels — do not rename/recolor/delete them. |
| `POST /api/frontend/labeling/query` | Query label assignments. Body: `{ "root": "<sourceRootId>", "keys": ["patientKey", ...] }` → `{ root, keys, labels: ["LabelA", ...] }`. Body `{ "root": "<sourceRootId>" }` (no keys) → `{ root, assignments: { "<dicomEntityId>": ["LabelA"] } }`. Body `{}` → `{ labels, systemLabels }` (all definitions). |
| `/api/frontend/state` | Full mirror of relevant Pinia state (`parsedData`, `volview`, `volviewCurrent`, `labeling`, `project.sourceRoots`, `timeline`, `tree`, `ui`). Larger; only fetch when summaries aren't enough. `parsedData` is the *raw* store projection (every patient/study/series/instance plus category files), whereas `/tree` is the same data arranged as the user's ordered tree — prefer `/tree` unless you need the raw shape. |
| `/api/frontend/ui/commands` | Lists allowed UI command names. |

`patientKey`, `studyKey`, and `seriesKey` are **opaque `dicomEntityId` UUIDs** (not names). They are URL-safe but URL-encode them anyway with `--data-urlencode` or `jq -sRr @uri` when interpolating.

### What the user is looking at

`GET /api/frontend/current` is the **only** correct source for "which file am I viewing / looking at /
do you see the file I have open". The viewer area has two layers:

- **VolView** (base layer) — DICOM instances.
- **An embedded module overlay** (top layer) — non-DICOM files opened through a module that supports
  embedding (`PDF Viewer`, `Excel Viewer`, …). It is a real full-area cover; VolView stays mounted
  and keeps reporting its last slice underneath.

```sh
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/current" \
  | jq '{lookingAt, tabs: [.moduleOverlay.tabs[] | {moduleName, fileName, active}]}'
```

`lookingAt.kind` answers it directly:

| `kind` | meaning |
|---|---|
| `module-tab` | a non-DICOM file is in front. `lookingAt.file` = `{ name, ref, absolutePath, patientName }`, `lookingAt.module` = `{ id, displayName }`. **This is the case a VolView-only read gets wrong.** |
| `module-window` | the user is in a *separate* module window (a module without embed support, or "pop out"). `lookingAt.file.absolutePath` is that window's file. |
| `volview` | no module tab is covering the viewer, so the VolView state is what they see. |

Every answer carries `basis` (why) and `confidence`, plus the raw inputs —
`moduleOverlay` (all open tabs, which is `active`, whether the cover is `visible` or the user
`collapsed` it), `moduleWindows`, `focusedWindow` — so you can explain or double-check it. `volview`
is reported in **all** cases: it is useful context ("the DICOM behind the PDF is at slice 42"), but it
is never the answer to the question.

Rules:

- **Never answer "what am I looking at" from `/volview/current` or `/volview/summary` alone.** They
  describe the base layer, and they will name the DICOM instance even while a PDF covers it.
- **Never answer it from the patient tree's selected row either.** Clicking a branch to expand or
  collapse also moves the tree's selection without changing what is being viewed, and a file's row
  stays selected after the user switches tabs or reveals VolView. The tree tells you what the user
  *last clicked*, not what they are *looking at*. (This is why the bridge does not expose a
  selection-based guess.)
- The user being in the **chat window** is reported by `focusedWindow: "chat"` but is deliberately
  NOT what `lookingAt` returns — asking you a question always focuses the chat, so it would otherwise
  always win.
- A DICOM click reveals VolView (`moduleOverlay.visible: false`, `collapsed: true`); the tabs stay
  alive. So `moduleOverlay.tabs` being non-empty does **not** mean the user is looking at one of them —
  only `visible` does.
- To act on what they are looking at: `lookingAt.file.absolutePath` is already resolved (read it
  directly), and `lookingAt.file.ref` is the tree ref if you need the tree side.
- To ask what they see *in the image*, use `/volview/snapshot` or `/volview/current` — and if
  `lookingAt.kind` is `module-tab`, say so, because the VolView pixels are then hidden behind a module.

### Analysis Results — create, show, verify, read back

The panel is a flat store of managed files organised under the 10 data-type tabs; it is deliberately
NOT part of the patient tree. A complete round trip:

1. **Create** — `createAnalysisResultNote {category, name, content}` or `createAnalysisResultSpreadsheet
   {category, name, csvText, type}`; or `addAnalysisResults {category, paths}` to bring in files that
   already exist (tree refs and real paths both work).
2. **Show** — `openAnalysisResults {category, name}` (or `assetId`). It opens the panel, selects the tab,
   clears the filter and flashes the row.
   Say what the user can now see, **in their words and their language** — which panel and tab it
   landed in — not which command you ran.
3. **Verify** — `GET /api/frontend/ui/state` → `ui.analysisResults` (`open`, `category`, `filter`). Do not
   claim the user can see something without checking.
4. **Read back** — `GET /api/frontend/parsed/analysis-results` for the `assetId`, then build
   `asset:<assetId>` and resolve it (see "Reading the actual files"), or just keep the content you wrote.
5. **Update** — `replaceAnalysisResult {category, assetId, name, content}`. It writes a **new** managed
   asset and purges the old one when nothing else references it, so **the `assetId` changes**; use the id
   it returns for any follow-up (`openAnalysisResults` with the stale id flashes nothing).
6. **Delete** — `removeAnalysisResult {category, assetId}` — confirm with the user first; it is destructive.

Text formats (`.txt`, `.md`, `.csv`) round-trip faithfully through `content` / `csvText`. For binary
files, prefer `addAnalysisResults` with a real path so the app makes the managed copy.

**Building a CSV from extracted text.** Write it with a quoted heredoc — `cat > /tmp/x.csv <<'EOF' … EOF` — so
Chinese, commas and quotes go in as-is with no JSON escaping, then import that path with
`addAnalysisResults`. **Do not write a script to parse the reports into it: you are the parser.** Quote any
field containing an ASCII comma (a patient name like `ZHOU, ZIQIN` is the common case; left unquoted it shifts
every later column of that row by one, silently). With `addAnalysisResults` the row name becomes the file's
**basename**, which is what `openAnalysisResults` then matches. Keep derived columns consistent with their
inputs — a flag column must never contradict the values beside it.

**Report-text work has a companion skill.** Reading PDFs, scans and photos and turning several reports into
a summary table is a long procedure with its own traps. It is documented in the
`pmt-frontend-bridge-report-text` skill — load it when the user asks for the *contents* of their reports or
wants them tabulated. That skill must be **enabled in this app** to be loadable; if it is not in the list, tell
the user to enable it.

Translate what the user says into a command instead of investigating how:

| the user says | you do |
|---|---|
| 「汇总成一张表」「生成 CSV」 | build the CSV yourself (heredoc), then `addAnalysisResults` |
| 「存进 / 导入 / 保存到 <标签>」 | `addAnalysisResults`, or `createAnalysisResultSpreadsheet` for a string |
| 「打开面板」「定位到它」 | `openAnalysisResults` |

### Data Packaging — Target → Package → Item

This is the **export step** of the working flow (import data → analyse it → deliver it). A **Target**
is where data goes, a **Package** is one delivery to that target, and an **Item** is a reference to
something in the Project.

```sh
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/packaging" \
  | jq '{meta, targets: [.targets[] | {name, packages: [.packages[] | {name, itemCount, staleCount, fileCount}]}]}'
```

**Items are references, resolved live.** An item stores only a ref; the read model resolves the current
display name, the file count, and whether it is still `stale`. Nothing is copied or snapshotted until
`exportDataPackage` writes the manifest.

**Build a ref from what `/api/frontend/tree` gave you.** `entityId` / `patientEntityId` values are the
node's `dicomEntityId`; `timepointKey` and `fileRef` are segments of the node's `keys`:

| `kind` | ref | where the values come from |
|---|---|---|
| `patient` | `{ entityId }` | patient node's `dicomEntityId` (contains everything under it) |
| `study` / `series` / `instance` | `{ entityId }` | that node's `dicomEntityId` |
| `timepoint` | `{ patientEntityId, timepointKey }` | patient node's `dicomEntityId` + timepoint node's `keys[1]` (`"tp\|2025-01-15"`, `"tp\|unassigned"`) |
| `timepoint_file` | `{ patientEntityId, timepointKey, fileRef, dataType? }` | + file node's `keys[2]`; add `dataType` only to disambiguate a file stored under several data types |
| `patient_level_file` | `{ patientEntityId, dataType, fileRef }` | `dataType` is **required** here (e.g. `pmt-patient-demographic-data`) |
| `analysis_catalogue` | `{ catalogue }` | a data-type key — every Analysis Results file in that catalogue |
| `analysis_catalogue_file` | `{ catalogue, assetId }` | from `/api/frontend/parsed/analysis-results` |

The same table is returned by the endpoint as `itemKinds` — read it rather than guessing.

**Typical flow** (create as you go, then export):

```sh
# 1. target, then package
TARGET=$(curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" -H 'Content-Type: application/json' -X POST \
  -d '{"command":"createDataPackageTarget","payload":{"name":"Delivery A"}}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/ui/dispatch" | jq -r '.result.id')
PKG=$(curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" -H 'Content-Type: application/json' -X POST \
  -d "{\"command\":\"createDataPackage\",\"payload\":{\"targetId\":\"$TARGET\",\"name\":\"Baseline\"}}" \
  "$FRONTEND_BRIDGE_URL/api/frontend/ui/dispatch" | jq -r '.result.id')

# 2. add items (repeat per item; see the ref table above)
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" -H 'Content-Type: application/json' -X POST \
  -d "{\"command\":\"addDataPackageItem\",\"payload\":{\"packageId\":\"$PKG\",\"ref\":{\"kind\":\"patient\",\"entityId\":\"<patientEntityId>\"}}}" \
  "$FRONTEND_BRIDGE_URL/api/frontend/ui/dispatch"
# -> {"ok":true,...,"result":{"created":true,"duplicate":false,"item":{...}}}
#    an item that is already in the package is NOT an error: {"created":false,"duplicate":true,"item":null}

# 3. show it, then export the manifest
curl ... -d '{"command":"openDataPackaging","payload":{"packageId":"<id>"}}' ...
curl ... -d '{"command":"exportDataPackage","payload":{"packageId":"<id>"}}' ...
# -> {"result":{"manifestPath":"<project>/artifacts/packages/<id>.json","fileCount":N,"warningCount":M}}
```

Rules:

- **`addDataPackageItem` answers three ways** and they must not be conflated: `created:true` (added),
  `created:false, duplicate:true` (the identical item was already there — a no-op, **not** an error), or
  an HTTP 500 (the call failed). Report the duplicate case as "already in the package", not as a failure.
- A package with **no items cannot be exported** — that is an error, not an empty manifest.
- **Deleting a target deletes its packages** (and their items). Confirm with the user first; the same goes
  for `removeDataPackage` and `removeDataPackageItem`.
- Deleting the underlying data does NOT delete the item: it turns it `stale`. Tell the user which items
  went stale instead of silently removing them.
- `exportDataPackage` writes the manifest to `<packagePath>/artifacts/packages/<packageId>.json` — it is
  **overwritten** on every export, so the file always describes the package's current contents.

### The patient tree

`GET /api/frontend/tree` is the **canonical read for tree-shaped questions**. It returns a flat
`nodes` array in display order (pre-order: a parent always precedes its children), so you can read it
top to bottom without recursing.

```sh
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/tree" | jq '.nodes[] | {slot, keys, name}'
```

Node fields:

| field | meaning |
|---|---|
| `slot` | row type — see the table below |
| `keys` | **the exact tuple to pass to `expand` / `collapse` / `selectInstance` / `labelAssign` / a package item ref** |
| `name` | display name, composed as the UI shows it (study/series names get ` · <date>` / ` #<number>`, timepoints get ` · <label> · Day +N`) |
| `level` | 1 patient · 2 study/timepoint/patient-level branch · 3 series/file/meta · 4 instance |
| `parentId` / `childIds` | wiring between nodes (`id` is a stable handle derived from `keys`; use `keys`, not `id`, for commands) |
| `expanded` | current UI expansion flag |
| `hasChildren` | whether the node can be expanded (honest even with `files=false`) |
| `dicomEntityId` | entity the label system keys on; `null` where there is none |
| `assignedLabels` | labels on this node, **including** the reserved data-type labels (`[]` where the node has no entity) |

Slots and their extra fields:

| slot | keys | extra fields |
|---|---|---|
| `patient` | `[patientKey]` | `PatientName`, `PatientID`, `root` (a **sourceRootId**), `isManual`, `enrollmentDate` |
| `pmt-patient-level` | `[patientKey, dataTypeKey]` | `dataType` — a header branch, **not** on the time axis |
| `pmt-patient-level-file` | `[patientKey, dataTypeKey, ref]` | `dataType`, `typeLabel`, `ref`/`filePath` |
| `study` | `[patientKey, studyKey]` | `StudyInstanceUID`, `StudyDescription`, `StudyID`, `StudyDate`, `date` (normalized), `datePrecision` |
| `series` | `[patientKey, studyKey, seriesKey]` | `SeriesInstanceUID`, `Modality`, `SeriesDescription`, `SeriesNumber` |
| `instance` | `[patientKey, studyKey, seriesKey, instanceKey]` | `SOPInstanceUID`, `InstanceNumber`, `fileName`, `filePath` (ref), `sourceRootId`, `relativePath` |
| `timepoint` | `[patientKey, "tp\|<YYYY-MM-DD>"]` (or `"tp\|unassigned"`) | `timepointKey`, `timepointLabel`, `date`, `datePrecision`, `offsetDays` (relative to enrollment) |
| `pmt-timepoint-meta` | `[patientKey, timepointKey]` | `metaLabel`, `metaKey`, `text` — one inline structured fact |
| `pmt-timepoint-file` | `[patientKey, timepointKey, ref]` | `dataType`, `typeLabel`, `ref`/`filePath` |
| `other-files` / `file-type` / `file` | `["other-files"]` / `["other-files", ext]` / `["other-files", ext, path]` | `extension`, `ref`/`filePath`, `sourceRootId`, `relativePath` |

Rules that follow from how the tree is built:

- **Narrow the read.** `?slots=<comma list>` keeps only those row types plus the ancestors that give them
  meaning; `?patientKey=` and `?files=false` narrow further. This is not a nicety: on a project with DICOM
  the unfiltered tree is megabytes, because every instance is a node — measured 1.34 MB (~370k tokens) for
  3 patients x 2 studies x 3 series x 150 instances, versus ~1.9 KB narrowed. `meta.nodeCount` against
  `meta.totalNodeCount` says how much was filtered.
- An unknown `patientKey` is a **404**, and a `dicomEntityId` passed as `patientKey` is a **400** whose
  message names the correct key. An empty `nodes` list never means "no such patient".
- **Patient-level branches are not on the time axis.** Only data types in the patient-level set
  (`pmt-patient-demographic-data`) get a header branch; the other nine are *timeline* data types, so
  their files appear as `pmt-timepoint-file` leaves under the date they were annotated with. Do not
  tell the user a note is missing just because it is not under a "Clinical Notes" branch.
- **A timepoint exists only when it has content**: files with that annotated date, or a label
  (`timeline.labels`) that marks the date. Files with no date land in the `tp|unassigned` bundle,
  which always sorts last.
- **Same-date ordering** is DICOM study → non-DICOM timepoint. Dates sort ascending.
- **Outcome events are not tree nodes.** They exist only on the time axis in the timeline views;
  read them from `/api/frontend/parsed/timeline` → `outcomes`.
- A collapsed branch is still returned by default — `visible=true` is the filter for "what the user
  can actually see". The `tree` block of `/state` carries the raw expansion maps
  (`patientCategoryExpansion`, `timepointExpansion`) if you need them directly.

**The way to act on something you found:** take its `keys` from the tree, then dispatch. `expand` /
`collapse` accept **every** slot above, including the synthetic `timepoint`, `pmt-patient-level`,
`pmt-timepoint-file` and `other-files` nodes — so you can reveal the item you are about to name.

### Reading the actual files (leaf nodes)

Tree leaf items are files, but the bridge reports them as **refs**, not paths, because Project files are addressed indirectly:

- `evidence:<sourceRootId>:<relativePath>` — a file inside a registered Source Root (DICOM instances, and anything else that lives on disk under a root).
- `asset:<assetId>` — a managed copy inside the Project (`<packagePath>/artifacts/managed/<sha256>.<ext>`): Analysis Results files, files added with "Add files as…", and label attachments.

Refs are what you get from instance `filePath`, from `/parsed/other-files` `path`, and as the **keys of** `labeling.labelDetails["<dicomEntityId>|<dataTypeKey>"].files` (equivalently the keys under each patient in `/parsed/categories`). To read a file's contents, resolve the ref first:

```sh
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"ref":"asset:<assetId>"}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/file/resolve"
# -> { "file": { "ref": "...", "path": "/abs/path/file.txt", "name": "file.txt",
#                "exists": true, "kind": "file", "byteSize": 1234,
#                "refType": "asset", "error": null } }
```

Then open `file.path` with your own file tools.

- Batch with `{"refs":[...]}` (max 200) instead of one request per file when summarising a patient or a whole project.
- `exists:false` is the stale-reference case: the item is still in the Project but the file is gone. Report it as missing — never claim you read it. For `evidence:` refs, `path` still shows the expected location.
- Do not assemble paths yourself from `/project/source-roots` + `relativePath`: a managed (`asset:`) file has no Source Root at all, and roots can be re-registered.
- Text formats (`.txt`, `.md`, `.csv`, `.json`) are meant to be read directly. For binary formats (`.dcm`, `.xlsx`, `.png`) do not interpret raw bytes — resolve the path, or use the app itself (`selectInstance` / `openInVolView` for images, the numeric `/volview/*` endpoints for pixels).

### PDFs, scans and photos → text (`/extract`)

**The user does not need to know any of this.** They will not say `/extract`, `ref`, "OCR", or "text layer" — they will say things like 「这份报告里写了什么？」「这几个 PDF 帮我汇总一下」「这是扫描件，你能读吗？」. Treat any request about the *content* of a PDF, scan, photo of a report, or other opaque document as this capability, find the files yourself (`/api/frontend/tree`, `/parsed/other-files`, the per-patient category files, or whatever `/api/frontend/current` says they are looking at), resolve the refs yourself, and just report the content. Never ask the user for an endpoint, a ref, an engine, or a dpi.

A resolved path is not readable text when the file is a PDF or an image. Do **not** try to read those bytes yourself, and do not assume a PDF is either "digital" or "scanned": one page can have both. Extract instead — `/extract` accepts a PDF, PNG or JPEG, and decides per page whether to use the text layer, OCR, or both:

```sh
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/extract/status"
# -> { "ocr":     { "installed": true, "ready": true, "engines": ["newbee-ocr-cli"], "reason": "" },
#      "textLayer": { "available": true, "provider": "pdfkit",
#                     "detail": "PDFKit (macOS, honours ActualText)", "reason": "" } }

curl -s --max-time 900 -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" -X POST \
  -d '{"ref":"asset:<assetId>"}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/extract"
# -> { "result": { "ref": "...", "path": "...", "sourceKind": "pdf", "pageCount": 1, "chars": 14,
#                  "text": "姓名：test1\n测试文本\n66",
#                  "pages": [ { "page": 1, "source": "mixed", "fromTextChars": 2,
#                               "fromOcrChars": 12, "droppedCoveredLines": 1 } ],
#                  "textPath": "<packagePath>/artifacts/text/<sha256>.txt",
#                  "ocrRan": true, "ocrEngine": "newbee-ocr-cli", "ocrDpi": 200,
#                  "avgConfidence": 0.983, "textProvider": "pdfkit", ... } }
```

How it behaves:

- **Per page, the two sources are merged by geometry.** The PDF's own text layer is exact where it exists; OCR covers everything else. So a born-digital report yields its exact digits and never runs OCR at all (`ocrRan:false`, worth reporting — it means the text is not a recognition result), a scanned page yields OCR text, and a page that is both yields both.
- `pages[].source` is `text` | `ocr` | `mixed` | `empty` — say which one you got rather than implying everything was read the same way.
- Text is also cached to `textPath` (plus a `.json` sidecar). That is an ordinary file: re-read it with your own tools, or `grep`/`sed` a slice instead of re-extracting. Repeating the same call returns `cached:true` in milliseconds. Pass `{"force":true}` to redo it.
- Batch with `{"refs":[...]}` (**max 20**, run sequentially) instead of shell-looping: each document may run OCR, which is CPU bound and spawns native processes.
- **For more than a couple of files — or whenever one long request is risky — queue the work instead of waiting for it.** Add `"background": true`:
  ```sh
  curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" -H "Content-Type: application/json" -X POST \
    -d '{"refs":["asset:<id1>","asset:<id2>"],"background":true}' \
    "$FRONTEND_BRIDGE_URL/api/frontend/extract"
  # -> { "jobs": [ { "ref": "asset:<id1>", "jobId": "extract-..." }, ... ],
  #      "poll": "/api/frontend/extract/jobs/<jobId>" }

  curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
    "$FRONTEND_BRIDGE_URL/api/frontend/extract/jobs/extract-..."
  # -> { "job": { "state": "queued|running|completed|failed", "percent": 40,
  #               "error": null, "result": { ...same result object as above... } } }
  ```
  It returns in milliseconds. `state:"queued"` is normal and expected — the runner is strictly sequential, so in a batch the second job waits for the first. Poll until every job leaves `queued`/`running`; a `completed` job **keeps its result**, so a late or repeated poll returns the text without redoing the OCR. Tell the user how many are done rather than going silent, and prefer this over a longer timeout: if a request is cut off mid-batch, the files that never started are simply never queued.
- **OCR takes seconds to minutes per document.** With the foreground form use a generous `--max-time`; the work continues and caches even if the request is cut off, so a retry is cheap.
- **Photos and screenshots work too.** The OCR engine has no raster entry point, so a PNG/JPEG is wrapped into a one-page PDF first; you do not do anything differently, but the result tells you what happened: `sourceKind:"image"`, `textProvider:"none"` (an image has no text layer, so **every** page is `source:"ocr"` and the OCR caveats below apply in full), and `imageRender` with the source size, the rendered size and a `scale`. `scale < 1` means the image was bigger than the render guard and the page was shrunk, so OCR saw fewer pixels than the file holds — mention it if the user asked for detail from a large photo. PNG (including 1-bit scans and transparency, composited onto white) and JPEG both work; anything else, including Office files and DICOM, fails with a message naming the extension rather than returning nothing.
- `{"dpi":300}` is **not** a general accuracy win: measured on a ~205 dpi scanned lab report it changed nothing (character accuracy 98.4% at both 200 and 300) while costing ~30% more time, because the embedded image holds no more detail to recover. Leave it at the default 200 unless the source really is high resolution and the text is small.
- **OCR error concentrates in symbols, not in the data.** On the same measurement the 11 differing characters were 8 misread arrows (`↑`/`↓` read as `1`, or dropped) plus 3 characters of footer boilerplate — every patient name, ID, date, analyte name, numeric value, unit and reference range came through exactly. On a lower-quality scan the same mechanism also drops thin-stroke CJK characters (`结果`→`果`). So when a table column looks corrupted, prefer the primary values (which survive) over derived/symbol columns, and say which parts you would not trust.
- **Recompute a derived column instead of copying it when the copy is suspect.** A column that is a function of the others — a lab flag (`↑` high / `↓` low), a ratio, a unit conversion, a total — is both the first thing OCR mangles and the thing you can rebuild: `↑` simply means the numeric result lies outside its own reference range. So derive it from the primary values and say that you did, rather than propagating an unreadable symbol; the report itself stays trustworthy because the inputs survived.
  ```
  result 1284.00, reference range 0.00-35.00  ->  above the upper bound, so the flag is "high"
  # even though the digitised flag cell came back empty, or as "1" instead of "↑↑↑"
  ```
  Two limits: only derive when you actually have both the value and its reference range (if the range is what is unreadable, say so and leave the flag unknown — do not invent one), and never present a derived value as if it were read off the page. Report which cells were read and which were computed.
- **Treat OCR-derived text as recognition output, not fact.** Quote `avgConfidence` / `lowConfidenceBoxes` when they matter, and say that values read by OCR (especially digits and symbols) should be verified against the source. Text-layer content needs no such caveat.
- `unmappedCompatChars` non-empty means the extractor produced CJK compatibility characters it could not repair (e.g. `⻔` for `门`): the text is usable but exact matching may fail — mention it rather than passing the text off as verbatim.
- Unresolved refs fail with `404` (`stale ref`), and an unavailable OCR runtime fails with the reason from `extract/status` — check status first on a fresh machine.

### ROI and annotation reporting rules

- ROI and annotation request coordinates are zero-based current-slice image-plane index coordinates. Call these `index-pixels` or `image-plane indices`, not physical units.
- `measurements.width`, `measurements.height`, `measurements.area`, `measurements.perimeter`, and ruler `measurements.length` are physical/world measurements. Use `measurementUnits`; normally width/height/perimeter/length are `mm`, area is `mm^2`, and scalar stats are image scalar units.
- Do not say a non-approximated ROI count is caused by supersampling. The VolView `roiStats.ts` helpers use inclusive endpoint index ranges for rectangle-style bounds. For example, a rectangle from x=120 to x=184 and y=80 to y=128 has `(184 - 120 + 1) * (128 - 80 + 1) = 65 * 49 = 3185` samples, even though the request span was `width:64,height:48`.
- `sampled: false` means the ROI was not stride-thinned by `maxSamples`; it does not mean supersampled. `sampled: true` means the bridge used a stride because the candidate ROI was larger than `maxSamples`.
- `roiPixelGrid.rows` from `POST /api/frontend/volview/roi` are nearest-center sampled scalar values over the requested grid. They are not per-cell averages. The grid response says `sampling: nearest-center-with-null-outside-roi`.
- Polygon ROI measurements have area, perimeter, scalar stats, and count. If you discuss polygon width/height, label it as the image-plane bounding box, not as a polygon physical measurement.
- Circle requests are normalized internally as ellipse ROI parameters with equal radii. It is fine to say `circle normalized to ellipse with rx=ry`.
- Segmentation masks are current-slice-only. Do not claim the whole series or whole volume was segmented unless a future chunked/export endpoint was explicitly used.
- `POST /api/frontend/volview/segmentation` writes VolView-native labelmap segment data. It does not create annotation overlays; use `/annotation` for visual measurement overlays.
- For natural-language requests like "create a segmentation named X", put the display name in `segment.name`. Use `groupName` / `segmentGroupName` only if the user explicitly asks to name or rename the segment group.
- When creating a new segmentation from a new ROI/mask, omit both `segmentGroupId` and `segmentValue`. The bridge creates a fresh segment group and uses segment value 1, so overlapping AI-generated masks can be hidden/deleted independently.
- To add another segment to an existing group, pass `segmentGroupId` (preferred after listing groups) or `reuseSegmentGroup:true`; then omit `segmentValue` to use the next unused value in that group.
- Existing non-background labels are preserved by default. Send `overwriteExisting:true` only when the user explicitly asks to overwrite or replace existing segmentation pixels.
- For `mode:"replace"`, describe the replacement as bounded to the affected current-slice mask bounds. It replaces only the target segment's current-slice pixels unless `overwriteExisting:true` is also used. For whole-slice/whole-volume replacement, ask for a narrower request or wait for the later bounded export/chunk milestone.
- For natural-language thresholds like "above the ROI mean", use `threshold:{"mode":"above","value":"mean"}` instead of making a separate ROI call unless the user asks to report the ROI stats first. The response includes `currentSliceMask.threshold.stats`.
- For localized segmentation around a point, use `seed:{"x":...,"y":...}` plus `threshold` to keep only the connected component containing that seed. Use `connectivity:4` by default; use `8` only when diagonal connectivity is desired.
- Whole-volume access must start with `/api/frontend/volview/volume` `action:"info"`. For data values, request explicit bounded chunks only. Never ask for the whole volume as one normal JSON response unless `info.rawBytes`, requested `sampleVoxels`, `maxVoxels`, and `maxBytes` prove it is within limits.
- Volume chunk coordinates are image IJK indices, not current-slice image-plane coordinates and not physical mm. `origin` and `size` define a source window: source inclusive range is `origin` through `origin + size - 1`. `stride` chooses samples inside that source window; it does not multiply the source range. For example, `origin:[0,0,0]`, `size:[64,64,4]`, `stride:[2,2,1]` has `sourceRange` i/j/k `[0..63,0..63,0..3]`, `sampledRange` `[0..62,0..62,0..3]`, and `sampleSize` `32x32x4`. Do not describe it as `[0..126,0..126,0..3]`.
- When summarizing chunk results, prefer the response fields `chunk.sourceRange`, `chunk.sampledRange`, `chunk.sampleSize`, `chunk.sampleVoxels`, `valueRange`, and `histogram`. Do not recalculate displayed ranges unless those fields are absent.
- Chunk values are flattened with x/i changing fastest, then y/j, then z/k.
- For whole-volume AI analysis, prefer `/api/frontend/volview/volume` with `action:"scan"` over multiple manual chunk calls. Scan returns compact stats only: no `values` array. Start with `stride:[1,1,1]` only if `info.voxelCount` is under `maxScanVoxels`; otherwise choose a stride such as `[2,2,1]` or a smaller source window.
- Use `threshold` or `thresholds` with `action:"scan"` for questions like "how much of the volume is above X" or "where are values in this range". Use `gt:X` for strict "above X" / "greater than X", `gte:X` or `min:X` for "at least X", `lt:X` for strict "below X", and `lte:X` or `max:X` for "at most X". Report `thresholdCounts[].count`, `fraction`, `boundingBox`, `lowerExclusive`, and `upperExclusive`; describe the bounding box as approximate sampled IJK bounds when stride is greater than 1.
- Use `includeSlices:true` only when the user asks for per-slice/slab trends or "which slice has the strongest signal". Report `sliceSummary.extrema` first; only print full `sliceSummaries` if the user needs a table and it is not too long.
- Treat `/volume` scalar values as raw image scalar values unless metadata clearly establishes calibrated units. Do not call low values "air", "tissue", "soft tissue", "HU", "padding", "background", or "anatomical mass" as a fact unless DICOM modality/rescale context supports that wording. Prefer cautious phrasing such as "uniform low scalar values", "likely background/padding", "less-negative scalar values", "higher scalar cluster", or "possible in-volume structure". Avoid saying a chunk/scan is "seeing tissue" solely because values are less negative than the corner/background value.

### Snapshot image streaming safety

The snapshot endpoint may return `image.dataURL` as a long `data:image/png;base64,...` string. **Never put that data URL directly into streamed Markdown image syntax** such as:

```md
![current viewer](data:image/png;base64,...)
```

Assistant text is streamed token by token. If a partial base64 data URL is rendered while it is still streaming, the frontend may repeatedly try to render broken intermediate URLs and flicker until the full string arrives.

When the user asks to "return the image", "show the image", "render a preview", or similar:

- Fetch `/api/frontend/volview/snapshot` as needed, but do not print `image.dataURL` inline in chat.
- If a rendered preview is requested, save the complete PNG to a temporary local file yourself, URL-encode the local file path first, then return Markdown that points to the app's local-file protocol: `![volview-preview](h3://localhost/file/<already-url-encoded-local-file-path>)`.
- Use a safe ASCII temporary filename, e.g. `/tmp/pmt-volview-preview-<timestamp>.png` or `$TMPDIR/pmt-volview-preview-<timestamp>.png`, so the resulting path is easy to encode.
- The Markdown URL is plain text; it will not call JavaScript functions. The path segment after `/file/` must already be URL-encoded before writing the Markdown. Equivalent encoding is JavaScript `encodeURIComponent(localFilePath)` or Python `urllib.parse.quote(localFilePath, safe='')`.
- Prefer a concise metadata summary alongside the preview: image width/height, crop, view, and slice.
- If terminal output is needed, omit the data URL with `jq 'del(.image.dataURL)'`.
- Only include the raw data URL if the user explicitly asks for the literal string and accepts that it is large and unsuitable for streamed Markdown previews.

### Examples

```sh
# parsed summary
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/parsed/summary"

# list patients
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/parsed/patients"

# active viewer image/pixel snapshot, omitting the large PNG data URL from terminal output
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/snapshot?maxWidth=768&bins=64" \
  | jq 'del(.image.dataURL)'
```

When a chat-rendered preview is requested, create the PNG file first and return only the compact `h3://localhost/file/...` Markdown image.

```sh
OUT="${TMPDIR:-/tmp}/pmt-volview-preview-$(date +%s).png"
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/snapshot?maxWidth=768" \
  | python3 -c 'import base64,json,sys; data=json.load(sys.stdin)["image"]["dataURL"].split(",",1)[1]; open(sys.argv[1],"wb").write(base64.b64decode(data))' "$OUT"
ENCODED_PATH=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$OUT")
printf '![volview-preview](h3://localhost/file/%s)\n' "$ENCODED_PATH"
```

```sh
# histogram/pixel summary only
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/snapshot?includeImage=false&bins=64"

# downsampled nearest-value scalar grid for the current 2D slice, omitting the PNG image
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/snapshot?includeImage=false&includePixels=true&pixelWidth=32&pixelHeight=32"

# rectangle ROI statistics on the current 2D slice; x/y are image-plane indices, not screen pixels
# sampleCount may exceed width*height because VolView's native stats include endpoint indices.
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"roi":{"type":"rectangle","x":120,"y":80,"width":64,"height":48},"bins":64}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/roi" \
  | jq '.currentSliceRoi | {viewName, orientation, slice, coordinateSystem, planeAxes, roi, measurements, measurementUnits, valueRange, sampleCount, sampled}'

# polygon ROI with a small bounded nearest-value grid; values outside the polygon are null
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"roi":{"type":"polygon","points":[[120,80],[180,90],[160,140]]},"includePixels":true,"pixelWidth":16,"pixelHeight":16}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/roi"

# circle ROI; this matches the existing VolView ellipse/circle annotation measurement path
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"roi":{"type":"circle","cx":160,"cy":110,"radius":32},"bins":64}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/roi" \
  | jq '.currentSliceRoi | {viewName, orientation, slice, roi, measurements, measurementSource}'

# create rectangle annotation overlay on active pane.
# Input width/height are image-plane index-pixel units; measurements.width/height are physical mm.
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"create","type":"rectangle","annotation":{"x":120,"y":80,"width":64,"height":48}}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/annotation" \
  | jq '.annotation | {id,type,imagePlaneGeometry: .imagePlane.geometry, measurements, measurementUnits}'

# create ruler annotation overlay
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"create","type":"ruler","annotation":{"x1":120,"y1":80,"x2":180,"y2":92}}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/annotation" \
  | jq '.annotation | {id,type,imagePlaneGeometry: .imagePlane.geometry, measurements, measurementUnits}'

# update an annotation by id (move / restyle)
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"update","annotationId":"<tool-id>","annotation":{"x":130,"y":90,"width":64,"height":48,"color":"#00ff88"}}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/annotation"

# delete annotation by id
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"delete","annotationId":"<tool-id>"}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/annotation"

# list annotations for the current image on active pane context
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"list"}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/annotation" \
  | jq '{count, annotations: [.annotations[] | {id,type,slice,measurements}]}'

# list VolView-native segment groups for the current image
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"list"}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/segmentation" \
  | jq '{count: (.segmentGroups | length), segmentGroups}'

# create a new independently toggleable current-slice segmentation from an ROI threshold.
# Omit segmentGroupId and segmentValue for a new AI segmentation group.
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"applyMask","segment":{"name":"AI threshold ROI","color":"#00ff88"},"roi":{"type":"rectangle","x":120,"y":80,"width":64,"height":48},"threshold":{"min":100,"max":300},"mode":"add"}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/segmentation" \
  | jq '{segmentGroup: .segmentGroup.id, segment: .segment, mask: .currentSliceMask}'

# apply a small explicit binary mask as a new independently toggleable segmentation
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"applyMask","segment":{"name":"AI binary mask","color":"#ffcc00"},"mask":{"x":120,"y":80,"rows":[[1,1,0,0],[1,1,1,0],[0,1,1,1]]}}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/segmentation" \
  | jq '{segmentGroup: .segmentGroup.id, segment: .segment, painted: .currentSliceMask.painted}'

# threshold from ROI statistics in one request: pixels above the ROI mean
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"applyMask","segment":{"name":"Above ROI mean","color":"#00ccff"},"roi":{"type":"rectangle","x":120,"y":80,"width":64,"height":48},"threshold":{"mode":"above","value":"mean"}}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/segmentation" \
  | jq '{segment: .segment, threshold: .currentSliceMask.threshold, painted: .currentSliceMask.painted}'

# seed-connected segmentation: threshold first, then keep only the component touching seed x/y
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"applyMask","segment":{"name":"Seed component","color":"#ff66cc"},"roi":{"type":"circle","cx":180,"cy":130,"radius":48},"threshold":{"mode":"above","value":"median"},"seed":{"x":180,"y":130},"connectivity":4}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/segmentation" \
  | jq '{segment: .segment, connectedComponent: .currentSliceMask.connectedComponent, painted: .currentSliceMask.painted}'

# whole-volume metadata only: dimensions, spacing, scalar type, and safe chunk limits
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"info"}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/volume" \
  | jq '{dimensions, spacing, scalarType, components, rawBytes, chunkLimits}'

# bounded volume chunk: explicit IJK source window, x-fastest flattened values
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"chunk","origin":[0,0,0],"size":[64,64,4],"stride":[2,2,1],"bins":64}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/volume" \
  | jq '{chunk: {sourceRange: .chunk.sourceRange, sampledRange: .chunk.sampledRange, sampleSize: .chunk.sampleSize, sampleVoxels: .chunk.sampleVoxels, rawBytes: .chunk.rawBytes, valuesOrder: .chunk.valuesOrder}, valueRange, histogram: .histogram.counts}'

# stats-only bounded volume chunk without returning values
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"chunk","origin":[0,0,0],"size":[128,128,8],"stride":[2,2,2],"includeValues":false}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/volume" \
  | jq '{chunk: {sourceRange: .chunk.sourceRange, sampledRange: .chunk.sampledRange, sampleSize: .chunk.sampleSize, sampleVoxels: .chunk.sampleVoxels, rawBytes: .chunk.rawBytes}, valueRange}'

# stats-only whole-volume scan: no raw values returned
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"scan","stride":[1,1,1],"bins":64}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/volume" \
  | jq '{scan: {sampledRange: .scan.sampledRange, sampleVoxels: .scan.sampleVoxels, chunking: .scan.chunking}, valueRange, histogram: .histogram.counts}'

# whole-volume scan with threshold count and per-slice extrema
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"action":"scan","stride":[1,1,1],"thresholds":[{"name":"strictly above -700","gt":-700}],"includeSlices":true,"maxSliceSummaries":128}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/volview/volume" \
  | jq '{valueRange, thresholdCounts, sliceSummary}'

# studies for a specific patient (the key is an opaque dicomEntityId UUID)
#   — first fetch the patient key from /parsed/patients, then interpolate it:
PATIENT_KEY="<dicomEntityId-uuid-from-/parsed/patients>"
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/parsed/patients/$(printf %s "$PATIENT_KEY" | jq -sRr @uri)/studies"
```

### Ordering: first, last, and Nth instance

**Important:** the `instances` map you see in `/api/frontend/state` is a plain object whose key order is *insertion* order. The viewer parses files concurrently, so insertion order does **not** match `InstanceNumber`. If you take `Object.keys(instances).at(-1)` you will pick a random instance, not the last one.

To answer "first / last / Nth instance" correctly, **always** call:

```
GET /api/frontend/parsed/patients/{patientKey}/studies/{studyKey}/series/{seriesKey}/instances
```

It returns a `{ count, instances, first, last }` payload where `instances` is sorted ascending by `InstanceNumber` (with stable secondary order). Use `first`, `last`, or `instances[N-1]` directly. Do not re-sort or re-index client-side.

```sh
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  "$FRONTEND_BRIDGE_URL/api/frontend/parsed/patients/$P/studies/$S/series/$SE/instances" \
  | jq '{count, first: .first, last: .last}'
```

Then build the `keys` for `selectInstance` / `openInVolView` from the chosen instance's `key`.

## Write endpoint (POST `/api/frontend/ui/dispatch`)

Body: `{ "command": "<name>", "payload": { ... } }`

**Response is authoritative.** The bridge waits for the renderer to actually run the command and returns:
- Success → `{ "ok": true, "command": "...", "result": ... }`. `result` carries the command's own return value where it has one — notably the **new `assetId`** from `replaceAnalysisResult` — and is `null` for commands that only change UI state.
- Failure → HTTP **500** with a message that includes the renderer's error (e.g. `command "labelAssign" failed: unknown label "Reviewed" — create it first with labelCreate`).

**Never report a UI action as done just because you sent it.** Check the HTTP status: a 2xx means it ran; a 4xx/5xx means it did **not** take effect, and you should relay the error (and fix the cause) instead of claiming success.

Allowed commands (current whitelist):

| command | payload | effect |
|---|---|---|
| `selectInstance` | `{ "keys": [patient, study, series, instance] }` | **Render this instance in the main app window** (the embedded viewer). Internally: expands ancestor rows in the patient/study/series tree if they are collapsed, then marks this instance as the recently-clicked thumbnail — which causes the main window's viewer pane to load that series at the chosen slice. This is the in-app "highlight / view this slice" action. |
| `openInVolView` | `{ "keys": ["patientKey", "studyKey?", "seriesKey?", "instanceKey?"] }` | Opens the (deepest resolvable) instance in a **separate, standalone viewer window**. If `keys` ends at a series/study/patient, the first instance underneath is opened. The `newWindow` flag is implicit — do not send it. |
| `expand` | `{ "keys": [...] }` | Expand the branch at this path (without highlighting anything). Works for **every** node returned by `/api/frontend/tree`: patient, study, series, `pmt-patient-level` (e.g. Demographic Data), `timepoint` (`tp\|<date>`), and `other-files` / its extension groups. |
| `collapse` | `{ "keys": [...] }` | Collapse it. Same coverage as `expand`. |
| `collapseAll` | _(none)_ | Collapse the entire tree. |
| `toggleModuleManager` | `{ "open": true }`, `{ "open": false }`, or _(none)_ | Open, close, or toggle the main app Module Manager dialog. |
| `volviewSetSlice` | `{ "slice": 42 }` | Set the active embedded VolView pane to an absolute zero-based slice index. Read `/api/frontend/volview/current` first and use `state.currentSlice.config.min/max` to stay in range. |
| `volviewStepInstance` | `{ "delta": 1 }` or `{ "delta": -1 }` | Move the active embedded VolView pane by DICOM instance order. Use this for casual "next/previous slice/image/instance" wording, because the constructed volume's raw slice index may be reversed relative to InstanceNumber. |
| `volviewStepSlice` | `{ "delta": 1 }` or `{ "delta": -1 }` | Move the active embedded VolView pane by raw VolView slice-index order. Use this only when the user explicitly asks to increase/decrease the slice index or move the slicer/slider by index. Read `/api/frontend/volview/current` first when deciding a safe delta. |
| `volviewSetSliceByDicomTag` | `{ "tag": "InstanceNumber", "value": 42 }`, `{ "tag": "SOPInstanceUID", "value": "..." }`, or `{ "tag": "0008|0018", "value": "..." }` | Set the active embedded VolView pane to the slice whose DICOM tag matches `value`. `tag` may be a known keyword from `state.currentSlice.dicomTags.named` or a raw key from `state.currentSlice.dicomTags.raw`. Optional `match`: `equals` (default) or `contains`; optional `direction`: `first` (default), `last`, `forward`, `backward`, or `nearest`. |
| `volviewSetWindowLevel` | `{ "width": 400, "level": 40 }`, `{ "width": 1500 }`, or `{ "level": -600 }` | Set the active embedded VolView pane's window width and/or window level. Use for explicit WL values, CT presets the user names, or prompts like "set lung window" after translating to numeric width/level. |
| `volviewStepWindowLevel` | `{ "widthDelta": 100 }`, `{ "levelDelta": -25 }`, or `{ "widthScale": 0.8 }` | Adjust the active embedded VolView pane's current window/level relatively. Smaller width increases contrast; larger width lowers contrast. Level shifts the intensity center. |
| `volviewResetWindowLevel` | _(none)_ | Reset the active embedded VolView pane's window/level to VolView defaults for the current image. |
| `volviewApplyDicomWindowLevel` | _(none)_ | Apply the current slice's DICOM `WindowWidth`/`WindowLevel` tags when available. Read `/api/frontend/volview/current` first; if `state.windowLevel.dicom` is null, say there is no DICOM WL on the current slice. |
| `volviewSetActiveView` | `{ "viewID": "..." }`, `{ "name": "Axial" }`, `{ "orientation": "Sagittal" }`, or `{ "type": "3D" }` | Focus/select an existing embedded VolView pane. Do **not** use this to change the current pane from axial to sagittal/coronal/3D; use `volviewSetActiveViewType` for that. |
| `volviewSetActiveViewType` | `{ "name": "Sagittal" }`, `{ "orientation": "Coronal" }`, `{ "type": "3D" }`, or `{ "viewID": "...", "name": "Axial" }` | Change the active embedded VolView pane's view type, matching the in-app view type switcher. This preserves the current pane's image data and does not switch to an `Only` layout. Use this for prompts like "switch to sagittal", "make this view coronal", or "change the current viewer to 3D". |
| `volviewSetActiveViewMaximized` | `{ "maximized": true }` or `{ "maximized": false }` | Maximize or restore the current active embedded VolView pane. Do not send a `viewID` unless the user explicitly names another pane; for "current viewer", let VolView use its active view. |
| `volviewPlayCine` | `{ "fps": 10, "direction": "forward" }` or just `{}`  | Start a cine (movie-style) auto-play of slices in the active 2D pane. `fps` defaults to 10 (range 1–60). `direction`: `"forward"` (default, wraps from last to first), `"backward"` (wraps from first to last), or `"pingpong"` (bounces back and forth). Use this for prompts like "play this series", "animate the slices", "start cine". |
| `volviewStopCine` | _(none)_ | Stop any currently running cine playback. Use for "stop", "pause", "stop playing". Safe to call even if nothing is playing. |
| `labelCreate` | `{ "name": "Abnormal", "color": "#ff4444" }` | Create a new global label definition with a name and hex color. The label becomes available for assignment to any DICOM item. Returned label dots appear in the patient tree. |
| `labelRename` | `{ "oldName": "Abnormal", "newName": "Urgent" }` | Rename a global label. Propagates to all existing assignments across all loaded roots in the database. |
| `labelRecolor` | `{ "name": "Abnormal", "color": "#ff8800" }` | Change the color of an existing global label. Takes effect immediately in the UI. |
| `labelDelete` | `{ "name": "Abnormal" }` | Delete a global label and remove all its assignments from all loaded roots. |
| `labelAssign` | `{ "keys": ["patientKey", "studyKey", "seriesKey"], "label": "Abnormal" }` | Assign a label to a DICOM item (patient, study, series, or instance). A colored dot appears next to the item in the tree. Automatically loads label data for the item's root if needed. |
| `labelRemove` | `{ "keys": ["patientKey", "studyKey", "seriesKey"], "label": "Abnormal" }` | Remove a label assignment from a DICOM item. |
| `labelSetDetails` | `{ "keys": ["patientKey", ...], "label": "Abnormal", "description": "Mass in left lobe...", "meta": { "size": "2.3cm" }, "files": { "screenshot.png": { "name": "screenshot.png", "type": "image/png" } } }` | Set or update label details (description, metadata, attached files) for a label assignment. If details already exist, they are updated; otherwise created. |
| `createManualPatient` | `{ "patientName": "Jane Doe", "patientId": "MRN-123", "patientBirthDate": "19570523", "patientSex": "F", "customFields": { "Patient Address": "12 Example St" } }` | Create a new manual (non-DICOM) patient. Only `patientName` is required. The extra fields stand in for the DICOM patient tags so an export/de-identification module can match and scrub them in the patient's attached documents. The patient appears in the tree with only the 10 data types (no studies). |
| `updateManualPatient` | `{ "dicomEntityId": "<patientKey>", "patientName": "Jane Doe", "patientId": "MRN-123", "patientBirthDate": "19570523", "patientSex": "F", "customFields": { "Patient Address": "12 Example St" } }` | Edit a manual patient. **Full replace, not a patch**: any field you omit (or send as `null`) is cleared, so read the current values from `/parsed/manual-patients` first and send the complete set. `patientSex` accepts `M`/`F`/`O` or `male`/`female`/`other`; `patientBirthDate` accepts `YYYYMMDD` or `YYYY-MM-DD` and is **stored as `YYYYMMDD`** (the DICOM `DA` form). |
| `deleteManualPatient` | `{ "dicomEntityId": "<patientKey>" }` | Delete a manual patient and its category content. Use `patientName`/`patientId` from `/parsed/manual-patients` to confirm the right one first. |
| `mergeManualPatient` | `{ "manualEntityId": "<patientKey>", "targetEntityId": "<dicom patientKey>" }` | Merge a manual patient into an existing DICOM patient (manual → DICOM only). Moves the manual patient's label assignments + category files onto the target, then deletes the manual patient. **If the manual patient has a birth date, sex or custom fields, they are first backed up into the target's Demographic Data as a `metadata.json` file** (the manual entity is deleted, so this is the only surviving record). Mention that to the user before merging — it is destructive and cannot be undone. |
| `addAnalysisResults` | `{ "category": "pmt-patient-photos-and-images", "paths": ["evidence:<root>:<rel>", ...] }` | Add files (as managed assets) to an Analysis Results sub-folder. `paths` may be `evidence:`/`asset:` refs (resolved automatically) or real filesystem paths. |
| `removeAnalysisResult` | `{ "category": "pmt-patient-photos-and-images", "assetId": "..." }` | Remove a file from an Analysis Results sub-folder. |
| `createAnalysisResultNote` | `{ "category": "pmt-patient-clinical-notes-and-summary", "name": "My Note.txt", "content": "..." }` | Create a new note file in an Analysis Results sub-folder. |
| `createAnalysisResultSpreadsheet` | `{ "category": "pmt-patient-demographic-data", "name": "Sheet", "csvText": "a,b\n1,2\n", "type": "csv" }` | Create a new CSV/XLSX spreadsheet in an Analysis Results sub-folder. `type` is `"csv"` or `"xlsx"`. |
| `replaceAnalysisResult` | `{ "category": "pmt-patient-clinical-notes-and-summary", "assetId": "<old assetId>", "name": "note.md", "content": "..." }` | **Update** an existing Analysis Results file: replace its content, and optionally its name. `name` is required — pass the current name to keep it. `assetId` must be the file's **current** id (from `/parsed/analysis-results`). **The replacement is a new managed asset, so `assetId` CHANGES** — the call returns `{ assetId, name, extension, mimeType, byteSize }` and you must use the new `assetId` from then on. |
| `openAnalysisResults` | `{ "category"?: "pmt-patient-blood-tests", "assetId"?: "<assetId>", "name"?: "summary.xlsx" }` | Open the Analysis Results panel, select that data-type tab and scroll to + flash the file row (matched by `assetId`, else by exact `name`). Call it after writing a file so the user sees the result. Payload is optional (opens the panel on its current tab). |
| `closeAnalysisResults` | _(none)_ | Close the Analysis Results panel. The selected tab, the filter and the last highlight are remembered (only `open` changes). |
| `setAnalysisResultsFilter` | `{ "filter": "ct" }` | Set the panel's file-name filter (case-insensitive substring). Send `{ "filter": "" }` to clear it. Pair with `openAnalysisResults` when the user wants to *see* a subset. |
| `createDataPackageTarget` | `{ "name": "Delivery A" }` | Create a Target. Returns the target snapshot (its `id` is what `createDataPackage` needs). |
| `renameDataPackageTarget` | `{ "targetId": "...", "name": "Delivery B" }` | Rename a Target. |
| `removeDataPackageTarget` | `{ "targetId": "..." }` | Delete a Target **and all of its packages/items**. Confirm first. |
| `createDataPackage` | `{ "targetId": "...", "name": "Baseline" }` | Create a Package inside a Target. Returns the package snapshot. |
| `renameDataPackage` | `{ "packageId": "...", "name": "Week 8" }` | Rename a Package. |
| `removeDataPackage` | `{ "packageId": "..." }` | Delete a Package and its items (the referenced data is untouched). Confirm first. |
| `addDataPackageItem` | `{ "packageId": "...", "ref": { "kind": "patient", "entityId": "..." } }` | Add one item. Returns `{created, duplicate, item}` — see "Data Packaging" for the per-`kind` ref shapes. |
| `removeDataPackageItem` | `{ "itemId": "..." }` | Remove one item from its package (`itemId` comes from `/api/frontend/packaging`). |
| `exportDataPackage` | `{ "packageId": "..." }` | Expand the package in the main process and write its manifest to `<packagePath>/artifacts/packages/<packageId>.json`. Returns `{ manifestPath, fileCount, warningCount }`. Fails if the package has no items. |
| `openDataPackaging` | `{ "packageId"?: "...", "itemId"?: "..." }` | Open the Data Packaging panel and select that package; with `itemId` it also scrolls to + flashes that row (use it right after adding an item). Payload optional (opens on the current selection). |
| `closeDataPackaging` | _(none)_ | Close the panel. The selected package and filter are remembered. |
| `setDataPackagingFilter` | `{ "filter": "ct" }` | Set the panel's item filter (matches the item name and its parent path). `""` clears it. |
| `showInFolder` | `{ "keys": [...] }` **(preferred)** or `{ "path": "/abs/path" }` | Reveal in OS file manager. **Always prefer `keys`** — the bridge resolves the real path (instance `evidence:` ref, or the patient/study/series source root) from the authoritative store. Only fall back to `path` if you have a path that is not in the parsed data; even then, copy it verbatim from a previous bridge response, never retype it (CJK / lookalike characters can silently break `path`). |

### `selectInstance` vs `openInVolView` — which to use

Both render the chosen instance, but they target different windows. Pick based on the user's intent:

- **Default = `selectInstance`** (in-app rendering). Use it whenever the user asks to "view", "show", "highlight", "select", "display", "render", "jump to", "go to" an instance / slice / series / study. The result appears in the main app window's viewer pane — no extra window pops up. This is what users usually mean.
  - It accepts a series-level path too: pass `[patient, study, series]` to render that series from its first instance, or `[patient, study, series, instance]` to render at a specific slice.
- **Use `openInVolView` only when:**
  1. The user explicitly says "new window", "separate window", "standalone", "pop out", "detach", or similar.
  2. The user references the **source file** of an instance (e.g. "open the file `IM-0554-0004.dcm`", "open this file", "open the file path …"). Mentioning the file path / file name signals they want the on-disk file opened in a fresh viewer window, not just navigation inside the existing tree.
- If unsure, prefer `selectInstance`. It is non-disruptive (no new window) and easy to follow up with `openInVolView` if the user wants more.

#### Quick mapping

| User says… | Use |
|---|---|
| "highlight the 4th instance of series Z" | `selectInstance` |
| "show me slice 12 of series Z" | `selectInstance` |
| "move to the next slice" / "go back 3 slices" | `volviewStepInstance` |
| "jump to InstanceNumber 42" | `volviewSetSliceByDicomTag` with `{ "tag": "InstanceNumber", "value": 42 }` |
| "go to SOPInstanceUID X" | `volviewSetSliceByDicomTag` with `{ "tag": "SOPInstanceUID", "value": "X" }` |
| "find the next slice where tag X contains Y" | `volviewSetSliceByDicomTag` with `{ "tag": "X", "value": "Y", "match": "contains", "direction": "forward" }` |
| "increase the slice index" / "move the slider one index up" | `volviewStepSlice` |
| "set this viewer to slice index 42" | `volviewSetSlice` |
| "set lung window" | `volviewSetWindowLevel` with `{ "width": 1500, "level": -600 }` |
| "apply the DICOM window" | `volviewApplyDicomWindowLevel` |
| "make it higher contrast" | `volviewStepWindowLevel` with a smaller `widthScale`, for example `{ "widthScale": 0.8 }` |
| "make it brighter/darker" | `volviewStepWindowLevel` with a `levelDelta`; read current WL first and use a modest delta. |
| "reset window level" | `volviewResetWindowLevel` |
| "switch to axial/sagittal/coronal" / "make this view sagittal" | `volviewSetActiveViewType` with the matching `name` or `orientation`. |
| "focus the sagittal pane" / "select the 3D view" | `volviewSetActiveView` |
| "maximize this viewer" / "restore the view" | `volviewSetActiveViewMaximized` |
| "play this series" / "animate the slices" / "start cine" | `volviewPlayCine` with appropriate `direction` and `fps`. |
| "stop playing" / "pause cine" | `volviewStopCine` |
| "describe what is visible" / "capture the current viewer" | `GET /api/frontend/current` first — if `lookingAt.kind` is `module-tab`, the user is looking at a module (a PDF/…), not the image. Otherwise `GET /api/frontend/volview/snapshot`; use `image.dataURL` as the image input if the runtime supports image attachments, otherwise summarize available metadata and pixel statistics. |
| "return the image" / "show the image" / "render a preview" | `GET /api/frontend/volview/snapshot`; save the completed `image.dataURL` to a safe temp PNG file, URL-encode the local path, then return `![volview-preview](h3://localhost/file/<already-url-encoded-local-file-path>)`. Never stream the base64 data URL in Markdown. |
| "summarize the current slice histogram" / "what is the intensity range" | `GET /api/frontend/volview/snapshot?includeImage=false&bins=64` |
| "sample the current slice pixels" / "show a downsampled pixel grid" | `GET /api/frontend/volview/snapshot?includeImage=false&includePixels=true&pixelWidth=32&pixelHeight=32`; summarize patterns and avoid dumping all rows unless the user asks. |
| "measure intensities in this rectangle/polygon/circle/ROI" / "sample this region" | `POST /api/frontend/volview/roi` with rectangle, polygon, or circle/ellipse image-plane coordinates. Read `/api/frontend/volview/current` or use a snapshot first to establish current slice dimensions; do not treat screenshot/screen pixels as ROI coordinates unless you have explicitly mapped them to image-plane indices. Prefer `currentSliceRoi.measurements` when comparing with VolView's visible annotation labels (`Mean`, `Median`, `SDev`, `Sum`, `Max`, `Min`, `P`, `Area`, `W`, `H`). |
| "draw/add/create annotation overlay" / "move/update/delete this measurement" | `POST /api/frontend/volview/annotation` with `action` = `create`, `update`, `delete`, or `list`. Use `type` `ruler|rectangle|circle|polygon` for create; keep coordinates in current-slice image-plane indices. |
| "jump to series Z" / "view series Z" | `selectInstance` (keys end at series) |
| "open this in a new window" | `openInVolView` |
| "open this file" / "open the source file…" | `openInVolView` |
| "pop out / detach this series" | `openInVolView` |
| "create a label called Abnormal" / "add a red 'Urgent' tag" | `labelCreate` with name + color. |
| "rename this label to X" | `labelRename` |
| "change the color of label Y" | `labelRecolor` |
| "delete this label entirely" | `labelDelete` |
| "mark this series as reviewed" / "tag this patient" | `labelAssign` with keys + label name. Read `/labeling/definitions` first to know available labels. |
| "unmark this series" / "remove the label" | `labelRemove` |
| "add a note to this label" / "write a finding description" | `labelSetDetails` with `description`, optional `meta` and `files`. |
| "what labels exist?" / "list available tags" | `GET /api/frontend/labeling/definitions`. |
| "what does this patient have?" / "show me the tree" / "what's in this project?" | `GET /api/frontend/tree` (add `patientKey=<key>` for one patient, `files=false` for the branch structure only). |
| "where is X in the tree?" / "what are the keys for this series/timepoint/file?" | `GET /api/frontend/tree` and read the node's `keys` — never invent or retype them. |
| "what can I see right now?" / "what's expanded?" | `GET /api/frontend/tree?visible=true` (or the `tree` block of `/state` for the raw expansion maps). |
| "expand/collapse that branch/date/patient" | `expand` / `collapse` with the node's `keys` (works for every slot, including timepoints and Other Files). |
| "what is this item labeled as?" / "check labels on this series" | `POST /api/frontend/labeling/query` with `root` + `keys`. |
| "show the distribution of labels" / "how many items are labeled X?" | `POST /api/frontend/labeling/query` with `root` (no keys), then aggregate. Use `bar_chart` for label distribution. |
| "list manual patients" / "how many non-DICOM patients" | `GET /api/frontend/parsed/manual-patients` (and compare with `/parsed/patients` `isManual`). |
| "create a patient called X (no DICOM yet)" | `createManualPatient { patientName: "X", patientId?, patientBirthDate?, patientSex?, customFields? }`. |
| "this patient's birth date is wrong" / "add a hospital number to this patient" | `GET /api/frontend/parsed/manual-patients` to read the current values, then `updateManualPatient { dicomEntityId, ...complete field set... }`. Do not send a partial payload — omitted fields are cleared. |
| "merge this manual patient into patient Y" | `mergeManualPatient { manualEntityId, targetEntityId }` — confirm first (destructive). |
| "delete this manual patient" | `deleteManualPatient { dicomEntityId }` — confirm first (destructive). |
| "what's in Analysis Results?" | `GET /api/frontend/parsed/analysis-results`. |
| "add this file to Analysis Results → Photos and Images" | `addAnalysisResults { category: "pmt-patient-photos-and-images", paths: [...] }`. |
| "create a note under Analysis Results → Clinical Notes" | `createAnalysisResultNote { category: "pmt-patient-clinical-notes-and-summary", name, content }`. |
| "update / rewrite that summary file" / "rename it" | `replaceAnalysisResult { category, assetId, name, content }` — read the current `assetId` from `/parsed/analysis-results` first, and use the **new** `assetId` it returns. |
| "delete that summary file" | `removeAnalysisResult { category, assetId }` (confirm first — destructive). |
| "read the file I saved into Analysis Results" | build `asset:<assetId>` from `/parsed/analysis-results`, then `POST /api/frontend/file/resolve` → read `file.path`. |
| "show me that summary file in Analysis Results" | `openAnalysisResults { category, name }` (or `assetId`) — opens the panel, selects the tab and flashes the row. |
| "close that panel" / "only show files named X in the panel" | `closeAnalysisResults` / `setAnalysisResultsFilter { filter: "X" }` (then `openAnalysisResults` if it was closed). |
| "what's in Data Packaging?" / "what am I about to deliver?" | `GET /api/frontend/packaging` → `targets[].packages[]` with live names, `staleCount` and `fileCount`. |
| "make a delivery for site X" / "start a new package" | `createDataPackageTarget { name }` → `createDataPackage { targetId, name }`. |
| "put this patient/series/timepoint in the package" | `addDataPackageItem { packageId, ref }` — build the ref from the tree node (see the ref table). |
| "is that already in the package?" | `addDataPackageItem` answers `{ created: false, duplicate: true }`; or read `/api/frontend/packaging` and compare `itemId`s. |
| "export the package" / "produce the delivery manifest" | `exportDataPackage { packageId }` → `manifestPath` + `fileCount`. |
| "show me the package panel" / "which package is selected?" | `openDataPackaging { packageId, itemId? }`; read `ui.dataPackaging` from `/api/frontend/ui/state` to verify. |
| "remove that item from the package" / "delete this target" | `removeDataPackageItem { itemId }` / `removeDataPackageTarget { targetId }` — both destructive, confirm first. |
| "what category files does this patient have?" | `GET /api/frontend/parsed/categories` → `categories[patientKey]`. |
| "what folders are loaded?" / "where is this patient's data on disk?" | `GET /api/frontend/project/source-roots`; map `patient.root` → `canonicalPath`. |
| "what am I looking at?" / "which file do I have open?" / "do you see the PDF I opened?" | `GET /api/frontend/current` → `lookingAt` (`module-tab` = a non-DICOM file is in front, `volview` = the DICOM viewer is). Never answer this from `/volview/current`. |
| "what's on screen / describe what I see" | `GET /api/frontend/current` first (is a module covering the viewer?), then `/volview/snapshot` **only** when `lookingAt.kind === 'volview'`. |
| "which tabs do I have open?" / "switch back to the DICOM viewer" | `GET /api/frontend/current` → `moduleOverlay.tabs` (+ `visible`/`collapsed`). Revealing VolView is a user action (top-bar chip or clicking a DICOM item), not a bridge command. |
| "which project is open?" / "where is this project saved?" | `GET /api/frontend/project` → `project.name` + `project.packagePath`. |
| "read this file" / "what does this report say?" / "summarize this note" | `POST /api/frontend/file/resolve` with the leaf's ref → read `file.path` with your own file tools. |
| "when was this taken?" / "what's this patient's baseline?" / "put these files in order" | `GET /api/frontend/parsed/timeline` (keyed by the same patient keys as `/parsed/patients`). |
| "is that panel open?" / "did the panel switch to that tab?" | `GET /api/frontend/ui/state` — verify `analysisResults.open`/`category` or `dataPackaging.open`/`selectedPackageId`. |
| "show this patient/study/series in Finder" | `showInFolder { keys: [...] }` (works at any level — the bridge resolves the source root). |

### Example

```sh
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"command":"collapseAll"}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/ui/dispatch"
```

## Guidelines

- **Always start with a small read** (e.g. `/parsed/summary`) before dispatching UI commands, so you act on real keys rather than guessed ones. Remember that **keys are opaque `dicomEntityId` UUIDs**, never human names — copy them from a bridge response, never retype them.
- **Use `/api/frontend/tree` to locate anything.** It returns the user's ordered tree with the `keys` tuple on every node, so "find the item, then act on it" is one read plus one dispatch. Do not reconstruct the tree from `/state` by hand.
- **Confirm before destructive or disruptive UI actions** (e.g. opening many windows, collapsing everything when the user is in the middle of a task, `deleteManualPatient`, or `mergeManualPatient`). For purely informational reads, no confirmation is needed.
- **Do not invent commands.** Only the names listed above are accepted; anything else returns 400.
- **Treat `FRONTEND_BRIDGE_TOKEN` as a secret.** Don't echo it back to the user, don't write it to logs, and don't include it in tool output.
- **Map UUIDs back to names for the user.** The bridge returns `dicomEntityId` UUIDs as keys; always pair them with `PatientName` / `StudyDescription` / `SeriesDescription` / `fileName` when reporting, so the user never sees bare UUIDs.

## Visualizing parsed data — chart selection

When the user asks to chart, plot, visualize, or graph statistics about their loaded data and they do **not** explicitly name a chart type, choose the tool by the **shape of the data**, not by what looks prettiest:

| Data shape | Use the tool | Typical prompts |
|---|---|---|
| Counts / sums / averages across **discrete independent categories** (modality, patient, study, file type) | `bar_chart` | "instances per modality", "files per patient", "series count by study", "modality distribution" (default) |
| **Proportions** of a single whole, **at most 6–7 slices**, values truly sum to a meaningful total | `donut_chart` (set `variant:"pie"` for a solid pie) | "share of modalities in this study", "patient gender split", "% of files by extension" |
| **Trends** over an **ordered numeric / time axis** (SeriesNumber, InstanceNumber, dates) | `chart` (line) | "image count by SeriesNumber", "studies over time", "value of `<tag>` across instances" |
| **Cumulative totals or composition** over an ordered axis, especially when stacking multiple series whose sum is meaningful | `area_chart` | "cumulative file count by modality over time", "stacked instances per modality across studies" |
| **Pixel intensity distributions** (histogram bins from `/snapshot`, `/roi`, or `/volume` endpoints) | `histogram` | "show me the pixel histogram", "intensity distribution for this ROI", "visualize the frequency of HU values" |
| **Structured analysis findings** with labeled observations, values, severity, and details — especially after ROI measurement or segmentation | `findings` | "summarize your findings", "what did you discover", "give me a structured report of this analysis" |

Rules of thumb:

- For **"distribution of X"** with **categorical X**, default to `bar_chart`. Only use `donut_chart` if the user explicitly asks for a "pie", "donut", "share", or "proportion" **and** there are ≤ 6–7 categories. When the user says "pie chart", set `variant:"pie"`; when they say "donut"/"doughnut"/"ring", set `variant:"donut"` (or omit, since donut is the default).
- The modality count list (`modalityCounts` from `/parsed/summary`) is **categorical** → `bar_chart` by default.
- If the user explicitly names a chart type ("plot a pie chart of …", "show me a bar chart of …"), honor it without second-guessing.
- Never use `chart` (line) for purely categorical x-axes — interpolating a line between unrelated category labels is misleading.
- Use `histogram` for pixel intensity distributions — it renders as a bar chart with statistical summary (min/max/mean/median/stddev) above the bars.
- Use `findings` when the user asks for a structured summary of your analysis. Each finding has a `label`, `value`, optional `severity` (critical/warning/abnormal/normal/info), and optional `detail`. This renders as a professional card with color-coded severity icons — much more impressive than raw text.
- **Horizontal bar chart ordering**: when using `bar_chart` with `horizontal:true` for ranked lists (top patients, top series), **reverse the data array** so the #1 item appears at the top. The chart renders index 0 at the bottom visually, so `data.reverse()` puts the highest-ranked item where users expect it. For vertical bar charts, keep the original order.
- Always source the numbers from the bridge endpoints (e.g. `/parsed/summary`, `/parsed/patients/.../series`); do not make up values.

## Labeling — global tags and per-item assignments

The host application has a labeling system: **global label definitions** (name + color) and **per-item assignments** (which labels are applied to which patient/study/series/instance). Both are now persisted in the Project database (SQLite `project.db`) and survive restarts. Labels render as colored dots in the patient tree.

There are two kinds of labels:

- **User labels** — created via `labelCreate` or the Label Manager UI. Assign them to any DICOM item with `labelAssign`.
- **System labels** — the 10 reserved per-patient data-type labels (`systemLabels` in `/labeling/definitions`). Their names equal the data-type keys and are the storage backend for category files. **Never create/rename/recolor/delete them**, and do not surface them as "user tags" — they represent the data types, not annotations.

### Typical labeling workflow

1. **Discover**: `GET /api/frontend/labeling/definitions` — see what labels exist (and which are system labels)
2. **Create if needed**: `labelCreate { name, color }` — create new user labels
3. **Query**: `POST /api/frontend/labeling/query { root, keys }` — check current labels on an item
4. **Assign**: `labelAssign { keys, label }` — tag an item (colored dot appears)
5. **Detail**: `labelSetDetails { keys, label, description, meta, files }` — add structured notes
6. **Remove**: `labelRemove { keys, label }` or `labelDelete { name }` — clean up (only for user labels)

### Labeling rules of thumb

- **Always check definitions first** — call `GET /labeling/definitions` before suggesting labels, so you don't suggest labels the user hasn't created yet, and so you don't mistake the **10** system category labels (the per-patient data types) for user tags.
- **Create the label before assigning it.** `labelAssign` requires the label to already exist (via `labelCreate` or a prior session). If you assign a name that isn't in `/labeling/definitions`, the dispatch returns a 500 with `unknown label "…"` — create it first, then re-assign. Do **not** report success on a 500.
- **Keys are `dicomEntityId` UUIDs** in clinical hierarchy: `[patientKey, studyKey, seriesKey, instanceKey]`. Patient-level = 1 key, study = 2, series = 3, instance = 4. The bridge automatically derives the correct `slot` from key length.
- **Root is auto-resolved**: the bridge finds the item's `root` (a `sourceRootId`) from the parsed data, so you don't need to provide it in `keys`.
- **Color convention**: red (#ff4444) for abnormalities/warnings, green (#44bb44) for normal/benign, yellow (#ffaa00) for follow-up, blue (#4488ff) for reviewed, gray (#888888) for miscellaneous.
- **Batch labeling**: for "label all CT series", first fetch all series via the parsed endpoints, filter by Modality, then `labelAssign` each one.
- **Label distribution**: `POST /labeling/query` with only `root` returns all assignments for a root — aggregate by label name and use `bar_chart` to visualize.
- **Label details persist**: `labelSetDetails` writes to SQLite and survives app restarts.
