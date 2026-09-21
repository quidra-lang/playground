// Lexical highlighting for Quidra.
//
// This is a highlighter, not a parser. It recognises comments, strings,
// numbers, keywords and known names, and nothing else: the playground has
// exactly one opinion about what a program means, and it comes from the
// compiler. Where a token is genuinely ambiguous without type information --
// `<` as a generic bracket or a comparison, `&` as an address, a reference or
// a declaration -- it is left unstyled rather than guessed at.
//
// The word lists are generated from the Core checkout by
// scripts/prepare-core.mjs, so they cannot drift from the compiler by hand.

import { StreamLanguage, type StringStream } from "@codemirror/language";
import { BUILTINS, KEYWORDS, STANDARD_MODULES, TYPE_NAMES } from "./generated/tokens";

const keywords = new Set(KEYWORDS);
const typeNames = new Set(TYPE_NAMES);
const builtins = new Set(BUILTINS);
const standardModules = new Set(STANDARD_MODULES);

interface QuidraState {
  /** Inside a `"""`-style block string, if the language grows one. */
  inString: boolean;
}

function readString(stream: StringStream): void {
  let escaped = false;
  let next: string | void;
  while ((next = stream.next()) != null) {
    if (!escaped && next === '"') return;
    escaped = !escaped && next === "\\";
  }
}

export const quidraLanguage = StreamLanguage.define<QuidraState>({
  name: "quidra",

  startState(): QuidraState {
    return { inString: false };
  },

  token(stream, _state): string | null {
    if (stream.eatSpace()) return null;

    // Comments run to end of line.
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }

    if (stream.peek() === '"') {
      stream.next();
      readString(stream);
      return "string";
    }

    // Numbers. Quidra has no base prefixes, so decimal with an optional
    // fraction and exponent is the whole story.
    if (/[0-9]/.test(stream.peek() ?? "")) {
      stream.eatWhile(/[0-9_]/);
      if (stream.peek() === "." && /[0-9]/.test(stream.string.charAt(stream.pos + 1))) {
        stream.next();
        stream.eatWhile(/[0-9_]/);
      }
      if (stream.peek() === "e" || stream.peek() === "E") {
        const save = stream.pos;
        stream.next();
        if (stream.peek() === "+" || stream.peek() === "-") stream.next();
        if (/[0-9]/.test(stream.peek() ?? "")) stream.eatWhile(/[0-9]/);
        else stream.pos = save;
      }
      return "number";
    }

    if (/[A-Za-z_]/.test(stream.peek() ?? "")) {
      stream.eatWhile(/[A-Za-z0-9_]/);
      const word = stream.current();

      if (word === "true" || word === "false") return "bool";
      // AND / OR / XOR / NOT are fixed-width integer bit operations and read
      // as operators, not as the boolean keywords they shadow in lowercase.
      if (word === word.toUpperCase() && keywords.has(word)) return "operator";
      if (keywords.has(word)) return "keyword";
      if (typeNames.has(word)) return "typeName";
      if (builtins.has(word)) return "function";
      if (standardModules.has(word) && stream.peek() === ".") return "namespace";
      // A capitalised name is a user type by convention only; styling it as a
      // type is a display choice, not a claim about what the compiler resolved.
      if (/^[A-Z]/.test(word)) return "typeName";
      return "variableName";
    }

    // Operators that carry one stable job each.
    if (stream.match(/^(==|!=|<=|>=|\+=|-=|\*=|\/=|%=|<<|>>)/)) return "operator";
    if (stream.match(/^[+\-*/%=<>!]/)) return "operator";
    if (stream.match(/^[|]/)) return "punctuation";
    if (stream.match(/^[&]/)) return "punctuation";
    if (stream.match(/^[(){}[\],:.]/)) return "punctuation";

    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { line: "//" },
    // Quidra rejects a tab anywhere on a line and requires four-space levels.
    indentOnInput: /^\s*$/,
  },
});
