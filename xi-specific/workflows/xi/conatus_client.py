"""One bounded call to Qiniu's free-only Conatus endpoint.

Credentials remain local. This module never executes model output, retries a
request, follows redirects, or chooses another model when the free call fails.
"""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import urllib.error
import urllib.request


ENDPOINT = 'https://api.qnaigc.com/v1/chat/completions'
MODEL = 'qiniu/conatus-free'
MAX_TOKENS = 4096
MAX_RESPONSE_BYTES = 1048576


class ConatusCredentialError(RuntimeError):
    """Missing or unusable local credentials; messages never include secrets."""


class ConatusResponseError(ValueError):
    """Unexpected provider response; messages never include response bodies."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _validate_key(key):
    key = key.strip()
    if not key or len(key) > 8192 or any(ord(char) < 33 or ord(char) > 126 for char in key):
        raise ConatusCredentialError('Conatus API key is empty or invalid')
    return key


def _unprotect(encrypted):
    if os.name != 'nt':
        raise ConatusCredentialError('Windows DPAPI credentials require Windows')

    class DataBlob(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD),
                    ('pbData', ctypes.POINTER(ctypes.c_ubyte))]

    crypt32 = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(DataBlob), ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.c_void_p,
        wintypes.DWORD, ctypes.POINTER(DataBlob),
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    backing = (ctypes.c_ubyte * len(encrypted)).from_buffer_copy(encrypted)
    incoming = DataBlob(len(encrypted), backing)
    outgoing = DataBlob()
    # CRYPTPROTECT_UI_FORBIDDEN prevents an interactive credential dialog.
    if not crypt32.CryptUnprotectData(
            ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
        raise ConatusCredentialError('Unable to decrypt the Conatus DPAPI credential')
    try:
        return ctypes.string_at(outgoing.pbData, outgoing.cbData).decode('utf-8')
    except UnicodeDecodeError:
        raise ConatusCredentialError('Conatus DPAPI credential must contain a UTF-8 key') from None
    finally:
        if outgoing.pbData:
            ctypes.memset(outgoing.pbData, 0, outgoing.cbData)
            kernel32.LocalFree(outgoing.pbData)


def credential_path():
    """Resolve only an explicit private credential reference, without reading it."""
    value = os.environ.get('XI_CONATUS_KEY_FILE') or os.environ.get('CONATUS_KEY_FILE')
    if not value or not Path(value).is_absolute():
        raise ConatusCredentialError('An absolute XI_CONATUS_KEY_FILE or CONATUS_KEY_FILE is required')
    return Path(value)


def load_key():
    """Use an explicit environment key, otherwise an explicit private DPAPI path."""
    environment_key = os.environ.get('CONATUS_API_KEY')
    if environment_key is not None:
        return _validate_key(environment_key)
    key_path = credential_path()
    try:
        with key_path.open('rb') as credential:
            encrypted = credential.read(65537)
    except FileNotFoundError:
        raise ConatusCredentialError(
            'Conatus API key is not configured; set CONATUS_API_KEY or provision the DPAPI credential file'
        ) from None
    except OSError:
        raise ConatusCredentialError('Unable to read the Conatus DPAPI credential file') from None
    if not encrypted or len(encrypted) > 65536:
        raise ConatusCredentialError('Conatus DPAPI credential file is empty or invalid')
    return _validate_key(_unprotect(encrypted))


def _normalize_usage(usage):
    if not isinstance(usage, dict):
        return None
    # Preserve known numeric counters only, never arbitrary provider text.
    result = {}
    for field in ('prompt_tokens', 'completion_tokens', 'total_tokens'):
        value = usage.get(field)
        if type(value) is int and value >= 0:
            result[field] = value
    for source, target in (('prompt_tokens', 'input_tokens'), ('completion_tokens', 'output_tokens')):
        if source in result:
            result[target] = result[source]
    detail_fields = {
        'prompt_tokens_details': ('cached_tokens', 'audio_tokens'),
        'completion_tokens_details': (
            'reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'),
    }
    for field, allowed in detail_fields.items():
        details = usage.get(field)
        if isinstance(details, dict):
            counters = {name: details[name] for name in allowed
                        if type(details.get(name)) is int and details[name] >= 0}
            if counters:
                result[field] = counters
    return result or None


def normalize_response(response):
    """Convert a Chat Completions reply to the workflow's text-only Messages shape."""
    if not isinstance(response, dict):
        raise ConatusResponseError('Conatus response must be an object')
    choices = response.get('choices')
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        raise ConatusResponseError('Conatus response must contain one choice')
    choice = choices[0]
    message = choice.get('message')
    if not isinstance(message, dict) or message.get('role', 'assistant') != 'assistant':
        raise ConatusResponseError('Conatus response lacks an assistant message')
    finish = choice.get('finish_reason')
    if message.get('tool_calls') or message.get('function_call') or finish in ('tool_calls', 'function_call'):
        raise ConatusResponseError('Unexpected tool call; no action executed or candidate accepted')
    content = message.get('content')
    if content is None and finish == 'length':
        content = ''
    if not isinstance(content, str):
        raise ConatusResponseError('Conatus response lacks text content')
    if not content.strip() and finish != 'length':
        raise ConatusResponseError('Conatus response has no candidate text')
    provider_model = response.get('model')
    if not isinstance(provider_model, str) or not provider_model.strip():
        provider_model = None
    return {
        'content': [{'type': 'text', 'text': content}],
        'stop_reason': 'end_turn' if finish == 'stop' else 'max_tokens' if finish == 'length' else 'other',
        'usage': _normalize_usage(response.get('usage')),
        'provider_model': provider_model,
    }


def _call_model(prompt, system, max_tokens, model):
    """Fixed authorized models only; callers explicitly select their billing route."""
    if model not in (MODEL, 'deepseek/deepseek-v4.1-flash-1017'):
        raise ValueError('Unsupported Qiniu model; no substitution')
    if not isinstance(prompt, str) or not prompt.strip() or not isinstance(system, str):
        raise ValueError('Conatus requires text prompt and system instructions')
    if type(max_tokens) is not int or not 1 <= max_tokens <= MAX_TOKENS:
        raise ValueError('Conatus max_tokens must be between 1 and 4096')
    key = load_key()
    body = {
        'model': model,
        'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': prompt}],
        'stream': False,
        'max_tokens': max_tokens,
    }
    if model == 'deepseek/deepseek-v4.1-flash-1017':
        # Initial tiny coding task exhausted its output on reasoning only.
        # Use explicit non-thinking for this bounded candidate executor.
        body['thinking'] = {'type': 'disabled'}
    request = urllib.request.Request(
        ENDPOINT, data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}, method='POST')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=120) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        status = error.code
        retry = error.headers.get('Retry-After', '') if error.headers else ''
        retry_seconds = int(retry) if retry.isdigit() and int(retry) <= 86400 else None
        error.close()
        # Retain only status for the workflow receipt; do not expose headers/body.
        safe_error = urllib.error.HTTPError(ENDPOINT, status, 'Conatus request failed', None, None)
        safe_error.retry_after_seconds = retry_seconds
        raise safe_error from None
    except (urllib.error.URLError, OSError):
        raise RuntimeError('Conatus network request failed; no retry or fallback attempted') from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ConatusResponseError('Conatus response exceeds size limit')
    try:
        decoded = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise ConatusResponseError('Conatus returned invalid JSON') from None
    return normalize_response(decoded)


def call_free(prompt, system, max_tokens):
    """Conatus activity credits, no automatic fallback."""
    return _call_model(prompt, system, max_tokens, MODEL)


def call_deepseek_trial(prompt, system, max_tokens):
    """User-selected model, charged under the separate newcomer resource package."""
    return _call_model(prompt, system, max_tokens, 'deepseek/deepseek-v4.1-flash-1017')
