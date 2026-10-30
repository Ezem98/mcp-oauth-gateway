import { getEnv } from "../src/config/env.js";
import { getConnectAdminToken } from "../src/credentials/admin-token.js";

const user = process.argv[2];
if (!user || user.trim() === "") {
  console.error("Usage: npm run connect-url -- <user>");
  process.exit(1);
}

const env = getEnv();
const token = getConnectAdminToken();

const baseUrl = env.PUBLIC_URL.replace(/\/+$/, "");
const url = new URL(`${baseUrl}/connect/google`);
url.searchParams.set("user", user);
url.searchParams.set("admin", token);

console.log(url.toString());
