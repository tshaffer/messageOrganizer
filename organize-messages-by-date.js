#!/usr/bin/env node
/**
 * organize-messages-by-date.js
 *
 * Recursively scans a Messages Attachments folder, reads each media file's
 * actual capture date (from EXIF/QuickTime metadata via exiftool, falling
 * back to the file's filesystem date when no metadata date exists), and
 * copies it into <dest>/<year>/<filename> (e.g. 2026/IMG_1234.jpg for a
 * 2026 photo). Originals are left untouched - this only ever copies,
 * never deletes or moves the source.
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
 *   --concurrency=<n>    how many files to read metadata/hashes from in
 *                        parallel (default 8)
 *
 * Notes:
 *   - "Media files" = common image/video extensions (see MEDIA_EXTENSIONS
 *     below). Everything else under the source folder (PDFs, voice messages,
 *     contact cards, stickers, etc.) is left in place and just counted.
 *   - AppleDouble sidecar files (e.g. "._IMG_1234.heic") and .DS_Store are
 *     never treated as media, even though they can share a real file's
 *     name/extension.
 *   - Files that are byte-for-byte identical to another source file (e.g.
 *     the same photo attached in two different conversations) are only
 *     copied once. The extra copies are skipped and listed in the summary
 *     under "Duplicate content" - never renamed, never copied twice.
 *   - Safe to re-run: before copying, each file's content hash is also
 *     checked against whatever already exists in that year's destination
 *     folder. Anything already archived (by content, not just by name) is
 *     skipped and listed under "Already archived" - re-running never
 *     creates redundant copies of something already there.
 *   - If two DIFFERENT files (different content) would still land on the
 *     same <year>/<filename>, the live run auto-renames with -1, -2, ...
 *     suffixes rather than overwriting or skipping anything. The dry run
 *     reports these separately, under "Duplicate filenames".
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
const crypto = require('crypto');
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

// Folder name for a given year, e.g. 2026 -> "2026".
function yearFolderName(year) {
  return `${year}`;
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

// SHA-256 of a file's raw bytes, used to detect byte-for-byte duplicates
// (e.g. the same photo attached in two different conversations, or a file
// that was already copied to the destination in a previous run).
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Reads a destination year-folder's current contents: the set of filenames
// already there (for name-collision avoidance) and a hash->filename map of
// their content (for detecting "this exact file is already archived").
async function loadExistingDestInfo(destDir, concurrency) {
  const names = new Set();
  const hashes = new Map(); // content hash -> existing filename
  let entries;
  try {
    entries = await fsp.readdir(destDir, { withFileTypes: true });
  } catch (err) {
    return { names, hashes }; // directory doesn't exist yet - nothing to load
  }
  const files = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      names.add(entry.name);
      files.push(entry.name);
    }
  }
  await mapWithConcurrency(files, concurrency, async (name) => {
    try {
      const hash = await hashFile(path.join(destDir, name));
      hashes.set(hash, name);
    } catch (err) {
      // unreadable existing file - it just won't match anything by hash
    }
  });
  return { names, hashes };
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

  console.log('');

  const exiftool = new ExifTool({
    taskTimeoutMillis: 15000,
    maxProcs: Math.max(1, Math.ceil(concurrency / 2)),
  });

  console.log('Reading capture dates and content hashes (this is the slow part)...');
  let readCount = 0;
  const dated = await mapWithConcurrency(mediaFiles, concurrency, async (filePath) => {
    const [dateInfo, hash] = await Promise.all([
      getDateInfoForFile(exiftool, filePath),
      hashFile(filePath).catch(() => null),
    ]);
    readCount += 1;
    if (readCount % 250 === 0) console.log(`  ...read ${readCount}/${mediaFiles.length}`);
    return { filePath, hash, ...dateInfo };
  });

  await exiftool.end();

  const unreadable = dated.filter((d) => d.year === null);
  const usable = dated.filter((d) => d.year !== null);

  // Content-based de-duplication among THIS RUN's source files: if two
  // source files are byte-for-byte identical (e.g. the same photo attached
  // in two different conversations), only one copy is placed in the
  // destination. The copy with the alphabetically first source path is
  // kept, for a deterministic result across dry-run and live-run; the rest
  // are skipped and reported, never copied and never auto-renamed.
  const byHash = new Map(); // hash -> [items]
  const noHash = []; // hashing failed - treat as unique, never skipped
  for (const item of usable) {
    if (!item.hash) {
      noHash.push(item);
      continue;
    }
    if (!byHash.has(item.hash)) byHash.set(item.hash, []);
    byHash.get(item.hash).push(item);
  }

  const toPlace = [...noHash];
  const duplicateGroups = []; // [{ kept, skipped: [...] }]
  for (const items of byHash.values()) {
    if (items.length === 1) {
      toPlace.push(items[0]);
      continue;
    }
    const sorted = [...items].sort((a, b) => (a.filePath < b.filePath ? -1 : 1));
    const [kept, ...skipped] = sorted;
    toPlace.push(kept);
    duplicateGroups.push({ kept, skipped });
  }
  const duplicatesSkippedCount = duplicateGroups.reduce((n, g) => n + g.skipped.length, 0);

  // Load each destination year folder that's actually relevant this run
  // (both its filenames, for collision avoidance, and its files' content
  // hashes, so a file already archived from a previous run is recognized
  // and skipped rather than re-copied or redundantly renamed).
  console.log('Checking destination folder(s) for existing content...');
  const yearsInvolved = [...new Set(toPlace.map((item) => yearFolderName(item.year)))];
  const destInfoByYear = new Map();
  for (const year of yearsInvolved) {
    destInfoByYear.set(year, await loadExistingDestInfo(path.join(dest, year), concurrency));
  }

  const alreadyArchived = []; // [{ item, existingName }]
  const toCopy = [];
  for (const item of toPlace) {
    const info = destInfoByYear.get(yearFolderName(item.year));
    if (item.hash && info.hashes.has(item.hash)) {
      alreadyArchived.push({ item, existingName: info.hashes.get(item.hash) });
    } else {
      toCopy.push(item);
    }
  }

  // Group by intended (pre-suffix) destination path so we can spot
  // duplicate FILENAMES that would land in the same year folder.
  // Content-identical duplicates (this run and already-archived) were
  // already removed above, so any collision found here is two DIFFERENT
  // files that just happen to share a name.
  const byNaiveDest = new Map(); // naiveDestPath -> [{filePath, dateSource}]
  for (const item of toCopy) {
    const yearDir = path.join(dest, yearFolderName(item.year));
    const filename = path.basename(item.filePath);
    const naiveDestPath = path.join(yearDir, filename);
    if (!byNaiveDest.has(naiveDestPath)) byNaiveDest.set(naiveDestPath, []);
    byNaiveDest.get(naiveDestPath).push(item);
  }
  const collisions = [...byNaiveDest.entries()].filter(([, items]) => items.length > 1);

  let copied = 0;
  let copyErrors = 0;

  if (!dryRun) {
    console.log('\nCopying files...');
    for (const [naiveDestPath, items] of byNaiveDest.entries()) {
      const year = path.basename(path.dirname(naiveDestPath));
      const yearDir = path.join(dest, year);
      await fsp.mkdir(yearDir, { recursive: true });
      const names = destInfoByYear.get(year).names; // already loaded above

      for (const { filePath } of items) {
        const filename = path.basename(filePath);
        let finalName = nextAvailableName(filename, names);
        // Defense in depth: even if our in-memory view of the destination
        // is somehow stale, never overwrite - keep trying the next suffix
        // until the filesystem itself confirms a free name.
        for (let attempt = 0; ; attempt++) {
          const destPath = path.join(yearDir, finalName);
          try {
            await fsp.copyFile(filePath, destPath, fs.constants.COPYFILE_EXCL);
            names.add(finalName);
            copied += 1;
            break;
          } catch (err) {
            if (err.code === 'EEXIST' && attempt < 1000) {
              names.add(finalName);
              finalName = nextAvailableName(filename, names);
              continue;
            }
            console.error(`ERROR copying ${filePath} -> ${destPath}: ${err.message}`);
            copyErrors += 1;
            break;
          }
        }
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Media files found:              ${mediaFiles.length}`);
  console.log(`Non-media files left alone:     ${nonMediaCount}`);
  console.log(`Unreadable (skipped):           ${unreadable.length}`);
  console.log(`Duplicate content found:        ${duplicateGroups.length} group(s), ${duplicatesSkippedCount} file(s) skipped`);
  console.log(`Already archived (prior run):   ${alreadyArchived.length} file(s) skipped`);
  if (dryRun) {
    console.log(`Would copy:                     ${toCopy.length}`);
  } else {
    console.log(`Copied:                         ${copied}`);
    console.log(`Copy errors:                    ${copyErrors}`);
  }
  console.log(`Duplicate filenames, different content: ${collisions.length}`);

  if (unreadable.length > 0) {
    console.log('\nUnreadable files (no metadata date AND no usable filesystem date):');
    for (const item of unreadable) console.log(`  ${item.filePath} - ${item.dateSource}`);
  }

  if (duplicateGroups.length > 0) {
    console.log('\nDuplicate content within this run (identical file kept once; the rest are skipped, not copied):');
    for (const { kept, skipped } of duplicateGroups) {
      console.log(`\n  KEEP: ${kept.filePath}`);
      for (const s of skipped) console.log(`  SKIP: ${s.filePath}`);
    }
  }

  if (alreadyArchived.length > 0) {
    console.log('\nAlready archived (same content already exists in the destination - skipped, not re-copied):');
    for (const { item, existingName } of alreadyArchived) {
      console.log(`  ${item.filePath}`);
      console.log(`    already present as: ${path.join(dest, yearFolderName(item.year), existingName)}`);
    }
  }

  if (collisions.length > 0) {
    console.log(
      dryRun
        ? '\nDuplicate destination filenames, different content (the live run will auto-rename these with -1, -2, ... suffixes):'
        : '\nDuplicate destination filenames, different content (auto-renamed with -1, -2, ... suffixes during copy):'
    );
    for (const [naiveDestPath, items] of collisions) {
      console.log(`\n  ${naiveDestPath}`);
      for (const { filePath, dateSource } of items) {
        console.log(`    <- ${filePath}  (date from ${dateSource})`);
      }
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
