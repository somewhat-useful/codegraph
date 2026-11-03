/**
 * F# scope: which declarations a name written in one file can mean.
 *
 * F# has no ambient project-wide namespace. What a name binds to depends on how
 * it is written:
 * - unqualified (`helper`): a scope enclosing the reference (in this file or another), the
 *   contents of a namespace or module the file `open`s (an `[<AutoOpen>]`
 *   module inside an opened one included), or `namespace global`. A module that
 *   merely sits inside an opened namespace is not opened, a type's members are
 *   never in scope bare, and neither is the case of a .NET-style `enum`;
 * - through a module or type (`Calc.helper`, `Other.Lib.Fn.helper`, a module
 *   alias): the container whose full path that is, taken as written, relative
 *   to an `open`, or relative to a scope enclosing the reference;
 * - through a value (`x.Add`), or a chain of properties (`Settings.Current.Save`):
 *   a member of some type. Its type is whatever inference says, so it is
 *   reached by name within the neighbourhood the file can see.
 *
 * The extractor keeps only the last segment of a qualified callee, so the
 * qualifier is read back from the source, at the reference's own position.
 *
 * A same-named function in a namespace none of that reaches — `map`, `bind`,
 * `format` — is never what the name means.
 *
 * C# and VB.NET see an F# module as a static class and an F# namespace as a
 * namespace, so a name they write reaches an F# declaration by their own
 * lookup (`isFsharpReachableFromDotnet`): through the module or type it is
 * written with (`Pricing.discount`, `Shop.Domain.Pricing.discount`, an alias),
 * bare when it is a type in a namespace the file is in or imports, or a member
 * of a module the file imports `static`ally, and through a value when it is a
 * member of a type in such a namespace.
 */

import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

/** Reference kinds that name a declaration (an `open` names a namespace, which is not a symbol). */
const SYMBOL_REFERENCE_KINDS: ReadonlySet<string> = new Set([
  'calls',
  'references',
  'extends',
  'implements',
  'instantiates',
  'type_of',
  'returns',
  'overrides',
  'decorates',
]);

/** Candidates that are bookkeeping rather than named symbols. */
const NON_SYMBOL_KINDS: ReadonlySet<string> = new Set(['file', 'namespace', 'import', 'export']);

/** What a type owns: reached through a value or a type name, never bare. */
const MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field']);

/** Languages an F# name can be written against: its own and the other .NET ones. */
const SCOPED_LANGUAGES: ReadonlySet<string> = new Set(['fsharp', 'csharp', 'vbnet']);

/** The .NET languages whose names reach F# declarations by their own lookup rules (`isFsharpReachableFromDotnet`). */
const DOTNET_REFERRERS: ReadonlySet<string> = new Set(['csharp', 'vbnet']);

/** What a type is, to a C# or VB.NET name: seen bare through its namespace. */
const TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface', 'union', 'enum', 'type_alias', 'module']);

/** Scopes whose own contents sit inside them: a reference written in one is relative to it. */
const OWN_SCOPE_KINDS: ReadonlySet<string> = new Set(['namespace', 'module', 'class', 'struct', 'interface', 'union', 'enum']);

/** Declarations directly in `namespace global` are visible from every file, and the namespace is always open. */
const GLOBAL_NAMESPACE = 'global';

/** Where a reference is written, and what its file brings into reach. */
export interface FsharpRefScope {
  /** Dotted path of the scopes around the reference. */
  container: string;
  /** The namespace the reference's file declares it in. */
  namespace: string;
  /** Paths the file opens. */
  opens: readonly string[];
  /** Types the file opens with `open type`: their static members, nested types and union cases are in scope bare. */
  openTypes?: readonly string[];
  /** Qualifiers the name is written with, aliases expanded: `Calc` in `Calc.helper`, `x` in `x.Add`. */
  qualifiers: readonly string[];
  /** The name is written through a capitalised path whose head the project does not declare: `System.Threading.Tasks.Task.Run`. */
  externalQualifier: boolean;
  /**
   * When the name is a member written on a value (`r.Add`, `this.Step`,
   * `Settings.Current.Save`): the dotted paths of the value's type and of the
   * types it inherits or implements, as F# types it — a self identifier, a
   * parameter's annotation, a `let` or `use` bound to a constructor or
   * annotated. Null when that type is not known: then no member is meant.
   */
  receivers?: readonly string[] | null;
}

/** Where a candidate is declared. */
export interface FsharpCandidateScope {
  name: string;
  /** Dotted path of the scopes and types around it. */
  container: string;
  /** The namespace its file declares it in. */
  namespace: string;
  kind: string;
  /** Containers whose opening exposes it unqualified: its own, and what an `[<AutoOpen>]` chain adds. */
  holders: readonly string[];
  /** The `[<AutoOpen>]` modules among the scopes around it. */
  autoOpened: readonly string[];
  /** A class's `let` binding: in scope bare inside its type, where the type's members are not. */
  classLet?: boolean;
  /** A static member, which `open type` brings into scope bare. */
  isStatic?: boolean;
}

/**
 * The dotted path of the namespaces / modules / types around a node:
 * `Shop.Core::Calc::helper` → `Shop.Core.Calc`. Empty for a node declared at
 * the top of a script, outside any namespace or module.
 */
function fsharpContainerOf(qualifiedName: string): string {
  const segments = qualifiedName.split('::');
  return segments.slice(0, -1).join('.');
}

/** The module a file that declares no namespace or module puts its top level in, named after the file (`a.fsx` → `A`). */
function implicitModule(filePath: string): string {
  const stem = (filePath.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '');
  return stem === '' ? '' : stem.charAt(0).toUpperCase() + stem.slice(1);
}

/** The container of a node, the implicit module of its file when it has none. */
function containerOfNode(node: Node): string {
  return fsharpContainerOf(node.qualifiedName) || implicitModule(node.filePath);
}

function isPathPrefix(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

/** `A.B.C` → ['', 'A', 'A.B', 'A.B.C']: the scopes a name written in `A.B.C` can be relative to. */
function scopePrefixes(container: string): string[] {
  const parts = container === '' ? [] : container.split('.');
  return ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('.'))];
}

function parentPath(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(0, dot);
}

function joinPath(prefix: string, rest: string): string {
  return prefix === '' ? rest : `${prefix}.${rest}`;
}

/** A qualifier names a module or type when it starts with a capital or a backtick; a lowercase one is a value. */
function namesContainer(qualifier: string): boolean {
  return /^(?:``|\p{Lu})/u.test(qualifier);
}

/**
 * The full paths a file's `open`s, in order, can name: each read relative to the
 * scopes around the reference, and to what the `open`s before it opened —
 * `open Shop` then `open Core` opens the module `Shop.Core` (F# refuses that
 * for a namespace, FS0893, so code that compiles names a module there).
 */
function openedPaths(prefixes: readonly string[], opens: readonly { name: string; line: number }[]): { path: string; line: number }[] {
  const out: { path: string; line: number }[] = [];
  const bases = new Set<string>(prefixes);
  for (const { name, line } of opens) {
    const reached = [...bases].map((base) => joinPath(base, name));
    for (const path of reached) {
      out.push({ path, line });
      bases.add(path);
    }
  }
  return out;
}

const RESOLVED_SCOPES = new WeakMap<FsharpRefScope, { prefixes: string[]; opens: Set<string>; openTypes: Set<string> }>();

/** The scopes around a reference and its opens, the latter also read relative to those scopes (`open Core` in `namespace Shop`). */
function resolvedScopes(ref: FsharpRefScope): { prefixes: string[]; opens: Set<string>; openTypes: Set<string> } {
  const cached = RESOLVED_SCOPES.get(ref);
  if (cached) return cached;
  const prefixes = scopePrefixes(ref.container);
  const opens = new Set<string>();
  for (const { path } of openedPaths(prefixes, ref.opens.map((name) => ({ name, line: 0 })))) opens.add(path);
  // `open type T` names `T` as written, relative to the scopes around the reference and to what is opened.
  const openTypes = new Set<string>();
  for (const name of ref.openTypes ?? []) for (const base of [...prefixes, ...opens]) openTypes.add(joinPath(base, name));
  const resolved = { prefixes, opens, openTypes };
  RESOLVED_SCOPES.set(ref, resolved);
  return resolved;
}

/**
 * Pure rule: can a name written as `ref` says mean a declaration placed as
 * `candidate` says? A type's own members are bare-visible inside it, in its file.
 */
export function isFsharpCandidateReachable(ref: FsharpRefScope, candidate: FsharpCandidateScope, sameFile = false): boolean {
  const c = candidate.container;
  if (c === '') return false;
  if (c === GLOBAL_NAMESPACE) return true;

  const { prefixes, opens, openTypes } = resolvedScopes(ref);
  const isMember = MEMBER_KINDS.has(candidate.kind);

  // What a qualifier can start from: the scopes around the reference, its opens, and
  // what an `[<AutoOpen>]` module opens in turn (`open Core` brings in `Core.Domain.AgentName`).
  const exposed = (path: string): boolean =>
    path === '' || path === GLOBAL_NAMESPACE || prefixes.includes(path) || opens.has(path) || (candidate.autoOpened.includes(path) && exposed(parentPath(path)));
  const viaContainer = ref.qualifiers.filter(namesContainer);
  if (viaContainer.length > 0) {
    const through = (path: string, q: string): boolean =>
      path === q || (path.endsWith(`.${q}`) && exposed(path.slice(0, path.length - q.length - 1)));
    // A union case is written through its type (`Shape.Circle`) or through the module or
    // namespace its type is declared in (`Box.Circle`): its holders.
    const paths = candidate.kind === 'enum_member' ? [c, ...candidate.holders] : [c];
    if (viaContainer.some((q) => paths.some((path) => through(path, q)))) return true;
  }
  if (ref.externalQualifier) return false;

  // A member on a value (`r.Add`), or on a chain of properties from a name (`Settings.Current.Save`),
  // is a member of the value's type, as F# types the value: its type, or one that type inherits.
  const viaValue = ref.qualifiers.some((q) => !namesContainer(q) || q.includes('.'));
  if (viaValue && isMember) return ref.receivers?.includes(c) === true;

  if (ref.qualifiers.length > 0) return false;

  // Bare name: a member is never in scope — inside its own type too, where it is reached
  // through the self identifier (`this.M`) — but a class's `let` is, inside that type;
  // anything else only through an enclosing scope or an opened one.
  if (isMember) return (candidate.classLet === true && sameFile && isPathPrefix(c, ref.container)) || (candidate.isStatic === true && openTypes.has(c));
  return openTypes.has(c) || candidate.holders.some((h) => opens.has(h) || isPathPrefix(h, ref.container));
}

/**
 * What a C# or VB.NET file can name, read by that language's own resolver:
 * the namespaces its code is in, the namespaces it imports (its own `using` /
 * `Imports`, its project's, `global using`), its aliases spelled out to full
 * paths, and the modules and types it imports statically. A VB.NET scope is
 * lowercased, with `ignoreCase` set, as VB.NET names are.
 */
export interface DotnetFileScope {
  namespaces: readonly string[];
  usings: ReadonlySet<string>;
  aliases: ReadonlyMap<string, string>;
  statics: ReadonlySet<string>;
  ignoreCase: boolean;
}

/** Reads the scope of the C# or VB.NET file a reference is written in; null for any other language. */
export type DotnetScopeReader = (ref: UnresolvedRef, context: ResolutionContext) => DotnetFileScope | null;

/**
 * An F# declaration as .NET sees it, which is what C# and VB.NET write: its
 * namespace; the path of the static class or type that holds it, where an F#
 * module is a static class — named `<M>Module` when a type of the same name sits
 * beside it, or when it carries `[<CompilationRepresentation(ModuleSuffix)>]`;
 * its name, or its `[<CompiledName>]`; and whether it is static (every module
 * function and value is).
 */
export interface DotnetTarget {
  /** False for what no .NET language can name: the top of an F# script. */
  reachable: boolean;
  namespace: string;
  /** Full path of what holds it: a namespace for a type declared in one, else a static class or type. */
  container: string;
  name: string;
  kind: string;
  isStatic: boolean;
}

/**
 * Pure rule: how near the name a C# or VB.NET file writes as `written`
 * (`discount`, `Pricing.discount`, `OrderModule.create`) finds the F#
 * declaration `target` — 0 for the namespace around the code, then one more for
 * each namespace outward to the global one, then the file's usings — or null
 * when the name cannot mean it. The nearest wins, as in C#: from `namespace
 * Shop.Web` with `using Shop.Domain;`, `Order` is `Shop.Order` before
 * `Shop.Domain.Order`.
 *
 * C#'s lookup: a qualified name's first segment is looked up in each namespace
 * around the code, outward to the global one, then among the types (never the
 * nested namespaces) of the namespaces its usings import; an alias stands for
 * what it names. A bare name is a type of those namespaces, or a static member
 * of a type a `using static` imports. A member on a value is the value's type's,
 * which only the C# or VB.NET resolver can tell: never decided here.
 */
export function dotnetLookupRank(file: DotnetFileScope, written: string, target: DotnetTarget): number | null {
  if (!target.reachable) return null;
  const norm = (text: string): string => (file.ignoreCase ? text.toLowerCase() : text);
  const container = norm(target.container);
  const namespace = norm(target.namespace);
  const own = norm(target.name);
  const isType = TYPE_KINDS.has(target.kind);
  // An instance member is reached through a value, never through its type's name.
  if (!isType && !target.isStatic) return null;

  // The namespaces a name is looked up in, nearest first: around the code, outward to the global one.
  const chains = (file.namespaces.length > 0 ? file.namespaces : ['']).map((ns) => scopePrefixes(norm(ns)).reverse());
  const viaUsings = Math.max(...chains.map((c) => c.length));
  const nearest = (path: string): number | null => {
    const at = chains.map((c) => c.indexOf(path)).filter((i) => i >= 0);
    return at.length > 0 ? Math.min(...at) : null;
  };

  const segments = norm(written).split('.');
  const name = segments.pop() ?? '';
  if (segments.length === 0) {
    // `using Customer = Shop.Domain.Customer;` names that one type.
    const alias = file.aliases.get(name);
    if (alias !== undefined) return alias === joinPath(container, own) ? viaUsings : null;
  }
  if (name !== own) return null;
  const aliased = segments.length > 0 ? file.aliases.get(segments[0]!) : undefined;
  const qualifier = aliased !== undefined ? [aliased, ...segments.slice(1)].join('.') : segments.join('.');

  if (qualifier === '') {
    if (isType && container === namespace) {
      const around = nearest(namespace);
      if (around !== null) return around;
      if (file.usings.has(namespace)) return viaUsings;
    }
    return file.statics.has(container) ? viaUsings : null;
  }
  // An alias, or the rest of the path from a namespace around the code (the global one: the full path).
  if (aliased !== undefined) return container === qualifier ? viaUsings : null;
  if (container === qualifier) return nearest('') ?? viaUsings;
  if (container.endsWith(`.${qualifier}`)) {
    const around = nearest(container.slice(0, container.length - qualifier.length - 1));
    if (around !== null) return around;
  }
  // From a namespace a using imports: the qualifier starts at one of its types.
  return container === joinPath(namespace, qualifier) && file.usings.has(namespace) ? viaUsings : null;
}

/** Can the name a C# or VB.NET file writes as `written` mean the F# declaration `target` at all? */
export function isFsharpReachableFromDotnet(file: DotnetFileScope, written: string, target: DotnetTarget): boolean {
  return dotnetLookupRank(file, written, target) !== null;
}

interface FileScope {
  /** Paths the file opens: `open X`. */
  opens: { node: Node; owner?: Node }[];
  /** Types the file opens: `open type X`. */
  openTypes: { node: Node; owner?: Node }[];
  /** Module abbreviations, with the lexical scope that owns them. */
  aliases: { node: Node; owner?: Node }[];
  /** Namespaces, modules and enums of the file by their qualified name. */
  scopes: Map<string, Node>;
  /** The same by dotted path: a file-level `module A.B.C` is one segment of the qualified name. */
  byPath: Map<string, Node>;
}

function containsPosition(node: Node, line: number, column: number): boolean {
  return (line > node.startLine || (line === node.startLine && column >= node.startColumn)) &&
    (line < node.endLine || (line === node.endLine && column <= node.endColumn));
}

/** An open or abbreviation applies only after its declaration, inside its owner. */
function importApplies(entry: { node: Node; owner?: Node }, ref: UnresolvedRef): boolean {
  return (ref.line > entry.node.endLine || (ref.line === entry.node.endLine && ref.column >= entry.node.endColumn)) &&
    (!entry.owner || containsPosition(entry.owner, ref.line, ref.column));
}

const FILE_SCOPES = new WeakMap<ResolutionContext, Map<string, FileScope>>();

/** What a file says about names, read once per resolution context. */
function fileScopeOf(filePath: string, context: ResolutionContext): FileScope {
  let perFile = FILE_SCOPES.get(context);
  if (!perFile) FILE_SCOPES.set(context, (perFile = new Map()));
  const cached = perFile.get(filePath);
  if (cached) return cached;
  const scope: FileScope = { opens: [], openTypes: [], aliases: [], scopes: new Map(), byPath: new Map() };
  const nodes = context.getNodesInFile(filePath);
  const containers = nodes.filter((n) => n.kind === 'module' || n.kind === 'namespace');
  for (const n of nodes) {
    if (n.kind === 'module' || n.kind === 'enum' || n.kind === 'namespace') {
      scope.scopes.set(n.qualifiedName, n);
      scope.byPath.set(n.qualifiedName.split('::').join('.'), n);
    }
    if (n.kind !== 'import') continue;
    // Import qualifiedName deliberately names its target, so recover the
    // lexical owner from source ranges rather than that qualifiedName.
    const owner = containers.filter((c) => containsPosition(c, n.startLine, n.startColumn))
      .sort((a, b) => b.startLine - a.startLine || b.startColumn - a.startColumn)[0];
    if (n.signature) scope.aliases.push({ node: n, owner });
    else if (n.decorators?.includes('type')) scope.openTypes.push({ node: n, owner });
    // `#load "a.fsx"` is an import node too, but names a file, not a scope.
    else if (!/[.]fsx?$/i.test(n.name)) scope.opens.push({ node: n, owner });
  }
  perFile.set(filePath, scope);
  return scope;
}

const isAutoOpen = (module: Node | undefined): boolean => module?.kind === 'module' && module.decorators?.some((d) => d.startsWith('AutoOpen')) === true;

/** Is the character part of a name? */
function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_']/u.test(ch);
}

/** Index of the first mention of `name` as a whole word in `line` at or after `from`, or -1. */
function indexOfWord(line: string, name: string, from: number): number {
  for (let at = line.indexOf(name, from); at >= 0; at = line.indexOf(name, at + 1)) {
    if (!isNameChar(line[at - 1]) && !isNameChar(line[at + name.length])) return at;
  }
  return -1;
}

/** How far below the reference's own line its name may be written: a pipeline continues on the next lines. */
const QUALIFIER_WINDOW = 8;

/** The longest qualifier read back; anything longer is not a name. */
const MAX_QUALIFIER = 240;

/**
 * Read the qualifier written just before `line[at]`: `Utils` in `Utils.helper`,
 * `Other.Lib.Fn` in `Other.Lib.Fn.helper`. Empty when the name is bare, `_` when
 * what precedes the dot is not a name (`(f x).Add`, `xs.[0].Add`). Reads backwards
 * from the name, so a long line costs only the qualifier.
 */
function qualifierBefore(line: string, at: number): string | null {
  let i = at - 1;
  while (i >= 0 && line[i] === ' ') i--;
  if (line[i] !== '.') return null;
  const segments: string[] = [];
  const stop = Math.max(-1, i - MAX_QUALIFIER);
  while (line[i] === '.' && i > stop) {
    i--;
    while (i >= 0 && line[i] === ' ') i--;
    let start: number;
    if (line[i] === '`' && line[i - 1] === '`') {
      start = line.lastIndexOf('``', i - 2);
      if (start < 0 || start <= stop) return '_';
    } else {
      start = i;
      while (start >= 0 && start > stop && isNameChar(line[start])) start--;
      start++;
      if (start > i) return '_';
    }
    segments.unshift(line.slice(start, i + 1));
    i = start - 1;
    while (i >= 0 && line[i] === ' ') i--;
  }
  return segments.join('.');
}

/**
 * The qualifier a reference's name is written with, aliases expanded: a module
 * alias (`module F = Other.Lib.Fn`) is replaced by what it names. The reference
 * points at the start of its expression, so the name is looked for from there on
 * its line and on the few lines below it, and the first mention is the one.
 */
function writtenQualifiers(ref: UnresolvedRef, aliases: ReadonlyMap<string, string>, context: ResolutionContext): string[] {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? [];
  for (let i = 0; i < QUALIFIER_WINDOW; i++) {
    const line = lines[ref.line - 1 + i];
    if (line === undefined) break;
    let at = indexOfWord(line, ref.referenceName, i === 0 ? Math.min(ref.column, line.length) : 0);
    if (at < 0 && i === 0) at = indexOfWord(line, ref.referenceName, 0);
    if (at < 0) continue;
    const written = qualifierBefore(line, at);
    if (written === null || written === '') return [];
    if (written === '_') return ['_'];
    const [head = '', ...rest] = written.split('.');
    const target = aliases.get(head);
    return [target ? [target, ...rest].join('.') : written];
  }
  return [];
}

const DECLARED_NAMESPACES = new WeakMap<ResolutionContext, Map<string, string>>();

/**
 * The namespace a node's file declares it in. `namespace A.B` is `A.B`; a
 * top-level `module A.B` sits in namespace `A`, and a bare `module M` in none.
 */
function declaredNamespace(node: Node, context: ResolutionContext): string {
  const head = node.qualifiedName.split('::')[0] ?? '';
  let perContext = DECLARED_NAMESPACES.get(context);
  if (!perContext) DECLARED_NAMESPACES.set(context, (perContext = new Map()));
  const key = `${node.filePath}|${head}`;
  const cached = perContext.get(key);
  if (cached !== undefined) return cached;
  const scope = fileScopeOf(node.filePath, context).scopes.get(head);
  const dot = scope ? scope.name.lastIndexOf('.') : -1;
  const namespace = !scope || scope.kind === 'enum' ? '' : scope.kind === 'namespace' ? scope.name : dot > 0 ? scope.name.slice(0, dot) : '';
  perContext.set(key, namespace);
  return namespace;
}

/** A capitalised dotted path that no project declaration ends in: `System.Threading.Tasks.Task`, though `Settings.Current` may be. */
function isExternalPath(qualifier: string, context: ResolutionContext): boolean {
  if (!qualifier.includes('.') || !qualifier.split('.').every(namesContainer)) return false;
  const last = qualifier.slice(qualifier.lastIndexOf('.') + 1);
  return !context.getNodesByName(last).some((n) => {
    const path = n.qualifiedName.split('::').join('.');
    return path === qualifier || path.endsWith(`.${qualifier}`);
  });
}

/** What a reference says about where it is written, read once for all of its candidates. */
const REF_SCOPES = new WeakMap<UnresolvedRef, FsharpRefScope>();

function scopeOfRef(ref: UnresolvedRef, context: ResolutionContext): FsharpRefScope {
  const cached = REF_SCOPES.get(ref);
  if (cached) return cached;
  const file = fileScopeOf(ref.filePath, context);
  const from = context.getNodeById?.(ref.fromNodeId) ?? context.getNodesInFile(ref.filePath).find((n) => n.id === ref.fromNodeId);
  // A scope is the one its own contents sit in; what is written at the top of a file sits in its implicit module.
  const container = !from || from.kind === 'file'
    ? implicitModule(ref.filePath)
    : OWN_SCOPE_KINDS.has(from.kind)
      ? from.qualifiedName.split('::').join('.')
      : containerOfNode(from);
  const aliases = new Map(file.aliases.filter((entry) => importApplies(entry, ref))
    .map(({ node }) => [node.name, node.signature!]));
  const qualifiers = writtenQualifiers(ref, aliases, context);
  const scope: FsharpRefScope = {
    container,
    namespace: from && from.kind !== 'file' ? declaredNamespace(from, context) : '',
    opens: file.opens.filter((entry) => importApplies(entry, ref)).map(({ node }) => node.name),
    openTypes: file.openTypes.filter((entry) => importApplies(entry, ref)).map(({ node }) => node.name),
    qualifiers,
    externalQualifier: qualifiers.length > 0 && qualifiers.every((q) => isExternalPath(q, context)),
  };
  REF_SCOPES.set(ref, scope);
  const onValue = qualifiers.find((q) => q !== '_' && (!namesContainer(q) || q.includes('.')));
  if (onValue !== undefined) scope.receivers = receiversOf(onValue, ref, from, scope, context);
  return scope;
}

/** A type written in an annotation or a construction, without its generic arguments: `Repo<int>` → `Repo`. */
const TYPE_NAME = String.raw`([A-Za-z_\x60][\w.\x60']*)`;

/**
 * The type of the value `written` names at `ref`, as F# types it, with what it
 * inherits: the dotted paths of those types, or null when F# would know it and
 * the source does not say. Read from what the source states — never from the
 * name of the member the value is used with.
 */
function receiversOf(written: string, ref: UnresolvedRef, from: Node | undefined, scope: FsharpRefScope, context: ResolutionContext): string[] | null {
  // `base.Speak()` in a member is the inherited type's member: the supertypes of the type it is declared in.
  if (written === 'base') return from && MEMBER_KINDS.has(from.kind) ? baseTypesOf(containerOfNode(from), context) : null;
  const typeName = written.includes('.') ? pathValueType(written, scope, context) : localValueType(written, ref, from, context);
  if (typeName === null) return null;
  const types = typeName.kind === 'path' ? [typeName.path] : reachableTypes(typeName.name, scope, context);
  if (types.length === 0) return null;
  const paths = new Set<string>();
  const visit = (node: Node, depth: number): void => {
    const path = node.qualifiedName.split('::').join('.');
    if (paths.has(path) || depth > 8) return;
    paths.add(path);
    for (const parent of context.getSupertypeNodes?.(node.id) ?? []) visit(parent, depth + 1);
  };
  for (const type of types) {
    if (typeof type === 'string') paths.add(type);
    else visit(type, 0);
  }
  return [...paths];
}

/** The dotted paths of what the type at `path` inherits or implements, and what those do in turn. */
function baseTypesOf(path: string, context: ResolutionContext): string[] | null {
  const types = context.getNodesByQualifiedName(path.split('.').join('::')).filter((n) => TYPE_KINDS.has(n.kind) && n.kind !== 'module');
  const paths = new Set<string>();
  const visit = (node: Node, depth: number): void => {
    for (const parent of context.getSupertypeNodes?.(node.id) ?? []) {
      const parentPath = parent.qualifiedName.split('::').join('.');
      if (paths.has(parentPath) || depth > 8) continue;
      paths.add(parentPath);
      visit(parent, depth + 1);
    }
  };
  for (const type of types) visit(type, 0);
  return paths.size > 0 ? [...paths] : null;
}

type ValueType = { kind: 'name'; name: string } | { kind: 'path'; path: string };

/** The type a bare value name has where `ref` is written: a self identifier, a parameter, a local or a module value. */
function localValueType(name: string, ref: UnresolvedRef, from: Node | undefined, context: ResolutionContext): ValueType | null {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? [];
  const word = escapeRegExp(name);
  if (from && from.kind !== 'file') {
    // `member x.Run() = x.Step()`: the self identifier is the type the member is declared in.
    const head = lines.slice(from.startLine - 1, from.startLine + 1).join(' ');
    const self = new RegExp(String.raw`\bmember\s+(?:(?:private|internal|public|static|inline)\s+)*${word}\s*\.`).test(head) ||
      new RegExp(String.raw`\b(?:override|default)\s+${word}\s*\.`).test(head);
    if (self && MEMBER_KINDS.has(from.kind)) return { kind: 'path', path: containerOfNode(from) };
    // `(r: Repo)`: a parameter's annotation.
    const parameter = new RegExp(String.raw`(?:^|[\s(,])${word}\s*:\s*${TYPE_NAME}`).exec(from.signature ?? '');
    if (parameter) return { kind: 'name', name: parameter[1]! };
    // The nearest `let` or `use` of the name above the reference, in the symbol's body.
    const bound = new RegExp(String.raw`\b(?:let|use)!?\s+(?:mutable\s+)?${word}\s*(?::\s*${TYPE_NAME}[^=]*)?=\s*(?:new\s+)?${TYPE_NAME}?\s*(?:<[^>\n]*>)?\s*(\()?`);
    for (let line = ref.line; line >= from.startLine; line--) {
      const m = bound.exec(lines[line - 1] ?? '');
      if (!m) continue;
      if (m[1]) return { kind: 'name', name: m[1] };
      return m[2] && m[3] && /^(?:\p{Lu}|\x60)/u.test(lastSegmentOf(m[2])) ? { kind: 'name', name: m[2] } : null;
    }
  }
  return null;
}

/** The type of a module value written by its path (`Settings.Current`): what its initializer constructs. */
function pathValueType(path: string, scope: FsharpRefScope, context: ResolutionContext): ValueType | null {
  const name = lastSegmentOf(path);
  const owner = path.slice(0, path.length - name.length - 1);
  const values = context.getNodesByName(name).filter((n) =>
    n.language === 'fsharp' && (n.kind === 'variable' || n.kind === 'constant') &&
    (containerOfNode(n) === owner || containerOfNode(n).endsWith(`.${owner}`)) &&
    isFsharpCandidateReachable({ ...scope, qualifiers: [owner], receivers: null }, scopeOfCandidate(n, context)));
  if (values.length !== 1) return null;
  const constructed = new RegExp(String.raw`^=\s*(?:new\s+)?${TYPE_NAME}\s*(?:<[^>]*>)?\s*\(`).exec(values[0]!.signature ?? '');
  return constructed && /^(?:\p{Lu}|\x60)/u.test(lastSegmentOf(constructed[1]!)) ? { kind: 'name', name: constructed[1]! } : null;
}

/** The project types a type name written at a reference can mean, by F#'s scope rules for that reference. */
function reachableTypes(written: string, scope: FsharpRefScope, context: ResolutionContext): Node[] {
  const name = lastSegmentOf(written);
  const qualifier = written.length > name.length ? written.slice(0, written.length - name.length - 1) : '';
  const local = { ...scope, qualifiers: qualifier === '' ? [] : [qualifier], receivers: null };
  return context.getNodesByName(name).filter((n) =>
    SCOPED_LANGUAGES.has(n.language) && TYPE_KINDS.has(n.kind) && n.kind !== 'module' &&
    (n.language !== 'fsharp' || isFsharpCandidateReachable(local, scopeOfCandidate(n, context))));
}

function lastSegmentOf(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The containers whose opening exposes an F# candidate unqualified: the one it
 * is declared in — for a union case, the one its type is declared in, and
 * none for a case of a .NET-style `enum`, which is always written through its
 * type — and, while that is an `[<AutoOpen>]` module, the one around it.
 */
function holdersOf(candidate: Node, file: FileScope): string[] {
  const segments = candidate.qualifiedName.split('::').slice(0, -1);
  if (candidate.kind === 'enum_member') {
    if (file.scopes.get(segments.join('::'))?.kind === 'enum') return [];
    segments.pop();
  }
  if (segments.length === 0) return [containerOfNode(candidate)];
  // An AutoOpen module opens into the scope around it.
  let path = segments.join('.');
  const holders = [path];
  while (path !== '' && isAutoOpen(file.byPath.get(path))) {
    path = parentPath(path);
    if (path !== '') holders.push(path);
  }
  return holders;
}

/** The `[<AutoOpen>]` modules among the scopes an F# candidate is declared in. */
function autoOpenedAround(candidate: Node, scopes: ReadonlyMap<string, Node>): string[] {
  const segments = candidate.qualifiedName.split('::').slice(0, -1);
  const found: string[] = [];
  for (let i = 1; i <= segments.length; i++) {
    if (isAutoOpen(scopes.get(segments.slice(0, i).join('::')))) found.push(segments.slice(0, i).join('.'));
  }
  return found;
}

/** The kinds of an F# type definition. */
const TYPE_DEFINITION_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface', 'union', 'enum', 'type_alias']);

/** `[<CompiledName("Discount")>]` → `Discount`. */
function compiledNameOf(node: Node): string | null {
  for (const d of node.decorators ?? []) {
    const m = /^CompiledName(?:Attribute)?\s*\(\s*"([^"]+)"\s*\)$/.exec(d);
    if (m) return m[1]!;
  }
  return null;
}

const COMPILED_NAMES = new WeakMap<ResolutionContext, Map<string, Node[]>>();

/** Whether some F# declaration is compiled under `name` by a `[<CompiledName>]` that differs from its F# name. */
export function isFsharpCompiledName(name: string, context: ResolutionContext): boolean {
  return compiledNamed(name, context).length > 0;
}

/** F# declarations whose `[<CompiledName>]` is `name`, which a lookup by their F# name does not find. */
function compiledNamed(name: string, context: ResolutionContext): Node[] {
  let byName = COMPILED_NAMES.get(context);
  if (!byName) {
    byName = new Map();
    for (const kind of ['function', 'method', 'property', 'variable', 'constant'] as const) {
      for (const n of context.getNodesByKind(kind)) {
        if (n.language !== 'fsharp') continue;
        const compiled = compiledNameOf(n);
        if (compiled !== null && compiled.toLowerCase() !== n.name.toLowerCase()) {
          byName.set(compiled, [...(byName.get(compiled) ?? []), n]);
        }
      }
    }
    COMPILED_NAMES.set(context, byName);
  }
  return byName.get(name) ?? [];
}

const DOTNET_TARGETS = new WeakMap<ResolutionContext, Map<string, DotnetTarget>>();

/** An F# declaration as .NET names it (see `DotnetTarget`). */
function dotnetTargetOf(candidate: Node, context: ResolutionContext): DotnetTarget {
  let perContext = DOTNET_TARGETS.get(context);
  if (!perContext) DOTNET_TARGETS.set(context, (perContext = new Map()));
  const cached = perContext.get(candidate.id);
  if (cached) return cached;
  const nodes = context.getNodesInFile(candidate.filePath);
  const namespace: string[] = [];
  const holders: string[] = [];
  const segments = candidate.qualifiedName.split('::').slice(0, -1);
  let qualified = '';
  for (const segment of segments) {
    qualified = qualified === '' ? segment : `${qualified}::${segment}`;
    // A type and a module of one name share a qualified name: the one around the candidate is meant.
    const around = nodes.filter((n) => n.qualifiedName === qualified && n.id !== candidate.id && containsLine(n, candidate.startLine));
    const scope = around.find((n) => n.kind === 'namespace' || n.kind === 'module') ?? around[0];
    if (scope?.kind === 'namespace' && holders.length === 0) {
      if (segment !== GLOBAL_NAMESPACE) namespace.push(...segment.split('.'));
    } else if (scope?.kind === 'module') {
      // `module A.B.C` at the top of a file is module `C` in namespace `A.B`.
      const parts = segment.split('.');
      const own = parts.pop()!;
      if (holders.length === 0) namespace.push(...parts);
      holders.push(hasModuleSuffix(scope, nodes) ? `${own}Module` : own);
    } else {
      holders.push(segment);
    }
  }
  // A file that declares no namespace or module puts its top level in a module named after
  // the file: a static class in the global namespace, unless the file is a script, which is no
  // part of an assembly.
  if (segments.length === 0) holders.push(implicitModule(candidate.filePath));
  const ns = namespace.join('.');
  const target: DotnetTarget = {
    reachable: !(segments.length === 0 && /\.fsx$/i.test(candidate.filePath)),
    namespace: ns,
    container: holders.length > 0 ? joinPath(ns, holders.join('.')) : ns,
    name: compiledNameOf(candidate) ?? (candidate.kind === 'module' && hasModuleSuffix(candidate, nodes) ? `${candidate.name}Module` : candidate.name),
    kind: candidate.kind,
    isStatic: !MEMBER_KINDS.has(candidate.kind) || candidate.isStatic === true,
  };
  perContext.set(candidate.id, target);
  return target;
}

/**
 * Whether .NET names F# module `module` `<M>Module`: it carries
 * `[<CompilationRepresentation(ModuleSuffix)>]`, or a type of the same name is
 * declared beside it, which since F# 4.1 adds the suffix on its own.
 */
function hasModuleSuffix(module: Node, nodesInFile: readonly Node[]): boolean {
  return module.decorators?.some((d) => /\bModuleSuffix\b/.test(d)) === true ||
    nodesInFile.some((n) => n.qualifiedName === module.qualifiedName && TYPE_DEFINITION_KINDS.has(n.kind));
}

function containsLine(node: Node, line: number): boolean {
  return node.startLine <= line && (node.endLine ?? node.startLine) >= line;
}

const CANDIDATE_SCOPES = new WeakMap<ResolutionContext, Map<string, FsharpCandidateScope>>();

const DOTNET_FILE_SCOPES = new WeakMap<ResolutionContext, Map<string, DotnetFileScope | null>>();

/** A C# or VB.NET file's scope, read once per resolution context. */
function dotnetFileScopeOf(ref: UnresolvedRef, context: ResolutionContext, read: DotnetScopeReader | undefined): DotnetFileScope | null {
  if (!read) return null;
  let perFile = DOTNET_FILE_SCOPES.get(context);
  if (!perFile) DOTNET_FILE_SCOPES.set(context, (perFile = new Map()));
  if (!perFile.has(ref.filePath)) perFile.set(ref.filePath, read(ref, context));
  return perFile.get(ref.filePath) ?? null;
}

/** Forget what was read from files and candidates; called when the resolver drops its caches after a sync. */
export function clearFsharpScopeCaches(context: ResolutionContext): void {
  DOTNET_FILE_SCOPES.delete(context);
  DOTNET_TARGETS.delete(context);
  COMPILED_NAMES.delete(context);
  FILE_SCOPES.delete(context);
  DECLARED_NAMESPACES.delete(context);
  CANDIDATE_SCOPES.delete(context);
}

/** Where a candidate is declared, read once per candidate. */
function scopeOfCandidate(candidate: Node, context: ResolutionContext): FsharpCandidateScope {
  let perContext = CANDIDATE_SCOPES.get(context);
  if (!perContext) CANDIDATE_SCOPES.set(context, (perContext = new Map()));
  const cached = perContext.get(candidate.id);
  if (cached) return cached;
  // A C# or VB.NET declaration is reached through its namespace like an F# one.
  const foreign = candidate.language !== 'fsharp';
  const container = foreign ? fsharpContainerOf(candidate.qualifiedName) : containerOfNode(candidate);
  const file = fileScopeOf(candidate.filePath, context);
  const scope: FsharpCandidateScope = {
    name: candidate.name,
    container,
    namespace: declaredNamespace(candidate, context),
    kind: candidate.kind,
    holders: foreign ? [container] : holdersOf(candidate, file),
    autoOpened: foreign ? [] : autoOpenedAround(candidate, file.scopes),
    classLet: !foreign && candidate.decorators?.[0] === 'let',
    isStatic: candidate.isStatic === true,
  };
  perContext.set(candidate.id, scope);
  return scope;
}

/**
 * The name a C# or VB.NET reference is written as, with its qualifier. An
 * extractor that records a path call by its last name (VB.NET's
 * `Domain.Pricing.discount(…)` as `discount`) leaves the qualifier in the source,
 * where it is read back at the reference's position.
 */
function writtenDotnetName(ref: UnresolvedRef, context: ResolutionContext): string {
  if (ref.referenceName.includes('.')) return ref.referenceName;
  const line = (context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/))?.[ref.line - 1];
  if (line === undefined) return ref.referenceName;
  const at = indexOfWord(line, ref.referenceName, Math.min(ref.column, line.length));
  const qualifier = at < 0 ? null : qualifierBefore(line, at);
  return qualifier && qualifier !== '_' ? `${qualifier}.${ref.referenceName}` : ref.referenceName;
}

/** What each reference kind of a C# or VB.NET name can land on in F#: a call invokes, a construction builds. */
const DOTNET_TARGET_KINDS: Readonly<Record<string, ReadonlySet<string>>> = {
  calls: new Set(['function', 'method', 'property', 'variable', 'constant', 'enum_member']),
  instantiates: new Set(['class', 'struct', 'union']),
};

/**
 * The F# declaration a C# or VB.NET name means, by that language's lookup
 * (`isFsharpReachableFromDotnet`): `Pricing.discount(…)`, `Shop.Domain.Pricing.discount(…)`,
 * `P.discount(…)` through an alias, `discount(…)` under `using static`, `new Customer(…)`.
 * Their own resolvers look for a C# or VB.NET class and method, and an F# module
 * is neither. Null unless exactly one F# declaration is reached: silent beats wrong.
 */
export function matchDotnetNameInFsharp(ref: UnresolvedRef, context: ResolutionContext, read: DotnetScopeReader): ResolvedRef | null {
  if (!DOTNET_REFERRERS.has(ref.language) || !SYMBOL_REFERENCE_KINDS.has(ref.referenceKind)) return null;
  const name = ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1);
  if (name === '') return null;
  // A `[<CompiledName>]` can differ from the F# name in case only: look it up by both.
  const named = context.getNodesByLowerName(name.toLowerCase());
  const allowed = DOTNET_TARGET_KINDS[ref.referenceKind];
  const declared = [...named, ...compiledNamed(name, context)]
    .filter((n) => n.language === 'fsharp' && !NON_SYMBOL_KINDS.has(n.kind) && (!allowed || allowed.has(n.kind)));
  if (declared.length === 0) return null;
  const file = dotnetFileScopeOf(ref, context, read);
  if (!file) return null;
  const written = writtenDotnetName(ref, context);
  // The nearest in C#'s lookup order; overloads of one member share a qualified name, two different declarations are a guess.
  const ranked = declared
    .map((n) => ({ n, rank: dotnetLookupRank(file, written, dotnetTargetOf(n, context)) }))
    .filter((r): r is { n: Node; rank: number } => r.rank !== null);
  if (ranked.length === 0) return null;
  const best = Math.min(...ranked.map((r) => r.rank));
  const reached = ranked.filter((r) => r.rank === best).map((r) => r.n);
  if (reached.some((n) => n.qualifiedName !== reached[0]!.qualifiedName)) return null;
  return { original: ref, targetNodeId: reached[0]!.id, confidence: 0.9, resolvedBy: 'qualified-name' };
}

/**
 * Of the declarations an F# name can mean, the ones F# takes: the name binds to
 * what became visible last before it. An `open` makes what it opens visible from
 * its line — so of two opened modules that both define `pick`, the one opened
 * later is meant — and a declaration of a scope around the reference from its
 * own line in that file, or from the top of any other file. Several equally late
 * stay: the caller does not guess between them.
 */
export function latestFsharpBindings(candidates: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  if (ref.language !== 'fsharp' || candidates.length < 2) return candidates;
  const scope = scopeOfRef(ref, context);
  const file = fileScopeOf(ref.filePath, context);
  // Where each path became visible through an `open` read relative to the scopes around the reference.
  const openedAt = new Map<string, number>();
  const applying = file.opens.filter((entry) => importApplies(entry, ref)).map(({ node }) => ({ name: node.name, line: node.endLine }));
  for (const { path, line } of openedPaths(scopePrefixes(scope.container), applying)) {
    openedAt.set(path, Math.max(openedAt.get(path) ?? -1, line));
  }
  const visibleFrom = (path: string, declaredAt: number, sameFile: boolean): number => {
    if (path === '' || path === GLOBAL_NAMESPACE) return 0;
    const opened = openedAt.get(path) ?? -1;
    const around = isPathPrefix(path, scope.container) ? (sameFile ? declaredAt : 0) : -1;
    return Math.max(opened, around);
  };
  const qualifier = scope.qualifiers.find(namesContainer);
  const lines = candidates.map((n) => {
    const target = scopeOfCandidate(n, context);
    const sameFile = n.filePath === ref.filePath;
    if (qualifier === undefined) return Math.max(...target.holders.map((h) => visibleFrom(h, n.startLine, sameFile)), -1);
    // `Calc.helper`: the module the qualifier starts at is what became visible.
    if (target.container === qualifier) return 0;
    const head = target.container.slice(0, target.container.length - qualifier.length - 1);
    return target.container.endsWith(`.${qualifier}`) ? visibleFrom(head, n.startLine, sameFile) : -1;
  });
  const latest = Math.max(...lines);
  const visible = candidates.filter((_, i) => lines[i] === latest);
  // Declared side by side, as one module or namespace's in one file: the later declaration shadows the earlier.
  const holder = (n: Node): string => `${n.filePath}|${scopeOfCandidate(n, context).holders[0] ?? ''}`;
  if (visible.length > 1 && visible.every((n) => holder(n) === holder(visible[0]!))) {
    const last = Math.max(...visible.map((n) => n.startLine));
    return visible.filter((n) => n.startLine === last);
  }
  return visible;
}

/**
 * The record type an F# record expression builds, as F# infers it from the
 * labels: `{Name;Email}` (the extractor's spelling of `{ Name = n; Email = e }`)
 * is a record type in scope with those fields — the one that became visible
 * last when several have them — and `{ Dom.Customer.Name = … }` the type its
 * first label is written through. `{c with Name}` copies `c`, so it builds `c`'s
 * type. Null unless exactly one type is meant.
 */
export function matchFsharpRecordConstruction(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const written = /^\{(.+)\}$/.exec(ref.referenceName);
  if (ref.language !== 'fsharp' || ref.referenceKind !== 'instantiates' || !written) return null;
  const scope = scopeOfRef(ref, context);
  const copy = /^(\S+) with (.+)$/.exec(written[1]!);
  const labels = (copy ? copy[2]! : written[1]!).split(';');
  let types: Node[];
  if (copy) {
    const from = context.getNodeById?.(ref.fromNodeId) ?? undefined;
    const valueType = copy[1]!.includes('.') ? pathValueType(copy[1]!, scope, context) : localValueType(copy[1]!, ref, from, context);
    if (!valueType) return null;
    types = valueType.kind === 'path'
      ? context.getNodesByQualifiedName(valueType.path.split('.').join('::')).filter((n) => TYPE_KINDS.has(n.kind))
      : reachableTypes(valueType.name, scope, context);
  } else if (labels[0]!.includes('.')) {
    const first = labels[0]!;
    labels[0] = lastSegmentOf(first);
    types = reachableTypes(first.slice(0, first.length - labels[0].length - 1), scope, context);
  } else {
    // The types with a field of the first label, among those the reference can name.
    const owners = new Set(context.getNodesByName(labels[0]!)
      .filter((n) => n.language === 'fsharp' && n.kind === 'field')
      .map((n) => n.qualifiedName.slice(0, n.qualifiedName.lastIndexOf('::'))));
    types = [...owners].flatMap((qn) => context.getNodesByQualifiedName(qn))
      .filter((t) => t.language === 'fsharp' && TYPE_KINDS.has(t.kind) && t.kind !== 'module' &&
        isFsharpCandidateReachable({ ...scope, qualifiers: [], receivers: null }, scopeOfCandidate(t, context)));
  }
  const hasField = (type: Node, label: string): boolean =>
    context.getNodesByName(label).some((f) => f.kind === 'field' && f.qualifiedName === `${type.qualifiedName}::${label}`);
  const built = latestFsharpBindings(types.filter((t) => labels.every((label) => hasField(t, label))), { ...ref, referenceName: '' }, context);
  if (built.length === 0 || built.some((t) => t.qualifiedName !== built[0]!.qualifiedName)) return null;
  return { original: ref, targetNodeId: built[0]!.id, confidence: 0.9, resolvedBy: 'exact-match' };
}

/** Is `candidate` something `ref` can mean? Always true for refs and candidates F# has nothing to say about. */
export function isFsharpCandidateInScope(
  candidate: Node,
  ref: UnresolvedRef,
  context: ResolutionContext,
  dotnetScope?: DotnetScopeReader,
): boolean {
  if (ref.language !== 'fsharp') {
    if (candidate.language !== 'fsharp') return true;
    // Razor's `@using` is not modelled: a Razor name never lands on an F# declaration. Silent beats wrong.
    if (ref.language === 'razor') return false;
    if (!DOTNET_REFERRERS.has(ref.language)) return true;
    if (!SYMBOL_REFERENCE_KINDS.has(ref.referenceKind) || NON_SYMBOL_KINDS.has(candidate.kind)) return true;
    const target = dotnetTargetOf(candidate, context);
    // An instance member on a value is the value's type's: that is the C# or VB.NET
    // resolver's to know (`var o = new Order(…); o.Confirm()`), not the written name's.
    if (!target.isStatic && ref.referenceName.includes('.')) return true;
    const file = dotnetFileScopeOf(ref, context, dotnetScope);
    return file !== null && isFsharpReachableFromDotnet(file, writtenDotnetName(ref, context), target);
  }
  // A Razor component is not something F# names.
  if (candidate.language === 'razor') return false;
  if (!SCOPED_LANGUAGES.has(candidate.language)) return true;
  if (!SYMBOL_REFERENCE_KINDS.has(ref.referenceKind) || NON_SYMBOL_KINDS.has(candidate.kind)) return true;
  // A call invokes something; a module is a scope — in any file, so a `module Order` beside `type Order` is not its constructor.
  if (ref.referenceKind === 'calls' && candidate.kind === 'module') return false;

  const sameFile = candidate.filePath === ref.filePath;
  const refScope = scopeOfRef(ref, context);

  const scope = scopeOfCandidate(candidate, context);
  // A C# or VB.NET declaration outside every namespace is global.
  if (candidate.language !== 'fsharp' && scope.container === '') return true;
  return isFsharpCandidateReachable(refScope, scope, sameFile);
}
