/**
 * Terminal escape codes (CSI colors/erase, OSC titles) that a non-TTY child
 * still emits. Stripped before output reaches job logs, which render text only.
 */
const ANSI_PATTERN =
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export interface ProgressWriter {
  push(chunk: string): void;
  flush(): void;
}

/**
 * The label of a percentage progress line, e.g. `remote: Counting objects:` in
 * `remote: Counting objects:  42% (5/12)`. Used to detect consecutive frames of
 * the same phase so only the last one is kept.
 */
function progressKey(line: string): string | null {
  const match = /^(.*?)\s*\d{1,3}%/.exec(line);
  if (!match) return null;
  const prefix = (match[1] ?? '').trim();
  return prefix === '' ? null : prefix;
}

/**
 * Turn a raw subprocess stream into clean log lines.
 *
 * Two kinds of noise are collapsed:
 *  - Spinners (clack-style) redraw one line with bare `\r` plus ANSI erase
 *    codes; `JobRegistry.append` splits on `\r`, turning each frame into its own
 *    garbled line. Only the final frame of a logical line survives.
 *  - Blocking git emits each progress frame as its own `\r\n` line (non-TTY),
 *    so `remote: Counting objects: 12%` … `100%, done.` arrive as many lines.
 *    Consecutive percentage lines for the same phase collapse to the last one.
 *
 * ANSI is stripped, blank lines are dropped, and partial lines are buffered
 * across chunks; call `flush` once the stream ends.
 */
export function createProgressWriter(emit: (line: string) => void): ProgressWriter {
  let current = '';
  let holdCr = false;
  let pending: { key: string; line: string } | null = null;

  const finalFrame = (segment: string): string => {
    const body = segment.endsWith('\r') ? segment.slice(0, -1) : segment;
    const idx = body.lastIndexOf('\r');
    return idx === -1 ? body : body.slice(idx + 1);
  };

  const flushPending = (): void => {
    if (pending) {
      emit(pending.line);
      pending = null;
    }
  };

  const emitLine = (line: string): void => {
    const clean = stripAnsi(line).replace(/[ \t]+$/, '');
    if (clean.trim() === '') return;
    const key = progressKey(clean);
    if (key === null) {
      flushPending();
      emit(clean);
      return;
    }
    if (pending && pending.key === key) pending.line = clean;
    else {
      flushPending();
      pending = { key, line: clean };
    }
  };

  return {
    push(chunk: string): void {
      let text = chunk;
      // A chunk may split a CRLF pair; hold a trailing \r for the next chunk.
      if (holdCr) {
        text = `\r${text}`;
        holdCr = false;
      }
      if (text.endsWith('\r')) {
        holdCr = true;
        text = text.slice(0, -1);
      }
      const parts = text.split('\n');
      const tail = parts.pop() ?? '';
      for (let i = 0; i < parts.length; i += 1) {
        const merged = i === 0 ? current + (parts[i] ?? '') : (parts[i] ?? '');
        emitLine(finalFrame(merged));
        current = '';
      }
      const idx = tail.lastIndexOf('\r');
      if (idx === -1) current += tail;
      else current = tail.slice(idx + 1);
    },
    flush(): void {
      if (current !== '') emitLine(current);
      current = '';
      holdCr = false;
      flushPending();
    },
  };
}
