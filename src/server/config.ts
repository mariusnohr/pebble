import "server-only";

export function appOrigin() {
  return new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
}

// Environment UIs sometimes store the full quoted line shown by `pnpm password:hash`.
export function adminPasswordHash() {
  return process.env.ADMIN_PASSWORD_HASH?.trim()
    .replace(/^ADMIN_PASSWORD_HASH\s*=\s*/, "")
    .replace(/^(['"])(.*)\1$/, "$2");
}
