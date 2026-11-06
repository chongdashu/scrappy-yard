"""Normalise Tripo scrap plane → game/public/assets/props/prop_scrap_plane.glb (2.2 m tall, flyover only)."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
import tripo_static_normalize as t
t.run("prop_scrap_plane", "assets/source/tripo/prop_scrap_plane/tripo-out/stylized-cartoon-patched-togethe-24234865/model.glb", "props", "mat_plane_rust", target_h=2.2)
