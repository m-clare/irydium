import replace from "@rollup/plugin-replace";
import json from "rollup-plugin-json";

export function createTemplates(baseDir) {
  const dirname = baseDir || __dirname;

  const fs = require("fs");
  return [
    "templates/Admonition.svelte",
    "templates/index.html",
    "templates/tasks.js",
    "taskrunner.js",
  ].reduce((acc, filename) => {
    return {
      ...acc,
      [filename]: fs.readFileSync(`${dirname}/src/${filename}`, "utf8"),
    };
  }, {});
}

export const getBaseCompilerPlugins = (baseDir = ".") => {
  return [
    // unified has an implicit dependency on rollup-plugin-json
    json(),
    replace({
      "__TEMPLATES = {}":
        "__TEMPLATES = " + JSON.stringify(createTemplates(baseDir)),
      delimiters: ["", ""],
    }),
  ];
};
