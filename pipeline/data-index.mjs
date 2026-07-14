#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContentIndex } from "./lib/data-store.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = await buildContentIndex(root);
console.log(`Rebuilt disposable query index: ${output}`);
