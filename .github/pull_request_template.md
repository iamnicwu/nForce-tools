## 这个 PR 做了什么

<!-- 一两句话说清"为什么改"。关联的 issue / 讨论也写在这里。 -->

## 改动范围

- [ ] 功能（feat）
- [ ] 修复（fix）
- [ ] 体验 / 样式（ui）
- [ ] 文档（docs）
- [ ] 工程 / 构建（chore）

## 自检清单

- [ ] `npm run verify` 通过（构建 + `check:ui` + 单测）
- [ ] 改了 `src/` 的话，`dist/` 已重新构建并**单独一个 commit**
- [ ] 交互 / 样式类改动在真 Chrome 里加载 `dist/` 看过（不是只看代码）
- [ ] 涉及文案的地方，`README.md` 与 `src/docs/README.md` 已同步

## 版本号

- [ ] 这次要发版：`src/manifest.json` 与 `package.json` 的 `version` **一起**改了（合并后 Actions 会自动打 tag + 发 Release）
- [ ] 这次不发版：版本号未改动（合并后只跑 CI）

> 发版规则见 [CONTRIBUTING.md](../CONTRIBUTING.md#6-发版自动)。

## 截图 / 录屏

<!-- 界面改动请贴 before / after；纯逻辑改动可删掉本节。 -->
