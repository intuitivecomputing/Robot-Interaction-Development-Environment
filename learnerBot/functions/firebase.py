import os
import firebase_admin
from firebase_admin import credentials, db, storage
from functools import lru_cache
from pathlib import Path

# --- DIRECT CONFIGURATION ---
DATABASE_URL="https://your-firebase-project-id-default-rtdb.firebaseio.com/"
ACCOUNT_KEY="firebase-database-key.json"
STORAGE_BUCKET="your-firebase-project-id.firebasestorage.app"

@lru_cache
def get_firebase_app():
    if not DATABASE_URL or not ACCOUNT_KEY:
        return None

    cred_path = Path(ACCOUNT_KEY)
    if not cred_path.exists():
        raise FileNotFoundError(f"Firebase credentials file not found at: {cred_path.absolute()}")

    if firebase_admin._apps:
        return firebase_admin.get_app()

    cred = credentials.Certificate(str(cred_path))
    app_options = {"databaseURL": DATABASE_URL, "storageBucket": STORAGE_BUCKET}

    return firebase_admin.initialize_app(cred, app_options)

def get_rtdb_reference(path: str):
    app = get_firebase_app()
    if app is None:
        raise RuntimeError("Firebase is not configured.")
    return db.reference(path, app=app)

def get_rtdb_data(path: str):
    return get_rtdb_reference(path).get()

@lru_cache
def get_storage_bucket():
    app = get_firebase_app()
    if app is None:
        raise RuntimeError("Firebase is not configured.")
    return storage.bucket(app=app)