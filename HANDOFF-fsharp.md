# F# support — handoff

Branch `fsharp-support-wip` (work in progress). `fsharp-support` = last pushed reviewed state (`7b14d00`).

## Done
1. Rebase on upstream main; `.fs` detector (GLSL/Forth), grammar provenance doc (`docs/grammars/tree-sitter-fsharp.md`).
2. F# scope rules, C# → F# linking (`src/resolution/fsharp-scope.ts`); VB.NET → F# removed (`7b14d00`).
3. **In progress (this commit), general redesign — no text scanning in the resolver:**
   - Extractor (`src/extraction/languages/fsharp.ts`, new `fsharp-bindings.ts`) records every reference as written (`Calc.helper`, `r.Save`, `_.Add` for a member on an expression), positioned at the name; `candidates` = receiver type from the local binding in the syntax tree (`Repo.Save` for `r: Repo`); `returnType` on values/functions/members/fields (annotation or what the body evaluates to). Local bindings are cached per scope node per tree.
   - Shared hook: `extractBareCall` may return `{ name, at, candidates }` (`tree-sitter-types.ts`, `tree-sitter.ts`).
   - Resolver: `candidates` now carried through ref rebuilds (`resolution/index.ts`); dedicated `matchFsharpReference` (F# refs resolve only by F# rules); value types follow `returnType` chains read at the declaration's own scope (`typesOfPath`, `scopeAtNode`); args read at the exact name position; `resolvedScopes` cache keyed by location (perf).
   - Tests: all F# suites pass (959). New tests: `fsharp-scope.test.ts` "as the extractor writes them".

4. **Done:** `src/extraction/fsharp-lexer.ts` — F# lexer (nested `(* *)`, `(*)` operator, strings, char literals, `(op)` and `(|A|B|)` names); used by the `.fs` detector (`hasFsharpCode`) and `.fsi` reading (`signatureNames`). `.fsproj` read as XML: comments/CDATA skipped, attributes in any order, `Include="A;B"`, `CompileBefore`/`Compile`/`CompileAfter` order, the `.fsproj` that lists the file among several in a folder. Tests: `__tests__/fsharp-lexer.test.ts`.

5. **Done:** C# → F#: a bare name, `this.M` and `base.M` find members (static or not) and nested types of the enclosing C# type and of what it inherits — an F# base class included — before any namespace (`dotnetRank`, used for F# targets and C# namesakes alike); the C# → F# step now runs before generic `methodCall`, since it applies C#'s whole lookup across both languages. Tests: `fsharp-scope.test.ts` "C# deriving from an F# class"; C# suites pass.

## Not verified yet
- Timing after the cached-bindings rewrite (before it: Paket 6.7s → 10s; the rewrite targets the remaining extractor cost). Run: `npm run build`, then index FSharp.Data / Giraffe / Paket.
- Full `npm test` after this step (only `glyphs.test.ts` fails, also on upstream).

## Remaining (from last review)
- Sync cost: file-node scan per sync (`fsharpConfigFiles`), `.fsi` entries never removed, shader `.fs` re-read every sync, `.fsi` reopen batching.
- Detector: C-comment-only / GLSL-statement-only `.fs` read as F#.
- Then one full review. Rule from the user: fix only as general cases, never special cases.
