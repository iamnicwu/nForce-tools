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