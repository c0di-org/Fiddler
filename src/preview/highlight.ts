/**
 * Syntax highlighting that costs nothing for the code you can't see.
 *
 * The usual approach — tokenise the whole file, hand a tree to the renderer —
 * falls over on the files a browser opens by accident: a 40,000-line lockfile
 * becomes a million token objects before a single pixel is drawn. So this splits
 * the work in two. One linear scan computes only what a line needs to know from
 * the lines above it (am I inside a block comment?), which is a byte per line.
 * Tokenising itself happens per line, on demand, for the sixty or so lines
 * actually on screen.
 *
 * The result is a highlighter whose cost tracks the viewport rather than the
 * file, and which stays correct when you jump to the middle of one.
 */

export type Kind = "txt" | "cmt" | "str" | "key" | "kw" | "num" | "typ" | "pun";

export interface Token {
  k: Kind;
  v: string;
}

/** Entry state for a line. Anything but `Normal` came from the line above. */
export const State = { Normal: 0, Block: 1 } as const;
export type State = (typeof State)[keyof typeof State];

interface Lang {
  line: string[];
  block?: [string, string];
  /** Quote characters that behave like strings, with backslash escapes. */
  quotes: string;
  keywords: Set<string>;
  types: Set<string>;
  /** JSON-ish files where `"a":` is a key rather than a plain string. */
  keyed?: boolean;
}

const WORDS = {
  js: "as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public return satisfies set static super switch this throw try typeof var void while with yield",
  rust: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
  py: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
  c: "auto break case catch class const constexpr continue default delete do else enum explicit extern final for friend goto if inline namespace new operator override private protected public return sizeof static struct switch template this throw try typedef typename union using virtual void volatile while",
  swift: "as associatedtype break case catch class continue default defer deinit do else enum extension fallthrough fileprivate for func guard if import in init inout internal is let open operator private protocol public repeat return self static struct subscript super switch throw throws try typealias var where while",
  rb: "alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield",
  sh: "case do done elif else esac fi for function if in local return select then time until while export source alias unset readonly",
  sql: "select from where group by order having join left right inner outer on as insert into values update set delete create table drop alter index view union all distinct limit offset and or not null primary key foreign references",
  css: "important media supports keyframes import charset font-face and not only from to",
};

const TYPES = {
  js: "string number boolean any unknown never object symbol bigint void null undefined true false Array Promise Record Map Set Date RegExp Error JSON Math console window document",
  rust: "bool char str String Vec Option Result Box Rc Arc HashMap HashSet u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f32 f64 true false None Some Ok Err",
  py: "True False None int str float bool list dict set tuple bytes object self cls",
  go: "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr true false nil iota",
  c: "bool char double float int long short signed unsigned size_t string vector true false nullptr NULL var val",
  swift: "Int Double Float String Bool Array Dictionary Set Optional Any AnyObject Void true false nil",
  rb: "Integer String Float Array Hash Symbol Proc Lambda",
  sh: "true false",
  sql: "int integer text varchar boolean timestamp date serial bigint numeric true false",
  css: "",
};

const set = (words: string) => new Set(words.split(/\s+/).filter(Boolean));

function lang(
  line: string[],
  quotes: string,
  words: string,
  types: string,
  block?: [string, string],
  keyed?: boolean
): Lang {
  return { line, quotes, keywords: set(words), types: set(types), block, keyed };
}

const C_STYLE = (words: string, types: string) =>
  lang(["//"], "\"'`", words, types, ["/*", "*/"]);

const LANGS: Record<string, Lang> = {
  js: C_STYLE(WORDS.js, TYPES.js),
  rust: C_STYLE(WORDS.rust, TYPES.rust),
  go: C_STYLE(WORDS.go, TYPES.go),
  c: C_STYLE(WORDS.c, TYPES.c),
  swift: C_STYLE(WORDS.swift, TYPES.swift),
  css: lang([], "\"'", WORDS.css, TYPES.css, ["/*", "*/"]),
  py: lang(["#"], "\"'", WORDS.py, TYPES.py),
  rb: lang(["#"], "\"'", WORDS.rb, TYPES.rb),
  sh: lang(["#"], "\"'", WORDS.sh, TYPES.sh),
  sql: lang(["--"], "'\"", WORDS.sql, TYPES.sql, ["/*", "*/"]),
  // Data formats have no keywords worth the name; what matters is telling the
  // key apart from the value.
  json: lang([], "\"'", "", "true false null", undefined, true),
  yaml: lang(["#"], "\"'", "", "true false null yes no on off", undefined, true),
  toml: lang(["#"], "\"'", "", "true false", undefined, true),
  xml: lang([], "\"'", "", "", ["<!--", "-->"]),
};

const BY_EXT: Record<string, keyof typeof LANGS> = {
  ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", vue: "js", svelte: "js",
  rs: "rust",
  go: "go",
  py: "py",
  rb: "rb", gemfile: "rb",
  swift: "swift",
  c: "c", h: "c", cpp: "c", cc: "c", cxx: "c", hpp: "c", hh: "c", cs: "c", java: "c",
  kt: "c", kts: "c", gradle: "c", scala: "c", dart: "c", php: "c", zig: "c", sol: "c",
  proto: "c", graphql: "c",
  css: "css", scss: "css", sass: "css", less: "css",
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh", env: "sh",
  sql: "sql",
  json: "json", jsonc: "json", json5: "json", lock: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "toml", cfg: "toml", conf: "toml", properties: "toml",
  xml: "xml", html: "xml", htm: "xml", plist: "xml", svg: "xml",
};

const BY_NAME: Record<string, keyof typeof LANGS> = {
  Makefile: "sh",
  Dockerfile: "sh",
  Justfile: "sh",
  Procfile: "sh",
  Gemfile: "rb",
  Rakefile: "rb",
  ".zshrc": "sh",
  ".bashrc": "sh",
  ".profile": "sh",
  ".env": "sh",
  ".gitignore": "sh",
  ".gitattributes": "sh",
  ".npmrc": "toml",
  ".editorconfig": "toml",
};

/** The grammar to read this file with, or `null` for "just show the text". */
export function grammarFor(nameOrPath: string): Lang | null {
  const name = nameOrPath.split("/").pop() ?? nameOrPath;
  const named = BY_NAME[name];
  if (named) return LANGS[named];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const key = BY_EXT[name.slice(dot + 1).toLowerCase()];
  return key ? LANGS[key] : null;
}

/** A grammar named by a markdown fence's info string. */
export function grammarNamed(info: string): Lang | null {
  if (!info) return null;
  const key = BY_EXT[info.toLowerCase()] ?? (info in LANGS ? (info as keyof typeof LANGS) : null);
  return key ? LANGS[key] : null;
}

/**
 * One byte per line: what a line needs to know from everything above it. This is
 * the only pass that touches the whole file, and it does nothing but count
 * comment delimiters.
 */
export function scan(lines: string[], grammar: Lang | null): Uint8Array {
  const states = new Uint8Array(lines.length);
  if (!grammar?.block) return states;

  const [open, close] = grammar.block;
  let state: State = State.Normal;

  for (let i = 0; i < lines.length; i++) {
    states[i] = state;
    const line = lines[i];
    // Cheap reject: most lines contain neither delimiter.
    if (!line.includes(open[0]) && !line.includes(close[0])) continue;

    let at = 0;
    while (at < line.length) {
      if (state === State.Block) {
        const end = line.indexOf(close, at);
        if (end < 0) break;
        at = end + close.length;
        state = State.Normal;
      } else {
        const start = line.indexOf(open, at);
        if (start < 0) break;
        at = start + open.length;
        state = State.Block;
      }
    }
  }
  return states;
}

const WORD = /[A-Za-z_$][\w$-]*/y;
const NUMBER = /(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)[a-zA-Z%]*/y;
const PUNCT = "{}[]()<>;,.:?!+-*/%=&|^~@#";

/** Split one line into spans. Called only for lines that are on screen. */
export function tokenize(line: string, entry: State, grammar: Lang | null): Token[] {
  if (!grammar) return line ? [{ k: "txt", v: line }] : [];

  const out: Token[] = [];
  let text = "";
  let i = 0;
  let state = entry;

  const flush = () => {
    if (text) {
      out.push({ k: "txt", v: text });
      text = "";
    }
  };
  const push = (k: Kind, v: string) => {
    flush();
    out.push({ k, v });
  };

  if (state === State.Block && grammar.block) {
    const end = line.indexOf(grammar.block[1]);
    if (end < 0) return [{ k: "cmt", v: line }];
    push("cmt", line.slice(0, end + grammar.block[1].length));
    i = end + grammar.block[1].length;
  }

  while (i < line.length) {
    const rest = line.slice(i);

    if (grammar.block && rest.startsWith(grammar.block[0])) {
      const end = line.indexOf(grammar.block[1], i + grammar.block[0].length);
      const to = end < 0 ? line.length : end + grammar.block[1].length;
      push("cmt", line.slice(i, to));
      i = to;
      continue;
    }

    const comment = grammar.line.find((m) => rest.startsWith(m));
    if (comment) {
      push("cmt", rest);
      break;
    }

    const c = line[i];

    if (grammar.quotes.includes(c)) {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") j += 2;
        else if (line[j] === c) {
          j++;
          break;
        } else j++;
      }
      const value = line.slice(i, Math.min(j, line.length));
      // In a config file the thing before the colon is the name of a setting,
      // and colouring it like a value makes the file much harder to skim.
      const after = line.slice(j).trimStart();
      push(grammar.keyed && after.startsWith(":") ? "key" : "str", value);
      i += value.length;
      continue;
    }

    WORD.lastIndex = i;
    const word = WORD.exec(line);
    if (word && word.index === i) {
      const v = word[0];
      const kind: Kind = grammar.keywords.has(v)
        ? "kw"
        : grammar.types.has(v)
          ? "typ"
          : // A bare word at the head of a YAML or TOML line is a key.
            grammar.keyed && line.slice(i + v.length).trimStart().startsWith(":") && !line.slice(0, i).trim()
            ? "key"
            : "txt";
      if (kind === "txt") text += v;
      else push(kind, v);
      i += v.length;
      continue;
    }

    NUMBER.lastIndex = i;
    const num = NUMBER.exec(line);
    if (num && num.index === i && /\d/.test(num[0][0])) {
      push("num", num[0]);
      i += num[0].length;
      continue;
    }

    if (PUNCT.includes(c)) {
      push("pun", c);
      i++;
      continue;
    }

    text += c;
    i++;
  }

  flush();
  return out;
}
