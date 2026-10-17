# Bencho 参考、源码与授权核验

核验日期：2026-10-18。对应 PRD：`../superpowers/specs/2026-10-18-frontend-bencho-prd.md`。

## 本轮采用方式

八项均在 AdTrender 内独立实现，现有业务层继续提供数据与命令。没有把 Bencho 的完整组件、讲解片段、照片、字体或音效放入仓库，没有购买或登录 Pro。Toast 的公开完整版仅用于核验依赖和交互；其演示队列和 framer-motion 依赖不适合直接替代本产品的真实命令队列，因此采用 CSS 和本产品状态管理。没有新增运行时 UI 依赖。

用户已明确授权：受限项按参考交互独立实现，仍完成全部 8 项，不购买 Pro。未取得完整版的项目不推断其免费或付费授权，也不按“已取得原码”交付。

## 逐项记录

| 项目 | 官方参考 | 当前取得的证据 | 交付源码 |
|---|---|---|---|
| F01 Image shimmer | [参考](https://bencho.dev/blocks/image-shimmer) | Code 面板明确提示 Pro；只公开原理说明，未取得完整源码 | `MediaPlaceholder.tsx`，由 `AdMedia.tsx` 的真实媒体状态驱动 |
| F02 Toast stack | [参考](https://bencho.dev/blocks/toast-stack) | Code 面板公开完整 TSX/CSS、安装与用法；依赖 framer-motion/lucide-react，包含演示通知 | `Toast.tsx`，独立实现作用域、真实异步结果、去重、计时和可访问队列 |
| F03 Copy field | [参考](https://bencho.dev/blocks/copy-field) | Code 面板明确提示 Pro；仅有原理片段，未取得完整源码 | `CopyButton.tsx`，真实 Clipboard 成功/失败反馈 |
| F04 Dropdown | [参考](https://bencho.dev/blocks/fold-dropdown) | Code 面板明确提示 Pro，未取得完整源码 | `FilterSelect.tsx`，原生表单值与自定义选项层 |
| F05 Collapsing sidebar | [参考](https://bencho.dev/blocks/collapsing-sidebar) | 已查看公开预览；Code 读取超时，未取得完整版；不据此认定授权等级 | 现有 `App.tsx` 状态 + `interactions.css` 过渡与焦点提示 |
| F06 Tab bar | [参考](https://bencho.dev/blocks/tab-bar) | 已核验公开组件描述；未取得完整源码，不声称原码可用 | `AnimatedTabs.tsx`，保留业务文字和键盘语义 |
| F07 Resizable panels | [参考](https://bencho.dev/blocks/resizable-panels) | 官方目录归入 Bencho Pro；公开说明可读，未取得完整源码 | `ResizableAdDetail.tsx`，按主容器尺寸启用与限制 |
| F08 FAQ accordion | [参考](https://bencho.dev/blocks/faq-accordion) | 官方目录归入 Bencho Pro；公开说明可读，未取得完整源码 | `FaqAccordion.tsx`，官网与帮助页共用 |

交付源码均位于 `apps/web/src/client/ui/`，样式集中于 `interactions.css`；侧栏沿用已有组件。独立实现参考交互和 PRD 的业务约束，不宣称逐像素复制 Bencho 的全部微动效。

## 授权边界

已阅读 [Bencho 官方 Licence](https://bencho.dev/licence)（页面标记更新 2026-10-12）。官方将免费块按 MIT 提供，复制相关源码时须保留版权及许可声明；Pro 完整源码受单独商业许可约束，可嵌入成品，但不能将其重发为组件包或模板库。示例照片、字体的权利不随组件许可自动授予。

本轮没有分发任何 Bencho 源码或第三方示例资产，因此没有将 Bencho Pro 代码错误标成仓库 MIT；以后改为原码集成时，必须重新取得相应版本及许可，并随源码保留必要声明。这里记录的是已看到的官方条款和本轮取得情况，并非对未取得代码的授权保证。

## 核验快照指纹

为避免把说明片段误当完整原码，记录只读核验文本的 SHA-256；快照仅保存在本机临时目录，不作为可分发组件加入仓库。

- Toast Code 面板（含完整组件与 CSS）：`cd7145e84b74445d683a6f7cd1163bb0347df5ebeccad2dcd47c1a0fceb6aba9`
- Copy field Code 面板（Pro 提示及说明片段）：`4b9b6bb53c880855f750797fdef6ccb0f625b079a5abb92252e7a88ac5d68467`

图片预览使用仓库既有的本地示例图，经隔离的本机媒体服务提供，不从 Bencho 下载或复制图片。本机示例广告均标注“本地示例，不代表真实广告”。
