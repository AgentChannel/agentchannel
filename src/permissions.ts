import { getPermissions } from "./config.js";

export function isActionRequest(content: string): boolean {
  // Messages containing @mention + imperative verbs are potential action requests
  return /^@\w+\s+(run|execute|delete|create|push|deploy|install|test|build|send|read|write|update|fix|check)/i.test(content);
}

export function isAllowed(sender: string, action: string): boolean {
  const perms = getPermissions(sender);
  if (perms.length === 0) return false;
  if (perms.includes("*")) return true;
  return perms.includes(action);
}

export function extractAction(content: string): string | null {
  const match = content.match(/^@\w+\s+(\w+)/);
  return match ? match[1].toLowerCase() : null;
}
