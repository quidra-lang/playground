// The contract between the page, the worker and the WebAssembly bridge.
//
// These types mirror src/wasm_api.cpp in quidra-lang/quidra one-for-one. The
// playground does not interpret compiler behaviour anywhere else: if a field is
// not in this file, the UI does not get to infer it.

/**
 * Version of the request/response envelope, deliberately independent of the
 * Quidra product version. The compiler may reach 0.4.0 while this is still 1.
 * It must equal the `wasm_schema_version` the loaded module reports.
 */
export const WASM_SCHEMA_VERSION = 1;

/** The single virtual file the playground edits. */
export const DEFAULT_FILENAME = "main.qui";

export type Operation =
  | "check"
  | "format"
  | "ir"
  | "inspect"
  | "patch"
  | "patch_schema"
  | "metadata";

export interface Position {
  offset: number;
  line: number;
  column: number;
}

export interface Span {
  start: Position;
  end: Position;
}

export interface Diagnostic {
  severity: "error";
  code: string;
  message: string;
  span: Span;
}

export interface CompilerRequest {
  schema_version: number;
  operation: Operation;
  filename?: string;
  source?: string;
  patch?: string;
  max_errors?: number;
  include_source?: boolean;
  include_effects?: boolean;
  kind?: string;
  max_depth?: number;
}

export interface ErrorBody {
  kind:
    | "invalid_request"
    | "unsupported_schema_version"
    | "unknown_operation"
    | "compile_failed"
    | "patch_failed"
    | "patch_rejected"
    | "internal";
  message: string;
  /** Present when the failure was the source not checking. */
  diagnostics?: Diagnostic[];
  truncated?: boolean;
  /** Present on patch failures. */
  code?: string;
  span?: Span;
  node_id?: string;
}

interface EnvelopeBase {
  schema_version: number;
  operation: Operation | "unknown";
}

export interface FailureResponse extends EnvelopeBase {
  ok: false;
  error: ErrorBody;
}

export interface CheckResponse extends EnvelopeBase {
  ok: true;
  operation: "check";
  valid: boolean;
  diagnostics: Diagnostic[];
  truncated: boolean;
}

export interface FormatResponse extends EnvelopeBase {
  ok: true;
  operation: "format";
  source: string;
  changed: boolean;
}

export interface IrResponse extends EnvelopeBase {
  ok: true;
  operation: "ir";
  text: string;
  ir_version: string;
}

export interface InspectResponse extends EnvelopeBase {
  ok: true;
  operation: "inspect";
  inspection: InspectionDocument;
}

export interface InspectionNode {
  node_id: string;
  kind: string;
  source_hash: string;
  span?: Span;
  source?: string;
  type?: string;
  authority?: string;
  parent_id?: string;
  depth?: number;
}

export interface InspectionDocument {
  revision: string;
  nodes: InspectionNode[];
  [key: string]: unknown;
}

export interface PatchResponse extends EnvelopeBase {
  ok: true;
  operation: "patch";
  base_revision: string;
  revision: string;
  source: string;
}

export interface PatchSchemaResponse extends EnvelopeBase {
  ok: true;
  operation: "patch_schema";
  schema: unknown;
}

export interface CoreMetadata {
  product_version: string;
  language_version: string;
  ir_version: string;
  core_commit: string;
  wasm_schema_version: number;
  language_name: string;
  source_extension: string;
  default_filename: string;
  tagline: string;
}

export interface MetadataResponse extends EnvelopeBase {
  ok: true;
  operation: "metadata";
  metadata: CoreMetadata;
}

export type SuccessResponse =
  | CheckResponse
  | FormatResponse
  | IrResponse
  | InspectResponse
  | PatchResponse
  | PatchSchemaResponse
  | MetadataResponse;

export type CompilerResponse = SuccessResponse | FailureResponse;

/** Narrow a response to the successful shape for a given operation. */
export function isOk<T extends SuccessResponse>(
  response: CompilerResponse,
  operation: T["operation"],
): response is T {
  return response.ok && response.operation === operation;
}

// --- worker transport -----------------------------------------------------

export interface WorkerRequestMessage {
  id: number;
  request: CompilerRequest;
}

/**
 * Sent once, before any request. The page resolves the module URL against
 * `document.baseURI` and hands it over, because a worker bundled into
 * `assets/` cannot compute it: the relative depth differs between the dev
 * server and a production build, and again under a subpath such as
 * `/playground/`.
 */
export interface WorkerInitMessage {
  id: -1;
  glueUrl: string;
}

export type WorkerInbound = WorkerInitMessage | WorkerRequestMessage;

export function isInitMessage(message: WorkerInbound): message is WorkerInitMessage {
  return message.id === -1;
}

export type WorkerResponseMessage =
  | { id: number; ok: true; response: CompilerResponse }
  | { id: number; ok: false; error: string };

/** Sent unprompted when the module finishes loading or fails to. */
export type WorkerStatusMessage =
  | { id: 0; status: "ready" }
  | { id: 0; status: "failed"; error: string };

export type WorkerOutbound = WorkerResponseMessage | WorkerStatusMessage;

export function isStatusMessage(message: WorkerOutbound): message is WorkerStatusMessage {
  return message.id === 0 && "status" in message;
}
