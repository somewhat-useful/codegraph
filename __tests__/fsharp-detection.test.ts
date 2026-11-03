/**
 * `.fs` is F#, but also the usual extension of GLSL fragment shaders and of
 * Forth. A `.fs` file is F# only by its content: a shader or Forth repository
 * must neither load the F# grammar nor have its files parsed into error trees.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectLanguage, isSourceFile, looksLikeFsharp } from '../src/extraction/grammars';
import { preloadLanguagesForFiles, scanDirectory } from '../src/extraction';

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
    expect(looksLikeFsharp('namespace global\n')).toBe(true);
    expect(looksLikeFsharp('﻿namespace Foo.Bar\r\n\r\nopen System // io\r\n')).toBe(true);
    expect(looksLikeFsharp('#r "nuget: FSharp.Data"\n')).toBe(true);
    expect(looksLikeFsharp('type Shape =\n  | Circle of float\n')).toBe(true);
  });

  it('keeps an F# file that holds a shader in a string F#', () => {
    expect(looksLikeFsharp(FSHARP_WITH_SHADER_STRING)).toBe(true);
  });

  it('reads an empty or comment-only file as not F#', () => {
    expect(looksLikeFsharp('')).toBe(false);
    expect(looksLikeFsharp('// nothing here\n')).toBe(false);
  });
});

describe('.fs detection', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fs-detect-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };

  it('detects a .fs file by its source', () => {
    expect(detectLanguage('src/Pricing.fs', FSHARP_MODULE)).toBe('fsharp');
    expect(detectLanguage('shaders/basic.fs', GLSL_FRAGMENT)).toBe('unknown');
    expect(detectLanguage('lib/sieve.fs', FORTH)).toBe('unknown');
  });

  it('always detects .fsx as F#, and never .fsi', () => {
    expect(detectLanguage('build.fsx')).toBe('fsharp');
    expect(isSourceFile('build.fsx')).toBe(true);
    expect(detectLanguage('src/Library.fsi')).not.toBe('fsharp');
    expect(isSourceFile('src/Library.fsi')).toBe(false);
  });

  it('counts a .fs file as source only when its content is F#', () => {
    write('src/Pricing.fs', FSHARP_MODULE);
    write('shaders/basic.fs', GLSL_FRAGMENT);
    write('forth/sieve.fs', FORTH);
    expect(isSourceFile('src/Pricing.fs', undefined, dir)).toBe(true);
    expect(isSourceFile('shaders/basic.fs', undefined, dir)).toBe(false);
    expect(isSourceFile('forth/sieve.fs', undefined, dir)).toBe(false);
    // Path-only detection reads the file from the root.
    expect(detectLanguage('src/Pricing.fs', undefined, undefined, dir)).toBe('fsharp');
    expect(detectLanguage('shaders/basic.fs', undefined, undefined, dir)).toBe('unknown');
  });

  it('still counts a .fs file that is gone, so a sync can drop it', () => {
    expect(isSourceFile('src/Deleted.fs', undefined, dir)).toBe(true);
  });

  it('leaves shaders and Forth out of a scan, and the F# grammar out of a shader repo', () => {
    write('shaders/basic.vs', '#version 330 core\nvoid main() {}\n');
    write('shaders/basic.fs', GLSL_FRAGMENT);
    write('shaders/post.fs', GLSL_ES_FRAGMENT);
    write('forth/sieve.fs', FORTH);
    write('src/main.c', 'int main(void) { return 0; }\n');

    const files = scanDirectory(dir);
    expect(files.filter((f) => f.endsWith('.fs'))).toEqual([]);
    expect(preloadLanguagesForFiles(files, undefined, dir)).not.toContain('fsharp');
    // Even handed the paths, the preload reads them and does not load F#.
    expect(preloadLanguagesForFiles(['shaders/basic.fs', 'forth/sieve.fs'], undefined, dir)).not.toContain('fsharp');
  });

  it('scans and preloads F# beside shaders', () => {
    write('shaders/basic.fs', GLSL_FRAGMENT);
    write('src/Pricing.fs', FSHARP_MODULE);
    write('src/Program.fs', FSHARP_PROGRAM);

    const files = scanDirectory(dir).filter((f) => f.endsWith('.fs')).sort();
    expect(files).toEqual(['src/Pricing.fs', 'src/Program.fs']);
    expect(preloadLanguagesForFiles(files, undefined, dir)).toContain('fsharp');
  });

  it('honours a codegraph.json mapping for .fs as the final answer', () => {
    write('shaders/basic.fs', GLSL_FRAGMENT);
    const overrides = { '.fs': 'fsharp' } as const;
    expect(isSourceFile('shaders/basic.fs', overrides, dir)).toBe(true);
    expect(detectLanguage('shaders/basic.fs', GLSL_FRAGMENT, overrides, dir)).toBe('fsharp');
  });
});
