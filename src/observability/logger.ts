import { getEnv } from "../config/env.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLOR: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

function shouldLog(level: LogLevel): boolean {
  return PRIORITY[level] >= PRIORITY[getEnv().LOG_LEVEL as LogLevel];
}

function format(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>
): string {
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  const tag = level.toUpperCase().padEnd(5);
  let line = `${COLOR[level]}[${ts}] ${tag}${RESET} ${message}`;
  if (data) {
    const compact = Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" | ");
    line += ` \x1b[90m${compact}${RESET}`;
  }
  return line;
}

export const logger = {
  debug(msg: string, data?: Record<string, unknown>) {
    if (shouldLog("debug")) console.log(format("debug", msg, data));
  },
  info(msg: string, data?: Record<string, unknown>) {
    if (shouldLog("info")) console.log(format("info", msg, data));
  },
  warn(msg: string, data?: Record<string, unknown>) {
    if (shouldLog("warn")) console.warn(format("warn", msg, data));
  },
  error(msg: string, data?: Record<string, unknown>) {
    if (shouldLog("error")) console.error(format("error", msg, data));
  },
};
