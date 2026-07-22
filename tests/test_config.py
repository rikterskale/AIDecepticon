from ipaddress import ip_network

from deceptionflow.config import get_settings


def test_trusted_proxy_networks_load_from_environment(monkeypatch) -> None:
    monkeypatch.setenv(
        "DECEPTIONFLOW_TRUSTED_PROXY_IPS",
        '["192.0.2.10/32", "10.20.0.0/16"]',
    )
    get_settings.cache_clear()

    settings = get_settings()

    assert settings.trusted_proxy_ips == [
        ip_network("192.0.2.10/32"),
        ip_network("10.20.0.0/16"),
    ]
    get_settings.cache_clear()
