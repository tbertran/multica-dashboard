import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PROFILE = process.env.MULTICA_PROFILE || 'team-apollo';

let cached = null;

// Reuses the multica CLI's own profile store instead of holding a second copy
// of the PAT — `multica --profile <name>` already writes this file.
export async function loadProfile() {
  if (cached) return cached;
  const p = path.join(homedir(), '.multica', 'profiles', PROFILE, 'config.json');
  const raw = await readFile(p, 'utf-8');
  const cfg = JSON.parse(raw);
  if (!cfg.token || !cfg.server_url || !cfg.workspace_id) {
    throw new Error(`multica profile "${PROFILE}" at ${p} is missing token/server_url/workspace_id`);
  }
  cached = {
    profile: PROFILE,
    token: cfg.token.trim(),
    serverUrl: cfg.server_url.replace(/\/+$/, ''),
    workspaceId: cfg.workspace_id,
  };
  return cached;
}
