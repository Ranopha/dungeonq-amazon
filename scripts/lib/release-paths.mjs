// Public artifacts may contain declared synthetic evidence, never a runnable installation or private source history.
const privateParts = new Set(['.git', '.codex', '.openai', 'node_modules', 'amazon-release', 'astra-release', 'release-study',
  '.labs', 'labs', 'local-data', 'private-data']);
const privateFiles = /^(?:local-instance|world-installation|study-installation|topology-installation|defense-installation|smtp-config|identity-config|oauth-config|credentials?|tokens?)\.json$/iu;
const privateExtensions = /\.(?:pem|key|p12|pfx|token|sqlite(?:-wal|-shm)?|db(?:-wal|-shm)?)$/iu;

export function isPublicSourcePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 256 && !path.includes('\\') && !path.startsWith('/')
    && !path.split('/').some(part => !part || part === '.' || part === '..' || privateParts.has(part)
      || part.startsWith('.env') || privateFiles.test(part))
    && !privateExtensions.test(path) && !/^docs\/(?:logs|plans|security)(?:\/|$)/u.test(path);
}

export function hasReleaseSecret(text) {
  return /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[ps]_[A-Za-z0-9]{30,}\b|\bAKIA[0-9A-Z]{16}\b)/u.test(text)
    || /"(?:actorToken|observerToken|mcpToken|accessToken|refreshToken|apiKey)"\s*:\s*"[^"\s]+"/u.test(text);
}
