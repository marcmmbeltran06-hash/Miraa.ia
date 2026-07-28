"""Private HTTP service for Mira using FASHN VTON v1.5."""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import os
import threading
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from PIL import Image, ImageOps

MAX_IMAGE_BYTES = int(os.getenv("MIRA_MAX_IMAGE_BYTES", str(15 * 1024 * 1024)))
MAX_PIXELS = int(os.getenv("MIRA_MAX_PIXELS", "40000000"))
WEIGHTS_DIR = Path(os.getenv("MIRA_WEIGHTS_DIR", "/app/weights"))
TOKEN = os.getenv("MIRA_ENGINE_TOKEN", "")
DEVICE = os.getenv("MIRA_DEVICE") or None
TIMESTEPS = min(50, max(20, int(os.getenv("MIRA_TIMESTEPS", "30"))))
GUIDANCE = min(5.0, max(0.1, float(os.getenv("MIRA_GUIDANCE_SCALE", "1.5"))))

app = FastAPI(title="Mira FASHN VTON Engine", version="1.0.0")
pipeline = None
pipeline_lock = threading.Lock()


class TryOnRequest(BaseModel):
    request_id: str = Field(pattern=r"^[A-Za-z0-9_-]{8,96}$")
    person_image_base64: str
    person_mime: str = "image/jpeg"
    garment_image_base64: str
    garment_mime: str = "image/jpeg"
    category: str = "clothing"
    garment_zone: str | None = None
    garment_photo_type: Literal["model", "flat-lay"] = "model"
    seed: int | None = None


def authorize(authorization: str | None) -> None:
    if not TOKEN:
        return
    expected = f"Bearer {TOKEN}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Invalid engine token")


def decode_image(value: str, field: str) -> Image.Image:
    try:
        raw = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"{field} is not valid base64") from exc
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail=f"{field} exceeds the allowed size")
    try:
        Image.MAX_IMAGE_PIXELS = MAX_PIXELS
        image = Image.open(io.BytesIO(raw))
        image.verify()
        image = Image.open(io.BytesIO(raw))
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.load()
        return image
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"{field} is not a supported image") from exc


def fashn_category(category: str, zone: str | None) -> str:
    normalized = (zone or category or "").strip().lower().replace("_", "-")
    mapping = {
        "upper-body": "tops",
        "upper": "tops",
        "top": "tops",
        "tops": "tops",
        "lower-body": "bottoms",
        "lower": "bottoms",
        "bottom": "bottoms",
        "bottoms": "bottoms",
        "full-body": "one-pieces",
        "full": "one-pieces",
        "dress": "one-pieces",
        "dresses": "one-pieces",
        "one-piece": "one-pieces",
        "one-pieces": "one-pieces",
    }
    result = mapping.get(normalized)
    if result:
        return result
    raise HTTPException(
        status_code=422,
        detail="Unsupported garment category. Use tops, bottoms or one-pieces.",
    )


def get_pipeline():
    global pipeline
    if pipeline is None:
        if not (WEIGHTS_DIR / "model.safetensors").is_file():
            raise HTTPException(status_code=503, detail="FASHN weights are not installed")
        from fashn_vton import TryOnPipeline

        pipeline = TryOnPipeline(weights_dir=str(WEIGHTS_DIR), device=DEVICE)
    return pipeline


@app.get("/health")
def health(authorization: str | None = Header(default=None)):
    authorize(authorization)
    return {
        "success": True,
        "engine": "fashn-vton-1.5",
        "weights_ready": (WEIGHTS_DIR / "model.safetensors").is_file(),
        "categories": ["tops", "bottoms", "one-pieces"],
    }


@app.post("/v1/tryon")
def tryon(request: TryOnRequest, authorization: str | None = Header(default=None)):
    authorize(authorization)
    person = decode_image(request.person_image_base64, "person_image_base64")
    garment = decode_image(request.garment_image_base64, "garment_image_base64")
    category = fashn_category(request.category, request.garment_zone)
    seed = request.seed if request.seed is not None else int(hashlib.sha256(request.request_id.encode()).hexdigest()[:8], 16)

    # FASHN and the CUDA allocator are shared deliberately. Serial inference prevents
    # concurrent requests from exhausting VRAM and makes credit/result handling stable.
    with pipeline_lock:
        result = get_pipeline()(
            person_image=person,
            garment_image=garment,
            category=category,
            garment_photo_type=request.garment_photo_type,
            num_samples=1,
            num_timesteps=TIMESTEPS,
            guidance_scale=GUIDANCE,
            seed=seed,
            segmentation_free=True,
        )

    output = io.BytesIO()
    result.images[0].save(output, format="JPEG", quality=94, optimize=True)
    return {
        "success": True,
        "request_id": request.request_id,
        "engine": "fashn-vton-1.5",
        "category": category,
        "result_mime": "image/jpeg",
        "result_image_base64": base64.b64encode(output.getvalue()).decode("ascii"),
    }
