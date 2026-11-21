import {
  buildMacros,
  evaluateCondition,
  evaluatePreprocessorExpression,
  expandMacros,
  preprocessComments,
} from './preprocessor.js';
import type { Macros } from './preprocessor.js';
import * as parser from './preprocessor-parser.js';
import { formatError } from '../error.js';
import generate from './generator.js';
import type { PreprocessorProgram } from './preprocessor.js';
import type {
  PreprocessorAstNode,
  PreprocessorConditionalNode,
  PreprocessorDefineNode,
  PreprocessorDefineArgumentsNode,
  PreprocessorIncludeNode,
  PreprocessorPragmaNode,
  PreprocessorSegmentNode,
  PreprocessorTextNode,
  PreprocessorVersionNode,
} from './preprocessor-node.js';

/** A single source map entry: generated line N corresponds to a source line. */
export interface SourceMapEntry {
  /** 1-based line number in the generated/bundled code */
  generatedLine: number;
  /** Path of the source file this line came from */
  file: string;
  /** 1-based line number in the source file */
  line: number;
}

/** A diagnostic collected while bundling. */
export interface ShaderBundleDiagnostic {
  /** Stable machine readable error code */
  code:
    | 'INCLUDE_NOT_FOUND'
    | 'INCLUDE_OUTSIDE_ROOT'
    | 'INCLUDE_CYCLE'
    | 'VERSION_IN_INCLUDE';
  /** Path of the file the diagnostic refers to */
  file: string;
  /** 1-based line number in that file */
  line: number;
  /** Human readable message */
  message: string;
}

export interface ParseShaderBundleOptions {
  /**
   * Read a file by path. Returns the file text, or null/undefined if the file
   * doesn't exist. The bundler never touches the filesystem itself.
   */
  read: (path: string) => string | null | undefined;
  /** Predefined macros, seeded the same way as preprocessor defines */
  defines?: Record<string, string | number | boolean>;
  /** When true, any error diagnostic makes parseShaderBundle throw */
  strict?: boolean;
}

export interface ShaderBundle {
  /** The fully expanded, single-file GLSL source code */
  code: string;
  /** Every file that contributed to the bundle, in first-visit order */
  files: string[];
  /** Generated-line to source-line mappings, in generated line order */
  map: SourceMapEntry[];
  /** All diagnostics collected while bundling */
  diagnostics: ShaderBundleDiagnostic[];
}

/** Error thrown in strict mode. Carries every collected diagnostic. */
export class ShaderBundleError extends Error {
  diagnostics: ShaderBundleDiagnostic[];

  constructor(diagnostics: ShaderBundleDiagnostic[]) {
    super(
      diagnostics.length
        ? `Failed to bundle shader: ${diagnostics
            .map((d) => `${d.code} (${d.file}:${d.line})`)
            .join(', ')}`
        : 'Failed to bundle shader'
    );
    this.name = 'ShaderBundleError';
    this.diagnostics = diagnostics;
  }
}

// Normalize every line ending to "\n" so line bookkeeping is predictable,
// regardless of whether a source file uses Unix or Windows line endings.
const normalizeNewlines = (src: string): string => src.replace(/\r\n?/g, '\n');

const splitSegments = (relative: string): string[] =>
  relative.split('/').filter((part) => part !== '' && part !== '.');

const dirname = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.substring(0, index);
};

interface Chunk {
  // Raw text to append to the output
  text: string;
  // Source mapping for each line of this chunk, parallel to the lines of
  // text (the trailing element after a final newline is excluded). An entry
  // of null means the generated line has no source mapping (an inserted
  // #line directive).
  sources: (SourceMapEntry | null)[];
}

const parsePreprocessor = (src: string): PreprocessorProgram =>
  formatError(parser)(src, { startRule: 'program' });

/**
 * Resolve, validate, and recursively expand a shader entry point and all of
 * its transitive #include directives into one GLSL source string.
 *
 * The bundler reuses the preprocessor's own parser and conditional/macro
 * evaluation (no regex replacement of includes): each file is parsed to the
 * preprocessor AST, conditionals are evaluated with the same logic as
 * preprocessAst, and only includes in taken branches are read and expanded.
 */
export const parseShaderBundle = (
  entryPath: string,
  options: ParseShaderBundleOptions
): ShaderBundle => {
  const root = '/' + splitSegments(entryPath).join('/');
  const rootDir = dirname(root);
  const strict = options.strict ?? false;

  const diagnostics: ShaderBundleDiagnostic[] = [];
  const files: string[] = [];
  const chunks: Chunk[] = [];

  // Files marked with #pragma once: their path is expanded at most once
  const includedOnce = new Set<string>();
  // Every file whose body has already been fully expanded. A file is only
  // emitted into code once: a later #include of an already expanded file is
  // a no-op (whether or not it used #pragma once).
  const expandedFiles = new Set<string>();
  // Files currently being expanded, used to detect include cycles
  const activeStack: string[] = [];

  // One macro table for the whole expansion, shared across files, mirroring
  // how the C preprocessor (and preprocessAst) accumulates macros top to
  // bottom. Untaken conditional branches are never walked, so macros inside
  // them cannot leak.
  const macros: Macros = buildMacros(options.defines);

  // Line-tracking state. This mirrors what the GLSL compiler itself thinks
  // after processing the emitted #line directives: currentFile is the file
  // the next physical output line belongs to, and nextSourceLine is the
  // source line number that next physical line will have.
  let currentFile: string | null = null;
  let nextSourceLine = 1;

  const addDiagnostic = (
    code: ShaderBundleDiagnostic['code'],
    file: string,
    line: number,
    message: string
  ) => {
    diagnostics.push({ code, file, line, message });
  };

  // Append raw text to the output. A #line directive is inserted lazily
  // whenever the compiler's line tracking would otherwise be wrong (a new
  // fragment starts, an include returns, or source lines were stripped).
  const emit = (text: string, file: string, startLine: number) => {
    if (text === '') {
      return;
    }

    if (currentFile !== file || nextSourceLine !== startLine) {
      chunks.push({
        text: `#line ${startLine} "${file}"\n`,
        sources: [null],
      });
    }

    pushTextChunk(text, file, startLine);
  };

  // Emit text without a preceding #line sync. Used for the entry point's
  // #version directive, which by spec must stay on the first output line.
  const emitRaw = (text: string, file: string, startLine: number) => {
    if (text === '') {
      return;
    }
    pushTextChunk(text, file, startLine);
  };

  const pushTextChunk = (
    text: string,
    file: string,
    startLine: number
  ): void => {
    const lineCount = (text.match(/\n/g) || []).length;
    const lines = text.split('\n');
    // The final element after a trailing newline is not a real line
    const sources: (SourceMapEntry | null)[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
      sources.push({ generatedLine: 0, file, line: startLine + i });
    }
    chunks.push({ text, sources });

    currentFile = file;
    nextSourceLine = startLine + lineCount;
  };

  // Emit a preserved directive node (single line) using the preprocessor
  // generator, with a source map entry pointing at its source line.
  const emitDirective = (node: PreprocessorAstNode, file: string) => {
    emit(generate(node), file, node.loc?.start.line ?? 1);
  };

  // Resolve a quoted include path relative to the including file's
  // directory, keeping the result inside the root directory.
  const resolveInclude = (
    rawPath: string,
    currentFile: string,
    line: number
  ): string | null => {
    if (rawPath.startsWith('/')) {
      addDiagnostic(
        'INCLUDE_OUTSIDE_ROOT',
        currentFile,
        line,
        `Absolute include path "${rawPath}" is not allowed`
      );
      return null;
    }

    // Root-relative directory stack of the including file, then walk the
    // include path segment by segment. A ".." that would pop above the root
    // is an escape attempt and is rejected.
    const currentDir = dirname(currentFile);
    const stack =
      rootDir === '/'
        ? currentDir.split('/').filter((part) => part !== '')
        : currentDir
            .substring(rootDir.length + 1)
            .split('/')
            .filter(Boolean);

    for (const part of splitSegments(rawPath)) {
      if (part === '..') {
        if (stack.length === 0) {
          addDiagnostic(
            'INCLUDE_OUTSIDE_ROOT',
            currentFile,
            line,
            `Include "${rawPath}" resolves outside of the bundle root`
          );
          return null;
        }
        stack.pop();
      } else {
        stack.push(part);
      }
    }

    return rootDir === '/'
      ? '/' + stack.join('/')
      : rootDir + '/' + stack.join('/');
  };

  const walkBlocks = (blocks: PreprocessorAstNode[], file: string): void => {
    for (const block of blocks) {
      walkNode(block, file);
    }
  };

  const walkNode = (node: PreprocessorAstNode, file: string): void => {
    switch (node.type) {
      case 'segment':
        walkBlocks((node as PreprocessorSegmentNode).blocks, file);
        return;

      case 'text': {
        const textNode = node as PreprocessorTextNode;
        // Same macro expansion pass preprocessAst runs on text nodes
        emit(
          expandMacros(textNode.text, macros),
          file,
          textNode.loc?.start.line ?? 1
        );
        return;
      }

      case 'include':
        expandInclude(node as PreprocessorIncludeNode, file);
        return;

      case 'pragma': {
        const pragmaNode = node as PreprocessorPragmaNode;
        if (pragmaNode.body.trim() === 'once') {
          // Content of this file is only emitted on this first visit;
          // expandInclude checks includedOnce on every subsequent include.
          includedOnce.add(file);
          return;
        }
        emitDirective(node, file);
        return;
      }

      case 'conditional':
        walkConditional(node as PreprocessorConditionalNode, file);
        return;

      case 'define': {
        const defineNode = node as PreprocessorDefineNode;
        macros[defineNode.identifier.identifier] = {
          body: defineNode.body || '',
        };
        return;
      }

      case 'define_arguments': {
        const defineNode = node as PreprocessorDefineArgumentsNode;
        macros[defineNode.identifier.identifier] = {
          args: defineNode.args,
          body: defineNode.body,
        };
        return;
      }

      case 'undef':
        delete macros[node.identifier.identifier];
        return;

      case 'extension':
        // Functional GLSL directive: preserve it in the bundled output
        emitDirective(node, file);
        return;

      case 'line':
        // Source #line directives are stripped: the bundler emits its own
        // #line sync directives, and keeping these would corrupt tracking.
        return;

      case 'version':
      case 'error':
        // #version is handled specially in expandFile (entry only). #error
        // matches the default preprocessAst behavior of stripping it.
        return;

      default:
        // Expression nodes (if/elseif/literal/binary/...) only appear inside
        // conditionals, which are handled above.
        return;
    }
  };

  const walkConditional = (
    node: PreprocessorConditionalNode,
    file: string
  ): void => {
    // Reuse the preprocessor's exact conditional semantics (macro
    // expansion, defined(), operator precedence). Only the taken branch is
    // walked, so an #include inside "#if 0" is never even read.
    if (evaluateCondition(node.ifPart, macros)) {
      if (node.ifPart.body) {
        walkNode(node.ifPart.body, file);
      }
      return;
    }

    for (const elseIf of node.elseIfParts) {
      if (evaluatePreprocessorExpression(elseIf.expression, macros)) {
        if (elseIf.body) {
          walkNode(elseIf.body, file);
        }
        return;
      }
    }

    if (node.elsePart?.body) {
      walkNode(node.elsePart.body, file);
    }
  };

  const expandInclude = (
    node: PreprocessorIncludeNode,
    currentFile: string
  ): void => {
    const line = node.loc?.start.line ?? 1;
    const resolved = resolveInclude(node.path, currentFile, line);
    if (resolved === null) {
      return;
    }

    if (activeStack.includes(resolved)) {
      addDiagnostic(
        'INCLUDE_CYCLE',
        currentFile,
        line,
        `Include cycle detected while expanding "${node.path}": ${[
          ...activeStack,
          resolved,
        ].join(' -> ')}`
      );
      return;
    }

    if (includedOnce.has(resolved) || expandedFiles.has(resolved)) {
      // #pragma once, or a file already expanded into the output: each path
      // contributes its body at most once.
      return;
    }

    const sourceText = options.read(resolved);
    if (sourceText === null || sourceText === undefined) {
      addDiagnostic(
        'INCLUDE_NOT_FOUND',
        currentFile,
        line,
        `Include "${node.path}" could not be read (resolved to "${resolved}")`
      );
      return;
    }

    expandFile(resolved, sourceText);
  };

  const expandFile = (path: string, rawSource: string): void => {
    const isEntry = path === root;

    // files[] records first-visit order even if the file is later re-included
    if (!files.includes(path)) {
      files.push(path);
    }
    expandedFiles.add(path);
    activeStack.push(path);

    let program: PreprocessorProgram;
    try {
      program = parsePreprocessor(
        preprocessComments(normalizeNewlines(rawSource))
      );
    } catch (e) {
      activeStack.pop();
      throw e;
    }

    const blocks = (program.program as unknown) as PreprocessorAstNode[];
    const versionIndex = blocks.findIndex((block) => block.type === 'version');

    if (!isEntry && versionIndex !== -1) {
      const versionNode = blocks[versionIndex] as PreprocessorVersionNode;
      addDiagnostic(
        'VERSION_IN_INCLUDE',
        path,
        versionNode.loc?.start.line ?? 1,
        `#version is not allowed inside included file "${path}"`
      );
    }

    if (isEntry && versionIndex !== -1) {
      // Guarantee #version stays on the first physical output line: emit it
      // raw (no preceding #line sync), then whatever preceded it (only
      // comments/blank lines are legal there), then the rest of the file.
      const versionNode = blocks[versionIndex] as PreprocessorVersionNode;
      emitRaw(generate(versionNode), path, versionNode.loc?.start.line ?? 1);
      walkBlocks(blocks.slice(0, versionIndex), path);
      walkBlocks(blocks.slice(versionIndex + 1), path);
    } else {
      walkBlocks(blocks, path);
    }

    activeStack.pop();
  };

  // Kick off expansion from the entry point
  const entrySource = options.read(root);
  if (entrySource === null || entrySource === undefined) {
    addDiagnostic(
      'INCLUDE_NOT_FOUND',
      root,
      1,
      `Entry point "${entryPath}" could not be read`
    );
  } else {
    expandFile(root, entrySource);
  }

  // Stitch chunks together and assign final generated line numbers
  let code = '';
  const map: SourceMapEntry[] = [];
  let generatedLine = 1;
  for (const chunk of chunks) {
    code += chunk.text;
    for (const source of chunk.sources) {
      if (source !== null) {
        map.push({ ...source, generatedLine });
      }
      generatedLine++;
    }
  }

  if (strict && diagnostics.length > 0) {
    throw new ShaderBundleError(diagnostics);
  }

  return { code, files, map, diagnostics };
};
