from pkm.importer.mermaid_preservation import (
    MermaidPreservationPlan,
    PreservedRef,
    plan_mermaid_preservation,
)


def test_nested_component_protection_reaches_ancestors_and_deduplicates_report():
    plan = plan_mermaid_preservation(
        component_descendants={
            "outer": {"inner", "line", "citer-a", "citer-z"},
            "inner": {"line"},
            "unreferenced": {"free-line"},
        },
        block_ref_sources={
            "line": {"citer-z", "citer-a"},
        },
    )

    assert plan == MermaidPreservationPlan(
        preserved_component_uids=frozenset({"inner", "outer"}),
        preserved_refs=(
            PreservedRef(
                descendant_uid="line",
                source_uids=("citer-a", "citer-z"),
            ),
        ),
    )


def test_report_sources_union_across_directly_protected_components():
    plan = plan_mermaid_preservation(
        component_descendants={
            "component-a": {"line", "source-a"},
            "component-b": {"line", "source-b"},
        },
        block_ref_sources={
            "line": {"source-a", "source-b", "outside"},
        },
    )

    assert plan.preserved_refs == (
        PreservedRef(
            descendant_uid="line",
            source_uids=("outside", "source-a", "source-b"),
        ),
    )


def test_empty_inputs_produce_empty_plan():
    assert plan_mermaid_preservation({}, {}) == MermaidPreservationPlan(
        preserved_component_uids=frozenset(),
        preserved_refs=(),
    )
