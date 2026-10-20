# pattern: Functional Core
"""The one direct `BaseModel` subclass in the server: every other model
derives from `StrictModel`, so pydantic never coerces a value (`"1"` for an
int, `1` for a bool) and pyrefly checks constructors against the declared
field types, brands included."""
from pydantic import BaseModel, ConfigDict


class StrictModel(BaseModel):
    model_config = ConfigDict(strict=True)
