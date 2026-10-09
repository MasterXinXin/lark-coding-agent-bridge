export type OpencodeApiVersion = 1 | 2;

/**
 * Read the forced API version from the environment. `auto` (the default) lets
 * {@link resolveOpencodeApiVersion} decide from `opencode --version`.
 */
export function resolveOpencodeApiVersionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpencodeApiVersion | 'auto' {
  const raw = (env.LARK_CHANNEL_OPENCODE_API ?? '').trim().toLowerCase();
  if (raw === 'v1' || raw === '1') return 1;
  if (raw === 'v2' || raw === '2') return 2;
  return 'auto';
}

/**
 * Extract the major version from a preflight version string. Handles both the
 * bare (`2.0.18`) and prefixed (`opencode v2.0.18`) forms.
 */
export function parseOpencodeMajorVersion(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const match = /(\d+)(?:\.(\d+))?/.exec(version);
  if (!match || !match[1]) return undefined;
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : undefined;
}

/**
 * Decide whether to talk to opencode's v1 (`/session`, no auth) or v2
 * (`/api/*`, Basic auth) API.
 *
 * Precedence: the `LARK_CHANNEL_OPENCODE_API` env override, then the major
 * version reported by `opencode --version`. Anything we cannot parse falls
 * back to v1 so existing installs keep working unchanged.
 */
export function resolveOpencodeApiVersion(input: {
  env?: NodeJS.ProcessEnv;
  version?: string;
}): OpencodeApiVersion {
  const forced = resolveOpencodeApiVersionFromEnv(input.env);
  if (forced !== 'auto') return forced;
  const major = parseOpencodeMajorVersion(input.version);
  return major !== undefined && major >= 2 ? 2 : 1;
}
