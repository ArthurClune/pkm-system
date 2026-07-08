---
name: python
description: "Python development: uv package management, type checking, testing, and code quality."
user-invocable: no
---

# Python Development

## Quick Reference

```bash
# Package Management (uv ONLY - never pip)
uv add package
uv add --dev package
uv run tool

# Format & Lint
uv run ruff format .
uv run ruff check .
uv run ruff check . --fix

# Type Checking
pyrefly init        # First time setup
pyrefly check       # Run after every change

# Tests
uv run pytest
uv run pytest -v
uv run pytest --cov
```

**Navigation:**
- [§ Package Management](#-package-management)
- [§ Code Quality](#-code-quality)
- [§ Testing](#-testing)
- [§ Code Style](#-code-style)
- [§ Best Practices](#-best-practices)
- [§ Error Resolution](#-error-resolution)

---

## § Package Management

### uv - THE ONLY PACKAGE MANAGER

**NEVER use pip. Always use uv.**

```bash
# ✅ GOOD - Install packages
uv add requests
uv add --dev pytest

# ✅ GOOD - Upgrade packages
uv add --dev ruff --upgrade-package ruff

# ✅ GOOD - Run tools
uv run pytest
uv run ruff check .

# ❌ FORBIDDEN
pip install package
uv pip install package
package@latest
```

**Why uv:**
- Faster than pip (10-100x)
- Deterministic dependency resolution
- Built-in virtual environment management
- Lock file support

---

## § Code Quality

### Type Hints - REQUIRED

**All code must have type hints.**

```python
# ✅ GOOD - Fully typed
def process_user(user_id: int, name: str) -> dict[str, Any]:
    return {"id": user_id, "name": name}

def fetch_data(url: str) -> list[dict[str, str]] | None:
    ...

# ❌ BAD - No types
def process_user(user_id, name):
    return {"id": user_id, "name": name}
```

**Common type patterns:**

```python
from typing import Any
from collections.abc import Callable, Iterable

# Optional values
def find_user(id: int) -> User | None:
    ...

# Callbacks
def register(callback: Callable[[str, int], bool]) -> None:
    ...

# Collections
def process(items: list[str]) -> dict[str, int]:
    ...

# Generic iterables
def summarize(data: Iterable[float]) -> float:
    ...
```

### Type Checking with pyrefly

```bash
# First time setup
pyrefly init

# Run after EVERY change
pyrefly check
```

**Fix common type errors:**

```python
# ❌ ERROR: Optional without None check
def process(value: str | None) -> str:
    return value.upper()  # Error: value might be None

# ✅ FIXED: Explicit None check
def process(value: str | None) -> str:
    if value is None:
        return ""
    return value.upper()
```

### Docstrings - REQUIRED for Public APIs

```python
def calculate_discount(price: float, code: str) -> float:
    """Calculate discounted price for given discount code.

    Args:
        price: Original price in dollars.
        code: Discount code to apply.

    Returns:
        Discounted price. Returns original price if code invalid.

    Raises:
        ValueError: If price is negative.
    """
    if price < 0:
        raise ValueError("Price cannot be negative")
    ...
```

### Ruff - Format & Lint

```bash
# Format code
uv run ruff format .

# Check for issues
uv run ruff check .

# Auto-fix issues
uv run ruff check . --fix
```

**Critical issues to watch:**
- Line length: 88 chars maximum
- Import sorting (I001)
- Unused imports

**Line wrapping techniques:**

```python
# ✅ GOOD - Strings with parentheses
message = (
    "This is a very long string that needs to be "
    "wrapped across multiple lines for readability"
)

# ✅ GOOD - Function calls multi-line
result = some_function(
    first_argument,
    second_argument,
    third_argument,
)

# ✅ GOOD - Imports split
from module import (
    FirstClass,
    SecondClass,
    ThirdClass,
)
```

---

## § Testing

### Framework: pytest

```bash
# Run all tests
uv run pytest

# Verbose output
uv run pytest -v

# With coverage
uv run pytest --cov

# Specific file/test
uv run pytest tests/test_user.py
uv run pytest tests/test_user.py::test_create_user
```

### Async Testing - Use anyio

**Use anyio, NOT asyncio directly.**

```python
import anyio
import pytest

# ✅ GOOD - anyio
@pytest.mark.anyio
async def test_async_operation():
    result = await fetch_data()
    assert result is not None

# ❌ BAD - asyncio directly
@pytest.mark.asyncio
async def test_async_operation():
    ...
```

### Test Requirements

- New features require tests
- Bug fixes require regression tests
- Test edge cases and errors
- Aim for meaningful coverage, not 100%

```python
# ✅ GOOD - Tests multiple behaviors
class TestCalculateDiscount:
    def test_valid_code(self):
        assert calculate_discount(100, "SUMMER10") == 90

    def test_invalid_code(self):
        assert calculate_discount(100, "INVALID") == 100

    def test_zero_price(self):
        assert calculate_discount(0, "SUMMER10") == 0

    def test_negative_price_raises(self):
        with pytest.raises(ValueError):
            calculate_discount(-10, "SUMMER10")

    def test_empty_code(self):
        assert calculate_discount(100, "") == 100
```

---

## § Code Style

### Naming Conventions - PEP 8

```python
# Functions and variables: snake_case
def process_user_data():
    user_count = 0
    ...

# Classes: PascalCase
class UserService:
    pass

# Constants: UPPER_SNAKE_CASE
MAX_CONNECTIONS = 100
DEFAULT_TIMEOUT = 30

# Private: leading underscore
def _internal_helper():
    ...

class User:
    def __init__(self):
        self._private_data = None
```

### String Formatting - f-strings

```python
# ✅ GOOD - f-strings
name = "Alice"
age = 30
message = f"User {name} is {age} years old"

# ❌ BAD - Old style
message = "User %s is %d years old" % (name, age)
message = "User {} is {} years old".format(name, age)
```

---

## § Best Practices

### Development Philosophy

- **Simplicity**: Write simple, straightforward code
- **Readability**: Make code easy to understand
- **Less Code = Less Debt**: Minimize code footprint
- **Testability**: Ensure code is testable

### Coding Patterns

**Early returns to avoid nesting:**

```python
# ✅ GOOD - Early return
def process(user: User | None) -> str:
    if user is None:
        return "No user"
    if not user.is_active:
        return "User inactive"
    return f"Processing {user.name}"

# ❌ BAD - Deep nesting
def process(user: User | None) -> str:
    if user is not None:
        if user.is_active:
            return f"Processing {user.name}"
        else:
            return "User inactive"
    else:
        return "No user"
```

**Descriptive names:**

```python
# ✅ GOOD
def handle_user_registration(email: str) -> User:
    ...

user_count = len(users)
is_authenticated = check_auth(token)

# ❌ BAD
def do_stuff(e: str) -> User:
    ...

n = len(users)
flag = check_auth(token)
```

**Constants over magic values:**

```python
# ✅ GOOD
MAX_RETRY_ATTEMPTS = 3
TIMEOUT_SECONDS = 30

for attempt in range(MAX_RETRY_ATTEMPTS):
    ...

# ❌ BAD
for attempt in range(3):  # Magic number
    ...
```

**DRY - Don't Repeat Yourself:**

```python
# ✅ GOOD - Reusable function
def format_currency(amount: float) -> str:
    return f"${amount:,.2f}"

price = format_currency(99.99)
total = format_currency(1234.56)

# ❌ BAD - Repeated logic
price = f"${99.99:,.2f}"
total = f"${1234.56:,.2f}"
```

**Functional style when clearer:**

```python
# ✅ GOOD - List comprehension
squares = [x * x for x in range(10)]
active_users = [u for u in users if u.is_active]

# ✅ GOOD - map/filter for simple transforms
names = list(map(lambda u: u.name, users))

# ❌ BAD - Verbose loop for simple transform
squares = []
for x in range(10):
    squares.append(x * x)
```

**Minimal changes:**
- Only modify code related to the task
- Don't refactor unrelated code
- Mark issues with `TODO:` comments for later

**Build iteratively:**
- Start with minimal functionality
- Verify it works before adding complexity
- Run tests frequently

---

## § Error Resolution

### Fix Order

When CI fails, fix in this order:
1. Formatting (`ruff format`)
2. Type errors (`pyrefly check`)
3. Linting (`ruff check`)

### Common Issues

**Line length (88 chars):**

```python
# ❌ TOO LONG
result = some_very_long_function_name(first_argument, second_argument, third_argument)

# ✅ FIXED
result = some_very_long_function_name(
    first_argument,
    second_argument,
    third_argument,
)
```

**Type narrowing for Optional:**

```python
# ❌ ERROR
def process(data: dict[str, Any] | None) -> str:
    return data["key"]  # Error: data might be None

# ✅ FIXED
def process(data: dict[str, Any] | None) -> str:
    if data is None:
        return ""
    return data["key"]
```

**Import sorting:**

```python
# ✅ GOOD - Grouped imports
import os
import sys
from collections.abc import Callable

import requests
from pydantic import BaseModel

from myapp.models import User
from myapp.utils import helper
```

### Pre-commit Checklist

- Check git status before commits
- Run formatters before type checks
- Keep changes minimal
- Follow existing patterns
- Document public APIs
- Test thoroughly

---

## § Resources

**Tools:**
- uv: https://docs.astral.sh/uv/
- ruff: https://docs.astral.sh/ruff/
- pyrefly: Type checker
- pytest: https://docs.pytest.org/

**Style:**
- PEP 8: https://peps.python.org/pep-0008/
- Google Python Style Guide

**Related:**
- Use context7 MCP to check library details

---

**End of SKILL: Python Development**
