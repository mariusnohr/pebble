import { createInterface } from "node:readline";
import { hashPassword } from "../src/server/crypto";

// Read from stdin instead of command-line arguments so passwords don't enter shell history.
if (process.stdin.isTTY)
  process.stderr.write("Enter an admin password (12+ characters; input is visible): ");
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  input.close();
  if (line.length < 12 || line.length > 1024) {
    process.stderr.write("Password must contain 12–1024 characters.\n");
    process.exitCode = 1;
    break;
  }
  console.log(`ADMIN_PASSWORD_HASH='${await hashPassword(line)}'`);
  break;
}
