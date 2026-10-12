import {
  createCodegraphRunner,
  detectCli,
  mcpStatus,
  projectStats,
  type CodegraphCliStatus,
  type CodegraphMcpStatus,
  type CodegraphRunner,
  type CodegraphStats,
} from '../workspace/codegraph';
import { projectDirById } from './workspace-api';

export interface CodegraphSystemView {
  cli: CodegraphCliStatus;
  mcp: CodegraphMcpStatus;
}

/** CLI + MCP status for the console's CodeGraph card. Never throws. */
export async function codegraphSystemView(): Promise<CodegraphSystemView> {
  const [cli, mcp] = await Promise.all([detectCli(), mcpStatus()]);
  return { cli, mcp };
}

/**
 * On-demand stats for one project. `projectStats` only spawns `codegraph status`
 * for an already-indexed project, so an un-indexed row never hangs the request.
 */
export async function codegraphProjectStatsView(
  profile: string,
  rootDir: string | undefined,
  id: string,
  runner: CodegraphRunner = createCodegraphRunner(),
): Promise<CodegraphStats> {
  const dir = await projectDirById(profile, rootDir, id);
  return projectStats(runner, dir);
}
