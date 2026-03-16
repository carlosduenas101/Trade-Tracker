"""
Configuration module.
Loads KCEX API credentials and app settings from environment variables.
Copy .env.example to .env and fill in your real credentials before running.
"""

import os
from dotenv import load_dotenv

load_dotenv()

# KCEX API credentials
KCEX_API_KEY: str = os.getenv("KCEX_API_KEY", "your_api_key_here")
KCEX_API_SECRET: str = os.getenv("KCEX_API_SECRET", "your_api_secret_here")

# Database
DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./trading_tracker.db")

# CORS — origins allowed to call this API (extend as needed)
ALLOWED_ORIGINS: list[str] = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:3000,http://localhost:5173,http://localhost:8080",
).split(",")

# App metadata
APP_TITLE: str = "Crypto Trading Performance Tracker"
APP_VERSION: str = "1.0.0"
APP_DESCRIPTION: str = (
    "Track, analyse and sync crypto trades from KCEX. "
    "Provides performance metrics: win rate, PnL, drawdown, risk/reward and streaks."
)
