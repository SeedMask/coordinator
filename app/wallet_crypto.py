"""Per-wallet encryption for watch-only secrets at rest."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from typing import Any

# Sensitive fields wiped from plaintext disk records when encrypted.
# policy_type / multisig_m / multisig_n stay public so the strip can show
# MultiSig key icons and avoid collapsing into another wallet's fingerprint group.
SECRET_KEYS = (
    "kpub",
    "descriptor",
    "derivation",
    "fingerprint",
    "script_type",
    "multisig_cosigners",
)

_PBKDF2_ROUNDS = 200_000
_SALT_LEN = 16
_NONCE_LEN = 12
_KEY_LEN = 32


def _derive_key(password: str, salt: bytes, rounds: int = _PBKDF2_ROUNDS) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        rounds,
        dklen=_KEY_LEN,
    )


def _aes_gcm_encrypt(key: bytes, nonce: bytes, plaintext: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        return AESGCM(key).encrypt(nonce, plaintext, None)
    except ImportError:
        out = bytearray()
        counter = 0
        while len(out) < len(plaintext):
            block = hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
            out.extend(block)
            counter += 1
        xored = bytes(a ^ b for a, b in zip(plaintext, out[: len(plaintext)]))
        tag = hmac.new(key, nonce + xored, hashlib.sha256).digest()[:16]
        return xored + tag


def _aes_gcm_decrypt(key: bytes, nonce: bytes, blob: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        return AESGCM(key).decrypt(nonce, blob, None)
    except ImportError:
        if len(blob) < 16:
            raise ValueError("Invalid encrypted wallet data") from None
        xored, tag = blob[:-16], blob[-16:]
        expect = hmac.new(key, nonce + xored, hashlib.sha256).digest()[:16]
        if not hmac.compare_digest(tag, expect):
            raise ValueError("Wrong password or corrupted wallet data") from None
        out = bytearray()
        counter = 0
        while len(out) < len(xored):
            block = hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
            out.extend(block)
            counter += 1
        return bytes(a ^ b for a, b in zip(xored, out[: len(xored)]))


def encrypt_secrets(secrets_obj: dict[str, Any], password: str) -> dict[str, Any]:
    """Return disk blob: salt, nonce, ciphertext (base64) + kdf metadata."""
    pw = (password or "").strip()
    if not pw:
        raise ValueError("Password required to encrypt wallet")
    salt = secrets.token_bytes(_SALT_LEN)
    nonce = secrets.token_bytes(_NONCE_LEN)
    key = _derive_key(pw, salt)
    plaintext = json.dumps(secrets_obj, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ciphertext = _aes_gcm_encrypt(key, nonce, plaintext)
    return {
        "kdf": "pbkdf2-sha256",
        "rounds": _PBKDF2_ROUNDS,
        "salt": base64.b64encode(salt).decode("ascii"),
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
    }


def decrypt_secrets(enc: dict[str, Any], password: str) -> dict[str, Any]:
    pw = (password or "").strip()
    if not pw:
        raise ValueError("Password required")
    try:
        salt = base64.b64decode(str(enc.get("salt") or ""))
        nonce = base64.b64decode(str(enc.get("nonce") or ""))
        ciphertext = base64.b64decode(str(enc.get("ciphertext") or ""))
        rounds = int(enc.get("rounds") or _PBKDF2_ROUNDS)
    except Exception as e:
        raise ValueError("Invalid encrypted wallet data") from e
    if len(salt) < 8 or len(nonce) < 8 or not ciphertext:
        raise ValueError("Invalid encrypted wallet data")
    key = _derive_key(pw, salt, rounds)
    try:
        raw = _aes_gcm_decrypt(key, nonce, ciphertext)
        data = json.loads(raw.decode("utf-8"))
    except Exception as e:
        raise ValueError("Wrong password or corrupted wallet data") from e
    if not isinstance(data, dict):
        raise ValueError("Invalid encrypted wallet data")
    return data


def split_wallet_dict(d: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return (public_meta, secrets)."""
    secrets_obj: dict[str, Any] = {}
    public = dict(d)
    for key in SECRET_KEYS:
        if key in public:
            secrets_obj[key] = public.pop(key)
    return public, secrets_obj


def apply_secrets(public: dict[str, Any], secrets_obj: dict[str, Any]) -> dict[str, Any]:
    out = dict(public)
    for key in SECRET_KEYS:
        if key in secrets_obj:
            out[key] = secrets_obj[key]
    # Older seals also encrypted policy / quorum — lift them back to public meta.
    for key in ("policy_type", "multisig_m", "multisig_n"):
        if key not in secrets_obj:
            continue
        val = secrets_obj[key]
        if val in (None, "", [], 0, "0"):
            continue
        out[key] = val
    out.pop("encrypted_blob", None)
    out["encrypted"] = True
    return out


def seal_wallet_dict(d: dict[str, Any], password: str) -> dict[str, Any]:
    """Produce an on-disk wallet dict with secrets encrypted."""
    public, secrets_obj = split_wallet_dict(d)
    # Keep quorum/policy readable while locked (strip icons + account grouping).
    if "policy_type" in d:
        public["policy_type"] = d.get("policy_type") or ""
    if "multisig_m" in d:
        public["multisig_m"] = int(d.get("multisig_m") or 0)
    if "multisig_n" in d:
        public["multisig_n"] = int(d.get("multisig_n") or 0)
    blob = encrypt_secrets(secrets_obj, password)
    public["encrypted"] = True
    public["encrypted_blob"] = blob
    public["password_hint"] = str(d.get("password_hint") or public.get("password_hint") or "").strip()
    public["kpub"] = ""
    public["descriptor"] = ""
    public["derivation"] = ""
    public["fingerprint"] = ""
    public["script_type"] = ""
    public["multisig_cosigners"] = []
    return public
