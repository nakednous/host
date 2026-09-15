import resolve from '@rollup/plugin-node-resolve';

// @nakednous/tree stays an external import, so an application that uses both
// packages loads one copy of tree.
export default {
  input: 'src/index.js',
  external: ['@nakednous/tree'],
  output: {
    file: 'dist/index.js',
    format: 'es',
    sourcemap: true
  },
  plugins: [resolve()]
};
