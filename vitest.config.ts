import { configDefaults, defineConfig } from "vitest/config";

// Match tsup's `.html` text loader (tsup.config.ts) so `import html from
// './generated/index.html'` returns the file's contents as a string under
// vitest too. Without this, vite's import-analysis tries to parse the built
// console HTML as JS and fails.
export default defineConfig({
  test: {
    // `.worktrees/**` holds git worktree checkouts of this same repo; without
    // excluding them, a test run from the main checkout collects every test a
    // second time (and they can fight over shared fixtures).
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
  },
  plugins: [
    {
      name: "html-string-loader",
      enforce: "pre",
      transform(code: string, id: string) {
        if (id.endsWith(".html")) {
          return { code: `export default ${JSON.stringify(code)};`, map: null };
        }
        return null;
      },
    },
  ],
});
