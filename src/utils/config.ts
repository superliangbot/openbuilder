/**
 * config.ts — Configuration file management for OpenBuilder
 *
 * Config file: ~/.openbuilder/config.json
 * Environment variables override config file values.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OPENBUILDER_DIR = join(homedir(), ".openbuilder");
export const CONFIG_FILE = join(OPENBUILDER_DIR, "config.json");
export const AUTH_FILE = join(OPENBUILDER_DIR, "auth.json");
export const AUTH_META_FILE = join(OPENBUILDER_DIR, "auth-meta.json");
export const PID_FILE = join(OPENBUILDER_DIR, "builder.pid");
export const WORKSPACE_DIR = join(homedir(), ".openclaw", "workspace", "openbuilder");
export const TRANSCRIPTS_DIR = join(WORKSPACE_DIR, "transcripts");
export const REPORTS_DIR = join(WORKSPACE_DIR, "reports");
export const SCREENSHOT_READY_FILE = join(WORKSPACE_DIR, "screenshot-ready.json");

export interface OpenBuilderConfig {
  aiProvider?: "claude" | "openai";
  anthropicApiKey?: string;
  openaiApiKey?: string;
  botName?: string;
  defaultDuration?: string;
}

const ENV_MAP: Record<string, keyof OpenBuilderConfig> = {
  OPENBUILDER_AI_PROVIDER: "aiProvider",
  ANTHROPIC_API_KEY: "anthropicApiKey",
  OPENAI_API_KEY: "openaiApiKey",
  OPENBUILDER_BOT_NAME: "botName",
  OPENBUILDER_DEFAULT_DURATION: "defaultDuration",
};

/** Read the config file from disk. Returns empty object if not found. */
export function readConfig(): OpenBuilderConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as OpenBuilderConfig;
  } catch {
    return {};
  }
}

/** Write the config file to disk. */
export function writeConfig(config: OpenBuilderConfig): void {
  mkdirSync(OPENBUILDER_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Get the effective config — file values with environment variable overrides.
 * Environment variables always take precedence over config file values.
 */
export function getConfig(): OpenBuilderConfig {
  const fileConfig = readConfig();

  // Apply environment variable overrides
  for (const [envVar, configKey] of Object.entries(ENV_MAP)) {
    const envValue = process.env[envVar];
    if (envValue !== undefined && envValue !== "") {
      (fileConfig as Record<string, string>)[configKey] = envValue;
    }
  }

  return fileConfig;
}

/** Get a single config value (with env override). */
export function getConfigValue(key: keyof OpenBuilderConfig): string | undefined {
  const config = getConfig();
  return config[key] as string | undefined;
}

/** Set a single config value in the config file. */
export function setConfigValue(key: keyof OpenBuilderConfig, value: string): void {
  const config = readConfig();
  (config as Record<string, string>)[key] = value;
  writeConfig(config);
}

/** Delete a config value from the config file. */
export function deleteConfigValue(key: keyof OpenBuilderConfig): void {
  const config = readConfig();
  delete config[key];
  writeConfig(config);
}

/** Ensure all required directories exist. */
export function ensureDirs(): void {
  mkdirSync(OPENBUILDER_DIR, { recursive: true });
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });
}
