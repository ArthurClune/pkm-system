from pkm.database import connect
from pkm.schema import DDL
from pkm.server.notify import seq_frame


def test_seq_frame_on_empty_journal():
    """An empty `changes` table reads as seq 0 with the row check on."""
    con = connect(":memory:")
    con.executescript(DDL)
    assert seq_frame(con).seq == 0
    con.close()
