import { describe, expect, it } from 'vitest';

import {
  parseOpencodeMajorVersion,
  resolveOpencodeApiVersion,
  resolveOpencodeApiVersionFromEnv,
} from '../../../src/agent/opencode/version';

describe('opencode api version resolution', () => {
  it('reads an explicit env override (auto/v1/v2, numeric aliases)', () => {
    expect(resolveOpencodeApiVersionFromEnv({ LARK_CHANNEL_OPENCODE_API: 'v1' })).toBe(1);
    expect(resolveOpencodeApiVersionFromEnv({ LARK_CHANNEL_OPENCODE_API: '1' })).toBe(1);
    expect(resolveOpencodeApiVersionFromEnv({ LARK_CHANNEL_OPENCODE_API: 'v2' })).toBe(2);
    expect(resolveOpencodeApiVersionFromEnv({ LARK_CHANNEL_OPENCODE_API: '2' })).toBe(2);
    expect(resolveOpencodeApiVersionFromEnv({ LARK_CHANNEL_OPENCODE_API: ' V2 ' })).toBe(2);
    expect(resolveOpencodeApiVersionFromEnv({ LARK_CHANNEL_OPENCODE_API: 'auto' })).toBe('auto');
    expect(resolveOpencodeApiVersionFromEnv({})).toBe('auto');
    expect(resolveOpencodeApiVersionFromEnv({ LARK_CHANNEL_OPENCODE_API: 'nonsense' })).toBe(
      'auto',
    );
  });

  it('parses the major version from bare and prefixed version strings', () => {
    expect(parseOpencodeMajorVersion('opencode v2.0.18')).toBe(2);
    expect(parseOpencodeMajorVersion('2.0.18')).toBe(2);
    expect(parseOpencodeMajorVersion('1.18.35')).toBe(1);
    expect(parseOpencodeMajorVersion('0.0.0-test')).toBe(0);
    expect(parseOpencodeMajorVersion(undefined)).toBeUndefined();
    expect(parseOpencodeMajorVersion('')).toBeUndefined();
  });

  it('auto-selects v2 for major >= 2 and falls back to v1 otherwise', () => {
    expect(resolveOpencodeApiVersion({ env: {}, version: 'opencode v2.0.18' })).toBe(2);
    expect(resolveOpencodeApiVersion({ env: {}, version: '3.1.0' })).toBe(2);
    expect(resolveOpencodeApiVersion({ env: {}, version: '1.18.35' })).toBe(1);
    expect(resolveOpencodeApiVersion({ env: {}, version: '0.0.0-test' })).toBe(1);
    expect(resolveOpencodeApiVersion({ env: {}, version: undefined })).toBe(1);
  });

  it('lets the env override win over the detected version', () => {
    expect(
      resolveOpencodeApiVersion({ env: { LARK_CHANNEL_OPENCODE_API: 'v1' }, version: '2.0.18' }),
    ).toBe(1);
    expect(
      resolveOpencodeApiVersion({ env: { LARK_CHANNEL_OPENCODE_API: 'v2' }, version: '1.18.35' }),
    ).toBe(2);
  });
});
