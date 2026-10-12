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
 * Turn a raw subprocess stream into clean log lines.
 *
 * Progress spinners (clack-style) redraw a single line with bare `\r` plus ANSI
 * erase codes; `JobRegistry.append` splits on `\r`, which would turn every frame
 * into its own garbled log line. This collapses each logical line to its final
 * frame, strips ANSI, and emits only non-blank lines. `\r\n` is a real newline.
 *
 * Partial lines are buffered across chunks; call `flush` once the stream ends.
 */
export function createProgressWriter(emit: (line: string) => void): ProgressWriter {
  let current = '';
  let holdCr = false;

  const finalFrame = (segment: string): string => {
    const body = segment.endsWith('\r') ? segment.slice(0, -1) : segment;
    const idx = body.lastIndexOf('\r');
    return idx === -1 ? body : body.slice(idx + 1);
  };

  const emitLine = (line: string): void => {
    const clean = stripAnsi(line).replace(/[ \t]+$/, '');
    if (clean.trim() !== '') emit(clean);
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
    },
  };
}
