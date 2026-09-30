# CLAUDE.md

## 代码格式（必须遵守）

- 每次修改了代码，在结束任务、回复用户之前，都必须在仓库根目录运行一次：

  ```
  npm run format
  ```

- 然后运行 `npm run format:check`，确认输出 `All matched files use Prettier code style!`。检查不通过就不算完成。
- 不要手动调整格式来"对齐"Prettier，也不要改 `.prettierrc.json` 里的配置（`printWidth: 120`，其余用 Prettier 默认值）。格式一律以 Prettier 的输出为准。
- 格式化范围是 `src`、`tests`、`scripts` 下的 ts/vue/js/cjs/mjs/css/html/json 文件。`src/prompt-bundle/generated.ts` 是生成文件，已在 `.prettierignore` 中排除，不要格式化或手改。

## 其他约定

- 文本文件一律使用 LF 换行（见 `.gitattributes`）。写文件时不要引入 CRLF。
- `tsconfig.json` 开启了 `noUnusedLocals`、`noUnusedParameters`、`noImplicitReturns`、`noFallthroughCasesInSwitch`。不要留下未使用的变量、参数或导入；接口要求但用不到的参数用 `_` 前缀命名。
- 修改了 `resources/prompt-bundle/` 下的任何文件后，要运行 `npm run bundle:build` 重新生成 manifest，否则提示词包校验会失败。
