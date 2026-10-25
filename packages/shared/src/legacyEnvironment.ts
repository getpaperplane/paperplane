/** One-time warnings for operator settings renamed during the Paperplane migration. */
const legacyUserEnvironmentVariables = [
  "ROVE_HOME",
  "ROVE_PORT",
  "ROVE_HOST",
  "ROVE_NO_BROWSER",
  "ROVE_MODE",
  "ROVE_LOG_LEVEL",
  "ROVE_LOG_WS_EVENTS",
  "ROVE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
  "ROVE_DISABLE_AUTO_UPDATE",
  "ROVE_INSTALL_BIN_DIR",
  "ROVE_CHANNEL",
  "ROVE_VERSION",
  "ROVE_RELEASE_BASE_URL",
  "ROVE_HOSTED_APP_URL",
  "ROVE_TAILSCALE_SERVE",
  "ROVE_TAILSCALE_SERVE_PORT",
  "ROVE_TELEMETRY_ENABLED",
  "ROVE_TELEMETRY_FLUSH_BATCH_SIZE",
  "ROVE_TELEMETRY_MAX_BUFFERED_EVENTS",
  "ROVE_ANALYTICS_ENVIRONMENT",
  "ROVE_POSTHOG_HOST",
  "ROVE_POSTHOG_KEY",
  "ROVE_OTEL_SDK_DISABLED",
  "ROVE_OTLP_TRACES_URL",
  "ROVE_OTLP_METRICS_URL",
  "ROVE_OTLP_LOGS_URL",
  "ROVE_OTLP_EXPORT_INTERVAL_MS",
  "ROVE_OTLP_HEADERS",
  "ROVE_OTLP_PROTOCOL",
  "ROVE_TRACE_FILE",
  "ROVE_TRACE_MAX_FILES",
  "ROVE_TRACE_MIN_LEVEL",
  "ROVE_TRACE_TIMING_ENABLED",
  "ROVE_TRACE_MAX_BYTES",
  "ROVE_TRACE_BATCH_WINDOW_MS",
  "ROVE_CONTEXT_HANDOFF_TOKEN_CAP",
  "ROVE_PI_MEMORY_BUDGET_MIB",
  "ROVE_SERVER_BROWSER_SANDBOX",
  "ROVE_RESOURCE_MONITOR_PATH",
  "ROVE_CLOUDFLARED_PATH",
  "ROVE_CODEX_LAUNCH_ARGS",
  "ROVE_BITBUCKET_ACCESS_TOKEN",
  "ROVE_BITBUCKET_EMAIL",
  "ROVE_BITBUCKET_API_TOKEN",
  "ROVE_BITBUCKET_API_BASE_URL",
  "ROVE_DESKTOP_LAN_HOST",
  "ROVE_DESKTOP_HTTPS_ENDPOINTS",
  "ROVE_RELAY_URL",
  "ROVE_CLERK_PUBLISHABLE_KEY",
  "ROVE_CLERK_JWT_TEMPLATE",
  "ROVE_CLERK_CLI_OAUTH_CLIENT_ID",
] as const;

/** Warn once per set name, including empty values, without reading or copying its value. */
export function warnIgnoredLegacyEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
): void {
  for (const oldName of legacyUserEnvironmentVariables) {
    if (env[oldName] !== undefined) {
      const replacement = oldName.replace(/^ROVE_/, "PAPERPLANE_");
      warn(`${oldName} is set but ignored; use ${replacement}.`);
    }
  }
}
