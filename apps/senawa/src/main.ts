#!/usr/bin/env node
import { runCli } from "./cli.js";
import { createNodeCliDependencies } from "./node-cli.js";

const result = await runCli(process.argv.slice(2), createNodeCliDependencies());
process.stdout.write(`${result.output}\n`);
process.exitCode = result.exitCode;
