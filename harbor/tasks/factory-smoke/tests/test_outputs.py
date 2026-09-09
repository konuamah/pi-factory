import json
from pathlib import Path


def test_outputs():
    output_path = Path("/app/artifacts/factory-quality-summary.json")
    assert output_path.exists(), "expected artifacts/factory-quality-summary.json to exist"

    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload == {
        "repo": "pi-factory",
        "task": "factory-smoke",
        "status": "ok",
        "notes": "Harbor wiring is ready for richer Factory evals.",
    }
