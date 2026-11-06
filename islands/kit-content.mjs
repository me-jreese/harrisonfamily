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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// hfyContentSanitizePolicy -> esbuild plugin (HFY-TSK-171, PS-11): "@io-kit/md/react", imported from inside @io-kit/content, resolves to
// src/lib/hfy-markdown.jsx, whose KitMarkdown defaults `policy` to the HFY SanitizePolicy (src/lib/sanitize-policy.js: no markdown
// images, no mailto:). PostCard and ArticleView render the post body through KitMarkdown and accept no policy of their own.
// The wrapper itself imports "@io-kit/md/react" from outside the kit, so it reaches the real KitMarkdown.
export const HFY_MARKDOWN = fileURLToPath(new URL("./src/lib/hfy-markdown.jsx", import.meta.url));
export const hfyContentSanitizePolicy = {
  name: "hfy-content-sanitize-policy",
  setup(b) {
    b.onResolve({ filter: /^@io-kit\/md\/react$/ }, (args) => (IN_KIT_CONTENT.test(args.importer) ? { path: HFY_MARKDOWN } : undefined));
  }
};

// hfyCommentsSanitizePolicy -> esbuild plugin (HFY-TSK-187, PS-11): the same swap for "@io-kit/md/react" imported from inside
// @io-kit/comments, to src/lib/hfy-comments-markdown.jsx. Comment, CommentBody and Thread render a comment through KitMarkdown with
// the kit's own `policy: userContentPolicy` (https images and mailto: links) and accept no policy of their own, so unlike the content
// kit the wrapper FORCES the HFY SanitizePolicy over whatever policy it is handed. Kit gap, for the kit backlog: Thread and Comment take
// a `policy`; then delete this plugin and the module.
export const HFY_COMMENTS_MARKDOWN = fileURLToPath(new URL("./src/lib/hfy-comments-markdown.jsx", import.meta.url));
const IN_KIT_COMMENTS = /(^|[\\/])node_modules[\\/]@io-kit[\\/]comments[\\/]/;
export const hfyCommentsSanitizePolicy = {
  name: "hfy-comments-sanitize-policy",
  setup(b) {
    b.onResolve({ filter: /^@io-kit\/md\/react$/ }, (args) => (IN_KIT_COMMENTS.test(args.importer) ? { path: HFY_COMMENTS_MARKDOWN } : undefined));
  }
};

// hfyRoutedModules -> esbuild plugin (HFY-TSK-382): the BUILD DETERMINISM fix. A plugin that resolves to a bare path (the two plugins
// above do) hands esbuild a file with no module type, while esbuild's own resolver stamps the same file ESM, because islands/package.json
// says "type": "module". esbuild parses a file once, under whichever import reached it first, and the imports run in parallel, so a file
// reached BOTH ways was parsed with either module type from run to run. For lib/hfy-markdown.jsx (plugin from @io-kit/content, relative
// import from person.jsx and from hfy-comments-markdown.jsx) that decided whether its `react/jsx-runtime` import was emitted as
// `__toESM(x, 1)` or `__toESM(x)`, which changed the bytes of the big shared chunk, hence its content hash, hence its file name, hence
// the file name in every entry that imports it: about 1 build in 8 differed. This plugin resolves EVERY import of a plugin-routed file
// (relative or not) to the same bare path, so each such file has one module type, whatever the schedule. The guard is
// tests/build-determinism.test.mjs, which fails when any import of a routed file still reaches esbuild's own resolver.
export const ROUTED_MODULES = [HFY_MARKDOWN, HFY_COMMENTS_MARKDOWN];
/** The routed module that a relative import resolves to, with or without its `.jsx` extension; undefined for any other file. */
export function routedModuleOf(resolveDir, path) {
  const abs = resolve(resolveDir, path);
  return ROUTED_MODULES.find((m) => m === abs || m === `${abs}.jsx`);
}
export const hfyRoutedModules = {
  name: "hfy-routed-modules",
  setup(b) {
    // Every relative import: ROUTED_MODULES alone decides, so a file added to it needs no change here.
    b.onResolve({ filter: /^\.\.?\// }, (args) => {
      const routed = routedModuleOf(args.resolveDir || dirname(args.importer), args.path);
      return routed ? { path: routed } : undefined;
    });
  }
};

/** The kit plugins of the island build, in order (build.mjs), and of tests/build-determinism.test.mjs, which must bundle the same way. */
export const HFY_KIT_PLUGINS = [hfyNoDocumentEditor, hfyContentSanitizePolicy, hfyCommentsSanitizePolicy, hfyRoutedModules];

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
    plugins: [hfyContentSanitizePolicy, hfyNoDocumentEditor, externals],
    write: false,
    logLevel: "silent"
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].contents).toString("base64")}`);
}

/**
 * "@io-kit/comments/react" for a node:test suite: bundled in memory with hfyCommentsSanitizePolicy, as the build bundles it, with every
 * other package external at its resolved file URL (React is the test's own instance).
 */
export async function importCommentsReact() {
  const externals = {
    name: "hfy-test-externals",
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith("@io-kit/comments") ? undefined : { path: import.meta.resolve(args.path), external: true }));
    }
  };
  const out = await build({
    stdin: { contents: 'export * from "@io-kit/comments/react";', resolveDir: import.meta.dirname, loader: "js" },
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    plugins: [hfyCommentsSanitizePolicy, externals],
    write: false,
    logLevel: "silent"
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].contents).toString("base64")}`);
}
