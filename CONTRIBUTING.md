# 参与贡献

感谢你愿意改进 AdTrender。

1. 较大的改动先开 Issue 说明想法，避免重复劳动。
2. Fork 仓库，从 `main` 建分支开发。
3. 按 [本地配置说明](saas/README.md#本地配置与启动) 安装工具链和应用依赖后，在仓库根目录安装测试依赖及浏览器，再运行验证：
   ```bash
   export PATH="$PWD/saas/toolchain/node_modules/.bin:$PATH"
   npm ci --no-audit
   node node_modules/playwright/cli.js install chromium --no-shell
   REACT_APP_API_URL=https://api.example.invalid ./saas/scripts/verify.sh
   ```
   需要数据库的集成测试在未设置 `SAAS_TEST_DATABASE_URL` 时跳过；请在 PR 里如实写明跳过了哪些。运行这些测试前，先为独立本机测试库部署 `saas/app/migrations`，再显式设置 `SAAS_TEST_DATABASE_URL` 及同值的 `SAAS_OWNED_TEST_DATABASE_URL`。测试库名须含 `_test_`，不能复用开发库或生产库；全局 setup 会安装原生采集入库函数。`psql` 必须位于 `PATH`，或用 `PG_BIN` 指定其目录。

   `verify.sh` 会重新生成 `.wasp/`；运行前先停掉正在使用该目录的开发预览，避免生成期间的文件变化中断 Vite。
4. 提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/)，例如 `feat(collector): ...`、`fix(app): ...`。
5. 不要提交任何真实凭据、服务器地址或个人数据；配置示例只用 `example.com` 和文档保留地址（如 `203.0.113.0/24`）。

提交 Pull Request 即表示你同意以 [MIT 许可](LICENSE) 发布你的贡献。
