import generate from './parser/generator.js';
import * as parser from './parser/parser.js';
import parse from './parser/index.js';
import { parseShaderBundle, ShaderBundleError } from './preprocessor/bundle.js';
import type {
  ParseShaderBundleOptions,
  ShaderBundle,
  ShaderBundleDiagnostic,
  SourceMapEntry,
} from './preprocessor/bundle.js';

// I tried "export * from './error.js'" here but it doesn't seem to make
// GlslSyntaxError available to consumers of the module?
export { GlslSyntaxError } from './error.js';

export { generate, parser, parse, parseShaderBundle, ShaderBundleError };
export type {
  ParseShaderBundleOptions,
  ShaderBundle,
  ShaderBundleDiagnostic,
  SourceMapEntry,
};
