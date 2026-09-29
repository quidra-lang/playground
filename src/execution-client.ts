export const RUNNER_API_VERSION = 2;

export type ExecutionOperation = "build" | "run";

export interface RunnerMetadata {
  api_version: number;
  operations: ExecutionOperation[];
  version: string;
  core_commit: string;
  max_source_bytes: number;
  timeout_seconds: number;
}

export interface ExecutionResult {
  api_version: number;
  operation: ExecutionOperation;
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  elapsed_ms: number;
  timed_out: boolean;
  version: string;
  core_commit: string;
}

function normaliseBaseUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  return value.replace(/\/+$/, "");
}

async function readJson<T>(response: Response): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`runner returned HTTP ${response.status} without JSON`);
  }
  if (!response.ok) {
    const message =
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof (value as { error?: unknown }).error === "string"
        ? (value as { error: string }).error
        : `runner returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return value as T;
}

export class ExecutionClient {
  constructor(private readonly baseUrl: string) {}

  static fromEnvironment(): ExecutionClient | null {
    const baseUrl = normaliseBaseUrl(import.meta.env.VITE_QUIDRA_RUNNER_URL);
    return baseUrl ? new ExecutionClient(baseUrl) : null;
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
    timeoutMs = 10_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      return await readJson<T>(response);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`runner did not answer within ${timeoutMs / 1000} seconds`);
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  metadata(): Promise<RunnerMetadata> {
    return this.request<RunnerMetadata>("/v2/meta");
  }

  execute(
    operation: ExecutionOperation,
    source: string,
    args: string[] = [],
  ): Promise<ExecutionResult> {
    return this.request<ExecutionResult>(
      "/v2/execute",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation, source, args }),
      },
      45_000,
    );
  }
}
