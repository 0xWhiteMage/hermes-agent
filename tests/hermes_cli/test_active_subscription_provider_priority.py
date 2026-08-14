"""An ACTIVE subscription/OAuth login must outrank a leftover OPENAI_API_KEY
env var in provider auto-resolution — while a STALE (logged-out) login must
still yield to the env key (preserving the #29285 intent).

Reported: "the default bot switches to the OpenAI API account rather than the
Subscription one." Root cause: resolve_provider('auto') checked OPENAI/
OPENROUTER env keys before the logged-in active_provider, so a leftover
OPENAI_API_KEY silently hijacked an active subscription.
"""

import os
from unittest.mock import patch

import pytest

from hermes_cli import auth, config as cfgmod


def _resolve(cfg, active_provider, logged_in, env_key="sk-fake-key-000123456789"):
    fake_store = {"active_provider": active_provider} if active_provider else {}
    with patch.dict(os.environ, {"OPENAI_API_KEY": env_key}, clear=False), \
         patch.object(cfgmod, "load_config", lambda: cfg), \
         patch.object(auth, "_load_auth_store", lambda: fake_store), \
         patch.object(auth, "get_auth_status", lambda p: {"logged_in": logged_in}):
        return auth.resolve_provider("auto")


def test_active_subscription_beats_leftover_openai_key():
    # The bug: active login lost to a stray env key.
    assert _resolve({"model": {}}, "nous", logged_in=True) == "nous"


def test_active_xai_oauth_beats_openai_key():
    assert _resolve({"model": {}}, "xai-oauth", logged_in=True) == "xai-oauth"


def test_stale_login_still_yields_to_env_key():
    # #29285 intent preserved: a logged-OUT active_provider is stale, so the
    # explicit env key still wins.
    assert _resolve({"model": {}}, "nous", logged_in=False) == "openrouter"


def test_no_login_env_key_unchanged():
    assert _resolve({"model": {}}, None, logged_in=False) == "openrouter"


def test_explicit_config_pin_still_wins_over_active_login():
    # An explicit model.provider pin is the strongest signal and outranks both
    # the active login and the env key.
    assert _resolve({"model": {"provider": "nous"}}, "xai-oauth", logged_in=True) == "nous"
