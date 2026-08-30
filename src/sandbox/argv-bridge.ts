import { readFile } from "node:fs/promises";

import { execa } from "execa";

interface TargetPayload {
  executablePath: string;
  args: string[];
  cwdAbsolute: string;
  environment: NodeJS.ProcessEnv;
}

const SANDBOX_ENVIRONMENT_KEYS = /^(?:(?:HTTP|HTTPS|ALL|NO)_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|CURL_CA_BUNDLE|GIT_SSL_CAINFO|CARGO_HTTP_CAINFO|JAVA_TOOL_OPTIONS|GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)|SRT_[A-Z0-9_]+)$/u;

function mergedTargetEnvironment(payload: TargetPayload): NodeJS.ProcessEnv {
  const environment = { ...payload.environment };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && SANDBOX_ENVIRONMENT_KEYS.test(key)) {
      environment[key] = value;
    }
  }
  return environment;
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) throw new Error("Missing EASY CODE sandbox target payload");
  const payload = JSON.parse(await readFile(payloadPath, "utf8")) as TargetPayload;
  if (
    !payload ||
    typeof payload.executablePath !== "string" ||
    !Array.isArray(payload.args) ||
    typeof payload.cwdAbsolute !== "string" ||
    !payload.environment ||
    typeof payload.environment !== "object"
  ) {
    throw new Error("Invalid EASY CODE sandbox target payload");
  }
  const subprocess = execa(payload.executablePath, payload.args, {
    cwd: payload.cwdAbsolute,
    env: mergedTargetEnvironment(payload),
    extendEnv: false,
    shell: false,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    buffer: false,
    reject: false,
    cleanup: true,
    windowsHide: true,
  });
  const result = await subprocess;
  process.exitCode = result.exitCode ?? 1;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`EASY CODE sandbox target launch failed: ${message}\n`);
  process.exitCode = 127;
});
