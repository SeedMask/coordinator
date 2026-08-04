#!/usr/bin/env node
/**
 * Validate PSKT / PSKB using rusty-kaspa WASM v2 (official parser).
 */
import { createRequire } from "module";
import { readFileSync } from "fs";

const require = createRequire(import.meta.url);
const kaspa = require("./sdk_v2/kaspa.js");

function usage() {
  console.error("Usage: validate_pskt.mjs --pskt-hex HEX | --pskt-json FILE | --pskb-hex HEX");
  process.exit(2);
}

function psktJsonFromHex(hex) {
  const raw = hex.trim();
  if (!raw.toUpperCase().startsWith("PSKT")) {
    throw new Error("Expected PSKT prefix");
  }
  return Buffer.from(raw.slice(4), "hex").toString("utf8");
}

const args = process.argv.slice(2);
if (args.length < 2) usage();

const mode = args[0];
const value = args[1];

try {
  if (mode === "--pskt-hex") {
    const json = psktJsonFromHex(value);
    const pskt = new kaspa.PSKT(json);
    console.log(JSON.stringify({ ok: true, kind: "pskt", role: pskt.role }));
  } else if (mode === "--pskt-json") {
    const raw = readFileSync(value, "utf8");
    const pskt = new kaspa.PSKT(raw);
    console.log(JSON.stringify({ ok: true, kind: "pskt", role: pskt.role }));
  } else if (mode === "--pskb-hex") {
    const bundle = kaspa.PSKB.deserialize(value.trim());
    console.log(JSON.stringify({ ok: true, kind: "pskb", length: bundle.length }));
  } else {
    usage();
  }
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  process.exit(1);
}
