# Editor support for `.flow` files

Syntax highlighting for `.flow` scenario files used by quiver. Highlights:

- **Comments** (`# ...`) — grey
- **Step keywords** (`Visit`, `Goto`, `Click`, `ClickLink`, `ClickButton`, `FillIn`, `Choose`, etc.) — keyword colour
- **Header directives** (`Start`, `Scope`, `Exclude`, etc.) — function colour
- **Dividers** (`--- Setup ---`, `--- Map ---`) — constant colour
- **Quoted strings** (`"selector"`) — string colour

## Zed

Zed uses tree-sitter grammars. Install the extension as a dev extension:

1. Open Zed
2. Open the command palette (Cmd+Shift+P)
3. Run `zed: install dev extension`
4. Select the `editor/zed-flow-syntax` directory

Your `.flow` files should immediately get syntax highlighting. If you need to update the extension after changes, repeat the steps above.

## VS Code

Symlink the extension folder into your VS Code extensions directory:

```bash
# macOS / Linux (run from the quiver repo root)
ln -s "$(pwd)/editor/vscode-flow-syntax" ~/.vscode/extensions/flow-scenario-syntax

# Then reload VS Code (Cmd+Shift+P → "Developer: Reload Window")
```

Or, to install as a packaged extension:

```bash
cd editor/vscode-flow-syntax
npx @vscode/vsce package
code --install-extension flow-scenario-syntax-0.1.0.vsix
```

## Sublime Text

Copy the TextMate grammar into your Sublime Text packages:

```bash
# macOS
mkdir -p ~/Library/Application\ Support/Sublime\ Text/Packages/Flow
cp editor/vscode-flow-syntax/syntaxes/flow.tmLanguage.json \
   ~/Library/Application\ Support/Sublime\ Text/Packages/Flow/
```

Sublime Text will pick it up automatically for `.flow` files.

## Other editors

- **TextMate grammar** (VS Code, Sublime, and others): `editor/vscode-flow-syntax/syntaxes/flow.tmLanguage.json`
- **Tree-sitter grammar** (Zed, Neovim, Helix, and others): [tree-sitter-flow-scenario](https://github.com/michaelgallagher/tree-sitter-flow-scenario)
