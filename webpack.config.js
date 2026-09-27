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
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendors',
          chunks: 'all'
        }
      }
    }
  }
};