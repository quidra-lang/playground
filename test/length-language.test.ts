import { highlightTree, classHighlighter } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { quidraLanguage } from "../src/quidra-language";

describe("length shorthand highlighting", () => {
  it("styles # as an operator while preserving literal and comment hashes", () => {
    const source = 'count := #values\ntext := "#literal"\n// #comment\n';
    const spans: Array<{ text: string; classes: string }> = [];
    highlightTree(quidraLanguage.parser.parse(source), classHighlighter, (from, to, classes) => {
      spans.push({ text: source.slice(from, to), classes });
    });
    expect(spans.some((span) => span.text.includes("#") && span.classes.includes("tok-operator"))).toBe(true);
    expect(spans.some((span) => span.text.includes("#literal") && span.classes.includes("tok-string"))).toBe(true);
    expect(spans.some((span) => span.text.includes("#comment") && span.classes.includes("tok-comment"))).toBe(true);
  });
});

describe("integer factorial and matrix multiplication highlighting", () => {
  it.each([
    ['factorial := value!', '!'],
    ['product := left @ right', '@'],
    ['different := left != right', '!='],
  ])("styles the operator in %s", (source, operator) => {
    const operators: string[] = [];
    highlightTree(quidraLanguage.parser.parse(source), classHighlighter, (from, to, classes) => {
      if (classes.includes("tok-operator")) operators.push(source.slice(from, to));
    });
    expect(operators).toContain(operator);
  });

  it("keeps operator-shaped string and comment contents intact", () => {
    const source = 'text := "!@"\n// !@\n';
    const spans: Array<{ text: string; classes: string }> = [];
    highlightTree(quidraLanguage.parser.parse(source), classHighlighter, (from, to, classes) => {
      spans.push({ text: source.slice(from, to), classes });
    });
    expect(spans.some((span) => span.text.includes("!@") && span.classes.includes("tok-string"))).toBe(true);
    expect(spans.some((span) => span.text.includes("!@") && span.classes.includes("tok-comment"))).toBe(true);
    expect(spans.some((span) => span.text.includes("!@") && span.classes.includes("tok-operator"))).toBe(false);
  });
});
