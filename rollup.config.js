import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

export default {
    input: "src/lsdev.ts",
    output: {
        file: "dist/lsdev.cjs",
        format: "cjs",
        sourcemap: true
    },
    plugins: [
        resolve({ preferBuiltins: true }),
        commonjs(),
        typescript({
            tsconfig: "tsconfig.json",
            outputToFilesystem: true
        })
    ],
    external: ["fs", "path", "os", "readline"]
};
