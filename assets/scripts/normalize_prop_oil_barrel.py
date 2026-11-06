"""Rerunnable normalise for prop_oil_barrel.

Input  (untouched Tripo download): assets/source/tripo/prop_oil_barrel/tripo-out/prop-oil-barrel-1a794519/model.glb
Outputs: assets/blender/props/prop_oil_barrel.blend, game/public/assets/props/prop_oil_barrel.glb,
         out/blender/reimport-prop_oil_barrel.txt
Run from the game root: blender -b --python assets/scripts/normalize_prop_oil_barrel.py
Per-axis fit to the contract box 0.8 × 0.85 × 0.8 m (source drum is taller/narrower → a squatter toy drum),
ground-contact centre pivot.
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
import tripo_static_normalize as t

t.run("prop_oil_barrel", "assets/source/tripo/prop_oil_barrel/tripo-out/prop-oil-barrel-1a794519/model.glb",
      "props", "mat_barrel", fit_box=(0.8, 0.85, 0.8))
