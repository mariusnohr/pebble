import "server-only";

// Environment UIs sometimes store the full quoted line shown by `pnpm password:hash`.
export function adminPasswordHash() {
  return process.env.ADMIN_PASSWORD_HASH?.trim()
    .replace(/^ADMIN_PASSWORD_HASH\s*=\s*/, "")
    .replace(/^(['"])(.*)\1$/, "$2");
}
