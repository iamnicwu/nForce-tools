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
          to: 'lib/css'
        },
        {
          from: 'src/lib/js',
          to: 'lib/js'
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