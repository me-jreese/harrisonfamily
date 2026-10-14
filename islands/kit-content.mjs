// HFY-TSK-315: how the islands load @io-kit/content 0.3.1, for the build (build.mjs) and the node:test suites.
//
// KIT ROOT CAUSE (@io-kit/content 0.2.0 and later; record for the kit backlog): "@io-kit/content/react" re-exports DocumentEditor,
// which imports the whole "@cloudscape-design/components" barrel. No island renders DocumentEditor, and esbuild drops its JS, but
// esbuild still bundles the stylesheet of every Cloudscape component that barrel reaches: about 1.4 MB into each of my-posts.css,
// posts.css and timeline.css. Node cannot import "@io-kit/content/react" at all, because Cloudscape's ES modules use directory
// imports that only bundlers resolve. search-ui imports Cloudscape by component path and is not affected.
// Upstream: export DocumentEditor from its own subpath; then delete this module, its use in build.mjs and in the tests.
//
// hfyNoDocumentEditor -> esbuild plugin: the Cloudscape barrel, imported from inside @io-kit/content, resolves to an empty module.
// documentEditorLeaks(metafile) -> the island outputs that would still ship DocumentEditor, which would then render without
//   Cloudscape; build.mjs fails on any.
import { build } from "esbuild";

const IN_KIT_CONTENT = /(^|[\\/])node_modules[\\/]@io-kit[\\/]content[\\/]/;
const KIT_DOCUMENT_EDITOR = /(^|[\\/])node_modules[\\/]@io-kit[\\/]content[\\/]dist[\\/]src[\\/]document-editor\.js$/;
export const NO_DOCUMENT_EDITOR = "hfy-no-document-editor";

export const hfyNoDocumentEditor = {
  name: NO_DOCUMENT_EDITOR,
  setup(b) {
    b.onResolve({ filter: /^@cloudscape-design\/components$/ }, (args) => (IN_KIT_CONTENT.test(args.importer)
      ? { path: "cloudscape-barrel", namespace: NO_DOCUMENT_EDITOR, sideEffects: false }
      : undefined));
    // CommonJS, so DocumentEditor's named imports (Alert, Button, ...) still bind, to undefined, and the build does not fail.
    b.onLoad({ filter: /.*/, namespace: NO_DOCUMENT_EDITOR }, () => ({ contents: "module.exports = {};", loader: "js" }));
  }
};

/** `<output> <- <input>` for every island output that carries DocumentEditor or the stub; empty on a good build. */
export function documentEditorLeaks(metafile) {
  const leaks = [];
  for (const [out, meta] of Object.entries(metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(meta.inputs)) {
      if (bytesInOutput > 0 && (KIT_DOCUMENT_EDITOR.test(input) || input.startsWith(`${NO_DOCUMENT_EDITOR}:`))) leaks.push(`${out} <- ${input}`);
    }
  }
  return leaks;
}

/**
 * "@io-kit/content/react" for a node:test suite: bundled in memory with hfyNoDocumentEditor, as the build does, with every other
 * package left external at its resolved file URL, so React is the test's own instance (renderToStaticMarkup works on its elements).
 */
export async function importContentReact() {
  const externals = {
    name: "hfy-test-externals",
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith("@io-kit/content") ? undefined : { path: import.meta.resolve(args.path), external: true }));
    }
  };
  const out = await build({
    stdin: { contents: 'export * from "@io-kit/content/react";', resolveDir: import.meta.dirname, loader: "js" },
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    plugins: [hfyNoDocumentEditor, externals],
    write: false,
    logLevel: "silent"
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].contents).toString("base64")}`);
}
