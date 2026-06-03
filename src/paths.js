import { join } from 'node:path';

export function resolveQueueDir(env, homedir) {
  if (env.CLAUDE_GO_QUEUE_DIR && env.CLAUDE_GO_QUEUE_DIR.trim())
    return env.CLAUDE_GO_QUEUE_DIR.trim();
  return join(homedir, '.claude-disparador');
}
