import "server-only";

// Environment UIs sometimes store the quoted form shown in .env.example.
export function adminPasswordHash() {
  return process.env.ADMIN_PASSWORD_HASH?.replace(/^(['"])(.*)\1$/, "$2");
}
