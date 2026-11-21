import { expect, test, vi } from 'vitest';
import {
  parseShaderBundle,
  ShaderBundleError,
  ShaderBundle,
  ShaderBundleDiagnostic,
} from './bundle.js';

// Virtual filesystem. Keys are absolute, POSIX style paths (the bundler
// normalizes every entry/include path to this form).
type Vfs = Record<string, string>;

const makeRead = (vfs: Vfs) => {
  const reads: string[] = [];
  const read = vi.fn((path: string): string | null => {
    reads.push(path);
    return Object.prototype.hasOwnProperty.call(vfs, path) ? vfs[path] : null;
  });
  return { read, reads };
};

const findDiagnostic = (
  bundle: ShaderBundle,
  code: ShaderBundleDiagnostic['code'],
  file?: string
): ShaderBundleDiagnostic => {
  const diagnostic = bundle.diagnostics.find(
    (d) => d.code === code && (file === undefined || d.file === file)
  );
  expect(diagnostic, `expected a ${code} diagnostic`).toBeDefined();
  return diagnostic!;
};

// First map entry that points at the given file
const firstEntryFor = (bundle: ShaderBundle, file: string) =>
  bundle.map.find((entry) => entry.file === file);

test('expands a single entry file and records it in files and map', () => {
  const { read } = makeRead({
    '/main.glsl': 'float x;\nfloat y;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  expect(bundle.diagnostics).toEqual([]);
  expect(bundle.files).toEqual(['/main.glsl']);
  expect(bundle.code).toContain('float x;');
  expect(bundle.code).toContain('float y;');

  const first = firstEntryFor(bundle, '/main.glsl')!;
  expect(first).toBeDefined();
  expect(first.line).toBe(1);
});

test('expands recursive relative includes and preserves first-visit order', () => {
  const { read } = makeRead({
    '/main.glsl':
      '#version 300 es\n#include "lib/a.glsl"\n#include "lib/b.glsl"\nvoid main() {}\n',
    '/lib/a.glsl': '#include "common.glsl"\nfloat a;\n',
    '/lib/b.glsl': 'float b;\n',
    '/lib/common.glsl': 'float common;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  expect(bundle.diagnostics).toEqual([]);
  expect(bundle.files).toEqual([
    '/main.glsl',
    '/lib/a.glsl',
    '/lib/common.glsl',
    '/lib/b.glsl',
  ]);

  // Each file's body appears exactly once in the generated code
  const occurrences = (needle: string) => bundle.code.split(needle).length - 1;
  expect(occurrences('float common;')).toBe(1);
  expect(occurrences('float a;')).toBe(1);
  expect(occurrences('float b;')).toBe(1);
  expect(occurrences('void main() {}')).toBe(1);

  // Include directives themselves are gone from the output
  expect(bundle.code).not.toContain('#include');

  // The map covers an entry for the entry and every include. Files whose
  // first source line is real content map that line (line 1); a.glsl's first
  // line is itself a stripped #include directive, so its first remaining
  // source line is line 2.
  for (const file of bundle.files) {
    const entry = firstEntryFor(bundle, file)!;
    expect(entry, `missing map entry for ${file}`).toBeDefined();
  }
  for (const contentFirst of [
    '/main.glsl',
    '/lib/common.glsl',
    '/lib/b.glsl',
  ]) {
    expect(firstEntryFor(bundle, contentFirst)!.line).toBe(1);
  }
  expect(firstEntryFor(bundle, '/lib/a.glsl')!.line).toBe(2);

  // A dedicated case where every include starts with real content: every
  // include gets a line-1 map entry and an explicit #line 1 directive.
  const simple = parseShaderBundle('main.glsl', {
    read: makeRead({
      '/main.glsl': '#version 300 es\n#include "x.glsl"\n#include "y.glsl"\n',
      '/x.glsl': 'float x;\n',
      '/y.glsl': 'float y;\n',
    }).read,
  });
  for (const file of ['/main.glsl', '/x.glsl', '/y.glsl']) {
    expect(firstEntryFor(simple, file)!.line).toBe(1);
  }
  expect(simple.code).toContain('#line 1 "/x.glsl"');
  expect(simple.code).toContain('#line 1 "/y.glsl"');
});

test('resolves nested relative includes relative to the including file', () => {
  const { read } = makeRead({
    '/shaders/main.glsl': '#include "lib/a.glsl"\n',
    '/shaders/lib/a.glsl': '#include "sub/b.glsl"\n',
    '/shaders/lib/sub/b.glsl': 'float b;\n',
  });

  const bundle = parseShaderBundle('shaders/main.glsl', { read });

  expect(bundle.diagnostics).toEqual([]);
  expect(bundle.files).toEqual([
    '/shaders/main.glsl',
    '/shaders/lib/a.glsl',
    '/shaders/lib/sub/b.glsl',
  ]);
  expect(bundle.code).toContain('float b;');
});

test('rejects absolute include paths with INCLUDE_OUTSIDE_ROOT', () => {
  const { read } = makeRead({
    '/main.glsl': '#include "/etc/secret.glsl"\nfloat after;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  const diagnostic = findDiagnostic(bundle, 'INCLUDE_OUTSIDE_ROOT');
  expect(diagnostic.file).toBe('/main.glsl');
  expect(diagnostic.line).toBe(1);
  expect(diagnostic.message).toContain('Absolute');

  // The bad include never reaches read(), and the rest of the file survives
  expect(read).not.toHaveBeenCalledWith('/etc/secret.glsl');
  expect(bundle.code).toContain('float after;');
});

test('rejects ".." escaping the root directory with INCLUDE_OUTSIDE_ROOT', () => {
  const { read } = makeRead({
    '/shaders/main.glsl': '#include "../outside.glsl"\n',
    '/outside.glsl': 'float o;\n',
  });

  const bundle = parseShaderBundle('shaders/main.glsl', { read });

  const diagnostic = findDiagnostic(bundle, 'INCLUDE_OUTSIDE_ROOT');
  expect(diagnostic.file).toBe('/shaders/main.glsl');
  expect(read).not.toHaveBeenCalledWith('/outside.glsl');
});

test('allows ".." that stays inside the root directory', () => {
  const { read } = makeRead({
    '/shaders/main.glsl': '#include "lib/../sibling.glsl"\n',
    '/shaders/sibling.glsl': 'float s;\n',
  });

  const bundle = parseShaderBundle('shaders/main.glsl', { read });

  expect(bundle.diagnostics).toEqual([]);
  expect(bundle.files).toContain('/shaders/sibling.glsl');
  expect(bundle.code).toContain('float s;');
});

test('reports INCLUDE_CYCLE for circular includes and still returns partial output', () => {
  const { read } = makeRead({
    '/main.glsl': '#include "a.glsl"\nfloat mainBody;\n',
    '/a.glsl': '#include "b.glsl"\nfloat aBody;\n',
    '/b.glsl': '#include "a.glsl"\nfloat bBody;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  const diagnostic = findDiagnostic(bundle, 'INCLUDE_CYCLE');
  // The diagnostic points at the include line in the file that closes the loop
  expect(diagnostic.file).toBe('/b.glsl');
  expect(diagnostic.line).toBe(1);
  expect(diagnostic.message).toContain('a.glsl');

  // Files already visited before the cycle are still recorded
  expect(bundle.files).toEqual(['/main.glsl', '/a.glsl', '/b.glsl']);
  expect(bundle.code).toContain('float mainBody;');
});

test('#pragma once guarantees a file is expanded only once', () => {
  const { read } = makeRead({
    '/main.glsl':
      '#include "p.glsl"\n#include "p.glsl"\n#include "nested.glsl"\nfloat mainBody;\n',
    '/p.glsl': '#pragma once\nfloat pBody;\n',
    '/nested.glsl': '#include "p.glsl"\nfloat nestedBody;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  expect(bundle.diagnostics).toEqual([]);
  expect(bundle.code.split('float pBody;').length - 1).toBe(1);
  expect(bundle.files).toEqual(['/main.glsl', '/p.glsl', '/nested.glsl']);
  expect(bundle.code).toContain('float nestedBody;');
  expect(bundle.code).toContain('float mainBody;');
});

test('does not read or expand includes inside an untaken "#if 0" branch', () => {
  const { read, reads } = makeRead({
    '/main.glsl':
      '#version 300 es\n#if 0\n#include "missing.glsl"\n#endif\n#if 1\n#include "present.glsl"\n#endif\n',
    '/present.glsl': 'float present;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  expect(bundle.diagnostics).toEqual([]);
  expect(reads).not.toContain('/missing.glsl');
  expect(reads).toContain('/present.glsl');
  expect(bundle.code).toContain('float present;');
  expect(bundle.code).not.toContain('missing');
});

test('evaluates #ifdef / #ifndef / #elif with the core preprocessor semantics', () => {
  const { read } = makeRead({
    '/main.glsl':
      '#ifdef FEATURE_A\n#include "a.glsl"\n#elif defined(FEATURE_B)\n#include "b.glsl"\n#else\n#include "c.glsl"\n#endif\n',
    '/a.glsl': 'float a;\n',
    '/b.glsl': 'float b;\n',
    '/c.glsl': 'float c;\n',
  });

  const bundleA = parseShaderBundle('main.glsl', {
    read,
    defines: { FEATURE_A: true },
  });
  expect(bundleA.diagnostics).toEqual([]);
  expect(bundleA.code).toContain('float a;');
  expect(bundleA.code).not.toContain('float b;');
  expect(bundleA.code).not.toContain('float c;');

  const bundleB = parseShaderBundle('main.glsl', {
    read,
    defines: { FEATURE_B: true },
  });
  expect(bundleB.code).toContain('float b;');
  expect(bundleB.code).not.toContain('float a;');

  const bundleC = parseShaderBundle('main.glsl', { read });
  expect(bundleC.code).toContain('float c;');
});

test('options.defines participate in #if expressions and macro expansion', () => {
  const { read } = makeRead({
    '/main.glsl':
      '#version 300 es\n#if MAX_LIGHTS > 1\nfloat many;\n#endif\nint count = MAX_LIGHTS;\n',
  });

  const bundle = parseShaderBundle('main.glsl', {
    read,
    defines: { MAX_LIGHTS: 4 },
  });

  expect(bundle.diagnostics).toEqual([]);
  expect(bundle.code).toContain('float many;');
  expect(bundle.code).toContain('int count = 4;');
});

test('macros defined in an included file expand in the parent file', () => {
  const { read } = makeRead({
    '/main.glsl':
      '#version 300 es\n#include "constants.glsl"\nvec3 color = COLOR;\n',
    '/constants.glsl': '#define COLOR vec3(1.0)\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  expect(bundle.diagnostics).toEqual([]);
  expect(bundle.code).toContain('vec3 color = vec3(1.0);');
});

test('reports INCLUDE_NOT_FOUND when read() returns null', () => {
  const { read } = makeRead({
    '/main.glsl': '#include "ghost.glsl"\nfloat after;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  const diagnostic = findDiagnostic(bundle, 'INCLUDE_NOT_FOUND');
  expect(diagnostic).toMatchObject({
    code: 'INCLUDE_NOT_FOUND',
    file: '/main.glsl',
    line: 1,
  });
  expect(diagnostic.message).toContain('ghost.glsl');
  expect(bundle.code).toContain('float after;');
});

test('reports VERSION_IN_INCLUDE when an included file contains #version', () => {
  const { read } = makeRead({
    '/main.glsl': '#version 300 es\n#include "bad.glsl"\nfloat after;\n',
    '/bad.glsl': '#version 300 es\nfloat bad;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  const diagnostic = findDiagnostic(bundle, 'VERSION_IN_INCLUDE', '/bad.glsl');
  expect(diagnostic.line).toBe(1);
  // The include body is still emitted, minus its illegal #version
  expect(bundle.code).toContain('float bad;');
  expect(bundle.code).toContain('float after;');
});

test('keeps the entry #version on the first physical output line', () => {
  const { read } = makeRead({
    '/main.glsl':
      '// header comment\n\n#include "lib.glsl"\n#version 300 es\nvoid main() {}\n',
    '/lib.glsl': 'float lib;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  expect(bundle.diagnostics).toEqual([]);
  expect(bundle.code.split('\n')[0]).toBe('#version 300 es');

  // And the map says generated line 1 is source line 1's directive
  expect(bundle.map[0]).toMatchObject({
    generatedLine: 1,
    file: '/main.glsl',
    line: 4,
  });
});

test('emits #line directives before each expanded fragment', () => {
  const { read } = makeRead({
    '/main.glsl':
      '#version 300 es\n#include "a.glsl"\n#include "b.glsl"\nvoid main() {}\n',
    '/a.glsl': 'float a;\n',
    '/b.glsl': 'float b;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });
  const lines = bundle.code.split('\n');

  const lineA = lines.indexOf('#line 1 "/a.glsl"');
  const lineB = lines.indexOf('#line 1 "/b.glsl"');
  expect(lineA).toBeGreaterThanOrEqual(0);
  expect(lineB).toBeGreaterThan(lineA);

  // Each #line directive itself is not a source line in the map; the line
  // after each directive maps to the include's first source line.
  const entryA = firstEntryFor(bundle, '/a.glsl')!;
  expect(entryA).toMatchObject({ file: '/a.glsl', line: 1 });
  expect(lines[entryA.generatedLine - 1]).toBe('float a;');
});

test('the source map stays accurate across stripped directives and includes', () => {
  const { read } = makeRead({
    '/main.glsl':
      '#version 300 es\n#define X 1\nfloat x = X;\n#include "lib.glsl"\nfloat y;\n',
    '/lib.glsl': '#define Z 2\nfloat z = Z;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });
  const generatedLines = bundle.code.split('\n');

  for (const entry of bundle.map) {
    const physical = generatedLines[entry.generatedLine - 1];
    // Every mapped generated line must actually exist
    expect(physical).toBeDefined();
    // No map entry may point at an inserted #line directive
    expect(physical.startsWith('#line')).toBe(false);
  }

  // The generated line claiming to be /lib.glsl source line 2 holds its body
  const libEntry = firstEntryFor(bundle, '/lib.glsl')!;
  expect(generatedLines[libEntry.generatedLine - 1]).toBe('float z = 2;');
});

test('non-strict mode collects all diagnostics without throwing', () => {
  const { read } = makeRead({
    '/main.glsl': '#include "missing.glsl"\n#include "/absolute.glsl"\n',
  });

  let bundle: ShaderBundle;
  expect(() => {
    bundle = parseShaderBundle('main.glsl', { read });
  }).not.toThrow();

  const codes = bundle!.diagnostics.map((d) => d.code).sort();
  expect(codes).toEqual(['INCLUDE_NOT_FOUND', 'INCLUDE_OUTSIDE_ROOT'].sort());
});

test('strict mode throws ShaderBundleError carrying all diagnostics', () => {
  const { read } = makeRead({
    '/main.glsl': '#include "missing.glsl"\n',
  });

  try {
    parseShaderBundle('main.glsl', { read, strict: true });
    throw new Error('expected parseShaderBundle to throw');
  } catch (e) {
    expect(e).toBeInstanceOf(ShaderBundleError);
    const error = e as ShaderBundleError;
    expect(error.diagnostics).toHaveLength(1);
    expect(error.diagnostics[0].code).toBe('INCLUDE_NOT_FOUND');
    expect(error.message).toContain('INCLUDE_NOT_FOUND');
  }
});

test('strict=false is the default', () => {
  const { read } = makeRead({
    '/main.glsl': '#include "missing.glsl"\n',
  });

  expect(() => parseShaderBundle('main.glsl', { read })).not.toThrow();
});

test('normalizes CRLF line endings and keeps line numbers stable', () => {
  const { read } = makeRead({
    '/main.glsl': '#version 300 es\r\nfloat a;\r\nfloat b;\r\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  expect(bundle.code).not.toContain('\r');
  const entries = bundle.map.filter((e) => e.file === '/main.glsl');
  expect(entries.map((e) => e.line)).toEqual([1, 2, 3]);
});

test('preserves functional #extension directives in the output', () => {
  const { read } = makeRead({
    '/main.glsl': '#version 300 es\n#extension GL_EXT_foo : enable\nfloat a;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  expect(bundle.code).toContain('#extension GL_EXT_foo : enable');
});

test('handles includes inside nested and elif conditionals', () => {
  const vfs: Vfs = {
    '/main.glsl':
      '#version 300 es\n#ifdef OUTER\n  #ifdef INNER\n  #include "inner.glsl"\n  #endif\n#elif defined(BRANCH)\n#include "branch.glsl"\n#endif\n',
    '/inner.glsl': 'float inner;\n',
    '/branch.glsl': 'float branch;\n',
  };

  const nested = parseShaderBundle('main.glsl', {
    read: makeRead(vfs).read,
    // Feature flags are tested with #ifdef, which works for any define value
    defines: { OUTER: true, INNER: true },
  });
  expect(nested.diagnostics).toEqual([]);
  expect(nested.code).toContain('float inner;');
  expect(nested.code).not.toContain('float branch;');
  expect(nested.files).toContain('/inner.glsl');
  expect(nested.files).not.toContain('/branch.glsl');

  const elif = parseShaderBundle('main.glsl', {
    read: makeRead(vfs).read,
    defines: { BRANCH: true },
  });
  expect(elif.code).toContain('float branch;');
  expect(elif.code).not.toContain('float inner;');

  const none = parseShaderBundle('main.glsl', {
    read: makeRead(vfs).read,
  });
  expect(none.code).not.toContain('float inner;');
  expect(none.code).not.toContain('float branch;');
  expect(none.files).toEqual(['/main.glsl']);
});

test('a re-included file expands only once and keeps first-visit ordering', () => {
  const { read } = makeRead({
    '/main.glsl': '#include "guard.glsl"\n#include "guard.glsl"\nfloat m;\n',
    '/guard.glsl': '#ifndef GUARD_H\n#define GUARD_H\nfloat guard;\n#endif\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  expect(bundle.diagnostics).toEqual([]);
  // Each path's body appears in code at most once
  expect(bundle.code.split('float guard;').length - 1).toBe(1);
  expect(bundle.files).toEqual(['/main.glsl', '/guard.glsl']);
});

test('macro expansion does not change the number of source lines', () => {
  const { read } = makeRead({
    '/main.glsl':
      '#version 300 es\n#define A 1\n#define B 2\nfloat x = A + B;\nfloat y;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });
  const mappedLines = bundle.map
    .filter((e) => e.file === '/main.glsl')
    .map((e) => e.line);

  // The two #define lines are stripped; the surviving source lines map 1:1
  expect(mappedLines).toEqual([1, 4, 5]);
  expect(bundle.code).toContain('float x = 1 + 2;');
});

test('entry without #version still emits a line sync and a line-1 map entry', () => {
  const { read } = makeRead({
    '/main.glsl': 'float a;\nfloat b;\n',
  });

  const bundle = parseShaderBundle('main.glsl', { read });

  expect(bundle.code.startsWith('#line 1 "/main.glsl"')).toBe(true);
  expect(firstEntryFor(bundle, '/main.glsl')).toMatchObject({
    file: '/main.glsl',
    line: 1,
  });
});
