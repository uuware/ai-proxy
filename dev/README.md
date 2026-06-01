# AI Proxy development tools

This directory contains helper tooling that is useful while developing or releasing the extension.

## Packaging

VS Code Marketplace and Open VSX use the same extension package format: a `.vsix` file. The packaging helper can create one package for the VS Code Marketplace output folder, one package for the Open VSX output folder, or both.

From the `ai-proxy` directory:

```cmd
npm install
npm run package:vsix
npm run package:vsx
npm run package:all
```

Outputs:

- `dist/vscode-marketplace/*.vsix` for VS Code Marketplace.
- `dist/open-vsx/*.vsix` for Open VSX.

The two files are the same package format. They are written to separate folders only so it is clear where each package is intended to be uploaded or published.

## Publishing

VS Code Marketplace publishing can use `vsce publish`, or you can upload the generated `.vsix` package manually in the publisher portal.

Open VSX publishing can use `ovsx publish dist/open-vsx/<package>.vsix -p <token>`. Keep the token in a secure environment variable or secret store; do not commit tokens to the repository.
