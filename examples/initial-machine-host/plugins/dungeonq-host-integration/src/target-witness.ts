import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  dungeonqLogicalTargetId,
  dungeonqMaximumTargetBytes,
  dungeonqRuntimeCommit,
  dungeonqRuntimeVersion,
  dungeonqStateRelativePath,
  dungeonqTargetRelativePath,
  installationManifestSchema,
  type InstallationManifest,
  targetWitnessSchema,
  type TargetWitness
} from "./contracts";

export class DungeonQHostError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "DungeonQHostError";
    this.code = code;
  }
}

export function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertRepositoryRelative(path: string, expected: string): void {
  if (path !== expected || isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
    throw new DungeonQHostError("HOST_PATH_NOT_ALLOWLISTED");
  }
}

async function assertNoSymlinkSegments(root: string, path: string): Promise<void> {
  const suffix = relative(root, path);
  if (!suffix || suffix.startsWith(`..${sep}`) || suffix === "..") {
    throw new DungeonQHostError("HOST_PATH_OUTSIDE_REPOSITORY");
  }
  let cursor = root;
  for (const segment of suffix.split(sep)) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new DungeonQHostError("HOST_SYMLINK_DENIED");
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolveStream);
  });
  return hash.digest("hex");
}

export async function captureTargetWitness(repoRoot: string): Promise<TargetWitness> {
  const repository = await realpath(resolve(repoRoot));
  const target = resolve(repository, dungeonqTargetRelativePath);
  await assertNoSymlinkSegments(repository, target);
  const resolvedTarget = await realpath(target);
  if (!resolvedTarget.startsWith(`${repository}${sep}`)) {
    throw new DungeonQHostError("HOST_PATH_OUTSIDE_REPOSITORY");
  }
  const info = await lstat(resolvedTarget, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
    throw new DungeonQHostError("TARGET_REGULAR_FILE_REQUIRED");
  }
  if ((Number(info.mode) & 0o077) !== 0) throw new DungeonQHostError("TARGET_PRIVATE_MODE_REQUIRED");
  const sizeBytes = Number(info.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > dungeonqMaximumTargetBytes) {
    throw new DungeonQHostError("TARGET_SIZE_INVALID");
  }
  return targetWitnessSchema.parse({
    schemaVersion: "dungeonq.target-witness/v1",
    sha256: await sha256File(resolvedTarget),
    sizeBytes,
    mode: Number(info.mode) & 0o777,
    device: info.dev.toString(),
    inode: info.ino.toString(),
    modifiedAtMs: Number(info.mtimeMs),
    observedAt: new Date().toISOString()
  });
}

export function targetWitnessUnchanged(before: TargetWitness, after: TargetWitness): boolean {
  return before.sha256 === after.sha256
    && before.sizeBytes === after.sizeBytes
    && before.mode === after.mode
    && before.device === after.device
    && before.inode === after.inode
    && before.modifiedAtMs === after.modifiedAtMs;
}

export async function installHostLayout(repoRoot: string): Promise<void> {
  const root = resolve(repoRoot);
  const targetDirectory = resolve(root, dirname(dungeonqTargetRelativePath));
  const localRoot = resolve(root, ".local/dungeonq-host");
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await chmod(resolve(root, ".local"), 0o700);
  await chmod(localRoot, 0o700);
  await chmod(targetDirectory, 0o700);
}

function base32(value: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (5 - bits)) & 31];
  return output;
}

export async function prepareInstallation(repoRoot: string, artificialTargetConfirmed: boolean): Promise<InstallationManifest> {
  if (!artificialTargetConfirmed) throw new DungeonQHostError("ARTIFICIAL_TARGET_CONFIRMATION_REQUIRED");
  assertRepositoryRelative(dungeonqTargetRelativePath, dungeonqTargetRelativePath);
  assertRepositoryRelative(dungeonqStateRelativePath, dungeonqStateRelativePath);
  await installHostLayout(repoRoot);
  const stateDirectory = resolve(repoRoot, dungeonqStateRelativePath);
  const manifestPath = join(stateDirectory, "installation.json");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  try {
    await lstat(manifestPath);
    throw new DungeonQHostError("INSTALLATION_ALREADY_EXISTS");
  } catch (error) {
    if (!(error instanceof Error) || !Object.hasOwn(error, "code") || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const baseline = await captureTargetWitness(repoRoot);
  const contents = `IM-ACCESS-${base32(randomBytes(20))}`;
  const value = {
    documentId: dungeonqLogicalTargetId,
    classification: "RESTRICTED" as const,
    status: "AVAILABLE" as const,
    contents
  };
  const manifest = installationManifestSchema.parse({
    schemaVersion: "dungeonq.initial-machine-host/v1",
    profile: "CONTROLLED_TEST_ONLY",
    createdAt: new Date().toISOString(),
    runtime: {
      sourceRelativePath: "vendor/dungeonq-runtime",
      commit: dungeonqRuntimeCommit,
      version: dungeonqRuntimeVersion
    },
    target: {
      relativePath: dungeonqTargetRelativePath,
      logicalId: dungeonqLogicalTargetId,
      artificialDataAttested: true,
      baseline
    },
    decoy: {
      recordKey: dungeonqLogicalTargetId,
      value,
      valueDigest: digestJson(value)
    }
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return manifest;
}

export async function loadInstallation(repoRoot: string): Promise<InstallationManifest> {
  const manifestPath = resolve(repoRoot, dungeonqStateRelativePath, "installation.json");
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new DungeonQHostError("INSTALLATION_PRIVATE_FILE_REQUIRED");
  }
  return installationManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
}
