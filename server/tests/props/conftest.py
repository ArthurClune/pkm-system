"""Hypothesis profiles and the shared template database. Every non-fixture
helper (`fresh_app`, `template_db_path`, `FROZEN_NOW`, `DAILY_TITLE`,
`MERGE_EXAMPLES`, `examples`) lives in `props.harness` instead, since
`pytestmark` and Hypothesis state machines can't reach into a conftest."""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from hypothesis import HealthCheck, settings

from props.harness import template_db_path

settings.register_profile("dev", max_examples=20, deadline=None)
settings.register_profile(
    "merge", deadline=None, print_blob=True,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large])
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "dev"))


@pytest.fixture(scope="session")
def template_db() -> Path:
    return template_db_path()
