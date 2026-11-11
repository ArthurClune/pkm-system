from pkm.contracts.ops import SidebarEntryId
from pkm.server.sidebar_core import next_order_idx, reorder_is_valid
from pkm.test_data.ids import sidebar_entry_id_of, sidebar_order_idx_of


def _ids(*ids: int) -> set[SidebarEntryId]:
    return {sidebar_entry_id_of(i) for i in ids}


def _order(*ids: int) -> list[SidebarEntryId]:
    return [sidebar_entry_id_of(i) for i in ids]


def test_next_order_idx_continues_after_max():
    assert next_order_idx([sidebar_order_idx_of(0), sidebar_order_idx_of(2), sidebar_order_idx_of(1)]) == 3


def test_next_order_idx_zero_when_empty():
    assert next_order_idx([]) == 0


def test_reorder_is_valid_accepts_a_permutation_of_existing_ids():
    assert reorder_is_valid(existing_ids=_ids(1, 2, 3), new_order=_order(3, 1, 2))


def test_reorder_is_valid_rejects_missing_id():
    assert not reorder_is_valid(existing_ids=_ids(1, 2, 3), new_order=_order(1, 2))


def test_reorder_is_valid_rejects_unknown_id():
    assert not reorder_is_valid(existing_ids=_ids(1, 2), new_order=_order(1, 2, 99))


def test_reorder_is_valid_rejects_duplicate_id():
    assert not reorder_is_valid(existing_ids=_ids(1, 2), new_order=_order(1, 1))
