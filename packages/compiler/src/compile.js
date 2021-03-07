import mustache from "mustache";
import { compile as svelteCompile } from "svelte/compiler";
import { compile as mdsvexCompile } from "mdsvex";
import { parseChunks } from "./parser.js";
import { TASK_TYPE, TASK_STATE } from "@irydium/taskrunner";

// just requiring rollup and cross-fetch directly for now (this
// means this code won't run in a browser environment, which is
// fine since mdsvex doesn't support that either)
//import * as rollup from "rollup/dist/es/rollup.browser.js";
const rollup = require("rollup");
const fetch = require("cross-fetch");

// note this is loaded as a *string*-- we rely on the compiler to transform it into
// JavaScript at build-time
import index from "./templates/index.html";
import appSource from "./templates/App.svelte";
import taskRunnerSource from "../../taskrunner/src/main.js";

const CDN_URL = "https://cdn.jsdelivr.net/npm";

async function fetch_package(url) {
  return (await fetch(url)).text();
}

async function createSvelteBundle(files) {
  const bundle = await rollup.rollup({
    input: "./App.svelte",
    plugins: [
      {
        name: "repl-plugin",
        resolveId: async (importee, importer) => {
          // handle imports from 'svelte'

          // import x from 'svelte'
          if (importee === "svelte") return `${CDN_URL}/svelte/index.mjs`;

          // import x from 'svelte/somewhere'
          if (importee.startsWith("svelte/")) {
            return `${CDN_URL}/svelte/${importee.slice(7)}/index.mjs`;
          }

          // import x from './file.js' (via a 'svelte' or 'svelte/x' package)
          if (importer && importer.startsWith(`${CDN_URL}/svelte`)) {
            const resolved = new URL(importee, importer).href;
            if (resolved.endsWith(".mjs")) return resolved;
            return `${resolved}/index.mjs`;
          }

          // local repl components
          if (files.has(importee)) return importee;

          // relative imports from a remote package
          if (importee.startsWith(".")) return new URL(importee, importer).href;

          // bare named module imports (importing an npm package)

          // get the package.json and load it into memory
          const pkg_url = `${CDN_URL}/${importee}/package.json`;
          const pkg = JSON.parse(await fetch_package(pkg_url));

          // get an entry point from the pkg.json - first try svelte, then modules, then main
          if (pkg.svelte || pkg.module || pkg.main) {
            // use the aobove url minus `/package.json` to resolve the URL
            const url = pkg_url.replace(/\/package\.json$/, "");
            return new URL(pkg.svelte || pkg.module || pkg.main, `${url}/`)
              .href;
          }

          // we probably missed stuff, pass it along as is
          return importee;
        },
        load: async (id) => {
          // local repl components are stored in memory
          // this is our virtual filesystem
          if (files.has(id)) return files.get(id).code;

          // everything else comes from a cdn
          return await fetch_package(id);
        },
        transform: async (code, id) => {
          // our only transform is to compile svelte components
          //@ts-ignore
          if (/.*\.svelte/.test(id)) return svelteCompile(code).js.code;
        },
      },
    ],
  });

  return (await bundle.generate({ format: "esm" })).output[0].code;
}

export async function compile(input, options = {}) {
  const chunks = parseChunks(input);

  // python chunks are actually just js chunks
  const pyChunks = chunks
    .filter((chunk) => chunk.type === "py")
    .map((chunk) => {
      const preamble = chunk.inputs.length
        ? `from js import ${chunk.inputs.join(",")}\\n`
        : "";
      return {
        ...chunk,
        code: `return (await pyodide.runPythonAsync(\"${preamble}${chunk.lines.join(
          "\\n"
        )}\"))`,
      };
    });

  // we convert all markdown chunks into one big document which we
  // compile with mdsvex
  // FIXME: this may not play nice with script directives, need to figure
  // out how to handle this
  const files = new Map();
  const mdSvelte = await mdsvexCompile(
    chunks
      .filter((chunk) => chunk.type === "md")
      .map((chunk) => chunk.content)
      .join("\n"),
    {}
  );
  files.set("./mdsvelte.svelte", mdSvelte);
  // scaffolding code of varying kinds
  files.set("./taskrunner", {
    code: taskRunnerSource,
    map: "",
  });
  files.set("./App.svelte", {
    code: appSource,
    map: "",
  });
  // any remaining svelte cells are components we can import
  chunks
    .filter((chunk) => chunk.type === "svelte")
    .forEach((chunk) => {
      // FIXME: need to verify that a filename is provided for these cells
      files.set(`./${chunk.filename}`, {
        code: chunk.content,
        map: "",
      });
    });
  const svelteJs = await createSvelteBundle(files);

  let tasks = [
    ...chunks[0].data.map((d) => {
      return {
        type: TASK_TYPE.DOWNLOAD,
        state: TASK_STATE.PENDING,
        payload: JSON.stringify(d.url),
        id: JSON.stringify(d.name),
        inputs: JSON.stringify([]),
      };
    }),
    ...chunks
      .filter((chunk) => chunk.type === "js")
      .concat(pyChunks)
      .map((chunk) => ({
        id: JSON.stringify(chunk.output),
        type: TASK_TYPE.JS,
        state: TASK_STATE.PENDING,
        payload: `(${chunk.inputs.join(",")}) => { ${chunk.content} }`,
        inputs: JSON.stringify(chunk.inputs || []),
      })),
  ];
  return mustache.render(index, {
    ...options,
    ...chunks[0],
    tasks: tasks,
    hasPyChunks: pyChunks.length > 0,
    svelteJs,
  });
}
