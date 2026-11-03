# tree-sitter-fsharp.wasm — provenance & rebuild

`src/extraction/wasm/tree-sitter-fsharp.wasm` is the `fsharp` grammar of
[ionide/tree-sitter-fsharp](https://github.com/ionide/tree-sitter-fsharp), the
maintained fork of `microsoft/tree-sitter-fsharp`, built unmodified — no patch.

| | |
|---|---|
| Source | https://github.com/ionide/tree-sitter-fsharp |
| Version | tag `0.3.12`, commit `aefd0c8741bdf3aeb827a228aa4a996a6536697e` (2026-09-12) |
| License | MIT — `Copyright (c) 2023 Nikolaj Sidorenco` (the repository's `LICENSE`) |
| Grammar | `fsharp/` (the repository's `tree-sitter.json` lists `fsharp` and `fsharp_signature`; only `fsharp` is built) |
| Toolchain | `tree-sitter-cli` 0.27.0, the version the tag's `package-lock.json` pins; `build --wasm` fetches its own wasi-sdk clang and binaryen `wasm-opt` (version_132) |
| ABI | 15 |
| `wasm` SHA-256 | `ff1a927387fec25e184d120d9e18ec7cd5271b30f6380f02d494d3548a99f7b7` (11,430,318 bytes) |

Input sources at that commit:

| file | sha256 |
|---|---|
| `fsharp/src/parser.c` | `c1818692b883636a992d7648023c29cda96d3af0ebe798bca6b7ec6d31b9f45c` |
| `fsharp/src/scanner.c` | `4e53e98f5f32715abf2ecee72f4ad9cee23fe040e0930215b196aed1a5956646` |
| `common/scanner.h` | `5e14db207730d34e7f054df0afbb294f8798c9b8214734df025b239ef41e7592` |

The checked-in `parser.c` is what `tree-sitter generate` writes from
`fsharp/grammar.js` with the same CLI (regenerated and compared, byte for
byte), and the build below reproduces the vendored wasm byte for byte on
Linux x86_64. It is the same binary the release attaches as
`tree-sitter-fsharp.wasm`, built by the tag's `publish.yml` with the same
command.

`tree-sitter-wasms` ships no F# grammar, so there is nothing to resolve it from
at install time; the file has to live in the repository like the other vendored
grammars.

The file is large (11.4 MB) because the F# parser tables are. It is loaded only
for a project that has F# in it: `.fsx` files, or `.fs` files whose content is
F# (see "Telling F# from GLSL and Forth" below).

The tag also has a `fsharp_signature` grammar (2.7 MB) for `.fsi` signature
files; it is not vendored. The main grammar mis-parses `val` declarations, so
`.fsi` files are not indexed — every symbol they declare is in the `.fs` anyway.

## Rebuild / update

```bash
git clone https://github.com/ionide/tree-sitter-fsharp
cd tree-sitter-fsharp
git checkout aefd0c8741bdf3aeb827a228aa4a996a6536697e   # tag 0.3.12
npm install --no-save tree-sitter-cli@0.27.0
# optional: regenerate parser.c from grammar.js (the result equals the checked-in one)
(cd fsharp && npx tree-sitter generate)
npx tree-sitter build --wasm fsharp      # writes ./tree-sitter-fsharp.wasm
sha256sum tree-sitter-fsharp.wasm        # ff1a9273…f7b7 for 0.3.12
cp tree-sitter-fsharp.wasm path/to/codegraph/src/extraction/wasm/
```

No emscripten or Docker is needed: tree-sitter-cli 0.26+ downloads wasi-sdk
into `~/.cache/tree-sitter` on first use.

To move to a newer release, check out its tag, use the `tree-sitter-cli`
version its `package-lock.json` pins, rebuild, update the table above and run
the health check:

```bash
node scripts/add-lang/check-grammar.mjs src/extraction/wasm/tree-sitter-fsharp.wasm <sample.fs>
```

(0.3.12 parses 20 of 20 runs clean in the shared multi-grammar runtime.) Then
run the F# suites: `npx vitest run __tests__/extraction.test.ts -t "F#"`,
`__tests__/fsharp-scope.test.ts` and `__tests__/fsharp-lexical-scope.test.ts`.

## Telling F# from GLSL and Forth

`.fs` is also the usual extension for GLSL fragment shaders (`shader.vs` /
`shader.fs`) and for Forth. So `.fs` is not in the extension table: a `.fs`
file is indexed as F# only when the first 32 KB of its content read as F#, and
is otherwise skipped as it was before F# support — the F# grammar is never
loaded for it and it is never parsed. `.fsx` (F# script) has no such clash and
is always F#.

A `.fs` file is F# when it has:

1. a `namespace` or `module` declaration, or an `open` of a namespace, on a
   line of its own — every F# file of a project but the last must begin with a
   namespace or module declaration (FS0222); or, failing that,
2. no GLSL line (`#version`, `#define`, `#ifdef`, `precision mediump float`,
   `uniform` / `varying` / `attribute` declarations, `layout(`, `in` / `out`
   `vec4 …`, `void main(`) **and** an F# line: a `let` binding, a `type`
   definition, a `[<Attribute>]`, or a script directive like `#r "…"`.

Neither GLSL nor Forth writes a line of the first kind, and Forth's `type` is a
word that prints, never followed by a name and `=`. A GLSL line beside a
declaration is a shader kept in an F# string, so the declaration wins.

The answer depends only on the file's own bytes, so a full index, a sync of one
edited file and a fresh re-index agree. A project can always decide for itself
in `codegraph.json`: `{ "extensions": { ".fs": "fsharp" } }` indexes every
`.fs` file as F#, and that mapping is never second-guessed.
