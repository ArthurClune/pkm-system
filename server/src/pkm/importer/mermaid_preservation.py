# pattern: Functional Core
"""Global protection planning for Mermaid component flattening."""
from __future__ import annotations

from collections.abc import Mapping, Set
from dataclasses import dataclass


@dataclass(frozen=True)
class PreservedRef:
    """A descendant preserved because these source blocks reference it."""

    descendant_uid: str
    source_uids: tuple[str, ...]


@dataclass(frozen=True)
class MermaidPreservationPlan:
    """Globally protected components and deduplicated reference evidence."""

    preserved_component_uids: frozenset[str]
    preserved_refs: tuple[PreservedRef, ...]


def plan_mermaid_preservation(
    component_descendants: Mapping[str, Set[str]],
    block_ref_sources: Mapping[str, Set[str]],
) -> MermaidPreservationPlan:
    """Plan direct reference protection and transitive ancestor protection."""
    protected_components: set[str] = set()
    report_sources: dict[str, set[str]] = {}

    for component_uid in sorted(component_descendants):
        descendants = component_descendants[component_uid]
        component_members = set(descendants) | {component_uid}
        for descendant_uid in sorted(descendants):
            external_sources = (
                set(block_ref_sources.get(descendant_uid, set()))
                - component_members
            )
            if not external_sources:
                continue
            protected_components.add(component_uid)
            report_sources.setdefault(descendant_uid, set()).update(
                external_sources
            )

    while True:
        newly_protected = {
            component_uid
            for component_uid, descendants in component_descendants.items()
            if component_uid not in protected_components
            and bool(set(descendants) & protected_components)
        }
        if not newly_protected:
            break
        protected_components.update(newly_protected)

    preserved_refs = tuple(
        PreservedRef(descendant_uid, tuple(sorted(report_sources[descendant_uid])))
        for descendant_uid in sorted(report_sources)
    )
    return MermaidPreservationPlan(
        preserved_component_uids=frozenset(protected_components),
        preserved_refs=preserved_refs,
    )
