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
  transform: {},
  moduleFileExtensions: ['js', 'json'],
  clearMocks: true
};
