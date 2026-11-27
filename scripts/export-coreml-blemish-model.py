#!/usr/bin/env python3
"""
Export an open-weight Ultralytics YOLO acne/blemish detector (.pt) to Core ML
(BlemishDetector.mlpackage) + blemish_model_manifest.json for Skin Trace (personal R&D use).

Run on macOS (Apple Silicon or Intel) with Python 3.10–3.12:

    python3 -m venv .venv-ml
    source .venv-ml/bin/activate
    pip install --upgrade pip ultralytics coremltools huggingface_hub
    python3 scripts/export-coreml-blemish-model.py

Then drag both files from ./ml-export/ into Xcode's App target ("Copy items if needed" + "Add to targets: App"):
    - ml-export/BlemishDetector.mlpackage
    - ml-export/blemish_model_manifest.json
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path


def infer_skin_trace_category(raw_label: str) -> str | None:
    """Map raw detector class labels onto Skin Trace's LesionCategory schema."""
    norm = raw_label.strip().lower().replace("-", "_").replace(" ", "_")

    if any(k in norm for k in ("comedone", "blackhead", "whitehead", "open_com", "closed_com")):
        return "comedone"
    if any(k in norm for k in ("papule", "pustule", "pimple", "white_head")):
        return "papule_pustule"
    if any(k in norm for k in ("nodule", "cyst")):
        return "nodule_cyst"
    if any(k in norm for k in ("erythema", "pie", "red_mark", "redness")):
        return "residual_red_mark_pie"
    if any(k in norm for k in ("pigment", "pih", "dark_spot", "scar", "mark", "spot")):
        return "residual_dark_spot_pih"
    if any(k in norm for k in ("acne", "blemish", "lesion")):
        return "active_blemish_unspecified"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export a YOLO acne .pt model to Core ML + Skin Trace manifest."
    )
    parser.add_argument(
        "--repo-id",
        default="mufasabrownie/glowlytics-skin-models",
        help="Hugging Face repo ID containing the .pt weights.",
    )
    parser.add_argument(
        "--filename",
        default="acne_detector_best.pt",
        help="Weights filename inside the Hugging Face repo.",
    )
    parser.add_argument(
        "--weights",
        type=Path,
        default=None,
        help="Optional local path to a .pt checkpoint (skips Hugging Face download).",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("ml-export"),
        help="Output directory for BlemishDetector.mlpackage and blemish_model_manifest.json.",
    )
    parser.add_argument(
        "--imgsz",
        type=int,
        default=640,
        help="Square Core ML input size (default: 640).",
    )
    parser.add_argument(
        "--conf-threshold",
        type=float,
        default=0.35,
        help="Default confident detection threshold in manifest (default: 0.35).",
    )
    parser.add_argument(
        "--uncertain-threshold",
        type=float,
        default=0.20,
        help="Default uncertain detection threshold in manifest (default: 0.20).",
    )
    args = parser.parse_args()

    try:
        from ultralytics import YOLO
    except ImportError:
        print(
            "Missing dependency: ultralytics. Install with:\n"
            "  pip install ultralytics coremltools huggingface_hub",
            file=sys.stderr,
        )
        return 1

    if args.weights is not None:
        weights_path = args.weights.resolve()
        if not weights_path.exists():
            print(f"Weights file not found: {weights_path}", file=sys.stderr)
            return 1
        model_version = f"local-{weights_path.stem}"
    else:
        try:
            from huggingface_hub import hf_hub_download
        except ImportError:
            print(
                "Missing dependency: huggingface_hub. Install with:\n"
                "  pip install huggingface_hub",
                file=sys.stderr,
            )
            return 1

        print(f"Downloading {args.repo_id}/{args.filename} from Hugging Face...")
        downloaded = hf_hub_download(repo_id=args.repo_id, filename=args.filename)
        weights_path = Path(downloaded)
        repo_slug = args.repo_id.replace("/", "-")
        model_version = f"{repo_slug}-{Path(args.filename).stem}"

    print(f"Loading PyTorch weights: {weights_path}")
    model = YOLO(str(weights_path))

    raw_names = model.names
    if isinstance(raw_names, list):
        label_list = raw_names
    elif isinstance(raw_names, dict):
        label_list = [raw_names[k] for k in sorted(raw_names.keys())]
    else:
        print(f"Unexpected model.names format: {type(raw_names)}", file=sys.stderr)
        return 1

    print("\nDetected model labels -> Skin Trace classMap:")
    class_map: dict[str, str] = {}
    unmapped: list[str] = []
    for label in label_list:
        mapped = infer_skin_trace_category(str(label))
        if mapped:
            class_map[str(label)] = mapped
            print(f"  {label!r} -> {mapped!r}")
        else:
            unmapped.append(str(label))
            print(f"  {label!r} -> (UNMAPPED — will be ignored unless added manually)")

    if not class_map:
        print(
            "\nError: None of the model labels matched Skin Trace categories. "
            "Inspect model.names above and update infer_skin_trace_category().",
            file=sys.stderr,
        )
        return 1

    print(f"\nExporting Core ML .mlpackage with built-in NMS (imgsz={args.imgsz})...")
    exported_path = Path(
        model.export(
            format="coreml",
            imgsz=args.imgsz,
            nms=True,
            half=True,
        )
    )

    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    target_pkg = out_dir / "BlemishDetector.mlpackage"
    if target_pkg.exists():
        shutil.rmtree(target_pkg)

    if exported_path.is_dir():
        shutil.copytree(exported_path, target_pkg)
    else:
        # Older Core ML exporters can emit .mlmodel instead of .mlpackage
        target_pkg = out_dir / f"BlemishDetector{exported_path.suffix}"
        shutil.copy2(exported_path, target_pkg)

    manifest = {
        "modelVersion": model_version,
        "preprocessingVersion": f"square-roi-crop-{args.imgsz}-v1",
        "licenseScope": "non_commercial_research_only",
        "modelSource": "research_coreml_model",
        "classMap": class_map,
        "defaultConfidenceThreshold": args.conf_threshold,
        "defaultUncertainThreshold": args.uncertain_threshold,
    }
    manifest_path = out_dir / "blemish_model_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print("\nExport complete!")
    print(f"  Model:    {target_pkg}")
    print(f"  Manifest: {manifest_path}")
    if unmapped:
        print(f"  Note: unmapped labels skipped: {unmapped}")
    print(
        "\nNext steps in Xcode:\n"
        "  1. Open ios/App/App.xcworkspace (via `npx cap open ios`).\n"
        "  2. Drag BOTH files above into the App/App group in Xcode.\n"
        "  3. Check 'Copy items if needed' and 'Add to targets: App'.\n"
        "  4. Clean (Cmd+Shift+K) and Run (Cmd+R) on your iPhone.\n"
        "  5. Open any captured session -> Inspect / Annotate -> Run On-Device Core ML."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
