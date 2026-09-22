Went with the recommended option for all three: capture-date metadata (with filesystem-date fallback), images/videos only, and auto-rename on collision. Here's the script.

**One-time setup:**
```bash
cd wherever_you_save_this_script
npm install exiftool-vendored
```
That pulls in its own `exiftool` binary automatically — nothing else to install.

**Usage:**
```bash
node organize-messages-by-date.js --dry-run   # preview, copies nothing
node organize-messages-by-date.js             # actually copies
```
Both default to your paths (`.../Attachments` as source, `.../ByDate` as destination) — override with `--source=` / `--dest=` if needed.

How it works: it walks every subfolder under `Attachments`, and for each image/video reads the actual capture date from EXIF (photos) or QuickTime metadata (videos) via exiftool, falling back to the file's filesystem date only if no metadata date exists. Files land at `ByDate/<year>/<original filename>`. Originals are never touched — this only copies. Non-media attachments (PDFs, voice messages, stickers, etc.) are left alone and just counted in the summary, not copied.

The dry run reports two things before you commit to anything: any source files that would collide on the same `<year>/<filename>` (Messages attachment names can repeat across conversations), and any filenames that already exist in the destination from an earlier run. Neither case will ever overwrite anything in the live run — collisions get auto-suffixed (`-1`, `-2`, ...).

One caveat worth knowing: video capture dates in metadata are occasionally stored in UTC rather than local time, which can very rarely push a video shot late on Dec 31 into the following year's folder — a quirk of the metadata itself, not something the script can fully correct for.

Run the dry run first and skim the collision/summary output before doing the real copy.