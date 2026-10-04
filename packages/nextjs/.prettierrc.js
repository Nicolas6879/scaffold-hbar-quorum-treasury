module.exports = {
  arrowParens: "avoid",
  printWidth: 120,
  tabWidth: 2,
  trailingComma: "all",
  // No import-sorting plugin on purpose: @trivago/prettier-plugin-sort-imports@4 strips TypeScript generics and
  // mapped types when npm hoists its @babel/* dependencies (create-scaffold-hbar runs `format` after `npm install`).
};
