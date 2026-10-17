# 开发流程

> 一句话：**改动一律走分支 → PR → 你 review 后合并**，`main` 只接受合并；
> 合并之后由 GitHub Actions 自动打 tag、发 Release。

这条流程解决的是过去那几个具体问题：

- 直接往 `main` 提交时，`dist/` 忘了重建也照样进仓库 —— 现在 CI 会在 PR 上就卡住；
- 改动和"发版"混在一起，事后说不清哪个提交对应哪个版本 —— 现在 tag 由 Actions 按版本号创建；
- 版本号写在两个文件里（`src/manifest.json`、`package.json`），手改容易漏 —— 发版前会校验一致性。

---

## 1. 开分支

```bash
git switch main && git pull
git switch -c feat/home-folders     # 见下面的命名规则
```

分支命名（一眼能看出这批改动是什么）：

| 前缀 | 用在 |
| --- | --- |
| `feat/` | 新功能 |
| `fix/` | 修 bug |
| `perf/` | 只改性能，不改行为 |
| `ui/` | 只改样式 / 排版 |
| `docs/` | 只改文档 |
| `chore/` | 构建、CI、依赖、脚本 |

## 2. 开发与自检

```bash
npm run verify      # = build + check:ui + 单测，本地先自己跑一遍
```

- **改了 `src/` 就必须 `npm run build`**，并把 `dist/` 单独提交一个 commit
  （`dist/` 是入库的，CI 会逐字节比较；构建可复现）。
- 交互 / 样式类改动要**真的在 Chrome 里加载 `dist/` 看一眼** —— 单测和语法检查抓不到
  "按钮点不动""空壳页面零报错"这类问题。
- 文案要改两处：`README.md` 与 `src/docs/README.md`（扩展内「项目说明」，同源文档）。

## 3. 提交并推送

提交信息格式：`type: 一句话说清做了什么（vX.Y.Z）`

```
feat: 首页分组折成文件夹（v4.12.0）
fix: 拖进文件夹后首页仍显示一份（v4.12.2）
```

```bash
git push -u origin feat/home-folders
```

## 4. 开 PR

用仓库的 PR 模板（自动带出）填写：做了什么、自检清单、是否发版、界面截图。

CI（`.github/workflows/build.yml`）会在 PR 上跑：`npm ci` → `npm run build` →
`npm run check:ui` → `npx jest` → **`dist/` 与 `src/` 是否同步**。红着不合。

## 5. 合并

Review 通过后 **Squash and merge**：`main` 上一条提交对应一个功能，历史干净、回滚简单。
合并完 `main` 会再跑一遍 CI（可能与 Release 并行，互不影响）。

## 6. 发版（自动）

**发不发版，由版本号决定**：

1. 想让这次合并成为一个版本 → 在同一个 PR 里把
   `src/manifest.json` 与 `package.json` 的 `version` **一起**改（语义化：feat → minor、
   fix → patch、破坏性 → major）。
2. 合并到 `main` 后，`.github/workflows/release.yml` 自动执行：
   - 读 `src/manifest.json` 的版本号，并校验 `package.json` 与它一致；
   - **`vX.Y.Z` tag 已存在 → 跳过**（这类合并只跑 CI，不重复发版，也不报红）；
   - 否则 `npm run verify` → 把 `dist/` 打成 `nforce-tools-X.Y.Z.zip` →
     创建 `vX.Y.Z` tag（指向本次合并的提交）→ 发布 Release，自动生成更新说明，
     并把 zip 挂到 Release 资产里。
3. 补发：Actions 页面选 **Release → Run workflow**（比如当时 Actions 出故障，
   修好后手动补一次；同样会先判断 tag 是否存在）。

> 为什么用 tag 做闸门：日常还有大量"不改版本号"的合并（改文档、修 CI、小重构）。
> 无条件发版要么反复覆盖同一个 Release，要么每次都因 tag 已存在而报红。

## 7. 用户拿到的是哪个包

Release 里的 `nforce-tools-X.Y.Z.zip` 解压后就是可加载的扩展目录
（Chrome → `chrome://extensions` → 打开开发者模式 → 加载已解压的扩展程序）。
仓库里的 `dist/` 始终与 `main` 同步，两者内容一致。
