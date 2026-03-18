/**
 * auth.ts — OAuth2 client for Read AI
 *
 * Uses Authorization Code flow with a localhost callback server.
 * No manual code pasting needed — browser redirects back automatically.
 *
 * Tokens are stored at ~/.openbuilder/readai-auth.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";

const OPENBUILDER_DIR = join(homedir(), ".openbuilder");
const READAI_AUTH_FILE = join(OPENBUILDER_DIR, "readai-auth.json");

// Endpoints from https://authn.read.ai/.well-known/openid-configuration
const OAUTH_REGISTER_URL = "https://api.read.ai/oauth/register";
const OAUTH_AUTHORIZE_URL = "https://authn.read.ai/oauth2/auth";
const OAUTH_TOKEN_URL = "https://authn.read.ai/oauth2/token";

const CALLBACK_PORT = 8976;
const OAUTH_REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
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
  expires_at: string;
  scope: string;
}

interface ReadAIAuthState {
  client: ReadAIClientCredentials;
  tokens: ReadAITokens;
  savedAt: string;
}

function loadAuthState(): ReadAIAuthState | null {
  if (!existsSync(READAI_AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(READAI_AUTH_FILE, "utf-8")) as ReadAIAuthState;
  } catch {
    return null;
  }
}

function saveAuthState(state: ReadAIAuthState): void {
  mkdirSync(OPENBUILDER_DIR, { recursive: true });
  writeFileSync(READAI_AUTH_FILE, JSON.stringify(state, null, 2) + "\n");
}

function isTokenExpired(tokens: ReadAITokens): boolean {
  const expiresAt = new Date(tokens.expires_at).getTime();
  return Date.now() >= expiresAt - 60_000;
}

async function registerClient(): Promise<ReadAIClientCredentials> {
  const body = {
    client_name: "OpenBuilder",
    redirect_uris: [OAUTH_REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: OAUTH_SCOPE,
    token_endpoint_auth_method: "client_secret_basic",
    audience: ["https://api.read.ai/v1/meetings", "https://api.read.ai/mcp"],
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
  return {
    client_id: data.client_id as string,
    client_secret: data.client_secret as string,
  };
}

function buildAuthorizationURL(client: ReadAIClientCredentials, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Start a temporary localhost HTTP server that waits for the OAuth callback.
 * Returns the authorization code from the redirect.
 */
function waitForCallback(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for authorization (5 minutes). Try again."));
    }, 5 * 60 * 1000);

    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${CALLBACK_PORT}`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><body><h2>Authorization failed</h2><p>${error}</p><p>You can close this tab.</p></body></html>`);
          clearTimeout(timeout);
          server.close();
          reject(new Error(`Authorization failed: ${error}`));
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><body><h2>✅ Authorized!</h2><p>OpenBuilder is now connected to Read AI.</p><p>You can close this tab and return to your terminal.</p></body></html>`);
          clearTimeout(timeout);
          server.close();
          resolve(code);
          return;
        }

        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing authorization code");
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      // Server ready
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start callback server on port ${CALLBACK_PORT}: ${err.message}`));
    });
  });
}

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
 * Run the full OAuth flow:
 * 1. Register client (or reuse existing)
 * 2. Start localhost callback server
 * 3. Open browser for authorization
 * 4. Wait for redirect with code
 * 5. Exchange code for tokens
 * 6. Save everything
 */
export async function authorize(): Promise<void> {
  let client: ReadAIClientCredentials;

  const existing = loadAuthState();
  if (existing?.client?.client_id) {
    console.log("Reusing existing Read AI client registration.");
    client = existing.client;
  } else {
    console.log("Registering new OAuth2 client with Read AI...");
    client = await registerClient();
    console.log("Client registered successfully.\n");
  }

  const oauthState = Math.random().toString(36).substring(2) + Date.now().toString(36);
  const authURL = buildAuthorizationURL(client, oauthState);

  console.log("Opening your browser for Read AI authorization...\n");
  console.log(`If it doesn't open automatically, go to:\n  ${authURL}\n`);

  // Start callback server BEFORE opening browser
  const codePromise = waitForCallback();

  // Open browser
  try {
    const { exec } = await import("node:child_process");
    const openCmd =
      process.platform === "darwin" ? "open" :
      process.platform === "win32" ? "start" : "xdg-open";
    exec(`${openCmd} "${authURL}"`);
  } catch { /* ignore */ }

  console.log("Waiting for authorization (this will complete automatically)...\n");

  const code = await codePromise;

  console.log("Authorization received! Exchanging for tokens...");
  const tokens = await exchangeCode(client, code);

  const state: ReadAIAuthState = { client, tokens, savedAt: new Date().toISOString() };
  saveAuthState(state);

  console.log("\n✅ Read AI connected! Tokens saved to ~/.openbuilder/readai-auth.json");
}

export async function getAccessToken(): Promise<string> {
  const state = loadAuthState();
  if (!state?.tokens?.access_token) {
    throw new Error("Not authenticated with Read AI. Run: npx openbuilder readai auth");
  }

  if (!isTokenExpired(state.tokens)) {
    return state.tokens.access_token;
  }

  if (!state.tokens.refresh_token) {
    throw new Error("Access token expired and no refresh token. Run: npx openbuilder readai auth");
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

export function isAuthenticated(): boolean {
  const state = loadAuthState();
  return !!(state?.tokens?.access_token);
}
