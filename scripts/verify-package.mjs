import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const packageName = '@verdict/node';
const allowedTopLevel = new Set(['CHANGELOG.md', 'LICENSE', 'README.md', 'dist', 'package.json']);
const requiredFiles = new Set([
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/middleware/index.d.ts',
  'dist/middleware/index.js',
  'package.json',
]);

function run(command, args, options = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      key.toLowerCase() === 'npm_config_allow_scripts' ||
      key.toLowerCase() === 'npm_config_dangerously_allow_all_scripts' ||
      key.toLowerCase() === 'npm_config_userconfig'
    ) {
      delete environment[key];
    }
  }
  environment.HOME = homeDirectory;
  environment.NPM_CONFIG_USERCONFIG = '/dev/null';

  return execFileSync(command, args, {
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function assertPackageInventory(files) {
  const paths = new Set(files.map(file => file.path));

  for (const required of requiredFiles) {
    if (!paths.has(required)) {
      throw new Error(`package is missing required file: ${required}`);
    }
  }

  for (const path of paths) {
    const topLevel = path.split('/')[0];
    if (!allowedTopLevel.has(topLevel)) {
      throw new Error(`package contains unintended file: ${path}`);
    }
    if (
      path.startsWith('coverage/') ||
      path.startsWith('tests/') ||
      path.startsWith('scripts/') ||
      path.endsWith('.log') ||
      path.endsWith('.tgz') ||
      (path.endsWith('.ts') && !path.endsWith('.d.ts'))
    ) {
      throw new Error(`package contains generated or development artifact: ${path}`);
    }
  }
}

function assertSupportedToolchain() {
  const typescript = JSON.parse(
    readFileSync(resolve('node_modules/typescript/package.json'), 'utf8')
  );
  const tsJest = JSON.parse(readFileSync(resolve('node_modules/ts-jest/package.json'), 'utf8'));
  const typescriptVersion = String(typescript.version);
  const typescriptPeer = tsJest.peerDependencies?.typescript;
  if (!typescriptVersion.startsWith('5.9.')) {
    throw new Error(`Unsupported TypeScript ${typescriptVersion}; expected the 5.9.x line.`);
  }
  if (typescriptPeer !== '>=4.3 <7') {
    throw new Error(`Unexpected ts-jest TypeScript peer range: ${typescriptPeer}`);
  }
}

const workspace = mkdtempSync(join(tmpdir(), 'verdict-node-package-'));
const homeDirectory = join(workspace, 'home');
const packDirectory = join(workspace, 'pack');
const consumerDirectory = join(workspace, 'consumer');

try {
  assertSupportedToolchain();
  mkdirSync(homeDirectory);
  mkdirSync(packDirectory);
  mkdirSync(consumerDirectory);
  const packOutput = run('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    packDirectory,
  ]);
  const [packResult] = JSON.parse(packOutput);
  if (!packResult?.filename || !Array.isArray(packResult.files)) {
    throw new Error('npm pack did not return the expected JSON inventory');
  }
  assertPackageInventory(packResult.files);

  writeFileSync(
    join(workspace, 'package-inventory.json'),
    `${JSON.stringify(packResult.files, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ name: 'verdict-node-package-smoke', private: true, type: 'module' }, null, 2)}\n`,
    'utf8'
  );

  const tarball = join(packDirectory, basename(packResult.filename));
  run('npm', ['install', '--no-audit', '--no-fund', '--save-exact', tarball], {
    cwd: consumerDirectory,
  });

  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const root = await import(${JSON.stringify(packageName)});
       const middleware = await import(${JSON.stringify(`${packageName}/middleware`)});
       if (typeof root.LlmGateNode !== 'function' || typeof middleware.validate !== 'function') {
         throw new Error('package exports are incomplete');
       }`,
    ],
    { cwd: consumerDirectory }
  );

  writeFileSync(
    join(consumerDirectory, 'smoke.ts'),
    `import { LlmGateNode, OpenAIChatCompletionRequestSchema } from '${packageName}';
import { validate } from '${packageName}/middleware';

const gateway = new LlmGateNode({ baseUrl: 'http://127.0.0.1:20132/v1' });
void gateway;
void OpenAIChatCompletionRequestSchema;
void validate;
`,
    'utf8'
  );
  writeFileSync(
    join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2022',
        },
        include: ['smoke.ts'],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  const tsc = resolve('node_modules/.bin/tsc');
  run(tsc, ['--project', join(consumerDirectory, 'tsconfig.json')], {
    cwd: consumerDirectory,
  });

  const installedPackage = JSON.parse(
    readFileSync(
      join(consumerDirectory, 'node_modules', '@verdict', 'node', 'package.json'),
      'utf8'
    )
  );
  if (installedPackage.name !== packageName) {
    throw new Error('clean install resolved an unexpected package');
  }

  process.stdout.write(
    `Verified ${packResult.files.length} shipped files, clean ESM imports, and TypeScript declarations.\n`
  );
} finally {
  rmSync(workspace, { force: true, recursive: true });
}
