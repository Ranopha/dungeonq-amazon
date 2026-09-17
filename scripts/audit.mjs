#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenOriginalName = String.fromCodePoint(105, 100, 101, 112, 111, 116);
const forbiddenRetiredName = String.fromCodePoint(109, 105, 114, 97, 103, 101, 112, 114, 111, 111, 102);
const privateOwnerToken = String.fromCodePoint(108, 105, 117, 101, 110, 121, 97, 110);
const privatePathPrefix = ["", "Users", ""].join("/");
const textExtensions = new Set([".css", ".html", ".json", ".md", ".mjs", ".ts", ".tsx", ".yml"]);
const findings = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".DS_Store" ||
      entry.name === ".next" ||
      entry.name === ".vinext" ||
      entry.name === ".wrangler" ||
      entry.name === "dist"
    ) continue;
    const target = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    if (entry.isFile()) files.push(target);
  }
  return files;
}

const files = await walk(root);
for (const file of files) {
  const path = relative(root, file);
  const fileStat = await stat(file);
  if (fileStat.size > 300_000) findings.push({ path, code: "FILE_TOO_LARGE" });
  if (!textExtensions.has(extname(file))) continue;
  const content = await readFile(file, "utf8");
  const lowered = content.toLowerCase();
  if (lowered.includes(forbiddenOriginalName)) findings.push({ path, code: "FORBIDDEN_ORIGINAL_NAME" });
  if (lowered.includes(forbiddenRetiredName)) findings.push({ path, code: "FORBIDDEN_RETIRED_NAME" });
  if (content.includes(privatePathPrefix)) findings.push({ path, code: "PRIVATE_ABSOLUTE_PATH" });
  if (lowered.includes(privateOwnerToken)) findings.push({ path, code: "PRIVATE_OWNER_TOKEN" });
  if (/(?:\bAKIA[0-9A-Z]{16}\b|\bgh[ps]_[A-Za-z0-9]{30,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u.test(content)) {
    findings.push({ path, code: "CREDENTIAL_PATTERN" });
  }

  if (path === "public/index.html" || path.startsWith("public/assets/") || path.startsWith("public/world/") || path.startsWith("public/study/") || path.startsWith("public/topology/")) {
    if (/\bhttps?:\/\//iu.test(content)) findings.push({ path, code: "BROWSER_REMOTE_REFERENCE" });
    if (/(?:\.innerHTML\b|\.outerHTML\b|document\.write\s*\(|\beval\s*\(|new\s+Function\s*\()/u.test(content)) {
      findings.push({ path, code: "UNSAFE_BROWSER_SINK" });
    }
  }
}

const packageDocument = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (packageDocument.private !== true) findings.push({ path: "package.json", code: "NPM_PUBLISH_GUARD_REQUIRED" });
if (packageDocument.license !== "Apache-2.0") findings.push({ path: "package.json", code: "PUBLIC_LICENSE_INVALID" });
if (packageDocument.repository?.url !== "git+https://github.com/Ranopha/dungeonq-amazon.git") {
  findings.push({ path: "package.json", code: "DEVELOPMENT_REPOSITORY_METADATA_INVALID" });
}
for (const requiredFile of [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "ASSET_PROVENANCE.md",
  "SBOM.cdx.json",
  "docs/SUBMISSION.md",
  "docs/TESTING.md",
  "docs/DEMO_SCRIPT.md"
]) {
  if (!files.includes(join(root, requiredFile))) findings.push({ path: requiredFile, code: "PUBLIC_RELEASE_FILE_MISSING" });
}
const licenseText = await readFile(join(root, "LICENSE"), "utf8").catch(() => "");
if (!licenseText.includes("Apache License") || !licenseText.includes("Version 2.0, January 2004")) {
  findings.push({ path: "LICENSE", code: "PUBLIC_LICENSE_TEXT_INVALID" });
}

const report = {
  reportVersion: "dungeonq.clean-room-audit/v1",
  scannedFiles: files.length,
  passed: findings.length === 0,
  findings
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.passed) process.exitCode = 1;
