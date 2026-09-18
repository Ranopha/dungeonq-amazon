"""Thin standard-library client for the DungeonQ reference HTTP API.

No automatic retries. Keep the same operation requestId after an uncertain
response, and inspect server evidence before deciding how to continue.
"""
import json
import re
import urllib.error
import urllib.parse
import urllib.request


class RuntimeError(Exception):
    def __init__(self, code, status=0, request_id=None, uncertain=False):
        super().__init__(code)
        self.code = code
        self.status = status
        self.request_id = request_id
        self.uncertain = uncertain


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class RuntimeClient:
    def __init__(self, origin, token="", timeout=10):
        try:
            url = urllib.parse.urlsplit(origin)
            url.port  # Validate the port before a request can begin.
        except (ValueError, TypeError, AttributeError):
            raise RuntimeError("INVALID_RUNTIME_ORIGIN") from None
        if (url.scheme not in ("http", "https") or not url.hostname
                or (url.scheme == "http" and url.hostname not in ("127.0.0.1", "localhost", "::1"))
                or url.username or url.password or url.query or url.fragment or url.path not in ("", "/")):
            raise RuntimeError("INVALID_RUNTIME_ORIGIN")
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 0 < timeout <= 60:
            raise RuntimeError("INVALID_CLIENT_OPTIONS")
        self._origin = urllib.parse.urlunsplit((url.scheme, url.netloc, "", "", ""))
        self._timeout = timeout
        self._opener = urllib.request.build_opener(_NoRedirect(), urllib.request.ProxyHandler({}))
        self.set_token(token)

    def set_token(self, token):
        if not isinstance(token, str) or len(token) > 4096 or re.search(r"[\s\x00-\x1f\x7f]", token):
            raise RuntimeError("INVALID_TOKEN")
        self._token = token

    def disconnect(self):
        self._token = ""

    def _request(self, path, body=None, authenticated=True):
        if authenticated and not self._token:
            raise RuntimeError("AUTH_REQUIRED")
        headers = {"Accept": "application/json", "Cache-Control": "no-store"}
        if authenticated:
            headers["Authorization"] = "Bearer " + self._token
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(self._origin + path, data=data, headers=headers,
                                         method="POST" if data is not None else "GET")
        try:
            try:
                response = self._opener.open(request, timeout=self._timeout)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status = response.code
                content = response.read(2_097_153)
            if len(content) > 2_097_152:
                raise RuntimeError("RESPONSE_TOO_LARGE", status, uncertain=body is not None)
            try:
                value = json.loads(content)
            except (ValueError, UnicodeError):
                raise RuntimeError("INVALID_RESPONSE", status, uncertain=body is not None) from None
            if not isinstance(value, dict):
                raise RuntimeError("INVALID_RESPONSE", status, uncertain=body is not None)
            if not 200 <= status < 300:
                code = value.get("error", {}).get("code") if isinstance(value.get("error"), dict) else None
                if not isinstance(code, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,95}", code):
                    code = "AUTH_REQUIRED" if status == 401 else "PERMISSION_DENIED" if status == 403 else "REQUEST_REJECTED"
                request_id = value.get("requestId")
                if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request_id):
                    request_id = None
                raise RuntimeError(code, status, request_id, uncertain=body is not None and status >= 500)
            return value
        except RuntimeError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError):
            raise RuntimeError("CONNECTION_UNAVAILABLE", uncertain=body is not None) from None

    def capabilities(self):
        return self._request("/api/capabilities", authenticated=False)

    def status(self):
        return self._request("/api/status")

    def evidence(self):
        return self._request("/api/evidence")

    def preview(self, context_id, action, reason=None):
        body = {"contextId": context_id, "action": action}
        if reason is not None:
            body["reason"] = reason
        return self._request("/api/policy/preview", body)

    def apply(self, proposal_id, digest, confirmation):
        if confirmation != "APPLY":
            raise RuntimeError("EXPLICIT_CONFIRMATION_REQUIRED")
        return self._request("/api/policy/apply", {"proposalId": proposal_id, "digest": digest, "confirmation": confirmation})

    def operate(self, request_id, operation, args=None):
        if operation not in ("snapshot", "read", "write", "issue-ticket", "use-ticket"):
            raise RuntimeError("UNSUPPORTED_OPERATION")
        return self._request("/api/operate", {"requestId": request_id, "operation": operation, "args": {} if args is None else args})


def evidence_state(value):
    state = value.get("status") if isinstance(value, dict) else None
    checks = value.get("checks") if isinstance(value, dict) else None
    if state == "FAIL" or (isinstance(checks, list) and any(isinstance(item, dict) and item.get("status") == "FAIL" for item in checks)):
        return "FAIL"
    if state == "PASS" and "checks" in value and (not isinstance(checks, list) or not checks or any(not isinstance(item, dict) or item.get("status") != "PASS" for item in checks)):
        return "INCONCLUSIVE"
    return state if state in ("PASS", "FAIL", "INCONCLUSIVE") else "INCONCLUSIVE"
