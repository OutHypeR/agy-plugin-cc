#!/usr/bin/env node
// agy's statusLine command (installed by /agy:setup). agy pipes its documented status
// JSON in on every state change; this keeps the `quota` part in the shared usage file and prints
// nothing, so agy's own status line (stack_with_default) stays as it was.

import fs from "node:fs";
import { readUsage, writeSection } from "./usage-lib.mjs";

let input = "";
try {
  input = fs.readFileSync(0, "utf8");
} catch {}
let d = null;
try {
  d = JSON.parse(input);
} catch {}
if (d && d.quota && typeof d.quota === "object" && Object.keys(d.quota).length) {
  const prev = readUsage().antigravity || {};
  const next = { at: Date.now(), plan: d.plan_tier || prev.plan || null, buckets: d.quota };
  // agy calls this many times a second while starting; skip identical writes within 5 s.
  if (!(prev.at && Date.now() - prev.at < 5000 && JSON.stringify(prev.buckets) === JSON.stringify(d.quota))) {
    writeSection("antigravity", next);
  }
}
