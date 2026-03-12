#!/usr/bin/env npx tsx
/**
 * builder-config.ts — View and manage OpenBuilder configuration
 *
 * Usage:
 *   npx openbuilder config                    # show all config
 *   npx openbuilder config set <key> <value>  # set a value
 *   npx openbuilder config get <key>          # get a value
 *   npx openbuilder config delete <key>       # delete a value
 */

import {
  CONFIG_FILE,
  getConfig,
  readConfig,
  setConfigValue,
  deleteConfigValue,
  type OpenBuilderConfig,
} from "../src/utils/config.js";

const VALID_KEYS: (keyof OpenBuilderConfig)[] = [
  "aiProvider",
  "anthropicApiKey",
  "openaiApiKey",
  "botName",
  "defaultDuration",
];

const SENSITIVE_KEYS = new Set(["anthropicApiKey", "openaiApiKey"]);

function maskValue(key: string, value: string): string {
  if (SENSITIVE_KEYS.has(key) && value.length > 8) {
    return value.slice(0, 4) + "..." + value.slice(-4);
  }
  return value;
}

function showHelp() {
  console.log(`OpenBuilder Config

Usage:
  openbuilder config                    Show all configuration
  openbuilder config set <key> <value>  Set a configuration value
  openbuilder config get <key>          Get a configuration value
  openbuilder config delete <key>       Delete a configuration value

Keys:
  aiProvider       AI provider to use: claude or openai (default: claude)
  anthropicApiKey  Anthropic API key for Claude
  openaiApiKey     OpenAI API key
  botName          Default bot display name
  defaultDuration  Default meeting duration (e.g. 60m, 2h)

Environment variables (override config file):
  OPENBUILDER_AI_PROVIDER
  ANTHROPIC_API_KEY
  OPENAI_API_KEY
  OPENBUILDER_BOT_NAME
  OPENBUILDER_DEFAULT_DURATION

Config file: ${CONFIG_FILE}`);
}

function showAll() {
  const fileConfig = readConfig();
  const effectiveConfig = getConfig();

  console.log("OpenBuilder Configuration\n");
  console.log(`Config file: ${CONFIG_FILE}\n`);

  if (Object.keys(effectiveConfig).length === 0) {
    console.log("(no configuration set)");
    console.log("\nRun `openbuilder config set <key> <value>` to configure.");
    return;
  }

  console.log("Current settings:");
  for (const key of VALID_KEYS) {
    const fileVal = fileConfig[key] as string | undefined;
    const effectiveVal = effectiveConfig[key] as string | undefined;

    if (effectiveVal) {
      const source = fileVal === effectiveVal ? "config" : "env";
      console.log(`  ${key}: ${maskValue(key, effectiveVal)} (${source})`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    if (!subcommand) {
      showAll();
      return;
    }
    showHelp();
    return;
  }

  if (subcommand === "set") {
    const key = args[1] as keyof OpenBuilderConfig;
    const value = args[2];

    if (!key || !value) {
      console.error("Usage: openbuilder config set <key> <value>");
      process.exit(1);
    }

    if (!VALID_KEYS.includes(key)) {
      console.error(`Unknown config key: ${key}`);
      console.error(`Valid keys: ${VALID_KEYS.join(", ")}`);
      process.exit(1);
    }

    if (key === "aiProvider" && value !== "claude" && value !== "openai") {
      console.error("aiProvider must be 'claude' or 'openai'");
      process.exit(1);
    }

    setConfigValue(key, value);
    console.log(`Set ${key} = ${maskValue(key, value)}`);
    return;
  }

  if (subcommand === "get") {
    const key = args[1] as keyof OpenBuilderConfig;
    if (!key) {
      console.error("Usage: openbuilder config get <key>");
      process.exit(1);
    }

    const config = getConfig();
    const value = config[key] as string | undefined;
    if (value) {
      console.log(maskValue(key, value));
    } else {
      console.log(`(not set)`);
    }
    return;
  }

  if (subcommand === "delete") {
    const key = args[1] as keyof OpenBuilderConfig;
    if (!key) {
      console.error("Usage: openbuilder config delete <key>");
      process.exit(1);
    }

    if (!VALID_KEYS.includes(key)) {
      console.error(`Unknown config key: ${key}`);
      process.exit(1);
    }

    deleteConfigValue(key);
    console.log(`Deleted ${key}`);
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  showHelp();
  process.exit(1);
}

main();
