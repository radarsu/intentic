import { type Logger, pino, stdSerializers, stdTimeFunctions } from "pino";
import type { Config } from "./env.config.js";

// The sandbox's structured logger. Config mirrors web-platform's pino setup (base pid, ISO timestamps, the
// `level` label formatter, the std error serializer, `message` as the message key), minus its NestJS /
// OpenTelemetry coupling. JSON by default; pino-pretty transport only when logPretty is set (dev), so the
// container still emits machine-readable lines.
export const createLogger = (config: Pick<Config, "logLevel" | "logPretty">): Logger =>
    pino({
        base: { pid: process.pid },
        level: config.logLevel,
        messageKey: "message",
        formatters: { level: (label) => ({ level: label }) },
        serializers: { err: stdSerializers.err },
        timestamp: stdTimeFunctions.isoTime,
        ...(config.logPretty ? { transport: { target: "pino-pretty" } } : {}),
    });
