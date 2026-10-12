import { describe, expect, it } from 'vitest';
import { JobRegistry } from '../../../src/workspace/jobs';

describe('JobRegistry basics', () => {
  it('creates a running job with startedAt from the clock', () => {
    const reg = new JobRegistry({ now: () => 42 });
    const { id } = reg.create({ kind: 'add', label: '添加项目' });
    const snap = reg.get(id);
    expect(snap).toBeDefined();
    expect(snap!.status).toBe('running');
    expect(snap!.kind).toBe('add');
    expect(snap!.label).toBe('添加项目');
    expect(snap!.startedAt).toBe(42);
    expect(snap!.endedAt).toBeUndefined();
    expect(snap!.steps).toEqual([]);
    expect(snap!.logs).toEqual([]);
  });

  it('returns undefined for an unknown job', () => {
    const reg = new JobRegistry();
    expect(reg.get('nope')).toBeUndefined();
  });

  it('generates unique ids', () => {
    const reg = new JobRegistry();
    const a = reg.create({ kind: 'k', label: 'a' }).id;
    const b = reg.create({ kind: 'k', label: 'b' }).id;
    expect(a).not.toBe(b);
  });
});

describe('JobRegistry append', () => {
  it('splits on \\r and \\n and drops blank lines', () => {
    const reg = new JobRegistry({ now: () => 1 });
    const { id } = reg.create({ kind: 'k', label: 'l' });
    reg.append(id, { stream: 'stdout', text: 'a\rb\nc\r\nd\n\n   \n' });
    expect(reg.get(id)!.logs.map((l) => l.text)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('assigns per-job monotonic seq starting at 1', () => {
    const reg = new JobRegistry();
    const { id } = reg.create({ kind: 'k', label: 'l' });
    reg.append(id, { stream: 'stdout', text: 'a' });
    reg.append(id, { stream: 'stderr', text: 'b' });
    reg.append(id, { stepId: 's1', stream: 'info', text: 'c' });
    const logs = reg.get(id)!.logs;
    expect(logs.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(logs[1]!.stream).toBe('stderr');
    expect(logs[2]!.stepId).toBe('s1');
  });

  it('supports incremental reads with since', () => {
    const reg = new JobRegistry();
    const { id } = reg.create({ kind: 'k', label: 'l' });
    reg.append(id, { stream: 'stdout', text: 'one\ntwo\nthree' });
    expect(reg.get(id, 1)!.logs.map((l) => l.seq)).toEqual([2, 3]);
    expect(reg.get(id, 3)!.logs).toEqual([]);
    expect(reg.get(id, 0)!.logs.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it('caps lines at maxLinesPerJob keeping the newest', () => {
    const reg = new JobRegistry({ maxLinesPerJob: 3 });
    const { id } = reg.create({ kind: 'k', label: 'l' });
    reg.append(id, { stream: 'stdout', text: '1\n2\n3\n4\n5' });
    const logs = reg.get(id)!.logs;
    expect(logs.map((l) => l.text)).toEqual(['3', '4', '5']);
    expect(logs.map((l) => l.seq)).toEqual([3, 4, 5]);
  });

  it('scrubs redacted strings in every line', () => {
    const reg = new JobRegistry();
    const { id } = reg.create({ kind: 'k', label: 'l', redact: ['SECRET', 'tok'] });
    reg.append(id, { stream: 'stdout', text: 'use SECRET and tok here\nplain' });
    expect(reg.get(id)!.logs.map((l) => l.text)).toEqual(['use *** and *** here', 'plain']);
  });
});

describe('JobRegistry steps', () => {
  it('adds steps as running and is idempotent by id', () => {
    const reg = new JobRegistry();
    const { id } = reg.create({ kind: 'k', label: 'l' });
    reg.addStep(id, { id: 's1', name: 'repo-a' });
    reg.addStep(id, { id: 's1', name: 'repo-a-again' });
    const steps = reg.get(id)!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ id: 's1', name: 'repo-a', status: 'running' });
  });

  it('updates step status', () => {
    const reg = new JobRegistry();
    const { id } = reg.create({ kind: 'k', label: 'l' });
    reg.addStep(id, { id: 's1', name: 'repo-a' });
    reg.setStepStatus(id, 's1', 'succeeded');
    expect(reg.get(id)!.steps[0]!.status).toBe('succeeded');
  });
});

describe('JobRegistry terminal states', () => {
  it('finish sets succeeded, result and endedAt', () => {
    const reg = new JobRegistry({ now: () => 7 });
    const { id } = reg.create({ kind: 'k', label: 'l' });
    reg.finish(id, { added: 2 });
    const snap = reg.get(id)!;
    expect(snap.status).toBe('succeeded');
    expect(snap.result).toEqual({ added: 2 });
    expect(snap.endedAt).toBe(7);
  });

  it('fail sets failed and error', () => {
    const reg = new JobRegistry({ now: () => 9 });
    const { id } = reg.create({ kind: 'k', label: 'l' });
    reg.fail(id, 'boom');
    const snap = reg.get(id)!;
    expect(snap.status).toBe('failed');
    expect(snap.error).toBe('boom');
    expect(snap.endedAt).toBe(9);
  });

  it('ignores append/finish/fail once terminal or unknown', () => {
    const reg = new JobRegistry();
    const { id } = reg.create({ kind: 'k', label: 'l' });
    reg.finish(id, 'ok');
    reg.append(id, { stream: 'stdout', text: 'late' });
    reg.fail(id, 'nope');
    reg.finish(id, 'again');
    const snap = reg.get(id)!;
    expect(snap.status).toBe('succeeded');
    expect(snap.result).toBe('ok');
    expect(snap.error).toBeUndefined();
    expect(snap.logs).toEqual([]);

    expect(() => reg.append('nope', { stream: 'stdout', text: 'x' })).not.toThrow();
    expect(() => reg.finish('nope')).not.toThrow();
    expect(() => reg.fail('nope', 'x')).not.toThrow();
  });
});

describe('JobRegistry cleanup', () => {
  it('sweeps completed jobs past the ttl on create', () => {
    let t = 0;
    const reg = new JobRegistry({ now: () => t, ttlMs: 100 });
    const old = reg.create({ kind: 'k', label: 'old' }).id;
    reg.finish(old);

    t = 200;
    const fresh = reg.create({ kind: 'k', label: 'fresh' }).id;
    expect(reg.get(old)).toBeUndefined();
    expect(reg.get(fresh)).toBeDefined();
  });

  it('keeps in-progress jobs even when old', () => {
    let t = 0;
    const reg = new JobRegistry({ now: () => t, ttlMs: 100 });
    const running = reg.create({ kind: 'k', label: 'running' }).id;

    t = 10_000;
    reg.create({ kind: 'k', label: 'other' });
    expect(reg.get(running)).toBeDefined();
  });

  it('keeps only the newest maxJobs completed jobs', () => {
    let t = 0;
    const reg = new JobRegistry({ now: () => t, ttlMs: 1_000_000, maxJobs: 2 });
    const a = reg.create({ kind: 'k', label: 'a' }).id;
    t = 1;
    reg.finish(a);
    const b = reg.create({ kind: 'k', label: 'b' }).id;
    t = 2;
    reg.finish(b);
    const c = reg.create({ kind: 'k', label: 'c' }).id;
    t = 3;
    reg.finish(c);

    // create triggers the sweep: completed a/b/c → keep newest two (c, b).
    t = 4;
    reg.create({ kind: 'k', label: 'd' });

    expect(reg.get(a)).toBeUndefined();
    expect(reg.get(b)).toBeDefined();
    expect(reg.get(c)).toBeDefined();
  });
});
