import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

// @nakednous/tree stays an external import, so an application that uses both
// packages loads one copy of tree. webgl-obj-loader ships a UMD build only;
// commonjs bundles it in.
export default {
  input: 'src/index.js',
  external: ['@nakednous/tree'],
  output: {
    file: 'dist/index.js',
    format: 'es',
    sourcemap: true
  },
  plugins: [resolve(), commonjs()]
};
