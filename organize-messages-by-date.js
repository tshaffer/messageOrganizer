#!/usr/bin/env node
/**
 * organize-messages-by-date.js
 *
 * Recursively scans a Messages Attachments folder, reads each media file's
 * actual capture date (from EXIF/QuickTime metadata via exiftool, falling
 * back to the file's filesystem date when no metadata date exists), and
 * copies it into <dest>/<year><month>/<filename> (e.g. 202609/IMG_1234.jpg
 * for a September 2026 photo). Originals are left untouched - this only
 * ever copies, never deletes or moves the source.
 *
 * Setup (once, in whatever folder you keep this script):
 *   npm install exiftool-vendored
 *
 * Usage:
 *   node organize-messages-by-date.js --dry-run   # preview only, copies nothing
 *   node organize-messages-by-date.js             # actually copies files
 *
 * Optional flags:
 *   --source=<path>      default: /Volumes/ShMedia/Archives/Messages/Attachments
 *   --dest=<path>        default: /Volumes/ShMedia/Archives/Messages/ByDate
 *   --concurrency=<n>    how many files to read metadata from in parallel (default 8)
 *
 * Notes:
 *   - "Media files" = common image/video extensions (see MEDIA_EXTENSIONS
 *     below). Everything else under the source folder (PDFs, voice messages,
 *     contact cards, stickers, etc.) is left in place and just counted.
 *   - If two source files would land on the same <year><month>/<filename>,
 *     the live run auto-renames with -1, -2, ... suffixes rather than
 *     overwriting or skipping anything. The dry run reports these up front.
 *   - Video capture dates occasionally come from a UTC timestamp in the
 *     file's metadata rather than local time, which can very rarely push a
 *     video shot right at a year boundary (e.g. Dec 31 late at night) into
 *     the neighboring year. This is a metadata limitation, not a bug in
 *     the script.
 */
 
'use strict';
 
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ExifTool } = require('exiftool-vendored');
 
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.bmp', '.tiff', '.tif', '.webp',
]);
const VIDEO_EXTENSIONS = new Set([
  '.mov', '.mp4', '.m4v', '.avi', '.3gp', '.3g2', '.mpg', '.mpeg',
]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
 
// AppleDouble sidecar files (e.g. "._IMG_1234.heic") and Finder's .DS_Store
// share a real file's name/extension but hold only Finder metadata, not
// actual photo/video content. Never treat these as media.
function isJunkFile(filePath) {
  const name = path.basename(filePath);
  return name.startsWith('._') || name === '.DS_Store';
}
 
function parseArgs(argv) {
  const args = {
    dryRun: false,
    source: '/Volumes/ShMedia/Archives/Messages/Attachments',
    dest: '/Volumes/ShMedia/Archives/Messages/ByDate',
    concurrency: 8,
  };
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '--dry') args.dryRun = true;
    else if (arg.startsWith('--source=')) args.source = arg.slice('--source='.length);
    else if (arg.startsWith('--dest=')) args.dest = arg.slice('--dest='.length);
    else if (arg.startsWith('--concurrency=')) {
      args.concurrency = parseInt(arg.slice('--concurrency='.length), 10) || 8;
    }
  }
  return args;
}
 
async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`Cannot read directory ${dir}: ${err.message}`);
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
    // symlinks are intentionally skipped
  }
  return out;
}
 
// Runs `worker` over `items` with at most `limit` in flight at once.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runNext() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current], current);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) || 1 }, runNext);
  await Promise.all(runners);
  return results;
}
 
// Folder name for a given year/month, e.g. (2026, 9) -> "202609".
function periodFolderName(year, month) {
  return `${year}${String(month).padStart(2, '0')}`;
}
 
async function getDateInfoForFile(exiftool, filePath) {
  try {
    const tags = await exiftool.read(filePath);
    // Prefer the actual capture date. DateTimeOriginal is the standard EXIF
    // field for photos; CreationDate/CreateDate/MediaCreateDate/
    // TrackCreateDate cover various video containers, roughly in order of
    // how likely they are to reflect local capture time rather than UTC.
    const candidate =
      tags.DateTimeOriginal ||
      tags.CreationDate ||
      tags.CreateDate ||
      tags.MediaCreateDate ||
      tags.TrackCreateDate;
    if (candidate && typeof candidate.year === 'number' && typeof candidate.month === 'number') {
      return { year: candidate.year, month: candidate.month, dateSource: 'metadata' };
    }
  } catch (err) {
    // fall through to filesystem date
  }
  try {
    const stat = await fsp.stat(filePath);
    const fsDate = stat.birthtime && stat.birthtime.getTime() > 0 ? stat.birthtime : stat.mtime;
    return {
      year: fsDate.getFullYear(),
      month: fsDate.getMonth() + 1, // Date.getMonth() is 0-based
      dateSource: 'filesystem (no metadata date found)',
    };
  } catch (err) {
    return { year: null, month: null, dateSource: `unreadable: ${err.message}` };
  }
}
 
async function loadExistingNames(destDir) {
  const names = new Set();
  try {
    const entries = await fsp.readdir(destDir);
    for (const name of entries) names.add(name);
  } catch (err) {
    // directory doesn't exist yet - nothing to load
  }
  return names;
}
 
function nextAvailableName(filename, existingNames) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let suffix = 0;
  while (existingNames.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}${ext}`;
  }
  return candidate;
}
 
async function main() {
  const { dryRun, source, dest, concurrency } = parseArgs(process.argv.slice(2));
 
  console.log(`Mode:        ${dryRun ? 'DRY RUN (no files will be copied)' : 'LIVE (files will be copied)'}`);
  console.log(`Source:      ${source}`);
  console.log(`Destination: ${dest}`);
  console.log(`Concurrency: ${concurrency}\n`);
 
  const allFiles = await walk(source);
  console.log(`Found ${allFiles.length} total files under source.`);
 
  const isMedia = (f) => !isJunkFile(f) && MEDIA_EXTENSIONS.has(path.extname(f).toLowerCase());
  const mediaFiles = allFiles.filter(isMedia);
  const nonMediaFiles = allFiles.filter((f) => !isMedia(f));
  const nonMediaCount = nonMediaFiles.length;
  console.log(`${mediaFiles.length} are images/videos; ${nonMediaCount} other files will be left in place.`);
 
  if (nonMediaCount > 0) {
    const previewCount = Math.min(50, nonMediaCount);
    console.log(`\nFirst ${previewCount} non-media file(s) (left in place, not copied):`);
    for (const f of nonMediaFiles.slice(0, previewCount)) console.log(`  ${f}`);
  }
  console.log('');
 
  const exiftool = new ExifTool({
    taskTimeoutMillis: 15000,
    maxProcs: Math.max(1, Math.ceil(concurrency / 2)),
  });
 
  console.log('Reading capture dates (this is the slow part)...');
  let readCount = 0;
  const dated = await mapWithConcurrency(mediaFiles, concurrency, async (filePath) => {
    const result = await getDateInfoForFile(exiftool, filePath);
    readCount += 1;
    if (readCount % 250 === 0) console.log(`  ...read ${readCount}/${mediaFiles.length}`);
    return { filePath, ...result };
  });
 
  await exiftool.end();
 
  const unreadable = dated.filter((d) => d.year === null);
  const usable = dated.filter((d) => d.year !== null);
 
  // Group by intended (pre-suffix) destination path so we can spot
  // duplicate filenames that would land in the same year+month folder.
  const byNaiveDest = new Map(); // naiveDestPath -> [{filePath, dateSource}]
  for (const item of usable) {
    const periodDir = path.join(dest, periodFolderName(item.year, item.month));
    const filename = path.basename(item.filePath);
    const naiveDestPath = path.join(periodDir, filename);
    if (!byNaiveDest.has(naiveDestPath)) byNaiveDest.set(naiveDestPath, []);
    byNaiveDest.get(naiveDestPath).push(item);
  }
  const collisions = [...byNaiveDest.entries()].filter(([, items]) => items.length > 1);
 
  // Check which naive destination names already exist on disk (e.g. from a
  // previous run of this script). Informational only - the live run
  // handles these safely either way by auto-renaming.
  const existingNamesByPeriod = new Map();
  const alreadyOnDisk = [];
  for (const [naiveDestPath, items] of byNaiveDest.entries()) {
    const period = path.basename(path.dirname(naiveDestPath));
    if (!existingNamesByPeriod.has(period)) {
      existingNamesByPeriod.set(period, await loadExistingNames(path.join(dest, period)));
    }
    const names = existingNamesByPeriod.get(period);
    const filename = path.basename(naiveDestPath);
    if (names.has(filename)) {
      alreadyOnDisk.push({ naiveDestPath, items });
    }
  }
 
  let copied = 0;
  let copyErrors = 0;
 
  if (!dryRun) {
    console.log('\nCopying files...');
    for (const [naiveDestPath, items] of byNaiveDest.entries()) {
      const period = path.basename(path.dirname(naiveDestPath));
      const periodDir = path.join(dest, period);
      await fsp.mkdir(periodDir, { recursive: true });
      const names = existingNamesByPeriod.get(period); // already loaded above
 
      for (const { filePath } of items) {
        const filename = path.basename(filePath);
        const finalName = nextAvailableName(filename, names);
        names.add(finalName);
        const destPath = path.join(periodDir, finalName);
        try {
          await fsp.copyFile(filePath, destPath, fs.constants.COPYFILE_EXCL);
          copied += 1;
        } catch (err) {
          console.error(`ERROR copying ${filePath} -> ${destPath}: ${err.message}`);
          copyErrors += 1;
        }
      }
    }
  }
 
  console.log('\n--- Summary ---');
  console.log(`Media files found:          ${mediaFiles.length}`);
  console.log(`Non-media files left alone: ${nonMediaCount}`);
  console.log(`Unreadable (skipped):       ${unreadable.length}`);
  if (dryRun) {
    console.log(`Would copy:                 ${usable.length}`);
  } else {
    console.log(`Copied:                     ${copied}`);
    console.log(`Copy errors:                ${copyErrors}`);
  }
  console.log(`Duplicate filenames within this run (same year+month folder + same name): ${collisions.length}`);
  console.log(`Filenames already present in the destination (e.g. prior run): ${alreadyOnDisk.length}`);
 
  if (unreadable.length > 0) {
    console.log('\nUnreadable files (no metadata date AND no usable filesystem date):');
    for (const item of unreadable) console.log(`  ${item.filePath} - ${item.dateSource}`);
  }
 
  if (collisions.length > 0) {
    console.log(
      dryRun
        ? '\nDuplicate destination filenames (the live run will auto-rename these with -1, -2, ... suffixes):'
        : '\nDuplicate destination filenames (auto-renamed with -1, -2, ... suffixes during copy):'
    );
    for (const [naiveDestPath, items] of collisions) {
      console.log(`\n  ${naiveDestPath}`);
      for (const { filePath, dateSource } of items) {
        console.log(`    <- ${filePath}  (date from ${dateSource})`);
      }
    }
  }
 
  if (alreadyOnDisk.length > 0) {
    console.log('\nFilenames that already exist in the destination folder (likely from a previous run):');
    for (const { naiveDestPath, items } of alreadyOnDisk) {
      console.log(`  ${naiveDestPath}  (${items.length} source file(s) this run)`);
    }
  }
}
 
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
 