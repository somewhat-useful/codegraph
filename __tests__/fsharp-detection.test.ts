/**
 * `.fs` is F#, but also the usual extension of GLSL fragment shaders and of
 * Forth. A `.fs` file whose head is not F# is skipped where its bytes are read,
 * like an MPEG transport stream named `.ts` (#1910): a shader or Forth
 * repository neither loads the F# grammar nor gets its files parsed into error
 * trees, and an F# file that turns into one is dropped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { detectLanguage, isForeignToExtension, isSourceFile, looksLikeFsharp } from '../src/extraction/grammars';
import { preloadLanguagesForFiles } from '../src/extraction';

const GLSL_FRAGMENT = `#version 330 core
out vec4 FragColor;
in vec2 TexCoord;
uniform sampler2D texture1;

void main()
{
    FragColor = texture(texture1, TexCoord);
}
`;

const GLSL_ES_FRAGMENT = `#ifdef GL_ES
precision mediump float;
#endif
varying vec2 vUv;
uniform float time;
void main() {
  gl_FragColor = vec4(vUv, 0.5 + 0.5 * sin(time), 1.0);
}
`;

/** A shader with no preprocessor line and no `void main` near the top. */
const GLSL_BARE = `// blur pass
in vec2 uv;
layout(location = 0) out vec4 color;
`;

const FORTH = `\\ Sieve of Eratosthenes
: prime? ( n -- f )
  dup 2 < if drop false exit then
  true swap 2 ?do i dup * over > if leave then
  dup i mod 0= if nip false swap leave then loop drop ;
variable count
: primes ( n -- ) 0 count ! 2 do i prime? if 1 count +! then loop ;
s" done" type cr
`;

const FSHARP_MODULE = `module Shop.Pricing

open System

let discount (rate: decimal) price = price * (1m - rate)
`;

const FSHARP_NAMESPACE = `// Licensed under the MIT license.
namespace Shop.Core

type Customer = { Name: string; Email: string }
`;

/** The last file of a project may skip the declaration. */
const FSHARP_PROGRAM = `[<EntryPoint>]
let main argv =
    printfn "Hello %A" argv
    0
`;

const FSHARP_WITH_SHADER_STRING = `module Render.Shaders

let fragment = """
#version 330 core
out vec4 FragColor;
void main() { FragColor = vec4(1.0); }
"""
`;

describe('looksLikeFsharp', () => {
  it('reads GLSL fragment shaders as not F#', () => {
    expect(looksLikeFsharp(GLSL_FRAGMENT)).toBe(false);
    expect(looksLikeFsharp(GLSL_ES_FRAGMENT)).toBe(false);
    expect(looksLikeFsharp(GLSL_BARE)).toBe(false);
  });

  it('reads Forth as not F#', () => {
    expect(looksLikeFsharp(FORTH)).toBe(false);
  });

  it('reads F# modules, namespaces and a declaration-less Program.fs as F#', () => {
    expect(looksLikeFsharp(FSHARP_MODULE)).toBe(true);
    expect(looksLikeFsharp(FSHARP_NAMESPACE)).toBe(true);
    expect(looksLikeFsharp(FSHARP_PROGRAM)).toBe(true);
    expect(looksLikeFsharp('module rec Parser\n')).toBe(true);
    expect(looksLikeFsharp('module internal rec Parser\n')).toBe(true);
    expect(looksLikeFsharp('namespace global\n')).toBe(true);
    expect(looksLikeFsharp('﻿namespace Foo.Bar\r\n\r\nopen System // io\r\n')).toBe(true);
    expect(looksLikeFsharp('#r "nuget: FSharp.Data"\n')).toBe(true);
    expect(looksLikeFsharp('type Shape =\n  | Circle of float\n')).toBe(true);
  });

  it('reads a BOM-led Program.fs whose only F# line is its first', () => {
    expect(looksLikeFsharp('﻿let main _ = 0\n')).toBe(true);
    expect(looksLikeFsharp('﻿[<EntryPoint>]\nmain\n')).toBe(true);
  });

  it('keeps an F# file that holds a shader in a string F#', () => {
    expect(looksLikeFsharp(FSHARP_WITH_SHADER_STRING)).toBe(true);
  });

  it('reads an empty or comment-only file as not F#', () => {
    expect(looksLikeFsharp('')).toBe(false);
    expect(looksLikeFsharp('// nothing here\n')).toBe(false);
  });
});

describe('isForeignToExtension', () => {
  const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');

  it('names a .fs shader or Forth file not F#, and an F# one nothing', () => {
    expect(isForeignToExtension('shaders/basic.fs', bytes(GLSL_FRAGMENT))).toBe('not-fsharp');
    expect(isForeignToExtension('lib/sieve.FS', bytes(FORTH))).toBe('not-fsharp');
    expect(isForeignToExtension('src/Pricing.fs', bytes(FSHARP_MODULE))).toBeNull();
  });

  it('leaves other extensions alone, .fsx included', () => {
    expect(isForeignToExtension('build.fsx', bytes(GLSL_FRAGMENT))).toBeNull();
    expect(isForeignToExtension('notes.txt', bytes(GLSL_FRAGMENT))).toBeNull();
  });

  it('takes a codegraph.json mapping for .fs as the answer', () => {
    expect(isForeignToExtension('shaders/basic.fs', bytes(GLSL_FRAGMENT), { '.fs': 'fsharp' })).toBeNull();
  });
});

describe('.fs by path', () => {
  it('is F# by path, as .fsx is, and .fsi is not indexed', () => {
    expect(detectLanguage('src/Pricing.fs')).toBe('fsharp');
    expect(isSourceFile('src/Pricing.fs')).toBe(true);
    expect(detectLanguage('build.fsx')).toBe('fsharp');
    expect(isSourceFile('src/Library.fsi')).toBe(false);
  });
});

const tempDirs: string[] = [];
function createProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fs-detect-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('preloading the F# grammar', () => {
  it('leaves it out for a repository of shaders and Forth', () => {
    const dir = createProject({
      'shaders/basic.fs': GLSL_FRAGMENT,
      'shaders/post.fs': GLSL_ES_FRAGMENT,
      'forth/sieve.fs': FORTH,
      'src/main.c': 'int main(void) { return 0; }\n',
    });
    const files = ['shaders/basic.fs', 'shaders/post.fs', 'forth/sieve.fs', 'src/main.c'];
    expect(preloadLanguagesForFiles(files, undefined, dir)).not.toContain('fsharp');
  });

  it('loads it when one .fs file is F#, when there is a .fsx, or when codegraph.json maps .fs', () => {
    const dir = createProject({ 'shaders/basic.fs': GLSL_FRAGMENT, 'src/Pricing.fs': FSHARP_MODULE, 'build.fsx': '' });
    expect(preloadLanguagesForFiles(['shaders/basic.fs', 'src/Pricing.fs'], undefined, dir)).toContain('fsharp');
    expect(preloadLanguagesForFiles(['shaders/basic.fs', 'build.fsx'], undefined, dir)).toContain('fsharp');
    expect(preloadLanguagesForFiles(['shaders/basic.fs'], { '.fs': 'fsharp' }, dir)).toContain('fsharp');
  });
});

describe('indexing .fs files', () => {
  it('indexes F# and skips shaders and Forth, counted as skipped, with no errors', async () => {
    const dir = createProject({
      'shaders/basic.fs': GLSL_FRAGMENT,
      'forth/sieve.fs': FORTH,
      'src/Pricing.fs': FSHARP_MODULE,
      'src/Program.fs': FSHARP_PROGRAM,
    });
    const cg = await CodeGraph.init(dir);
    try {
      const result = await cg.indexAll();
      expect(result.filesSkipped).toBe(2);
      expect(result.errors.filter((e) => e.filePath?.endsWith('.fs'))).toEqual([]);
      expect(cg.getFiles().map((f) => f.path).sort()).toEqual(['src/Pricing.fs', 'src/Program.fs']);
      expect(cg.searchNodes('discount').some((r) => r.node.filePath === 'src/Pricing.fs')).toBe(true);

      // A named sync (the watcher's path) does not let a shader in either.
      await cg.sync({ paths: ['shaders/basic.fs'] });
      expect(cg.getFiles().map((f) => f.path).sort()).toEqual(['src/Pricing.fs', 'src/Program.fs']);
    } finally {
      await cg.close();
    }
  });

  it('drops an F# file that becomes a shader, and takes it back when it is F# again', async () => {
    const dir = createProject({ 'src/Pricing.fs': FSHARP_MODULE, 'src/Program.fs': FSHARP_PROGRAM });
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(cg.getFiles().map((f) => f.path)).toContain('src/Pricing.fs');

      fs.writeFileSync(path.join(dir, 'src/Pricing.fs'), GLSL_FRAGMENT);
      await cg.sync({ paths: ['src/Pricing.fs'] });
      expect(cg.getFiles().map((f) => f.path)).not.toContain('src/Pricing.fs');
      expect(cg.searchNodes('discount').filter((r) => r.node.filePath === 'src/Pricing.fs')).toEqual([]);

      fs.writeFileSync(path.join(dir, 'src/Pricing.fs'), FSHARP_MODULE);
      await cg.sync({ paths: ['src/Pricing.fs'] });
      expect(cg.searchNodes('discount').some((r) => r.node.filePath === 'src/Pricing.fs')).toBe(true);
    } finally {
      await cg.close();
    }
  });
});
