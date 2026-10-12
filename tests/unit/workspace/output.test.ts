import { describe, expect, it } from 'vitest';
import { createProgressWriter, stripAnsi } from '../../../src/workspace/output';

describe('stripAnsi', () => {
  it('removes CSI color and erase sequences', () => {
    expect(stripAnsi('\x1b[2m|\x1b[0m  \x1b[32m*\x1b[0m Scanning')).toBe('|  * Scanning');
    expect(stripAnsi('a\x1b[Kb')).toBe('ab');
    expect(stripAnsi('\x1b[38;2;243;183;34m\x1b[1m.\x1b[0m')).toBe('.');
  });

  it('removes OSC titles and cursor visibility controls', () => {
    expect(stripAnsi('\x1b]0;title\x07done')).toBe('done');
    expect(stripAnsi('\x1b[?25lbusy\x1b[?25h')).toBe('busy');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('hello 世界')).toBe('hello 世界');
  });
});

describe('createProgressWriter', () => {
  function collect(): { lines: string[]; push: (chunk: string) => void; flush: () => void } {
    const lines: string[] = [];
    const writer = createProgressWriter((line) => lines.push(line));
    return { lines, push: writer.push, flush: writer.flush };
  }

  it('collapses carriage-return redraws to the final frame and strips ANSI', () => {
    const { lines, push, flush } = collect();
    push('\x1b[2m|\x1b[0m Scanning\r\x1b[KParsing 50%\r\x1b[KParsing 100%\n');
    flush();
    expect(lines).toEqual(['Parsing 100%']);
  });

  it('treats CRLF as a real newline and keeps the line', () => {
    const { lines, push, flush } = collect();
    push('first\r\nsecond\r\n');
    flush();
    expect(lines).toEqual(['first', 'second']);
  });

  it('buffers a partial line across chunks', () => {
    const { lines, push, flush } = collect();
    push('hel');
    push('lo\nworld');
    flush();
    expect(lines).toEqual(['hello', 'world']);
  });

  it('drops blank and whitespace-only lines', () => {
    const { lines, push, flush } = collect();
    push('a\n\n   \n\t\nb\n');
    flush();
    expect(lines).toEqual(['a', 'b']);
  });

  it('discards a frame that a later chunk overwrites', () => {
    const { lines, push, flush } = collect();
    push('scanning');
    push('\rdone\n');
    flush();
    expect(lines).toEqual(['done']);
  });

  it('sanitizes the real init stream into readable lines', () => {
    const { lines, push, flush } = collect();
    push('┌  Initializing CodeGraph\n│\n◆  Initialized in D:\\test\\e-archives\n');
    push('\x1b[2m|\x1b[0m\n');
    push('\r\x1b[K\x1b[2m|\x1b[0m  \x1b[32m*\x1b[0m Scanning files - 5481 found\n');
    push(
      '\r\x1b[K\x1b[2m|\x1b[0m  \x1b[38;2;243;183;34m\x1b[1m.\x1b[0m Parsing code  0%' +
        '\r\x1b[K\x1b[2m|\x1b[0m  \x1b[251;191;36m\x1b[1m*\x1b[0m Parsing code  100%\n',
    );
    push('\r\x1b[K\x1b[2m|\x1b[0m  \x1b[32m*\x1b[0m Resolving refs - done\n');
    push('│\n◆  Indexed 2 files\n│\n●  4 nodes, 4 edges in 957ms\n│\n└  Done\n\n');
    flush();
    expect(lines).toEqual([
      '┌  Initializing CodeGraph',
      '│',
      '◆  Initialized in D:\\test\\e-archives',
      '|',
      '|  * Scanning files - 5481 found',
      '|  * Parsing code  100%',
      '|  * Resolving refs - done',
      '│',
      '◆  Indexed 2 files',
      '│',
      '●  4 nodes, 4 edges in 957ms',
      '│',
      '└  Done',
    ]);
  });
});
