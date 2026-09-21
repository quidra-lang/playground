// The source editor.
//
// Quidra rejects a tab anywhere on a line and requires indentation in
// four-space levels, so the editor is configured to make that the only thing
// it can produce, and pasted tabs are converted on the way in.

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { bracketMatching, indentUnit } from "@codemirror/language";
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";

import { quidraLanguage } from "./quidra-language";
import type { Diagnostic } from "./protocol";

export const INDENT = "    ";

/**
 * Tabs are a hard error in Quidra, so they never reach the compiler from here.
 * Anything pasted is normalised once, at the point it enters the document.
 */
const normaliseTabs = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged) return transaction;
  let sawTab = false;
  const changes: { from: number; to: number; insert: string }[] = [];
  transaction.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
    const text = inserted.toString();
    if (!text.includes("\t")) return;
    sawTab = true;
    changes.push({ from: fromB, to: toB, insert: text.replace(/\t/g, INDENT) });
  });
  if (!sawTab) return transaction;
  return [transaction, { changes, sequential: true }];
});

export interface EditorOptions {
  parent: HTMLElement;
  initialSource: string;
  onChange: (source: string) => void;
}

export function createEditor(options: EditorOptions): EditorView {
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    bracketMatching(),
    highlightActiveLine(),
    lintGutter(),
    indentUnit.of(INDENT),
    EditorState.tabSize.of(INDENT.length),
    quidraLanguage,
    normaliseTabs,
    EditorView.lineWrapping,
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange(update.state.doc.toString());
    }),
  ];

  return new EditorView({
    parent: options.parent,
    state: EditorState.create({ doc: options.initialSource, extensions }),
  });
}

/** Clamp a compiler byte offset to a position this document actually has. */
function clampOffset(view: EditorView, offset: number): number {
  return Math.max(0, Math.min(offset, view.state.doc.length));
}

/**
 * Compiler spans are byte offsets into UTF-8; CodeMirror counts UTF-16 code
 * units. They agree only for ASCII, so the line/column the compiler also
 * reports is used to place the marker and the byte offset is used only to
 * measure the span's length.
 */
export function offsetFromLineColumn(
  view: EditorView,
  line: number,
  column: number,
  byteOffset: number,
): number {
  const lineCount = view.state.doc.lines;
  if (line < 1 || line > lineCount) return clampOffset(view, byteOffset);
  const docLine = view.state.doc.line(line);
  const text = docLine.text;

  // Walk the line's UTF-8 bytes until the compiler's column is reached.
  let bytes = 1;
  let index = 0;
  while (index < text.length && bytes < column) {
    const code = text.codePointAt(index) ?? 0;
    const width = code > 0xffff ? 2 : 1;
    const utf8 = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    bytes += utf8;
    index += width;
  }
  return clampOffset(view, docLine.from + index);
}

export function spanToRange(
  view: EditorView,
  diagnostic: Diagnostic,
): { from: number; to: number } {
  const from = offsetFromLineColumn(
    view,
    diagnostic.span.start.line,
    diagnostic.span.start.column,
    diagnostic.span.start.offset,
  );
  let to = offsetFromLineColumn(
    view,
    diagnostic.span.end.line,
    diagnostic.span.end.column,
    diagnostic.span.end.offset,
  );
  if (to <= from) to = Math.min(view.state.doc.length, from + 1);
  return { from, to };
}

export function showDiagnostics(view: EditorView, diagnostics: Diagnostic[]): void {
  const marks: CmDiagnostic[] = diagnostics.map((diagnostic) => {
    const { from, to } = spanToRange(view, diagnostic);
    return {
      from,
      to,
      severity: "error",
      // Plain text. Nothing the compiler produces is ever treated as markup.
      message: `${diagnostic.code}: ${diagnostic.message}`,
      source: "quidra",
    };
  });
  view.dispatch(setDiagnostics(view.state, marks));
}

/**
 * Replace the whole document with the compiler's formatting while keeping the
 * caret where the user left it, measured from the end of the document so that
 * a reflow above the cursor does not drag it to the wrong place.
 */
export function replaceSource(view: EditorView, next: string): void {
  const current = view.state.doc.toString();
  if (current === next) return;
  const selection = view.state.selection.main;
  const tailLength = current.length - selection.head;
  const head = Math.max(0, Math.min(next.length, next.length - tailLength));
  view.dispatch({
    changes: { from: 0, to: current.length, insert: next },
    selection: { anchor: head },
    scrollIntoView: true,
  });
}

export function revealRange(view: EditorView, from: number, to: number): void {
  view.dispatch({
    selection: { anchor: from, head: to },
    scrollIntoView: true,
  });
  view.focus();
}
