// Public artifacts may contain declared synthetic evidence, never a runnable installation or private source history.
const privateParts = new Set(['.git', '.codex', '.openai', 'node_modules', 'amazon-release', 'astra-release', 'release-study',
  '.labs', 'labs', 'local-data', 'private-data', 'installations', 'reports', 'history', '__pycache__']);
const privateFiles = /^(?:local-instance|world-installation|study-installation|topology-installation|defense-installation|runtime-installation|reference|ssh-host|smtp-config|identity-config|oauth-config|credentials?|tokens?)\.json$/iu;
const privateExtensions = /\.(?:pem|key|ticket-key|p12|pfx|token|sqlite(?:-wal|-shm)?|db(?:-wal|-shm)?|py[co]|env|sock|log)$/iu;

export function isPythonCachePath(path) {
  return typeof path === 'string' && (path.split('/').some(part => part.toLowerCase() === '__pycache__') || /\.py[co]$/iu.test(path));
}

export function isPublicSourcePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 256 && !path.includes('\\') && !path.startsWith('/')
    && !path.split('/').some(part => !part || part === '.' || part === '..' || privateParts.has(part.toLowerCase())
      || part.toLowerCase().startsWith('.env') || privateFiles.test(part))
    && !privateExtensions.test(path) && !/^docs\/(?:logs|plans|security)(?:\/|$)/iu.test(path);
}

export function hasReleaseSecret(text) {
  return /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[ps]_[A-Za-z0-9]{30,}\b|\bAKIA[0-9A-Z]{16}\b)/u.test(text)
    || /"(?:actorToken|observerToken|mcpToken|accessToken|refreshToken|apiKey|ownerToken|operatorToken|participantToken|normalToken|witnessToken|producerToken|readerToken|sealKey|signingKey)"\s*:\s*"[^"\s]+"/u.test(text)
    || /"(?:owner|actor|other|ordinary|seal|producer|reader|witness)"\s*:\s*"[A-Za-z0-9_-]{32,256}"/u.test(text);
}
