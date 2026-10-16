# 参与贡献

感谢你愿意改进 AdTrender。

1. 较大的改动先开 Issue 说明想法，避免重复劳动。
2. Fork 仓库，从 `main` 建分支开发。
3. 提交前运行验证：
   ```bash
   npm ci
   npx vitest run --config vitest.config.ts apps/worker
   REACT_APP_API_URL=https://api.example.invalid ./scripts/verify.sh
   ```
   需要数据库的集成测试会在缺少测试库时跳过，请在 PR 里如实写明跳过了哪些。
4. 提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/)，例如 `feat(collector): ...`、`fix(app): ...`。
5. 不要提交任何真实凭据、服务器地址或个人数据；配置示例只用 `example.com` 和文档保留地址（如 `203.0.113.0/24`）。

提交 Pull Request 即表示你同意以 [MIT 许可](LICENSE) 发布你的贡献。
