# 本地图标资产

此目录仅用于本地 Free Tools 原型及图标库比较。SVG 按官方固定 commit 获取；原始 viewBox、几何、fill、stroke 与 opacity 保持不变。运行时使用根目录的 `icons-data.js`，无需网络或 npm 依赖。

- **Phosphor Icons**：MIT，Copyright (c) 2023 Phosphor Icons。17 枚 duotone、29 枚 regular，见 [许可证](phosphor/LICENSE)。来源：[phosphor-icons/core](https://github.com/phosphor-icons/core/tree/2b75f3ad12b420c9504ef05df8d2564a28f8500e)。
- **Tabler Icons**：MIT，Copyright (c) 2020-2026 Paweł Kuna。6 枚 outline，见 [许可证](tabler/LICENSE)。来源：[tabler/tabler-icons](https://github.com/tabler/tabler-icons/tree/a4ce1404bc6d24d3c365afe7b258d6bf6f48d62d)。
- **Lucide Icons**：ISC；包含 Lucide 及其来源 Feather 的版权与许可，完整保留于 [许可证](lucide/LICENSE)。6 枚 outline。来源：[lucide-icons/lucide](https://github.com/lucide-icons/lucide/tree/20aef31db93fe4d9f398dbb15b120d99c48eef95)。

[统一 manifest](manifest.json) 记录每枚 SVG 的来源 URL、commit、字节数与 SHA-256，同时记录经典脚本的校验值。`phosphor-manifest.json`、`outline-manifest.json` 是分批获取记录。

安全检查：所有 SVG 均经过 XML 元素/属性检查，无 script、事件处理器、foreignObject、外部引用或实体声明。Phosphor 使用 currentColor；Tabler/Lucide 保留 outline。
