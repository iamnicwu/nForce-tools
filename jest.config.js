module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.js'],
  collectCoverageFrom: [
    'src/common/*.js',
    'src/biz/*.js',
    '!src/biz/ui.js',
    '!src/biz/sf_service.js',
    '!src/biz/logic.js'
  ],
  coverageDirectory: 'coverage',
  verbose: true,
  // 这里是**唯一**让 src/ 的 ESM 源码能在 Jest 里被 require 的地方。
  // 之前写的是 `transform: {}`（什么都不转），于是每个套件都在
  // "Cannot use import statement outside a module" 上直接挂掉。
  // babel-jest 读根目录的 babel.config.js，只做 ESM → CJS 一个转换。
  transform: { '^.+\\.js$': 'babel-jest' },
  moduleFileExtensions: ['js', 'json'],
  clearMocks: true
};
