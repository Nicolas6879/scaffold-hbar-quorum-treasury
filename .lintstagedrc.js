const path = require("path");

const buildNextEslintCommand = filenames =>
  `yarn next:lint --fix --file ${filenames.map(f => path.relative(path.join("packages", "nextjs"), f)).join(" --file ")}`;

module.exports = {
  "packages/nextjs/**/*.{ts,tsx}": [buildNextEslintCommand, () => "yarn next:check-types"],
  "packages/treasury/**/*.ts": [() => "yarn treasury:check-types"],
};
