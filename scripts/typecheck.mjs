import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ts = require(process.env.PI_VERIFICATION_TYPESCRIPT || 'typescript');
const file = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
if (file.error) throw new Error(ts.flattenDiagnosticMessageText(file.error.messageText, '\n'));
const config = ts.parseJsonConfigFileContent(file.config, ts.sys, process.cwd());
if (process.env.PI_VERIFICATION_HOST_ROOT) {
  const modules = resolve(process.env.PI_VERIFICATION_HOST_ROOT, 'node_modules');
  config.options.baseUrl = process.cwd();
  config.options.paths = {
    '@earendil-works/pi-coding-agent': [resolve(modules, '@earendil-works/pi-coding-agent/dist/index.d.ts')],
    typebox: [resolve(modules, 'typebox/build/index.d.mts')],
  };
  config.options.typeRoots = [resolve(modules, '@types')];
}
const program = ts.createProgram(config.fileNames, config.options);
const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getCanonicalFileName: path => path,
    getNewLine: () => '\n',
  }));
  process.exitCode = 1;
} else console.log(`Typecheck passed (TypeScript ${ts.version}).`);
