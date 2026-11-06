"""Rerunnable normalise for prop_scrap_car.

Input  (untouched Tripo download): assets/source/tripo/prop_scrap_car/tripo-out/prop-scrap-car-08cfc360/model.glb
Outputs: assets/blender/props/prop_scrap_car.blend, game/public/assets/props/prop_scrap_car.glb,
         out/blender/reimport-prop_scrap_car.txt
Run from the game root: blender -b --python assets/scripts/normalize_prop_scrap_car.py
Tripo front (+X) → glTF +Z so the long axis runs along Z, nose toward the camera; per-axis fit to the
contract box 1.3 × 1.4 × 3.0 m; ground-contact centre pivot.
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
import tripo_static_normalize as t

t.run("prop_scrap_car", "assets/source/tripo/prop_scrap_car/tripo-out/prop-scrap-car-08cfc360/model.glb",
      "props", "mat_car_rust", fit_box=(1.3, 1.4, 3.0))
