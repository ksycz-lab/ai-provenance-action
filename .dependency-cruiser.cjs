/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-stays-pure",
      comment:
        "P0-M1-04: src/core must not depend on GitHub Actions SDK, Node fs, or adapters.",
      severity: "error",
      from: { path: "^src/core" },
      to: {
        path: "^src/adapters|@actions/|^node:fs|^node:fs/promises|^fs$",
      },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
  },
};
