---
name: pmt-frontend-bridge
description: Read live state from the host application's frontend (parsed patients/studies/series/instances) and dispatch whitelisted UI commands back to it via the PMT Frontend Bridge.
---

# PMT Frontend Bridge

This skill lets you interact with the host application's frontend while it is running. Use it when the user asks about:

- Statistics or summaries of what they have parsed/loaded (patient/study/series/instance counts, modality breakdown, etc.)
- Listing patients, studies, or series currently visible in the viewer
- Reading the embedded VolView viewer's parent-mirrored state (mounted status, active view/data IDs, latest slicing event, current image/slice metadata)
- Performing UI actions on their behalf (open something in the embedded viewer, expand/collapse the tree, reveal a file in the OS file manager)

## Terminology

When the user says "viewer", "image viewer", "DICOM viewer", "current image", "current slice", "active pane", or "main viewer pane", treat that as the embedded VolView context unless they clearly mean a separate standalone window or the patient tree.

## Authoritative source — do not read project files

**For any question about the user's loaded / parsed data (patients, studies, series, instances, modalities, file paths in the viewer, what is currently selected, what is expanded, etc.), the Frontend Bridge HTTP API is the ONLY source of truth.**

Concretely:

- **Do not** `view`, `grep`, or `glob` source files in the working directory to answer such questions. Files like `app/stores/parsing.ts`, `app/components/TreePatients.vue`, `server/index.ts`, `server/frontend-bridge.ts`, etc. describe the *implementation* of the viewer, not the user's live data. Reading them will not tell you how many patients are loaded.
- **Do not** guess patient/study/series keys, file paths, or counts. Always fetch them from the bridge first.
- If `FRONTEND_BRIDGE_URL` is unset (e.g. the viewer is not running), say so plainly instead of falling back to source-code inspection.

The only legitimate reason to read project source files in the same conversation is if the user explicitly asks a code/development question unrelated to their loaded data.

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

## Read endpoints (GET)

All return JSON.

| Endpoint | Description |
|---|---|
| `/api/frontend/health` | Liveness probe. |
| `/api/frontend/volview/summary` | Embedded VolView parent-mirrored state: `{ mounted, activeViewID, activeViewDataID, activeViewDataIDByView, lastSlicing, lastSlicingAt, loadingUIDs }`. Use this before answering questions about the current active VolView pane/slice. |
| `/api/frontend/volview/current` | Detailed active VolView context. Includes the summary fields plus `state`, where `state.activeView`, `state.views`, `state.layout`, `state.currentImage.metadata`, `state.currentSlice.config`, `state.currentSlice.metadata`, `state.currentSlice.dicomTags`, and `state.windowLevel` describe the current viewer pane/image/slice. Use this when the user asks what image/slice/view is currently loaded, needs current image dimensions/spacing/orientation, asks for DICOM tags from the current slice, asks about current window/level, or asks about layout/active pane. `dicomTags` is `null` for non-DICOM data. |
| `/api/frontend/volview/snapshot` | On-demand active VolView pane snapshot. Returns the active pane context plus `image` as a cropped PNG data URL, `currentSlicePixels` as compact scalar statistics/histogram for 2D views, and optionally `currentSlicePixelGrid` as downsampled scalar rows. Query options: `includeImage=false`, `includeHistogram=false`, `includePixels=true`, `maxWidth=768`, `maxHeight=768`, `bins=64`, `pixelWidth=64`, `pixelHeight=64`. Pixel grids are clamped to 128x128. Use this for visual/screenshot-style prompts, histogram/pixel-summary prompts, or bounded raw-scalar inspection. Do not print the full `image.dataURL` in chat unless explicitly needed; summarize it or omit it with `jq 'del(.image.dataURL)'`. |
| `POST /api/frontend/volview/roi` | On-demand scalar sampling for a rectangle, polygon, or circle/ellipse on the active 2D VolView slice. Body can be `{ "roi": { "type": "rectangle", "x": 120, "y": 80, "width": 64, "height": 48 } }`, `{ "roi": { "type": "polygon", "points": [[120,80],[180,90],[160,140]] } }`, or `{ "roi": { "type": "circle", "cx": 160, "cy": 110, "radius": 32 } }`. Coordinates are zero-based current-slice image-plane indices, not screen pixels. The response includes `currentSliceRoi.roi` in index-pixel units, `currentSliceRoi.measurements` in VolView physical/world units, `measurementUnits`, `valueRange`, source image dimensions, plane axes, ROI bounds, histogram, and sampling metadata. Optional body/query fields: `includePixels=true`, `pixelWidth=32`, `pixelHeight=32`, `bins=64`, `maxSamples=262144`, `component=0`. ROI pixel grids are clamped to 128x128 and use `null` outside polygon or ellipse masks. |
| `POST /api/frontend/volview/annotation` | Manage VolView-native overlays on the active 2D pane. Body: `{ "action": "create|update|delete|list", ... }`. Supports `type`: `ruler`, `rectangle`, `circle`, `polygon`. `create` / `update` accept `annotation` geometry in zero-based current-slice image-plane index coordinates, not screen pixels and not millimeters. `delete` uses `annotationId`. `list` returns current-image annotations. Responses include annotation `id`, `imagePlane.geometry` in index-pixel units, `measurements` in VolView physical/world units, and `measurementUnits`. Do not describe `measurements.width` / `measurements.height` as image-plane units; for a DICOM image with spacing, a rectangle created with `width:64,height:48` index pixels may display as smaller/larger physical mm dimensions in VolView. |
| `POST /api/frontend/volview/segmentation` | Manage VolView-native segment groups and apply a bounded mask to the active 2D slice. Use this only for current-slice masks, not whole-volume masks. `action:"list"` returns segment groups for the current image. `action:"applyMask"` accepts either `{ "roi": { ... }, "threshold": { "min": 100, "max": 300 } }`, `{ "roi": { ... }, "threshold": { "mode": "above", "value": "mean" } }`, `{ "mask": { "x": 120, "y": 80, "rows": [[1,0,1], ...] } }`, or `{ "mask": { "x": 120, "y": 80, "width": 16, "height": 16, "values": [1,0,...] } }`. Coordinates are zero-based current-slice image-plane indices. Threshold values can be numbers or ROI/mask statistics: `mean`, `median`, `min`, `max`, `p25`, `p75`, or `pNN`. Threshold modes: `above`, `below`, `between` (default), and `outside`; optional `delta` shifts the statistic. Optional `seed:{x,y}` with `connectivity:4|8` keeps only the connected component containing the seed after thresholding. Optional fields: `segmentGroupId`, `segmentGroupName`/`groupName`, `newSegmentGroup`, `reuseSegmentGroup`, `segmentValue` 1-255, `segment:{name,color,visible,locked}`, `mode:"add|replace|erase"`, `overwriteExisting`, `maxPixels=262144`, `component=0`. If `segmentGroupId` is omitted for a new add/replace/create/update request, the bridge creates a fresh segment group by default so overlapping AI-generated masks can be toggled independently; that fresh group uses `segment.name` as its display name unless `groupName`/`segmentGroupName` is provided. To add another segment to an existing group, pass `segmentGroupId` or `reuseSegmentGroup:true`. If `segmentValue` is omitted inside a target group, the bridge allocates the next unused segment value. Existing non-background labels are preserved unless `overwriteExisting:true` is sent. The bridge rejects masks over `maxPixels` rather than downsampling. Responses include `segmentationSemantics.version`, `createdSegmentGroup`, segment group metadata, segment metadata, current-slice mask bounds, threshold stats, connected-component counts, skip counts, and plane axes. |
| `POST /api/frontend/volview/volume` | Bounded whole-volume scalar access. This endpoint is metadata/chunk oriented and never returns an unbounded volume by default. `action:"info"` returns dimensions, spacing, origin, direction, scalar type, component count, raw byte estimate, and chunk limits. `action:"chunk"` returns an explicit IJK source window only: `{ "origin": [i,j,k], "size": [width,height,depth], "stride": [si,sj,sk] }`. `size` is the source-window size before stride, not the number of returned samples. The response includes `chunk.sourceRange`, `chunk.sampledRange`, `chunk.sampleSize`, and `chunk.sampleVoxels`; use those response fields when reporting ranges. Values are flattened `x-fastest-then-y-then-z`. Optional fields: `component=0`, `bins=64`, `includeValues=false` for stats-only, `maxVoxels=262144` (max 1048576), `maxBytes=4194304` (max 16777216). `action:"scan"` performs stats-only analysis over a bounded source window or the whole volume by iterating internally bounded chunks; it returns `valueRange`, `histogram`, optional `thresholdCounts`, and optional `sliceSummaries`, never raw scalar values. Scan options: `origin`, `size`, `stride`, `bins=64`, `threshold:{min,max}`, `thresholds:[{name,min,max}]`, strict operators `gt`/`lt`, inclusive operators `gte`/`lte`, `includeSlices`, `maxSliceSummaries=512`, `maxScanVoxels=50000000`, `maxChunkVoxels=262144`, `maxChunkBytes=4194304`. The bridge rejects chunks/scans over caps; increase stride or narrow the source window instead of asking for unbounded raw values. |
| `/api/frontend/parsed/summary` | `{ patientCount, studyCount, seriesCount, instanceCount, modalityCounts, isParsing }`. **Start here** for "how many / what kinds" questions. |
| `/api/frontend/parsed/patients` | List of patients with `key`, `PatientName`, `PatientID`, `root`, `studyCount`. |
| `/api/frontend/parsed/patients/{patientKey}/studies` | Studies under a patient. |
| `/api/frontend/parsed/patients/{patientKey}/studies/{studyKey}/series` | Series under a study. |
| `/api/frontend/parsed/patients/{patientKey}/studies/{studyKey}/series/{seriesKey}/instances` | **Instances under a series, pre-sorted by `InstanceNumber`.** Returns `{ count, instances, first, last }`. **Use this for any "first / last / Nth instance" question** — do not try to derive ordering from `/state` object keys. |
| `/api/frontend/state` | Full mirror of relevant Pinia state. Larger; only fetch when summaries aren't enough. |
| `/api/frontend/ui/commands` | Lists allowed UI command names. |

`patientKey`, `studyKey`, and `seriesKey` are URL-encoded — pass them with `--data-urlencode` or pre-encode them yourself.

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

# studies for a specific patient (encode the key!)
PATIENT="John^Doe"
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  --get --data-urlencode "" \
  "$FRONTEND_BRIDGE_URL/api/frontend/parsed/patients/$(printf %s "$PATIENT" | jq -sRr @uri)/studies"
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

Allowed commands (current whitelist):

| command | payload | effect |
|---|---|---|
| `selectInstance` | `{ "keys": [patient, study, series, instance] }` | **Render this instance in the main app window** (the embedded viewer). Internally: expands ancestor rows in the patient/study/series tree if they are collapsed, then marks this instance as the recently-clicked thumbnail — which causes the main window's viewer pane to load that series at the chosen slice. This is the in-app "highlight / view this slice" action. |
| `openInVolView` | `{ "keys": ["patientKey", "studyKey?", "seriesKey?", "instanceKey?"] }` | Opens the (deepest resolvable) instance in a **separate, standalone viewer window**. If `keys` ends at a series/study/patient, the first instance underneath is opened. The `newWindow` flag is implicit — do not send it. |
| `expand` | `{ "keys": [...] }` | Expand the patient/study/series at this path in the tree (without highlighting anything). |
| `collapse` | `{ "keys": [...] }` | Collapse it. |
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
| `showInFolder` | `{ "keys": [...] }` **(preferred)** or `{ "path": "/abs/path" }` | Reveal in OS file manager. **Always prefer `keys`** — the bridge resolves the real path from the authoritative store. Only fall back to `path` if you have a path that is not in the parsed data; even then, copy it verbatim from a previous bridge response, never retype it (CJK / lookalike characters can silently break `path`). |

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
| "describe what is visible" / "capture the current viewer" | `GET /api/frontend/volview/snapshot`; use `image.dataURL` as the image input if the runtime supports image attachments, otherwise summarize available metadata and pixel statistics. |
| "return the image" / "show the image" / "render a preview" | `GET /api/frontend/volview/snapshot`; save the completed `image.dataURL` to a safe temp PNG file, URL-encode the local path, then return `![volview-preview](h3://localhost/file/<already-url-encoded-local-file-path>)`. Never stream the base64 data URL in Markdown. |
| "summarize the current slice histogram" / "what is the intensity range" | `GET /api/frontend/volview/snapshot?includeImage=false&bins=64` |
| "sample the current slice pixels" / "show a downsampled pixel grid" | `GET /api/frontend/volview/snapshot?includeImage=false&includePixels=true&pixelWidth=32&pixelHeight=32`; summarize patterns and avoid dumping all rows unless the user asks. |
| "measure intensities in this rectangle/polygon/circle/ROI" / "sample this region" | `POST /api/frontend/volview/roi` with rectangle, polygon, or circle/ellipse image-plane coordinates. Read `/api/frontend/volview/current` or use a snapshot first to establish current slice dimensions; do not treat screenshot/screen pixels as ROI coordinates unless you have explicitly mapped them to image-plane indices. Prefer `currentSliceRoi.measurements` when comparing with VolView's visible annotation labels (`Mean`, `Median`, `SDev`, `Sum`, `Max`, `Min`, `P`, `Area`, `W`, `H`). |
| "draw/add/create annotation overlay" / "move/update/delete this measurement" | `POST /api/frontend/volview/annotation` with `action` = `create`, `update`, `delete`, or `list`. Use `type` `ruler|rectangle|circle|polygon` for create; keep coordinates in current-slice image-plane indices. |
| "jump to series Z" / "view series Z" | `selectInstance` (keys end at series) |
| "open this in a new window" | `openInVolView` |
| "open this file" / "open the source file…" | `openInVolView` |
| "pop out / detach this series" | `openInVolView` |

### Example

```sh
curl -s -H "Authorization: Bearer $FRONTEND_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"command":"collapseAll"}' \
  "$FRONTEND_BRIDGE_URL/api/frontend/ui/dispatch"
```

## Guidelines

- **Always start with a small read** (e.g. `/parsed/summary` or `/parsed/patients`) before dispatching UI commands, so you act on real keys rather than guessed ones.
- **Confirm before destructive or disruptive UI actions** (e.g. opening many windows, collapsing everything when the user is in the middle of a task). For purely informational reads, no confirmation is needed.
- **Do not invent commands.** Only the names listed above are accepted; anything else returns 400.
- **Treat `FRONTEND_BRIDGE_TOKEN` as a secret.** Don't echo it back to the user, don't write it to logs, and don't include it in tool output.

## Visualizing parsed data — chart selection

When the user asks to chart, plot, visualize, or graph statistics about their loaded data and they do **not** explicitly name a chart type, choose the tool by the **shape of the data**, not by what looks prettiest:

| Data shape | Use the tool | Typical prompts |
|---|---|---|
| Counts / sums / averages across **discrete independent categories** (modality, patient, study, file type) | `bar_chart` | "instances per modality", "files per patient", "series count by study", "modality distribution" (default) |
| **Proportions** of a single whole, **at most 6–7 slices**, values truly sum to a meaningful total | `donut_chart` (set `variant:"pie"` for a solid pie) | "share of modalities in this study", "patient gender split", "% of files by extension" |
| **Trends** over an **ordered numeric / time axis** (SeriesNumber, InstanceNumber, dates) | `chart` (line) | "image count by SeriesNumber", "studies over time", "value of `<tag>` across instances" |
| **Cumulative totals or composition** over an ordered axis, especially when stacking multiple series whose sum is meaningful | `area_chart` | "cumulative file count by modality over time", "stacked instances per modality across studies" |

Rules of thumb:

- For **"distribution of X"** with **categorical X**, default to `bar_chart`. Only use `donut_chart` if the user explicitly asks for a "pie", "donut", "share", or "proportion" **and** there are ≤ 6–7 categories. When the user says "pie chart", set `variant:"pie"`; when they say "donut"/"doughnut"/"ring", set `variant:"donut"` (or omit, since donut is the default).
- The modality count list (`modalityCounts` from `/parsed/summary`) is **categorical** → `bar_chart` by default.
- If the user explicitly names a chart type ("plot a pie chart of …", "show me a bar chart of …"), honor it without second-guessing.
- Never use `chart` (line) for purely categorical x-axes — interpolating a line between unrelated category labels is misleading.
- Always source the numbers from the bridge endpoints (e.g. `/parsed/summary`, `/parsed/patients/.../series`); do not make up values.
