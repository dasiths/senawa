#!/usr/bin/env node
import { renderCli } from "./cli.js";

const result = renderCli(process.argv.slice(2));
process.stdout.write(`${result.output}\n`);
process.exitCode = result.exitCode;
