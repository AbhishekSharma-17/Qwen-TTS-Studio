from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    root_dir: Path = Field(default_factory=Path.cwd)
    models_dir: Path = Field(default_factory=lambda: Path.cwd() / "models")
    data_dir: Path = Field(default_factory=lambda: Path.cwd() / "data")
    logs_dir: Path = Field(default_factory=lambda: Path.cwd() / "logs")

    orch_host: str = "127.0.0.1"
    orch_port: int = 8080

    customvoice_host: str = "127.0.0.1"
    customvoice_port: int = 8091
    voicedesign_host: str = "127.0.0.1"
    voicedesign_port: int = 8092
    base_host: str = "127.0.0.1"
    base_port: int = 8093

    default_stream: bool = True
    default_response_format: str = "wav"
    default_sample_rate: int = 24000

    voices_json: Path = Field(default_factory=lambda: Path.cwd() / "data" / "voices.json")
    voices_dir: Path = Field(default_factory=lambda: Path.cwd() / "data" / "voices")
    max_upload_mb: int = 10

    def backend_url(self, task_type: str) -> str:
        tt = task_type.lower()
        if tt == "voicedesign":
            return f"http://{self.voicedesign_host}:{self.voicedesign_port}"
        if tt == "base":
            return f"http://{self.base_host}:{self.base_port}"
        return f"http://{self.customvoice_host}:{self.customvoice_port}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
