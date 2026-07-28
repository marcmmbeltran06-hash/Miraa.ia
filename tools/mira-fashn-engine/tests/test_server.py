import base64
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import server


def encoded_image():
    output = io.BytesIO()
    Image.new("RGB", (32, 48), "white").save(output, "PNG")
    return base64.b64encode(output.getvalue()).decode()


@pytest.mark.parametrize(
    ("category", "zone", "expected"),
    [
        ("clothing", "upper_body", "tops"),
        ("bottoms", None, "bottoms"),
        ("dress", None, "one-pieces"),
    ],
)
def test_category_mapping(category, zone, expected):
    assert server.fashn_category(category, zone) == expected


def test_rejects_accessory_category():
    with pytest.raises(Exception) as error:
        server.fashn_category("jewelry", None)
    assert error.value.status_code == 422


def test_health_reports_missing_weights(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "WEIGHTS_DIR", tmp_path)
    monkeypatch.setattr(server, "TOKEN", "")
    response = TestClient(server.app).get("/health")
    assert response.status_code == 200
    assert response.json()["weights_ready"] is False


def test_invalid_image_is_rejected_before_inference(monkeypatch):
    monkeypatch.setattr(server, "TOKEN", "")
    payload = {
        "request_id": "tryon_12345678",
        "person_image_base64": "invalid!",
        "garment_image_base64": encoded_image(),
        "category": "tops",
    }
    response = TestClient(server.app).post("/v1/tryon", json=payload)
    assert response.status_code == 422
