const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    app: './src/app.js',
    login_app: './src/login_app.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader']
      },
      {
        test: /\.(png|svg|jpg|jpeg|gif)$/i,
        type: 'asset/resource'
      },
      {
        test: /\.(woff|woff2|eot|ttf|otf)$/i,
        type: 'asset/resource'
      }
    ]
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        {
          from: 'src/manifest.json',
          to: 'manifest.json'
        },
        {
          from: 'src/index.html',
          to: 'index.html'
        },
        {
          from: 'src/login.html',
          to: 'login.html'
        },
        {
          from: 'src/popup.html',
          to: 'popup.html'
        },
        {
          from: 'src/background.js',
          to: 'background.js'
        },
        // 贴边浮窗的**内容脚本**。必须是「经典脚本」—— content_scripts 不是 module，
        // 里面不能出现 import/export；而 src/ 目录本身也要能直接加载运行，
        // 所以这里既不做 webpack 打包，也不改写成 ESM，只是逐字复制。
        // 它需要的一切（配置、日志）都通过 runtime.sendMessage 找 service worker 要，
        // 因此本身零依赖，两份产物逐字节一致。
        {
          from: 'src/dock.js',
          to: 'dock.js',
          info: { minimized: true }
        },
        {
          from: 'src/icons',
          to: 'icons'
        },
        {
          from: 'src/rules',
          to: 'rules'
        },
        {
          from: 'src/docs',
          to: 'docs'
        },
        {
          from: 'src/lib/css',
          to: 'lib/css',
          // antd.full.css 是 vendored 源头（545KB 完整版），由
          // tools/purge-antd-css.mjs 裁剪成 antd.min.css 后再发布。
          // 把源头一起打进扩展只会白白让包变大，所以这里排除掉。
          // .DS_Store 也一并忽略（macOS 元数据，曾经被原样复制进 dist）。
          globOptions: {
            ignore: ['**/antd.full.css', '**/.DS_Store']
          }
        },
        {
          from: 'src/lib/js',
          to: 'lib/js',
          // cometd 是**原生 ESM**，inspector_tools.js 用
          // `import("../lib/js/cometd/cometd.js")` 按需加载 —— 这是个静态字符串，
          // webpack 能解析，所以它已经被打进懒加载 chunk（dist/551.js，约 43KB，
          // 只有进 section-26 事件监听时才会请求）。再逐字复制一份 15 个源文件
          // （84KB）进 dist 只会是死重量：dist 的代码走 chunk，永远不读这些文件。
          // 注意：这条排除成立的前提是那个 import 保持**静态字符串字面量**。
          // 若哪天改成 chrome.runtime.getURL("lib/js/cometd/cometd.js") 之类
          // 绕过打包器的写法，必须同时把这一条排除删掉。
          globOptions: {
            ignore: ['**/.DS_Store', '**/cometd/**']
          }
        },
        // login.html / popup.html 里的 <script type="module"> 直接
        // `import { replaceIcons } from "./common/icons.js"`。
        // icons.js 不是 webpack 入口，不复制的话 dist 里就没有这个文件，
        // 导入会 404 → replaceIcons() 从不执行 → 页面上的 <i class="fa-*">
        // 全部退化成空白方块（src/ 下却正常，因为源码目录本身就是 ESM）。
        // icons.js 自身没有任何 import，逐字复制即可作为原生 ESM 使用。
        // info.minimized 让 webpack 跳过 Terser —— 否则它会把一个"复制来的"文件
        // 顺手压一遍（28.6KB → 24.6KB），虽然仍是合法 ESM，但复制就该是逐字节一致。
        {
          from: 'src/common/icons.js',
          to: 'common/icons.js',
          info: { minimized: true }
        },
        // background.js 是 ESM service worker（manifest type: module），
        // 逐字复制到 dist/ 后通过原生 ESM import 加载本模块。
        // 与 icons.js 同理：info.minimized 跳过 Terser，保持逐字节一致。
        {
          from: 'src/common/logger.js',
          to: 'common/logger.js',
          info: { minimized: true }
        },
        // background.js 现在还会 import 偏好层（它要回答内容脚本的 dock:get-config）。
        // 复制型 JS 的 import 必须在 dist 里真实存在，所以这两条是必需的，不是冗余：
        //   prefs.js       ← 依赖 logger.js（已复制）与 api_version.js
        //   api_version.js ← 零依赖，纯常量与解析器
        // 若哪天它们被别的复制型文件引用，check-ui 的 J 组会先报出来。
        {
          from: 'src/common/prefs.js',
          to: 'common/prefs.js',
          info: { minimized: true }
        },
        {
          from: 'src/common/api_version.js',
          to: 'common/api_version.js',
          info: { minimized: true }
        }
      ]
    })
  ],
  resolve: {
    extensions: ['.js']
  },
  devServer: {
    static: {
      directory: path.join(__dirname, 'dist')
    },
    port: 3000,
    hot: true
  },
  optimization: {
    // ⚠️ 只允许拆分**异步** chunk（= webpack 的默认值）。不要改回 'all'。
    //
    // 2026-09-28 修：'all' 会把两个入口（app / login_app）的公共模块抽成一个**初始**
    // 共享 chunk（实测名字是 753.js，内容正是 common/logger.js、icons.js 这些被两边
    // 同时 import 的模块）。而本项目**没有 html-webpack-plugin** —— index.html /
    // login.html 是 CopyWebpackPlugin 逐字复制的手写 HTML，只会引用各自入口。
    //
    // 后果不是"报错"，而是**静默不执行**：入口 bundle 的收尾是
    //   var a = o.O(void 0, [753], () => o(575))
    // webpack 的 startup 回调只有在 `installedChunks[753] === 0` 时才跑，而 753.js
    // 从没被加载过 → 整个 app.js 一句都不执行。表现是：页面壳（顶栏/CSS）正常渲染，
    // 内容区全空、图标全部未替换，**DevTools 里连一个报错都没有**。
    // （留个回归验法：check-ui 的 J 组会检查「入口依赖的初始 chunk 是否被 HTML 引用」。）
    //
    // 代价：两个入口各自内联一份公共模块（实测 8.7KB），对本地扩展可忽略。
    // 懒加载不受影响 —— 动态 import 的 chunk（cometd 等）是解析期生成的，
    // 与 SplitChunksPlugin 无关，仍按需加载。
    splitChunks: { chunks: 'async' }
  }
};