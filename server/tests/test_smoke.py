from importlib.metadata import version


def test_installed_distribution_has_declared_version():
    assert version("pkm-server") == "0.1.0"
