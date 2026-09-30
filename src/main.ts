// Wires the page to the compiler.
//
// Compiler and execution output is inserted as text, never as markup, so
// nothing the compiler or the user writes can become DOM. Language semantics
// come only from Quidra Core: local tooling uses the WebAssembly frontend, and
// Build/Run delegates to a native runner built from the exact same Core commit.

import type { EditorView } from "@codemirror/view";

import { CompilerClient, type ClientStatus } from "./compiler-client";
import {
  ExecutionClient,
  RUNNER_API_VERSION,
  type ExecutionOperation,
  type ExecutionResult,
  type RunnerMetadata,
} from "./execution-client";
import { createEditor, replaceSource, revealRange, showDiagnostics, spanToRange } from "./editor";
import { buildInfo } from "./generated/build-info";
import {
  isOk,
  type CheckResponse,
  type CompilerResponse,
  type CoreMetadata,
  type Diagnostic,
  type FormatResponse,
  type InspectResponse,
  type InspectionDocument,
  type IrResponse,
  type MetadataResponse,
  type PatchResponse,
} from "./protocol";
import "./styles.css";

const STORAGE_KEY = "quidra-playground/source";

const SAMPLE = `// Quidra: maximum meaning per token.

string name = "Quidra"
int answer = 6 * 7
print("Hello, {name}")
print(NL)
print("answer = {answer}")
print(NL)
`;

// --- tiny DOM helpers ------------------------------------------------------

function need<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
}

/** The only way text reaches the page. */
function setText(element: HTMLElement, text: string): void {
  element.textContent = text;
}

const ui = {
  editorHost: need<HTMLDivElement>("editor"),
  filename: need<HTMLSpanElement>("filename"),
  tagline: need<HTMLParagraphElement>("tagline"),
  playgroundVersion: need<HTMLElement>("info-playground-version"),
  core: need<HTMLElement>("info-core"),
  formats: need<HTMLElement>("info-formats"),
  status: need<HTMLElement>("status"),
  diagnostics: need<HTMLUListElement>("diagnostics"),
  diagnosticsEmpty: need<HTMLParagraphElement>("diagnostics-empty"),
  problemCount: need<HTMLSpanElement>("problem-count"),
  irOutput: need<HTMLPreElement>("ir-output"),
  irEmpty: need<HTMLParagraphElement>("ir-empty"),
  inspectOutput: need<HTMLPreElement>("inspect-output"),
  inspectEmpty: need<HTMLParagraphElement>("inspect-empty"),
  patchInput: need<HTMLTextAreaElement>("patch-input"),
  patchOutput: need<HTMLPreElement>("patch-output"),
  executionOutput: need<HTMLPreElement>("execution-output"),
  executionEmpty: need<HTMLParagraphElement>("execution-empty"),
  executionMeta: need<HTMLParagraphElement>("execution-meta"),
  executionNote: need<HTMLElement>("execution-note"),
  buildButton: need<HTMLButtonElement>("action-build"),
  runButton: need<HTMLButtonElement>("action-run"),
};

// --- tabs ------------------------------------------------------------------

const TABS = ["problems", "output", "ir", "inspect", "patch"] as const;
type TabName = (typeof TABS)[number];

function selectTab(name: TabName): void {
  for (const tab of TABS) {
    const button = need<HTMLButtonElement>(`tab-${tab}`);
    const panel = need<HTMLDivElement>(`panel-${tab}`);
    const selected = tab === name;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
}

function wireTabs(): void {
  TABS.forEach((tab, index) => {
    const button = need<HTMLButtonElement>(`tab-${tab}`);
    button.addEventListener("click", () => selectTab(tab));
    button.addEventListener("keydown", (event: KeyboardEvent) => {
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      const next = TABS[(index + delta + TABS.length) % TABS.length];
      if (!next) return;
      selectTab(next);
      need<HTMLButtonElement>(`tab-${next}`).focus();
    });
  });
}

// --- status ----------------------------------------------------------------

function setStatus(message: string, state: "" | "ok" | "error" = ""): void {
  setText(ui.status, message);
  if (state) ui.status.dataset.state = state;
  else delete ui.status.dataset.state;
}

// --- diagnostics -----------------------------------------------------------

let editor: EditorView;

function renderDiagnostics(diagnostics: Diagnostic[], truncated: boolean): void {
  ui.diagnostics.replaceChildren();
  ui.problemCount.textContent = String(diagnostics.length);
  ui.problemCount.dataset.state = diagnostics.length > 0 ? "errors" : "clean";

  if (diagnostics.length === 0) {
    ui.diagnosticsEmpty.hidden = false;
    setText(ui.diagnosticsEmpty, "No problems. The source passes the Quidra checker.");
    showDiagnostics(editor, []);
    return;
  }
  ui.diagnosticsEmpty.hidden = true;

  for (const diagnostic of diagnostics) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "diagnostic";

    const head = document.createElement("span");
    head.className = "diagnostic-head";

    const location = document.createElement("span");
    location.className = "diagnostic-location";
    setText(location, `${diagnostic.span.start.line}:${diagnostic.span.start.column}`);

    const code = document.createElement("span");
    code.className = "diagnostic-code";
    setText(code, diagnostic.code);

    const message = document.createElement("span");
    message.className = "diagnostic-message";
    setText(message, diagnostic.message);

    head.append(location, code);
    button.append(head, message);

    button.addEventListener("click", () => {
      const { from, to } = spanToRange(editor, diagnostic);
      revealRange(editor, from, to);
    });

    item.append(button);
    ui.diagnostics.append(item);
  }

  if (truncated) {
    const item = document.createElement("li");
    const note = document.createElement("p");
    note.className = "empty";
    setText(note, "The compiler stopped after its error limit; fix these and check again.");
    item.append(note);
    ui.diagnostics.append(item);
  }

  showDiagnostics(editor, diagnostics);
}

/** Render whatever diagnostics a failure carried, and report the rest plainly. */
function reportFailure(response: CompilerResponse, context: string): void {
  if (response.ok) return;
  const diagnostics = response.error.diagnostics ?? [];
  if (diagnostics.length > 0) {
    renderDiagnostics(diagnostics, response.error.truncated ?? false);
    selectTab("problems");
    setStatus(`${context}: the source does not check.`, "error");
    return;
  }
  setStatus(`${context}: ${response.error.message}`, "error");
}

// --- operations ------------------------------------------------------------

let client: CompilerClient;
const executionClient = ExecutionClient.fromEnvironment();
let metadata: CoreMetadata | null = null;
let runnerMetadata: RunnerMetadata | null = null;
let executionReady = false;
let executionBusy = false;
let lastInspection: InspectionDocument | null = null;

function source(): string {
  return editor.state.doc.toString();
}

async function runCheck(announce = true): Promise<void> {
  try {
    const response = await client.check(source());
    if (isOk<CheckResponse>(response, "check")) {
      renderDiagnostics(response.diagnostics, response.truncated);
      if (announce) {
        setStatus(
          response.valid
            ? "Checked: no problems."
            : `Checked: ${response.diagnostics.length} problem(s).`,
          response.valid ? "ok" : "error",
        );
      }
      return;
    }
    reportFailure(response, "Check");
  } catch (error) {
    setStatus(`Check failed: ${(error as Error).message}`, "error");
  }
}

async function runFormat(): Promise<void> {
  try {
    const response = await client.format(source());
    if (isOk<FormatResponse>(response, "format")) {
      if (!response.changed) {
        setStatus("Already formatted.", "ok");
        return;
      }
      replaceSource(editor, response.source);
      setStatus("Formatted.", "ok");
      void runCheck(false);
      return;
    }
    reportFailure(response, "Format");
  } catch (error) {
    setStatus(`Format failed: ${(error as Error).message}`, "error");
  }
}

async function runIr(): Promise<void> {
  selectTab("ir");
  try {
    const response = await client.ir(source());
    if (isOk<IrResponse>(response, "ir")) {
      ui.irEmpty.hidden = true;
      setText(ui.irOutput, response.text);
      setStatus(`Lowered to typed Quidra IR (format ${response.ir_version}).`, "ok");
      return;
    }
    setText(ui.irOutput, "");
    ui.irEmpty.hidden = false;
    setText(ui.irEmpty, "IR needs a program that checks.");
    reportFailure(response, "IR");
  } catch (error) {
    setStatus(`IR failed: ${(error as Error).message}`, "error");
  }
}

async function runInspect(): Promise<void> {
  selectTab("inspect");
  try {
    const response = await client.inspect(source());
    if (isOk<InspectResponse>(response, "inspect")) {
      lastInspection = response.inspection;
      ui.inspectEmpty.hidden = true;
      setText(ui.inspectOutput, JSON.stringify(response.inspection, null, 2));
      setStatus(`Inspected: ${response.inspection.nodes.length} nodes.`, "ok");
      return;
    }
    setText(ui.inspectOutput, "");
    ui.inspectEmpty.hidden = false;
    setText(ui.inspectEmpty, "Inspect needs a program that checks.");
    reportFailure(response, "Inspect");
  } catch (error) {
    setStatus(`Inspect failed: ${(error as Error).message}`, "error");
  }
}

function syncExecutionButtons(): void {
  const disabled = !executionReady || executionBusy;
  ui.buildButton.disabled = disabled;
  ui.runButton.disabled = disabled;
}

function setExecutionNote(message: string): void {
  setText(ui.executionNote, message);
}

async function configureExecution(): Promise<void> {
  executionReady = false;
  runnerMetadata = null;
  syncExecutionButtons();

  if (!executionClient) {
    setExecutionNote("Build/Run disabled: this deployment has no native runner configured.");
    return;
  }
  if (!metadata) return;

  setExecutionNote("Connecting to native runner…");
  try {
    const runner = await executionClient.metadata();
    if (runner.api_version !== RUNNER_API_VERSION) {
      throw new Error(
        `runner API v${runner.api_version} does not match page API v${RUNNER_API_VERSION}`,
      );
    }
    if (!runner.operations.includes("build") || !runner.operations.includes("run")) {
      throw new Error("runner does not provide both Build and Run");
    }
    if (runner.version === "unknown" || runner.version !== metadata.version) {
      throw new Error(
        `Version mismatch: page ${metadata.version}, runner ${runner.version}`,
      );
    }
    if (runner.core_commit === "unknown" || runner.core_commit !== metadata.core_commit) {
      throw new Error(
        `Core mismatch: page ${shortSha(metadata.core_commit)}, runner ${shortSha(runner.core_commit)}`,
      );
    }

    runnerMetadata = runner;
    executionReady = true;
    syncExecutionButtons();
    setExecutionNote(
      `Native Build/Run ready · Quidra ${runner.version} · Core ${shortSha(runner.core_commit)} · source is uploaded only when you Build or Run.`,
    );
  } catch (error) {
    setExecutionNote(`Build/Run unavailable: ${(error as Error).message}`);
  }
}

async function checkBeforeExecution(operation: ExecutionOperation, program: string): Promise<boolean> {
  try {
    const response = await client.check(program);
    if (isOk<CheckResponse>(response, "check")) {
      renderDiagnostics(response.diagnostics, response.truncated);
      if (response.valid) return true;
      selectTab("problems");
      setStatus(
        `${operation === "build" ? "Build" : "Run"} blocked: fix the compiler errors first.`,
        "error",
      );
      return false;
    }
    reportFailure(response, operation === "build" ? "Build" : "Run");
  } catch (error) {
    setStatus(
      `${operation === "build" ? "Build" : "Run"} check failed: ${(error as Error).message}`,
      "error",
    );
  }
  return false;
}

function renderExecution(result: ExecutionResult): void {
  ui.executionEmpty.hidden = true;
  const chunks: string[] = [];
  if (result.stdout) chunks.push(result.stdout.replace(/\s+$/, ""));
  if (result.stderr) {
    chunks.push(`[stderr]\n${result.stderr.replace(/\s+$/, "")}`);
  }
  if (result.stdout_truncated || result.stderr_truncated) {
    chunks.push("[output truncated]");
  }
  setText(ui.executionOutput, chunks.join("\n\n") || "Completed with no output.");

  const exit = result.exit_code === null ? "no exit code" : `exit ${result.exit_code}`;
  setText(
    ui.executionMeta,
    `${result.operation} · ${exit} · ${result.elapsed_ms} ms · ${result.version}`,
  );
  selectTab("output");
  setStatus(
    result.timed_out
      ? `${result.operation === "build" ? "Build" : "Run"} timed out.`
      : result.ok
        ? `${result.operation === "build" ? "Build" : "Run"} succeeded.`
        : `${result.operation === "build" ? "Build" : "Run"} failed (${exit}).`,
    result.ok ? "ok" : "error",
  );
}

async function runNative(operation: ExecutionOperation): Promise<void> {
  if (!executionClient || !metadata || !runnerMetadata || !executionReady || executionBusy) {
    setStatus("Native Build/Run is not available in this deployment.", "error");
    return;
  }

  const program = source();
  const bytes = new TextEncoder().encode(program).length;
  if (bytes > runnerMetadata.max_source_bytes) {
    setStatus(
      `Source is ${bytes} bytes; runner limit is ${runnerMetadata.max_source_bytes} bytes.`,
      "error",
    );
    return;
  }

  executionBusy = true;
  syncExecutionButtons();
  try {
    if (!(await checkBeforeExecution(operation, program))) return;
    if (source() !== program) {
      setStatus(
        `${operation === "build" ? "Build" : "Run"} cancelled: source changed while checking; press again.`,
        "error",
      );
      return;
    }

    selectTab("output");
    ui.executionEmpty.hidden = true;
    setText(ui.executionOutput, operation === "build" ? "Building…" : "Running…");
    setText(ui.executionMeta, "");
    setStatus(operation === "build" ? "Building with native Quidra…" : "Running with native Quidra…");

    const result = await executionClient.execute(operation, program);
    if (
      result.api_version !== RUNNER_API_VERSION ||
      result.version !== metadata.version ||
      result.core_commit !== metadata.core_commit
    ) {
      executionReady = false;
      setExecutionNote("Build/Run disabled: runner identity changed; reload after the runner is updated.");
      throw new Error("runner identity changed during the request");
    }
    renderExecution(result);
  } catch (error) {
    setText(ui.executionOutput, "");
    ui.executionEmpty.hidden = false;
    setText(ui.executionMeta, "");
    setStatus(
      `${operation === "build" ? "Build" : "Run"} failed: ${(error as Error).message}`,
      "error",
    );
  } finally {
    executionBusy = false;
    syncExecutionButtons();
  }
}

/**
 * Builds a patch skeleton from the latest inspection so the revision, node id
 * and hash are the compiler's own values rather than something hand-copied.
 */
function fillPatchTemplate(): void {
  if (!lastInspection || lastInspection.nodes.length === 0) {
    setStatus("Run Inspect first: a patch is keyed by node id and content hash.", "error");
    selectTab("patch");
    return;
  }
  // Prefer the smallest node that carries its own text: replacing a literal
  // is a legible first edit, whereas the outermost node is the whole program.
  const span = (candidate: { span?: { start: { offset: number }; end: { offset: number } } }) =>
    candidate.span ? candidate.span.end.offset - candidate.span.start.offset : Number.MAX_SAFE_INTEGER;
  const node = lastInspection.nodes
    .filter((candidate) => candidate.source !== undefined && candidate.source !== "")
    .sort((a, b) => span(a) - span(b))[0] ?? lastInspection.nodes[0];
  if (!node) return;
  ui.patchInput.value = JSON.stringify(
    {
      schema_version: 2,
      base_revision: lastInspection.revision,
      operations: [
        {
          op: "replace_node",
          node_id: node.node_id,
          expected_hash: node.source_hash,
          expected_kind: node.kind,
          replacement: node.source ?? "",
        },
      ],
    },
    null,
    2,
  );
  setStatus("Patch template filled from the last Inspect. Edit 'replacement', then Apply.");
}

async function applyPatch(): Promise<void> {
  selectTab("patch");
  const patch = ui.patchInput.value.trim();
  if (patch === "") {
    setStatus("Enter a patch JSON document first.", "error");
    return;
  }
  try {
    const response = await client.patch(source(), patch);
    if (response.ok) {
      if (!isOk<PatchResponse>(response, "patch")) {
        setStatus("The compiler answered a different operation than it was asked.", "error");
        return;
      }
      replaceSource(editor, response.source);
      setText(
        ui.patchOutput,
        `applied\n  base revision ${response.base_revision}\n  new revision  ${response.revision}`,
      );
      setStatus("Patch applied; the result checks.", "ok");
      lastInspection = null;
      void runCheck(false);
      return;
    }
    // The source is deliberately left exactly as it was.
    const detail = [
      `refused (${response.error.kind})`,
      response.error.code ? `  code ${response.error.code}` : "",
      `  ${response.error.message}`,
      "  the source is unchanged",
    ]
      .filter(Boolean)
      .join("\n");
    setText(ui.patchOutput, detail);
    if (response.error.diagnostics?.length) {
      renderDiagnostics(response.error.diagnostics, false);
    }
    setStatus("Patch refused; the source is unchanged.", "error");
  } catch (error) {
    setStatus(`Patch failed: ${(error as Error).message}`, "error");
  }
}

// --- metadata --------------------------------------------------------------

function shortSha(sha: string): string {
  return /^[0-9a-f]{7,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

async function loadMetadata(): Promise<void> {
  const response = await client.metadata();
  if (!isOk<MetadataResponse>(response, "metadata")) {
    setStatus("The compiler did not report its version.", "error");
    return;
  }
  metadata = response.metadata;

  // The version on screen is the compiler's own answer. The playground has no
  // version of its own to display and never guesses one.
  setText(ui.playgroundVersion, metadata.version);
  setText(
    ui.core,
    `${metadata.version} @ ${shortSha(metadata.core_commit)}` +
      (buildInfo.playgroundCommit !== "unknown"
        ? ` · ui ${shortSha(buildInfo.playgroundCommit)}`
        : ""),
  );
  setText(ui.formats, `ir v${metadata.ir_version} · api v${metadata.wasm_schema_version}`);
  ui.core.title = `Core commit ${metadata.core_commit}\nPlayground commit ${buildInfo.playgroundCommit}`;
  setText(ui.tagline, metadata.tagline);
  setText(ui.filename, metadata.default_filename);
  document.title = `Quidra Playground ${metadata.version}`;
  void configureExecution();
}

// --- storage ---------------------------------------------------------------

function loadSource(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? SAMPLE;
  } catch {
    // Private mode, or storage disabled. The editor still works.
    return SAMPLE;
  }
}

function saveSource(text: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, text);
  } catch {
    // Nothing to do: persistence is a convenience, not a feature to report.
  }
}

// --- start -----------------------------------------------------------------

let checkTimer: number | undefined;

function scheduleCheck(): void {
  window.clearTimeout(checkTimer);
  checkTimer = window.setTimeout(() => void runCheck(false), 350);
}

function main(): void {
  wireTabs();
  selectTab("problems");

  editor = createEditor({
    parent: ui.editorHost,
    initialSource: loadSource(),
    onChange: (text) => {
      saveSource(text);
      lastInspection = null;
      if (client.currentStatus === "ready") scheduleCheck();
    },
  });

  client = new CompilerClient({
    // Resolved against the page, so the same bundle works at the site root and
    // under a subpath such as /playground/.
    glueUrl: new URL("wasm/quidra-core.js", document.baseURI).href,
    createWorker: () =>
      new Worker(new URL("./worker/compiler.worker.ts", import.meta.url), { type: "module" }),
    onStatusChange: (status: ClientStatus, detail) => {
      if (status === "ready") {
        setStatus("Compiler ready.", "ok");
        void loadMetadata().then(() => void runCheck(false));
      } else if (status === "failed") {
        setStatus(`The compiler could not be loaded: ${detail ?? "unknown error"}`, "error");
      } else {
        setStatus("Loading compiler…");
      }
    },
    onRestart: (reason) => {
      setStatus(`The compiler stopped (${reason}) and was restarted. Your source is intact.`, "error");
    },
  });

  ui.runButton.addEventListener("click", () => void runNative("run"));
  ui.buildButton.addEventListener("click", () => void runNative("build"));
  need<HTMLButtonElement>("action-check").addEventListener("click", () => void runCheck());
  need<HTMLButtonElement>("action-format").addEventListener("click", () => void runFormat());
  need<HTMLButtonElement>("action-ir").addEventListener("click", () => void runIr());
  need<HTMLButtonElement>("action-inspect").addEventListener("click", () => void runInspect());
  need<HTMLButtonElement>("action-patch").addEventListener("click", () => selectTab("patch"));
  need<HTMLButtonElement>("action-patch-template").addEventListener("click", fillPatchTemplate);
  need<HTMLButtonElement>("action-patch-apply").addEventListener("click", () => void applyPatch());
  need<HTMLButtonElement>("action-reset").addEventListener("click", () => {
    replaceSource(editor, SAMPLE);
    saveSource(SAMPLE);
    void runCheck();
  });

  window.addEventListener("keydown", (event: KeyboardEvent) => {
    const accel = event.metaKey || event.ctrlKey;
    if (accel && event.key === "Enter") {
      event.preventDefault();
      void runCheck();
    } else if (event.shiftKey && event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      void runFormat();
    }
  });
}

main();

// Exposed for the browser smoke test, which drives the page the way a visitor
// does and then asks what the compiler actually answered.
declare global {
  interface Window {
    __quidraPlayground?: {
      metadata: () => CoreMetadata | null;
      runnerMetadata: () => RunnerMetadata | null;
      source: () => string;
    };
  }
}
window.__quidraPlayground = {
  metadata: () => metadata,
  runnerMetadata: () => runnerMetadata,
  source: () => (editor ? editor.state.doc.toString() : ""),
};
