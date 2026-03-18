/**
 * auth.ts — OAuth2 client for Read AI
 *
 * Handles dynamic client registration, authorization URL building,
 * token exchange, auto-refresh, and token persistence.
 *
 * Tokens are stored at ~/.openbuilder/readai-auth.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OPENBUILDER_DIR = join(homedir(), ".openbuilder");
const READAI_AUTH_FILE = join(OPENBUILDER_DIR, "readai-auth.json");

const READAI_BASE_URL = "https://api.read.ai";
const READAI_APP_URL = "https://app.read.ai";
const OAUTH_REGISTER_URL = `${READAI_BASE_URL}/oauth/register`;
const OAUTH_AUTHORIZE_URL = `${READAI_APP_URL}/oauth/authorize`;
const OAUTH_TOKEN_URL = `${READAI_APP_URL}/oauth/token`;
const OAUTH_REDIRECT_URI = `${READAI_APP_URL}/oauth/ui`;

const OAUTH_SCOPE = "openid email offline_access profile meeting:read mcp:execute";

interface ReadAIClientCredentials {
  client_id: string;
  client_secret: string;
}

interface ReadAITokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  /** ISO timestamp when the access token expires */
  expires_at: string;
  scope: string;
}

interface ReadAIAuthState {
  client: ReadAIClientCredentials;
  tokens: ReadAITokens;
  savedAt: string;
}

/** Load saved auth state from disk. Returns null if not found or invalid. */
function loadAuthState(): ReadAIAuthState | null {
  if (!existsSync(READAI_AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(READAI_AUTH_FILE, "utf-8")) as ReadAIAuthState;
  } catch {
    return null;
  }
}

/** Save auth state to disk. */
function saveAuthState(state: ReadAIAuthState): void {
  mkdirSync(OPENBUILDER_DIR, { recursive: true });
  writeFileSync(READAI_AUTH_FILE, JSON.stringify(state, null, 2) + "\n");
}

/** Check whether the access token has expired (with 60s buffer). */
function isTokenExpired(tokens: ReadAITokens): boolean {
  const expiresAt = new Date(tokens.expires_at).getTime();
  return Date.now() >= expiresAt - 60_000;
}

/**
 * Register a new OAuth2 client with Read AI.
 * This is a one-time step; credentials are saved and reused.
 */
async function registerClient(): Promise<ReadAIClientCredentials> {
  const body = {
    client_name: "OpenBuilder",
    redirect_uris: [OAUTH_REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: OAUTH_SCOPE,
    token_endpoint_auth_method: "client_secret_basic",
  };

  const res = await fetch(OAUTH_REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Client registration failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const client_id = data.client_id as string;
  const client_secret = data.client_secret as string;

  if (!client_id || !client_secret) {
    throw new Error("Registration response missing client_id or client_secret");
  }

  return { client_id, client_secret };
}

/**
 * Build the OAuth authorization URL for user consent.
 * The user should open this URL in their browser.
 */
function buildAuthorizationURL(client: ReadAIClientCredentials): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * Uses HTTP Basic auth (client_secret_basic).
 */
async function exchangeCode(
  client: ReadAIClientCredentials,
  code: string,
): Promise<ReadAITokens> {
  const basicAuth = Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64");

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const expiresIn = (data.expires_in as number) || 3600;

  return {
    access_token: data.access_token as string,
    refresh_token: data.refresh_token as string,
    token_type: (data.token_type as string) || "Bearer",
    expires_in: expiresIn,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scope: (data.scope as string) || OAUTH_SCOPE,
  };
}

/**
 * Refresh the access token using the saved refresh token.
 */
async function refreshAccessToken(
  client: ReadAIClientCredentials,
  refreshToken: string,
): Promise<ReadAITokens> {
  const basicAuth = Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64");

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const expiresIn = (data.expires_in as number) || 3600;

  return {
    access_token: data.access_token as string,
    refresh_token: (data.refresh_token as string) || refreshToken,
    token_type: (data.token_type as string) || "Bearer",
    expires_in: expiresIn,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scope: (data.scope as string) || OAUTH_SCOPE,
  };
}

/**
 * Run the full OAuth authorization flow:
 * 1. Register client (or reuse existing)
 * 2. Open browser for user consent
 * 3. Wait for user to provide the authorization code
 * 4. Exchange code for tokens
 * 5. Save everything to disk
 */
export async function authorize(): Promise<void> {
  let client: ReadAIClientCredentials;

  // Reuse existing client credentials if available
  const existing = loadAuthState();
  if (existing?.client?.client_id) {
    console.log("Reusing existing Read AI client registration.");
    client = existing.client;
  } else {
    console.log("Registering new OAuth2 client with Read AI...");
    client = await registerClient();
    console.log("Client registered successfully.");
  }

  // Build authorization URL and prompt user
  const authURL = buildAuthorizationURL(client);
  console.log("\nOpen this URL in your browser to authorize OpenBuilder:\n");
  console.log(`  ${authURL}\n`);

  // Try to open the browser automatically
  try {
    const { exec } = await import("node:child_process");
    const openCmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    exec(`${openCmd} "${authURL}"`);
    console.log("(Browser should open automatically — if not, copy the URL above.)\n");
  } catch {
    // Silently ignore if browser can't be opened
  }

  // Read the authorization code from stdin
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const code = await new Promise<string>((resolve) => {
    rl.question("Paste the authorization code here: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!code) {
    throw new Error("No authorization code provided.");
  }

  console.log("\nExchanging authorization code for tokens...");
  const tokens = await exchangeCode(client, code);

  const state: ReadAIAuthState = {
    client,
    tokens,
    savedAt: new Date().toISOString(),
  };
  saveAuthState(state);

  console.log("Read AI authorization complete! Tokens saved to ~/.openbuilder/readai-auth.json");
}

/**
 * Get a valid access token, refreshing if necessary.
 * Throws if not authenticated.
 */
export async function getAccessToken(): Promise<string> {
  const state = loadAuthState();
  if (!state?.tokens?.access_token) {
    throw new Error("Not authenticated with Read AI. Run: npx openbuilder readai auth");
  }

  if (!isTokenExpired(state.tokens)) {
    return state.tokens.access_token;
  }

  // Token expired — try to refresh
  if (!state.tokens.refresh_token) {
    throw new Error("Access token expired and no refresh token available. Run: npx openbuilder readai auth");
  }

  console.log("Read AI access token expired, refreshing...");
  const newTokens = await refreshAccessToken(state.client, state.tokens.refresh_token);

  const newState: ReadAIAuthState = {
    client: state.client,
    tokens: newTokens,
    savedAt: new Date().toISOString(),
  };
  saveAuthState(newState);

  return newTokens.access_token;
}

/**
 * Check if the user has saved Read AI credentials.
 */
export function isAuthenticated(): boolean {
  const state = loadAuthState();
  return !!(state?.tokens?.access_token);
}
