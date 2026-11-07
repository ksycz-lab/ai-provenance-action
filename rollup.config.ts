import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

export default {
  input: "src/main.ts",
  output: {
    file: "dist/index.js",
    format: "cjs",
    sourcemap: true,
    exports: "auto",
  },
  plugins: [
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    typescript({
      tsconfig: "./tsconfig.build.json",
    }),
  ],
};
