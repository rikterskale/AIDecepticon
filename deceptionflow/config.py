from functools import lru_cache
from pathlib import Path

from pydantic import Field, IPvAnyNetwork
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_path: Path = Path("data/deceptionflow.db")
    log_level: str = "INFO"
    public_base_url: str = "http://localhost:8080"
    trusted_proxy_ips: list[IPvAnyNetwork] = Field(default_factory=list)

    model_config = SettingsConfigDict(
        env_prefix="DECEPTIONFLOW_",
        env_file=".env",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
