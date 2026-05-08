import { openSync, fstatSync, readSync, closeSync } from "node:fs";

export interface TailedLine {
  text: string;
  /** Byte offset of this line's first byte in the file. */
  offset: number;
}

export interface TailResult {
  /** Complete lines (excluding trailing \n) since prevOffset, with their byte offsets. */
  lines: TailedLine[];
  /**
   * Byte offset to persist. Always immediately after the last *complete* line
   * we returned. A trailing partial line (no \n yet) stays for next time.
   */
  newOffset: number;
  inode: number;
  size: number;
  /** True iff rotation/truncation was detected and we re-read from 0. */
  rotated: boolean;
}

/**
 * Read newly-appended bytes from `filePath` starting at `prevOffset` and emit
 * each complete line with its absolute byte offset. A partial trailing line
 * (no terminating \n) stays buffered — newOffset stops before it.
 *
 * Rotation detection: file shrank (truncate) or inode changed → re-read from 0.
 */
export function tailFile(
  filePath: string,
  prevOffset: number,
  prevInode: number | null = null
): TailResult {
  const fd = openSync(filePath, "r");
  try {
    const st = fstatSync(fd);
    const size = st.size;
    const inode = Number(st.ino);

    let from = prevOffset;
    let rotated = false;
    if (size < prevOffset) {
      from = 0;
      rotated = true;
    } else if (prevInode !== null && prevInode !== inode) {
      from = 0;
      rotated = true;
    }

    if (size <= from) {
      return { lines: [], newOffset: from, inode, size, rotated };
    }

    const len = size - from;
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    const slice = buf.subarray(0, read);

    const lines: TailedLine[] = [];
    let lineStart = 0;
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === 0x0a) {
        if (i > lineStart) {
          const text = slice.subarray(lineStart, i).toString("utf8");
          lines.push({ text, offset: from + lineStart });
        }
        lineStart = i + 1;
      }
    }

    // Anything past `lineStart` is a trailing partial line — leave it for next read.
    const newOffset = from + lineStart;
    return { lines, newOffset, inode, size, rotated };
  } finally {
    closeSync(fd);
  }
}
