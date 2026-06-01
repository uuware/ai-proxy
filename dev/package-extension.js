#!/usr/bin/env node

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const targetInfo = {
  marketplace: {
    label: 'VS Code Marketplace',
    outputDirName: 'vscode-marketplace',
  },
  openVsx: {
    label: 'Open VSX',
    outputDirName: 'open-vsx',
  },
};

main();

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
      printHelp();
      return;
    }

    const pkg = readPackageJson();
    const targets = expandTargets(options.targets);

    if (options.clean) {
      fs.rmSync(distDir, { recursive: true, force: true });
    }

    if (!options.skipCheck) {
      runNpm(['run', 'check']);
    }

    const createdFiles = [];
    for (const target of targets) {
      createdFiles.push(packageTarget(pkg, target, options));
    }

    console.log('');
    console.log('Created extension package(s):');
    for (const file of createdFiles) {
      console.log(`- ${path.relative(rootDir, file)}`);
    }
    console.log('');
    console.log('VS Code Marketplace and Open VSX both consume .vsix files.');
    console.log('The separate output folders only make the intended destination clear.');
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  }
}

function parseArgs(args) {
  const options = {
    targets: [],
    clean: false,
    preRelease: false,
    skipCheck: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--target' || arg === '-t') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('Missing value after --target.');
      }
      index += 1;
      addTargets(options.targets, value);
      continue;
    }

    if (arg === '--all') {
      options.targets.push('all');
      continue;
    }

    if (arg === '--vsix' || arg === '--marketplace') {
      options.targets.push('marketplace');
      continue;
    }

    if (arg === '--vsx' || arg === '--open-vsx') {
      options.targets.push('openVsx');
      continue;
    }

    if (arg === '--clean') {
      options.clean = true;
      continue;
    }

    if (arg === '--pre-release') {
      options.preRelease = true;
      continue;
    }

    if (arg === '--skip-check') {
      options.skipCheck = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function addTargets(targets, value) {
  for (const part of String(value).split(',')) {
    const normalized = normalizeTarget(part.trim());
    if (normalized) {
      targets.push(normalized);
    }
  }
}

function normalizeTarget(value) {
  const key = value.toLowerCase();

  if (key === 'all') {
    return 'all';
  }

  if (key === 'marketplace' || key === 'vscode' || key === 'vsix') {
    return 'marketplace';
  }

  if (key === 'open-vsx' || key === 'openvsx' || key === 'vsx') {
    return 'openVsx';
  }

  throw new Error(`Unknown package target: ${value}`);
}

function expandTargets(targets) {
  const requested = targets.length > 0 ? targets : ['marketplace'];
  const expanded = [];

  for (const target of requested) {
    if (target === 'all') {
      pushUnique(expanded, 'marketplace');
      pushUnique(expanded, 'openVsx');
      continue;
    }

    pushUnique(expanded, target);
  }

  return expanded;
}

function pushUnique(values, value) {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function readPackageJson() {
  const filePath = path.join(rootDir, 'package.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function packageTarget(pkg, target, options) {
  const info = targetInfo[target];
  if (!info) {
    throw new Error(`Unsupported package target: ${target}`);
  }

  const outputDir = path.join(distDir, info.outputDirName);
  const outputFile = getOutputFile(pkg, target);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('');
  console.log(`Packaging ${info.label} package...`);

  const args = ['--yes', '@vscode/vsce', 'package', '--allow-missing-repository', '--no-rewrite-relative-links'];

  if (options.preRelease) {
    args.push('--pre-release');
  }

  args.push('--out', outputFile);

  runNpx(args);
  return outputFile;
}

function getOutputFile(pkg, target) {
  const info = targetInfo[target];
  const outputDir = path.join(distDir, info.outputDirName);
  return path.join(outputDir, `${pkg.name}-${pkg.version}.vsix`);
}

function runNpm(args) {
  runCommand(resolveCommand('npm'), args);
}

function runNpx(args) {
  runCommand(resolveCommand('npx'), args);
}

function resolveCommand(command) {
  return process.platform === 'win32' ? `${command}.cmd` : command;
}

function runCommand(command, args) {
  const spawnCommand = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : command;
  const spawnArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command, ...args] : args;

  const result = cp.spawnSync(spawnCommand, spawnArgs, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function printHelp() {
  console.log(`Usage: node ./dev/package-extension.js [options]

Options:
  -t, --target <target>  Package target: marketplace, vsix, open-vsx, vsx, or all.
  --marketplace         Shortcut for --target marketplace.
  --vsix                Shortcut for --target marketplace.
  --open-vsx            Shortcut for --target open-vsx.
  --vsx                 Shortcut for --target open-vsx.
  --all                 Build both marketplace and open-vsx packages.
  --clean               Remove ./dist before packaging.
  --pre-release         Pass --pre-release to vsce.
  --skip-check          Skip npm run check.
  -h, --help            Show this help.
`);
}
